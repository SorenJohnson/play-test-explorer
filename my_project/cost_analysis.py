"""Analyze the true cost of producing resources and fulfilling contracts.

Traces the upstream build chain: to get +1 FOOD, you need a Hydroponic Farm
(costs 1 FE, drains 1 H2O). To get +1 H2O you need a Water Pump (costs 1 FE,
drains 1 PWR). So the full path cost of +1 FOOD = 2 FE build cost + ongoing
drains of 1 H2O and 1 PWR.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from my_project.models import Resource, ResourceAmount
from my_project.parsing import parse_cards, parse_contracts
from pathlib import Path


@dataclass
class BuildingOption:
    """One way to produce a resource."""
    name: str
    slot: int
    build_costs: dict[str, int]  # resource -> amount (one-time)
    net_rate: int  # how much of the target resource this produces
    negative_rates: dict[str, int]  # resource -> amount consumed ongoing
    copies_in_deck: int
    # Efficiency: build cost per unit of target resource
    build_cost_per_unit: dict[str, float] = field(default_factory=dict)
    # Total ongoing drain per unit of target resource
    drain_per_unit: dict[str, float] = field(default_factory=dict)


@dataclass
class ResourceProductionProfile:
    """How to produce a resource — all options and cheapest path."""
    resource: str
    options: list[BuildingOption]
    cheapest: BuildingOption | None  # lowest total build cost per unit
    total_deck_copies: int  # how many cards in deck can produce this


@dataclass
class ContractPathAnalysis:
    """Full upstream cost analysis for a contract."""
    contract_label: str
    requirements: dict[str, int]  # resource -> amount needed
    reward: int
    # For each required resource, the cheapest production path
    resource_paths: dict[str, ResourceProductionProfile]
    # Total build cost to gain the required rates (using cheapest buildings)
    total_build_cost: dict[str, float]  # resource -> total units needed from market
    # Total ongoing drains incurred
    total_drains: dict[str, float]
    # Number of buildings needed to reach the contract requirements
    buildings_needed: int
    # Estimated money cost at a reference market price
    estimated_money_cost: float
    # Availability: how many deck copies support this contract
    deck_availability: int


def analyze_resource_production() -> dict[str, ResourceProductionProfile]:
    """Analyze all ways to produce each resource."""
    data_dir = Path(__file__).parent / "data"
    cards = parse_cards(data_dir / "Cards.csv")

    # Group unique building types
    building_types: dict[str, dict] = {}
    for card in cards:
        if card.building not in building_types:
            building_types[card.building] = {
                "slot": card.slot,
                "costs": card.costs,
                "rates": card.rates,
                "count": 0,
            }
        building_types[card.building]["count"] += 1

    profiles: dict[str, ResourceProductionProfile] = {}

    for resource in Resource:
        options: list[BuildingOption] = []

        for bname, bdata in building_types.items():
            # Does this building produce this resource?
            target_rate = 0
            for ra in bdata["rates"]:
                if ra.resource == resource and ra.amount > 0:
                    target_rate = ra.amount

            if target_rate == 0:
                continue

            build_costs = {ra.resource.value: ra.amount for ra in bdata["costs"]}
            negative_rates = {}
            for ra in bdata["rates"]:
                if ra.amount < 0:
                    negative_rates[ra.resource.value] = abs(ra.amount)

            opt = BuildingOption(
                name=bname,
                slot=bdata["slot"],
                build_costs=build_costs,
                net_rate=target_rate,
                negative_rates=negative_rates,
                copies_in_deck=bdata["count"],
            )
            opt.build_cost_per_unit = {r: v / target_rate for r, v in build_costs.items()}
            opt.drain_per_unit = {r: v / target_rate for r, v in negative_rates.items()}
            options.append(opt)

        # Cheapest = lowest total build cost per unit
        cheapest = None
        if options:
            cheapest = min(options, key=lambda o: sum(o.build_cost_per_unit.values()))

        profiles[resource.value] = ResourceProductionProfile(
            resource=resource.value,
            options=options,
            cheapest=cheapest,
            total_deck_copies=sum(o.copies_in_deck for o in options),
        )

    return profiles


def analyze_contracts() -> list[ContractPathAnalysis]:
    """Analyze the full upstream cost of each contract."""
    data_dir = Path(__file__).parent / "data"
    contracts = parse_contracts(data_dir / "Contracts.csv")
    profiles = analyze_resource_production()

    results: list[ContractPathAnalysis] = []

    for contract in contracts:
        reqs = {ra.resource.value: ra.amount for ra in contract.requirements}
        label = ", ".join(f"{v} {r}" for r, v in reqs.items())

        resource_paths: dict[str, ResourceProductionProfile] = {}
        total_build: dict[str, float] = {}
        total_drains: dict[str, float] = {}
        buildings_needed = 0
        deck_availability = 999  # min across required resources

        for res, amount in reqs.items():
            profile = profiles.get(res)
            resource_paths[res] = profile

            if profile and profile.cheapest:
                opt = profile.cheapest
                # How many buildings needed for this amount?
                num_buildings = -(-amount // opt.net_rate)  # ceiling division
                buildings_needed += num_buildings

                for cost_res, cost_per_unit in opt.build_cost_per_unit.items():
                    total_build[cost_res] = total_build.get(cost_res, 0) + cost_per_unit * amount

                for drain_res, drain_per_unit in opt.drain_per_unit.items():
                    total_drains[drain_res] = total_drains.get(drain_res, 0) + drain_per_unit * amount

                deck_availability = min(deck_availability, profile.total_deck_copies)

        # Estimate money cost at mid-market (~$3 per resource unit)
        estimated_cost = sum(v * 3.0 for v in total_build.values())

        results.append(ContractPathAnalysis(
            contract_label=label,
            requirements=reqs,
            reward=contract.reward,
            resource_paths=resource_paths,
            total_build_cost=total_build,
            total_drains=total_drains,
            buildings_needed=buildings_needed,
            estimated_money_cost=estimated_cost,
            deck_availability=deck_availability if deck_availability < 999 else 0,
        ))

    # Sort by estimated cost
    results.sort(key=lambda r: r.estimated_money_cost)
    return results


def export_analysis() -> dict:
    """Export the full analysis as a JSON-serializable dict."""
    profiles = analyze_resource_production()
    contracts = analyze_contracts()

    resource_data = {}
    for res, profile in profiles.items():
        resource_data[res] = {
            "total_deck_copies": profile.total_deck_copies,
            "options": [
                {
                    "building": o.name,
                    "slot": o.slot,
                    "build_costs": o.build_costs,
                    "net_rate": o.net_rate,
                    "negative_rates": o.negative_rates,
                    "copies_in_deck": o.copies_in_deck,
                    "build_cost_per_unit": {k: round(v, 2) for k, v in o.build_cost_per_unit.items()},
                    "drain_per_unit": {k: round(v, 2) for k, v in o.drain_per_unit.items()},
                }
                for o in profile.options
            ],
            "cheapest": profile.cheapest.name if profile.cheapest else None,
        }

    contract_data = []
    for ca in contracts:
        contract_data.append({
            "label": ca.contract_label,
            "requirements": ca.requirements,
            "reward": ca.reward,
            "total_build_cost": {k: round(v, 2) for k, v in ca.total_build_cost.items()},
            "total_drains": {k: round(v, 2) for k, v in ca.total_drains.items()},
            "buildings_needed": ca.buildings_needed,
            "estimated_money_cost": round(ca.estimated_money_cost, 1),
            "deck_availability": ca.deck_availability,
            "cheapest_buildings": {
                res: ca.resource_paths[res].cheapest.name
                for res in ca.requirements
                if ca.resource_paths.get(res) and ca.resource_paths[res].cheapest
            },
        })

    return {
        "resources": resource_data,
        "contracts": contract_data,
    }
