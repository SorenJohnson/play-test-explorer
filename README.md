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

## What's implemented (v0.2.0)

**Core game**
- 3 corporations with asymmetric starting rates
- 9 resources with market price dynamics
- Building, selling, contract fulfillment
- One-build-per-turn rule, pool swapping
- 3 AI strategies (random, greedy, smart)
- Per-player colors and editable seat names

**Events**
- Power Bills, Debt Collection, Futures Settlements, PWR Adjust
- News Bulletins (rate_all / market_random / trigger effects from a 13-card news deck)
- Draw Building Card events (refresh the pool)
- Patent Auctions (silent auction with pre-declared human bids)
- Redraw cascades (some events fire two cards in a single player-turn)
- Configurable event deck via JSON in the New Game modal

**Special buildings (Slot-4)**
- Pleasure Dome (per-dome power-bill bonus)
- Optimization Center (pre-futures rate boost)
- Space Elevator (-1 to all contract requirements)
- Hacker Array (passive on-sell market bump)
- Patent Office (draw 2 patents on build, keep best)

**Patents**
- 10-card patent pile
- Silent auction with `runner_up + $5` debt cost
- Pre-declared human bids via the play UI; AI heuristic for non-declarers

## Not yet implemented

- Launch Pad ("Free Action: Fulfill Contract") — needs per-turn action limits
- News "resource cost" semantics (the rules mention this but it's not implemented yet)
- Discard-to-refresh-market action
- Sell-once-per-resource-per-turn limit
- News event "redraw" semantics from the rules
- Mid-event modal interruptions for human auction bids (currently uses pre-declaration)
