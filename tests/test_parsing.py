from pathlib import Path

from my_project.models import Resource, ResourceAmount
from my_project.parsing import (
    parse_cards,
    parse_contracts,
    parse_market,
    parse_resource_amount,
    parse_resource_list,
)

DATA_DIR = Path(__file__).resolve().parent.parent / "my_project" / "data"


class TestParseResourceAmount:
    def test_unsigned(self):
        assert parse_resource_amount("1 FE") == ResourceAmount(Resource.FE, 1)

    def test_positive(self):
        assert parse_resource_amount("+2 PWR") == ResourceAmount(Resource.PWR, 2)

    def test_negative(self):
        assert parse_resource_amount("-1 H2O") == ResourceAmount(Resource.H2O, -1)

    def test_alias_h20(self):
        assert parse_resource_amount("2 H20") == ResourceAmount(Resource.H2O, 2)

    def test_whitespace(self):
        assert parse_resource_amount("  3 GLS  ") == ResourceAmount(Resource.GLS, 3)


class TestParseResourceList:
    def test_empty(self):
        assert parse_resource_list("") == []
        assert parse_resource_list("  ") == []

    def test_single(self):
        result = parse_resource_list("1 SI")
        assert result == [ResourceAmount(Resource.SI, 1)]

    def test_multi(self):
        result = parse_resource_list("-1 PWR, +1 H2O")
        assert result == [
            ResourceAmount(Resource.PWR, -1),
            ResourceAmount(Resource.H2O, 1),
        ]

    def test_multi_cost(self):
        result = parse_resource_list("1 FE, 1 C")
        assert result == [
            ResourceAmount(Resource.FE, 1),
            ResourceAmount(Resource.C, 1),
        ]


class TestParseCards:
    def test_loads_all(self):
        cards = parse_cards(DATA_DIR / "Cards.csv")
        assert len(cards) == 102

    def test_solar_panel(self):
        cards = parse_cards(DATA_DIR / "Cards.csv")
        first = cards[0]
        assert first.building == "Solar Panel"
        assert first.slot == 1
        assert first.costs == [ResourceAmount(Resource.SI, 1)]
        assert first.rates == [ResourceAmount(Resource.PWR, 2)]
        assert first.can_sell == [Resource.C, Resource.SI]
        assert first.can_fulfill_contract is False

    def test_iron_mine_empty_cost(self):
        cards = parse_cards(DATA_DIR / "Cards.csv")
        iron_mines = [c for c in cards if c.building == "Iron Mine"]
        assert len(iron_mines) > 0
        for mine in iron_mines:
            assert mine.costs == []
            assert ResourceAmount(Resource.FE, 1) in mine.rates
            assert ResourceAmount(Resource.PWR, -2) in mine.rates

    def test_electrolysis_reactor_multi_rates(self):
        cards = parse_cards(DATA_DIR / "Cards.csv")
        reactors = [c for c in cards if c.building == "Electrolysis Reactor"]
        assert len(reactors) > 0
        r = reactors[0]
        assert r.costs == [ResourceAmount(Resource.FE, 1), ResourceAmount(Resource.C, 1)]
        assert ResourceAmount(Resource.PWR, 1) in r.rates
        assert ResourceAmount(Resource.H2O, -1) in r.rates
        assert ResourceAmount(Resource.O2, 1) in r.rates

    def test_contract_alternate(self):
        cards = parse_cards(DATA_DIR / "Cards.csv")
        contract_cards = [c for c in cards if c.can_fulfill_contract]
        assert len(contract_cards) > 0
        for c in contract_cards:
            assert c.can_sell == []

    def test_patent_office_has_food_rate(self):
        cards = parse_cards(DATA_DIR / "Cards.csv")
        offices = [c for c in cards if c.building == "Patent Office"]
        assert len(offices) > 0
        for o in offices:
            assert any(r.resource == Resource.FOOD and r.amount == -1 for r in o.rates)
            assert len(o.costs) > 0
            assert o.effect != ""


class TestParseContracts:
    def test_loads_all(self):
        contracts = parse_contracts(DATA_DIR / "Contracts.csv")
        assert len(contracts) == 29

    def test_all_reward_50(self):
        contracts = parse_contracts(DATA_DIR / "Contracts.csv")
        for c in contracts:
            assert c.reward == 50

    def test_h20_typo_normalized(self):
        """Contracts.csv has H20 (zero) instead of H2O on some rows."""
        contracts = parse_contracts(DATA_DIR / "Contracts.csv")
        for c in contracts:
            for req in c.requirements:
                assert req.resource != "H20"
                if "H2" in req.resource.value:
                    assert req.resource == Resource.H2O

    def test_single_resource_contract(self):
        contracts = parse_contracts(DATA_DIR / "Contracts.csv")
        first = contracts[0]  # 3 H2O
        assert first.requirements == [ResourceAmount(Resource.H2O, 3)]

    def test_multi_resource_contract(self):
        contracts = parse_contracts(DATA_DIR / "Contracts.csv")
        second = contracts[1]  # 2 H2O, 1 O2
        assert second.requirements == [
            ResourceAmount(Resource.H2O, 2),
            ResourceAmount(Resource.O2, 1),
        ]


class TestParseMarket:
    def test_loads_all(self):
        tracks = parse_market(DATA_DIR / "market.csv")
        assert len(tracks) == 9

    def test_resources(self):
        tracks = parse_market(DATA_DIR / "market.csv")
        resources = {t.resource for t in tracks}
        assert resources == set(Resource)

    def test_price_track_length(self):
        tracks = parse_market(DATA_DIR / "market.csv")
        for t in tracks:
            assert len(t.prices) == 17

    def test_price_track_values(self):
        tracks = parse_market(DATA_DIR / "market.csv")
        expected = [1, 1, 1, 2, 2, 2, 3, 3, 4, 4, 5, 5, 6, 7, 8, 9, 10]
        for t in tracks:
            assert t.prices == expected
