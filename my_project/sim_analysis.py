"""Analyze simulation results to compute real contract costs and building economics."""

from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

from my_project.models import Resource
from my_project.simulation import (
    DEFAULT_MARKET_POS,
    DEFAULT_MAX_TURNS,
    DEFAULT_NUM_PLAYERS,
    EventType,
    PRICE_TRACK,
    build_event_deck,
)


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


def analyze_market_dynamics(sim_files: list[Path]) -> dict:
    """Track market price trajectories and buy/sell/drain pressures per resource.

    Returns per-resource stats:
    - Avg price trajectory over turns (0 = start, N = end)
    - Total bought from market (sum of deficit purchases)
    - Total sold to market (sum of sells)
    - Total negative rate exposure during futures settlements
    - Final price distribution
    """
    # price_trajectories[resource] = list of (turn_idx, price) lists per game
    all_trajectories: dict[str, list[list[int]]] = defaultdict(list)
    bought: dict[str, int] = defaultdict(int)
    sold: dict[str, int] = defaultdict(int)
    sell_revenue: dict[str, int] = defaultdict(int)
    buy_cost: dict[str, int] = defaultdict(int)
    final_prices: dict[str, list[int]] = defaultdict(list)
    starting_prices: dict[str, list[int]] = defaultdict(list)

    # Event-driven per-resource flows
    bills_units_earned: dict[str, int] = defaultdict(int)
    bills_units_owed: dict[str, int] = defaultdict(int)
    futures_units_bought: dict[str, int] = defaultdict(int)
    futures_debt_per_resource: dict[str, int] = defaultdict(int)

    # Event-driven economy (aggregate across all games)
    pwr_earned = 0  # total earned at power bills from positive PWR
    pwr_debt = 0  # total debt incurred from negative PWR at power bills
    futures_debt = 0  # total debt incurred from negative non-PWR rates at settlements

    # Count games and player-games for normalization
    total_games = 0
    total_player_games = 0

    for f in sim_files:
        with open(f) as fh:
            data = json.load(fh)

        for game in data["games"]:
            total_games += 1
            total_player_games += len(game.get("players", []))
            history = game.get("action_history", [])
            if not history:
                continue

            # Per-game: track price at each distinct turn (one entry per round)
            per_game: dict[str, list[int]] = defaultdict(list)
            seen_turns: set[int] = set()
            for rec in history:
                # Take only the first player's turn per round for consistent trajectory
                if rec["turn"] in seen_turns:
                    continue
                seen_turns.add(rec["turn"])
                for r, p in rec.get("market", {}).items():
                    per_game[r].append(p)

            for r, prices in per_game.items():
                if prices:
                    all_trajectories[r].append(prices)
                    starting_prices[r].append(prices[0])

            # Aggregate build/sell stats
            for rec in history:
                for a in rec.get("actions", []):
                    if a["type"] == "build":
                        spent = a.get("money_spent", 0)
                        for r, amt in a.get("costs_paid", {}).items():
                            bought[r] += amt
                            # Attribute full money_spent proportionally by cost units
                            total_units = sum(a.get("costs_paid", {}).values())
                            if total_units:
                                buy_cost[r] += spent * amt / total_units
                    elif a["type"] == "sell":
                        r = a.get("resource", "")
                        amt = a.get("amount", 0)
                        rev = a.get("revenue", 0)
                        if r:
                            sold[r] += amt
                            sell_revenue[r] += rev

            # Final prices
            for r, p in game.get("final_market", {}).items():
                final_prices[r].append(p)

            # Event-driven economy stats from this game
            pwr_earned += game.get("pwr_total_earned", 0)
            pwr_debt += game.get("pwr_total_debt", 0)
            futures_debt += game.get("futures_total_debt", 0)

            for r, v in game.get("bills_units_earned", {}).items():
                bills_units_earned[r] += v
            for r, v in game.get("bills_units_owed", {}).items():
                bills_units_owed[r] += v
            for r, v in game.get("futures_units_bought", {}).items():
                futures_units_bought[r] += v
            for r, v in game.get("futures_debt_per_resource", {}).items():
                futures_debt_per_resource[r] += v

    # Build result
    results = {}
    all_resources = (
        set(all_trajectories)
        | set(bought)
        | set(sold)
        | set(final_prices)
        | set(bills_units_earned)
        | set(bills_units_owed)
        | set(futures_units_bought)
    )
    for r in sorted(all_resources):
        # Compute avg trajectory
        trajectories = all_trajectories.get(r, [])
        avg_traj: list[float] = []
        if trajectories:
            max_len = max(len(t) for t in trajectories)
            for turn in range(max_len):
                vals = [t[turn] for t in trajectories if turn < len(t)]
                avg_traj.append(round(sum(vals) / len(vals), 2))

        starts = starting_prices.get(r, [])
        finals = final_prices.get(r, [])

        # Combine market trades + event-driven flows
        # PWR: power bills earn for + rate (treat as "sold"), debt for - rate (treat as "bought")
        # Other: futures settlement charges debt for - rate (treat as "bought")
        market_bought = bought.get(r, 0)
        market_sold = sold.get(r, 0)
        market_buy_cost = int(round(buy_cost.get(r, 0)))
        market_sell_revenue = sell_revenue.get(r, 0)

        # Power bill flows (PWR only in practice, but tracked for any resource)
        bill_earned_units = bills_units_earned.get(r, 0)
        bill_owed_units = bills_units_owed.get(r, 0)
        bill_earned_cash = pwr_earned if r == "PWR" else 0
        bill_debt_cash = pwr_debt if r == "PWR" else 0

        # Futures settlement (non-PWR only)
        fut_units = futures_units_bought.get(r, 0)
        fut_debt = futures_debt_per_resource.get(r, 0)

        # Bought / sold include market + bills, futures kept separate for display
        total_bought = market_bought + bill_owed_units + fut_units
        total_sold = market_sold + bill_earned_units
        total_buy_cost = market_buy_cost + bill_debt_cash + fut_debt
        total_sell_revenue = market_sell_revenue + bill_earned_cash

        results[r] = {
            "avg_trajectory": avg_traj,
            "avg_starting_price": round(sum(starts) / len(starts), 2) if starts else 0,
            "avg_final_price": round(sum(finals) / len(finals), 2) if finals else 0,
            "min_final": min(finals) if finals else 0,
            "max_final": max(finals) if finals else 0,
            # Bought / sold counts and cash exclude futures (futures are separate)
            "total_bought": total_bought,
            "total_sold": total_sold,
            "total_buy_cost": total_buy_cost,
            "total_sell_revenue": total_sell_revenue,
            # Futures settlement debt (forced buys at settlements)
            "futures_debt": fut_debt,
            "futures_units": fut_units,
            # Component breakdowns
            "market_bought": market_bought,
            "market_sold": market_sold,
            "bill_earned_units": bill_earned_units,
            "bill_owed_units": bill_owed_units,
        }

    return {
        "resources": results,
        "total_games": total_games,
        "total_player_games": total_player_games,
        "segments": _segment_player_flows(sim_files),
    }


def _segment_player_flows(sim_files: list[Path]) -> dict:
    """Build per-segment aggregates of player flows.

    Segments:
    - all
    - winners / losers (top / bottom NW per game)
    - by strategy (smart / greedy / random)
    """
    # Discover all strategies from the data instead of hardcoding
    all_strategies: set[str] = set()
    for f in sim_files:
        with open(f) as fh:
            data = json.load(fh)
        for game in data["games"]:
            for p in game.get("players", []):
                s = p.get("strategy", "")
                if s:
                    all_strategies.add(s)

    segment_keys = ["all", "winners", "losers"] + sorted(all_strategies)

    def _empty_segment():
        return {
            "player_count": 0,
            "resources": defaultdict(lambda: {
                "bought_units": 0,
                "sold_units": 0,
                "buy_cost": 0.0,
                "sell_revenue": 0.0,
                "futures_units": 0,
                "futures_cost": 0.0,
            }),
            "totals": {
                "net_worth": 0,
                "money": 0,
                "debt": 0,
                "contracts_fulfilled": 0,
                "contract_value": 0,
            },
        }
    out: dict[str, dict] = {seg: _empty_segment() for seg in segment_keys}

    for f in sim_files:
        with open(f) as fh:
            data = json.load(fh)

        for game in data["games"]:
            players = game.get("players", [])
            if not players:
                continue

            nws = [p.get("net_worth", 0) for p in players]
            top_nw = max(nws)
            bottom_nw = min(nws)

            for p in players:
                flows = p.get("flows", {})
                if not flows:
                    continue
                nw = p.get("net_worth", 0)
                strat = p.get("strategy", "")

                segments = ["all"]
                if nw == top_nw:
                    segments.append("winners")
                if nw == bottom_nw and top_nw != bottom_nw:
                    segments.append("losers")
                if strat in all_strategies:
                    # Ensure segment exists (might be new strategy)
                    if strat not in out:
                        out[strat] = _empty_segment()
                    segments.append(strat)

                contracts = p.get("contracts_fulfilled", 0)
                money = p.get("money", 0)
                debt = p.get("debt", 0)
                for seg in segments:
                    out[seg]["player_count"] += 1
                    seg_res = out[seg]["resources"]
                    for r, v in flows.get("bought_units", {}).items():
                        seg_res[r]["bought_units"] += v
                    for r, v in flows.get("sold_units", {}).items():
                        seg_res[r]["sold_units"] += v
                    for r, v in flows.get("buy_cost", {}).items():
                        seg_res[r]["buy_cost"] += v
                    for r, v in flows.get("sell_revenue", {}).items():
                        seg_res[r]["sell_revenue"] += v
                    for r, v in flows.get("futures_units", {}).items():
                        seg_res[r]["futures_units"] += v
                    for r, v in flows.get("futures_cost", {}).items():
                        seg_res[r]["futures_cost"] += v
                    # Totals
                    t = out[seg]["totals"]
                    t["net_worth"] += nw
                    t["money"] += money
                    t["debt"] += debt
                    t["contracts_fulfilled"] += contracts
                    t["contract_value"] += contracts * 50

    # Convert defaultdicts to plain dicts
    return {
        seg: {
            "player_count": s["player_count"],
            "resources": {
                r: {k: round(v, 2) if isinstance(v, float) else v for k, v in stats.items()}
                for r, stats in s["resources"].items()
            },
            "totals": s["totals"],
        }
        for seg, s in out.items()
    }


def analyze_corporations(sim_files: list[Path]) -> dict:
    """Compute win rate and performance stats per corporation.

    A "win" = highest net worth in a game. Ties count for all tied players.
    """
    stats: dict[str, dict] = defaultdict(lambda: {
        "games": 0,
        "wins": 0,
        "net_worths": [],
        "contracts": 0,
        "by_strategy": defaultdict(lambda: {"games": 0, "wins": 0, "net_worths": []}),
    })

    for f in sim_files:
        with open(f) as fh:
            data = json.load(fh)

        for game in data["games"]:
            players = game.get("players", [])
            if not players:
                continue

            winning_nw = max(p["net_worth"] for p in players)

            for p in players:
                corp = p.get("corporation", "")
                if not corp:
                    continue
                s = stats[corp]
                s["games"] += 1
                s["net_worths"].append(p["net_worth"])
                s["contracts"] += p.get("contracts_fulfilled", 0)
                if p["net_worth"] == winning_nw:
                    s["wins"] += 1

                strat = p.get("strategy", "unknown")
                ss = s["by_strategy"][strat]
                ss["games"] += 1
                ss["net_worths"].append(p["net_worth"])
                if p["net_worth"] == winning_nw:
                    ss["wins"] += 1

    results = {}
    for corp, s in stats.items():
        n = s["games"]
        nws = sorted(s["net_worths"])
        results[corp] = {
            "games": n,
            "wins": s["wins"],
            "win_rate": round(s["wins"] / n, 3) if n else 0,
            "avg_net_worth": round(sum(nws) / n, 1) if n else 0,
            "median_net_worth": nws[n // 2] if n else 0,
            "avg_contracts": round(s["contracts"] / n, 2) if n else 0,
            "by_strategy": {
                strat: {
                    "games": ss["games"],
                    "win_rate": round(ss["wins"] / ss["games"], 3) if ss["games"] else 0,
                    "avg_net_worth": round(sum(ss["net_worths"]) / ss["games"], 1) if ss["games"] else 0,
                }
                for strat, ss in s["by_strategy"].items()
            },
        }
    return results


def analyze_building_value(sim_files: list[Path]) -> dict:
    """Compute differential value metrics per building.

    Metrics:
    - times_built: total across all games
    - games_built_in: games where at least one player built it
    - winner_pct: % of winners who built it (share of winning player-games)
    - loser_pct: % of losers who built it (share of losing player-games)
    - edge: winner_pct − loser_pct (positive = winning building)
    - avg_builder_net_worth: avg NW of player-games that built it
    - avg_non_builder_net_worth: avg NW of player-games that did NOT build it
    - nw_delta: avg_builder_net_worth − avg_non_builder_net_worth
    - avg_market_cost: avg $ paid at market when built
    """
    total_count: dict[str, int] = defaultdict(int)
    market_cost_total: dict[str, float] = defaultdict(float)
    games_built: dict[str, int] = defaultdict(int)

    # Per-player-game differential tracking (unconditional denominators)
    winner_built_count: dict[str, int] = defaultdict(int)
    loser_built_count: dict[str, int] = defaultdict(int)
    builder_nw_sum: dict[str, float] = defaultdict(float)
    builder_nw_count: dict[str, int] = defaultdict(int)

    total_winners = 0
    total_losers = 0
    total_nw_sum = 0.0
    total_player_games = 0

    for f in sim_files:
        with open(f) as fh:
            data = json.load(fh)

        for game in data["games"]:
            players = game.get("players", [])
            if not players:
                continue

            winning_nw = max(p["net_worth"] for p in players)

            # Collect all builds in this game (from action history)
            built_by_player: dict[str, set[str]] = defaultdict(set)
            for turn in game.get("action_history", []):
                player_name = turn["player"]
                for action in turn.get("actions", []):
                    if action["type"] != "build":
                        continue
                    buildings = action.get("buildings", [])
                    money = action.get("money_spent", 0)
                    per_building = money / len(buildings) if buildings else 0
                    for bname in buildings:
                        total_count[bname] += 1
                        market_cost_total[bname] += per_building
                        built_by_player[player_name].add(bname)

            all_built_this_game: set[str] = set()
            for i, p in enumerate(players):
                player_name = f"Player_{i+1}"
                player_builds = built_by_player.get(player_name, set())
                all_built_this_game.update(player_builds)

                nw = p["net_worth"]
                is_winner = nw == winning_nw
                total_player_games += 1
                total_nw_sum += nw
                if is_winner:
                    total_winners += 1
                else:
                    total_losers += 1

                for b in player_builds:
                    builder_nw_sum[b] += nw
                    builder_nw_count[b] += 1
                    if is_winner:
                        winner_built_count[b] += 1
                    else:
                        loser_built_count[b] += 1

            for b in all_built_this_game:
                games_built[b] += 1

    results = {}
    for bname in sorted(total_count.keys(), key=lambda b: -total_count[b]):
        count = total_count[bname]
        gb = games_built[bname]
        wb = winner_built_count[bname]
        lb = loser_built_count[bname]
        winner_pct = wb / total_winners if total_winners else 0
        loser_pct = lb / total_losers if total_losers else 0

        b_count = builder_nw_count[bname]
        b_sum = builder_nw_sum[bname]
        nb_count = total_player_games - b_count
        nb_sum = total_nw_sum - b_sum
        avg_builder_nw = b_sum / b_count if b_count else 0
        avg_non_builder_nw = nb_sum / nb_count if nb_count else 0

        results[bname] = {
            "times_built": count,
            "games_built_in": gb,
            "winner_pct": round(winner_pct, 4),
            "loser_pct": round(loser_pct, 4),
            "edge": round(winner_pct - loser_pct, 4),
            "avg_builder_net_worth": round(avg_builder_nw, 1),
            "avg_non_builder_net_worth": round(avg_non_builder_nw, 1),
            "nw_delta": round(avg_builder_nw - avg_non_builder_nw, 1),
            "avg_market_cost": round(market_cost_total[bname] / count, 1) if count else 0,
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
    num_turns: int = DEFAULT_MAX_TURNS,
    num_players: int = DEFAULT_NUM_PLAYERS,
    market_start_pos: int = DEFAULT_MARKET_POS,
) -> dict:
    """Compute the theoretical value of +1 rate for each resource at each turn."""
    deck = build_event_deck(num_players)
    # END_GAME is always at the bottom; it fires both a power bill and a settlement
    def _count(et: EventType) -> int:
        return sum(1 for ec in deck if ec.type == et)
    end_game = _count(EventType.END_GAME)
    total_power_bills = _count(EventType.POWER_BILL) + end_game
    total_settlements = _count(EventType.FUTURES_SETTLEMENT) + end_game
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
