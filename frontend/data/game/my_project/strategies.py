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
    _count_buildings,
    compute_build_deficit,
    effective_contract_requirements,
    swap_pool_card,
)



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
        # AI considers contracts both with and without the Space Elevator
        # discount when valuing pool-swap candidates.
        se_available = (
            _count_buildings(player, "Space Elevator") > 0
            and not player.has_used_space_elevator_this_turn
        )
        for contract in state.available_contracts:
            effective = effective_contract_requirements(
                player, contract, apply_elevator=se_available
            )
            can_afford = all(
                req.amount == 0 or player.rate(req.resource) >= req.amount
                for req in effective
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
    """Pick a random legal action. Always acts if any legal move exists.

    Action-points rule: builds/sells/non-LP contracts each cost 1 AP. With
    AP=0 the only legal proposals are free actions — Launch Pad contracts
    are the only one this strategy knows about. Other free actions
    (active patents, Optimization Center) are human-only — see
    context/AI-CARD-GAPS.md.

    Note: an empty hand is NOT a reason to pass — a free Launch Pad
    contract is still legal. The action loop in run_turn / step_ai_turn
    likewise no longer gates on hand size; it just iterates until this
    function returns PASS.
    """
    has_cards = player.cards_remaining() >= 1
    options: list[Action] = []

    # Build: each card costs 1 AP, so requires has_cards. Random only proposes
    # single-card builds.
    cr = player.cards_remaining()
    if has_cards and not player.has_built_this_turn:
        for i, card in enumerate(player.hand):
            result = compute_build_deficit([card], player, state.market)
            if result is not None:
                options.append(Action(ActionType.BUILD, build_cards=[i]))

    # Sell: requires 1 AP per sell.
    has_hacker = _count_buildings(player, "Hacker Array") > 0
    if has_cards:
        for i, card in enumerate(player.hand):
            if card.can_sell:
                for sell_res in card.can_sell:
                    if player.rate(sell_res) > 0:
                        action = Action(ActionType.SELL, sell_card=i)
                        if has_hacker:
                            ht, hd = _pick_hacker_target(state, player, sell_res)
                            action.hacker_target = ht
                            action.hacker_direction = hd
                        options.append(action)
                        break

    # Contract enumeration: hand-card and SE paths cost 1 AP. Launch Pad is
    # FREE, so it's enumerated regardless of AP.
    se_available = (
        _count_buildings(player, "Space Elevator") > 0
        and not player.has_used_space_elevator_this_turn
    )
    lp_available = (
        _count_buildings(player, "Launch Pad") > 0
        and not player.has_used_launch_pad_this_turn
    )
    for ci, contract in enumerate(state.available_contracts):
        # Reqs without elevator
        plain_reqs = effective_contract_requirements(player, contract, apply_elevator=False)
        plain_affordable = all(
            player.rate(req.resource) >= req.amount for req in plain_reqs
        )
        # Reqs with elevator
        if se_available:
            disc_reqs = effective_contract_requirements(player, contract, apply_elevator=True)
            disc_affordable = all(
                req.amount == 0 or player.rate(req.resource) >= req.amount for req in disc_reqs
            )
        else:
            disc_affordable = False

        # Real contract-icon hand cards (cost 1 AP)
        if has_cards:
            for i, card in enumerate(player.hand):
                if not card.can_fulfill_contract:
                    continue
                if disc_affordable:
                    options.append(Action(
                        ActionType.CONTRACT, contract_card=i, contract_idx=ci, use_elevator=True
                    ))
                elif plain_affordable:
                    options.append(Action(
                        ActionType.CONTRACT, contract_card=i, contract_idx=ci
                    ))
        # Launch Pad: FREE — always enumerate when available, even at AP=0.
        if lp_available:
            if disc_affordable:
                options.append(Action(
                    ActionType.CONTRACT, contract_card=-1, contract_idx=ci,
                    use_launch_pad=True, use_elevator=True,
                ))
            elif plain_affordable:
                options.append(Action(
                    ActionType.CONTRACT, contract_card=-1, contract_idx=ci,
                    use_launch_pad=True,
                ))

    if not options:
        # No legal proposal. The "discard via sell" cycle hack only works if
        # we have AP — without it the sell would just be rejected and we'd
        # infinite-loop. With AP=0 just pass.
        if has_cards:
            non_contract = [i for i, c in enumerate(player.hand) if not c.can_fulfill_contract]
            if non_contract:
                return Action(ActionType.SELL, sell_card=random.choice(non_contract))
        return Action(ActionType.PASS)

    return random.choice(options)


random_strategy.pool_swap = _random_pool_swap


def greedy_strategy(state: GameState, player: Player) -> Action:
    """Pick the highest-value action. Called repeatedly until pass.

    Each call evaluates the current hand state and picks the single best action.
    Multi-card builds are considered, capped at min(2, action_points) cards.

    Action-points rule: builds/sells/non-LP contracts cost 1 AP each. With
    AP=0 the strategy returns PASS — note that this strategy does NOT
    enumerate the Launch Pad path, so it can't take a "free" contract on
    a 0-AP turn even if the player owns one. See context/AI-CARD-GAPS.md.
    """
    has_cards = player.cards_remaining() >= 1
    best_score = -999.0
    best_action = Action(ActionType.PASS)
    hand_indices = list(range(len(player.hand)))

    # Score build options (subsets of current hand, capped at 2 cards AND
    # at the player's remaining action points).
    # Rule: only one build action per turn. Skip entirely if already built.
    cr = player.cards_remaining()
    if has_cards and not player.has_built_this_turn:
        max_build_size = min(cr, len(player.hand))
        for size in range(1, max_build_size + 1):
            for build_combo in combinations(hand_indices, size):
                build_list = list(build_combo)
                cards = [player.hand[i] for i in build_list]

                result = compute_build_deficit(cards, player, state.market)
                if result is None:
                    continue

                _, estimated_cost = result
                value = _score_build_value(cards, state, player)
                score = value - estimated_cost

                if score > best_score:
                    best_score = score
                    best_action = Action(ActionType.BUILD, build_cards=build_list)

    # Score sell options (spends 1 card each)
    if has_cards:
        for i, card in enumerate(player.hand):
            if card.can_sell:
                sell_score = _score_sell(state, player, card)
                if sell_score > best_score:
                    best_score = sell_score
                    best_action = Action(ActionType.SELL, sell_card=i)

    # Score contract options. Hand-card path (spends 1 card) and Launch Pad
    # fallback (FREE — 0 cards).
    lp_available = (
        _count_buildings(player, "Launch Pad") > 0
        and not player.has_used_launch_pad_this_turn
    )
    for ci, contract in enumerate(state.available_contracts):
        contract_score = _score_contract(state, player, contract)
        if contract_score is None or contract_score <= best_score:
            continue
        # Try hand-card path first (costs 1 card)
        chosen = None
        if has_cards:
            for i, card in enumerate(player.hand):
                if card.can_fulfill_contract:
                    chosen = Action(
                        ActionType.CONTRACT, contract_card=i, contract_idx=ci,
                    )
                    break
        # Fall back to Launch Pad (FREE)
        if chosen is None and lp_available:
            chosen = Action(
                ActionType.CONTRACT, contract_card=-1, contract_idx=ci,
                use_launch_pad=True,
            )
        if chosen is not None:
            best_score = contract_score
            best_action = chosen

    return best_action


greedy_strategy.pool_swap = _greedy_pool_swap


# --- Scoring helpers ---

# Lazily loaded empirical card values from CardValues.csv (generated by
# the evaluate-cards command). Falls back to 0 if the file doesn't exist.
_learned_card_values: dict[str, float] | None = None


def _get_learned_card_values() -> dict[str, float]:
    """Load empirical card values from CardValues.csv (cached)."""
    global _learned_card_values
    if _learned_card_values is None:
        from my_project.parsing import parse_card_values
        from pathlib import Path
        path = Path(__file__).parent / "data" / "CardValues.csv"
        _learned_card_values = parse_card_values(path)
    return _learned_card_values


# Full lookup table with timing bonuses (cached separately)
_card_values_full: dict[str, dict] | None = None


def _get_card_values_full() -> dict[str, dict]:
    """Load the full card value table with timing bonuses (cached)."""
    global _card_values_full
    if _card_values_full is None:
        from my_project.parsing import parse_card_values_full
        from pathlib import Path
        path = Path(__file__).parent / "data" / "CardValues.csv"
        _card_values_full = parse_card_values_full(path)
    return _card_values_full


def card_value_now(card_name: str, state: GameState) -> float:
    """Look up the time-adjusted value of a card at the current game state.

    Returns the regression coefficient for the current game phase
    (early/mid/late). Each coefficient is the direct value of
    acquiring this card at that phase — no base + bonus split.
    """
    table = _get_card_values_full()
    entry = table.get(card_name)
    if entry is None:
        return 0.0

    # Determine game phase from event deck progress
    total = len(state.event_deck)
    consumed = state.event_idx
    if total <= 0:
        progress = 1.0
    else:
        progress = consumed / total  # 0.0 = start, 1.0 = end

    if progress < 0.33:
        return entry.get("early", 0.0)
    elif progress < 0.67:
        return entry.get("mid", 0.0)
    else:
        return entry.get("late", 0.0)


def _pick_hacker_target(
    state: GameState, player: Player, sold_resource: Resource,
) -> tuple[str, int]:
    """Pick the best Hacker Array target and direction for a sell action.

    Strategy:
    1. If the player has a positive rate they plan to sell later, raise
       that resource's price (+3) to increase future sell revenue.
    2. If the player has a negative non-PWR rate (futures exposure),
       lower that resource's price (-3) to reduce settlement debt.
    3. Fallback: raise the resource the player produces most of.

    Returns (target_resource_value, direction) e.g. ("GLS", 1) or ("FE", -1).
    """
    candidates = [
        r for r in Resource
        if r != Resource.PWR and r != sold_resource
    ]
    if not candidates:
        return ("", 0)

    # Option A: raise a resource we produce a lot of (future sell value)
    best_raise = None
    best_raise_score = 0
    for r in candidates:
        rate = player.rate(r)
        if rate > 0:
            # Score: how much we'd gain from +3 price on this resource
            score = rate * 3  # rate × price_delta
            if score > best_raise_score:
                best_raise_score = score
                best_raise = r

    # Option B: lower a resource we're negative on (reduce futures debt)
    best_lower = None
    best_lower_score = 0
    for r in candidates:
        rate = player.rate(r)
        if rate < 0:
            # Score: how much debt we'd avoid from -3 price on this resource
            score = abs(rate) * 3
            if score > best_lower_score:
                best_lower_score = score
                best_lower = r

    # Pick whichever saves/earns more
    if best_lower_score > best_raise_score and best_lower is not None:
        return (best_lower.value, -1)
    elif best_raise is not None:
        return (best_raise.value, 1)
    else:
        # Fallback: raise the most expensive resource we don't sell
        target = max(candidates, key=lambda r: state.market.price(r))
        return (target.value, 1)


def _mechanical_building_value(card: Card, state: GameState, player: Player) -> float:
    """Compute the value of a special building's effect using the same
    unified rate valuation as the rest of the AI.

    Each building's effect is translated into rate-equivalent terms
    using _rate_ongoing_value, contract proximity, and sell income.
    """
    from my_project.simulation import (
        EventType, PLEASURE_DOME_TIERS, CONTRACT_REWARD,
        _count_buildings, _rate_ongoing_value,
    )
    name = card.building
    remaining = state.remaining_events()

    if name == "Pleasure Dome":
        # Earns a bonus at each power bill. Passive — no card/AP cost.
        bills_left = (
            remaining.get(EventType.POWER_BILL, 0)
            + remaining.get(EventType.END_ROUND, 0)
            + remaining.get(EventType.END_GAME, 0)
        )
        dome_bonus = PLEASURE_DOME_TIERS[0] if PLEASURE_DOME_TIERS else 20
        return dome_bonus * bills_left

    if name == "Optimization Center":
        # Free action: -1 PWR, +1 best positive non-PWR rate each turn.
        # Value = ongoing value of the best conversion target minus PWR cost.
        # Fires each turn, so multiply by remaining player turns.
        total_events = sum(remaining.values())
        player_turns = total_events / max(len(state.players), 1)
        # Estimate conversion value: best non-PWR rate - PWR rate
        pwr_val = _rate_ongoing_value(Resource.PWR, state, player)
        candidates = [
            r for r in Resource
            if r != Resource.PWR and player.rate(r) > 0
        ]
        if candidates and player_turns > 0:
            best_gain = max(
                _rate_ongoing_value(r, state, player) for r in candidates
            )
            per_fire = max(0, best_gain - pwr_val)
            # Diminishing: each fire shifts rates, reducing future value.
            # Use sqrt(turns) as a rough diminishing factor.
            import math
            return per_fire * math.sqrt(player_turns)
        return 0.0

    if name == "Launch Pad":
        # Free contract fulfillment once per turn (no card cost).
        # Value = best contract proximity bonus × remaining turns.
        # LP makes contracts free, so the value is the contract reward
        # minus the rate opportunity cost (which _smart_score_contract handles).
        total_events = sum(remaining.values())
        player_turns = total_events / max(len(state.players), 1)
        best_contract_val = 0.0
        for contract in state.available_contracts:
            sc = _smart_score_contract(state, player, contract)
            if sc is not None and sc > best_contract_val:
                best_contract_val = sc
        # LP lets you fulfill without spending a card — the card savings
        # is worth roughly one sell action's revenue.
        if best_contract_val > 0:
            return best_contract_val
        # Even if no contract is affordable now, LP has future value
        # from contract proximity — estimate from best proximity bonus.
        best_prox = max(
            (_contract_proximity_bonus(r, state, player) for r in Resource),
            default=0,
        )
        return best_prox * player_turns * 0.5

    if name == "Space Elevator":
        # Reduces one contract requirement by 1 unit. This means:
        # 1. You need 1 less rate to fulfill the contract (lower barrier)
        # 2. You keep that 1 rate for selling instead of losing it
        # The savings = ongoing value of the 1 rate you DON'T consume.
        # SE picks the most expensive requirement to discount.
        best_savings = 0.0
        for contract in state.available_contracts:
            if not contract.requirements:
                continue
            # Value of keeping the most expensive rate unit
            max_req_val = max(
                _rate_ongoing_value(req.resource, state, player)
                for req in contract.requirements
            )
            best_savings = max(best_savings, max_req_val)
        # Also consider: SE makes contracts 1 unit easier to achieve,
        # which increases contract proximity for near-miss contracts.
        proximity_boost = 0.0
        for contract in state.available_contracts:
            total_deficit = sum(
                max(0, req.amount - player.rate(req.resource))
                for req in contract.requirements
            )
            # SE turns a 1-unit deficit into affordable
            if total_deficit == 1:
                proximity_boost = max(proximity_boost, float(contract.reward))
        return max(best_savings, proximity_boost)

    if name == "Patent Office":
        # Draw 2 patents, keep the better one. Value = expected value
        # of the best-of-2 from available patents using learned values.
        patent_vals = sorted(
            [max(0, card_value_now(n, state)) for n in (
                "Superconductors", "Energy Vault", "Financial Instruments",
                "Water Engine", "Nanotechnology", "Cold Fusion", "Virtual Reality",
                "Perpetual Motion", "Carbon Scrubbing", "Slant Drilling",
                "Thinking Machines", "Teleportation",
            )],
            reverse=True,
        )
        # Best-of-2 from the pool ≈ top-third average
        top_third = patent_vals[: max(len(patent_vals) // 3, 1)]
        return sum(top_third) / max(len(top_third), 1)

    if name == "Hacker Array":
        # Shifts market ±3 positions on each sell. Two sources of value:
        # 1. Raise price of a resource you sell → extra revenue per sell
        # 2. Lower price of a negative rate → reduced futures debt
        from my_project.simulation import (
            PRICE_TRACK, _expected_sell_events, _sell_rank_discount,
        )
        total_events = sum(remaining.values())
        player_turns = total_events / max(len(state.players), 1)

        # --- Sell boost: value of +3 price shift on sellable resources ---
        # HA is strongest when the player has 2+ good sellable rates,
        # because it can raise the price of whichever is being sold.
        sellable = sorted(
            [(r, player.rate(r) * state.market.price(r))
             for r in Resource if r != Resource.PWR and player.rate(r) > 0],
            key=lambda x: -x[1],
        )
        sell_boost = 0.0
        for rank, (r, revenue) in enumerate(sellable[:2]):  # top 2 sell options
            # Price gain from +3 positions
            cur_pos = state.market.positions[r]
            boosted_pos = min(cur_pos + 3, len(PRICE_TRACK) - 1)
            price_gain = PRICE_TRACK[boosted_pos] - PRICE_TRACK[cur_pos]
            # Expected sells for this resource
            sell_events = _expected_sell_events(r, state, player)
            discount = _sell_rank_discount(r, state, player)
            sell_boost += price_gain * player.rate(r) * sell_events * discount

        # --- Futures relief: value of -3 price shift on negative rates ---
        futures_relief = 0.0
        end_events = (
            remaining.get(EventType.END_ROUND, 0)
            + remaining.get(EventType.END_GAME, 0)
        )
        settlements = remaining.get(EventType.FUTURES_SETTLEMENT, 0) + end_events
        for r in Resource:
            if r == Resource.PWR or player.rate(r) >= 0:
                continue
            cur_pos = state.market.positions[r]
            lowered_pos = max(cur_pos - 3, 0)
            price_saved = PRICE_TRACK[cur_pos] - PRICE_TRACK[lowered_pos]
            futures_relief += price_saved * abs(player.rate(r)) * settlements

        return sell_boost + futures_relief

    if name == "Virtual Reality":
        # Doubles Pleasure Dome bonus. Value = PD's ongoing value
        # (what PD would earn over remaining power bills).
        # Worth the same whether the player already has PD or might build it.
        bills_left = (
            remaining.get(EventType.POWER_BILL, 0)
            + remaining.get(EventType.END_ROUND, 0)
            + remaining.get(EventType.END_GAME, 0)
        )
        dome_bonus = PLEASURE_DOME_TIERS[0] if PLEASURE_DOME_TIERS else 20
        return dome_bonus * bills_left

    return 0.0


# Exploration mode: when set to a dict, _special_building_value returns
# the pre-rolled value for each building. Set per-game by card_valuation.py.
# Dict maps building name → forced value. None = normal mode.
_exploration_overrides: dict[str, float] | None = None


def _special_building_value(card: Card, state: GameState, player: Player) -> float:
    """Estimate the value of a special building or patent's effect.

    In exploration mode: returns a per-game pre-rolled value (stable
    within a game so the AI plays coherently, varied across games
    for timing diversity in the regression).

    In normal mode: uses MAX of mechanical floor and time-adjusted
    learned value from CardValues.csv.
    """
    if not card.effect:
        return 0.0

    if _exploration_overrides and card.building in _exploration_overrides:
        return _exploration_overrides[card.building]

    mechanical = _mechanical_building_value(card, state, player)
    learned = card_value_now(card.building, state)
    return max(mechanical, learned)


def _apply_hooks_to_copy(cards: list[Card], player: Player, state: GameState) -> list[Card]:
    """Apply patent build hooks to deep copies of cards, returning the
    modified versions. This lets the AI score cards as they would ACTUALLY
    be after hooks fire (e.g. Perpetual Motion strips -PWR, Superconductors
    adds +1 PWR)."""
    from my_project.simulation import PATENT_BUILD_HOOKS, _player_patent_names
    patent_names = _player_patent_names(player)
    if not any(name in PATENT_BUILD_HOOKS for name in patent_names):
        return cards  # no hooks — skip the copy
    import copy
    result = []
    for card in cards:
        c = copy.deepcopy(card)
        for name in patent_names:
            hook = PATENT_BUILD_HOOKS.get(name)
            if hook:
                hook(state, player, c)
        result.append(c)
    return result


def _score_build_value(cards, state: GameState, player: Player) -> float:
    """Value of rates gained from building these cards.

    Applies patent build hooks to copies of the cards so the score
    reflects the ACTUAL rates after hooks fire (e.g. Perpetual Motion
    strips -PWR, Superconductors adds +1 PWR).

    Uses unified _rate_ongoing_value for both positive rates (sell income +
    patent synergies + contract bonus) and negative rates (futures cost).
    """
    from my_project.simulation import _rate_ongoing_value

    hooked_cards = _apply_hooks_to_copy(cards, player, state)
    value = 0.0
    for card in hooked_cards:
        for ra in card.rates:
            if ra.amount > 0:
                value += _rate_ongoing_value(ra.resource, state, player) * ra.amount
            else:
                value -= _rate_ongoing_value(ra.resource, state, player) * abs(ra.amount)
        value += _special_building_value(card, state, player)
    return value


def _contract_proximity_bonus(
    resource: Resource, state: GameState, player: Player,
) -> float:
    """Bonus value for +1 rate that moves the player closer to a contract.

    For each available contract, computes the rate deficit (how many
    units the player is short). If this resource reduces the deficit,
    the bonus is: contract_reward × (1 / deficit) × time_discount.

    Closer contracts → higher bonus. Less time remaining → lower bonus.
    Returns the best bonus across all available contracts.
    """
    remaining = state.remaining_events()
    total_events = sum(remaining.values())
    player_turns = total_events / max(len(state.players), 1)

    best_bonus = 0.0
    for contract in state.available_contracts:
        # How many total rate units is the player short?
        total_deficit = 0
        resource_helps = False
        for req in contract.requirements:
            shortfall = max(0, req.amount - player.rate(req.resource))
            total_deficit += shortfall
            if req.resource == resource and shortfall > 0:
                resource_helps = True

        if total_deficit == 0 or not resource_helps:
            continue

        # Time discount: need enough turns to close the gap via builds
        time_discount = min(1.0, player_turns / total_deficit)

        bonus = contract.reward * (1.0 / total_deficit) * time_discount
        best_bonus = max(best_bonus, bonus)

    return best_bonus


def _score_sell(state: GameState, player: Player, card) -> float:
    """Score a sell action: immediate cash from selling resources.

    Returns the best revenue from the card's sellable resources
    (rate × market price). Scored independently from building —
    the strategy picks whichever action scores highest.
    """
    best = 0.0
    for sell_res in card.can_sell:
        rate = max(0, player.rate(sell_res))
        if rate > 0:
            revenue = state.market.price(sell_res) * rate
            best = max(best, revenue)
    return best


def _score_contract(state: GameState, player: Player, contract) -> float | None:
    """Score a contract: reward minus ongoing value of rates permanently lost.

    Passes player so the opportunity cost includes lost sell income,
    not just futures settlement cost.
    """
    from my_project.simulation import _rate_ongoing_value

    for req in contract.requirements:
        if player.rate(req.resource) < req.amount:
            return None

    opportunity_cost = sum(
        _rate_ongoing_value(req.resource, state, player) * req.amount
        for req in contract.requirements
    )
    return contract.reward - opportunity_cost



# _positive_rate_value, _negative_rate_cost, _expected_pwr_price, and
# _best_contract_value_per_unit have been replaced by the unified
# _rate_ongoing_value in simulation.py.


def _smart_score_build_value(cards, state: GameState, player: Player) -> float:
    """Value of rates gained from building these cards.

    Applies patent build hooks to copies so the score reflects actual
    rates after hooks (e.g. Perpetual Motion strips -PWR).
    Uses unified rate valuation: sell income for positive, futures for negative.
    """
    from my_project.simulation import _rate_ongoing_value

    hooked_cards = _apply_hooks_to_copy(cards, player, state)
    value = 0.0
    for card in hooked_cards:
        for ra in card.rates:
            if ra.amount > 0:
                value += _rate_ongoing_value(ra.resource, state, player) * ra.amount
            else:
                value -= _rate_ongoing_value(ra.resource, state, player) * abs(ra.amount)
        value += _special_building_value(card, state, player)
    return value


def _smart_score_contract(state: GameState, player: Player, contract) -> float | None:
    """Score contract: reward minus ongoing value of rates permanently lost.

    Passes player so opportunity cost includes lost sell income.
    """
    from my_project.simulation import _rate_ongoing_value

    for req in contract.requirements:
        if player.rate(req.resource) < req.amount:
            return None

    opportunity_cost = sum(
        _rate_ongoing_value(req.resource, state, player) * req.amount
        for req in contract.requirements
    )
    return contract.reward - opportunity_cost


def _smart_score_card(card, player: Player, state: GameState) -> float:
    """Score a card for pool swap using time-dependent values."""
    from my_project.simulation import _rate_ongoing_value

    build_value = 0.0
    for ra in card.rates:
        if ra.amount > 0:
            build_value += _rate_ongoing_value(ra.resource, state, player) * ra.amount
        else:
            build_value -= _rate_ongoing_value(ra.resource, state, player) * abs(ra.amount)

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

    Action-points rule: builds/sells/non-LP contracts cost 1 AP each.
    Launch Pad contracts are FREE — this strategy uses LP as a fallback
    contract path when no contract-icon card is in hand, so even with
    AP=0 (or an empty hand) it can still propose a LP contract.
    """
    has_cards = player.cards_remaining() >= 1
    best_score = -999.0
    best_action = Action(ActionType.PASS)
    hand_indices = list(range(len(player.hand)))

    # Score build options.
    # Rule: only one build action per turn. Skip entirely if already built.
    cr = player.cards_remaining()
    if has_cards and not player.has_built_this_turn:
        max_build_size = min(cr, len(player.hand))
        for size in range(1, max_build_size + 1):
            for build_combo in combinations(hand_indices, size):
                build_list = list(build_combo)
                cards = [player.hand[i] for i in build_list]

                result = compute_build_deficit(cards, player, state.market)
                if result is None:
                    continue

                _, estimated_cost = result
                value = _smart_score_build_value(cards, state, player)
                score = value - estimated_cost

                if score > best_score:
                    best_score = score
                    best_action = Action(ActionType.BUILD, build_cards=build_list)

    # Score sell options (cost 1 AP each). Hacker Array: AI picks the best
    # target strategically — raise a resource we produce, or lower one we owe.
    has_hacker = _count_buildings(player, "Hacker Array") > 0
    if has_cards:
        for i, card in enumerate(player.hand):
            if not card.can_sell:
                continue
            sell_score = _score_sell(state, player, card)
            if sell_score > best_score:
                best_score = sell_score
                action = Action(ActionType.SELL, sell_card=i)
                if has_hacker:
                    sold = max(
                        (r for r in card.can_sell if player.rate(r) > 0),
                        key=lambda r: state.market.price(r) * player.rate(r),
                        default=None,
                    )
                    if sold is not None:
                        ht, hd = _pick_hacker_target(state, player, sold)
                        action.hacker_target = ht
                        action.hacker_direction = hd
                best_action = action

    # Score contract options. AI uses Space Elevator and Launch Pad whenever
    # they're available.
    se_available = (
        _count_buildings(player, "Space Elevator") > 0
        and not player.has_used_space_elevator_this_turn
    )
    lp_available = (
        _count_buildings(player, "Launch Pad") > 0
        and not player.has_used_launch_pad_this_turn
    )
    for ci, contract in enumerate(state.available_contracts):
        # Affordability with elevator
        if se_available:
            disc_reqs = effective_contract_requirements(player, contract, apply_elevator=True)
            disc_affordable = all(
                req.amount == 0 or player.rate(req.resource) >= req.amount for req in disc_reqs
            )
        else:
            disc_affordable = False
        plain_affordable = all(
            player.rate(req.resource) >= req.amount for req in contract.requirements
        )

        contract_score = _smart_score_contract(state, player, contract)
        if contract_score is None and not disc_affordable:
            continue
        if contract_score is None:
            # Affordable only with elevator — re-score using effective reqs
            from my_project.simulation import _rate_ongoing_value
            opportunity_cost = sum(
                _rate_ongoing_value(req.resource, state, player) * req.amount
                for req in disc_reqs
            )
            contract_score = contract.reward - opportunity_cost
        if contract_score <= best_score:
            continue

        use_elev = disc_affordable  # use it whenever it's needed/available
        # Try a contract-icon hand card first (spends 1 card — only if has_cards)
        chosen = None
        if has_cards:
            for i, card in enumerate(player.hand):
                if card.can_fulfill_contract:
                    chosen = Action(
                        ActionType.CONTRACT,
                        contract_card=i,
                        contract_idx=ci,
                        use_elevator=use_elev and se_available,
                    )
                    break
        # Fall back to Launch Pad (FREE — works even with 0 cards remaining)
        if chosen is None and lp_available:
            chosen = Action(
                ActionType.CONTRACT,
                contract_card=-1,
                contract_idx=ci,
                use_launch_pad=True,
                use_elevator=use_elev and se_available,
            )
        if chosen is not None and (plain_affordable or disc_affordable):
            best_score = contract_score
            best_action = chosen

    return best_action


smart_greedy_strategy.pool_swap = _smart_pool_swap


# ==========================================================================
# optimal_strategy: unified card scoring + 2-action lookahead
# ==========================================================================


def _card_value(card, player: Player, state: GameState) -> float:
    """Unified value of a card across ALL its possible uses.

    Returns the max of: build value, sell value, contract value, and
    special effect value. This is the card's worth to the player —
    used for pool swaps, Nanotechnology discard decisions, and action
    planning.
    """
    # Apply patent hooks to get the ACTUAL rates post-hooks
    hooked = _apply_hooks_to_copy([card], player, state)
    hcard = hooked[0]

    # Build value: net rate value minus estimated market cost
    from my_project.simulation import _rate_ongoing_value

    build_val = 0.0
    for ra in hcard.rates:
        if ra.amount > 0:
            build_val += _rate_ongoing_value(ra.resource, state, player) * ra.amount
        else:
            build_val -= _rate_ongoing_value(ra.resource, state, player) * abs(ra.amount)
    # Subtract estimated build cost (what we'd need to buy from market)
    for ra in hcard.costs:
        have = max(0, player.rate(ra.resource))
        deficit = max(0, ra.amount - have)
        if deficit > 0:
            build_val -= state.market.estimate_buy_cost(ra.resource, deficit)
    # Add special building / patent effect value
    build_val += _special_building_value(card, state, player)

    # Sell value: immediate cash from best sellable resource
    sell_val = 0.0
    if card.can_sell:
        for r in card.can_sell:
            rate = max(0, player.rate(r))
            if rate > 0:
                sell_val = max(sell_val, state.market.price(r) * rate)

    # Contract value: best contract this card can fulfill
    contract_val = 0.0
    if card.can_fulfill_contract:
        se_avail = (
            _count_buildings(player, "Space Elevator") > 0
            and not player.has_used_space_elevator_this_turn
        )
        for contract in state.available_contracts:
            eff = effective_contract_requirements(
                player, contract, apply_elevator=se_avail
            )
            if all(req.amount == 0 or player.rate(req.resource) >= req.amount for req in eff):
                sc = _smart_score_contract(state, player, contract)
                if sc is not None:
                    contract_val = max(contract_val, sc)

    return max(build_val, sell_val, contract_val)


def _enumerate_actions(
    state: GameState, player: Player,
) -> list[tuple[float, Action]]:
    """Enumerate all legal actions with their scores.

    Returns a list of (score, Action) tuples, sorted by score descending.
    Includes PASS as a 0-score option.
    """
    actions: list[tuple[float, Action]] = [(0.0, Action(ActionType.PASS))]
    hand_indices = list(range(len(player.hand)))
    cr = player.cards_remaining()

    # --- Builds (1-2 cards) ---
    if not player.has_built_this_turn and cr >= 1:
        max_build = min(cr, len(player.hand))
        for size in range(1, max_build + 1):
            for combo in combinations(hand_indices, size):
                build_list = list(combo)
                cards = [player.hand[i] for i in build_list]
                # One-of-each special check
                dominated = False
                for c in cards:
                    if c.effect and _count_buildings(player, c.building) > 0:
                        dominated = True
                if dominated:
                    continue

                result = compute_build_deficit(cards, player, state.market)
                if result is None:
                    continue
                _, cost = result
                value = _smart_score_build_value(cards, state, player)
                score = value - cost
                actions.append((
                    score,
                    Action(ActionType.BUILD, build_cards=build_list),
                ))

    # --- Sells ---
    if cr >= 1:
        has_hacker = _count_buildings(player, "Hacker Array") > 0
        for i, card in enumerate(player.hand):
            if not card.can_sell:
                continue
            sell_sc = _score_sell(state, player, card)
            if sell_sc > 0:
                action = Action(ActionType.SELL, sell_card=i)
                if has_hacker:
                    sold = max(
                        (r for r in card.can_sell if player.rate(r) > 0),
                        key=lambda r: state.market.price(r) * player.rate(r),
                        default=None,
                    )
                    if sold is not None:
                        ht, hd = _pick_hacker_target(state, player, sold)
                        action.hacker_target = ht
                        action.hacker_direction = hd
                actions.append((sell_sc, action))

    # --- Contracts ---
    se_avail = (
        _count_buildings(player, "Space Elevator") > 0
        and not player.has_used_space_elevator_this_turn
    )
    lp_avail = (
        _count_buildings(player, "Launch Pad") > 0
        and not player.has_used_launch_pad_this_turn
    )
    for ci, contract in enumerate(state.available_contracts):
        # Check affordability
        if se_avail:
            disc_reqs = effective_contract_requirements(player, contract, apply_elevator=True)
            disc_ok = all(r.amount == 0 or player.rate(r.resource) >= r.amount for r in disc_reqs)
        else:
            disc_ok = False
        plain_ok = all(
            player.rate(r.resource) >= r.amount for r in contract.requirements
        )
        if not plain_ok and not disc_ok:
            continue

        c_score = _smart_score_contract(state, player, contract)
        if c_score is None:
            if disc_ok:
                from my_project.simulation import _rate_ongoing_value
                opp = sum(
                    _rate_ongoing_value(r.resource, state, player) * r.amount
                    for r in disc_reqs
                )
                c_score = contract.reward - opp
            else:
                continue
        if c_score <= 0:
            continue

        use_elev = disc_ok and se_avail

        # Path A: hand card (1 card spent)
        if cr >= 1:
            for i, card in enumerate(player.hand):
                if card.can_fulfill_contract:
                    actions.append((
                        c_score,
                        Action(ActionType.CONTRACT, contract_card=i,
                               contract_idx=ci, use_elevator=use_elev),
                    ))
                    break  # one card is enough

        # Path B: Launch Pad (free)
        if lp_avail:
            actions.append((
                c_score,
                Action(ActionType.CONTRACT, contract_card=-1,
                       contract_idx=ci, use_launch_pad=True,
                       use_elevator=use_elev),
            ))


    actions.sort(key=lambda x: -x[0])
    return actions


def _actions_compatible(a1: Action, a2: Action) -> bool:
    """Check if two actions can legally happen in the same turn."""
    # Can't build twice
    if a1.action_type == ActionType.BUILD and a2.action_type == ActionType.BUILD:
        return False
    # Can't use Launch Pad twice
    if (a1.action_type == ActionType.CONTRACT and a1.use_launch_pad and
            a2.action_type == ActionType.CONTRACT and a2.use_launch_pad):
        return False
    # PASS is compatible with nothing (it ends the turn)
    if a1.action_type == ActionType.PASS or a2.action_type == ActionType.PASS:
        return False
    return True


def optimal_strategy(state: GameState, player: Player) -> Action:
    """2-action lookahead strategy with unified card scoring.

    Enumerates all legal actions, then for the top candidates, simulates
    executing them and scores the best follow-up action. Returns the
    first action of the best (action1, action2) pair.

    Called repeatedly by the game loop — returns PASS when done.
    """
    if player.cards_remaining() <= 0 and not (
        _count_buildings(player, "Launch Pad") > 0
        and not player.has_used_launch_pad_this_turn
    ):
        return Action(ActionType.PASS)

    actions = _enumerate_actions(state, player)
    if not actions or actions[0][0] <= 0:
        return Action(ActionType.PASS)

    # If only 1 card remaining or already used build, just take the best
    if player.cards_remaining() <= 1 or player.has_built_this_turn:
        return actions[0][1]

    # 2-action lookahead: try top actions as action1, simulate, score action2
    import copy
    best_total = actions[0][0]  # baseline: just take the best single action
    best_action = actions[0][1]

    # Only consider top N candidates for action1 to limit combinatorial cost
    top_n = min(8, len(actions))
    for score1, action1 in actions[:top_n]:
        if action1.action_type == ActionType.PASS:
            continue
        # Simulate action1 on a copy
        try:
            state_copy = copy.deepcopy(state)
            player_idx = state.players.index(player)
            player_copy = state_copy.players[player_idx]

            # Apply action1 flags
            from my_project.simulation import _execute_action
            result = _execute_action(state_copy, player_copy, action1)
            if result is None:
                continue
            if action1.action_type == ActionType.BUILD:
                player_copy.has_built_this_turn = True

            # Now enumerate action2 on the modified state
            actions2 = _enumerate_actions(state_copy, player_copy)
            # Filter for compatible actions
            for score2, action2 in actions2:
                if action2.action_type == ActionType.PASS:
                    # Total = just action1
                    if score1 > best_total:
                        best_total = score1
                        best_action = action1
                    break
                if not _actions_compatible(action1, action2):
                    continue
                total = score1 + score2
                if total > best_total:
                    best_total = total
                    best_action = action1
                break  # only consider the best compatible action2

        except Exception:
            # If simulation fails, fall back to single-action score
            if score1 > best_total:
                best_total = score1
                best_action = action1

    return best_action


def _optimal_pool_swap(state: GameState, player: Player) -> None:
    """Swap hand cards with pool cards to maximize total hand value.

    Uses _card_value to score every card, then greedily swaps the worst
    hand card for the best pool card until no improvement is possible.
    """
    if not state.pool or not player.hand:
        return

    for _ in range(len(player.hand) + len(state.pool)):
        best_swap = None
        best_gain = 0.0

        # Find worst hand card and best pool card
        for hi, hcard in enumerate(player.hand):
            h_val = _card_value(hcard, player, state)
            for pi, pcard in enumerate(state.pool):
                p_val = _card_value(pcard, player, state)
                gain = p_val - h_val
                if gain > best_gain:
                    best_gain = gain
                    best_swap = (hi, pi)

        if best_swap:
            swap_pool_card(state, player, best_swap[0], best_swap[1])
        else:
            break


optimal_strategy.pool_swap = _optimal_pool_swap
