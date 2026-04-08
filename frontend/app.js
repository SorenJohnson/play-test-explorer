let cy;
let networkData;

async function init() {
  const resp = await fetch("data/network.json");
  networkData = await resp.json();

  renderGraph(true);
  populateTable();
  setupControls();
}

function getResourceNodes() {
  return networkData.nodes.filter((n) => n.data.type === "resource");
}

function getContractNodes() {
  return networkData.nodes.filter((n) => n.data.type === "contract");
}

function getBuildEdges() {
  return networkData.edges.filter((e) => e.data.relationship === "build_cost");
}

function getContractEdges() {
  return networkData.edges.filter(
    (e) => e.data.relationship === "contract_requires"
  );
}

function renderGraph(showContracts) {
  const elements = [];

  // Resource nodes — always shown
  for (const n of getResourceNodes()) {
    elements.push({ group: "nodes", data: { ...n.data } });
  }

  // Build cost edges — always shown
  for (const e of getBuildEdges()) {
    elements.push({ group: "edges", data: { ...e.data } });
  }

  // Contracts
  if (showContracts) {
    for (const n of getContractNodes()) {
      elements.push({ group: "nodes", data: { ...n.data } });
    }
    for (const e of getContractEdges()) {
      elements.push({ group: "edges", data: { ...e.data } });
    }
  }

  if (cy) cy.destroy();

  cy = cytoscape({
    container: document.getElementById("cy"),
    elements,
    style: getStyles(),
    layout: getLayout(),
    minZoom: 0.3,
    maxZoom: 3,
  });

  setupInteractions();
}

function getStyles() {
  // Find max edge weight for scaling
  const maxWeight = Math.max(
    ...getBuildEdges().map((e) => e.data.total_cost_units),
    1
  );

  return [
    // Resource nodes
    {
      selector: 'node[type="resource"]',
      style: {
        label: "data(label)",
        "background-color": "data(color)",
        width: function (ele) {
          const d = ele.data();
          const size = Math.max(d.total_build_demand, d.total_production, 10);
          return 30 + Math.sqrt(size) * 8;
        },
        height: function (ele) {
          const d = ele.data();
          const size = Math.max(d.total_build_demand, d.total_production, 10);
          return 30 + Math.sqrt(size) * 8;
        },
        "font-size": "14px",
        "font-weight": "bold",
        color: "#fff",
        "text-valign": "center",
        "text-halign": "center",
        "text-outline-color": "#000",
        "text-outline-width": 2,
        "border-width": function (ele) {
          return ele.data("contract_demand") > 0 ? 3 : 1;
        },
        "border-color": function (ele) {
          return ele.data("contract_demand") > 0 ? "#f0883e" : "#30363d";
        },
      },
    },
    // Contract nodes
    {
      selector: 'node[type="contract"]',
      style: {
        shape: "round-rectangle",
        "background-color": "#238636",
        label: function (ele) {
          return "$" + ele.data("reward");
        },
        width: 40,
        height: 30,
        "font-size": "10px",
        color: "#fff",
        "text-valign": "center",
        "text-halign": "center",
        "text-outline-color": "#000",
        "text-outline-width": 1,
        opacity: 0.7,
      },
    },
    // Build cost edges
    {
      selector: 'edge[relationship="build_cost"]',
      style: {
        width: function (ele) {
          return 1 + (ele.data("total_cost_units") / maxWeight) * 10;
        },
        "line-color": "#388bfd",
        "target-arrow-color": "#388bfd",
        "target-arrow-shape": "triangle",
        "curve-style": "bezier",
        opacity: 0.6,
        label: function (ele) {
          const cost = ele.data("total_cost_units");
          const prod = ele.data("total_produced_units");
          return cost + "→" + prod;
        },
        "font-size": "9px",
        color: "#8b949e",
        "text-rotation": "autorotate",
        "text-margin-y": -10,
        "text-outline-color": "#0d1117",
        "text-outline-width": 2,
      },
    },
    // Contract requirement edges
    {
      selector: 'edge[relationship="contract_requires"]',
      style: {
        width: function (ele) {
          return 0.5 + ele.data("weight");
        },
        "line-color": "#f0883e",
        "target-arrow-color": "#f0883e",
        "target-arrow-shape": "triangle",
        "curve-style": "bezier",
        "line-style": "dashed",
        opacity: 0.3,
      },
    },
    // Highlighted
    {
      selector: ".highlighted",
      style: {
        opacity: 1,
        "z-index": 10,
      },
    },
    {
      selector: ".faded",
      style: {
        opacity: 0.08,
      },
    },
  ];
}

function getLayout() {
  return {
    name: "dagre",
    rankDir: "LR",
    nodeSep: 30,
    rankSep: 100,
    edgeSep: 10,
    animate: true,
    animationDuration: 400,
    // Rank by build demand — most consumed on left
    rank: function (node) {
      const d = node.data();
      if (d.type === "contract") return 100; // far right
      // Invert rank so highest demand = lowest rank number = leftmost
      return 10 - d.rank;
    },
  };
}

function setupInteractions() {
  const tooltip = document.getElementById("tooltip");
  const panel = document.getElementById("info-panel");

  // Hover tooltips
  cy.on("mouseover", "node", (e) => {
    const d = e.target.data();
    let html;

    if (d.type === "resource") {
      html =
        `<strong>${d.label}</strong><br>` +
        `Build demand: ${d.total_build_demand}<br>` +
        `Production: ${d.total_production}<br>` +
        `Contract demand: ${d.contract_demand}`;
    } else {
      html = `<strong>Contract: ${d.label}</strong><br>Reward: $${d.reward}`;
    }

    tooltip.innerHTML = html;
    tooltip.style.display = "block";
  });

  cy.on("mouseover", "edge", (e) => {
    const d = e.target.data();
    let html;

    if (d.relationship === "build_cost") {
      html =
        `<strong>${d.source} → ${d.target}</strong><br>` +
        `Total build cost: ${d.total_cost_units} ${d.source}<br>` +
        `Total produced: ${d.total_produced_units} ${d.target}<br>` +
        `Buildings: ${d.buildings.join(", ")}`;
    } else {
      html = `Requires ${d.weight} ${d.source}`;
    }

    tooltip.innerHTML = html;
    tooltip.style.display = "block";
  });

  cy.on("mousemove", (e) => {
    if (e.originalEvent) {
      tooltip.style.left = e.originalEvent.clientX + 14 + "px";
      tooltip.style.top = e.originalEvent.clientY + 14 + "px";
    }
  });

  cy.on("mouseout", "node, edge", () => {
    tooltip.style.display = "none";
  });

  // Click to highlight connected subgraph
  cy.on("tap", "node", (e) => {
    const node = e.target;
    const connected = node.closedNeighborhood();

    cy.elements().addClass("faded");
    connected.removeClass("faded").addClass("highlighted");

    showNodeInfo(node.data());
  });

  cy.on("tap", "edge", (e) => {
    const edge = e.target;
    const connected = edge.connectedNodes().add(edge);

    cy.elements().addClass("faded");
    connected.removeClass("faded").addClass("highlighted");

    showEdgeInfo(edge.data());
  });

  // Click background to reset
  cy.on("tap", (e) => {
    if (e.target === cy) {
      cy.elements().removeClass("faded highlighted");
      panel.innerHTML = '<p class="hint">Click a node or edge for details</p>';
    }
  });
}

function showNodeInfo(d) {
  const panel = document.getElementById("info-panel");

  if (d.type === "resource") {
    panel.innerHTML = `
      <div class="detail-row">
        <span class="detail-label">Resource</span>
        <span class="detail-value">
          <span class="resource-dot" style="background:${d.color}"></span>${d.label}
        </span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Build demand</span>
        <span class="detail-value">${d.total_build_demand}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Production</span>
        <span class="detail-value">${d.total_production}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Contract demand</span>
        <span class="detail-value">${d.contract_demand}</span>
      </div>`;
  } else {
    const reqs = d.requirements.map((r) => `${r.amount} ${r.resource}`).join(" + ");
    panel.innerHTML = `
      <div class="detail-row">
        <span class="detail-label">Contract</span>
        <span class="detail-value">$${d.reward}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Requires</span>
        <span class="detail-value">${reqs}</span>
      </div>`;
  }
}

function showEdgeInfo(d) {
  const panel = document.getElementById("info-panel");

  if (d.relationship === "build_cost") {
    let buildingsHtml = "";
    for (const b of d.building_details) {
      const negRates =
        b.negative_rates.length > 0
          ? ` (${b.negative_rates.map((r) => `-${r.amount} ${r.resource}`).join(", ")})`
          : "";
      buildingsHtml += `
        <div class="building-item">
          <strong>${b.name}</strong> (${b.copies}x)<br>
          Cost: ${b.cost} ${d.source} → Produces: ${b.produces} ${d.target}${negRates}
        </div>`;
    }

    const ratio = (d.total_produced_units / d.total_cost_units).toFixed(1);

    panel.innerHTML = `
      <div class="detail-row">
        <span class="detail-label">Edge</span>
        <span class="detail-value">${d.source} → ${d.target}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Total cost</span>
        <span class="detail-value">${d.total_cost_units} ${d.source}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Total produced</span>
        <span class="detail-value">${d.total_produced_units} ${d.target}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Efficiency</span>
        <span class="detail-value">${ratio}x</span>
      </div>
      <div class="building-list">
        ${buildingsHtml}
      </div>`;
  } else {
    panel.innerHTML = `
      <div class="detail-row">
        <span class="detail-label">Contract requires</span>
        <span class="detail-value">${d.weight} ${d.source}</span>
      </div>`;
  }
}

function populateTable() {
  const tbody = document.getElementById("resource-tbody");
  const resources = getResourceNodes()
    .map((n) => n.data)
    .sort((a, b) => b.total_build_demand - a.total_build_demand);

  tbody.innerHTML = resources
    .map(
      (r) => `
    <tr>
      <td><span class="resource-dot" style="background:${r.color}"></span>${r.label}</td>
      <td>${r.total_build_demand}</td>
      <td>${r.total_production}</td>
      <td>${r.contract_demand || "-"}</td>
    </tr>`
    )
    .join("");
}

function setupControls() {
  document.getElementById("show-contracts").addEventListener("change", (e) => {
    renderGraph(e.target.checked);
  });
}

init();
