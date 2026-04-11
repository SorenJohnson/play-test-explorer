"""Empirical card valuation via Monte Carlo regression.

Runs exploration games with random AI strategies, collects per-player
outcome data, and fits a linear regression to discover each special
building's and patent's intrinsic dollar value.

Usage:
    uv run python -m my_project evaluate-cards -n 2000 -p 3
"""

from __future__ import annotations

import csv
import random
from pathlib import Path

import numpy as np

from my_project.models import Resource
from my_project.parsing import parse_cards, parse_contracts
from my_project.simulation import GameState, Player, run_game

DATA_DIR = Path(__file__).parent / "data"

# Cards we want to learn values for. These are the slot-4 specials and
# slot-5 patents whose effects are hard to value from heuristics alone.
SPECIAL_BUILDINGS = [
    "Pleasure Dome",
    "Optimization Center",
    "Space Elevator",
    "Hacker Array",
    "Launch Pad",
    "Patent Office",
]

PATENTS = [
    "Superconductors",
    "Energy Vault",
    "Financial Instruments",
    "Water Engine",
    "Nanotechnology",
    "Cold Fusion",
    "Virtual Reality",
    "Perpetual Motion",
    "Carbon Scrubbing",
    "Slant Drilling",
    "Thinking Machines",
    "Teleportation",
]

ALL_CARD_NAMES = SPECIAL_BUILDINGS + PATENTS


def collect_valuation_data(
    n_games: int = 2000,
    num_players: int = 3,
    num_rounds: int = 2,
) -> dict[str, list]:
    """Run exploration games and collect per-player feature/outcome data.

    Uses random_strategy for broad coverage of building/patent choices.
    Returns a dict-of-lists dataset suitable for regression.
    """
    from my_project.strategies import random_strategy, smart_greedy_strategy

    # Use a mix of strategies for broad coverage: smart plays well but
    # builds specials when valuable; random explores more card combinations.
    strategies_pool = [
        [smart_greedy_strategy] * num_players,
        [random_strategy] * num_players,
        [smart_greedy_strategy, random_strategy, random_strategy],
    ]

    cards = parse_cards(DATA_DIR / "Cards.csv")
    contracts = parse_contracts(DATA_DIR / "Contracts.csv")

    # Feature columns: one binary flag per card + control variables
    data: dict[str, list] = {
        "net_worth": [],
        "num_buildings": [],
        "total_positive_rates": [],
        "contracts_fulfilled": [],
        "money": [],
    }
    for name in ALL_CARD_NAMES:
        data[name] = []

    for _ in range(n_games):
        # Rotate through strategy mixes for diverse data
        strats = strategies_pool[_ % len(strategies_pool)]
        state = run_game(
            all_cards=cards,
            all_contracts=contracts,
            strategies=strats,
            num_players=num_players,
            randomize_market=True,
            num_rounds=num_rounds,
        )
        for player in state.players:
            owned = set(player.building_names())
            # Binary features for each tracked card
            for name in ALL_CARD_NAMES:
                data[name].append(1 if name in owned else 0)
            # Control variables
            data["num_buildings"].append(len(player.buildings_played))
            data["total_positive_rates"].append(
                sum(v for v in player.rates.values() if v > 0)
            )
            data["contracts_fulfilled"].append(player.contracts_fulfilled)
            data["money"].append(player.money)
            # Target
            data["net_worth"].append(player.net_worth())

    return data


def fit_card_values(data: dict[str, list]) -> dict[str, dict]:
    """Fit OLS linear regression and return per-card value estimates.

    Model: NW ~ β₀ + Σ βᵢ·card_i + γ₁·num_buildings + γ₂·positive_rates + γ₃·contracts

    Returns a dict mapping card name → {"value": float, "std_err": float}.
    Also includes R² and intercept in the "_meta" key.
    """
    n = len(data["net_worth"])
    y = np.array(data["net_worth"], dtype=float)

    # Build feature matrix: card flags + control variables
    feature_names = list(ALL_CARD_NAMES) + [
        "num_buildings", "total_positive_rates", "contracts_fulfilled",
    ]
    X = np.ones((n, len(feature_names) + 1), dtype=float)  # +1 for intercept
    for i, name in enumerate(feature_names):
        X[:, i + 1] = np.array(data[name], dtype=float)

    # OLS: β = (X'X)⁻¹ X'y
    XtX = X.T @ X
    Xty = X.T @ y
    try:
        beta = np.linalg.solve(XtX, Xty)
    except np.linalg.LinAlgError:
        # Singular matrix — add tiny regularization
        beta = np.linalg.solve(XtX + 1e-6 * np.eye(XtX.shape[0]), Xty)

    # R²
    y_hat = X @ beta
    ss_res = np.sum((y - y_hat) ** 2)
    ss_tot = np.sum((y - np.mean(y)) ** 2)
    r_squared = 1 - ss_res / ss_tot if ss_tot > 0 else 0.0

    # Standard errors
    residual_var = ss_res / max(n - len(beta), 1)
    try:
        cov = residual_var * np.linalg.inv(XtX)
        std_errs = np.sqrt(np.diag(cov))
    except np.linalg.LinAlgError:
        std_errs = np.zeros(len(beta))

    # Package results
    results: dict[str, dict] = {
        "_meta": {
            "r_squared": round(r_squared, 4),
            "intercept": round(float(beta[0]), 1),
            "n_observations": n,
        }
    }
    for i, name in enumerate(feature_names):
        results[name] = {
            "value": round(float(beta[i + 1]), 1),
            "std_err": round(float(std_errs[i + 1]), 1),
        }

    return results


def export_card_values(results: dict[str, dict], path: Path) -> None:
    """Write learned card values to CardValues.csv."""
    with open(path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["Card", "Type", "Learned_Value", "Std_Error"])
        for name in SPECIAL_BUILDINGS:
            if name in results:
                writer.writerow([
                    name, "special",
                    results[name]["value"],
                    results[name]["std_err"],
                ])
        for name in PATENTS:
            if name in results:
                writer.writerow([
                    name, "patent",
                    results[name]["value"],
                    results[name]["std_err"],
                ])


def run_evaluation(
    n_games: int = 2000,
    num_players: int = 3,
) -> dict[str, dict]:
    """Full pipeline: collect data, fit model, export values, print report."""
    print(f"Running {n_games} exploration games ({num_players} players, random strategy)...")
    data = collect_valuation_data(n_games, num_players)
    n_obs = len(data["net_worth"])
    print(f"Collected {n_obs} player observations.")

    print("\nFitting OLS regression...")
    results = fit_card_values(data)

    meta = results["_meta"]
    print(f"R² = {meta['r_squared']:.3f}, intercept = ${meta['intercept']:.0f}")

    print(f"\nCard Values (learned from {n_games} games):")
    print(f"{'Card':<25} {'Value':>8} {'± Std Err':>10}")
    print("-" * 45)

    # Sort by value descending
    card_results = [
        (name, results[name]) for name in ALL_CARD_NAMES if name in results
    ]
    card_results.sort(key=lambda x: -x[1]["value"])
    for name, r in card_results:
        print(f"  {name:<23} ${r['value']:>6.1f}   ± ${r['std_err']:.1f}")

    # Export
    out_path = DATA_DIR / "CardValues.csv"
    export_card_values(results, out_path)
    print(f"\nExported to {out_path}")

    return results
