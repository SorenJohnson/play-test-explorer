# Mars Colony Playtest Explorer

A Python rules engine for a Mars-colony board game with three surfaces built on top: a WebRTC multiplayer web game (Pyodide + PeerJS), an analytics dashboard, and a Monte Carlo CLI. Started as surface #3, grew the others.

## Commands

```bash
uv sync                                          # Install dependencies
uv run pytest                                    # Run tests (285 tests, <2s)
uv run python -m my_project simulate-all         # Monte Carlo runs (5 x 500 games)
uv run python -m my_project analyze              # Produce analysis.json
uv run python -m my_project sync-play            # Copy sources into frontend/data/game/ for Pyodide
uv add <package>                                 # Add a dependency
```

`sync-play` is also run by the devcontainer on create and by the deploy workflow on push; only run it manually when iterating on `my_project/` and wanting to see it in the browser immediately.

## Architecture

Full map: [context/DESIGN-DOC.md](context/DESIGN-DOC.md). Short version:

- `my_project/` — **single source of truth for game rules**. `simulation.py` is the engine (~3.1k lines, next refactor target); `play_adapter.py` is a stepwise wrapper for interactive play; `strategies.py` holds the AI players; `data/*.csv` are hand-edited card/contract/event/news tables.
- `frontend/` — six classic-script files sharing state via `window.MP`. The coordinator is `multiplayer.js` (80 lines); real work is in `multiplayer-{debug,animations,ui,network,core}.js`. Host runs Python via Pyodide; clients render broadcast state.
- `frontend/data/game/my_project/` — **generated Pyodide bundle**, gitignored. Produced by `sync-play`.
- `tests/` — pytest, behavioral (observable outcomes, not log-shape assertions). CI gates PRs on green.

## Conventions

- Python >=3.10; modern syntax (type hints, match, dict union)
- `uv` for dependency management (never pip)
- Tests mirror the package structure under `tests/`
- Observable-state pattern: every engine mutation flows through `models.Currency` / `ResourceRates` / `CardZone` and lands in `GameLog.action_log`. Don't mutate `player.money` with `+=` — use the wrappers.
- Frontend modules share mutable state via `window.MP.*`; each module wraps its own code in an IIFE and exposes its public surface on `MP.<namespace>`.
- When touching `my_project/*.py`, remember that the file list in [cli.py `py_files`](my_project/cli.py) and [multiplayer-core.js `PY_FILES`](frontend/multiplayer-core.js) must stay in sync for the browser to load it.

## Context

- [context/DESIGN-DOC.md](context/DESIGN-DOC.md) — architecture map (module responsibilities, data flow, sync pipeline)
- [context/RULES.md](context/RULES.md) — game rules reference
- [context/AI-CARD-GAPS.md](context/AI-CARD-GAPS.md) — cards whose effects work in the play UI but are ignored by AI strategies
- [context/REFACTOR-PLAN.md](context/REFACTOR-PLAN.md) — historical record of the observable-state refactor (v2.0.0-stable)
- [context/FUTURE-UI-UPGRADE.md](context/FUTURE-UI-UPGRADE.md) — planned board-state animations and interactive market

Read DESIGN-DOC before planning anything cross-cutting; read AI-CARD-GAPS before interpreting simulation numbers.
