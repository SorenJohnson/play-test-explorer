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

    Forces exploration values scaled to each building's build cost so
    ALL specials get built at roughly equal rates. Without this,
    expensive buildings (OC, PO, SE) would never get built and the
    regression would have no data for them.

    Includes timing interaction terms: each card gets early/mid/late
    features based on when it was acquired relative to total turns.

    Returns a dict-of-lists dataset suitable for regression.
    """
    from my_project.strategies import (
        _get_learned_card_values,
        _learned_card_values,
        optimal_strategy,
        smart_greedy_strategy,
        random_strategy,
    )
    import my_project.strategies as strat_mod

    cards = parse_cards(DATA_DIR / "Cards.csv")
    contracts = parse_contracts(DATA_DIR / "Contracts.csv")

    # No forced exploration — AI plays normally using mechanical floor +
    # current learned values. Natural card draw variation provides the
    # data. This avoids distorting play with forced suboptimal decisions.
    strategies_pool = [
        [optimal_strategy, smart_greedy_strategy, random_strategy],
    ]

    data: dict[str, list] = {
        "net_worth": [],
        "num_buildings": [],
        "total_positive_rates": [],
        "contracts_fulfilled": [],
        "money": [],
        "game_avg_nw": [],  # average NW of all players in this game (normalizer)
    }
    for name in ALL_CARD_NAMES:
        data[name] = []               # binary: 1 if owned
        data[f"{name}_early"] = []    # 1 if acquired in first third of game
        data[f"{name}_mid"] = []      # 1 if acquired in middle third
        data[f"{name}_late"] = []     # 1 if acquired in last third
    # Track patent source: 1 = auction, 0 = PO or unknown
    for name in PATENTS:
        data[f"{name}_auction"] = []

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

        # Build maps: player → {building: turn}, player → {patent: source}
        build_turns: dict[str, dict[str, int]] = {
            p.name: {} for p in state.players
        }
        auction_patents: dict[str, set[str]] = {
            p.name: set() for p in state.players
        }
        for turn_idx, rec in enumerate(state.history):
            for action_rec in rec.actions:
                for bname in action_rec.buildings:
                    if bname not in build_turns[rec.player]:
                        build_turns[rec.player][bname] = turn_idx
            # Patent auctions show in the event detail
            if "patent auction:" in rec.event.lower() and "won" in rec.event.lower():
                parts = rec.event.split("won")
                if len(parts) >= 2:
                    patent_part = parts[1].strip().split(" for")[0].strip()
                    if patent_part and rec.player in build_turns:
                        build_turns[rec.player][patent_part] = turn_idx
                        auction_patents[rec.player].add(patent_part)

        # Only include seat 0 (optimal player)
        for player in state.players[:1]:
            owned = set(player.building_names())
            p_turns = build_turns.get(player.name, {})
            p_auctions = auction_patents.get(player.name, set())

            # Patents from Patent Office: tag with PO's build turn
            po_turn = p_turns.get("Patent Office", -1)
            if po_turn >= 0:
                for name in PATENTS:
                    if name in owned and name not in p_turns:
                        p_turns[name] = po_turn

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

            # Patent source tracking
            for name in PATENTS:
                data[f"{name}_auction"].append(
                    1 if name in p_auctions else 0
                )

            # Control variables
            data["num_buildings"].append(len(player.buildings_played))
            data["total_positive_rates"].append(
                sum(v for v in player.rates.values() if v > 0)
            )
            data["contracts_fulfilled"].append(player.contracts_fulfilled)
            data["money"].append(player.money)
            # Game-level normalizer: avg NW across all players
            game_avg_nw = sum(p.net_worth() for p in state.players) / len(state.players)
            data["game_avg_nw"].append(game_avg_nw)
            # Target
            data["net_worth"].append(player.net_worth())

    # Restore normal mode
    strat_mod._learned_card_values = None  # force reload from CSV on next access
    strat_mod._card_values_full = None  # force reload from CSV on next access

    # Cache to disk so we can re-fit the regression without re-running games
    import json
    cache_path = DATA_DIR / "exploration_data.json"
    with open(cache_path, "w") as f:
        json.dump(data, f)

    return data


def fit_card_values(
    data: dict[str, list],
    card_names: list[str] | None = None,
    periods: tuple[str, ...] = ("early", "mid", "late"),
) -> dict[str, dict]:
    """Fit OLS linear regression and return per-card value estimates.

    Model uses timing binary features ONLY. If you own a card, exactly
    one timing flag is 1; if you don't, all are 0.

    `periods` controls which timing columns to include. Default is
    ("early", "mid", "late"). For patents (auction-only, first half),
    use ("early", "mid").

    Returns a dict mapping card name → {period: value, ...}.
    """
    if card_names is None:
        card_names = ALL_CARD_NAMES

    n = len(data["net_worth"])
    nw = np.array(data["net_worth"], dtype=float)
    # Predict NW above game average — isolates "did this patent help you
    # beat other players" from market-driven NW swings.
    if "game_avg_nw" in data:
        avg = np.array(data["game_avg_nw"], dtype=float)
        y = nw - avg
    else:
        y = nw

    # Build feature matrix: timing-only, no controls
    feature_names: list[str] = []
    for name in card_names:
        for period in periods:
            key = f"{name}_{period}"
            if key in data:
                feature_names.append(key)

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
    name_to_idx = {name: i + 1 for i, name in enumerate(feature_names)}

    for name in card_names:
        entry: dict[str, float] = {}
        for period in periods:
            key = f"{name}_{period}"
            tidx = name_to_idx.get(key)
            if tidx is not None:
                entry[period] = round(float(beta[tidx]), 1)
                entry[f"{period}_se"] = round(float(std_errs[tidx]), 1)
        if entry:
            results[name] = entry

    return results


def export_card_values(results: dict[str, dict], path: Path) -> None:
    """Write learned card values to CardValues.csv.

    New format: Early/Mid/Late are the direct regression coefficients
    (value of acquiring the card at that game phase), not base + bonus.
    Learned_Value is the average of the three phases for backward compat.
    """
    with open(path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["Card", "Type", "Learned_Value", "Std_Error", "Early_Bonus", "Mid_Bonus", "Late_Bonus"])
        for name in PATENTS:
            if name not in results:
                continue
            r = results[name]
            early = r.get("early", 0)
            mid = r.get("mid", 0)
            avg = round((early + mid) / 2, 1)
            writer.writerow([name, "patent", avg, 0.0, early, mid, 0])


def _print_regression(label: str, results: dict[str, dict], card_names: list[str]) -> list[tuple[str, dict]]:
    """Print a regression results table. Returns sorted (name, entry) list."""
    meta = results["_meta"]
    print(f"\n{'=' * 55}")
    print(f"  {label}")
    print(f"  R² = {meta['r_squared']:.3f}, intercept = ${meta['intercept']:.0f}, n = {meta['n_observations']}")
    print(f"{'=' * 55}")
    print(f"{'Card':<25} {'Early':>8} {'Mid':>8} {'Late':>8}")
    print("-" * 55)

    card_results = [
        (name, results[name]) for name in card_names if name in results
    ]
    # Sort by best phase value descending
    card_results.sort(key=lambda x: -max(
        x[1].get("early", 0), x[1].get("mid", 0), x[1].get("late", 0),
    ))
    for name, r in card_results:
        early = f"${r['early']:+.0f}" if "early" in r else "—"
        mid = f"${r['mid']:+.0f}" if "mid" in r else "—"
        late = f"${r['late']:+.0f}" if "late" in r else "—"
        print(f"  {name:<23} {early:>7}  {mid:>7}  {late:>7}")
    return card_results


def run_evaluation(
    n_games: int = 2000,
    num_players: int = 3,
    refit: bool = False,
) -> dict[str, dict]:
    """Full pipeline: collect data, fit two separate models, export values.

    Runs two independent regressions:
    1. Specials-only: features are special building flags (no patents)
    2. Patents-only: features are patent flags (no specials)

    When `refit=True`, loads cached exploration data from disk instead
    of re-running games. Use this to iterate on the regression model
    without waiting for 1500 games.
    """
    if refit:
        import json
        cache_path = DATA_DIR / "exploration_data.json"
        if not cache_path.exists():
            print("No cached data — run without --refit first.")
            return {}
        print(f"Loading cached exploration data from {cache_path}...")
        with open(cache_path) as f:
            data = json.load(f)
    else:
        print(f"Running {n_games} exploration games ({num_players} players, optimal+smart+random)...")
        data = collect_valuation_data(n_games, num_players)
    n_obs = len(data["net_worth"])
    print(f"Collected {n_obs} player observations.")

    # --- Patent regression (auction-acquired, early+mid) ---
    # Patents with timing flags came from auctions (event parser).
    # PO-granted patents have no timing (all zeros) and don't affect
    # early/mid coefficients. No specials regression — specials are
    # valued by the mechanical heuristic at runtime.
    print("\nFitting patent regression (auction-acquired, early+mid)...")
    results = fit_card_values(data, card_names=PATENTS, periods=("early", "mid"))
    patent_cards = _print_regression(
        "PATENTS (auction-acquired, early+mid)",
        results, PATENTS,
    )

    # Export research JSON
    import json
    research_path = Path("frontend/data/card_valuation.json")
    research_data = {
        "meta": results["_meta"],
        "cards": [
            {
                "name": name,
                "type": "patent",
                "early_total": r.get("early", 0),
                "mid_total": r.get("mid", 0),
                "late_total": 0,
                "base_value": round(
                    (r.get("early", 0) + r.get("mid", 0)) / 2, 1
                ),
                "early_bonus": 0,
                "mid_bonus": 0,
                "late_bonus": 0,
                "std_err": 0.0,
            }
            for name, r in patent_cards
        ],
    }
    research_path.parent.mkdir(parents=True, exist_ok=True)
    with open(research_path, "w") as f:
        json.dump(research_data, f, indent=2)
    print(f"\nResearch data → {research_path}")

    # Export CSV (patents only — specials use mechanical heuristic)
    out_path = DATA_DIR / "CardValues.csv"
    export_card_values(results, out_path)
    print(f"AI values   → {out_path}")
    print("\n💡 To use these values in the AI, commit CardValues.csv.")
    print("   Special buildings are valued by mechanical heuristic (no regression).")

    return results
