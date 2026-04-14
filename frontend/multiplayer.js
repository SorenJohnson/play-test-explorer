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
      if (msg.entry.kind === "event") showEventBanner(formatEventTitle(msg.entry.text || "Event"));
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
  logGameStep("start", "Game", -1, "Game started", {setupLines, marketLine});

  hostAdvanceGame();
}

function showGameScreen() {
  document.getElementById("lobby-screen").style.display = "none";
  document.getElementById("loading-screen").style.display = "none";
  document.getElementById("game-wrapper").style.display = "flex";
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

const AI_TURN_DELAY = 800;   // ms between AI actions and event
const AI_EVENT_DELAY = 1200; // ms to show event banner before next turn

function hostAdvanceGame() {
  hostAdvanceStep();
}

function hostAdvanceStep() {
  if (game.is_over()) {
    hostRefreshState();
    showEndgame();
    return;
  }

  const s = game.state_dict().toJs({dict_converter: Object.fromEntries});
  const curIdx = s.current_player_index;

  // Human's turn — stop and wait for input
  if (s.human_indices.includes(curIdx)) {
    game.begin_human_turn();
    hostRefreshState();
    if (currentState.pending_prompt) {
      handleHostPrompt(currentState.pending_prompt);
    }
    return;
  }

  // Snapshot player state BEFORE the AI turn
  const preTurnState = game.state_dict().toJs({dict_converter: Object.fromEntries});
  const playerBefore = preTurnState.players[preTurnState.current_player_index];

  // AI turn — execute, show actions, pause, show event, pause, next
  const result = game.step_ai_turn().toJs({dict_converter: Object.fromEntries});
  const stateSnap = game.state_dict().toJs({dict_converter: Object.fromEntries});
  const eventLines = (stateSnap.last_event_lines || []).map(l => Object.assign({}, l));
  const playerSnaps = stateSnap.players.map(p => ({name: p.name, money: p.money, debt: p.debt, net_worth: p.net_worth}));

  const aiActions = result.actions || [];
  const playerIdx = result.player_index;
  const playerName = stateSnap.players[playerIdx]?.name || "AI";
  const playerAfter = stateSnap.players[playerIdx];
  const eventDetail = result.event?.detail || "";

  // Concise title: just action types ("Built Iron Mine, Sold FE")
  const titleParts = aiActions.map(a => {
    if (a.type === "build") return `Built ${(a.buildings || []).join(", ")}`;
    if (a.type === "sell") return `Sold ${a.sell_resource || ""}`;
    if (a.type === "contract") return `Contract`;
    if (a.type === "free_action") return a.detail || "Free action";
    return a.type;
  });
  const titleSummary = titleParts.join(", ") || "Pass";

  // Step 1: Show AI actions + update board
  const actionEntry = {
    kind: "turn",
    text: `${playerName}: ${titleSummary}`,
    actions: aiActions,
    playerBefore: playerBefore ? {money: playerBefore.money, debt: playerBefore.debt, net_worth: playerBefore.net_worth, rates: playerBefore.rates} : null,
    playerAfter: playerAfter ? {money: playerAfter.money, debt: playerAfter.debt, net_worth: playerAfter.net_worth, rates: playerAfter.rates} : null,
  };
  addFeedEntry(actionEntry);
  broadcastFeed(actionEntry);
  hostRefreshState();
  logGameStep("turn", playerName, playerIdx, titleSummary, {actions: aiActions});

  // AI action animations
  animateAiActions(aiActions, playerIdx);

  // Step 2: After a pause, show the event (or handle prompt)
  setTimeout(() => {
    // If awaiting prompt (e.g. patent auction), don't add event entry yet —
    // the prompt resolution will add the complete event.
    if (result.awaiting_prompt) {
      hostRefreshState();
      handleHostPrompt(currentState.pending_prompt);
      return;
    }

    if (eventDetail) {
      const evData = result.event?.structured || stateSnap.last_event_data || {};
      addEventFeedEntries(eventDetail, eventLines, playerSnaps, evData);
      logGameStep("event", playerName, playerIdx, buildEventTitle(evData), Object.assign({}, evData, {event_lines: eventLines}));

      // Render chained (redraw) events as separate feed entries
      const chained = result.chained_events || [];
      for (const ce of chained) {
        const ceData = ce.structured || {};
        ceData._is_redraw = true;
        const ceLines = ce.lines || [];
        addEventFeedEntries(ce.detail, ceLines, playerSnaps, ceData);
        logGameStep("event", playerName, playerIdx, buildEventTitle(ceData), Object.assign({}, ceData, {event_lines: ceLines}));
      }
      hostRefreshState();
    }

    // Step 3: After event display, advance to next turn
    setTimeout(() => {
      hostAdvanceStep();
    }, eventDetail ? AI_EVENT_DELAY : 200);

  }, AI_TURN_DELAY);
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
  const snap = game.state_dict().toJs({dict_converter: Object.fromEntries});
  addEventFeedEntries(
    result.detail || "Turn ended",
    (snap.last_event_lines || []).map(l => Object.assign({}, l)),
    snap.players.map(p => ({name: p.name, money: p.money, debt: p.debt, net_worth: p.net_worth})),
    snap.last_event_data || {},
  );

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
  const promptEvData = snapAfter.last_event_data || {};
  const promptLines = (snapAfter.last_event_lines || []).map(l => Object.assign({}, l));
  addEventFeedEntries(
    result.detail || "Prompt resolved",
    promptLines,
    snapAfter.players.map(p => ({name: p.name, money: p.money, debt: p.debt, net_worth: p.net_worth})),
    promptEvData,
  );
  // Include event_lines in the log detail so bids/debt details are captured
  const logDetail = Object.assign({}, promptEvData, {event_lines: promptLines});
  const logSummary = buildEventTitle(promptEvData) || result.detail || "Prompt resolved";
  logGameStep("event", "", -1, logSummary, logDetail);

  if (result.awaiting_prompt) {
    hostRefreshState();
    handleHostPrompt(currentState.pending_prompt);
    return;
  }
  hostRefreshState();
  hostAdvanceGame();
}

// ===== Card Animations =====

const ANIM_FLIGHT = 400;
const ANIM_FADE = 300;

function animateCard(sourceRect, destRect, html, opts = {}) {
  const clone = document.createElement("div");
  clone.className = "flying-card";
  clone.innerHTML = html;
  Object.assign(clone.style, {
    position: "fixed",
    left: sourceRect.left + "px",
    top: sourceRect.top + "px",
    width: sourceRect.width + "px",
    zIndex: "200",
    transition: `all ${ANIM_FLIGHT}ms cubic-bezier(0.4, 0, 0.2, 1)`,
    pointerEvents: "none",
    overflow: "hidden",
  });
  document.body.appendChild(clone);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      clone.style.left = destRect.left + "px";
      clone.style.top = destRect.top + "px";
      clone.style.width = destRect.width + "px";
      if (opts.fadeOut) clone.style.opacity = "0";
    });
  });
  const cleanup = () => { if (clone.parentNode) clone.remove(); };
  clone.addEventListener("transitionend", cleanup, {once: true});
  setTimeout(cleanup, ANIM_FLIGHT + 100);
}

function animateFadeOut(rect, html) {
  if (!rect) return;
  const clone = document.createElement("div");
  clone.className = "flying-card card-fade-out";
  clone.innerHTML = html || "";
  Object.assign(clone.style, {
    position: "fixed",
    left: rect.left + "px",
    top: rect.top + "px",
    width: rect.width + "px",
    zIndex: "200",
    pointerEvents: "none",
  });
  document.body.appendChild(clone);
  setTimeout(() => { if (clone.parentNode) clone.remove(); }, ANIM_FADE + 100);
}

function animateReward(rect, text) {
  const el = document.createElement("div");
  el.className = "reward-popup";
  el.textContent = text;
  Object.assign(el.style, {
    position: "fixed",
    left: (rect.left + rect.width / 2) + "px",
    top: rect.top + "px",
    zIndex: "201",
  });
  document.body.appendChild(el);
  setTimeout(() => { if (el.parentNode) el.remove(); }, 900);
}

function animateAiActions(actions, playerIdx) {
  // Find the opponent card element for this player
  const oppCards = document.querySelectorAll("#mp-opponents .opponent-card");
  let oppEl = null;
  for (const card of oppCards) {
    // Match by checking if the card's name matches
    const nameEl = card.querySelector(".opponent-name");
    const playerName = currentState?.players[playerIdx]?.name || "";
    if (nameEl && nameEl.textContent.includes(playerName)) {
      oppEl = card;
      break;
    }
  }
  if (!oppEl) return;
  const oppRect = oppEl.getBoundingClientRect();

  // Pool area as source for builds (AI "picks" from pool conceptually)
  const poolGrid = document.getElementById("mp-pool-grid");
  const poolRect = poolGrid?.getBoundingClientRect() || {left: oppRect.left, top: oppRect.top - 100, width: 160, height: 30};

  let delay = 0;
  for (const a of actions) {
    if (a.type === "build") {
      // Card flies from pool area to opponent's panel
      const names = (a.buildings || []).join(", ");
      const ratesHtml = Object.entries(a.rates_gained || {})
        .filter(([, v]) => v !== 0)
        .map(([r, v]) => `<span class="${v > 0 ? 'rate-pos' : 'rate-neg'}">${v > 0 ? '+' : ''}${v} ${r}</span>`)
        .join(" ");
      const html = `<div class="card-name">${names}</div>${ratesHtml ? `<div class="card-rates">${ratesHtml}</div>` : ""}`;
      const sourceRect = {left: poolRect.left + poolRect.width / 2 - 80, top: poolRect.top, width: 160, height: 40};
      const ratesGained = a.rates_gained;
      setTimeout(() => {
        animateCard(sourceRect, oppRect, html);
        // Rate change popups on the opponent's rate chips
        if (ratesGained && oppEl) {
          setTimeout(() => animateRateChanges(ratesGained, "#mp-opponents"), 200);
        }
      }, delay);
      delay += 120;
    } else if (a.type === "sell" && a.sell_revenue > 0) {
      // Reward popup near opponent
      setTimeout(() => animateReward(oppRect, `+$${a.sell_revenue}`), delay);
      delay += 80;
    } else if (a.type === "contract" && a.contract_reward > 0) {
      setTimeout(() => animateReward(oppRect, `+$${a.contract_reward}`), delay);
      delay += 80;
    }
  }
}

function animateRateChanges(rates, targetSelector) {
  // Show floating +/- numbers over the rate chips that changed
  if (!rates || typeof rates !== "object") return;
  const entries = Object.entries(rates).filter(([, v]) => v !== 0);
  if (entries.length === 0) return;

  for (const [resource, amount] of entries) {
    // Find the rate chip — search all chips under the target, match by resource text
    const chips = document.querySelectorAll(`${targetSelector} .rate-chip`);
    let chipEl = null;
    for (const chip of chips) {
      const resEl = chip.querySelector(".rate-res");
      if (resEl && resEl.textContent.trim().toUpperCase() === resource.toUpperCase()) {
        chipEl = chip;
        break;
      }
    }
    if (!chipEl) {
      // Fallback: try finding by resource color in the rates grid
      continue;
    }
    const rect = chipEl.getBoundingClientRect();
    if (rect.width === 0) continue; // element not visible
    const popup = document.createElement("div");
    popup.className = amount > 0 ? "rate-change-popup positive" : "rate-change-popup negative";
    popup.textContent = `${amount > 0 ? "+" : ""}${amount}`;
    Object.assign(popup.style, {
      position: "fixed",
      left: (rect.left + rect.width / 2) + "px",
      top: (rect.top - 8) + "px",
      zIndex: "250",
    });
    document.body.appendChild(popup);
    setTimeout(() => { if (popup.parentNode) popup.remove(); }, 1200);
  }
}

// ===== Deck viewer =====

let deckViewerOpen = false;

function toggleDeckViewer() {
  deckViewerOpen = !deckViewerOpen;
  renderDeckViewer();
}

function renderDeckViewer() {
  const el = document.getElementById("deck-viewer");
  if (!el) return;
  if (!deckViewerOpen || !currentState) {
    el.style.display = "none";
    return;
  }
  const remaining = currentState.event_deck_remaining || [];
  const nonRedraw = remaining.filter(e => !e.redraws);
  const numPlayers = currentState.players?.length || 3;

  // Count by type
  const counts = {};
  for (const e of remaining) {
    const label = e.redraws ? `${e.type} (redraw)` : e.type;
    counts[label] = (counts[label] || 0) + 1;
  }

  const EVENT_COLORS = {
    power_bill: "#e74c3c",
    debt_collection: "#f85149",
    futures_trading: "#d29922",
    patent_auction: "#a371f7",
    draw_building_card: "#58a6ff",
    news_bulletin: "#3fb950",
    news: "#3fb950",
    end_round: "#f0883e",
    end_game: "#f0883e",
  };

  el.style.display = "block";
  el.innerHTML = `
    <div class="deck-viewer-inner">
      <div class="deck-viewer-header">
        <strong>Event Deck</strong> — ${remaining.length} cards left, ${nonRedraw.length} player turns (${Math.floor(nonRedraw.length / numPlayers)} per player)
        <span style="margin-left:auto;cursor:pointer;color:#8b949e" onclick="toggleDeckViewer()">close</span>
      </div>
      <div class="deck-viewer-summary">
        ${Object.entries(counts).map(([type, n]) => {
          const baseType = type.replace(" (redraw)", "");
          const color = EVENT_COLORS[baseType] || "#8b949e";
          return `<span class="deck-chip" style="border-color:${color}">${type}: ${n}</span>`;
        }).join("")}
      </div>
      <div class="deck-viewer-list">
        ${remaining.map((e, i) => {
          const color = EVENT_COLORS[e.type] || "#8b949e";
          const flags = [];
          if (e.redraws) flags.push("redraw");
          if (e.pwr_adjust) flags.push("PWR adj");
          const flagStr = flags.length ? ` <span class="deck-flags">${flags.join(", ")}</span>` : "";
          return `<span class="deck-card" style="border-left-color:${color}">${e.type.replace(/_/g, " ")}${flagStr}</span>`;
        }).join("")}
      </div>
    </div>
  `;
}

// ===== Event Deck/Discard =====

function showEventBanner(titleHtml) {
  // Animate card from deck to discard
  const deckEl = document.getElementById("event-deck-card");
  const discardEl = document.getElementById("event-discard");
  const textEl = document.getElementById("event-discard-text");
  if (!deckEl || !discardEl || !textEl) return;

  const deckRect = deckEl.getBoundingClientRect();
  const discardRect = discardEl.getBoundingClientRect();

  // Create a flying card clone
  const flyCard = document.createElement("div");
  flyCard.className = "flying-card";
  flyCard.innerHTML = `<span style="font-size:0.7rem">&#9889; ${titleHtml}</span>`;
  Object.assign(flyCard.style, {
    position: "fixed",
    left: deckRect.left + "px",
    top: deckRect.top + "px",
    width: deckRect.width + "px",
    height: deckRect.height + "px",
    zIndex: "200",
    transition: `all ${ANIM_FLIGHT}ms cubic-bezier(0.4, 0, 0.2, 1)`,
    pointerEvents: "none",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderColor: "#f0883e",
  });
  document.body.appendChild(flyCard);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      flyCard.style.left = discardRect.left + "px";
      flyCard.style.top = discardRect.top + "px";
      flyCard.style.width = discardRect.width + "px";
      flyCard.style.height = discardRect.height + "px";
    });
  });

  flyCard.addEventListener("transitionend", () => {
    flyCard.remove();
    // Update discard face
    textEl.innerHTML = `&#9889; ${titleHtml}`;
    discardEl.classList.remove("fresh");
    void discardEl.offsetHeight; // reflow
    discardEl.classList.add("fresh");
  }, {once: true});
  setTimeout(() => { if (flyCard.parentNode) flyCard.remove(); }, ANIM_FLIGHT + 100);
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
  renderDeckViewer();
}

const PRICE_TRACK = [1,1,1,2,2,2,3,3,4,4,5,5,6,7,8,9,10];
let expandedMarketResource = null;

function stepsAtSamePrice(pos, direction) {
  // Count remaining positions in direction with the SAME price (not including current)
  const curPrice = PRICE_TRACK[pos];
  let steps = 0;
  let p = pos + direction;
  while (p >= 0 && p < PRICE_TRACK.length && PRICE_TRACK[p] === curPrice) {
    steps++;
    p += direction;
  }
  return steps;
}

function renderMarket(s) {
  const grid = document.getElementById("mp-market-grid");
  const positions = s.market_positions || {};

  grid.innerHTML = RESOURCE_ORDER.map(r => {
    const price = s.market[r] || 0;
    const pos = positions[r] ?? 9;
    const stepsDown = stepsAtSamePrice(pos, -1);
    const stepsUp = stepsAtSamePrice(pos, 1);
    const dotsLeft = stepsDown > 0 ? Array(stepsDown).fill('<span class="step-dot"></span>').join("") : "";
    const dotsRight = stepsUp > 0 ? Array(stepsUp).fill('<span class="step-dot"></span>').join("") : "";
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

  // Wire click to expand ruler + toggle chart line
  grid.querySelectorAll(".market-cell").forEach(el => {
    el.addEventListener("click", () => {
      const r = el.dataset.res;
      const wasSelected = expandedMarketResource === r;
      expandedMarketResource = wasSelected ? null : r;
      renderMarketRuler(s);
      // Toggle chart visibility: isolate clicked resource or show all
      if (marketChart) {
        RESOURCE_ORDER.forEach((res, i) => {
          if (wasSelected) {
            marketChart.setDatasetVisibility(i, true);
          } else {
            marketChart.setDatasetVisibility(i, res === r);
          }
        });
        marketChart.update();
      }
      // Dim/undim market cells
      grid.querySelectorAll(".market-cell").forEach(cell => {
        if (wasSelected) {
          cell.style.opacity = "1";
        } else {
          cell.style.opacity = cell.dataset.res === r ? "1" : "0.4";
        }
      });
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
        plugins: {legend: {display: false}},
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
  const myTurn = isMyTurn(s);
  grid.innerHTML = (s.available_contracts || []).map((c, ci) => {
    const reqs = (c.requirements || []).map(r => {
      const have = me?.rates?.[r.resource] || 0;
      const met = have >= r.amount;
      return `<span class="contract-req ${met ? 'met' : 'unmet'}">${r.amount} ${r.resource}</span>`;
    }).join(", ");
    const sel = ci === selectedContract ? "selected" : "";
    const inactive = !myTurn ? "inactive" : "";
    return `
      <div class="contract-card ${sel} ${inactive}" data-ci="${ci}">
        <div class="contract-reward">$${c.reward}</div>
        <div>${reqs}</div>
      </div>
    `;
  }).join("");
  if (myTurn) {
    grid.querySelectorAll(".contract-card").forEach(el => {
      el.addEventListener("click", () => {
        const ci = parseInt(el.dataset.ci);
        selectedContract = selectedContract === ci ? -1 : ci;
        renderContracts(s);
      });
    });
  }
}

function renderPool(s) {
  const grid = document.getElementById("mp-pool-grid");
  const myTurn = isMyTurn(s);
  const canSwap = myTurn && s.can_pool_swap && selectedCards.size === 1;
  const poolInactive = myTurn && !canSwap ? "inactive" : "";
  grid.innerHTML = (s.pool || []).map((c, i) => {
    const swappable = canSwap ? "swap-target" : "";
    return `<div class="pool-card ${swappable} ${poolInactive}" data-pi="${i}">${renderCard(c)}</div>`;
  }).join("");
  if (canSwap) {
    grid.querySelectorAll(".pool-card").forEach(el => {
      el.addEventListener("click", () => {
        const pi = parseInt(el.dataset.pi);
        const hi = Array.from(selectedCards)[0];
        executePoolSwap(hi, pi);
        clearSelection();
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
    grid.innerHTML = `<div style="color:#8b949e;padding:12px">Hand is empty</div>`;
    document.getElementById("mp-build-estimate").textContent = "";
    return;
  }

  // Affordability hints from legal actions
  const affordableSet = new Set(currentLegal?.affordable_single_builds || []);
  const cr = currentLegal?.cards_remaining ?? 2;

  const inactive = !myTurn ? "inactive" : "";
  grid.innerHTML = hand.map((c, i) => {
    const sel = selectedCards.has(i) ? "selected" : "";
    return `<div class="hand-card ${sel} ${inactive}" data-hi="${i}">${renderCard(c)}</div>`;
  }).join("");

  // Build cost estimate
  const estimateEl = document.getElementById("mp-build-estimate");
  if (selectedCards.size > 0 && myTurn && role === "host") {
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
        if (selectedCards.has(hi)) selectedCards.delete(hi);
        else if (selectedCards.size < cr) selectedCards.add(hi);
        renderHand(s);
        renderPool(s);
        renderActions(s);
      });
    });
  }
}

function executePoolSwap(handIdx, poolIdx) {
  // Capture positions before swap
  const handEl = document.querySelectorAll("#mp-hand-grid .hand-card")[handIdx];
  const poolEl = document.querySelectorAll("#mp-pool-grid .pool-card")[poolIdx];
  const handRect = handEl?.getBoundingClientRect();
  const poolRect = poolEl?.getBoundingClientRect();
  const handHtml = handEl?.innerHTML || "";
  const poolHtml = poolEl?.innerHTML || "";

  if (role === "host") {
    game.human_pool_swap(parseInt(handIdx), parseInt(poolIdx));
    hostRefreshState();
    const pName = currentState?.players[mySeat]?.name || "You";
    logGameStep("swap", pName, mySeat, `Swapped hand[${handIdx}] with pool[${poolIdx}]`, {handIdx, poolIdx});
  } else {
    hostConn.send(JSON.stringify({type: "pool_swap", hand_idx: parseInt(handIdx), pool_idx: parseInt(poolIdx)}));
  }

  // Cross-swap animation
  if (handRect && poolRect) {
    animateCard(handRect, poolRect, handHtml);
    animateCard(poolRect, handRect, poolHtml);
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
      const pName = currentState?.players[mySeat]?.name || "You";
      addFeedEntry({kind: "free-action", text: `You: ${result.detail}`});
      broadcastFeed({kind: "free-action", text: `${pName}: ${result.detail}`});
      hostRefreshState();
      logGameStep("free_action", pName, mySeat, result.detail, result);
    } else if (result) {
      alert(result.reason || "Patent action failed");
      hostRefreshState();
    } else {
      hostRefreshState();
    }
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
  strip.innerHTML = s.players.filter((_, i) => i !== mySeat).map(p => {
    const realIdx = s.players.indexOf(p);
    const isActive = realIdx === s.current_player_index;
    const color = PLAYER_COLORS[realIdx % PLAYER_COLORS.length];

    // Same rate-chip grid as player panel, slightly smaller
    const ratesGrid = RESOURCE_ORDER.map(r => {
      const v = p.rates?.[r] || 0;
      const cls = v > 0 ? "rate-pos" : v < 0 ? "rate-neg" : "rate-zero";
      return `<div class="rate-chip sm ${cls}"><span class="rate-res" style="color:${RESOURCE_COLORS[r]}">${r}</span><span class="rate-val">${v > 0 ? "+" : ""}${v}</span></div>`;
    }).join("");

    // Buildings split into regular + specials + patents
    const builtCards = p.built_cards || [];
    const buildings = builtCards.filter(c => !c.effect && c.slot !== 5).map(c => c.building);
    const specials = builtCards.filter(c => c.effect && c.slot !== 5);
    const patents = builtCards.filter(c => c.slot === 5);
    const buildingList = buildings.length ? buildings.join(", ") : "none";
    const specialList = specials.map(c => `<span class="opp-special">${c.building}</span>`).join(" ");
    const patentList = patents.map(c => `<span class="opp-patent">${c.building}</span>`).join(" ");

    return `
      <div class="opponent-card ${isActive ? 'active-turn' : ''}" style="border-left:3px solid ${color}">
        <div class="opponent-header">
          <span class="opponent-name" style="color:${color}">${p.name}${p.is_human ? '' : ' (AI)'}</span>
          <span class="opponent-nw" style="color:${p.net_worth >= 0 ? '#3fb950' : '#f85149'}">NW $${p.net_worth}</span>
        </div>
        <div class="opponent-money">
          $${p.money}${p.debt > 0 ? ` <span style="color:#f85149">Debt $${p.debt}</span>` : ''}${p.credit > 0 ? ` <span style="color:#d29922">Credit $${p.credit}</span>` : ''} | ${p.contracts_fulfilled || 0} contracts
        </div>
        <div class="opponent-rates-grid">${ratesGrid}</div>
        <div class="opponent-buildings">${buildingList}</div>
        ${specialList ? `<div class="opponent-specials">${specialList}</div>` : ''}
        ${patentList ? `<div class="opponent-specials">${patentList}</div>` : ''}
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

function addEventFeedEntries(_eventDetail, eventLines, playerSnaps, eventData) {
  const entry = {
    kind: "event",
    eventData: eventData || {},
    event_lines: eventLines,
    player_snapshots: (eventData && eventData.player_snapshots) || playerSnaps,
  };
  addFeedEntry(entry);
  broadcastFeed(entry);
  showEventBanner(buildEventCardLabel(eventData || {}));

  // Round marker when END_ROUND fires
  const evType = (eventData || {}).event_type;
  if (evType === "end_round") {
    const roundNum = currentState?.deck_round || currentState?.round || "?";
    const marker = {kind: "round-marker", text: `--- Round ${roundNum} Complete ---`};
    addFeedEntry(marker);
    broadcastFeed(marker);
  }

  // Animate draw building card: new card flies from event deck to pool
  if (eventData?.event_type === "draw_building_card" && eventData.card_drawn) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const poolCards = document.querySelectorAll("#mp-pool-grid .pool-card");
        const destEl = poolCards[poolCards.length - 1]; // new card is last in pool
        const deckEl = document.getElementById("event-deck-card");
        if (destEl && deckEl) {
          const destRect = destEl.getBoundingClientRect();
          const deckRect = deckEl.getBoundingClientRect();
          animateCard(
            deckRect,
            destRect,
            `<div class="card-name">${eventData.card_drawn}</div>`
          );
        }
      });
    });
  }
}

function buildEventCardLabel(ed) {
  // Simple label for the discard card face — just the event type, no effects
  if (!ed) return "";
  switch (ed.event_type || "") {
    case "draw_building_card": return "Draw Building Card";
    case "news_bulletin": {
      const name = ed.news_name || "?";
      const effects = ed.news_effects || "";
      return effects ? `News: ${name} (${effects})` : `News: ${name}`;
    }
    case "patent_auction": return "Patent Auction";
    case "power_bill": return "Power Bill";
    case "debt_collection": return "Debt Collection";
    case "futures_trading": return "Futures Trading";
    case "futures_settlement": return "Futures Settlement";
    case "end_round": return "END OF ROUND";
    case "end_game": return "END GAME";
    default: return (ed.event_type || "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  }
}

function buildEventTitle(ed) {
  if (!ed) return "";
  const type = ed.event_type || "";
  let title = "";

  switch (type) {
    case "draw_building_card":
      title = `Draw: ${ed.card_drawn || "?"}`;
      break;
    case "news_bulletin":
      title = `News: ${ed.news_name || "?"}`;
      break;
    case "patent_auction":
      title = `Patent Auction: ${ed.auction_result || ""}`;
      break;
    case "power_bill": title = "Power Bill"; break;
    case "debt_collection": title = "Debt Collection"; break;
    case "futures_trading": {
      const changes = (ed.market_changes || []).map(c =>
        `${c.resource} $${c.price_before}\u2192$${c.price_after}`
      ).join(", ");
      title = `Futures Trading${changes ? ": " + changes : ""}`;
      break;
    }
    case "futures_settlement": title = "Futures Settlement"; break;
    case "end_round": title = "END OF ROUND"; break;
    case "end_game": title = "END GAME"; break;
    default: title = type.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  }

  // PWR adjust prepended before title (rendered before lightning icon)
  if (ed.pwr_adjust) {
    const rate = ed.pwr_adjust.rate;
    const cls = rate >= 0 ? "pwr-up" : "pwr-down";
    const sign = rate >= 0 ? "+" : "";
    title = `<span class="${cls}">${sign}${rate} PWR</span> ${title}`;
  }

  return title;
}

function fmtMoney(text) {
  if (!text) return "";
  return text.replace(/\$(\d+)/g, '<span class="feed-money">$$$1</span>');
}

function formatRates(rates) {
  // {FE: 1, PWR: -1} → "+1 FE -1 PWR"
  if (!rates || typeof rates !== "object") return "";
  return Object.entries(rates)
    .filter(([, v]) => v !== 0)
    .map(([r, v]) => `<span class="${v > 0 ? 'rate-pos' : 'rate-neg'}">${v > 0 ? '+' : ''}${v} ${r}</span>`)
    .join(" ");
}

function formatActionSummary(a) {
  // Build a concise one-line summary with rates
  if (a.type === "build") {
    const names = (a.buildings || []).join(", ");
    const cost = a.build_money_spent > 0 ? ` ($${a.build_money_spent})` : "";
    const rates = formatRates(a.rates_gained);
    return `Built ${names}${cost}${rates ? " " + rates : ""}`;
  }
  if (a.type === "sell") {
    return `Sold ${a.sell_amount || ""} ${a.sell_resource || ""} for $${a.sell_revenue || 0}`;
  }
  if (a.type === "contract") {
    return `Contract ${a.contract_label || ""} for $${a.contract_reward || 0}`;
  }
  if (a.type === "free_action") {
    return a.detail || "Free action";
  }
  return a.detail || a.type || "?";
}

// formatEventTitle removed — all events now use structured data via buildEventTitle()

function renderFeedEntry(e) {
  if (e.kind === "turn-start") {
    // Game kickoff or round marker
    const detailLines = (e.details || "").split("\n").map(l => `<div>${fmtMoney(l)}</div>`).join("");
    return `
      <details class="feed-group kickoff">
        <summary class="feed-group-title">${e.text}</summary>
        <div class="feed-group-body">${detailLines}</div>
      </details>
    `;
  }

  if (e.kind === "turn") {
    const colonIdx = (e.text || "").indexOf(":");
    const playerName = colonIdx > 0 ? e.text.substring(0, colonIdx) : "";
    const playerIdx = currentState?.players?.findIndex(p => p.name === playerName) ?? -1;
    const color = playerIdx >= 0 ? PLAYER_COLORS[playerIdx % PLAYER_COLORS.length] : "#8b949e";
    const title = playerName || "Turn";
    const summary = colonIdx > 0 ? e.text.substring(colonIdx + 1).trim() : e.text;

    const actionList = e.actions || [];
    const before = e.playerBefore;
    const after = e.playerAfter;

    // Build structured detail: action table + before/after comparison
    let detailHtml = "";
    if (actionList.length > 0) {
      detailHtml += `<table class="feed-action-table">`;
      for (const a of actionList) {
        const rates = formatRates(a.rates_gained);
        const cost = a.build_money_spent > 0 ? `<span class="feed-money">-$${a.build_money_spent}</span>` : "";
        const rev = a.sell_revenue > 0 ? `<span class="feed-money">+$${a.sell_revenue}</span>` : "";
        const reward = a.contract_reward > 0 ? `<span class="feed-money">+$${a.contract_reward}</span>` : "";
        const label = a.type === "build" ? (a.buildings || []).join(", ")
          : a.type === "sell" ? `Sell ${a.sell_amount || ""} ${a.sell_resource || ""}`
          : a.type === "contract" ? `Contract ${a.contract_label || ""}`
          : a.detail || a.type;
        detailHtml += `<tr><td class="feed-at-action">${label}</td><td class="feed-at-cash">${cost}${rev}${reward}</td><td class="feed-at-rates">${rates}</td></tr>`;
      }
      detailHtml += `</table>`;
    }
    // Before/after snapshot
    if (before && after) {
      const nwDelta = after.net_worth - before.net_worth;
      const nwClass = nwDelta >= 0 ? "positive" : "negative";
      detailHtml += `<div class="feed-before-after">`;
      detailHtml += `<span>$${before.money}→$${after.money}</span>`;
      if (after.debt > 0 || before.debt > 0) detailHtml += `<span class="negative">Debt $${before.debt}→$${after.debt}</span>`;
      detailHtml += `<span class="${nwClass}">NW $${before.net_worth}→$${after.net_worth} (${nwDelta >= 0 ? "+" : ""}${nwDelta})</span>`;
      detailHtml += `</div>`;
    }

    if (detailHtml) {
      return `
        <details class="feed-group turn" style="border-left-color:${color}">
          <summary class="feed-group-title"><span class="feed-player-name" style="color:${color}">${title}</span> ${fmtMoney(summary)} <span class="feed-time">${e.time}</span></summary>
          <div class="feed-group-body">${detailHtml}</div>
        </details>
      `;
    }
    return `
      <div class="feed-group turn" style="border-left-color:${color}">
        <div class="feed-group-title"><span class="feed-player-name" style="color:${color}">${title}</span> ${fmtMoney(summary)} <span class="feed-time">${e.time}</span></div>
      </div>
    `;
  }

  if (e.kind === "event") {
    const ed = e.eventData || {};
    const eventTitle = buildEventTitle(ed);

    // Build rich expandable detail from structured data
    let detailHtml = "";

    // Draw building card: show card details + what was replaced
    if (ed.event_type === "draw_building_card") {
      detailHtml += `<div class="feed-line-note">Drew <strong>${ed.card_drawn || "?"}</strong> into pool</div>`;
      if (ed.card_replaced) detailHtml += `<div class="feed-line-note">Replaced: ${ed.card_replaced}</div>`;
      if (ed.card_rates?.length) {
        const rates = ed.card_rates.map(r => `<span class="${r.amount > 0 ? 'rate-pos' : 'rate-neg'}">${r.amount > 0 ? '+' : ''}${r.amount} ${r.resource}</span>`).join(" ");
        detailHtml += `<div class="feed-line-note">Rates: ${rates}</div>`;
      }
      if (ed.card_costs?.length) {
        detailHtml += `<div class="feed-line-note">Costs: ${ed.card_costs.map(c => c.amount + " " + c.resource).join(", ")}</div>`;
      }
      if (ed.card_effect) detailHtml += `<div class="feed-line-note" style="color:#a371f7">${ed.card_effect}</div>`;
    }

    // Futures trading: show who caused the market moves
    if (ed.event_type === "futures_trading") {
      if (ed.market_changes?.length) {
        detailHtml += `<div class="feed-line-header">Market Changes</div>`;
        for (const c of ed.market_changes) {
          const color = RESOURCE_COLORS[c.resource] || "#8b949e";
          detailHtml += `<div class="feed-line-note"><span style="color:${color}">${c.resource}</span>: +${c.units} units → $${c.price_before} → $${c.price_after}</div>`;
        }
      }
      if (ed.player_contributions?.length) {
        detailHtml += `<div class="feed-line-header">Caused By</div>`;
        for (const p of ed.player_contributions) {
          const rates = Object.entries(p.rates).map(([r, v]) => `<span class="rate-neg">${v} ${r}</span>`).join(" ");
          detailHtml += `<div class="feed-line-player"><span class="feed-line-name">${p.name}</span> ${rates}</div>`;
        }
      }
    }

    // News: show effects
    if (ed.event_type === "news_bulletin" && ed.news_effects) {
      detailHtml += `<div class="feed-line-note">${ed.news_effects}</div>`;
    }

    // PWR adjust detail
    if (ed.pwr_adjust) {
      const pa = ed.pwr_adjust;
      detailHtml += `<div class="feed-line-note">PWR price: $${pa.price_before} → $${pa.price_after}</div>`;
    }

    // Event lines from the backend (power bill per-player details, etc.)
    if (e.event_lines?.length > 0) {
      detailHtml += e.event_lines.map(line => {
        if (line.kind === "header") return `<div class="feed-line-header">${line.text}</div>`;
        if (line.kind === "note") return `<div class="feed-line-note">${fmtMoney(line.text)}</div>`;
        if (line.kind === "player") {
          const nw = line.net_worth_after !== undefined ? `<span class="feed-nw-inline">NW $${line.net_worth_after}</span>` : '';
          return `<div class="feed-line-player"><span class="feed-line-name">${line.name || ''}</span> ${fmtMoney(line.text)} ${nw}</div>`;
        }
        return `<div class="feed-line-note">${fmtMoney(line.text || '')}</div>`;
      }).join("");
    }

    // Player snapshots
    if (e.player_snapshots?.length > 0) {
      detailHtml += `<div class="feed-impact">${e.player_snapshots.map(p => {
        const cls = p.net_worth >= 0 ? "positive" : "negative";
        return `<span class="feed-nw-chip ${cls}">${p.name} $${p.net_worth}</span>`;
      }).join("")}</div>`;
    }

    const redrawIcon = ed.redraws ? '<span class="redraw-icon" title="Draws another event">&#8635;</span>' : '';
    const isRedraw = ed._is_redraw ? '<span class="redraw-marker" title="Redrawn event">&#8627;</span> ' : '';

    // Always expandable for events
    return `
      <details class="feed-group event">
        <summary class="feed-group-title">${isRedraw}${ed.pwr_adjust ? '<span class="feed-event-icon">&#9889;</span> ' : ''}${eventTitle} ${redrawIcon} <span class="feed-time">${e.time}</span></summary>
        <div class="feed-group-body">${detailHtml || '<div class="feed-line-note">No additional details</div>'}</div>
      </details>
    `;
  }

  if (e.kind === "action" || e.kind === "free-action") {
    return `
      <div class="feed-group ${e.kind}">
        <div class="feed-group-title">${fmtMoney(e.text)} <span class="feed-time">${e.time}</span></div>
      </div>
    `;
  }

  if (e.kind === "round-marker") {
    return `<div class="feed-round-marker">${e.text}</div>`;
  }

  // Fallback
  return `<div class="feed-group"><div class="feed-group-title">${fmtMoney(e.text || '')} <span class="feed-time">${e.time || ''}</span></div></div>`;
}

function renderFeed() {
  const container = document.getElementById("feed-entries");
  if (!container) return;
  container.innerHTML = feedEntries.slice(-80).reverse().map(renderFeedEntry).join("");
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

let endgameShown = false;
function showEndgame() {
  if (!currentState || endgameShown) return;
  endgameShown = true;
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
  // Deck viewer toggle (click the deck card back)
  document.getElementById("event-deck-card")?.addEventListener("click", toggleDeckViewer);

  // Market chart toggle
  document.getElementById("market-toggle")?.addEventListener("click", () => {
    const wrap = document.getElementById("market-chart-wrap");
    if (wrap) wrap.style.display = wrap.style.display === "none" ? "block" : "none";
  });

  document.getElementById("mp-build-btn").addEventListener("click", () => {
    if (selectedCards.size === 0) return;
    // Capture card rects before action
    const cardRects = [...selectedCards].map(i => {
      const el = document.querySelectorAll("#mp-hand-grid .hand-card")[i];
      return el ? {rect: el.getBoundingClientRect(), html: el.innerHTML} : null;
    }).filter(Boolean);
    const destRect = document.getElementById("mp-your-stats")?.getBoundingClientRect();

    sendAction({type: "build", build_cards: [...selectedCards].map(Number)});
    clearSelection();

    // Animate cards flying to buildings area
    if (destRect) {
      cardRects.forEach((c, i) => {
        setTimeout(() => animateCard(c.rect, destRect, c.html), i * 80);
      });
    }
  });
  document.getElementById("mp-sell-btn").addEventListener("click", () => {
    if (selectedCards.size !== 1) return;
    const cardIdx = Number([...selectedCards][0]);
    // Capture card rect
    const el = document.querySelectorAll("#mp-hand-grid .hand-card")[cardIdx];
    const cardRect = el?.getBoundingClientRect();
    const cardHtml = el?.innerHTML || "";

    const action = {type: "sell", card_idx: cardIdx};
    const resSel = document.getElementById("mp-sell-resource");
    if (resSel?.value) action.sell_resource = resSel.value;
    const hTarget = document.getElementById("mp-hacker-target");
    const hDir = document.getElementById("mp-hacker-dir");
    if (hTarget?.value) {
      action.hacker_target = hTarget.value;
      action.hacker_direction = parseInt(hDir?.value || "1");
    }
    sendAction(action);
    clearSelection();

    // Animate fade out
    if (cardRect) animateFadeOut(cardRect, cardHtml);
  });
  document.getElementById("mp-contract-btn").addEventListener("click", () => {
    if (selectedContract < 0) return;
    const cardIdx = selectedCards.size === 1 ? Number([...selectedCards][0]) : -1;
    // Capture card rect
    const el = cardIdx >= 0 ? document.querySelectorAll("#mp-hand-grid .hand-card")[cardIdx] : null;
    const cardRect = el?.getBoundingClientRect();
    const cardHtml = el?.innerHTML || "";

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

    // Animate fade + reward
    if (cardRect) {
      animateFadeOut(cardRect, cardHtml);
      const contract = currentState?.available_contracts?.[selectedContract];
      if (contract) animateReward(cardRect, `+$${contract.reward}`);
    }
  });
  document.getElementById("mp-pass-btn").addEventListener("click", () => {
    clearSelection();
    // Log the pass/end turn
    const playerName = currentState?.players[mySeat]?.name || "You";
    addFeedEntry({kind: "turn", text: `${playerName}: End Turn`});
    broadcastFeed({kind: "turn", text: `${playerName}: End Turn`});

    if (role === "host") {
      const result = game.end_human_turn().toJs({dict_converter: Object.fromEntries});
      humanTurnActions = [];

      // If awaiting prompt (patent auction, debt paydown), don't add event
      // entry yet — the prompt resolution will add the complete event.
      if (result.awaiting_prompt) {
        hostRefreshState();
        handleHostPrompt(currentState.pending_prompt);
        return;
      }

      // Event resolved normally — add feed entry
      const snapAfter = game.state_dict().toJs({dict_converter: Object.fromEntries});
      const playerSnapsAfter = snapAfter.players.map(p => ({name: p.name, money: p.money, debt: p.debt, net_worth: p.net_worth}));
      const evData = result.structured || snapAfter.last_event_data || {};
      addEventFeedEntries(
        result.detail || "Turn ended",
        (result.lines || snapAfter.last_event_lines || []).map(l => Object.assign({}, l)),
        playerSnapsAfter,
        evData,
      );
      const pName = currentState?.players[mySeat]?.name || "You";
      const humanEventLines = (result.lines || snapAfter.last_event_lines || []).map(l => Object.assign({}, l));
      logGameStep("event", pName, mySeat, buildEventTitle(evData), Object.assign({}, evData, {event_lines: humanEventLines}));
      // Render chained (redraw) events as separate feed entries
      const chained = result.chained_events || [];
      for (const ce of chained) {
        const ceData = ce.structured || {};
        ceData._is_redraw = true;
        const ceLines = ce.lines || [];
        addEventFeedEntries(ce.detail, ceLines, playerSnapsAfter, ceData);
        logGameStep("event", pName, mySeat, buildEventTitle(ceData), Object.assign({}, ceData, {event_lines: ceLines}));
      }
      hostRefreshState();
      hostAdvanceGame();
    } else {
      hostConn.send(JSON.stringify({type: "end_turn"}));
    }
  });
}

// Accumulate human actions during their turn for a grouped feed entry
let humanTurnActions = [];

function sendAction(action) {
  if (role === "host") {
    const beforeSnap = currentState?.players[mySeat];
    const playerBefore = beforeSnap ? {money: beforeSnap.money, debt: beforeSnap.debt, net_worth: beforeSnap.net_worth, rates: Object.assign({}, beforeSnap.rates)} : null;

    const result = game.apply_human_action(pyodide.toPy(action)).toJs({dict_converter: Object.fromEntries});
    if (result.ok) {
      humanTurnActions.push(result);
      hostRefreshState();
      // Animate rate changes on your panel (after DOM paints)
      if (result.rates_gained) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            animateRateChanges(result.rates_gained, ".player-panel-rates");
          });
        });
      }
      const afterSnap = currentState?.players[mySeat];
      const playerAfter = afterSnap ? {money: afterSnap.money, debt: afterSnap.debt, net_worth: afterSnap.net_worth, rates: Object.assign({}, afterSnap.rates)} : null;
      const playerName = currentState?.players[mySeat]?.name || "You";
      const title = formatActionSummary(result);
      addFeedEntry({
        kind: "turn",
        text: `${playerName}: ${title}`,
        actions: [result],
        playerBefore: playerBefore,
        playerAfter: playerAfter,
      });
      broadcastFeed({
        kind: "turn",
        text: `${playerName}: ${title}`,
        actions: [result],
        playerBefore: playerBefore,
        playerAfter: playerAfter,
      });
      logGameStep(result.type || "action", playerName, mySeat, title, result);
    } else {
      alert(result.reason || "Action failed");
      hostRefreshState();
    }
  } else {
    hostConn.send(JSON.stringify({type: "action", action}));
  }
}

// ===== Game Log + Debug Panel =====

const gameLog = [];
let replayMode = false;
let replayStep = -1;
let debugPanelOpen = false;

function logGameStep(type, playerName, playerIdx, summary, detail) {
  if (role !== "host" || !game) return;
  const state = game.state_dict().toJs({dict_converter: Object.fromEntries});
  gameLog.push({
    step: gameLog.length,
    type,
    player: playerName || "",
    playerIdx: playerIdx ?? -1,
    summary: summary || "",
    detail: detail || {},
    state,
    time: new Date().toLocaleTimeString(),
  });
  if (debugPanelOpen) updateDebugPanel();
}

// Toggle debug panel with backtick
document.addEventListener("keydown", (e) => {
  if (e.key === "`" || (e.ctrlKey && e.key === "d")) {
    e.preventDefault();
    toggleDebugPanel();
  }
});

function toggleDebugPanel() {
  debugPanelOpen = !debugPanelOpen;
  const panel = document.getElementById("debug-panel");
  if (panel) panel.style.display = debugPanelOpen ? "block" : "none";
  if (debugPanelOpen) updateDebugPanel();
}

function updateDebugPanel() {
  const total = gameLog.length;
  const step = replayMode ? replayStep : total - 1;
  const entry = gameLog[step];

  document.getElementById("debug-step-label").textContent = `${step + 1} / ${total}`;
  const slider = document.getElementById("debug-slider");
  slider.max = Math.max(0, total - 1);
  slider.value = step;

  document.getElementById("debug-replay-indicator").style.display = replayMode ? "inline" : "none";
  document.getElementById("debug-live").style.display = replayMode ? "inline" : "none";

  const info = document.getElementById("debug-step-info");
  if (entry) {
    const color = entry.playerIdx >= 0 ? PLAYER_COLORS[entry.playerIdx % PLAYER_COLORS.length] : "#8b949e";
    info.innerHTML = `
      <div><strong>Step ${entry.step + 1}</strong> — <span style="color:${color}">${entry.player}</span> <span style="text-transform:uppercase;color:#f0883e">${entry.type}</span> <span style="color:#6e7681">${entry.time}</span></div>
      <div style="margin-top:4px">${entry.summary}</div>
    `;
  } else {
    info.innerHTML = "<div>No data</div>";
  }

  const stateView = document.getElementById("debug-state-view");
  if (!entry) { stateView.textContent = "No data"; return; }

  const lines = [];

  // Detail data (structured action/event info)
  const d = entry.detail;
  if (d && typeof d === "object" && Object.keys(d).length > 0) {
    lines.push("=== ACTION/EVENT DETAIL ===");
    // Event structured data
    if (d.event_type) lines.push(`Event type: ${d.event_type}`);
    if (d.card_drawn) lines.push(`Card drawn: ${d.card_drawn}`);
    if (d.card_replaced) lines.push(`Card replaced: ${d.card_replaced}`);
    if (d.card_rates?.length) lines.push(`Card rates: ${d.card_rates.map(r => `${r.amount > 0 ? "+" : ""}${r.amount} ${r.resource}`).join(", ")}`);
    if (d.card_costs?.length) lines.push(`Card costs: ${d.card_costs.map(c => `${c.amount} ${c.resource}`).join(", ")}`);
    if (d.card_effect) lines.push(`Card effect: ${d.card_effect}`);
    if (d.news_name) lines.push(`News: ${d.news_name}`);
    if (d.news_effects) lines.push(`Effects: ${d.news_effects}`);
    if (d.auction_result) lines.push(`Auction: ${d.auction_result}`);
    if (d.market_changes?.length) {
      for (const c of d.market_changes) {
        lines.push(`  ${c.resource}: +${c.units} units, $${c.price_before} → $${c.price_after}`);
      }
    }
    if (d.player_contributions?.length) {
      lines.push("Caused by:");
      for (const p of d.player_contributions) {
        const rates = Object.entries(p.rates).map(([r, v]) => `${v} ${r}`).join(", ");
        lines.push(`  ${p.name}: ${rates}`);
      }
    }
    if (d.pwr_adjust) lines.push(`PWR adjust: rate=${d.pwr_adjust.rate}, $${d.pwr_adjust.price_before} → $${d.pwr_adjust.price_after}`);
    if (d.sub_events) lines.push(`Sub-events: ${d.sub_events.join(", ")}`);
    // Action data
    if (d.type === "build") lines.push(`Built: ${(d.buildings || []).join(", ")}, cost: $${d.build_money_spent || 0}`);
    if (d.rates_gained) {
      const rg = Object.entries(d.rates_gained).filter(([,v]) => v !== 0).map(([r,v]) => `${v > 0 ? "+" : ""}${v} ${r}`).join(", ");
      if (rg) lines.push(`Rates gained: ${rg}`);
    }
    if (d.type === "sell") lines.push(`Sold: ${d.sell_amount || 0} ${d.sell_resource || ""} for $${d.sell_revenue || 0}`);
    if (d.type === "contract") lines.push(`Contract: ${d.contract_label || ""} reward $${d.contract_reward || 0}`);
    // AI actions list
    if (d.actions?.length) {
      lines.push("Actions:");
      for (const a of d.actions) {
        lines.push(`  ${a.detail || a.type}`);
        if (a.rates_gained) {
          const rg = Object.entries(a.rates_gained).filter(([,v]) => v !== 0).map(([r,v]) => `${v > 0 ? "+" : ""}${v} ${r}`).join(", ");
          if (rg) lines.push(`    rates: ${rg}`);
        }
        if (a.net_worth_after !== undefined) lines.push(`    NW after: $${a.net_worth_after}`);
      }
    }
    // Event lines from backend (auction bids, power bill per-player, debt details)
    if (d.event_lines?.length) {
      lines.push("Event lines:");
      for (const line of d.event_lines) {
        if (line.kind === "header") lines.push(`  [${line.text}]`);
        else if (line.kind === "player") lines.push(`  ${line.name || ""}: ${line.text}${line.net_worth_after !== undefined ? ` (NW: $${line.net_worth_after})` : ""}`);
        else lines.push(`  ${line.text || ""}`);
      }
    }
    if (d.player_snapshots?.length) {
      lines.push("Player snapshots:");
      for (const p of d.player_snapshots) {
        lines.push(`  ${p.name}: $${p.money}${p.debt > 0 ? ` debt:$${p.debt}` : ""} NW:$${p.net_worth}`);
      }
    }
    lines.push("");
  }

  // State snapshot
  const s = entry.state;
  if (s) {
    lines.push("=== STATE ===");
    lines.push(`Market: ${RESOURCE_ORDER.map(r => `${r}=$${s.market?.[r] || 0}`).join(" ")}`);
    if (s.market_positions) {
      lines.push(`Positions: ${RESOURCE_ORDER.map(r => `${r}:${s.market_positions[r] ?? "?"}`).join(" ")}`);
    }
    lines.push(`Deck: ${(s.event_deck_remaining || []).length} remaining`);
    lines.push(`Round: ${s.round || "?"} Turn: ${(s.turn_index || 0) + 1}`);
    lines.push("");
    for (const p of s.players || []) {
      const rates = RESOURCE_ORDER.map(r => {
        const v = p.rates?.[r] || 0;
        return v !== 0 ? `${v > 0 ? "+" : ""}${v}${r}` : null;
      }).filter(Boolean).join(" ");
      lines.push(`${p.name}: $${p.money}${p.debt > 0 ? ` debt:$${p.debt}` : ""}${p.credit > 0 ? ` credit:$${p.credit}` : ""} NW:$${p.net_worth} | contracts:${p.contracts_fulfilled || 0}`);
      lines.push(`  rates: ${rates || "none"}`);
      lines.push(`  buildings: ${(p.buildings_played || []).join(", ") || "none"}`);
      if (p.hand?.length) {
        lines.push(`  hand: ${p.hand.map(c => c.building).join(", ")}`);
      }
    }
    lines.push("");
    lines.push(`Pool: ${(s.pool || []).map(c => c.building).join(", ")}`);
    lines.push(`Contracts: ${(s.available_contracts || []).map(c => c.requirements?.map(r => `${r.amount}${r.resource}`).join("+") + "=$" + c.reward).join(" | ")}`);
  }
  stateView.textContent = lines.join("\n");
}

function enterReplay(step) {
  step = Math.max(0, Math.min(step, gameLog.length - 1));
  replayMode = true;
  replayStep = step;
  currentState = gameLog[step].state;
  currentLegal = null;
  renderGame();
  updateDebugPanel();
}

function exitReplay() {
  replayMode = false;
  replayStep = -1;
  hostRefreshState();
  updateDebugPanel();
}

// Wire debug panel buttons
document.getElementById("debug-close")?.addEventListener("click", toggleDebugPanel);
document.getElementById("debug-first")?.addEventListener("click", () => enterReplay(0));
document.getElementById("debug-prev")?.addEventListener("click", () => {
  if (replayMode) enterReplay(replayStep - 1);
  else enterReplay(gameLog.length - 2);
});
document.getElementById("debug-next")?.addEventListener("click", () => {
  if (replayMode && replayStep < gameLog.length - 1) enterReplay(replayStep + 1);
  else exitReplay();
});
document.getElementById("debug-last")?.addEventListener("click", () => exitReplay());
document.getElementById("debug-live")?.addEventListener("click", () => exitReplay());
document.getElementById("debug-slider")?.addEventListener("input", (e) => {
  enterReplay(parseInt(e.target.value));
});
document.getElementById("debug-download")?.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(gameLog, null, 2)], {type: "application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `game-log-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});
