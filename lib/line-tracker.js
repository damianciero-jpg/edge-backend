/**
 * EDGE Line Tracker — v2
 *
 * Tracks opening and current lines for BOTH teams in a game.
 * Uses real Odds API game IDs for reliable matching.
 *
 * Signals produced:
 *   - Line movement score (-10 to +10): did the line move toward or away from this side?
 *   - Reverse Line Movement (RLM): line moved opposite to public money direction
 *     RLM is one of the strongest sharp money signals in sports betting.
 *
 * Keys expire 48 hours after creation.
 */

const { hasRedisConfig, createRedis } = require('./redis');

const KEY      = (gameId, team) => `edge:line:v2:${gameId}:${team.toLowerCase().replace(/\s+/g, '_')}`;
const GAME_KEY = (gameId)       => `edge:game:v2:${gameId}`;
const TTL = 48 * 60 * 60; // 48 hours

// ─── OPENING LINE STORAGE ─────────────────────────────────────────────────────

async function recordOpeningLine(gameId, team, americanOdds) {
  if (!hasRedisConfig() || !gameId || !team || americanOdds == null) return;
  try {
    const redis = createRedis();
    const key = KEY(gameId, team);
    const existing = await redis.get(key);
    if (!existing) {
      await redis.set(key, { odds: americanOdds, recordedAt: new Date().toISOString() }, { ex: TTL });
    }
  } catch (err) {
    console.warn('Line tracker recordOpeningLine error:', err.message);
  }
}

async function recordGameLines(gameId, homeTeam, awayTeam, homeOdds, awayOdds) {
  if (!hasRedisConfig() || !gameId) return;
  try {
    const redis = createRedis();
    // Record each team's line if not seen before
    const [homeKey, awayKey] = [KEY(gameId, homeTeam), KEY(gameId, awayTeam)];
    const [existingHome, existingAway] = await Promise.all([
      redis.get(homeKey),
      redis.get(awayKey),
    ]);
    const now = new Date().toISOString();
    const ops = [];
    if (!existingHome && homeOdds != null) {
      ops.push(redis.set(homeKey, { odds: homeOdds, recordedAt: now }, { ex: TTL }));
    }
    if (!existingAway && awayOdds != null) {
      ops.push(redis.set(awayKey, { odds: awayOdds, recordedAt: now }, { ex: TTL }));
    }
    if (ops.length) await Promise.all(ops);
  } catch (err) {
    console.warn('Line tracker recordGameLines error:', err.message);
  }
}

async function getOpeningLine(gameId, team) {
  if (!hasRedisConfig() || !gameId || !team) return null;
  try {
    const redis = createRedis();
    const data = await redis.get(KEY(gameId, team));
    return data ? data.odds : null;
  } catch (err) {
    console.warn('Line tracker getOpeningLine error:', err.message);
    return null;
  }
}

// ─── LINE MOVEMENT MATH ───────────────────────────────────────────────────────

function toImplied(american) {
  const n = Number(american);
  if (!Number.isFinite(n) || n === 0) return null;
  return n > 0 ? 100 / (n + 100) : Math.abs(n) / (Math.abs(n) + 100);
}

function calcLineMovementScore(openingOdds, currentOdds) {
  if (openingOdds == null || currentOdds == null) return 0;
  const opening = Number(openingOdds);
  const current = Number(currentOdds);
  if (!Number.isFinite(opening) || !Number.isFinite(current)) return 0;
  // Positive = price got longer (value moved in our favor)
  const raw = (current - opening) / 10;
  return Math.max(-10, Math.min(10, raw));
}

// ─── REVERSE LINE MOVEMENT ────────────────────────────────────────────────────
// RLM = line moves OPPOSITE to where the public money is going.
// If 70%+ of tickets are on Team A but the line moves toward Team B,
// sharp money is on Team B — one of the strongest betting signals available.
//
// We approximate public money direction from the line movement itself:
// In an efficient market, lines move toward the side taking more action.
// When a line moves away from a heavy favorite (shortens the dog), that's RLM.
//
// RLM Score: -5 to +5
//   +5 = strong RLM in favor of this side (sharp money here)
//   -5 = strong RLM against this side (sharp money on the other side)
//    0 = no RLM signal

function calcRLMScore(homeOpenOdds, awayOpenOdds, homeCurrentOdds, awayCurrentOdds) {
  if (!homeOpenOdds || !awayOpenOdds || !homeCurrentOdds || !awayCurrentOdds) return 0;

  const homeOpenImpl  = toImplied(homeOpenOdds);
  const awayOpenImpl  = toImplied(awayOpenOdds);
  const homeCurrImpl  = toImplied(homeCurrentOdds);
  const awayCurrImpl  = toImplied(awayCurrentOdds);

  if (!homeOpenImpl || !awayOpenImpl || !homeCurrImpl || !awayCurrImpl) return 0;

  // Which team is the public favorite (higher implied prob at open)?
  const homeIsFavorite = homeOpenImpl > awayOpenImpl;

  // How did the line move? Did the favorite get shorter (more public money in)?
  const homeMovement = homeCurrImpl - homeOpenImpl; // positive = got shorter (more likely)
  const awayMovement = awayCurrImpl - awayOpenImpl;

  // RLM: favorite's line moves longer (public is on them but sharp fades)
  // This is expressed as a signal for the UNDERDOG side
  if (homeIsFavorite) {
    // If home (favorite) line moved longer despite public support → RLM for away
    if (homeMovement < -0.02) {
      const strength = Math.min(5, Math.abs(homeMovement) * 100);
      return -strength; // negative for home, positive would be for away
    }
  } else {
    // Away is favorite — if away line moved longer → RLM for home
    if (awayMovement < -0.02) {
      const strength = Math.min(5, Math.abs(awayMovement) * 100);
      return strength; // positive for home
    }
  }

  return 0;
}

// ─── FULL SIGNAL ──────────────────────────────────────────────────────────────

async function getLineMovementSignal(gameId, team, currentOdds) {
  const openingOdds = await getOpeningLine(gameId, team);

  if (openingOdds == null) {
    await recordOpeningLine(gameId, team, currentOdds);
    return { score: 0, openingOdds: null, currentOdds, direction: 'UNKNOWN', basisPoints: 0, rlmScore: 0 };
  }

  const score       = calcLineMovementScore(openingOdds, currentOdds);
  const basisPoints = Number(currentOdds) - Number(openingOdds);

  let direction = 'STABLE';
  if (basisPoints > 5)  direction = 'STEAM';
  if (basisPoints < -5) direction = 'FADE';

  return { score, openingOdds, currentOdds, direction, basisPoints, rlmScore: 0 };
}

async function getGameLineSignals(gameId, homeTeam, awayTeam, homeCurrentOdds, awayCurrentOdds) {
  // Get opening lines for both teams
  const [homeOpen, awayOpen] = await Promise.all([
    getOpeningLine(gameId, homeTeam),
    getOpeningLine(gameId, awayTeam),
  ]);

  // Record if first time seeing this game
  await recordGameLines(gameId, homeTeam, awayTeam,
    homeOpen == null ? homeCurrentOdds : null,
    awayOpen == null ? awayCurrentOdds : null,
  );

  const homeScore = calcLineMovementScore(homeOpen, homeCurrentOdds);
  const awayScore = calcLineMovementScore(awayOpen, awayCurrentOdds);
  const rlmScore  = calcRLMScore(homeOpen, awayOpen, homeCurrentOdds, awayCurrentOdds);

  const homeBasis = homeOpen != null ? Number(homeCurrentOdds) - Number(homeOpen) : 0;
  const awayBasis = awayOpen != null ? Number(awayCurrentOdds) - Number(awayOpen) : 0;

  return {
    home: {
      score:        homeScore,
      openingOdds:  homeOpen,
      currentOdds:  homeCurrentOdds,
      basisPoints:  homeBasis,
      direction:    homeBasis > 5 ? 'STEAM' : homeBasis < -5 ? 'FADE' : homeOpen ? 'STABLE' : 'UNKNOWN',
    },
    away: {
      score:        awayScore,
      openingOdds:  awayOpen,
      currentOdds:  awayCurrentOdds,
      basisPoints:  awayBasis,
      direction:    awayBasis > 5 ? 'STEAM' : awayBasis < -5 ? 'FADE' : awayOpen ? 'STABLE' : 'UNKNOWN',
    },
    rlmScore,
    rlmDirection: rlmScore > 2 ? 'HOME_VALUE' : rlmScore < -2 ? 'AWAY_VALUE' : 'NEUTRAL',
    hasHistory: homeOpen != null || awayOpen != null,
  };
}

module.exports = {
  recordOpeningLine,
  recordGameLines,
  getOpeningLine,
  getLineMovementSignal,
  getGameLineSignals,
  calcLineMovementScore,
  calcRLMScore,
};
