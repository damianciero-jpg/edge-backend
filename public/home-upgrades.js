console.log("EDGE HOME SCRIPT LOADED");

// ─── FIX 1: INTERCEPT ALL /api/analyze CALLS ─────────────────────────────────
// Forces selectedSide: 'best' on every analyze request so the backend always
// auto-evaluates both sides and returns the best pick. Removes any manual
// team selection the minified frontend may be sending.
(function forceBestSide() {
  const origFetch = window.fetch;
  window.fetch = function (url, options) {
    if (typeof url === 'string' && url.includes('/api/analyze') && options && options.body) {
      try {
        const body = JSON.parse(options.body);
        body.selectedSide = 'best';
        body.selectedTeam = '';
        body.opponentTeam = '';
        options = { ...options, body: JSON.stringify(body) };
      } catch (e) {}
    }
    return origFetch.call(this, url, options);
  };
})();

// ─── FIX 2: HIDE TEAM SELECTOR UI ────────────────────────────────────────────
// Removes any team/side selection dropdowns or buttons from the UI since
// the app now auto-picks the best side for the user.
(function removeTeamSelector() {
  const SELECTORS = [
    '[data-side]',
    '.team-selector',
    '.side-selector',
    '#teamSelect',
    '#sideSelect',
    'select[name="side"]',
    'select[name="team"]',
  ];

  function hideSelectors() {
    SELECTORS.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => {
        el.style.display = 'none';
      });
    });
  }

  // Run on load and watch for dynamically added elements
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hideSelectors);
  } else {
    hideSelectors();
  }

  // MutationObserver catches any dynamically rendered team selectors
  const observer = new MutationObserver(hideSelectors);
  observer.observe(document.body, { childList: true, subtree: true });
})();

// ─── EXISTING HOME WIDGET CODE ────────────────────────────────────────────────

function waitForElement(selector, timeout = 5000) {
  return new Promise((resolve) => {
    const interval = 100;
    let elapsed = 0;

    const check = () => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);

      elapsed += interval;
      if (elapsed >= timeout) return resolve(document.querySelector('main') || document.body);

      setTimeout(check, interval);
    };

    check();
  });
}

waitForElement('.welcome').then(container => {
  if (document.getElementById('edgeUpgradePanel')) return;

  async function goToCheckout() {
    try {
      const res = await fetch('/api/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: 'sub' })
      });
      const data = await res.json();
      if (!res.ok || !data.url) throw new Error(data.error || 'Checkout unavailable');
      window.location.href = data.url;
    } catch (err) {
      alert(err.message || 'Checkout unavailable');
    }
  }

  function showPaywall() {
    const modal = document.createElement('div');
    modal.style = `position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.9);display:flex;align-items:center;justify-content:center;z-index:9999;`;
    modal.innerHTML = `
      <div style="background:#0d1219;padding:30px;border:1px solid #243447;text-align:center">
        <h2 style="color:#00e5ff">Unlock EDGE Premium</h2>
        <p>Get Deep AI, best edges, and alerts</p>
        <button id="edgeCheckoutBtn" style="background:#00e5ff;color:black;padding:12px 20px;margin-top:15px;">Upgrade Now - $20/mo</button>
        <button id="edgeClosePaywall" style="display:block;margin:12px auto 0;background:transparent;color:#5a7a8a;border:0;">Close</button>
      </div>`;
    document.body.appendChild(modal);
    document.getElementById('edgeCheckoutBtn').addEventListener('click', goToCheckout);
    document.getElementById('edgeClosePaywall').addEventListener('click', () => modal.remove());
  }

  async function runAnalysis(useSearch) {
    const input = document.getElementById('manualInput');
    const result = document.getElementById('homeAiResult');
    const quickBtn = document.getElementById('quickBtn');
    const deepBtn = document.getElementById('deepBtn');
    const prompt = input.value.trim();
    if (!prompt) {
      result.style.display = 'block';
      result.textContent = 'Enter a bet first.';
      return;
    }

    quickBtn.disabled = true;
    deepBtn.disabled = true;
    result.style.display = 'block';
    result.textContent = useSearch ? 'Research AI is analyzing...' : 'Quick AI is analyzing...';

    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          useSearch,
          secondLayer: useSearch,
          selectedSide: 'best',
          selectedTeam: '',
          opponentTeam: '',
        })
      });

      const data = await res.json().catch(() => ({}));

      if (data.authRequired || res.status === 401) {
        const overlay = document.getElementById('auth-overlay');
        if (overlay) overlay.style.display = 'flex';
        result.textContent = 'Please sign in to run analysis.';
        return;
      }

      if (data.paywall || res.status === 402) {
        showPaywall();
        result.textContent = data.error || 'No credits remaining.';
        return;
      }

      if (!res.ok || data.ok === false) {
        result.textContent = data.error || 'Analysis failed.';
        return;
      }

      result.textContent = data.text || 'Analysis complete.';
      if (typeof syncUserStatus === 'function') syncUserStatus();

      // Phase 4: store prediction for calibration tracking (fire-and-forget)
      if (data.data && data.data.verdict && data.data.pick) {
        edgeStorePrediction(data.data).catch(() => {});
      }
    } catch (err) {
      result.textContent = `Analysis failed: ${err.message}`;
    } finally {
      quickBtn.disabled = false;
      deepBtn.disabled = false;
    }
  }

  const html = `
    <div id="edgeUpgradePanel" style="box-sizing:border-box;width:min(920px,96%);margin:22px auto 0;">
      <div style="display:flex;gap:6px;justify-content:center;flex-wrap:wrap;">
        <input id="manualInput" placeholder="Paste bet or enter game" style="min-width:220px;padding:8px;background:#080c10;border:1px solid #243447;color:#e8f4f8;" />
        <button id="quickBtn" style="padding:8px 12px;background:#00e5ff;border:0;color:#080c10;font-weight:700;">Quick AI</button>
        <button id="deepBtn" style="padding:8px 12px;background:#7b61ff;border:0;color:white;font-weight:700;">Deep AI</button>
      </div>
      <div id="homeAiResult" style="display:none;margin:12px auto 0;max-width:720px;max-height:260px;overflow:auto;white-space:pre-wrap;text-align:left;background:#0d1219;border:1px solid #1e2d3d;color:#b0ccd8;padding:12px;font-size:12px;line-height:1.7;"></div>
    </div>
  `;

  container.insertAdjacentHTML('beforeend', html);
  document.getElementById('manualInput').style.boxSizing = 'border-box';
  document.getElementById('quickBtn').addEventListener('click', () => runAnalysis(false));
  document.getElementById('deepBtn').addEventListener('click', () => runAnalysis(true));
});

// ─── PHASE 4: CALIBRATION PREDICTION STORE ───────────────────────────────────

const EDGE_PREDICTIONS_KEY = 'edge_predictions';

function edgeLoadPredictions() {
  try { return JSON.parse(localStorage.getItem(EDGE_PREDICTIONS_KEY) || '[]'); } catch { return []; }
}

function edgeSavePredictions(list) {
  try { localStorage.setItem(EDGE_PREDICTIONS_KEY, JSON.stringify(list.slice(-500))); } catch {}
}

async function edgeStorePrediction(d) {
  const prediction = {
    id: Date.now(),
    pick: d.pick,
    verdict: d.verdict,
    edgeScore: d.edgeScore,
    consensusProb: d.consensusProb,
    noVigProb: d.noVigProb,
    priceEdge: d.priceEdge,
    odds: d.odds,
    result: null,
    resolvedAt: null,
    createdAt: new Date().toISOString(),
  };

  // Save locally
  const list = edgeLoadPredictions();
  list.unshift(prediction);
  edgeSavePredictions(list);

  // Sync to server (non-blocking — if it fails, local copy is still kept)
  try {
    await fetch('/api/performance/predict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prediction),
    });
  } catch {}
}

function edgeMarkPredictionOutcome(id, result) {
  const list = edgeLoadPredictions();
  const idx = list.findIndex(p => p.id === id);
  if (idx === -1) return;
  list[idx] = { ...list[idx], result, resolvedAt: new Date().toISOString() };
  edgeSavePredictions(list);

  // Sync to server (fire-and-forget)
  fetch('/api/performance/outcome', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ predictionId: id, result }),
  }).catch(() => {});

  renderPerformanceDashboard();
}

// ─── PHASE 4: PERFORMANCE DASHBOARD ─────────────────────────────────────────
// Injected into the Tracker tab. Shows algorithm calibration analytics —
// NOT duplicating the raw bet log/stats already in the Tracker tab.
// Only visible when >= 20 predictions have been resolved.

const PERF_PANEL_ID = 'edge-perf-dashboard';
const MIN_RESOLVED_FOR_REPORT = 20;

function renderPerformanceDashboard() {
  const tracker = document.getElementById('view-tracker');
  if (!tracker || !tracker.querySelector('.scrollable')) return;

  const scrollable = tracker.querySelector('.scrollable');

  // Remove existing panel to re-render
  const existing = document.getElementById(PERF_PANEL_ID);
  if (existing) existing.remove();

  const predictions = edgeLoadPredictions();
  const resolved = predictions.filter(p => p.result === 'win' || p.result === 'loss');
  const pending = predictions.filter(p => !p.result);

  // Always show prediction log; hide full calibration report until 20 resolved
  const panel = document.createElement('div');
  panel.id = PERF_PANEL_ID;
  panel.style.cssText = 'margin-bottom:22px;';

  if (predictions.length === 0) {
    panel.innerHTML = '';
    scrollable.insertAdjacentElement('afterbegin', panel);
    return;
  }

  const hasReport = resolved.length >= MIN_RESOLVED_FOR_REPORT;
  const reportHtml = hasReport ? buildCalibrationReportHtml(resolved) : `
    <div style="font-family:var(--mono);font-size:9px;color:var(--muted);letter-spacing:1px;padding:14px 0 4px;">
      ALGORITHM CALIBRATION — ${resolved.length}/${MIN_RESOLVED_FOR_REPORT} resolved predictions. Mark ${MIN_RESOLVED_FOR_REPORT - resolved.length} more outcomes to unlock the full report.
    </div>`;

  const pendingRows = pending.slice(0, 10).map(p => `
    <tr>
      <td style="font-family:var(--mono);font-size:9px;color:var(--muted);">${new Date(p.createdAt).toLocaleDateString('en-US',{month:'short',day:'numeric'})}</td>
      <td style="color:var(--accent);font-size:11px;font-weight:700;">${escHtml(p.pick)}</td>
      <td style="font-family:var(--mono);font-size:9px;" class="${p.verdict === 'BET' ? 'pos' : p.verdict === 'LEAN' ? 'wrn' : 'neg'}">${p.verdict}</td>
      <td style="font-family:var(--mono);font-size:9px;color:var(--muted);">${p.edgeScore != null ? Number(p.edgeScore).toFixed(2) : '—'}</td>
      <td style="font-family:var(--mono);font-size:9px;color:var(--muted);">${p.noVigProb != null ? (Number(p.noVigProb)*100).toFixed(1)+'%' : '—'}</td>
      <td>
        <div style="display:flex;gap:4px;">
          <button onclick="edgeMarkPredictionOutcome(${p.id},'win')" style="font-family:var(--mono);font-size:8px;padding:3px 7px;border:1px solid var(--green);color:var(--green);background:transparent;cursor:pointer;">W</button>
          <button onclick="edgeMarkPredictionOutcome(${p.id},'loss')" style="font-family:var(--mono);font-size:8px;padding:3px 7px;border:1px solid var(--red);color:var(--red);background:transparent;cursor:pointer;">L</button>
        </div>
      </td>
    </tr>`).join('');

  panel.innerHTML = `
    <div class="section-lbl" style="margin-bottom:14px;">ALGORITHM PERFORMANCE</div>
    ${reportHtml}
    ${pending.length > 0 ? `
    <div style="font-family:var(--mono);font-size:8px;color:var(--muted);letter-spacing:2px;margin:14px 0 8px;">PENDING PREDICTIONS — MARK OUTCOME</div>
    <div style="overflow-x:auto;margin-bottom:18px;">
      <table style="width:100%;border-collapse:collapse;background:var(--surface);border:1px solid var(--border);">
        <thead><tr>
          <th style="font-family:var(--mono);font-size:8px;color:var(--muted);letter-spacing:2px;padding:8px 12px;text-align:left;border-bottom:1px solid var(--border);background:var(--surface2);">DATE</th>
          <th style="font-family:var(--mono);font-size:8px;color:var(--muted);letter-spacing:2px;padding:8px 12px;text-align:left;border-bottom:1px solid var(--border);background:var(--surface2);">PICK</th>
          <th style="font-family:var(--mono);font-size:8px;color:var(--muted);letter-spacing:2px;padding:8px 12px;text-align:left;border-bottom:1px solid var(--border);background:var(--surface2);">VERDICT</th>
          <th style="font-family:var(--mono);font-size:8px;color:var(--muted);letter-spacing:2px;padding:8px 12px;text-align:left;border-bottom:1px solid var(--border);background:var(--surface2);">EDGE SCORE</th>
          <th style="font-family:var(--mono);font-size:8px;color:var(--muted);letter-spacing:2px;padding:8px 12px;text-align:left;border-bottom:1px solid var(--border);background:var(--surface2);">TRUE PROB</th>
          <th style="font-family:var(--mono);font-size:8px;color:var(--muted);letter-spacing:2px;padding:8px 12px;text-align:left;border-bottom:1px solid var(--border);background:var(--surface2);">OUTCOME</th>
        </tr></thead>
        <tbody>${pendingRows}</tbody>
      </table>
    </div>` : ''}
  `;

  scrollable.insertAdjacentElement('afterbegin', panel);
}

function buildCalibrationReportHtml(resolved) {
  const wins = resolved.filter(p => p.result === 'win').length;
  const winRate = (wins / resolved.length * 100).toFixed(1);

  // ROI estimate
  let roi = 0;
  resolved.forEach(p => {
    if (p.result === 'win') {
      const o = Number(p.odds || -110);
      roi += o > 0 ? o / 100 : 100 / Math.abs(o);
    } else {
      roi -= 1;
    }
  });
  roi = (roi / resolved.length * 100).toFixed(1);

  // By verdict
  const byVerdict = {};
  resolved.forEach(p => {
    const v = p.verdict || 'UNKNOWN';
    if (!byVerdict[v]) byVerdict[v] = { w: 0, n: 0 };
    byVerdict[v].n++;
    if (p.result === 'win') byVerdict[v].w++;
  });

  const verdictRows = Object.entries(byVerdict).map(([v, d]) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-bottom:1px solid var(--border);">
      <span style="font-family:var(--mono);font-size:10px;font-weight:700;color:${v==='BET'?'var(--green)':v==='LEAN'?'var(--yellow)':'var(--red)'};">${v}</span>
      <span style="font-family:var(--mono);font-size:10px;color:var(--text);">${(d.w/d.n*100).toFixed(1)}% win rate</span>
      <span style="font-family:var(--mono);font-size:9px;color:var(--muted);">${d.n} resolved</span>
    </div>`).join('');

  return `
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px;">
      <div style="background:var(--surface);border:1px solid var(--border);padding:14px;">
        <div style="font-family:var(--mono);font-size:8px;color:var(--muted);letter-spacing:2px;margin-bottom:6px;">RESOLVED BETS</div>
        <div style="font-family:var(--mono);font-size:20px;font-weight:700;color:var(--text);">${resolved.length}</div>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);padding:14px;">
        <div style="font-family:var(--mono);font-size:8px;color:var(--muted);letter-spacing:2px;margin-bottom:6px;">ACTUAL WIN RATE</div>
        <div style="font-family:var(--mono);font-size:20px;font-weight:700;color:${parseFloat(winRate)>=50?'var(--green)':'var(--red)'};">${winRate}%</div>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);padding:14px;">
        <div style="font-family:var(--mono);font-size:8px;color:var(--muted);letter-spacing:2px;margin-bottom:6px;">EST. ROI</div>
        <div style="font-family:var(--mono);font-size:20px;font-weight:700;color:${parseFloat(roi)>=0?'var(--green)':'var(--red)'};">${roi>0?'+':''}${roi}%</div>
      </div>
    </div>
    <div style="font-family:var(--mono);font-size:8px;color:var(--muted);letter-spacing:2px;margin-bottom:8px;">WIN RATE BY VERDICT</div>
    <div style="background:var(--surface);border:1px solid var(--border);margin-bottom:14px;">${verdictRows}</div>`;
}

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── PHASE 4: HOOK showTab TO RENDER DASHBOARD ON TRACKER ────────────────────
// Extends window.showTab (defined in index.html) without modifying index.html.
(function hookShowTab() {
  function tryHook() {
    if (typeof window.showTab !== 'function') { setTimeout(tryHook, 100); return; }
    const orig = window.showTab;
    window.showTab = function(tab) {
      orig.apply(this, arguments);
      if (tab === 'tracker') renderPerformanceDashboard();
    };
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryHook);
  } else {
    tryHook();
  }
})();
