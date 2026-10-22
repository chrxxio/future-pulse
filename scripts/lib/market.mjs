// Price data from Yahoo Finance's public chart endpoint, plus session building.
import { fetchJSON, sessionKey, etParts, weekKey, monthKey, last } from './util.mjs';

const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];

export const chartUrl = (host, symbol, range, interval) =>
  `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=true&events=div%2Csplits`;

async function chart(symbol, range, interval) {
  let lastErr;
  for (const host of HOSTS) {
    try {
      const j = await fetchJSON(chartUrl(host, symbol, range, interval), { timeout: 15000, retries: 1 });
      const r = j?.chart?.result?.[0];
      if (!r) throw new Error(j?.chart?.error?.description || 'empty chart');
      return r;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

export function toBars(result) {
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if ([o, h, l, c].some((x) => x === null || x === undefined || Number.isNaN(x))) continue;
    bars.push({ t: ts[i] * 1000, o, h, l, c, v: q.volume?.[i] || 0 });
  }
  return bars;
}

// Fetch daily (1y), hourly (3mo) and 5-minute (5d) bars for one instrument.
export async function loadInstrumentBars(inst) {
  let lastErr;
  for (const symbol of inst.yahoo) {
    try {
      const [d, h, m5] = await Promise.all([
        chart(symbol, '1y', '1d'),
        chart(symbol, '3mo', '60m'),
        chart(symbol, '5d', '5m'),
      ]);
      const out = {
        symbol,
        meta: m5.meta || d.meta || {},
        daily: toBars(d),
        hourly: toBars(h),
        m5: toBars(m5),
      };
      if (out.m5.length < 20 || out.daily.length < 20) throw new Error('not enough bars');
      return out;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

export async function loadMacro(m) {
  const r = await chart(m.yahoo, '1mo', '1d');
  const bars = toBars(r);
  const price = r.meta?.regularMarketPrice ?? last(bars)?.c;
  // previous close = last completed daily close before today's bar
  const prev = bars.length >= 2 ? bars[bars.length - 2].c : null;
  return { id: m.id, name: m.name, price, prev, change: prev ? price - prev : 0,
    changePct: prev ? ((price - prev) / prev) * 100 : 0, unit: m.unit,
    spark: bars.slice(-20).map((b) => +b.c.toFixed(3)) };
}

// Group intraday bars into Globex sessions (18:00 -> 17:00 ET).
export function buildSessions(bars, inst) {
  const map = new Map();
  for (const b of bars) {
    const key = sessionKey(b.t);
    let s = map.get(key);
    if (!s) { s = { key, bars: [] }; map.set(key, s); }
    s.bars.push(b);
  }
  const [dStart, dEnd] = inst.day;
  return [...map.values()].map((s) => {
    const bs = s.bars;
    const o = bs[0].o, c = last(bs).c;
    let h = -Infinity, l = Infinity, v = 0;
    for (const b of bs) { h = Math.max(h, b.h); l = Math.min(l, b.l); v += b.v; }
    // Overnight = bars before the day session opens (from 18:00 ET previous evening).
    const on = bs.filter((b) => { const p = etParts(b.t); return p.minutes < dStart || p.h >= 18; });
    const day = bs.filter((b) => { const p = etParts(b.t); return p.h < 18 && p.minutes >= dStart && p.minutes < dEnd; });
    const ib = inst.ib ? day.filter((b) => etParts(b.t).minutes < dStart + 60) : [];
    const hl = (arr) => arr.length ? { h: Math.max(...arr.map((b) => b.h)), l: Math.min(...arr.map((b) => b.l)) } : null;
    return {
      key: s.key, week: weekKey(s.key), month: monthKey(s.key),
      o, h, l, c, v, bars: bs, start: bs[0].t, end: last(bs).t,
      overnight: hl(on),
      dayOpen: day.length ? day[0].o : null,
      dayClose: day.length ? last(day).c : null,
      dayStarted: day.length > 0,
      dayDone: day.length > 0 && etParts(last(bs).t).minutes >= dEnd - 5 && etParts(last(bs).t).h < 18,
      ib: ib.length >= 11 ? hl(ib) : null, // only once the first hour is complete (12 x 5m)
    };
  }).sort((a, b) => a.start - b.start);
}

// Aggregate sessions (from hourly bars) into weeks / months.
export function aggregate(sessions, keyName) {
  const map = new Map();
  for (const s of sessions) {
    const k = s[keyName];
    let a = map.get(k);
    if (!a) { a = { key: k, o: s.o, h: s.h, l: s.l, c: s.c, sessions: 0 }; map.set(k, a); }
    a.h = Math.max(a.h, s.h); a.l = Math.min(a.l, s.l); a.c = s.c; a.sessions++;
  }
  return [...map.values()];
}

// Session VWAP with standard-deviation bands from 5m bars.
export function vwap(bars) {
  let pv = 0, vol = 0, pv2 = 0;
  for (const b of bars) {
    const tp = (b.h + b.l + b.c) / 3, v = b.v || 0;
    pv += tp * v; vol += v; pv2 += tp * tp * v;
  }
  if (!vol) return null;
  const vw = pv / vol;
  const sd = Math.sqrt(Math.max(0, pv2 / vol - vw * vw));
  return { vwap: vw, sd };
}

// Volume profile: spread each bar's volume across its range into price bins.
export function volumeProfile(bars, binSize) {
  if (!bars.length || !(binSize > 0)) return null;
  const bins = new Map();
  let total = 0;
  for (const b of bars) {
    const v = b.v || 0;
    if (!v) continue;
    const lo = Math.floor(b.l / binSize), hi = Math.floor(b.h / binSize);
    const n = hi - lo + 1, share = v / n;
    for (let k = lo; k <= hi; k++) bins.set(k, (bins.get(k) || 0) + share);
    total += v;
  }
  if (!total) return null;
  const keys = [...bins.keys()].sort((a, b) => a - b);
  let poc = keys[0];
  for (const k of keys) if (bins.get(k) > bins.get(poc)) poc = k;
  // Value area: expand from POC until 70% of volume is covered.
  let lo = keys.indexOf(poc), hi = lo, acc = bins.get(poc);
  while (acc < total * 0.7 && (lo > 0 || hi < keys.length - 1)) {
    const down = lo > 0 ? bins.get(keys[lo - 1]) : -1;
    const up = hi < keys.length - 1 ? bins.get(keys[hi + 1]) : -1;
    if (up >= down) acc += bins.get(keys[++hi]); else acc += bins.get(keys[--lo]);
  }
  const mid = (k) => (k + 0.5) * binSize;
  return { poc: mid(poc), vah: (keys[hi] + 1) * binSize, val: keys[lo] * binSize };
}

// Fractal swing highs/lows: a bar whose high (low) is the extreme of +/- n bars.
export function swings(bars, n = 5) {
  const highs = [], lows = [];
  for (let i = n; i < bars.length - n; i++) {
    let isH = true, isL = true;
    for (let j = i - n; j <= i + n; j++) {
      if (j === i) continue;
      if (bars[j].h >= bars[i].h) isH = false;
      if (bars[j].l <= bars[i].l) isL = false;
      if (!isH && !isL) break;
    }
    if (isH) highs.push({ price: bars[i].h, t: bars[i].t });
    if (isL) lows.push({ price: bars[i].l, t: bars[i].t });
  }
  return { highs, lows };
}

// Merge nearby swing points into zones; more touches = stronger level.
export function clusterSwings(points, tol) {
  const sorted = [...points].sort((a, b) => a.price - b.price);
  const clusters = [];
  for (const p of sorted) {
    const c = last(clusters);
    if (c && p.price - c.points[0].price <= tol) { // compare to zone start: no chaining
      c.points.push(p); c.max = p.price;
    } else clusters.push({ points: [p], max: p.price });
  }
  return clusters.map((c) => ({
    price: c.points.reduce((s, p) => s + p.price, 0) / c.points.length,
    touches: c.points.length,
    lastT: Math.max(...c.points.map((p) => p.t)),
  }));
}
