# Architecture

This doc is the map, not the rulebook. It describes **how the code is laid out** and **how a turn flows through the stack**. Rules and gameplay are covered by [RULES.md](RULES.md); open questions about AI are in [AI-CARD-GAPS.md](AI-CARD-GAPS.md).

## What this project is

A board game about building a Mars colony, with three concurrent surfaces built on the same Python rules engine:

1. **Playable** — [frontend/multiplayer.html](../frontend/multiplayer.html), WebRTC peer-to-peer multiplayer. Pyodide runs the Python engine in the host's browser; PeerJS data channels sync filtered state to every client.
2. **Analytics** — [frontend/compare.html](../frontend/compare.html), aggregate dashboards across thousands of simulated games (strategy performance, building edges, market trajectories).
3. **CLI** — `python -m my_project …` for Monte Carlo runs, analysis, card-value regression, and the Pyodide bundle sync.

It started as surface #3 and grew surfaces #1 and #2 on top of the same engine. The current invariant: **Python in `my_project/` is the single source of truth for game rules**; every surface is a different front door to it.

## Backend (`my_project/`)

Core engine and CLI:

| Module | Responsibility |
|---|---|
| `simulation.py` (~3.1k lines) | Game engine: `GameState`, `Player`, `Market`, `Deck`, action executors, event system, AI turn loop, Monte Carlo runner |
| `models.py` | Observable state wrappers (`Currency`, `ResourceRates`, `CardZone`) + `GameLog` — every mutation flows through these and lands in `action_log` for debug replay |
| `play_adapter.py` (~1.4k lines) | `PlayableGame` — stepwise wrapper over the simulator for interactive play. Owns human-turn sequencing, legal-action enumeration, state serialization |
| `strategies.py` (~1.3k lines) | AI players (`random`, `greedy`, `smart_greedy`, `optimal`) |
| `accounting.py` | Contract cost ledger for post-hoc profit attribution |
| `parsing.py` | CSV loaders for Cards, Contracts, Patents, News, Events, Corporations, GameConfig |
| `cli.py` | Subcommands: `simulate`, `simulate-all`, `analyze`, `publish`, `sync-play`, `evaluate-cards`, `refresh-all` |
| `data/*.csv` | **Source of truth for card text, contract requirements, event definitions, and all tunable knobs.** Hand-edited. |

## Frontend (`frontend/`)

The playable surface is split into six classic-script files sharing state via `window.MP`:

| File | Public surface | Role |
|---|---|---|
| `multiplayer.js` (~80 lines) | — | Coordinator: constants, `MP` state init, lobby button wiring |
| `multiplayer-debug.js` | `MP.debug` | Debug panel + `StateTracker` (replays `action_log` step-by-step) |
| `multiplayer-animations.js` | `MP.anim` | Card motion, reward popups, deck viewer, event banner |
| `multiplayer-ui.js` (~1.4k lines) | `MP.ui` | Rendering + feed formatting + game controls. Biggest file; next refactor target. |
| `multiplayer-network.js` | `MP.network` | PeerJS lobby + host/client message dispatch + transport |
| `multiplayer-core.js` | `MP.core` | Pyodide bootstrap + host game loop + prompt resolution + feed mutators |

Other pages:

- `compare.html` + `compare.js` — analytics dashboard, reads `frontend/data/*.json` bundles
- `research.html`, `index.html` — landing / research-table pages

## Data flow for one multiplayer turn

```
                           ┌─ PeerJS (host) ─┐
                           │   broadcasts    │
Pyodide game engine        │  filtered state │        Client browsers
  (host's browser)   ──────►     per seat    ──────►  (pure JS, no engine)
      ↑                    └─────────────────┘               │
      │                                                      │
      │  apply_human_action(py_dict)                         │
      │  end_human_turn()                                    │
      │  step_ai_turn()                                      │
      │                                                      │
      └──────────────  PeerJS (client → host)  ──────────────┘
                        {type: "action", …}
                        {type: "end_turn"}
                        {type: "prompt_answer", …}
```

Key facts:

- **Only the host runs Python.** Clients receive pre-computed state blobs via `state_for_seat(seatIdx)` and render them. Clients never hold game truth.
- **UI selection state** (`MP.selectedCards`, `selectedContract`, `pendingPoolSwap`) is client-local and ephemeral; host doesn't know about it until the client sends an `action`.
- **Observable state for debugging.** Every mutation in the engine lands in `state.action_log`. The debug panel (backtick key) scrubs through those entries; the "download action log" button serializes the whole game.

## Pyodide sync pipeline

The Python files and CSVs under `my_project/` need to be reachable from the browser. `cli.py` subcommand `sync-play` hard-copies them into `frontend/data/game/my_project/`, which is **gitignored** — it's a generated artifact, not a committed copy. It's regenerated by:

- The devcontainer `post-create.sh` (for local Codespaces work)
- The `deploy-pages.yml` workflow (for every GitHub Pages deploy)

If you edit anything under `my_project/` and want to see the change in the browser, run `uv run python -m my_project.cli sync-play` manually. The `multiplayer-core.js` loader lists the files to fetch — keep `cli.py:py_files` and `multiplayer-core.js:PY_FILES` in sync.

## Testing

- `tests/*.py` — 285 tests, 1.8s runtime, behavioral (test observable game outcomes, not log line counts)
- Coverage hot spots: events ([tests/test_event_deck.py](../tests/test_event_deck.py), 24 tests), patents ([tests/test_patents.py](../tests/test_patents.py), 70 tests), action points ([tests/test_action_points.py](../tests/test_action_points.py)), play adapter ([tests/test_play_adapter.py](../tests/test_play_adapter.py))
- CI ([.github/workflows/test.yml](../.github/workflows/test.yml)) runs pytest + a sync-play smoke check on every PR + push

## Known holes

- No frontend tests. Playwright MCP can drive a browser via Claude Code but there's no automated regression suite.
- `AI-CARD-GAPS.md` lists cards whose effects work in the play UI but aren't used by the AI in Monte Carlo runs — biases simulation results.
- `multiplayer-ui.js` mixes rendering, feed formatting, and user-input handling; needs another split.
- PeerJS message sequencing has no tick counter — out-of-order `feed` vs `game_state` messages are possible but not observed in practice.
