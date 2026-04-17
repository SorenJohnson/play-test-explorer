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

// Palette is sourced from CSS custom properties defined in multiplayer.css
// (:root block). Keeping a single source of truth means a visual tweak
// lives in one place, not scattered across CSS + JS. Resolved at script
// load; the stylesheet is already attached because this script tag sits
// at the bottom of <body>.
//
// Modules that render inline-style HTML strings can reference `var(--name)`
// directly in the style attribute — browsers resolve those. Modules that
// pass colors to Chart.js or set element.style.X where a canvas/WebGL
// consumer won't resolve CSS vars use MP.cssVar("--name") to get the
// resolved hex value at call time.
const _cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const RESOURCE_COLORS = Object.fromEntries(
  RESOURCE_ORDER.map(r => [r, _cssVar(`--res-${r.toLowerCase()}`)])
);
const PLAYER_COLORS = [
  _cssVar("--accent-blue"),
  _cssVar("--accent-orange"),
  _cssVar("--accent-green"),
  _cssVar("--accent-purple"),
];

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
  gameStarted: false, // set true when game_start fires (host issues / client receives).
                      // Gates client-side game-state messages — late joiners silently drop
                      // game_state/your_turn/prompt until they see game_start.
  // host-only
  pyodide: null,
  game: null,         // PlayableGame Python object
  seatConfig: [],     // [{type: "human-local"|"human-remote"|"optimal"|"smart"|"random", name: "", peerId: null}]
  clientSeats: {},    // {peerId: seatIdx} — which client claimed which seat
  disconnectedSeats: new Set(),  // host-only: seats that dropped mid-game (for visibility)
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

// Exposed so sibling modules (whose IIFEs close over their own MP alias)
// can resolve CSS vars for Chart.js and element.style.X assignments,
// which don't resolve var() references themselves.
MP.cssVar = _cssVar;

// Pip text color: dark text on light resource backgrounds, white on dark.
// Used by sell pips, ruler dots, and rate tracker dots for consistency.
const _darkTextResources = new Set(["SI", "O2", "FOOD", "GLS", "PWR", "ELX"]);
MP.pipTextColor = (resource) => _darkTextResources.has(resource) ? "#000" : "#fff";

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

// Auto-start: ?autostart skips the lobby and launches a game with all AI
// opponents. Optionally ?autostart&theme=v2 also activates the new theme.
// Useful for quick testing and Playwright automation.
if (new URLSearchParams(location.search).has("autostart")) {
  const params = new URLSearchParams(location.search);
  const aiType = params.get("ai") || "smart";
  // Bypass the lobby UI entirely: init PeerJS, force all seats to AI,
  // call startGame directly. No button clicks, no DOM events.
  MP.role = "host";
  document.getElementById("lobby-choice").style.display = "none";
  document.getElementById("host-setup").style.display = "block";
  MP.network.initHost();
  const _waitAndStart = () => {
    // Wait for PeerJS to open (initHost sets seatConfig in the open callback)
    if (!MP.peer?.id || !MP.seatConfig?.length) {
      setTimeout(_waitAndStart, 200);
      return;
    }
    // Force all non-host seats to AI
    for (let i = 1; i < MP.seatConfig.length; i++) {
      MP.seatConfig[i] = {type: aiType, name: `AI ${i + 1}`, peerId: null};
    }
    MP.core.startGame();
  };
  _waitAndStart();
}
