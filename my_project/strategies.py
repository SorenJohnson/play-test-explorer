"""AI strategies for the simulation.

Each strategy is a callable: (GameState, Player) -> Action
Called repeatedly within a turn until the player passes or runs out of cards.

Strategies also have a `pool_swap` attribute for the pool-swapping phase.
"""

from __future__ import annotations

import random
from itertools import combinations

from my_project.models import Resource
from my_project.simulation import (
    Action,
    ActionType,
    EventType,
    GameState,
    Player,
    compute_build_deficit,
    swap_pool_card,
)

# Valuation constants
SELL_VALUE_MULTIPLIER = 1.5  # positive rate value = current sell price × this


# --- Pool Swapping ---

def _score_card(card, player: Player, state) -> float:
    """Rough score of how valuable a card is to this player (for greedy pool swap)."""
    market = state.market

    # Value of building it
    build_value = 0.0
    for ra in card.rates:
        price = market.price(ra.resource)
        if ra.amount > 0:
            build_value += price * ra.amount * 3
        else:
            build_value -= price * abs(ra.amount) * 3

    # Estimate build cost
    build_cost = 0.0
    for ra in card.costs:
        have = max(0, player.rate(ra.resource))
        deficit = max(0, ra.amount - have)
        if deficit > 0:
            build_cost += market.estimate_buy_cost(ra.resource, deficit)

    # Value of selling
    sell_value = 0.0
    if card.can_sell:
        for sell_res in card.can_sell:
            rate = max(0, player.rate(sell_res))
            if rate > 0:
                sell_value = max(sell_value, rate * market.price(sell_res))

    # Contract card value = best affordable contract score
    contract_value = 0.0
    if card.can_fulfill_contract:
        for contract in state.available_contracts:
            can_afford = all(
                player.rate(req.resource) >= req.amount for req in contract.requirements
            )
            if can_afford:
                score = _score_contract(state, player, contract)
                if score is not None:
                    contract_value = max(contract_value, score)

    return max(build_value - build_cost, sell_value, contract_value)


def _greedy_pool_swap(state: GameState, player: Player) -> None:
    """Swap hand cards with pool cards if pool has better options."""
    if not state.pool:
        return

    for _ in range(len(player.hand)):  # max swaps = hand size
        best_swap = None
        best_gain = 0.0

        for hi, hand_card in enumerate(player.hand):
            hand_score = _score_card(hand_card, player, state)
            for pi, pool_card in enumerate(state.pool):
                pool_score = _score_card(pool_card, player, state)
                gain = pool_score - hand_score
                if gain > best_gain:
                    best_gain = gain
                    best_swap = (hi, pi)

        if best_swap:
            swap_pool_card(state, player, best_swap[0], best_swap[1])
        else:
            break  # no beneficial swaps left


def _random_pool_swap(state: GameState, player: Player) -> None:
    """Randomly swap 0-1 cards with the pool."""
    if not state.pool and not player.hand:
        return
    if random.random() < 0.3 and player.hand and state.pool:
        hi = random.randrange(len(player.hand))
        pi = random.randrange(len(state.pool))
        swap_pool_card(state, player, hi, pi)


# --- Strategies ---

def random_strategy(state: GameState, player: Player) -> Action:
    """Pick a random legal action. Always acts if any legal move exists."""
    if not player.hand:
        return Action(ActionType.PASS)

    options: list[Action] = []

    # Build: try single cards (with optional discard of others to help afford)
    for i, card in enumerate(player.hand):
        remaining = [j for j in range(len(player.hand)) if j != i]
        # Try without discards first, then with
        for num_disc in range(len(remaining) + 1):
            discard_list = remaining[:num_disc]
            result = compute_build_deficit([card], player, num_disc, state.market)
            if result is not None:
                options.append(Action(ActionType.BUILD, build_cards=[i], discard_cards=list(discard_list)))
                break  # found cheapest affordable discard level

    # Sell: any card whose sell alternates match a positive rate
    for i, card in enumerate(player.hand):
        if card.can_sell:
            for sell_res in card.can_sell:
                if player.rate(sell_res) > 0:
                    options.append(Action(ActionType.SELL, sell_card=i))
                    break

    # Contract
    for i, card in enumerate(player.hand):
        if card.can_fulfill_contract:
            for ci, contract in enumerate(state.available_contracts):
                can_afford = all(
                    player.rate(req.resource) >= req.amount
                    for req in contract.requirements
                )
                if can_afford:
                    options.append(Action(ActionType.CONTRACT, contract_card=i, contract_idx=ci))

    if not options:
        # No legal action — discard a non-contract card to cycle it
        non_contract = [i for i, c in enumerate(player.hand) if not c.can_fulfill_contract]
        if non_contract:
            return Action(ActionType.SELL, sell_card=random.choice(non_contract))
        # Only contract cards left and can't afford any — pass
        return Action(ActionType.PASS)

    return random.choice(options)


random_strategy.pool_swap = _random_pool_swap


def greedy_strategy(state: GameState, player: Player) -> Action:
    """Pick the highest-value action. Called repeatedly until pass or hand empty.

    Each call evaluates the current hand state and picks the single best action.
    Multi-card builds are considered (all subsets of current hand).
    """
    if not player.hand:
        return Action(ActionType.PASS)

    best_score = -999.0
    best_action = Action(ActionType.PASS)
    hand_indices = list(range(len(player.hand)))

    # Score build options (all subsets of current hand)
    for size in range(1, len(player.hand) + 1):
        for build_combo in combinations(hand_indices, size):
            build_list = list(build_combo)
            remaining = [i for i in hand_indices if i not in build_combo]
            cards = [player.hand[i] for i in build_list]

            # Try with increasing discards
            best_for_combo = None
            for num_disc in range(len(remaining) + 1):
                discard_list = remaining[:num_disc]
                result = compute_build_deficit(cards, player, num_disc, state.market)
                if result is None:
                    continue

                _, estimated_cost = result
                value = _score_build_value(cards, state, player)
                score = value - estimated_cost

                if best_for_combo is None or score > best_for_combo[0]:
                    best_for_combo = (score, build_list, list(discard_list))

            if best_for_combo is not None:
                score, bl, dl = best_for_combo
                if score > best_score:
                    best_score = score
                    best_action = Action(ActionType.BUILD, build_cards=bl, discard_cards=dl)

    # Score sell options
    for i, card in enumerate(player.hand):
        if card.can_sell:
            sell_score = _score_sell(state, player, card)
            if sell_score > best_score:
                best_score = sell_score
                best_action = Action(ActionType.SELL, sell_card=i)

    # Score contract options
    for i, card in enumerate(player.hand):
        if card.can_fulfill_contract:
            for ci, contract in enumerate(state.available_contracts):
                contract_score = _score_contract(state, player, contract)
                if contract_score is not None and contract_score > best_score:
                    best_score = contract_score
                    best_action = Action(ActionType.CONTRACT, contract_card=i, contract_idx=ci)

    return best_action


greedy_strategy.pool_swap = _greedy_pool_swap


# --- Scoring helpers ---

def _score_build_value(cards, state: GameState, player: Player) -> float:
    """Value of rates gained from building these cards."""
    value = 0.0
    for card in cards:
        for ra in card.rates:
            price = state.market.price(ra.resource)
            if ra.amount > 0:
                value += _rate_value(ra.resource, price) * ra.amount
            else:
                value -= _rate_value(ra.resource, price) * abs(ra.amount)
    return value


def _rate_value(resource: Resource, market_price: int) -> float:
    """Estimate ongoing value of +1 rate."""
    return market_price * 3


def _score_sell(state: GameState, player: Player, card) -> float:
    """Score a sell action: revenue from best sellable resource (all units at current price)."""
    best = 0.0
    for sell_res in card.can_sell:
        rate = max(0, player.rate(sell_res))
        if rate > 0:
            revenue = state.market.price(sell_res) * rate
            best = max(best, revenue)
    return best


def _score_contract(state: GameState, player: Player, contract) -> float | None:
    """Score a contract: reward minus opportunity cost of rates spent (sell value)."""
    for req in contract.requirements:
        if player.rate(req.resource) < req.amount:
            return None

    opportunity_cost = 0.0
    for req in contract.requirements:
        sell_value = state.market.price(req.resource) * SELL_VALUE_MULTIPLIER
        opportunity_cost += sell_value * req.amount

    return contract.reward - opportunity_cost


# --- Time-dependent rate valuation ---


def _best_contract_value_per_unit(resource: Resource, state: GameState) -> float:
    """For each contract in the pool that uses this resource,
    compute $/unit. Return the best (highest) value per unit.

    Example: "3 FOOD" contract → $50/3 = $16.67/FOOD unit.
    """
    best = 0.0
    for contract in state.available_contracts:
        total_units = sum(req.amount for req in contract.requirements)
        if total_units == 0:
            continue
        uses_resource = any(req.resource == resource for req in contract.requirements)
        if uses_resource:
            value_per_unit = contract.reward / total_units
            best = max(best, value_per_unit)
    return best


def _expected_pwr_price(state: GameState) -> float:
    """Estimate average PWR price across remaining power bills.

    Each PWR_ADJUST event shifts the market by the active player's PWR rate
    (positive rate shifts market DOWN like selling, negative shifts UP).
    We approximate the expected market trajectory by using the AVERAGE
    PWR rate across all players (since we don't know which player will
    be active when each adjust fires).

    Returns the avg between current PWR price and the projected future price.
    """
    from my_project.simulation import PRICE_TRACK

    remaining = state.remaining_events()
    num_adjusts = remaining.get(EventType.PWR_ADJUST, 0)
    # END_GAME also fires a power bill
    num_bills = remaining.get(EventType.POWER_BILL, 0) + remaining.get(EventType.END_GAME, 0)

    if num_bills == 0 or not state.players:
        return float(state.market.price(Resource.PWR))

    # Average PWR rate across all players
    avg_pwr_rate = sum(p.rate(Resource.PWR) for p in state.players) / len(state.players)

    # Total expected market shift over remaining adjusts
    # Positive avg rate pushes market DOWN (each adjust shifts -rate positions)
    expected_shift = -avg_pwr_rate * num_adjusts

    current_pos = state.market.positions[Resource.PWR]
    projected_pos = max(0, min(current_pos + expected_shift, len(PRICE_TRACK) - 1))

    # Average between current and projected position (linear trajectory)
    avg_pos = (current_pos + projected_pos) / 2
    avg_pos_idx = max(0, min(int(round(avg_pos)), len(PRICE_TRACK) - 1))
    return float(PRICE_TRACK[avg_pos_idx])


def _positive_rate_value(resource: Resource, state: GameState) -> float:
    """Value of +1 positive rate.

    - PWR: earns at every power bill. Uses expected avg PWR price
      (accounts for market drift from PWR_ADJUST events).
    - Other: max of sell value × multiplier OR best contract value per unit.
    """
    if resource == Resource.PWR:
        remaining = state.remaining_events()
        # END_GAME also fires a power bill
        collections = remaining.get(EventType.POWER_BILL, 0) + remaining.get(EventType.END_GAME, 0)
        avg_price = _expected_pwr_price(state)
        return avg_price * collections

    price = state.market.price(resource)
    sell_value = price * SELL_VALUE_MULTIPLIER
    contract_value = _best_contract_value_per_unit(resource, state)
    return max(sell_value, contract_value)


def _negative_rate_cost(resource: Resource, state: GameState) -> float:
    """Cost of -1 negative rate.

    - PWR: charged at every power bill at expected avg price.
    - Other: charged at every futures settlement at current price.
    """
    remaining = state.remaining_events()
    if resource == Resource.PWR:
        collections = remaining.get(EventType.POWER_BILL, 0) + remaining.get(EventType.END_GAME, 0)
        avg_price = _expected_pwr_price(state)
        return avg_price * collections

    price = state.market.price(resource)
    # END_GAME also fires a futures settlement
    collections = remaining.get(EventType.FUTURES_SETTLEMENT, 0) + remaining.get(EventType.END_GAME, 0)
    return price * collections


def _smart_score_build_value(cards, state: GameState, player: Player) -> float:
    """Value of rates gained from building these cards.

    Positive rates valued by sell/power-bill potential.
    Negative rates valued by settlement/power-bill cost.
    """
    value = 0.0
    for card in cards:
        for ra in card.rates:
            if ra.amount > 0:
                value += _positive_rate_value(ra.resource, state) * ra.amount
            else:
                value -= _negative_rate_cost(ra.resource, state) * abs(ra.amount)
    return value


def _smart_score_contract(state: GameState, player: Player, contract) -> float | None:
    """Score contract: reward minus opportunity cost of rates spent.

    Opportunity cost = what you'd otherwise get from selling those rates,
    NOT the contract value (which would double-count).
    """
    for req in contract.requirements:
        if player.rate(req.resource) < req.amount:
            return None

    opportunity_cost = 0.0
    for req in contract.requirements:
        # If you don't fulfill this contract, you'd sell the rates instead
        sell_value = state.market.price(req.resource) * SELL_VALUE_MULTIPLIER
        opportunity_cost += sell_value * req.amount

    return contract.reward - opportunity_cost


def _smart_score_card(card, player: Player, state: GameState) -> float:
    """Score a card for pool swap using time-dependent values."""
    build_value = 0.0
    for ra in card.rates:
        if ra.amount > 0:
            build_value += _positive_rate_value(ra.resource, state) * ra.amount
        else:
            build_value -= _negative_rate_cost(ra.resource, state) * abs(ra.amount)

    build_cost = 0.0
    for ra in card.costs:
        have = max(0, player.rate(ra.resource))
        deficit = max(0, ra.amount - have)
        if deficit > 0:
            build_cost += state.market.estimate_buy_cost(ra.resource, deficit)

    sell_value = 0.0
    if card.can_sell:
        for sell_res in card.can_sell:
            rate = max(0, player.rate(sell_res))
            if rate > 0:
                sell_value = max(sell_value, rate * state.market.price(sell_res))

    # Contract card value = best contract we could fulfill with current rates
    contract_value = 0.0
    if card.can_fulfill_contract:
        for contract in state.available_contracts:
            can_afford = all(
                player.rate(req.resource) >= req.amount for req in contract.requirements
            )
            if can_afford:
                score = _smart_score_contract(state, player, contract)
                if score is not None:
                    contract_value = max(contract_value, score)

    return max(build_value - build_cost, sell_value, contract_value)


def _smart_pool_swap(state: GameState, player: Player) -> None:
    """Pool swap using time-dependent card scoring."""
    if not state.pool:
        return
    for _ in range(len(player.hand)):
        best_swap = None
        best_gain = 0.0
        for hi, hand_card in enumerate(player.hand):
            hand_score = _smart_score_card(hand_card, player, state)
            for pi, pool_card in enumerate(state.pool):
                pool_score = _smart_score_card(pool_card, player, state)
                gain = pool_score - hand_score
                if gain > best_gain:
                    best_gain = gain
                    best_swap = (hi, pi)
        if best_swap:
            swap_pool_card(state, player, best_swap[0], best_swap[1])
        else:
            break


def smart_greedy_strategy(state: GameState, player: Player) -> Action:
    """Like greedy, but values rates based on remaining events.

    Early game: negative rates are expensive (many bills/settlements ahead).
    Late game: negative rates are cheap (few collections left).
    """
    if not player.hand:
        return Action(ActionType.PASS)

    best_score = -999.0
    best_action = Action(ActionType.PASS)
    hand_indices = list(range(len(player.hand)))

    # Score build options
    for size in range(1, len(player.hand) + 1):
        for build_combo in combinations(hand_indices, size):
            build_list = list(build_combo)
            remaining = [i for i in hand_indices if i not in build_combo]
            cards = [player.hand[i] for i in build_list]

            best_for_combo = None
            for num_disc in range(len(remaining) + 1):
                discard_list = remaining[:num_disc]
                result = compute_build_deficit(cards, player, num_disc, state.market)
                if result is None:
                    continue

                _, estimated_cost = result
                value = _smart_score_build_value(cards, state, player)
                score = value - estimated_cost

                if best_for_combo is None or score > best_for_combo[0]:
                    best_for_combo = (score, build_list, list(discard_list))

            if best_for_combo is not None:
                score, bl, dl = best_for_combo
                if score > best_score:
                    best_score = score
                    best_action = Action(ActionType.BUILD, build_cards=bl, discard_cards=dl)

    # Score sell options
    for i, card in enumerate(player.hand):
        if card.can_sell:
            sell_score = _score_sell(state, player, card)
            if sell_score > best_score:
                best_score = sell_score
                best_action = Action(ActionType.SELL, sell_card=i)

    # Score contract options
    for i, card in enumerate(player.hand):
        if card.can_fulfill_contract:
            for ci, contract in enumerate(state.available_contracts):
                contract_score = _smart_score_contract(state, player, contract)
                if contract_score is not None and contract_score > best_score:
                    best_score = contract_score
                    best_action = Action(ActionType.CONTRACT, contract_card=i, contract_idx=ci)

    return best_action


smart_greedy_strategy.pool_swap = _smart_pool_swap
