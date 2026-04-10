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

For each entry, the **Suggested AI strategy** is a starting point for
when we wire it up. Tweak before implementing.

### Optimization Center (slot-4 building)

- **Effect**: Free action — −1 PWR rate, +1 to any positive non-PWR
  resource rate. Once per turn.
- **Where in code**: [my_project/play_adapter.py](../my_project/play_adapter.py) → `PlayableGame.use_optimization_center`
- **Current AI behavior**: Builds it (slot-4 cards are part of the deck),
  but never invokes it. The slot of the card sits inert.
- **History**: Used to fire automatically during Futures Settlement; we
  removed that auto-trigger when the rules changed to "free action".
  This is a regression for AI parity that needs to be closed.
- **Suggested AI strategy**: Auto-fire at the start of every AI turn if
  the player owns one and hasn't used it. Pick the highest-priced
  positive non-PWR rate as the target (mirrors the old auto-pick logic).
  Always strictly beneficial — there's no opportunity cost to NOT using
  it on most turns.
- **Priority**: HIGH — this used to be a working AI behavior and is
  silently suppressed today.

### Water Engine (patent)

- **Effect**: Free action — −1 H2O rate, +2 PWR rate. Once per turn.
- **Where in code**: [my_project/play_adapter.py](../my_project/play_adapter.py) → `PlayableGame.use_water_engine`
- **Current AI behavior**: Wins it via auction, gets nothing from it.
- **Suggested AI strategy**: Auto-fire at the start of every AI turn if
  the player has H2O ≥ 1. Same "always beneficial" reasoning as OC, with
  one wrinkle: if PWR is the most-valuable resource for the rest of the
  game and the player has spare H2O, this is an obvious yes.
- **Priority**: MEDIUM — patent is rare (one of 12) so the impact on MC
  averages is small per game, but compounds across runs.

### Nanotechnology (patent)

- **Effect**: Free action — discard one card from hand, draw one new
  card. Once per turn.
- **Where in code**: [my_project/play_adapter.py](../my_project/play_adapter.py) → `PlayableGame.use_nanotechnology`
- **Current AI behavior**: Wins it via auction, gets nothing from it.
- **Suggested AI strategy**: Trickier than the others because the AI
  has to decide WHICH card is worst. Initial heuristic: discard the
  highest-cost card in hand that the AI cannot afford and that doesn't
  match any contract on the board. Or: discard the card with the lowest
  rate/cost ratio. Worth experimenting.
- **Priority**: LOW — strategic value depends on a smarter hand-quality
  metric than the AI currently has, so we may want to defer until the
  greedy strategy itself is revised.

### Teleportation (patent)

- **Effect**: Free action — sell any positive non-PWR resource at market
  price (gain cash equal to that price), −1 PWR rate. Once per turn.
- **Where in code**: [my_project/play_adapter.py](../my_project/play_adapter.py) → `PlayableGame.use_teleportation`
- **Current AI behavior**: Wins it via auction, gets nothing from it.
- **Suggested AI strategy**: Auto-fire each turn if the player has any
  positive non-PWR rate. Pick the resource with the highest current
  market price. Cost analysis: −1 PWR rate is a permanent loss, so we
  should only fire when (current price of chosen resource) ×
  (remaining_turns) > (PWR price × remaining_power_bills). The naive
  version: always fire if sell price > 5 and PWR rate stays ≥ 0.
- **Priority**: MEDIUM — balanced trade-off makes this a non-trivial
  strategic decision.

### Discard-2 contract path (rule, not a card)

- **Effect**: Alternative way to fulfill a contract. Instead of spending
  a hand card with `can_fulfill_contract=True`, the player discards any
  2 hand cards. Costs 1 AP, same as the regular contract path.
- **Where in code**: [my_project/simulation.py](../my_project/simulation.py) → `execute_contract` (`discard_card_indices` parameter), [my_project/play_adapter.py](../my_project/play_adapter.py) → `apply_human_action` "contract" branch with `use_discard: true`.
- **Current AI behavior**: AI strategies (`random_strategy`, `greedy_strategy`, `smart_greedy_strategy`) only enumerate the contract-card and Launch-Pad paths. They never consider the discard-2 path.
- **Suggested AI strategy**: When the AI has no `can_fulfill_contract`
  card in hand BUT has 2 spare cards AND a contract is affordable from
  current rates, propose a `discard_card_indices` action with the 2
  lowest-EV cards in hand (e.g. cheapest builds the AI doesn't plan to
  use). Score the action against the regular contract reward minus the
  EV of the 2 discarded cards. Only fire if positive.
- **Priority**: LOW — the AI rarely sits on hands with 0 contract cards,
  and the discard-2 path is more of a human convenience option that adds
  strategic depth in late-game corner cases.

---

## Closed — cards the AI now uses correctly

(Empty — populate as we close gaps.)

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
