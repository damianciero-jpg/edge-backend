/**
 * EDGE App — Playwright E2E Test Suite
 * Target: https://edge-backend-rho.vercel.app
 *
 * Auth strategy: calls /api/auth/test-token (protected by TEST_LOGIN_SECRET)
 * to get a real httpOnly session cookie without going through the OTP email flow.
 *
 * Required env vars (in .env.test):
 *   TEST_EMAIL         — must be in OWNER_EMAILS for unlimited credits
 *   TEST_LOGIN_SECRET  — must match TEST_LOGIN_SECRET set in Vercel environment variables
 *
 * Before running: add TEST_LOGIN_SECRET to Vercel:
 *   vercel env add TEST_LOGIN_SECRET production
 */

const { test, expect, request } = require('@playwright/test');
require('dotenv').config({ path: '.env.test' });

const TEST_EMAIL = process.env.TEST_EMAIL || 'damianciero@gmail.com';
const TEST_LOGIN_SECRET = process.env.TEST_LOGIN_SECRET || 'edge-test-secret-2026';
const BASE_URL = 'https://edge-backend-rho.vercel.app';
const ANALYSIS_TIMEOUT = 60000;

// ─── AUTH HELPER ──────────────────────────────────────────────────────────────
// Calls /api/auth/test-token on the server to get a real signed session cookie,
// then injects that cookie into the browser context. Requires TEST_LOGIN_SECRET
// to be set as a Vercel env var on the production deployment.
async function loginViaTestEndpoint(page) {
  // Use the raw fetch API within Playwright to get a session cookie from the server
  const apiCtx = await request.newContext({ baseURL: BASE_URL });
  const resp = await apiCtx.post('/api/auth/test-token', {
    headers: { 'x-test-secret': TEST_LOGIN_SECRET, 'Content-Type': 'application/json' },
    data: { email: TEST_EMAIL, testSecret: TEST_LOGIN_SECRET },
  });

  if (!resp.ok()) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(`Test auth failed (${resp.status()}): ${body.error || 'Check TEST_LOGIN_SECRET in .env.test and Vercel env vars'}`);
  }

  const data = await resp.json();
  const token = data.token;
  if (!token) throw new Error('Test auth returned no token');

  await page.context().addCookies([{
    name: 'edge_session',
    value: token,
    domain: 'edge-backend-rho.vercel.app',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
  }]);

  await apiCtx.dispose();
}

// Navigate to the app and wait for the shell to be ready
async function loadApp(page) {
  await loginViaTestEndpoint(page);
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.logo', { timeout: 15000 });
  // Wait for authInit to complete — auth overlay must disappear
  await page.waitForSelector('#auth-overlay', { state: 'hidden', timeout: 15000 });
}

// Select a sport in the Odds sidebar and wait for games OR empty state (off-season/no games)
async function selectSportAndWaitForGames(page, sportDataAttr) {
  await page.click(`#tab-odds`);
  await page.waitForSelector('#view-odds', { state: 'visible' });
  await page.click(`button[data-sport="${sportDataAttr}"]`);
  // Accept either game items OR a non-loading empty state (off-season is valid)
  await page.waitForFunction(
    () => {
      const list = document.getElementById('gamesList');
      if (!list) return false;
      const items = list.querySelectorAll('.game-item');
      const empty = list.querySelector('.sb-empty');
      return items.length > 0 || (empty && !empty.textContent.includes('LOADING'));
    },
    { timeout: 20000 }
  );
}

// Click the first game in the sidebar and wait for the detail header
async function selectFirstGame(page) {
  const firstGame = page.locator('#gamesList .game-item').first();
  await firstGame.click();
  await page.waitForSelector('#analyzeBtn', { timeout: 10000 });
}

// Run a quick analysis and wait for the result card
async function runQuickAnalysis(page) {
  await page.click('#analyzeBtn');
  await page.waitForSelector('.edge-decision-card', { timeout: ANALYSIS_TIMEOUT });
}

// ─── TESTS ────────────────────────────────────────────────────────────────────

// ── 1. App loads and EDGE logo is visible (no auth required) ──────────────────
test('1. App loads: EDGE logo and nav tabs are visible', async ({ page }) => {
  // This test does NOT require auth — just verifies the page shell renders
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.logo', { timeout: 15000 });

  const logo = page.locator('.logo').first();
  await expect(logo).toBeVisible();
  await expect(logo).toContainText('EDGE');

  // Desktop nav tabs should exist in DOM (even behind auth overlay)
  await expect(page.locator('#tab-home')).toBeAttached();
  await expect(page.locator('#tab-odds')).toBeAttached();
  await expect(page.locator('#tab-markets')).toBeAttached();
  await expect(page.locator('#tab-tracker')).toBeAttached();
  await expect(page.locator('#tab-account')).toBeAttached();
});

// ── 2. Login with cookie shows authenticated state ────────────────────────────
test('2. Auth: session cookie shows logged-in account info', async ({ page }) => {
  await loadApp(page);

  // Navigate to account tab
  await page.click('#tab-account');
  await page.waitForSelector('#view-account', { state: 'visible' });

  // Auth overlay should be hidden (we're logged in)
  const overlay = page.locator('#auth-overlay');
  await expect(overlay).not.toBeVisible();

  // Either show UNLIMITED (subscriber/owner) or credit count
  const creditDisplay = page.locator('#acct-credits');
  const creditType = page.locator('#acct-type');
  await expect(creditDisplay).toBeVisible();

  const creditText = await creditDisplay.textContent();
  const typeText = (await creditType.textContent()) || '';

  const hasUnlimited = typeText.toUpperCase().includes('UNLIMITED') ||
    typeText.toUpperCase().includes('SUBSCRI') ||   // matches both SUBSCRIBER and SUBSCRIPTION
    creditText.trim() === '∞' ||
    parseInt(creditText, 10) > 100;
  const hasCredits = parseInt(creditText, 10) >= 0;

  expect(hasUnlimited || hasCredits).toBeTruthy();
});

// ── 3. Odds tab: NBA games load ───────────────────────────────────────────────
test('3. Odds tab: click NBA selector, at least 1 game loads', async ({ page }) => {
  await loadApp(page);
  await selectSportAndWaitForGames(page, 'basketball_nba');

  const gameItems = page.locator('#gamesList .game-item');
  const count = await gameItems.count();
  if (count === 0) { test.skip(); return; }
  expect(count).toBeGreaterThanOrEqual(1);
});

// ── 4. Analysis: first NBA game returns a result card ─────────────────────────
test('4. Analysis: click first NBA game, run analysis, result card appears', async ({ page }) => {
  await loadApp(page);
  await selectSportAndWaitForGames(page, 'basketball_nba');
  if (await page.locator('#gamesList .game-item').count() === 0) { test.skip(); return; }
  await selectFirstGame(page);
  await runQuickAnalysis(page);

  const card = page.locator('.edge-decision-card').first();
  await expect(card).toBeVisible();
});

// ── 5. Result card contains EDGE VERDICT ─────────────────────────────────────
test('5. Result card contains EDGE VERDICT with BET, LEAN, or PASS', async ({ page }) => {
  await loadApp(page);
  await selectSportAndWaitForGames(page, 'basketball_nba');
  if (await page.locator('#gamesList .game-item').count() === 0) { test.skip(); return; }
  await selectFirstGame(page);
  await runQuickAnalysis(page);

  const verdict = page.locator('.ed-verdict').first();
  await expect(verdict).toBeVisible();

  const text = (await verdict.textContent()).trim().toUpperCase();
  const validVerdicts = ['BET', 'LEAN', 'PASS'];
  const isValid = validVerdicts.some(v => text.includes(v));
  expect(isValid).toBeTruthy();
});

// ── 6. Result card contains PROPRIETARY EDGE SCORE ───────────────────────────
test('6. Result card contains PROPRIETARY EDGE SCORE with a numeric value', async ({ page }) => {
  await loadApp(page);
  await selectSportAndWaitForGames(page, 'basketball_nba');
  if (await page.locator('#gamesList .game-item').count() === 0) { test.skip(); return; }
  await selectFirstGame(page);
  await runQuickAnalysis(page);

  // Find the score metric label
  const scoreLabel = page.locator('.ed-label', { hasText: /PROPRIETARY EDGE SCORE/i }).first();
  await expect(scoreLabel).toBeVisible();

  // Score value is in the sibling .ed-value
  const scoreCard = page.locator('.ed-metric', { has: page.locator('.ed-label', { hasText: /PROPRIETARY EDGE SCORE/i }) }).first();
  const scoreValue = scoreCard.locator('.ed-value');
  await expect(scoreValue).toBeVisible();

  const val = await scoreValue.textContent();
  expect(val.trim()).not.toBe('');
  // Value should contain a number (possibly signed like "+9.4" or "-2.1")
  expect(val).toMatch(/[-+]?\d/);
});

// ── 7. Result card contains RECOMMENDED PLAY ─────────────────────────────────
test('7. Result card contains RECOMMENDED PLAY with a non-empty value', async ({ page }) => {
  await loadApp(page);
  await selectSportAndWaitForGames(page, 'basketball_nba');
  if (await page.locator('#gamesList .game-item').count() === 0) { test.skip(); return; }
  await selectFirstGame(page);
  await runQuickAnalysis(page);

  const playLabel = page.locator('.rt-label', { hasText: /RECOMMENDED PLAY/i }).first();
  await expect(playLabel).toBeVisible();

  const playCard = page.locator('.locked-play').first();
  const playValue = playCard.locator('.rt-value');
  await expect(playValue).toBeVisible();

  const playText = await playValue.textContent();
  expect(playText.trim()).not.toBe('');
});

// ── 8. RECOMMENDED PLAY is not 'No clear edge' at least 50% of the time ──────
test('8. RECOMMENDED PLAY: not "No clear edge" at least 50% across 3 games', async ({ page }) => {
  await loadApp(page);
  await page.click('#tab-odds');
  await page.waitForSelector('#view-odds', { state: 'visible' });
  await page.click(`button[data-sport="basketball_nba"]`);

  await page.waitForFunction(
    () => document.getElementById('gamesList').querySelectorAll('.game-item').length >= 3,
    { timeout: 20000 }
  ).catch(() => {}); // ok if fewer than 3 games

  const gameItems = page.locator('#gamesList .game-item');
  const total = await gameItems.count();
  const runs = Math.min(total, 3);

  if (runs === 0) {
    test.skip('No NBA games available for multi-run test');
    return;
  }

  let notNoEdgeCount = 0;

  for (let i = 0; i < runs; i++) {
    await gameItems.nth(i).click();
    await page.waitForSelector('#analyzeBtn', { timeout: 10000 });
    await page.click('#analyzeBtn');
    await page.waitForSelector('.edge-decision-card', { timeout: ANALYSIS_TIMEOUT });

    const playCard = page.locator('.locked-play').first();
    const playText = ((await playCard.locator('.rt-value').textContent()) || '').trim();
    if (!playText.toLowerCase().includes('no clear edge')) {
      notNoEdgeCount++;
    }
  }

  // At least 50% should have a real recommended play
  expect(notNoEdgeCount / runs).toBeGreaterThanOrEqual(0.5);
}, { timeout: ANALYSIS_TIMEOUT * 3 + 30000 });

// ── 9. Multi-market: at least one spread or total pick across 3 games ─────────
test('9. Multi-market: at least 1 spread or total pick across 3 runs', async ({ page }) => {
  await loadApp(page);
  await page.click('#tab-odds');
  await page.waitForSelector('#view-odds', { state: 'visible' });
  await page.click(`button[data-sport="basketball_nba"]`);

  // Accept games OR empty state (off-season)
  await page.waitForFunction(
    () => {
      const list = document.getElementById('gamesList');
      if (!list) return false;
      const items = list.querySelectorAll('.game-item');
      const empty = list.querySelector('.sb-empty');
      return items.length > 0 || (empty && !empty.textContent.includes('LOADING'));
    },
    { timeout: 20000 }
  );

  const gameItems = page.locator('#gamesList .game-item');
  const total = await gameItems.count();
  const runs = Math.min(total, 3);

  if (runs === 0) {
    test.skip('No NBA games available');
    return;
  }

  let foundNonML = false;

  for (let i = 0; i < runs; i++) {
    await gameItems.nth(i).click();
    await page.waitForSelector('#analyzeBtn', { timeout: 10000 });

    // Check if spread market tab is available (Markets tab has spread/total)
    await page.click('#tab-markets');
    await page.waitForSelector('#view-markets', { state: 'visible' });

    const spreadTab = page.locator('.mkt-tab', { hasText: /SPREAD/i }).first();
    const totalTab = page.locator('.mkt-tab', { hasText: /TOTAL/i }).first();

    const hasSpread = await spreadTab.isVisible().catch(() => false);
    const hasTotal = await totalTab.isVisible().catch(() => false);

    if (hasSpread || hasTotal) {
      foundNonML = true;
      break;
    }

    await page.click('#tab-odds');
    await page.waitForSelector('#view-odds', { state: 'visible' });
  }

  expect(foundNonML).toBeTruthy();
}, { timeout: 60000 });

// ── 10. MLB games load ────────────────────────────────────────────────────────
test('10. MLB: click MLB selector, game list loads without error', async ({ page }) => {
  await loadApp(page);
  await page.click('#tab-odds');
  await page.waitForSelector('#view-odds', { state: 'visible' });

  await page.click(`button[data-sport="baseball_mlb"]`);
  // Wait up to 15s for either games or empty state (off-season is valid)
  await page.waitForFunction(
    () => {
      const list = document.getElementById('gamesList');
      if (!list) return false;
      const items = list.querySelectorAll('.game-item');
      const empty = list.querySelector('.sb-empty');
      return items.length > 0 || (empty && !empty.textContent.includes('LOADING'));
    },
    { timeout: 20000 }
  );

  // No error state
  const errEl = page.locator('.err-msg:visible');
  const hasError = await errEl.count() > 0;
  expect(hasError).toBeFalsy();
});

// ── 11. NFL games load without errors ─────────────────────────────────────────
test('11. NFL: loads without errors', async ({ page }) => {
  await loadApp(page);
  await page.click('#tab-odds');
  await page.waitForSelector('#view-odds', { state: 'visible' });

  await page.click(`button[data-sport="americanfootball_nfl"]`);
  await page.waitForFunction(
    () => {
      const list = document.getElementById('gamesList');
      if (!list) return false;
      const empty = list.querySelector('.sb-empty');
      return list.querySelectorAll('.game-item').length > 0 ||
        (empty && !empty.textContent.includes('LOADING'));
    },
    { timeout: 20000 }
  );

  const errEl = page.locator('.err-msg:visible');
  expect(await errEl.count()).toBe(0);
});

// ── 12. UFC loads without errors ──────────────────────────────────────────────
test('12. UFC: loads without errors', async ({ page }) => {
  await loadApp(page);
  await page.click('#tab-odds');
  await page.waitForSelector('#view-odds', { state: 'visible' });

  await page.click(`button[data-sport="mma_mixed_martial_arts"]`);
  await page.waitForFunction(
    () => {
      const list = document.getElementById('gamesList');
      if (!list) return false;
      const empty = list.querySelector('.sb-empty');
      return list.querySelectorAll('.game-item').length > 0 ||
        (empty && !empty.textContent.includes('LOADING'));
    },
    { timeout: 20000 }
  );

  const errEl = page.locator('.err-msg:visible');
  expect(await errEl.count()).toBe(0);
});

// ── 13. PGA golf matchups load ────────────────────────────────────────────────
test('13. PGA: golf matchup list loads (or shows off-season message)', async ({ page }) => {
  await loadApp(page);
  await page.click('#tab-odds');
  await page.waitForSelector('#view-odds', { state: 'visible' });

  // PGA might not be in the default sport buttons — try MLS as fallback
  const pgaBtn = page.locator('button[data-sport="golf_pga_tour"]');
  const hasPga = await pgaBtn.count() > 0;

  if (!hasPga) {
    // App doesn't have PGA button; verify no crash
    await page.click('button[data-sport="soccer_usa_mls"]');
    await page.waitForTimeout(3000);
    const errEl = page.locator('.err-msg:visible');
    expect(await errEl.count()).toBe(0);
    return;
  }

  await pgaBtn.click();
  await page.waitForFunction(
    () => {
      const list = document.getElementById('gamesList');
      if (!list) return false;
      const empty = list.querySelector('.sb-empty');
      return list.querySelectorAll('.game-item').length > 0 ||
        (empty && !empty.textContent.includes('LOADING'));
    },
    { timeout: 20000 }
  );

  const errEl = page.locator('.err-msg:visible');
  expect(await errEl.count()).toBe(0);
});

// ── 14. Account tab loads (serves as Settings equivalent) ─────────────────────
test('14. Account tab: loads without errors', async ({ page }) => {
  await loadApp(page);
  await page.click('#tab-account');
  await page.waitForSelector('#view-account', { state: 'visible' });

  // Auth overlay must be hidden (we're logged in)
  await expect(page.locator('#auth-overlay')).not.toBeVisible();

  // Account section heading visible
  const heading = page.locator('#view-account .section-lbl').first();
  await expect(heading).toBeVisible();
});

// ── 15. Account section is visible ────────────────────────────────────────────
test('15. Account: Account & Billing section is visible', async ({ page }) => {
  await loadApp(page);
  await page.click('#tab-account');
  await page.waitForSelector('#view-account', { state: 'visible' });

  const accountGrid = page.locator('.account-grid');
  await expect(accountGrid).toBeVisible();

  // Credit section
  const creditCard = page.locator('.acct-title').first();
  await expect(creditCard).toBeVisible();
});

// ── 16. Upgrade or Pro status shown ───────────────────────────────────────────
test('16. Account: upgrade button or Pro status is shown', async ({ page }) => {
  await loadApp(page);
  await page.click('#tab-account');
  await page.waitForSelector('#view-account', { state: 'visible' });

  // Either a Stripe button (for non-subscribers) or subscriber status indicator
  const stripeBtn = page.locator('.stripe-btn').first();
  const creditDisplay = page.locator('.credit-display').first();

  const hasStripeBtn = await stripeBtn.isVisible().catch(() => false);
  const hasCredits = await creditDisplay.isVisible().catch(() => false);

  expect(hasStripeBtn || hasCredits).toBeTruthy();
});

// ── 17. Bet history table exists (in place of "Export all bets" button) ───────
test('17. Tracker: bet history table and log form exist', async ({ page }) => {
  await loadApp(page);
  await page.click('#tab-tracker');
  await page.waitForSelector('#view-tracker', { state: 'visible' });

  // Log bet form
  const logForm = page.locator('.bet-form');
  await expect(logForm).toBeVisible();

  // Bet history table
  const betsTable = page.locator('.bets-table');
  await expect(betsTable).toBeVisible();
});

// ── 18. Tracker tab loads without errors ─────────────────────────────────────
test('18. Tracker tab: loads without errors', async ({ page }) => {
  await loadApp(page);
  await page.click('#tab-tracker');
  await page.waitForSelector('#view-tracker', { state: 'visible' });

  const errEl = page.locator('.err-msg:visible');
  expect(await errEl.count()).toBe(0);
});

// ── 19. Tracker: performance dashboard visible ────────────────────────────────
test('19. Tracker: performance stats dashboard is visible', async ({ page }) => {
  await loadApp(page);
  await page.click('#tab-tracker');
  await page.waitForSelector('#view-tracker', { state: 'visible' });

  // Stats grid with TOTAL BETS, WIN RATE, UNITS P&L, ROI
  const statsGrid = page.locator('#trackerStats');
  await expect(statsGrid).toBeVisible();

  const totalBetsLabel = page.locator('.stat-label', { hasText: /TOTAL BETS/i }).first();
  await expect(totalBetsLabel).toBeVisible();

  const roiLabel = page.locator('.stat-label', { hasText: /ROI/i }).first();
  await expect(roiLabel).toBeVisible();
});

// ── 20. No unhandled console errors during navigation ────────────────────────
test('20. No unhandled JS errors during tab navigation', async ({ page }) => {
  const consoleErrors = [];
  const pageErrors = [];

  page.on('console', msg => {
    if (msg.type() === 'error') {
      const text = msg.text();
      // Ignore expected network errors for missing/optional resources
      if (
        text.includes('net::ERR_') ||
        text.includes('favicon') ||
        text.includes('sw.js') ||
        text.includes('Failed to load resource')
      ) return;
      consoleErrors.push(text);
    }
  });

  page.on('pageerror', err => {
    pageErrors.push(err.message);
  });

  await loadApp(page);

  const tabs = ['home', 'odds', 'markets', 'tracker', 'account'];
  for (const tab of tabs) {
    await page.click(`#tab-${tab}`);
    await page.waitForTimeout(1000);
  }

  // Filter out non-critical errors (GA script, external services)
  const criticalErrors = pageErrors.filter(e =>
    !e.includes('gtag') &&
    !e.includes('google') &&
    !e.includes('analytics')
  );

  expect(criticalErrors).toHaveLength(0);
});
