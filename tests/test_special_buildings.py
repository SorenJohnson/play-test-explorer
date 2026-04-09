"""Tests for special-building effects (Slot-4 cards from Cards.csv)."""

from pathlib import Path

from my_project.models import Resource, ResourceAmount, Card, Contract
from my_project.parsing import parse_cards, parse_contracts
from my_project.simulation import (
    GameState,
    Player,
    SUPPORTED_SPECIAL_EFFECTS,
    _count_buildings,
    _pleasure_dome_bonus,
    do_futures_settlement,
    do_power_bill,
    effective_contract_requirements,
    execute_contract,
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
        assert _pleasure_dome_bonus(state.players[0]) == 0

    def test_one_dome_pays_20(self):
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        state.players[0].buildings_played.append(_build_special("Pleasure Dome"))
        assert _pleasure_dome_bonus(state.players[0]) == 20

    def test_two_domes_pay_30(self):
        """Two domes: 2 × $15 = $30 per the diminishing-tier interpretation."""
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        dome = _build_special("Pleasure Dome")
        state.players[0].buildings_played.extend([dome, dome])
        assert _pleasure_dome_bonus(state.players[0]) == 30

    def test_three_domes_pay_30(self):
        """Three domes: 3 × $10 = $30."""
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        dome = _build_special("Pleasure Dome")
        state.players[0].buildings_played.extend([dome, dome, dome])
        assert _pleasure_dome_bonus(state.players[0]) == 30

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


# --- Space Elevator ---


class TestSpaceElevator:
    def test_no_elevator_no_discount(self):
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        contract = state.available_contracts[0]
        effective = effective_contract_requirements(state.players[0], contract)
        assert [(r.resource, r.amount) for r in effective] == [
            (r.resource, r.amount) for r in contract.requirements
        ]

    def test_elevator_reduces_each_requirement_by_one(self):
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        p = state.players[0]
        p.buildings_played.append(_build_special("Space Elevator"))
        # Hand-craft a contract so the test is deterministic
        contract = Contract(
            requirements=[
                ResourceAmount(resource=Resource.FOOD, amount=2),
                ResourceAmount(resource=Resource.GLS, amount=1),
            ],
            reward=50,
            count=1,
        )
        effective = effective_contract_requirements(p, contract)
        amounts = {r.resource: r.amount for r in effective}
        assert amounts[Resource.FOOD] == 1
        assert amounts[Resource.GLS] == 0

    def test_elevator_floor_at_zero(self):
        """Reduction can't make a requirement negative."""
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        p = state.players[0]
        # Two elevators: -2 to each req
        elevator = _build_special("Space Elevator")
        p.buildings_played.extend([elevator, elevator])
        contract = Contract(
            requirements=[ResourceAmount(resource=Resource.FOOD, amount=1)],
            reward=10,
            count=1,
        )
        effective = effective_contract_requirements(p, contract)
        assert effective[0].amount == 0

    def test_elevator_lets_player_fulfill_otherwise_unaffordable(self):
        """A contract that would normally be unaffordable can be fulfilled with SE."""
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        p = state.players[0]
        p.buildings_played.append(_build_special("Space Elevator"))
        # Set a contract requiring 1 FOOD when the player only has 0 FOOD rate
        p.rates[Resource.FOOD] = 0
        custom_contract = Contract(
            requirements=[ResourceAmount(resource=Resource.FOOD, amount=1)],
            reward=10,
            count=1,
        )
        state.available_contracts[0] = custom_contract
        # Give the player a card with the contract icon
        from my_project.models import Card as _Card
        contract_card = _Card(
            alternate="Contract",
            slot=1,
            building="MockContract",
            costs=[],
            rates=[],
            effect="",
            can_sell=[],
            can_fulfill_contract=True,
        )
        p.hand = [contract_card]
        record = execute_contract(state, p, card_idx=0, contract_idx=0)
        assert record is not None
        assert p.contracts_fulfilled == 1


# --- Optimization Center ---


class TestOptimizationCenter:
    def test_no_oc_no_boost(self):
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        # Force a known positive rate
        state.players[0].rates[Resource.FE] = 2
        before = state.players[0].rate(Resource.FE)
        do_futures_settlement(state)
        # Without OC, the rate stays the same (the settlement debits debt
        # for negatives but doesn't touch positives).
        assert state.players[0].rate(Resource.FE) == before

    def test_oc_boosts_highest_priced_positive_rate(self):
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        p = state.players[0]
        # Two positive rates, one priced higher than the other
        p.rates[Resource.FE] = 2
        p.rates[Resource.GLS] = 1
        # Manually adjust market so GLS is priced higher than FE
        state.market.adjust(Resource.GLS, 5)
        gls_price = state.market.price(Resource.GLS)
        fe_price = state.market.price(Resource.FE)
        assert gls_price > fe_price
        p.buildings_played.append(_build_special("Optimization Center"))
        do_futures_settlement(state)
        # GLS got the +1 boost (highest priced positive)
        assert p.rate(Resource.GLS) == 2
        assert p.rate(Resource.FE) == 2

    def test_two_ocs_apply_twice(self):
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        p = state.players[0]
        p.rates[Resource.FE] = 1
        oc = _build_special("Optimization Center")
        p.buildings_played.extend([oc, oc])
        do_futures_settlement(state)
        # Both OCs boosted the only positive rate
        assert p.rate(Resource.FE) == 3


# --- Filter gate ---


class TestSupportedSpecialEffects:
    def test_supported_set_includes_passives(self):
        for name in ["Pleasure Dome", "Optimization Center", "Space Elevator"]:
            assert name in SUPPORTED_SPECIAL_EFFECTS

    def test_unsupported_specials_excluded_from_deck(self):
        cards, contracts = _load()
        state = GameState.create(cards, contracts)
        all_in_play = state.deck.cards + state.deck.discard + list(state.pool)
        for player in state.players:
            all_in_play.extend(player.hand)
        for c in all_in_play:
            if c.effect:
                assert c.building in SUPPORTED_SPECIAL_EFFECTS, (
                    f"Unsupported special card in deck: {c.building}"
                )
