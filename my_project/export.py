import json
from pathlib import Path

from my_project.network import Network


def network_to_dict(net: Network) -> dict:
    """Convert Network to Cytoscape.js-compatible JSON structure."""
    nodes = []
    edges = []

    # Rank resources by build demand (highest = leftmost)
    ranked = sorted(net.resource_nodes.values(), key=lambda n: n.rank, reverse=True)
    rank_order = {n.resource: i for i, n in enumerate(ranked)}

    # Resource nodes
    for r, rn in net.resource_nodes.items():
        nodes.append({
            "data": {
                "id": r.value,
                "type": "resource",
                "label": r.value,
                "color": rn.color,
                "rank": rank_order[r],
                "total_build_demand": rn.total_build_demand,
                "total_production": rn.total_production,
                "contract_demand": rn.contract_demand,
            }
        })

    # Contract nodes
    for cn in net.contract_nodes:
        nodes.append({
            "data": {
                "id": cn.contract_id,
                "type": "contract",
                "label": cn.label,
                "reward": cn.reward,
                "requirements": [
                    {"resource": ra.resource.value, "amount": ra.amount}
                    for ra in cn.requirements
                ],
            }
        })

    # Build cost edges (resource → resource via buildings)
    for edge in net.build_cost_edges:
        edges.append({
            "data": {
                "id": f"{edge.source.value}->{edge.target.value}",
                "source": edge.source.value,
                "target": edge.target.value,
                "relationship": "build_cost",
                "total_cost_units": edge.total_cost_units,
                "total_produced_units": edge.total_produced_units,
                "buildings": edge.buildings,
                "building_details": edge.building_details,
            }
        })

    # Contract edges
    for ce in net.contract_edges:
        edges.append({
            "data": {
                "id": f"{ce.source.value}->{ce.target}",
                "source": ce.source.value,
                "target": ce.target,
                "relationship": "contract_requires",
                "weight": ce.weight,
            }
        })

    return {
        "nodes": nodes,
        "edges": edges,
        "metadata": {
            "total_building_types": len(net.building_types),
            "total_contracts": len(net.contract_nodes),
        },
    }


def export_network(net: Network, output_path: Path) -> None:
    """Serialize network to JSON and write to file."""
    data = network_to_dict(net)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(data, f, indent=2)
