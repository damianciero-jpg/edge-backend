console.log("EDGE HOME SCRIPT LOADED");

function waitForElement(selector, timeout = 5000) {
  return new Promise((resolve) => {
    const interval = 100;
    let elapsed = 0;

    const check = () => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);

      elapsed += interval;
      if (elapsed >= timeout) return resolve(document.body);

      setTimeout(check, interval);
    };

    check();
  });
}

waitForElement('.welcome').then(container => {
  if (document.getElementById('edgeUpgradePanel')) return;

  function trackEvent(name, meta = {}) {
    const payload = { name, meta, ts: new Date().toISOString() };
    const events = JSON.parse(localStorage.getItem('edge_events') || '[]');
    events.push(payload);
    localStorage.setItem('edge_events', JSON.stringify(events.slice(-100)));
    console.log('EDGE_EVENT', payload);
  }

  async function goToCheckout(source = 'paywall') {
    trackEvent('checkout_started', { source });
    const res = await fetch('/api/create-checkout-session', { method: 'POST' });
    const data = await res.json();
    if (data.url) window.location.href = data.url;
  }

  window.edgeGoToCheckout = goToCheckout;

  function showPaywall(source = 'unknown') {
    trackEvent('paywall_opened', { source });
    const existing = document.getElementById('edgePaywallModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'edgePaywallModal';
    modal.style = `position:fixed;inset:0;background:rgba(0,0,0,0.92);display:flex;align-items:center;justify-content:center;z-index:9999;padding:18px;`;
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
        <button onclick="window.edgeGoToCheckout('${source}')" style="width:100%;background:#00e5ff;color:#080c10;border:0;padding:14px 18px;margin-top:12px;font-weight:800;letter-spacing:1px">Upgrade Now - $9.99/mo</button>
        <button onclick="document.getElementById('edgePaywallModal').remove()" style="margin-top:12px;background:transparent;color:#5a7a8a;border:0;font-size:11px">Continue with free Quick AI</button>
        <p style="color:#5a7a8a;font-size:9px;line-height:1.6;margin-top:14px">EDGE does not guarantee wins. Bet responsibly.</p>
      </div>`;
    document.body.appendChild(modal);
  }

  window.edgeShowPaywall = showPaywall;

  async function runAnalysis(useSearch) {
    const input = document.getElementById('manualInput');
    const prompt = input.value.trim();
    if (!prompt) return alert('Enter a bet');

    trackEvent(useSearch ? 'deep_ai_clicked' : 'quick_ai_used', { prompt });

    const resultBox = document.getElementById('edgeInlineResult');
    resultBox.style.display = 'block';
    resultBox.textContent = useSearch ? 'Deep AI is analyzing...' : 'Quick AI is analyzing...';

    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, useSearch, secondLayer: useSearch })
    });

    const data = await res.json();

    if (data.paywall) {
      trackEvent(data.event || 'deep_ai_blocked', { prompt });
      showPaywall(data.event || 'deep_ai_blocked');
      resultBox.textContent = 'Deep AI is premium. Upgrade to unlock full analysis.';
      return;
    }

    if (!res.ok || !data.ok) {
      resultBox.textContent = data.error || 'Analysis failed.';
      return;
    }

    trackEvent('analysis_completed', { mode: data.meta?.mode || (useSearch ? 'deep' : 'quick') });
    resultBox.textContent = data.text || 'Analysis complete.';
  }

  window.edgeRunAnalysis = runAnalysis;

  const style = document.createElement('style');
  style.textContent = `
    #edgeUpgradePanel{width:min(920px,96%);margin:22px auto 0;text-align:left;}
    .edge-pod-banner{border:1px solid #00e5ff;background:linear-gradient(135deg,rgba(0,229,255,.09),rgba(123,97,255,.08));padding:14px;margin-bottom:12px;text-align:left;}
    .edge-pod-top{font-family:monospace;color:#ffd600;font-size:10px;letter-spacing:2px;margin-bottom:6px;}
    .edge-pod-pick{font-weight:800;color:#e8f4f8;font-size:18px;margin-bottom:4px;}
    .edge-pod-meta{font-family:monospace;color:#b0ccd8;font-size:10px;line-height:1.6;margin-bottom:10px;}
    .edge-pod-btn,.edge-action-btn{background:#00e5ff;color:#080c10;border:0;padding:12px 14px;font-weight:800;font-family:monospace;cursor:pointer;}
    .edge-action-btn.deep{background:#7b61ff;color:white;}
    .edge-card{background:#0d1219;border:1px solid #1e2d3d;padding:16px;margin-top:12px;}
    .edge-title{font-family:monospace;color:#00e5ff;font-size:10px;letter-spacing:2px;margin-bottom:9px;}
    .edge-row{display:grid;grid-template-columns:1fr auto auto;gap:8px;}
    #manualInput{background:#080c10;color:#e8f4f8;border:1px solid #243447;padding:12px;font-size:13px;}
    #edgeInlineResult{display:none;white-space:pre-wrap;color:#b0ccd8;font-size:12px;line-height:1.7;max-height:300px;overflow:auto;}
    .edge-locked-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:10px;}
    .edge-locked{border:1px solid #243447;background:#080c10;padding:12px;min-height:120px;}
    .edge-locked div:first-child{color:#7b61ff;font-family:monospace;font-size:9px;letter-spacing:2px;margin-bottom:8px;}
    .edge-locked strong{display:block;color:#e8f4f8;margin-bottom:6px;}
    .edge-locked p{color:#5a7a8a;font-size:11px;line-height:1.5;margin-bottom:10px;}
    @media(max-width:768px){#edgeUpgradePanel{width:100%;padding:0 8px}.edge-row{grid-template-columns:1fr}.edge-action-btn,.edge-pod-btn{width:100%;font-size:12px;padding:14px}#manualInput{font-size:14px;padding:14px}.edge-locked-grid{grid-template-columns:1fr}.edge-card{padding:16px}.edge-pod-pick{font-size:17px}}
  `;
  document.head.appendChild(style);

  const html = `
    <div id="edgeUpgradePanel">
      <div class="edge-pod-banner">
        <div class="edge-pod-top">🔥 EDGE PICK OF THE DAY</div>
        <div class="edge-pod-pick">Premium pick locked until upgrade</div>
        <div class="edge-pod-meta">EDGE Confidence™: 78 • Risk: Medium • Full analysis available in Deep AI</div>
        <button class="edge-pod-btn" onclick="window.edgeShowPaywall('pick_of_the_day')">Unlock Pick of the Day</button>
      </div>

      <div class="edge-card">
        <div class="edge-title">MANUAL BET ANALYSIS</div>
        <div class="edge-row">
          <input id="manualInput" placeholder="Paste bet: Phillies moneyline +120 vs Mets" />
          <button class="edge-action-btn" onclick="window.edgeRunAnalysis(false)">⚡ Quick AI</button>
          <button class="edge-action-btn deep" onclick="window.edgeRunAnalysis(true)">🔍 Deep AI</button>
        </div>
        <div style="font-family:monospace;color:#ffd600;font-size:10px;margin-top:8px">Free users get limited Quick AI. Deep AI unlocks premium research.</div>
      </div>

      <div class="edge-card" id="edgeInlineResult"></div>

      <div class="edge-card">
        <div class="edge-title">TODAY'S BEST EDGES</div>
        <div class="edge-locked-grid">
          <div class="edge-locked"><div>🔒 PREMIUM</div><strong>Top Value Bet</strong><p>High-confidence edge detected.</p><button class="edge-pod-btn" onclick="window.edgeShowPaywall('best_edges')">Unlock</button></div>
          <div class="edge-locked"><div>🔒 PREMIUM</div><strong>Line Movement Alert</strong><p>Deep AI watches for better prices.</p><button class="edge-pod-btn" onclick="window.edgeShowPaywall('line_movement')">Unlock</button></div>
          <div class="edge-locked"><div>🔒 PREMIUM</div><strong>Risk Filtered Pick</strong><p>Skip noisy bets. Focus on value.</p><button class="edge-pod-btn" onclick="window.edgeShowPaywall('risk_filtered')">Unlock</button></div>
        </div>
      </div>
    </div>
  `;

  container.insertAdjacentHTML('beforeend', html);
  trackEvent('home_upgrade_rendered');
});
