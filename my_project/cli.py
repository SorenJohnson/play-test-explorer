import argparse
import sys
from pathlib import Path

import json

from my_project.cost_analysis import export_analysis
from my_project.export import export_network
from my_project.sim_analysis import (
    analyze_sim_building_costs,
    analyze_sim_contracts,
    compute_rate_value_curves,
    compute_resource_flows,
)
from my_project.monte_carlo import SimulationConfig, export_results, run_monte_carlo
from my_project.network import build_network
from my_project.parsing import parse_cards, parse_contracts


DATA_DIR = Path(__file__).parent / "data"


def cmd_network() -> None:
    """Generate the resource network JSON."""
    output_path = Path("frontend/data/network.json")
    cards = parse_cards(DATA_DIR / "Cards.csv")
    contracts = parse_contracts(DATA_DIR / "Contracts.csv")
    net = build_network(cards, contracts)
    export_network(net, output_path)
    print(f"Network exported to {output_path}")


def cmd_simulate(args: argparse.Namespace) -> None:
    """Run Monte Carlo simulation."""
    cards = parse_cards(DATA_DIR / "Cards.csv")
    contracts = parse_contracts(DATA_DIR / "Contracts.csv")

    player_strategies = args.player_strategies
    if player_strategies and len(player_strategies) != args.players:
        print(f"Error: --player-strategies needs {args.players} values (got {len(player_strategies)})")
        return

    config = SimulationConfig(
        num_simulations=args.runs,
        num_players=args.players,
        start_money=args.money,
        start_market_pos=args.market_pos,
        randomize_market=args.randomize_market,
        max_turns=args.turns,
        strategy=args.strategy,
        player_strategies=player_strategies,
    )

    strat_desc = ", ".join(player_strategies) if player_strategies else config.strategy
    print(f"Running {config.num_simulations} simulations "
          f"({config.num_players} players, strategies: {strat_desc})...")

    results = run_monte_carlo(cards, contracts, config)

    output_path = Path(args.output)
    export_results(results, output_path)

    print(f"\nResults exported to {output_path}")
    print(f"  Avg net worth: ${results.avg_net_worth:.0f}")
    print(f"  Avg contracts: {results.avg_contracts:.1f}")
    print(f"\n  Top buildings played:")
    for name, count in list(results.building_frequency.items())[:10]:
        print(f"    {name:25s} {count:4d}x ({count/config.num_simulations:.1f}/game)")


def main() -> None:
    parser = argparse.ArgumentParser(description="Board game analysis tools")
    sub = parser.add_subparsers(dest="command")

    # network subcommand
    sub.add_parser("network", help="Generate resource network JSON")

    # analyze subcommand
    sub.add_parser("analyze", help="Analyze contract and resource costs")

    # simulate subcommand
    sim = sub.add_parser("simulate", help="Run Monte Carlo simulation")
    sim.add_argument("-n", "--runs", type=int, default=100, help="Number of simulations")
    sim.add_argument("-p", "--players", type=int, default=1, help="Number of players")
    sim.add_argument("-m", "--money", type=int, default=20, help="Starting money")
    sim.add_argument("--market-pos", type=int, default=10, help="Starting market position (10=$5)")
    sim.add_argument("--randomize-market", action="store_true", help="Randomize starting prices")
    sim.add_argument("-t", "--turns", type=int, default=15, help="Turns per player")
    sim.add_argument("-s", "--strategy", choices=["greedy", "random", "smart"], default="greedy",
                     help="Default strategy for all players")
    sim.add_argument("--player-strategies", nargs="+", choices=["greedy", "random", "smart"],
                     help="Per-player strategies, e.g. --player-strategies greedy random random")
    sim.add_argument("-o", "--output", default="frontend/data/simulation.json")

    args = parser.parse_args()

    if args.command == "network":
        cmd_network()
    elif args.command == "simulate":
        cmd_simulate(args)
    elif args.command == "analyze":
        # Static analysis from card data
        data = export_analysis()

        # Real costs from simulation data
        sim_files = list(Path("frontend/data").glob("sim_*.json"))
        if sim_files:
            data["sim_contract_costs"] = analyze_sim_contracts(sim_files)
            data["sim_building_costs"] = analyze_sim_building_costs(sim_files)
            data["rate_value_curves"] = compute_rate_value_curves()
            data["resource_flows"] = compute_resource_flows(sim_files)
            print(f"Analyzed {len(sim_files)} simulation files")

        output = Path("frontend/data/analysis.json")
        output.parent.mkdir(parents=True, exist_ok=True)
        with open(output, "w") as f:
            json.dump(data, f, indent=2)
        print(f"Analysis exported to {output}")

        if "sim_contract_costs" in data:
            print(f"\nContract true costs (from cost accounting ledger):")
            for label, stats in sorted(data["sim_contract_costs"].items(),
                                       key=lambda x: x[1]["true_cost"]["mean"]):
                tc = stats["true_cost"]
                print(f"  {label:<35s}  n={stats['count']:>4d}  "
                      f"avg=${tc['mean']:<8.1f}  med=${tc['median']:<8.1f}  "
                      f"range=[${tc['min']:.0f}-${tc['max']:.0f}]")
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
