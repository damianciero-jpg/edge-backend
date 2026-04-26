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

  async function goToCheckout() {
    const res = await fetch('/api/create-checkout-session', { method: 'POST' });
    const data = await res.json();
    if (data.url) window.location.href = data.url;
  }

  function showPaywall() {
    const modal = document.createElement('div');
    modal.style = `position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.9);display:flex;align-items:center;justify-content:center;z-index:9999;`;
    modal.innerHTML = `
      <div style="background:#0d1219;padding:30px;border:1px solid #243447;text-align:center">
        <h2 style="color:#00e5ff">Unlock EDGE Premium</h2>
        <p>Get Deep AI, best edges, and alerts</p>
        <button onclick="(${goToCheckout.toString()})()" style="background:#00e5ff;color:black;padding:12px 20px;margin-top:15px;">Upgrade Now - $9.99/mo</button>
      </div>`;
    document.body.appendChild(modal);
  }

  async function runAnalysis(useSearch) {
    const prompt = document.getElementById('manualInput').value.trim();
    if (!prompt) return alert('Enter a bet');

    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, useSearch, secondLayer: useSearch })
    });

    const data = await res.json();

    if (data.paywall) {
      showPaywall();
      return;
    }

    alert(data.text);
  }

  const html = `
    <div id="edgeUpgradePanel">
      <input id="manualInput" placeholder="Paste bet" />
      <button onclick="runAnalysis(false)">Quick AI</button>
      <button onclick="runAnalysis(true)">Deep AI</button>
    </div>
  `;

  container.insertAdjacentHTML('beforeend', html);
});
