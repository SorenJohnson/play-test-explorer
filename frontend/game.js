const RESOURCE_COLORS = {
  PWR: "#e74c3c", H2O: "#2c3e80", FE: "#555555", C: "#8e44ad",
  SI: "#f1c40f", O2: "#bdc3c7", FOOD: "#27ae60", GLS: "#5dade2", ELX: "#e67e22",
};

const PLAYER_COLORS = ["#3fb950", "#58a6ff", "#f85149", "#f0883e"];

let gameData = null;

async function init() {
  const params = new URLSearchParams(window.location.search);
  const file = params.get("file");
  const gameId = parseInt(params.get("game") || "0");

  if (!file) {
    document.getElementById("game-info").textContent = "No file specified. Use ?file=data/sim_xxx.json&game=0";
    return;
  }

  const resp = await fetch(file);
  const simData = await resp.json();
  gameData = simData.games[gameId];

  if (!gameData) {
    document.getElementById("game-info").textContent = `Game #${gameId} not found in ${file}`;
    return;
  }

  const strategies = gameData.players.map((p) => `${p.strategy}`).join(", ");
  const netWorths = gameData.players.map((p) => `$${p.net_worth}`).join(", ");
  const turnsPerPlayer = Math.floor(gameData.turn_count / gameData.players.length);
  document.getElementById("game-info").textContent =
    `Game #${gameId + 1} | Players: ${strategies} | Final net worth: ${netWorths} | ${turnsPerPlayer} turns/player`;

  renderNetWorthChart();
  renderMarketChart();
  renderRateCharts();
  renderTurnLog();
}

function getPlayerTurns() {
  // Group turns by player, in order
  const players = {};
  for (const turn of gameData.action_history) {
    if (!players[turn.player]) players[turn.player] = [];
    players[turn.player].push(turn);
  }
  return players;
}

function renderNetWorthChart() {
  const playerTurns = getPlayerTurns();
  const datasets = [];

  let playerIdx = 0;
  for (const [player, turns] of Object.entries(playerTurns)) {
    const strategy = gameData.players[playerIdx]?.strategy || "unknown";
    const color = PLAYER_COLORS[playerIdx % PLAYER_COLORS.length];

    // Money (solid line)
    datasets.push({
      label: `${player} (${strategy}) — Money`,
      data: turns.map((t) => ({ x: t.turn, y: t.money_after })),
      borderColor: color,
      backgroundColor: "transparent",
      tension: 0.2,
      borderWidth: 2,
    });

    // Debt (dashed line)
    datasets.push({
      label: `${player} — Debt`,
      data: turns.map((t) => ({ x: t.turn, y: -(t.debt || 0) })),
      borderColor: color,
      backgroundColor: "transparent",
      tension: 0.2,
      borderWidth: 1,
      borderDash: [5, 5],
    });

    // Net worth (thick line with fill)
    datasets.push({
      label: `${player} — Net Worth`,
      data: turns.map((t) => ({
        x: t.turn,
        y: t.money_after - (t.debt || 0) + (t.contracts || 0) * 50,
      })),
      borderColor: color,
      backgroundColor: color + "22",
      tension: 0.2,
      borderWidth: 3,
      fill: true,
    });

    playerIdx++;
  }

  new Chart(document.getElementById("networth-chart"), {
    type: "line",
    data: { datasets },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: "#8b949e", font: { size: 10 } } } },
      scales: {
        x: {
          type: "linear",
          title: { display: true, text: "Turn", color: "#8b949e" },
          ticks: { color: "#8b949e", stepSize: 3 },
          grid: { color: "#21262d" },
        },
        y: {
          title: { display: true, text: "$", color: "#8b949e" },
          ticks: { color: "#8b949e" },
          grid: { color: "#21262d" },
        },
      },
    },
  });
}

function renderMarketChart() {
  const history = gameData.action_history;
  // Take one snapshot per game turn (first player's turn)
  const seenTurns = new Set();
  const snapshots = [];
  for (const t of history) {
    if (!seenTurns.has(t.turn)) {
      seenTurns.add(t.turn);
      snapshots.push(t);
    }
  }

  const resources = Object.keys(snapshots[0].market);
  const datasets = resources.map((r) => ({
    label: r,
    data: snapshots.map((s) => ({ x: s.turn, y: s.market[r] })),
    borderColor: RESOURCE_COLORS[r] || "#888",
    backgroundColor: "transparent",
    tension: 0.2,
    borderWidth: 2,
    pointRadius: 0,
  }));

  new Chart(document.getElementById("market-chart"), {
    type: "line",
    data: { datasets },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: "#8b949e", font: { size: 10 } } } },
      scales: {
        x: {
          type: "linear",
          title: { display: true, text: "Turn", color: "#8b949e" },
          ticks: { color: "#8b949e", stepSize: 3 },
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

function renderRateCharts() {
  const container = document.getElementById("rate-charts");
  const playerTurns = getPlayerTurns();

  let playerIdx = 0;
  for (const [player, turns] of Object.entries(playerTurns)) {
    const strategy = gameData.players[playerIdx]?.strategy || "unknown";

    const div = document.createElement("div");
    div.className = "chart-container";
    div.style.marginBottom = "16px";
    div.style.minHeight = "250px";
    const canvas = document.createElement("canvas");
    div.appendChild(canvas);
    container.appendChild(div);

    const resources = Object.keys(turns[0].rates);
    const datasets = resources
      .filter((r) => {
        // Only show resources that change
        const vals = turns.map((t) => t.rates[r] || 0);
        return Math.max(...vals) !== Math.min(...vals);
      })
      .map((r) => ({
        label: r,
        data: turns.map((t) => ({ x: t.turn, y: t.rates[r] || 0 })),
        borderColor: RESOURCE_COLORS[r] || "#888",
        backgroundColor: "transparent",
        tension: 0.2,
        borderWidth: 2,
        pointRadius: 0,
      }));

    new Chart(canvas, {
      type: "line",
      data: { datasets },
      options: {
        responsive: true,
        plugins: {
          title: { display: true, text: `${player} (${strategy}) — Rates`, color: "#c9d1d9", font: { size: 13 } },
          legend: { labels: { color: "#8b949e", font: { size: 10 } } },
        },
        scales: {
          x: {
            type: "linear",
            title: { display: true, text: "Turn", color: "#8b949e" },
            ticks: { color: "#8b949e", stepSize: 3 },
            grid: { color: "#21262d" },
          },
          y: {
            title: { display: true, text: "Rate", color: "#8b949e" },
            ticks: { color: "#8b949e" },
            grid: { color: "#21262d" },
          },
        },
      },
    });
    playerIdx++;
  }
}

function renderTurnLog() {
  const container = document.getElementById("turn-log");
  const history = gameData.action_history;

  // Group by game round (each round = one turn per player)
  const numPlayers = gameData.players.length;
  const rounds = [];
  for (let i = 0; i < history.length; i += numPlayers) {
    rounds.push(history.slice(i, i + numPlayers));
  }

  let html = '<div class="table-scroll"><table><thead><tr><th>Round</th>';
  for (let p = 0; p < numPlayers; p++) {
    const strat = gameData.players[p]?.strategy || "?";
    html += `<th>Player ${p + 1} (${strat})</th>`;
  }
  html += "</tr></thead><tbody>";

  for (let r = 0; r < rounds.length; r++) {
    const round = rounds[r];
    html += `<tr><td style="vertical-align:top; font-weight:600; color:#58a6ff">${r + 1}</td>`;
    for (let p = 0; p < numPlayers; p++) {
      const turn = round[p];
      if (!turn) {
        html += "<td>-</td>";
        continue;
      }

      let cellHtml = "";

      // Actions
      for (const action of turn.actions) {
        const cls = action.type === "build" ? "build" : action.type === "sell" ? "sell" : "contract";
        cellHtml += `<div class="action-log ${cls}">${action.detail}</div>`;
      }
      if (turn.actions.length === 0) {
        cellHtml += '<div style="color:#484f58">Pass</div>';
      }

      // Event
      if (turn.event && turn.event !== "no event") {
        cellHtml += `<div style="color:#a371f7; font-size:0.7rem">⚡ ${turn.event}</div>`;
      }

      // Money & Debt
      const debt = turn.debt || 0;
      const contracts = turn.contracts || 0;
      const nw = turn.money_after - debt + contracts * 50;
      cellHtml += `<div style="color:#8b949e; font-size:0.7rem">$${turn.money_before} → $${turn.money_after}`;
      if (debt > 0) cellHtml += ` | <span style="color:#f85149">debt: $${debt}</span>`;
      if (contracts > 0) cellHtml += ` | <span style="color:#f0883e">${contracts}×📋</span>`;
      cellHtml += ` | NW: $${nw}</div>`;

      html += `<td style="vertical-align:top; font-size:0.75rem; line-height:1.6">${cellHtml}</td>`;
    }
    html += "</tr>";
  }

  html += "</tbody></table></div>";
  container.innerHTML = html;
}

init();
