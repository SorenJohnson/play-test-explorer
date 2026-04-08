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
    renderCorporationTable();
    renderBuildingValueTable();
    renderContractCostChart();
    renderStrategyContractTable();
    renderContractSelector();
    renderFlowNetwork();
  }
  renderGameBrowser();
  renderMarketChart();
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

// --- Contract Cost Box Plots ---

function renderContractCostChart() {
  const contracts = analysisData.sim_contract_costs;
  if (!contracts) return;

  const sorted = Object.entries(contracts).sort(
    (a, b) => a[1].gross_cost.median - b[1].gross_cost.median
  );

  new Chart(document.getElementById("contract-cost-chart"), {
    type: "boxplot",
    data: {
      labels: sorted.map(([l]) => l),
      datasets: [
        {
          label: "Gross Cost (total invested)",
          backgroundColor: "#f8514933",
          borderColor: "#f85149",
          data: sorted.map(([, s]) => s.gross_cost.values),
        },
        {
          label: "Net Cost (after sell revenue)",
          backgroundColor: "#3fb95033",
          borderColor: "#3fb950",
          data: sorted.map(([, s]) => s.true_cost.values),
        },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { title: { display: true, text: "$ Spent", color: "#8b949e" }, ticks: { color: "#8b949e" }, grid: { color: "#21262d" } },
        y: { ticks: { color: "#8b949e", font: { size: 9 } }, grid: { color: "#21262d" } },
      },
    },
  });
}

// --- Contract Cost by Strategy ---

function renderStrategyContractTable() {
  const contracts = analysisData.sim_contract_costs;
  if (!contracts) return;

  const table = document.getElementById("strategy-contract-table");
  const tbody = table.querySelector("tbody");
  const entries = Object.entries(contracts);

  let currentSort = { col: 2, asc: true }; // default: gross cost ascending

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

  function renderRows() {
    const sorted = [...entries].sort((a, b) => {
      const va = getSortValue(a[0], a[1], currentSort.col);
      const vb = getSortValue(b[0], b[1], currentSort.col);
      if (typeof va === "string") return currentSort.asc ? va.localeCompare(vb) : vb.localeCompare(va);
      return currentSort.asc ? va - vb : vb - va;
    });

    tbody.innerHTML = sorted.map(([label, stats]) => {
      const smart = stats.by_strategy?.smart;
      const greedy = stats.by_strategy?.greedy;
      const random = stats.by_strategy?.random;
      return `<tr>
        <td>${label}</td>
        <td>${stats.count}</td>
        <td>$${stats.gross_cost.mean}</td>
        <td>$${stats.true_cost.mean}</td>
        <td>${smart ? `$${smart.mean} (n=${smart.count})` : "-"}</td>
        <td>${greedy ? `$${greedy.mean} (n=${greedy.count})` : "-"}</td>
        <td>${random ? `$${random.mean} (n=${random.count})` : "-"}</td>
      </tr>`;
    }).join("");
  }

  // Make headers clickable for sorting
  table.querySelectorAll("thead th").forEach((th, idx) => {
    th.style.cursor = "pointer";
    th.addEventListener("click", () => {
      if (currentSort.col === idx) {
        currentSort.asc = !currentSort.asc;
      } else {
        currentSort = { col: idx, asc: true };
      }
      // Update header indicators
      table.querySelectorAll("thead th").forEach((h) => h.textContent = h.textContent.replace(/ [▲▼]$/, ""));
      th.textContent += currentSort.asc ? " ▲" : " ▼";
      renderRows();
    });
  });

  renderRows();
}

// --- Build Path Selector ---

function renderContractSelector() {
  const contracts = analysisData.sim_contract_costs;
  if (!contracts) return;

  const container = document.getElementById("contract-selector");
  const sorted = Object.entries(contracts).sort((a, b) => b[1].count - a[1].count);

  const buttons = sorted.map(([label, stats]) =>
    `<button class="contract-btn" data-label="${label}">${label} <span style="color:#8b949e">(${stats.count})</span></button>`
  );
  container.innerHTML = `<div style="display:flex; flex-wrap:wrap; gap:6px; margin-bottom:16px">${buttons.join("")}</div>`;

  container.querySelectorAll(".contract-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      container.querySelectorAll(".contract-btn").forEach((b) => b.style.borderColor = "#30363d");
      btn.style.borderColor = "#58a6ff";
      showBuildPath(btn.dataset.label);
    });
  });

  // Show first contract by default
  if (sorted.length > 0) {
    showBuildPath(sorted[0][0]);
    container.querySelector(".contract-btn").style.borderColor = "#58a6ff";
  }
}

function showBuildPath(contractLabel) {
  const stats = analysisData.sim_contract_costs[contractLabel];
  if (!stats) return;

  const detail = document.getElementById("build-path-detail");
  const buildings = stats.top_buildings || [];
  const rates = stats.avg_rates_at_fulfillment || {};

  const buildingRows = buildings.map((b) =>
    `<tr>
      <td>${b.building}</td>
      <td>${b.count}</td>
      <td>${b.rate.toFixed(1)}</td>
    </tr>`
  ).join("");

  const rateEntries = Object.entries(rates)
    .filter(([, v]) => Math.abs(v) >= 0.1)
    .sort((a, b) => b[1] - a[1])
    .map(([r, v]) => `<span style="color:${RESOURCE_COLORS[r] || '#888'}">${r}: ${v > 0 ? "+" : ""}${v}</span>`)
    .join("&nbsp;&nbsp;");

  detail.innerHTML = `
    <div style="background:#161b22; border:1px solid #30363d; border-radius:8px; padding:16px; font-size:0.85rem;">
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:24px;">
        <div>
          <h3 style="color:#58a6ff; margin-bottom:8px;">Buildings Played Before This Contract</h3>
          <p style="color:#8b949e; margin-bottom:8px;">How often each building appeared in the build path (since last contract)</p>
          <table style="width:100%">
            <thead><tr><th>Building</th><th>Times</th><th>Avg / Contract</th></tr></thead>
            <tbody>${buildingRows || "<tr><td colspan='3'>No data</td></tr>"}</tbody>
          </table>
        </div>
        <div>
          <h3 style="color:#58a6ff; margin-bottom:8px;">Avg Rate Profile at Fulfillment</h3>
          <p style="color:#8b949e; margin-bottom:8px;">What rates players typically had when they fulfilled this contract</p>
          <div style="line-height:2">${rateEntries || "No data"}</div>
          <div style="margin-top:16px;">
            <div class="detail-row"><span class="detail-label">Avg true cost:</span> <span class="detail-value">$${stats.true_cost.mean}</span></div>
            <div class="detail-row"><span class="detail-label">Median:</span> <span class="detail-value">$${stats.true_cost.median}</span></div>
            <div class="detail-row"><span class="detail-label">Net profit (avg):</span> <span class="detail-value">$${(50 - stats.true_cost.mean).toFixed(1)}</span></div>
          </div>
        </div>
      </div>
    </div>`;
}

// --- Rate Profiles at Fulfillment ---

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

// --- Market Prices ---

function renderMarketChart() {
  const resources = Object.keys(allData[0].data.price_stats);

  const datasets = allData.map((s) => ({
    label: s.label,
    backgroundColor: s.color + "44",
    borderColor: s.color,
    data: resources.map((r) => s.data.price_stats[r].values),
  }));

  new Chart(document.getElementById("market-chart"), {
    type: "boxplot",
    data: { labels: resources, datasets },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: "#8b949e" } } },
      scales: {
        x: { ticks: { color: "#8b949e" }, grid: { color: "#21262d" } },
        y: { title: { display: true, text: "Final Price ($)", color: "#8b949e" }, ticks: { color: "#8b949e" }, grid: { color: "#21262d" } },
      },
    },
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
