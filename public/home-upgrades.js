document.addEventListener('DOMContentLoaded', () => {
  const container = document.querySelector('.welcome');
  if (!container) return;
  if (document.getElementById('edgeUpgradePanel')) return;

  const style = document.createElement('style');
  style.textContent = `
    .edge-upgrade-panel{width:min(920px,96%);margin:24px auto 0;text-align:left;}
    .edge-hero-copy{font-size:13px;color:#b0ccd8;line-height:1.7;text-align:center;max-width:720px;margin:0 auto 18px;}
    .edge-manual-card,.edge-results-card,.edge-alert-card{background:#0d1219;border:1px solid #1e2d3d;padding:16px;margin-top:14px;}
    .edge-card-title{font-family:'Space Mono',monospace;font-size:10px;letter-spacing:2px;color:#00e5ff;margin-bottom:8px;text-transform:uppercase;}
    .edge-manual-row{display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:center;}
    #manualInput{width:100%;padding:12px;background:#080c10;border:1px solid #243447;color:#e8f4f8;font-family:'Space Mono',monospace;font-size:11px;outline:none;}
    #manualInput:focus{border-color:#00e5ff;}
    .edge-mode-btn,.edge-small-btn{background:#00e5ff;color:#080c10;border:0;font-family:'Space Mono',monospace;font-size:9px;font-weight:700;letter-spacing:1px;padding:11px 13px;cursor:pointer;}
    .edge-mode-btn.deep{background:#7b61ff;color:#fff;}
    .edge-mode-btn:disabled,.edge-small-btn:disabled{opacity:.5;cursor:not-allowed;}
    .edge-help{font-family:'Space Mono',monospace;font-size:8px;color:#5a7a8a;margin-top:8px;line-height:1.7;}
    .edge-results-card{display:none;}
    .edge-result-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:12px 0;}
    .edge-metric{border:1px solid #243447;background:#080c10;padding:10px;}
    .edge-metric-label{font-family:'Space Mono',monospace;font-size:8px;color:#5a7a8a;letter-spacing:1px;margin-bottom:5px;text-transform:uppercase;}
    .edge-metric-value{font-family:'Space Mono',monospace;font-size:16px;font-weight:700;color:#00e5ff;}
    .edge-result-text{white-space:pre-wrap;font-size:12px;line-height:1.7;color:#b0ccd8;max-height:280px;overflow:auto;border-top:1px solid #1e2d3d;padding-top:12px;}
    .edge-risk-low{color:#00ff88!important}.edge-risk-medium{color:#ffd600!important}.edge-risk-high{color:#ff3b5c!important}
    .edge-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:10px;}
    .edge-card{border:1px solid #243447;background:#080c10;padding:12px;min-height:150px;display:flex;flex-direction:column;gap:6px;}
    .edge-card-sport{font-family:'Space Mono',monospace;font-size:8px;color:#7b61ff;letter-spacing:2px;}
    .edge-card-matchup{font-weight:800;font-size:13px;line-height:1.3;}
    .edge-card-pick{font-family:'Space Mono',monospace;font-size:11px;color:#00e5ff;}
    .edge-card-meta{font-family:'Space Mono',monospace;font-size:8px;color:#5a7a8a;line-height:1.6;}
    .edge-card button{margin-top:auto;background:transparent;border:1px solid #243447;color:#00e5ff;padding:8px;font-family:'Space Mono',monospace;font-size:8px;cursor:pointer;}
    .edge-alert-row{display:grid;grid-template-columns:1fr auto;gap:8px;}
    .edge-alert-row input{background:#080c10;border:1px solid #243447;color:#e8f4f8;padding:10px;font-family:'Space Mono',monospace;font-size:10px;outline:none;}
    .edge-disclaimer{font-family:'Space Mono',monospace;font-size:8px;color:#5a7a8a;text-align:center;margin-top:14px;line-height:1.8;}
    @media(max-width:768px){.edge-manual-row,.edge-alert-row{grid-template-columns:1fr}.edge-result-grid,.edge-cards{grid-template-columns:1fr}.edge-upgrade-panel{width:100%;}.edge-mode-btn{width:100%;}}
  `;
  document.head.appendChild(style);

  const html = `
    <div id="edgeUpgradePanel" class="edge-upgrade-panel">
      <p class="edge-hero-copy">Find smarter bets in seconds. EDGE compares risk, confidence, and value signals so you can decide whether to Bet, Lean, or Pass.</p>

      <div class="edge-manual-card">
        <div class="edge-card-title">Manual Bet Analysis</div>
        <div class="edge-manual-row">
          <input id="manualInput" placeholder="Paste a bet: Phillies moneyline +120 vs Mets" />
          <button id="quickBtn" class="edge-mode-btn">⚡ Quick AI</button>
          <button id="deepBtn" class="edge-mode-btn deep">🔍 Deep AI</button>
        </div>
        <div class="edge-help">Quick AI = fast basic analysis. Deep AI = premium research mode. Deep AI is intentionally not the default.</div>
      </div>

      <div id="analysisResult" class="edge-results-card">
        <div class="edge-card-title">Analysis Result</div>
        <div class="edge-result-grid">
          <div class="edge-metric"><div class="edge-metric-label">Verdict</div><div id="metricVerdict" class="edge-metric-value">—</div></div>
          <div class="edge-metric"><div class="edge-metric-label">Confidence</div><div id="metricConfidence" class="edge-metric-value">—</div></div>
          <div class="edge-metric"><div class="edge-metric-label">EV</div><div id="metricEv" class="edge-metric-value">—</div></div>
          <div class="edge-metric"><div class="edge-metric-label">Risk</div><div id="metricRisk" class="edge-metric-value">—</div></div>
        </div>
        <div id="resultText" class="edge-result-text"></div>
      </div>

      <div style="margin-top:24px">
        <div class="edge-card-title">Today’s Best Edges</div>
        <div id="edges" class="edge-cards"></div>
      </div>

      <div class="edge-alert-card">
        <div class="edge-card-title">Email Alerts</div>
        <div class="edge-alert-row">
          <input id="alertEmail" placeholder="email@example.com" />
          <button id="alertBtn" class="edge-small-btn">Send Test Alert</button>
        </div>
        <div class="edge-help">Uses Resend when RESEND_API_KEY and FROM_EMAIL are configured in Vercel.</div>
      </div>

      <div class="edge-disclaimer">EDGE does not guarantee wins. Use analysis as decision support, not financial advice. Bet responsibly.</div>
    </div>
  `;

  container.insertAdjacentHTML('beforeend', html);

  const defaultEdges = [
    { sport:'MLB', matchup:'Run analysis to unlock', pick:'No pick yet', confidence:'—', risk:'—', prompt:'Phillies moneyline +120 vs Mets' },
    { sport:'NBA', matchup:'Run analysis to unlock', pick:'No pick yet', confidence:'—', risk:'—', prompt:'Knicks spread -3.5' },
    { sport:'NHL', matchup:'Run analysis to unlock', pick:'No pick yet', confidence:'—', risk:'—', prompt:'Flyers over 5.5' }
  ];

  function getCachedEdges() {
    try { return JSON.parse(localStorage.getItem('edge_best_edges') || 'null') || defaultEdges; }
    catch { return defaultEdges; }
  }

  function saveEdge(edge) {
    const current = getCachedEdges().filter(e => e.matchup !== edge.matchup);
    localStorage.setItem('edge_best_edges', JSON.stringify([edge, ...current].slice(0, 3)));
    renderEdges();
  }

  function renderEdges() {
    const wrap = document.getElementById('edges');
    wrap.innerHTML = getCachedEdges().map((edge, idx) => `
      <div class="edge-card">
        <div class="edge-card-sport">${edge.sport || 'EDGE'}</div>
        <div class="edge-card-matchup">${edge.matchup || 'Run analysis to unlock'}</div>
        <div class="edge-card-pick">${edge.pick || 'No pick yet'}</div>
        <div class="edge-card-meta">Confidence: ${edge.confidence || '—'}<br>Risk: ${edge.risk || '—'}</div>
        <button data-edge-index="${idx}">Analyze</button>
      </div>
    `).join('');

    wrap.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        const edge = getCachedEdges()[Number(btn.dataset.edgeIndex)];
        document.getElementById('manualInput').value = edge.prompt || edge.matchup || '';
        document.getElementById('manualInput').focus();
      });
    });
  }

  function parseAnalysis(text) {
    let raw = String(text || '').trim();
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch {}
    const haystack = parsed ? JSON.stringify(parsed) : raw;
    const confidenceMatch = haystack.match(/confidence[^0-9]{0,12}(\d{1,3})/i);
    const evMatch = haystack.match(/(?:ev|expected value)[^\-+0-9]{0,12}([\-+]?\d+(?:\.\d+)?%?)/i);
    const riskMatch = haystack.match(/risk[^a-z]{0,12}(low|medium|high)/i);
    const verdictMatch = haystack.match(/verdict[^a-z]{0,12}(bet|lean|pass)/i) || haystack.match(/\b(bet|lean|pass)\b/i);

    return {
      parsed,
      verdict: parsed?.verdict || parsed?.recommendation || (verdictMatch ? verdictMatch[1].toUpperCase() : 'REVIEW'),
      confidence: parsed?.confidence || parsed?.confidence_score || (confidenceMatch ? `${confidenceMatch[1]}%` : '—'),
      ev: parsed?.ev || parsed?.expected_value || (evMatch ? evMatch[1] : '—'),
      risk: parsed?.risk || parsed?.risk_level || (riskMatch ? riskMatch[1].toUpperCase() : '—')
    };
  }

  async function runAnalysis(useSearch) {
    const prompt = document.getElementById('manualInput').value.trim();
    if (!prompt) return showResult('Enter a bet first.', true);

    const quick = document.getElementById('quickBtn');
    const deep = document.getElementById('deepBtn');
    quick.disabled = true;
    deep.disabled = true;
    showResult(`${useSearch ? 'Deep AI' : 'Quick AI'} is analyzing...`, false, { verdict:'...', confidence:'...', ev:'...', risk:'...' });

    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, useSearch, secondLayer: useSearch })
      });

      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Analysis failed');
      const metrics = parseAnalysis(data.text);
      showResult(data.text, false, metrics);

      saveEdge({
        sport: metrics.parsed?.sport || 'EDGE',
        matchup: metrics.parsed?.matchup || prompt,
        pick: metrics.parsed?.pick || metrics.parsed?.recommendation || metrics.verdict,
        confidence: metrics.confidence,
        risk: metrics.risk,
        prompt
      });
    } catch (err) {
      showResult(`Quick AI is temporarily unavailable. ${err.message}\n\nTry again, or use Manual Analysis with a simpler prompt.`, true);
    } finally {
      quick.disabled = false;
      deep.disabled = false;
    }
  }

  function showResult(text, isError, metrics = {}) {
    const result = document.getElementById('analysisResult');
    result.style.display = 'block';
    document.getElementById('resultText').textContent = text || '';
    document.getElementById('metricVerdict').textContent = metrics.verdict || (isError ? 'ERROR' : '—');
    document.getElementById('metricConfidence').textContent = metrics.confidence || '—';
    document.getElementById('metricEv').textContent = metrics.ev || '—';
    const riskEl = document.getElementById('metricRisk');
    riskEl.textContent = metrics.risk || '—';
    riskEl.className = 'edge-metric-value';
    const risk = String(metrics.risk || '').toLowerCase();
    if (risk.includes('low')) riskEl.classList.add('edge-risk-low');
    if (risk.includes('medium')) riskEl.classList.add('edge-risk-medium');
    if (risk.includes('high')) riskEl.classList.add('edge-risk-high');
    result.scrollIntoView({ behavior:'smooth', block:'nearest' });
  }

  async function sendAlert() {
    const email = document.getElementById('alertEmail').value.trim();
    if (!email) return showResult('Enter an email address first.', true);
    try {
      const res = await fetch('/api/alerts/test', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({ email })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Alert failed');
      showResult('Test alert sent. Check your inbox.', false, { verdict:'SENT', confidence:'—', ev:'—', risk:'LOW' });
    } catch (err) {
      showResult(`Email alert failed: ${err.message}`, true);
    }
  }

  document.getElementById('quickBtn').onclick = () => runAnalysis(false);
  document.getElementById('deepBtn').onclick = () => runAnalysis(true);
  document.getElementById('alertBtn').onclick = sendAlert;
  renderEdges();
});
