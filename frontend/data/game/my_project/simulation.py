"""Game state model and simulation engine for the board game.

Simulates N players taking turns: draw cards, take one action (build/sell/contract),
draw back to hand size, then resolve one event from the event deck.
"""

from __future__ import annotations

import random
from collections import defaultdict
from dataclasses import dataclass, field
from enum import StrEnum

from my_project.accounting import CostLedger
from my_project.models import Card, Contract, Resource, ResourceAmount


# --- Market ---

PRICE_TRACK = [1, 1, 1, 2, 2, 2, 3, 3, 4, 4, 5, 5, 6, 7, 8, 9, 10]

# Game balance constants
DEFAULT_MAX_TURNS = 8
DEFAULT_NUM_PLAYERS = 3
DEFAULT_START_MONEY = 20
DEFAULT_MARKET_POS = 9
HAND_SIZE = 3
POOL_SIZE = 4
CONTRACTS_AVAILABLE_BASE = 2  # base + num_players contract cards drawn
CONTRACT_REWARD = 50  # net worth value of a fulfilled contract
DEBT_INTEREST_DIVISOR = 10  # $1 interest per $X owed
MAX_ACTIONS_PER_TURN = 10  # safety limit

# Event deck composition (random within ranges)
POWER_BILL_RANGE = (3, 4)
DEBT_COLLECTION_RANGE = (2, 4)
FUTURES_SETTLEMENT_RANGE = (3, 4)
PWR_ADJUST_FRACTION = 0.5  # fraction of remaining slots

# Slot-4 special buildings whose effects are wired up. Cards in Cards.csv
# with `effect` strings are excluded from the deck unless their `Building`
# name appears here. Add to this set when implementing a new special-
# building handler so the deck starts dealing it.
SUPPORTED_SPECIAL_EFFECTS: set[str] = {
    "Pleasure Dome",        # passive: power-bill bonus per dome owned
    "Optimization Center",  # passive: pre-futures rate boost
    "Space Elevator",       # passive: -1 to all contract requirements
    "Hacker Array",         # passive on sell: +3 to highest-priced non-sold resource
    "Patent Office",        # build-time: draw 2 patents, keep best, return other
}


# Corporations (name, starting rates)
CORPORATIONS: list[tuple[str, dict[str, int]]] = [
    ("Seneca Development", {"PWR": 2, "FE": 1, "FOOD": -1}),
    ("Yoshimi Robotics", {"PWR": -2, "FE": 2}),
    ("Reclamation Inc.", {"PWR": 1, "SI": 1, "C": 1, "H2O": -1}),
]


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

    def net_worth(self) -> int:
        return self.money - self.debt + self.contracts_fulfilled * CONTRACT_REWARD

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
    # Stub for the future patent auction system. Currently a no-op.
    PATENT_AUCTION = "patent_auction"
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

    def display_label(self) -> str:
        return self.label or self.type.value


def _ec(t: EventType, redraws: bool = False) -> EventCard:
    """Shorthand for creating a simple (no-payload) EventCard."""
    return EventCard(type=t, redraws=redraws)


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


# Hardcoded effect dispatch keyed by exact card name from Events.csv (the
# "NEWS: " prefix is stripped before lookup). The CSV's freeform Effect column
# is documentation; the truth lives here.
NEWS_EFFECTS: dict[str, list[NewsEffect]] = {
    "Colonist Shuttle":         [NewsEffect("rate_all", {"PWR": -1, "O2": -1})],
    "Population Growth":        [NewsEffect("rate_all", {"PWR": -1, "FOOD": -1})],
    "Infrastructure Added":     [NewsEffect("rate_all", {"PWR": -1, "H2O": -1})],
    "MARSQUAKE":                [NewsEffect("rate_all", {"PWR": -1, "FE": -1})],
    "Wage Increases":           [NewsEffect("rate_all", {"GLS": -1, "ELX": -1})],
    "Life Support Volatile":    [NewsEffect("market_random", {"resources": ["H2O", "O2", "FOOD"], "rolls": 1})],
    "Raw Materials Volatile":   [NewsEffect("market_random", {"resources": ["FE", "C", "SI"], "rolls": 1})],
    "Consumer Goods Volatile":  [NewsEffect("market_random", {"resources": ["GLS", "ELX"], "rolls": 1})],
    "Power Market Volatile":    [NewsEffect("market_random", {"resources": ["PWR"], "rolls": 2})],
    "All Quiet":                [],
    "Debt Collection":          [NewsEffect("trigger", {"event": "debt_collection"})],
    "Power Bill":               [NewsEffect("trigger", {"event": "power_bill"})],
    "Futures Settlement":       [NewsEffect("trigger", {"event": "futures_settlement"})],
}

# Same d20 distribution used by GameState.create's randomize_market roll.
_D20_DELTAS = [3, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, -2, -2, -2, -3, -3, -4, -4, 0]


def build_default_news_deck() -> list[NewsCard]:
    """Build a fresh news deck containing one card per entry in NEWS_EFFECTS."""
    return [NewsCard(name=name, effects=list(effects)) for name, effects in NEWS_EFFECTS.items()]


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
    pwr_adjust_fraction: float = PWR_ADJUST_FRACTION


def default_event_counts(num_players: int) -> dict[str, int]:
    """Return the default per-event-type counts for a given player count.

    These values mirror Events.csv. The player-count conditionals from the
    CSV (3-4P Patent Auction vs 2P News Bulletin, redraw flags on Draw
    Building Card) are resolved here.
    """
    # Base counts from Events.csv rows 2-10
    counts = {
        "news_bulletin": 3,
        "debt_collection": 2,
        "power_bill": 1,
        "futures_settlement": 1,
        "patent_auction": 3,
        "draw_building": 5,         # row 9: regular draws (no redraw at 3-4P)
        "draw_building_redraw": 5,  # row 10: redraw at 2-3P
    }
    # Row 7 conditional: 3-4P → Patent Auction, 2P → News Bulletin
    if num_players >= 3:
        counts["patent_auction"] += 1
    else:
        counts["news_bulletin"] += 1
    # Row 9 redraws at 2P
    if num_players == 2:
        counts["draw_building_redraw"] += counts["draw_building"]
        counts["draw_building"] = 0
    # Row 10 redraws at 2-3P (already in counts as redraw); at 4P+ they're regular
    if num_players >= 4:
        counts["draw_building"] += counts["draw_building_redraw"]
        counts["draw_building_redraw"] = 0
    return counts


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


def build_event_deck(
    num_turns: int,
    num_players: int,
    config: EventDeckConfig | None = None,
) -> list[EventCard]:
    """Build a shuffled event deck for one full game.

    Composition defaults come from default_event_counts(num_players). The
    deck is sized to num_turns * num_players PLUS the number of redraw
    cards, since each redraw consumes an extra event slot during play.
    The last card is always END_GAME.

    Any user-supplied EventDeckConfig fields override the defaults; fields
    left as None use default_event_counts.
    """
    cfg = config or EventDeckConfig()
    defaults = default_event_counts(num_players)

    n_news_bulletin = _resolve_or_default(cfg.news_bulletin_count, defaults["news_bulletin"])
    n_debt = _resolve_or_default(cfg.debt_collection_count, defaults["debt_collection"])
    n_power = _resolve_or_default(cfg.power_bill_count, defaults["power_bill"])
    n_futures = _resolve_or_default(cfg.futures_settlement_count, defaults["futures_settlement"])
    n_patent = _resolve_or_default(cfg.patent_auction_count, defaults["patent_auction"])
    n_draw_reg = _resolve_or_default(cfg.draw_building_count, defaults["draw_building"])
    n_draw_redraw = _resolve_or_default(cfg.draw_building_redraw_count, defaults["draw_building_redraw"])

    events: list[EventCard] = []
    events.extend([_ec(EventType.NEWS_BULLETIN)] * n_news_bulletin)
    events.extend([_ec(EventType.DEBT_COLLECTION)] * n_debt)
    events.extend([_ec(EventType.POWER_BILL)] * n_power)
    events.extend([_ec(EventType.FUTURES_SETTLEMENT)] * n_futures)
    events.extend([_ec(EventType.PATENT_AUCTION)] * n_patent)
    events.extend([_ec(EventType.DRAW_BUILDING_CARD)] * n_draw_reg)
    events.extend([_ec(EventType.DRAW_BUILDING_CARD, redraws=True)] * n_draw_redraw)

    # Legacy direct-NEWS pool (JSON Advanced section). Sampled with replacement.
    news_n = _resolve_count(cfg.news_count)
    if news_n > 0 and cfg.news_pool:
        events.extend(random.choices(cfg.news_pool, k=news_n))

    # Size the deck to player_turns + redraws so each player-turn gets at
    # least one event after redraws have consumed extras.
    player_turns = num_turns * num_players
    redraw_count = sum(1 for ec in events if ec.redraws)
    target_size = player_turns + redraw_count

    # Truncate if the structured composition already exceeds target size.
    if len(events) > target_size - 1:  # -1 leaves room for END_GAME
        events = events[: target_size - 1]
        redraw_count = sum(1 for ec in events if ec.redraws)
        target_size = player_turns + redraw_count

    # Pad with PWR_ADJUST / NO_EVENT fillers up to target_size - 1.
    fillers_needed = (target_size - 1) - len(events)
    if fillers_needed > 0:
        pwr_adjusts = int(fillers_needed * cfg.pwr_adjust_fraction)
        events.extend([_ec(EventType.PWR_ADJUST)] * pwr_adjusts)
        events.extend([_ec(EventType.NO_EVENT)] * (fillers_needed - pwr_adjusts))

    random.shuffle(events)
    # END_GAME always goes at the bottom (fires on the final player-turn)
    events.append(_ec(EventType.END_GAME))
    return events


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
    max_turns: int = DEFAULT_MAX_TURNS

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
    ) -> GameState:
        market = Market.create(start_market_pos)

        if randomize_market:
            for r in Resource:
                roll = random.choice([3, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, -2, -2, -2, -3, -3, -4, -4, 0])
                market.adjust(r, roll)

        # Filter the deck to only include cards whose effect we know how to
        # handle. Slot-4 buildings live in Cards.csv with non-empty `effect`
        # strings; SUPPORTED_SPECIAL_EFFECTS gates which ones are wired up.
        # Anything with an unrecognized effect is silently excluded so the
        # deck can't deal "broken" cards.
        playable_cards = [
            c for c in all_cards
            if not c.effect or c.building in SUPPORTED_SPECIAL_EFFECTS
        ]
        deck = Deck.from_cards(playable_cards)

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
            event_deck = build_event_deck(max_turns, num_players, event_deck_config)

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
        corp_pool = list(CORPORATIONS)
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
) -> ActionRecord | None:
    """Play one or more building cards. Optionally discard cards to reduce deficit.

    Returns ActionRecord on success, None if the build is unaffordable OR if
    the player has already built this turn (one build action per turn).
    """
    if player.has_built_this_turn:
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
        # Patent Office build-time trigger: draw 2 patents, keep the better
        # one (by total rate sum), put the other back on top of the pile.
        if card.building == "Patent Office":
            _patent_office_trigger(state, player)

    # Remove cards from hand (highest indices first to avoid shifting) → discard pile
    all_indices = sorted(set(build_indices) | set(discard_indices), reverse=True)
    for idx in all_indices:
        state.deck.discard.append(player.hand.pop(idx))

    # Enforce one build per turn
    player.has_built_this_turn = True

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


def execute_sell(state: GameState, player: Player, card_idx: int) -> ActionRecord:
    """Sell resources using a card's alternate sell types."""
    card = player.hand[card_idx]
    best_resource = None
    best_revenue = 0

    for sell_res in card.can_sell:
        rate = max(0, player.rate(sell_res))
        if rate > 0:
            # All units sell at current price (then market drops by amount)
            revenue = state.market.price(sell_res) * rate
            if revenue > best_revenue:
                best_revenue = revenue
                best_resource = sell_res

    if best_resource is None:
        state.deck.discard.append(player.hand.pop(card_idx))
        return ActionRecord(action_type="sell", detail="Sold (no matching resources)")

    rate = max(0, player.rate(best_resource))
    revenue = state.market.sell(best_resource, rate)
    player.money += revenue
    player.ledger.record_sell(best_resource, revenue)
    # Per-player flow tracking
    player.flow_sold_units[best_resource] += rate
    player.flow_sell_revenue[best_resource] += revenue
    state.deck.discard.append(player.hand.pop(card_idx))

    # Hacker Array bonus: passive effect that fires on every sell. The owner
    # bumps the highest-priced resource (other than the one just sold) by +3.
    # Auto-targeted for now; an explicit picker UI is a future improvement.
    detail_extra = ""
    ha_count = _count_buildings(player, "Hacker Array")
    if ha_count > 0:
        candidates = [r for r in Resource if r != best_resource and r != Resource.PWR]
        if candidates:
            target = max(candidates, key=lambda r: state.market.price(r))
            state.market.adjust(target, 3)
            detail_extra = f" [HA: +3 {target.value}]"

    return ActionRecord(
        action_type="sell",
        detail=f"Sold {rate} {best_resource.value} for ${revenue}{detail_extra}",
        sell_resource=best_resource.value,
        sell_amount=rate,
        sell_revenue=revenue,
    )


def execute_contract(
    state: GameState, player: Player, card_idx: int, contract_idx: int,
) -> ActionRecord | None:
    """Fulfill a contract. Requires contract icon on card.

    Returns ActionRecord on success, None if player can't afford it.
    """
    contract = state.available_contracts[contract_idx]
    # Apply Space Elevator discount: each SE reduces every requirement by 1.
    effective_reqs = effective_contract_requirements(player, contract)

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

    # Contracts pay off debt, not give cash. Remaining value is end-game net worth.
    debt_payoff = min(player.debt, contract.reward)
    player.debt -= debt_payoff
    player.contracts_fulfilled += 1
    state.deck.discard.append(player.hand.pop(card_idx))

    # Display label uses the ORIGINAL requirements so the log is consistent
    # (the discount is reflected in rates_spent for analytics).
    req_str = ", ".join(f"{r.amount} {r.resource.value}" for r in contract.requirements)
    label = req_str

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


# Pleasure Dome bonus tiers: indexed by GLOBAL number of PDs in play - 1.
# Source: Cards.csv "Power Bill: $20/$15/$10 if 1/2/3 PD in play".
# Each owner who has at least one PD receives the same per-owner amount
# from the tier — so:
#   1 PD globally  → that owner gets $20
#   2 PDs globally → each owner gets $15
#   3+ PDs globally → each owner gets $10
# With one-of-each enforcement, "PDs globally" == number of distinct
# owners (each owner has 0 or 1 PD).
PLEASURE_DOME_TIERS = [20, 15, 10]


def _global_dome_count(state: GameState) -> int:
    """Total number of Pleasure Domes across all players."""
    return sum(_count_buildings(p, "Pleasure Dome") for p in state.players)


def _pleasure_dome_bonus(state: GameState, player: Player) -> int:
    """Per-owner power-bill bonus from Pleasure Dome.

    The tier is keyed on the GLOBAL number of PDs in play, not on this
    player's count. Each owner who has at least one PD gets the same
    per-owner amount from that tier.
    """
    if _count_buildings(player, "Pleasure Dome") == 0:
        return 0
    total = _global_dome_count(state)
    return PLEASURE_DOME_TIERS[min(total - 1, len(PLEASURE_DOME_TIERS) - 1)]


def _patent_office_trigger(state: GameState, player: Player) -> None:
    """Build-time trigger: draw 2 patents, keep the better, return the other.

    "Better" is the patent with the higher total positive rate sum (a simple
    proxy for value). Ties pick the first drawn. If only 1 patent is left,
    just take it. If 0, no-op.

    The kept patent is appended to player.buildings_played and its rates
    are applied. The returned patent goes back on TOP of the pile so the
    next Patent Office (or other patent-related event) can pick it up.
    """
    # How many patents are still available?
    available = len(state.patent_pile) - state.patent_idx
    if available <= 0:
        return
    drawn: list[Card] = []
    for _ in range(min(2, available)):
        drawn.append(state.patent_pile[state.patent_idx])
        state.patent_idx += 1

    if len(drawn) == 1:
        kept = drawn[0]
    else:
        a, b = drawn
        score_a = sum(ra.amount for ra in a.rates if ra.amount > 0)
        score_b = sum(ra.amount for ra in b.rates if ra.amount > 0)
        if score_b > score_a:
            kept, returned = b, a
        else:
            kept, returned = a, b
        # Put the returned patent back on TOP of the pile (next card drawn).
        # The cursor advanced past 2 cards; rewind it 1 and overwrite the
        # slot just past the cursor with the returned card.
        state.patent_idx -= 1
        state.patent_pile[state.patent_idx] = returned

    player.buildings_played.append(kept)
    player.apply_rates(kept)


def effective_contract_requirements(
    player: Player,
    contract: Contract,
) -> list[ResourceAmount]:
    """Apply Space Elevator's -1 to each contract requirement (floor 0).

    Each Space Elevator the player owns reduces every contract requirement
    by 1, down to a minimum of 0. Returns a fresh list of ResourceAmount
    so callers can use it without mutating the original contract.
    """
    discount = _count_buildings(player, "Space Elevator")
    if discount == 0:
        return list(contract.requirements)
    return [
        ResourceAmount(resource=req.resource, amount=max(0, req.amount - discount))
        for req in contract.requirements
    ]


# --- Events ---

def do_pwr_adjust(state: GameState, player: Player) -> None:
    """Adjust PWR market price based on active player's rate.

    Positive PWR shifts price down (like selling), negative shifts up.
    """
    pwr_rate = player.rate(Resource.PWR)
    if pwr_rate > 0:
        state.market.adjust(Resource.PWR, -pwr_rate)
    elif pwr_rate < 0:
        state.market.adjust(Resource.PWR, abs(pwr_rate))


def do_power_bill(state: GameState) -> None:
    """Power bill event: positive PWR earns money, negative PWR adds debt.

    Pleasure Dome owners also get a flat per-dome bonus on every power bill.
    """
    pwr_price = state.market.price(Resource.PWR)
    for player in state.players:
        pwr_rate = player.rate(Resource.PWR)
        if pwr_rate > 0:
            earning = pwr_rate * pwr_price
            player.money += earning
            state.pwr_total_earned += earning
            state.bills_units_earned[Resource.PWR] += pwr_rate
            # Per-player: power bill earnings count as "sold" PWR
            player.flow_sold_units[Resource.PWR] += pwr_rate
            player.flow_sell_revenue[Resource.PWR] += earning
        elif pwr_rate < 0:
            shortage = abs(pwr_rate)
            cost = shortage * pwr_price
            player.debt += cost
            state.pwr_total_debt += cost
            state.bills_units_owed[Resource.PWR] += shortage
            player.ledger.record_event_cost(Resource.PWR, cost, pwr_rate)
            # Per-player: power bill debt counts as "bought" PWR
            player.flow_bought_units[Resource.PWR] += shortage
            player.flow_buy_cost[Resource.PWR] += cost
        # Pleasure Dome bonus is added on top of normal bill processing.
        bonus = _pleasure_dome_bonus(state, player)
        if bonus > 0:
            player.money += bonus


def do_debt_collection(state: GameState) -> None:
    """Increase debt by $1 per DEBT_INTEREST_DIVISOR owed (minus contract value)."""
    for player in state.players:
        contract_offset = player.contracts_fulfilled * CONTRACT_REWARD
        effective_debt = max(0, player.debt - contract_offset)
        interest = effective_debt // DEBT_INTEREST_DIVISOR
        player.debt += interest


def do_futures_settlement(state: GameState) -> None:
    """Players with negative resources buy at market rate (as debt).

    All players pay the price at the start of settlement. Then the market
    rises by the total negative rates across all players for each resource.

    Optimization Center owners get +1 to a positive non-PWR rate per OC,
    applied BEFORE the settlement is calculated. The chosen rate is the
    highest-priced one the player currently has (max value boost).
    """
    # Snapshot prices before any market shifts
    starting_prices = {r: state.market.price(r) for r in Resource if r != Resource.PWR}
    total_negatives: dict[Resource, int] = {r: 0 for r in starting_prices}

    # Optimization Center: pre-settlement rate boost
    for player in state.players:
        oc_count = _count_buildings(player, "Optimization Center")
        for _ in range(oc_count):
            # Pick the highest-priced positive non-PWR rate to boost.
            candidates = [
                r for r in starting_prices
                if player.rate(r) > 0
            ]
            if not candidates:
                continue
            best = max(candidates, key=lambda r: starting_prices[r])
            player.rates[best] = player.rate(best) + 1

    # All players pay debt at the snapshot price
    for player in state.players:
        for r in starting_prices:
            rate = player.rate(r)
            if rate < 0:
                shortage = abs(rate)
                cost = starting_prices[r] * shortage
                player.debt += cost
                state.futures_total_debt += cost
                state.futures_units_bought[r] += shortage
                state.futures_debt_per_resource[r] += cost
                player.ledger.record_event_cost(r, cost, rate)
                total_negatives[r] += shortage
                # Per-player futures tracking
                player.flow_futures_units[r] += shortage
                player.flow_futures_cost[r] += cost

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
        return ", ".join(parts) or "no rate change"

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
        return ", ".join(parts) or "no market change"

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
        return "news bulletin (deck empty)"
    if not card.effects:
        return f"NEWS: {card.name} (All Quiet)"
    detail_parts = [_apply_news_effect(state, eff, active_player) for eff in card.effects]
    return f"NEWS: {card.name} ({'; '.join(detail_parts)})"


def do_draw_building_card(state: GameState) -> str:
    """Refresh the pool by drawing a fresh card from the building deck.

    Pool size stays at POOL_SIZE: the new card replaces the oldest pool slot.
    """
    if not state.deck.cards and not state.deck.discard:
        return "draw building card (deck empty)"
    drawn = state.deck.draw(1)
    if not drawn:
        return "draw building card (deck empty)"
    new_card = drawn[0]
    if state.pool:
        # FIFO: evict the oldest pool slot back to the discard pile.
        evicted = state.pool.pop(0)
        state.deck.discard.append(evicted)
    state.pool.append(new_card)
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
      - Winner pays runner_up + 5 as DEBT (per the rules doc)
      - If only one player bids, they pay 5 (since runner_up = 0)
    """
    positive_bids = {idx: amt for idx, amt in bids.items() if amt > 0}
    if not positive_bids:
        return None

    # Sort by (-bid, idx) so highest bid first, ties broken by lower seat
    sorted_bidders = sorted(positive_bids.items(), key=lambda kv: (-kv[1], kv[0]))
    winner_idx, winner_bid = sorted_bidders[0]
    runner_up_bid = sorted_bidders[1][1] if len(sorted_bidders) > 1 else 0

    # Pay runner_up + 5 (as debt)
    amount_paid = runner_up_bid + 5
    state.players[winner_idx].debt += amount_paid
    state.players[winner_idx].buildings_played.append(patent)
    # Apply the patent's rates to the winner's accumulated rates
    state.players[winner_idx].apply_rates(patent)
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
        return "patent auction (no patents left)"

    bids: dict[int, int] = {}
    for idx, player in enumerate(state.players):
        if idx in state.pending_bids:
            bids[idx] = state.pending_bids[idx]
        else:
            bids[idx] = _default_ai_bid(player, patent)
    # Clear the bid overrides; they're consumed by this single auction.
    state.pending_bids = {}

    result = settle_silent_auction(state, patent, bids)
    if result is None:
        return f"patent auction ({patent.building}): no bids"
    winner_idx, amount = result
    return (
        f"patent auction: {state.players[winner_idx].name} "
        f"won {patent.building} for ${amount} debt"
    )


def _default_ai_bid(player: Player, patent: Card) -> int:
    """Heuristic bid for the headless / Monte Carlo path.

    Bids up to 1/3 of available cash, capped at $30. Bids in $5
    increments. Players with more debt than cash bid 0 (passing).
    """
    available = player.money - player.debt
    if available <= 0:
        return 0
    target = min(available // 3, 30)
    # Round down to a $5 increment
    return (target // 5) * 5


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
    """
    detail = execute_event(state, event, active_player)
    while event.redraws and state.event_idx < len(state.event_deck):
        next_event = state.event_deck[state.event_idx]
        state.event_idx += 1
        detail = detail + " | " + execute_event(state, next_event, active_player)
        event = next_event
    return detail


def execute_event(state: GameState, event: EventCard, active_player: Player) -> str:
    """Execute an event card and return a description."""
    match event.type:
        case EventType.NO_EVENT:
            return "no event"
        case EventType.PWR_ADJUST:
            do_pwr_adjust(state, active_player)
            return f"PWR adjust (rate={active_player.rate(Resource.PWR)})"
        case EventType.POWER_BILL:
            do_power_bill(state)
            return "power bill"
        case EventType.DEBT_COLLECTION:
            do_debt_collection(state)
            return "debt collection"
        case EventType.FUTURES_SETTLEMENT:
            do_futures_settlement(state)
            return "futures settlement"
        case EventType.NEWS:
            return do_news(state, event)
        case EventType.NEWS_BULLETIN:
            return do_news_bulletin(state, active_player)
        case EventType.DRAW_BUILDING_CARD:
            return do_draw_building_card(state)
        case EventType.PATENT_AUCTION:
            return do_patent_auction(state)
        case EventType.END_GAME:
            do_power_bill(state)
            do_futures_settlement(state)
            return "END GAME (final power bill + futures settlement)"


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
        return execute_sell(state, player, action.sell_card)

    elif action.action_type == ActionType.CONTRACT and action.contract_card >= 0:
        return execute_contract(state, player, action.contract_card, action.contract_idx)

    return None


def run_turn(state: GameState, player: Player, strategy, event: EventCard) -> None:
    """Run one turn: pool swaps, then actions until hand empty or pass, draw, event."""
    state.turn += 1
    money_before = player.money
    action_records: list[ActionRecord] = []

    # Reset per-turn state (rule: one build action per turn)
    player.has_built_this_turn = False

    # Pool swapping phase (free, before actions)
    swap_fn = getattr(strategy, 'pool_swap', None)
    if swap_fn:
        swap_fn(state, player)

    # Action phase: keep taking actions until hand is empty or player passes
    actions_taken = 0
    while player.hand and actions_taken < MAX_ACTIONS_PER_TURN:
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

    # Execute event (with cascading redraws if applicable)
    event_detail = execute_event_with_redraws(state, event, player)

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
) -> GameState:
    """Run a complete game and return the final state.

    Args:
        strategy: Single strategy function applied to all players.
        strategies: Per-player strategy list (overrides `strategy`).
                    Length must match num_players.
    """
    state = GameState.create(
        all_cards=all_cards,
        all_contracts=all_contracts,
        num_players=num_players,
        start_money=start_money,
        start_market_pos=start_market_pos,
        randomize_market=randomize_market,
        max_turns=max_turns,
        corporation_rates=corporation_rates,
    )

    # Build per-player strategy list
    if strategies is not None:
        player_strategies = strategies
    elif strategy is not None:
        player_strategies = [strategy] * num_players
    else:
        raise ValueError("Must provide either `strategy` or `strategies`")

    for _ in range(max_turns):
        for i, player in enumerate(state.players):
            event = state.event_deck[state.event_idx] if state.event_idx < len(state.event_deck) else _ec(EventType.NO_EVENT)
            state.event_idx += 1
            run_turn(state, player, player_strategies[i], event)

    return state
