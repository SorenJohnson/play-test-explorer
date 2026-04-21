const SCENARIOS = [
  { file: "data/sim_3random.json", label: "3 Random", color: "#f85149" },
  { file: "data/sim_3optimal.json", label: "3 Optimal", color: "#d2a8ff" },
  { file: "data/sim_optimal_smart_random.json", label: "Optimal+S+R", color: "#f0883e" },
];

const RESOURCE_COLORS = {
  PWR: "#e74c3c", H2O: "#2c3e80", FE: "#555555", C: "#8e44ad",
  SI: "#f1c40f", O2: "#bdc3c7", FOOD: "#27ae60", GLS: "#5dade2", ELX: "#e67e22",
};

const SPREAD_SAMPLE_SIZE = 50;

function hexToRgba(hex, alpha) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

let allData = [];
let analysisData = null;
let currentScenario = "all";
const chartRegistry = {}; // id -> Chart instance (for destroy-on-rerender)

// Read an analysis field, honoring the current scenario filter if a per-scenario variant exists.
function getSource(field) {
  if (currentScenario === "all") return analysisData[field];
  const byScenario = analysisData[`${field}_by_scenario`];
  if (byScenario && byScenario[currentScenario]) return byScenario[currentScenario];
  return analysisData[field];
}

// Strip all listeners from a DOM element by cloning it.
function resetEl(el) {
  if (!el) return null;
  const clone = el.cloneNode(true);
  el.parentNode.replaceChild(clone, el);
  return clone;
}

// Destroy a registered chart if present.
function destroyChart(id) {
  if (chartRegistry[id]) {
    chartRegistry[id].destroy();
    delete chartRegistry[id];
  }
}

async function init() {
  const [scenarioResults, analysis] = await Promise.all([
    Promise.all(SCENARIOS.map(async (s) => {
      const resp = await fetch(s.file);
      return { ...s, data: await resp.json() };
    })),
    fetch("data/analysis.json").then((r) => r.json()).catch(() => null),
  ]);
  allData = scenarioResults;
  analysisData = analysis;

  renderDataRefreshedAt();
  renderStrategyChart();
  if (analysisData) {
    populateScenarioSelector();
    renderScenarioDependent();
    renderFlowNetwork(); // not scenario-filtered
  }
  renderGameBrowser(); // not scenario-filtered
}

function renderDataRefreshedAt() {
  const el = document.getElementById("data-refreshed-at");
  if (!el) return;
  const stamps = allData
    .map((s) => s.data && s.data.generated_at)
    .filter(Boolean);
  if (analysisData && analysisData.generated_at) stamps.push(analysisData.generated_at);
  if (!stamps.length) return;
  const oldest = stamps.sort()[0];
  const d = new Date(oldest);
  if (Number.isNaN(d.getTime())) return;
  const pad = (n) => String(n).padStart(2, "0");
  el.textContent = `Data refreshed ${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

function populateScenarioSelector() {
  const select = document.getElementById("page-scenario");
  if (!select) return;
  const scenarios = Object.keys(analysisData.building_value_by_scenario || {}).sort();
  const prettyLabel = (name) => {
    if (name === "all") return "All scenarios (combined)";
    return name.replace(/^sim_/, "").replace(/_/g, " + ");
  };
  select.innerHTML = ["all", ...scenarios]
    .map((s) => `<option value="${s}">${prettyLabel(s)}</option>`)
    .join("");
  select.addEventListener("change", () => {
    currentScenario = select.value;
    renderScenarioDependent();
  });
}

// Re-render all scenario-dependent sections. Resets DOM listeners and charts
// so repeated calls don't stack handlers or leak Chart.js instances.
function renderScenarioDependent() {
  // Destroy scenario-bound charts
  destroyChart("market-trajectory-chart");

  // Reset elements that have wired listeners (sortable headers, toggle buttons)
  resetEl(document.querySelector("#corporation-table"));
  resetEl(document.querySelector("#building-value-table"));
  resetEl(document.querySelector("#strategy-contract-table"));
  resetEl(document.querySelector("#market-dynamics-table"));
  // Toggle button groups for market dynamics
  document.querySelectorAll(".view-toggle, .segment-toggle").forEach((btn) => {
    resetEl(btn);
  });

  renderMarketDynamics();
  renderCorporationTable();
  renderBuildingValueTable();
  renderStrategyContractTable();
}

// --- Strategy Performance ---

function renderStrategyChart() {
  const STRATEGY_COLORS = {
    optimal: { bg: "#d2a8ff44", border: "#d2a8ff" },
    smart:   { bg: "#3fb95044", border: "#3fb950" },
    greedy:  { bg: "#58a6ff44", border: "#58a6ff" },
    random:  { bg: "#f8514944", border: "#f85149" },
  };

  // Discover all strategies present in the data
  const stratNames = new Set();
  for (const s of allData) {
    for (const g of s.data.games) {
      for (const p of g.players) {
        if (p.strategy) stratNames.add(p.strategy);
      }
    }
  }

  const labels = [];
  const stratData = {};
  for (const name of stratNames) stratData[name] = [];

  for (const s of allData) {
    labels.push(s.label);
    const byStrat = {};
    for (const name of stratNames) byStrat[name] = [];
    for (const g of s.data.games) {
      for (const p of g.players) {
        if (byStrat[p.strategy]) byStrat[p.strategy].push(p.net_worth);
      }
    }
    for (const name of stratNames) {
      stratData[name].push(byStrat[name].length > 0 ? byStrat[name] : null);
    }
  }

  // Build datasets in a consistent order: optimal first, then smart, greedy, random, others
  const order = ["optimal", "smart", "greedy", "random"];
  const sortedNames = [...stratNames].sort((a, b) => {
    const ai = order.indexOf(a), bi = order.indexOf(b);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });

  const datasets = sortedNames.map((name) => {
    const colors = STRATEGY_COLORS[name] || { bg: "#8b949e44", border: "#8b949e" };
    return {
      label: name.charAt(0).toUpperCase() + name.slice(1),
      backgroundColor: colors.bg,
      borderColor: colors.border,
      data: stratData[name],
    };
  }).filter((ds) => ds.data.some((d) => d !== null));

  new Chart(document.getElementById("strategy-nw-chart"), {
    type: "boxplot",
    data: { labels, datasets },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: "#8b949e" } } },
      scales: {
        x: { ticks: { color: "#8b949e" }, grid: { color: "#21262d" } },
        y: { title: { display: true, text: "Net Worth ($)", color: "#8b949e" }, ticks: { color: "#8b949e" }, grid: { color: "#21262d" } },
      },
    },
  });
}

// --- Game Economics (sortable + expandable) ---

function renderStrategyContractTable() {
  const contracts = getSource("sim_contract_costs");
  if (!contracts) return;

  const table = document.getElementById("strategy-contract-table");
  const tbody = table.querySelector("tbody");
  const entries = Object.entries(contracts);

  let currentSort = { col: 2, asc: true }; // default: gross cost ascending
  const expandedRows = new Set();

  // Discover all strategies from the contract data
  const allStrats = new Set();
  for (const [, stats] of entries) {
    if (stats.by_strategy) {
      for (const s of Object.keys(stats.by_strategy)) allStrats.add(s);
    }
  }
  const stratOrder = ["optimal", "smart", "greedy", "random"];
  const sortedStrats = [...allStrats].sort((a, b) => {
    const ai = stratOrder.indexOf(a), bi = stratOrder.indexOf(b);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });

  // Build dynamic headers
  const thead = table.querySelector("thead");
  thead.innerHTML = `<tr>
    <th>Contract</th><th>Fulfilled</th><th>Gross Cost</th><th>Net Cost</th>
    ${sortedStrats.map((s) => `<th>${s.charAt(0).toUpperCase() + s.slice(1)}</th>`).join("")}
  </tr>`;

  function getSortValue(label, stats, colIdx) {
    if (colIdx === 0) return label;
    if (colIdx === 1) return stats.count;
    if (colIdx === 2) return stats.gross_cost.mean;
    if (colIdx === 3) return stats.true_cost.mean;
    // Strategy columns start at index 4
    const stratIdx = colIdx - 4;
    if (stratIdx >= 0 && stratIdx < sortedStrats.length) {
      const s = stats.by_strategy?.[sortedStrats[stratIdx]];
      return s?.mean ?? 999;
    }
    return 0;
  }

  function buildExpandedRow(label, stats) {
    const buildings = stats.top_buildings || [];
    const rates = stats.avg_rates_at_fulfillment || {};

    const buildingRows = buildings.length
      ? buildings
          .map(
            (b) =>
              `<tr><td>${b.building}</td><td>${b.count}</td><td>${b.rate.toFixed(1)}</td></tr>`
          )
          .join("")
      : "<tr><td colspan='3'>No data</td></tr>";

    const rateEntries = Object.entries(rates)
      .filter(([, v]) => Math.abs(v) >= 0.1)
      .sort((a, b) => b[1] - a[1])
      .map(
        ([r, v]) =>
          `<span style="color:${RESOURCE_COLORS[r] || "#888"}">${r}: ${v > 0 ? "+" : ""}${v}</span>`
      )
      .join("&nbsp;&nbsp;");

    const gross = stats.gross_cost;
    const net = stats.true_cost;

    return `<tr class="contract-detail-row"><td colspan="7">
      <div style="background:#0d1117; padding:16px; border-left:3px solid #58a6ff;">
        <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:24px;">
          <div>
            <h4 style="color:#58a6ff; margin-bottom:8px; font-size:0.85rem;">Build Path (since last contract)</h4>
            <table style="width:100%">
              <thead><tr><th>Building</th><th>Count</th><th>Avg/Contract</th></tr></thead>
              <tbody>${buildingRows}</tbody>
            </table>
          </div>
          <div>
            <h4 style="color:#58a6ff; margin-bottom:8px; font-size:0.85rem;">Avg Rate Profile at Fulfillment</h4>
            <div style="line-height:2; font-size:0.8rem;">${rateEntries || "No data"}</div>
          </div>
          <div>
            <h4 style="color:#58a6ff; margin-bottom:8px; font-size:0.85rem;">Cost Distribution</h4>
            <div style="font-size:0.8rem; line-height:1.8;">
              <div class="detail-row"><span class="detail-label">Gross cost (mean):</span> <span class="detail-value">$${gross.mean}</span></div>
              <div class="detail-row"><span class="detail-label">Gross cost (median):</span> <span class="detail-value">$${gross.median}</span></div>
              <div class="detail-row"><span class="detail-label">Gross cost (min/max):</span> <span class="detail-value">$${gross.min} / $${gross.max}</span></div>
              <div class="detail-row"><span class="detail-label">Net cost (mean):</span> <span class="detail-value">$${net.mean}</span></div>
              <div class="detail-row"><span class="detail-label">Net cost (median):</span> <span class="detail-value">$${net.median}</span></div>
              <div class="detail-row"><span class="detail-label">Net cost (min/max):</span> <span class="detail-value">$${net.min} / $${net.max}</span></div>
              <div class="detail-row"><span class="detail-label">Avg net profit:</span> <span class="detail-value positive">$${(50 - net.mean).toFixed(1)}</span></div>
            </div>
          </div>
        </div>
      </div>
    </td></tr>`;
  }

  function renderRows() {
    const sorted = [...entries].sort((a, b) => {
      const va = getSortValue(a[0], a[1], currentSort.col);
      const vb = getSortValue(b[0], b[1], currentSort.col);
      if (typeof va === "string")
        return currentSort.asc ? va.localeCompare(vb) : vb.localeCompare(va);
      return currentSort.asc ? va - vb : vb - va;
    });

    const rows = [];
    sorted.forEach(([label, stats]) => {
      const expanded = expandedRows.has(label);
      const arrow = expanded ? "▼" : "▶";
      const stratCells = sortedStrats.map((s) => {
        const d = stats.by_strategy?.[s];
        return `<td>${d ? `$${d.mean} (n=${d.count})` : "-"}</td>`;
      }).join("");
      rows.push(
        `<tr class="contract-row" data-label="${label}" style="cursor:pointer;">
          <td>${arrow} ${label}</td>
          <td>${stats.count}</td>
          <td>$${stats.gross_cost.mean}</td>
          <td>$${stats.true_cost.mean}</td>
          ${stratCells}
        </tr>`
      );
      if (expanded) {
        rows.push(buildExpandedRow(label, stats));
      }
    });
    tbody.innerHTML = rows.join("");

    // Wire up click handlers
    tbody.querySelectorAll(".contract-row").forEach((row) => {
      row.addEventListener("click", () => {
        const label = row.dataset.label;
        if (expandedRows.has(label)) {
          expandedRows.delete(label);
        } else {
          expandedRows.add(label);
        }
        renderRows();
      });
    });
  }

  // Make headers clickable for sorting
  table.querySelectorAll("thead th").forEach((th, idx) => {
    th.style.cursor = "pointer";
    th.addEventListener("click", (e) => {
      e.stopPropagation();
      if (currentSort.col === idx) {
        currentSort.asc = !currentSort.asc;
      } else {
        currentSort = { col: idx, asc: true };
      }
      table.querySelectorAll("thead th").forEach((h) => {
        h.textContent = h.textContent.replace(/ [▲▼]$/, "");
      });
      th.textContent += currentSort.asc ? " ▲" : " ▼";
      renderRows();
    });
  });

  renderRows();
}

// --- Flow Network ---

function renderFlowNetwork() {
  const flows = analysisData.resource_flows;
  if (!flows) return;

  const elements = [];
  const maxFlow = Math.max(...flows.resource_flows.map((e) => e.count), 1);

  // Resource nodes
  const allResources = new Set();
  for (const e of flows.resource_flows) {
    allResources.add(e.source);
    allResources.add(e.target);
  }
  for (const r of allResources) {
    elements.push({
      data: { id: r, label: r, type: "resource", color: RESOURCE_COLORS[r] || "#888" },
    });
  }

  // Contract node
  elements.push({
    data: { id: "CONTRACTS", label: "Contracts\n($50)", type: "contract", color: "#238636" },
  });

  // Resource flow edges (only show significant ones)
  const minCount = maxFlow * 0.05;
  for (const e of flows.resource_flows) {
    if (e.count < minCount) continue;
    const buildings = e.buildings.map((b) => b.name).join(", ");
    elements.push({
      data: {
        id: `${e.source}->${e.target}`,
        source: e.source,
        target: e.target,
        count: e.count,
        buildings,
        weight: e.count / maxFlow,
      },
    });
  }

  // Contract consumption edges
  const maxContract = Math.max(...Object.values(flows.contract_consumption), 1);
  for (const [res, amt] of Object.entries(flows.contract_consumption)) {
    elements.push({
      data: {
        id: `${res}->CONTRACTS`,
        source: res,
        target: "CONTRACTS",
        count: amt,
        buildings: "contract fulfillment",
        weight: amt / maxContract,
      },
    });
  }

  const cy = cytoscape({
    container: document.getElementById("flow-network"),
    elements,
    style: [
      {
        selector: 'node[type="resource"]',
        style: {
          label: "data(label)",
          "background-color": "data(color)",
          width: 50, height: 50,
          "font-size": "14px", "font-weight": "bold",
          color: "#fff",
          "text-valign": "center", "text-halign": "center",
          "text-outline-color": "#000", "text-outline-width": 2,
        },
      },
      {
        selector: 'node[type="contract"]',
        style: {
          label: "data(label)",
          "background-color": "#238636",
          shape: "round-rectangle",
          width: 80, height: 50,
          "font-size": "12px", color: "#fff",
          "text-valign": "center", "text-halign": "center",
          "text-outline-color": "#000", "text-outline-width": 1,
          "text-wrap": "wrap",
        },
      },
      {
        selector: "edge",
        style: {
          width: function (ele) { return 1 + ele.data("weight") * 10; },
          "line-color": "#388bfd",
          "target-arrow-color": "#388bfd",
          "target-arrow-shape": "triangle",
          "curve-style": "bezier",
          opacity: function (ele) { return 0.3 + ele.data("weight") * 0.5; },
        },
      },
      {
        selector: "edge[target='CONTRACTS']",
        style: {
          "line-color": "#f0883e",
          "target-arrow-color": "#f0883e",
          "line-style": "dashed",
        },
      },
      { selector: ".highlighted", style: { opacity: 1, "z-index": 10 } },
      { selector: ".faded", style: { opacity: 0.08 } },
    ],
    layout: {
      name: "dagre",
      rankDir: "LR",
      nodeSep: 40,
      rankSep: 120,
    },
    minZoom: 0.5, maxZoom: 2,
  });

  // Click interaction
  const detail = document.getElementById("flow-detail");

  cy.on("tap", "node", (e) => {
    const d = e.target.data();
    const connected = e.target.closedNeighborhood();
    cy.elements().addClass("faded");
    connected.removeClass("faded").addClass("highlighted");

    if (d.type === "resource") {
      const incoming = e.target.incomers("edge").map((edge) =>
        `${edge.data("source")} → ${d.id}: ${edge.data("count")}x via ${edge.data("buildings")}`
      );
      const outgoing = e.target.outgoers("edge").map((edge) =>
        `${d.id} → ${edge.data("target")}: ${edge.data("count")}x via ${edge.data("buildings")}`
      );
      detail.innerHTML = `<div style="background:#161b22; border:1px solid #30363d; border-radius:6px; padding:12px; font-size:0.8rem;">
        <strong><span class="resource-dot" style="background:${d.color}"></span>${d.id}</strong><br>
        ${incoming.length ? "<br><strong>Inflows:</strong><br>" + incoming.join("<br>") : ""}
        ${outgoing.length ? "<br><strong>Outflows:</strong><br>" + outgoing.join("<br>") : ""}
      </div>`;
    }
  });

  cy.on("tap", "edge", (e) => {
    const d = e.target.data();
    const connected = e.target.connectedNodes().add(e.target);
    cy.elements().addClass("faded");
    connected.removeClass("faded").addClass("highlighted");
    detail.innerHTML = `<div style="background:#161b22; border:1px solid #30363d; border-radius:6px; padding:12px; font-size:0.8rem;">
      <strong>${d.source} → ${d.target}</strong>: ${d.count} times<br>
      Buildings: ${d.buildings}
    </div>`;
  });

  cy.on("tap", (e) => {
    if (e.target === cy) {
      cy.elements().removeClass("faded highlighted");
      detail.innerHTML = "";
    }
  });
}

// --- Game Browser ---

function renderGameBrowser() {
  const scenarioSelect = document.getElementById("filter-scenario");
  const sortSelect = document.getElementById("filter-sort");
  const countEl = document.getElementById("game-count");

  // Populate scenario dropdown
  scenarioSelect.innerHTML = allData
    .map((s, i) => `<option value="${i}">${s.label}</option>`)
    .join("");

  function refresh() {
    const scenarioIdx = parseInt(scenarioSelect.value);
    const scenario = allData[scenarioIdx];
    const sortBy = sortSelect.value;

    // Carry the scenario stem (e.g., "sim_3optimal") so Inspect links
    // resolve to the per-game detail file written by cmd_publish.
    const stem = (scenario.file.split("/").pop() || "").replace(/\.json$/, "");
    let games = scenario.data.games.map((g, i) => ({
      ...g, _idx: i, _file: scenario.file, _stem: stem,
    }));

    // Sort
    if (sortBy === "nw_desc") games.sort((a, b) => b.players[0].net_worth - a.players[0].net_worth);
    else if (sortBy === "nw_asc") games.sort((a, b) => a.players[0].net_worth - b.players[0].net_worth);
    else if (sortBy === "contracts_desc") {
      games.sort((a, b) => {
        const ac = a.players.reduce((s, p) => s + p.contracts_fulfilled, 0);
        const bc = b.players.reduce((s, p) => s + p.contracts_fulfilled, 0);
        return bc - ac;
      });
    } else if (sortBy === "contracts_asc") {
      games.sort((a, b) => {
        const ac = a.players.reduce((s, p) => s + p.contracts_fulfilled, 0);
        const bc = b.players.reduce((s, p) => s + p.contracts_fulfilled, 0);
        return ac - bc;
      });
    }

    // Show top 50
    const shown = games.slice(0, 50);
    countEl.textContent = `Showing ${shown.length} of ${games.length} games`;

    const tbody = document.querySelector("#game-browser-table tbody");
    tbody.innerHTML = shown
      .map((g) => {
        const ps = g.players;
        const totalContracts = ps.reduce((s, p) => s + p.contracts_fulfilled, 0);
        const nwCells = ps
          .map((p) => {
            const cls = p.net_worth >= 0 ? "positive" : "negative";
            return `<td class="${cls}">$${p.net_worth} <span style="color:#8b949e; font-size:0.7rem">(${p.strategy[0]})</span></td>`;
          })
          .join("");

        const gameId = g.game_id !== undefined ? g.game_id : g._idx;
        const inspectHref = `game.html?scenario=${encodeURIComponent(g._stem)}&game=${gameId}`;
        return `<tr>
          <td>#${g._idx + 1}</td>
          ${nwCells}
          <td>${totalContracts}</td>
          <td>${g.turn_count}</td>
          <td><a href="${inspectHref}" style="color:#58a6ff; text-decoration:none;">Inspect →</a></td>
        </tr>`;
      })
      .join("");
  }

  scenarioSelect.addEventListener("change", refresh);
  sortSelect.addEventListener("change", refresh);
  refresh();
}

// Starting rates per corporation (mirrors simulation.py CORPORATIONS)
const CORP_STARTING_RATES = {
  "Seneca Development": { PWR: 2, FE: 1, FOOD: -1 },
  "Yoshimi Robotics": { PWR: -2, FE: 2 },
  "Reclamation Inc.": { PWR: 1, SI: 1, C: 1, H2O: -1 },
  "New Meridians": { PWR: -1, FE: 1, O2: 1, FOOD: 1 },
};

// Persisted across scenario changes so user selections survive filter swaps.
let mdCurrentSegment = "all";
let mdCurrentView = "totals";
let mdShowSpread = false;

// --- Market spread (per-game trajectory) helpers ---

// Pull raw games for the current scenario from the already-loaded sim files.
// Avoids any extra fetches and any backend changes — the data is right there.
function getGamesForCurrentScenario() {
  if (currentScenario === "all") {
    return allData.flatMap((s) => s.data.games || []);
  }
  const target = `data/${currentScenario}.json`;
  const entry = allData.find((s) => s.file === target);
  return entry ? (entry.data.games || []) : [];
}

// In-place Fisher-Yates pick of the first `n` items from a shuffled copy.
function sampleArray(arr, n) {
  if (arr.length <= n) return arr.slice();
  const idx = arr.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, n).map((i) => arr[i]);
}

// Mirrors analyze_market_dynamics: take one snapshot per distinct turn (the
// first action_history entry per turn), then collect prices into per-resource
// trajectories. Prepends the initial price (Turn 0) so trajectories align
// with the avg line. Returns { resource: [trajectory, trajectory, ...] }.
function extractTrajectoriesFromGames(games) {
  const out = {};
  for (const game of games) {
    const initMarket = game.initial_market || {};
    const seen = new Set();
    const perGame = {};
    // Prefer the lean per-turn market_history written by cmd_publish;
    // fall back to action_history for older sim files that still embed it.
    const snapshots = game.market_history && game.market_history.length
      ? game.market_history
      : (game.action_history || []);
    for (const rec of snapshots) {
      if (seen.has(rec.turn)) continue;
      seen.add(rec.turn);
      const market = rec.market || {};
      for (const r of Object.keys(market)) {
        if (!perGame[r]) perGame[r] = [];
        perGame[r].push(market[r]);
      }
    }
    for (const r of Object.keys(perGame)) {
      if (!out[r]) out[r] = [];
      // Prepend Turn 0 using actual per-game initial price
      const initPrice = initMarket[r] ?? perGame[r][0] ?? 4;
      out[r].push([initPrice, ...perGame[r]]);
    }
  }
  return out;
}

// Compute per-turn percentiles from trajectories for confidence bands.
function computeBandPercentiles(trajectories) {
  const maxLen = Math.max(0, ...trajectories.map((t) => t.length));
  const p25 = [], p75 = [], p10 = [], p90 = [];
  for (let i = 0; i < maxLen; i++) {
    const vals = trajectories.filter((t) => i < t.length).map((t) => t[i]).sort((a, b) => a - b);
    if (vals.length === 0) { p25.push(0); p75.push(0); p10.push(0); p90.push(0); continue; }
    p25.push(percentile(vals, 25));
    p75.push(percentile(vals, 75));
    p10.push(percentile(vals, 10));
    p90.push(percentile(vals, 90));
  }
  return { p10, p25, p75, p90 };
}

// Build percentile band datasets (P25-P75 at 25% opacity, P10-P90 at 10% opacity).
function buildSpreadDatasets(chart) {
  const games = getGamesForCurrentScenario();
  const sampled = sampleArray(games, SPREAD_SAMPLE_SIZE);
  const byResource = extractTrajectoriesFromGames(sampled);

  // Extend labels if needed
  const maxTrajLen = Math.max(
    0,
    ...Object.values(byResource).flatMap((trajs) => trajs.map((t) => t.length))
  );
  if (maxTrajLen > chart.data.labels.length) {
    for (let i = chart.data.labels.length; i < maxTrajLen; i++) {
      chart.data.labels.push(`Turn ${i + 1}`);
    }
  }

  for (const [r, trajs] of Object.entries(byResource)) {
    if (trajs.length < 3) continue;
    const color = RESOURCE_COLORS[r] || "#888";
    const avgIdx = chart.data.datasets.findIndex(
      (d) => d._kind === "avg" && d._resource === r
    );
    const avgVisible = avgIdx >= 0 ? chart.isDatasetVisible(avgIdx) : true;
    const { p10, p25, p75, p90 } = computeBandPercentiles(trajs);

    // P10-P90 band (80% of games, faint)
    chart.data.datasets.push({
      label: `${r}__p90`,
      data: p90,
      borderWidth: 0, pointRadius: 0, tension: 0.3,
      fill: "+1",
      backgroundColor: hexToRgba(color, 0.08),
      hidden: !avgVisible,
      _resource: r, _kind: "spread",
    });
    chart.data.datasets.push({
      label: `${r}__p10`,
      data: p10,
      borderWidth: 0, pointRadius: 0, tension: 0.3,
      fill: false, backgroundColor: "transparent",
      hidden: !avgVisible,
      _resource: r, _kind: "spread",
    });

    // P25-P75 band (50% of games, more visible)
    chart.data.datasets.push({
      label: `${r}__p75`,
      data: p75,
      borderWidth: 0, pointRadius: 0, tension: 0.3,
      fill: "+1",
      backgroundColor: hexToRgba(color, 0.22),
      hidden: !avgVisible,
      _resource: r, _kind: "spread",
    });
    chart.data.datasets.push({
      label: `${r}__p25`,
      data: p25,
      borderWidth: 0, pointRadius: 0, tension: 0.3,
      fill: false, backgroundColor: "transparent",
      hidden: !avgVisible,
      _resource: r, _kind: "spread",
    });
  }
}

function wireMarketSpreadToggle() {
  const btn = document.getElementById("market-spread-toggle");
  if (!btn) return;
  btn.classList.toggle("active", mdShowSpread);
  // If the toggle was on before a scenario change, rebuild the spread for the
  // new scenario's games immediately so the user doesn't have to re-click.
  if (mdShowSpread) {
    const chart = chartRegistry["market-trajectory-chart"];
    if (chart && !chart.data.datasets.some((d) => d._kind === "spread")) {
      buildSpreadDatasets(chart);
      chart.update();
    }
  }
  btn.onclick = () => {
    mdShowSpread = !mdShowSpread;
    btn.classList.toggle("active", mdShowSpread);
    const chart = chartRegistry["market-trajectory-chart"];
    if (!chart) return;
    const hasSpread = chart.data.datasets.some((d) => d._kind === "spread");
    if (mdShowSpread && !hasSpread) {
      buildSpreadDatasets(chart);
    } else {
      chart.data.datasets.forEach((d, i) => {
        if (d._kind !== "spread") return;
        const avgIdx = chart.data.datasets.findIndex(
          (x) => x._kind === "avg" && x._resource === d._resource
        );
        const avgVisible = avgIdx >= 0 ? chart.isDatasetVisible(avgIdx) : false;
        chart.setDatasetVisibility(i, mdShowSpread && avgVisible);
      });
    }
    chart.update();
  };
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function buildMarketLegendTable(resources, stats) {
  const tbody = document.querySelector("#market-legend-table tbody");
  if (!tbody) return;
  const chart = chartRegistry["market-trajectory-chart"];

  // Compute volatility (avg absolute turn-to-turn price change) from raw games
  const games = getGamesForCurrentScenario();
  const byResource = extractTrajectoriesFromGames(games);
  const volatility = {};
  for (const r of resources) {
    const trajs = byResource[r] || [];
    let totalDelta = 0, totalSteps = 0;
    for (const traj of trajs) {
      for (let i = 1; i < traj.length; i++) {
        totalDelta += Math.abs(traj[i] - traj[i - 1]);
        totalSteps++;
      }
    }
    volatility[r] = totalSteps > 0 ? (totalDelta / totalSteps).toFixed(2) : "?";
  }

  tbody.innerHTML = resources.map((r) => {
    const color = RESOURCE_COLORS[r] || "#888";
    const s = stats[r] || {};
    const vol = volatility[r];
    return `
      <tr class="legend-row" data-resource="${r}" style="cursor:pointer; border-bottom:1px solid #21262d;">
        <td style="padding:4px;">
          <span style="display:inline-block; width:16px; height:2px; background:${color}; vertical-align:middle; margin-right:4px;"></span>
          <span style="color:${color}; font-weight:600;">${r}</span>
        </td>
        <td style="text-align:right; padding:4px; color:#c9d1d9;">$${s.avg}</td>
        <td style="text-align:right; padding:4px; color:#c9d1d9;">$${s.end}</td>
        <td style="text-align:right; padding:4px; color:#8b949e;" title="Avg absolute price change per turn (volatility)">$${vol}</td>
      </tr>
    `;
  }).join("");

  // Wire row clicks: click isolates that resource + shows its spread.
  // Click again to restore all (spread hidden).
  let isolatedResource = null;

  tbody.querySelectorAll(".legend-row").forEach((row) => {
    row.addEventListener("click", () => {
      if (!chart) return;
      const resource = row.dataset.resource;

      if (isolatedResource === resource) {
        // Already isolated — show all, hide spread
        isolatedResource = null;
        chart.data.datasets.forEach((d, i) => {
          if (d._kind === "avg") chart.setDatasetVisibility(i, true);
          if (d._kind === "spread") chart.setDatasetVisibility(i, false);
        });
        tbody.querySelectorAll(".legend-row").forEach((r) => r.style.opacity = "1");
      } else {
        // Isolate this resource + show its spread
        isolatedResource = resource;
        // Ensure spread datasets exist
        if (!chart.data.datasets.some((d) => d._kind === "spread")) {
          buildSpreadDatasets(chart);
        }
        chart.data.datasets.forEach((d, i) => {
          const match = d._resource === resource;
          if (d._kind === "avg") chart.setDatasetVisibility(i, match);
          if (d._kind === "spread") chart.setDatasetVisibility(i, match);
        });
        tbody.querySelectorAll(".legend-row").forEach((r) => {
          r.style.opacity = r.dataset.resource === resource ? "1" : "0.35";
        });
      }
      chart.update();
    });
  });
}

function renderMarketDynamics() {
  const md = getSource("market_dynamics");
  if (!md) return;
  const allResourcesData = md.resources || md;  // fallback for old format
  const segments = md.segments || {};

  // Populate strategy segment buttons dynamically from the data
  const stratBtnHost = document.getElementById("strategy-segment-buttons");
  if (stratBtnHost) {
    const stratNames = Object.keys(segments).filter(
      (s) => !["all", "winners", "losers"].includes(s)
    );
    const order = ["optimal", "smart", "greedy", "random"];
    stratNames.sort((a, b) => {
      const ai = order.indexOf(a), bi = order.indexOf(b);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });
    stratBtnHost.innerHTML = stratNames.map((s) =>
      `<button class="segment-toggle" data-segment="${s}">${s.charAt(0).toUpperCase() + s.slice(1)}</button>`
    ).join("");
  }

  // Build a normalized data structure for a segment.
  // Segment data uses different keys than the resource-level data,
  // so we map them. PWR is special - segment tracks bills via flow_*.
  function buildSegmentData(segmentKey) {
    if (segmentKey === "all") {
      return allResourcesData;
    }
    const seg = segments[segmentKey];
    if (!seg) return allResourcesData;
    const resourceMap = seg.resources || {};
    // Need to merge with avg_starting/final_price from allResourcesData (segment doesn't have prices)
    const result = {};
    const allResourceKeys = new Set([
      ...Object.keys(allResourcesData),
      ...Object.keys(resourceMap),
    ]);
    for (const r of allResourceKeys) {
      const segR = resourceMap[r] || {
        bought_units: 0,
        sold_units: 0,
        buy_cost: 0,
        sell_revenue: 0,
        futures_units: 0,
        futures_cost: 0,
      };
      const fullR = allResourcesData[r] || {};
      result[r] = {
        avg_trajectory: fullR.avg_trajectory || [],
        avg_starting_price: fullR.avg_starting_price || 0,
        avg_final_price: fullR.avg_final_price || 0,
        total_bought: segR.bought_units + segR.futures_units,
        total_sold: segR.sold_units,
        total_buy_cost: segR.buy_cost + segR.futures_cost,
        total_sell_revenue: segR.sell_revenue,
        futures_debt: segR.futures_cost,
        futures_units: segR.futures_units,
      };
    }
    return result;
  }

  // Line chart: avg trajectory per resource over turns (uses all-segment data).
  // Spread datasets (per-game faint lines) are built lazily on toggle click —
  // see wireMarketSpreadToggle below.
  const resources = Object.keys(allResourcesData);
  const maxLen = Math.max(...resources.map((r) => (allResourcesData[r].avg_trajectory || []).length));
  const labels = Array.from({ length: maxLen }, (_, i) => i === 0 ? "Start" : `Turn ${i}`);

  const datasets = resources.map((r) => ({
    label: r,
    data: allResourcesData[r].avg_trajectory || [],
    borderColor: RESOURCE_COLORS[r] || "#888",
    backgroundColor: "transparent",
    borderWidth: 2,
    tension: 0.2,
    pointRadius: 0,
    _resource: r,
    _kind: "avg",
  }));

  // Compute per-resource stats for the legend table
  const marketStats = {};
  for (const r of resources) {
    const traj = allResourcesData[r].avg_trajectory || [];
    if (traj.length > 0) {
      const avg = traj.reduce((a, b) => a + b, 0) / traj.length;
      const variance = traj.reduce((a, v) => a + (v - avg) ** 2, 0) / traj.length;
      marketStats[r] = {
        avg: avg.toFixed(1),
        std: Math.sqrt(variance).toFixed(1),
        end: allResourcesData[r].avg_final_price?.toFixed(1) || traj[traj.length - 1]?.toFixed(1) || "?",
      };
    } else {
      marketStats[r] = { avg: "?", std: "?", end: "?" };
    }
  }

  chartRegistry["market-trajectory-chart"] = new Chart(document.getElementById("market-trajectory-chart"), {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },  // using custom legend table
      },
      scales: {
        x: {
          title: { display: true, text: "Game Turn", color: "#8b949e" },
          ticks: { color: "#8b949e", maxTicksLimit: 12 },
          grid: { color: "#21262d" },
        },
        y: {
          title: { display: true, text: "Avg Market Price ($)", color: "#8b949e" },
          ticks: { color: "#8b949e" },
          grid: { color: "#21262d" },
        },
      },
    },
  });

  // Build custom legend table with stats
  buildMarketLegendTable(resources, marketStats);

  wireMarketSpreadToggle();

  // Use totals from analysis (computed from full data, not trimmed publish data).
  // Falls back to counting trimmed data if missing.
  let totalGames = md.total_games;
  let totalPlayerGames = md.total_player_games;
  if (!totalGames) {
    totalGames = 0;
    totalPlayerGames = 0;
    for (const s of allData) {
      const games = s.data.games || [];
      totalGames += games.length;
      for (const g of games) {
        totalPlayerGames += (g.players || []).length;
      }
    }
  }

  function renderSegmentSummary(segment, divisor, unitLabel) {
    const el = document.getElementById("segment-summary");
    if (!el) return;
    const seg = segments[segment];
    if (!seg || !seg.totals) {
      el.innerHTML = "";
      return;
    }
    const t = seg.totals;
    const pc = seg.player_count || 1;
    const d = divisor || pc;
    const fmt = (v) => "$" + (v / d).toFixed(1);
    const fmtSigned = (v) => {
      const val = v / d;
      return (val >= 0 ? "+$" : "-$") + Math.abs(val).toFixed(1);
    };
    const fmtN = (v) => (v / d).toFixed(2);

    // Compute cash components from segment resource flows
    const segRes = seg.resources || {};
    let totalSold = 0, totalBought = 0, totalFutures = 0;
    let pwrSold = 0, pwrBought = 0;
    for (const [r, stats] of Object.entries(segRes)) {
      totalSold += stats.sell_revenue || 0;
      totalBought += stats.buy_cost || 0;
      totalFutures += stats.futures_cost || 0;
      if (r === "PWR") {
        pwrSold = stats.sell_revenue || 0;
        pwrBought = stats.buy_cost || 0;
      }
    }
    const marketNonPwrSold = totalSold - pwrSold;
    const marketNonPwrBought = totalBought - pwrBought;
    const pwrNet = pwrSold - pwrBought;

    const nwClass = t.net_worth >= 0 ? "positive" : "negative";
    const pwrClass = pwrNet >= 0 ? "positive" : "negative";

    // Build the income line-item rows
    const row = (label, value, cls, hint = "") => `
      <div style="display:flex; justify-content:space-between; align-items:baseline; padding:6px 0; border-bottom:1px solid #21262d;">
        <span style="color:#8b949e; font-size:0.8rem;">${label}</span>
        <span>
          <span class="${cls}" style="font-weight:600; font-size:0.9rem;">${value}</span>
          ${hint ? `<span style="color:#484f58; font-size:0.7rem; margin-left:6px;">${hint}</span>` : ""}
        </span>
      </div>`;

    el.innerHTML = `
      <div style="background:#161b22; border:1px solid #30363d; border-radius:8px; padding:20px;">
        <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:16px;">
          <h3 style="color:#58a6ff; font-size:1rem; margin:0;">
            Player Income Breakdown
          </h3>
          <span style="color:#8b949e; font-size:0.75rem;">
            ${segment} segment · ${unitLabel} · ${pc.toLocaleString()} player-games
          </span>
        </div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:24px;">
          <div>
            <div style="color:#58a6ff; font-size:0.75rem; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:8px;">
              Cash Flow Sources
            </div>
            ${row("Market Sales (non-PWR)", fmtSigned(marketNonPwrSold), "positive")}
            ${row("Market Buys (non-PWR)", fmtSigned(-marketNonPwrBought), "negative")}
            ${row("PWR (power bills)", fmtSigned(pwrNet), pwrClass)}
            ${row("Futures Settlements", fmtSigned(-totalFutures), "negative")}
          </div>
          <div>
            <div style="color:#58a6ff; font-size:0.75rem; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:8px;">
              Final Position
            </div>
            ${row("Money", fmt(t.money), "positive")}
            ${row("Debt", fmtSigned(-t.debt), "negative")}
            ${row("Contracts Fulfilled", fmt(t.contract_value), "positive", `${fmtN(t.contracts_fulfilled)} contracts`)}
            <div style="display:flex; justify-content:space-between; align-items:baseline; padding:10px 0 0; margin-top:6px; border-top:2px solid #30363d;">
              <span style="color:#c9d1d9; font-size:0.85rem; font-weight:600;">Net Worth</span>
              <span class="${nwClass}" style="font-weight:700; font-size:1.2rem;">${fmt(t.net_worth)}</span>
            </div>
          </div>
        </div>
      </div>`;
  }

  // Render the table for a given view mode + segment
  function renderTable(view, segment) {
    const tbody = document.querySelector("#market-dynamics-table tbody");
    const segmentData = buildSegmentData(segment);
    const sorted = Object.entries(segmentData).sort(
      (a, b) => b[1].avg_final_price - a[1].avg_final_price
    );

    // Determine divisor based on view + segment
    let divisor = 1;
    let valFmt = (v) => v.toLocaleString();
    let cashFmt = (v) => "$" + Math.round(v).toLocaleString();

    // For non-all segments, normalization should use segment player count
    let segPlayerCount = totalPlayerGames;
    if (segment !== "all" && segments[segment]) {
      segPlayerCount = segments[segment].player_count || totalPlayerGames;
    }
    // For per-game in a segment, "games" are roughly player_count / 3 (avg) but
    // we don't track per-segment game count. Use the segment player count for
    // per-game and per-player-game both. Per-player-game is the truer view for segments.
    if (view === "per-game") {
      divisor = totalGames || 1;
      // For non-all segments, scale by what fraction of players are in this segment
      if (segment !== "all") {
        divisor = totalGames * (segPlayerCount / (totalPlayerGames || 1));
        if (divisor < 1) divisor = 1;
      }
      valFmt = (v) => (v / divisor).toFixed(1);
      cashFmt = (v) => "$" + (v / divisor).toFixed(1);
    } else if (view === "per-player-game") {
      divisor = segPlayerCount || 1;
      valFmt = (v) => (v / divisor).toFixed(2);
      cashFmt = (v) => "$" + (v / divisor).toFixed(2);
    }

    // Aggregate totals
    let totBoughtUnits = 0,
      totSoldUnits = 0,
      totFutUnits = 0;
    let totBoughtCash = 0,
      totSoldCash = 0,
      totFutCash = 0;

    const rowsHtml = sorted.map(([r, s]) => {
      const delta = (s.avg_final_price - s.avg_starting_price).toFixed(1);
      const deltaClass = delta >= 0 ? "positive" : "negative";
      const deltaSign = delta >= 0 ? "+" : "";
      const dot = `<span class="resource-dot" style="background:${RESOURCE_COLORS[r] || "#888"}"></span>`;
      const futuresPaid = s.futures_debt || 0;
      const futuresUnits = s.futures_units || 0;
      const boughtUnits = s.total_bought - futuresUnits;
      const boughtCash = s.total_buy_cost - futuresPaid;
      const netFlowCash = s.total_sell_revenue - s.total_buy_cost;
      const netClass = netFlowCash >= 0 ? "positive" : "negative";
      const netSignCash = netFlowCash >= 0 ? "+" : "";
      const netUnits = s.total_sold - boughtUnits - futuresUnits;
      const unitClass = netUnits >= 0 ? "positive" : "negative";
      const unitSign = netUnits > 0 ? "+" : "";
      const avgBuy = boughtUnits > 0 ? boughtCash / boughtUnits : 0;
      const avgSell = s.total_sold > 0 ? s.total_sell_revenue / s.total_sold : 0;
      const avgFut = futuresUnits > 0 ? futuresPaid / futuresUnits : 0;
      const fmtAvg = (v) => (v > 0 ? `$${v.toFixed(2)}` : "-");

      totBoughtUnits += boughtUnits;
      totSoldUnits += s.total_sold;
      totFutUnits += futuresUnits;
      totBoughtCash += boughtCash;
      totSoldCash += s.total_sell_revenue;
      totFutCash += futuresPaid;

      return `<tr>
        <td>${dot}<strong>${r}</strong></td>
        <td>$${s.avg_starting_price}</td>
        <td>$${s.avg_final_price}</td>
        <td class="${deltaClass}">${deltaSign}${delta}</td>
        <td>${valFmt(boughtUnits)}</td>
        <td>${valFmt(s.total_sold)}</td>
        <td>${valFmt(futuresUnits)}</td>
        <td class="${unitClass}">${unitSign}${valFmt(netUnits)}</td>
        <td>${boughtCash > 0 ? `<span class="negative">${cashFmt(boughtCash)}</span>` : "-"}</td>
        <td>${s.total_sell_revenue > 0 ? `<span class="positive">${cashFmt(s.total_sell_revenue)}</span>` : "-"}</td>
        <td>${futuresPaid > 0 ? `<span class="negative">${cashFmt(futuresPaid)}</span>` : "-"}</td>
        <td>${fmtAvg(avgBuy)}</td>
        <td>${fmtAvg(avgSell)}</td>
        <td>${fmtAvg(avgFut)}</td>
        <td class="${netClass}">${netSignCash}${cashFmt(netFlowCash)}</td>
      </tr>`;
    });

    // Totals row
    const totNetUnits = totSoldUnits - totBoughtUnits - totFutUnits;
    const totNetCash = totSoldCash - totBoughtCash - totFutCash;
    const totNetUnitClass = totNetUnits >= 0 ? "positive" : "negative";
    const totNetCashClass = totNetCash >= 0 ? "positive" : "negative";
    const totUnitSign = totNetUnits > 0 ? "+" : "";
    const totCashSign = totNetCash > 0 ? "+" : "";
    rowsHtml.push(`<tr style="border-top:2px solid #30363d; font-weight:700; background:#161b22;">
      <td><strong>TOTAL</strong></td>
      <td>—</td>
      <td>—</td>
      <td>—</td>
      <td>${valFmt(totBoughtUnits)}</td>
      <td>${valFmt(totSoldUnits)}</td>
      <td>${valFmt(totFutUnits)}</td>
      <td class="${totNetUnitClass}">${totUnitSign}${valFmt(totNetUnits)}</td>
      <td><span class="negative">${cashFmt(totBoughtCash)}</span></td>
      <td><span class="positive">${cashFmt(totSoldCash)}</span></td>
      <td><span class="negative">${cashFmt(totFutCash)}</span></td>
      <td>—</td>
      <td>—</td>
      <td>—</td>
      <td class="${totNetCashClass}">${totCashSign}${cashFmt(totNetCash)}</td>
    </tr>`);

    tbody.innerHTML = rowsHtml.join("");

    // Render the segment summary panel (always per-player-game so it's readable)
    if (segments[segment]) {
      renderSegmentSummary(segment, segments[segment].player_count || 1, "per player-game");
    }
  }

  // Sync toggle button active classes with persistent state (handles rerender)
  document.querySelectorAll(".view-toggle").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === mdCurrentView);
  });
  document.querySelectorAll(".segment-toggle").forEach((b) => {
    b.classList.toggle("active", b.dataset.segment === mdCurrentSegment);
  });

  // Initial render
  renderTable(mdCurrentView, mdCurrentSegment);

  // Wire up view toggles
  document.querySelectorAll(".view-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".view-toggle").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      mdCurrentView = btn.dataset.view;
      renderTable(mdCurrentView, mdCurrentSegment);
    });
  });

  // Wire up segment toggles
  document.querySelectorAll(".segment-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".segment-toggle").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      mdCurrentSegment = btn.dataset.segment;
      renderTable(mdCurrentView, mdCurrentSegment);
    });
  });
}

function renderCorporationTable() {
  const data = getSource("corporations");
  if (!data) return;

  const tbody = document.querySelector("#corporation-table tbody");
  const sorted = Object.entries(data).sort((a, b) => b[1].win_rate - a[1].win_rate);

  tbody.innerHTML = sorted
    .map(([name, s]) => {
      const rates = CORP_STARTING_RATES[name] || {};
      const rateStr = Object.entries(rates)
        .map(([r, v]) => {
          const sign = v > 0 ? "+" : "";
          const color = v > 0 ? "#3fb950" : "#f85149";
          return `<span style="color:${color}">${sign}${v} ${r}</span>`;
        })
        .join(" ");
      return `<tr>
        <td><strong>${name}</strong></td>
        <td>${rateStr}</td>
        <td>${s.games}</td>
        <td>${s.wins}</td>
        <td><strong>${(s.win_rate * 100).toFixed(1)}%</strong></td>
        <td>$${s.avg_net_worth}</td>
        <td>$${s.median_net_worth}</td>
        <td>${s.avg_contracts}</td>
      </tr>`;
    })
    .join("");
}

function renderBuildingValueTable() {
  const data = getSource("building_value");
  if (!data) return;

  const table = document.getElementById("building-value-table");
  const tbody = table.querySelector("tbody");
  const entries = Object.entries(data);

  let currentSort = { col: 4, asc: false }; // default: edge desc

  function getSortValue(name, s, colIdx) {
    switch (colIdx) {
      case 0: return name;
      case 1: return s.times_built;
      case 2: return s.winner_pct;
      case 3: return s.loser_pct;
      case 4: return s.edge;
      case 5: return s.avg_builder_net_worth;
      case 6: return s.nw_delta;
      case 7: return s.avg_market_cost;
      default: return 0;
    }
  }

  function renderRows() {
    const sorted = [...entries].sort((a, b) => {
      const va = getSortValue(a[0], a[1], currentSort.col);
      const vb = getSortValue(b[0], b[1], currentSort.col);
      if (typeof va === "string") return currentSort.asc ? va.localeCompare(vb) : vb.localeCompare(va);
      return currentSort.asc ? va - vb : vb - va;
    });

    const signedPct = (v) => {
      const pct = (v * 100).toFixed(1);
      return v >= 0 ? `+${pct}%` : `${pct}%`;
    };
    const signedDollar = (v) => {
      const abs = Math.abs(v).toFixed(0);
      return v >= 0 ? `+$${abs}` : `-$${abs}`;
    };

    tbody.innerHTML = sorted
      .map(([name, s]) => {
        const edgeCls = s.edge > 0 ? "positive" : s.edge < 0 ? "negative" : "";
        const deltaCls = s.nw_delta > 0 ? "positive" : s.nw_delta < 0 ? "negative" : "";
        return `<tr>
          <td>${name}</td>
          <td>${s.times_built}</td>
          <td>${(s.winner_pct * 100).toFixed(1)}%</td>
          <td>${(s.loser_pct * 100).toFixed(1)}%</td>
          <td class="${edgeCls}"><strong>${signedPct(s.edge)}</strong></td>
          <td>$${s.avg_builder_net_worth}</td>
          <td class="${deltaCls}"><strong>${signedDollar(s.nw_delta)}</strong></td>
          <td>$${s.avg_market_cost}</td>
        </tr>`;
      })
      .join("");
  }

  // Sortable headers
  table.querySelectorAll("thead th").forEach((th, idx) => {
    th.style.cursor = "pointer";
    th.addEventListener("click", () => {
      if (currentSort.col === idx) {
        currentSort.asc = !currentSort.asc;
      } else {
        currentSort = { col: idx, asc: false };
      }
      table.querySelectorAll("thead th").forEach((h) => {
        h.textContent = h.textContent.replace(/ [▲▼]$/, "");
      });
      th.textContent += currentSort.asc ? " ▲" : " ▼";
      renderRows();
    });
  });

  renderRows();
}

init();
