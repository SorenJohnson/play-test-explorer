// Mars Colony — playable browser client
// Boots Pyodide, loads the Python engine from frontend/data/game/, and drives
// a stepwise human-vs-AI game via my_project.play_adapter.PlayableGame.

const RESOURCE_COLORS = {
  PWR: "#e74c3c", H2O: "#2c3e80", FE: "#888888", C: "#8e44ad",
  SI: "#f1c40f", O2: "#bdc3c7", FOOD: "#27ae60", GLS: "#5dade2", ELX: "#e67e22",
};

const RESOURCE_ORDER = ["PWR", "H2O", "FE", "C", "SI", "O2", "FOOD", "GLS", "ELX"];

const PY_FILES = [
  "__init__.py", "accounting.py", "models.py", "parsing.py",
  "play_adapter.py", "simulation.py", "strategies.py",
];
const CSV_FILES = ["Cards.csv", "Contracts.csv", "market.csv"];

let pyodide = null;
let game = null;              // Pyodide proxy to PlayableGame instance
let currentState = null;      // most recent state_dict result
let currentLegal = null;      // most recent legal_human_actions result
const turnLog = [];           // array of {turn, player, text, isHuman}

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
  startNewGame();

  document.getElementById("loading").style.display = "none";
  document.getElementById("game-root").style.display = "block";

  wireButtons();
}

function setLoadingDetail(text) {
  const el = document.getElementById("loading-detail");
  if (el) el.textContent = text;
}

async function loadPythonSources() {
  // Create the my_project package structure in Pyodide's virtual FS
  pyodide.FS.mkdirTree("/home/pyodide/my_project/data");

  for (const name of PY_FILES) {
    const resp = await fetch(`data/game/my_project/${name}`);
    if (!resp.ok) throw new Error(`Failed to fetch ${name}: ${resp.status}`);
    const text = await resp.text();
    pyodide.FS.writeFile(`/home/pyodide/my_project/${name}`, text);
  }
  for (const name of CSV_FILES) {
    const resp = await fetch(`data/game/my_project/data/${name}`);
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

function startNewGame(seed = null) {
  if (seed === null) seed = Math.floor(Math.random() * 1_000_000);
  // Destroy prior game if any
  if (game) {
    try { game.destroy(); } catch {}
    game = null;
  }
  pyodide.runPython(`game = PlayableGame(seed=${seed}, num_players=3, human_index=0)`);
  game = pyodide.globals.get("game");
  turnLog.length = 0;
  clearSelection();
  document.getElementById("endgame-overlay").style.display = "none";
  if (game.is_human_turn()) {
    // begin_human_turn resets has_built_this_turn. Must call BEFORE refreshState
    // so the rendered state reflects the fresh turn, not stale flags.
    game.begin_human_turn();
    refreshState();
  } else {
    advanceUntilHuman();
  }
}

function clearSelection() {
  selectedBuildIdxs.clear();
  selectedDiscardIdxs.clear();
  selectedContractIdx = null;
  pendingPoolSwapIdx = null;
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
  renderLog();
}

function renderStatusBar() {
  const s = currentState;
  document.getElementById("round-indicator").textContent = `${s.round} / ${s.max_rounds}`;
  document.getElementById("turn-indicator").textContent = `${s.turn_index + 1} / ${s.total_turns}`;
  document.getElementById("seed-display").textContent = s.seed;
  const activeIdx = s.current_player_index;
  let activeLabel;
  if (activeIdx < 0) {
    activeLabel = "Game Over";
  } else if (activeIdx === s.human_index) {
    activeLabel = "YOU";
  } else {
    activeLabel = s.players[activeIdx].name;
  }
  document.getElementById("active-player").textContent = activeLabel;
}

function renderOpponents() {
  const s = currentState;
  const el = document.getElementById("opponents-strip");
  const opponents = s.players.filter((p) => !p.is_human);
  el.innerHTML = opponents.map((p, i) => {
    const playerIdx = s.players.indexOf(p);
    const isActive = playerIdx === s.current_player_index;
    const rateChips = RESOURCE_ORDER.map((r) => {
      const v = p.rates[r] || 0;
      if (v === 0) return "";
      const color = v > 0 ? "#3fb950" : "#f85149";
      return `<span style="color:${color}">${v > 0 ? "+" : ""}${v} ${r}</span>`;
    }).filter(Boolean).join(" ");
    return `
      <div class="opponent-card ${isActive ? "active" : ""}">
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
}

function renderPlayer() {
  const s = currentState;
  const p = s.players[s.human_index];
  document.getElementById("player-heading").textContent =
    `You — ${p.corporation || "No corporation"}`;

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
  const p = s.players[s.human_index];
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
  const isHumanTurn = s.current_player_index === s.human_index && !s.is_over;
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

    return `
      <div class="${classes.join(" ")}" data-pool-idx="${i}">
        <div class="pool-card-name">${card.building}</div>
        <div class="pool-card-line">Cost: ${costText}</div>
        <div class="pool-card-line">Rates: ${rateText}</div>
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
  const p = s.players[s.human_index];
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
  const isHuman = s.current_player_index === s.human_index && !s.is_over;
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

  // Contract: requires exactly one card selected + a contract selected, pair must be legal
  const validContractPairs = new Set(
    (legal.can_contract || []).map((c) => `${c.card_idx}-${c.contract_idx}`)
  );
  const canContract =
    singleSelected !== null &&
    selectedContractIdx !== null &&
    validContractPairs.has(`${singleSelected}-${selectedContractIdx}`);
  contractBtn.disabled = !canContract;

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

function renderLog() {
  const el = document.getElementById("turn-log");
  if (turnLog.length === 0) {
    el.innerHTML = "<em style='color:#484f58'>No turns yet</em>";
    return;
  }
  el.innerHTML = turnLog.slice(-30).reverse().map((entry) => {
    const cls = entry.isHuman ? "log-entry human" : "log-entry";
    return `<div class="${cls}">
      <span class="turn-num">T${entry.turn}</span>
      <span class="player-name">${entry.player}</span>
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
  document.getElementById("new-game-btn").addEventListener("click", () => startNewGame());
  document.getElementById("play-again-btn").addEventListener("click", () => startNewGame());
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
  const action = { type: "sell", card_idx: cardIdx };
  applyHumanAction(action, (result) => {
    if (result.ok && result.sell_resource) {
      logHumanAction(`Sold ${result.sell_amount} ${result.sell_resource} for $${result.sell_revenue}`);
    } else if (result.ok) {
      logHumanAction("Sold (no matching resources)");
    }
  });
}

function onContract() {
  if (selectedBuildIdxs.size !== 1 || selectedContractIdx === null) return;
  const cardIdx = [...selectedBuildIdxs][0];
  const action = {
    type: "contract",
    card_idx: cardIdx,
    contract_idx: selectedContractIdx,
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
    player: "YOU",
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
      player: "YOU",
      text: "Passed",
      isHuman: true,
      event: eventText,
    });
  }
}

function logAiTurn(result) {
  if (!result.ok) return;
  const playerIdx = result.player_index;
  const playerName = currentState?.players[playerIdx]?.name || `AI_${playerIdx}`;
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
    player: playerName,
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
    return `
      <div class="${classes.join(" ")}">
        <span class="endgame-rank-name">
          #${rank + 1} ${s.is_human ? "(You) " : ""}${s.name} — ${s.corporation}
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
