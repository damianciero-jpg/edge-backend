document.addEventListener('DOMContentLoaded', () => {
  const container = document.querySelector('.welcome');
  if (!container) return;

  const html = `
    <div style="margin-top:20px;text-align:center">
      <h3 style="margin-bottom:10px">Manual Bet Analysis</h3>
      <input id="manualInput" placeholder="Paste a bet (e.g. Phillies +120 vs Mets)" style="width:80%;padding:10px;margin-bottom:10px;background:#080c10;border:1px solid #243447;color:#e8f4f8" />
      <br/>
      <button id="quickBtn">⚡ Quick AI</button>
      <button id="deepBtn">🔍 Deep AI</button>
    </div>

    <div style="margin-top:30px">
      <h3>Today’s Best Edges</h3>
      <div id="edges" style="display:flex;gap:10px">
        <div style="border:1px solid #243447;padding:10px">Run analysis to unlock</div>
        <div style="border:1px solid #243447;padding:10px">Run analysis to unlock</div>
        <div style="border:1px solid #243447;padding:10px">Run analysis to unlock</div>
      </div>
    </div>
  `;

  container.insertAdjacentHTML('beforeend', html);

  async function runAnalysis(useSearch) {
    const prompt = document.getElementById('manualInput').value;
    if (!prompt) return alert('Enter a bet');

    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, useSearch })
    });

    const data = await res.json();
    alert(data.text || data.error);
  }

  document.getElementById('quickBtn').onclick = () => runAnalysis(false);
  document.getElementById('deepBtn').onclick = () => runAnalysis(true);
});
