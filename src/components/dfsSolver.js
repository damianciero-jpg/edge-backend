'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// dfsSolver.js — FanDuel-exclusive modular optimization engine
//
// Models roster selection as a Binary Integer Linear Program (BILP):
//
//   maximise   Σ  adjustedPoints_i × x_i
//   subject to:
//     Σ salary_i × x_i  ≤  cap                     (salary constraint)
//     Σ x_i == 1  ∀ slot s                          (one player per slot)
//     x_i ∈ {0, 1}                                  (binary selection)
//     teamCount(t) ≤ maxPlayersPerTeam  ∀ team t    (team diversity)
//     + sport-specific stacking & correlation rules
//
// Solved via beam search with suffix-minimum LP relaxation for O(1) per-step
// feasibility pruning. Beam width = 48 for higher solution quality than the
// legacy 32-width solver.
// ─────────────────────────────────────────────────────────────────────────────

const BEAM_WIDTH   = 48;
const MVP_SAL_MULT = 1.5;  // FanDuel MVP slot salary multiplier
const MVP_PTS_MULT = 1.5;  // FanDuel MVP slot projection multiplier

// ─── Position Utilities ───────────────────────────────────────────────────────

/**
 * Returns true if the position string represents a pitcher (P / SP / RP).
 */
function isMlbPitcher(pos) {
  return String(pos || '')
    .toUpperCase()
    .split(/[\/,\s]+/)
    .some(p => /^(P|SP|RP)$/.test(p));
}

/**
 * FanDuel-exclusive position ↔ roster slot eligibility.
 *
 * Key differences from a generic matcher:
 *  • MVP / CPT / UTIL: showdown flex — any player eligible (pitchers excluded in MLB)
 *  • GLFR: PGA all-flex — every golfer fills any slot
 *  • C1B: unified FD MLB catcher-firstbase slot — accepts C, 1B, or C1B positions
 *  • FLEX (NFL): RB / WR / TE / FLEX dual-tagged players eligible
 */
function positionMatchesFD(playerPos, slot, sport) {
  const s = String(slot || '').toUpperCase();

  // ── Showdown flex slots: all players eligible except MLB pitchers
  if (s === 'MVP' || s === 'CPT' || s === 'UTIL') {
    return sport === 'mlb' ? !isMlbPitcher(playerPos) : true;
  }

  // ── PGA all-flex
  if (s === 'GLFR') return true;

  const parts = String(playerPos || '')
    .toUpperCase()
    .split(/[\/,\s]+/)
    .filter(Boolean);
  if (!parts.length) return false;

  switch (sport) {
    case 'mlb':
      if (s === 'P')          return parts.some(p => /^(P|SP|RP)$/.test(p));
      // Unified C/1B slot — accepts C, 1B, C1B, or legacy C/1B tokens
      if (s === 'C1B' || s === 'C/1B')
                              return parts.some(p => ['C', '1B', 'C1B'].includes(p));
      if (s === '2B')         return parts.includes('2B');
      if (s === '3B')         return parts.includes('3B');
      if (s === 'SS')         return parts.includes('SS');
      if (s === 'OF')         return parts.some(p => ['OF', 'LF', 'CF', 'RF'].includes(p));
      if (s === 'UTIL')       return !isMlbPitcher(playerPos);
      break;

    case 'nfl':
      if (s === 'QB')         return parts.includes('QB');
      if (s === 'RB')         return parts.includes('RB');
      if (s === 'WR')         return parts.includes('WR');
      if (s === 'TE')         return parts.includes('TE');
      // FLEX accepts RB / WR / TE; players with explicit FLEX tag also eligible
      if (s === 'FLEX')       return parts.some(p => ['RB', 'WR', 'TE', 'FLEX'].includes(p));
      if (s === 'DST' || s === 'D/ST')
                              return parts.some(p => ['DST', 'DEF', 'D'].includes(p));
      if (s === 'K')          return parts.includes('K');
      if (s === 'UTIL')       return true;
      break;

    case 'nba':
      if (s === 'PG')  return parts.includes('PG');
      if (s === 'SG')  return parts.includes('SG');
      if (s === 'SF')  return parts.includes('SF');
      if (s === 'PF')  return parts.includes('PF');
      if (s === 'C')   return parts.includes('C');
      if (s === 'G')   return parts.some(p => p === 'PG' || p === 'SG');
      if (s === 'F')   return parts.some(p => p === 'SF' || p === 'PF');
      if (s === 'UTIL') return true;
      break;

    case 'golf':
      return true;
  }
  return false;
}

// ─── C. Anti-Kornet Punt / Dud Filter ────────────────────────────────────────
//
// Removes players who are simultaneously:
//   (a) below the salary punt threshold, AND
//   (b) below the sport-specific usage floor
// Locked players are always preserved regardless of salary.
//

/**
 * @param {Object[]} players
 * @param {Object}   config   - sport config from sportConfigs.js
 * @param {Object}   opts     - { lockedNames: Set }
 * @returns {Object[]}
 */
function applyPuntFilter(players, config, opts = {}) {
  const threshold = config.puntThreshold  || (config.isShowdown ? 1500 : 3500);
  const floor     = config.minSalary      || 1000;
  const usageCol  = config.usageColumn;
  const usageMin  = config.usageMinimum   || 0;
  const locked    = opts.lockedNames      || new Set();

  return players.filter(p => {
    if (locked.has(p.name)) return true;
    if (!p.salary || p.salary < floor) return false;

    // In the punt zone: only keep if the usage column clears the minimum
    if (p.salary < threshold && usageCol && usageMin > 0) {
      const usage = p[usageCol];
      if (usage != null && Number(usage) < usageMin) return false;
    }
    return true;
  });
}

// ─── D. Stokastic-Style Tournament Upside & Leverage Engine ──────────────────
//
// When useTournamentUpside is enabled:
//   1. UpsidePoints = median + (stdDev × 1.2)           if CSV has stdDev column
//                   = median × sportMultiplier           otherwise
//   2. AdjustedPoints = UpsidePoints − (ownership × 0.1)
//      (forces the LP solver away from chalk into high-leverage combinations)
//

function _varianceMultiplier(player, config) {
  const pos = String(player.position || '').toUpperCase();
  switch (config.sport) {
    case 'mlb':
      return isMlbPitcher(pos)
        ? (config.pitcherVarianceMultiplier || 1.10)
        : (config.sportVarianceMultiplier   || 1.35);
    case 'nfl':
      if (pos.includes('RB')) return config.rbVarianceMultiplier || 1.25;
      if (pos.includes('WR')) return config.wrVarianceMultiplier || 1.30;
      return config.sportVarianceMultiplier || 1.20;
    default:
      return config.sportVarianceMultiplier || 1.15;
  }
}

/**
 * Clones and adjusts each player's fppg using tournament upside logic.
 * When useTournamentUpside is false, returns a shallow clone with no changes.
 */
function applyTournamentUpside(players, config, opts = {}) {
  return players.map(p => {
    // Prefer live prop projection over CSV fppg as scoring baseline.
    // When no prop was found, projection === fppg, so behaviour is identical.
    // Use || not ?? so that a zero projection still falls back to the CSV fppg.
    const median    = Number(p.projection || p.fppg) || 0;
    const stdDev    = p.stdDev  != null      ? Number(p.stdDev)       : null;
    const ownership = p.ownershipPct != null ? Number(p.ownershipPct) : 0;

    if (!opts.useTournamentUpside) {
      // Even without upside engine, scoring fppg = projection (prop-driven when available).
      return { ...p, fppg: median, _baseFppg: Number(p.fppg) || 0 };
    }

    // Step 1: upside calculation
    const upside = (stdDev != null && stdDev > 0)
      ? median + stdDev * 1.2
      : median * _varianceMultiplier(p, config);

    // Step 2: ownership leverage tax
    const adjusted = upside - ownership * 0.1;

    return { ...p, fppg: Math.max(0, adjusted), _baseFppg: median };
  });
}

// ─── B. Anti-Correlation Tagging ─────────────────────────────────────────────
//
// Tags hitters whose team is the opponent of an active starting pitcher.
// The penalty is applied as a score adjustment during beam-search candidate
// ranking, not as a hard exclusion (preserving fallback options).
//

/**
 * @param {Object[]} players       - player pool to tag
 * @param {Object[]} activePitchers - pitchers whose opponents receive the penalty
 * @param {Object}   config
 * @returns {Object[]} cloned players with _antiCorrPenalty set where applicable
 */
function tagAntiCorrelation(players, activePitchers, config) {
  if (!config.antiCorrelation || !activePitchers.length) {
    return players.map(p => ({ ...p }));
  }
  const penalty  = config.antiCorrelationPenalty || -15;
  const oppTeams = new Set(activePitchers.map(p => p.opponent).filter(Boolean));

  return players.map(p => {
    if (!isMlbPitcher(p.position) && oppTeams.has(p.team)) {
      return { ...p, _antiCorrPenalty: penalty };
    }
    return { ...p };
  });
}

// ─── A. Showdown MVP Dual-Pricing Matrix ─────────────────────────────────────
//
// Every player becomes two binary variables:
//   name__util  →  salary × 1.0,  projection × 1.0  (UTIL slots only)
//   name__mvp   →  salary × 1.5,  projection × 1.5  (MVP slot only)
//
// Mutual exclusion: once either variant is picked, the beam-search state
// records the real player name in usedRealNames, blocking the other variant.
//

function expandShowdownVariants(players) {
  const out = [];
  for (const p of players) {
    out.push({
      ...p,
      _variant:  'util',
      _realName: p.name,
      name:      `${p.name}__util`,
    });
    out.push({
      ...p,
      _variant:   'mvp',
      _realName:  p.name,
      name:       `${p.name}__mvp`,
      salary:     Math.round(p.salary * MVP_SAL_MULT),
      fppg:       (p.fppg || 0) * MVP_PTS_MULT,
      _baseFppg:  ((p._baseFppg ?? p.fppg) || 0) * MVP_PTS_MULT,
    });
  }
  return out;
}

// ─── Core Beam Search ─────────────────────────────────────────────────────────

function beamSearch(players, slots, cap, opts = {}) {
  const {
    sport              = 'nba',
    isShowdown         = false,
    maxTeamCount       = 99,
    maxHittersPerTeam  = 5,
    maxPlayersPerTeam  = 99,
    lockedNames        = new Set(),
    excludedNames      = new Set(),
    puntThreshold      = 0,
    maxPunts           = 99,
    nflQbTeam          = null,
    nflMinWrStack      = 0,
    previousLineups    = [],
    minUniquePlayers   = 0,
    minSalaryFloor     = 0,
  } = opts;

  const NFL_FLEX = new Set(['WR', 'TE', 'FLEX']);

  const pool = players.filter(p => !excludedNames.has(p._realName || p.name));

  // ── Per-slot candidate lists sorted by effective score descending
  const slotCandidates = slots.map(slot =>
    pool
      .filter(p => {
        if (isShowdown) {
          if (slot === 'MVP')  return p._variant === 'mvp';
          if (slot === 'UTIL') return p._variant === 'util';
          return false;
        }
        return positionMatchesFD(p.position, slot, sport);
      })
      .sort((a, b) => {
        const aScore = (a.fppg || 0) + (a._antiCorrPenalty || 0)
          + (a.stdDev || 0) * 0.25
          + (a.salary || 0) / 1000000
          + (nflQbTeam && NFL_FLEX.has(a.position) && a.team === nflQbTeam ? 4.0 : 0);
        const bScore = (b.fppg || 0) + (b._antiCorrPenalty || 0)
          + (b.stdDev || 0) * 0.25
          + (b.salary || 0) / 1000000
          + (nflQbTeam && NFL_FLEX.has(b.position) && b.team === nflQbTeam ? 4.0 : 0);
        return bScore - aScore;
      })
  );

  // ── Suffix-minimum salary array for LP feasibility pruning
  const slotMinSal = slotCandidates.map(cands => {
    const sals = cands.map(p => p.salary).filter(s => s > 0);
    return sals.length ? Math.min(...sals) : Infinity;
  });
  const suffixMin = new Array(slots.length + 1).fill(0);
  for (let i = slots.length - 1; i >= 0; i--) {
    suffixMin[i] = suffixMin[i + 1] + slotMinSal[i];
  }
  if (suffixMin[0] > cap) return null;  // globally infeasible before any pick

  // ── Previous-lineup uniqueness index
  const nPrev    = previousLineups.length;
  const maxOvlap = nPrev > 0 && minUniquePlayers > 0
    ? slots.length - minUniquePlayers : Infinity;
  const prevIdx  = new Map();
  if (nPrev > 0 && minUniquePlayers > 0) {
    previousLineups.forEach((lset, idx) => {
      for (const nm of lset) {
        let arr = prevIdx.get(nm);
        if (!arr) { arr = []; prevIdx.set(nm, arr); }
        arr.push(idx);
      }
    });
  }

  // ── Initial beam state
  let beam = [{
    picked:        [],
    salarySoFar:   0,
    fppgSoFar:     0,
    cheapCount:    0,
    teamCounts:    {},  // all players (NBA / NFL / showdown)
    hitterTeams:   {},  // MLB: hitters only
    qbTeam:        null,
    qbStack:       0,
    usedRealNames: new Set(),
    overlapCounts: nPrev > 0 ? new Array(nPrev).fill(0) : null,
  }];

  for (let si = 0; si < slots.length; si++) {
    const slot      = slots[si];
    const nextBeam  = [];
    // Remaining NFL skill slots for look-ahead stack enforcement
    const remSkill  = sport === 'nfl'
      ? slots.slice(si).filter(s => NFL_FLEX.has(s)).length : 0;

    for (const st of beam) {
      if (cap - st.salarySoFar < suffixMin[si]) continue;  // LP prune

      const usedNames = new Set(st.picked.map(p => p.name));
      const budget    = cap - st.salarySoFar;

      const elig = slotCandidates[si].filter(p => {
        if (usedNames.has(p.name)) return false;

        // Showdown: mutual exclusion — block the other variant of the same player
        if (isShowdown && p._realName && st.usedRealNames.has(p._realName)) return false;

        // LP salary feasibility prune
        if (p.salary + suffixMin[si + 1] > budget) return false;

        // Punt cap
        if (puntThreshold > 0 && p.salary > 0 && p.salary < puntThreshold
            && !lockedNames.has(p._realName || p.name)) {
          if (st.cheapCount >= maxPunts) return false;
        }

        // Team diversity constraints
        const team = p.team;
        if (sport === 'mlb') {
          if (!isMlbPitcher(p.position) && (st.hitterTeams[team] || 0) >= maxHittersPerTeam)
            return false;
        } else if (isShowdown) {
          if ((st.teamCounts[team] || 0) >= maxPlayersPerTeam) return false;
        } else {
          if ((st.teamCounts[team] || 0) >= maxTeamCount) return false;
        }

        // NFL: block DST that opposes any of our offensive players
        if (sport === 'nfl' && !isShowdown && (slot === 'DST' || slot === 'D/ST')) {
          const ourTeams = new Set(st.picked.map(q => q.team).filter(Boolean));
          if (p.opponent && ourTeams.has(p.opponent)) return false;
        }

        // NFL: look-ahead stack enforcement — when remaining skill slots == still-needed
        // WR/TE from QB's team, force those picks
        if (sport === 'nfl' && !isShowdown && nflMinWrStack > 0
            && st.qbTeam && NFL_FLEX.has(slot)) {
          const needed = nflMinWrStack - st.qbStack;
          if (needed > 0 && remSkill <= needed) {
            if (!(p.team === st.qbTeam && (p.position === 'WR' || p.position === 'TE')))
              return false;
          }
        }

        return true;
      });

      // Locked players take priority over the open pool
      const locked = elig.filter(p => lockedNames.has(p._realName || p.name));
      const cands  = (locked.length ? locked : elig).slice(0, BEAM_WIDTH * 2);

      for (const player of cands) {
        const nextSal   = st.salarySoFar + player.salary;
        const effScore  = (player.fppg || 0) + (player._antiCorrPenalty || 0)
          + (player.stdDev || 0) * 0.25
          + (player.salary || 0) / 1000000;
        const nextFppg  = st.fppgSoFar + effScore;

        const isPunt    = puntThreshold > 0 && player.salary > 0 && player.salary < puntThreshold;
        const nextPunt  = st.cheapCount + (isPunt ? 1 : 0);

        const nextTeam  = { ...st.teamCounts };
        const nextHit   = { ...st.hitterTeams };
        nextTeam[player.team] = (nextTeam[player.team] || 0) + 1;
        if (sport === 'mlb' && !isMlbPitcher(player.position)) {
          nextHit[player.team] = (nextHit[player.team] || 0) + 1;
        }

        const nextQbTeam = st.qbTeam || (player.position === 'QB' ? player.team : null);
        const nextQbStk  = st.qbStack + (
          st.qbTeam
          && (player.position === 'WR' || player.position === 'TE')
          && player.team === st.qbTeam ? 1 : 0
        );

        const nextUsed  = isShowdown && player._realName
          ? new Set([...st.usedRealNames, player._realName])
          : st.usedRealNames;

        // Uniqueness check vs every previous lineup
        let nextOvlap = st.overlapCounts;
        if (nPrev > 0 && minUniquePlayers > 0 && !lockedNames.has(player._realName || player.name)) {
          const rn   = player._realName || player.name;
          const pis  = prevIdx.get(rn);
          if (pis && pis.length) {
            let skip = false;
            nextOvlap = st.overlapCounts.slice();
            for (const idx of pis) {
              nextOvlap[idx]++;
              if (nextOvlap[idx] > maxOvlap) { skip = true; break; }
            }
            if (skip) continue;
          }
        }

        nextBeam.push({
          picked:        [...st.picked, player],
          salarySoFar:   nextSal,
          fppgSoFar:     nextFppg,
          cheapCount:    nextPunt,
          teamCounts:    nextTeam,
          hitterTeams:   nextHit,
          qbTeam:        nextQbTeam,
          qbStack:       nextQbStk,
          usedRealNames: nextUsed,
          overlapCounts: nextOvlap,
        });
      }
    }

    if (!nextBeam.length) return null;
    nextBeam.sort((a, b) => b.fppgSoFar - a.fppgSoFar);
    beam = nextBeam.slice(0, BEAM_WIDTH);
  }

  const valid = beam.filter(s =>
    s.picked.length === slots.length &&
    s.salarySoFar <= cap &&
    s.salarySoFar >= minSalaryFloor
  );
  if (!valid.length) return null;
  valid.sort((a, b) => b.fppgSoFar - a.fppgSoFar);
  return valid[0];
}

// ─── MLB Stacking Solver ──────────────────────────────────────────────────────
//
// Enforces SaberSim-style 4-4 / 5-3 hitter team distribution:
//
//   Outer loop: iterate eligible starting pitchers (top 8 by fppg)
//   Per pitcher:
//     • Apply anti-correlation penalty to opposing hitters (AdCoR rule)
//     • Try each (primaryTeam, stackCombo) pairing:
//         – Boost primary-team hitters by +50 fppg to guide the beam
//         – Run beam search for hitter slots
//         – Validate the resulting team distribution
//     • Track the best valid (stacked, within-budget) result
//   Fallback: if no stacked lineup found, run without stacking enforcement
//

function solveMlbStacked(players, config, opts = {}) {
  const { slots, cap }  = config;
  const validCombos     = config.stackingRules?.validCombos || [[5, 3], [4, 4]];
  const hitterSlots     = slots.filter(s => s !== 'P');
  const excluded        = opts.excludedNames || new Set();
  const locked          = opts.lockedNames   || new Set();

  const allPitchers = players.filter(p =>  isMlbPitcher(p.position) && !excluded.has(p.name));
  const allHitters  = players.filter(p => !isMlbPitcher(p.position) && !excluded.has(p.name));

  if (!allPitchers.length || !allHitters.length) return null;

  // Filter to probable starters; fall back to entire pool if none flagged
  let eligPitchers = opts.requireProbablePitcher !== false
    ? allPitchers.filter(p => p.probablePitcher)
    : allPitchers;
  if (!eligPitchers.length) eligPitchers = allPitchers;
  eligPitchers.sort((a, b) => (b.fppg || 0) - (a.fppg || 0));

  // Rank teams by average hitter fppg for stack candidate selection
  const teamAcc = {};
  for (const h of allHitters) {
    if (!teamAcc[h.team]) teamAcc[h.team] = { sum: 0, count: 0 };
    teamAcc[h.team].sum   += (h.fppg || 0);
    teamAcc[h.team].count += 1;
  }
  const stackTeams = Object.keys(teamAcc)
    .sort((a, b) =>
      (teamAcc[b].sum / teamAcc[b].count) - (teamAcc[a].sum / teamAcc[a].count)
    )
    .slice(0, 6);

  const beamOpts = {
    sport:            'mlb',
    isShowdown:       false,
    maxHittersPerTeam: 5,
    puntThreshold:    config.puntThreshold || 3500,
    maxPunts:         opts.allowValuePunts !== false ? (opts.maxPunts ?? 1) : 0,
    lockedNames:      locked,
    previousLineups:  opts.previousLineups || [],
    minUniquePlayers: opts.minUniquePlayers || 0,
    minSalaryFloor:   opts.minSalaryFloor  || 0,
  };

  let best = null;

  for (const pitcher of eligPitchers.slice(0, 8)) {
    const hCap = cap - pitcher.salary;
    if (hCap <= 0) continue;

    // Anti-correlation: hitters from pitcher's opponent team take the penalty
    const penalisedHitters = tagAntiCorrelation(allHitters, [pitcher], config);

    for (const [minA] of validCombos) {
      for (const primaryTeam of stackTeams) {
        // Boost primary team to guide beam search toward the stacking target
        const boosted = penalisedHitters.map(p =>
          p.team === primaryTeam ? { ...p, fppg: (p.fppg || 0) + 50 } : p
        );

        const result = beamSearch(boosted, hitterSlots, hCap, {
          ...beamOpts,
          excludedNames: excluded,
        });
        if (!result) continue;

        // Validate stack distribution using the required combos
        const dist = {};
        for (const h of result.picked) dist[h.team] = (dist[h.team] || 0) + 1;
        const counts  = Object.values(dist).sort((a, b) => b - a);
        const isValid = validCombos.some(
          ([a, b]) => (counts[0] || 0) >= a && (counts[1] || 0) >= b
        );
        if (!isValid) continue;

        // Score with the real (un-boosted, anti-corr-penalised) fppg
        const hitterFppgMap = new Map(penalisedHitters.map(h => [h.name, h]));
        const realHitFppg   = result.picked.reduce((s, h) => {
          const orig = hitterFppgMap.get(h.name);
          return s + (orig ? (orig.fppg || 0) + (orig._antiCorrPenalty || 0) : 0);
        }, 0);
        const totalFppg = (pitcher.fppg || 0) + realHitFppg;
        const totalSal  = pitcher.salary + result.salarySoFar;

        if (!best || totalFppg > best.totalFppg) {
          best = {
            pitchers:    [pitcher],
            hitters:     result.picked,
            totalSalary: totalSal,
            totalFppg,
          };
        }
      }
    }
  }

  // Fallback: no valid stacked lineup — run unconstrained
  if (!best) {
    const fallbackHitters = tagAntiCorrelation(allHitters, eligPitchers.slice(0, 1), config);
    for (const pitcher of eligPitchers.slice(0, 5)) {
      const hCap = cap - pitcher.salary;
      if (hCap <= 0) continue;
      const r = beamSearch(fallbackHitters, hitterSlots, hCap, {
        ...beamOpts,
        excludedNames: excluded,
      });
      if (r) {
        best = {
          pitchers:    [pitcher],
          hitters:     r.picked,
          totalSalary: pitcher.salary + r.salarySoFar,
          totalFppg:   (pitcher.fppg || 0) + r.fppgSoFar,
        };
        break;
      }
    }
  }

  if (!best) return null;

  // Assemble slot-ordered lineup
  const lineup = [];
  let pi = 0, hi = 0;
  for (const slot of slots) {
    if (slot === 'P') lineup.push({ ...best.pitchers[pi++], slot });
    else              lineup.push({ ...best.hitters[hi++],  slot });
  }

  // Stack summary
  const dist = {};
  lineup
    .filter(p => !isMlbPitcher(p.position))
    .forEach(p => { dist[p.team] = (dist[p.team] || 0) + 1; });
  const ts = Object.entries(dist).sort((a, b) => b[1] - a[1]);
  const stackInfo = ts.length >= 2
    ? `${ts[0][0]} ×${ts[0][1]}  +  ${ts[1][0]} ×${ts[1][1]}`
    : (ts[0] ? `${ts[0][0]} ×${ts[0][1]}` : null);

  return {
    lineup,
    totalSalary: best.totalSalary,
    totalFppg:   best.totalFppg,
    stackInfo,
    salaryCap:   cap,
  };
}

// ─── NFL Classic Solver ───────────────────────────────────────────────────────

function solveNflClassic(players, config, opts = {}) {
  const { slots, cap } = config;
  const minStack = config.stackingEnabled && opts.enableStacking !== false
    ? (config.stackingRules?.minQbWrTeStack ?? 1)
    : 0;

  const bOpts = {
    ...opts,
    sport:         'nfl',
    isShowdown:    false,
    maxTeamCount:  config.maxPlayersPerTeam || 4,
    puntThreshold: config.puntThreshold     || 3500,
    maxPunts:      opts.allowValuePunts !== false ? (opts.maxPunts ?? 1) : 0,
    nflMinWrStack: minStack,
  };

  let result = beamSearch(players, slots, cap, bOpts);

  // If the first pass returned a lineup but the QB stack wasn't satisfied,
  // retry with an explicit QB team boost
  if (result && minStack > 0) {
    const qb = result.picked.find(p => p.position === 'QB');
    if (qb) {
      const actualStack = result.picked.filter(
        p => p.team === qb.team && (p.position === 'WR' || p.position === 'TE')
      ).length;
      if (actualStack < minStack) {
        const retry = beamSearch(players, slots, cap, {
          ...bOpts,
          nflQbTeam:    qb.team,
          nflMinWrStack: minStack,
        });
        if (retry) result = retry;
      }
    }
  }

  // Escalating fallbacks: relax ownership → relax team cap → relax stack
  if (!result) result = beamSearch(players, slots, cap, { ...bOpts, maxPunts: 99 });
  if (!result) result = beamSearch(players, slots, cap, { ...bOpts, maxPunts: 99, maxTeamCount: 99 });
  if (!result) result = beamSearch(players, slots, cap, { ...bOpts, maxPunts: 99, maxTeamCount: 99, nflMinWrStack: 0 });

  if (!result) return null;

  const lineup = result.picked.map((p, i) => ({ ...p, slot: slots[i] }));

  const qb       = lineup.find(p => p.position === 'QB');
  const partners = qb
    ? lineup.filter(p => p.team === qb.team && (p.position === 'WR' || p.position === 'TE'))
    : [];
  const stackInfo = partners.length
    ? `QB stack: ${qb.team} — ${qb.name} + ${partners.map(p => p.name).join(', ')}`
    : null;

  return { lineup, totalSalary: result.salarySoFar, totalFppg: result.fppgSoFar, stackInfo, salaryCap: cap };
}

// ─── Showdown Solver (Exhaustive MVP Permutation) ────────────────────────────
//
// For every player in the pool:
//   1. Tentatively assign them as MVP  → salary × 1.5, fppg × 1.5
//   2. Solve the remaining UTIL slots via beam search under the leftover cap
//   3. Score the combo with TRUE fppg sums (no beam-score bonuses)
//   4. Pick the permutation with the highest total
//
// This guarantees we never miss a high-ceiling MVP because of beam pruning.
// Top-5 candidates are logged for transparency.

function solveShowdown(players, config, opts = {}) {
  const { slots, cap, sport } = config;

  const mvpSlot   = slots[0];        // 'MVP'
  const utilSlots = slots.slice(1);  // ['UTIL', 'UTIL', ...]
  const nUtil     = utilSlots.length;

  const excluded       = opts.excludedNames  || new Set();
  const locked         = opts.lockedNames    || new Set();
  const minSalaryFloor = opts.minSalaryFloor || 0;

  const pool = players.filter(p => !excluded.has(p.name));
  if (!pool.length) return null;

  // Shared beam-search options for the UTIL sub-problem
  const utilBeamOpts = {
    sport,
    isShowdown:       false,
    maxTeamCount:     config.maxPlayersPerTeam || 5,
    puntThreshold:    config.puntThreshold     || 1500,
    maxPunts:         99,
    lockedNames:      locked,
    previousLineups:  opts.previousLineups  || [],
    minUniquePlayers: opts.minUniquePlayers || 0,
  };

  const permResults = [];

  for (const mvp of pool) {
    const mvpSalary    = Math.round(mvp.salary * MVP_SAL_MULT);
    const mvpFppg      = (mvp.fppg || 0) * MVP_PTS_MULT;
    const remainingCap = cap - mvpSalary;

    if (remainingCap <= 0) continue;

    // Players available for UTIL (exclude the MVP candidate)
    const utilPool = pool.filter(p => p.name !== mvp.name);
    if (utilPool.length < nUtil) continue;

    // Salary floor propagated to the UTIL sub-problem
    const remainingFloor = Math.max(0, minSalaryFloor - mvpSalary);

    const utilResult = beamSearch(utilPool, utilSlots, remainingCap, {
      ...utilBeamOpts,
      minSalaryFloor: remainingFloor,
    });

    if (!utilResult || utilResult.picked.length < nUtil) continue;

    // Use raw fppg sums for honest ranking (not the beam's composite score)
    const trueUtilFppg = utilResult.picked.reduce((s, p) => s + (p.fppg || 0), 0);
    const totalFppg    = mvpFppg + trueUtilFppg;
    const totalSalary  = mvpSalary + utilResult.salarySoFar;

    permResults.push({
      mvp,
      utilPicked:  utilResult.picked,
      mvpFppg:     +mvpFppg.toFixed(2),
      utilFppg:    +trueUtilFppg.toFixed(2),
      totalFppg:   +totalFppg.toFixed(2),
      totalSalary,
    });
  }

  if (!permResults.length) return null;

  permResults.sort((a, b) => b.totalFppg - a.totalFppg);

  // Log top-5 permutations so results are auditable in server logs
  const top5 = permResults.slice(0, 5);
  const logHeader = `[DFS Showdown] MVP permutations tested: ${permResults.length}`;
  const logLines  = top5.map((r, i) =>
    `  ${i + 1}. ${r.mvp.name} MVP: ${r.totalFppg.toFixed(1)}` +
    ` (MVP pts: ${r.mvpFppg.toFixed(1)}, UTIL: ${r.utilFppg.toFixed(1)},` +
    ` salary: $${r.totalSalary.toLocaleString()})`
  );
  console.log([logHeader, ...logLines].join('\n'));

  const best = permResults[0];

  const lineup = [
    {
      ...best.mvp,
      slot:          mvpSlot,
      isMvp:         true,
      salary:        Math.round(best.mvp.salary * MVP_SAL_MULT),
      displaySalary: best.mvp.salary,
      fppg:          best.mvpFppg,
      displayFppg:   +(best.mvp.fppg || 0).toFixed(2),
    },
    ...best.utilPicked.map((p, i) => ({
      ...p,
      slot:          utilSlots[i] || 'UTIL',
      isMvp:         false,
      displaySalary: p.salary,
      displayFppg:   +(p.fppg || 0).toFixed(2),
    })),
  ];

  return {
    lineup,
    totalSalary:     best.totalSalary,
    totalFppg:       best.totalFppg,
    stackInfo:       null,
    salaryCap:       cap,
    // Surface top-5 to the frontend response
    mvpPermutations: top5.map(r => ({
      name:       r.mvp.name,
      totalScore: r.totalFppg,
      mvpScore:   r.mvpFppg,
      utilScore:  r.utilFppg,
    })),
  };
}

// ─── NBA / PGA Classic Solver ─────────────────────────────────────────────────

function solveClassic(players, config, opts = {}) {
  const { slots, cap, sport } = config;

  const bOpts = {
    ...opts,
    sport,
    isShowdown:   false,
    maxTeamCount: config.maxPlayersPerTeam || 4,
    puntThreshold: config.puntThreshold || 3500,
    maxPunts:     opts.allowValuePunts !== false ? (opts.maxPunts ?? 1) : 0,
  };

  let result = beamSearch(players, slots, cap, bOpts);

  // NBA: relax team cap and punt constraints as fallbacks
  if (!result && sport === 'nba') {
    result = beamSearch(players, slots, cap, { ...bOpts, maxTeamCount: 99 });
  }
  if (!result) {
    result = beamSearch(players, slots, cap, { ...bOpts, maxTeamCount: 99, puntThreshold: 0, maxPunts: 99 });
  }

  if (!result) return null;

  const lineup = result.picked.map((p, i) => ({ ...p, slot: slots[i] }));
  return { lineup, totalSalary: result.salarySoFar, totalFppg: result.fppgSoFar, stackInfo: null, salaryCap: cap };
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * Generate a single optimal lineup for a given FanDuel sport configuration.
 *
 * Pipeline:
 *   1. Punt/dud filter      (C — Anti-Kornet)
 *   2. Tournament upside    (D — Stokastic engine, conditional)
 *   3. Sport-specific solve (A showdown / B MLB stacking / NFL / NBA / PGA)
 *
 * @param {Object[]} rawPlayers   Normalised players from the CSV upload
 * @param {Object}   config       Sport config returned by getConfig()
 * @param {Object}   [opts]
 *   @param {boolean}  opts.useTournamentUpside    Enable Stokastic upside engine
 *   @param {Set}      opts.lockedNames            Players forced into the lineup
 *   @param {Set}      opts.excludedNames          Players blocked from the lineup
 *   @param {boolean}  opts.allowValuePunts        false = zero-tolerance punt filter
 *   @param {number}   opts.maxPunts               Max cheap players permitted
 *   @param {boolean}  opts.enableStacking         false = disable stacking rules
 *   @param {boolean}  opts.requireProbablePitcher MLB: only probable SP allowed
 *   @param {Set[]}    opts.previousLineups        Prior lineup sets for uniqueness
 *   @param {number}   opts.minUniquePlayers       Min diff from each prior lineup
 *
 * @returns {{ lineup, totalSalary, totalFppg, stackInfo, salaryCap } | null}
 */
function generateOptimalLineup(rawPlayers, config, opts = {}) {
  if (!config || !rawPlayers || !rawPlayers.length) return null;

  // Step 1 — Remove dud punts
  const filtered = applyPuntFilter(rawPlayers, config, opts);
  if (!filtered.length) return null;

  // Step 2 — Tournament upside scoring (conditional)
  const scored = applyTournamentUpside(filtered, config, opts);

  // Step 3 — 20-attempt retry: start at minCapUsagePct floor, drop 1% per attempt
  const minCapUsagePct = opts.minCapUsagePct != null ? opts.minCapUsagePct : 95;
  const cap = config.cap;

  for (let attempt = 0; attempt <= 20; attempt++) {
    const floorPct       = Math.max(0, minCapUsagePct - attempt);
    const minSalaryFloor = Math.round(cap * floorPct / 100);
    const attemptOpts    = { ...opts, minSalaryFloor };

    let result;
    if (config.isShowdown)         result = solveShowdown(scored, config, attemptOpts);
    else if (config.sport === 'mlb') result = solveMlbStacked(scored, config, attemptOpts);
    else if (config.sport === 'nfl') result = solveNflClassic(scored, config, attemptOpts);
    else                             result = solveClassic(scored, config, attemptOpts);

    if (result) return result;
  }

  return null;
}

module.exports = {
  generateOptimalLineup,
  // Exported for unit-testing and route-level composition
  applyPuntFilter,
  applyTournamentUpside,
  tagAntiCorrelation,
  expandShowdownVariants,
  positionMatchesFD,
  isMlbPitcher,
  beamSearch,
};
