"""Monte Carlo runner: run many simulations and aggregate results."""

from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from my_project.models import Card, Contract, Resource
from my_project.simulation import (
    DEFAULT_MARKET_POS,
    DEFAULT_MAX_TURNS,
    DEFAULT_START_MONEY,
    GameState,
    run_game,
)
from my_project.strategies import greedy_strategy, optimal_strategy, random_strategy, smart_greedy_strategy

STRATEGIES = {
    "greedy": greedy_strategy,
    "random": random_strategy,
    "smart": smart_greedy_strategy,
    "optimal": optimal_strategy,
}


@dataclass
class SimulationConfig:
    num_simulations: int = 100
    num_players: int = 1
    start_money: int = DEFAULT_START_MONEY
    start_market_pos: int = DEFAULT_MARKET_POS
    randomize_market: bool = True
    max_turns: int = DEFAULT_MAX_TURNS
    num_rounds: int = 2  # match play UI default: 2 passes through the event deck
    strategy: str = "greedy"
    player_strategies: list[str] | None = None  # per-player override, e.g. ["greedy", "random", "random"]


@dataclass
class GameSummary:
    """Summary of one game run."""
    final_money: list[int]
    final_debt: list[int]
    final_net_worth: list[int]
    contracts_fulfilled: list[int]
    buildings_played: list[list[str]]
    final_rates: list[dict[str, int]]
    final_market: dict[str, int]
    turn_count: int
    action_history: list[dict]  # condensed history
    action_log: list[dict] = field(default_factory=list)  # full GameLog mutation stream (inspector)
    # Strategy that played at each seat in THIS specific game. Needed because
    # run_monte_carlo shuffles the config's strategy list per game to remove
    # seat bias — seat 0 is not always the first strategy in the config.
    seat_strategies: list[str] = field(default_factory=list)
    corporations: list[str] = field(default_factory=list)
    starting_rates: list[dict[str, int]] = field(default_factory=list)
    pwr_total_earned: int = 0
    pwr_total_debt: int = 0
    futures_total_debt: int = 0
    bills_units_earned: dict[str, int] = field(default_factory=dict)
    bills_units_owed: dict[str, int] = field(default_factory=dict)
    futures_units_bought: dict[str, int] = field(default_factory=dict)
    futures_debt_per_resource: dict[str, int] = field(default_factory=dict)
    # Per-player flows: list[player_idx] -> {resource: amount}
    player_flows: list[dict] = field(default_factory=list)
    initial_market: dict[str, int] = field(default_factory=dict)


@dataclass
class MonteCarloResults:
    """Aggregated results across all simulations."""
    config: SimulationConfig
    games: list[GameSummary]

    # Aggregated stats
    avg_net_worth: float = 0
    avg_contracts: float = 0
    building_frequency: dict[str, int] = field(default_factory=dict)
    resource_final_prices: dict[str, list[int]] = field(default_factory=dict)
    resource_rate_distributions: dict[str, list[int]] = field(default_factory=dict)
    market_price_history: list[dict[str, int]] = field(default_factory=list)


def _summarize_game(state: GameState, seat_strategies: list[str] | None = None) -> GameSummary:
    final_money = [p.money for p in state.players]
    final_debt = [p.debt for p in state.players]
    final_net_worth = [p.net_worth() for p in state.players]
    contracts = [p.contracts_fulfilled for p in state.players]
    buildings = [p.building_names() for p in state.players]
    rates = [{r.value: v for r, v in p.rates.items()} for p in state.players]
    final_market = state.market.snapshot()
    corporations = [p.corporation for p in state.players]
    starting_rates = [dict(p.starting_rates) for p in state.players]
    player_flows = [
        {
            "bought_units": {r.value: v for r, v in p.flow_bought_units.items() if v > 0},
            "sold_units": {r.value: v for r, v in p.flow_sold_units.items() if v > 0},
            "buy_cost": {r.value: round(v, 2) for r, v in p.flow_buy_cost.items() if v > 0},
            "sell_revenue": {r.value: v for r, v in p.flow_sell_revenue.items() if v > 0},
            "futures_units": {r.value: v for r, v in p.flow_futures_units.items() if v > 0},
            "futures_cost": {r.value: v for r, v in p.flow_futures_cost.items() if v > 0},
        }
        for p in state.players
    ]

    # Build action_history from GameLog entries.
    # Entries are flat; turns are delimited by event entries.
    # A state tracker replays mutations for per-turn snapshots.
    actions = _build_action_history(state)

    # Full mutation stream for the game inspector. Only kept per-game and
    # emitted into the split detail file by cmd_publish — the top-level
    # sim_*.json strips this out so compare.html stays small.
    full_log = [
        {
            "id": e.action_id,
            "type": e.type,
            "player": e.player_name,
            "player_idx": e.player_idx,
            "summary": e.summary,
            "mutations": [
                {"field": m.field, "old": m.old_value, "new": m.new_value}
                for m in e.mutations
            ],
            "metadata": e.metadata if e.metadata else {},
        }
        for e in state.log.entries
    ]

    initial_market = getattr(state, "_initial_market", final_market)

    return GameSummary(
        final_money=final_money,
        final_debt=final_debt,
        final_net_worth=final_net_worth,
        contracts_fulfilled=contracts,
        buildings_played=buildings,
        final_rates=rates,
        final_market=final_market,
        turn_count=state.turn,
        action_history=actions,
        action_log=full_log,
        seat_strategies=list(seat_strategies) if seat_strategies else [],
        corporations=corporations,
        starting_rates=starting_rates,
        initial_market=initial_market,
        pwr_total_earned=state.pwr_total_earned,
        pwr_total_debt=state.pwr_total_debt,
        futures_total_debt=state.futures_total_debt,
        bills_units_earned={r.value: v for r, v in state.bills_units_earned.items()},
        bills_units_owed={r.value: v for r, v in state.bills_units_owed.items()},
        futures_units_bought={r.value: v for r, v in state.futures_units_bought.items()},
        futures_debt_per_resource={r.value: v for r, v in state.futures_debt_per_resource.items()},
        player_flows=player_flows,
    )


class _StateTracker:
    """Replays mutations to reconstruct per-turn state snapshots."""

    def __init__(self, num_players: int) -> None:
        self.market: dict[str, int] = {r.value: 0 for r in Resource}
        self.players: list[dict] = [
            {"money": 0, "debt": 0, "credit": 0, "contracts": 0,
             "rates": {r.value: 0 for r in Resource}}
            for _ in range(num_players)
        ]

    def apply(self, entry) -> None:
        for m in entry.mutations:
            self._apply_mut(m.field, m.new_value)

    def _apply_mut(self, field: str, new_val) -> None:
        import re
        mkt = re.match(r"^market\.(\w+)$", field)
        if mkt and isinstance(new_val, (int, float)):
            self.market[mkt.group(1)] = int(new_val)
            return
        pm = re.match(r"^player\.(\d+)\.(.+)$", field)
        if not pm:
            return
        idx = int(pm.group(1))
        rest = pm.group(2)
        if idx >= len(self.players):
            return
        p = self.players[idx]
        if rest == "money" and isinstance(new_val, (int, float)):
            p["money"] = int(new_val)
        elif rest == "debt" and isinstance(new_val, (int, float)):
            p["debt"] = int(new_val)
        elif rest == "credit" and isinstance(new_val, (int, float)):
            p["credit"] = int(new_val)
        else:
            rm = re.match(r"^rates\.(\w+)$", rest)
            if rm and isinstance(new_val, (int, float)):
                p["rates"][rm.group(1)] = int(new_val)

    def record_contract(self, player_idx: int) -> None:
        if 0 <= player_idx < len(self.players):
            self.players[player_idx]["contracts"] += 1

    def player_snapshot(self, idx: int) -> dict:
        p = self.players[idx]
        return {
            "money": p["money"], "debt": p["debt"],
            "credit": p["credit"], "contracts": p["contracts"],
            "rates": dict(p["rates"]),
        }

    def market_snapshot(self) -> dict[str, int]:
        """Return market prices (not positions) via PRICE_TRACK lookup."""
        from my_project.simulation import PRICE_TRACK
        result = {}
        for r, pos in self.market.items():
            clamped = max(0, min(pos, len(PRICE_TRACK) - 1))
            result[r] = PRICE_TRACK[clamped]
        return result


def _build_action_history(state: GameState) -> list[dict]:
    """Build turn-grouped action_history from GameLog entries.

    Turns are delimited by event entries. Chained redraw events (event
    entries with no preceding player actions) are merged into their
    parent turn, matching the old TurnRecord grouping.
    """
    tracker = _StateTracker(len(state.players))
    log_entries = state.log.entries
    num_players = len(state.players)

    turns: list[dict] = []
    pending: list = []
    turn_num = 0

    for entry in log_entries:
        tracker.apply(entry)

        if entry.type == "setup":
            continue

        # Track contract fulfillment
        if entry.type == "contract" and entry.player_idx >= 0:
            tracker.record_contract(entry.player_idx)

        if entry.type.startswith("event:"):
            # Is this a chained redraw event? (no player actions since last event)
            has_player_actions = any(
                e.type in ("build", "sell", "contract", "swap")
                or e.type.startswith("free:")
                for e in pending
            )

            if not has_player_actions and turns:
                # Chained redraw: merge into the previous turn
                last = turns[-1]
                last["event"] += f" | {entry.summary}"
                # Update snapshots to post-chain state
                pidx = 0
                for i, p in enumerate(state.players):
                    if p.name == last["player"]:
                        pidx = i
                        break
                snap = tracker.player_snapshot(pidx)
                last["money_after"] = snap["money"]
                last["debt"] = snap["debt"]
                last["contracts"] = snap["contracts"]
                last["market"] = tracker.market_snapshot()
                last["rates"] = snap["rates"]
                pending = []
                continue

            # Primary event — closes a turn.
            turn_num += 1
            turn_player_idx = (turn_num - 1) % num_players
            turn_player = state.players[turn_player_idx].name

            # Extract build/sell/contract actions from pending entries
            turn_actions = []
            money_before = None
            for e in pending:
                if e.type in ("build", "sell", "contract"):
                    action_data: dict = {"type": e.type, "detail": e.summary}
                    meta = e.metadata
                    if e.type == "build":
                        action_data["buildings"] = meta.get("buildings", [])
                        action_data["costs_paid"] = meta.get("costs_paid", {})
                        action_data["money_spent"] = meta.get("money_spent", 0)
                        action_data["rates_gained"] = meta.get("rates_gained", {})
                    elif e.type == "sell":
                        action_data["resource"] = meta.get("sell_resource", "")
                        action_data["amount"] = meta.get("sell_amount", 0)
                        action_data["revenue"] = meta.get("sell_revenue", 0)
                    elif e.type == "contract":
                        action_data["label"] = meta.get("contract_label", "")
                        action_data["rates_spent"] = meta.get("rates_spent", {})
                        action_data["reward"] = meta.get("reward", 0)
                        action_data["true_cost"] = meta.get("true_cost", 0)
                        action_data["gross_cost"] = meta.get("gross_cost", 0)
                    turn_actions.append(action_data)

                # Track money_before from the first mutation on this player
                if money_before is None and e.player_idx == turn_player_idx:
                    for m in e.mutations:
                        if m.field == f"player.{turn_player_idx}.money":
                            money_before = m.old_value
                            break

            # Also check the event entry for money_before
            if money_before is None:
                for m in entry.mutations:
                    if m.field == f"player.{turn_player_idx}.money":
                        money_before = m.old_value
                        break

            snap = tracker.player_snapshot(turn_player_idx)
            turns.append({
                "turn": turn_num,
                "player": turn_player,
                "action_count": len(turn_actions),
                "actions": turn_actions,
                "event": entry.summary,
                "money_before": money_before if money_before is not None else snap["money"],
                "money_after": snap["money"],
                "debt": snap["debt"],
                "contracts": snap["contracts"],
                "market": tracker.market_snapshot(),
                "rates": snap["rates"],
            })
            pending = []
        else:
            pending.append(entry)

    return turns


def run_monte_carlo(
    all_cards: list[Card],
    all_contracts: list[Contract],
    config: SimulationConfig,
) -> MonteCarloResults:
    """Run N simulations and aggregate results.

    Seat-strategy mapping is shuffled per game to remove seat-order bias from
    the aggregate. Each game records the actual seat→strategy mapping so
    downstream aggregation can group by strategy instead of seat.
    """
    import random as _random

    if config.player_strategies:
        base_strategy_names = list(config.player_strategies)
    else:
        base_strategy_names = [config.strategy] * config.num_players

    games: list[GameSummary] = []

    for _ in range(config.num_simulations):
        seat_names = list(base_strategy_names)
        _random.shuffle(seat_names)
        strategies_list = [STRATEGIES[s] for s in seat_names]
        state = run_game(
            all_cards=all_cards,
            all_contracts=all_contracts,
            strategies=strategies_list,
            num_players=config.num_players,
            start_money=config.start_money,
            start_market_pos=config.start_market_pos,
            randomize_market=config.randomize_market,
            max_turns=config.max_turns,
            num_rounds=config.num_rounds,
        )
        games.append(_summarize_game(state, seat_strategies=seat_names))

    results = MonteCarloResults(config=config, games=games)
    _aggregate(results)
    return results


def _aggregate(results: MonteCarloResults) -> None:
    """Compute aggregate statistics across all games."""
    n = len(results.games)
    if n == 0:
        return

    # Average net worth (player 0)
    results.avg_net_worth = sum(g.final_net_worth[0] for g in results.games) / n
    results.avg_contracts = sum(g.contracts_fulfilled[0] for g in results.games) / n

    # Building frequency
    freq: dict[str, int] = defaultdict(int)
    for g in results.games:
        for buildings in g.buildings_played:
            for b in buildings:
                freq[b] += 1
    results.building_frequency = dict(sorted(freq.items(), key=lambda x: -x[1]))

    # Final market prices distribution
    price_dist: dict[str, list[int]] = defaultdict(list)
    for g in results.games:
        for res, price in g.final_market.items():
            price_dist[res].append(price)
    results.resource_final_prices = dict(price_dist)

    # Final rate distributions (player 0)
    rate_dist: dict[str, list[int]] = defaultdict(list)
    for g in results.games:
        if g.final_rates:
            for res, rate in g.final_rates[0].items():
                rate_dist[res].append(rate)
    results.resource_rate_distributions = dict(rate_dist)


def results_to_dict(results: MonteCarloResults) -> dict:
    """Convert results to JSON-serializable dict."""
    # Net worth distribution
    net_worths = [g.final_net_worth[0] for g in results.games]
    contracts = [g.contracts_fulfilled[0] for g in results.games]

    num_players = results.config.num_players
    config_strats = results.config.player_strategies or [results.config.strategy] * num_players

    # Per-game summaries with all players
    game_summaries = []
    for i, g in enumerate(results.games):
        # Prefer the per-game seat→strategy mapping (records actual shuffled
        # assignment). Fall back to config for backwards compat with old games.
        game_strats = g.seat_strategies if g.seat_strategies else config_strats
        players_data = []
        for p in range(num_players):
            players_data.append({
                "strategy": game_strats[p] if p < len(game_strats) else "unknown",
                "corporation": g.corporations[p] if p < len(g.corporations) else "",
                "starting_rates": g.starting_rates[p] if p < len(g.starting_rates) else {},
                "net_worth": g.final_net_worth[p] if p < len(g.final_net_worth) else 0,
                "money": g.final_money[p] if p < len(g.final_money) else 0,
                "debt": g.final_debt[p] if p < len(g.final_debt) else 0,
                "contracts_fulfilled": g.contracts_fulfilled[p] if p < len(g.contracts_fulfilled) else 0,
                "buildings_played": g.buildings_played[p] if p < len(g.buildings_played) else [],
                "final_rates": g.final_rates[p] if p < len(g.final_rates) else {},
                "flows": g.player_flows[p] if p < len(g.player_flows) else {},
            })
        game_summaries.append({
            "game_id": i,
            "players": players_data,
            "initial_market": g.initial_market,
            "final_market": g.final_market,
            "turn_count": g.turn_count,
            "action_history": g.action_history,
            "action_log": g.action_log,
            "pwr_total_earned": g.pwr_total_earned,
            "pwr_total_debt": g.pwr_total_debt,
            "futures_total_debt": g.futures_total_debt,
            "bills_units_earned": g.bills_units_earned,
            "bills_units_owed": g.bills_units_owed,
            "futures_units_bought": g.futures_units_bought,
            "futures_debt_per_resource": g.futures_debt_per_resource,
            # Keep player 0 at top level for backwards compat with single-player report
            "net_worth": g.final_net_worth[0],
            "money": g.final_money[0],
            "debt": g.final_debt[0],
            "contracts_fulfilled": g.contracts_fulfilled[0],
            "buildings_played": g.buildings_played[0] if g.buildings_played else [],
            "final_rates": g.final_rates[0] if g.final_rates else {},
        })

    # Building stats
    building_stats = []
    for name, count in results.building_frequency.items():
        building_stats.append({
            "building": name,
            "times_played": count,
            "play_rate": count / len(results.games),
        })

    # Resource price distributions
    price_stats = {}
    for res, prices in results.resource_final_prices.items():
        price_stats[res] = {
            "mean": sum(prices) / len(prices),
            "min": min(prices),
            "max": max(prices),
            "values": prices,
        }

    # Resource rate distributions
    rate_stats = {}
    for res, rates in results.resource_rate_distributions.items():
        rate_stats[res] = {
            "mean": sum(rates) / len(rates),
            "min": min(rates),
            "max": max(rates),
            "values": rates,
        }

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "config": {
            "num_simulations": results.config.num_simulations,
            "num_players": results.config.num_players,
            "start_money": results.config.start_money,
            "start_market_pos": results.config.start_market_pos,
            "randomize_market": results.config.randomize_market,
            "max_turns": results.config.max_turns,
            "strategy": results.config.strategy,
            "player_strategies": results.config.player_strategies,
        },
        "summary": {
            "avg_net_worth": round(results.avg_net_worth, 1),
            "avg_contracts": round(results.avg_contracts, 2),
            "net_worth_distribution": net_worths,
            "contracts_distribution": contracts,
        },
        "building_stats": building_stats,
        "price_stats": price_stats,
        "rate_stats": rate_stats,
        "games": game_summaries,
    }


def export_results(results: MonteCarloResults, output_path: Path) -> None:
    """Write results to JSON file."""
    data = results_to_dict(results)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(data, f, indent=2)
