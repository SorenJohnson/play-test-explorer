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
  renderEndGameBreakdown();
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
  // Snapshot of all players + market at the moment the NEXT turn begins.
  // Updated each time a turn closes so every turn record can show its own
  // "before" state without needing to replay mutations in reverse.
  let nextTurnStart = allPlayerStates();
  let nextTurnMarket = { ...market };

  for (const entry of data.action_log || []) {
    // For terminal events (END_GAME / END_ROUND), snapshot pre-event state
    // BEFORE applying mutations so the End-Game Scoring breakdown can show
    // each player's starting rates / market prices / money at the moment
    // scoring began.
    let preState = null;
    let preMarket = null;
    const isTerminal = entry.type === "event:end_game" || entry.type === "event:end_round";
    if (isTerminal) {
      preState = allPlayerStates();
      preMarket = { ...market };
    }
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
      // Per-player breakdown — power bill / futures settlement / debt
      // collection / news rate_all all fire on one player's turn but mutate
      // every player. Computing delta per player lets the turn log show
      // "⚡ POWER BILL — P1 +$3, P2 -$4 debt, P3 -$0".
      const eventPlayerDeltas = [];
      for (let pi = 0; pi < numPlayers; pi++) {
        eventPlayerDeltas.push({
          money: sumDelta(entry.mutations, `player.${pi}.money`),
          debt: sumDelta(entry.mutations, `player.${pi}.debt`),
          credit: sumDelta(entry.mutations, `player.${pi}.credit`),
        });
      }

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
        event_metadata: entry.metadata || {},
        event_money_delta: eventMoneyDelta,
        event_debt_delta: eventDebtDelta,
        event_credit_delta: eventCreditDelta,
        event_player_deltas: eventPlayerDeltas,
        event_pre_state: preState,
        event_pre_market: preMarket,
        // State at the start of the turn (before any actions). Used by the
        // expandable turn log to show the "before" side of the waterfall.
        turn_start_state: nextTurnStart,
        turn_start_market: nextTurnMarket,
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
      // Capture the state at the close of this turn as the NEXT turn's
      // starting state. Done after pushing so the next iteration's pending
      // entries begin from a fresh baseline.
      nextTurnStart = allPlayerStates();
      nextTurnMarket = { ...market };
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
    const series = turns
      .map((t) => {
        const ps = t.player_states && t.player_states[i];
        if (!ps) return null;
        return {
          x: t.turn,
          y: (ps.money || 0) - (ps.debt || 0) + (ps.credit || 0),
        };
      })
      .filter(Boolean);
    datasets.push({
      label: `P${i + 1} (${strategy})`,
      data: series,
      borderColor: color,
      backgroundColor: color + "22",
      tension: 0.2, borderWidth: 3, pointRadius: 0, fill: false,
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

// Translate the current market POSITION (what the engine mutates) into a
// dollar price using the same tiered track used in simulation.py. Kept in
// sync with PRICE_TRACK there; if that constant drifts, update this too.
const PRICE_TRACK = [1, 1, 1, 2, 2, 2, 3, 3, 4, 4, 5, 5, 6, 7, 8, 9, 10];
function positionToPrice(pos) {
  const clamped = Math.max(0, Math.min(pos, PRICE_TRACK.length - 1));
  return PRICE_TRACK[clamped];
}

function renderEndGameBreakdown() {
  const container = document.getElementById("end-game-breakdown");
  if (!container) return;

  // Look at every terminal turn (END_GAME and the END_ROUND one in a 2-round
  // game) so the user can see both power-bill/futures settlements.
  const terminals = turns.filter(
    (t) => (t.event_type === "event:end_game" || t.event_type === "event:end_round")
         && t.event_pre_state
  );
  if (!terminals.length) {
    container.innerHTML = '<p class="subtitle">No terminal events found in this game.</p>';
    return;
  }

  const numPlayers = gameData.players.length;
  const signed = (n) => (n > 0 ? `+$${n}` : n < 0 ? `-$${Math.abs(n)}` : "$0");

  const sections = terminals.map((t) => {
    const meta = t.event_metadata || {};
    const preState = t.event_pre_state;
    const preMarket = t.event_pre_market || {};
    const postState = t.player_states;
    const perPlayerMeta = Array.isArray(meta.per_player) ? meta.per_player : [];
    const pwrPrice = meta.pwr_price !== undefined
      ? meta.pwr_price
      : (preMarket.PWR !== undefined ? positionToPrice(preMarket.PWR) : null);

    const rows = [];
    for (let i = 0; i < numPlayers; i++) {
      const player = gameData.players[i] || {};
      const color = PLAYER_COLORS[i % PLAYER_COLORS.length];
      const pre = preState[i] || {};
      const post = (postState && postState[i]) || {};
      const preRates = pre.rates || {};
      const pmeta = perPlayerMeta[i] || {};

      // Power bill: PWR rate × pwr_price (metadata.per_player confirms).
      const pwrRate = preRates.PWR || 0;
      const pwrShielded = !!pmeta.shielded;
      const pwrEarning = pmeta.earning;
      const pwrDebt = pmeta.debt;
      const domeBonus = pmeta.dome_bonus || 0;

      // Futures settlements: each negative non-PWR rate × current market price.
      const futuresLines = [];
      let futuresDebt = 0;
      for (const [r, rate] of Object.entries(preRates)) {
        if (r === "PWR") continue;
        if ((rate || 0) >= 0) continue;
        const units = Math.abs(rate);
        const pos = preMarket[r];
        const price = pos !== undefined ? positionToPrice(pos) : null;
        const cost = price !== null ? units * price : null;
        futuresLines.push(
          `${units} ${r} @ ${price !== null ? `$${price}` : "?"} = ${cost !== null ? `$${cost}` : "?"}`
        );
        if (cost !== null) futuresDebt += cost;
      }

      const preNw = (pre.money || 0) - (pre.debt || 0) + (pre.credit || 0);
      const postNw = (post.money || 0) - (post.debt || 0) + (post.credit || 0);
      const nwDelta = postNw - preNw;

      const pwrLine = pwrShielded
        ? `Energy Vault shielded (${pwrRate > 0 ? "+" : ""}${pwrRate} PWR)`
        : pwrRate > 0
          ? `+$${pwrEarning !== undefined ? pwrEarning : pwrRate * (pwrPrice || 0)} (sold ${pwrRate} PWR @ $${pwrPrice || "?"})`
          : pwrRate < 0
            ? `-$${pwrDebt !== undefined ? pwrDebt : Math.abs(pwrRate) * (pwrPrice || 0)} debt (bought ${Math.abs(pwrRate)} PWR @ $${pwrPrice || "?"})`
            : "no change (0 PWR)";

      rows.push(`
        <tr>
          <td><span style="color:${color}; font-weight:600">P${i + 1}</span><br>
              <span style="color:#8b949e; font-size:0.7rem">${player.strategy || "?"}${player.corporation ? ` · ${player.corporation}` : ""}</span></td>
          <td style="font-size:0.72rem">money $${pre.money || 0} · debt $${pre.debt || 0} · credit $${pre.credit || 0}<br>
              <span style="color:#8b949e">NW $${preNw}</span></td>
          <td style="font-size:0.72rem">${
            Object.entries(preRates)
              .filter(([, v]) => v)
              .map(([k, v]) => `<span style="color:${v > 0 ? "#3fb950" : "#f85149"}">${v > 0 ? "+" : ""}${v} ${k}</span>`)
              .join(" ") || "<span style=\"color:#484f58\">no rates</span>"
          }</td>
          <td style="font-size:0.72rem">${pwrLine}${domeBonus ? `<br><span style=\"color:#a371f7\">+$${domeBonus} Pleasure Dome bonus</span>` : ""}</td>
          <td style="font-size:0.72rem">${futuresLines.length ? futuresLines.join("<br>") + `<br><span style=\"color:#8b949e\">total: $${futuresDebt} debt</span>` : "<span style=\"color:#484f58\">no negative rates</span>"}</td>
          <td style="font-size:0.72rem">money $${post.money || 0} · debt $${post.debt || 0} · credit $${post.credit || 0}<br>
              <span style="color:${nwDelta >= 0 ? "#3fb950" : "#f85149"}">NW $${postNw} (${signed(nwDelta)})</span></td>
        </tr>
      `);
    }

    const header = t.event_type === "event:end_game" ? "END GAME" : `END OF ROUND ${t.turn}`;
    const pwrStr = pwrPrice !== null ? `PWR @ $${pwrPrice}` : "";
    return `
      <h3 style="color:#58a6ff; margin-top:16px">${header} <span style="color:#8b949e; font-weight:normal; font-size:0.8rem">${pwrStr} · turn ${t.turn}</span></h3>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Player</th>
              <th>Pre-event $ / debt / credit / NW</th>
              <th>Rates at scoring</th>
              <th>Power Bill</th>
              <th>Futures Settlement</th>
              <th>Post $ / debt / credit / NW (Δ)</th>
            </tr>
          </thead>
          <tbody>${rows.join("")}</tbody>
        </table>
      </div>
    `;
  });

  container.innerHTML = sections.join("");
}

function renderTurnLog() {
  const container = document.getElementById("turn-log");
  const numPlayers = gameData.players.length;
  const signed = (n) => (n > 0 ? `+$${n}` : n < 0 ? `-$${Math.abs(n)}` : "$0");
  const colorFor = (type) => {
    if (type === "build") return "#58a6ff";
    if (type === "sell") return "#3fb950";
    if (type === "contract") return "#f0883e";
    if (type === "swap") return "#8b949e";
    if (type.startsWith("free:")) return "#d2a8ff";
    return "#c9d1d9";
  };
  const ratesSpan = (rates) => Object.entries(rates || {})
    .filter(([, v]) => v)
    .map(([k, v]) => `<span style="color:${v > 0 ? "#3fb950" : "#f85149"}">${v > 0 ? "+" : ""}${v} ${k}</span>`)
    .join(" ") || '<span style="color:#484f58">—</span>';
  const nwOf = (s) => (s ? (s.money || 0) - (s.debt || 0) + (s.credit || 0) : 0);
  const fmtState = (s) => s
    ? `$${s.money || 0} · debt $${s.debt || 0} · credit $${s.credit || 0} · NW $${nwOf(s)}`
    : "—";

  const controls = `
    <div style="display:flex; gap:8px; margin-bottom:8px; font-size:0.75rem;">
      <button id="tl-expand-all" style="background:#21262d; border:1px solid #30363d; color:#c9d1d9; padding:4px 10px; border-radius:4px; cursor:pointer;">Expand all</button>
      <button id="tl-collapse-all" style="background:#21262d; border:1px solid #30363d; color:#c9d1d9; padding:4px 10px; border-radius:4px; cursor:pointer;">Collapse all</button>
    </div>`;

  const turnBlocks = turns.map((turn) => {
    const pidx = turn._player_idx;
    const color = PLAYER_COLORS[pidx % PLAYER_COLORS.length];
    const player = gameData.players[pidx] || {};
    const preActing = (turn.turn_start_state && turn.turn_start_state[pidx]) || {};
    const postActing = (turn.player_states && turn.player_states[pidx]) || {};
    const round = Math.floor((turn.turn - 1) / numPlayers) + 1;
    const nwPre = nwOf(preActing);
    const nwPost = nwOf(postActing);
    const nwDelta = nwPost - nwPre;
    const deltaColor = nwDelta > 0 ? "#3fb950" : nwDelta < 0 ? "#f85149" : "#8b949e";

    // One-line summary shown in the <summary> header while collapsed.
    const gameplayCount = turn.actions.filter((a) => !["swap"].includes(a.type)).length;
    const actionsTeaser = gameplayCount
      ? turn.actions
          .filter((a) => a.type !== "swap")
          .map((a) => a.detail.replace(/\s*\([^)]+\)\s*$/, ""))
          .slice(0, 2)
          .join(" · ")
      : "Pass";
    const eventTeaser = turn.event
      ? ` <span style="color:#a371f7">⚡ ${turn.event.split(" | ")[0]}</span>`
      : "";

    const summaryHtml = `
      <summary style="cursor:pointer; padding:8px 12px; background:#161b22; border-left:3px solid ${color}; font-size:0.82rem; line-height:1.5;">
        <span style="color:${color}; font-weight:600;">Turn ${turn.turn} · Round ${round} · P${pidx + 1} (${player.strategy || "?"})</span>
        <span style="color:#8b949e; margin-left:8px;">${actionsTeaser}</span>
        ${eventTeaser}
        <span style="color:${deltaColor}; margin-left:8px;">NW ${nwPre} → ${nwPost} (${signed(nwDelta)})</span>
      </summary>`;

    // Pre-turn state (all players).
    const preRows = (turn.turn_start_state || []).map((s, i) => {
      const c = PLAYER_COLORS[i % PLAYER_COLORS.length];
      const p = gameData.players[i] || {};
      return `<tr>
        <td style="color:${c}; font-weight:600">P${i + 1} (${p.strategy || "?"})</td>
        <td>${fmtState(s)}</td>
        <td>${ratesSpan(s && s.rates)}</td>
      </tr>`;
    }).join("");

    // Market snapshot at start of turn.
    const marketEntries = Object.entries(turn.turn_start_market || {}).filter(([k]) => k !== "PWR");
    const marketLine = marketEntries
      .map(([r, pos]) => `${r}: $${positionToPrice(pos)}`)
      .join(" · ");

    // Action list with per-action deltas.
    const actionRows = turn.actions.length
      ? turn.actions.map((a) => {
          const cl = colorFor(a.type);
          const deltaBits = [];
          if (a.money_delta) deltaBits.push(signed(a.money_delta));
          if (a.debt_delta) deltaBits.push(`debt ${a.debt_delta > 0 ? "+" : ""}${a.debt_delta}`);
          if (a.credit_delta) deltaBits.push(`credit ${a.credit_delta > 0 ? "+" : ""}${a.credit_delta}`);
          const deltaStr = deltaBits.length ? ` <span style="color:#484f58">(${deltaBits.join(", ")})</span>` : "";
          return `<li style="color:${cl}">${a.type}: ${a.detail}${deltaStr}</li>`;
        }).join("")
      : '<li style="color:#484f58">Pass — no actions</li>';

    // Event block with per-player impact.
    const eventPerPlayer = (turn.event_player_deltas || []).map((d, i) => {
      const bits = [];
      if (d.money) bits.push(signed(d.money));
      if (d.debt) bits.push(`debt ${d.debt > 0 ? "+" : ""}${d.debt}`);
      if (d.credit) bits.push(`credit ${d.credit > 0 ? "+" : ""}${d.credit}`);
      if (!bits.length) return null;
      const c = PLAYER_COLORS[i % PLAYER_COLORS.length];
      return `<li><span style="color:${c}">P${i + 1}:</span> ${bits.join(" · ")}</li>`;
    }).filter(Boolean).join("");
    const eventHtml = turn.event
      ? `<div style="margin-top:8px;">
           <div style="color:#a371f7">⚡ ${turn.event}</div>
           ${eventPerPlayer ? `<ul style="margin:4px 0 0 16px; padding:0; list-style:disc; color:#c9d1d9">${eventPerPlayer}</ul>` : ""}
         </div>`
      : "";

    // Post-turn state (all players).
    const postRows = (turn.player_states || []).map((s, i) => {
      const c = PLAYER_COLORS[i % PLAYER_COLORS.length];
      const p = gameData.players[i] || {};
      return `<tr>
        <td style="color:${c}; font-weight:600">P${i + 1} (${p.strategy || "?"})</td>
        <td>${fmtState(s)}</td>
        <td>${ratesSpan(s && s.rates)}</td>
      </tr>`;
    }).join("");

    const bodyHtml = `
      <div style="padding:12px 16px; background:#0d1117; border-left:3px solid ${color}; font-size:0.78rem; line-height:1.6;">
        <div style="color:#8b949e; margin-bottom:8px;">Market at start: ${marketLine || "—"}</div>

        <h4 style="color:#58a6ff; margin:8px 0 4px; font-size:0.8rem;">Pre-turn state</h4>
        <table style="width:100%; font-size:0.72rem;"><tbody>${preRows}</tbody></table>

        <h4 style="color:#58a6ff; margin:12px 0 4px; font-size:0.8rem;">Actions by P${pidx + 1}</h4>
        <ul style="margin:4px 0 0 16px; padding:0; list-style:disc;">${actionRows}</ul>

        ${eventHtml}

        <h4 style="color:#58a6ff; margin:12px 0 4px; font-size:0.8rem;">Post-turn state</h4>
        <table style="width:100%; font-size:0.72rem;"><tbody>${postRows}</tbody></table>
      </div>`;

    return `<details style="margin-bottom:4px; border-radius:4px; overflow:hidden;">${summaryHtml}${bodyHtml}</details>`;
  }).join("");

  container.innerHTML = controls + turnBlocks;

  const expandBtn = document.getElementById("tl-expand-all");
  const collapseBtn = document.getElementById("tl-collapse-all");
  if (expandBtn) expandBtn.addEventListener("click", () => {
    container.querySelectorAll("details").forEach((d) => { d.open = true; });
  });
  if (collapseBtn) collapseBtn.addEventListener("click", () => {
    container.querySelectorAll("details").forEach((d) => { d.open = false; });
  });
}

init();
