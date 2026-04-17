// ===== Card Animations + Deck Viewer + Event Banner =====
//
// All DOM-side-effect helpers for animating card motion, reward popups, rate
// change indicators, the deck viewer modal, and the event banner. Wrapped in
// an IIFE; public API on MP.anim.
// Depends on: window.MP (MP.currentState), plus code in multiplayer.js that
// calls MP.anim.* after the module has loaded.

(function () {
  const MP = window.MP = window.MP || {};

  const ANIM_FLIGHT = 400;
  const ANIM_FADE = 300;

  // Zoom factor from the game wrapper (v2 viewport scaling).
  // Clones are appended to body (outside zoom), so coords from
  // getBoundingClientRect are screen-space but clone content renders
  // unzoomed. Dividing coords by z and setting clone zoom = z keeps
  // visual size and position consistent.
  function _zoom() {
    const w = document.getElementById("game-wrapper");
    return parseFloat(w?.style.zoom) || 1;
  }

  function animateCard(sourceRect, destRect, html, opts = {}) {
    const z = _zoom();
    const clone = document.createElement("div");
    clone.className = "flying-card";
    clone.innerHTML = html;
    Object.assign(clone.style, {
      position: "fixed",
      left: (sourceRect.left / z) + "px",
      top: (sourceRect.top / z) + "px",
      width: (sourceRect.width / z) + "px",
      height: (sourceRect.height / z) + "px",
      zoom: z,
      zIndex: "200",
      transition: `all ${ANIM_FLIGHT}ms cubic-bezier(0.4, 0, 0.2, 1)`,
      pointerEvents: "none",
      overflow: "hidden",
    });
    document.body.appendChild(clone);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        clone.style.left = (destRect.left / z) + "px";
        clone.style.top = (destRect.top / z) + "px";
        clone.style.width = (destRect.width / z) + "px";
        clone.style.height = (destRect.height / z) + "px";
        if (opts.fadeOut) clone.style.opacity = "0";
      });
    });
    const cleanup = () => { if (clone.parentNode) clone.remove(); };
    clone.addEventListener("transitionend", cleanup, {once: true});
    setTimeout(cleanup, ANIM_FLIGHT + 100);
  }

  function animateFadeOut(rect, html) {
    if (!rect) return;
    const z = _zoom();
    const clone = document.createElement("div");
    clone.className = "flying-card card-fade-out";
    clone.innerHTML = html || "";
    Object.assign(clone.style, {
      position: "fixed",
      left: (rect.left / z) + "px",
      top: (rect.top / z) + "px",
      width: (rect.width / z) + "px",
      height: (rect.height / z) + "px",
      zoom: z,
      zIndex: "200",
      pointerEvents: "none",
    });
    document.body.appendChild(clone);
    setTimeout(() => { if (clone.parentNode) clone.remove(); }, ANIM_FADE + 100);
  }

  function animateReward(rect, text) {
    const z = _zoom();
    const el = document.createElement("div");
    el.className = "reward-popup";
    el.textContent = text;
    Object.assign(el.style, {
      position: "fixed",
      left: ((rect.left + rect.width / 2) / z) + "px",
      top: (rect.top / z) + "px",
      zoom: z,
      zIndex: "201",
    });
    document.body.appendChild(el);
    setTimeout(() => { if (el.parentNode) el.remove(); }, 900);
  }

  function animateAiActions(actions, playerIdx) {
    // Find the opponent card element for this player
    const oppCards = document.querySelectorAll("#mp-opponents .opponent-card");
    let oppEl = null;
    for (const card of oppCards) {
      // Match by checking if the card's name matches
      const nameEl = card.querySelector(".opponent-name");
      const playerName = MP.currentState?.players[playerIdx]?.name || "";
      if (nameEl && nameEl.textContent.includes(playerName)) {
        oppEl = card;
        break;
      }
    }
    if (!oppEl) return;
    const oppRect = oppEl.getBoundingClientRect();

    // Pool area as source for builds (AI "picks" from pool conceptually)
    const poolGrid = document.getElementById("mp-pool-grid");
    const poolRect = poolGrid?.getBoundingClientRect() || {left: oppRect.left, top: oppRect.top - 100, width: 160, height: 30};

    let delay = 0;
    for (const a of actions) {
      if (a.type === "build") {
        // Card flies from pool area to opponent's panel
        const names = (a.buildings || []).join(", ");
        const ratesHtml = Object.entries(a.rates_gained || {})
          .filter(([, v]) => v !== 0)
          .map(([r, v]) => `<span class="${v > 0 ? 'rate-pos' : 'rate-neg'}">${v > 0 ? '+' : ''}${v} ${r}</span>`)
          .join(" ");
        const html = `<div class="card-name">${names}</div>${ratesHtml ? `<div class="card-rates">${ratesHtml}</div>` : ""}`;
        const sourceRect = {left: poolRect.left + poolRect.width / 2 - 80, top: poolRect.top, width: 160, height: 40};
        const ratesGained = a.rates_gained;
        setTimeout(() => {
          animateCard(sourceRect, oppRect, html);
          // Rate change popups on the opponent's rate chips
          if (ratesGained && oppEl) {
            setTimeout(() => animateRateChanges(ratesGained, "#mp-opponents"), 200);
          }
        }, delay);
        delay += 120;
      } else if (a.type === "sell" && a.sell_revenue > 0) {
        // Reward popup near opponent
        setTimeout(() => animateReward(oppRect, `+$${a.sell_revenue}`), delay);
        delay += 80;
      } else if (a.type === "contract" && a.contract_reward > 0) {
        setTimeout(() => animateReward(oppRect, `+$${a.contract_reward}`), delay);
        delay += 80;
      }
    }
  }

  function animateRateChanges(rates, targetSelector) {
    // Show floating +/- numbers over the rate chips that changed
    if (!rates || typeof rates !== "object") return;
    const entries = Object.entries(rates).filter(([, v]) => v !== 0);
    if (entries.length === 0) return;

    for (const [resource, amount] of entries) {
      // Find the rate chip — search all chips under the target, match by resource text
      const chips = document.querySelectorAll(`${targetSelector} .rate-chip`);
      let chipEl = null;
      for (const chip of chips) {
        const resEl = chip.querySelector(".rate-res");
        if (resEl && resEl.textContent.trim().toUpperCase() === resource.toUpperCase()) {
          chipEl = chip;
          break;
        }
      }
      if (!chipEl) {
        // Fallback: try finding by resource color in the rates grid
        continue;
      }
      const rect = chipEl.getBoundingClientRect();
      if (rect.width === 0) continue; // element not visible
      const popup = document.createElement("div");
      popup.className = amount > 0 ? "rate-change-popup positive" : "rate-change-popup negative";
      popup.textContent = `${amount > 0 ? "+" : ""}${amount}`;
      const z = _zoom();
      Object.assign(popup.style, {
        position: "fixed",
        left: ((rect.left + rect.width / 2) / z) + "px",
        top: ((rect.top - 8) / z) + "px",
        zoom: z,
        zIndex: "250",
      });
      document.body.appendChild(popup);
      setTimeout(() => { if (popup.parentNode) popup.remove(); }, 1200);
    }
  }

  // ===== Deck viewer =====

  let deckViewerOpen = false;

  function toggleDeckViewer() {
    deckViewerOpen = !deckViewerOpen;
    renderDeckViewer();
  }

  function renderDeckViewer() {
    const el = document.getElementById("deck-viewer");
    if (!el) return;
    if (!deckViewerOpen || !MP.currentState) {
      el.style.display = "none";
      return;
    }
    const remaining = MP.currentState.event_deck_remaining || [];
    const nonRedraw = remaining.filter(e => !e.redraws);
    const numPlayers = MP.currentState.players?.length || 3;

    // Count by type
    const counts = {};
    for (const e of remaining) {
      const label = e.redraws ? `${e.type} (redraw)` : e.type;
      counts[label] = (counts[label] || 0) + 1;
    }

    const EVENT_COLORS = {
      power_bill: "var(--res-pwr)",
      debt_collection: "var(--accent-red)",
      futures_trading: "var(--accent-yellow)",
      patent_auction: "var(--accent-violet)",
      draw_building_card: "var(--accent-blue)",
      news_bulletin: "var(--accent-green)",
      news: "var(--accent-green)",
      end_round: "var(--accent-orange)",
      end_game: "var(--accent-orange)",
    };

    el.style.display = "block";
    el.innerHTML = `
      <div class="deck-viewer-inner">
        <div class="deck-viewer-header">
          <strong>Event Deck</strong> — ${remaining.length} cards left, ${nonRedraw.length} player turns (${Math.floor(nonRedraw.length / numPlayers)} per player)
          <span style="margin-left:auto;cursor:pointer;color:var(--text-muted)" onclick="MP.anim.toggleDeckViewer()">close</span>
        </div>
        <div class="deck-viewer-summary">
          ${Object.entries(counts).map(([type, n]) => {
            const baseType = type.replace(" (redraw)", "");
            const color = EVENT_COLORS[baseType] || "var(--text-muted)";
            return `<span class="deck-chip" style="border-color:${color}">${type}: ${n}</span>`;
          }).join("")}
        </div>
        <div class="deck-viewer-list">
          ${remaining.map((e, i) => {
            const color = EVENT_COLORS[e.type] || "var(--text-muted)";
            const flags = [];
            if (e.redraws) flags.push("redraw");
            if (e.pwr_adjust) flags.push("PWR adj");
            const flagStr = flags.length ? ` <span class="deck-flags">${flags.join(", ")}</span>` : "";
            return `<span class="deck-card" style="border-left-color:${color}">${e.type.replace(/_/g, " ")}${flagStr}</span>`;
          }).join("")}
        </div>
      </div>
    `;
  }

  // ===== Event Deck/Discard Banner =====

  function showEventBanner(titleHtml) {
    // Animate card from deck to discard
    const deckEl = document.getElementById("event-deck-card");
    const discardEl = document.getElementById("event-discard");
    const textEl = document.getElementById("event-discard-text");
    if (!deckEl || !discardEl || !textEl) return;

    const deckRect = deckEl.getBoundingClientRect();
    const discardRect = discardEl.getBoundingClientRect();

    // Create a flying card clone
    const flyCard = document.createElement("div");
    flyCard.className = "flying-card";
    flyCard.innerHTML = `<span style="font-size:0.7rem">&#9889; ${titleHtml}</span>`;
    const z = _zoom();
    Object.assign(flyCard.style, {
      position: "fixed",
      left: (deckRect.left / z) + "px",
      top: (deckRect.top / z) + "px",
      width: (deckRect.width / z) + "px",
      height: (deckRect.height / z) + "px",
      zoom: z,
      zIndex: "200",
      transition: `all ${ANIM_FLIGHT}ms cubic-bezier(0.4, 0, 0.2, 1)`,
      pointerEvents: "none",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      borderColor: "var(--accent-orange)",
    });
    document.body.appendChild(flyCard);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        flyCard.style.left = (discardRect.left / z) + "px";
        flyCard.style.top = (discardRect.top / z) + "px";
        flyCard.style.width = (discardRect.width / z) + "px";
        flyCard.style.height = (discardRect.height / z) + "px";
      });
    });

    flyCard.addEventListener("transitionend", () => {
      flyCard.remove();
      // Update discard face
      textEl.innerHTML = `&#9889; ${titleHtml}`;
      discardEl.classList.remove("fresh");
      void discardEl.offsetHeight; // reflow
      discardEl.classList.add("fresh");
    }, {once: true});
    setTimeout(() => { if (flyCard.parentNode) flyCard.remove(); }, ANIM_FLIGHT + 100);
  }

  // Public API
  MP.anim = {
    animateCard,
    animateFadeOut,
    animateReward,
    animateAiActions,
    animateRateChanges,
    toggleDeckViewer,
    renderDeckViewer,
    showEventBanner,
  };
})();
