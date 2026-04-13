"""Tests for special-building effects (Slot-4 cards from Cards.csv)."""

from pathlib import Path

from my_project.models import Resource, ResourceAmount, Card, Contract
from my_project.parsing import parse_cards, parse_contracts
from my_project.simulation import (
    GameState,
    Player,
    _count_buildings,
    _patent_office_trigger,
    _pleasure_dome_bonus,
    do_futures_settlement,
    do_power_bill,
    effective_contract_requirements,
    execute_build,
    execute_contract,
    execute_sell,
)


DATA = Path(__file__).resolve().parent.parent / "my_project" / "data"


def _load():
    return parse_cards(DATA / "Cards.csv"), parse_contracts(DATA / "Contracts.csv")


def _build_special(name: str) -> Card:
    """Construct a fake Card matching one of the slot-4 specials by name."""
    cards, _ = _load()
    for c in cards:
        if c.building == name:
            return c
    raise ValueError(f"No card named {name!r} in Cards.csv")


# --- Pleasure Dome ---


class TestPleasureDome:
    def test_no_dome_no_bonus(self):
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        assert _pleasure_dome_bonus(state, state.players[0]) == 0

    def test_one_dome_globally_pays_20(self):
        """1 PD in play → that owner gets $20."""
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        state.players[0].buildings_played.append(_build_special("Pleasure Dome"))
        assert _pleasure_dome_bonus(state, state.players[0]) == 20
        # Other players (no dome) get nothing.
        assert _pleasure_dome_bonus(state, state.players[1]) == 0

    def test_two_domes_split_two_owners_each_get_15(self):
        """2 PDs in play, one each on two players → each owner gets $15."""
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        dome = _build_special("Pleasure Dome")
        state.players[0].buildings_played.append(dome)
        state.players[1].buildings_played.append(dome)
        assert _pleasure_dome_bonus(state, state.players[0]) == 15
        assert _pleasure_dome_bonus(state, state.players[1]) == 15
        assert _pleasure_dome_bonus(state, state.players[2]) == 0

    def test_three_domes_split_three_owners_each_get_10(self):
        """3 PDs in play, one each on three players → each owner gets $10."""
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        dome = _build_special("Pleasure Dome")
        for i in range(3):
            state.players[i].buildings_played.append(dome)
        for i in range(3):
            assert _pleasure_dome_bonus(state, state.players[i]) == 10

    def test_power_bill_pays_dome_bonus(self):
        """do_power_bill adds the Pleasure Dome bonus on top of regular pay."""
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        p = state.players[0]
        # Zero PWR rate so no regular power-bill movement, just the bonus
        p.rates[Resource.PWR] = 0
        money_before = p.money
        p.buildings_played.append(_build_special("Pleasure Dome"))
        do_power_bill(state)
        assert p.money == money_before + 20

    def test_power_bill_with_two_pd_owners(self):
        """do_power_bill pays each owner $15 when 2 PDs are in play."""
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        # Zero PWR for everyone so the bill is just the dome bonus
        for p in state.players:
            p.rates[Resource.PWR] = 0
        dome = _build_special("Pleasure Dome")
        state.players[0].buildings_played.append(dome)
        state.players[1].buildings_played.append(dome)
        money_before = [p.money for p in state.players]
        do_power_bill(state)
        assert state.players[0].money == money_before[0] + 15
        assert state.players[1].money == money_before[1] + 15
        assert state.players[2].money == money_before[2]  # no dome


# --- One-of-each gate ---


class TestOneOfEach:
    def test_cannot_build_two_pleasure_domes(self):
        """Building a second Pleasure Dome (when one is already owned) fails."""
        from my_project.simulation import execute_build
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        p = state.players[0]
        p.buildings_played.append(_build_special("Pleasure Dome"))
        # Stick a Pleasure Dome card in hand and try to build it
        p.hand = [_build_special("Pleasure Dome")]
        # Make sure player can afford it
        p.money = 100
        for r in Resource:
            p.rates[r] = 5
        record = execute_build(state, p, build_indices=[0])
        assert record is None

    def test_can_build_first_special(self):
        """The first copy of a special is allowed."""
        from my_project.simulation import execute_build
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        p = state.players[0]
        p.hand = [_build_special("Pleasure Dome")]
        p.money = 100
        for r in Resource:
            p.rates[r] = 5
        record = execute_build(state, p, build_indices=[0])
        assert record is not None
        assert any(c.building == "Pleasure Dome" for c in p.buildings_played)

    def test_ordinary_buildings_can_still_dupe(self):
        """The constraint is slot-4 only — non-special duplicates are still fine."""
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        p = state.players[0]
        # Find any non-special card
        ordinary = next(c for c in cards if not c.effect)
        # Already owns one of these
        p.buildings_played.append(ordinary)
        # No exception expected; the gate skips cards without `effect`
        from my_project.simulation import execute_build
        p.hand = [ordinary]
        p.money = 100
        for r in Resource:
            p.rates[r] = 5
        record = execute_build(state, p, build_indices=[0])
        assert record is not None


# --- Space Elevator ---


def _make_contract_card() -> Card:
    return Card(
        alternate="Contract",
        slot=1,
        building="MockContract",
        costs=[],
        rates=[],
        effect="",
        can_sell=[],
        can_fulfill_contract=True,
    )


class TestSpaceElevator:
    def test_no_elevator_no_discount(self):
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        contract = state.available_contracts[0]
        # Even with apply_elevator=True, the player doesn't own one
        effective = effective_contract_requirements(state.players[0], contract, apply_elevator=True)
        assert [(r.resource, r.amount) for r in effective] == [
            (r.resource, r.amount) for r in contract.requirements
        ]

    def test_apply_elevator_false_returns_original(self):
        """Even if the player owns SE, apply_elevator=False returns original reqs."""
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        p = state.players[0]
        p.buildings_played.append(_build_special("Space Elevator"))
        contract = Contract(
            requirements=[ResourceAmount(resource=Resource.FOOD, amount=2)],
            reward=50,
            count=1,
        )
        effective = effective_contract_requirements(p, contract, apply_elevator=False)
        assert effective[0].amount == 2

    def test_elevator_targets_one_resource_only(self):
        """SE -1 applies to ONE resource (the target), not all."""
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        p = state.players[0]
        p.buildings_played.append(_build_special("Space Elevator"))
        contract = Contract(
            requirements=[
                ResourceAmount(resource=Resource.FOOD, amount=2),
                ResourceAmount(resource=Resource.GLS, amount=1),
            ],
            reward=50,
            count=1,
        )
        # Target FOOD: FOOD becomes 1, GLS stays 1
        effective = effective_contract_requirements(
            p, contract, apply_elevator=True, elevator_target="FOOD"
        )
        amounts = {r.resource: r.amount for r in effective}
        assert amounts[Resource.FOOD] == 1
        assert amounts[Resource.GLS] == 1
        # Target GLS: FOOD stays 2, GLS becomes 0
        effective = effective_contract_requirements(
            p, contract, apply_elevator=True, elevator_target="GLS"
        )
        amounts = {r.resource: r.amount for r in effective}
        assert amounts[Resource.FOOD] == 2
        assert amounts[Resource.GLS] == 0

    def test_elevator_default_target_is_first_req(self):
        """When no target is supplied, the first requirement gets the discount."""
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        p = state.players[0]
        p.buildings_played.append(_build_special("Space Elevator"))
        contract = Contract(
            requirements=[
                ResourceAmount(resource=Resource.FOOD, amount=2),
                ResourceAmount(resource=Resource.GLS, amount=1),
            ],
            reward=50,
            count=1,
        )
        effective = effective_contract_requirements(p, contract, apply_elevator=True)
        amounts = {r.resource: r.amount for r in effective}
        assert amounts[Resource.FOOD] == 1  # first req gets the -1
        assert amounts[Resource.GLS] == 1   # second req unchanged

    def test_elevator_floor_at_zero(self):
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        p = state.players[0]
        p.buildings_played.append(_build_special("Space Elevator"))
        contract = Contract(
            requirements=[ResourceAmount(resource=Resource.FOOD, amount=0)],
            reward=10,
            count=1,
        )
        effective = effective_contract_requirements(p, contract, apply_elevator=True)
        assert effective[0].amount == 0

    def test_elevator_lets_player_fulfill_otherwise_unaffordable(self):
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        p = state.players[0]
        p.buildings_played.append(_build_special("Space Elevator"))
        p.rates[Resource.FOOD] = 0
        custom_contract = Contract(
            requirements=[ResourceAmount(resource=Resource.FOOD, amount=1)],
            reward=10,
            count=1,
        )
        state.available_contracts[0] = custom_contract
        p.hand = [_make_contract_card()]
        record = execute_contract(state, p, card_idx=0, contract_idx=0, use_elevator=True)
        assert record is not None
        assert p.contracts_fulfilled == 1
        assert p.has_used_space_elevator_this_turn

    def test_elevator_use_blocked_after_first_use(self):
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        p = state.players[0]
        p.buildings_played.append(_build_special("Space Elevator"))
        p.has_used_space_elevator_this_turn = True
        custom_contract = Contract(
            requirements=[ResourceAmount(resource=Resource.FOOD, amount=1)],
            reward=10,
            count=1,
        )
        state.available_contracts[0] = custom_contract
        p.rates[Resource.FOOD] = 0
        p.hand = [_make_contract_card()]
        record = execute_contract(state, p, card_idx=0, contract_idx=0, use_elevator=True)
        assert record is None  # already used this turn

    def test_elevator_use_rejected_when_not_owned(self):
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        p = state.players[0]
        # Doesn't own Space Elevator
        custom_contract = Contract(
            requirements=[ResourceAmount(resource=Resource.FOOD, amount=1)],
            reward=10,
            count=1,
        )
        state.available_contracts[0] = custom_contract
        p.rates[Resource.FOOD] = 0
        p.hand = [_make_contract_card()]
        record = execute_contract(state, p, card_idx=0, contract_idx=0, use_elevator=True)
        assert record is None

    def test_elevator_default_off_does_not_discount(self):
        """When use_elevator is not passed, the discount doesn't apply even if owned."""
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        p = state.players[0]
        p.buildings_played.append(_build_special("Space Elevator"))
        custom_contract = Contract(
            requirements=[ResourceAmount(resource=Resource.FOOD, amount=1)],
            reward=10,
            count=1,
        )
        state.available_contracts[0] = custom_contract
        p.rates[Resource.FOOD] = 0
        p.hand = [_make_contract_card()]
        # Without use_elevator, the FOOD requirement isn't discounted
        record = execute_contract(state, p, card_idx=0, contract_idx=0)
        assert record is None  # 0 < 1, can't afford


# --- Optimization Center ---
#
# OC is now a per-turn free action: -1 PWR rate, +1 to any positive non-PWR
# resource rate. Tested through PlayableGame.use_optimization_center, since
# the action lives on the play adapter (not in simulation.py).


class TestOptimizationCenter:
    def _make_game_with_oc(self):
        from my_project.play_adapter import PlayableGame
        game = PlayableGame(seats=["human", "smart"], seed=123)
        p = game.state.players[0]
        p.buildings_played.append(_build_special("Optimization Center"))
        p.has_used_optimization_center_this_turn = False
        return game, p

    def test_no_oc_no_boost(self):
        """Calling without owning the building is rejected."""
        from my_project.play_adapter import PlayableGame
        game = PlayableGame(seats=["human", "smart"], seed=123)
        p = game.state.players[0]
        p.rates[Resource.FE] = 2
        result = game.use_optimization_center(0, "FE")
        assert not result["ok"]
        # Rate is unchanged
        assert p.rate(Resource.FE) == 2

    def test_use_boosts_chosen_resource(self):
        game, p = self._make_game_with_oc()
        p.rates[Resource.FE] = 2
        pwr_before = p.rate(Resource.PWR)
        result = game.use_optimization_center(0, "FE")
        assert result["ok"]
        assert p.rate(Resource.FE) == 3
        # PWR rate dropped by 1
        assert p.rate(Resource.PWR) == pwr_before - 1
        assert p.has_used_optimization_center_this_turn

    def test_blocked_when_already_used(self):
        game, p = self._make_game_with_oc()
        p.rates[Resource.FE] = 2
        game.use_optimization_center(0, "FE")
        result = game.use_optimization_center(0, "FE")
        assert not result["ok"]

    def test_blocked_when_resource_not_positive(self):
        game, p = self._make_game_with_oc()
        # Player has 0 FE rate
        p.rates[Resource.FE] = 0
        result = game.use_optimization_center(0, "FE")
        assert not result["ok"]
        assert not p.has_used_optimization_center_this_turn

    def test_cannot_target_pwr(self):
        game, p = self._make_game_with_oc()
        p.rates[Resource.PWR] = 5  # plenty of PWR
        result = game.use_optimization_center(0, "PWR")
        assert not result["ok"]

    def test_invalid_resource_rejected(self):
        game, p = self._make_game_with_oc()
        result = game.use_optimization_center(0, "BOGUS")
        assert not result["ok"]

    def test_futures_settlement_no_longer_touches_oc(self):
        """OC has no effect on futures settlement under the new rules."""
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        p = state.players[0]
        p.buildings_played.append(_build_special("Optimization Center"))
        p.rates[Resource.FE] = 2
        p.rates[Resource.GLS] = 1
        before_fe = p.rate(Resource.FE)
        before_gls = p.rate(Resource.GLS)
        do_futures_settlement(state)
        # Neither rate should be boosted by the settlement
        assert p.rate(Resource.FE) == before_fe
        assert p.rate(Resource.GLS) == before_gls


# --- Hacker Array ---


def _make_sellable_fe() -> Card:
    return Card(
        alternate="C/SI",
        slot=1,
        building="MockSeller",
        costs=[],
        rates=[],
        effect="",
        can_sell=[Resource.FE],
        can_fulfill_contract=False,
    )


class TestHackerArray:
    def test_no_hacker_no_market_bump(self):
        """Without a Hacker Array, supplying hacker_target+direction is a no-op."""
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        p = state.players[0]
        p.rates[Resource.FE] = 2
        p.hand = [_make_sellable_fe()]
        prices_before = {r: state.market.price(r) for r in Resource}
        execute_sell(state, p, card_idx=0, hacker_target="GLS", hacker_direction=1)
        for r in Resource:
            if r == Resource.FE:
                continue  # the sold resource always drops
            assert state.market.price(r) == prices_before[r]

    def test_hacker_with_no_target_no_bonus(self):
        """Owning HA but not supplying target+direction = no bonus (player chose to skip)."""
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        p = state.players[0]
        p.buildings_played.append(_build_special("Hacker Array"))
        p.rates[Resource.FE] = 2
        p.hand = [_make_sellable_fe()]
        prices_before = {r: state.market.price(r) for r in Resource}
        record = execute_sell(state, p, card_idx=0)  # no hacker params
        assert "[HA:" not in record.detail
        for r in Resource:
            if r == Resource.FE:
                continue
            assert state.market.price(r) == prices_before[r]

    def test_hacker_picks_resource_and_direction_up(self):
        """Player picks GLS / +1 → GLS market moves up."""
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        p = state.players[0]
        p.buildings_played.append(_build_special("Hacker Array"))
        p.rates[Resource.FE] = 2
        p.hand = [_make_sellable_fe()]
        gls_pos_before = state.market.positions[Resource.GLS]
        record = execute_sell(state, p, card_idx=0, hacker_target="GLS", hacker_direction=1)
        gls_pos_after = state.market.positions[Resource.GLS]
        assert gls_pos_after == gls_pos_before + 3
        assert "[HA: +3 GLS]" in record.detail

    def test_hacker_picks_resource_and_direction_down(self):
        """Player picks H2O / -1 → H2O market moves down."""
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        p = state.players[0]
        p.buildings_played.append(_build_special("Hacker Array"))
        p.rates[Resource.FE] = 2
        # Push H2O up first so we can see it drop
        state.market.adjust(Resource.H2O, 5)
        p.hand = [_make_sellable_fe()]
        h2o_pos_before = state.market.positions[Resource.H2O]
        record = execute_sell(state, p, card_idx=0, hacker_target="H2O", hacker_direction=-1)
        h2o_pos_after = state.market.positions[Resource.H2O]
        assert h2o_pos_after == h2o_pos_before - 3
        assert "[HA: -3 H2O]" in record.detail

    def test_hacker_target_same_as_sold_no_bonus(self):
        """Trying to bump the same resource you sold is forbidden — no-op."""
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        p = state.players[0]
        p.buildings_played.append(_build_special("Hacker Array"))
        p.rates[Resource.FE] = 2
        p.hand = [_make_sellable_fe()]
        record = execute_sell(state, p, card_idx=0, hacker_target="FE", hacker_direction=1)
        assert "[HA:" not in record.detail


# --- Patent Office ---


def _patent(name: str, rate_amount: int = 1, rate_resource=Resource.PWR) -> Card:
    return Card(
        alternate="Patent",
        slot=5,
        building=name,
        costs=[],
        rates=[ResourceAmount(resource=rate_resource, amount=rate_amount)],
        effect="",
        can_sell=[],
        can_fulfill_contract=False,
    )


class TestPatentOffice:
    def test_no_patents_is_noop(self):
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        # patent_pile defaults to empty
        p = state.players[0]
        rates_before = dict(p.rates)
        _patent_office_trigger(state, p)
        # No patents added, no rate change
        assert dict(p.rates) == rates_before

    def test_draws_two_keeps_better(self):
        cards, contracts = _load()
        # Hand-crafted patent_pile so the test is deterministic
        better = _patent("Better", rate_amount=3, rate_resource=Resource.PWR)
        worse = _patent("Worse", rate_amount=1, rate_resource=Resource.PWR)
        state = GameState.create(
            cards, contracts, num_players=3, patent_pile=[better, worse]
        )
        # Override the post-shuffle order so the test is deterministic
        state.patent_pile = [better, worse]
        state.patent_idx = 0
        p = state.players[0]
        pwr_before = p.rate(Resource.PWR)
        _patent_office_trigger(state, p)
        # The better patent (3 PWR) should be in buildings_played
        assert any(c.building == "Better" for c in p.buildings_played)
        assert not any(c.building == "Worse" for c in p.buildings_played)
        # The rate boost from the kept patent applied (+3 to whatever they had)
        assert p.rate(Resource.PWR) == pwr_before + 3

    def test_returned_patent_is_next_drawn(self):
        cards, contracts = _load()
        better = _patent("Better", rate_amount=3)
        worse = _patent("Worse", rate_amount=1)
        third = _patent("Third", rate_amount=2)
        state = GameState.create(
            cards, contracts, num_players=3, patent_pile=[better, worse, third]
        )
        state.patent_pile = [better, worse, third]
        state.patent_idx = 0
        p = state.players[0]
        _patent_office_trigger(state, p)
        # Worse was returned to top → next draw is Worse
        next_drawn = state.patent_pile[state.patent_idx]
        assert next_drawn.building == "Worse"

    def test_one_patent_left_just_takes_it(self):
        cards, contracts = _load()
        only = _patent("Only", rate_amount=1)
        state = GameState.create(
            cards, contracts, num_players=3, patent_pile=[only]
        )
        state.patent_pile = [only]
        state.patent_idx = 0
        p = state.players[0]
        _patent_office_trigger(state, p)
        assert any(c.building == "Only" for c in p.buildings_played)
        assert state.patent_idx == 1


# --- Launch Pad ---


class TestLaunchPad:
    def test_owned_lets_fulfill_without_card(self):
        """With Launch Pad, fulfill a contract with no contract-icon hand card."""
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        p = state.players[0]
        p.buildings_played.append(_build_special("Launch Pad"))
        custom_contract = Contract(
            requirements=[ResourceAmount(resource=Resource.FE, amount=1)],
            reward=10,
            count=1,
        )
        state.available_contracts[0] = custom_contract
        p.rates[Resource.FE] = 2
        p.hand = []  # no contract-icon card
        record = execute_contract(
            state, p, card_idx=-1, contract_idx=0, use_launch_pad=True
        )
        assert record is not None
        assert p.contracts_fulfilled == 1
        assert p.has_used_launch_pad_this_turn

    def test_used_twice_in_one_turn_blocked(self):
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        p = state.players[0]
        p.buildings_played.append(_build_special("Launch Pad"))
        p.has_used_launch_pad_this_turn = True
        custom_contract = Contract(
            requirements=[ResourceAmount(resource=Resource.FE, amount=1)],
            reward=10,
            count=1,
        )
        state.available_contracts[0] = custom_contract
        p.rates[Resource.FE] = 2
        record = execute_contract(
            state, p, card_idx=-1, contract_idx=0, use_launch_pad=True
        )
        assert record is None

    def test_not_owned_blocked(self):
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        p = state.players[0]
        # Doesn't own Launch Pad
        custom_contract = Contract(
            requirements=[ResourceAmount(resource=Resource.FE, amount=1)],
            reward=10,
            count=1,
        )
        state.available_contracts[0] = custom_contract
        p.rates[Resource.FE] = 2
        record = execute_contract(
            state, p, card_idx=-1, contract_idx=0, use_launch_pad=True
        )
        assert record is None

    def test_player_still_spends_rates(self):
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        p = state.players[0]
        p.buildings_played.append(_build_special("Launch Pad"))
        custom_contract = Contract(
            requirements=[
                ResourceAmount(resource=Resource.FE, amount=2),
                ResourceAmount(resource=Resource.GLS, amount=1),
            ],
            reward=20,
            count=1,
        )
        state.available_contracts[0] = custom_contract
        p.rates[Resource.FE] = 3
        p.rates[Resource.GLS] = 1
        execute_contract(state, p, card_idx=-1, contract_idx=0, use_launch_pad=True)
        assert p.rate(Resource.FE) == 1  # 3 - 2
        assert p.rate(Resource.GLS) == 0  # 1 - 1

    def test_launch_pad_combos_with_space_elevator(self):
        """Both flags can apply to the same fulfillment."""
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        p = state.players[0]
        p.buildings_played.append(_build_special("Launch Pad"))
        p.buildings_played.append(_build_special("Space Elevator"))
        custom_contract = Contract(
            requirements=[ResourceAmount(resource=Resource.FE, amount=1)],
            reward=10,
            count=1,
        )
        state.available_contracts[0] = custom_contract
        # Player has 0 FE — only the SE discount makes it affordable
        p.rates[Resource.FE] = 0
        record = execute_contract(
            state, p, card_idx=-1, contract_idx=0,
            use_launch_pad=True, use_elevator=True,
        )
        assert record is not None
        assert p.has_used_launch_pad_this_turn
        assert p.has_used_space_elevator_this_turn


