'use strict';

// ─── FanDuel Roster Configurations ───────────────────────────────────────────
// All FanDuel slates run on a unified $60,000 salary cap.
// DraftKings config is deliberately absent — this module is FD-exclusive.

const GLOBAL_CAP = 60000;

const SPORT_CONFIGS = {

  // ── NBA Classic (9-man) ──────────────────────────────────────────────────
  nba_classic: {
    label:            'NBA Classic',
    sport:            'nba',
    isShowdown:       false,
    cap:              GLOBAL_CAP,
    minSalary:        3500,
    maxPlayersPerTeam: 4,
    slots:            ['PG', 'PG', 'SG', 'SG', 'SF', 'SF', 'PF', 'PF', 'C'],
    rosterBreakdown:  { pg: 2, sg: 2, sf: 2, pf: 2, c: 1 },
    stackingEnabled:  false,
    antiCorrelation:  false,
    // Punt / dud filter thresholds
    puntThreshold:    3500,
    usageColumn:      'projectedMinutes',
    usageMinimum:     15,
    // Upside engine fallback multiplier (no stdDev column)
    sportVarianceMultiplier: 1.15,
  },

  // ── NBA Showdown (MVP + 5 UTIL) ──────────────────────────────────────────
  nba_showdown: {
    label:             'NBA Showdown',
    sport:             'nba',
    isShowdown:        true,
    cap:               GLOBAL_CAP,
    minSalary:         1000,
    maxPlayersPerTeam: 5,
    slots:             ['MVP', 'UTIL', 'UTIL', 'UTIL', 'UTIL', 'UTIL'],
    rosterBreakdown:   { mvp: 1, util: 5 },
    stackingEnabled:   false,
    antiCorrelation:   false,
    puntThreshold:     1500,
    usageColumn:       'projectedMinutes',
    usageMinimum:      8,
    sportVarianceMultiplier: 1.15,
  },

  // ── MLB Classic (9-man, strict stacking) ────────────────────────────────
  // Unified 'C1B' slot accepts both C and 1B CSV positions.
  mlb_classic: {
    label:             'MLB Classic',
    sport:             'mlb',
    isShowdown:        false,
    cap:               35000,
    minSalary:         2000,
    maxHittersPerTeam: 5,        // beam soft cap; stacking engine overrides for target teams
    slots:             ['P', 'C1B', '2B', '3B', 'SS', 'OF', 'OF', 'OF', 'UTIL'],
    rosterBreakdown:   { p: 1, c1b: 1, '2b': 1, '3b': 1, ss: 1, of: 3, util: 1 },
    stackingEnabled:   true,
    stackingRules: {
      // Hitter distribution must satisfy one of: 5-3 (5 from Team A + 3 from Team B)
      // or 4-4 (4 from Team A + 4 from Team B). Tried in priority order.
      validCombos: [[5, 3], [4, 4]],
    },
    antiCorrelation:       true,
    antiCorrelationPenalty: -15,  // pts deducted from hitters facing the lineup's active SP
    puntThreshold:         3500,
    usageColumn:           'plateAppearances',
    usageMinimum:          2,
    sportVarianceMultiplier:  1.35,  // MLB batters have the highest variance
    pitcherVarianceMultiplier: 1.10,
  },

  // ── MLB Showdown (MVP + 5 UTIL) ──────────────────────────────────────────
  mlb_showdown: {
    label:             'MLB Showdown',
    sport:             'mlb',
    isShowdown:        true,
    cap:               GLOBAL_CAP,
    minSalary:         1000,
    maxPlayersPerTeam: 5,
    slots:             ['MVP', 'UTIL', 'UTIL', 'UTIL', 'UTIL', 'UTIL'],
    rosterBreakdown:   { mvp: 1, util: 5 },
    stackingEnabled:   false,
    antiCorrelation:   false,
    puntThreshold:     1500,
    usageColumn:       'plateAppearances',
    usageMinimum:      1,
    sportVarianceMultiplier: 1.35,
  },

  // ── NFL Classic (9-man, QB stack) ───────────────────────────────────────
  // FLEX slot accepts RB / WR / TE.
  nfl_classic: {
    label:             'NFL Classic',
    sport:             'nfl',
    isShowdown:        false,
    cap:               GLOBAL_CAP,
    minSalary:         4500,
    maxPlayersPerTeam: 4,
    slots:             ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'DST'],
    rosterBreakdown:   { qb: 1, rb: 2, wr: 3, te: 1, flex: 1, dst: 1 },
    stackingEnabled:   true,
    stackingRules: {
      minQbWrTeStack: 1,   // at least 1 WR or TE from the QB's team
    },
    antiCorrelation:       true,
    antiCorrelationPenalty: -10,  // QB + opposing-team DST score penalty
    puntThreshold:         3500,
    usageColumn:           'targets',
    usageMinimum:          3,
    sportVarianceMultiplier:  1.20,
    rbVarianceMultiplier:     1.25,
    wrVarianceMultiplier:     1.30,
  },

  // ── NFL Showdown (MVP + 5 UTIL) ──────────────────────────────────────────
  nfl_showdown: {
    label:             'NFL Showdown',
    sport:             'nfl',
    isShowdown:        true,
    cap:               GLOBAL_CAP,
    minSalary:         1000,
    maxPlayersPerTeam: 5,
    slots:             ['MVP', 'UTIL', 'UTIL', 'UTIL', 'UTIL', 'UTIL'],
    rosterBreakdown:   { mvp: 1, util: 5 },
    stackingEnabled:   false,
    antiCorrelation:   false,
    puntThreshold:     1500,
    usageColumn:       'targets',
    usageMinimum:      1,
    sportVarianceMultiplier: 1.20,
  },

  // ── PGA Classic (6-player all-flex) ─────────────────────────────────────
  // No team-based constraints — maxPlayersPerTeam is deliberately omitted.
  pga_classic: {
    label:            'PGA Classic',
    sport:            'golf',
    isShowdown:       false,
    cap:              GLOBAL_CAP,
    minSalary:        6500,
    // maxPlayersPerTeam intentionally absent — individual golfers, no teams
    slots:            ['GLFR', 'GLFR', 'GLFR', 'GLFR', 'GLFR', 'GLFR'],
    rosterBreakdown:  { glfr: 6 },
    stackingEnabled:  false,
    antiCorrelation:  false,
    puntThreshold:    6500,
    usageColumn:      null,  // no usage metric for golf
    usageMinimum:     0,
    sportVarianceMultiplier: 1.20,
  },
};

/**
 * Resolve the correct FanDuel configuration for a sport + slate type.
 * @param {string}  sport       - 'nba' | 'mlb' | 'nfl' | 'golf' | 'pga'
 * @param {boolean} isShowdown  - true for single-game / captain slates
 * @returns {Object|null}
 */
function getConfig(sport, isShowdown = false) {
  const s = String(sport || '').toLowerCase().trim();
  if (s === 'golf' || s === 'pga') return SPORT_CONFIGS.pga_classic;
  const key = `${s}_${isShowdown ? 'showdown' : 'classic'}`;
  return SPORT_CONFIGS[key] || null;
}

/**
 * Detect showdown format from a resolved slot array.
 * A 6-slot array that is entirely MVP / CPT / UTIL / FLEX = showdown.
 * @param {string[]} slots
 * @returns {boolean}
 */
function isShowdownSlots(slots) {
  if (!Array.isArray(slots) || slots.length !== 6) return false;
  const SD = new Set(['MVP', 'CPT', 'UTIL', 'FLEX']);
  return slots.every(s => SD.has(String(s).toUpperCase()));
}

module.exports = { SPORT_CONFIGS, GLOBAL_CAP, getConfig, isShowdownSlots };
