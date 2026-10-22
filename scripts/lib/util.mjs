// Shared helpers: networking, time (US/Eastern sessions), math.
import fs from 'node:fs/promises';
import path from 'node:path';

export const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// ---------- fixtures (offline testing) ----------
// When FIXTURE_DIR is set, every network call is served from a local file
// named after the request (see fixtureName). Used by scripts/sample.mjs + tests.
const FIXTURE_DIR = process.env.FIXTURE_DIR || '';
export const fixtureName = (url) =>
  url.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9._=-]+/g, '_').slice(0, 180);

export async function fetchText(url, { timeout = 15000, retries = 1, headers = {} } = {}) {
  if (FIXTURE_DIR) {
    const file = path.join(FIXTURE_DIR, fixtureName(url));
    try { return await fs.readFile(file, 'utf8'); }
    catch { throw new Error(`fixture missing: ${fixtureName(url)}`); }
  }
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: '*/*', ...headers },
        signal: AbortSignal.timeout(timeout),
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      if (i < retries) await sleep(700 * (i + 1));
    }
  }
  throw lastErr;
}

export async function fetchJSON(url, opts) {
  return JSON.parse(await fetchText(url, opts));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run async tasks with limited concurrency.
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------- time (America/New_York) ----------
const ET_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
});
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function etParts(ms) {
  const p = Object.fromEntries(ET_FMT.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const h = Number(p.hour) % 24;
  return {
    y: Number(p.year), m: Number(p.month), d: Number(p.day),
    h, mi: Number(p.minute), dow: DOW[p.weekday],
    date: `${p.year}-${p.month}-${p.day}`, minutes: h * 60 + Number(p.minute),
  };
}

// CME Globex sessions run 18:00 ET -> 17:00 ET next day. A bar's trading date is
// the date the session closes. Shifting by +6h maps 18:00..23:59 onto the next date.
export const sessionKey = (ms) => etParts(ms + 6 * 3600e3).date;

// Monday-anchored week key of a session date string (YYYY-MM-DD).
export function weekKey(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}
export const monthKey = (dateStr) => dateStr.slice(0, 7);

// Is CME Globex open right now (ignores exchange holidays)?
export function globexStatus(ms = Date.now()) {
  const p = etParts(ms);
  const t = p.minutes;
  let open;
  if (p.dow === 6) open = false; // Saturday
  else if (p.dow === 0) open = t >= 18 * 60; // Sunday evening open
  else if (p.dow === 5) open = t < 17 * 60; // Friday close
  else open = !(t >= 17 * 60 && t < 18 * 60); // daily maintenance break
  let label = open ? 'Globex open' : 'Closed';
  if (!open && p.dow >= 1 && p.dow <= 4) label = 'Daily break (5–6pm ET)';
  if (!open && (p.dow === 6 || p.dow === 0 || (p.dow === 5 && t >= 17 * 60))) label = 'Weekend — opens Sun 6pm ET';
  return { open, label, et: `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')} ET` };
}

// ---------- math ----------
export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const sum = (a) => a.reduce((s, x) => s + x, 0);
export const mean = (a) => (a.length ? sum(a) / a.length : 0);
export const last = (a) => a[a.length - 1];

export function ema(values, n) {
  const k = 2 / (n + 1);
  const out = [];
  let e;
  for (const v of values) {
    e = e === undefined ? v : v * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

// Wilder ATR over OHLC bars.
export function atr(bars, n = 14) {
  if (bars.length < 2) return bars.length ? bars[0].h - bars[0].l : 0;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], pc = bars[i - 1].c;
    trs.push(Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)));
  }
  let a = mean(trs.slice(0, Math.min(n, trs.length)));
  for (let i = n; i < trs.length; i++) a = (a * (n - 1) + trs[i]) / n;
  return a;
}

// A "nice" increment (1, 2, 2.5, 5 x 10^k) close to x.
export function niceStep(x) {
  if (!(x > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  const f = x / p;
  const nice = f < 1.5 ? 1 : f < 2.25 ? 2 : f < 3.5 ? 2.5 : f < 7.5 ? 5 : 10;
  return nice * p;
}

export const roundTo = (x, step) => Math.round(x / step) * step;

export function decimalsFor(step) {
  const s = String(step);
  return s.includes('.') ? s.split('.')[1].length : 0;
}

export function fmt(x, dec = 2) {
  if (x === null || x === undefined || Number.isNaN(x)) return '—';
  return Number(x).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export async function readJSON(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}
export async function writeJSON(file, data, pretty = false) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, pretty ? 2 : 0));
}
