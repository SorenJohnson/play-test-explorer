const SCENARIOS = [
  { file: "data/sim_3random.json", label: "3 Random", color: "#f85149" },
  { file: "data/sim_1smart.json", label: "1 Smart + 2R", color: "#f0883e" },
  { file: "data/sim_smart_greedy_random.json", label: "Smart+Greedy+R", color: "#58a6ff" },
  { file: "data/sim_3greedy.json", label: "3 Greedy", color: "#a371f7" },
  { file: "data/sim_3smart.json", label: "3 Smart", color: "#3fb950" },
];

const RESOURCE_COLORS = {
  PWR: "#e74c3c", H2O: "#2c3e80", FE: "#555555", C: "#8e44ad",
  SI: "#f1c40f", O2: "#bdc3c7", FOOD: "#27ae60", GLS: "#5dade2", ELX: "#e67e22",
};

let allData = [];
let analysisData = null;

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

  renderStrategyChart();
  if (analysisData) {
    renderMarketDynamics();
    renderCorporationTable();
    renderBuildingValueTable();
    renderStrategyContractTable();
    renderFlowNetwork();
  }
  renderGameBrowser();
}

// --- Strategy Performance ---

function renderStrategyChart() {
  const labels = [];
  const greedyData = [], smartData = [], randomData = [];

  for (const s of allData) {
    labels.push(s.label);
    const byStrat = { greedy: [], random: [], smart: [] };
    for (const g of s.data.games) {
      for (const p of g.players) {
        if (byStrat[p.strategy]) byStrat[p.strategy].push(p.net_worth);
      }
    }
    smartData.push(byStrat.smart.length > 0 ? byStrat.smart : null);
    greedyData.push(byStrat.greedy.length > 0 ? byStrat.greedy : null);
    randomData.push(byStrat.random.length > 0 ? byStrat.random : null);
  }

  const datasets = [
    { label: "Smart", backgroundColor: "#3fb95044", borderColor: "#3fb950", data: smartData },
    { label: "Greedy", backgroundColor: "#58a6ff44", borderColor: "#58a6ff", data: greedyData },
    { label: "Random", backgroundColor: "#f8514944", borderColor: "#f85149", data: randomData },
  ].filter((ds) => ds.data.some((d) => d !== null));

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

// --- Contract Economics (sortable + expandable) ---

function renderStrategyContractTable() {
  const contracts = analysisData.sim_contract_costs;
  if (!contracts) return;

  const table = document.getElementById("strategy-contract-table");
  const tbody = table.querySelector("tbody");
  const entries = Object.entries(contracts);

  let currentSort = { col: 2, asc: true }; // default: gross cost ascending
  const expandedRows = new Set();

  function getSortValue(label, stats, colIdx) {
    const smart = stats.by_strategy?.smart;
    const greedy = stats.by_strategy?.greedy;
    const random = stats.by_strategy?.random;
    switch (colIdx) {
      case 0: return label;
      case 1: return stats.count;
      case 2: return stats.gross_cost.mean;
      case 3: return stats.true_cost.mean;
      case 4: return smart?.mean ?? 999;
      case 5: return greedy?.mean ?? 999;
      case 6: return random?.mean ?? 999;
      default: return 0;
    }
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
      const smart = stats.by_strategy?.smart;
      const greedy = stats.by_strategy?.greedy;
      const random = stats.by_strategy?.random;
      const expanded = expandedRows.has(label);
      const arrow = expanded ? "▼" : "▶";
      rows.push(
        `<tr class="contract-row" data-label="${label}" style="cursor:pointer;">
          <td>${arrow} ${label}</td>
          <td>${stats.count}</td>
          <td>$${stats.gross_cost.mean}</td>
          <td>$${stats.true_cost.mean}</td>
          <td>${smart ? `$${smart.mean} (n=${smart.count})` : "-"}</td>
          <td>${greedy ? `$${greedy.mean} (n=${greedy.count})` : "-"}</td>
          <td>${random ? `$${random.mean} (n=${random.count})` : "-"}</td>
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

    let games = scenario.data.games.map((g, i) => ({ ...g, _idx: i, _file: scenario.file }));

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

        return `<tr>
          <td>#${g._idx + 1}</td>
          ${nwCells}
          <td>${totalContracts}</td>
          <td>${g.turn_count}</td>
          <td><a href="game.html?file=${g._file}&game=${g._idx}" style="color:#58a6ff; font-size:0.75rem">Inspect →</a></td>
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
};

function renderMarketDynamics() {
  const md = analysisData.market_dynamics;
  if (!md) return;
  const data = md.resources || md;  // fallback for old format

  // Line chart: avg trajectory per resource over turns
  const resources = Object.keys(data);
  const maxLen = Math.max(...resources.map((r) => data[r].avg_trajectory.length));
  const labels = Array.from({ length: maxLen }, (_, i) => `Turn ${i + 1}`);

  const datasets = resources.map((r) => ({
    label: r,
    data: data[r].avg_trajectory,
    borderColor: RESOURCE_COLORS[r] || "#888",
    backgroundColor: "transparent",
    borderWidth: 2,
    tension: 0.2,
    pointRadius: 0,
  }));

  new Chart(document.getElementById("market-trajectory-chart"), {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: "#8b949e", font: { size: 11 } } },
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

  // Compute totals for normalization
  let totalGames = 0;
  let totalPlayerGames = 0;
  for (const s of allData) {
    const games = s.data.games || [];
    totalGames += games.length;
    for (const g of games) {
      totalPlayerGames += (g.players || []).length;
    }
  }

  // Render the table for a given view mode
  function renderTable(view) {
    const tbody = document.querySelector("#market-dynamics-table tbody");
    const sorted = Object.entries(data).sort(
      (a, b) => b[1].avg_final_price - a[1].avg_final_price
    );

    let divisor = 1;
    let valFmt = (v) => v.toLocaleString();
    let cashFmt = (v) => "$" + Math.round(v).toLocaleString();
    if (view === "per-game") {
      divisor = totalGames || 1;
      valFmt = (v) => (v / divisor).toFixed(1);
      cashFmt = (v) => "$" + (v / divisor).toFixed(1);
    } else if (view === "per-player-game") {
      divisor = totalPlayerGames || 1;
      valFmt = (v) => (v / divisor).toFixed(2);
      cashFmt = (v) => "$" + (v / divisor).toFixed(2);
    }

    tbody.innerHTML = sorted
      .map(([r, s]) => {
        const delta = (s.avg_final_price - s.avg_starting_price).toFixed(1);
        const deltaClass = delta >= 0 ? "positive" : "negative";
        const deltaSign = delta >= 0 ? "+" : "";
        const dot = `<span class="resource-dot" style="background:${RESOURCE_COLORS[r] || "#888"}"></span>`;
        const marketImpact = s.total_sell_revenue - s.total_buy_cost;
        const impactClass = marketImpact >= 0 ? "positive" : "negative";
        const impactSign = marketImpact >= 0 ? "+" : "";
        const futuresPaid = s.futures_debt || 0;
        const netFlow = s.net_flow;
        const netSign = netFlow > 0 ? "+" : "";
        return `<tr>
          <td>${dot}<strong>${r}</strong></td>
          <td>$${s.avg_starting_price}</td>
          <td>$${s.avg_final_price}</td>
          <td class="${deltaClass}">${deltaSign}${delta}</td>
          <td>${valFmt(s.total_bought)}</td>
          <td>${valFmt(s.total_sold)}</td>
          <td>${netSign}${valFmt(netFlow)}</td>
          <td>${cashFmt(s.total_buy_cost)}</td>
          <td>${cashFmt(s.total_sell_revenue)}</td>
          <td>${futuresPaid > 0 ? `<span class="negative">${cashFmt(futuresPaid)}</span>` : "-"}</td>
          <td class="${impactClass}">${impactSign}${cashFmt(marketImpact)}</td>
        </tr>`;
      })
      .join("");
  }

  // Initial render
  renderTable("totals");

  // Wire up view toggles
  document.querySelectorAll(".view-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".view-toggle").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      renderTable(btn.dataset.view);
    });
  });
}

function renderCorporationTable() {
  const data = analysisData.corporations;
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
  const data = analysisData.building_value;
  if (!data) return;

  const table = document.getElementById("building-value-table");
  const tbody = table.querySelector("tbody");
  const entries = Object.entries(data);

  let currentSort = { col: 4, asc: false }; // default: win_rate desc

  function getSortValue(name, s, colIdx) {
    switch (colIdx) {
      case 0: return name;
      case 1: return s.times_built;
      case 2: return s.games_built_in;
      case 3: return s.games_winner_built;
      case 4: return s.win_rate;
      case 5: return s.avg_builder_net_worth;
      case 6: return s.avg_market_cost;
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

    tbody.innerHTML = sorted
      .map(([name, s]) => {
        const winPct = (s.win_rate * 100).toFixed(1);
        return `<tr>
          <td>${name}</td>
          <td>${s.times_built}</td>
          <td>${s.games_built_in}</td>
          <td>${s.games_winner_built}</td>
          <td><strong>${winPct}%</strong></td>
          <td>$${s.avg_builder_net_worth}</td>
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
