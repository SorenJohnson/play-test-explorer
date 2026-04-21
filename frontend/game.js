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
let turns = [];   // turn-grouped view (one per player-turn) used by charts
let blocks = []; // interleaved turn + event blocks used by the replay UI

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

  const built = buildTurns(gameData);
  turns = built.turns;
  blocks = built.blocks;
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

  const turnsOut = [];      // one per player-turn (charts)
  const blocksOut = [];     // interleaved turn + event blocks (replay)
  let pending = [];
  let turnNum = 0;
  let eventNum = 0;
  let turnStartState = allPlayerStates();
  let turnStartMarket = { ...market };

  const sumDelta = (muts, field) => {
    let d = 0;
    for (const m of muts || []) {
      if (m.field !== field) continue;
      const a = typeof m.old === "number" ? m.old : 0;
      const b = typeof m.new === "number" ? m.new : a;
      d += b - a;
    }
    return d;
  };

  const perPlayerDeltas = (muts) => {
    const out = [];
    for (let pi = 0; pi < numPlayers; pi++) {
      out.push({
        money: sumDelta(muts, `player.${pi}.money`),
        debt: sumDelta(muts, `player.${pi}.debt`),
        credit: sumDelta(muts, `player.${pi}.credit`),
      });
    }
    return out;
  };

  for (const entry of data.action_log || []) {
    // Snapshot state BEFORE applying this entry's mutations so each block
    // can show an accurate "pre" side of its own waterfall.
    const preState = allPlayerStates();
    const preMarket = { ...market };

    for (const m of entry.mutations || []) applyMutation(m);
    if (entry.type === "contract" && entry.player_idx >= 0) {
      players[entry.player_idx].contracts += 1;
    }

    if (["setup", "market_roll", "corp_assigned"].includes(entry.type)) continue;

    if (entry.type.startsWith("event:")) {
      const hasPlayerActions = pending.some(
        (e) => ["build", "sell", "contract", "swap"].includes(e.type)
             || e.type.startsWith("free:")
      );

      // If there were player actions buffered since the last event, close
      // out a Turn block now — the player's actions are done and the event
      // is about to fire.
      if (hasPlayerActions) {
        turnNum += 1;
        const actor = pending.find((e) => e.player_idx >= 0);
        const pidx = actor ? actor.player_idx : (turnNum - 1) % numPlayers;
        const moneyField = `player.${pidx}.money`;
        const debtField = `player.${pidx}.debt`;
        const creditField = `player.${pidx}.credit`;

        const actions = [];
        for (const e of pending) {
          const meta = e.metadata || {};
          const moneyDelta = sumDelta(e.mutations, moneyField);
          const debtDelta = sumDelta(e.mutations, debtField);
          const creditDelta = sumDelta(e.mutations, creditField);
          // Hacker Array: any market.* change on a resource other than the
          // one being sold indicates the HA pushed a target price.
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
        }

        // pre-event state = what just came in preState (before THIS event
        // entry fired). turnStartState = snapshot taken when the previous
        // turn closed, so it's the true "start" of this turn.
        blocksOut.push({
          kind: "turn",
          turn_num: turnNum,
          player_idx: pidx,
          actions,
          pre_state: turnStartState,
          pre_market: turnStartMarket,
          post_state: preState,
          post_market: preMarket,
        });

        // Start a chart record for this player-turn. Its player_states /
        // market will be updated each time an event fires within this turn.
        turnsOut.push({
          turn: turnNum,
          _player_idx: pidx,
          player_states: null,
          market: null,
        });

        pending = [];
      }

      eventNum += 1;
      const postState = allPlayerStates();
      const postMarket = { ...market };

      blocksOut.push({
        kind: "event",
        event_num: eventNum,
        turn_num: turnNum,
        type: entry.type,
        summary: entry.summary,
        metadata: entry.metadata || {},
        pre_state: preState,
        pre_market: preMarket,
        post_state: postState,
        post_market: postMarket,
        player_deltas: perPlayerDeltas(entry.mutations),
      });

      // Keep the current player-turn's chart row updated to this event's
      // post-state — final row per turn will reflect the state after the
      // last chained event fires.
      if (turnsOut.length) {
        const last = turnsOut[turnsOut.length - 1];
        last.player_states = postState;
        last.market = postMarket;
      }

      // After each event chain step, future pending actions start from the
      // new post-event state. (If the next entry is another chained event
      // with no actions, this snapshot is fine — it won't be used as a
      // turn-start.)
      turnStartState = postState;
      turnStartMarket = postMarket;
    } else {
      pending.push(entry);
    }
  }

  return { turns: turnsOut, blocks: blocksOut };
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
  const marketLine = (mkt) => Object.entries(mkt || {})
    .filter(([k]) => k !== "PWR")
    .map(([r, pos]) => `${r}: $${positionToPrice(pos)}`)
    .join(" · ") || "—";
  const pwrLine = (mkt) => mkt && mkt.PWR !== undefined
    ? `PWR @ $${positionToPrice(mkt.PWR)}`
    : "";
  const nameToPidx = (name) => {
    // Engine players are "Player_1" / "Player_2" / ...; parse the index.
    const m = /_(\d+)$/.exec(name || "");
    return m ? parseInt(m[1], 10) - 1 : -1;
  };
  const playerLabel = (i) => {
    const p = gameData.players[i] || {};
    const color = PLAYER_COLORS[i % PLAYER_COLORS.length];
    return `<span style="color:${color}; font-weight:600">P${i + 1}</span><span style="color:#8b949e"> (${p.strategy || "?"})</span>`;
  };

  const stateTable = (state) => {
    const rows = (state || []).map((s, i) => {
      const c = PLAYER_COLORS[i % PLAYER_COLORS.length];
      const p = gameData.players[i] || {};
      return `<tr>
        <td style="color:${c}; font-weight:600">P${i + 1} (${p.strategy || "?"})</td>
        <td>${fmtState(s)}</td>
        <td>${ratesSpan(s && s.rates)}</td>
      </tr>`;
    }).join("");
    return `<table style="width:100%; font-size:0.72rem;"><tbody>${rows}</tbody></table>`;
  };

  const perPlayerDeltaList = (deltas) => {
    const items = (deltas || []).map((d, i) => {
      const bits = [];
      if (d.money) bits.push(signed(d.money));
      if (d.debt) bits.push(`debt ${d.debt > 0 ? "+" : ""}${d.debt}`);
      if (d.credit) bits.push(`credit ${d.credit > 0 ? "+" : ""}${d.credit}`);
      if (!bits.length) return `<li style="color:#484f58">${playerLabel(i)}: no change</li>`;
      return `<li>${playerLabel(i)}: ${bits.join(" · ")}</li>`;
    }).join("");
    return `<ul style="margin:4px 0 0 16px; padding:0; list-style:disc; color:#c9d1d9">${items}</ul>`;
  };

  // ---- Event-specific detail renderers ----

  const renderPatentAuction = (block) => {
    const meta = block.metadata;
    if (!meta || !meta.bids) return "";
    const winnerIdx = nameToPidx(meta.winner);
    const rows = Object.entries(meta.bids).map(([name, bid]) => {
      const i = nameToPidx(name);
      const isWinner = i === winnerIdx && meta.winner;
      const c = i >= 0 ? PLAYER_COLORS[i % PLAYER_COLORS.length] : "#c9d1d9";
      const label = i >= 0 ? `P${i + 1} (${(gameData.players[i] || {}).strategy || "?"})` : name;
      return `<tr>
        <td style="color:${c}; font-weight:600">${label}</td>
        <td>$${bid}</td>
        <td>${isWinner ? '<span style="color:#3fb950; font-weight:600">WON</span>' : "—"}</td>
      </tr>`;
    }).join("");
    const winnerText = meta.winner
      ? `<span style="color:#3fb950; font-weight:600">Won by ${meta.winner} for $${meta.price}</span>`
      : '<span style="color:#8b949e">No winner (auction failed)</span>';
    return `
      <div style="margin-top:8px;">
        <div style="color:#c9d1d9"><strong>Patent:</strong> ${meta.patent || "?"} — ${winnerText}</div>
        <table style="width:100%; font-size:0.72rem; margin-top:6px;">
          <thead><tr><th style="text-align:left">Bidder</th><th style="text-align:left">Bid</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  };

  const renderPowerBill = (block) => {
    const meta = block.metadata || {};
    const perPlayer = Array.isArray(meta.per_player) ? meta.per_player : [];
    const rows = perPlayer.map((pm) => {
      const i = nameToPidx(pm.name);
      const c = i >= 0 ? PLAYER_COLORS[i % PLAYER_COLORS.length] : "#c9d1d9";
      const label = i >= 0 ? `P${i + 1} (${(gameData.players[i] || {}).strategy || "?"})` : pm.name;
      let effect;
      if (pm.shielded) effect = `<span style=\"color:#d2a8ff\">Energy Vault shielded (rate ${pm.rate})</span>`;
      else if (pm.earning) effect = `<span style=\"color:#3fb950\">+$${pm.earning}</span> (sold ${pm.rate} PWR)`;
      else if (pm.debt) effect = `<span style=\"color:#f85149\">-$${pm.debt} debt</span> (bought ${Math.abs(pm.rate)} PWR)`;
      else effect = '<span style="color:#484f58">no change (0 PWR)</span>';
      const dome = pm.dome_bonus ? ` · <span style=\"color:#a371f7\">+$${pm.dome_bonus} Pleasure Dome</span>` : "";
      return `<tr><td style="color:${c}; font-weight:600">${label}</td><td>${effect}${dome}</td></tr>`;
    }).join("");
    return `
      <div style="margin-top:8px;">
        <div style="color:#c9d1d9"><strong>PWR @ $${meta.pwr_price ?? "?"}</strong></div>
        <table style="width:100%; font-size:0.72rem; margin-top:6px;"><tbody>${rows}</tbody></table>
      </div>`;
  };

  const renderDebtCollection = (block) => {
    const meta = block.metadata || {};
    const perPlayer = Array.isArray(meta.per_player) ? meta.per_player : [];
    const rows = perPlayer.map((pm) => {
      const i = nameToPidx(pm.name);
      const c = i >= 0 ? PLAYER_COLORS[i % PLAYER_COLORS.length] : "#c9d1d9";
      const label = i >= 0 ? `P${i + 1} (${(gameData.players[i] || {}).strategy || "?"})` : pm.name;
      let effect;
      if (pm.debt_added) effect = `<span style=\"color:#f85149\">+$${pm.debt_added} debt</span> (interest $${pm.interest || 0})`;
      else effect = '<span style="color:#484f58">no debt</span>';
      return `<tr><td style="color:${c}; font-weight:600">${label}</td><td>${effect}</td></tr>`;
    }).join("");
    return `<div style="margin-top:8px;"><table style="width:100%; font-size:0.72rem;"><tbody>${rows}</tbody></table></div>`;
  };

  const renderFuturesTrading = (block) => {
    const meta = block.metadata || {};
    const mc = Array.isArray(meta.market_changes) ? meta.market_changes : [];
    const pc = Array.isArray(meta.player_contributions) ? meta.player_contributions : [];
    const mcLines = mc.map((c) => `${c.resource} +${c.units} units ($${c.price_before} → $${c.price_after})`).join(" · ") || "—";
    const pcLines = pc.map((p) => {
      const i = nameToPidx(p.name);
      const c = i >= 0 ? PLAYER_COLORS[i % PLAYER_COLORS.length] : "#c9d1d9";
      const label = i >= 0 ? `P${i + 1}` : p.name;
      const rates = Object.entries(p.rates || {})
        .map(([k, v]) => `${v > 0 ? "+" : ""}${v} ${k}`).join(" ");
      return `<li><span style="color:${c}; font-weight:600">${label}</span>: ${rates}</li>`;
    }).join("");
    return `
      <div style="margin-top:8px;">
        <div><strong>Market pushed:</strong> ${mcLines}</div>
        ${pc.length ? `<div style="margin-top:4px"><strong>Contributions:</strong></div><ul style="margin:2px 0 0 16px; padding:0; list-style:disc">${pcLines}</ul>` : ""}
      </div>`;
  };

  const renderNewsBulletin = (block) => {
    const meta = block.metadata || {};
    const mc = Array.isArray(meta.market_changes) ? meta.market_changes : [];
    const pc = Array.isArray(meta.player_contributions) ? meta.player_contributions : [];
    const mcLines = mc.length
      ? mc.map((c) => `${c.resource} +${c.units} units ($${c.price_before} → $${c.price_after})`).join(" · ")
      : "";
    const pcLines = pc.map((p) => {
      const i = nameToPidx(p.name);
      const c = i >= 0 ? PLAYER_COLORS[i % PLAYER_COLORS.length] : "#c9d1d9";
      const label = i >= 0 ? `P${i + 1}` : p.name;
      const rates = Object.entries(p.rates || {})
        .map(([k, v]) => `${v > 0 ? "+" : ""}${v} ${k}`).join(" ");
      return `<li><span style="color:${c}; font-weight:600">${label}</span>: ${rates}</li>`;
    }).join("");
    let inner = "";
    if (mcLines) inner += `<div><strong>Market:</strong> ${mcLines}</div>`;
    if (pcLines) inner += `<div style="margin-top:4px"><strong>Contributions:</strong></div><ul style="margin:2px 0 0 16px; padding:0; list-style:disc">${pcLines}</ul>`;
    return inner ? `<div style="margin-top:8px;">${inner}</div>` : "";
  };

  const renderTerminal = (block) => {
    // END_ROUND / END_GAME: power bill + futures settlement.
    const meta = block.metadata || {};
    const preMarket = block.pre_market || {};
    const preState = block.pre_state || [];
    const postState = block.post_state || [];
    const perPlayerMeta = Array.isArray(meta.per_player) ? meta.per_player : [];
    const pwrPrice = meta.pwr_price ?? (preMarket.PWR !== undefined ? positionToPrice(preMarket.PWR) : null);

    const rows = preState.map((pre, i) => {
      const post = postState[i] || {};
      const preRates = pre.rates || {};
      const pmeta = perPlayerMeta[i] || {};
      const pwrRate = preRates.PWR || 0;
      const futures = [];
      let futuresDebt = 0;
      for (const [r, rate] of Object.entries(preRates)) {
        if (r === "PWR" || (rate || 0) >= 0) continue;
        const units = Math.abs(rate);
        const pos = preMarket[r];
        const price = pos !== undefined ? positionToPrice(pos) : null;
        const cost = price !== null ? units * price : null;
        futures.push(`${units} ${r} @ ${price !== null ? `$${price}` : "?"} = ${cost !== null ? `$${cost}` : "?"}`);
        if (cost !== null) futuresDebt += cost;
      }
      const pwrBit = pmeta.shielded
        ? `Energy Vault shielded (${pwrRate > 0 ? "+" : ""}${pwrRate} PWR)`
        : pwrRate > 0
          ? `<span style=\"color:#3fb950\">+$${pmeta.earning ?? pwrRate * (pwrPrice || 0)}</span> (sold ${pwrRate} PWR)`
          : pwrRate < 0
            ? `<span style=\"color:#f85149\">-$${pmeta.debt ?? Math.abs(pwrRate) * (pwrPrice || 0)} debt</span> (bought ${Math.abs(pwrRate)} PWR)`
            : '<span style="color:#484f58">0 PWR</span>';
      const dome = pmeta.dome_bonus ? `<br><span style=\"color:#a371f7\">+$${pmeta.dome_bonus} Pleasure Dome</span>` : "";
      const preNw = nwOf(pre);
      const postNw = nwOf(post);
      const nwDelta = postNw - preNw;
      const deltaColor = nwDelta > 0 ? "#3fb950" : nwDelta < 0 ? "#f85149" : "#8b949e";
      return `<tr>
        <td>${playerLabel(i)}</td>
        <td>${fmtState(pre)}</td>
        <td>${ratesSpan(preRates)}</td>
        <td>${pwrBit}${dome}</td>
        <td>${futures.length ? futures.join("<br>") + `<br><span style=\"color:#8b949e\">total: $${futuresDebt}</span>` : '<span style="color:#484f58">—</span>'}</td>
        <td>${fmtState(post)} <span style=\"color:${deltaColor}\">(${signed(nwDelta)})</span></td>
      </tr>`;
    }).join("");
    return `
      <div style="margin-top:8px;">
        <div style="color:#c9d1d9"><strong>${pwrPrice !== null ? `PWR @ $${pwrPrice}` : ""}</strong></div>
        <div class="table-scroll" style="margin-top:6px">
          <table style="width:100%; font-size:0.7rem;">
            <thead><tr>
              <th>Player</th><th>Pre</th><th>Rates</th><th>Power Bill</th><th>Futures</th><th>Post (ΔNW)</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  };

  const renderDrawBuildingCard = (block) => {
    // Draw building card: summary is human-readable, metadata is empty.
    return `<div style="margin-top:8px; color:#c9d1d9">${block.summary}</div>`;
  };

  // Dispatch to the right event renderer based on type.
  const renderEventDetail = (block) => {
    switch (block.type) {
      case "event:patent_auction": return renderPatentAuction(block);
      case "event:power_bill": return renderPowerBill(block);
      case "event:debt_collection": return renderDebtCollection(block);
      case "event:futures_trading": return renderFuturesTrading(block);
      case "event:news_bulletin": return renderNewsBulletin(block);
      case "event:end_round":
      case "event:end_game": return renderTerminal(block);
      case "event:draw_building_card": return renderDrawBuildingCard(block);
      default: return "";
    }
  };

  const prettyEventName = (type) => {
    const map = {
      "event:patent_auction": "Patent Auction",
      "event:power_bill": "Power Bill",
      "event:debt_collection": "Debt Collection",
      "event:futures_trading": "Futures Trading",
      "event:news_bulletin": "News Bulletin",
      "event:end_round": "End of Round",
      "event:end_game": "End of Game",
      "event:draw_building_card": "Draw Building Card",
    };
    return map[type] || type.replace(/^event:/, "");
  };

  const controls = `
    <div style="display:flex; gap:8px; margin-bottom:8px; font-size:0.75rem;">
      <button id="tl-expand-all" style="background:#21262d; border:1px solid #30363d; color:#c9d1d9; padding:4px 10px; border-radius:4px; cursor:pointer;">Expand all</button>
      <button id="tl-collapse-all" style="background:#21262d; border:1px solid #30363d; color:#c9d1d9; padding:4px 10px; border-radius:4px; cursor:pointer;">Collapse all</button>
    </div>`;

  const renderTurnBlock = (b) => {
    const pidx = b.player_idx;
    const color = PLAYER_COLORS[pidx % PLAYER_COLORS.length];
    const player = gameData.players[pidx] || {};
    const round = Math.floor((b.turn_num - 1) / numPlayers) + 1;
    const actingPre = (b.pre_state && b.pre_state[pidx]) || {};
    const actingPost = (b.post_state && b.post_state[pidx]) || {};
    const nwDelta = nwOf(actingPost) - nwOf(actingPre);
    const deltaColor = nwDelta > 0 ? "#3fb950" : nwDelta < 0 ? "#f85149" : "#8b949e";
    const gameplay = b.actions.filter((a) => a.type !== "swap");
    const teaser = gameplay.length
      ? gameplay.slice(0, 2).map((a) => a.detail.replace(/\s*\([^)]+\)\s*$/, "")).join(" · ")
      : "Pass";

    const summaryHtml = `
      <summary style="cursor:pointer; padding:8px 12px; background:#161b22; border-left:3px solid ${color}; font-size:0.82rem; line-height:1.5;">
        <span style="color:${color}; font-weight:600;">Turn ${b.turn_num} · Round ${round} · P${pidx + 1} (${player.strategy || "?"})</span>
        <span style="color:#8b949e; margin-left:8px;">${teaser}</span>
        <span style="color:${deltaColor}; margin-left:8px;">NW ${nwOf(actingPre)} → ${nwOf(actingPost)} (${signed(nwDelta)})</span>
      </summary>`;

    const actionRows = b.actions.length
      ? b.actions.map((a) => {
          const cl = colorFor(a.type);
          const deltaBits = [];
          if (a.money_delta) deltaBits.push(signed(a.money_delta));
          if (a.debt_delta) deltaBits.push(`debt ${a.debt_delta > 0 ? "+" : ""}${a.debt_delta}`);
          if (a.credit_delta) deltaBits.push(`credit ${a.credit_delta > 0 ? "+" : ""}${a.credit_delta}`);
          const deltaStr = deltaBits.length ? ` <span style="color:#484f58">(${deltaBits.join(", ")})</span>` : "";
          return `<li style="color:${cl}">${a.type}: ${a.detail}${deltaStr}</li>`;
        }).join("")
      : '<li style="color:#484f58">Pass — no actions</li>';

    return `<details style="margin-bottom:4px;">${summaryHtml}
      <div style="padding:12px 16px; background:#0d1117; border-left:3px solid ${color}; font-size:0.78rem; line-height:1.6;">
        <div style="color:#8b949e; margin-bottom:8px;">Market at start: ${marketLine(b.pre_market)} · ${pwrLine(b.pre_market)}</div>
        <h4 style="color:#58a6ff; margin:8px 0 4px; font-size:0.8rem;">Pre-turn state</h4>
        ${stateTable(b.pre_state)}
        <h4 style="color:#58a6ff; margin:12px 0 4px; font-size:0.8rem;">Actions by P${pidx + 1}</h4>
        <ul style="margin:4px 0 0 16px; padding:0; list-style:disc;">${actionRows}</ul>
        <h4 style="color:#58a6ff; margin:12px 0 4px; font-size:0.8rem;">State after actions</h4>
        ${stateTable(b.post_state)}
      </div>
    </details>`;
  };

  const renderEventBlock = (b) => {
    const name = prettyEventName(b.type);
    const anyImpact = (b.player_deltas || []).some((d) => d.money || d.debt || d.credit);
    const summaryBits = [];
    if (b.type === "event:patent_auction" && b.metadata && b.metadata.winner) {
      const wi = nameToPidx(b.metadata.winner);
      summaryBits.push(`${b.metadata.patent || ""} → P${wi + 1} for $${b.metadata.price}`);
    } else if (b.type === "event:power_bill" && b.metadata && b.metadata.pwr_price !== undefined) {
      summaryBits.push(`PWR @ $${b.metadata.pwr_price}`);
    } else {
      summaryBits.push(b.summary.replace(/^Event: /, ""));
    }

    const summaryHtml = `
      <summary style="cursor:pointer; padding:6px 12px; background:#1f1b2a; border-left:3px solid #a371f7; font-size:0.8rem; line-height:1.5;">
        <span style="color:#a371f7; font-weight:600;">⚡ ${name}</span>
        <span style="color:#c9d1d9; margin-left:8px;">${summaryBits.join(" · ")}</span>
        ${anyImpact ? '<span style="color:#8b949e; margin-left:8px; font-size:0.7rem">(multi-player impact)</span>' : ""}
      </summary>`;

    const detail = renderEventDetail(b);
    return `<details style="margin-bottom:4px; margin-left:16px;">${summaryHtml}
      <div style="padding:10px 16px; background:#0d1117; border-left:3px solid #a371f7; font-size:0.76rem; line-height:1.6;">
        <div style="color:#8b949e; margin-bottom:6px;">Market before event: ${marketLine(b.pre_market)} · ${pwrLine(b.pre_market)}</div>
        ${detail}
        ${anyImpact
          ? `<h4 style="color:#58a6ff; margin:10px 0 4px; font-size:0.8rem;">Net impact per player</h4>${perPlayerDeltaList(b.player_deltas)}`
          : ""}
      </div>
    </details>`;
  };

  const html = blocks.map((b) => b.kind === "turn" ? renderTurnBlock(b) : renderEventBlock(b)).join("");
  container.innerHTML = controls + html;

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
