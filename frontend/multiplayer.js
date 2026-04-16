// ===== Multiplayer Game — coordinator =====
//
// Thin entry point: top-level constants, the window.MP state namespace, and
// the lobby button wiring. All real logic lives in the sibling modules:
//   - multiplayer-debug.js       (MP.debug)
//   - multiplayer-animations.js  (MP.anim)
//   - multiplayer-ui.js          (MP.ui)
//   - multiplayer-network.js     (MP.network)
//   - multiplayer-core.js        (MP.core)
//
// Load order in multiplayer.html places this coordinator LAST so every module
// it references has already registered its public surface on window.MP.

const RESOURCE_ORDER = ["PWR","H2O","FE","C","SI","O2","FOOD","GLS","ELX"];
const RESOURCE_COLORS = {
  PWR:"#e74c3c",H2O:"#2c3e80",FE:"#888888",C:"#8e44ad",
  SI:"#f1c40f",O2:"#ecf0f1",FOOD:"#27ae60",GLS:"#5dade2",ELX:"#e67e22"
};
const PLAYER_COLORS = ["#58a6ff","#f0883e","#3fb950","#d2a8ff"];

// ===== State (shared via window.MP namespace) =====
// All mutable cross-module state lives on window.MP so modules extracted from
// this file can share live references. Object.assign (not `= X || {...}`)
// because sibling modules load before this file and have already set
// `window.MP = {}`; we still want their public APIs (MP.debug, MP.anim, etc.)
// but we need to install the state defaults here regardless.
window.MP = window.MP || {};
Object.assign(window.MP, {
  // role/connection (network)
  role: null,         // "host" | "client"
  peer: null,         // PeerJS instance
  connections: {},    // {peerId: DataConnection} (host tracks all clients)
  hostConn: null,     // DataConnection to host (client only)
  mySeat: -1,         // this player's seat index
  // host-only
  pyodide: null,
  game: null,         // PlayableGame Python object
  seatConfig: [],     // [{type: "human-local"|"human-remote"|"optimal"|"smart"|"random", name: "", peerId: null}]
  clientSeats: {},    // {peerId: seatIdx} — which client claimed which seat
  // shared game state (received from host, or generated locally by host)
  currentState: null,
  currentLegal: null,
  selectedCards: new Set(),
  selectedContract: -1,
  pendingPoolSwap: -1,  // pool card index awaiting hand card click
  feedEntries: [],
  marketChart: null,
});
const MP = window.MP;

// ===== Lobby button wiring =====

document.getElementById("btn-create").addEventListener("click", () => {
  MP.role = "host";
  document.getElementById("lobby-choice").style.display = "none";
  document.getElementById("host-setup").style.display = "block";
  MP.network.initHost();
});

document.getElementById("btn-join").addEventListener("click", () => {
  MP.role = "client";
  document.getElementById("lobby-choice").style.display = "none";
  document.getElementById("join-setup").style.display = "block";
});

document.getElementById("btn-connect").addEventListener("click", () => {
  const code = document.getElementById("join-code").value.trim();
  if (!code) return;
  MP.network.initClient(code);
});

document.getElementById("btn-start").addEventListener("click", () => MP.core.startGame());
document.getElementById("prompt-submit").addEventListener("click", () => MP.core.submitPrompt());
document.getElementById("btn-new-game").addEventListener("click", () => location.reload());
document.getElementById("btn-review-game").addEventListener("click", () => {
  document.getElementById("endgame-overlay").style.display = "none";
});
