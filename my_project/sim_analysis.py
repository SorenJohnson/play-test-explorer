"""Analyze simulation results to compute real contract costs and building economics."""

from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

from my_project.models import Resource
from my_project.simulation import EventType, PRICE_TRACK, build_event_deck


def analyze_sim_contracts(sim_files: list[Path]) -> dict:
    """Extract real contract costs from simulation action histories.

    For each contract fulfillment, tracks:
    - Incremental cost: money spent on builds since last contract
    - Cumulative cost: total money spent on builds up to fulfillment
    - Buildings played before fulfillment (since last contract)
    - Rate profile at moment of fulfillment (before spending rates)
    - Strategy of the player who fulfilled it
    """
    contract_data: dict[str, list[dict]] = defaultdict(list)

    for f in sim_files:
        with open(f) as fh:
            data = json.load(fh)

        strats = data.get("config", {}).get("player_strategies") or [data.get("config", {}).get("strategy", "unknown")]

        for game in data["games"]:
            # Per-player tracking
            player_state: dict[str, dict] = {}

            for turn in game.get("action_history", []):
                player = turn["player"]
                if player not in player_state:
                    player_state[player] = {
                        "spend_since_last": 0,
                        "buildings_since_last": [],
                        "strategy": "unknown",
                    }
                    idx = int(player.split("_")[1]) - 1 if "_" in player else 0
                    if idx < len(strats):
                        player_state[player]["strategy"] = strats[idx]

                ps = player_state[player]

                for action in turn.get("actions", []):
                    if action["type"] == "build":
                        spent = action.get("money_spent", 0)
                        ps["spend_since_last"] += spent
                        for bname in action.get("buildings", []):
                            ps["buildings_since_last"].append(bname)

                    elif action["type"] == "contract":
                        label = action.get("label", "")
                        rates_at_fulfillment = dict(turn.get("rates", {}))
                        true_cost = action.get("true_cost", 0)
                        gross_cost = action.get("gross_cost", true_cost)

                        contract_data[label].append({
                            "true_cost": true_cost,
                            "gross_cost": gross_cost,
                            "incremental_market_cost": ps["spend_since_last"],
                            "buildings_played": list(ps["buildings_since_last"]),
                            "rates_at_fulfillment": rates_at_fulfillment,
                            "rates_spent": action.get("rates_spent", {}),
                            "strategy": ps["strategy"],
                        })

                        ps["spend_since_last"] = 0
                        ps["buildings_since_last"] = []

    # Aggregate
    results = {}
    for label in sorted(contract_data.keys()):
        entries = contract_data[label]
        n = len(entries)
        true_costs = sorted([e["true_cost"] for e in entries])
        gross_costs = sorted([e["gross_cost"] for e in entries])

        # Building frequency in the path to this contract
        build_freq: dict[str, int] = defaultdict(int)
        for e in entries:
            for b in e["buildings_played"]:
                build_freq[b] += 1
        top_buildings = sorted(build_freq.items(), key=lambda x: -x[1])[:10]

        # Average rates at fulfillment
        rate_sums: dict[str, float] = defaultdict(float)
        for e in entries:
            for r, v in e["rates_at_fulfillment"].items():
                rate_sums[r] += v
        avg_rates = {r: round(v / n, 1) for r, v in rate_sums.items()}

        # By strategy
        by_strategy: dict[str, list[float]] = defaultdict(list)
        for e in entries:
            by_strategy[e["strategy"]].append(e["true_cost"])
        strategy_stats = {}
        for strat, costs in by_strategy.items():
            s = sorted(costs)
            sn = len(s)
            strategy_stats[strat] = {
                "count": sn,
                "mean": round(sum(s) / sn, 1),
                "median": round(s[sn // 2], 1),
            }

        results[label] = {
            "count": n,
            "true_cost": {
                "mean": round(sum(true_costs) / n, 1),
                "median": round(true_costs[n // 2], 1),
                "q1": round(true_costs[n // 4], 1),
                "q3": round(true_costs[3 * n // 4], 1),
                "min": round(true_costs[0], 1),
                "max": round(true_costs[-1], 1),
                "values": [round(v, 1) for v in true_costs],
            },
            "gross_cost": {
                "mean": round(sum(gross_costs) / n, 1),
                "median": round(gross_costs[n // 2], 1),
                "q1": round(gross_costs[n // 4], 1),
                "q3": round(gross_costs[3 * n // 4], 1),
                "min": round(gross_costs[0], 1),
                "max": round(gross_costs[-1], 1),
                "values": [round(v, 1) for v in gross_costs],
            },
            "top_buildings": [{"building": b, "count": c, "rate": round(c / n, 2)} for b, c in top_buildings],
            "avg_rates_at_fulfillment": avg_rates,
            "by_strategy": strategy_stats,
        }

    return results


def analyze_sim_building_costs(sim_files: list[Path]) -> dict:
    """Extract per-building actual market costs from simulation data."""
    building_stats: dict[str, dict] = {}

    for f in sim_files:
        with open(f) as fh:
            data = json.load(fh)

        for game in data["games"]:
            for turn in game.get("action_history", []):
                for action in turn.get("actions", []):
                    if action["type"] != "build":
                        continue
                    buildings = action.get("buildings", [])
                    money = action.get("money_spent", 0)
                    per_building = money / len(buildings) if buildings else 0

                    for bname in buildings:
                        if bname not in building_stats:
                            building_stats[bname] = {
                                "count": 0, "total_money": 0,
                                "solo_count": 0, "solo_money": 0,
                            }
                        bs = building_stats[bname]
                        bs["count"] += 1
                        bs["total_money"] += per_building
                        if len(buildings) == 1:
                            bs["solo_count"] += 1
                            bs["solo_money"] += money

    results = {}
    for bname, bs in sorted(building_stats.items(), key=lambda x: -x[1]["count"]):
        avg_cost = bs["total_money"] / bs["count"] if bs["count"] > 0 else 0
        solo_avg = bs["solo_money"] / bs["solo_count"] if bs["solo_count"] > 0 else None
        results[bname] = {
            "times_built": bs["count"],
            "avg_market_cost": round(avg_cost, 1),
            "solo_builds": bs["solo_count"],
            "solo_avg_cost": round(solo_avg, 1) if solo_avg is not None else None,
        }

    return results


def compute_resource_flows(sim_files: list[Path]) -> dict:
    """Compute resource-to-resource flow data from simulation action histories.

    For each build action, tracks which build-cost resources flowed into which
    produced resources, and which buildings facilitated the flow.
    Also tracks contract consumption of rates.
    """
    # Edge: (cost_resource, produced_resource) -> {count, buildings}
    edges: dict[tuple[str, str], dict] = defaultdict(lambda: {
        "count": 0, "buildings": defaultdict(int),
    })

    # Contract edges: resource -> total units consumed
    contract_edges: dict[str, int] = defaultdict(int)

    # Free builds (no cost resource, like Iron Mine)
    free_edges: dict[str, dict] = defaultdict(lambda: {
        "count": 0, "buildings": defaultdict(int),
    })

    for f in sim_files:
        with open(f) as fh:
            data = json.load(fh)

        for game in data["games"]:
            for turn in game.get("action_history", []):
                for action in turn.get("actions", []):
                    if action["type"] == "build":
                        costs_paid = action.get("costs_paid", {})
                        rates_gained = action.get("rates_gained", {})
                        buildings = action.get("buildings", [])

                        pos_rates = {r: v for r, v in rates_gained.items() if v > 0}
                        if not pos_rates:
                            continue

                        if costs_paid:
                            for cost_res in costs_paid:
                                for rate_res in pos_rates:
                                    key = (cost_res, rate_res)
                                    edges[key]["count"] += 1
                                    for b in buildings:
                                        edges[key]["buildings"][b] += 1
                        else:
                            # Free build
                            for rate_res in pos_rates:
                                free_edges[rate_res]["count"] += 1
                                for b in buildings:
                                    free_edges[rate_res]["buildings"][b] += 1

                    elif action["type"] == "contract":
                        for res, amt in action.get("rates_spent", {}).items():
                            contract_edges[res] += amt

    # Format output
    result_edges = []
    for (src, tgt), data in sorted(edges.items(), key=lambda x: -x[1]["count"]):
        top_buildings = sorted(data["buildings"].items(), key=lambda x: -x[1])[:5]
        result_edges.append({
            "source": src,
            "target": tgt,
            "count": data["count"],
            "buildings": [{"name": b, "count": c} for b, c in top_buildings],
        })

    result_free = []
    for res, data in sorted(free_edges.items(), key=lambda x: -x[1]["count"]):
        top_buildings = sorted(data["buildings"].items(), key=lambda x: -x[1])[:5]
        result_free.append({
            "resource": res,
            "count": data["count"],
            "buildings": [{"name": b, "count": c} for b, c in top_buildings],
        })

    return {
        "resource_flows": result_edges,
        "free_builds": result_free,
        "contract_consumption": dict(contract_edges),
    }


def compute_rate_value_curves(
    num_turns: int = 8,
    num_players: int = 3,
    market_start_pos: int = 10,
) -> dict:
    """Compute the theoretical value of +1 rate for each resource at each turn."""
    deck = build_event_deck(num_turns, num_players)
    total_power_bills = deck.count(EventType.POWER_BILL)
    total_settlements = deck.count(EventType.FUTURES_SETTLEMENT)
    base_price = PRICE_TRACK[min(market_start_pos, len(PRICE_TRACK) - 1)]

    curves = {}
    for resource in Resource:
        points = []
        for turn in range(1, num_turns + 1):
            fraction_remaining = (num_turns - turn) / num_turns

            if resource == Resource.PWR:
                remaining = max(0, round(total_power_bills * fraction_remaining))
                value = base_price * max(remaining, 0)
                collections = remaining
            else:
                remaining = max(0, round(total_settlements * fraction_remaining))
                value = base_price * (remaining + 1)
                collections = remaining + 1

            points.append({
                "turn": turn,
                "value": round(value, 1),
                "remaining_collections": collections,
            })

        curves[resource.value] = points

    return curves
