# Major Refactor: Observable Game State & Clean Object Model

## Status
Tagged `v2.0.0-stable` at `d347733` on main. This refactor should happen on a feature branch (`refactor/observable-state`).

## Why
The codebase has grown organically through many iterations. Game state is mutated via raw Python primitives (ints, dicts, lists) scattered across ~110 sites in simulation.py. This makes it impossible to:
- Log every state change with its cause (for debugging, replay, audit)
- Animate AI actions at the same granularity as human actions
- Step through simulations action-by-action
- Undo/replay game states

The current logging is split between JS (fragmented, different for human/AI) and Python (turn-level only, no per-action snapshots). This refactor unifies everything.

## Current Architecture (what exists)

### Files
- `my_project/simulation.py` (~2800 lines) — game engine: GameState, Player, Market, Deck, all game actions, event execution, AI turn loop, Monte Carlo turn loop
- `my_project/play_adapter.py` (~1100 lines) — PlayableGame wrapping GameState for interactive play: human/AI turn management, state serialization, prompt handling
- `my_project/strategies.py` (~1300 lines) — AI strategies: random, greedy, smart, optimal
- `my_project/monte_carlo.py` (~340 lines) — Monte Carlo simulation runner
- `my_project/sim_analysis.py` — analysis/aggregation of simulation results
- `my_project/parsing.py` — CSV parsing for cards, events, news, patents
- `my_project/accounting.py` — cost ledger for contract economics
- `my_project/card_valuation.py` — regression-based card value learning
- `my_project/models.py` — empty (everything is in simulation.py)
- `frontend/multiplayer.js` (~2500 lines) — WebRTC multiplayer UI with debug panel
- `frontend/play.js` (~2100 lines) — original solo/hot-seat play UI

### Current mutable state (all raw primitives)
```python
# Player (dataclass)
money: int              # direct += / -= everywhere
debt: int               # direct += / -=
credit: int             # direct += / -=
rates: dict[Resource, int]  # direct [r] += / [r] = 
hand: list[Card]        # .pop(), .append(), .extend()
buildings_played: list[Card]  # .append()
cards_spent_this_turn: int
hand_size: int
contracts_fulfilled: int
# + many per-turn flags and flow tracking dicts

# Market
positions: dict[Resource, int]  # adjusted via .adjust() method

# GameState
pool: list[Card]        # .pop(), .append()
event_deck: list[EventCard]  # indexed by event_idx
event_idx: int          # incremented manually
deck: Deck              # .draw(), .discard
patent_pile: list[Card]
patent_idx: int
```

### Current logging
- `TurnRecord` — one per player turn, captures summary + final state
- `TurnRecord.actions: list[ActionRecord]` — per-action structured data (build/sell/contract) but NO state snapshots between actions
- `TurnRecord.free_actions: list[str]` — just description strings
- No pool swap logging
- No per-mutation tracking
- JS-side `gameLog[]` in multiplayer.js — captures state_dict() snapshots but different format for human vs AI

### Current action flow
```
Human: JS sendAction() → Python apply_human_action() → _execute_action() → mutates state
AI:    Python step_ai_turn() → strategy() → _execute_action() → mutates state (atomic, no intermediate visibility)
Sim:   Python run_turn() → strategy() → _execute_action() → mutates state

All three call _execute_action which calls execute_build/execute_sell/execute_contract.
Events: all call execute_event().
Free actions: all call _execute_free_actions().
Pool swaps: all call swap_pool_card().
```

## Proposed Architecture

### New domain objects (replace raw primitives)

```python
class Currency:
    """Observable int for money, debt, credit."""
    _value: int
    _log: GameLog
    _label: str  # e.g. "player.0.money"
    
    def add(self, amount): ...  # logs automatically
    def set(self, value): ...   # logs automatically
    def __int__(self): return self._value
    def __eq__, __lt__, etc.    # comparison operators

class ResourceRates:
    """Observable dict for player rates."""
    _values: dict[Resource, int]
    _log: GameLog
    _label: str  # e.g. "player.0.rates"
    
    def get(self, r) -> int: ...
    def adjust(self, r, delta): ...  # logs automatically
    def set(self, r, value): ...     # logs automatically
    def __iter__: yields (resource, value) pairs

class CardZone:
    """Observable list for hand, pool, buildings_played."""
    _cards: list[Card]
    _log: GameLog
    _label: str  # e.g. "player.0.hand", "pool"
    
    def add(self, card): ...      # logs automatically
    def remove(self, idx): ...    # logs automatically
    def extend(self, cards): ...  # logs automatically
    def __len__, __iter__, __getitem__

class MarketTrack:
    """Observable market with price track."""
    _positions: dict[Resource, int]
    _log: GameLog
    
    def price(self, r) -> int: ...
    def adjust(self, r, amount): ...  # logs automatically
    def snapshot(self) -> dict: ...
```

### GameLog

```python
@dataclass
class Mutation:
    field: str       # "player.0.money", "market.FE", "pool"
    old_value: Any
    new_value: Any

@dataclass
class ActionEntry:
    action_id: int
    type: str        # "build", "sell", "swap", "event:power_bill", "free:oc"
    player_name: str
    player_idx: int
    summary: str
    mutations: list[Mutation]

class GameLog:
    entries: list[ActionEntry]
    _current: ActionEntry | None
    _enabled: bool  # can disable for perf if needed
    
    def begin(self, type, player_name, player_idx, summary): ...
    def record(self, field, old_val, new_val): ...
    def end(self): ...
```

Every domain object holds a reference to the GameLog. When a mutation method is called, it calls `self._log.record(...)`. The `begin/end` calls happen at the action boundaries (in execute_build, execute_sell, execute_event, etc.).

### Migration strategy

Phase 1: Add GameLog + Currency (money/debt/credit only)
- Create GameLog, Mutation, ActionEntry
- Create Currency class
- Replace Player.money/debt/credit with Currency instances
- Update ~20 mutation sites
- Verify tests pass

Phase 2: Add ResourceRates
- Create ResourceRates class
- Replace Player.rates dict with ResourceRates
- Update ~15 mutation sites
- Verify tests pass

Phase 3: Add CardZone (pool, hand, buildings)
- Create CardZone class
- Replace state.pool, player.hand, player.buildings_played
- Update ~15 mutation sites
- Verify tests pass

Phase 4: Add MarketTrack (already partially exists as Market)
- Extend Market.adjust() with logging
- ~5 mutation sites
- Verify tests pass

Phase 5: Wire action boundaries
- Add log.begin/end around execute_build, execute_sell, execute_contract, execute_event, swap_pool_card, _execute_free_actions
- ~30 sites
- Verify tests pass

Phase 6: Expose to frontend
- state_dict() includes action_log
- JS debug panel reads from Python log
- Remove JS-side gameLog
- Verify human and AI logs are identical

Phase 7: Clean up dead code
- Remove unused modules/functions
- Consolidate TurnRecord (may be replaceable by GameLog)
- Clean up play_adapter redundancies

### Code to potentially delete/simplify
- `TurnRecord` — may be fully replaced by GameLog entries grouped by turn
- `_record_event_line` system — replaced by GameLog mutations
- JS-side `gameLog[]`, `logGameStep()`, `feedEntries[]` — replaced by Python log
- `_last_event_data`, `_last_event_structured`, `_futures_trading_data`, `_draw_card_data` — ad-hoc structured data replaced by GameLog mutations
- Duplicate frontend copy (`frontend/data/game/my_project/`) — consider serving from one source

### Performance considerations
- GameLog.record() is a list append — O(1), ~0.5μs overhead per mutation
- ~1000 mutations per game → ~0.5ms per game overhead
- 2000 simulations → ~1s total overhead (negligible vs game computation)
- Memory: ~100 bytes per mutation × 1000 per game × 2000 sims = ~200MB (acceptable for 64GB machine)
- Can gate with `_enabled` flag if needed for extreme bulk runs

### Testing strategy
- Each phase: run full test suite (283 tests) after migration
- Add new tests for GameLog: verify every action type produces expected mutations
- Add integration test: play a full game, verify log has entries for every state change
- Add determinism test: same seed produces identical log entries

## How to start a fresh session with this plan
1. Read this plan file
2. Create branch: `git checkout -b refactor/observable-state`
3. Start with Phase 1 (GameLog + Currency)
4. Tag after each phase passes tests
5. Merge to main when all phases complete
