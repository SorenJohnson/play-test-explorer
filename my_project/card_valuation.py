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

    Forces all special buildings and patents to the same base value
    ($20) during exploration so the AI builds them all equally. This
    prevents the regression from being biased by the AI's prior
    avoidance of "low-value" cards.

    Includes timing interaction terms: each card gets early/mid/late
    features based on when it was acquired relative to total turns.

    Returns a dict-of-lists dataset suitable for regression.
    """
    from my_project.strategies import (
        _get_learned_card_values,
        _learned_card_values,
        optimal_strategy,
        random_strategy,
    )
    import my_project.strategies as strat_mod

    # Force flat base values so the AI explores all buildings equally
    flat_values = {name: 20.0 for name in ALL_CARD_NAMES}
    strat_mod._learned_card_values = flat_values

    strategies_pool = [
        [optimal_strategy] * num_players,
        [random_strategy] * num_players,
        [optimal_strategy, random_strategy, random_strategy],
    ]

    cards = parse_cards(DATA_DIR / "Cards.csv")
    contracts = parse_contracts(DATA_DIR / "Contracts.csv")

    # Feature columns: binary flags + timing interactions + controls
    data: dict[str, list] = {
        "net_worth": [],
        "num_buildings": [],
        "total_positive_rates": [],
        "contracts_fulfilled": [],
        "money": [],
    }
    for name in ALL_CARD_NAMES:
        data[name] = []               # binary: 1 if owned
        data[f"{name}_early"] = []    # 1 if acquired in first third of game
        data[f"{name}_mid"] = []      # 1 if acquired in middle third
        data[f"{name}_late"] = []     # 1 if acquired in last third

    for game_idx in range(n_games):
        strats = strategies_pool[game_idx % len(strategies_pool)]
        state = run_game(
            all_cards=cards,
            all_contracts=contracts,
            strategies=strats,
            num_players=num_players,
            randomize_market=True,
            num_rounds=num_rounds,
        )

        # Figure out total turns for timing buckets
        total_turns = len(state.history)
        third = max(total_turns // 3, 1)

        # Build a map: player_name → {building_name: turn_acquired}
        build_turns: dict[str, dict[str, int]] = {
            p.name: {} for p in state.players
        }
        for turn_idx, rec in enumerate(state.history):
            for action_rec in rec.actions:
                for bname in action_rec.buildings:
                    if bname not in build_turns[rec.player]:
                        build_turns[rec.player][bname] = turn_idx
            # Patent auctions show in the event detail
            if "patent auction:" in rec.event.lower() and "won" in rec.event.lower():
                # Parse "patent auction: Player_2 won Superconductors for $15 debt"
                parts = rec.event.split("won")
                if len(parts) >= 2:
                    patent_part = parts[1].strip().split(" for")[0].strip()
                    if patent_part and rec.player in build_turns:
                        build_turns[rec.player][patent_part] = turn_idx

        for player in state.players:
            owned = set(player.building_names())
            p_turns = build_turns.get(player.name, {})

            for name in ALL_CARD_NAMES:
                has_it = 1 if name in owned else 0
                data[name].append(has_it)

                # Timing: when was it acquired?
                acq_turn = p_turns.get(name, -1)
                if has_it and acq_turn >= 0:
                    data[f"{name}_early"].append(1 if acq_turn < third else 0)
                    data[f"{name}_mid"].append(1 if third <= acq_turn < 2 * third else 0)
                    data[f"{name}_late"].append(1 if acq_turn >= 2 * third else 0)
                else:
                    data[f"{name}_early"].append(0)
                    data[f"{name}_mid"].append(0)
                    data[f"{name}_late"].append(0)

            # Control variables
            data["num_buildings"].append(len(player.buildings_played))
            data["total_positive_rates"].append(
                sum(v for v in player.rates.values() if v > 0)
            )
            data["contracts_fulfilled"].append(player.contracts_fulfilled)
            data["money"].append(player.money)
            # Target
            data["net_worth"].append(player.net_worth())

    # Restore the real learned values (we forced flat values for exploration)
    strat_mod._learned_card_values = None  # force reload from CSV on next access

    return data


def fit_card_values(data: dict[str, list]) -> dict[str, dict]:
    """Fit OLS linear regression and return per-card value estimates.

    Model includes:
    - Binary flags for each card (owned or not)
    - Timing interactions: early/mid/late acquisition for each card
    - Control variables: num_buildings, total_positive_rates, contracts

    The "value" for each card is the base coefficient. The timing
    coefficients show how much MORE the card is worth when acquired
    early vs late.

    Returns a dict mapping card name → {"value", "std_err", "early", "mid", "late"}.
    """
    n = len(data["net_worth"])
    y = np.array(data["net_worth"], dtype=float)

    # Build feature matrix: card flags + timing + controls
    # Base card flags
    feature_names = list(ALL_CARD_NAMES)
    # Timing interaction terms
    timing_features = []
    for name in ALL_CARD_NAMES:
        for period in ("early", "mid", "late"):
            key = f"{name}_{period}"
            if key in data:
                timing_features.append(key)
    feature_names += timing_features
    # Control variables
    feature_names += [
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
    # Build a name→index map for easy lookup
    name_to_idx = {name: i + 1 for i, name in enumerate(feature_names)}

    for name in ALL_CARD_NAMES:
        idx = name_to_idx.get(name)
        if idx is None:
            continue
        entry: dict = {
            "value": round(float(beta[idx]), 1),
            "std_err": round(float(std_errs[idx]), 1),
        }
        # Timing coefficients
        for period in ("early", "mid", "late"):
            key = f"{name}_{period}"
            tidx = name_to_idx.get(key)
            if tidx is not None:
                entry[period] = round(float(beta[tidx]), 1)
        results[name] = entry

    # Also include control variable coefficients
    for ctrl in ("num_buildings", "total_positive_rates", "contracts_fulfilled"):
        idx = name_to_idx.get(ctrl)
        if idx is not None:
            results[ctrl] = {
                "value": round(float(beta[idx]), 1),
                "std_err": round(float(std_errs[idx]), 1),
            }

    return results


def export_card_values(results: dict[str, dict], path: Path) -> None:
    """Write learned card values to CardValues.csv."""
    with open(path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["Card", "Type", "Learned_Value", "Std_Error", "Early_Bonus", "Mid_Bonus", "Late_Bonus"])
        for name in SPECIAL_BUILDINGS:
            if name in results:
                r = results[name]
                writer.writerow([
                    name, "special", r["value"], r["std_err"],
                    r.get("early", ""), r.get("mid", ""), r.get("late", ""),
                ])
        for name in PATENTS:
            if name in results:
                r = results[name]
                writer.writerow([
                    name, "patent", r["value"], r["std_err"],
                    r.get("early", ""), r.get("mid", ""), r.get("late", ""),
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
    print(f"{'Card':<25} {'Base':>7} {'Early':>7} {'Mid':>7} {'Late':>7} {'± SE':>7}")
    print("-" * 65)

    # Sort by value descending
    card_results = [
        (name, results[name]) for name in ALL_CARD_NAMES if name in results
    ]
    card_results.sort(key=lambda x: -x[1]["value"])
    for name, r in card_results:
        early = f"${r['early']:+.0f}" if "early" in r else "—"
        mid = f"${r['mid']:+.0f}" if "mid" in r else "—"
        late = f"${r['late']:+.0f}" if "late" in r else "—"
        print(f"  {name:<23} ${r['value']:>5.0f}  {early:>6} {mid:>6} {late:>6}  ±${r['std_err']:.0f}")

    # Export research JSON (for frontend display — doesn't change AI behavior)
    import json
    research_path = Path("frontend/data/card_valuation.json")
    research_data = {
        "meta": meta,
        "cards": [
            {
                "name": name,
                "type": "special" if name in SPECIAL_BUILDINGS else "patent",
                "base_value": r["value"],
                "early_bonus": r.get("early", 0),
                "mid_bonus": r.get("mid", 0),
                "late_bonus": r.get("late", 0),
                "early_total": r["value"] + r.get("early", 0),
                "mid_total": r["value"] + r.get("mid", 0),
                "late_total": r["value"] + r.get("late", 0),
                "std_err": r["std_err"],
            }
            for name, r in card_results
        ],
    }
    research_path.parent.mkdir(parents=True, exist_ok=True)
    with open(research_path, "w") as f:
        json.dump(research_data, f, indent=2)
    print(f"\nResearch data → {research_path}")

    # Export CSV (updates AI behavior only when explicitly run)
    out_path = DATA_DIR / "CardValues.csv"
    export_card_values(results, out_path)
    print(f"AI values   → {out_path}")
    print("\n💡 To use these values in the AI, commit CardValues.csv.")
    print("   To just view results, check the Research tab in the analytics dashboard.")

    return results
