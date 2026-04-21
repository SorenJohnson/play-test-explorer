// Game Inspector — renders one game from its per-game detail JSON.
// URL: game.html?scenario=sim_3optimal&game=5
//
// Data source: frontend/data/games/<scenario>/<game_id>.json, produced by
// cmd_publish. Contains a flat action_log (mutation stream) plus
// players[].starting_rates for the initial state.
//
// The mutation stream has the shape:
//   { id, type, player, player_idx, summary, mutations: [{field, old, new}], metadata }
// Fields touched: "market.<R>", "player.<i>.money", "player.<i>.debt",
// "player.<i>.credit", "player.<i>.rates.<R>". Turns are delimited by
// entries whose type starts with "event:".

const RESOURCE_COLORS = {
  PWR: "#e74c3c", H2O: "#2c3e80", FE: "#555555", C: "#8e44ad",
  SI: "#f1c40f", O2: "#bdc3c7", FOOD: "#27ae60", GLS: "#5dade2", ELX: "#e67e22",
};
const PLAYER_COLORS = ["#3fb950", "#58a6ff", "#f85149", "#f0883e"];

let gameData = null;
let turns = [];  // turn-grouped view built from action_log

async function init() {
  const params = new URLSearchParams(window.location.search);
  const scenario = params.get("scenario");
  const gameId = parseInt(params.get("game") || "0", 10);

  if (!scenario) {
    document.getElementById("game-info").textContent =
      "No scenario. Use game.html?scenario=sim_3optimal&game=0";
    return;
  }

  const url = `data/games/${scenario}/${gameId}.json`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
    gameData = await resp.json();
  } catch (e) {
    document.getElementById("game-info").textContent =
      `Failed to load ${url}: ${e.message}`;
    return;
  }

  turns = buildTurns(gameData);
  renderHeader(scenario);
  renderNetWorthChart();
  renderMarketChart();
  renderRateCharts();
  renderTurnLog();
}

function renderHeader(scenario) {
  const ps = gameData.players;
  const summary = ps
    .map((p, i) => {
      const corp = p.corporation ? ` [${p.corporation}]` : "";
      return `P${i + 1} ${p.strategy}${corp}: $${p.net_worth}`;
    })
    .join(" · ");
  document.getElementById("game-title").textContent =
    `Game #${gameData.game_id + 1} — ${scenario.replace(/^sim_/, "").replace(/_/g, " + ")}`;
  document.getElementById("game-info").innerHTML =
    `${turns.length} player-turns<br>${summary}`;
}

// Walk the mutation stream, maintaining a live state tracker, and emit one
// entry per event:* record (= one player-turn). Redraw chains (event:* with
// no intervening player actions) are merged into the previous turn so the
// view matches how turns are actually experienced.
function buildTurns(data) {
  const numPlayers = data.players.length;
  const market = { ...(data.initial_market || {}) };
  // Fill in resources missing from initial_market (defensive).
  Object.keys(RESOURCE_COLORS).forEach((r) => {
    if (!(r in market)) market[r] = 0;
  });

  const players = data.players.map((p) => ({
    money: 0,
    debt: 0,
    credit: 0,
    contracts: 0,
    rates: { ...(p.starting_rates || {}) },
  }));
  // Normalize: every resource present so charts don't choke.
  Object.keys(RESOURCE_COLORS).forEach((r) => {
    players.forEach((p) => {
      if (!(r in p.rates)) p.rates[r] = 0;
    });
  });

  const applyMutation = (m) => {
    const f = m.field;
    const v = m.new;
    if (typeof v !== "number") return;
    let match = /^market\.(\w+)$/.exec(f);
    if (match) { market[match[1]] = v; return; }
    match = /^player\.(\d+)\.(.+)$/.exec(f);
    if (!match) return;
    const idx = parseInt(match[1], 10);
    const rest = match[2];
    if (idx < 0 || idx >= players.length) return;
    const p = players[idx];
    if (rest === "money") p.money = v;
    else if (rest === "debt") p.debt = v;
    else if (rest === "credit") p.credit = v;
    else {
      const rm = /^rates\.(\w+)$/.exec(rest);
      if (rm) p.rates[rm[1]] = v;
    }
  };

  const turnSnapshot = (playerIdx) => ({
    money: players[playerIdx].money,
    debt: players[playerIdx].debt,
    credit: players[playerIdx].credit,
    contracts: players[playerIdx].contracts,
    rates: { ...players[playerIdx].rates },
    market: { ...market },
  });
  // Snapshot every player's state so NW/market charts can plot all lines
  // at every turn — not just at each player's own turns. END_GAME's debt
  // settlement fires on the last turn-taker's record but changes everyone.
  const allPlayerStates = () => players.map((p) => ({
    money: p.money,
    debt: p.debt,
    credit: p.credit,
    contracts: p.contracts,
    rates: { ...p.rates },
  }));

  const out = [];
  let pending = [];
  let turnNum = 0;

  for (const entry of data.action_log || []) {
    // Apply this entry's mutations first so post-entry snapshots reflect its effect.
    for (const m of entry.mutations || []) applyMutation(m);

    if (entry.type === "setup") continue;
    if (entry.type === "contract" && entry.player_idx >= 0) {
      players[entry.player_idx].contracts += 1;
    }

    if (entry.type.startsWith("event:")) {
      const hasPlayerActions = pending.some(
        (e) => ["build", "sell", "contract", "swap"].includes(e.type)
             || e.type.startsWith("free:")
      );

      if (!hasPlayerActions && out.length) {
        // Redraw chain — merge into previous turn.
        const last = out[out.length - 1];
        last.event += " | " + entry.summary;
        const snap = turnSnapshot(last._player_idx);
        last.money_after = snap.money;
        last.debt = snap.debt;
        last.contracts = snap.contracts;
        last.market = snap.market;
        last.rates = snap.rates;
        last.player_states = allPlayerStates();
        pending = [];
        continue;
      }

      turnNum += 1;
      const pidx = (turnNum - 1) % numPlayers;
      const turnPlayer = data.players[pidx];

      // actions = every log entry that belongs to this player-turn, excluding
      // the terminating event. Includes free:* (teleportation, OC, etc.) and
      // swaps so the turn log shows the full sequence. Also captures the
      // acting player's money delta per entry so we can render a
      // per-source money flow ($X sell, -$Y build, etc.).
      const actions = [];
      const moneyField = `player.${pidx}.money`;
      const debtField = `player.${pidx}.debt`;
      const creditField = `player.${pidx}.credit`;
      let moneyBefore = null;

      const sumDelta = (muts, field) => {
        // Net change across mutations for `field` in this entry, using each
        // mutation's own old→new delta so chained mutations of the same
        // field inside one action don't cancel each other out.
        let d = 0;
        for (const m of muts || []) {
          if (m.field !== field) continue;
          const a = typeof m.old === "number" ? m.old : 0;
          const b = typeof m.new === "number" ? m.new : a;
          d += b - a;
        }
        return d;
      };

      for (const e of pending) {
        if (["setup", "market_roll", "corp_assigned"].includes(e.type)) continue;
        const meta = e.metadata || {};
        const moneyDelta = sumDelta(e.mutations, moneyField);
        const debtDelta = sumDelta(e.mutations, debtField);
        const creditDelta = sumDelta(e.mutations, creditField);
        // For sells, detect Hacker Array target mutations — any market.* move
        // on a resource OTHER than the sold one is a hacker array shift.
        let hackerNote = "";
        if (e.type === "sell") {
          const sold = (meta.sell_resource || "").toUpperCase();
          for (const m of e.mutations || []) {
            const mm = /^market\.(\w+)$/.exec(m.field);
            if (!mm || mm[1] === sold) continue;
            if (typeof m.old !== "number" || typeof m.new !== "number") continue;
            const delta = m.new - m.old;
            if (delta === 0) continue;
            hackerNote += ` · Hacker ${mm[1]} ${delta > 0 ? "+" : ""}${delta}`;
          }
        }
        actions.push({
          type: e.type,
          detail: e.summary + hackerNote,
          money_delta: moneyDelta,
          debt_delta: debtDelta,
          credit_delta: creditDelta,
          meta,
        });
        if (moneyBefore === null && e.player_idx === pidx) {
          for (const m of e.mutations || []) {
            if (m.field === moneyField) { moneyBefore = m.old; break; }
          }
        }
      }

      // Event's effect on the acting player's money/debt/credit.
      const eventMoneyDelta = sumDelta(entry.mutations, moneyField);
      const eventDebtDelta = sumDelta(entry.mutations, debtField);
      const eventCreditDelta = sumDelta(entry.mutations, creditField);

      if (moneyBefore === null) {
        for (const m of entry.mutations || []) {
          if (m.field === moneyField) { moneyBefore = m.old; break; }
        }
      }

      const snap = turnSnapshot(pidx);
      out.push({
        turn: turnNum,
        _player_idx: pidx,
        player: turnPlayer.strategy
          ? `P${pidx + 1} (${turnPlayer.strategy})`
          : `P${pidx + 1}`,
        actions,
        event: entry.summary,
        event_type: entry.type,
        event_money_delta: eventMoneyDelta,
        event_debt_delta: eventDebtDelta,
        event_credit_delta: eventCreditDelta,
        money_before: moneyBefore !== null ? moneyBefore : snap.money,
        money_after: snap.money,
        debt: snap.debt,
        credit: snap.credit,
        contracts: snap.contracts,
        market: snap.market,
        rates: snap.rates,
        player_states: allPlayerStates(),
      });
      pending = [];
    } else {
      pending.push(entry);
    }
  }

  return out;
}

function axisStyle(title) {
  return {
    title: { display: true, text: title, color: "#8b949e" },
    ticks: { color: "#8b949e" },
    grid: { color: "#21262d" },
  };
}

function renderNetWorthChart() {
  const datasets = [];
  const numPlayers = gameData.players.length;
  for (let i = 0; i < numPlayers; i++) {
    const color = PLAYER_COLORS[i % PLAYER_COLORS.length];
    const strategy = gameData.players[i]?.strategy || "?";
    // One point per turn for THIS player, using the all-players snapshot
    // captured at the end of each turn. That way END_GAME debt settlement
    // (which fires on the last turn-taker) shows up on every player's line.
    const series = turns
      .map((t) => {
        const ps = t.player_states && t.player_states[i];
        if (!ps) return null;
        return {
          x: t.turn,
          money: ps.money,
          debt: ps.debt || 0,
          contracts: ps.contracts || 0,
          credit: ps.credit || 0,
        };
      })
      .filter(Boolean);
    datasets.push({
      label: `P${i + 1} (${strategy}) — Money`,
      data: series.map((s) => ({ x: s.x, y: s.money })),
      borderColor: color, backgroundColor: "transparent",
      tension: 0.2, borderWidth: 2, pointRadius: 0,
    });
    datasets.push({
      label: `P${i + 1} — Debt`,
      data: series.map((s) => ({ x: s.x, y: -s.debt })),
      borderColor: color, backgroundColor: "transparent",
      tension: 0.2, borderWidth: 1, borderDash: [5, 5], pointRadius: 0,
    });
    datasets.push({
      label: `P${i + 1} — Net Worth`,
      data: series.map((s) => ({
        x: s.x,
        y: s.money - s.debt + s.credit,
      })),
      borderColor: color, backgroundColor: color + "22",
      tension: 0.2, borderWidth: 3, fill: true, pointRadius: 0,
    });
  }

  new Chart(document.getElementById("networth-chart"), {
    type: "line",
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: "#8b949e", font: { size: 10 } } } },
      scales: { x: { type: "linear", ...axisStyle("Turn") }, y: axisStyle("$") },
    },
  });
}

function renderMarketChart() {
  // One snapshot per calendar turn (first player-turn per turn number).
  const seen = new Set();
  const snapshots = [];
  for (const t of turns) {
    if (!seen.has(t.turn)) {
      seen.add(t.turn);
      snapshots.push(t);
    }
  }
  const resources = Object.keys(snapshots[0]?.market || RESOURCE_COLORS);
  const datasets = resources.map((r) => ({
    label: r,
    data: snapshots.map((s) => ({ x: s.turn, y: s.market[r] })),
    borderColor: RESOURCE_COLORS[r] || "#888",
    backgroundColor: "transparent",
    tension: 0.2, borderWidth: 2, pointRadius: 0,
  }));
  new Chart(document.getElementById("market-chart"), {
    type: "line",
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: "#8b949e", font: { size: 10 } } } },
      scales: { x: { type: "linear", ...axisStyle("Turn") }, y: axisStyle("Position") },
    },
  });
}

function renderRateCharts() {
  const container = document.getElementById("rate-charts");
  container.innerHTML = "";
  const numPlayers = gameData.players.length;
  for (let i = 0; i < numPlayers; i++) {
    const series = turns
      .map((t) => t.player_states && t.player_states[i]
        ? { x: t.turn, rates: t.player_states[i].rates }
        : null)
      .filter(Boolean);
    if (!series.length) continue;
    const div = document.createElement("div");
    div.className = "chart-container";
    div.style.marginBottom = "16px";
    div.style.minHeight = "240px";
    const canvas = document.createElement("canvas");
    div.appendChild(canvas);
    container.appendChild(div);

    const allResources = Object.keys(series[0].rates);
    const datasets = allResources
      .filter((r) => {
        const vals = series.map((s) => s.rates[r] || 0);
        return Math.max(...vals) !== Math.min(...vals);
      })
      .map((r) => ({
        label: r,
        data: series.map((s) => ({ x: s.x, y: s.rates[r] || 0 })),
        borderColor: RESOURCE_COLORS[r] || "#888",
        backgroundColor: "transparent",
        tension: 0.2, borderWidth: 2, pointRadius: 0,
      }));

    const strategy = gameData.players[i]?.strategy || "?";
    new Chart(canvas, {
      type: "line",
      data: { datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          title: {
            display: true,
            text: `P${i + 1} (${strategy}) — Rates`,
            color: "#c9d1d9", font: { size: 13 },
          },
          legend: { labels: { color: "#8b949e", font: { size: 10 } } },
        },
        scales: { x: { type: "linear", ...axisStyle("Turn") }, y: axisStyle("Rate") },
      },
    });
  }
}

function renderTurnLog() {
  const container = document.getElementById("turn-log");
  const numPlayers = gameData.players.length;
  const rounds = [];
  for (let i = 0; i < turns.length; i += numPlayers) {
    rounds.push(turns.slice(i, i + numPlayers));
  }

  let html = '<div class="table-scroll"><table><thead><tr><th>Round</th>';
  for (let p = 0; p < numPlayers; p++) {
    const player = gameData.players[p] || {};
    const strat = player.strategy || "?";
    const corp = player.corporation || "";
    const startRates = player.starting_rates || {};
    const startStr = Object.entries(startRates)
      .map(([r, v]) => `${v > 0 ? "+" : ""}${v}${r}`)
      .join(" ");
    const corpLine = corp
      ? `<div style="font-size:0.65rem; color:#8b949e; font-weight:normal">${corp}<br>${startStr}</div>`
      : "";
    html += `<th>P${p + 1} (${strat})${corpLine}</th>`;
  }
  html += "</tr></thead><tbody>";

  const signed = (n) => (n > 0 ? `+$${n}` : n < 0 ? `-$${Math.abs(n)}` : "$0");
  const colorFor = (type) => {
    if (type === "build") return "#58a6ff";
    if (type === "sell") return "#3fb950";
    if (type === "contract") return "#f0883e";
    if (type === "swap") return "#8b949e";
    if (type.startsWith("free:")) return "#d2a8ff";
    return "#c9d1d9";
  };

  rounds.forEach((round, r) => {
    html += `<tr><td style="vertical-align:top; font-weight:600; color:#58a6ff">${r + 1}</td>`;
    for (let p = 0; p < numPlayers; p++) {
      const turn = round[p];
      if (!turn) { html += "<td>-</td>"; continue; }
      let cellHtml = "";
      const gameplayActions = turn.actions.filter((a) => a.type !== "swap");
      if (!gameplayActions.length) cellHtml += '<div style="color:#484f58">Pass</div>';
      for (const a of turn.actions) {
        const color = colorFor(a.type);
        const hasDelta = a.money_delta || a.debt_delta || a.credit_delta;
        let deltaStr = "";
        if (hasDelta) {
          const parts = [];
          if (a.money_delta) parts.push(signed(a.money_delta));
          if (a.debt_delta) parts.push(`debt ${a.debt_delta > 0 ? "+" : ""}${a.debt_delta}`);
          if (a.credit_delta) parts.push(`credit ${a.credit_delta > 0 ? "+" : ""}${a.credit_delta}`);
          deltaStr = ` <span style="color:#484f58">(${parts.join(", ")})</span>`;
        }
        cellHtml += `<div style="color:${color}">${a.detail}${deltaStr}</div>`;
      }
      if (turn.event) {
        const parts = [];
        if (turn.event_money_delta) parts.push(signed(turn.event_money_delta));
        if (turn.event_debt_delta) parts.push(`debt ${turn.event_debt_delta > 0 ? "+" : ""}${turn.event_debt_delta}`);
        if (turn.event_credit_delta) parts.push(`credit ${turn.event_credit_delta > 0 ? "+" : ""}${turn.event_credit_delta}`);
        const eventDelta = parts.length
          ? ` <span style="color:#484f58">(${parts.join(", ")})</span>`
          : "";
        cellHtml += `<div style="color:#a371f7; font-size:0.7rem">⚡ ${turn.event}${eventDelta}</div>`;
      }
      const credit = turn.credit || 0;
      const nw = turn.money_after - (turn.debt || 0) + credit;
      cellHtml += `<div style="color:#8b949e; font-size:0.7rem">$${turn.money_before} → $${turn.money_after}`;
      if (turn.debt > 0) cellHtml += ` | <span style="color:#f85149">debt $${turn.debt}</span>`;
      if (credit > 0) cellHtml += ` | <span style="color:#3fb950">credit $${credit}</span>`;
      if (turn.contracts > 0) cellHtml += ` | <span style="color:#f0883e">${turn.contracts}×📋</span>`;
      cellHtml += ` | NW $${nw}</div>`;
      html += `<td style="vertical-align:top; font-size:0.75rem; line-height:1.6">${cellHtml}</td>`;
    }
    html += "</tr>";
  });

  html += "</tbody></table></div>";
  container.innerHTML = html;
}

init();
