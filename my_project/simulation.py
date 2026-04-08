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
        """Buy `amount` units. Returns total cost. Price increases by amount."""
        total = 0
        for _ in range(amount):
            total += self.price(resource)
            self.positions[resource] = min(self.positions[resource] + 1, len(PRICE_TRACK) - 1)
        return total

    def sell(self, resource: Resource, amount: int) -> int:
        """Sell `amount` units. Returns total revenue. Price decreases by amount."""
        total = 0
        for _ in range(amount):
            total += self.price(resource)
            self.positions[resource] = max(self.positions[resource] - 1, 0)
        return total

    def adjust(self, resource: Resource, delta: int) -> None:
        """Shift price position by delta (positive = up, negative = down)."""
        self.positions[resource] = max(0, min(
            self.positions[resource] + delta, len(PRICE_TRACK) - 1
        ))

    def estimate_buy_cost(self, resource: Resource, amount: int) -> int:
        """Estimate cost of buying without modifying market state."""
        total = 0
        pos = self.positions[resource]
        for _ in range(amount):
            p = max(0, min(pos, len(PRICE_TRACK) - 1))
            total += PRICE_TRACK[p]
            pos = min(pos + 1, len(PRICE_TRACK) - 1)
        return total

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
    buildings_played: list[str] = field(default_factory=list)
    contracts_fulfilled: int = 0
    hand_size: int = 3
    ledger: CostLedger = field(default_factory=CostLedger.create)

    def net_worth(self) -> int:
        return self.money - self.debt

    def rate(self, resource: Resource) -> int:
        return self.rates.get(resource, 0)

    def apply_rates(self, card: Card) -> None:
        for ra in card.rates:
            self.rates[ra.resource] = self.rates.get(ra.resource, 0) + ra.amount

    def snapshot(self) -> dict:
        return {
            "money": self.money,
            "debt": self.debt,
            "net_worth": self.net_worth(),
            "rates": {r.value: v for r, v in self.rates.items()},
            "buildings_played": list(self.buildings_played),
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


def build_event_deck(num_turns: int, num_players: int) -> list[EventType]:
    """Build a shuffled event deck with one card per player-turn.

    Default composition:
    - 3 power bills
    - 2 debt collections
    - 2 futures settlements
    - 3 PWR adjustments
    - rest are no-events
    """
    total = num_turns * num_players
    events: list[EventType] = []
    events.extend([EventType.POWER_BILL] * 3)
    events.extend([EventType.DEBT_COLLECTION] * 2)
    events.extend([EventType.FUTURES_SETTLEMENT] * 2)
    events.extend([EventType.PWR_ADJUST] * 3)

    remaining = total - len(events)
    if remaining > 0:
        events.extend([EventType.NO_EVENT] * remaining)
    else:
        events = events[:total]

    random.shuffle(events)
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
    market_snapshot: dict[str, int]
    rates_snapshot: dict[str, int]
    actions: list[ActionRecord] = field(default_factory=list)


@dataclass
class GameState:
    players: list[Player]
    market: Market
    deck: Deck
    contracts: list[Contract]
    available_contracts: list[Contract]
    pool: list[Card]
    event_deck: list[EventType]
    turn: int = 0
    event_idx: int = 0
    history: list[TurnRecord] = field(default_factory=list)
    max_turns: int = 15

    def remaining_events(self) -> dict[EventType, int]:
        """Count remaining events from current position in event deck."""
        counts: dict[EventType, int] = {e: 0 for e in EventType}
        for e in self.event_deck[self.event_idx:]:
            counts[e] += 1
        return counts

    @classmethod
    def create(
        cls,
        all_cards: list[Card],
        all_contracts: list[Contract],
        num_players: int = 1,
        start_money: int = 20,
        start_market_pos: int = 10,
        randomize_market: bool = False,
        max_turns: int = 15,
        corporation_rates: list[dict[Resource, int]] | None = None,
    ) -> GameState:
        market = Market.create(start_market_pos)

        if randomize_market:
            for r in Resource:
                roll = random.choice([3, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, -2, -2, -2, -3, -3, -4, -4, 0])
                market.adjust(r, roll)

        # Filter out special-effect cards (Slot 4 with effects)
        basic_cards = [c for c in all_cards if not c.effect]
        deck = Deck.from_cards(basic_cards)

        # Draw contracts
        contracts = list(all_contracts)
        random.shuffle(contracts)
        num_available = 2 + num_players
        available = contracts[:num_available]
        remaining_contracts = contracts[num_available:]

        # Draw pool
        pool = deck.draw(4)

        # Build event deck
        event_deck = build_event_deck(max_turns, num_players)

        # Create players
        players = []
        for i in range(num_players):
            p = Player(name=f"Player_{i+1}", money=start_money)
            if corporation_rates and i < len(corporation_rates):
                for r, v in corporation_rates[i].items():
                    p.rates[r] = v
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

    PWR: price × remaining power bills
    Others: price × (remaining futures settlements + 1 for end-game)
    """
    remaining = state.remaining_events()
    price = state.market.price(resource)

    if resource == Resource.PWR:
        collections = remaining.get(EventType.POWER_BILL, 0)
        return price * max(collections, 1)
    else:
        collections = remaining.get(EventType.FUTURES_SETTLEMENT, 0) + 1
        return price * collections


# --- Simulation Engine ---

def execute_build(
    state: GameState,
    player: Player,
    build_indices: list[int],
    discard_indices: list[int],
) -> ActionRecord | None:
    """Play one or more building cards. Optionally discard cards to reduce deficit.

    Returns ActionRecord on success, None if the build is unaffordable.
    """
    build_cards = [player.hand[i] for i in build_indices]
    num_discards = len(discard_indices)

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
        player.buildings_played.append(card.building)

    # Remove cards from hand (highest indices first to avoid shifting)
    all_indices = sorted(set(build_indices) | set(discard_indices), reverse=True)
    for idx in all_indices:
        player.hand.pop(idx)

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
            revenue = 0
            pos = state.market.positions[sell_res]
            for _ in range(rate):
                p = max(0, min(pos, len(PRICE_TRACK) - 1))
                revenue += PRICE_TRACK[p]
                pos = max(pos - 1, 0)
            if revenue > best_revenue:
                best_revenue = revenue
                best_resource = sell_res

    if best_resource is None:
        player.hand.pop(card_idx)
        return ActionRecord(action_type="sell", detail="Sold (no matching resources)")

    rate = max(0, player.rate(best_resource))
    revenue = state.market.sell(best_resource, rate)
    player.money += revenue
    player.ledger.record_sell(best_resource, revenue)
    player.hand.pop(card_idx)
    return ActionRecord(
        action_type="sell",
        detail=f"Sold {rate} {best_resource.value} for ${revenue}",
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

    # Check if player can afford the rate costs
    for req in contract.requirements:
        if player.rate(req.resource) < req.amount:
            return None

    # Compute costs from ledger before spending rates
    contract_true_cost = player.ledger.contract_cost(contract.requirements)
    contract_gross_cost = player.ledger.contract_gross_cost(contract.requirements)

    # Spend rates permanently
    rates_spent: dict[str, int] = {}
    for req in contract.requirements:
        player.rates[req.resource] -= req.amount
        rates_spent[req.resource.value] = req.amount

    # Record in ledger
    player.ledger.record_contract(contract.requirements)

    player.money += contract.reward
    player.contracts_fulfilled += 1
    player.hand.pop(card_idx)

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
    """Power bill event: positive PWR earns money, negative PWR adds debt."""
    pwr_price = state.market.price(Resource.PWR)
    for player in state.players:
        pwr_rate = player.rate(Resource.PWR)
        if pwr_rate > 0:
            player.money += pwr_rate * pwr_price
        elif pwr_rate < 0:
            cost = abs(pwr_rate) * pwr_price
            player.debt += cost
            player.ledger.record_event_cost(Resource.PWR, cost, pwr_rate)


def do_debt_collection(state: GameState) -> None:
    """Increase debt by $1 per $10 owed (minus contract value)."""
    for player in state.players:
        contract_offset = player.contracts_fulfilled * 50
        effective_debt = max(0, player.debt - contract_offset)
        interest = effective_debt // 10
        player.debt += interest


def do_futures_settlement(state: GameState) -> None:
    """Players with negative resources buy at market rate (as debt)."""
    for player in state.players:
        for r in Resource:
            if r == Resource.PWR:
                continue  # PWR handled by power bill
            rate = player.rate(r)
            if rate < 0:
                cost = state.market.buy(r, abs(rate))
                player.debt += cost
                player.ledger.record_event_cost(r, cost, rate)


def execute_event(state: GameState, event: EventType, active_player: Player) -> str:
    """Execute an event and return a description."""
    match event:
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


def run_turn(state: GameState, player: Player, strategy, event: EventType) -> None:
    """Run one turn: pool swaps, then actions until hand empty or pass, draw, event."""
    state.turn += 1
    money_before = player.money
    action_records: list[ActionRecord] = []

    # Pool swapping phase (free, before actions)
    swap_fn = getattr(strategy, 'pool_swap', None)
    if swap_fn:
        swap_fn(state, player)

    # Action phase: keep taking actions until hand is empty or player passes
    max_actions = 10  # safety limit
    actions_taken = 0
    while player.hand and actions_taken < max_actions:
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

    # Execute event
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
        market_snapshot=state.market.snapshot(),
        rates_snapshot={r.value: v for r, v in player.rates.items()},
        actions=action_records,
    ))


def run_game(
    all_cards: list[Card],
    all_contracts: list[Contract],
    strategy=None,
    num_players: int = 1,
    start_money: int = 20,
    start_market_pos: int = 10,
    randomize_market: bool = False,
    max_turns: int = 15,
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
            event = state.event_deck[state.event_idx] if state.event_idx < len(state.event_deck) else EventType.NO_EVENT
            state.event_idx += 1
            run_turn(state, player, player_strategies[i], event)

    # End game: final futures settlement
    do_futures_settlement(state)

    return state
