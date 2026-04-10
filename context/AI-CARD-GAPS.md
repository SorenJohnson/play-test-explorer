# AI Card Strategy Gaps

This is a living tracker for cards whose mechanical effects work in the
**interactive play UI** but are **not yet used by the AI** during Monte
Carlo simulation runs (`run_game` / `run_turn` / `step_ai_turn`).

When a card here gets an AI strategy implemented, move it from "Gaps" to
"Closed" with a short note about how the AI handles it. When a card
changes how it works, update the entry in place.

> ⚠️ **Why this matters for Monte Carlo**: cards in the "Gaps" list are
> *strictly worse for the AI* than for humans. AIs that build/win them
> get no value, which biases simulation results — e.g. an Optimization
> Center built by a smart_greedy AI will sit unused. When interpreting
> Monte Carlo numbers, mentally discount any benefit a card in this list
> would normally provide.

---

## Architectural background

The simulation engine has three "shapes" of card effect:

| Shape | How it fires for AI | Examples |
|---|---|---|
| **Build hook** (passive, fires inside `execute_build`) | Automatic — both human and AI builds run the same hooks via `PATENT_BUILD_HOOKS` and the slot-4 `effect` registry. | Superconductors, Cold Fusion, Slant Drilling, Perpetual Motion, Carbon Scrubbing, Energy Vault (build half), Patent Office, Hacker Array (per-sell hook) |
| **Event hook** (passive, fires inside `do_*` event functions) | Automatic for AI — both finalize through the shared event functions. | Pleasure Dome, Energy Vault (Power Bill payout), Financial Instruments, Virtual Reality, Thinking Machines (acquisition draw) |
| **Free action** (active, requires an explicit "use" call) | **Manual only** — invoked via `PlayableGame.use_*` methods from the UI. AI strategies in `my_project/strategies.py` only return `BUILD / SELL / CONTRACT / PASS` actions and have **no path** to invoke free actions. | Optimization Center, Water Engine, Nanotechnology, Teleportation, Space Elevator (toggle), Launch Pad (toggle) |

The "Gaps" section below tracks **free-action cards** the AI does not yet
exercise. Build hooks and event hooks are NOT in this list because they
fire automatically — verifying their AI parity is just "does the test
pass when I call `do_*` or `execute_build` without a `PlayableGame`
instance?".

Space Elevator and Launch Pad are listed for completeness even though
they *are* used by the AI today via flags on the `Action` dataclass
(`use_elevator`, `use_launch_pad`) — meaning the AI invokes them as part
of contract-fulfillment decisions. Other free actions don't fit this
mold and need their own AI plumbing.

---

## Gaps — cards the AI does not yet use

(No open gaps. All known card/rule gaps have been closed.)

---

## Closed — cards the AI now uses correctly

### Optimization Center (slot-4 building) — CLOSED

Auto-fired at start of every AI turn via `_execute_free_actions()` in
`simulation.py`. Picks the highest-priced positive non-PWR rate.

### Water Engine (patent) — CLOSED

Auto-fired via `_execute_free_actions()` when H2O rate ≥ 1.

### Nanotechnology (patent) — CLOSED

Auto-fired via `_execute_free_actions()`. Discards the lowest-value
hand card and draws 1 replacement.

### Teleportation (patent) — CLOSED

Auto-fired via `_execute_free_actions()` when the highest-priced
positive resource is worth ≥ $5. Conservative threshold avoids
unprofitable sells.

### Launch Pad in greedy_strategy — CLOSED

`greedy_strategy` now enumerates Launch Pad as a fallback contract
path (same pattern as `smart_greedy_strategy`).

### Discard-2-for-contract — CLOSED (smart_greedy only)

`smart_greedy_strategy` now considers the discard-2 path as a last
resort when no contract-icon card or Launch Pad is available. Proposes
the 2 lowest-value hand cards if the contract reward exceeds their
opportunity cost. `random_strategy` and `greedy_strategy` do not use
this path.

---

## Verifying a card is in sync

When you change a card or add a new one, go through this checklist:

1. **Identify the shape**: build hook, event hook, or free action?
2. **Build hooks / event hooks**: write a unit test that calls
   `execute_build` or the relevant `do_*` event directly, with a synthetic
   `Player` and no `PlayableGame` wrapper. The AI takes the same code path,
   so a passing test = AI parity.
3. **Free actions**: write a unit test for the `PlayableGame.use_*`
   method, then add or update an entry in the **Gaps** section above.
   The AI will not use the new card until you also update
   `my_project/strategies.py` (or add an automatic trigger in
   `run_turn` / `step_ai_turn`).
4. **Update Cards.csv / Patents.csv** so the card's `effect` text
   matches the new behavior. The play UI surfaces this string verbatim
   in the player panel.
5. **Run `uv run pytest`** and `uv run python -m my_project sync-play`.
