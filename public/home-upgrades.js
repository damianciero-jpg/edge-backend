console.log("EDGE HOME SCRIPT LOADED");

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
        body: JSON.stringify({ prompt, useSearch, secondLayer: useSearch })
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
        <input id="manualInput" placeholder="Paste bet" style="min-width:220px;padding:8px;background:#080c10;border:1px solid #243447;color:#e8f4f8;" />
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
