// ===== Multiplayer Game — WebRTC P2P via PeerJS =====
//
// Architecture:
//   Host: loads Pyodide, runs game engine, broadcasts state
//   Client: pure JS renderer, sends actions to host via data channel

const RESOURCE_ORDER = ["PWR","H2O","FE","C","SI","O2","FOOD","GLS","ELX"];
const RESOURCE_COLORS = {
  PWR:"#e74c3c",H2O:"#2c3e80",FE:"#555555",C:"#8e44ad",
  SI:"#f1c40f",O2:"#bdc3c7",FOOD:"#27ae60",GLS:"#5dade2",ELX:"#e67e22"
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
let pendingPoolSwap = -1;  // pool card index awaiting hand card click
let feedEntries = [];
let marketChart = null;

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
  "__init__.py","play_adapter.py","simulation.py","models.py",
  "strategies.py","parsing.py","accounting.py"
];
const DATA_FILES = [
  "data/Cards.csv","data/Contracts.csv","data/Patents.csv",
  "data/Events.csv","data/News.csv","data/CardValues.csv",
  "data/Corporations.csv","data/GameConfig.csv","data/market.csv"
];

async function startGame() {
  document.getElementById("lobby-screen").style.display = "none";
  document.getElementById("loading-screen").style.display = "flex";

  // Load Pyodide script dynamically (only host needs it)
  const prog = document.getElementById("load-progress");
  prog.textContent = "Loading Pyodide runtime...";
  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/pyodide/v0.27.0/full/pyodide.js";
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
  pyodide = await loadPyodide();

  // Fetch and mount Python sources
  prog.textContent = "Loading game files...";
  pyodide.FS.mkdirTree("/home/pyodide/my_project/data");

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

  // Kickoff feed entry with game setup info
  const initState = game.state_dict().toJs({dict_converter: Object.fromEntries});
  const setupLines = initState.players.map((p, i) => {
    const rates = RESOURCE_ORDER.map(r => {
      const v = p.rates?.[r] || 0;
      return v !== 0 ? `${v > 0 ? "+" : ""}${v}${r}` : null;
    }).filter(Boolean).join(" ");
    return `${p.name}${p.corporation ? " (" + p.corporation + ")" : ""}: ${rates || "no rates"}`;
  }).join("\n");
  const marketLine = RESOURCE_ORDER.map(r => `${r}=$${initState.market[r]}`).join(" ");
  const kickoff = {
    kind: "turn-start",
    text: "Game started!",
    details: `Players:\n${setupLines}\n\nMarket: ${marketLine}`,
  };
  addFeedEntry(kickoff);
  broadcastFeed(kickoff);

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
    // Capture event lines for structured feed
    const stateSnap = game.state_dict().toJs({dict_converter: Object.fromEntries});
    const eventLines = (stateSnap.last_event_lines || []).map(l => Object.assign({}, l));
    const playerSnaps = stateSnap.players.map(p => ({name: p.name, money: p.money, debt: p.debt, net_worth: p.net_worth}));
    const aiEntry = {
      kind: "turn",
      text: `${result.player || 'AI'}: ${result.detail || 'took actions'}`,
      event: result.event_detail,
      event_lines: eventLines,
      player_snapshots: playerSnaps,
      details: result.free_actions ? `Free actions: ${result.free_actions}` : null,
    };
    addFeedEntry(aiEntry);
    broadcastFeed(aiEntry);

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
  const snapAfter = game.state_dict().toJs({dict_converter: Object.fromEntries});
  const promptEntry = {
    kind: "event",
    text: result.detail || "Prompt resolved",
    event_lines: (snapAfter.last_event_lines || []).map(l => Object.assign({}, l)),
    player_snapshots: snapAfter.players.map(p => ({name: p.name, money: p.money, debt: p.debt, net_worth: p.net_worth})),
  };
  addFeedEntry(promptEntry);
  broadcastFeed(promptEntry);

  if (result.awaiting_prompt) {
    hostRefreshState();
    handleHostPrompt(currentState.pending_prompt);
    return;
  }
  hostRefreshState();
  hostAdvanceGame();
}

// ===== Selection helpers =====

function clearSelection() {
  selectedCards.clear();
  selectedContract = -1;
  pendingPoolSwap = -1;
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
  const roundStr = s.num_rounds > 1 ? `${s.round} (Rd ${s.deck_round || 1}/${s.num_rounds})` : `${s.round || "-"}`;
  document.getElementById("mp-round").textContent = roundStr;
  document.getElementById("mp-turn").textContent = `${(s.turn_index || 0) + 1} / ${s.total_turns || "?"}`;
  const activeP = s.players[s.current_player_index];
  const activeLabel = activeP ? `${activeP.name}${s.current_player_index === mySeat ? " (You)" : ""}` : "-";
  document.getElementById("mp-active").textContent = activeLabel;
  document.getElementById("mp-cards-left").textContent = s.cards_in_deck ?? "-";

  // Cards remaining / AP display
  const apEl = document.getElementById("mp-ap-display");
  if (apEl) {
    if (myTurn && currentLegal) {
      const cr = currentLegal.cards_remaining ?? 2;
      const builtMsg = s.human_already_built ? " (built)" : "";
      apEl.textContent = `Cards: ${cr}/2${builtMsg}`;
      apEl.className = "status-value " + (cr >= 2 ? "ap-full" : cr >= 1 ? "ap-half" : "ap-empty");
    } else {
      apEl.textContent = "-";
      apEl.className = "status-value";
    }
  }

  const banner = document.getElementById("turn-banner");
  banner.style.display = myTurn ? "block" : "none";

  renderMarket(s);
  renderContracts(s);
  renderPool(s);
  renderHand(s);
  renderActions(s);
  renderPlayerPanel(s);
  renderOpponents(s);
}

const PRICE_TRACK = [1,1,1,2,2,2,3,3,4,4,5,5,6,7,8,9,10];
let expandedMarketResource = null;

function stepsToChange(pos, direction) {
  // Count steps in direction until price changes (or hits boundary)
  const curPrice = PRICE_TRACK[pos];
  let steps = 0;
  let p = pos + direction;
  while (p >= 0 && p < PRICE_TRACK.length && PRICE_TRACK[p] === curPrice) {
    steps++;
    p += direction;
  }
  // One more step to actually change
  if (p >= 0 && p < PRICE_TRACK.length) steps++;
  return steps;
}

function renderMarket(s) {
  const grid = document.getElementById("mp-market-grid");
  const positions = s.market_positions || {};

  grid.innerHTML = RESOURCE_ORDER.map(r => {
    const price = s.market[r] || 0;
    const pos = positions[r] ?? 9;
    const stepsDown = stepsToChange(pos, -1);
    const stepsUp = stepsToChange(pos, 1);
    const dotsLeft = stepsDown > 0 ? Array(Math.min(stepsDown, 4)).fill('<span class="step-dot"></span>').join("") : "";
    const dotsRight = stepsUp > 0 ? Array(Math.min(stepsUp, 4)).fill('<span class="step-dot"></span>').join("") : "";
    const isExpanded = expandedMarketResource === r;
    return `
      <div class="market-cell ${isExpanded ? 'expanded' : ''}" data-res="${r}">
        <div class="res-name" style="color:${RESOURCE_COLORS[r]}">${r}</div>
        <div class="res-price-wrap">
          <span class="dots-down" title="${stepsDown} step${stepsDown !== 1 ? 's' : ''} down">${dotsLeft}</span>
          <span class="res-price">$${price}</span>
          <span class="dots-up" title="${stepsUp} step${stepsUp !== 1 ? 's' : ''} up">${dotsRight}</span>
        </div>
      </div>
    `;
  }).join("");

  // Wire click to expand ruler
  grid.querySelectorAll(".market-cell").forEach(el => {
    el.addEventListener("click", () => {
      const r = el.dataset.res;
      expandedMarketResource = expandedMarketResource === r ? null : r;
      renderMarketRuler(s);
    });
  });

  renderMarketRuler(s);
  renderMarketChart(s);
}

function renderMarketRuler(s) {
  const ruler = document.getElementById("mp-market-ruler");
  if (!ruler) return;
  ruler.style.display = "block";

  const positions = s.market_positions || {};
  const selectedRes = expandedMarketResource;
  const selectedPos = selectedRes ? (positions[selectedRes] ?? 9) : -1;
  const selectedColor = selectedRes ? RESOURCE_COLORS[selectedRes] : "#888";

  // Build position → list of resources at that position
  const resourcesAtPos = {};
  for (const r of RESOURCE_ORDER) {
    const pos = positions[r] ?? 9;
    if (!resourcesAtPos[pos]) resourcesAtPos[pos] = [];
    resourcesAtPos[pos].push(r);
  }

  ruler.innerHTML = `
    <div class="ruler-track">
      ${PRICE_TRACK.map((p, i) => {
        const isCurrent = i === selectedPos;
        const resHere = resourcesAtPos[i] || [];
        const dots = resHere.map(r => {
          const isSelected = r === selectedRes;
          return `<span class="ruler-res-dot ${isSelected ? 'selected' : ''}" style="background:${RESOURCE_COLORS[r]}" title="${r}"></span>`;
        }).join("");
        return `<span class="ruler-pip ${isCurrent ? 'current' : ''}" style="${isCurrent ? 'border-color:' + selectedColor : ''}">
          <span class="ruler-dots-row">${dots}</span>
          <span class="ruler-price">$${p}</span>
        </span>`;
      }).join("")}
    </div>
  `;
}

function renderMarketChart(s) {
  let history = s.market_history || [];
  // Prepend current market as turn 0 if history is empty or missing the start
  if (history.length === 0 && s.market) {
    history = [{turn: 0, market: s.market}];
  }
  if (history.length < 1) return;
  const canvas = document.getElementById("mp-market-chart");
  if (!canvas) return;
  const labels = history.map(h => h.turn);
  const datasets = RESOURCE_ORDER.map(r => ({
    label: r,
    data: history.map(h => h.market?.[r] || 0),
    borderColor: RESOURCE_COLORS[r],
    backgroundColor: "transparent",
    borderWidth: 1.5,
    pointRadius: 0,
    tension: 0.3,
  }));
  if (marketChart) {
    marketChart.data.labels = labels;
    marketChart.data.datasets = datasets;
    marketChart.update("none");
  } else {
    marketChart = new Chart(canvas, {
      type: "line",
      data: {labels, datasets},
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {legend: {labels: {boxWidth: 10, font: {size: 10}, color: "#8b949e"}}},
        scales: {
          x: {display: true, ticks: {color: "#8b949e", font: {size: 9}}, grid: {color: "#21262d"}},
          y: {display: true, ticks: {color: "#8b949e", font: {size: 9}, callback: v => "$" + v}, grid: {color: "#21262d"}},
        },
      },
    });
  }
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
  const myTurn = isMyTurn(s);
  grid.innerHTML = (s.pool || []).map((c, i) => {
    const pending = pendingPoolSwap === i ? "selected" : "";
    return `<div class="pool-card ${pending}" data-pi="${i}">${renderCard(c)}</div>`;
  }).join("");
  if (myTurn && s.can_pool_swap) {
    grid.querySelectorAll(".pool-card").forEach(el => {
      el.addEventListener("click", () => {
        const pi = parseInt(el.dataset.pi);
        pendingPoolSwap = pendingPoolSwap === pi ? -1 : pi;
        renderPool(s);
        renderHand(s);
      });
    });
  }
}

function renderHand(s) {
  const grid = document.getElementById("mp-hand-grid");
  const me = s.players[mySeat];
  const hand = me?.hand || [];
  const myTurn = isMyTurn(s);

  if (hand.length === 0) {
    grid.innerHTML = `<div style="color:#8b949e;padding:12px">${myTurn ? 'Hand is empty' : 'Cards hidden until your turn'}</div>`;
    document.getElementById("mp-build-estimate").textContent = "";
    return;
  }

  // Affordability hints from legal actions
  const affordableSet = new Set(currentLegal?.affordable_single_builds || []);
  const swapping = pendingPoolSwap >= 0;
  const cr = currentLegal?.cards_remaining ?? 2;

  grid.innerHTML = hand.map((c, i) => {
    const sel = selectedCards.has(i) ? "selected" : "";
    const dis = !myTurn ? "disabled" : "";
    const swapHint = swapping ? "swap-target" : "";
    const unaffordable = myTurn && !swapping && !affordableSet.has(i) && !selectedCards.has(i) ? "unaffordable" : "";
    return `<div class="hand-card ${sel} ${dis} ${swapHint} ${unaffordable}" data-hi="${i}">${renderCard(c)}</div>`;
  }).join("");

  // Build cost estimate
  const estimateEl = document.getElementById("mp-build-estimate");
  if (swapping) {
    estimateEl.textContent = "Click a hand card to swap with the selected pool card";
  } else if (selectedCards.size > 0 && myTurn && role === "host") {
    try {
      const indices = [...selectedCards];
      const est = game.estimate_build_cost(pyodide.toPy(indices)).toJs({dict_converter: Object.fromEntries});
      if (est.ok) {
        const defParts = Object.entries(est.deficit || {}).map(([r, a]) => `${a} ${r}`).join(", ");
        estimateEl.innerHTML = `Build cost: <strong>$${est.cost}</strong>${defParts ? ` (buy ${defParts})` : ' (free)'}`;
      } else {
        estimateEl.innerHTML = `<span style="color:#f85149">${est.reason || 'Cannot build'}</span>`;
      }
    } catch { estimateEl.textContent = ""; }
  } else {
    estimateEl.textContent = "";
  }

  if (myTurn) {
    grid.querySelectorAll(".hand-card:not(.disabled)").forEach(el => {
      el.addEventListener("click", () => {
        const hi = parseInt(el.dataset.hi);
        if (pendingPoolSwap >= 0) {
          executePoolSwap(hi, pendingPoolSwap);
          pendingPoolSwap = -1;
          return;
        }
        if (selectedCards.has(hi)) selectedCards.delete(hi);
        else if (selectedCards.size < cr) selectedCards.add(hi);
        renderHand(s);
        renderActions(s);
      });
    });
  }
}

function executePoolSwap(handIdx, poolIdx) {
  if (role === "host") {
    game.human_pool_swap(handIdx, poolIdx);
    hostRefreshState();
  } else {
    hostConn.send(JSON.stringify({type: "pool_swap", hand_idx: handIdx, pool_idx: poolIdx}));
  }
}

function renderCard(c) {
  // Returns full card HTML: costs → name → rates → effect → sell/contract
  const costs = (c.costs || []).map(r => `${r.amount} ${r.resource}`).join(", ");
  const rates = (c.rates || []).map(r =>
    `<span class="${r.amount > 0 ? 'rate-pos' : 'rate-neg'}">${r.amount > 0 ? '+' : ''}${r.amount} ${r.resource}</span>`
  ).join(" ");
  const sell = (c.can_sell || []).join("/");
  const canContract = c.can_fulfill_contract;
  let html = "";
  if (costs) html += `<div class="card-costs">${costs}</div>`;
  html += `<div class="card-name">${c.building}</div>`;
  if (rates) html += `<div class="card-rates">${rates}</div>`;
  if (c.effect) html += `<div class="card-effect">${c.effect}</div>`;
  const bottomParts = [];
  if (sell) bottomParts.push(`<span class="card-sell">Sell: ${sell}</span>`);
  if (canContract) bottomParts.push(`<span class="card-contract">\u{1F4CB}</span>`);
  if (bottomParts.length) html += `<div class="card-bottom">${bottomParts.join(" ")}</div>`;
  return html;
}

function renderActions(s) {
  const myTurn = isMyTurn(s);
  const cr = currentLegal?.cards_remaining ?? 0;
  const alreadyBuilt = s.human_already_built;
  const buildBtn = document.getElementById("mp-build-btn");
  const sellBtn = document.getElementById("mp-sell-btn");
  const contractBtn = document.getElementById("mp-contract-btn");
  const passBtn = document.getElementById("mp-pass-btn");

  const canBuild = myTurn && selectedCards.size > 0 && (!alreadyBuilt || currentLegal?.matter_replication);
  buildBtn.disabled = !canBuild;
  if (alreadyBuilt && !currentLegal?.matter_replication) {
    buildBtn.title = "Already built this turn";
  } else {
    buildBtn.title = "";
  }

  // Sell: need exactly 1 card selected and it must be sellable
  const sellCardIdx = selectedCards.size === 1 ? Array.from(selectedCards)[0] : -1;
  const sellCard = sellCardIdx >= 0 ? (s.players[mySeat]?.hand || [])[sellCardIdx] : null;
  const canSell = myTurn && sellCard?.can_sell?.length > 0 && cr >= 1;
  sellBtn.disabled = !canSell;

  // Sell resource picker (show when card has multiple sell options)
  let sellPickerHtml = "";
  if (canSell && sellCard.can_sell.length > 1) {
    const me = s.players[mySeat];
    const opts = sellCard.can_sell.map(r => {
      const rate = me.rates?.[r] || 0;
      const rev = rate > 0 ? rate * (s.market[r] || 0) : 0;
      return `<option value="${r}">${r} (rate ${rate}, $${rev})</option>`;
    }).join("");
    sellPickerHtml = `<select id="mp-sell-resource" class="toggle-select">${opts}</select>`;
  }
  // Hacker Array picker
  let hackerHtml = "";
  if (canSell && currentLegal?.hacker_array_status?.owned) {
    const resOpts = RESOURCE_ORDER.filter(r => r !== "PWR").map(r => `<option value="${r}">${r}</option>`).join("");
    hackerHtml = `
      <span style="font-size:0.8rem;color:#8b949e">HA target:</span>
      <select id="mp-hacker-target" class="toggle-select">${resOpts}</select>
      <select id="mp-hacker-dir" class="toggle-select">
        <option value="1">+3 (raise)</option>
        <option value="-1">-3 (lower)</option>
      </select>
    `;
  }
  const sellExtras = document.getElementById("mp-sell-extras");
  if (sellExtras) sellExtras.innerHTML = sellPickerHtml + hackerHtml;

  contractBtn.disabled = !myTurn || selectedContract < 0;
  passBtn.disabled = !myTurn;

  renderPatentActions(s);
  renderSpecialToggles(s);
}

function renderPatentActions(s) {
  const host = document.getElementById("mp-patent-actions");
  if (!host) return;
  const myTurn = isMyTurn(s);
  const pa = currentLegal?.patent_actions || {};
  const oc = currentLegal?.optimization_center_status || {};
  const parts = [];

  if (oc.owned) {
    const status = oc;
    const opts = (status.valid_resources || []).map(r => `<option value="${r}">${r}</option>`).join("");
    const canUse = myTurn && status.available && opts;
    parts.push(`
      <div class="patent-action-row">
        <strong>Optimization Center</strong> &mdash; -1 PWR, +1 to a positive rate.
        <select id="pa-oc-resource" class="toggle-select" ${canUse ? "" : "disabled"}>
          ${opts || '<option value="">none</option>'}
        </select>
        <button id="pa-oc-btn" class="action-btn" ${canUse ? "" : "disabled"}>Use OC</button>
      </div>
    `);
  }
  if (pa.water_engine?.owned) {
    const status = pa.water_engine;
    const canUse = myTurn && status.available;
    parts.push(`
      <div class="patent-action-row">
        <strong>Water Engine</strong> &mdash; -1 H2O, +2 PWR.
        <button id="pa-we-btn" class="action-btn" ${canUse ? "" : "disabled"}>Use WE</button>
      </div>
    `);
  }
  if (pa.nanotechnology?.owned) {
    const status = pa.nanotechnology;
    const pool = s.pool || [];
    const poolOpts = pool.map((c, i) => `<option value="${i}">${i + 1}: ${c.building}</option>`).join("");
    const canUse = myTurn && status.available && pool.length > 0;
    parts.push(`
      <div class="patent-action-row">
        <strong>Nanotechnology</strong> &mdash; replace a pool card with a deck draw.
        <select id="pa-nano-card" class="toggle-select" ${canUse ? "" : "disabled"}>
          ${poolOpts || '<option value="">empty</option>'}
        </select>
        <button id="pa-nano-btn" class="action-btn" ${canUse ? "" : "disabled"}>Replace</button>
      </div>
    `);
  }
  if (pa.teleportation?.owned) {
    const status = pa.teleportation;
    const opts = (status.valid_resources || []).map(r => `<option value="${r}">${r}</option>`).join("");
    const canUse = myTurn && status.available && opts;
    parts.push(`
      <div class="patent-action-row">
        <strong>Teleportation</strong> &mdash; sell any resource, -1 PWR.
        <select id="pa-tele-resource" class="toggle-select" ${canUse ? "" : "disabled"}>
          ${opts || '<option value="">none</option>'}
        </select>
        <button id="pa-tele-btn" class="action-btn" ${canUse ? "" : "disabled"}>Sell</button>
      </div>
    `);
  }

  host.innerHTML = parts.length ? `<h4 style="color:#8b949e;font-size:0.75rem;margin:8px 0 4px">Patent Actions</h4>${parts.join("")}` : "";

  // Wire buttons
  document.getElementById("pa-oc-btn")?.addEventListener("click", () => {
    const r = document.getElementById("pa-oc-resource")?.value;
    if (!r) return;
    sendPatentAction("oc", {resource: r});
  });
  document.getElementById("pa-we-btn")?.addEventListener("click", () => {
    sendPatentAction("water_engine", {});
  });
  document.getElementById("pa-nano-btn")?.addEventListener("click", () => {
    const idx = parseInt(document.getElementById("pa-nano-card")?.value);
    if (isNaN(idx)) return;
    sendPatentAction("nanotech", {pool_idx: idx});
  });
  document.getElementById("pa-tele-btn")?.addEventListener("click", () => {
    const r = document.getElementById("pa-tele-resource")?.value;
    if (!r) return;
    sendPatentAction("teleport", {resource: r});
  });
}

function sendPatentAction(action, params) {
  if (role === "host") {
    let result;
    switch (action) {
      case "water_engine":
        result = game.use_water_engine(mySeat).toJs({dict_converter: Object.fromEntries});
        break;
      case "nanotech":
        result = game.use_nanotechnology(mySeat, params.pool_idx).toJs({dict_converter: Object.fromEntries});
        break;
      case "oc":
        result = game.use_optimization_center(mySeat, params.resource).toJs({dict_converter: Object.fromEntries});
        break;
      case "teleport":
        result = game.use_teleportation(mySeat, params.resource).toJs({dict_converter: Object.fromEntries});
        break;
    }
    if (result?.ok) {
      addFeedEntry({kind: "free-action", text: `You: ${result.detail}`});
      broadcastFeed({kind: "free-action", text: `${currentState.players[mySeat]?.name}: ${result.detail}`});
    } else if (result) {
      alert(result.reason || "Patent action failed");
    }
    hostRefreshState();
  } else {
    hostConn.send(JSON.stringify({type: "patent_action", action, ...params}));
  }
}

function renderSpecialToggles(s) {
  const host = document.getElementById("mp-special-toggles");
  if (!host) return;
  const myTurn = isMyTurn(s);
  if (!myTurn || !currentLegal) { host.innerHTML = ""; return; }

  const parts = [];
  const se = currentLegal.space_elevator_status;
  if (se?.owned) {
    parts.push(`
      <label class="toggle-label">
        <input type="checkbox" id="toggle-se" ${se.available ? "" : "disabled"}>
        Space Elevator (reduce 1 contract req)
      </label>
    `);
  }
  const lp = currentLegal.launch_pad_status;
  if (lp?.owned) {
    parts.push(`
      <label class="toggle-label">
        <input type="checkbox" id="toggle-lp" ${lp.available ? "" : "disabled"}>
        Launch Pad (free contract, no card cost)
      </label>
    `);
  }
  host.innerHTML = parts.join("");
}

function renderPlayerPanel(s) {
  const me = s.players[mySeat];
  if (!me) return;
  const panel = document.getElementById("mp-your-stats");
  const color = PLAYER_COLORS[mySeat % PLAYER_COLORS.length];

  // Rates grid (all 9 resources, styled)
  const ratesGrid = RESOURCE_ORDER.map(r => {
    const v = me.rates?.[r] || 0;
    const cls = v > 0 ? "rate-pos" : v < 0 ? "rate-neg" : "rate-zero";
    return `<div class="rate-chip ${cls}"><span class="rate-res" style="color:${RESOURCE_COLORS[r]}">${r}</span><span class="rate-val">${v > 0 ? "+" : ""}${v}</span></div>`;
  }).join("");

  // Buildings (split into regular + specials + patents)
  const builtCards = me.built_cards || [];
  const buildings = builtCards.filter(c => !c.effect && c.slot !== 5).map(c => c.building);
  const specials = builtCards.filter(c => c.effect && c.slot !== 5);
  const patents = builtCards.filter(c => c.slot === 5);

  const buildingList = buildings.length ? buildings.join(", ") : "none";
  const specialList = specials.map(c => `<div class="built-special"><strong>${c.building}</strong> <span style="color:#a371f7">${c.effect}</span></div>`).join("");
  const patentList = patents.map(c => `<div class="built-special"><strong>${c.building}</strong> <span style="color:#d2a8ff">${c.effect}</span></div>`).join("");

  panel.innerHTML = `
    <div class="player-panel-inner">
      <div class="player-panel-header" style="border-left:3px solid ${color}">
        <div class="player-panel-name" style="color:${color}">${me.name}${me.corporation ? ` — ${me.corporation}` : ''}</div>
        <div class="player-panel-money">
          <span>Cash: <strong>$${me.money}</strong></span>
          ${me.debt > 0 ? `<span style="color:#f85149"> | Debt: <strong>$${me.debt}</strong></span>` : ''}
          ${me.credit > 0 ? `<span style="color:#d29922"> | Credit: <strong>$${me.credit}</strong></span>` : ''}
          <span style="color:${me.net_worth >= 0 ? '#3fb950' : '#f85149'}"> | NW: <strong>$${me.net_worth}</strong></span>
          <span> | Contracts: <strong>${me.contracts_fulfilled || 0}</strong></span>
        </div>
      </div>
      <div class="player-panel-rates">
        <div class="rates-grid">${ratesGrid}</div>
      </div>
      <div class="player-panel-buildings">
        <div style="font-size:0.75rem;color:#8b949e">Buildings: ${buildingList}</div>
        ${specialList ? `<div style="margin-top:4px">${specialList}</div>` : ''}
        ${patentList ? `<div style="margin-top:4px">${patentList}</div>` : ''}
      </div>
    </div>
  `;
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

function addStructuredFeedEntry(entry) {
  // Rich entry with event_lines and player_snapshots from state
  entry.time = new Date().toLocaleTimeString();
  // Capture event lines from the state if available
  if (role === "host" && currentState?.last_event_lines) {
    entry.event_lines = [...currentState.last_event_lines];
  }
  feedEntries.push(entry);
  renderFeed();
}

function broadcastFeed(entry) {
  entry.time = new Date().toLocaleTimeString();
  const msg = JSON.stringify({type: "feed", entry});
  Object.values(connections).forEach(c => c.send(msg));
}

function formatFeedText(raw) {
  // Clean up Python detail strings for display
  if (!raw) return "";
  return raw
    .replace(/; /g, "<br>")          // separate actions onto lines
    .replace(/\n/g, "<br>")          // newlines to breaks
    .replace(/\| /g, "<br>")         // pipe-separated events
    .replace(/\$(\d+)/g, '<span class="feed-money">$$$1</span>');  // highlight dollar amounts
}

function renderFeed() {
  const container = document.getElementById("feed-entries");
  if (!container) return;
  const html = feedEntries.slice(-80).reverse().map(e => {
    const kindClass = e.kind || '';
    const hasDetails = e.details || e.event_lines || e.player_snapshots;

    // Build detail content for expandable section
    let detailHtml = "";
    if (e.details) {
      detailHtml += `<div class="feed-detail-text">${formatFeedText(e.details)}</div>`;
    }
    if (e.event_lines && e.event_lines.length > 0) {
      detailHtml += `<div class="feed-lines">`;
      detailHtml += e.event_lines.map(line => {
        if (line.kind === "header") return `<div class="feed-line-header">${line.text}</div>`;
        if (line.kind === "note") return `<div class="feed-line-note">${line.text}</div>`;
        if (line.kind === "player") {
          const nw = line.net_worth_after !== undefined ? `<span class="feed-nw-inline">NW $${line.net_worth_after}</span>` : '';
          return `<div class="feed-line-player"><span class="feed-line-name">${line.name || ''}</span> ${line.text} ${nw}</div>`;
        }
        return `<div class="feed-line-note">${line.text || ''}</div>`;
      }).join("");
      detailHtml += `</div>`;
    }
    if (e.player_snapshots && e.player_snapshots.length > 0) {
      detailHtml += `<div class="feed-impact">${e.player_snapshots.map(p => {
        const cls = p.net_worth >= 0 ? "positive" : "negative";
        return `<span class="feed-nw-chip ${cls}">${p.name} $${p.net_worth}</span>`;
      }).join("")}</div>`;
    }

    // Main text: split action text from event text for cleaner display
    const mainText = formatFeedText(e.text || "");
    const eventText = e.event ? formatFeedText(e.event) : "";

    if (hasDetails) {
      return `
        <details class="feed-entry ${kindClass}">
          <summary class="feed-summary">
            <span class="feed-time">${e.time || ''}</span>
            <span class="feed-text">${mainText}</span>
          </summary>
          <div class="feed-detail-body">
            ${eventText ? `<div class="feed-event-text">${eventText}</div>` : ''}
            ${detailHtml}
          </div>
        </details>
      `;
    }
    return `
      <div class="feed-entry ${kindClass}">
        <div class="feed-header-row">
          <span class="feed-time">${e.time || ''}</span>
          <span class="feed-text">${mainText}</span>
        </div>
        ${eventText ? `<div class="feed-event-text">${eventText}</div>` : ''}
      </div>
    `;
  }).join("");
  container.innerHTML = html;
  container.scrollTop = 0;
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

let endgameNwChart = null;

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
        <span>${i + 1}. ${p.name}${isYou ? ' (You)' : ''}${p.is_human ? '' : ' (AI)'}</span>
        <span style="font-weight:bold;color:${p.net_worth >= 0 ? '#3fb950' : '#f85149'}">NW: $${p.net_worth} | $${p.money} cash | ${p.contracts_fulfilled || 0} contracts</span>
      </div>
    `;
  }).join("");
  renderEndgameChart();
  overlay.style.display = "flex";
}

function renderEndgameChart() {
  const history = currentState?.player_history || [];
  if (history.length < 2) return;
  const canvas = document.getElementById("endgame-nw-chart");
  if (!canvas) return;
  const labels = history.map(h => h.turn);
  const datasets = (currentState.players || []).map((p, idx) => ({
    label: p.name,
    data: history.map(h => h.players?.[idx]?.net_worth ?? 0),
    borderColor: PLAYER_COLORS[idx % PLAYER_COLORS.length],
    backgroundColor: "transparent",
    borderWidth: 2,
    pointRadius: 0,
    tension: 0.3,
  }));
  if (endgameNwChart) endgameNwChart.destroy();
  endgameNwChart = new Chart(canvas, {
    type: "line",
    data: {labels, datasets},
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {labels: {boxWidth: 12, font: {size: 11}, color: "#c9d1d9"}},
        title: {display: true, text: "Net Worth Over Time", color: "#8b949e"},
      },
      scales: {
        x: {ticks: {color: "#8b949e"}, grid: {color: "#21262d"}},
        y: {ticks: {color: "#8b949e", callback: v => "$" + v}, grid: {color: "#21262d"}},
      },
    },
  });
}

// ===== Action Wiring =====

function wireGameButtons() {
  // Market chart toggle
  document.getElementById("market-toggle")?.addEventListener("click", () => {
    const wrap = document.getElementById("market-chart-wrap");
    if (wrap) wrap.style.display = wrap.style.display === "none" ? "block" : "none";
  });

  document.getElementById("mp-build-btn").addEventListener("click", () => {
    if (selectedCards.size === 0) return;
    sendAction({type: "build", build_cards: [...selectedCards]});
    clearSelection();
  });
  document.getElementById("mp-sell-btn").addEventListener("click", () => {
    if (selectedCards.size !== 1) return;
    const cardIdx = [...selectedCards][0];
    const action = {type: "sell", sell_card: cardIdx};
    // Use resource picker if present
    const resSel = document.getElementById("mp-sell-resource");
    if (resSel?.value) action.sell_resource = resSel.value;
    // Hacker Array target
    const hTarget = document.getElementById("mp-hacker-target");
    const hDir = document.getElementById("mp-hacker-dir");
    if (hTarget?.value) {
      action.hacker_target = hTarget.value;
      action.hacker_direction = parseInt(hDir?.value || "1");
    }
    sendAction(action);
    clearSelection();
  });
  document.getElementById("mp-contract-btn").addEventListener("click", () => {
    if (selectedContract < 0) return;
    const cardIdx = selectedCards.size === 1 ? [...selectedCards][0] : -1;
    const useSE = document.getElementById("toggle-se")?.checked || false;
    const useLP = document.getElementById("toggle-lp")?.checked || false;
    const action = {type: "contract", contract_idx: selectedContract};
    if (useLP) {
      action.use_launch_pad = true;
    } else if (cardIdx >= 0) {
      action.card_idx = cardIdx;
    }
    if (useSE) action.use_space_elevator = true;
    sendAction(action);
    clearSelection();
  });
  document.getElementById("mp-pass-btn").addEventListener("click", () => {
    clearSelection();
    if (role === "host") {
      const result = game.end_human_turn().toJs({dict_converter: Object.fromEntries});
      const snapAfter = game.state_dict().toJs({dict_converter: Object.fromEntries});
      const turnEntry = {
        kind: "event",
        text: result.detail || "Turn ended",
        event_lines: (result.lines || snapAfter.last_event_lines || []).map(l => Object.assign({}, l)),
        player_snapshots: snapAfter.players.map(p => ({name: p.name, money: p.money, debt: p.debt, net_worth: p.net_worth})),
      };
      addFeedEntry(turnEntry);
      broadcastFeed(turnEntry);
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
