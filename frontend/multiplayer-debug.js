// ===== Debug Panel — driven entirely by Python action_log =====
//
// Wrapped in an IIFE so internal state (debugPanelOpen, debugStep) stays
// private. Public API is exposed on MP.debug.
// Depends on: window.MP (for MP.game, MP.currentState); RESOURCE_ORDER and
// PLAYER_COLORS globals declared in multiplayer.js (available at callback
// time since listeners only fire after all scripts have loaded).

(function () {
  const MP = window.MP = window.MP || {};

  let debugPanelOpen = false;
  let debugStep = -1; // -1 = live (latest)

  document.addEventListener("keydown", (e) => {
    if (e.key === "`" || (e.ctrlKey && e.key === "d")) {
      e.preventDefault();
      toggleDebugPanel();
    }
  });

  function toggleDebugPanel() {
    debugPanelOpen = !debugPanelOpen;
    const panel = document.getElementById("debug-panel");
    if (panel) panel.style.display = debugPanelOpen ? "block" : "none";
    if (debugPanelOpen) updateDebugPanel();
  }

  function _getActionLog() {
    // Live from Python MP.game object, or from last received state for clients
    if (MP.game) {
      try {
        const s = MP.game.state_dict().toJs({dict_converter: Object.fromEntries});
        return s.action_log || [];
      } catch (e) { /* fall through */ }
    }
    return MP.currentState?.action_log || [];
  }

  function updateDebugPanel() {
    const actionLog = _getActionLog();
    const total = actionLog.length;
    const step = debugStep >= 0 ? Math.min(debugStep, total - 1) : total - 1;
    const isLive = debugStep < 0;

    document.getElementById("debug-step-label").textContent = `${step + 1} / ${total}`;
    const slider = document.getElementById("debug-slider");
    slider.max = Math.max(0, total - 1);
    slider.value = step;

    document.getElementById("debug-replay-indicator").style.display = isLive ? "none" : "inline";
    document.getElementById("debug-live").style.display = isLive ? "none" : "inline";

    // Step header
    const info = document.getElementById("debug-step-info");
    const a = actionLog[step];
    if (a) {
      const cls = _mutTypeClass(a.type);
      const pColor = a.player_idx >= 0 ? PLAYER_COLORS[a.player_idx % PLAYER_COLORS.length] : "var(--text-muted)";
      const playerLabel = a.player || "GLOBAL";
      info.innerHTML = `
        <div><strong>#${a.id}</strong> <span class="mut-type ${cls}">${a.type}</span> <span style="color:${pColor}">${playerLabel}</span></div>
        <div style="margin-top:4px;color:var(--text-primary)">${a.summary}</div>
      `;
    } else {
      info.innerHTML = "<div>No data</div>";
    }

    // Content: mutations + metadata + snapshot for the current entry
    const container = document.getElementById("debug-content");
    if (!container) return;
    if (!a) { container.innerHTML = '<div style="color:var(--text-dim);padding:12px">No actions yet.</div>'; return; }

    // Replay state up to current step
    const tracker = new StateTracker();
    for (let i = 0; i <= step; i++) {
      tracker.applyAction(actionLog[i]);
    }

    const html = [];

    // Mutations
    if (a.mutations?.length) {
      for (const m of a.mutations) {
        html.push(`<div><span class="mut-field">${m.field}</span> <span class="mut-old">${formatMutValue(m.old)}</span> <span class="mut-arrow">\u2192</span> <span class="mut-new">${formatMutValue(m.new)}</span></div>`);
      }
    } else {
      html.push('<div style="color:var(--text-subtle);font-size:0.68rem">No mutations</div>');
    }

    // Metadata
    const meta = a.metadata;
    if (meta && Object.keys(meta).length > 0) {
      html.push('<div class="mut-metadata">');
      for (const [key, val] of Object.entries(meta)) {
        html.push(`<div><span class="mut-meta-key">${key}:</span> ${formatMetaValue(val)}</div>`);
      }
      html.push('</div>');
    }

    // Snapshot
    html.push(tracker.renderSnapshot());

    container.innerHTML = html.join("");
  }

  function _mutTypeClass(type) {
    if (type.startsWith("event")) return "event";
    if (type.startsWith("free")) return "free";
    return type;
  }

  class StateTracker {
    constructor() {
      this.players = [];
      this.market = Object.fromEntries(RESOURCE_ORDER.map(r => [r, 0]));
    }

    _ensurePlayer(idx) {
      while (this.players.length <= idx) {
        this.players.push({
          name: "", money: 0, debt: 0, credit: 0,
          rates: Object.fromEntries(RESOURCE_ORDER.map(r => [r, 0])),
        });
      }
    }

    applyAction(action) {
      for (const m of action.mutations || []) {
        this._applyMut(m);
      }
    }

    _applyMut(m) {
      const f = m.field;
      const mkt = f.match(/^market\.(\w+)$/);
      if (mkt && typeof m.new === "number") {
        this.market[mkt[1]] = m.new;
        return;
      }
      const pm = f.match(/^player\.(\d+)\.(.+)$/);
      if (!pm) return;
      const idx = parseInt(pm[1]);
      const rest = pm[2];
      this._ensurePlayer(idx);
      const p = this.players[idx];

      if (rest === "name" && typeof m.new === "string") p.name = m.new;
      else if (rest === "money" && typeof m.new === "number") p.money = m.new;
      else if (rest === "debt" && typeof m.new === "number") p.debt = m.new;
      else if (rest === "credit" && typeof m.new === "number") p.credit = m.new;
      else {
        const rm = rest.match(/^rates\.(\w+)$/);
        if (rm && typeof m.new === "number") p.rates[rm[1]] = m.new;
      }
    }

    renderSnapshot() {
      const lines = [];
      lines.push('<div class="mut-snapshot">');
      const mktParts = RESOURCE_ORDER
        .map(r => `${r}:${this.market[r]}`);
      lines.push(`<div class="mut-snap-row"><span class="mut-snap-label">MKT</span> ${mktParts.join(" ")}</div>`);
      for (const p of this.players) {
        if (!p.name) continue;
        const nw = p.money - p.debt + p.credit;
        const rates = RESOURCE_ORDER
          .map(r => { const v = p.rates[r]; return v ? `${v > 0 ? "+" : ""}${v}${r}` : null; })
          .filter(Boolean).join(" ");
        let line = `$${p.money}`;
        if (p.debt) line += ` debt:$${p.debt}`;
        if (p.credit) line += ` cr:$${p.credit}`;
        line += ` NW:$${nw}`;
        if (rates) line += ` | ${rates}`;
        lines.push(`<div class="mut-snap-row"><span class="mut-snap-label">${p.name.replace("Player_", "P")}</span> ${line}</div>`);
      }
      lines.push('</div>');
      return lines.join("");
    }
  }

  function formatMetaValue(v) {
    if (v === null || v === undefined) return "null";
    if (typeof v === "number") return String(v);
    if (typeof v === "string") return v;
    if (Array.isArray(v)) {
      return v.map(item => {
        if (typeof item === "object") {
          return Object.entries(item).map(([k, val]) => `${k}:${val}`).join(" ");
        }
        return String(item);
      }).join(" | ");
    }
    return Object.entries(v).map(([k, val]) => `${k}:${val}`).join(", ");
  }

  function formatCardDesc(c) {
    if (typeof c === "string") return c;
    if (!c || !c.name) return JSON.stringify(c);
    let s = c.name;
    if (c.sells?.length) s += ` (${c.sells.join(", ")})`;
    else if (c.action === "contract") s += " (contract)";
    return s;
  }

  function formatMutValue(v) {
    if (v === null || v === undefined) return "null";
    if (typeof v === "object") {
      if (!Array.isArray(v) && v.name) return formatCardDesc(v);
      if (Array.isArray(v)) return v.map(item =>
        (typeof item === "object" && item?.name) ? formatCardDesc(item) : String(item)
      ).join(", ");
      if (v.old && v.new) return `${formatMutValue(v.old)} \u2194 ${formatMutValue(v.new)}`;
      return Object.entries(v).map(([k,val]) => `${k}:${formatMutValue(val)}`).join(", ");
    }
    return String(v);
  }

  // Navigation — steps through action_log entries
  function debugGo(step) {
    debugStep = step;
    updateDebugPanel();
  }
  function debugLive() {
    debugStep = -1;
    updateDebugPanel();
  }

  document.getElementById("debug-close")?.addEventListener("click", toggleDebugPanel);
  document.getElementById("debug-first")?.addEventListener("click", () => debugGo(0));
  document.getElementById("debug-prev")?.addEventListener("click", () => {
    const actionLog = _getActionLog();
    const cur = debugStep >= 0 ? debugStep : actionLog.length - 1;
    debugGo(Math.max(0, cur - 1));
  });
  document.getElementById("debug-next")?.addEventListener("click", () => {
    const actionLog = _getActionLog();
    if (debugStep >= 0 && debugStep < actionLog.length - 1) debugGo(debugStep + 1);
    else debugLive();
  });
  document.getElementById("debug-last")?.addEventListener("click", () => debugLive());
  document.getElementById("debug-live")?.addEventListener("click", () => debugLive());
  document.getElementById("debug-slider")?.addEventListener("input", (e) => {
    debugGo(parseInt(e.target.value));
  });
  document.getElementById("debug-download")?.addEventListener("click", () => {
    const actionLog = _getActionLog();
    const blob = new Blob([JSON.stringify(actionLog, null, 2)], {type: "application/json"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `action-log-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // Public API
  MP.debug = {
    toggleDebugPanel,
    updateDebugPanel,
    isOpen: () => debugPanelOpen,
  };
})();
