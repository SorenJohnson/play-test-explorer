from pathlib import Path

from my_project.models import Resource
from my_project.network import build_network
from my_project.parsing import parse_cards, parse_contracts

DATA_DIR = Path(__file__).resolve().parent.parent / "my_project" / "data"


def _load_network():
    cards = parse_cards(DATA_DIR / "Cards.csv")
    contracts = parse_contracts(DATA_DIR / "Contracts.csv")
    return build_network(cards, contracts)


class TestResourceNodes:
    def test_all_nine_resources(self):
        net = _load_network()
        assert len(net.resource_nodes) == 9
        assert set(net.resource_nodes.keys()) == set(Resource)

    def test_fe_highest_build_demand(self):
        """FE should be the most consumed build cost resource."""
        net = _load_network()
        fe = net.resource_nodes[Resource.FE]
        for r, node in net.resource_nodes.items():
            if r != Resource.FE:
                assert fe.total_build_demand >= node.total_build_demand

    def test_food_zero_build_demand(self):
        """FOOD is never a build cost."""
        net = _load_network()
        assert net.resource_nodes[Resource.FOOD].total_build_demand == 0

    def test_h2o_zero_build_demand(self):
        """H2O is never a build cost."""
        net = _load_network()
        assert net.resource_nodes[Resource.H2O].total_build_demand == 0

    def test_contract_resources_have_demand(self):
        net = _load_network()
        for r in (Resource.H2O, Resource.O2, Resource.FOOD, Resource.GLS, Resource.ELX):
            assert net.resource_nodes[r].contract_demand > 0

    def test_raw_resources_no_contract_demand(self):
        net = _load_network()
        for r in (Resource.PWR, Resource.FE, Resource.C, Resource.SI):
            assert net.resource_nodes[r].contract_demand == 0


class TestBuildCostEdges:
    def test_fe_to_h2o_exists(self):
        """Water Pump costs FE and produces H2O."""
        net = _load_network()
        fe_h2o = [e for e in net.build_cost_edges
                  if e.source == Resource.FE and e.target == Resource.H2O]
        assert len(fe_h2o) == 1
        edge = fe_h2o[0]
        assert edge.total_produced_units > 0
        assert "Water Pump" in edge.buildings

    def test_fe_to_food_exists(self):
        """Hydroponic Farm and Underground Farm cost FE and produce FOOD."""
        net = _load_network()
        fe_food = [e for e in net.build_cost_edges
                   if e.source == Resource.FE and e.target == Resource.FOOD]
        assert len(fe_food) == 1
        edge = fe_food[0]
        assert "Hydroponic Farm" in edge.buildings or "Underground Farm" in edge.buildings

    def test_no_food_as_source(self):
        """No buildings cost FOOD, so FOOD should never be an edge source."""
        net = _load_network()
        food_sources = [e for e in net.build_cost_edges if e.source == Resource.FOOD]
        assert len(food_sources) == 0

    def test_edges_have_building_details(self):
        net = _load_network()
        for edge in net.build_cost_edges:
            assert len(edge.building_details) > 0
            for detail in edge.building_details:
                assert "name" in detail
                assert "cost" in detail
                assert "produces" in detail
                assert "copies" in detail

    def test_free_buildings_not_in_edges(self):
        """Iron Mine has no build cost, so it should not create any build cost edges."""
        net = _load_network()
        for edge in net.build_cost_edges:
            assert "Iron Mine" not in edge.buildings


class TestContracts:
    def test_contract_count(self):
        net = _load_network()
        assert len(net.contract_nodes) == 29

    def test_contract_edges_exist(self):
        net = _load_network()
        assert len(net.contract_edges) > 0

    def test_contract_edges_only_from_contract_resources(self):
        """Contract edges should only come from H2O, O2, FOOD, GLS, ELX."""
        net = _load_network()
        allowed = {Resource.H2O, Resource.O2, Resource.FOOD, Resource.GLS, Resource.ELX}
        for ce in net.contract_edges:
            assert ce.source in allowed


class TestBuildingTypes:
    def test_building_types_aggregated(self):
        """Multiple card copies of same building should be aggregated."""
        net = _load_network()
        names = [bt.name for bt in net.building_types]
        assert len(names) == len(set(names))  # no duplicates

    def test_iron_mine_is_free(self):
        net = _load_network()
        iron_mines = [bt for bt in net.building_types if bt.name == "Iron Mine"]
        assert len(iron_mines) == 1
        assert iron_mines[0].costs == []

    def test_water_pump_details(self):
        net = _load_network()
        pumps = [bt for bt in net.building_types if bt.name == "Water Pump"]
        assert len(pumps) == 1
        pump = pumps[0]
        assert len(pump.costs) == 1  # 1 FE
        assert len(pump.positive_rates) == 1  # +1 H2O
        assert len(pump.negative_rates) == 1  # -1 PWR (stored as positive)
