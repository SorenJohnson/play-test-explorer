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
    Player,
    _default_ai_bid,
    compute_build_deficit,
    effective_contract_requirements,
    execute_build,
    execute_contract,
    execute_event_with_redraws,
    execute_sell,
    settle_silent_auction,
    swap_pool_card,
)
from my_project.strategies import (
    greedy_strategy,
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
    event_deck_config: EventDeckConfig | None = None
    # When provided, overrides build_event_deck entirely.
    custom_event_deck: list[EventCard] | None = None
    data_dir: Path = field(default_factory=lambda: DEFAULT_DATA_DIR)

    state: GameState = field(init=False)
    _human_indices: set[int] = field(default_factory=set, init=False)
    last_event: str = field(default="", init=False)
    last_ai_actions: list[dict] = field(default_factory=list, init=False)
    human_turn_in_progress: bool = field(default=False, init=False)
    # One snapshot per completed player-turn so the UI can plot market drift.
    # Entry shape: {"turn": int (1-indexed player-turn), "market": {res_str: price}}.
    market_history: list[dict] = field(default_factory=list, init=False)
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
        # Seed history with the starting market so the UI chart has a turn-0 anchor.
        self._snapshot_market(turn=0)

    def _snapshot_market(self, turn: int) -> None:
        self.market_history.append({
            "turn": turn,
            "market": {r.value: self.state.market.price(r) for r in Resource},
        })

    # --- Status queries ---

    def _turn_in_progress(self) -> bool:
        """True if a turn's event has been pre-advanced but not yet fired.

        During this period event_idx is one ahead of the player whose turn is
        active, so callers need to compensate.
        """
        return self._active_player_idx >= 0

    def is_over(self) -> bool:
        # Game ends when we've played all the player-turns OR the event deck
        # is exhausted (which can happen if redraws consume END_GAME early).
        if self._turn_in_progress():
            return False
        if self._turn_count >= self.max_turns * self.num_players:
            return True
        return self.state.event_idx >= len(self.state.event_deck)

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
        return self.current_player_index() in self._human_indices and not self.is_over()

    def current_player(self) -> Player:
        return self.state.players[self.current_player_index()]

    def turn_number(self) -> int:
        """1-indexed player turn number (out of max_turns * num_players)."""
        if self._turn_in_progress():
            return self._turn_count
        return self._turn_count + 1

    def round_number(self) -> int:
        """1-indexed round (1..max_turns). Each round is num_players player-turns."""
        effective = self._turn_count - 1 if self._turn_in_progress() else self._turn_count
        return (effective // self.num_players) + 1

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
        # Reset per-turn state
        active = self.state.players[self._active_player_idx]
        active.has_built_this_turn = False
        active.has_used_space_elevator_this_turn = False
        active.has_used_launch_pad_this_turn = False
        # Pre-advance event_idx and stash the current turn's event so that
        # state.remaining_events() does NOT reveal it to the UI or any helper
        # that inspects remaining events during the action phase.
        self._pending_event = self.state.event_deck[self.state.event_idx]
        self.state.event_idx += 1

    def end_human_turn(self) -> dict:
        """Complete the human turn: draw back to hand size, fire the event.

        Returns a dict describing the fired event so the UI can render it.
        """
        if not self.human_turn_in_progress:
            raise RuntimeError("begin_human_turn was not called")

        player = self.current_player()

        # Draw back to hand size
        needed = player.hand_size - len(player.hand)
        if needed > 0:
            player.hand.extend(self.state.deck.draw(needed))

        # Fire the pre-stashed event. event_idx was already advanced in
        # begin_human_turn; do NOT advance it again here.
        event = self._pending_event
        event_detail = execute_event_with_redraws(self.state, event, player)
        self._pending_event = None
        self.last_event = event_detail

        self.human_turn_in_progress = False
        self._active_player_idx = -1
        self._snapshot_market(turn=self.state.turn)
        return {"type": event.type.value, "detail": event_detail}

    def apply_human_action(self, action: dict) -> dict:
        """Apply a single action for the human player.

        `action` is a dict with at minimum `type` in {build, sell, contract, pass}.
        Additional keys per type:
          - build: build_cards (list[int]), discard_cards (list[int])
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
            if player.has_built_this_turn:
                return {"ok": False, "reason": "Already built this turn"}
            build_idx = list(action.get("build_cards") or [])
            discard_idx = list(action.get("discard_cards") or [])
            if not build_idx:
                return {"ok": False, "reason": "No cards selected"}
            record = execute_build(self.state, player, build_idx, discard_idx)
            if record is None:
                return {"ok": False, "reason": "Cannot afford build (or duplicate special)"}
            self._turn_action_records.append(record)
            return _record_to_dict(record, ok=True)

        if atype == "sell":
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
                hacker_target=action.get("hacker_target") or None,
                hacker_direction=int(action.get("hacker_direction", 0) or 0),
            )
            self._turn_action_records.append(record)
            return _record_to_dict(record, ok=True)

        if atype == "contract":
            card_idx = action.get("card_idx", -1)
            contract_idx = action.get("contract_idx", -1)
            use_elevator = bool(action.get("use_elevator", False))
            use_launch_pad = bool(action.get("use_launch_pad", False))
            elevator_target = action.get("elevator_target") or None
            if not use_launch_pad:
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
            return _record_to_dict(record, ok=True)

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

    def set_patent_bid(self, seat_idx: int, amount: int) -> dict:
        """Set a human seat's bid for the next patent auction.

        The bid is stored on `state.pending_bids` and consumed by the next
        PATENT_AUCTION event (which could fire on this player's turn or any
        later one). The bid is rounded down to the nearest $5 and clamped
        to >= 0. Pre-declaring lets each human pick their bid in advance,
        rather than mid-event modal interruptions.
        """
        if seat_idx not in self._human_indices:
            return {"ok": False, "reason": "Seat is not human"}
        amount = max(0, int(amount))
        amount = (amount // 5) * 5
        self.state.pending_bids[seat_idx] = amount
        return {"ok": True, "amount": amount}

    def clear_patent_bid(self, seat_idx: int) -> dict:
        """Clear a previously declared bid for a human seat."""
        self.state.pending_bids.pop(seat_idx, None)
        return {"ok": True}

    def set_oc_pick(self, seat_idx: int, resource: str) -> dict:
        """Set a human seat's Optimization Center target for the next futures
        settlement. Validated against Resource enum and excludes PWR."""
        if seat_idx not in self._human_indices:
            return {"ok": False, "reason": "Seat is not human"}
        try:
            res = Resource(resource)
        except ValueError:
            return {"ok": False, "reason": f"Invalid resource: {resource}"}
        if res == Resource.PWR:
            return {"ok": False, "reason": "PWR is not a valid OC target"}
        self.state.pending_oc_picks[seat_idx] = res.value
        return {"ok": True, "resource": res.value}

    def clear_oc_pick(self, seat_idx: int) -> dict:
        """Clear a previously declared OC target."""
        self.state.pending_oc_picks.pop(seat_idx, None)
        return {"ok": True}

    # --- AI turn ---

    def step_ai_turn(self) -> dict:
        """Run one complete AI turn (pool swap + actions + draw + event).

        Returns a dict with the action log and event result.
        """
        if self.is_over():
            return {"ok": False, "reason": "Game is over"}
        if self.is_human_turn():
            return {"ok": False, "reason": "It's the human's turn"}

        # Record active player via _turn_count, BEFORE incrementing it.
        # event_idx pre-advances independently so the strategy's
        # remaining_events() call does not include the current turn's event
        # (matching simulation.run_game).
        acting_player_idx = self._turn_count % self.num_players
        self._active_player_idx = acting_player_idx
        self._turn_count += 1
        player = self.state.players[acting_player_idx]
        event = self.state.event_deck[self.state.event_idx]
        self.state.event_idx += 1

        # Snapshot hand-before so we can diff action records into a log
        actions_log: list[dict] = []

        # Reset per-turn state
        player.has_built_this_turn = False
        player.has_used_space_elevator_this_turn = False
        player.has_used_launch_pad_this_turn = False

        # Look up this seat's strategy. seats is fully populated by __post_init__.
        strategy_fn = _resolve_strategy(self.seats[acting_player_idx])

        # Pool swap phase
        swap_fn = getattr(strategy_fn, "pool_swap", None)
        if swap_fn:
            swap_fn(self.state, player)

        # Action phase
        self.state.turn += 1
        actions_taken = 0
        max_actions = 10  # mirrors MAX_ACTIONS_PER_TURN
        while player.hand and actions_taken < max_actions:
            action = strategy_fn(self.state, player)
            if action.action_type == ActionType.PASS:
                break
            record = self._execute_ai_action(player, action)
            if record is not None:
                actions_log.append(_record_to_dict(record, ok=True))
            actions_taken += 1

        # Draw
        needed = player.hand_size - len(player.hand)
        if needed > 0:
            player.hand.extend(self.state.deck.draw(needed))

        # Event. event_idx was already advanced above; do NOT advance it again.
        event_detail = execute_event_with_redraws(self.state, event, player)
        self.last_event = event_detail
        self.last_ai_actions = actions_log

        # End of turn: clear the active-turn marker.
        self._active_player_idx = -1
        self._snapshot_market(turn=self.state.turn)

        return {
            "ok": True,
            "player_index": acting_player_idx,
            "actions": actions_log,
            "event": {"type": event.type.value, "detail": event_detail},
        }

    def _execute_ai_action(self, player: Player, action: Action):
        if action.action_type == ActionType.BUILD and action.build_cards:
            return execute_build(self.state, player, action.build_cards, action.discard_cards)
        if action.action_type == ActionType.SELL and action.sell_card >= 0:
            return execute_sell(self.state, player, action.sell_card)
        if action.action_type == ActionType.CONTRACT and action.contract_card >= 0:
            return execute_contract(self.state, player, action.contract_card, action.contract_idx)
        return None

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
            "max_rounds": self.max_turns,
            "turn_index": turn_index,
            "total_turns": len(s.event_deck),
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
            # Patent state for the auction UI
            "patent_pile_remaining": max(0, len(s.patent_pile) - s.patent_idx),
            "pending_bids": dict(s.pending_bids),
            # Optimization Center pre-declared picks (seat → resource string)
            "pending_oc_picks": dict(s.pending_oc_picks),
        }

    # --- Legal action enumeration (for UI hinting) ---

    def legal_human_actions(self) -> dict:
        """Summarize what actions the human can currently take.

        Returns a dict with:
          - already_built: bool — True if a build action has already been taken
          - affordable_single_builds: list of {card_idx, cost} for single-card
            builds that are currently affordable (UI hint only; real build is
            a multi-card action).
          - can_sell: list of card indices sellable this turn
          - can_contract: list of {card_idx, contract_idx} pairs currently legal
        """
        if not self.is_human_turn():
            return {
                "already_built": False,
                "affordable_single_builds": [],
                "can_sell": [],
                "can_contract": [],
                "space_elevator_status": {"owned": False, "used": False},
                "launch_pad_status": {"owned": False, "used": False},
                "hacker_array_status": {"owned": False},
                "optimization_center_owned": False,
            }
        player = self.current_player()
        already_built = player.has_built_this_turn

        from my_project.simulation import _count_buildings

        # Affordable single-card builds (only meaningful if not already built).
        # Skips slot-4 specials the player already owns (one-of-each rule).
        affordable = []
        if not already_built:
            for i, card in enumerate(player.hand):
                if card.effect and _count_buildings(player, card.building) > 0:
                    continue  # already owns this special
                result = compute_build_deficit([card], player, 0, self.state.market)
                if result is not None:
                    _, cost = result
                    affordable.append({"card_idx": i, "cost": cost})

        # Sellable cards
        can_sell = []
        for i, card in enumerate(player.hand):
            if not card.can_sell:
                continue
            if any(player.rate(r) > 0 for r in card.can_sell):
                can_sell.append(i)

        # Special-building consumable status
        se_owned = _count_buildings(player, "Space Elevator") > 0
        se_used = player.has_used_space_elevator_this_turn
        lp_owned = _count_buildings(player, "Launch Pad") > 0
        lp_used = player.has_used_launch_pad_this_turn
        ha_owned = _count_buildings(player, "Hacker Array") > 0
        oc_owned = _count_buildings(player, "Optimization Center") > 0

        # Contract-fulfillable combinations. Each entry includes flags for
        # which special-building paths it requires. With the new SE semantics
        # (-1 to ONE resource), we enumerate per-resource elevator picks too.
        can_contract = []
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
                    if all(player.rate(r.resource) >= r.amount for r in disc_reqs):
                        se_targets.append(target)

            if not plain_ok and not se_targets:
                continue

            # Real hand cards
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
            # Launch Pad path (no hand card needed)
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

        return {
            "already_built": already_built,
            "affordable_single_builds": affordable,
            "can_sell": can_sell,
            "can_contract": can_contract,
            "space_elevator_status": {"owned": se_owned, "used": se_used},
            "launch_pad_status": {"owned": lp_owned, "used": lp_used},
            "hacker_array_status": {"owned": ha_owned},
            "optimization_center_owned": oc_owned,
        }

    def estimate_build_cost(self, build_indices: list[int], discard_indices: list[int]) -> dict:
        """Estimate the market cost of a proposed multi-card build.

        Used by the UI to show live feedback as the user selects cards.
        Returns {"ok": True, "cost": int, "deficit": {resource: amount}} if
        affordable, or {"ok": False, "reason": str} otherwise.
        """
        if not self.is_human_turn():
            return {"ok": False, "reason": "Not your turn"}
        player = self.current_player()
        if player.has_built_this_turn:
            return {"ok": False, "reason": "Already built this turn"}
        if not build_indices:
            return {"ok": False, "reason": "No cards selected"}
        cards = [player.hand[i] for i in build_indices]
        result = compute_build_deficit(cards, player, len(discard_indices), self.state.market)
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
        "is_human": is_human,
    }


def _record_to_dict(record, ok: bool = True) -> dict:
    return {
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
