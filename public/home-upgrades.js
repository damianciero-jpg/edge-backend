console.log('EDGE HOME SCRIPT LOADED');

function waitForElement(selector, timeout = 7000) {
  return new Promise((resolve) => {
    const interval = 100;
    let elapsed = 0;

    const check = () => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);

      elapsed += interval;
      if (elapsed >= timeout) {
        return resolve(document.querySelector('main') || document.body);
      }

      setTimeout(check, interval);
    };

    check();
  });
}

function trackEdgeEvent(name, meta = {}) {
  try {
    const payload = { name, meta, ts: new Date().toISOString() };
    const events = JSON.parse(localStorage.getItem('edge_events') || '[]');
    events.push(payload);
    localStorage.setItem('edge_events', JSON.stringify(events.slice(-100)));
    console.log('EDGE_EVENT', payload);
  } catch (err) {
    console.log('EDGE_EVENT_FAILED', name, err.message);
  }
}

waitForElement('.welcome').then(container => {
  if (document.getElementById('edgeUpgradePanel')) return;

  const style = document.createElement('style');
  style.textContent = `
    #edgeUpgradePanel{width:min(920px,96%);margin:22px auto 0;text-align:left;}
    .edge-up-card{background:#0d1219;border:1px solid #1e2d3d;padding:16px;margin-top:12px;}
    .edge-up-title{font-family:'Space Mono',monospace;color:#00e5ff;font-size:10px;letter-spacing:2px;margin-bottom:9px;text-transform:uppercase;}
    .edge-up-row{display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:center;}
    #manualInput{width:100%;background:#080c10;color:#e8f4f8;border:1px solid #243447;padding:12px;font-size:13px;font-family:'Space Mono',monospace;outline:none;}
    #manualInput:focus{border-color:#00e5ff;}
    .edge-up-btn{background:#00e5ff;color:#080c10;border:0;padding:12px 14px;font-weight:800;font-family:'Space Mono',monospace;cursor:pointer;}
    .edge-up-btn.deep{background:#7b61ff;color:white;}
    .edge-up-btn:disabled{opacity:.55;cursor:not-allowed;}
    #edgeInlineResult{display:none;white-space:pre-wrap;color:#b0ccd8;font-size:12px;line-height:1.7;max-height:320px;overflow:auto;}
    .edge-pod-banner{border:1px solid #00e5ff;background:linear-gradient(135deg,rgba(0,229,255,.09),rgba(123,97,255,.08));padding:14px;margin-bottom:12px;}
    .edge-pod-top{font-family:'Space Mono',monospace;color:#ffd600;font-size:10px;letter-spacing:2px;margin-bottom:6px;}
    .edge-pod-pick{font-weight:800;color:#e8f4f8;font-size:18px;margin-bottom:4px;}
    .edge-pod-meta{font-family:'Space Mono',monospace;color:#b0ccd8;font-size:10px;line-height:1.6;margin-bottom:10px;}
    .edge-locked-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:10px;}
    .edge-locked{border:1px solid #243447;background:#080c10;padding:12px;min-height:120px;}
    .edge-locked div:first-child{color:#7b61ff;font-family:'Space Mono',monospace;font-size:9px;letter-spacing:2px;margin-bottom:8px;}
    .edge-locked strong{display:block;color:#e8f4f8;margin-bottom:6px;}
    .edge-locked p{color:#5a7a8a;font-size:11px;line-height:1.5;margin-bottom:10px;}
    @media(max-width:768px){
      #edgeUpgradePanel{width:100%;padding:0 8px;margin-top:16px;}
      .edge-up-row{grid-template-columns:1fr;}
      .edge-up-btn{width:100%;font-size:12px;padding:14px;margin-top:6px;}
      #manualInput{font-size:14px;padding:14px;}
      .edge-up-card{padding:16px;}
      #edgeInlineResult{font-size:14px;}
      .edge-locked-grid{grid-template-columns:1fr;}
      .edge-pod-pick{font-size:17px;}
    }
  `;
  document.head.appendChild(style);

  async function goToCheckout(source = 'paywall') {
    trackEdgeEvent('checkout_started', { source });
    const res = await fetch('/api/create-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 'sub' })
    });
    const data = await res.json();
    if (data.url) window.location.href = data.url;
  }

  function showPaywall(source = 'unknown') {
    trackEdgeEvent('paywall_opened', { source });
    const existing = document.getElementById('edgePaywallModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'edgePaywallModal';
    modal.style = 'position:fixed;inset:0;background:rgba(0,0,0,.92);display:flex;align-items:center;justify-content:center;z-index:9999;padding:18px;';
    modal.innerHTML = `
      <div style="background:#0d1219;padding:28px;border:1px solid #243447;text-align:center;max-width:430px;width:100%;box-shadow:0 0 40px rgba(0,229,255,.16)">
        <div style="font-family:monospace;color:#00e5ff;font-size:11px;letter-spacing:2px;margin-bottom:8px">EDGE PREMIUM</div>
        <h2 style="color:#e8f4f8;margin:0 0 10px;font-size:24px">Unlock the picks serious users see first</h2>
        <p style="color:#b0ccd8;line-height:1.6;font-size:13px;margin:0 0 18px">Deep AI adds research mode, second-layer review, best-edge cards, and alerts so you can spot value faster before lines move.</p>
        <div style="display:grid;gap:8px;text-align:left;margin:16px 0;color:#e8f4f8;font-size:12px">
          <div>✅ Deep AI research mode</div>
          <div>✅ Pick of the Day full breakdown</div>
          <div>✅ Best Edges unlocked</div>
          <div>✅ Email alerts for high-confidence spots</div>
        </div>
        <button id="edgeCheckoutBtn" style="width:100%;background:#00e5ff;color:#080c10;border:0;padding:14px 18px;margin-top:12px;font-weight:800;letter-spacing:1px">Upgrade Now - $9.99/mo</button>
        <button id="edgeClosePaywall" style="margin-top:12px;background:transparent;color:#5a7a8a;border:0;font-size:11px">Continue with free Quick AI</button>
        <p style="color:#5a7a8a;font-size:9px;line-height:1.6;margin-top:14px">EDGE does not guarantee wins. Bet responsibly.</p>
      </div>`;
    document.body.appendChild(modal);
    document.getElementById('edgeCheckoutBtn').addEventListener('click', () => goToCheckout(source));
    document.getElementById('edgeClosePaywall').addEventListener('click', () => modal.remove());
  }

  async function runAnalysis(useSearch) {
    const input = document.getElementById('manualInput');
    const resultBox = document.getElementById('edgeInlineResult');
    const quickBtn = document.getElementById('quickBtn');
    const deepBtn = document.getElementById('deepBtn');
    const prompt = input.value.trim();

    if (!prompt) {
      resultBox.style.display = 'block';
      resultBox.textContent = 'Enter a bet first.';
      return;
    }

    trackEdgeEvent(useSearch ? 'deep_ai_clicked' : 'quick_ai_used', { prompt });
    quickBtn.disabled = true;
    deepBtn.disabled = true;
    resultBox.style.display = 'block';
    resultBox.textContent = useSearch ? 'Deep AI is analyzing...' : 'Quick AI is analyzing...';

    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, useSearch, secondLayer: useSearch })
      });

      const data = await res.json();

      if (data.paywall) {
        trackEdgeEvent(data.event || 'deep_ai_blocked', { prompt });
        showPaywall(data.event || 'deep_ai_blocked');
        resultBox.textContent = 'Deep AI is premium. Upgrade to unlock full analysis.';
        return;
      }

      if (!res.ok || !data.ok) {
        resultBox.textContent = data.error || 'Analysis failed.';
        return;
      }

      trackEdgeEvent('analysis_completed', { mode: data.meta?.mode || (useSearch ? 'deep' : 'quick') });
      resultBox.textContent = data.text || 'Analysis complete.';
    } catch (err) {
      resultBox.textContent = `Analysis failed: ${err.message}`;
    } finally {
      quickBtn.disabled = false;
      deepBtn.disabled = false;
    }
  }

  const html = `
    <div id="edgeUpgradePanel">
      <div class="edge-pod-banner">
        <div class="edge-pod-top">🔥 EDGE PICK OF THE DAY</div>
        <div class="edge-pod-pick">Premium pick locked until upgrade</div>
        <div class="edge-pod-meta">EDGE Confidence™: 78 • Risk: Medium • Full analysis available in Deep AI</div>
        <button id="pickOfDayBtn" class="edge-up-btn">Unlock Pick of the Day</button>
      </div>

      <div class="edge-up-card">
        <div class="edge-up-title">Manual Bet Analysis</div>
        <div class="edge-up-row">
          <input id="manualInput" placeholder="Paste bet: Phillies moneyline +120 vs Mets" />
          <button id="quickBtn" class="edge-up-btn">⚡ Quick AI</button>
          <button id="deepBtn" class="edge-up-btn deep">🔍 Deep AI</button>
        </div>
        <div style="font-family:monospace;color:#ffd600;font-size:10px;margin-top:8px">Free users get limited Quick AI. Deep AI unlocks premium research.</div>
      </div>

      <div class="edge-up-card" id="edgeInlineResult"></div>

      <div class="edge-up-card">
        <div class="edge-up-title">Today's Best Edges</div>
        <div class="edge-locked-grid">
          <div class="edge-locked"><div>🔒 PREMIUM</div><strong>Top Value Bet</strong><p>High-confidence edge detected.</p><button class="edge-up-btn edge-lock-btn" data-source="best_edges">Unlock</button></div>
          <div class="edge-locked"><div>🔒 PREMIUM</div><strong>Line Movement Alert</strong><p>Deep AI watches for better prices.</p><button class="edge-up-btn edge-lock-btn" data-source="line_movement">Unlock</button></div>
          <div class="edge-locked"><div>🔒 PREMIUM</div><strong>Risk Filtered Pick</strong><p>Skip noisy bets. Focus on value.</p><button class="edge-up-btn edge-lock-btn" data-source="risk_filtered">Unlock</button></div>
        </div>
      </div>
    </div>
  `;

  container.insertAdjacentHTML('beforeend', html);

  document.getElementById('quickBtn').addEventListener('click', () => runAnalysis(false));
  document.getElementById('deepBtn').addEventListener('click', () => runAnalysis(true));
  document.getElementById('pickOfDayBtn').addEventListener('click', () => showPaywall('pick_of_the_day'));
  document.querySelectorAll('.edge-lock-btn').forEach(btn => {
    btn.addEventListener('click', () => showPaywall(btn.dataset.source || 'locked_edge'));
  });

  trackEdgeEvent('home_upgrade_rendered');
});
