# Mars Colony Playtest Explorer

A board game about building a Mars colony: playable in the browser, backed by a Monte Carlo simulator and analytics dashboard for balance tuning.

**Live site:** https://rtjeannier.github.io/play-test-explorer/

## Play

[play.html](https://rtjeannier.github.io/play-test-explorer/play.html) — browser-based hot-seat game powered by Pyodide. Configure seats with any mix of humans and AI strategies (Smart, Greedy, Random), set player names and round count, then play.

## Analytics

[compare.html](https://rtjeannier.github.io/play-test-explorer/compare.html) — aggregate analytics across thousands of simulated games. Strategy performance, building value edges, contract economics, market dynamics with per-game trajectory spread, and per-segment income breakdowns.

## Simulation CLI

```bash
uv sync                                         # Install dependencies
uv run python -m my_project simulate-all        # Run all standard scenarios (5 x 500 games)
uv run python -m my_project analyze             # Generate analysis.json from sim data
uv run python -m my_project sync-play           # Copy Python sources to frontend for Pyodide
```

See `uv run python -m my_project --help` for single-scenario runs and other options.

## Development

```bash
uv run pytest                                   # Run tests
```

Rules summary and design notes are in [context/DESIGN-DOC.md](context/DESIGN-DOC.md).

## What's implemented (v0.1.0)

- 3 corporations with asymmetric starting rates
- 9 resources with market price dynamics
- Building, selling, contract fulfillment
- Power Bills, Debt Collection, Futures Settlements, PWR Adjust events
- One-build-per-turn rule, pool swapping
- 3 AI strategies (random, greedy, smart)
- Per-player colors and editable seat names

## Not yet implemented

- News events (market-moving / resource-costing)
- Special buildings (Hacker Array, Space Elevator, Launch Pad, etc.)
- Patent auctions
- Discard-to-refresh-market, discard-two-for-guaranteed-contract
- Sell-once-per-resource-per-turn limit
