"""Monte Carlo runner: run many simulations and aggregate results."""

from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

from my_project.models import Card, Contract, Resource
from my_project.simulation import GameState, run_game
from my_project.strategies import greedy_strategy, random_strategy, smart_greedy_strategy

STRATEGIES = {
    "greedy": greedy_strategy,
    "random": random_strategy,
    "smart": smart_greedy_strategy,
}


@dataclass
class SimulationConfig:
    num_simulations: int = 100
    num_players: int = 1
    start_money: int = 20
    start_market_pos: int = 10
    randomize_market: bool = True
    max_turns: int = 6
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


def _summarize_game(state: GameState) -> GameSummary:
    final_money = [p.money for p in state.players]
    final_debt = [p.debt for p in state.players]
    final_net_worth = [p.net_worth() for p in state.players]
    contracts = [p.contracts_fulfilled for p in state.players]
    buildings = [list(p.buildings_played) for p in state.players]
    rates = [{r.value: v for r, v in p.rates.items()} for p in state.players]
    final_market = state.market.snapshot()

    # Action history with structured action data
    actions = []
    for rec in state.history:
        turn_actions = []
        for ar in rec.actions:
            action_data: dict = {"type": ar.action_type, "detail": ar.detail}
            if ar.action_type == "build":
                action_data["buildings"] = ar.buildings
                action_data["costs_paid"] = ar.build_costs_paid
                action_data["money_spent"] = ar.build_money_spent
                action_data["rates_gained"] = ar.rates_gained
            elif ar.action_type == "sell":
                action_data["resource"] = ar.sell_resource
                action_data["amount"] = ar.sell_amount
                action_data["revenue"] = ar.sell_revenue
            elif ar.action_type == "contract":
                action_data["label"] = ar.contract_label
                action_data["rates_spent"] = ar.contract_rates_spent
                action_data["reward"] = ar.contract_reward
                action_data["true_cost"] = ar.contract_true_cost
                action_data["gross_cost"] = ar.contract_gross_cost
            turn_actions.append(action_data)

        actions.append({
            "turn": rec.turn,
            "player": rec.player,
            "action_count": len(rec.actions),
            "actions": turn_actions,
            "event": rec.event,
            "money_before": rec.money_before,
            "money_after": rec.money_after,
            "debt": rec.debt,
            "contracts": rec.contracts_fulfilled,
            "market": rec.market_snapshot,
            "rates": rec.rates_snapshot,
        })

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
    )


def run_monte_carlo(
    all_cards: list[Card],
    all_contracts: list[Contract],
    config: SimulationConfig,
) -> MonteCarloResults:
    """Run N simulations and aggregate results."""
    # Build per-player strategy list if specified
    if config.player_strategies:
        strategies_list = [STRATEGIES[s] for s in config.player_strategies]
    else:
        strategies_list = [STRATEGIES[config.strategy]] * config.num_players

    games: list[GameSummary] = []

    for _ in range(config.num_simulations):
        state = run_game(
            all_cards=all_cards,
            all_contracts=all_contracts,
            strategies=strategies_list,
            num_players=config.num_players,
            start_money=config.start_money,
            start_market_pos=config.start_market_pos,
            randomize_market=config.randomize_market,
            max_turns=config.max_turns,
        )
        games.append(_summarize_game(state))

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
    player_strats = results.config.player_strategies or [results.config.strategy] * num_players

    # Per-game summaries with all players
    game_summaries = []
    for i, g in enumerate(results.games):
        players_data = []
        for p in range(num_players):
            players_data.append({
                "strategy": player_strats[p] if p < len(player_strats) else "unknown",
                "net_worth": g.final_net_worth[p] if p < len(g.final_net_worth) else 0,
                "money": g.final_money[p] if p < len(g.final_money) else 0,
                "debt": g.final_debt[p] if p < len(g.final_debt) else 0,
                "contracts_fulfilled": g.contracts_fulfilled[p] if p < len(g.contracts_fulfilled) else 0,
                "buildings_played": g.buildings_played[p] if p < len(g.buildings_played) else [],
                "final_rates": g.final_rates[p] if p < len(g.final_rates) else {},
            })
        game_summaries.append({
            "game_id": i,
            "players": players_data,
            "final_market": g.final_market,
            "turn_count": g.turn_count,
            "action_history": g.action_history,
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
