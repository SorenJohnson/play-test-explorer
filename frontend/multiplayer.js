// ===== Multiplayer Game — WebRTC P2P via PeerJS =====
//
// Architecture:
//   Host: loads Pyodide, runs game engine, broadcasts state
//   Client: pure JS renderer, sends actions to host via data channel

const RESOURCE_ORDER = ["PWR","H2O","FE","C","SI","O2","FOOD","GLS","ELX"];
const RESOURCE_COLORS = {
  PWR:"#f0883e",H2O:"#58a6ff",FE:"#8b949e",C:"#6e7681",
  SI:"#d2a8ff",O2:"#7ee787",FOOD:"#3fb950",GLS:"#79c0ff",ELX:"#f778ba"
};
const PLAYER_COLORS = ["#58a6ff","#f0883e","#3fb950","#d2a8ff"];

// ===== State =====
let role = null;       // "host" | "client"
let peer = null;       // PeerJS instance
let connections = {};  // {peerId: DataConnection} (host tracks all clients)
let hostConn = null;   // DataConnection to host (client only)
let mySeat = -1;       // this player's seat index

// Host-only state
let pyodide = null;
let game = null;       // PlayableGame Python object
let seatConfig = [];   // [{type: "human-local"|"human-remote"|"optimal"|"smart"|"random", name: "", peerId: null}]
let clientSeats = {};  // {peerId: seatIdx} — which client claimed which seat

// Shared game state (received from host, or generated locally by host)
let currentState = null;
let currentLegal = null;
let selectedCards = new Set();
let selectedContract = -1;
let feedEntries = [];

// ===== Lobby =====

document.getElementById("btn-create").addEventListener("click", () => {
  role = "host";
  document.getElementById("lobby-choice").style.display = "none";
  document.getElementById("host-setup").style.display = "block";
  initHost();
});

document.getElementById("btn-join").addEventListener("click", () => {
  role = "client";
  document.getElementById("lobby-choice").style.display = "none";
  document.getElementById("join-setup").style.display = "block";
});

document.getElementById("btn-connect").addEventListener("click", () => {
  const code = document.getElementById("join-code").value.trim();
  if (!code) return;
  initClient(code);
});

document.getElementById("btn-start").addEventListener("click", startGame);
document.getElementById("prompt-submit").addEventListener("click", submitPrompt);
document.getElementById("btn-new-game").addEventListener("click", () => location.reload());

// ===== Host: PeerJS Setup =====

function initHost() {
  peer = new Peer();
  peer.on("open", (id) => {
    document.getElementById("room-code").textContent = id;
    // Default 3 seats: host + 1 remote + 1 AI
    seatConfig = [
      {type: "human-local", name: "You (Host)", peerId: null},
      {type: "human-remote", name: "Player 2", peerId: null},
      {type: "optimal", name: "AI (Optimal)", peerId: null},
    ];
    mySeat = 0;
    renderSeatGrid();
    updateStartButton();
  });
  peer.on("connection", (conn) => {
    conn.on("open", () => {
      connections[conn.peer] = conn;
      updateHostStatus();
      // Send current lobby state
      conn.send(JSON.stringify({type: "lobby_state", seats: seatConfig.map(s => ({type: s.type, name: s.name, claimed: !!s.peerId || s.type === "human-local"}))}));
    });
    conn.on("data", (raw) => {
      const msg = JSON.parse(raw);
      handleHostMessage(conn, msg);
    });
    conn.on("close", () => {
      handleDisconnect(conn.peer);
    });
  });
  peer.on("error", (err) => {
    document.getElementById("room-code").textContent = "Connection error";
    console.error("PeerJS error:", err);
  });
}

function renderSeatGrid() {
  const grid = document.getElementById("seat-grid");
  grid.innerHTML = seatConfig.map((s, i) => {
    const isHost = i === 0;
    const claimed = s.peerId || isHost;
    return `
      <div class="seat-card ${claimed ? 'claimed' : ''}">
        <div class="seat-label">Seat ${i + 1}${isHost ? ' (You)' : ''}</div>
        ${isHost ? `<div style="color:#3fb950">Host</div>` : `
          <select data-seat="${i}" class="seat-type-select" ${game ? 'disabled' : ''}>
            <option value="human-remote" ${s.type==='human-remote'?'selected':''}>Human (Remote)</option>
            <option value="optimal" ${s.type==='optimal'?'selected':''}>AI - Optimal</option>
            <option value="smart" ${s.type==='smart'?'selected':''}>AI - Smart</option>
            <option value="random" ${s.type==='random'?'selected':''}>AI - Random</option>
            <option value="empty" ${s.type==='empty'?'selected':''}>Empty</option>
          </select>
        `}
        <div class="seat-status">${s.peerId ? 'Connected: ' + (s.name || s.peerId.substring(0,8)) : (s.type === 'human-remote' ? 'Waiting for player...' : '')}</div>
      </div>
    `;
  }).join("");

  // Add/remove seat buttons
  if (!game) {
    grid.innerHTML += `
      <div class="seat-card" style="display:flex;align-items:center;justify-content:center;gap:8px">
        ${seatConfig.length < 4 ? `<button class="lobby-btn" id="btn-add-seat">+ Add Seat</button>` : ''}
        ${seatConfig.length > 2 ? `<button class="lobby-btn" id="btn-remove-seat">- Remove</button>` : ''}
      </div>
    `;
    document.getElementById("btn-add-seat")?.addEventListener("click", () => {
      seatConfig.push({type: "optimal", name: `AI ${seatConfig.length + 1}`, peerId: null});
      renderSeatGrid();
      broadcastLobbyState();
      updateStartButton();
    });
    document.getElementById("btn-remove-seat")?.addEventListener("click", () => {
      seatConfig.pop();
      renderSeatGrid();
      broadcastLobbyState();
      updateStartButton();
    });
  }

  // Wire seat type selects
  grid.querySelectorAll(".seat-type-select").forEach(sel => {
    sel.addEventListener("change", () => {
      const idx = parseInt(sel.dataset.seat);
      const oldType = seatConfig[idx].type;
      seatConfig[idx].type = sel.value;
      // Clear remote claim if switching away from human-remote
      if (oldType === "human-remote" && sel.value !== "human-remote") {
        seatConfig[idx].peerId = null;
        seatConfig[idx].name = sel.value === "empty" ? "Empty" : `AI ${idx + 1}`;
      }
      if (sel.value === "human-remote") {
        seatConfig[idx].name = `Player ${idx + 1}`;
        seatConfig[idx].peerId = null;
      }
      renderSeatGrid();
      broadcastLobbyState();
      updateStartButton();
    });
  });
}

function updateStartButton() {
  const unclaimedRemotes = seatConfig.filter(s => s.type === "human-remote" && !s.peerId);
  const activeSeatCount = seatConfig.filter(s => s.type !== "empty").length;
  const btn = document.getElementById("btn-start");
  btn.disabled = unclaimedRemotes.length > 0 || activeSeatCount < 2;
}

function updateHostStatus() {
  const n = Object.keys(connections).length;
  document.getElementById("host-status").textContent = `${n} player${n !== 1 ? 's' : ''} connected`;
}

function broadcastLobbyState() {
  const msg = JSON.stringify({
    type: "lobby_state",
    seats: seatConfig.map(s => ({type: s.type, name: s.name, claimed: !!s.peerId || s.type === "human-local"})),
  });
  Object.values(connections).forEach(c => c.send(msg));
}

function handleHostMessage(conn, msg) {
  switch (msg.type) {
    case "claim_seat": {
      const idx = msg.seat_idx;
      if (idx >= 0 && idx < seatConfig.length && seatConfig[idx].type === "human-remote" && !seatConfig[idx].peerId) {
        seatConfig[idx].peerId = conn.peer;
        seatConfig[idx].name = msg.name || conn.peer.substring(0, 8);
        clientSeats[conn.peer] = idx;
        renderSeatGrid();
        broadcastLobbyState();
        updateStartButton();
        conn.send(JSON.stringify({type: "seat_claimed", seat_idx: idx}));
      }
      break;
    }
    case "action":
      if (game) handleRemoteAction(conn.peer, msg);
      break;
    case "end_turn":
      if (game) handleRemoteEndTurn(conn.peer);
      break;
    case "prompt_answer":
      if (game) handleRemotePromptAnswer(conn.peer, msg.answers);
      break;
    case "patent_action":
      if (game) handleRemotePatentAction(conn.peer, msg);
      break;
    case "pool_swap":
      if (game) handleRemotePoolSwap(conn.peer, msg);
      break;
  }
}

function handleDisconnect(peerId) {
  delete connections[peerId];
  const seatIdx = clientSeats[peerId];
  if (seatIdx !== undefined) {
    seatConfig[seatIdx].peerId = null;
    delete clientSeats[peerId];
    // TODO: AI takeover for disconnected player
    if (!game) {
      renderSeatGrid();
      broadcastLobbyState();
      updateStartButton();
    }
  }
  updateHostStatus();
}

// ===== Client: PeerJS Setup =====

function initClient(roomCode) {
  peer = new Peer();
  document.getElementById("join-status").textContent = "Connecting...";
  peer.on("open", () => {
    hostConn = peer.connect(roomCode, {reliable: true});
    hostConn.on("open", () => {
      document.getElementById("join-status").textContent = "Connected! Waiting for seat info...";
    });
    hostConn.on("data", (raw) => {
      const msg = JSON.parse(raw);
      handleClientMessage(msg);
    });
    hostConn.on("close", () => {
      document.getElementById("join-status").textContent = "Disconnected from host.";
    });
    hostConn.on("error", (err) => {
      document.getElementById("join-status").textContent = `Error: ${err}`;
    });
  });
  peer.on("error", (err) => {
    document.getElementById("join-status").textContent = `PeerJS error: ${err.type}`;
  });
}

function handleClientMessage(msg) {
  switch (msg.type) {
    case "lobby_state":
      renderClientLobby(msg.seats);
      break;
    case "seat_claimed":
      mySeat = msg.seat_idx;
      document.getElementById("join-status").textContent = `Seat ${mySeat + 1} claimed. Waiting for host to start...`;
      break;
    case "game_start":
      mySeat = msg.your_seat;
      showGameScreen();
      break;
    case "game_state":
      currentState = msg.state;
      currentLegal = msg.legal || null;
      renderGame();
      break;
    case "your_turn":
      currentState = msg.state;
      currentLegal = msg.legal;
      renderGame();
      break;
    case "waiting":
      currentState = msg.state;
      currentLegal = null;
      renderGame();
      break;
    case "prompt":
      currentState = msg.state || currentState;
      showPrompt(msg.prompt);
      break;
    case "feed":
      addFeedEntry(msg.entry);
      break;
    case "game_over":
      currentState = msg.state;
      showEndgame();
      break;
  }
}

function renderClientLobby(seats) {
  document.getElementById("seat-claim").style.display = "block";
  const grid = document.getElementById("claim-grid");
  grid.innerHTML = seats.map((s, i) => {
    const canClaim = s.type === "human-remote" && !s.claimed && mySeat < 0;
    return `
      <div class="seat-card ${s.claimed ? 'claimed' : ''}">
        <div class="seat-label">Seat ${i + 1}</div>
        <div>${s.type === 'human-remote' ? 'Human' : s.type}</div>
        <div class="seat-status">${s.claimed ? (s.name || 'Claimed') : 'Open'}</div>
        ${canClaim ? `<button class="claim-btn" data-seat="${i}">Claim Seat</button>` : ''}
      </div>
    `;
  }).join("");
  grid.querySelectorAll(".claim-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.seat);
      const name = prompt("Enter your name:", `Player ${idx + 1}`) || `Player ${idx + 1}`;
      hostConn.send(JSON.stringify({type: "claim_seat", seat_idx: idx, name}));
    });
  });
}

// ===== Game Start (Host) =====

const PY_FILES = [
  "play_adapter.py","simulation.py","models.py","strategies.py",
  "parsing.py","sim_analysis.py","card_valuation.py"
];
const DATA_FILES = [
  "data/Cards.csv","data/Contracts.csv","data/Patents.csv",
  "data/Events.csv","data/News.csv","data/CardValues.csv",
  "data/Buildings.csv","data/Corporations.csv"
];

async function startGame() {
  document.getElementById("lobby-screen").style.display = "none";
  document.getElementById("loading-screen").style.display = "flex";

  // Load Pyodide
  const prog = document.getElementById("load-progress");
  prog.textContent = "Loading Pyodide runtime...";
  pyodide = await loadPyodide();

  // Fetch and mount Python sources
  prog.textContent = "Loading game files...";
  pyodide.FS.mkdirTree("/home/pyodide/my_project/data");
  pyodide.FS.writeFile("/home/pyodide/my_project/__init__.py", "");

  for (const f of PY_FILES) {
    const resp = await fetch(`data/game/my_project/${f}`, {cache: "no-cache"});
    pyodide.FS.writeFile(`/home/pyodide/my_project/${f}`, await resp.text());
  }
  for (const f of DATA_FILES) {
    const resp = await fetch(`data/game/my_project/${f}`, {cache: "no-cache"});
    pyodide.FS.writeFile(`/home/pyodide/my_project/${f}`, await resp.text());
  }

  pyodide.runPython(`import sys; sys.path.insert(0, "/home/pyodide")`);

  // Build seats array for PlayableGame
  const seats = seatConfig.filter(s => s.type !== "empty").map(s => {
    if (s.type === "human-local" || s.type === "human-remote") return "human";
    return s.type; // "optimal", "smart", "random"
  });
  const names = seatConfig.filter(s => s.type !== "empty").map(s => s.name);

  // Remap seat indices after filtering empties
  const seatMap = {};
  let j = 0;
  for (let i = 0; i < seatConfig.length; i++) {
    if (seatConfig[i].type !== "empty") {
      seatMap[i] = j++;
    }
  }
  mySeat = seatMap[0]; // host is always original seat 0

  prog.textContent = "Creating game...";
  const seed = Math.floor(Math.random() * 100000);
  const createCode = `
from my_project.play_adapter import PlayableGame
_seats = ${JSON.stringify(seats)}
_names = ${JSON.stringify(names)}
game = PlayableGame(seed=${seed}, seats=_seats, names=_names)
game
`;
  game = pyodide.runPython(createCode);

  // Notify clients
  for (const [peerId, seatIdx] of Object.entries(clientSeats)) {
    const mappedSeat = seatMap[seatIdx];
    if (mappedSeat !== undefined && connections[peerId]) {
      connections[peerId].send(JSON.stringify({type: "game_start", your_seat: mappedSeat}));
    }
  }
  // Update clientSeats to use mapped indices
  const newClientSeats = {};
  for (const [peerId, seatIdx] of Object.entries(clientSeats)) {
    const mapped = seatMap[seatIdx];
    if (mapped !== undefined) newClientSeats[peerId] = mapped;
  }
  Object.keys(clientSeats).forEach(k => delete clientSeats[k]);
  Object.assign(clientSeats, newClientSeats);

  showGameScreen();
  hostAdvanceGame();
}

function showGameScreen() {
  document.getElementById("lobby-screen").style.display = "none";
  document.getElementById("loading-screen").style.display = "none";
  document.getElementById("game-screen").style.display = "block";
  wireGameButtons();
}

// ===== Host: Game Loop =====

function hostRefreshState() {
  const s = game.state_dict().toJs({dict_converter: Object.fromEntries});
  currentState = s;

  if (!game.is_over() && isMyTurn(s)) {
    currentLegal = game.legal_human_actions().toJs({dict_converter: Object.fromEntries});
  } else {
    currentLegal = null;
  }
  renderGame();
  broadcastState();
}

function broadcastState() {
  if (!currentState) return;
  for (const [peerId, seatIdx] of Object.entries(clientSeats)) {
    const conn = connections[peerId];
    if (!conn) continue;
    // Filter state for this seat
    const filteredState = game.state_for_seat(seatIdx).toJs({dict_converter: Object.fromEntries});
    const isTheirTurn = currentState.current_player_index === seatIdx;
    let legal = null;
    if (isTheirTurn && !game.is_over()) {
      legal = game.legal_human_actions().toJs({dict_converter: Object.fromEntries});
    }
    if (game.is_over()) {
      conn.send(JSON.stringify({type: "game_over", state: filteredState}));
    } else if (isTheirTurn) {
      conn.send(JSON.stringify({type: "your_turn", state: filteredState, legal}));
    } else {
      conn.send(JSON.stringify({type: "waiting", state: filteredState, active_player: currentState.players[currentState.current_player_index]?.name || "?"}));
    }
  }
}

function hostAdvanceGame() {
  // Run AI turns and advance until a human's turn or game over
  while (!game.is_over()) {
    const s = game.state_dict().toJs({dict_converter: Object.fromEntries});
    const curIdx = s.current_player_index;

    // Check if current player is human
    if (s.human_indices.includes(curIdx)) {
      game.begin_human_turn();
      hostRefreshState();

      // Check for prompt (pre-turn event like patent auction)
      if (currentState.pending_prompt) {
        handleHostPrompt(currentState.pending_prompt);
      }
      return; // Wait for human input
    }

    // AI turn
    const result = game.step_ai_turn().toJs({dict_converter: Object.fromEntries});
    addFeedEntry({kind: "turn", text: `${result.player || 'AI'}: ${result.detail || 'took actions'}`, event: result.event_detail});
    broadcastFeed({kind: "turn", text: `${result.player || 'AI'}: ${result.detail || 'took actions'}`, event: result.event_detail});

    if (result.awaiting_prompt) {
      hostRefreshState();
      handleHostPrompt(currentState.pending_prompt);
      return;
    }
  }

  // Game over
  hostRefreshState();
  showEndgame();
}

function handleHostPrompt(prompt) {
  if (!prompt) return;
  // Show to host if host is involved
  if (mySeat >= 0) {
    showPrompt(prompt);
  }
  // Send to remote clients
  for (const [peerId, seatIdx] of Object.entries(clientSeats)) {
    const conn = connections[peerId];
    if (conn) {
      conn.send(JSON.stringify({type: "prompt", prompt, your_seat: seatIdx}));
    }
  }
}

// ===== Host: Handle Remote Player Actions =====

function handleRemoteAction(peerId, msg) {
  const seatIdx = clientSeats[peerId];
  if (seatIdx === undefined || currentState.current_player_index !== seatIdx) return;

  const action = msg.action;
  const result = game.apply_human_action(pyodide.toPy(action)).toJs({dict_converter: Object.fromEntries});
  if (result.ok) {
    addFeedEntry({kind: "action", text: `${currentState.players[seatIdx]?.name}: ${result.detail}`});
    broadcastFeed({kind: "action", text: `${currentState.players[seatIdx]?.name}: ${result.detail}`});
  }
  hostRefreshState();
}

function handleRemoteEndTurn(peerId) {
  const seatIdx = clientSeats[peerId];
  if (seatIdx === undefined || currentState.current_player_index !== seatIdx) return;

  const result = game.end_human_turn().toJs({dict_converter: Object.fromEntries});
  addFeedEntry({kind: "event", text: result.detail || "Turn ended", event: result.detail});
  broadcastFeed({kind: "event", text: result.detail || "Turn ended"});

  if (result.awaiting_prompt) {
    hostRefreshState();
    handleHostPrompt(currentState.pending_prompt);
    return;
  }
  hostRefreshState();
  hostAdvanceGame();
}

function handleRemotePromptAnswer(peerId, answers) {
  const seatIdx = clientSeats[peerId];
  if (seatIdx === undefined) return;
  // Store the answer and check if all answers collected
  pendingPromptAnswers = pendingPromptAnswers || {};
  pendingPromptAnswers[seatIdx] = answers;
  tryResolvePrompt();
}

function handleRemotePatentAction(peerId, msg) {
  const seatIdx = clientSeats[peerId];
  if (seatIdx === undefined || currentState.current_player_index !== seatIdx) return;

  let result;
  switch (msg.action) {
    case "water_engine":
      result = game.use_water_engine(seatIdx).toJs({dict_converter: Object.fromEntries});
      break;
    case "nanotech":
      result = game.use_nanotechnology(seatIdx, msg.pool_idx).toJs({dict_converter: Object.fromEntries});
      break;
    case "oc":
      result = game.use_optimization_center(seatIdx, msg.resource).toJs({dict_converter: Object.fromEntries});
      break;
    case "teleport":
      result = game.use_teleportation(seatIdx, msg.resource).toJs({dict_converter: Object.fromEntries});
      break;
  }
  if (result?.ok) {
    addFeedEntry({kind: "free-action", text: `${currentState.players[seatIdx]?.name}: ${result.detail}`});
    broadcastFeed({kind: "free-action", text: `${currentState.players[seatIdx]?.name}: ${result.detail}`});
  }
  hostRefreshState();
}

function handleRemotePoolSwap(peerId, msg) {
  const seatIdx = clientSeats[peerId];
  if (seatIdx === undefined || currentState.current_player_index !== seatIdx) return;
  game.human_pool_swap(msg.hand_idx, msg.pool_idx);
  hostRefreshState();
}

// ===== Prompt Collection =====
let pendingPromptAnswers = {};

function submitPrompt() {
  const prompt = currentState?.pending_prompt;
  if (!prompt) return;

  if (role === "host") {
    // Collect host's answer
    const answers = collectPromptInputs(prompt);
    pendingPromptAnswers[mySeat] = answers;
    document.getElementById("prompt-modal").style.display = "none";
    tryResolvePrompt();
  } else {
    // Client sends answer to host
    const answers = collectPromptInputs(prompt);
    hostConn.send(JSON.stringify({type: "prompt_answer", answers}));
    document.getElementById("prompt-modal").style.display = "none";
  }
}

function collectPromptInputs(prompt) {
  if (prompt.kind === "patent_auction") {
    const inp = document.querySelector(`.prompt-bid-input[data-seat-idx="${mySeat}"]`);
    return {bids: {[mySeat]: parseInt(inp?.value || "0")}};
  }
  if (prompt.kind === "debt_paydown") {
    const inp = document.querySelector(`.prompt-paydown-input[data-seat-idx="${mySeat}"]`);
    return {payments: {[mySeat]: parseInt(inp?.value || "0")}};
  }
  return {};
}

function tryResolvePrompt() {
  if (role !== "host" || !currentState?.pending_prompt) return;
  const prompt = currentState.pending_prompt;

  // Check if we have answers from all required human seats
  const humanSeats = currentState.human_indices || [];
  const allAnswered = humanSeats.every(idx => pendingPromptAnswers[idx] !== undefined);
  if (!allAnswered) return;

  // Merge all answers
  let merged = {};
  if (prompt.kind === "patent_auction") {
    merged = {bids: {}};
    for (const answers of Object.values(pendingPromptAnswers)) {
      Object.assign(merged.bids, answers.bids || {});
    }
  } else if (prompt.kind === "debt_paydown") {
    merged = {payments: {}};
    for (const answers of Object.values(pendingPromptAnswers)) {
      Object.assign(merged.payments, answers.payments || {});
    }
  }

  pendingPromptAnswers = {};
  const result = game.resolve_pending_prompt(pyodide.toPy(merged)).toJs({dict_converter: Object.fromEntries});
  addFeedEntry({kind: "event", text: result.detail || "Prompt resolved"});
  broadcastFeed({kind: "event", text: result.detail || "Prompt resolved"});

  if (result.awaiting_prompt) {
    hostRefreshState();
    handleHostPrompt(currentState.pending_prompt);
    return;
  }
  hostRefreshState();
  hostAdvanceGame();
}

// ===== Rendering =====

function isMyTurn(s) {
  s = s || currentState;
  return s && s.current_player_index === mySeat && !s.is_over;
}

function renderGame() {
  if (!currentState) return;
  const s = currentState;
  const myTurn = isMyTurn(s);

  // Status bar
  document.getElementById("mp-round").textContent = s.round || "-";
  document.getElementById("mp-turn").textContent = `${(s.turn_index || 0) + 1} / ${s.total_turns || "?"}`;
  document.getElementById("mp-active").textContent = s.players[s.current_player_index]?.name || "-";
  document.getElementById("mp-cards-left").textContent = s.cards_in_deck ?? "-";

  const banner = document.getElementById("turn-banner");
  banner.style.display = myTurn ? "block" : "none";

  renderMarket(s);
  renderContracts(s);
  renderPool(s);
  renderHand(s);
  renderActions(s);
  renderOpponents(s);
  renderYourStats(s);
}

function renderMarket(s) {
  const grid = document.getElementById("mp-market-grid");
  grid.innerHTML = RESOURCE_ORDER.map(r => `
    <div class="market-cell">
      <div class="res-name" style="color:${RESOURCE_COLORS[r]}">${r}</div>
      <div class="res-price">$${s.market[r] || 0}</div>
    </div>
  `).join("");
}

function renderContracts(s) {
  const grid = document.getElementById("mp-contracts-grid");
  const me = s.players[mySeat];
  grid.innerHTML = (s.available_contracts || []).map((c, ci) => {
    const reqs = (c.requirements || []).map(r => {
      const have = me?.rates?.[r.resource] || 0;
      const met = have >= r.amount;
      return `<span class="contract-req ${met ? 'met' : 'unmet'}">${r.amount} ${r.resource}</span>`;
    }).join(", ");
    const sel = ci === selectedContract ? "selected" : "";
    return `
      <div class="contract-card ${sel}" data-ci="${ci}">
        <div class="contract-reward">$${c.reward}</div>
        <div>${reqs}</div>
      </div>
    `;
  }).join("");
  grid.querySelectorAll(".contract-card").forEach(el => {
    el.addEventListener("click", () => {
      const ci = parseInt(el.dataset.ci);
      selectedContract = selectedContract === ci ? -1 : ci;
      renderContracts(s);
    });
  });
}

function renderPool(s) {
  const grid = document.getElementById("mp-pool-grid");
  grid.innerHTML = (s.pool || []).map((c, i) => `
    <div class="pool-card" data-pi="${i}">
      <div class="card-name">${c.building}</div>
      ${renderCardDetails(c)}
    </div>
  `).join("");
}

function renderHand(s) {
  const grid = document.getElementById("mp-hand-grid");
  const me = s.players[mySeat];
  const hand = me?.hand || [];
  const myTurn = isMyTurn(s);

  if (hand.length === 0) {
    grid.innerHTML = `<div style="color:#8b949e;padding:12px">${myTurn ? 'Hand is empty' : 'Cards hidden until your turn'}</div>`;
    return;
  }

  grid.innerHTML = hand.map((c, i) => {
    const sel = selectedCards.has(i) ? "selected" : "";
    const dis = !myTurn ? "disabled" : "";
    return `
      <div class="hand-card ${sel} ${dis}" data-hi="${i}">
        <div class="card-name">${c.building}</div>
        ${renderCardDetails(c)}
      </div>
    `;
  }).join("");

  if (myTurn) {
    grid.querySelectorAll(".hand-card").forEach(el => {
      el.addEventListener("click", () => {
        const hi = parseInt(el.dataset.hi);
        if (selectedCards.has(hi)) selectedCards.delete(hi);
        else selectedCards.add(hi);
        renderHand(s);
        renderActions(s);
      });
    });
  }
}

function renderCardDetails(c) {
  const rates = (c.rates || []).map(r =>
    `<span class="${r.amount > 0 ? 'rate-pos' : 'rate-neg'}">${r.amount > 0 ? '+' : ''}${r.amount} ${r.resource}</span>`
  ).join(" ");
  const costs = (c.costs || []).map(r => `${r.amount} ${r.resource}`).join(", ");
  const sell = (c.can_sell || []).join("/");
  const parts = [];
  if (rates) parts.push(`<div class="card-rates">${rates}</div>`);
  if (costs) parts.push(`<div class="card-costs">Cost: ${costs}</div>`);
  if (sell) parts.push(`<div class="card-sell">Sell: ${sell}</div>`);
  if (c.effect) parts.push(`<div class="card-effect">${c.effect}</div>`);
  return parts.join("");
}

function renderActions(s) {
  const myTurn = isMyTurn(s);
  const buildBtn = document.getElementById("mp-build-btn");
  const sellBtn = document.getElementById("mp-sell-btn");
  const contractBtn = document.getElementById("mp-contract-btn");
  const passBtn = document.getElementById("mp-pass-btn");

  buildBtn.disabled = !myTurn || selectedCards.size === 0;
  sellBtn.disabled = !myTurn || selectedCards.size !== 1;
  contractBtn.disabled = !myTurn || selectedContract < 0;
  passBtn.disabled = !myTurn;
}

function renderOpponents(s) {
  const strip = document.getElementById("mp-opponents");
  strip.innerHTML = s.players.filter((_, i) => i !== mySeat).map((p, oi) => {
    const realIdx = s.players.indexOf(p);
    const isActive = realIdx === s.current_player_index;
    const color = PLAYER_COLORS[realIdx % PLAYER_COLORS.length];
    const rates = RESOURCE_ORDER.map(r => {
      const v = p.rates?.[r] || 0;
      if (v === 0) return '';
      return `<span style="color:${v > 0 ? '#3fb950' : '#f85149'}">${v > 0 ? '+' : ''}${v}${r}</span>`;
    }).filter(Boolean).join(" ");
    const buildings = (p.buildings_played || []).join(", ") || "none";
    return `
      <div class="opponent-card ${isActive ? 'active-turn' : ''}" style="border-left:3px solid ${color}">
        <div class="opponent-name" style="color:${color}">${p.name}${p.is_human ? '' : ' (AI)'}</div>
        <div class="opponent-stats">$${p.money}${p.debt > 0 ? ` | Debt: $${p.debt}` : ''} | NW: $${p.net_worth}</div>
        <div class="opponent-rates">${rates || 'no rates'}</div>
        <div class="opponent-buildings">${buildings}</div>
      </div>
    `;
  }).join("");
}

function renderYourStats(s) {
  const me = s.players[mySeat];
  if (!me) return;
  const bar = document.getElementById("mp-your-stats");
  const rates = RESOURCE_ORDER.map(r => {
    const v = me.rates?.[r] || 0;
    if (v === 0) return '';
    return `<span style="color:${v > 0 ? '#3fb950' : '#f85149'}">${v > 0 ? '+' : ''}${v} ${r}</span>`;
  }).filter(Boolean).join(" | ");
  bar.innerHTML = `
    <div class="stat-item"><span class="stat-label">Cash:</span> <span class="stat-value">$${me.money}</span></div>
    <div class="stat-item"><span class="stat-label">Debt:</span> <span class="stat-value ${me.debt > 0 ? 'negative' : ''}">${me.debt > 0 ? '$' + me.debt : '-'}</span></div>
    <div class="stat-item"><span class="stat-label">NW:</span> <span class="stat-value ${me.net_worth >= 0 ? 'positive' : 'negative'}">$${me.net_worth}</span></div>
    <div class="stat-item"><span class="stat-label">Contracts:</span> <span class="stat-value">${me.contracts_fulfilled || 0}</span></div>
    <div class="stat-item"><span class="stat-label">Rates:</span> ${rates || '<span class="stat-value">none</span>'}</div>
  `;
}

// ===== Event Feed =====

function addFeedEntry(entry) {
  entry.time = new Date().toLocaleTimeString();
  feedEntries.push(entry);
  renderFeed();
}

function broadcastFeed(entry) {
  entry.time = new Date().toLocaleTimeString();
  const msg = JSON.stringify({type: "feed", entry});
  Object.values(connections).forEach(c => c.send(msg));
}

function renderFeed() {
  const container = document.getElementById("feed-entries");
  if (!container) return;
  container.innerHTML = feedEntries.slice(-50).reverse().map(e => `
    <div class="feed-entry ${e.kind || ''}">
      <div class="feed-time">${e.time || ''}</div>
      <div class="feed-text">${e.text || ''}</div>
      ${e.event ? `<div class="feed-text" style="color:#f0883e">${e.event}</div>` : ''}
    </div>
  `).join("");
}

// ===== Prompt Modal =====

function showPrompt(prompt) {
  const titleEl = document.getElementById("prompt-title");
  const bodyEl = document.getElementById("prompt-body");

  if (prompt.kind === "patent_auction") {
    titleEl.textContent = "Patent Auction";
    const patent = prompt.patent || {};
    const ratesStr = (patent.rates || []).map(r => `${r.amount > 0 ? "+" : ""}${r.amount} ${r.resource}`).join(", ");
    bodyEl.innerHTML = `
      <p><strong>${patent.name}</strong> &mdash; ${patent.effect || ratesStr || "no effect"}</p>
      <div class="prompt-row">
        <label>Your bid ($5 increments):</label>
        <input type="number" class="prompt-bid-input" data-seat-idx="${mySeat}" min="0" max="500" step="5" value="0">
      </div>
      <p style="color:#8b949e;font-size:0.8rem">Bid 0 to pass. Highest bidder wins; pays runner-up + $5 as debt.</p>
    `;
  } else if (prompt.kind === "debt_paydown") {
    titleEl.textContent = "Debt Collection - Pay Down Debt";
    const me = (prompt.players || []).find(p => p.seat === mySeat);
    if (me) {
      const maxPay = Math.floor(Math.min(me.debt, me.money) / 10) * 10;
      bodyEl.innerHTML = `
        <p>You have $${me.debt} debt and $${me.money} cash.</p>
        <div class="prompt-row">
          <label>Pay down ($10 increments):</label>
          <input type="number" class="prompt-paydown-input" data-seat-idx="${mySeat}" min="0" max="${maxPay}" step="10" value="${maxPay}">
        </div>
      `;
    } else {
      bodyEl.innerHTML = `<p>Waiting for other players...</p>`;
      // Auto-submit empty answer since we have no debt
      if (role === "host") {
        pendingPromptAnswers[mySeat] = {};
        tryResolvePrompt();
        return;
      } else {
        hostConn.send(JSON.stringify({type: "prompt_answer", answers: {}}));
        return;
      }
    }
  } else {
    titleEl.textContent = "Prompt";
    bodyEl.innerHTML = `<p>${prompt.kind}</p>`;
  }

  document.getElementById("prompt-modal").style.display = "flex";
}

// ===== Endgame =====

function showEndgame() {
  if (!currentState) return;
  const overlay = document.getElementById("endgame-overlay");
  const rankings = document.getElementById("endgame-rankings");
  const sorted = [...currentState.players].sort((a, b) => b.net_worth - a.net_worth);
  rankings.innerHTML = sorted.map((p, i) => {
    const color = PLAYER_COLORS[currentState.players.indexOf(p) % PLAYER_COLORS.length];
    const isYou = currentState.players.indexOf(p) === mySeat;
    return `
      <div style="display:flex;justify-content:space-between;padding:8px 12px;margin:4px 0;background:#0d1117;border-radius:6px;border-left:3px solid ${color}${isYou ? ';border:1px solid #58a6ff' : ''}">
        <span>${i + 1}. ${p.name}${isYou ? ' (You)' : ''}</span>
        <span style="font-weight:bold;color:${p.net_worth >= 0 ? '#3fb950' : '#f85149'}">NW: $${p.net_worth}</span>
      </div>
    `;
  }).join("");
  overlay.style.display = "flex";
}

// ===== Action Wiring =====

function wireGameButtons() {
  document.getElementById("mp-build-btn").addEventListener("click", () => {
    if (selectedCards.size === 0) return;
    sendAction({type: "build", build_cards: [...selectedCards]});
    selectedCards.clear();
  });
  document.getElementById("mp-sell-btn").addEventListener("click", () => {
    if (selectedCards.size !== 1) return;
    sendAction({type: "sell", sell_card: [...selectedCards][0]});
    selectedCards.clear();
  });
  document.getElementById("mp-contract-btn").addEventListener("click", () => {
    if (selectedContract < 0) return;
    const cardIdx = selectedCards.size === 1 ? [...selectedCards][0] : -1;
    sendAction({type: "contract", contract_idx: selectedContract, card_idx: cardIdx});
    selectedCards.clear();
    selectedContract = -1;
  });
  document.getElementById("mp-pass-btn").addEventListener("click", () => {
    selectedCards.clear();
    selectedContract = -1;
    if (role === "host") {
      const result = game.end_human_turn().toJs({dict_converter: Object.fromEntries});
      addFeedEntry({kind: "event", text: result.detail || "Turn ended"});
      broadcastFeed({kind: "event", text: result.detail || "Turn ended"});
      if (result.awaiting_prompt) {
        hostRefreshState();
        handleHostPrompt(currentState.pending_prompt);
        return;
      }
      hostRefreshState();
      hostAdvanceGame();
    } else {
      hostConn.send(JSON.stringify({type: "end_turn"}));
    }
  });
}

function sendAction(action) {
  if (role === "host") {
    const result = game.apply_human_action(pyodide.toPy(action)).toJs({dict_converter: Object.fromEntries});
    if (result.ok) {
      addFeedEntry({kind: "action", text: `You: ${result.detail}`});
      broadcastFeed({kind: "action", text: `${currentState.players[mySeat]?.name}: ${result.detail}`});
    } else {
      alert(result.reason || "Action failed");
    }
    hostRefreshState();
  } else {
    hostConn.send(JSON.stringify({type: "action", action}));
  }
}
