// Support / resistance engine.
// Builds every classic reference level (prior day / overnight / weekly / monthly
// highs, lows, opens and closes; floor + Camarilla pivots; VWAP; volume profile;
// swing zones; round numbers; ATR range), merges levels that sit on top of each
// other into confluence zones, and explains each one.
import {
  atr as calcAtr, ema, niceStep, roundTo, sessionKey, weekKey, last, clamp, fmt, decimalsFor,
} from './util.mjs';
import {
  buildSessions, aggregate, vwap, volumeProfile, swings, clusterSwings, dailySessions,
} from './market.mjs';
import { SETTINGS } from '../config.mjs';

const SETTINGS_RANGE = SETTINGS.levelRangeAtr;
const MIN_EACH = SETTINGS.minLevelsEachSide;

// Levels created during the current session (can't have "flipped" since the open).
const DYNAMIC = new Set(['GO', 'NYO', 'HOD', 'LOD', 'ONH', 'ONL', 'IBH', 'IBL', 'VWAP', 'VWAP+1σ', 'VWAP−1σ', 'VWAP+2σ', 'VWAP−2σ', 'ATR↑', 'ATR↓']);

// Next trading-session key when the market is closed for the weekend.
function upcomingKey(nowKey) {
  const d = new Date(nowKey + 'T12:00:00Z');
  const dow = d.getUTCDay();
  if (dow === 6) d.setUTCDate(d.getUTCDate() + 2);
  else if (dow === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Category ids map to the filter chips in the app.
export const CATS = {
  hl: 'Highs / Lows', oc: 'Opens / Closes', pivot: 'Pivots', vol: 'Volume / VWAP',
  swing: 'Swing zones', round: 'Round numbers', range: 'ATR range',
};

export function analyzeLevels(inst, data, nowMs = Date.now()) {
  const tick = inst.tick;
  const dec = Math.max(decimalsFor(tick), 0);
  const snap = (x) => +roundTo(x, tick).toFixed(dec);

  // With no intraday data (daily-only fallback source), daily bars stand in for sessions.
  const intraday = data.m5.length > 0;
  const s5 = intraday ? buildSessions(data.m5, inst) : dailySessions(data.daily);
  const sH = data.hourly.length ? buildSessions(data.hourly, inst) : dailySessions(data.daily);
  const nowKey = sessionKey(nowMs);
  const lastS = last(s5);
  const live = lastS && lastS.key >= nowKey; // current session in progress (or just closed today)
  const cur = live ? lastS : null;
  const prior = live ? s5[s5.length - 2] : lastS;
  const price = snap(data.meta?.regularMarketPrice ?? (last(data.m5) || last(data.daily)).c);

  // Daily ATR from completed daily bars only.
  const dailyDone = data.daily.filter((b) => sessionKey(b.t) < (cur ? cur.key : nowKey));
  const A = calcAtr(dailyDone.slice(-60), 14) || (prior ? prior.h - prior.l : price * 0.01);

  const raw = [];
  const add = (p, code, label, cat, w) => {
    if (p === null || p === undefined || !Number.isFinite(p)) return;
    raw.push({ price: p, code, label, cat, w });
  };

  // --- current session ---
  if (cur) {
    add(cur.o, 'GO', 'Globex open (6pm ET)', 'oc', 1.5);
    if (cur.dayStarted) {
      add(cur.dayOpen, 'NYO', 'Day-session open', 'oc', 2);
      if (cur.overnight) {
        add(cur.overnight.h, 'ONH', 'Overnight high', 'hl', 2.5);
        add(cur.overnight.l, 'ONL', 'Overnight low', 'hl', 2.5);
      }
      if (cur.ib) {
        add(cur.ib.h, 'IBH', 'Initial balance high (first hour)', 'hl', 2);
        add(cur.ib.l, 'IBL', 'Initial balance low (first hour)', 'hl', 2);
      }
    }
    add(cur.h, 'HOD', 'Session high', 'hl', 2);
    add(cur.l, 'LOD', 'Session low', 'hl', 2);
    const vw = vwap(cur.bars);
    if (vw) {
      add(vw.vwap, 'VWAP', 'Session VWAP', 'vol', 2);
      if (vw.sd > 0) {
        add(vw.vwap + vw.sd, 'VWAP+1σ', 'VWAP +1 std dev', 'vol', 0.8);
        add(vw.vwap - vw.sd, 'VWAP−1σ', 'VWAP −1 std dev', 'vol', 0.8);
        add(vw.vwap + 2 * vw.sd, 'VWAP+2σ', 'VWAP +2 std dev', 'vol', 0.8);
        add(vw.vwap - 2 * vw.sd, 'VWAP−2σ', 'VWAP −2 std dev', 'vol', 0.8);
      }
    }
    // ATR exhaustion: how far a typical day travels from today's extremes.
    add(cur.l + A, 'ATR↑', 'ATR range top (session low + 14-day ATR)', 'range', 1.5);
    add(cur.h - A, 'ATR↓', 'ATR range bottom (session high − 14-day ATR)', 'range', 1.5);
  }

  // --- prior session + pivots ---
  let piv = null;
  if (prior) {
    const H = prior.h, L = prior.l, C = prior.dayClose ?? prior.c;
    add(H, 'PDH', 'Prior day high', 'hl', 3);
    add(L, 'PDL', 'Prior day low', 'hl', 3);
    add(C, 'PDC', prior.dayClose != null ? 'Prior day-session close (≈ settlement)' : 'Prior close', 'oc', 2.5);
    const P = (H + L + C) / 3, R = H - L;
    piv = { P, R1: 2 * P - L, S1: 2 * P - H, R2: P + R, S2: P - R, R3: H + 2 * (P - L), S3: L - 2 * (H - P) };
    add(piv.P, 'P', 'Daily floor pivot', 'pivot', 2.5);
    add(piv.R1, 'R1', 'Daily pivot R1', 'pivot', 2);
    add(piv.S1, 'S1', 'Daily pivot S1', 'pivot', 2);
    add(piv.R2, 'R2', 'Daily pivot R2', 'pivot', 1.5);
    add(piv.S2, 'S2', 'Daily pivot S2', 'pivot', 1.5);
    add(piv.R3, 'R3', 'Daily pivot R3', 'pivot', 1);
    add(piv.S3, 'S3', 'Daily pivot S3', 'pivot', 1);
    const k = R * 1.1;
    add(C + k / 4, 'H3', 'Camarilla H3', 'pivot', 1.2);
    add(C - k / 4, 'L3', 'Camarilla L3', 'pivot', 1.2);
    add(C + k / 2, 'H4', 'Camarilla H4 (breakout)', 'pivot', 1.2);
    add(C - k / 2, 'L4', 'Camarilla L4 (breakdown)', 'pivot', 1.2);
    const vp = volumeProfile(prior.bars, Math.max(tick, roundTo(niceStep(A / 30), tick)));
    if (vp) {
      add(vp.poc, 'PD POC', 'Prior day volume point of control', 'vol', 2);
      add(vp.vah, 'PD VAH', 'Prior day value area high', 'vol', 1.5);
      add(vp.val, 'PD VAL', 'Prior day value area low', 'vol', 1.5);
    }
  }

  // --- multi-day volume profile (≈5 sessions of 5m bars) ---
  const vp5 = volumeProfile(data.m5, Math.max(tick, roundTo(niceStep(A / 20), tick)));
  if (vp5) {
    add(vp5.poc, '5D POC', '5-day volume point of control', 'vol', 2.5);
    add(vp5.vah, '5D VAH', '5-day value area high', 'vol', 1.5);
    add(vp5.val, '5D VAL', '5-day value area low', 'vol', 1.5);
  }

  // --- weekly / monthly (from hourly sessions) ---
  const curKey = cur ? cur.key : upcomingKey(nowKey);
  const weeks = aggregate(sH, 'week');
  const months = aggregate(sH, 'month');
  const curWeekKey = cur ? cur.week : weekKey(curKey);
  const curWeekSessions = sH.filter((s) => s.week === curWeekKey && s.key <= curKey);
  const priorWeek = [...weeks].reverse().find((w) => w.key < curWeekKey);
  if (priorWeek) {
    add(priorWeek.h, 'PWH', 'Prior week high', 'hl', 3);
    add(priorWeek.l, 'PWL', 'Prior week low', 'hl', 3);
    add(priorWeek.c, 'PWC', 'Prior week close', 'oc', 2);
    add((priorWeek.h + priorWeek.l + priorWeek.c) / 3, 'WP', 'Weekly floor pivot', 'pivot', 2);
  }
  if (curWeekSessions.length && cur) add(curWeekSessions[0].o, 'WO', 'Weekly open', 'oc', 2);
  const curMonthKey = curKey.slice(0, 7);
  const priorMonth = [...months].reverse().find((m) => m.key < curMonthKey);
  if (priorMonth && priorMonth.sessions >= 10) {
    add(priorMonth.h, 'PMH', 'Prior month high', 'hl', 3);
    add(priorMonth.l, 'PML', 'Prior month low', 'hl', 3);
    add(priorMonth.c, 'PMC', 'Prior month close', 'oc', 1.5);
  }
  const monthSessions = sH.filter((s) => s.month === curMonthKey);
  if (monthSessions.length) add(monthSessions[0].o, 'MO', 'Monthly open', 'oc', 2);

  // --- 52-week extremes ---
  const yr = data.daily.slice(-252);
  if (yr.length > 100) {
    add(Math.max(...yr.map((b) => b.h)), '52WH', '52-week high', 'hl', 3);
    add(Math.min(...yr.map((b) => b.l)), '52WL', '52-week low', 'hl', 3);
  }

  // --- swing zones ---
  const dSw = swings(data.daily.slice(-252), 3);
  for (const c of clusterSwings([...dSw.highs, ...dSw.lows], 0.3 * A)) {
    const recent = nowMs - c.lastT < 60 * 864e5;
    if (c.touches >= 2 || recent) {
      add(c.price, c.touches >= 2 ? `D-SW×${c.touches}` : 'D-SW',
        c.touches >= 2 ? `Daily swing zone (${c.touches} turning points)` : 'Recent daily swing point',
        'swing', Math.min(3.5, 1 + 0.6 * c.touches));
    }
  }
  const hSw = swings(data.hourly, 8);
  const hZones = clusterSwings([...hSw.highs, ...hSw.lows], 0.15 * A)
    .filter((c) => c.touches >= 3)
    .sort((a, b) => b.touches - a.touches || Math.abs(a.price - price) - Math.abs(b.price - price))
    .slice(0, 10);
  for (const c of hZones) {
    {
      add(c.price, `H-SW×${c.touches}`, `Hourly swing zone (${c.touches} turning points)`, 'swing',
        Math.min(3, 0.6 + 0.5 * c.touches));
    }
  }

  // --- round numbers ---
  const major = niceStep(A * 2), minor = niceStep(A * 0.5);
  const span = SETTINGS_RANGE * A;
  for (let k = Math.ceil((price - span) / major); k * major <= price + span; k++) {
    add(k * major, 'RN', `Major round number (${fmtStep(major)} grid)`, 'round', 1.5);
  }
  const below = Math.floor(price / minor) * minor, above = below + minor;
  add(below, 'rn', `Round number (${fmtStep(minor)} grid)`, 'round', 0.6);
  add(above, 'rn', `Round number (${fmtStep(minor)} grid)`, 'round', 0.6);

  // --- confluence merge ---
  const tol = Math.max(2 * tick, 0.08 * A);
  raw.sort((a, b) => a.price - b.price);
  const zones = [];
  for (const r of raw) {
    const z = last(zones);
    if (z && r.price - z.lo <= tol) { z.members.push(r); z.hi = r.price; }
    else zones.push({ lo: r.price, hi: r.price, members: [r] });
  }

  const recentBars = s5.slice(-3).flatMap((s) => s.bars);
  const levels = zones.map((z) => {
    // dedupe identical codes inside a zone (e.g. two round-number entries)
    const seen = new Set();
    const members = z.members.filter((m) => (seen.has(m.code) ? false : (seen.add(m.code), true)))
      .sort((a, b) => b.w - a.w);
    const anchor = members[0];
    const totalW = members.reduce((s, m) => s + m.w, 0);
    const lp = snap(anchor.price);
    const dist = lp - price;
    const role = Math.abs(dist) <= 0.04 * A ? 'testing' : dist > 0 ? 'resistance' : 'support';
    const strength = totalW < 2 ? 1 : totalW < 3.5 ? 2 : totalW < 5 ? 3 : totalW < 7 ? 4 : 5;
    const tests = touchStats(recentBars, lp, Math.max(tick, tol / 2), A);
    let flipped = null;
    const preExisting = members.some((m) => !DYNAMIC.has(m.code));
    if (cur && cur.o != null && preExisting) {
      if (role === 'support' && cur.o < lp) flipped = 'Was overhead at the Globex open; broken today and now below price (old resistance → support).';
      if (role === 'resistance' && cur.o > lp) flipped = 'Was below price at the Globex open; lost today and now overhead (old support → resistance).';
    }
    return {
      price: lp,
      role,
      strength,
      weight: +totalW.toFixed(2),
      codes: members.map((m) => m.code),
      labels: members.map((m) => m.label),
      cats: [...new Set(members.map((m) => m.cat))],
      confluence: members.length,
      dist: +dist.toFixed(dec + 2),
      distAtr: +(dist / A).toFixed(2),
      dollars: Math.round(Math.abs(dist) * inst.pointValue),
      tests,
      flipped,
      reason: levelReason(members, tests, flipped),
    };
  });

  // keep levels near price, but always a few on each side
  let shown = levels.filter((l) => Math.abs(l.dist) <= SETTINGS_RANGE * A);
  const need = (side, arr) => arr.filter((l) => (side === 'up' ? l.dist > 0 : l.dist <= 0)).length;
  if (need('up', shown) < MIN_EACH || need('down', shown) < MIN_EACH) {
    const ups = levels.filter((l) => l.dist > 0).sort((a, b) => a.dist - b.dist).slice(0, MIN_EACH);
    const downs = levels.filter((l) => l.dist <= 0).sort((a, b) => b.dist - a.dist).slice(0, MIN_EACH);
    const set = new Set(shown);
    for (const l of [...ups, ...downs]) set.add(l);
    shown = [...set];
  }
  shown.sort((a, b) => b.price - a.price);

  // Nearest meaningful (strength >= 2) levels either side.
  const sig = shown.filter((l) => l.strength >= 2);
  const nearestRes = sig.filter((l) => l.dist > 0).sort((a, b) => a.dist - b.dist)[0] || null;
  const nearestSup = sig.filter((l) => l.dist <= 0).sort((a, b) => b.dist - a.dist)[0] || null;

  // Technical inputs for the sentiment model.
  const hc = data.hourly.map((b) => b.c);
  const e20 = last(ema(hc, 20)), e50 = last(ema(hc, 50));
  const dc = dailyDone.map((b) => b.c);
  const d20 = ema(dc, 20);
  const dSlope = d20.length > 5 ? (last(d20) - d20[d20.length - 6]) / 5 : 0;
  const vw = cur ? vwap(cur.bars) : null;
  const pdc = prior ? prior.dayClose ?? prior.c : null;

  const stats = {
    price, atr: A, tick, dec, intraday,
    sessionKey: cur?.key || null,
    live: !!cur,
    sessionOpen: cur?.o ?? null,
    dayOpen: cur?.dayOpen ?? null,
    hod: cur?.h ?? null, lod: cur?.l ?? null,
    vwap: vw?.vwap ?? null,
    pdh: prior?.h ?? null, pdl: prior?.l ?? null, pdc,
    pivot: piv?.P ?? null,
    onh: cur?.overnight?.h ?? null, onl: cur?.overnight?.l ?? null,
    pwh: priorWeek?.h ?? null, pwl: priorWeek?.l ?? null,
    ema20h: e20, ema50h: e50, dailySlope: dSlope,
    rangeUsed: cur ? (cur.h - cur.l) / A : null,
    change: pdc != null ? price - pdc : null,
    changePct: pdc ? ((price - pdc) / pdc) * 100 : null,
  };

  // Sparkline of the current (or last) session, downsampled to <= 96 points.
  const sb = intraday ? (cur || prior || { bars: data.m5.slice(-96) }).bars : data.daily.slice(-60);
  const stepN = Math.max(1, Math.ceil(sb.length / 96));
  const spark = sb.filter((_, i) => i % stepN === 0).map((b) => +b.c.toFixed(dec));

  return { levels: shown, nearest: { support: nearestSup, resistance: nearestRes }, stats, spark };
}

function fmtStep(x) { return x >= 1 ? fmt(x, x % 1 ? 1 : 0) : String(+x.toFixed(4)); }

// How price behaved at a level over the last few sessions.
// A "test" starts when a bar trades into the zone after being clearly away;
// it ends as "held" if price leaves on the same side it came from, else "broke".
function touchStats(bars, level, zone, A) {
  let state = null; // { from: 'above'|'below' }
  let held = 0, broke = 0, lastTest = null;
  const away = Math.max(zone * 2, 0.06 * A);
  let side = null;
  for (const b of bars) {
    const inZone = b.l <= level + zone && b.h >= level - zone;
    if (!state) {
      if (b.l > level + away) side = 'above';
      else if (b.h < level - away) side = 'below';
      if (inZone && side) { state = { from: side }; lastTest = b.t; }
    } else {
      if (b.l > level + away || b.h < level - away) {
        const exit = b.l > level + away ? 'above' : 'below';
        if (exit === state.from) held++; else broke++;
        side = exit; state = null;
      }
    }
  }
  return { held, broke, lastTest };
}

function levelReason(members, tests, flipped) {
  const parts = [];
  const names = members.map((m) => m.label);
  parts.push(members.length > 1
    ? `Confluence of ${members.length}: ${names.join(' + ')}.`
    : `${names[0]}.`);
  if (flipped) parts.push(flipped);
  return parts.join(' ');
}

// Technical score in [-1, 1] with human-readable drivers.
export function technicalScore(stats) {
  const A = stats.atr || 1;
  const t = (x) => Math.tanh(x);
  const drivers = [];
  const comps = [];
  const push = (val, w, text) => { comps.push([val, w]); if (text) drivers.push({ kind: 'technical', effect: val, text }); };

  if (stats.ema20h && stats.ema50h) {
    const v = t(((stats.ema20h - stats.ema50h) / A) * 3);
    push(v, 0.25, `Hourly trend: 20-EMA ${stats.ema20h > stats.ema50h ? 'above' : 'below'} 50-EMA (${stats.ema20h > stats.ema50h ? 'uptrend' : 'downtrend'}).`);
  }
  if (stats.vwap) {
    const v = t((stats.price - stats.vwap) / (0.35 * A));
    push(v, 0.2, `Price ${stats.price >= stats.vwap ? 'above' : 'below'} session VWAP ${fmt(stats.vwap, stats.dec)}.`);
  }
  if (stats.pivot) {
    const v = t((stats.price - stats.pivot) / (0.35 * A));
    push(v, 0.15, `Price ${stats.price >= stats.pivot ? 'above' : 'below'} the daily pivot ${fmt(stats.pivot, stats.dec)}.`);
  }
  if (stats.change != null) {
    const v = t(stats.change / (0.5 * A));
    push(v, 0.2, `${stats.change >= 0 ? 'Up' : 'Down'} ${fmt(Math.abs(stats.change), stats.dec)} vs prior close (${Math.abs(stats.change / A).toFixed(2)} ATR).`);
  }
  if (stats.pdh != null && stats.pdl != null && stats.pdh > stats.pdl) {
    let v;
    let text;
    if (stats.price > stats.pdh) { v = 1; text = 'Trading above the prior day high (range expansion up).'; }
    else if (stats.price < stats.pdl) { v = -1; text = 'Trading below the prior day low (range expansion down).'; }
    else { v = (2 * (stats.price - stats.pdl)) / (stats.pdh - stats.pdl) - 1; v *= 0.5; text = `Inside the prior day range (${Math.round(((stats.price - stats.pdl) / (stats.pdh - stats.pdl)) * 100)}% of it).`; }
    push(v, 0.1, text);
  }
  if (stats.dailySlope) {
    const v = t((stats.dailySlope / A) * 4);
    push(v, 0.1, `Daily 20-EMA sloping ${stats.dailySlope > 0 ? 'up' : 'down'}.`);
  }
  const wsum = comps.reduce((s, [, w]) => s + w, 0) || 1;
  const score = comps.reduce((s, [v, w]) => s + v * w, 0) / wsum;
  return { score: clamp(score, -1, 1), drivers };
}
