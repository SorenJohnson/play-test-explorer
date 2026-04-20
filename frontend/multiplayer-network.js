// ===== PeerJS Networking: Host & Client Lobby + Transport =====
//
// Wrapped in an IIFE; public API on MP.network.
// Depends on: window.MP, PeerJS (loaded globally), and external globals
// declared in multiplayer.js / extracted later:
//   - MP.ui.renderGame, MP.ui.showPrompt, MP.core.showGameScreen, MP.ui.showEndgame (ui module — pending)
//   - MP.core.addFeedEntry (core module — pending)
//   - MP.core.handleRemoteAction, MP.core.handleRemoteEndTurn, MP.core.handleRemotePromptAnswer,
//     MP.core.handleRemotePatentAction, MP.core.handleRemotePoolSwap (core module — pending)
// These are resolved at call time (after all scripts have loaded) as bare
// globals for now; they'll become MP.core.* / MP.ui.* in later commits and
// this file will be updated to match.

(function () {
  const MP = window.MP = window.MP || {};

  // ===== Host: PeerJS Setup =====

  function initHost() {
    MP.peer = new Peer();
    MP.peer.on("open", (id) => {
      document.getElementById("room-code").textContent = id;
      // Default 3 seats: host + 1 remote + 1 AI
      MP.seatConfig = [
        {type: "human-local", name: "You (Host)", peerId: null},
        {type: "human-remote", name: "Player 2", peerId: null},
        {type: "optimal", name: "AI (Optimal)", peerId: null},
      ];
      MP.mySeat = 0;
      renderSeatGrid();
      updateStartButton();
    });
    MP.peer.on("connection", (conn) => {
      conn.on("open", () => {
        MP.connections[conn.peer] = conn;
        updateHostStatus();
        // Send current lobby state
        conn.send(JSON.stringify({type: "lobby_state", seats: MP.seatConfig.map(s => ({type: s.type, name: s.name, claimed: !!s.peerId || s.type === "human-local"}))}));
      });
      conn.on("data", (raw) => {
        const msg = JSON.parse(raw);
        handleHostMessage(conn, msg);
      });
      conn.on("close", () => {
        handleDisconnect(conn.peer);
      });
    });
    MP.peer.on("error", (err) => {
      document.getElementById("room-code").textContent = "Connection error";
      console.error("PeerJS error:", err);
    });
  }

  function renderSeatGrid() {
    const grid = document.getElementById("seat-grid");
    grid.innerHTML = MP.seatConfig.map((s, i) => {
      const isHost = i === 0;
      const claimed = s.peerId || isHost;
      return `
        <div class="seat-card ${claimed ? 'claimed' : ''}">
          <div class="seat-label">Seat ${i + 1}${isHost ? ' (You)' : ''}</div>
          ${isHost ? `<div style="color:var(--accent-green)">Host</div>` : `
            <select data-seat="${i}" class="seat-type-select" ${MP.game ? 'disabled' : ''}>
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
    if (!MP.game) {
      grid.innerHTML += `
        <div class="seat-card" style="display:flex;align-items:center;justify-content:center;gap:8px">
          ${MP.seatConfig.length < 4 ? `<button class="lobby-btn" id="btn-add-seat">+ Add Seat</button>` : ''}
          ${MP.seatConfig.length > 2 ? `<button class="lobby-btn" id="btn-remove-seat">- Remove</button>` : ''}
        </div>
      `;
      document.getElementById("btn-add-seat")?.addEventListener("click", () => {
        MP.seatConfig.push({type: "optimal", name: `AI ${MP.seatConfig.length + 1}`, peerId: null});
        renderSeatGrid();
        broadcastLobbyState();
        updateStartButton();
      });
      document.getElementById("btn-remove-seat")?.addEventListener("click", () => {
        MP.seatConfig.pop();
        renderSeatGrid();
        broadcastLobbyState();
        updateStartButton();
      });
    }

    // Wire seat type selects
    grid.querySelectorAll(".seat-type-select").forEach(sel => {
      sel.addEventListener("change", () => {
        const idx = parseInt(sel.dataset.seat);
        const oldType = MP.seatConfig[idx].type;
        MP.seatConfig[idx].type = sel.value;
        // Clear remote claim if switching away from human-remote
        if (oldType === "human-remote" && sel.value !== "human-remote") {
          MP.seatConfig[idx].peerId = null;
          MP.seatConfig[idx].name = sel.value === "empty" ? "Empty" : `AI ${idx + 1}`;
        }
        if (sel.value === "human-remote") {
          MP.seatConfig[idx].name = `Player ${idx + 1}`;
          MP.seatConfig[idx].peerId = null;
        }
        renderSeatGrid();
        broadcastLobbyState();
        updateStartButton();
      });
    });
  }

  function updateStartButton() {
    const unclaimedRemotes = MP.seatConfig.filter(s => s.type === "human-remote" && !s.peerId);
    const activeSeatCount = MP.seatConfig.filter(s => s.type !== "empty").length;
    const btn = document.getElementById("btn-start");
    btn.disabled = unclaimedRemotes.length > 0 || activeSeatCount < 2;
  }

  function updateHostStatus() {
    const n = Object.keys(MP.connections).length;
    document.getElementById("host-status").textContent = `${n} player${n !== 1 ? 's' : ''} connected`;
  }

  function broadcastLobbyState() {
    const msg = JSON.stringify({
      type: "lobby_state",
      seats: MP.seatConfig.map(s => ({type: s.type, name: s.name, claimed: !!s.peerId || s.type === "human-local"})),
    });
    Object.values(MP.connections).forEach(c => c.send(msg));
  }

  function handleHostMessage(conn, msg) {
    switch (msg.type) {
      case "claim_seat": {
        const idx = msg.seat_idx;
        if (idx >= 0 && idx < MP.seatConfig.length && MP.seatConfig[idx].type === "human-remote" && !MP.seatConfig[idx].peerId) {
          MP.seatConfig[idx].peerId = conn.peer;
          MP.seatConfig[idx].name = msg.name || conn.peer.substring(0, 8);
          MP.clientSeats[conn.peer] = idx;
          renderSeatGrid();
          broadcastLobbyState();
          updateStartButton();
          conn.send(JSON.stringify({type: "seat_claimed", seat_idx: idx}));
        }
        break;
      }
      case "action":
        if (MP.game) MP.core.handleRemoteAction(conn.peer, msg);
        break;
      case "end_turn":
        if (MP.game) MP.core.handleRemoteEndTurn(conn.peer);
        break;
      case "prompt_answer":
        if (MP.game) MP.core.handleRemotePromptAnswer(conn.peer, msg.answers);
        break;
      case "patent_action":
        if (MP.game) MP.core.handleRemotePatentAction(conn.peer, msg);
        break;
      case "pool_swap":
        if (MP.game) MP.core.handleRemotePoolSwap(conn.peer, msg);
        break;
      case "patent_office_pick":
        if (MP.game) MP.core.handlePatentOfficePick(conn.peer, msg.pick_idx);
        break;
      case "draft_pick":
        if (MP.game) MP.core.handleRemoteDraftPick(conn.peer, msg);
        break;
    }
  }

  function handleDisconnect(peerId) {
    delete MP.connections[peerId];
    const seatIdx = MP.clientSeats[peerId];
    if (seatIdx !== undefined) {
      const seatName = MP.seatConfig[seatIdx]?.name || `Seat ${seatIdx + 1}`;
      MP.seatConfig[seatIdx].peerId = null;
      delete MP.clientSeats[peerId];
      if (!MP.game) {
        renderSeatGrid();
        broadcastLobbyState();
        updateStartButton();
      } else {
        // Mid-game disconnect: surface it in the host's feed and console.
        // Full AI-takeover would require restructuring PlayableGame.human_indices
        // at runtime and isn't supported yet — if it becomes the disconnected
        // seat's turn, the game stalls until they reconnect.
        MP.disconnectedSeats.add(seatIdx);
        MP.core.addFeedEntry({kind: "round-marker", text: `\u26A0 ${seatName} disconnected`});
        console.warn(`[mp] Seat ${seatIdx} (${seatName}) disconnected mid-game. Game will stall on their turn until they rejoin.`);
      }
    }
    updateHostStatus();
  }

  // ===== Client: PeerJS Setup =====

  function initClient(roomCode) {
    MP.peer = new Peer();
    document.getElementById("join-status").textContent = "Connecting...";
    MP.peer.on("open", () => {
      MP.hostConn = MP.peer.connect(roomCode, {reliable: true});
      MP.hostConn.on("open", () => {
        document.getElementById("join-status").textContent = "Connected! Waiting for seat info...";
      });
      MP.hostConn.on("data", (raw) => {
        const msg = JSON.parse(raw);
        handleClientMessage(msg);
      });
      MP.hostConn.on("close", () => {
        document.getElementById("join-status").textContent = "Disconnected from host.";
      });
      MP.hostConn.on("error", (err) => {
        document.getElementById("join-status").textContent = `Error: ${err}`;
      });
    });
    MP.peer.on("error", (err) => {
      document.getElementById("join-status").textContent = `PeerJS error: ${err.type}`;
    });
  }

  function handleClientMessage(msg) {
    // Late-joiner guard: drop game-state messages until we've received a
    // game_start. Lobby-time messages (lobby_state, seat_claimed) and
    // game_start itself always pass through.
    const lobbyPhase = msg.type === "lobby_state" || msg.type === "seat_claimed" || msg.type === "game_start";
    if (!MP.gameStarted && !lobbyPhase) {
      console.warn(`[mp] Dropping ${msg.type} before game_start`);
      return;
    }
    switch (msg.type) {
      case "lobby_state":
        renderClientLobby(msg.seats);
        break;
      case "seat_claimed":
        MP.mySeat = msg.seat_idx;
        document.getElementById("join-status").textContent = `Seat ${MP.mySeat + 1} claimed. Waiting for host to start...`;
        break;
      case "game_start":
        MP.gameStarted = true;
        MP.mySeat = msg.your_seat;
        MP.core.showGameScreen();
        break;
      case "game_state":
        MP.currentState = msg.state;
        MP.currentLegal = msg.legal || null;
        MP.ui.renderGame();
        break;
      case "your_turn":
        MP.currentState = msg.state;
        MP.currentLegal = msg.legal;
        MP.ui.renderGame();
        break;
      case "waiting":
        MP.currentState = msg.state;
        MP.currentLegal = null;
        MP.ui.renderGame();
        break;
      case "prompt":
        MP.currentState = msg.state || MP.currentState;
        MP.ui.showPrompt(msg.prompt);
        break;
      case "feed":
        MP.core.addFeedEntry(msg.entry);
        // Event feed entries carry structured eventData; the banner label
        // comes from MP.ui.buildEventCardLabel. (The pre-split code here
        // called a non-existent `formatEventTitle` — a latent ReferenceError
        // that would crash any client receiving an event-kind feed entry.)
        if (msg.entry.kind === "event") {
          MP.anim.showEventBanner(MP.ui.buildEventCardLabel(msg.entry.eventData || {}));
        }
        break;
      case "game_over":
        MP.currentState = msg.state;
        MP.ui.showEndgame();
        break;
      case "action_result":
        // Host rejected the client's action — show the error. The state
        // refresh that follows will correct any optimistic animation.
        if (!msg.ok) {
          alert(msg.reason || "Action failed");
        }
        break;
    }
  }

  function renderClientLobby(seats) {
    document.getElementById("seat-claim").style.display = "block";
    const grid = document.getElementById("claim-grid");
    grid.innerHTML = seats.map((s, i) => {
      const canClaim = s.type === "human-remote" && !s.claimed && MP.mySeat < 0;
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
        MP.hostConn.send(JSON.stringify({type: "claim_seat", seat_idx: idx, name}));
      });
    });
  }

  // ===== Transport: host → client state/feed broadcasts =====

  function broadcastState() {
    if (!MP.currentState) return;
    for (const [peerId, seatIdx] of Object.entries(MP.clientSeats)) {
      const conn = MP.connections[peerId];
      if (!conn) continue;
      // Filter state for this seat
      const filteredState = MP.game.state_for_seat(seatIdx).toJs({dict_converter: Object.fromEntries});
      const isTheirTurn = MP.currentState.current_player_index === seatIdx;
      let legal = null;
      if (isTheirTurn && !MP.game.is_over()) {
        legal = MP.game.legal_human_actions().toJs({dict_converter: Object.fromEntries});
      }
      if (MP.game.is_over()) {
        conn.send(JSON.stringify({type: "game_over", state: filteredState}));
      } else if (isTheirTurn) {
        conn.send(JSON.stringify({type: "your_turn", state: filteredState, legal}));
      } else {
        conn.send(JSON.stringify({type: "waiting", state: filteredState, active_player: MP.currentState.players[MP.currentState.current_player_index]?.name || "?"}));
      }
    }
  }

  function broadcastFeed(entry) {
    entry.time = new Date().toLocaleTimeString();
    const msg = JSON.stringify({type: "feed", entry});
    Object.values(MP.connections).forEach(c => c.send(msg));
  }

  // Public API
  MP.network = {
    initHost,
    initClient,
    broadcastState,
    broadcastFeed,
  };
})();
