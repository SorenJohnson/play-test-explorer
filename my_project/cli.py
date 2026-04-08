import argparse
from pathlib import Path

import json

from my_project.cost_analysis import export_analysis
from my_project.export import export_network
from my_project.sim_analysis import (
    analyze_building_value,
    analyze_corporations,
    analyze_market_dynamics,
    analyze_sim_building_costs,
    analyze_sim_contracts,
    compute_rate_value_curves,
    compute_resource_flows,
)
from my_project.monte_carlo import SimulationConfig, export_results, run_monte_carlo
from my_project.network import build_network
from my_project.parsing import parse_cards, parse_contracts
from my_project.simulation import DEFAULT_MARKET_POS, DEFAULT_MAX_TURNS, DEFAULT_NUM_PLAYERS


DATA_DIR = Path(__file__).parent / "data"
FULL_DIR = Path("frontend/data/full")
PUBLISH_DIR = Path("frontend/data")

SCENARIOS = [
    {"name": "sim_3random", "strategies": ["random", "random", "random"]},
    {"name": "sim_1smart", "strategies": ["smart", "random", "random"]},
    {"name": "sim_smart_greedy_random", "strategies": ["smart", "greedy", "random"]},
    {"name": "sim_3greedy", "strategies": ["greedy", "greedy", "greedy"]},
    {"name": "sim_3smart", "strategies": ["smart", "smart", "smart"]},
]


def cmd_network() -> None:
    """Generate the resource network JSON."""
    output_path = PUBLISH_DIR / "network.json"
    cards = parse_cards(DATA_DIR / "Cards.csv")
    contracts = parse_contracts(DATA_DIR / "Contracts.csv")
    net = build_network(cards, contracts)
    export_network(net, output_path)
    print(f"Network exported to {output_path}")


def cmd_simulate(args: argparse.Namespace) -> None:
    """Run a single Monte Carlo simulation."""
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


def cmd_simulate_all(args: argparse.Namespace) -> None:
    """Run all standard scenarios and save full results."""
    cards = parse_cards(DATA_DIR / "Cards.csv")
    contracts = parse_contracts(DATA_DIR / "Contracts.csv")
    FULL_DIR.mkdir(parents=True, exist_ok=True)

    for scenario in SCENARIOS:
        config = SimulationConfig(
            num_simulations=args.runs,
            num_players=DEFAULT_NUM_PLAYERS,
            randomize_market=True,
            strategy="greedy",
            player_strategies=scenario["strategies"],
        )

        strat_desc = ", ".join(scenario["strategies"])
        print(f"Running {scenario['name']} ({strat_desc})...")

        results = run_monte_carlo(cards, contracts, config)
        output = FULL_DIR / f"{scenario['name']}.json"
        export_results(results, output)

        print(f"  → {output} | avg NW: ${results.avg_net_worth:.0f}, contracts: {results.avg_contracts:.1f}")

    print(f"\nAll scenarios complete. Full data in {FULL_DIR}/")
    print("Run 'analyze' to generate analysis, then 'publish' to create trimmed files.")


def cmd_analyze() -> None:
    """Analyze simulation data and export analysis.json."""
    data = export_analysis()

    # Look for full data first, fall back to publish data
    full_files = list(FULL_DIR.glob("sim_*.json"))
    publish_files = list(PUBLISH_DIR.glob("sim_*.json"))
    sim_files = full_files if full_files else publish_files

    if sim_files:
        data["sim_contract_costs"] = analyze_sim_contracts(sim_files)
        data["sim_building_costs"] = analyze_sim_building_costs(sim_files)
        data["rate_value_curves"] = compute_rate_value_curves()
        data["resource_flows"] = compute_resource_flows(sim_files)
        data["corporations"] = analyze_corporations(sim_files)
        data["building_value"] = analyze_building_value(sim_files)
        data["market_dynamics"] = analyze_market_dynamics(sim_files)
        source = "full" if full_files else "publish"
        print(f"Analyzed {len(sim_files)} simulation files (from {source} data)")

    output = PUBLISH_DIR / "analysis.json"
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


def cmd_publish(args: argparse.Namespace) -> None:
    """Create trimmed simulation files for GitHub Pages deployment."""
    full_files = list(FULL_DIR.glob("sim_*.json"))
    if not full_files:
        print(f"No full data found in {FULL_DIR}/. Run 'simulate-all' first.")
        return

    keep = args.games
    PUBLISH_DIR.mkdir(parents=True, exist_ok=True)

    for f in full_files:
        with open(f) as fh:
            data = json.load(fh)

        games = data["games"]
        n = len(games)

        if n > keep:
            # Sort by player 0 net worth to sample across the distribution
            games.sort(key=lambda g: g["players"][0]["net_worth"])
            indices = [int(i * (n - 1) / (keep - 1)) for i in range(keep)]
            sampled = [games[i] for i in indices]
            for i, g in enumerate(sampled):
                g["game_id"] = i
            data["games"] = sampled

        out = PUBLISH_DIR / f.name
        with open(out, "w") as fh:
            json.dump(data, fh)

        orig_mb = f.stat().st_size / 1024 / 1024
        new_mb = out.stat().st_size / 1024 / 1024
        print(f"  {f.name}: {orig_mb:.1f}MB → {out.name}: {new_mb:.1f}MB ({len(data['games'])} games)")

    print(f"\nPublish-ready files in {PUBLISH_DIR}/")
    print("Commit and push to deploy.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Board game analysis tools")
    sub = parser.add_subparsers(dest="command")

    # network
    sub.add_parser("network", help="Generate resource network JSON")

    # simulate (single run)
    sim = sub.add_parser("simulate", help="Run Monte Carlo simulation")
    sim.add_argument("-n", "--runs", type=int, default=100, help="Number of simulations")
    sim.add_argument("-p", "--players", type=int, default=1, help="Number of players")
    sim.add_argument("-m", "--money", type=int, default=20, help="Starting money")
    sim.add_argument("--market-pos", type=int, default=DEFAULT_MARKET_POS, help="Starting market position")
    sim.add_argument("--randomize-market", action="store_true", help="Randomize starting prices")
    sim.add_argument("-t", "--turns", type=int, default=DEFAULT_MAX_TURNS, help="Turns per player")
    sim.add_argument("-s", "--strategy", choices=["greedy", "random", "smart"], default="greedy",
                     help="Default strategy for all players")
    sim.add_argument("--player-strategies", nargs="+", choices=["greedy", "random", "smart"],
                     help="Per-player strategies, e.g. --player-strategies greedy random random")
    sim.add_argument("-o", "--output", default="frontend/data/simulation.json")

    # simulate-all (all standard scenarios)
    sim_all = sub.add_parser("simulate-all", help="Run all standard scenarios (full data)")
    sim_all.add_argument("-n", "--runs", type=int, default=500, help="Simulations per scenario")

    # analyze
    sub.add_parser("analyze", help="Generate analysis.json from simulation data")

    # publish
    pub = sub.add_parser("publish", help="Create trimmed sim files for deployment")
    pub.add_argument("-g", "--games", type=int, default=50, help="Games to keep per scenario")

    args = parser.parse_args()

    match args.command:
        case "network":
            cmd_network()
        case "simulate":
            cmd_simulate(args)
        case "simulate-all":
            cmd_simulate_all(args)
        case "analyze":
            cmd_analyze()
        case "publish":
            cmd_publish(args)
        case _:
            parser.print_help()


if __name__ == "__main__":
    main()
