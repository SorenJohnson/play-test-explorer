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
const CSV_FILES = ["Cards.csv", "Contracts.csv", "market.csv", "Patents.csv"];

let pyodide = null;
let game = null;              // Pyodide proxy to PlayableGame instance
let currentState = null;      // most recent state_dict result
let currentLegal = null;      // most recent legal_human_actions result
const turnLog = [];           // array of {turn, player, text, isHuman}
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
// selectedDiscardIdxs: set of card indices to discard for cost reduction
// selectedContractIdx: the available-contracts index for a contract action
// pendingPoolSwapIdx: pool index clicked by the user, waiting for a hand click
// Sell and contract actions require exactly one card in selectedBuildIdxs.
let selectedBuildIdxs = new Set();
let selectedDiscardIdxs = new Set();
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
  power_bill_count: [3, 4],
  debt_collection_count: [2, 4],
  futures_settlement_count: [3, 4],
  news_count: 0,
  news_pool: [],
  pwr_adjust_fraction: 0.5,
};

// Pretty-printed string used to seed the textarea on first load.
const DEFAULT_EVENT_CONFIG_TEXT = JSON.stringify(DEFAULT_EVENT_CONFIG, null, 2);

// Last-used config so the New Game modal pre-fills with the previous settings.
let lastGameConfig = {
  seats: ["human", "smart", "smart"],
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
if "futures_settlement_count" in _raw:
    _kw["futures_settlement_count"] = _coerce_count(_raw["futures_settlement_count"])
if "news_count" in _raw:
    _kw["news_count"] = _coerce_count(_raw["news_count"])
if "news_pool" in _raw:
    _kw["news_pool"] = _coerce_news(_raw["news_pool"])
if "pwr_adjust_fraction" in _raw:
    _kw["pwr_adjust_fraction"] = float(_raw["pwr_adjust_fraction"])
_event_deck_config = _EDC(**_kw)
`);
    extraKwargs = ", event_deck_config=_event_deck_config";
  }

  pyodide.runPython(
    `game = PlayableGame(seed=${seed}, seats=${seatsLiteral}, names=${namesLiteral}, max_turns=${cfg.rounds}${extraKwargs})`
  );
  game = pyodide.globals.get("game");
  turnLog.length = 0;
  clearSelection();
  if (marketChart) {
    marketChart.destroy();
    marketChart = null;
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
  document.getElementById("ng-rounds").value = String(cfg.rounds);
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
      curSeats[i] || (i === 0 ? "human" : "smart")
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
  const rounds = parseInt(document.getElementById("ng-rounds").value, 10) || 8;
  const seedRaw = document.getElementById("ng-seed").value.trim();
  const seed = seedRaw === "" ? null : parseInt(seedRaw, 10);
  const eventConfigText = document.getElementById("ng-event-config").value;
  return {
    seats,
    names: filledNames,
    rounds,
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
    "futures_settlement_count",
    "news_count",
    "news_pool",
    "pwr_adjust_fraction",
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
  selectedDiscardIdxs.clear();
  selectedContractIdx = null;
  pendingPoolSwapIdx = null;
  useElevatorThisFulfill = false;
  elevatorTargetResource = "";
  useLaunchPadThisFulfill = false;
  hackerTarget = "";
  hackerDirection = 0;
}

function refreshState() {
  const s = game.state_dict().toJs({ dict_converter: Object.fromEntries });
  const legal = game.legal_human_actions().toJs({ dict_converter: Object.fromEntries });
  currentState = s;
  currentLegal = legal;
  render();
}

function advanceUntilHuman() {
  // Run AI turns until it's the human's turn or game ends
  while (!game.is_over() && !game.is_human_turn()) {
    const result = game.step_ai_turn().toJs({ dict_converter: Object.fromEntries });
    logAiTurn(result);
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
  renderOcSection();
  renderPatentSection();
  renderLog();
}

function renderStatusBar() {
  const s = currentState;
  document.getElementById("round-indicator").textContent = `${s.round} / ${s.max_rounds}`;
  document.getElementById("turn-indicator").textContent = `${s.turn_index + 1} / ${s.total_turns}`;
  document.getElementById("seed-display").textContent = s.seed;
  const activeIdx = s.current_player_index;
  const humans = s.human_indices || [s.human_index ?? 0];
  const activeEl = document.getElementById("active-player");
  if (activeIdx < 0) {
    activeEl.innerHTML = "Game Over";
    return;
  }
  const youSuffix = humans.includes(activeIdx) ? " (You)" : "";
  const label = `${s.players[activeIdx].name}${youSuffix}`;
  const color = playerColor(activeIdx);
  activeEl.innerHTML =
    `<span class="player-swatch" style="background:${color}"></span>${label}`;
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

  const buildings = p.buildings_played.length
    ? p.buildings_played.join(", ")
    : "<em>None built yet</em>";

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
      <div class="player-stats-row">
        <span class="player-stats-label">Contracts Fulfilled</span>
        <span class="player-stats-value">${p.contracts_fulfilled}</span>
      </div>
      <div class="player-stats-row">
        <span class="player-stats-label">Net Worth</span>
        <span class="player-stats-value big">$${p.net_worth}</span>
      </div>
      <div class="buildings-list">
        <strong>Buildings (${p.buildings_played.length}):</strong> ${buildings}
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

    return `
      <div class="${classes.join(" ")}" data-pool-idx="${i}">
        <div class="pool-card-name">${card.building}</div>
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
        pyodide.toPy([...selectedDiscardIdxs]),
      );
      buildEstimate = pyResult.toJs({ dict_converter: Object.fromEntries });
    } catch (err) {
      console.error("estimate_build_cost failed", err);
    }
  }

  const swapPending = pendingPoolSwapIdx !== null;

  el.innerHTML = p.hand.map((card, i) => {
    const inBuild = selectedBuildIdxs.has(i);
    const inDiscard = selectedDiscardIdxs.has(i);
    const affordable = affordableSingleIdxs.has(i);
    const classes = ["hand-card"];
    if (swapPending) classes.push("swap-target");
    if (inBuild) classes.push("selected-build");
    if (inDiscard) classes.push("selected-discard");
    if (!affordable && card.costs.length && !inBuild && !inDiscard) {
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

    const marker = inBuild ? "✓ BUILD" : inDiscard ? "✗ DISCARD" : "";

    return `
      <div class="${classes.join(" ")}" data-hand-idx="${i}">
        <div class="hand-card-name">${card.building}
          ${marker ? `<span class="card-marker">${marker}</span>` : ""}
        </div>
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
      if (e.shiftKey) {
        // Toggle as discard; mutually exclusive with build
        if (selectedDiscardIdxs.has(idx)) {
          selectedDiscardIdxs.delete(idx);
        } else {
          selectedDiscardIdxs.add(idx);
          selectedBuildIdxs.delete(idx);
        }
      } else {
        // Toggle as build; mutually exclusive with discard
        if (selectedBuildIdxs.has(idx)) {
          selectedBuildIdxs.delete(idx);
        } else {
          selectedBuildIdxs.add(idx);
          selectedDiscardIdxs.delete(idx);
        }
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
        <span style="color:#8b949e">Building ${selectedBuildIdxs.size} card(s)
        (${selectedDiscardIdxs.size} discard):
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

  // Build: requires at least one card in build set AND not yet built this turn.
  // Live affordability is checked via the estimate call in renderHand.
  const alreadyBuilt = !!s.human_already_built;
  const hasBuildCards = selectedBuildIdxs.size > 0;
  let canBuild = hasBuildCards && !alreadyBuilt;
  if (canBuild) {
    // Quick check: must have affordable estimate. We could call again, but
    // the enable state is checked in onBuild as well.
    // Here, tentatively enable; onBuild will guard against unaffordable.
  }
  buildBtn.disabled = !canBuild;

  // Sell: requires exactly one card in build set AND it must be sellable
  const canSellIdxs = new Set(legal.can_sell || []);
  const singleSelected = selectedBuildIdxs.size === 1 ? [...selectedBuildIdxs][0] : null;
  const canSell = singleSelected !== null && canSellIdxs.has(singleSelected);
  sellBtn.disabled = !canSell;

  // Contract: legal if a contract is selected and EITHER:
  //   (a) a hand-card is selected and the (card,contract) pair is in can_contract
  //   (b) Launch Pad toggle is on, owned, unused, and (-1,contract) is in can_contract
  // Each path can compose with the Space Elevator toggle (which targets one
  // specific resource on the contract via elevatorTargetResource).
  const canContractList = legal.can_contract || [];
  const matchKey = (entry) =>
    `${entry.card_idx}-${entry.contract_idx}-${entry.use_elevator ? 1 : 0}-${entry.use_launch_pad ? 1 : 0}-${entry.elevator_target || ""}`;
  const validKeys = new Set(canContractList.map(matchKey));
  const targetCardIdx = useLaunchPadThisFulfill ? -1 : singleSelected;
  const elevatorKey = useElevatorThisFulfill ? (elevatorTargetResource || "") : "";
  const canContract =
    selectedContractIdx !== null &&
    targetCardIdx !== null &&
    targetCardIdx !== undefined &&
    (useLaunchPadThisFulfill || singleSelected !== null) &&
    validKeys.has(
      `${targetCardIdx}-${selectedContractIdx}-${useElevatorThisFulfill ? 1 : 0}-${useLaunchPadThisFulfill ? 1 : 0}-${elevatorKey}`
    );
  contractBtn.disabled = !canContract;

  // Render the special-building toggles (SE / LP / HA picker)
  renderSpecialToggles(legal, singleSelected);

  // Hint text
  if (alreadyBuilt && selectedBuildIdxs.size === 0 && selectedContractIdx === null) {
    instr.textContent = "You've already built this turn. You can still sell, fulfill contracts, or pass.";
  } else if (selectedBuildIdxs.size === 0 && selectedContractIdx === null) {
    instr.textContent = "Click hand cards to select for build (multiple OK). Shift-click to mark as a discard. Click Pass to end your turn.";
  } else if (selectedBuildIdxs.size > 1) {
    instr.textContent = `Building ${selectedBuildIdxs.size} cards together. Click Build to confirm.`;
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
          <span>Use Launch Pad (free contract icon)</span>
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

function renderOcSection() {
  const s = currentState;
  const legal = currentLegal || {};
  const section = document.getElementById("oc-section");
  if (!section) return;
  const youIdx = activeHumanIndex(s);
  const isHumanTurn = (s.human_indices || []).includes(s.current_player_index);
  if (!isHumanTurn || !legal.optimization_center_owned) {
    section.style.display = "none";
    return;
  }
  section.style.display = "block";
  const pendingPicks = s.pending_oc_picks || {};
  const myPick = pendingPicks[youIdx];
  const status = document.getElementById("oc-status");
  if (status) {
    if (myPick) {
      status.textContent = `Target declared: ${myPick}`;
      status.style.color = "#3fb950";
    } else {
      status.textContent = "No target declared (will auto-pick highest-priced)";
      status.style.color = "#8b949e";
    }
  }
  const input = document.getElementById("oc-target-input");
  if (input && myPick && document.activeElement !== input) {
    input.value = myPick;
  }
}

function renderPatentSection() {
  const s = currentState;
  const section = document.getElementById("patent-section");
  if (!section) return;
  // Hide entirely if no patents are loaded.
  const remaining = s.patent_pile_remaining || 0;
  if (remaining === 0) {
    section.style.display = "none";
    return;
  }
  // Show only on a human's turn (in hot-seat the active human gets to declare).
  const youIdx = activeHumanIndex(s);
  const isHumanTurn = (s.human_indices || []).includes(s.current_player_index);
  if (!isHumanTurn) {
    section.style.display = "none";
    return;
  }
  section.style.display = "block";

  const info = document.getElementById("patent-info");
  if (info) {
    info.textContent =
      `${remaining} patent${remaining === 1 ? "" : "s"} remaining. Set your bid for the next ` +
      `auction. Bids are in $5 increments and paid as debt by the winner. Highest bidder wins ` +
      `(ties go to earliest seat).`;
  }

  // Status: show whether the active human has already declared a bid.
  const pendingBids = s.pending_bids || {};
  const youBid = pendingBids[youIdx];
  const status = document.getElementById("patent-bid-status");
  const input = document.getElementById("patent-bid-input");
  if (status) {
    if (youBid !== undefined) {
      status.textContent = `Bid declared: $${youBid}`;
      status.style.color = "#3fb950";
    } else {
      status.textContent = "No bid declared (will use AI default)";
      status.style.color = "#8b949e";
    }
  }
  // Reflect the declared bid in the input so re-clicks update from a sensible value
  if (input && youBid !== undefined && document.activeElement !== input) {
    input.value = String(youBid);
  }
}

function renderLog() {
  const el = document.getElementById("turn-log");
  if (turnLog.length === 0) {
    el.innerHTML = "<em style='color:#484f58'>No turns yet</em>";
    return;
  }
  const s = currentState;
  const humans = (s && s.human_indices) || [];
  el.innerHTML = turnLog.slice(-30).reverse().map((entry) => {
    const idx = entry.playerIdx;
    const player = s && idx >= 0 ? s.players[idx] : null;
    const baseName = player ? player.name : "?";
    const youSuffix = humans.includes(idx) ? " (You)" : "";
    const color = idx >= 0 ? playerColor(idx) : "#21262d";
    const cls = entry.isHuman ? "log-entry human" : "log-entry";
    return `<div class="${cls}" style="--player-color:${color}">
      <span class="turn-num">T${entry.turn}</span>
      <span class="player-name">${baseName}${youSuffix}</span>
      ${entry.text}
      ${entry.event ? `<div style="margin-top:4px"><span class="event-tag">⚡ ${entry.event}</span></div>` : ""}
    </div>`;
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

  // Patent auction bid controls
  const bidSetBtn = document.getElementById("patent-bid-set-btn");
  if (bidSetBtn) {
    bidSetBtn.addEventListener("click", () => {
      const input = document.getElementById("patent-bid-input");
      if (!input || !game) return;
      const youIdx = activeHumanIndex(currentState);
      const amount = parseInt(input.value, 10) || 0;
      const result = game.set_patent_bid(youIdx, amount).toJs({
        dict_converter: Object.fromEntries,
      });
      if (result.ok) {
        // The Python side may have rounded the amount; reflect that.
        input.value = String(result.amount);
      }
      refreshState();
    });
  }
  const bidClearBtn = document.getElementById("patent-bid-clear-btn");
  if (bidClearBtn) {
    bidClearBtn.addEventListener("click", () => {
      if (!game) return;
      const youIdx = activeHumanIndex(currentState);
      game.clear_patent_bid(youIdx);
      refreshState();
    });
  }

  // Optimization Center picker
  const ocSetBtn = document.getElementById("oc-set-btn");
  if (ocSetBtn) {
    ocSetBtn.addEventListener("click", () => {
      const input = document.getElementById("oc-target-input");
      if (!input || !game) return;
      const youIdx = activeHumanIndex(currentState);
      const value = input.value;
      if (!value) return;
      game.set_oc_pick(youIdx, value);
      refreshState();
    });
  }
  const ocClearBtn = document.getElementById("oc-clear-btn");
  if (ocClearBtn) {
    ocClearBtn.addEventListener("click", () => {
      if (!game) return;
      const youIdx = activeHumanIndex(currentState);
      game.clear_oc_pick(youIdx);
      refreshState();
    });
  }
}

function onBuild() {
  if (selectedBuildIdxs.size === 0) return;
  const action = {
    type: "build",
    build_cards: [...selectedBuildIdxs],
    discard_cards: [...selectedDiscardIdxs],
  };
  applyHumanAction(action, (result) => {
    if (result.ok) {
      logHumanAction(`Built ${result.buildings.join(", ")} for $${result.build_money_spent}`);
    }
  });
}

function onSell() {
  if (selectedBuildIdxs.size !== 1) return;
  const cardIdx = [...selectedBuildIdxs][0];
  const action = {
    type: "sell",
    card_idx: cardIdx,
    hacker_target: hackerTarget || "",
    hacker_direction: hackerDirection,
  };
  applyHumanAction(action, (result) => {
    if (result.ok && result.sell_resource) {
      logHumanAction(`Sold ${result.sell_amount} ${result.sell_resource} for $${result.sell_revenue}`);
    } else if (result.ok) {
      logHumanAction("Sold (no matching resources)");
    }
  });
}

function onContract() {
  // With Launch Pad, no hand card is required.
  if (selectedContractIdx === null) return;
  if (!useLaunchPadThisFulfill && selectedBuildIdxs.size !== 1) return;
  const cardIdx = useLaunchPadThisFulfill
    ? -1
    : [...selectedBuildIdxs][0];
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
      logHumanAction(`Fulfilled contract (${result.contract_label}) for $${result.contract_reward}`);
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
  // Advance through AI turns
  advanceUntilHuman();
}

// --- Log helpers ---

function logHumanAction(text) {
  const s = currentState;
  turnLog.push({
    turn: s.turn_index + 1,
    playerIdx: s.current_player_index,
    text,
    isHuman: true,
    event: null,
  });
  render();
}

function logHumanTurnEnd(eventResult) {
  // Mark the last human entry with the event that fired
  const lastHuman = [...turnLog].reverse().find((e) => e.isHuman);
  const eventText = eventResult.detail && eventResult.detail !== "no event" ? eventResult.detail : null;
  if (lastHuman && eventText) {
    lastHuman.event = eventText;
  } else if (eventText) {
    // The human may have passed with no actions
    const s = currentState;
    turnLog.push({
      turn: s.turn_index + 1,
      playerIdx: s.current_player_index,
      text: "Passed",
      isHuman: true,
      event: eventText,
    });
  }
}

function logAiTurn(result) {
  if (!result.ok) return;
  const s = currentState;
  const turnNum = s ? s.turn_index + 1 : "?";
  const actionText = result.actions.length
    ? result.actions.map((a) => a.detail).join("; ")
    : "Passed";
  const eventText =
    result.event && result.event.detail && result.event.detail !== "no event"
      ? result.event.detail
      : null;
  turnLog.push({
    turn: turnNum,
    playerIdx: result.player_index,
    text: actionText,
    isHuman: false,
    event: eventText,
  });
}

// --- End-game ---

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
  overlay.style.display = "flex";
}

// --- Kickoff ---

boot().catch((err) => {
  setLoadingDetail(`Failed to load: ${err.message}`);
  console.error(err);
});
