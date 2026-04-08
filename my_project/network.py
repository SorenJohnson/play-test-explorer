from collections import defaultdict
from dataclasses import dataclass, field

from my_project.models import (
    Card,
    Contract,
    Resource,
    ResourceAmount,
    RESOURCE_COLORS,
)


@dataclass
class BuildingType:
    """A unique building type aggregated across all card copies."""
    name: str
    slot: int
    costs: list[ResourceAmount]  # build costs only
    positive_rates: list[ResourceAmount]  # what it produces
    negative_rates: list[ResourceAmount]  # ongoing consumption (stored as positive amounts)
    copy_count: int = 0


@dataclass
class ResourceNode:
    resource: Resource
    color: str
    # As a build cost: how many total units are needed across all building copies
    total_build_demand: int = 0
    # As production: total positive rate units across all building copies
    total_production: int = 0
    # Contract demand: total units required across all contracts
    contract_demand: int = 0

    @property
    def rank(self) -> int:
        """Higher rank = more consumed as build cost. Used for left-to-right layout."""
        return self.total_build_demand


@dataclass
class BuildCostEdge:
    """Resource A is a build cost of buildings that produce Resource B."""
    source: Resource  # the build cost resource
    target: Resource  # the produced resource
    total_cost_units: int = 0  # total units of source consumed across all copies
    total_produced_units: int = 0  # total units of target produced across all copies
    buildings: list[str] = field(default_factory=list)
    building_details: list[dict] = field(default_factory=list)  # per-building breakdown


@dataclass
class ContractNode:
    contract_id: str
    label: str
    requirements: list[ResourceAmount]
    reward: int


@dataclass
class ContractEdge:
    source: Resource
    target: str
    weight: int = 0


@dataclass
class Network:
    resource_nodes: dict[Resource, ResourceNode]
    building_types: list[BuildingType]
    build_cost_edges: list[BuildCostEdge]
    contract_nodes: list[ContractNode]
    contract_edges: list[ContractEdge]


def _aggregate_building_types(cards: list[Card]) -> list[BuildingType]:
    """Group cards by building name and aggregate."""
    by_name: dict[str, BuildingType] = {}

    for card in cards:
        if card.building not in by_name:
            pos_rates = [ra for ra in card.rates if ra.amount > 0]
            neg_rates = [ResourceAmount(ra.resource, abs(ra.amount)) for ra in card.rates if ra.amount < 0]
            by_name[card.building] = BuildingType(
                name=card.building,
                slot=card.slot,
                costs=list(card.costs),
                positive_rates=pos_rates,
                negative_rates=neg_rates,
                copy_count=0,
            )
        by_name[card.building].copy_count += 1

    return list(by_name.values())


def _build_resource_nodes(
    building_types: list[BuildingType],
    contracts: list[Contract],
) -> dict[Resource, ResourceNode]:
    nodes = {r: ResourceNode(resource=r, color=RESOURCE_COLORS[r]) for r in Resource}

    for bt in building_types:
        for ra in bt.costs:
            nodes[ra.resource].total_build_demand += ra.amount * bt.copy_count
        for ra in bt.positive_rates:
            nodes[ra.resource].total_production += ra.amount * bt.copy_count

    for contract in contracts:
        for req in contract.requirements:
            nodes[req.resource].contract_demand += req.amount

    return nodes


def _build_cost_edges(building_types: list[BuildingType]) -> list[BuildCostEdge]:
    """For each building, connect its build cost resources to its produced resources.

    Only uses the Cost column (one-time build costs), NOT negative rates.
    This answers: "what resource do I spend to get this other resource?"
    """
    edge_map: dict[tuple[Resource, Resource], BuildCostEdge] = {}

    for bt in building_types:
        if not bt.costs or not bt.positive_rates:
            continue

        for cost_ra in bt.costs:
            for prod_ra in bt.positive_rates:
                key = (cost_ra.resource, prod_ra.resource)
                if key not in edge_map:
                    edge_map[key] = BuildCostEdge(source=cost_ra.resource, target=prod_ra.resource)

                edge = edge_map[key]
                edge.total_cost_units += cost_ra.amount * bt.copy_count
                edge.total_produced_units += prod_ra.amount * bt.copy_count
                if bt.name not in edge.buildings:
                    edge.buildings.append(bt.name)
                    edge.building_details.append({
                        "name": bt.name,
                        "cost": cost_ra.amount,
                        "produces": prod_ra.amount,
                        "copies": bt.copy_count,
                        "negative_rates": [
                            {"resource": nr.resource.value, "amount": nr.amount}
                            for nr in bt.negative_rates
                        ],
                    })

    return list(edge_map.values())


def _build_contract_nodes(contracts: list[Contract]) -> list[ContractNode]:
    nodes = []
    for i, contract in enumerate(contracts):
        req_strs = [f"{ra.amount} {ra.resource.value}" for ra in contract.requirements]
        label = " + ".join(req_strs)
        nodes.append(
            ContractNode(
                contract_id=f"contract_{i}",
                label=label,
                requirements=contract.requirements,
                reward=contract.reward,
            )
        )
    return nodes


def _build_contract_edges(contract_nodes: list[ContractNode]) -> list[ContractEdge]:
    edges = []
    for cn in contract_nodes:
        for req in cn.requirements:
            edges.append(ContractEdge(source=req.resource, target=cn.contract_id, weight=req.amount))
    return edges


def build_network(cards: list[Card], contracts: list[Contract]) -> Network:
    building_types = _aggregate_building_types(cards)
    resource_nodes = _build_resource_nodes(building_types, contracts)
    build_cost_edges = _build_cost_edges(building_types)
    contract_nodes = _build_contract_nodes(contracts)
    contract_edges = _build_contract_edges(contract_nodes)

    return Network(
        resource_nodes=resource_nodes,
        building_types=building_types,
        build_cost_edges=build_cost_edges,
        contract_nodes=contract_nodes,
        contract_edges=contract_edges,
    )
