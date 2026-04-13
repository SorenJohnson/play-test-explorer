// Mars Colony — playable browser client
// Boots Pyodide, loads the Python engine from frontend/data/game/, and drives
// a stepwise human-vs-AI game via my_project.play_adapter.PlayableGame.

const RESOURCE_COLORS = {
  PWR: "#e74c3c", H2O: "#2c3e80", FE: "#888888", C: "#8e44ad",
  SI: "#f1c40f", O2: "#bdc3c7", FOOD: "#27ae60", GLS: "#5dade2", ELX: "#e67e22",
};

const RESOURCE_ORDER = ["PWR", "H2O", "FE", "C", "SI", "O2", "FOOD", "GLS", "ELX"];

// Per-player identity colors. Distinct from #58a6ff (the active-state accent)
// so "this is P1" and "this is highlighted" don't visually collide.
const PLAYER_COLORS = ["#79c0ff", "#ffa657", "#56d364", "#c297ff"];
function playerColor(idx) {
  return PLAYER_COLORS[idx % PLAYER_COLORS.length];
}

const PY_FILES = [
  "__init__.py", "accounting.py", "models.py", "parsing.py",
  "play_adapter.py", "simulation.py", "strategies.py",
];
const CSV_FILES = [
  "Cards.csv", "Contracts.csv", "market.csv", "Patents.csv",
  "News.csv", "Corporations.csv", "GameConfig.csv", "Events.csv",
];

let pyodide = null;
let game = null;              // Pyodide proxy to PlayableGame instance
let currentState = null;      // most recent state_dict result
let currentLegal = null;      // most recent legal_human_actions result
// Tagged log entries — two flavors interleaved chronologically:
//
//   Player-actions row:
//     {kind: "turn", turn, playerIdx, isHuman, actions: [...]}
//
//   Event row (pushed right after the turn row when the event resolves):
//     {kind: "event", turn, triggeredBy, isHuman,
//      summary: "Power Bill — PWR @ $4",
//      lines: [{kind: "header"|"note"|"player", text, ...}, ...]}
//
// Each action is the per-action record returned by the backend, augmented
// with `type`, `detail`, and post-action NW snapshot fields. Each event line
// comes from `state.last_event_lines` on the Python side and may carry
// per-player NW snapshot fields too.
const turnLog = [];
let marketChart = null;       // Chart.js instance for the price-history chart

// Returns the player index whose hand/stats should fill the "You" panel.
// During a human turn, that's the active player. Otherwise we fall back to
// the first human seat so the panel still has data to render.
function activeHumanIndex(s) {
  const humans = s.human_indices || [s.human_index ?? 0];
  if (
    s.current_player_index >= 0 &&
    humans.includes(s.current_player_index)
  ) {
    return s.current_player_index;
  }
  return humans[0] ?? 0;
}

// --- Hand selection state ---
// selectedBuildIdxs: set of card indices to build together (one build action)
// selectedContractIdx: the available-contracts index for a contract action
// pendingPoolSwapIdx: pool index clicked by the user, waiting for a hand click
// Sell and contract actions require exactly one card in selectedBuildIdxs.
let selectedBuildIdxs = new Set();
let selectedContractIdx = null;
let pendingPoolSwapIdx = null;
// Special-building per-action toggles:
// useElevatorThisFulfill: apply Space Elevator -1 on the next contract action
// elevatorTargetResource: which contract requirement to discount (resource value)
// useLaunchPadThisFulfill: use Launch Pad as the contract icon (no card needed)
// hackerTarget / hackerDirection: Hacker Array picker for the next sell
let useElevatorThisFulfill = false;
let elevatorTargetResource = "";
let useLaunchPadThisFulfill = false;
// Patent Office pick: when building a Patent Office, the index (0 or 1) of
// the patent the human wants to keep. null = auto-pick (AI default).
let patentOfficePick = null;
// Which resource the human wants to sell (when a card has multiple sell options).
// null = auto-pick best. Set by the sell resource picker.
let selectedSellResource = null;
let hackerTarget = "";
let hackerDirection = 0;

// --- Boot ---

async function boot() {
  setLoadingDetail("Downloading Pyodide runtime…");
  pyodide = await loadPyodide({
    indexURL: "https://cdn.jsdelivr.net/pyodide/v0.27.0/full/",
  });

  setLoadingDetail("Fetching Python engine sources…");
  await loadPythonSources();

  setLoadingDetail("Booting game engine…");
  pyodide.runPython(`
    from my_project.play_adapter import PlayableGame
  `);

  setLoadingDetail("Ready.");
  document.getElementById("loading").style.display = "none";

  wireButtons();
  // Show config screen instead of auto-starting. The game-root stays hidden
  // until the user clicks Start in the modal.
  showNewGameModal({ initial: true });
}

function setLoadingDetail(text) {
  const el = document.getElementById("loading-detail");
  if (el) el.textContent = text;
}

async function loadPythonSources() {
  // Create the my_project package structure in Pyodide's virtual FS
  pyodide.FS.mkdirTree("/home/pyodide/my_project/data");

  // cache: "no-cache" forces the browser to revalidate with the server on
  // every load. GitHub Pages returns ETag-based 304s when nothing changed
  // (cheap), but a fresh deploy is picked up immediately — without this
  // these .py files can stay cached for ~10 minutes after a deploy and
  // Pyodide ends up running stale Python while play.js runs the new JS.
  for (const name of PY_FILES) {
    const resp = await fetch(`data/game/my_project/${name}`, { cache: "no-cache" });
    if (!resp.ok) throw new Error(`Failed to fetch ${name}: ${resp.status}`);
    const text = await resp.text();
    pyodide.FS.writeFile(`/home/pyodide/my_project/${name}`, text);
  }
  for (const name of CSV_FILES) {
    const resp = await fetch(`data/game/my_project/data/${name}`, { cache: "no-cache" });
    if (!resp.ok) throw new Error(`Failed to fetch ${name}: ${resp.status}`);
    const text = await resp.text();
    pyodide.FS.writeFile(`/home/pyodide/my_project/data/${name}`, text);
  }

  // Ensure Python can import from /home/pyodide
  pyodide.runPython(`
    import sys
    if "/home/pyodide" not in sys.path:
        sys.path.insert(0, "/home/pyodide")
  `);
}

// --- Game lifecycle ---

// Default JSON shown in the New Game modal's Advanced section. Mirrors the
// Python EventDeckConfig defaults so the user has a working starting point.
// `news_pool` is empty by default; populating it and bumping `news_count`
// turns on news events.
const DEFAULT_EVENT_CONFIG = {
  news_count: 0,
  news_pool: [],
};

// Pretty-printed string used to seed the textarea on first load.
const DEFAULT_EVENT_CONFIG_TEXT = JSON.stringify(DEFAULT_EVENT_CONFIG, null, 2);

// Last-used config so the New Game modal pre-fills with the previous settings.
let lastGameConfig = {
  seats: ["human", "optimal", "optimal"],
  names: ["Player_1", "Player_2", "Player_3"],
  rounds: 8,
  seed: null,
  // Raw textarea contents — kept as a string so user formatting/comments survive
  // round-trips through the modal.
  eventConfigText: DEFAULT_EVENT_CONFIG_TEXT,
};

// Default name for a seat index — matches the engine's `Player_{i+1}` format
// so a user who never edits the field gets the same display string the
// backend would have produced anyway.
function defaultSeatName(idx) {
  return `Player_${idx + 1}`;
}

function startNewGame(config = null) {
  const cfg = config || lastGameConfig;
  lastGameConfig = cfg;
  const seed = cfg.seed === null || cfg.seed === undefined
    ? Math.floor(Math.random() * 1_000_000)
    : cfg.seed;
  // Destroy prior game if any
  if (game) {
    try { game.destroy(); } catch {}
    game = null;
  }
  // Build seats and names as Python literals. Names are quoted with JSON to
  // safely escape any user input.
  const seatsLiteral = "[" + cfg.seats.map((s) => `"${s}"`).join(", ") + "]";
  const namesArr = (cfg.names || []).map((n, i) => n || defaultSeatName(i));
  const namesLiteral = "[" + namesArr.map((n) => JSON.stringify(n)).join(", ") + "]";

  // Build the EventDeckConfig kwarg, only if the user provided non-default JSON.
  // The Python side parses the JSON and turns dict entries into EventDeckConfig
  // / EventCard instances. Tuples are written as Python tuples via lists →
  // tuple() coercion in the helper.
  const eventConfig = cfg.eventConfig || null;
  let extraKwargs = "";
  if (eventConfig) {
    const json = JSON.stringify(eventConfig);
    // Stash the JSON in a Python global, then build EventDeckConfig from it.
    // Done in a separate runPython call so we can keep the main constructor
    // call readable.
    pyodide.runPython(`
import json as _json
from my_project.simulation import EventDeckConfig as _EDC, EventCard as _EC, EventType as _ET
_raw = _json.loads(${JSON.stringify(json)})

def _coerce_count(v):
    if isinstance(v, list) and len(v) == 2:
        return (int(v[0]), int(v[1]))
    return int(v)

def _coerce_news(items):
    out = []
    for item in items or []:
        out.append(_EC(
            type=_ET.NEWS,
            label=item.get("label", ""),
            payload={"market_deltas": item.get("market_deltas", {})},
        ))
    return out

_kw = {}
if "power_bill_count" in _raw:
    _kw["power_bill_count"] = _coerce_count(_raw["power_bill_count"])
if "debt_collection_count" in _raw:
    _kw["debt_collection_count"] = _coerce_count(_raw["debt_collection_count"])
if "futures_trading_count" in _raw:
    _kw["futures_trading_count"] = _coerce_count(_raw["futures_trading_count"])
if "news_count" in _raw:
    _kw["news_count"] = _coerce_count(_raw["news_count"])
if "news_pool" in _raw:
    _kw["news_pool"] = _coerce_news(_raw["news_pool"])
_event_deck_config = _EDC(**_kw)
`);
    extraKwargs = ", event_deck_config=_event_deck_config";
  }

  const deckRounds = cfg.deckRounds || 2;
  pyodide.runPython(
    `game = PlayableGame(seed=${seed}, seats=${seatsLiteral}, names=${namesLiteral}, num_rounds=${deckRounds}${extraKwargs})`
  );
  game = pyodide.globals.get("game");
  turnLog.length = 0;
  clearSelection();
  if (marketChart) {
    marketChart.destroy();
    marketChart = null;
  }
  if (endgameNwChart) {
    endgameNwChart.destroy();
    endgameNwChart = null;
  }
  document.getElementById("endgame-overlay").style.display = "none";
  document.getElementById("new-game-modal").style.display = "none";
  document.getElementById("game-root").style.display = "block";
  if (game.is_human_turn()) {
    // begin_human_turn resets has_built_this_turn. Must call BEFORE refreshState
    // so the rendered state reflects the fresh turn, not stale flags.
    game.begin_human_turn();
    refreshState();
  } else {
    advanceUntilHuman();
  }
}

// --- New game modal ---

function showNewGameModal({ initial = false } = {}) {
  const modal = document.getElementById("new-game-modal");
  const cancelBtn = document.getElementById("ng-cancel-btn");
  // Cancel is only available if a game is already in progress.
  cancelBtn.style.display = initial ? "none" : "inline-block";
  populateNewGameForm(lastGameConfig);
  modal.style.display = "flex";
}

function hideNewGameModal() {
  document.getElementById("new-game-modal").style.display = "none";
}

function populateNewGameForm(cfg) {
  const numSeatsSelect = document.getElementById("ng-num-seats");
  numSeatsSelect.value = String(cfg.seats.length);
  document.getElementById("ng-deck-rounds").value = String(cfg.deckRounds || 2);
  document.getElementById("ng-seed").value = cfg.seed === null ? "" : String(cfg.seed);
  document.getElementById("ng-event-config").value =
    cfg.eventConfigText || DEFAULT_EVENT_CONFIG_TEXT;
  // Clear any leftover error message from the previous open.
  const errEl = document.getElementById("ng-config-error");
  if (errEl) errEl.textContent = "";
  renderSeatRows(cfg.seats, cfg.names || []);
  numSeatsSelect.onchange = () => {
    const n = parseInt(numSeatsSelect.value, 10);
    const { seats: curSeats, names: curNames } = readSeatRows();
    const nextSeats = Array.from({ length: n }, (_, i) =>
      curSeats[i] || (i === 0 ? "human" : "optimal")
    );
    const nextNames = Array.from({ length: n }, (_, i) => curNames[i] || defaultSeatName(i));
    renderSeatRows(nextSeats, nextNames);
  };
}

function renderSeatRows(seats, names) {
  const wrap = document.getElementById("ng-seats-list");
  wrap.innerHTML = seats
    .map((s, i) => {
      const name = names[i] || defaultSeatName(i);
      return `
    <div class="seat-row">
      <input type="text" class="seat-name" data-seat-idx="${i}"
             value="${escapeAttr(name)}" maxlength="20">
      <select data-seat-idx="${i}">
        <option value="human" ${s === "human" ? "selected" : ""}>Human</option>
        <option value="optimal" ${s === "optimal" ? "selected" : ""}>Optimal AI</option>
        <option value="smart" ${s === "smart" ? "selected" : ""}>Smart AI</option>
        <option value="greedy" ${s === "greedy" ? "selected" : ""}>Greedy AI</option>
        <option value="random" ${s === "random" ? "selected" : ""}>Random AI</option>
      </select>
    </div>`;
    })
    .join("");
}

// Escape a user string for safe insertion into an HTML attribute.
function escapeAttr(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function readSeatRows() {
  const seats = Array.from(document.querySelectorAll("#ng-seats-list select")).map(
    (sel) => sel.value
  );
  const names = Array.from(document.querySelectorAll("#ng-seats-list input.seat-name")).map(
    (inp) => inp.value.trim()
  );
  return { seats, names };
}

function readNewGameConfig() {
  const { seats, names } = readSeatRows();
  // Fill any blank names with the seat default so the backend always gets a real string.
  const filledNames = names.map((n, i) => n || defaultSeatName(i));
  const deckRounds = parseInt(document.getElementById("ng-deck-rounds").value, 10) || 2;
  const seedRaw = document.getElementById("ng-seed").value.trim();
  const seed = seedRaw === "" ? null : parseInt(seedRaw, 10);
  const eventConfigText = document.getElementById("ng-event-config").value;
  return {
    seats,
    names: filledNames,
    deckRounds,
    seed: Number.isNaN(seed) ? null : seed,
    eventConfigText,
  };
}

// Parse the event-deck JSON textarea. Returns {ok: true, parsed} or
// {ok: false, error}. Empty / whitespace-only text is treated as "no
// custom config" and parsed === null.
function parseEventConfig(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return { ok: true, parsed: null };
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return { ok: false, error: `JSON parse error: ${err.message}` };
  }
  if (typeof parsed !== "object" || Array.isArray(parsed) || parsed === null) {
    return { ok: false, error: "Top-level event config must be a JSON object." };
  }
  // Light validation — surface obvious mistakes early instead of letting
  // Pyodide raise a less-friendly traceback.
  const known = new Set([
    "power_bill_count",
    "debt_collection_count",
    "futures_trading_count",
    "news_count",
    "news_pool",
  ]);
  for (const key of Object.keys(parsed)) {
    if (!known.has(key)) {
      return { ok: false, error: `Unknown field: ${key}` };
    }
  }
  if (parsed.news_pool !== undefined && !Array.isArray(parsed.news_pool)) {
    return { ok: false, error: "news_pool must be an array." };
  }
  for (const [i, card] of (parsed.news_pool || []).entries()) {
    if (typeof card !== "object" || card === null) {
      return { ok: false, error: `news_pool[${i}] must be an object.` };
    }
    if (card.market_deltas !== undefined && (typeof card.market_deltas !== "object" || Array.isArray(card.market_deltas))) {
      return { ok: false, error: `news_pool[${i}].market_deltas must be an object.` };
    }
  }
  return { ok: true, parsed };
}

function clearSelection() {
  selectedBuildIdxs.clear();
  selectedContractIdx = null;
  pendingPoolSwapIdx = null;
  useElevatorThisFulfill = false;
  elevatorTargetResource = "";
  useLaunchPadThisFulfill = false;
  patentOfficePick = null;
  selectedSellResource = null;
  hackerTarget = "";
  hackerDirection = 0;
}

function refreshState() {
  const s = game.state_dict().toJs({ dict_converter: Object.fromEntries });
  const legal = game.legal_human_actions().toJs({ dict_converter: Object.fromEntries });
  currentState = s;
  currentLegal = legal;

  render();
  // Surface (or hide) the prompt modal whenever state changes.
  maybeShowPromptModal();
}

function advanceUntilHuman() {
  // Run AI turns until it's the human's turn or game ends. If an AI turn
  // pauses for a human prompt (patent auction), stop and let the modal
  // handle it; resume advancing after the prompt is resolved.
  while (!game.is_over() && !game.is_human_turn()) {
    const result = game.step_ai_turn().toJs({ dict_converter: Object.fromEntries });
    if (!result.ok) break;  // e.g. "It's the human's turn" or "Game is over"
    logAiTurn(result);
    if (result.awaiting_prompt) {
      refreshState();
      maybeShowPromptModal();
      return;
    }
  }
  if (game.is_over()) {
    refreshState();
    showEndgame();
    return;
  }
  // begin_human_turn resets has_built_this_turn. Must call BEFORE refreshState
  // so the rendered state reflects the fresh turn, not stale flags from prior.
  game.begin_human_turn();
  refreshState();
}

// --- Rendering ---

function render() {
  if (!currentState) return;
  renderStatusBar();
  renderOpponents();
  renderMarket();
  renderPlayer();
  renderContracts();
  renderPool();
  renderHand();
  renderActionBar();
  renderPatentActions();
  renderLog();
}

function renderStatusBar() {
  const s = currentState;
  const roundSuffix = s.num_rounds > 1 ? ` (Rd ${s.deck_round}/${s.num_rounds})` : "";
  document.getElementById("round-indicator").textContent = `${s.round} / ${s.max_rounds}${roundSuffix}`;
  document.getElementById("turn-indicator").textContent = `${s.turn_index + 1} / ${s.total_turns} (${s.cards_in_deck} cards left)`;
  document.getElementById("seed-display").textContent = s.seed;
  const activeIdx = s.current_player_index;
  const humans = s.human_indices || [s.human_index ?? 0];
  const activeEl = document.getElementById("active-player");
  const crEl = document.getElementById("action-points-display");
  if (activeIdx < 0) {
    activeEl.innerHTML = "Game Over";
    if (crEl) crEl.textContent = "—";
    return;
  }
  const youSuffix = humans.includes(activeIdx) ? " (You)" : "";
  const label = `${s.players[activeIdx].name}${youSuffix}`;
  const color = playerColor(activeIdx);
  activeEl.innerHTML =
    `<span class="player-swatch" style="background:${color}"></span>${label}`;
  // Cards remaining: pulled from currentLegal during human turns; for AI
  // turns we read player.cards_remaining from the state snapshot.
  if (crEl) {
    const cr = currentLegal && currentLegal.cards_remaining != null
      ? currentLegal.cards_remaining
      : (s.players[activeIdx].cards_remaining ?? "—");
    crEl.textContent = `${cr} / 2`;
    crEl.className = "status-value";
    if (typeof cr === "number") {
      if (cr >= 2) crEl.classList.add("ap-full");
      else if (cr === 1) crEl.classList.add("ap-half");
      else crEl.classList.add("ap-empty");
    }
  }
}

function renderOpponents() {
  const s = currentState;
  const el = document.getElementById("opponents-strip");
  const youIdx = activeHumanIndex(s);
  // In multi-human, the other humans are also "opponents" to whichever human
  // is currently in the seat — show everyone except the active human.
  const opponents = s.players.filter((_, i) => i !== youIdx);
  el.innerHTML = opponents.map((p) => {
    const playerIdx = s.players.indexOf(p);
    const isActive = playerIdx === s.current_player_index;
    const seatColor = playerColor(playerIdx);
    const rateChips = RESOURCE_ORDER.map((r) => {
      const v = p.rates[r] || 0;
      if (v === 0) return "";
      const color = v > 0 ? "#3fb950" : "#f85149";
      return `<span style="color:${color}">${v > 0 ? "+" : ""}${v} ${r}</span>`;
    }).filter(Boolean).join(" ");
    // Slot-4 specials and slot-5 patents the opponent owns
    const builtCards = p.built_cards || [];
    const specials = builtCards.filter((c) => c.slot === 4);
    const patents = builtCards.filter((c) => c.slot === 5);
    const specialsLine = specials.length
      ? `<div class="opponent-specials"><span class="opp-label">Specials:</span> ${specials.map((c) => c.building).join(", ")}</div>`
      : "";
    const patentsLine = patents.length
      ? `<div class="opponent-patents"><span class="opp-label">Patents:</span> ${patents.map((c) => c.building).join(", ")}</div>`
      : "";
    const creditCell = (p.credit || 0) > 0
      ? `<div class="stat"><span class="stat-label">Credit</span><span style="color:#3fb950">$${p.credit}</span></div>`
      : "";
    return `
      <div class="opponent-card ${isActive ? "active" : ""}" style="--player-color:${seatColor}">
        <div class="opponent-name">${p.name}</div>
        <div class="opponent-corp">${p.corporation || "—"}</div>
        <div class="opponent-stats">
          <div class="stat">
            <span class="stat-label">Money</span>
            <span>$${p.money}</span>
          </div>
          <div class="stat">
            <span class="stat-label">Debt</span>
            <span style="color:#f85149">$${p.debt}</span>
          </div>
          ${creditCell}
          <div class="stat">
            <span class="stat-label">NW</span>
            <span style="color:#3fb950">$${p.net_worth}</span>
          </div>
          <div class="stat">
            <span class="stat-label">Contracts</span>
            <span>${p.contracts_fulfilled}</span>
          </div>
          <div class="stat">
            <span class="stat-label">Buildings</span>
            <span>${p.buildings_played.length}</span>
          </div>
        </div>
        <div class="opponent-rates">${rateChips || "<span style='color:#484f58'>no rates</span>"}</div>
        ${specialsLine}
        ${patentsLine}
      </div>`;
  }).join("");
}

function renderMarket() {
  const s = currentState;
  const el = document.getElementById("market-grid");
  el.innerHTML = RESOURCE_ORDER.map((r) => {
    const price = s.market[r];
    const color = RESOURCE_COLORS[r];
    return `
      <div class="market-cell" style="border-left:3px solid ${color}">
        <div class="resource-name" style="color:${color}">${r}</div>
        <div class="resource-price">$${price}</div>
      </div>`;
  }).join("");
  renderMarketHistoryChart();
}

function renderMarketHistoryChart() {
  const history = currentState?.market_history || [];
  if (history.length === 0) return;
  const labels = history.map((h) => `T${h.turn}`);
  const datasets = RESOURCE_ORDER.map((r) => ({
    label: r,
    data: history.map((h) => h.market[r] ?? null),
    borderColor: RESOURCE_COLORS[r],
    backgroundColor: "transparent",
    borderWidth: 2,
    tension: 0.2,
    pointRadius: 0,
  }));

  if (marketChart) {
    marketChart.data.labels = labels;
    marketChart.data.datasets.forEach((d, i) => { d.data = datasets[i].data; });
    marketChart.update("none");
    return;
  }

  const canvas = document.getElementById("play-market-chart");
  if (!canvas) return;
  marketChart = new Chart(canvas, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: "#8b949e", font: { size: 11 } } },
      },
      scales: {
        x: {
          title: { display: true, text: "Turn", color: "#8b949e" },
          ticks: { color: "#8b949e", maxTicksLimit: 12 },
          grid: { color: "#21262d" },
        },
        y: {
          title: { display: true, text: "Price ($)", color: "#8b949e" },
          ticks: { color: "#8b949e" },
          grid: { color: "#21262d" },
        },
      },
    },
  });
}

function renderPlayer() {
  const s = currentState;
  const youIdx = activeHumanIndex(s);
  const p = s.players[youIdx];
  const seatColor = playerColor(youIdx);
  const heading = document.getElementById("player-heading");
  heading.textContent = `${p.name} (You) — ${p.corporation || "No corporation"}`;
  heading.style.color = seatColor;
  document.getElementById("player-panel").style.setProperty("--player-color", seatColor);

  const rateCells = RESOURCE_ORDER.map((r) => {
    const v = p.rates[r] || 0;
    const cls = v > 0 ? "positive" : v < 0 ? "negative" : "zero";
    return `
      <div class="rate-chip">
        <div class="rate-res">${r}</div>
        <div class="rate-val ${cls}">${v > 0 ? "+" : ""}${v}</div>
      </div>`;
  }).join("");

  // Split built cards into ordinary buildings, slot-4 specials, and patents.
  // Specials and patents get their effect text inlined so the player can see
  // what they're getting from each unique card.
  const builtCards = p.built_cards || [];
  const ordinaryBuildings = builtCards.filter((c) => c.slot < 4);
  const specials = builtCards.filter((c) => c.slot === 4);
  const patents = builtCards.filter((c) => c.slot === 5);

  const ordinaryStr = ordinaryBuildings.length
    ? ordinaryBuildings.map((c) => c.building).join(", ")
    : "<em>None built yet</em>";

  const specialsHtml = specials.length
    ? specials.map((c) => `
      <div class="special-card-summary">
        <strong>${c.building}</strong>
        <span class="special-effect">${c.effect || "(no effect)"}</span>
      </div>
    `).join("")
    : '<em style="color:#484f58">None</em>';

  const patentsHtml = patents.length
    ? patents.map((c) => `
      <div class="special-card-summary">
        <strong>${c.building}</strong>
        <span class="special-effect">${c.effect || "(no effect)"}</span>
      </div>
    `).join("")
    : '<em style="color:#484f58">None</em>';

  // Credit row only shown if non-zero (avoid clutter for players who have none)
  const creditRow = (p.credit || 0) > 0
    ? `<div class="player-stats-row">
        <span class="player-stats-label">Credit</span>
        <span class="player-stats-value" style="color:#3fb950">$${p.credit}</span>
      </div>`
    : "";

  document.getElementById("player-panel").innerHTML = `
    <div class="player-stats-block">
      <div class="player-stats-row">
        <span class="player-stats-label">Money</span>
        <span class="player-stats-value">$${p.money}</span>
      </div>
      <div class="player-stats-row">
        <span class="player-stats-label">Debt</span>
        <span class="player-stats-value" style="color:#f85149">$${p.debt}</span>
      </div>
      ${creditRow}
      <div class="player-stats-row">
        <span class="player-stats-label">Contracts Fulfilled</span>
        <span class="player-stats-value">${p.contracts_fulfilled}</span>
      </div>
      <div class="player-stats-row">
        <span class="player-stats-label">Net Worth</span>
        <span class="player-stats-value big">$${p.net_worth}</span>
      </div>
      <div class="buildings-list">
        <strong>Buildings (${ordinaryBuildings.length}):</strong> ${ordinaryStr}
      </div>
      <div class="buildings-list">
        <strong>Special Buildings (${specials.length}):</strong>
        <div class="special-cards-list">${specialsHtml}</div>
      </div>
      <div class="buildings-list">
        <strong>Patents (${patents.length}):</strong>
        <div class="special-cards-list">${patentsHtml}</div>
      </div>
    </div>
    <div class="player-rates-block">
      <div class="hand-card-label" style="margin-bottom:6px">Production Rates</div>
      <div class="player-rates-grid">${rateCells}</div>
    </div>
  `;
}

function renderContracts() {
  const s = currentState;
  const el = document.getElementById("contracts-grid");
  const p = s.players[activeHumanIndex(s)];
  const canFulfillSet = new Set(
    (currentLegal?.can_contract || []).map((c) => c.contract_idx)
  );

  el.innerHTML = s.available_contracts.map((c, i) => {
    const reqHtml = c.requirements.map((r) => {
      const have = p.rates[r.resource] || 0;
      const ok = have >= r.amount;
      const color = ok ? "#3fb950" : "#f85149";
      return `<span style="color:${color}">${r.amount} ${r.resource} (have ${have})</span>`;
    }).join("<br>");
    const fulfillable = canFulfillSet.has(i);
    const selected = selectedContractIdx === i;
    const classes = ["contract-card"];
    if (selected) classes.push("selected");
    if (!fulfillable) classes.push("unavailable");
    return `
      <div class="${classes.join(" ")}" data-contract-idx="${i}">
        <div class="contract-reward">$${c.reward}</div>
        <div class="contract-requirements">${reqHtml}</div>
      </div>`;
  }).join("");

  // Wire clicks (only fulfillable ones)
  el.querySelectorAll(".contract-card").forEach((card) => {
    const idx = parseInt(card.dataset.contractIdx, 10);
    card.addEventListener("click", () => {
      if (!canFulfillSet.has(idx)) return;
      selectedContractIdx = selectedContractIdx === idx ? null : idx;
      render();
    });
  });
}

function renderPool() {
  const s = currentState;
  const el = document.getElementById("pool-grid");
  const hintEl = document.getElementById("pool-hint");
  const humans = s.human_indices || [s.human_index ?? 0];
  const isHumanTurn = humans.includes(s.current_player_index) && !s.is_over;
  const canSwap = s.can_pool_swap && isHumanTurn;

  if (!canSwap && pendingPoolSwapIdx !== null) {
    pendingPoolSwapIdx = null;
  }

  if (hintEl) {
    if (!isHumanTurn) {
      hintEl.textContent = "Pool is passive while other players take their turns.";
    } else if (pendingPoolSwapIdx !== null) {
      hintEl.textContent = "Pool card selected. Click a hand card below to complete the swap.";
    } else {
      hintEl.textContent =
        "Click a pool card then a hand card to swap them. Free and unlimited during your turn.";
    }
  }

  el.innerHTML = (s.pool || []).map((card, i) => {
    const classes = ["pool-card"];
    if (!canSwap) classes.push("locked");
    if (pendingPoolSwapIdx === i) classes.push("pending-swap");

    const rateText = card.rates && card.rates.length
      ? card.rates
          .map((r) => {
            const cls = r.amount > 0 ? "resource-plus" : "resource-minus";
            return `<span class="${cls}">${r.amount > 0 ? "+" : ""}${r.amount} ${r.resource}</span>`;
          })
          .join(" ")
      : "no rates";
    const costText = card.costs && card.costs.length
      ? card.costs.map((c) => `${c.amount} ${c.resource}`).join(", ")
      : "free";
    const sellText = card.can_sell && card.can_sell.length
      ? card.can_sell.join("/")
      : "—";

    const effectLine = card.effect
      ? `<div class="pool-card-effect">${card.effect}</div>`
      : "";

    return `
      <div class="${classes.join(" ")}" data-pool-idx="${i}">
        <div class="pool-card-name">${card.building}</div>
        ${effectLine}
        <div class="pool-card-line">Cost: ${costText}</div>
        <div class="pool-card-line">Rates: ${rateText}</div>
        <div class="pool-card-line">Sell: ${sellText}</div>
      </div>`;
  }).join("");

  if (canSwap) {
    el.querySelectorAll(".pool-card").forEach((cardEl) => {
      const idx = parseInt(cardEl.dataset.poolIdx, 10);
      cardEl.addEventListener("click", () => {
        if (pendingPoolSwapIdx === idx) {
          // Clicking the same pool card again cancels the pending swap
          pendingPoolSwapIdx = null;
        } else {
          pendingPoolSwapIdx = idx;
        }
        render();
      });
    });
  }
}

function renderHand() {
  const s = currentState;
  const p = s.players[activeHumanIndex(s)];
  const el = document.getElementById("hand-grid");

  const affordableSingleIdxs = new Set(
    (currentLegal?.affordable_single_builds || []).map((b) => b.card_idx)
  );

  // Live cost estimate for the current build selection (if any)
  let buildEstimate = null;
  if (selectedBuildIdxs.size > 0 && !s.human_already_built) {
    try {
      const pyResult = game.estimate_build_cost(
        pyodide.toPy([...selectedBuildIdxs]),
      );
      buildEstimate = pyResult.toJs({ dict_converter: Object.fromEntries });
    } catch (err) {
      console.error("estimate_build_cost failed", err);
    }
  }

  const swapPending = pendingPoolSwapIdx !== null;

  el.innerHTML = p.hand.map((card, i) => {
    const inBuild = selectedBuildIdxs.has(i);
    const affordable = affordableSingleIdxs.has(i);
    const classes = ["hand-card"];
    if (swapPending) classes.push("swap-target");
    if (inBuild) classes.push("selected-build");
    if (!affordable && card.costs.length && !inBuild) {
      classes.push("unaffordable");
    }

    const costText = card.costs.length
      ? card.costs.map((c) => `${c.amount} ${c.resource}`).join(", ")
      : "Free";
    const rateText = card.rates.length
      ? card.rates.map((r) => {
          const cls = r.amount > 0 ? "resource-plus" : "resource-minus";
          return `<span class="${cls}">${r.amount > 0 ? "+" : ""}${r.amount} ${r.resource}</span>`;
        }).join(" ")
      : "<em>no rates</em>";

    const alt = card.can_fulfill_contract
      ? "Contract icon"
      : card.can_sell.length
      ? `Sell: ${card.can_sell.join("/")}`
      : "";

    const effectText = card.effect
      ? `<div class="hand-card-effect">${card.effect}</div>`
      : "";

    const marker = inBuild ? "✓ BUILD" : "";

    return `
      <div class="${classes.join(" ")}" data-hand-idx="${i}">
        <div class="hand-card-name">${card.building}
          ${marker ? `<span class="card-marker">${marker}</span>` : ""}
        </div>
        ${effectText}
        <div class="hand-card-section">
          <span class="hand-card-label">Cost:</span> ${costText}
        </div>
        <div class="hand-card-section">
          <span class="hand-card-label">Rates:</span> ${rateText}
        </div>
        <div class="hand-card-meta">${alt}</div>
      </div>`;
  }).join("");

  // Wire clicks. If a pool swap is pending, a hand click executes the swap;
  // otherwise left-click toggles build set, shift-click toggles discard set.
  el.querySelectorAll(".hand-card").forEach((cardEl) => {
    const idx = parseInt(cardEl.dataset.handIdx, 10);
    cardEl.addEventListener("click", (e) => {
      if (pendingPoolSwapIdx !== null) {
        // Execute the pool swap
        executePoolSwap(idx, pendingPoolSwapIdx);
        return;
      }
      // Toggle as "selected hand card". The same selection set is reused
      // for build / sell / contract paths.
      if (selectedBuildIdxs.has(idx)) {
        selectedBuildIdxs.delete(idx);
      } else {
        // Cap selection size by cards_remaining — this enables
        // multi-card builds. For sell/contract the user picks 1.
        const legal = currentLegal || {};
        const cr = legal.cards_remaining ?? 2;
        const cap = Math.max(1, cr);
        if (selectedBuildIdxs.size >= cap) {
          // Refuse silently — render will show a hint
          return;
        }
        selectedBuildIdxs.add(idx);
      }
      render();
    });
  });

  // Show a live build estimate summary above the action bar
  const summaryEl = document.getElementById("build-estimate");
  if (summaryEl) {
    if (s.human_already_built) {
      summaryEl.innerHTML =
        '<span style="color:#8b949e">You already built this turn.</span>';
    } else if (selectedBuildIdxs.size === 0) {
      summaryEl.innerHTML = "";
    } else if (buildEstimate && buildEstimate.ok) {
      const deficitStr = Object.entries(buildEstimate.deficit)
        .map(([r, a]) => `${a} ${r}`)
        .join(", ") || "nothing";
      summaryEl.innerHTML = `
        <span style="color:#8b949e">Building ${selectedBuildIdxs.size} card(s):
        market needs <strong style="color:#c9d1d9">${deficitStr}</strong>,
        cost <strong class="positive">$${buildEstimate.cost}</strong></span>`;
    } else if (buildEstimate) {
      summaryEl.innerHTML = `<span class="negative">Build: ${buildEstimate.reason}</span>`;
    }
  }
}

function renderActionBar() {
  const s = currentState;
  const humans = s.human_indices || [s.human_index ?? 0];
  const isHuman = humans.includes(s.current_player_index) && !s.is_over;
  const legal = currentLegal || {};

  const buildBtn = document.getElementById("build-btn");
  const sellBtn = document.getElementById("sell-btn");
  const contractBtn = document.getElementById("contract-btn");
  const passBtn = document.getElementById("pass-btn");
  const instr = document.getElementById("action-instructions");

  if (!isHuman) {
    buildBtn.disabled = true;
    sellBtn.disabled = true;
    contractBtn.disabled = true;
    passBtn.disabled = true;
    instr.textContent = "Waiting for AI…";
    return;
  }

  passBtn.disabled = false;

  // Build: requires at least one card in build set, not yet built this turn,
  // AP ≥ #cards, and ≤ 2 cards selected.
  const alreadyBuilt = !!s.human_already_built;
  const cr = legal.cards_remaining ?? 0;
  const hasBuildCards = selectedBuildIdxs.size > 0;
  const buildSize = selectedBuildIdxs.size;
  const canBuild =
    hasBuildCards &&
    !alreadyBuilt &&
    buildSize <= cr;
  buildBtn.disabled = !canBuild;

  // Sell: requires exactly one card selected, sellable, AND ≥ 1 card remaining.
  // can_sell is now a list of {card_idx, resources: [{resource, rate, price, revenue}]}
  const canSellList = legal.can_sell || [];
  const canSellIdxs = new Set(canSellList.map((e) => e.card_idx));
  const singleSelected = selectedBuildIdxs.size === 1 ? [...selectedBuildIdxs][0] : null;
  const canSell =
    singleSelected !== null &&
    canSellIdxs.has(singleSelected) &&
    cr >= 1;
  sellBtn.disabled = !canSell;

  // Show sell resource picker when a sellable card with multiple options is selected
  const sellPickerEl = document.getElementById("build-estimate");
  if (canSell && sellPickerEl) {
    const sellEntry = canSellList.find((e) => e.card_idx === singleSelected);
    if (sellEntry && sellEntry.resources.length > 1) {
      const opts = sellEntry.resources.map((r) =>
        `<label style="display:inline-block; margin-right:12px; cursor:pointer; color:#c9d1d9;">
          <input type="radio" name="sell-resource" value="${r.resource}"
                 ${selectedSellResource === r.resource ? "checked" : ""}>
          ${r.resource} (${r.rate} × $${r.price} = $${r.revenue})
        </label>`
      ).join("");
      sellPickerEl.innerHTML = `
        <div style="margin-top:4px;">
          <span style="color:#8b949e; font-size:0.8rem;">Sell which resource?</span><br>
          ${opts}
        </div>`;
      sellPickerEl.querySelectorAll('input[name="sell-resource"]').forEach((radio) => {
        radio.addEventListener("change", () => {
          selectedSellResource = radio.value;
        });
      });
      // Default to the highest revenue if none selected
      if (!selectedSellResource && sellEntry.resources.length > 0) {
        const best = sellEntry.resources.reduce((a, b) => a.revenue > b.revenue ? a : b);
        selectedSellResource = best.resource;
      }
    } else if (sellEntry && sellEntry.resources.length === 1) {
      selectedSellResource = sellEntry.resources[0].resource;
    }
  }

  // Contract: legal if a contract is selected and EITHER:
  //   (a) a hand-card is selected and the (card,contract) pair is in can_contract
  //   (b) Launch Pad toggle is on (FREE — no AP gate)
  // Path (a) costs 1 AP; (b) is free.
  const canContractList = legal.can_contract || [];
  const matchKey = (entry) =>
    `${entry.card_idx}-${entry.contract_idx}-${entry.use_elevator ? 1 : 0}-${entry.use_launch_pad ? 1 : 0}-${entry.elevator_target || ""}`;
  const validKeys = new Set(canContractList.map(matchKey));
  let canContract = false;
  if (selectedContractIdx !== null) {
    const targetCardIdx = useLaunchPadThisFulfill ? -1 : singleSelected;
    const elevatorKey = useElevatorThisFulfill ? (elevatorTargetResource || "") : "";
    const crOk = useLaunchPadThisFulfill || cr >= 1;
    canContract =
      targetCardIdx !== null &&
      targetCardIdx !== undefined &&
      (useLaunchPadThisFulfill || singleSelected !== null) &&
      crOk &&
      validKeys.has(
        `${targetCardIdx}-${selectedContractIdx}-${useElevatorThisFulfill ? 1 : 0}-${useLaunchPadThisFulfill ? 1 : 0}-${elevatorKey}`
      );
  }
  contractBtn.disabled = !canContract;

  // Render the special-building toggles (SE / LP / HA picker)
  renderSpecialToggles(legal, singleSelected);

  // Hint text
  if (cr === 0 && !useLaunchPadThisFulfill) {
    instr.textContent = "No cards left to spend this turn. Free actions / Launch Pad still available, otherwise pass.";
  } else if (alreadyBuilt && selectedBuildIdxs.size === 0 && selectedContractIdx === null) {
    instr.textContent = "You've already built this turn. You can still sell, fulfill contracts, or pass.";
  } else if (selectedBuildIdxs.size === 0 && selectedContractIdx === null) {
    instr.textContent = `Cards: ${cr}/2. Click hand cards to build, sell, or pick a contract.`;
  } else if (selectedBuildIdxs.size > 1) {
    instr.textContent = `Building ${selectedBuildIdxs.size} card(s). Click Build to confirm.`;
  } else if (canContract) {
    instr.textContent = "Click Fulfill Contract to pay the rate cost and claim the reward.";
  } else if (singleSelected !== null) {
    instr.textContent = "Choose Build, Sell, or (with a contract selected) Fulfill Contract.";
  } else if (selectedContractIdx !== null) {
    instr.textContent = "Now select a hand card with a contract icon to fulfill this contract.";
  }
}

function renderSpecialToggles(legal, singleSelected) {
  const host = document.getElementById("special-toggles");
  if (!host) return;
  const seStatus = (legal && legal.space_elevator_status) || {};
  const lpStatus = (legal && legal.launch_pad_status) || {};
  const haStatus = (legal && legal.hacker_array_status) || {};

  const parts = [];

  // Hacker Array picker — only relevant when a sell candidate is selected
  if (haStatus.owned && singleSelected !== null && singleSelected !== undefined) {
    const dirSign = hackerDirection > 0 ? "+3" : hackerDirection < 0 ? "-3" : "0";
    const dirColor = hackerDirection > 0 ? "#3fb950" : hackerDirection < 0 ? "#f85149" : "#8b949e";
    parts.push(`
      <div class="toggle-row">
        <span class="toggle-label">Hacker Array:</span>
        <select id="ha-target" class="toggle-select">
          <option value="">— skip bonus —</option>
          <option value="PWR" ${hackerTarget === "PWR" ? "selected" : ""}>PWR</option>
          <option value="H2O" ${hackerTarget === "H2O" ? "selected" : ""}>H2O</option>
          <option value="FE" ${hackerTarget === "FE" ? "selected" : ""}>FE</option>
          <option value="C" ${hackerTarget === "C" ? "selected" : ""}>C</option>
          <option value="SI" ${hackerTarget === "SI" ? "selected" : ""}>SI</option>
          <option value="O2" ${hackerTarget === "O2" ? "selected" : ""}>O2</option>
          <option value="FOOD" ${hackerTarget === "FOOD" ? "selected" : ""}>FOOD</option>
          <option value="GLS" ${hackerTarget === "GLS" ? "selected" : ""}>GLS</option>
          <option value="ELX" ${hackerTarget === "ELX" ? "selected" : ""}>ELX</option>
        </select>
        <button id="ha-up" class="action-btn ${hackerDirection > 0 ? "active" : ""}">↑ +3</button>
        <button id="ha-down" class="action-btn ${hackerDirection < 0 ? "active" : ""}">↓ -3</button>
        <span style="color:${dirColor}; font-size:0.8rem;">${hackerTarget ? `${hackerTarget} ${dirSign}` : "no bonus"}</span>
      </div>
    `);
  }

  // Space Elevator toggle + target picker. Visible whenever owned.
  // The picker enumerates the resources on the SELECTED contract so the
  // player can choose which one to discount (-1 to ONE resource).
  if (seStatus.owned) {
    const used = !!seStatus.used;
    let targetOptions = "";
    let targetSection = "";
    if (useElevatorThisFulfill && !used && selectedContractIdx !== null) {
      const s = currentState;
      const contract = s.available_contracts && s.available_contracts[selectedContractIdx];
      if (contract && contract.requirements) {
        targetOptions = contract.requirements
          .map((r) => `<option value="${r.resource}" ${elevatorTargetResource === r.resource ? "selected" : ""}>${r.resource}</option>`)
          .join("");
        targetSection = `
          <select id="se-target" class="toggle-select">
            <option value="">— pick a resource —</option>
            ${targetOptions}
          </select>
        `;
      }
    }
    parts.push(`
      <div class="toggle-row">
        <label class="toggle-checkbox-label">
          <input type="checkbox" id="se-toggle" ${useElevatorThisFulfill && !used ? "checked" : ""} ${used ? "disabled" : ""}>
          <span>Use Space Elevator (-1 to one resource)</span>
        </label>
        ${targetSection}
        ${used ? '<span style="color:#8b949e; font-size:0.75rem;">already used this turn</span>' : ''}
      </div>
    `);
  }

  // Launch Pad toggle — visible whenever owned. Disabled if used.
  if (lpStatus.owned) {
    const used = !!lpStatus.used;
    parts.push(`
      <div class="toggle-row">
        <label class="toggle-checkbox-label">
          <input type="checkbox" id="lp-toggle" ${useLaunchPadThisFulfill && !used ? "checked" : ""} ${used ? "disabled" : ""}>
          <span>Use Launch Pad (free contract — 0 AP)</span>
        </label>
        ${used ? '<span style="color:#8b949e; font-size:0.75rem;">already used this turn</span>' : ''}
      </div>
    `);
  }

  host.innerHTML = parts.join("");

  // Wire HA picker
  const haTargetEl = document.getElementById("ha-target");
  if (haTargetEl) {
    haTargetEl.addEventListener("change", (e) => {
      hackerTarget = e.target.value;
      if (!hackerTarget) hackerDirection = 0;
      render();
    });
  }
  const haUpEl = document.getElementById("ha-up");
  if (haUpEl) {
    haUpEl.addEventListener("click", () => {
      hackerDirection = hackerDirection === 1 ? 0 : 1;
      render();
    });
  }
  const haDownEl = document.getElementById("ha-down");
  if (haDownEl) {
    haDownEl.addEventListener("click", () => {
      hackerDirection = hackerDirection === -1 ? 0 : -1;
      render();
    });
  }

  // Wire SE/LP toggles
  const seToggleEl = document.getElementById("se-toggle");
  if (seToggleEl) {
    seToggleEl.addEventListener("change", (e) => {
      useElevatorThisFulfill = e.target.checked;
      if (!useElevatorThisFulfill) elevatorTargetResource = "";
      render();
    });
  }
  const seTargetEl = document.getElementById("se-target");
  if (seTargetEl) {
    seTargetEl.addEventListener("change", (e) => {
      elevatorTargetResource = e.target.value;
      render();
    });
  }
  const lpToggleEl = document.getElementById("lp-toggle");
  if (lpToggleEl) {
    lpToggleEl.addEventListener("change", (e) => {
      useLaunchPadThisFulfill = e.target.checked;
      render();
    });
  }
}

// --- Mid-event prompt modal ---

function maybeShowPromptModal() {
  const s = currentState;
  if (!s || !s.pending_prompt) {
    hidePromptModal();
    return;
  }
  renderPromptModal(s.pending_prompt);
  document.getElementById("prompt-modal").style.display = "flex";
}

function hidePromptModal() {
  const modal = document.getElementById("prompt-modal");
  if (modal) modal.style.display = "none";
}

function renderPromptModal(prompt) {
  const titleEl = document.getElementById("prompt-title");
  const bodyEl = document.getElementById("prompt-body");
  if (!titleEl || !bodyEl) return;
  if (prompt.kind === "patent_auction") {
    titleEl.textContent = "Patent Auction";
    const patent = prompt.patent || {};
    const ratesStr = (patent.rates || [])
      .map((r) => `${r.amount > 0 ? "+" : ""}${r.amount} ${r.resource}`)
      .join(", ");
    const effectStr = patent.effect || "(no effect)";
    const humans = currentState.human_indices || [];
    const youIdx = activeHumanIndex(currentState);
    // Build per-human bid inputs (for hot-seat games, every human bids).
    const inputs = humans
      .map((idx) => {
        const player = currentState.players[idx];
        const isYou = idx === youIdx ? " (active)" : "";
        return `
          <div class="prompt-row">
            <label>${player.name}${isYou}:</label>
            <input type="number" class="prompt-bid-input" data-seat-idx="${idx}"
                   min="0" max="500" step="5" value="0">
            <span style="color:#8b949e; font-size:0.75rem;">$ as debt</span>
          </div>
        `;
      })
      .join("");
    bodyEl.innerHTML = `
      <p>The next patent is up for auction. Highest bidder wins; ties go to
      the earliest seat. The winner pays runner_up + $5 as debt.</p>
      <div class="prompt-detail">
        <strong>${patent.name}</strong><br>
        Rates: ${ratesStr || "—"}<br>
        Effect: ${effectStr}
      </div>
      ${inputs}
      <p style="color:#8b949e; font-size:0.75rem;">
        Bids round to the nearest $5. Bid 0 to pass. AI players bid using a
        heuristic based on the patent's rate value.
      </p>
    `;
  } else if (prompt.kind === "debt_paydown") {
    titleEl.textContent = "Debt Collection — Pay Down Debt";
    const humans = currentState.human_indices || [];
    const debtors = (prompt.players || []).filter(
      (d) => humans.includes(d.seat)
    );
    if (debtors.length === 0) {
      bodyEl.innerHTML = `<p>No human players have debt to pay down.</p>`;
    } else {
      const inputs = debtors
        .map((d) => {
          const player = currentState.players[d.seat];
          return `
            <div class="prompt-row">
              <label>${player.name}: $${d.debt} debt, $${d.money} cash</label>
              <input type="number" class="prompt-paydown-input" data-seat-idx="${d.seat}"
                     min="0" max="${Math.min(d.debt, d.money)}" step="10" value="${Math.floor(Math.min(d.debt, d.money) / 10) * 10}">
              <span style="color:#8b949e; font-size:0.75rem;">$ to pay</span>
            </div>
          `;
        })
        .join("");
      bodyEl.innerHTML = `
        <p>Before interest is charged, you may pay down debt with cash.
        Interest is $1 per $${currentState.debt_interest_divisor || 10} owed.</p>
        ${inputs}
        <p style="color:#8b949e; font-size:0.75rem;">
          Set to 0 to skip. AI players pay down debt automatically.
        </p>
      `;
    }
  } else {
    titleEl.textContent = "Pending";
    bodyEl.innerHTML = `<p>Unknown prompt: ${prompt.kind}</p>`;
  }
}

function submitPromptAnswer() {
  const s = currentState;
  if (!s || !s.pending_prompt) return;
  const prompt = s.pending_prompt;
  let answers;
  if (prompt.kind === "patent_auction") {
    const bids = {};
    document.querySelectorAll(".prompt-bid-input").forEach((inp) => {
      const idx = parseInt(inp.dataset.seatIdx, 10);
      const amt = Math.max(0, parseInt(inp.value, 10) || 0);
      bids[idx] = amt;
    });
    answers = { bids };
  } else if (prompt.kind === "debt_paydown") {
    const payments = {};
    document.querySelectorAll(".prompt-paydown-input").forEach((inp) => {
      const idx = parseInt(inp.dataset.seatIdx, 10);
      const amt = Math.max(0, parseInt(inp.value, 10) || 0);
      payments[idx] = amt;
    });
    answers = { payments };
  } else {
    answers = {};
  }
  // Resolve the prompt; the return value carries the event detail
  // (e.g. "patent auction: Player_2 won Superconductors for $25 debt"),
  // which we surface in the turn log via logEventResolution.
  const result = game.resolve_pending_prompt(pyodide.toPy(answers))
    .toJs({ dict_converter: Object.fromEntries });
  logEventResolution(result);
  refreshState();
  if (currentState && currentState.pending_prompt) {
    // Cascading prompt — re-show the modal
    maybeShowPromptModal();
    return;
  }
  hidePromptModal();
  // After resolving the prompt, advance AI turns or start the human's next turn.
  if (game.is_over()) {
    showEndgame();
  } else if (!game.is_human_turn()) {
    advanceUntilHuman();
  } else {
    // It's the human's turn — begin it so flags are reset and actions are enabled.
    game.begin_human_turn();
    refreshState();
  }
}

// Append the resolved event detail to the turn log.
// `result` is the dict returned by resolve_pending_prompt: {ok, type, detail, ...}
// or for the AI-resume path the same shape returned by step_ai_turn.
function logEventResolution(result) {
  if (!result || !result.ok) return;
  // The detail string contains everything: who won the auction, the bid, etc.
  const detail = result.detail || (result.event && result.event.detail);
  // event lines may live at the top level (human resume) or nested under
  // result.event.lines (AI resume), depending on which finalizer fired.
  const lines =
    (result.lines && result.lines.length ? result.lines : null) ||
    (result.event && result.event.lines) ||
    [];
  if ((!detail || detail === "no event") && lines.length === 0) return;
  // Find the most recent in-flight event row from this resume chain (if any)
  // and update it. Otherwise push a fresh event row.
  // We identify "in-flight" by the placeholder summary "(event)" used when
  // a paused auction first surfaced through logHumanTurnEnd / logAiTurn.
  let target = null;
  for (let i = turnLog.length - 1; i >= 0; i--) {
    const e = turnLog[i];
    if (e.kind === "event" && (e.summary === "(event)" || e.lines.length === 0)) {
      target = e;
      break;
    }
    if (e.kind === "turn") break;
  }
  if (target) {
    if (detail && detail !== "no event") target.summary = detail;
    if (lines.length > 0) target.lines = lines;
    return;
  }
  // No placeholder — push a fresh event row tied to the current state.
  const s = currentState;
  turnLog.push({
    kind: "event",
    turn: s ? s.turn_index + 1 : "?",
    triggeredBy: s ? s.current_player_index : -1,
    isHuman: false,
    summary: detail || "(event)",
    lines,
  });
}

function renderPatentActions() {
  const s = currentState;
  const legal = currentLegal || {};
  const section = document.getElementById("patent-actions-section");
  if (!section) return;
  const pa = legal.patent_actions || {};
  const oc = legal.optimization_center_status || {};
  const ownsAny =
    pa.water_engine?.owned ||
    pa.nanotechnology?.owned ||
    pa.teleportation?.owned ||
    oc.owned;
  const isHumanTurn = (s.human_indices || []).includes(s.current_player_index);
  if (!ownsAny || !isHumanTurn) {
    section.style.display = "none";
    return;
  }
  section.style.display = "block";

  const host = document.getElementById("patent-actions-list");
  if (!host) return;
  const youIdx = activeHumanIndex(s);
  const youPlayer = s.players[youIdx];

  const parts = [];

  // Helper: choose the right status label based on used vs other gates.
  const statusLabel = (status, otherwiseReason) => {
    if (status.used) return '<span class="patent-action-status">already used this turn</span>';
    if (!status.available) {
      return `<span class="patent-action-status">${otherwiseReason}</span>`;
    }
    return "";
  };

  if (oc.owned) {
    const opts = (oc.valid_resources || [])
      .map((r) => `<option value="${r}">${r}</option>`)
      .join("");
    parts.push(`
      <div class="patent-action-row">
        <strong>Optimization Center</strong> &mdash; -1 PWR rate, +1 to any positive resource.
        <select id="pa-oc-resource" class="toggle-select" ${oc.available ? "" : "disabled"}>
          ${opts || '<option value="">— no positive rates —</option>'}
        </select>
        <button id="pa-oc-btn" class="action-btn" ${oc.available ? "" : "disabled"}>
          Use Optimization Center
        </button>
        ${statusLabel(oc, "no positive rates")}
      </div>
    `);
  }

  if (pa.water_engine?.owned) {
    const status = pa.water_engine;
    parts.push(`
      <div class="patent-action-row">
        <strong>Water Engine</strong> &mdash; spend 1 H2O for 2 PWR.
        <button id="pa-water-engine-btn" class="action-btn"
                ${status.available ? "" : "disabled"}>
          Use Water Engine
        </button>
        ${statusLabel(status, "need +1 H2O rate")}
      </div>
    `);
  }

  if (pa.nanotechnology?.owned) {
    const status = pa.nanotechnology;
    // Build a dropdown of hand cards so the user can pick which one to discard.
    const handOpts = (youPlayer.hand || [])
      .map((c, i) => `<option value="${i}">${i + 1}: ${c.building}</option>`)
      .join("");
    const canUse = status.available && (youPlayer.hand || []).length > 0;
    parts.push(`
      <div class="patent-action-row">
        <strong>Nanotechnology</strong> &mdash; discard 1 card, draw 1 card.
        <select id="pa-nano-card" class="toggle-select" ${canUse ? "" : "disabled"}>
          ${handOpts || '<option value="">— hand is empty —</option>'}
        </select>
        <button id="pa-nanotech-btn" class="action-btn" ${canUse ? "" : "disabled"}>
          Discard &amp; Draw
        </button>
        ${statusLabel(status, "hand is empty")}
      </div>
    `);
  }

  if (pa.teleportation?.owned) {
    const status = pa.teleportation;
    const opts = (status.valid_resources || [])
      .map((r) => `<option value="${r}">${r}</option>`)
      .join("");
    parts.push(`
      <div class="patent-action-row">
        <strong>Teleportation</strong> &mdash; sell any resource at market price (-1 PWR cost).
        <select id="pa-tele-resource" class="toggle-select" ${status.available ? "" : "disabled"}>
          ${opts || '<option value="">— no valid resources —</option>'}
        </select>
        <button id="pa-tele-btn" class="action-btn" ${status.available ? "" : "disabled"}>
          Use Teleportation
        </button>
        ${statusLabel(status, "no positive rates to sell")}
      </div>
    `);
  }

  host.innerHTML = parts.join("");

  // Wire button handlers
  const ocBtn = document.getElementById("pa-oc-btn");
  if (ocBtn) {
    ocBtn.addEventListener("click", () => {
      const sel = document.getElementById("pa-oc-resource");
      if (!sel || !sel.value) {
        alert("Pick a resource to boost first.");
        return;
      }
      const result = game.use_optimization_center(youIdx, sel.value)
        .toJs({ dict_converter: Object.fromEntries });
      if (result.ok) {
        logHumanAction(result);
      } else {
        alert(`Optimization Center failed: ${result.reason}`);
      }
      refreshState();
    });
  }
  const weBtn = document.getElementById("pa-water-engine-btn");
  if (weBtn) {
    weBtn.addEventListener("click", () => {
      const result = game.use_water_engine(youIdx).toJs({ dict_converter: Object.fromEntries });
      if (result.ok) {
        logHumanAction(result);
      } else {
        alert(`Water Engine failed: ${result.reason}`);
      }
      refreshState();
    });
  }
  const nanoBtn = document.getElementById("pa-nanotech-btn");
  if (nanoBtn) {
    nanoBtn.addEventListener("click", () => {
      const sel = document.getElementById("pa-nano-card");
      if (!sel || sel.value === "") {
        alert("Pick a card to discard first.");
        return;
      }
      const cardIdx = parseInt(sel.value, 10);
      const result = game.use_nanotechnology(youIdx, cardIdx)
        .toJs({ dict_converter: Object.fromEntries });
      if (result.ok) {
        logHumanAction(result);
      } else {
        alert(`Nanotechnology failed: ${result.reason}`);
      }
      refreshState();
    });
  }
  const teleBtn = document.getElementById("pa-tele-btn");
  if (teleBtn) {
    teleBtn.addEventListener("click", () => {
      const sel = document.getElementById("pa-tele-resource");
      if (!sel || !sel.value) {
        alert("Pick a resource for Teleportation first.");
        return;
      }
      const result = game.use_teleportation(youIdx, sel.value)
        .toJs({ dict_converter: Object.fromEntries });
      if (result.ok) {
        logHumanAction(result);
      } else {
        alert(`Teleportation failed: ${result.reason}`);
      }
      refreshState();
    });
  }
}

function _nwParts(rec) {
  const parts = [];
  if (rec.money_after !== undefined && rec.money_after !== null) {
    parts.push(`$${rec.money_after}`);
  }
  if (rec.debt_after) {
    parts.push(`debt $${rec.debt_after}`);
  }
  if (rec.credit_after) {
    parts.push(`credit $${rec.credit_after}`);
  }
  if (rec.net_worth_after !== undefined && rec.net_worth_after !== null) {
    parts.push(`NW $${rec.net_worth_after}`);
  }
  return parts;
}

function renderTurnEntry(entry, s, humans) {
  const idx = entry.playerIdx;
  const player = s && idx >= 0 ? s.players[idx] : null;
  const baseName = player ? player.name : "?";
  const youSuffix = humans.includes(idx) ? " (You)" : "";
  const color = idx >= 0 ? playerColor(idx) : "#21262d";
  const cls = entry.isHuman ? "log-entry human" : "log-entry";
  const actions = entry.actions || [];
  const summary = actions.length
    ? actions.map((a) => a.detail).join("; ")
    : "Passed";
  const lastNw = actions.length
    ? actions[actions.length - 1].net_worth_after
    : null;
  const nwBadge =
    lastNw !== undefined && lastNw !== null
      ? `<span class="log-nw">NW $${lastNw}</span>`
      : "";
  const expandable = actions.length > 0;
  const detailsRows = actions.map((a) => {
    const parts = _nwParts(a);
    const nwSuffix = parts.length
      ? `<span class="log-action-nw">${parts.join(" · ")}</span>`
      : "";
    return `<div class="log-action">
      <span class="log-action-detail">${a.detail || a.type}</span>
      ${nwSuffix}
    </div>`;
  }).join("");
  const summaryRow = `<summary class="log-summary">
    <span class="turn-num">T${entry.turn}</span>
    <span class="player-name">${baseName}${youSuffix}</span>
    <span class="log-summary-text">${summary}</span>
    ${nwBadge}
  </summary>`;
  if (expandable) {
    return `<details class="${cls}" style="--player-color:${color}">
      ${summaryRow}
      <div class="log-actions-list">${detailsRows}</div>
    </details>`;
  }
  // No actions to expand — render as a flat row.
  return `<div class="${cls} log-entry-flat" style="--player-color:${color}">
    <span class="turn-num">T${entry.turn}</span>
    <span class="player-name">${baseName}${youSuffix}</span>
    <span class="log-summary-text">${summary}</span>
  </div>`;
}

function renderEventEntry(entry, humans) {
  const lines = entry.lines || [];
  const summary = entry.summary || "(event)";
  // Header line: ⚡ icon + summary text + line count badge.
  const headerRow = `<summary class="log-event-summary">
    <span class="turn-num">T${entry.turn}</span>
    <span class="event-tag">⚡</span>
    <span class="log-summary-text">${summary}</span>
  </summary>`;
  // The body shows each structured line.
  const bodyRows = lines.map((line) => {
    if (line.kind === "header") {
      return `<div class="log-event-line header">${line.text || ""}</div>`;
    }
    if (line.kind === "note") {
      return `<div class="log-event-line note">${line.text || ""}</div>`;
    }
    // Per-player line.
    const idx = line.player_idx;
    const youSuffix = humans.includes(idx) ? " (You)" : "";
    const color = idx >= 0 ? playerColor(idx) : "#8b949e";
    const parts = _nwParts(line);
    const nwSuffix = parts.length
      ? `<span class="log-event-nw">${parts.join(" · ")}</span>`
      : "";
    return `<div class="log-event-line player" style="--player-color:${color}">
      <span class="log-event-player-name">${line.name || "?"}${youSuffix}</span>
      <span class="log-event-text">${line.text || ""}</span>
      ${nwSuffix}
    </div>`;
  }).join("");
  if (lines.length === 0) {
    // Nothing to expand — render as a flat row.
    return `<div class="log-entry log-event-entry log-entry-flat">
      <span class="turn-num">T${entry.turn}</span>
      <span class="event-tag">⚡</span>
      <span class="log-summary-text">${summary}</span>
    </div>`;
  }
  return `<details class="log-entry log-event-entry">
    ${headerRow}
    <div class="log-event-lines">${bodyRows}</div>
  </details>`;
}

function renderLog() {
  const el = document.getElementById("turn-log");
  if (turnLog.length === 0) {
    el.innerHTML = "<em style='color:#484f58'>No turns yet</em>";
    return;
  }
  const s = currentState;
  const humans = (s && s.human_indices) || [];
  el.innerHTML = turnLog.slice(-60).reverse().map((entry) => {
    if (entry.kind === "event") return renderEventEntry(entry, humans);
    return renderTurnEntry(entry, s, humans);
  }).join("");
}

// --- Action handlers ---

function wireButtons() {
  document.getElementById("build-btn").addEventListener("click", onBuild);
  document.getElementById("sell-btn").addEventListener("click", onSell);
  document.getElementById("contract-btn").addEventListener("click", onContract);
  document.getElementById("pass-btn").addEventListener("click", onPass);
  document.getElementById("new-game-btn").addEventListener("click", () => {
    showNewGameModal({ initial: false });
  });
  document.getElementById("play-again-btn").addEventListener("click", () => {
    showNewGameModal({ initial: false });
  });
  document.getElementById("endgame-dismiss-btn").addEventListener("click", () => {
    document.getElementById("endgame-overlay").style.display = "none";
  });
  document.getElementById("ng-start-btn").addEventListener("click", () => {
    const cfg = readNewGameConfig();
    if (!cfg.seats.length) return;
    // Validate the event-config JSON inline so the user sees the error in the
    // modal instead of a Pyodide traceback in the console.
    const errEl = document.getElementById("ng-config-error");
    const parseResult = parseEventConfig(cfg.eventConfigText);
    if (!parseResult.ok) {
      if (errEl) errEl.textContent = parseResult.error;
      // Auto-open the Advanced section so the user actually sees the error.
      const adv = document.getElementById("ng-advanced");
      if (adv) adv.open = true;
      return;
    }
    if (errEl) errEl.textContent = "";
    cfg.eventConfig = parseResult.parsed;  // null if textarea was empty
    startNewGame(cfg);
  });
  document.getElementById("ng-cancel-btn").addEventListener("click", () => {
    hideNewGameModal();
  });

  // Mid-event prompt modal submit (replaces the old patent-bid panel)
  const promptSubmitBtn = document.getElementById("prompt-submit-btn");
  if (promptSubmitBtn) {
    promptSubmitBtn.addEventListener("click", submitPromptAnswer);
  }
}

function onBuild() {
  if (selectedBuildIdxs.size === 0) return;
  const s = currentState;
  const youIdx = activeHumanIndex(s);
  const selectedCards = [...selectedBuildIdxs].map((i) => s.players[youIdx].hand[i]).filter(Boolean);
  const hasPatentOffice = selectedCards.some((c) => c.building === "Patent Office");

  if (hasPatentOffice && s.patent_pile_remaining > 0) {
    // Fetch the patents ONLY now (after the player commits to building).
    const patents = game.peek_patent_office_patents()
      .toJs({ dict_converter: Object.fromEntries });
    if (patents.length >= 2) {
      // Show a simple pick dialog
      const names = patents.map((p, i) => `${i + 1}. ${p.name} — ${p.effect}`);
      const choice = prompt(
        `Patent Office: choose which patent to keep:\n\n${names.join("\n")}\n\nEnter 1 or 2:`
      );
      const pick = parseInt(choice, 10);
      if (pick !== 1 && pick !== 2) return; // cancelled or invalid
      patentOfficePick = pick - 1;
    } else {
      patentOfficePick = 0; // only 1 patent left, auto-pick
    }
  } else {
    patentOfficePick = null;
  }

  const action = {
    type: "build",
    build_cards: [...selectedBuildIdxs],
  };
  if (patentOfficePick !== null) {
    action.patent_office_pick = patentOfficePick;
  }
  applyHumanAction(action, (result) => {
    if (result.ok) {
      logHumanAction(result);
    }
  });
}

function onSell() {
  if (selectedBuildIdxs.size !== 1) return;
  const cardIdx = [...selectedBuildIdxs][0];
  const action = {
    type: "sell",
    card_idx: cardIdx,
    sell_resource: selectedSellResource || "",
    hacker_target: hackerTarget || "",
    hacker_direction: hackerDirection,
  };
  applyHumanAction(action, (result) => {
    if (result.ok) {
      logHumanAction(result);
    }
  });
}

function onContract() {
  if (selectedContractIdx === null) return;
  // Two paths:
  //   - useLaunchPadThisFulfill: card_idx = -1, no hand card needed (FREE)
  //   - default: exactly 1 selected card becomes the contract card
  if (!useLaunchPadThisFulfill && selectedBuildIdxs.size !== 1) return;
  const cardIdx = useLaunchPadThisFulfill ? -1 : [...selectedBuildIdxs][0];
  const action = {
    type: "contract",
    card_idx: cardIdx,
    contract_idx: selectedContractIdx,
    use_elevator: useElevatorThisFulfill,
    use_launch_pad: useLaunchPadThisFulfill,
    elevator_target: useElevatorThisFulfill ? elevatorTargetResource : "",
  };
  applyHumanAction(action, (result) => {
    if (result.ok) {
      logHumanAction(result);
    }
  });
}

function executePoolSwap(handIdx, poolIdx) {
  const pyResult = game.human_pool_swap(handIdx, poolIdx);
  const result = pyResult.toJs({ dict_converter: Object.fromEntries });
  if (!result.ok) {
    alert(`Pool swap failed: ${result.reason}`);
    return;
  }
  pendingPoolSwapIdx = null;
  refreshState();
}

function applyHumanAction(action, onSuccess) {
  const pyResult = game.apply_human_action(pyodide.toPy(action));
  const result = pyResult.toJs({ dict_converter: Object.fromEntries });
  if (!result.ok) {
    alert(`Action failed: ${result.reason}`);
    return;
  }
  onSuccess(result);
  clearSelection();
  refreshState();
}

function onPass() {
  // End the human's turn: draw + event, then AI turns
  const eventResult = game.end_human_turn().toJs({ dict_converter: Object.fromEntries });
  logHumanTurnEnd(eventResult);
  // If the event paused for a prompt, surface the modal and don't advance.
  if (eventResult.awaiting_prompt) {
    refreshState();
    maybeShowPromptModal();
    return;
  }
  // Advance through AI turns
  advanceUntilHuman();
}

// --- Log helpers ---

// Returns the in-progress human turn row, creating one if none exists.
// Reuses the most recent entry only if it's still the active turn row for
// this (turn, player) combo — once an event row has been pushed for this
// turn, the turn is closed and a new turn row would start fresh.
function getCurrentHumanLogEntry() {
  const s = currentState;
  const turn = s.turn_index + 1;
  const playerIdx = s.current_player_index;
  if (turnLog.length > 0) {
    const last = turnLog[turnLog.length - 1];
    if (
      last.kind === "turn" &&
      last.isHuman &&
      last.turn === turn &&
      last.playerIdx === playerIdx
    ) {
      return last;
    }
  }
  const entry = {
    kind: "turn",
    turn,
    playerIdx,
    isHuman: true,
    actions: [],
  };
  turnLog.push(entry);
  return entry;
}

function _normalizeAction(a) {
  return {
    type: a.type || "action",
    detail: a.detail || "",
    buildings: a.buildings || [],
    build_money_spent: a.build_money_spent,
    sell_resource: a.sell_resource,
    sell_amount: a.sell_amount,
    sell_revenue: a.sell_revenue,
    contract_label: a.contract_label,
    contract_reward: a.contract_reward,
    money_after: a.money_after,
    debt_after: a.debt_after,
    credit_after: a.credit_after,
    net_worth_after: a.net_worth_after,
  };
}

function logHumanAction(result) {
  const entry = getCurrentHumanLogEntry();
  entry.actions.push(_normalizeAction(result));
  render();
}

// Push an event row right after the human's turn row. Always emits a row
// if either a summary string or any structured lines were returned, even
// when the player took no actions (so the turn row stays empty but the
// event still appears in the log).
function logHumanTurnEnd(eventResult) {
  // Make sure a turn row exists in case the human passed with no actions.
  getCurrentHumanLogEntry();
  const summary =
    eventResult.detail && eventResult.detail !== "no event"
      ? eventResult.detail
      : null;
  const lines = eventResult.lines || [];
  if (!summary && lines.length === 0) return;
  const s = currentState;
  turnLog.push({
    kind: "event",
    turn: s.turn_index + 1,
    triggeredBy: s.current_player_index,
    isHuman: true,
    summary: summary || "(event)",
    lines,
  });
}

function logAiTurn(result) {
  if (!result.ok) return;
  const s = currentState;
  const turnNum = s ? s.turn_index + 1 : "?";
  // Always push the turn row (even if no actions, so the player is still
  // attributed in the log).
  turnLog.push({
    kind: "turn",
    turn: turnNum,
    playerIdx: result.player_index,
    isHuman: false,
    actions: (result.actions || []).map(_normalizeAction),
  });
  // Then push the event row if anything happened.
  const ev = result.event || {};
  const summary = ev.detail && ev.detail !== "no event" ? ev.detail : null;
  const lines = ev.lines || [];
  if (summary || lines.length > 0) {
    turnLog.push({
      kind: "event",
      turn: turnNum,
      triggeredBy: result.player_index,
      isHuman: false,
      summary: summary || "(event)",
      lines,
    });
  }
}

// --- End-game ---

// Persistent Chart instance for the post-game NW review chart so we can
// destroy it cleanly between games (Chart.js doesn't reuse canvases).
let endgameNwChart = null;

function showEndgame() {
  const scores = game.final_scores().toJs({ dict_converter: Object.fromEntries });
  const overlay = document.getElementById("endgame-overlay");
  const results = document.getElementById("endgame-results");
  results.innerHTML = scores.map((s, rank) => {
    const classes = ["endgame-rank"];
    if (rank === 0) classes.push("winner");
    if (s.is_human) classes.push("human");
    const color = playerColor(s.index);
    return `
      <div class="${classes.join(" ")}" style="--player-color:${color}">
        <span class="endgame-rank-name">
          #${rank + 1} ${s.name}${s.is_human ? " (You)" : ""} — ${s.corporation}
        </span>
        <span class="endgame-rank-nw">$${s.net_worth}</span>
      </div>`;
  }).join("");
  renderEndgameNwChart();
  overlay.style.display = "flex";
}

function renderEndgameNwChart() {
  const s = currentState;
  if (!s || !s.player_history) return;
  const history = s.player_history;
  if (history.length === 0) return;
  const canvas = document.getElementById("endgame-nw-chart");
  if (!canvas) return;
  // Destroy any prior chart so we don't leak Chart.js instances
  if (endgameNwChart) {
    endgameNwChart.destroy();
    endgameNwChart = null;
  }
  const labels = history.map((h) => `T${h.turn}`);
  const numPlayers = history[0].players.length;
  const datasets = [];
  for (let p = 0; p < numPlayers; p++) {
    datasets.push({
      label: history[0].players[p].name,
      data: history.map((h) => h.players[p].net_worth),
      borderColor: playerColor(p),
      backgroundColor: "transparent",
      borderWidth: 2,
      tension: 0.2,
      pointRadius: 0,
    });
  }
  endgameNwChart = new Chart(canvas, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: "#8b949e", font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: $${ctx.parsed.y}`,
          },
        },
      },
      scales: {
        x: {
          title: { display: true, text: "Turn", color: "#8b949e" },
          ticks: { color: "#8b949e", maxTicksLimit: 12 },
          grid: { color: "#21262d" },
        },
        y: {
          title: { display: true, text: "Net Worth ($)", color: "#8b949e" },
          ticks: { color: "#8b949e" },
          grid: { color: "#21262d" },
        },
      },
    },
  });
}

// --- Kickoff ---

boot().catch((err) => {
  setLoadingDetail(`Failed to load: ${err.message}`);
  console.error(err);
});
