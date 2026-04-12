"""Game state model and simulation engine for the board game.

Simulates N players taking turns: draw cards, take one action (build/sell/contract),
draw back to hand size, then resolve one event from the event deck.
"""

from __future__ import annotations

import random
from collections import defaultdict
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path

from my_project.accounting import CostLedger
from my_project.models import Card, Contract, Resource, ResourceAmount


# --- Game configuration (loaded from GameConfig.csv) ---
#
# These module-level constants are the single source of truth consumed by
# the engine. They are loaded from data/GameConfig.csv at import time so
# non-technical users can tune them by editing the CSV. The names are kept
# as module-level constants (ALL_CAPS) for backward compatibility with
# existing imports throughout the codebase.

def _load_game_config() -> dict[str, str]:
    from my_project.parsing import parse_game_config
    cfg_path = Path(__file__).parent / "data" / "GameConfig.csv"
    if cfg_path.exists():
        return parse_game_config(cfg_path)
    return {}

_CFG = _load_game_config()

# --- Market ---

PRICE_TRACK = [1, 1, 1, 2, 2, 2, 3, 3, 4, 4, 5, 5, 6, 7, 8, 9, 10]

# Game balance constants (sourced from GameConfig.csv, with hardcoded fallbacks)
DEFAULT_MAX_TURNS = int(_CFG.get("default_max_turns", "8"))
DEFAULT_NUM_PLAYERS = int(_CFG.get("default_num_players", "3"))
DEFAULT_START_MONEY = int(_CFG.get("default_start_money", "20"))
DEFAULT_MARKET_POS = int(_CFG.get("default_market_position", "9"))
HAND_SIZE = int(_CFG.get("hand_size", "3"))
POOL_SIZE = int(_CFG.get("pool_size", "4"))
CONTRACTS_AVAILABLE_BASE = int(_CFG.get("contracts_available_base", "2"))
CONTRACT_REWARD = int(_CFG.get("contract_reward", "50"))
DEBT_INTEREST_DIVISOR = int(_CFG.get("debt_interest_divisor", "10"))
MAX_CARDS_PER_TURN = int(_CFG.get("max_cards_per_turn", "2"))
MAX_ACTIONS_PER_TURN = 10  # safety limit — not a design parameter

# Event deck composition (random within ranges)
POWER_BILL_RANGE = (3, 4)
DEBT_COLLECTION_RANGE = (2, 4)
FUTURES_SETTLEMENT_RANGE = (3, 4)





def _load_corporations(data_dir: Path | None = None) -> list[tuple[str, dict[str, int]]]:
    """Load corporations from Corporations.csv."""
    from my_project.parsing import parse_corporations
    if data_dir is None:
        data_dir = Path(__file__).parent / "data"
    return parse_corporations(data_dir / "Corporations.csv")


@dataclass
class Market:
    """Tracks price position (index into PRICE_TRACK) for each resource."""
    positions: dict[Resource, int] = field(default_factory=dict)

    @classmethod
    def create(cls, start_position: int = 10) -> Market:
        """All resources start at the same position (default index 4 = price $2)."""
        return cls(positions={r: start_position for r in Resource})

    def price(self, resource: Resource) -> int:
        pos = self.positions[resource]
        pos = max(0, min(pos, len(PRICE_TRACK) - 1))
        return PRICE_TRACK[pos]

    def buy(self, resource: Resource, amount: int) -> int:
        """Buy `amount` units at the current price. Returns total cost. Then price rises by amount."""
        cost = self.price(resource) * amount
        self.positions[resource] = min(self.positions[resource] + amount, len(PRICE_TRACK) - 1)
        return cost

    def sell(self, resource: Resource, amount: int) -> int:
        """Sell `amount` units at the current price. Returns total revenue. Then price drops by amount."""
        revenue = self.price(resource) * amount
        self.positions[resource] = max(self.positions[resource] - amount, 0)
        return revenue

    def adjust(self, resource: Resource, delta: int) -> None:
        """Shift price position by delta (positive = up, negative = down)."""
        self.positions[resource] = max(0, min(
            self.positions[resource] + delta, len(PRICE_TRACK) - 1
        ))

    def estimate_buy_cost(self, resource: Resource, amount: int) -> int:
        """Estimate cost of buying without modifying market state.

        All units pay the current price (matches buy() semantics).
        """
        return self.price(resource) * amount

    def snapshot(self) -> dict[str, int]:
        return {r.value: self.price(r) for r in Resource}


# --- Player ---

@dataclass
class Player:
    name: str
    money: int = 20
    debt: int = 0
    # Contract credit: leftover reward from fulfilled contracts after paying
    # off any existing debt. Counts toward net worth (like cash) AND absorbs
    # future debt before it becomes real debt. NOT spendable as cash.
    credit: int = 0
    rates: dict[Resource, int] = field(default_factory=lambda: {r: 0 for r in Resource})
    hand: list[Card] = field(default_factory=list)
    # Cards the player has built. Each entry is the original Card so special-
    # building handlers can read its `effect` field at activation/trigger time.
    buildings_played: list[Card] = field(default_factory=list)
    contracts_fulfilled: int = 0
    hand_size: int = HAND_SIZE
    ledger: CostLedger = field(default_factory=CostLedger.create)
    corporation: str = ""
    starting_rates: dict[str, int] = field(default_factory=dict)
    # Per-player resource flows (units and cash)
    flow_bought_units: dict[Resource, int] = field(default_factory=lambda: {r: 0 for r in Resource})
    flow_sold_units: dict[Resource, int] = field(default_factory=lambda: {r: 0 for r in Resource})
    flow_buy_cost: dict[Resource, float] = field(default_factory=lambda: {r: 0.0 for r in Resource})
    flow_sell_revenue: dict[Resource, int] = field(default_factory=lambda: {r: 0 for r in Resource})
    flow_futures_units: dict[Resource, int] = field(default_factory=lambda: {r: 0 for r in Resource})
    flow_futures_cost: dict[Resource, int] = field(default_factory=lambda: {r: 0 for r in Resource})
    # Per-turn state: resets at the start of each of this player's turns.
    # Rule: only one BUILD action is allowed per turn (multi-card builds
    # are fine, but subsequent build actions are blocked). This prevents
    # rates from being reused as a free discount across separate actions.
    has_built_this_turn: bool = False
    # Special-building per-turn flags (each is a "use once per turn"
    # capability that refreshes between turns, NOT a one-shot consumable).
    has_used_space_elevator_this_turn: bool = False
    has_used_launch_pad_this_turn: bool = False
    has_used_optimization_center_this_turn: bool = False
    # Active-patent per-turn flags (same shape).
    has_used_water_engine_this_turn: bool = False
    has_used_nanotechnology_this_turn: bool = False
    has_used_teleportation_this_turn: bool = False
    # Tracks how many hand cards have been spent this turn (builds, sells,
    # contracts, and build-deficit discards all count). Resets to 0 at the
    # start of each player turn. Capped at MAX_CARDS_PER_TURN.
    # Nanotechnology is explicitly exempt.
    cards_spent_this_turn: int = 0
    # Per-patent stateful storage. Currently used by Energy Vault — key
    # "energy_vault" → remaining PWR units in the vault. Other patents may
    # add their own keys later.
    patent_state: dict[str, int] = field(default_factory=dict)

    def net_worth(self) -> int:
        return self.money - self.debt + self.credit

    def cards_remaining(self) -> int:
        """How many more hand cards the player can spend this turn."""
        return MAX_CARDS_PER_TURN - self.cards_spent_this_turn

    def rate(self, resource: Resource) -> int:
        return self.rates.get(resource, 0)

    def apply_rates(self, card: Card) -> None:
        for ra in card.rates:
            self.rates[ra.resource] = self.rates.get(ra.resource, 0) + ra.amount

    def building_names(self) -> list[str]:
        """Names of buildings the player has constructed, in build order."""
        return [c.building for c in self.buildings_played]

    def snapshot(self) -> dict:
        return {
            "money": self.money,
            "debt": self.debt,
            "credit": self.credit,
            "net_worth": self.net_worth(),
            "rates": {r.value: v for r, v in self.rates.items()},
            "buildings_played": self.building_names(),
            "contracts_fulfilled": self.contracts_fulfilled,
        }


# --- Deck ---

@dataclass
class Deck:
    cards: list[Card] = field(default_factory=list)
    discard: list[Card] = field(default_factory=list)

    @classmethod
    def from_cards(cls, cards: list[Card]) -> Deck:
        deck = cls(cards=list(cards))
        random.shuffle(deck.cards)
        return deck

    def draw(self, n: int = 1) -> list[Card]:
        drawn = []
        for _ in range(n):
            if not self.cards:
                if not self.discard:
                    break
                self.cards = self.discard
                self.discard = []
                random.shuffle(self.cards)
            if self.cards:
                drawn.append(self.cards.pop())
        return drawn

    def remaining(self) -> int:
        return len(self.cards) + len(self.discard)


# --- Events ---

class EventType(StrEnum):
    NO_EVENT = "no_event"
    PWR_ADJUST = "pwr_adjust"
    POWER_BILL = "power_bill"
    DEBT_COLLECTION = "debt_collection"
    FUTURES_SETTLEMENT = "futures_settlement"
    # Direct news with payload-based market deltas (for ad-hoc JSON config).
    NEWS = "news"
    # Draws and resolves a card from the news deck (data-driven via Events.csv).
    NEWS_BULLETIN = "news_bulletin"
    # Refreshes the building pool by drawing a fresh card.
    DRAW_BUILDING_CARD = "draw_building_card"
    PATENT_AUCTION = "patent_auction"
    # End-of-round: fires PB + Futures Settlement like END_GAME, but the
    # game continues into the next round with a fresh event deck shuffle.
    END_ROUND = "end_round"
    END_GAME = "end_game"


@dataclass
class EventCard:
    """A single card in the event deck.

    For simple events (power bill, futures settlement, etc.) only `type` is
    needed. The optional `payload` dict carries per-event parameters for
    data-driven events like NEWS. `label` is a human-readable display string
    for the turn log; if empty, falls back to `type.value`.

    `redraws=True` means: after firing this card's effect, the engine
    immediately draws and fires the NEXT event card too as part of the same
    player-turn. The deck must be sized to account for these extra
    consumptions (build_event_deck handles this).
    """
    type: EventType
    payload: dict | None = None
    label: str = ""
    redraws: bool = False
    pwr_adjust: bool = False

    def display_label(self) -> str:
        return self.label or self.type.value


def _ec(t: EventType, redraws: bool = False, pwr_adjust: bool = False) -> EventCard:
    """Shorthand for creating a simple (no-payload) EventCard."""
    return EventCard(type=t, redraws=redraws, pwr_adjust=pwr_adjust)


# --- News deck ---


@dataclass
class NewsEffect:
    """A single effect on a news card.

    `kind` selects the handler:
      - "rate_all": apply rate deltas to every player. payload = {"FOOD": -1, ...}
      - "market_random": roll the d20 distribution N times for each listed
            resource. payload = {"resources": ["H2O", ...], "rolls": 1}
      - "trigger": re-fire one of the standard event types in-place.
            payload = {"event": "power_bill"|"debt_collection"|"futures_settlement"}
    """
    kind: str
    payload: dict


@dataclass
class NewsCard:
    name: str
    effects: list[NewsEffect] = field(default_factory=list)


# Same d20 distribution used by GameState.create's randomize_market roll.
_D20_DELTAS = [3, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, -2, -2, -2, -3, -3, -4, -4, 0]


def build_default_news_deck(data_dir: Path | None = None) -> list[NewsCard]:
    """Build a fresh news deck from News.csv.

    Each row in News.csv becomes one NewsCard with typed effects. The CSV
    is the single source of truth for news content — no hardcoded effects.
    """
    from my_project.parsing import parse_news
    if data_dir is None:
        data_dir = Path(__file__).parent / "data"
    raw = parse_news(data_dir / "News.csv")
    cards: list[NewsCard] = []
    for entry in raw:
        effects = [NewsEffect(kind=e["kind"], payload=e["payload"]) for e in entry["effects"]]
        cards.append(NewsCard(name=entry["name"], effects=effects))
    return cards


@dataclass
class EventDeckConfig:
    """Configurable composition for the event deck.

    Each count field accepts either a fixed int or a (min, max) tuple for
    random variation. Defaults are sourced from default_event_counts() which
    encodes the Events.csv composition (player-count conditionals included).

    `news_pool` is the JSON-friendly direct-NEWS pool (legacy NEWS event type
    with explicit market_deltas in payload). The data-driven NEWS_BULLETIN
    flow uses the news deck on GameState, populated from NEWS_EFFECTS.
    """
    power_bill_count: int | tuple[int, int] | None = None
    debt_collection_count: int | tuple[int, int] | None = None
    futures_settlement_count: int | tuple[int, int] | None = None
    news_bulletin_count: int | tuple[int, int] | None = None
    patent_auction_count: int | tuple[int, int] | None = None
    draw_building_count: int | tuple[int, int] | None = None
    draw_building_redraw_count: int | tuple[int, int] | None = None
    # Legacy direct-NEWS payload pool (used by the JSON Advanced section).
    news_pool: list[EventCard] = field(default_factory=list)
    news_count: int | tuple[int, int] = 0


def default_event_counts(num_players: int, data_dir: Path | None = None) -> dict[str, int]:
    """Return the default per-event-type counts for a given player count.

    Reads Events.csv — the single source of truth for event deck composition.
    Each CSV row has a Condition column that filters by player count and a
    Redraw column that flags draw_building_card redraws.
    """
    from my_project.parsing import parse_event_counts
    if data_dir is None:
        data_dir = Path(__file__).parent / "data"
    return parse_event_counts(data_dir / "Events.csv", num_players)


def _resolve_count(spec: int | tuple[int, int]) -> int:
    """Resolve a count spec to a concrete int."""
    if isinstance(spec, tuple):
        return random.randint(spec[0], spec[1])
    return spec


def _resolve_or_default(spec, default):
    """Use the user-supplied count if given, else fall back to the default int."""
    if spec is None:
        return default
    return _resolve_count(spec)


def _build_event_pool(
    num_players: int,
    config: EventDeckConfig,
) -> list[EventCard]:
    """Build the initial event pool from Events.csv.

    Returns an unshuffled list of EventCards. No terminal cards — the
    engine handles END_ROUND / END_GAME when the pool is exhausted.

    Patent auction cards are included in the initial pool but are removed
    (not reshuffled back) after they fire during the game.
    """
    from my_project.parsing import parse_event_rows
    data_dir = Path(__file__).parent / "data"
    rows = parse_event_rows(data_dir / "Events.csv", num_players)

    _type_map = {e.value: e for e in EventType}

    events: list[EventCard] = []
    for spec in rows:
        event_str = spec["event"]
        et = _type_map.get(event_str)
        if et is None:
            continue
        count = spec["count"]
        if event_str == "draw_building_card":
            override_key = "draw_building_redraw_count" if spec["redraw"] else "draw_building_count"
        else:
            override_key = f"{event_str}_count"
        override = getattr(config, override_key, None)
        if override is not None:
            count = _resolve_count(override)
        events.extend([
            _ec(et, redraws=spec["redraw"], pwr_adjust=spec["pwr_adjust"])
        ] * count)

    # Legacy direct-NEWS pool (JSON Advanced section).
    news_n = _resolve_count(config.news_count)
    if news_n > 0 and config.news_pool:
        events.extend(random.choices(config.news_pool, k=news_n))

    # Separate "bonus draw" markers from actual player-turn events.
    # Redraw-flagged events aren't standalone player-turns — they indicate
    # "this many events in the round also draw a building card into the pool."
    # We shuffle the real events, then randomly tag N of them with redraws=True
    # so execute_event fires a bonus draw_building_card after the primary event.
    real_events = [e for e in events if not e.redraws]
    bonus_draw_count = sum(1 for e in events if e.redraws)

    random.shuffle(real_events)

    # Tag random events to carry a bonus building-card draw
    if bonus_draw_count > 0 and real_events:
        tag_indices = random.sample(
            range(len(real_events)),
            min(bonus_draw_count, len(real_events)),
        )
        for idx in tag_indices:
            e = real_events[idx]
            real_events[idx] = EventCard(
                type=e.type, payload=e.payload, label=e.label,
                redraws=True, pwr_adjust=e.pwr_adjust,
            )

    return real_events


def build_event_deck(
    num_turns: int,
    num_players: int,
    config: EventDeckConfig | None = None,
    num_rounds: int = 2,
) -> list[EventCard]:
    """Build a shuffled event deck for a multi-round game.

    The deck is built from Events.csv. Patent auction cards are consumed
    (removed) after firing. When the deck runs out:
      - Rounds 1..N-1: fire END_ROUND (PB + Futures), reshuffle the
        remaining events (minus consumed patent auctions), continue.
      - Round N: fire END_GAME (PB + Futures), game over.

    The deck returned here is the FULL pre-built deck for all rounds.
    Patent auctions appear only in round 1; subsequent rounds have
    them removed. No terminal cards are in the deck — the engine
    handles end-of-round/game transitions when the deck pointer passes
    a round boundary.

    Round boundaries are marked by inserting a sentinel END_ROUND /
    END_GAME card at the end of each round's shuffled segment.
    """
    cfg = config or EventDeckConfig()
    pool = _build_event_pool(num_players, cfg)

    all_events: list[EventCard] = []
    for round_idx in range(num_rounds):
        is_last = round_idx == num_rounds - 1

        if round_idx > 0:
            # Remove patent auction cards for subsequent rounds
            pool = [e for e in pool if e.type != EventType.PATENT_AUCTION]

        round_events = list(pool)
        random.shuffle(round_events)

        # Append the terminal sentinel (not a player-turn — fires as cleanup)
        terminal = EventType.END_GAME if is_last else EventType.END_ROUND
        round_events.append(_ec(terminal))
        all_events.extend(round_events)

    return all_events


# --- Actions ---

class ActionType(StrEnum):
    BUILD = "build"
    SELL = "sell"
    CONTRACT = "contract"
    PASS = "pass"


@dataclass
class Action:
    action_type: ActionType
    build_cards: list[int] = field(default_factory=list)  # indices of cards to build
    discard_cards: list[int] = field(default_factory=list)  # indices of cards to discard for discount
    sell_card: int = -1  # index of card to sell with
    contract_card: int = -1  # index of card to use for contract
    contract_idx: int = -1  # index into available_contracts
    # Special-building flags carried through to execute_*:
    use_elevator: bool = False     # consume Space Elevator's per-turn discount
    use_launch_pad: bool = False   # use Launch Pad as the contract icon source
    elevator_target: str = ""      # which contract requirement to discount (resource value)
    # Per-sell Hacker Array choice (used by execute_sell when set)
    hacker_target: str = ""        # resource value (e.g. "GLS"); empty = no bonus
    hacker_direction: int = 0      # +1 / -1 / 0 for no bonus
    # Discard-2-for-contract: indices of 2 hand cards to discard instead of
    # using a contract-icon card. When set, contract_card is ignored.
    discard_card_indices: list[int] | None = None
    detail: str = ""


# --- Game State ---

@dataclass
class ActionRecord:
    """Structured record of a single action within a turn."""
    action_type: str
    detail: str
    buildings: list[str] = field(default_factory=list)
    build_costs_paid: dict[str, int] = field(default_factory=dict)  # resource -> amount bought
    build_money_spent: int = 0
    rates_gained: dict[str, int] = field(default_factory=dict)
    sell_resource: str = ""
    sell_amount: int = 0
    sell_revenue: int = 0
    contract_label: str = ""
    contract_rates_spent: dict[str, int] = field(default_factory=dict)
    contract_reward: int = 0
    contract_true_cost: float = 0.0  # net cost (after sell revenue)
    contract_gross_cost: float = 0.0  # gross cost (total invested, before revenue)


@dataclass
class TurnRecord:
    turn: int
    player: str
    action: str
    detail: str
    event: str
    money_before: int
    money_after: int
    debt: int = 0
    contracts_fulfilled: int = 0
    market_snapshot: dict[str, int] = field(default_factory=dict)
    rates_snapshot: dict[str, int] = field(default_factory=dict)
    actions: list[ActionRecord] = field(default_factory=list)


@dataclass
class GameState:
    players: list[Player]
    market: Market
    deck: Deck
    contracts: list[Contract]
    available_contracts: list[Contract]
    pool: list[Card]
    event_deck: list[EventCard]
    # News deck consumed by NEWS_BULLETIN events. Drawn without replacement;
    # reshuffled when exhausted via _shuffle_news_deck().
    news_deck: list[NewsCard] = field(default_factory=list)
    news_idx: int = 0
    # Patent pile consumed by PATENT_AUCTION events. Drawn from the top
    # without replacement. When empty, auctions become no-ops.
    patent_pile: list[Card] = field(default_factory=list)
    patent_idx: int = 0
    # Per-player bid overrides for the next patent auction. Used by the
    # play adapter to thread human-supplied bids in. Key = seat index,
    # value = bid in $5 increments. Defaults to None for "use AI heuristic".
    pending_bids: dict[int, int] = field(default_factory=dict)
    # Mid-event interruption state. When set, the event resolution loop has
    # paused waiting for human input. The play adapter exposes this to the
    # UI and resumes after the resolve_prompt call.
    # Shape:
    #   {"kind": "patent_auction", "patent_card_dict": {...}}
    pending_prompt: dict | None = None
    # When pending_prompt is set, this captures the in-flight event so the
    # play adapter can resume it after the prompt is answered.
    _suspended_event: EventCard | None = field(default=None, repr=False)
    # When the suspended event was part of a redraw chain, True means there
    # might be more events to fire after the resume.
    _suspended_chain_active: bool = field(default=False, repr=False)
    turn: int = 0
    event_idx: int = 0
    history: list[TurnRecord] = field(default_factory=list)
    # Event-driven economy tracking (summed across all players)
    pwr_total_earned: int = 0  # cash earned from positive PWR at power bills
    pwr_total_debt: int = 0  # debt incurred from negative PWR at power bills
    futures_total_debt: int = 0  # debt incurred from negative non-PWR rates at settlements
    # Per-resource event accounting:
    # bills_units_earned[r] = total positive rate units "sold" via power bills
    # bills_units_owed[r] = total negative rate units "bought" via power bills (PWR only)
    # futures_units_bought[r] = total negative rate units bought at futures settlements
    bills_units_earned: dict[Resource, int] = field(default_factory=lambda: {r: 0 for r in Resource})
    bills_units_owed: dict[Resource, int] = field(default_factory=lambda: {r: 0 for r in Resource})
    futures_units_bought: dict[Resource, int] = field(default_factory=lambda: {r: 0 for r in Resource})
    futures_debt_per_resource: dict[Resource, int] = field(default_factory=lambda: {r: 0 for r in Resource})
    # Per-event detail rows captured during the most recent event chain.
    # Cleared at the start of execute_event_with_redraws and populated by
    # _record_event_line as each do_* event runs. The play adapter snapshots
    # this list and surfaces it to the UI for the expandable event log row.
    # Lines are dicts shaped like:
    #   {"kind": "header", "text": "Power Bill — PWR @ $4"}
    #   {"kind": "note",   "text": "Energy Vault: +$40"}
    #   {"kind": "player", "player_idx": 0, "name": "Alice",
    #    "text": "+$12 (sold 3 PWR)",
    #    "money_after": 112, "debt_after": 0, "credit_after": 0,
    #    "net_worth_after": 112}
    last_event_lines: list[dict] = field(default_factory=list)
    max_turns: int = DEFAULT_MAX_TURNS
    num_rounds: int = 1

    def remaining_events(self) -> dict[EventType, int]:
        """Count remaining events from current position in event deck."""
        counts: dict[EventType, int] = {e: 0 for e in EventType}
        for ec in self.event_deck[self.event_idx:]:
            counts[ec.type] += 1
        return counts

    @classmethod
    def create(
        cls,
        all_cards: list[Card],
        all_contracts: list[Contract],
        num_players: int = 1,
        start_money: int = DEFAULT_START_MONEY,
        start_market_pos: int = DEFAULT_MARKET_POS,
        randomize_market: bool = False,
        max_turns: int = DEFAULT_MAX_TURNS,
        corporation_rates: list[dict[Resource, int]] | None = None,
        event_deck_config: EventDeckConfig | None = None,
        event_deck: list[EventCard] | None = None,
        news_deck: list[NewsCard] | None = None,
        patent_pile: list[Card] | None = None,
        num_rounds: int = 1,
    ) -> GameState:
        market = Market.create(start_market_pos)

        if randomize_market:
            for r in Resource:
                roll = random.choice([3, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, -2, -2, -2, -3, -3, -4, -4, 0])
                market.adjust(r, roll)

        # All cards from Cards.csv are playable. Cards with an `effect`
        # column have their mechanical effects wired up via patent/build
        # hooks keyed on the building name. Unknown effects are harmless —
        # the card plays as a vanilla building with its rates/costs.
        deck = Deck.from_cards(list(all_cards))

        # Draw contracts
        contracts = list(all_contracts)
        random.shuffle(contracts)
        num_available = CONTRACTS_AVAILABLE_BASE + num_players
        available = contracts[:num_available]
        remaining_contracts = contracts[num_available:]

        # Draw pool
        pool = deck.draw(POOL_SIZE)

        # Build event deck (use explicit deck if provided, else build from config)
        if event_deck is None:
            event_deck = build_event_deck(
                max_turns, num_players, event_deck_config, num_rounds=num_rounds,
            )

        # Build news deck (defaults to one card per NEWS_EFFECTS entry,
        # shuffled). Callers can supply a custom list for tests / playtesting.
        if news_deck is None:
            news_deck = build_default_news_deck()
            random.shuffle(news_deck)

        # Patent pile (shuffled at game start). Empty list = no patents
        # available; auctions become no-ops in that case.
        if patent_pile is None:
            patent_pile = []
        else:
            patent_pile = list(patent_pile)
            random.shuffle(patent_pile)

        # Create players. Assign unique corporations randomly (capped at # of corps).
        corp_pool = list(_load_corporations())
        random.shuffle(corp_pool)
        players = []
        for i in range(num_players):
            p = Player(name=f"Player_{i+1}", money=start_money)

            # Assign corporation if explicit rates not provided
            if corporation_rates and i < len(corporation_rates):
                for r, v in corporation_rates[i].items():
                    p.rates[r] = v
            elif i < len(corp_pool):
                corp_name, corp_rates = corp_pool[i]
                p.corporation = corp_name
                p.starting_rates = dict(corp_rates)
                for r_str, v in corp_rates.items():
                    res = Resource(r_str)
                    p.rates[res] = v
                    # Sync to ledger so contract/build cost tracking is consistent.
                    # Starting rates have zero cost basis (free from corporation).
                    p.ledger.accounts[res].rate = v

            hand = deck.draw(p.hand_size)
            p.hand = hand
            players.append(p)

        return cls(
            players=players,
            market=market,
            deck=deck,
            contracts=remaining_contracts,
            available_contracts=available,
            pool=pool,
            event_deck=event_deck,
            news_deck=news_deck,
            patent_pile=patent_pile,
            max_turns=max_turns,
            num_rounds=num_rounds,
        )


# --- Build cost calculation ---

def compute_build_deficit(
    cards: list[Card],
    player: Player,
    num_discards: int,
    market: Market,
) -> tuple[dict[Resource, int], int] | None:
    """Compute the market deficit and estimated cost for building multiple cards.

    Returns (deficit_per_resource, estimated_total_cost) or None if unaffordable.
    Deficit = total cost per resource - player rate, then reduced by discards
    applied to the most expensive resource first.
    """
    # Total costs across all cards
    combined: dict[Resource, int] = defaultdict(int)
    for card in cards:
        for ra in card.costs:
            combined[ra.resource] += ra.amount

    # Deficit per resource
    deficit: dict[Resource, int] = {}
    for resource, total_cost in combined.items():
        d = max(0, total_cost - max(0, player.rate(resource)))
        if d > 0:
            deficit[resource] = d

    # Apply discards to most expensive resource first
    discards_remaining = num_discards
    while discards_remaining > 0 and deficit:
        # Find the resource with highest market price
        most_expensive = max(deficit.keys(), key=lambda r: market.price(r))
        deficit[most_expensive] -= 1
        if deficit[most_expensive] <= 0:
            del deficit[most_expensive]
        discards_remaining -= 1

    # Estimate total cost
    total_cost = 0
    for resource, amount in deficit.items():
        total_cost += market.estimate_buy_cost(resource, amount)

    if total_cost > player.money:
        return None

    return deficit, total_cost


# --- Rate valuation ---

def compute_rate_time_value(resource: Resource, state: GameState) -> float:
    """Compute the time-dependent value of +1 rate of a resource.

    END_GAME event fires both a power bill and a futures settlement, so
    it counts toward both PWR and non-PWR collection totals.
    """
    remaining = state.remaining_events()
    price = state.market.price(resource)
    end_game = remaining.get(EventType.END_GAME, 0)

    if resource == Resource.PWR:
        collections = remaining.get(EventType.POWER_BILL, 0) + end_game
        return price * collections
    else:
        collections = remaining.get(EventType.FUTURES_SETTLEMENT, 0) + end_game
        return price * collections


# --- Simulation Engine ---

def execute_build(
    state: GameState,
    player: Player,
    build_indices: list[int],
    discard_indices: list[int],
    patent_office_pick: int | None = None,
) -> ActionRecord | None:
    """Play one or more building cards. Optionally discard cards to reduce deficit.

    Returns ActionRecord on success, None if:
      - the player has already built this turn (one build action per turn),
      - the total cards used (build cards + discards) would exceed
        MAX_CARDS_PER_TURN when added to cards already spent this turn.

    Every card that leaves the hand counts toward the per-turn cap:
    both the cards being built AND any discards used to reduce the
    market deficit.
    """
    if player.has_built_this_turn:
        return None

    n_build_cards = len(build_indices)
    total_cards_used = n_build_cards + len(discard_indices)
    if n_build_cards == 0:
        return None
    if total_cards_used > player.cards_remaining():
        return None

    build_cards = [player.hand[i] for i in build_indices]
    num_discards = len(discard_indices)

    # One-of-each special-building constraint: a player can only ever own
    # ONE copy of any slot-4 special. The `effect` field is the slot-4
    # marker (it's empty for ordinary buildings). This also rejects
    # multi-card builds that include duplicates of the same special.
    seen_specials_this_build: set[str] = set()
    for card in build_cards:
        if not card.effect:
            continue
        if _count_buildings(player, card.building) > 0:
            return None
        if card.building in seen_specials_this_build:
            return None
        seen_specials_this_build.add(card.building)

    # Patent build-time hooks. If the player owns any patent in
    # PATENT_BUILD_HOOKS, deep-copy the build cards before mutating them
    # so we don't corrupt the prototype shared across the deck/pool/hand.
    # The mutated copies are what get applied AND what land in
    # buildings_played, so future patent triggers see the modified rates.
    patent_names = _player_patent_names(player)
    has_patent_hooks = any(name in PATENT_BUILD_HOOKS for name in patent_names)
    if has_patent_hooks:
        import copy as _copy
        build_cards = [_copy.deepcopy(c) for c in build_cards]
        for card in build_cards:
            for name in patent_names:
                hook = PATENT_BUILD_HOOKS.get(name)
                if hook:
                    hook(state, player, card)

    result = compute_build_deficit(build_cards, player, num_discards, state.market)
    if result is None:
        return None

    deficit, _ = result

    # Actually buy from market
    total_cost = 0
    costs_paid: dict[str, int] = {}
    cost_detail = []
    for resource, amount in deficit.items():
        spent = state.market.buy(resource, amount)
        total_cost += spent
        costs_paid[resource.value] = amount
        cost_detail.append(f"{amount} {resource.value}=${spent}")
        # Per-player flow tracking
        player.flow_bought_units[resource] += amount
        player.flow_buy_cost[resource] += spent

    player.money -= total_cost

    # Aggregate rates across all cards
    all_costs: list[ResourceAmount] = []
    positive_rates: list[ResourceAmount] = []
    negative_rates: list[ResourceAmount] = []
    rates_gained: dict[str, int] = {}

    for card in build_cards:
        all_costs.extend(card.costs)
        for ra in card.rates:
            rates_gained[ra.resource.value] = rates_gained.get(ra.resource.value, 0) + ra.amount
            if ra.amount > 0:
                positive_rates.append(ra)
            elif ra.amount < 0:
                negative_rates.append(ResourceAmount(ra.resource, abs(ra.amount)))

    # Record in cost ledger (before applying rates to player)
    market_prices = {r: state.market.price(r) for r in Resource}
    player.ledger.record_build(
        costs=all_costs,
        positive_rates=positive_rates,
        negative_rates=negative_rates,
        market_spend=total_cost,
        market_prices=market_prices,
        player_rates=dict(player.rates),
    )

    # Apply rates to player
    for card in build_cards:
        player.apply_rates(card)
        player.buildings_played.append(card)
        # Patent Office build-time trigger: draw 2 patents, keep one,
        # return the other. AI auto-picks; human pick_idx comes from the
        # play adapter.
        if card.building == "Patent Office":
            _patent_office_trigger(state, player, pick_idx=patent_office_pick)

    # Remove cards from hand (highest indices first to avoid shifting) → discard pile
    all_indices = sorted(set(build_indices) | set(discard_indices), reverse=True)
    for idx in all_indices:
        state.deck.discard.append(player.hand.pop(idx))

    # Enforce one build per turn
    player.has_built_this_turn = True
    # Count all hand cards consumed (builds + discards) toward the per-turn cap
    player.cards_spent_this_turn += total_cards_used

    names = ", ".join(c.building for c in build_cards)
    detail = f"Built {names}"
    if cost_detail:
        detail += f" (bought {', '.join(cost_detail)})"
    if num_discards > 0:
        detail += f" (discarded {num_discards} cards)"

    return ActionRecord(
        action_type="build",
        detail=detail,
        buildings=[c.building for c in build_cards],
        build_costs_paid=costs_paid,
        build_money_spent=total_cost,
        rates_gained=rates_gained,
    )


def execute_sell(
    state: GameState,
    player: Player,
    card_idx: int,
    sell_resource: str | None = None,
    hacker_target: str | None = None,
    hacker_direction: int = 0,
) -> ActionRecord | None:
    """Sell resources using a card's alternate sell types.

    `sell_resource`: when provided (e.g. "FE"), sells that specific resource
    instead of auto-picking the highest-revenue one. The resource must be
    in the card's can_sell list and the player must have a positive rate.
    When None (AI default), auto-picks the best.

    `hacker_target` + `hacker_direction` are used by the Hacker Array picker:
    if the player owns a Hacker Array, they can specify a non-sold resource
    and a direction (+1 or -1) to bump the market by ±3. If the params
    aren't supplied (or the player doesn't own an HA), no bonus fires.

    Returns None if the player has no remaining card budget (sell spends 1
    hand card).
    """
    if player.cards_remaining() < 1:
        return None
    card = player.hand[card_idx]
    best_resource = None
    best_revenue = 0

    if sell_resource is not None:
        # Human chose a specific resource
        try:
            res = Resource(sell_resource)
        except ValueError:
            return None
        if res not in card.can_sell:
            return None
        rate = max(0, player.rate(res))
        if rate > 0:
            best_resource = res
            best_revenue = state.market.price(res) * rate
    else:
        # AI auto-pick: highest revenue
        for sell_res in card.can_sell:
            rate = max(0, player.rate(sell_res))
            if rate > 0:
                revenue = state.market.price(sell_res) * rate
                if revenue > best_revenue:
                    best_revenue = revenue
                    best_resource = sell_res

    if best_resource is None:
        state.deck.discard.append(player.hand.pop(card_idx))
        player.cards_spent_this_turn += 1
        return ActionRecord(action_type="sell", detail="Sold (no matching resources)")

    rate = max(0, player.rate(best_resource))
    revenue = state.market.sell(best_resource, rate)
    player.money += revenue
    player.ledger.record_sell(best_resource, revenue)
    # Per-player flow tracking
    player.flow_sold_units[best_resource] += rate
    player.flow_sell_revenue[best_resource] += revenue
    state.deck.discard.append(player.hand.pop(card_idx))

    # Hacker Array bonus: only fires if the player owns one AND supplied a
    # target+direction (e.g. via the picker UI). A "no choice" sell skips
    # the bonus entirely — that matches the rule "the player chooses".
    detail_extra = ""
    ha_count = _count_buildings(player, "Hacker Array")
    if ha_count > 0 and hacker_target and hacker_direction != 0:
        try:
            target = Resource(hacker_target)
            if target != best_resource:
                delta = 3 if hacker_direction > 0 else -3
                state.market.adjust(target, delta)
                sign = "+" if delta >= 0 else ""
                detail_extra = f" [HA: {sign}{delta} {target.value}]"
        except ValueError:
            pass

    player.cards_spent_this_turn += 1
    return ActionRecord(
        action_type="sell",
        detail=f"Sold {rate} {best_resource.value} for ${revenue}{detail_extra}",
        sell_resource=best_resource.value,
        sell_amount=rate,
        sell_revenue=revenue,
    )


def execute_contract(
    state: GameState,
    player: Player,
    card_idx: int,
    contract_idx: int,
    *,
    discard_card_indices: list[int] | None = None,
    use_elevator: bool = False,
    use_launch_pad: bool = False,
    elevator_target: str | None = None,
) -> ActionRecord | None:
    """Fulfill a contract.

    Three ways to fulfill a contract:

    1. **Hand card** (default): pass `card_idx` pointing at a hand card
       with `can_fulfill_contract=True`. Costs 1 AP.

    2. **Discard 2 cards** (new): pass `discard_card_indices` with exactly
       2 distinct hand indices. The cards are discarded as the cost; no
       contract-capable card is required. Costs 1 AP. `card_idx` is ignored.

    3. **Launch Pad** (free): pass `use_launch_pad=True`. Skips the
       hand-card requirement entirely. **Free** (0 AP) but still gated by
       `has_used_launch_pad_this_turn` (only one Launch Pad contract per
       turn). `card_idx` and `discard_card_indices` are ignored.

    `use_elevator=True`: applies a one-time -1 to ONE resource (Space
    Elevator's per-turn discount). The resource is `elevator_target`
    (e.g. "FE"); if not provided, defaults to the first requirement.
    Also gated by the per-turn flag. Combines with all three paths.

    Returns ActionRecord on success, None if any precondition fails
    (including insufficient action points).
    """
    if contract_idx < 0 or contract_idx >= len(state.available_contracts):
        return None
    contract = state.available_contracts[contract_idx]

    # Determine which path is being taken and how many hand cards will be
    # consumed. Launch Pad spends 0 cards (it IS the free icon).
    use_discard = (
        not use_launch_pad
        and discard_card_indices is not None
        and len(discard_card_indices) > 0
    )
    if use_launch_pad:
        cards_cost = 0
    elif use_discard:
        cards_cost = 2  # the two discarded hand cards
    else:
        cards_cost = 1  # the contract-icon hand card
    if cards_cost > player.cards_remaining():
        return None

    # Validate Launch Pad path
    if use_launch_pad:
        if player.has_used_launch_pad_this_turn:
            return None
        if _count_buildings(player, "Launch Pad") == 0:
            return None
    elif use_discard:
        # Discard-2 path: validate that we have exactly 2 distinct in-range
        # hand indices.
        if len(discard_card_indices) != 2:
            return None
        if discard_card_indices[0] == discard_card_indices[1]:
            return None
        for idx in discard_card_indices:
            if idx < 0 or idx >= len(player.hand):
                return None
    else:
        if card_idx < 0 or card_idx >= len(player.hand):
            return None
        if not player.hand[card_idx].can_fulfill_contract:
            return None

    # Validate Space Elevator path
    if use_elevator:
        if player.has_used_space_elevator_this_turn:
            return None
        if _count_buildings(player, "Space Elevator") == 0:
            return None

    # Apply Space Elevator discount only if requested
    effective_reqs = effective_contract_requirements(
        player, contract, apply_elevator=use_elevator, elevator_target=elevator_target
    )

    # Check if player can afford the (discounted) rate costs
    for req in effective_reqs:
        if player.rate(req.resource) < req.amount:
            return None

    # Compute costs from ledger before spending rates (uses discounted reqs)
    contract_true_cost = player.ledger.contract_cost(effective_reqs)
    contract_gross_cost = player.ledger.contract_gross_cost(effective_reqs)

    # Spend rates permanently (the effective amount, not the original)
    rates_spent: dict[str, int] = {}
    for req in effective_reqs:
        if req.amount > 0:
            player.rates[req.resource] -= req.amount
            rates_spent[req.resource.value] = req.amount

    # Record in ledger
    player.ledger.record_contract(effective_reqs)

    # Contract reward: pay off existing debt first, leftover becomes credit.
    # Credit counts toward net worth and absorbs FUTURE debt before it
    # becomes real debt (see _apply_debt). It is NOT spendable as cash.
    debt_payoff = min(player.debt, contract.reward)
    player.debt -= debt_payoff
    leftover = contract.reward - debt_payoff
    if leftover > 0:
        player.credit += leftover
    player.contracts_fulfilled += 1

    # Burn the contract-icon card or the two discards, depending on path.
    if use_launch_pad:
        pass  # no card consumed — Launch Pad is the free icon
    elif use_discard:
        # Pop indices in descending order so the second pop doesn't shift
        # the first.
        for idx in sorted(discard_card_indices, reverse=True):
            state.deck.discard.append(player.hand.pop(idx))
    else:
        state.deck.discard.append(player.hand.pop(card_idx))

    # Set per-turn flags
    if use_elevator:
        player.has_used_space_elevator_this_turn = True
    if use_launch_pad:
        player.has_used_launch_pad_this_turn = True
    # Count hand cards spent toward per-turn cap
    player.cards_spent_this_turn += cards_cost

    # Display label uses the ORIGINAL requirements so the log is consistent
    # (the discount is reflected in rates_spent for analytics).
    req_str = ", ".join(f"{r.amount} {r.resource.value}" for r in contract.requirements)
    label = req_str
    if use_elevator:
        # Pick which resource was discounted for the log
        target = elevator_target or (contract.requirements[0].resource.value if contract.requirements else "")
        label += f" [SE -1 {target}]" if target else " [SE -1]"
    if use_launch_pad:
        label += " [LP]"

    # Replace contract
    state.available_contracts.pop(contract_idx)
    if state.contracts:
        state.available_contracts.append(state.contracts.pop())

    return ActionRecord(
        action_type="contract",
        detail=f"Fulfilled contract ({label}) for ${contract.reward}",
        contract_label=label,
        contract_rates_spent=rates_spent,
        contract_reward=contract.reward,
        contract_true_cost=round(contract_true_cost, 2),
        contract_gross_cost=round(contract_gross_cost, 2),
    )


# --- Special-building helpers ---

def _count_buildings(player: Player, name: str) -> int:
    """Number of copies of `name` in the player's buildings_played."""
    return sum(1 for c in player.buildings_played if c.building == name)


# --- Building tags (used by patent build hooks) ---
#
# A card is "tagged" with each resource it produces a positive rate of.
# Tags are NOT exclusive — a card with `+1 PWR, +1 FE` is BOTH a power
# building AND an iron building. Patent hooks like Superconductors and
# Slant Drilling read these tags to decide whether to fire on a build.

RESOURCE_TAGS: dict[Resource, str] = {
    Resource.PWR: "power",
    Resource.H2O: "water",
    Resource.FE: "iron",
    Resource.C: "carbon",
    Resource.SI: "silicon",
    Resource.O2: "oxygen",
    Resource.FOOD: "food",
    Resource.GLS: "glass",
    Resource.ELX: "electronics",
}


def building_tags(card: Card) -> set[str]:
    """Set of resource tags this card produces (positive rates only).

    A card with `+1 PWR, +1 FE` returns {"power", "iron"}. Empty if the
    card has no positive rates (e.g. a building that only consumes).
    """
    return {RESOURCE_TAGS[ra.resource] for ra in card.rates if ra.amount > 0}


# --- Patent helpers ---
#
# Patents are slot=5 Card instances. They live in player.buildings_played
# alongside normal buildings, but their `slot == 5` distinguishes them.

def _player_patent_names(player: Player) -> list[str]:
    """Names of all patents (slot-5 cards) the player owns."""
    return [c.building for c in player.buildings_played if c.slot == 5]


def _player_owns_patent(player: Player, patent_name: str) -> bool:
    """True iff the player owns a patent with this exact name."""
    return any(
        c.slot == 5 and c.building == patent_name for c in player.buildings_played
    )


def _bump_rate(card: Card, resource: Resource, amount: int) -> None:
    """Add `amount` to the card's rate for `resource`. ResourceAmount is
    frozen, so we replace the matching entry with a new instance (or
    append a new entry if no rate for that resource exists yet).

    Used by build-hook patents that add to a card's rates (Superconductors,
    Cold Fusion, Slant Drilling).
    """
    for i, ra in enumerate(card.rates):
        if ra.resource == resource:
            card.rates[i] = ResourceAmount(resource=resource, amount=ra.amount + amount)
            return
    card.rates.append(ResourceAmount(resource=resource, amount=amount))


# --- Patent build-time hooks ---
#
# These run inside execute_build BEFORE the card's rates and costs are
# applied. They mutate a deep-copied card so the prototype shared across
# the deck/pool/hand is unaffected. The hook only fires for the player who
# owns the patent.

def _hook_superconductors(state: GameState, player: Player, card: Card) -> None:
    """New Power Buildings: +1 PWR. Bumps PWR rate on any power-tagged card."""
    if "power" not in building_tags(card):
        return
    _bump_rate(card, Resource.PWR, +1)


def _hook_cold_fusion(state: GameState, player: Player, card: Card) -> None:
    """+1 PWR from new Water Buildings. Bumps PWR on any water-tagged card."""
    if "water" not in building_tags(card):
        return
    _bump_rate(card, Resource.PWR, +1)


def _hook_slant_drilling(state: GameState, player: Player, card: Card) -> None:
    """+1 from new FE/SI Buildings.

    A card tagged `iron` gets +1 FE; a card tagged `silicon` gets +1 SI.
    Both can apply if the card has both tags.
    """
    tags = building_tags(card)
    if "iron" in tags:
        _bump_rate(card, Resource.FE, +1)
    if "silicon" in tags:
        _bump_rate(card, Resource.SI, +1)


def _hook_perpetual_motion(state: GameState, player: Player, card: Card) -> None:
    """New H2O/FE/C/SI buildings consume no PWR.

    Strips negative PWR rates from cards tagged water/iron/carbon/silicon.
    Positive PWR rates and the card's COSTS are unaffected — the patent
    text says "consume" which we interpret as the per-turn negative rate.
    """
    tags = building_tags(card)
    if not (tags & {"water", "iron", "carbon", "silicon"}):
        return
    card.rates = [
        ra for ra in card.rates
        if not (ra.resource == Resource.PWR and ra.amount < 0)
    ]


def _hook_carbon_scrubbing(state: GameState, player: Player, card: Card) -> None:
    """New buildings do not produce negative rates of C or O2.

    Strips negative C and O2 rates from the card. Build-time costs are
    UNTOUCHED (the patent only affects the per-turn drain, not what you
    pay to put the building down). Positive C/O2 rates are also untouched.
    """
    card.rates = [
        ra for ra in card.rates
        if not (ra.resource in (Resource.C, Resource.O2) and ra.amount < 0)
    ]



# Energy Vault no longer has a build hook — it only affects Power Bills.
# The old _hook_energy_vault (which absorbed negative PWR from new builds)
# has been removed. The vault now shields the player from paying power
# bill debt when they have a negative rate, up to 10 uses.


# Patent name → build hook (signature: (state, player, card) -> None).
# Only patents that mutate a card at build time go here. Passive event hooks
# (Financial Instruments, Virtual Reality) and active patents (Water Engine,
# Nanotechnology, Teleportation) live elsewhere.
PATENT_BUILD_HOOKS = {
    "Superconductors": _hook_superconductors,
    "Cold Fusion": _hook_cold_fusion,
    "Slant Drilling": _hook_slant_drilling,
    "Perpetual Motion": _hook_perpetual_motion,
    "Carbon Scrubbing": _hook_carbon_scrubbing,
}


def _apply_patent_acquisition(state: GameState, player: Player, patent: Card) -> None:
    """Run any one-shot/initialization effects when a player WINS a patent.

    Called from settle_silent_auction after the patent is appended to
    buildings_played but before normal apply_rates would (which is also
    called by settle for any inherent rate effects, though most CSV
    patents have empty rates).

    Currently handles:
      - Energy Vault: initialize the 10-PWR vault
      - Thinking Machines: draw 1 card and bump hand_size by 1
    """
    if patent.building == "Energy Vault":
        player.patent_state["energy_vault"] = 10
    elif patent.building == "Thinking Machines":
        # Draw 1 card immediately
        player.hand.extend(state.deck.draw(1))
        # Permanently bump hand_size so future draws keep one extra
        player.hand_size += 1


# Pleasure Dome bonus tiers: indexed by GLOBAL number of PDs in play - 1.
# Source: Cards.csv "Power Bill: $20/$15/$10 if 1/2/3 PD in play".
# Each owner who has at least one PD receives the same per-owner amount
# from the tier — so:
#   1 PD globally  → that owner gets $20
#   2 PDs globally → each owner gets $15
#   3+ PDs globally → each owner gets $10
# With one-of-each enforcement, "PDs globally" == number of distinct
# owners (each owner has 0 or 1 PD).
PLEASURE_DOME_TIERS = [int(x) for x in _CFG.get("pleasure_dome_tiers", "20,15,10").split(",")]


def _global_dome_count(state: GameState) -> int:
    """Total number of Pleasure Domes across all players."""
    return sum(_count_buildings(p, "Pleasure Dome") for p in state.players)


def _pleasure_dome_bonus(state: GameState, player: Player) -> int:
    """Per-owner power-bill bonus from Pleasure Dome.

    The tier is keyed on the GLOBAL number of PDs in play, not on this
    player's count. Each owner who has at least one PD gets the same
    per-owner amount from that tier.

    Virtual Reality patent doubles this bonus for its owner (only if they
    also own a Pleasure Dome — no PD = no doubling because there's nothing
    to double).
    """
    if _count_buildings(player, "Pleasure Dome") == 0:
        return 0
    total = _global_dome_count(state)
    bonus = PLEASURE_DOME_TIERS[min(total - 1, len(PLEASURE_DOME_TIERS) - 1)]
    if _player_owns_patent(player, "Virtual Reality"):
        bonus *= 2
    return bonus


def _patent_office_trigger(
    state: GameState, player: Player, pick_idx: int | None = None,
) -> list[Card]:
    """Build-time trigger: draw 2 patents, keep one, return the other.

    When `pick_idx` is None (AI), auto-picks the patent with the higher
    total positive rate sum (or the higher AI_Value from the CSV).
    When `pick_idx` is 0 or 1 (human), keeps the indicated patent.

    The kept patent is appended to player.buildings_played and its rates
    are applied. The returned patent goes back on TOP of the pile.

    Returns the list of drawn patents (for UI display). Empty list if
    no patents are available.
    """
    available = len(state.patent_pile) - state.patent_idx
    if available <= 0:
        return []
    drawn: list[Card] = []
    for _ in range(min(2, available)):
        drawn.append(state.patent_pile[state.patent_idx])
        state.patent_idx += 1

    if len(drawn) == 1:
        kept = drawn[0]
    else:
        # Determine which to keep
        if pick_idx is not None and 0 <= pick_idx < len(drawn):
            kept_i = pick_idx
        else:
            # AI auto-pick: higher AI_Value, then positive rate sum as tiebreaker
            values = _get_patent_base_values()
            def _patent_score(c: Card) -> float:
                base = values.get(c.building, 0)
                rate_sum = sum(ra.amount for ra in c.rates if ra.amount > 0)
                return base + rate_sum
            kept_i = 0 if _patent_score(drawn[0]) >= _patent_score(drawn[1]) else 1
        returned_i = 1 - kept_i
        kept = drawn[kept_i]
        returned = drawn[returned_i]
        # Put the returned patent back on TOP of the pile
        state.patent_idx -= 1
        state.patent_pile[state.patent_idx] = returned

    player.buildings_played.append(kept)
    player.apply_rates(kept)
    _apply_patent_acquisition(state, player, kept)
    return drawn


def effective_contract_requirements(
    player: Player,
    contract: Contract,
    apply_elevator: bool = False,
    elevator_target: str | None = None,
) -> list[ResourceAmount]:
    """Return contract requirements, optionally with Space Elevator -1.

    Space Elevator gives -1 to ONE resource on the contract (player's pick),
    not -1 across the board. The discount only applies if:
      - the player owns a Space Elevator
      - `apply_elevator` is True (caller controls per-turn limit)
      - `elevator_target` is the resource value of one of the contract's
        requirements (e.g. "FE" for a contract requiring 2 FE)

    If `elevator_target` is None, the function falls back to discounting the
    FIRST requirement on the contract — useful for AI players that don't pick.
    Floor at 0.
    """
    if not apply_elevator or _count_buildings(player, "Space Elevator") == 0:
        return list(contract.requirements)
    if not contract.requirements:
        return []
    # Pick which req to discount.
    target_idx = 0
    if elevator_target:
        for i, req in enumerate(contract.requirements):
            if req.resource.value == elevator_target:
                target_idx = i
                break
    out: list[ResourceAmount] = []
    for i, req in enumerate(contract.requirements):
        if i == target_idx:
            out.append(ResourceAmount(resource=req.resource, amount=max(0, req.amount - 1)))
        else:
            out.append(ResourceAmount(resource=req.resource, amount=req.amount))
    return out


def can_use_space_elevator(player: Player) -> bool:
    """True iff the player owns a Space Elevator and hasn't used it this turn."""
    return (
        _count_buildings(player, "Space Elevator") > 0
        and not player.has_used_space_elevator_this_turn
    )


def can_use_launch_pad(player: Player) -> bool:
    """True iff the player owns a Launch Pad and hasn't used it this turn."""
    return (
        _count_buildings(player, "Launch Pad") > 0
        and not player.has_used_launch_pad_this_turn
    )


# --- Events ---

def _apply_debt(player: Player, amount: int) -> tuple[int, int]:
    """Charge `amount` debt against a player, consuming credit first.

    Credit absorbs debt before it becomes real debt. So a player with
    $30 credit and a $50 debt charge ends up with $0 credit and $20 debt.

    Returns a tuple `(credit_consumed, real_debt_added)` for callers that
    want to log the breakdown. Both are >= 0 and sum to `amount`.

    Negative or zero `amount` is a no-op.
    """
    if amount <= 0:
        return (0, 0)
    credit_consumed = min(player.credit, amount)
    player.credit -= credit_consumed
    real_debt_added = amount - credit_consumed
    player.debt += real_debt_added
    return (credit_consumed, real_debt_added)


def _record_event_line(
    state: "GameState",
    *,
    kind: str,
    text: str,
    player: "Player | None" = None,
) -> None:
    """Append a single line to the current event's detail log.

    `kind` is one of "header", "note", "player". For "player" lines, pass the
    affected `player` so the line snapshots their post-action NW components.
    The play adapter copies `state.last_event_lines` after every event resolves
    and surfaces it to the UI.
    """
    line: dict = {"kind": kind, "text": text}
    if player is not None:
        line["player_idx"] = state.players.index(player)
        line["name"] = player.name
        line["money_after"] = player.money
        line["debt_after"] = player.debt
        line["credit_after"] = player.credit
        line["net_worth_after"] = player.net_worth()
    state.last_event_lines.append(line)


def do_pwr_adjust(state: GameState, player: Player) -> None:
    """Adjust PWR market price based on active player's rate.

    Positive PWR shifts price down (like selling), negative shifts up.
    """
    pwr_rate = player.rate(Resource.PWR)
    price_before = state.market.price(Resource.PWR)
    if pwr_rate > 0:
        state.market.adjust(Resource.PWR, -pwr_rate)
    elif pwr_rate < 0:
        state.market.adjust(Resource.PWR, abs(pwr_rate))
    price_after = state.market.price(Resource.PWR)
    if pwr_rate != 0:
        direction = "↓" if pwr_rate > 0 else "↑"
        _record_event_line(
            state,
            kind="header",
            text=f"PWR Adjust — {player.name} has {pwr_rate:+d} PWR",
        )
        _record_event_line(
            state,
            kind="note",
            text=f"PWR price: ${price_before} → ${price_after} ({direction}{abs(pwr_rate)})",
        )


def do_power_bill(state: GameState) -> None:
    """Power bill event: positive PWR earns money, negative PWR adds debt.

    Pleasure Dome owners also get a flat per-dome bonus on every power bill.

    Energy Vault: if the player has a NEGATIVE PWR rate and vault > 0,
    the vault shields them from paying this power bill entirely (they
    neither earn nor pay). The vault decrements by 1 per shielded bill.
    If the player has a positive or zero rate, the vault has no effect.
    """
    pwr_price = state.market.price(Resource.PWR)
    _record_event_line(
        state, kind="header", text=f"Power Bill — PWR @ ${pwr_price}"
    )
    for player in state.players:
        base_rate = player.rate(Resource.PWR)
        vault = player.patent_state.get("energy_vault", 0)

        # Build the per-player text for the event log row.
        bill_parts: list[str] = []

        # Energy Vault: shields from negative power bills
        if base_rate < 0 and vault > 0:
            player.patent_state["energy_vault"] = vault - 1
            bill_parts.append(
                f"Energy Vault shields bill ({vault - 1} uses left)"
            )
        elif base_rate > 0:
            earning = base_rate * pwr_price
            player.money += earning
            state.pwr_total_earned += earning
            state.bills_units_earned[Resource.PWR] += base_rate
            player.flow_sold_units[Resource.PWR] += base_rate
            player.flow_sell_revenue[Resource.PWR] += earning
            bill_parts.append(
                f"+${earning} (sold {base_rate} PWR)"
            )
        elif base_rate < 0:
            shortage = abs(base_rate)
            cost = shortage * pwr_price
            _apply_debt(player, cost)
            state.pwr_total_debt += cost
            state.bills_units_owed[Resource.PWR] += shortage
            player.ledger.record_event_cost(Resource.PWR, cost, base_rate)
            player.flow_bought_units[Resource.PWR] += shortage
            player.flow_buy_cost[Resource.PWR] += cost
            bill_parts.append(
                f"−${cost} (bought {shortage} PWR)"
            )
        # Pleasure Dome bonus is added on top of normal bill processing.
        bonus = _pleasure_dome_bonus(state, player)
        if bonus > 0:
            player.money += bonus
            bill_parts.append(f"+${bonus} dome bonus")
        if bill_parts:
            _record_event_line(
                state,
                kind="player",
                player=player,
                text=" · ".join(bill_parts),
            )


def do_debt_collection(state: GameState) -> None:
    """Increase debt by $1 per DEBT_INTEREST_DIVISOR owed.

    The contract "shield" from the original rules is implicit: contract
    rewards now pay off debt directly (and any leftover becomes credit
    that absorbs future debt before it hits the player's actual debt).

    Financial Instruments hook: each owner of FI gains cash equal to the
    sum of REAL debt added to OTHER players (not themselves) this round.
    Credit-absorbed amounts don't count for the FI payout.
    """
    _record_event_line(state, kind="header", text="Debt Collection")
    debt_added: dict[int, int] = {}
    for idx, player in enumerate(state.players):
        interest = player.debt // DEBT_INTEREST_DIVISOR
        if interest <= 0:
            continue
        # Charge the interest through _apply_debt so any credit absorbs it
        credit_used, real_debt = _apply_debt(player, interest)
        debt_added[idx] = real_debt
        if real_debt > 0 and credit_used > 0:
            text = (
                f"+${interest} interest "
                f"(${credit_used} absorbed by credit, ${real_debt} → debt ${player.debt})"
            )
        elif real_debt > 0:
            text = f"+${interest} interest → debt ${player.debt}"
        else:
            text = f"+${interest} interest absorbed by credit (${player.credit} left)"
        _record_event_line(state, kind="player", player=player, text=text)

    # Financial Instruments payout: for each owner, gain cash equal to the
    # sum of debt added to OTHER players this round.
    for idx, player in enumerate(state.players):
        if not _player_owns_patent(player, "Financial Instruments"):
            continue
        bonus = sum(amt for other_idx, amt in debt_added.items() if other_idx != idx)
        if bonus > 0:
            player.money += bonus
            _record_event_line(
                state,
                kind="player",
                player=player,
                text=f"+${bonus} Financial Instruments payout",
            )


def do_futures_settlement(state: GameState) -> None:
    """Players with negative resources buy at market rate (as debt).

    All players pay the price at the start of settlement. Then the market
    rises by the total negative rates across all players for each resource.
    """
    _record_event_line(state, kind="header", text="Futures Settlement")
    # Snapshot prices before any market shifts
    starting_prices = {r: state.market.price(r) for r in Resource if r != Resource.PWR}
    total_negatives: dict[Resource, int] = {r: 0 for r in starting_prices}

    # All players pay debt at the snapshot price
    for player in state.players:
        per_resource_parts: list[str] = []
        total_cost = 0
        for r in starting_prices:
            rate = player.rate(r)
            if rate < 0:
                shortage = abs(rate)
                cost = starting_prices[r] * shortage
                _apply_debt(player, cost)
                state.futures_total_debt += cost
                state.futures_units_bought[r] += shortage
                state.futures_debt_per_resource[r] += cost
                player.ledger.record_event_cost(r, cost, rate)
                total_negatives[r] += shortage
                # Per-player futures tracking
                player.flow_futures_units[r] += shortage
                player.flow_futures_cost[r] += cost
                per_resource_parts.append(
                    f"{shortage} {r.value} @ ${starting_prices[r]} = ${cost}"
                )
                total_cost += cost
        if per_resource_parts:
            _record_event_line(
                state,
                kind="player",
                player=player,
                text=f"−${total_cost} (settled " + ", ".join(per_resource_parts) + ")",
            )

    # Market rises by total negative rates per resource (no buying, just adjust)
    for r, total in total_negatives.items():
        if total > 0:
            state.market.adjust(r, total)


def do_news(state: GameState, event: EventCard) -> str:
    """Execute a news event: adjust market prices per the payload.

    Payload shape:
        {"market_deltas": {"FOOD": 4, "H2O": -2, ...}}

    Each entry moves the named resource's market position by the given delta
    (positive = price rises, negative = price drops). Uses the same
    Market.adjust that PWR_ADJUST and futures settlements use.
    """
    payload = event.payload or {}
    deltas = payload.get("market_deltas", {})
    parts = []
    for r_str, delta in deltas.items():
        resource = Resource(r_str)
        state.market.adjust(resource, delta)
        sign = "+" if delta >= 0 else ""
        parts.append(f"{r_str} {sign}{delta}")
    label = event.display_label()
    detail = ", ".join(parts) if parts else "no effect"
    _record_event_line(state, kind="header", text=f"NEWS: {label}")
    if parts:
        _record_event_line(state, kind="note", text=detail)
    return f"NEWS: {label} ({detail})"


def _draw_news_card(state: GameState) -> NewsCard | None:
    """Draw the next card from the news deck. Reshuffle if exhausted."""
    if not state.news_deck:
        return None
    if state.news_idx >= len(state.news_deck):
        random.shuffle(state.news_deck)
        state.news_idx = 0
    card = state.news_deck[state.news_idx]
    state.news_idx += 1
    return card


def _apply_news_effect(state: GameState, effect: NewsEffect, active_player: Player) -> str:
    """Apply a single news effect, returning a short detail string."""
    if effect.kind == "rate_all":
        # Apply rate deltas to every player in the game.
        parts = []
        for r_str, delta in effect.payload.items():
            resource = Resource(r_str)
            for p in state.players:
                p.rates[resource] = p.rate(resource) + delta
            sign = "+" if delta >= 0 else ""
            parts.append(f"All {sign}{delta} {r_str}")
        text = ", ".join(parts) or "no rate change"
        _record_event_line(state, kind="note", text=text)
        return text

    if effect.kind == "market_random":
        resources = effect.payload.get("resources", [])
        rolls = int(effect.payload.get("rolls", 1))
        parts = []
        for r_str in resources:
            resource = Resource(r_str)
            for _ in range(rolls):
                delta = random.choice(_D20_DELTAS)
                state.market.adjust(resource, delta)
                sign = "+" if delta >= 0 else ""
                parts.append(f"{r_str} {sign}{delta}")
        text = ", ".join(parts) or "no market change"
        _record_event_line(state, kind="note", text=text)
        return text

    if effect.kind == "trigger":
        which = effect.payload.get("event")
        if which == "power_bill":
            do_power_bill(state)
            return "→ power bill"
        if which == "debt_collection":
            do_debt_collection(state)
            return "→ debt collection"
        if which == "futures_settlement":
            do_futures_settlement(state)
            return "→ futures settlement"
        return f"unknown trigger: {which}"

    return f"unknown effect: {effect.kind}"


def do_news_bulletin(state: GameState, active_player: Player) -> str:
    """Draw the top card from the news deck and apply all of its effects."""
    card = _draw_news_card(state)
    if card is None:
        _record_event_line(state, kind="header", text="News Bulletin (deck empty)")
        return "news bulletin (deck empty)"
    if not card.effects:
        _record_event_line(state, kind="header", text=f"NEWS: {card.name} (All Quiet)")
        return f"NEWS: {card.name} (All Quiet)"
    _record_event_line(state, kind="header", text=f"NEWS: {card.name}")
    detail_parts = [_apply_news_effect(state, eff, active_player) for eff in card.effects]
    return f"NEWS: {card.name} ({'; '.join(detail_parts)})"


def do_draw_building_card(state: GameState) -> str:
    """Refresh the pool by drawing a fresh card from the building deck.

    Pool size stays at POOL_SIZE: the new card replaces the oldest pool slot.
    """
    if not state.deck.cards and not state.deck.discard:
        _record_event_line(state, kind="header", text="Draw Building Card (deck empty)")
        return "draw building card (deck empty)"
    drawn = state.deck.draw(1)
    if not drawn:
        _record_event_line(state, kind="header", text="Draw Building Card (deck empty)")
        return "draw building card (deck empty)"
    new_card = drawn[0]
    if state.pool:
        # FIFO: evict the oldest pool slot back to the discard pile.
        evicted = state.pool.pop(0)
        state.deck.discard.append(evicted)
    state.pool.append(new_card)
    _record_event_line(state, kind="header", text=f"Drew {new_card.building} into pool")
    return f"draw building card → {new_card.building}"


def _draw_patent(state: GameState) -> Card | None:
    """Draw the next patent off the pile, or return None if exhausted."""
    if state.patent_idx >= len(state.patent_pile):
        return None
    patent = state.patent_pile[state.patent_idx]
    state.patent_idx += 1
    return patent


def settle_silent_auction(
    state: GameState,
    patent: Card,
    bids: dict[int, int],
) -> tuple[int, int] | None:
    """Resolve a silent auction given a {player_idx: bid} map.

    Returns (winner_idx, amount_paid) or None if no one bid above 0.

    Rules:
      - Highest bidder wins
      - Ties broken by turn order (lower index first)
      - Winner pays runner_up + $5, UNLESS they tied (same bid as
        runner-up), in which case they pay their own bid exactly
      - If only one player bids, they pay $5 (since runner_up = 0)
    """
    positive_bids = {idx: amt for idx, amt in bids.items() if amt > 0}
    if not positive_bids:
        return None

    # Sort by (-bid, idx) so highest bid first, ties broken by lower seat
    sorted_bidders = sorted(positive_bids.items(), key=lambda kv: (-kv[1], kv[0]))
    winner_idx, winner_bid = sorted_bidders[0]
    runner_up_bid = sorted_bidders[1][1] if len(sorted_bidders) > 1 else 0

    # Pay runner_up + 5, capped at winner's own bid (so ties pay exact bid)
    amount_paid = min(runner_up_bid + 5, winner_bid)
    winner = state.players[winner_idx]
    _apply_debt(winner, amount_paid)
    winner.buildings_played.append(patent)
    # Apply the patent's rates to the winner's accumulated rates (most CSV
    # patents have empty rates; the mechanical effects are wired via hooks)
    winner.apply_rates(patent)
    # Run any one-shot acquisition effects (Energy Vault init, Thinking
    # Machines draw + hand_size, etc.)
    _apply_patent_acquisition(state, winner, patent)
    return (winner_idx, amount_paid)


def do_patent_auction(state: GameState) -> str:
    """Run a silent patent auction.

    Draws the top patent from the pile, collects bids, settles, applies the
    result. The bid for each player is taken from `state.pending_bids` if
    set (used by the play adapter to inject human-supplied bids); otherwise
    falls back to a heuristic AI bid.
    """
    patent = _draw_patent(state)
    if patent is None:
        _record_event_line(
            state, kind="header", text="Patent Auction (no patents left)"
        )
        return "patent auction (no patents left)"

    _record_event_line(
        state, kind="header", text=f"Patent Auction — {patent.building}"
    )
    bids: dict[int, int] = {}
    for idx, player in enumerate(state.players):
        if idx in state.pending_bids:
            bids[idx] = state.pending_bids[idx]
        else:
            bids[idx] = _default_ai_bid(player, patent)
    # Clear the bid overrides; they're consumed by this single auction.
    state.pending_bids = {}

    # Snapshot vault/hand_size BEFORE settling so we can detect acquisition
    # effects (Energy Vault init, Thinking Machines draw) per-player.
    pre_vault = [
        p.patent_state.get("energy_vault", 0) for p in state.players
    ]
    pre_hand_size = [p.hand_size for p in state.players]

    result = settle_silent_auction(state, patent, bids)

    # Per-player bid lines, showing the winner with "WON".
    winner_idx = result[0] if result is not None else None
    sorted_bidders = sorted(
        ((idx, amt) for idx, amt in bids.items() if amt > 0),
        key=lambda kv: (-kv[1], kv[0]),
    )
    for idx, amt in sorted_bidders:
        suffix = " — WON" if idx == winner_idx else ""
        _record_event_line(
            state,
            kind="player",
            player=state.players[idx],
            text=f"Bid ${amt}{suffix}",
        )

    if result is None:
        _record_event_line(state, kind="note", text="No bids")
        return f"patent auction ({patent.building}): no bids"

    winner_idx, amount = result
    winner = state.players[winner_idx]
    _record_event_line(
        state,
        kind="note",
        text=f"{winner.name} pays ${amount} debt",
    )
    # Acquisition-effect notes
    if winner.patent_state.get("energy_vault", 0) > pre_vault[winner_idx]:
        _record_event_line(
            state,
            kind="note",
            text=f"Energy Vault initialized: {winner.patent_state['energy_vault']} PWR",
        )
    if winner.hand_size > pre_hand_size[winner_idx]:
        _record_event_line(
            state,
            kind="note",
            text="Thinking Machines: drew 1 card, hand size +1",
        )
    return (
        f"patent auction: {winner.name} "
        f"won {patent.building} for ${amount} debt"
    )


# Lazily loaded from Patents.csv AI_Value column. Populated on first
# call to _default_ai_bid. Module-level cache avoids re-reading on
# every auction.
_patent_base_values: dict[str, int] | None = None


def _get_patent_base_values() -> dict[str, int]:
    global _patent_base_values
    if _patent_base_values is None:
        from my_project.parsing import parse_patent_values
        data_dir = Path(__file__).parent / "data"
        _patent_base_values = parse_patent_values(data_dir / "Patents.csv")
    return _patent_base_values


def _default_ai_bid(player: Player, patent: Card) -> int:
    """Heuristic bid for a patent auction.

    Uses the PATENT_BASE_VALUES table for an approximate $ value of the
    patent, then randomizes ±$5 so different AI players don't always tie.
    The bid is clamped to half the player's available cash (so the AI
    doesn't go broke on a patent) and rounded to the nearest $5.

    Players with non-positive net cash pass (bid $0).
    """
    available = player.money - player.debt
    if available <= 0:
        return 0
    # Look up the patent's value. Priority: learned CardValues.csv → CSV
    # AI_Value column → rate-based fallback.
    from my_project.parsing import parse_card_values
    learned = parse_card_values(Path(__file__).parent / "data" / "CardValues.csv")
    base_value = int(learned.get(patent.building, 0))
    if base_value == 0:
        base_value = _get_patent_base_values().get(patent.building, 0)
    if base_value == 0:
        base_value = sum(ra.amount for ra in patent.rates if ra.amount > 0) * 8
    # Randomize ±$5
    jitter = random.choice([-5, 0, 0, 5, 5, 10])
    target = base_value + jitter
    # Clamp to half available cash and a reasonable ceiling
    cash_cap = available // 2
    target = max(5, min(target, cash_cap, 50))
    # Round to $5 increments
    bid = (target // 5) * 5
    if bid == 0 and available >= 5:
        bid = 5
    return bid


def _event_needs_prompt(state: GameState, event: EventCard) -> dict | None:
    """Inspect an event and return a prompt dict if it needs human input.

    Patent Auction: needs a bid from each human seat (so they can see the
    upcoming patent before bidding).

    Returns None if no human input is required (all-AI game, or the event
    doesn't need prompts).
    """
    if event.type == EventType.PATENT_AUCTION:
        # Peek at the next patent without drawing it
        if state.patent_idx >= len(state.patent_pile):
            return None  # no patents left, nothing to prompt
        patent = state.patent_pile[state.patent_idx]
        return {
            "kind": "patent_auction",
            "patent": _patent_to_dict(patent),
        }
    return None


def _patent_to_dict(patent: Card) -> dict:
    """Serialize a patent Card for the UI prompt."""
    return {
        "name": patent.building,
        "rates": [{"resource": ra.resource.value, "amount": ra.amount} for ra in patent.rates],
        "effect": patent.effect,
    }


def execute_event_with_redraws(
    state: GameState,
    event: EventCard,
    active_player: Player,
) -> str:
    """Execute an event and any cascading redraws.

    If the event has `redraws=True`, immediately draws and executes the next
    event card from the deck (advancing event_idx). Continues chaining as
    long as each fired card has `redraws=True`. The deck is sized in
    build_event_deck to account for these extra consumptions.

    Redraws may chain into END_GAME, which fires its effects inline as part
    of the same player-turn. The detail string concatenates each fired event.

    Mid-event interruptions: if any event in the chain needs human input
    (via _event_needs_prompt), the function pauses by setting
    state.pending_prompt and state._suspended_event, then returns the partial
    detail. The play adapter exposes the prompt to the UI and calls
    resume_pending_event() once the prompt is resolved.
    """
    # Reset per-event line capture for this fresh event chain. Subsequent
    # chained redraws append to the same list.
    state.last_event_lines = []

    # Check if THIS event needs a prompt before firing it
    prompt = _event_needs_prompt(state, event)
    if prompt is not None and _has_human_player(state):
        state.pending_prompt = prompt
        state._suspended_event = event
        state._suspended_chain_active = event.redraws
        return f"awaiting prompt: {prompt['kind']}"

    detail = execute_event(state, event, active_player)
    while event.redraws and state.event_idx < len(state.event_deck):
        next_event = state.event_deck[state.event_idx]
        # Pause-check before firing the next chained event
        next_prompt = _event_needs_prompt(state, next_event)
        if next_prompt is not None and _has_human_player(state):
            state.event_idx += 1
            state.pending_prompt = next_prompt
            state._suspended_event = next_event
            state._suspended_chain_active = next_event.redraws
            return detail + " | awaiting prompt: " + next_prompt["kind"]
        state.event_idx += 1
        detail = detail + " | " + execute_event(state, next_event, active_player)
        event = next_event
    return detail


def _has_human_player(state: GameState) -> bool:
    """Heuristic for 'is anyone in this game a human?'

    The simulation engine doesn't track human/AI seats — that lives on
    PlayableGame. We use a sentinel: humans set _is_human_game on the state
    via the play adapter at construction time.
    """
    return getattr(state, "_is_human_game", False)


def resume_pending_event(state: GameState, active_player: Player) -> str:
    """Resume a previously suspended event after its prompt was resolved.

    Called by the play adapter after the human supplies the prompt's answer.
    Fires the suspended event normally, then continues any redraw chain that
    was in progress.
    """
    if state._suspended_event is None:
        return ""
    event = state._suspended_event
    state._suspended_event = None
    state.pending_prompt = None
    chain_active = state._suspended_chain_active
    state._suspended_chain_active = False

    detail = execute_event(state, event, active_player)
    # If the suspended event was a redraw card, continue the chain
    while chain_active and state.event_idx < len(state.event_deck):
        next_event = state.event_deck[state.event_idx]
        next_prompt = _event_needs_prompt(state, next_event)
        if next_prompt is not None and _has_human_player(state):
            state.event_idx += 1
            state.pending_prompt = next_prompt
            state._suspended_event = next_event
            state._suspended_chain_active = next_event.redraws
            return detail + " | awaiting prompt: " + next_prompt["kind"]
        state.event_idx += 1
        detail = detail + " | " + execute_event(state, next_event, active_player)
        chain_active = next_event.redraws
    return detail


def execute_event(state: GameState, event: EventCard, active_player: Player) -> str:
    """Execute an event card and return a description.

    If the event card has `pwr_adjust=True`, also fires do_pwr_adjust
    AFTER the primary effect (adjusts PWR market by active player's rate).
    This is a CSV-configurable modifier — any event type can carry it.
    """
    detail: str
    match event.type:
        case EventType.NO_EVENT:
            detail = "no event"
        case EventType.PWR_ADJUST:
            # Standalone pwr_adjust event (backward compat)
            do_pwr_adjust(state, active_player)
            detail = f"PWR adjust (rate={active_player.rate(Resource.PWR)})"
        case EventType.POWER_BILL:
            do_power_bill(state)
            detail = "power bill"
        case EventType.DEBT_COLLECTION:
            do_debt_collection(state)
            detail = "debt collection"
        case EventType.FUTURES_SETTLEMENT:
            do_futures_settlement(state)
            detail = "futures settlement"
        case EventType.NEWS:
            detail = do_news(state, event)
        case EventType.NEWS_BULLETIN:
            detail = do_news_bulletin(state, active_player)
        case EventType.DRAW_BUILDING_CARD:
            detail = do_draw_building_card(state)
        case EventType.PATENT_AUCTION:
            detail = do_patent_auction(state)
        case EventType.END_ROUND:
            _record_event_line(state, kind="header", text="END OF ROUND")
            do_power_bill(state)
            do_futures_settlement(state)
            detail = "END OF ROUND (power bill + futures settlement)"
        case EventType.END_GAME:
            _record_event_line(state, kind="header", text="END GAME")
            do_power_bill(state)
            do_futures_settlement(state)
            detail = "END GAME (final power bill + futures settlement)"
        case _:
            detail = f"unknown event: {event.type}"
    # PWR_Adjust modifier: fire after the primary effect if the card flag is set.
    # Skip if the primary effect was already a standalone PWR_ADJUST (avoid double-fire).
    if event.pwr_adjust and event.type != EventType.PWR_ADJUST:
        do_pwr_adjust(state, active_player)
        detail += f" + PWR adjust ({active_player.rate(Resource.PWR):+d})"
    # Bonus building-card draw: if the event carries the redraws flag,
    # also draw a building card into the pool (like draw_building_card).
    if event.redraws and event.type != EventType.DRAW_BUILDING_CARD:
        bonus_detail = do_draw_building_card(state)
        detail += f" + {bonus_detail}"
    return detail


# --- Pool Swapping ---

def swap_pool_card(state: GameState, player: Player, hand_idx: int, pool_idx: int) -> None:
    """Swap a card from the player's hand with a card from the pool."""
    player.hand[hand_idx], state.pool[pool_idx] = state.pool[pool_idx], player.hand[hand_idx]


# --- Turn & Game ---

def _execute_action(state: GameState, player: Player, action: Action) -> ActionRecord | None:
    """Execute a single action. Returns ActionRecord or None on failure."""
    if action.action_type == ActionType.BUILD and action.build_cards:
        return execute_build(state, player, action.build_cards, action.discard_cards)

    elif action.action_type == ActionType.SELL and action.sell_card >= 0:
        return execute_sell(
            state,
            player,
            action.sell_card,
            hacker_target=action.hacker_target or None,
            hacker_direction=action.hacker_direction,
        )

    elif action.action_type == ActionType.CONTRACT:
        # Launch Pad path doesn't need a contract_card; the normal path does.
        if not action.use_launch_pad and action.contract_card < 0:
            return None
        return execute_contract(
            state,
            player,
            action.contract_card,
            action.contract_idx,
            discard_card_indices=action.discard_card_indices,
            use_elevator=action.use_elevator,
            use_launch_pad=action.use_launch_pad,
            elevator_target=action.elevator_target or None,
        )

    return None


def _execute_free_actions(state: GameState, player: Player) -> list[str]:
    """Auto-fire free actions for AI players at the start of their turn.

    Free actions don't cost cards and don't count toward the per-turn budget.
    They're fired BEFORE the action loop so the AI benefits from them (e.g.
    Water Engine's +2 PWR changes power-bill economics, Optimization Center's
    +1 rate makes builds/contracts cheaper).

    Returns a list of human-readable descriptions of what fired (for the
    turn log). Empty list if nothing fired.
    """
    fired: list[str] = []

    # Optimization Center: -1 PWR, +1 highest-priced positive non-PWR rate.
    if (
        _count_buildings(player, "Optimization Center") > 0
        and not player.has_used_optimization_center_this_turn
    ):
        candidates = [
            r for r in Resource
            if r != Resource.PWR and player.rate(r) > 0
        ]
        if candidates:
            target = max(candidates, key=lambda r: state.market.price(r))
            player.rates[Resource.PWR] = player.rate(Resource.PWR) - 1
            player.rates[target] = player.rate(target) + 1
            player.has_used_optimization_center_this_turn = True
            fired.append(f"Optimization Center: -1 PWR, +1 {target.value}")

    # Water Engine: -1 H2O, +2 PWR. Always beneficial when H2O ≥ 1.
    if (
        _player_owns_patent(player, "Water Engine")
        and not player.has_used_water_engine_this_turn
        and player.rate(Resource.H2O) >= 1
    ):
        player.rates[Resource.H2O] = player.rate(Resource.H2O) - 1
        player.rates[Resource.PWR] = player.rate(Resource.PWR) + 2
        player.has_used_water_engine_this_turn = True
        fired.append("Water Engine: -1 H2O, +2 PWR")

    # Teleportation: free sell — sells full rate of the highest-revenue
    # positive non-PWR resource (rate × price). Cost: -1 PWR permanent.
    # Fire when the revenue justifies the PWR loss.
    if (
        _player_owns_patent(player, "Teleportation")
        and not player.has_used_teleportation_this_turn
    ):
        candidates = [
            r for r in Resource
            if r != Resource.PWR and player.rate(r) > 0
        ]
        if candidates:
            best = max(candidates, key=lambda r: state.market.price(r) * player.rate(r))
            rate = player.rate(best)
            price = state.market.price(best)
            revenue = rate * price
            if revenue >= 10:  # worth more than the PWR loss
                player.money += revenue
                player.rates[Resource.PWR] = player.rate(Resource.PWR) - 1
                player.has_used_teleportation_this_turn = True
                fired.append(f"Teleportation: sold {rate} {best.value} for ${revenue}, -1 PWR")

    # Nanotechnology: discard the least useful hand card if it's below
    # the average value of cards remaining in the deck. The expected value
    # of a random draw is the deck average — discard if worst < average.
    if (
        _player_owns_patent(player, "Nanotechnology")
        and not player.has_used_nanotechnology_this_turn
        and player.hand
    ):
        from my_project.strategies import _card_value

        worst_idx = min(
            range(len(player.hand)),
            key=lambda i: _card_value(player.hand[i], player, state),
        )
        worst_val = _card_value(player.hand[worst_idx], player, state)

        # Compute average value of cards in the deck (what we'd expect to draw)
        deck_cards = state.deck.cards
        if deck_cards:
            avg_deck_val = sum(
                _card_value(c, player, state) for c in deck_cards
            ) / len(deck_cards)
        else:
            avg_deck_val = 0.0

        if worst_val < avg_deck_val:
            discarded = player.hand.pop(worst_idx)
            state.deck.discard.append(discarded)
            drawn = state.deck.draw(1)
            player.hand.extend(drawn)
            player.has_used_nanotechnology_this_turn = True
            new_name = drawn[0].building if drawn else "(empty)"
            fired.append(f"Nanotechnology: discarded {discarded.building}, drew {new_name}")

    return fired


def reset_per_turn_flags(player: Player) -> None:
    """Reset all per-turn flags to their start-of-turn defaults.

    Called at the start of every player turn — shared by run_turn (MC),
    begin_human_turn, and step_ai_turn (play adapter).
    """
    player.has_built_this_turn = False
    player.has_used_space_elevator_this_turn = False
    player.has_used_launch_pad_this_turn = False
    player.has_used_optimization_center_this_turn = False
    player.has_used_water_engine_this_turn = False
    player.has_used_nanotechnology_this_turn = False
    player.has_used_teleportation_this_turn = False
    player.cards_spent_this_turn = 0


def run_turn(state: GameState, player: Player, strategy, event: EventCard) -> None:
    """Run one turn: pool swaps, then actions until hand empty or pass, draw, event."""
    state.turn += 1
    money_before = player.money
    action_records: list[ActionRecord] = []

    reset_per_turn_flags(player)

    # Free actions phase (before pool swaps and the action loop).
    # Auto-fires Optimization Center, Water Engine, Teleportation,
    # Nanotechnology using simple heuristics.
    _execute_free_actions(state, player)

    # Pool swapping phase (free, before actions)
    swap_fn = getattr(strategy, 'pool_swap', None)
    if swap_fn:
        swap_fn(state, player)

    # Action phase: keep taking actions until the strategy passes. The
    # strategy is responsible for returning PASS when no legal action is
    # available (whether due to AP=0, empty hand, or no affordable plays).
    # MAX_ACTIONS_PER_TURN is a safety cap against infinite loops.
    actions_taken = 0
    while actions_taken < MAX_ACTIONS_PER_TURN:
        action = strategy(state, player)
        if action.action_type == ActionType.PASS:
            break

        record = _execute_action(state, player, action)
        if record is not None:
            action_records.append(record)
        actions_taken += 1

    # Draw back to hand size
    needed = player.hand_size - len(player.hand)
    if needed > 0:
        player.hand.extend(state.deck.draw(needed))

    # Execute the event. Each event is one player-turn — no redraw chaining
    # in the main game loop. The deck is pre-built with the right number of
    # events so each player gets exactly N turns.
    event_detail = execute_event(state, event, player)

    detail_strs = [r.detail for r in action_records]
    state.history.append(TurnRecord(
        turn=state.turn,
        player=player.name,
        action=f"{len(action_records)} actions",
        detail="; ".join(detail_strs) if detail_strs else "Pass",
        event=event_detail,
        money_before=money_before,
        money_after=player.money,
        debt=player.debt,
        contracts_fulfilled=player.contracts_fulfilled,
        market_snapshot=state.market.snapshot(),
        rates_snapshot={r.value: v for r, v in player.rates.items()},
        actions=action_records,
    ))


def run_game(
    all_cards: list[Card],
    all_contracts: list[Contract],
    strategy=None,
    num_players: int = 1,
    start_money: int = DEFAULT_START_MONEY,
    start_market_pos: int = DEFAULT_MARKET_POS,
    randomize_market: bool = False,
    max_turns: int = DEFAULT_MAX_TURNS,
    corporation_rates: list[dict[Resource, int]] | None = None,
    strategies: list | None = None,
    num_rounds: int = 1,
) -> GameState:
    """Run a complete game and return the final state.

    Args:
        strategy: Single strategy function applied to all players.
        strategies: Per-player strategy list (overrides `strategy`).
                    Length must match num_players.
        num_rounds: How many times to play through the event deck.
                    Each round reshuffles the same composition; the final
                    round ends with END_GAME.
    """
    # Load patents from CSV if available (same as the play adapter does).
    from my_project.parsing import parse_patents
    patents_path = Path(__file__).parent / "data" / "Patents.csv"
    patent_pile = parse_patents(patents_path) if patents_path.exists() else []

    state = GameState.create(
        all_cards=all_cards,
        all_contracts=all_contracts,
        num_players=num_players,
        start_money=start_money,
        start_market_pos=start_market_pos,
        randomize_market=randomize_market,
        max_turns=max_turns,
        corporation_rates=corporation_rates,
        num_rounds=num_rounds,
        patent_pile=patent_pile,
    )

    # Build per-player strategy list
    if strategies is not None:
        player_strategies = strategies
    elif strategy is not None:
        player_strategies = [strategy] * num_players
    else:
        raise ValueError("Must provide either `strategy` or `strategies`")

    # Play until the event deck is exhausted. Every event — including
    # END_ROUND and END_GAME — is a player's turn. The player takes their
    # normal actions, then the event fires. This gives exactly 30 player
    # turns at 3P with 2 rounds (17 round 1 + 13 round 2).
    safety = len(state.event_deck) + 100
    player_turn = 0
    while state.event_idx < len(state.event_deck) and player_turn < safety:
        event = state.event_deck[state.event_idx]
        state.event_idx += 1

        player_idx = player_turn % num_players
        player = state.players[player_idx]
        run_turn(state, player, player_strategies[player_idx], event)
        player_turn += 1

    return state
