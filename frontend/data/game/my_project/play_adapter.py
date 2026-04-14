"""Stepwise adapter around the simulation engine for interactive play.

The headless simulation (`run_game`/`run_turn`) calls a strategy callback
to pick actions until the player passes. A human player needs to pick
actions interactively, so this module splits a turn into explicit phases
that a UI can drive:

    game = PlayableGame(seed=123)
    while not game.is_over():
        if game.is_human_turn():
            # UI loop: show state, collect action, apply, repeat until pass
            for action in game.legal_actions():
                ...
            game.apply_human_action(action_dict)
            game.end_human_turn()  # draws back to hand, fires event
        else:
            game.step_ai_turn()  # runs full AI turn + event

State is serialized to a plain dict via `state_dict()` — no dataclass
references leak to the JS side. Upcoming events are hidden; only the
event that just fired is exposed as `last_event`.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from pathlib import Path

from my_project.models import Card, Contract, Resource
from my_project.parsing import parse_cards, parse_contracts, parse_patents
from my_project.simulation import (
    Action,
    ActionType,
    DEFAULT_MAX_TURNS,
    DEFAULT_START_MONEY,
    EventCard,
    EventDeckConfig,
    EventType,
    GameState,
    HAND_SIZE,
    MAX_CARDS_PER_TURN,
    Player,
    _default_ai_bid,
    _player_owns_patent,
    compute_build_deficit,
    effective_contract_requirements,
    execute_build,
    execute_contract,
    execute_event,
    execute_sell,
    reset_per_turn_flags,
    settle_silent_auction,
    swap_pool_card,
)
from my_project.strategies import (
    greedy_strategy,
    optimal_strategy,
    random_strategy,
    smart_greedy_strategy,
)


# Default asset paths (can be overridden when constructing PlayableGame)
DEFAULT_DATA_DIR = Path(__file__).parent / "data"

# Maps a seat string from the UI config to the *attribute name* of the strategy
# function on this module. We resolve via globals() at call time so that tests
# which monkey-patch e.g. `play_adapter.smart_greedy_strategy` are honored.
# "human" is handled separately and never appears here.
STRATEGY_NAMES = {
    "smart": "smart_greedy_strategy",
    "greedy": "greedy_strategy",
    "random": "random_strategy",
    "optimal": "optimal_strategy",
}


def _resolve_strategy(seat: str):
    return globals()[STRATEGY_NAMES[seat]]


@dataclass
class PlayableGame:
    """Stepwise game driver for one or more humans vs AI players.

    `seats` is the canonical config: a list whose length defines the number of
    players, with each entry either "human" or one of `STRATEGY_MAP` keys
    ("smart" / "greedy" / "random"). When `seats` is omitted, the legacy
    `num_players` + `human_index` shorthand builds a 1-human / N-1-smart layout.
    """

    seed: int = 0
    num_players: int = 3
    human_index: int = 0
    seats: list[str] | None = None
    # Optional per-seat display names. Empty string / missing entries fall
    # back to the engine's `Player_{i+1}` default.
    names: list[str] | None = None
    max_turns: int = DEFAULT_MAX_TURNS
    num_rounds: int = 2
    event_deck_config: EventDeckConfig | None = None
    # When provided, overrides build_event_deck entirely.
    custom_event_deck: list[EventCard] | None = None
    # Test escape hatch: when True, the engine never pauses mid-event for
    # human prompts (auctions / OC picks). Live play uses False.
    disable_prompts: bool = False
    data_dir: Path = field(default_factory=lambda: DEFAULT_DATA_DIR)

    state: GameState = field(init=False)
    _human_indices: set[int] = field(default_factory=set, init=False)
    last_event: str = field(default="", init=False)
    last_ai_actions: list[dict] = field(default_factory=list, init=False)
    human_turn_in_progress: bool = field(default=False, init=False)
    # One snapshot per completed player-turn so the UI can plot market drift.
    # Entry shape: {"turn": int (1-indexed player-turn), "market": {res_str: price}}.
    market_history: list[dict] = field(default_factory=list, init=False)
    # One snapshot per completed player-turn of every player's NW components
    # (money / debt / credit / net_worth). Used for the post-game review chart.
    player_history: list[dict] = field(default_factory=list, init=False)
    _turn_action_records: list = field(default_factory=list, init=False)
    # Event hiding: when a turn begins we pre-advance event_idx past the current
    # event and stash the event here. This prevents state.remaining_events()
    # from revealing the current turn's event to the strategy or UI during the
    # action phase, matching simulation.run_game's pattern. Cleared when the
    # event fires at end of turn.
    _pending_event: EventCard | None = field(default=None, init=False)
    # When a turn is in progress, event_idx has been pre-advanced, so
    # `event_idx % num_players` would point at the NEXT player. This field
    # records the index of the player whose turn is currently in progress.
    # -1 means no turn is in progress (use _turn_count-based calculation).
    _active_player_idx: int = field(default=-1, init=False)
    # Logical player-turn counter, decoupled from event_idx so that redraw
    # events (which consume multiple cards per turn) don't break the
    # whose-turn-is-it cycle. Increments by 1 per begin_human_turn /
    # step_ai_turn call. Mid-turn this is the 1-indexed turn currently in
    # progress; between turns it's the count of completed turns.
    _turn_count: int = field(default=0, init=False)
    # Suspended AI turn state (set when an AI turn paused mid-event for a
    # human prompt). None when no AI turn is paused.
    _suspended_ai_turn: dict | None = field(default=None, init=False)

    def __post_init__(self) -> None:
        # Resolve seats first; if omitted, derive from legacy num_players + human_index.
        if self.seats is None:
            self.seats = [
                "human" if i == self.human_index else "smart"
                for i in range(self.num_players)
            ]
        else:
            self.num_players = len(self.seats)
        for s in self.seats:
            if s != "human" and s not in STRATEGY_NAMES:
                raise ValueError(f"Unknown seat type: {s!r}")
        self._human_indices = {i for i, s in enumerate(self.seats) if s == "human"}
        # human_index is kept as the *first* human seat for any caller still using it.
        if self._human_indices:
            self.human_index = min(self._human_indices)

        random.seed(self.seed)
        cards = parse_cards(self.data_dir / "Cards.csv")
        contracts = parse_contracts(self.data_dir / "Contracts.csv")
        # Patents.csv may not exist in older asset bundles — graceful fallback.
        patents_path = self.data_dir / "Patents.csv"
        patents = parse_patents(patents_path) if patents_path.exists() else []
        self.state = GameState.create(
            all_cards=cards,
            all_contracts=contracts,
            num_players=self.num_players,
            start_money=DEFAULT_START_MONEY,
            max_turns=self.max_turns,
            randomize_market=True,
            event_deck_config=self.event_deck_config,
            event_deck=self.custom_event_deck,
            patent_pile=patents,
            num_rounds=self.num_rounds,
        )
        # Apply custom names if provided. Strict length check, empty entries
        # silently keep the engine's `Player_{i+1}` default so the UI can pass
        # a same-length parallel array without filtering empties first.
        if self.names is not None:
            if len(self.names) != self.num_players:
                raise ValueError(
                    f"names length {len(self.names)} != num_players {self.num_players}"
                )
            for i, n in enumerate(self.names):
                if n:
                    self.state.players[i].name = n
        # Mark the state as containing humans so the simulation engine knows
        # to pause for human input on auctions / OC picks. Tests that drive
        # the engine end-to-end can set disable_prompts=True to bypass.
        self.state._is_human_game = bool(self._human_indices) and not self.disable_prompts
        # Seed history with the starting market so the UI chart has a turn-0 anchor.
        self._snapshot_market(turn=0)

    def _snapshot_market(self, turn: int) -> None:
        self.market_history.append({
            "turn": turn,
            "market": {r.value: self.state.market.price(r) for r in Resource},
        })
        # Parallel per-player snapshot for the post-game review chart.
        self.player_history.append({
            "turn": turn,
            "players": [
                {
                    "name": p.name,
                    "money": p.money,
                    "debt": p.debt,
                    "credit": p.credit,
                    "net_worth": p.net_worth(),
                }
                for p in self.state.players
            ],
        })

    # --- Status queries ---

    def _turn_in_progress(self) -> bool:
        """True if a turn's event has been pre-advanced but not yet fired.

        During this period event_idx is one ahead of the player whose turn is
        active, so callers need to compensate.
        """
        return self._active_player_idx >= 0

    def is_over(self) -> bool:
        # Game ends when the event deck is exhausted AND no more rounds remain.
        # After END_ROUND the deck gets reshuffled, so being at the end of
        # round 1's deck is NOT game over.
        if self._turn_in_progress():
            return False
        if self.state.event_idx < len(self.state.event_deck):
            return False
        # Deck exhausted — check if there's a pending reshuffle (END_ROUND
        # was the last card but more rounds remain)
        if self.deck_round_number() < self.num_rounds:
            return False
        return True

    def current_player_index(self) -> int:
        """Index of the player whose turn is now active (0-based).

        Pre-redraws this could be derived from event_idx % num_players, but
        with redraws consuming variable cards per turn we track the player
        cycle via _turn_count instead.
        """
        if self._turn_in_progress():
            return self._active_player_idx
        return self._turn_count % self.num_players

    def is_human_turn(self) -> bool:
        if self.is_over():
            return False
        return self.current_player_index() in self._human_indices

    # Terminal event results queued for the frontend to pick up and log.
    # Each entry is a dict like the event portion of step_ai_turn's return.
    pending_terminal_results: list[dict] = field(default_factory=list, init=False)

    def _consume_terminal_events(self) -> None:
        """Auto-fire any terminal events (END_ROUND / END_GAME) at the current
        deck position. Called before beginning any player's turn so terminals
        fire as cleanup between rounds, not as a player's turn.

        Results are stashed in `pending_terminal_results` so the frontend
        can log them (the PB + Futures per-player breakdown).
        """
        from my_project.simulation import EventType as _ET, execute_event as _exec
        while (
            self.state.event_idx < len(self.state.event_deck)
            and self.state.event_deck[self.state.event_idx].type
            in (_ET.END_ROUND, _ET.END_GAME)
        ):
            terminal = self.state.event_deck[self.state.event_idx]
            self.state.event_idx += 1
            active = (
                self.state.players[self._active_player_idx]
                if self._active_player_idx >= 0
                else self.state.players[0]
            )
            self.state.last_event_lines = []
            detail = _exec(self.state, terminal, active)
            self.last_event = detail
            self._snapshot_market(turn=self.state.turn)
            self.pending_terminal_results.append({
                "type": terminal.type.value,
                "detail": detail,
                "lines": list(self.state.last_event_lines),
            })
            # Reshuffle deck for next round when END_ROUND fires
            if terminal.type == _ET.END_ROUND:
                from my_project.simulation import reshuffle_for_next_round
                current_round = self.deck_round_number()
                reshuffle_for_next_round(
                    self.state, self.num_players,
                    current_round, self.num_rounds,
                )

    def _total_player_turns(self) -> int:
        """Count events in the deck that are actual player-turns.
        Every non-redraw event is a player turn, including END_ROUND
        and END_GAME (the player takes actions, then the event fires)."""
        return sum(1 for e in self.state.event_deck if not e.redraws)

    def clear_terminal_results(self) -> None:
        """Clear the pending terminal event results after the frontend has logged them."""
        self.pending_terminal_results.clear()

    def current_player(self) -> Player:
        return self.state.players[self.current_player_index()]

    def turn_number(self) -> int:
        """1-indexed player turn number (out of max_turns * num_players)."""
        if self._turn_in_progress():
            return self._turn_count
        return self._turn_count + 1

    def round_number(self) -> int:
        """1-indexed round within the current deck-round.
        Each round is num_players player-turns."""
        effective = self._turn_count - 1 if self._turn_in_progress() else self._turn_count
        return (effective // self.num_players) + 1

    def deck_round_number(self) -> int:
        """1-indexed deck-round (1..num_rounds). Determined by how many
        END_ROUND events have already been consumed in the deck."""
        # Count END_ROUND events in the already-consumed portion of the deck
        from my_project.simulation import EventType
        consumed = self.state.event_deck[: self.state.event_idx]
        end_rounds_seen = sum(1 for e in consumed if e.type == EventType.END_ROUND)
        return end_rounds_seen + 1

    # --- Human turn control ---

    def begin_human_turn(self) -> None:
        """Mark the turn as started. Must be called before apply_human_action."""
        if self.human_turn_in_progress:
            return
        if not self.is_human_turn():
            raise RuntimeError("Not currently the human's turn")
        self.state.turn += 1
        self.human_turn_in_progress = True
        self._turn_action_records = []
        # Record which player is acting via _turn_count, BEFORE incrementing it.
        self._active_player_idx = self._turn_count % self.num_players
        self._turn_count += 1
        active = self.state.players[self._active_player_idx]
        reset_per_turn_flags(active)

        # Pre-advance event_idx and stash the current turn's event so that
        # state.remaining_events() does NOT reveal it to the UI or any helper
        # that inspects remaining events during the action phase.
        self._pending_event = self.state.event_deck[self.state.event_idx]
        self.state.event_idx += 1

    def end_human_turn(self) -> dict:
        """Complete the human turn: draw back to hand size, fire the event.

        Returns a dict describing the fired event so the UI can render it.
        If the event needs human input (auction bid, OC pick), pauses with
        a pending_prompt and the turn finalization happens later when the
        prompt is resolved.
        """
        if not self.human_turn_in_progress:
            raise RuntimeError("begin_human_turn was not called")

        player = self.current_player()

        # Draw back to hand size (independent of the event prompt)
        needed = player.hand_size - len(player.hand)
        if needed > 0:
            player.hand.extend(self.state.deck.draw(needed))

        # Fire the pre-stashed event. event_idx was already advanced in
        # begin_human_turn; do NOT advance it again here.
        event = self._pending_event
        self.state.last_event_lines = []

        # Check if this event needs human input (patent auction bid) before firing.
        from my_project.simulation import _event_needs_prompt, _has_human_player
        prompt = _event_needs_prompt(self.state, event)
        if prompt is not None and _has_human_player(self.state):
            self.state.pending_prompt = prompt
            self.state._suspended_event = event
            self.state._suspended_chain_active = False
            self.last_event = f"awaiting prompt: {prompt['kind']}"
            return {
                "type": event.type.value,
                "detail": self.last_event,
                "lines": [],
                "awaiting_prompt": True,
            }

        # Execute the event, then chain redraws.
        event_detail = execute_event(self.state, event, player)
        if self.state.pending_prompt is not None:
            self.last_event = event_detail
            return {
                "type": event.type.value,
                "detail": event_detail,
                "lines": list(self.state.last_event_lines),
                "awaiting_prompt": True,
            }
        # Chain redraw events (same turn, no actions)
        chain_detail = self._chain_redraws(player, event)
        if chain_detail:
            event_detail = f"{event_detail} | {chain_detail}"
        return self._finalize_human_turn(event, event_detail)

    def _chain_redraws(self, player, event) -> str:
        """If the event has redraws, keep drawing and executing events.
        Returns combined event detail string for all chained events."""
        details = []
        while event.redraws and self.state.event_idx < len(self.state.event_deck):
            event = self.state.event_deck[self.state.event_idx]
            self.state.event_idx += 1
            self.state.last_event_lines = []
            detail = execute_event(self.state, event, player)
            details.append(detail)
        return " | ".join(details) if details else ""

    def _finalize_human_turn(self, event: EventCard, event_detail: str) -> dict:
        """Finalize the in-progress human turn after the event has fully resolved."""
        self._pending_event = None
        self.last_event = event_detail
        self.human_turn_in_progress = False
        self._active_player_idx = -1
        self._snapshot_market(turn=self.state.turn)
        return {
            "type": event.type.value,
            "detail": event_detail,
            "lines": list(self.state.last_event_lines),
        }

    def apply_human_action(self, action: dict) -> dict:
        """Apply a single action for the human player.

        `action` is a dict with at minimum `type` in {build, sell, contract, pass}.
        Additional keys per type:
          - build: build_cards (list[int])
          - sell: card_idx (int)
          - contract: card_idx (int), contract_idx (int)

        Returns a dict describing what happened (action record-like) or
        `{"ok": False, "reason": "..."}` if the action was illegal.
        """
        if not self.human_turn_in_progress:
            self.begin_human_turn()

        player = self.current_player()
        atype = action.get("type", "")

        if atype == "pass":
            return {"ok": True, "type": "pass", "detail": "Pass"}

        if atype == "build":
            from my_project.simulation import _player_owns_patent
            if player.has_built_this_turn and not _player_owns_patent(player, "Matter Replication"):
                return {"ok": False, "reason": "Already built this turn"}
            build_idx = list(action.get("build_cards") or [])
            if not build_idx:
                return {"ok": False, "reason": "No cards selected"}
            if len(build_idx) > 2:
                return {"ok": False, "reason": "Max 2 cards per build"}
            if len(build_idx) > player.cards_remaining():
                return {"ok": False, "reason": f"Would spend {len(build_idx)} cards but only {player.cards_remaining()} left this turn"}
            patent_office_pick = action.get("patent_office_pick")
            if patent_office_pick is not None:
                patent_office_pick = int(patent_office_pick)
            record = execute_build(
                self.state, player, build_idx,
                patent_office_pick=patent_office_pick,
            )
            if record is None:
                return {"ok": False, "reason": "Cannot afford build (or duplicate special)"}
            self._turn_action_records.append(record)
            return _record_to_dict(record, ok=True, player=player)

        if atype == "sell":
            if player.cards_remaining() < 1:
                return {"ok": False, "reason": "No cards left to spend this turn"}
            idx = action.get("card_idx", -1)
            if idx < 0 or idx >= len(player.hand):
                return {"ok": False, "reason": "Invalid card"}
            card = player.hand[idx]
            if not card.can_sell:
                return {"ok": False, "reason": "Card cannot sell"}
            record = execute_sell(
                self.state,
                player,
                idx,
                sell_resource=action.get("sell_resource") or None,
                hacker_target=action.get("hacker_target") or None,
                hacker_direction=int(action.get("hacker_direction", 0) or 0),
            )
            if record is None:
                return {"ok": False, "reason": "Sell failed"}
            self._turn_action_records.append(record)
            return _record_to_dict(record, ok=True, player=player)

        if atype == "contract":
            card_idx = action.get("card_idx", -1)
            contract_idx = action.get("contract_idx", -1)
            use_elevator = bool(action.get("use_elevator", False))
            use_launch_pad = bool(action.get("use_launch_pad", False))
            elevator_target = action.get("elevator_target") or None
            # Card-spend check (Launch Pad is free; hand card costs 1)
            if use_launch_pad:
                cards_cost = 0
            else:
                cards_cost = 1
            if cards_cost > player.cards_remaining():
                return {"ok": False, "reason": f"Would spend {cards_cost} cards but only {player.cards_remaining()} left this turn"}
            # Path-specific validation
            if use_launch_pad:
                pass  # execute_contract validates the LP-once-per-turn flag
            else:
                if card_idx < 0 or card_idx >= len(player.hand):
                    return {"ok": False, "reason": "Invalid card"}
                if not player.hand[card_idx].can_fulfill_contract:
                    return {"ok": False, "reason": "Card has no contract icon"}
            if contract_idx < 0 or contract_idx >= len(self.state.available_contracts):
                return {"ok": False, "reason": "Invalid contract"}
            record = execute_contract(
                self.state,
                player,
                card_idx,
                contract_idx,
                use_elevator=use_elevator,
                use_launch_pad=use_launch_pad,
                elevator_target=elevator_target,
            )
            if record is None:
                return {"ok": False, "reason": "Cannot fulfill contract"}
            self._turn_action_records.append(record)
            return _record_to_dict(record, ok=True, player=player)

        return {"ok": False, "reason": f"Unknown action type: {atype}"}

    def human_pool_swap(self, hand_idx: int, pool_idx: int) -> dict:
        """Swap a card from the human's hand with one from the pool.

        Pool swaps are free and unlimited — allowed any time during the
        human's turn, before or between actions. Auto-begins the turn if
        the caller hasn't already.
        """
        if not self.is_human_turn():
            return {"ok": False, "reason": "Not human turn"}
        if not self.human_turn_in_progress:
            self.begin_human_turn()
        player = self.current_player()
        if hand_idx < 0 or hand_idx >= len(player.hand):
            return {"ok": False, "reason": "Invalid hand index"}
        if pool_idx < 0 or pool_idx >= len(self.state.pool):
            return {"ok": False, "reason": "Invalid pool index"}
        swap_pool_card(self.state, player, hand_idx, pool_idx)
        return {"ok": True}

    def can_pool_swap(self) -> bool:
        """True iff the human can currently perform a pool swap.

        Pool swaps are free and unlimited during the human's own turn.
        """
        return self.is_human_turn()

    # --- Active patent free actions (once per turn each) ---

    def use_water_engine(self, seat_idx: int) -> dict:
        """Water Engine: -1 H2O rate, +2 PWR rate. Once per turn.
        Requires owner has H2O rate >= 1.
        """
        if seat_idx not in self._human_indices:
            return {"ok": False, "reason": "Not a human seat"}
        player = self.state.players[seat_idx]
        if not _player_owns_patent(player, "Water Engine"):
            return {"ok": False, "reason": "No Water Engine"}
        if player.has_used_water_engine_this_turn:
            return {"ok": False, "reason": "Already used this turn"}
        if player.rate(Resource.H2O) < 1:
            return {"ok": False, "reason": "Need at least +1 H2O rate"}
        player.rates[Resource.H2O] = player.rate(Resource.H2O) - 1
        player.rates[Resource.PWR] = player.rate(Resource.PWR) + 2
        player.has_used_water_engine_this_turn = True
        return {
            "ok": True,
            "type": "patent",
            "detail": "Water Engine: -1 H2O, +2 PWR",
            **_nw_snapshot(player),
        }

    def use_nanotechnology(self, seat_idx: int, pool_idx: int) -> dict:
        """Nanotechnology: discard ONE pool card, replace with a deck draw.
        Once per turn."""
        if seat_idx not in self._human_indices:
            return {"ok": False, "reason": "Not a human seat"}
        player = self.state.players[seat_idx]
        if not _player_owns_patent(player, "Nanotechnology"):
            return {"ok": False, "reason": "No Nanotechnology"}
        if player.has_used_nanotechnology_this_turn:
            return {"ok": False, "reason": "Already used this turn"}
        if not self.state.pool:
            return {"ok": False, "reason": "Pool is empty"}
        if pool_idx < 0 or pool_idx >= len(self.state.pool):
            return {"ok": False, "reason": f"Invalid pool index: {pool_idx}"}
        # Discard the chosen pool card and draw a replacement from the deck.
        discarded = self.state.pool.pop(pool_idx)
        self.state.deck.discard.append(discarded)
        drawn = self.state.deck.draw(1)
        self.state.pool.extend(drawn)
        player.has_used_nanotechnology_this_turn = True
        new_name = drawn[0].building if drawn else "(deck empty)"
        return {
            "ok": True,
            "type": "patent",
            "detail": (
                f"Nanotechnology: replaced pool card {discarded.building} "
                f"with {new_name}"
            ),
            **_nw_snapshot(player),
        }

    def use_optimization_center(self, seat_idx: int, resource: str) -> dict:
        """Optimization Center: free action — −1 PWR rate, +1 to any
        positive non-PWR resource rate. Once per turn.
        """
        if seat_idx not in self._human_indices:
            return {"ok": False, "reason": "Not a human seat"}
        from my_project.simulation import _count_buildings
        player = self.state.players[seat_idx]
        if _count_buildings(player, "Optimization Center") == 0:
            return {"ok": False, "reason": "No Optimization Center"}
        if player.has_used_optimization_center_this_turn:
            return {"ok": False, "reason": "Already used this turn"}
        try:
            res = Resource(resource)
        except ValueError:
            return {"ok": False, "reason": f"Invalid resource: {resource}"}
        if res == Resource.PWR:
            return {"ok": False, "reason": "Cannot target PWR"}
        if player.rate(res) < 1:
            return {"ok": False, "reason": f"Need at least +1 {resource} rate"}
        # Apply: -1 PWR, +1 chosen resource
        player.rates[Resource.PWR] = player.rate(Resource.PWR) - 1
        player.rates[res] = player.rate(res) + 1
        player.has_used_optimization_center_this_turn = True
        return {
            "ok": True,
            "type": "special",
            "detail": f"Optimization Center: -1 PWR, +1 {resource}",
            **_nw_snapshot(player),
        }

    def use_teleportation(self, seat_idx: int, resource: str) -> dict:
        """Teleportation: free sell action. Sells your full rate of the
        chosen resource at market price (rate × price). Cost: -1 PWR rate
        (permanent). Does NOT decrement the sold rate. Once per turn.
        """
        if seat_idx not in self._human_indices:
            return {"ok": False, "reason": "Not a human seat"}
        player = self.state.players[seat_idx]
        if not _player_owns_patent(player, "Teleportation"):
            return {"ok": False, "reason": "No Teleportation"}
        if player.has_used_teleportation_this_turn:
            return {"ok": False, "reason": "Already used this turn"}
        try:
            res = Resource(resource)
        except ValueError:
            return {"ok": False, "reason": f"Invalid resource: {resource}"}
        if player.rate(res) < 1:
            return {"ok": False, "reason": f"Need at least +1 {resource} rate"}
        # Full sell: rate × price (same as a normal sell card, but free)
        rate = player.rate(res)
        price = self.state.market.price(res)
        revenue = rate * price
        player.money += revenue
        player.rates[Resource.PWR] = player.rate(Resource.PWR) - 1
        player.has_used_teleportation_this_turn = True
        return {
            "ok": True,
            "type": "patent",
            "detail": f"Teleportation: sold {rate} {resource} for ${revenue}, -1 PWR",
            **_nw_snapshot(player),
        }

    # --- Mid-event prompt resolution ---

    def is_awaiting_prompt(self) -> bool:
        """True iff the engine is paused waiting for a human prompt answer."""
        return self.state.pending_prompt is not None

    def pending_prompt(self) -> dict | None:
        """Returns the current pending prompt dict, or None."""
        return self.state.pending_prompt

    def resolve_pending_prompt(self, answers: dict) -> dict:
        """Resolve the in-flight prompt with the supplied answers and resume.

        For patent_auction prompts, `answers` should be:
            {"bids": {seat_idx: amount, ...}}

        After answers are written to state, fires the suspended event by
        calling resume_pending_event(state, active_player). If the event
        was part of a paused human turn, finalizes the turn. If part of an
        AI turn, finalizes that.
        """
        from my_project.simulation import resume_pending_event
        prompt = self.state.pending_prompt
        if prompt is None:
            return {"ok": False, "reason": "No pending prompt"}
        kind = prompt.get("kind")
        if kind == "patent_auction":
            bids = answers.get("bids", {})
            for seat_idx_raw, amount in bids.items():
                seat_idx = int(seat_idx_raw)
                self.state.pending_bids[seat_idx] = max(0, int(amount))
        elif kind == "debt_paydown":
            payments = answers.get("payments", {})
            for seat_idx_raw, amount in payments.items():
                seat_idx = int(seat_idx_raw)
                self.state.pending_debt_paydowns[seat_idx] = max(0, int(amount))

        # Resume the suspended event
        if self.human_turn_in_progress:
            player = self.state.players[self._active_player_idx]
            event = self.state._suspended_event
            detail = resume_pending_event(self.state, player)
            old_detail = self.last_event or ""
            full_detail = (old_detail + " | " + detail) if old_detail else detail
            # If the resume hit ANOTHER prompt, we're still paused
            if self.state.pending_prompt is not None:
                self.last_event = full_detail
                return {
                    "ok": True,
                    "awaiting_prompt": True,
                    "detail": full_detail,
                    "lines": list(self.state.last_event_lines),
                }
            finalized = self._finalize_human_turn(event, full_detail)
            return {"ok": True, **finalized}
        elif self._suspended_ai_turn is not None:
            ai_state = self._suspended_ai_turn
            player = self.state.players[ai_state["acting_player_idx"]]
            event = ai_state["event"]
            detail = resume_pending_event(self.state, player)
            old_detail = self.last_event or ""
            full_detail = (old_detail + " | " + detail) if old_detail else detail
            if self.state.pending_prompt is not None:
                self.last_event = full_detail
                return {
                    "ok": True,
                    "awaiting_prompt": True,
                    "detail": full_detail,
                    "lines": list(self.state.last_event_lines),
                }
            finalized = self._finalize_ai_turn(
                ai_state["acting_player_idx"],
                ai_state["actions_log"],
                event,
                full_detail,
            )
            return {"ok": True, **finalized}
        return {"ok": False, "reason": "No suspended turn to resume"}

    # --- AI turn ---

    def step_ai_turn(self) -> dict:
        """Run one complete AI turn (pool swap + actions + draw + event).

        Returns a dict with the action log and event result.
        """
        if self.is_over():
            return {"ok": False, "reason": "Game is over"}
        if self.is_human_turn():
            return {"ok": False, "reason": "It's the human's turn"}

        acting_player_idx = self._turn_count % self.num_players
        if acting_player_idx in self._human_indices:
            return {"ok": False, "reason": "It's the human's turn"}
        self._active_player_idx = acting_player_idx
        self._turn_count += 1
        player = self.state.players[acting_player_idx]
        event = self.state.event_deck[self.state.event_idx]
        self.state.event_idx += 1

        reset_per_turn_flags(player)

        # Free actions phase (same as run_turn in simulation.py).
        from my_project.simulation import _execute_free_actions
        free_action_log = _execute_free_actions(self.state, player)

        # Snapshot hand-before so we can diff action records into a log
        actions_log: list[dict] = []

        # Log free actions as action records so the frontend can show them
        for fa_detail in free_action_log:
            actions_log.append({
                "ok": True,
                "type": "free_action",
                "detail": fa_detail,
                "buildings": [],
                "build_money_spent": 0,
                "rates_gained": {},
                "sell_resource": "",
                "sell_amount": 0,
                "sell_revenue": 0,
                "contract_label": "",
                "contract_reward": 0,
                "money_after": player.money,
                "debt_after": player.debt,
                "credit_after": player.credit,
                "net_worth_after": player.net_worth(),
            })

        # Look up this seat's strategy. seats is fully populated by __post_init__.
        strategy_fn = _resolve_strategy(self.seats[acting_player_idx])

        # Pool swap phase
        swap_fn = getattr(strategy_fn, "pool_swap", None)
        if swap_fn:
            swap_fn(self.state, player)

        # Action phase. Loop runs until the strategy returns PASS — empty
        # hand is no longer a stopping condition because free actions
        # (notably Launch Pad contracts) remain legal at hand=0 and AP=0.
        # max_actions is a safety cap against infinite loops.
        self.state.turn += 1
        actions_taken = 0
        max_actions = 10  # mirrors MAX_ACTIONS_PER_TURN
        while actions_taken < max_actions:
            action = strategy_fn(self.state, player)
            if action.action_type == ActionType.PASS:
                break
            record = self._execute_ai_action(player, action)
            if record is not None:
                actions_log.append(_record_to_dict(record, ok=True, player=player))
            actions_taken += 1

        # Draw
        needed = player.hand_size - len(player.hand)
        if needed > 0:
            player.hand.extend(self.state.deck.draw(needed))

        # Event. Check for prompt before firing (e.g. patent auction).
        self.state.last_event_lines = []
        from my_project.simulation import _event_needs_prompt, _has_human_player
        prompt = _event_needs_prompt(self.state, event)
        if prompt is not None and _has_human_player(self.state):
            self.state.pending_prompt = prompt
            self.state._suspended_event = event
            self.state._suspended_chain_active = False
            self.last_event = f"awaiting prompt: {prompt['kind']}"
            self.last_ai_actions = actions_log
            self._suspended_ai_turn = {
                "acting_player_idx": acting_player_idx,
                "actions_log": actions_log,
                "event": event,
            }
            return {
                "ok": True,
                "player_index": acting_player_idx,
                "actions": actions_log,
                "event": {
                    "type": event.type.value,
                    "detail": self.last_event,
                    "lines": [],
                },
                "awaiting_prompt": True,
            }

        event_detail = execute_event(self.state, event, player)
        # Chain redraw events (same turn, no actions)
        chain_detail = self._chain_redraws(player, event)
        if chain_detail:
            event_detail = f"{event_detail} | {chain_detail}"
        self.last_event = event_detail
        self.last_ai_actions = actions_log

        if self.state.pending_prompt is not None:
            # An AI's event needs human input (e.g. an auction event fired
            # mid-AI-turn but a human in the game must bid). Pause here; the
            # play UI will resolve the prompt and then call resume_ai_turn().
            self._suspended_ai_turn = {
                "acting_player_idx": acting_player_idx,
                "actions_log": actions_log,
                "event": event,
            }
            return {
                "ok": True,
                "player_index": acting_player_idx,
                "actions": actions_log,
                "event": {
                    "type": event.type.value,
                    "detail": event_detail,
                    "lines": list(self.state.last_event_lines),
                },
                "awaiting_prompt": True,
            }

        return self._finalize_ai_turn(acting_player_idx, actions_log, event, event_detail)

    def _finalize_ai_turn(
        self, acting_player_idx: int, actions_log: list, event, event_detail: str,
    ) -> dict:
        """Finalize the in-progress AI turn after the event has fully resolved."""
        self.last_event = event_detail
        self._active_player_idx = -1
        self._snapshot_market(turn=self.state.turn)
        self._suspended_ai_turn = None
        return {
            "ok": True,
            "player_index": acting_player_idx,
            "actions": actions_log,
            "event": {
                "type": event.type.value,
                "detail": event_detail,
                "lines": list(self.state.last_event_lines),
            },
        }

    def _execute_ai_action(self, player: Player, action: Action):
        """Execute an AI action. Delegates to the shared _execute_action in
        simulation.py so the AI in play mode uses the exact same code path
        as the Monte Carlo simulation."""
        from my_project.simulation import _execute_action
        return _execute_action(self.state, player, action)

    # --- Serialization ---

    def state_dict(self) -> dict:
        """Serialize the game state to a plain dict suitable for the UI.

        CRITICAL: does NOT include `state.event_deck[event_idx:]` — upcoming
        events are hidden from the player.
        """
        s = self.state
        cur_idx = self.current_player_index() if not self.is_over() else -1
        human_already_built = (
            cur_idx in self._human_indices
            and s.players[cur_idx].has_built_this_turn
        )
        # turn_index is the 0-indexed position of the CURRENT player-turn.
        # During an active turn, event_idx has been pre-advanced, so we use
        # turn_number()-1 to get the correct 0-indexed position.
        turn_index = self.turn_number() - 1
        # Hand reveal: show the active human's hand only. In hot-seat play this
        # keeps other humans' hands hidden until it's their turn.
        return {
            "seed": self.seed,
            "round": self.round_number(),
            "max_rounds": self._total_player_turns() // max(self.num_players, 1),
            "deck_round": self.deck_round_number(),
            "num_rounds": self.num_rounds,
            "turn_index": turn_index,
            "total_turns": self._total_player_turns(),
            "cards_in_deck": max(0, len(s.event_deck) - s.event_idx),
            "is_over": self.is_over(),
            "current_player_index": cur_idx,
            "human_index": self.human_index,
            "human_indices": sorted(self._human_indices),
            "seats": list(self.seats),
            "human_already_built": human_already_built,
            "can_pool_swap": self.can_pool_swap(),
            "market": {r.value: s.market.price(r) for r in Resource},
            "market_positions": {r.value: s.market.positions[r] for r in Resource},
            "players": [
                _player_dict(
                    p,
                    is_human=(i in self._human_indices),
                    reveal_hand=(i == cur_idx and i in self._human_indices),
                )
                for i, p in enumerate(s.players)
            ],
            "available_contracts": [_contract_dict(c) for c in s.available_contracts],
            "pool": [_card_dict(c) for c in s.pool],
            "last_event": self.last_event,
            "last_ai_actions": self.last_ai_actions,
            "market_history": list(self.market_history),
            "player_history": list(self.player_history),
            # Patent state — patent_pile_remaining is just for stats / debug
            # since the modal handles the bid flow at auction time.
            "patent_pile_remaining": max(0, len(s.patent_pile) - s.patent_idx),
            # Mid-event prompt (None when no prompt is active)
            "pending_prompt": dict(s.pending_prompt) if s.pending_prompt else None,
            # Terminal event results (END_ROUND / END_GAME) that fired as
            # cleanup. The frontend should log these and then clear them.
            "terminal_events": list(self.pending_terminal_results),
            # Last event lines for structured feed display
            "last_event_lines": [
                {k: v for k, v in line.items()}
                for line in s.last_event_lines
            ],
            # Structured event data (for clean frontend rendering)
            "last_event_data": getattr(s, "_last_event_data", None) or {},
            # Full event deck for debug/inspection (type + flags for remaining cards)
            "event_deck_remaining": [
                {
                    "type": ec.type.value,
                    "redraws": ec.redraws,
                    "pwr_adjust": getattr(ec, "pwr_adjust", False),
                    "label": ec.label or ec.type.value,
                }
                for ec in s.event_deck[s.event_idx:]
            ],
        }

    def state_for_seat(self, seat_idx: int) -> dict:
        """Serialize game state filtered for a specific seat's perspective.

        Reveals hand only when it's that seat's turn and the seat is human.
        Used by the multiplayer host to send per-client state.
        """
        s = self.state
        cur_idx = self.current_player_index() if not self.is_over() else -1
        d = self.state_dict()
        # Re-build players list with hand reveal filtered for this seat
        d["players"] = [
            _player_dict(
                p,
                is_human=(i in self._human_indices),
                reveal_hand=(i == seat_idx and i == cur_idx and i in self._human_indices),
            )
            for i, p in enumerate(s.players)
        ]
        return d

    # --- Legal action enumeration (for UI hinting) ---

    def legal_human_actions(self) -> dict:
        """Summarize what actions the human can currently take.

        Returns a dict with:
          - already_built: bool — True if a build action has already been taken
          - cards_remaining: int — how many more hand cards can be spent this turn
          - max_build_cards: int — max # of cards the player can build
            (one-build-per-turn constraint + cards_remaining)
          - affordable_single_builds: list of {card_idx, cost} for single-card
            builds that are currently affordable (filtered by cards_remaining)
          - can_sell: list of card indices sellable this turn (filtered by cards_remaining)
          - can_contract: list of {card_idx, contract_idx, ...} entries (Path A
            entries need cards_remaining ≥ 1; Launch Pad Path B entries are always
            shown when LP is unused since LP spends 0 cards)
        """
        if not self.is_human_turn():
            return {
                "already_built": False,
                "cards_remaining": 0,
                "max_build_cards": 0,
                "affordable_single_builds": [],
                "can_sell": [],
                "can_contract": [],
                "space_elevator_status": {"owned": False, "used": False},
                "launch_pad_status": {"owned": False, "used": False},
                "hacker_array_status": {"owned": False},
                "optimization_center_status": {
                    "owned": False, "used": False, "available": False,
                    "valid_resources": [],
                },
                "patent_actions": {
                    "water_engine": {"owned": False, "used": False, "available": False},
                    "nanotechnology": {"owned": False, "used": False, "available": False},
                    "teleportation": {"owned": False, "used": False, "available": False, "valid_resources": []},
                },
            }
        player = self.current_player()
        from my_project.simulation import _player_owns_patent
        already_built = player.has_built_this_turn
        has_mr = _player_owns_patent(player, "Matter Replication")
        cr = player.cards_remaining()
        max_build_cards = 0 if (already_built and not has_mr) else min(cr, len(player.hand))

        from my_project.simulation import _count_buildings

        # Affordable single-card builds (only meaningful if not already built
        # AND player has ≥ 1 AP). Skips slot-4 specials the player already
        # owns (one-of-each rule).
        affordable = []
        if max_build_cards >= 1:
            for i, card in enumerate(player.hand):
                if card.effect and _count_buildings(player, card.building) > 0:
                    continue  # already owns this special
                result = compute_build_deficit([card], player, self.state.market)
                if result is not None:
                    _, cost = result
                    affordable.append({"card_idx": i, "cost": cost})

        # Sellable cards (require ≥ 1 AP to sell anything)
        # Sellable cards with per-resource revenue estimates so the human
        # can pick which resource to sell (instead of auto-picking the best).
        can_sell: list[dict] = []
        if cr >= 1:
            for i, card in enumerate(player.hand):
                if not card.can_sell:
                    continue
                resources = []
                for r in card.can_sell:
                    rate = max(0, player.rate(r))
                    if rate > 0:
                        price = self.state.market.price(r)
                        resources.append({
                            "resource": r.value,
                            "rate": rate,
                            "price": price,
                            "revenue": rate * price,
                        })
                if resources:
                    can_sell.append({
                        "card_idx": i,
                        "resources": resources,
                    })

        # Special-building consumable status
        se_owned = _count_buildings(player, "Space Elevator") > 0
        se_used = player.has_used_space_elevator_this_turn
        lp_owned = _count_buildings(player, "Launch Pad") > 0
        lp_used = player.has_used_launch_pad_this_turn
        ha_owned = _count_buildings(player, "Hacker Array") > 0
        oc_owned = _count_buildings(player, "Optimization Center") > 0
        oc_used = player.has_used_optimization_center_this_turn
        oc_resources = [
            r.value for r in Resource
            if r != Resource.PWR and player.rate(r) > 0
        ]

        # Contract-fulfillable combinations. Each entry includes flags for
        # which special-building paths it requires. With the new SE semantics
        # (-1 to ONE resource), we enumerate per-resource elevator picks too.
        # Path A (hand card) costs 1 AP; Path B (Launch Pad) is free, so LP
        # entries are emitted regardless of AP.
        can_contract: list[dict] = []
        for j, contract in enumerate(self.state.available_contracts):
            plain_reqs = effective_contract_requirements(player, contract, apply_elevator=False)
            plain_ok = all(player.rate(req.resource) >= req.amount for req in plain_reqs)

            # Per-resource SE picks: which targets make this contract affordable?
            se_targets: list[str] = []
            if se_owned and not se_used:
                for req in contract.requirements:
                    target = req.resource.value
                    disc_reqs = effective_contract_requirements(
                        player, contract, apply_elevator=True, elevator_target=target
                    )
                    if all(r.amount == 0 or player.rate(r.resource) >= r.amount for r in disc_reqs):
                        se_targets.append(target)

            if not plain_ok and not se_targets:
                continue

            # Path A — hand cards (spends 1 card)
            if cr >= 1:
                for i, card in enumerate(player.hand):
                    if not card.can_fulfill_contract:
                        continue
                    if plain_ok:
                        can_contract.append({
                            "card_idx": i, "contract_idx": j,
                            "use_elevator": False, "use_launch_pad": False,
                            "elevator_target": "",
                        })
                    for target in se_targets:
                        can_contract.append({
                            "card_idx": i, "contract_idx": j,
                            "use_elevator": True, "use_launch_pad": False,
                            "elevator_target": target,
                        })
            # Path B — Launch Pad (FREE, no AP cost; still gated by per-turn flag)
            if lp_owned and not lp_used:
                if plain_ok:
                    can_contract.append({
                        "card_idx": -1, "contract_idx": j,
                        "use_elevator": False, "use_launch_pad": True,
                        "elevator_target": "",
                    })
                for target in se_targets:
                    can_contract.append({
                        "card_idx": -1, "contract_idx": j,
                        "use_elevator": True, "use_launch_pad": True,
                        "elevator_target": target,
                    })

        # Active patent status (Water Engine, Nanotechnology, Teleportation)
        # Each entry: owned + available (owned & not used & any other gates).
        we_owned = _player_owns_patent(player, "Water Engine")
        nano_owned = _player_owns_patent(player, "Nanotechnology")
        tele_owned = _player_owns_patent(player, "Teleportation")
        # Teleportation needs the player to have at least one positive non-PWR
        # rate to sell (and PWR rate may go negative — no constraint there).
        tele_resources = [
            r.value for r in Resource
            if r != Resource.PWR and player.rate(r) > 0
        ]
        # `used` reflects ONLY the per-turn flag — useful for the UI to
        # distinguish "already used this turn" from "cannot use right now"
        # (e.g. Water Engine with no H2O rate). `available` combines all
        # gates (owned + not used + other prerequisites).
        patent_actions = {
            "water_engine": {
                "owned": we_owned,
                "used": player.has_used_water_engine_this_turn,
                "available": (
                    we_owned
                    and not player.has_used_water_engine_this_turn
                    and player.rate(Resource.H2O) >= 1
                ),
            },
            "nanotechnology": {
                "owned": nano_owned,
                "used": player.has_used_nanotechnology_this_turn,
                "available": nano_owned and not player.has_used_nanotechnology_this_turn and bool(self.state.pool),
            },
            "teleportation": {
                "owned": tele_owned,
                "used": player.has_used_teleportation_this_turn,
                "available": (
                    tele_owned
                    and not player.has_used_teleportation_this_turn
                    and len(tele_resources) > 0
                ),
                "valid_resources": tele_resources,
            },
        }

        return {
            "already_built": already_built,
            "cards_remaining": cr,
            "max_build_cards": max_build_cards,
            "affordable_single_builds": affordable,
            "can_sell": can_sell,
            "can_contract": can_contract,
            "space_elevator_status": {"owned": se_owned, "used": se_used},
            "launch_pad_status": {"owned": lp_owned, "used": lp_used},
            "hacker_array_status": {"owned": ha_owned},
            "optimization_center_status": {
                "owned": oc_owned,
                "used": oc_used,
                "available": oc_owned and not oc_used and len(oc_resources) > 0,
                "valid_resources": oc_resources,
            },
            "patent_actions": patent_actions,
        }

    def peek_patent_office_patents(self) -> list[dict]:
        """Return the top 2 patents from the pile for a Patent Office pick.

        Only call this AFTER the player has committed to building a Patent
        Office (not before — the patents are hidden information until then).
        Returns a list of 0-2 dicts with {name, effect}.
        """
        s = self.state
        return [
            {"name": p.building, "effect": p.effect}
            for p in s.patent_pile[s.patent_idx : s.patent_idx + 2]
        ]

    def estimate_build_cost(self, build_indices: list[int]) -> dict:
        """Estimate the market cost of a proposed multi-card build.

        Used by the UI to show live feedback as the user selects cards.
        Returns {"ok": True, "cost": int, "deficit": {resource: amount}} if
        affordable, or {"ok": False, "reason": str} otherwise.
        """
        if not self.is_human_turn():
            return {"ok": False, "reason": "Not your turn"}
        player = self.current_player()
        from my_project.simulation import _player_owns_patent
        if player.has_built_this_turn and not _player_owns_patent(player, "Matter Replication"):
            return {"ok": False, "reason": "Already built this turn"}
        if not build_indices:
            return {"ok": False, "reason": "No cards selected"}
        cards = [player.hand[i] for i in build_indices]
        result = compute_build_deficit(cards, player, self.state.market)
        if result is None:
            return {"ok": False, "reason": "Cannot afford", "cost": -1}
        deficit, cost = result
        return {
            "ok": True,
            "cost": cost,
            "deficit": {r.value: amt for r, amt in deficit.items()},
        }

    def final_scores(self) -> list[dict]:
        """Return final ranking when game is over."""
        scores = [
            {
                "index": i,
                "name": p.name,
                "corporation": p.corporation,
                "net_worth": p.net_worth(),
                "money": p.money,
                "debt": p.debt,
                "credit": p.credit,
                "contracts_fulfilled": p.contracts_fulfilled,
                "buildings_played": p.building_names(),
                "is_human": i == self.human_index,
            }
            for i, p in enumerate(self.state.players)
        ]
        scores.sort(key=lambda d: -d["net_worth"])
        return scores


def _card_dict(card: Card) -> dict:
    return {
        "building": card.building,
        "slot": card.slot,
        "alternate": card.alternate,
        "costs": [{"resource": ra.resource.value, "amount": ra.amount} for ra in card.costs],
        "rates": [{"resource": ra.resource.value, "amount": ra.amount} for ra in card.rates],
        "effect": card.effect,
        "can_sell": [r.value for r in card.can_sell],
        "can_fulfill_contract": card.can_fulfill_contract,
    }


def _contract_dict(contract: Contract) -> dict:
    return {
        "requirements": [
            {"resource": ra.resource.value, "amount": ra.amount} for ra in contract.requirements
        ],
        "reward": contract.reward,
        "label": ", ".join(f"{ra.amount} {ra.resource.value}" for ra in contract.requirements),
    }


def _player_dict(player: Player, is_human: bool, reveal_hand: bool = False) -> dict:
    return {
        "name": player.name,
        "corporation": player.corporation,
        "money": player.money,
        "debt": player.debt,
        "credit": player.credit,
        "net_worth": player.net_worth(),
        "rates": {r.value: v for r, v in player.rates.items()},
        # buildings_played keeps the original string-list shape for the
        # existing UI / analytics consumers. built_cards is the parallel
        # rich form (one dict per built card) used by special-building UI.
        "buildings_played": player.building_names(),
        "built_cards": [_card_dict(c) for c in player.buildings_played],
        "contracts_fulfilled": player.contracts_fulfilled,
        "hand_size": len(player.hand),
        "hand": [_card_dict(c) for c in player.hand] if reveal_hand else [],
        "cards_remaining": player.cards_remaining(),
        "is_human": is_human,
    }


def _nw_snapshot(player: Player) -> dict:
    """Return a dict of the player's current NW components.

    Used by the patent active-action methods so their results carry the
    same after-action snapshot as `_record_to_dict`, letting the play log
    show how each action moved the bottom line.
    """
    return {
        "money_after": player.money,
        "debt_after": player.debt,
        "credit_after": player.credit,
        "net_worth_after": player.net_worth(),
    }


def _record_to_dict(record, ok: bool = True, player: Player | None = None) -> dict:
    """Serialize an action record for the play UI.

    If `player` is supplied, snapshots the player's POST-action net worth
    components (money / debt / credit / net_worth) so the frontend can
    show how each individual action moved the bottom line.
    """
    out = {
        "ok": ok,
        "type": record.action_type,
        "detail": record.detail,
        "buildings": list(record.buildings),
        "build_money_spent": record.build_money_spent,
        "rates_gained": dict(record.rates_gained),
        "sell_resource": record.sell_resource,
        "sell_amount": record.sell_amount,
        "sell_revenue": record.sell_revenue,
        "contract_label": record.contract_label,
        "contract_reward": record.contract_reward,
    }
    if player is not None:
        out["money_after"] = player.money
        out["debt_after"] = player.debt
        out["credit_after"] = player.credit
        out["net_worth_after"] = player.net_worth()
    return out
