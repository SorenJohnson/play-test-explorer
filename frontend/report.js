let data;

const RESOURCE_COLORS = {
  PWR: "#e74c3c",
  H2O: "#2c3e80",
  FE: "#555555",
  C: "#8e44ad",
  SI: "#f1c40f",
  O2: "#bdc3c7",
  FOOD: "#27ae60",
  GLS: "#5dade2",
  ELX: "#e67e22",
};

async function init() {
  const resp = await fetch("data/simulation.json");
  data = await resp.json();

  renderConfig();
  renderStatCards();
  renderNetWorthChart();
  renderContractsChart();
  renderBuildingsChart();
  renderMarketChart();
  renderRatesChart();
  renderGamesTable();
}

function renderConfig() {
  const c = data.config;
  document.getElementById("config-summary").textContent =
    `${c.num_simulations} simulations · ${c.num_players} player(s) · ` +
    `${c.strategy} strategy · $${c.start_money} start · ` +
    `${c.max_turns} turns · market ${c.randomize_market ? "randomized" : "fixed"}`;
}

function renderStatCards() {
  const s = data.summary;
  const container = document.getElementById("stat-cards");

  const nw = s.net_worth_distribution;
  const median = [...nw].sort((a, b) => a - b)[Math.floor(nw.length / 2)];
  const min = Math.min(...nw);
  const max = Math.max(...nw);

  const cards = [
    { label: "Avg Net Worth", value: `$${s.avg_net_worth}`, cls: s.avg_net_worth >= 0 ? "positive" : "negative" },
    { label: "Median Net Worth", value: `$${median}`, cls: median >= 0 ? "positive" : "negative" },
    { label: "Best Game", value: `$${max}`, cls: "positive" },
    { label: "Worst Game", value: `$${min}`, cls: min >= 0 ? "positive" : "negative" },
    { label: "Avg Contracts", value: s.avg_contracts.toFixed(1), cls: "" },
    { label: "Games Played", value: data.config.num_simulations, cls: "" },
  ];

  container.innerHTML = cards
    .map(
      (c) => `
    <div class="stat-card">
      <div class="label">${c.label}</div>
      <div class="value ${c.cls}">${c.value}</div>
    </div>`
    )
    .join("");
}

function renderNetWorthChart() {
  const nw = data.summary.net_worth_distribution;
  const bins = histogram(nw, 15);

  new Chart(document.getElementById("net-worth-chart"), {
    type: "bar",
    data: {
      labels: bins.labels,
      datasets: [
        {
          label: "Net Worth Distribution",
          data: bins.counts,
          backgroundColor: bins.labels.map((l) =>
            parseInt(l) >= 0 ? "#3fb95088" : "#f8514988"
          ),
          borderColor: bins.labels.map((l) =>
            parseInt(l) >= 0 ? "#3fb950" : "#f85149"
          ),
          borderWidth: 1,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: "#8b949e" }, grid: { color: "#21262d" } },
        y: { ticks: { color: "#8b949e" }, grid: { color: "#21262d" } },
      },
    },
  });
}

function renderContractsChart() {
  const contracts = data.summary.contracts_distribution;
  const max = Math.max(...contracts);
  const counts = new Array(max + 1).fill(0);
  contracts.forEach((c) => counts[c]++);

  new Chart(document.getElementById("contracts-chart"), {
    type: "bar",
    data: {
      labels: counts.map((_, i) => i.toString()),
      datasets: [
        {
          label: "Contracts Fulfilled",
          data: counts,
          backgroundColor: "#f0883e88",
          borderColor: "#f0883e",
          borderWidth: 1,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: {
          title: { display: true, text: "Contracts", color: "#8b949e" },
          ticks: { color: "#8b949e" },
          grid: { color: "#21262d" },
        },
        y: {
          title: { display: true, text: "Games", color: "#8b949e" },
          ticks: { color: "#8b949e" },
          grid: { color: "#21262d" },
        },
      },
    },
  });
}

function renderBuildingsChart() {
  const stats = data.building_stats.slice(0, 20);

  new Chart(document.getElementById("buildings-chart"), {
    type: "bar",
    data: {
      labels: stats.map((s) => s.building),
      datasets: [
        {
          label: "Times Played",
          data: stats.map((s) => s.times_played),
          backgroundColor: "#388bfd88",
          borderColor: "#388bfd",
          borderWidth: 1,
        },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: "#8b949e" }, grid: { color: "#21262d" } },
        y: {
          ticks: { color: "#8b949e", font: { size: 11 } },
          grid: { color: "#21262d" },
        },
      },
    },
  });
}

function renderMarketChart() {
  const resources = Object.keys(data.price_stats);
  const means = resources.map((r) => data.price_stats[r].mean);
  const mins = resources.map((r) => data.price_stats[r].min);
  const maxes = resources.map((r) => data.price_stats[r].max);

  new Chart(document.getElementById("market-chart"), {
    type: "bar",
    data: {
      labels: resources,
      datasets: [
        {
          label: "Min",
          data: mins,
          backgroundColor: resources.map((r) => RESOURCE_COLORS[r] + "44"),
          borderColor: resources.map((r) => RESOURCE_COLORS[r]),
          borderWidth: 1,
        },
        {
          label: "Mean",
          data: means,
          backgroundColor: resources.map((r) => RESOURCE_COLORS[r] + "88"),
          borderColor: resources.map((r) => RESOURCE_COLORS[r]),
          borderWidth: 1,
        },
        {
          label: "Max",
          data: maxes,
          backgroundColor: resources.map((r) => RESOURCE_COLORS[r] + "cc"),
          borderColor: resources.map((r) => RESOURCE_COLORS[r]),
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: "#8b949e" } } },
      scales: {
        x: { ticks: { color: "#8b949e" }, grid: { color: "#21262d" } },
        y: {
          title: { display: true, text: "Price ($)", color: "#8b949e" },
          ticks: { color: "#8b949e" },
          grid: { color: "#21262d" },
        },
      },
    },
  });
}

function renderRatesChart() {
  const resources = Object.keys(data.rate_stats);
  const means = resources.map((r) => data.rate_stats[r].mean);

  new Chart(document.getElementById("rates-chart"), {
    type: "bar",
    data: {
      labels: resources,
      datasets: [
        {
          label: "Avg Final Rate",
          data: means.map((v) => parseFloat(v.toFixed(1))),
          backgroundColor: resources.map((r) =>
            (RESOURCE_COLORS[r] || "#888") + "88"
          ),
          borderColor: resources.map((r) => RESOURCE_COLORS[r] || "#888"),
          borderWidth: 1,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: "#8b949e" }, grid: { color: "#21262d" } },
        y: {
          title: { display: true, text: "Rate", color: "#8b949e" },
          ticks: { color: "#8b949e" },
          grid: { color: "#21262d" },
        },
      },
    },
  });
}

function renderGamesTable() {
  const tbody = document.querySelector("#games-table tbody");

  const sorted = [...data.games].sort((a, b) => b.net_worth - a.net_worth);

  tbody.innerHTML = sorted
    .map(
      (g) => `
    <tr class="clickable" data-game="${g.game_id}">
      <td>#${g.game_id + 1}</td>
      <td style="color:${g.net_worth >= 0 ? "#3fb950" : "#f85149"}">$${g.net_worth}</td>
      <td>$${g.money}</td>
      <td>$${g.debt}</td>
      <td>${g.contracts_fulfilled}</td>
      <td>${g.buildings_played.length}</td>
      <td>${g.turn_count}</td>
    </tr>`
    )
    .join("");

  tbody.querySelectorAll("tr.clickable").forEach((row) => {
    row.addEventListener("click", () => {
      const gameId = parseInt(row.dataset.game);
      showGameDetail(data.games[gameId]);
    });
  });
}

function showGameDetail(game) {
  const section = document.getElementById("game-detail");
  const content = document.getElementById("game-detail-content");
  section.style.display = "block";

  const rates = Object.entries(game.final_rates)
    .filter(([, v]) => v !== 0)
    .map(([r, v]) => `${r}: ${v > 0 ? "+" : ""}${v}`)
    .join(", ");

  const market = Object.entries(game.final_market)
    .map(([r, p]) => `${r}: $${p}`)
    .join(", ");

  // Building frequency in this game
  const buildFreq = {};
  game.buildings_played.forEach((b) => (buildFreq[b] = (buildFreq[b] || 0) + 1));
  const buildList = Object.entries(buildFreq)
    .sort((a, b) => b[1] - a[1])
    .map(([b, c]) => `${b} (${c}x)`)
    .join(", ");

  content.innerHTML = `
    <div class="detail-grid">
      <div class="detail-section">
        <h3>Final State</h3>
        <p>Net Worth: $${game.net_worth} (Money: $${game.money}, Debt: $${game.debt})</p>
        <p>Contracts: ${game.contracts_fulfilled}</p>
        <p>Rates: ${rates || "all zero"}</p>
        <p>Market: ${market}</p>
      </div>
      <div class="detail-section">
        <h3>Buildings (${game.buildings_played.length})</h3>
        <p>${buildList || "none"}</p>
      </div>
    </div>`;

  section.scrollIntoView({ behavior: "smooth" });
}

// Utility: simple histogram
function histogram(values, numBins) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const binSize = Math.ceil(range / numBins);
  const counts = new Array(numBins).fill(0);
  const labels = [];

  for (let i = 0; i < numBins; i++) {
    labels.push((min + i * binSize).toString());
  }

  values.forEach((v) => {
    const bin = Math.min(Math.floor((v - min) / binSize), numBins - 1);
    counts[bin]++;
  });

  return { labels, counts };
}

init();
