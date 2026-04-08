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


# --- Pool Swapping ---

def _score_card(card, player: Player, market) -> float:
    """Rough score of how valuable a card is to this player."""
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

    # Contract value
    contract_value = 0.0
    if card.can_fulfill_contract:
        contract_value = 10.0  # base value of having a contract card

    return max(build_value - build_cost, sell_value, contract_value)


def _greedy_pool_swap(state: GameState, player: Player) -> None:
    """Swap hand cards with pool cards if pool has better options."""
    if not state.pool:
        return

    for _ in range(len(player.hand)):  # max swaps = hand size
        best_swap = None
        best_gain = 0.0

        for hi, hand_card in enumerate(player.hand):
            hand_score = _score_card(hand_card, player, state.market)
            for pi, pool_card in enumerate(state.pool):
                pool_score = _score_card(pool_card, player, state.market)
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
    """Score a sell action: revenue from best sellable resource."""
    from my_project.simulation import PRICE_TRACK
    best = 0.0
    for sell_res in card.can_sell:
        rate = max(0, player.rate(sell_res))
        if rate > 0:
            revenue = 0
            pos = state.market.positions[sell_res]
            for _ in range(rate):
                p = max(0, min(pos, len(PRICE_TRACK) - 1))
                revenue += PRICE_TRACK[p]
                pos = max(pos - 1, 0)
            best = max(best, revenue)
    return best


def _score_contract(state: GameState, player: Player, contract) -> float | None:
    """Score a contract: $50 reward minus value of rates permanently spent."""
    for req in contract.requirements:
        if player.rate(req.resource) < req.amount:
            return None

    rates_lost_value = 0.0
    for req in contract.requirements:
        price = state.market.price(req.resource)
        rates_lost_value += _rate_value(req.resource, price) * req.amount

    return contract.reward - rates_lost_value


# --- Time-dependent rate valuation ---

def _time_dependent_rate_value(
    resource: Resource,
    state: GameState,
) -> float:
    """Value of +1 rate based on remaining events that will 'collect' on it.

    PWR: valued by remaining power bills (+ end-game power bill equivalent)
    Other resources: valued by remaining futures settlements (+ end-game settlement)
    """
    remaining = state.remaining_events()
    price = state.market.price(resource)

    if resource == Resource.PWR:
        # Power bills pay rate × price. +1 for mandatory end-game power bill
        collections = remaining.get(EventType.POWER_BILL, 0) + 1
        return price * collections
    else:
        # Futures settlements charge for negative rates at market price
        # +1 for mandatory end-game futures settlement
        collections = remaining.get(EventType.FUTURES_SETTLEMENT, 0) + 1
        return price * collections


def _smart_score_build_value(cards, state: GameState, player: Player) -> float:
    """Value of rates gained, using time-dependent valuation."""
    value = 0.0
    for card in cards:
        for ra in card.rates:
            rv = _time_dependent_rate_value(ra.resource, state)
            if ra.amount > 0:
                value += rv * ra.amount
            else:
                value -= rv * abs(ra.amount)
    return value


def _smart_score_contract(state: GameState, player: Player, contract) -> float | None:
    """Score contract using time-dependent rate values."""
    for req in contract.requirements:
        if player.rate(req.resource) < req.amount:
            return None

    rates_lost_value = 0.0
    for req in contract.requirements:
        rv = _time_dependent_rate_value(req.resource, state)
        rates_lost_value += rv * req.amount

    return contract.reward - rates_lost_value


def _smart_score_card(card, player: Player, state: GameState) -> float:
    """Score a card for pool swap using time-dependent values."""
    build_value = 0.0
    for ra in card.rates:
        rv = _time_dependent_rate_value(ra.resource, state)
        if ra.amount > 0:
            build_value += rv * ra.amount
        else:
            build_value -= rv * abs(ra.amount)

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

    contract_value = 10.0 if card.can_fulfill_contract else 0.0

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
