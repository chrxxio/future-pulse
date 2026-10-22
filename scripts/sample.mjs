#!/usr/bin/env node
// Offline test harness. Generates synthetic (clearly fake) Yahoo chart responses,
// RSS feeds and a calendar into a fixture folder, then runs the real update
// pipeline against them with SAMPLE=1. Usage:
//   node scripts/sample.mjs [ISO-time]      -> writes dist/ with sample data
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { INSTRUMENTS, MACRO, FEEDS, NEWS_TOPICS, googleNewsUrl, CALENDAR_URLS } from './config.mjs';
import { fixtureName, etParts } from './lib/util.mjs';
import { chartUrl } from './lib/market.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = process.argv[2] ? Date.parse(process.argv[2]) : Date.parse('2026-10-22T14:40:00Z');
const FIX = process.env.FIXTURE_OUT || path.join(ROOT, 'state', 'fixtures');
const H = 'https://query1.finance.yahoo.com';

// deterministic PRNG
let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

const BASE = { MES: 6000, MNQ: 22000, MYM: 45000, M2K: 2300, MGC: 4000, SIL: 48, MCL: 65, MBT: 100000 };
const VOL = { MES: 0.011, MNQ: 0.014, MYM: 0.01, M2K: 0.016, MGC: 0.013, SIL: 0.022, MCL: 0.025, MBT: 0.03 };

const globexOpen = (ms) => {
  const p = etParts(ms);
  if (p.dow === 6) return false;
  if (p.dow === 0) return p.minutes >= 18 * 60;
  if (p.dow === 5) return p.minutes < 17 * 60;
  return !(p.minutes >= 17 * 60 && p.minutes < 18 * 60);
};

const PASS2 = process.env.SAMPLE_PASS === '2';
function genIntraday(base, vol, days) {
  const bars = [];
  const step = 5 * 60e3;
  let t = Math.floor((NOW - days * 864e5) / step) * step;
  let p = base;
  const sd = (base * vol * 0.45) / Math.sqrt(276);
  let drift = 0;
  while (t <= NOW - step) {
    if (globexOpen(t)) {
      if (rnd() < 0.004) drift = gauss() * sd * 0.12;
      const pull = (base - p) * 0.0008;
      const o = p;
      const c = o + gauss() * sd + drift + pull;
      const h = Math.max(o, c) + Math.abs(gauss()) * sd * 0.5;
      const l = Math.min(o, c) - Math.abs(gauss()) * sd * 0.5;
      const hr = etParts(t).h;
      const v = Math.round((hr >= 9 && hr < 16 ? 4000 : 900) * (0.5 + rnd()));
      bars.push({ t, o, h, l, c, v });
      p = c;
    }
    t += step;
  }
  // second pass: same history, but the last half hour trends (exercises alerts)
  if (PASS2) {
    const dir = base % 2 === 0 ? -1 : 1;
    for (let k = 1; k <= 6; k++) {
      const b = bars[bars.length - 7 + k];
      const shift = dir * sd * 2.2 * k;
      b.o += shift; b.h += shift; b.l += shift; b.c += shift;
    }
  }
  return bars;
}

function aggregate(bars, keyFn) {
  const out = [];
  for (const b of bars) {
    const k = keyFn(b.t);
    const a = out[out.length - 1];
    if (a && a.k === k) { a.h = Math.max(a.h, b.h); a.l = Math.min(a.l, b.l); a.c = b.c; a.v += b.v; }
    else out.push({ k, t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
  }
  return out;
}

function chartJson(symbol, bars, price) {
  return JSON.stringify({
    chart: {
      result: [{
        meta: { symbol, currency: 'USD', regularMarketPrice: price, regularMarketTime: Math.floor((NOW - 60e3) / 1000), exchangeTimezoneName: 'America/New_York' },
        timestamp: bars.map((b) => Math.floor(b.t / 1000)),
        indicators: { quote: [{ open: bars.map((b) => b.o), high: bars.map((b) => b.h), low: bars.map((b) => b.l), close: bars.map((b) => b.c), volume: bars.map((b) => b.v) }] },
      }],
      error: null,
    },
  });
}

const write = (url, body) => fs.writeFile(path.join(FIX, fixtureName(url)), body);

async function main() {
  await fs.rm(FIX, { recursive: true, force: true });
  await fs.mkdir(FIX, { recursive: true });

  for (const inst of INSTRUMENTS) {
    const sym = inst.yahoo[0];
    const m5all = genIntraday(BASE[inst.id], VOL[inst.id], 95);
    const price = m5all[m5all.length - 1].c;
    const sessKey = (t) => etParts(t + 6 * 3600e3).date;
    const hourly = aggregate(m5all, (t) => Math.floor(t / 3600e3));
    const dailyRecent = aggregate(m5all, sessKey).map((b) => ({ ...b, t: Date.parse(b.k + 'T04:00:00Z') }));
    // older daily history: random walk backwards from the first recent bar
    const older = [];
    let p = dailyRecent[0].o;
    let t = dailyRecent[0].t;
    for (let i = 0; i < 170; i++) {
      t -= 864e5;
      const d = new Date(t).getUTCDay();
      if (d === 0 || d === 6) { i--; continue; }
      const c = p, o = c - gauss() * c * VOL[inst.id];
      older.unshift({ t, o, c, h: Math.max(o, c) * (1 + rnd() * VOL[inst.id] * 0.5), l: Math.min(o, c) * (1 - rnd() * VOL[inst.id] * 0.5), v: 1e5 });
      p = o;
    }
    const m5 = m5all.filter((b) => b.t >= NOW - 5 * 864e5 - 2 * 864e5);
    await write(chartUrl(H, sym, '1y', '1d'), chartJson(sym, [...older, ...dailyRecent], price));
    await write(chartUrl(H, sym, '3mo', '60m'), chartJson(sym, hourly, price));
    await write(chartUrl(H, sym, '5d', '5m'), chartJson(sym, m5, price));
  }
  const MB = { VIX: [17.2, 18.4], DXY: [99.1, 99.35], US10Y: [4.12, 4.165] };
  for (const m of MACRO) {
    const [a, b] = MB[m.id];
    const bars = Array.from({ length: 22 }, (_, i) => {
      const c = i === 21 ? b : i === 20 ? a : a * (1 + (rnd() - 0.5) * 0.03);
      return { t: NOW - (21 - i) * 864e5, o: c, h: c * 1.005, l: c * 0.995, c, v: 0 };
    });
    await write(chartUrl(H, m.yahoo, '1mo', '1d'), chartJson(m.yahoo, bars, b));
  }

  // RSS — obviously labelled sample headlines
  const ago = (min) => new Date(NOW - min * 60e3).toUTCString();
  const SAMPLE = [
    ['SAMPLE: Treasury yields jump after hotter-than-expected inflation data', 25],
    ['SAMPLE: Oil prices climb as tanker attacks near Strait of Hormuz fuel supply worries', 50],
    ['SAMPLE: Gold rises as dollar weakens ahead of Fed decision', 80],
    ['SAMPLE: Stock futures slip as new tariffs announced on chip imports', 140],
    ['SAMPLE: Nvidia beats estimates, shares jump in late trading', 300],
    ['SAMPLE: Jobless claims fall to lowest level since May', 400],
    ['SAMPLE: OPEC+ agrees to boost output from December', 700],
    ['SAMPLE: Bitcoin ETF record inflows lift crypto market', 900],
    ['SAMPLE: Fed officials say no rush to cut rates &amp; inflation still sticky', 1200],
  ];
  const rss = (items, src) => `<?xml version="1.0"?><rss version="2.0"><channel><title>Sample</title>${items.map(([t, m], i) =>
    `<item><title><![CDATA[${t}${src ? ` - ${src}` : ''}]]></title><link>https://example.com/sample/${i}</link><pubDate>${ago(m)}</pubDate>${src ? `<source url="https://example.com">${src}</source>` : ''}<description>&lt;p&gt;Sample article text for offline testing.&lt;/p&gt;</description></item>`).join('')}</channel></rss>`;
  for (const [i, f] of FEEDS.entries()) {
    if (i % 3 === 2) continue; // leave some feeds "failing" to exercise feed health
    await write(f.url, rss(SAMPLE.filter((_, k) => (k + i) % 2 === 0), ''));
  }
  for (const [i, t] of NEWS_TOPICS.entries()) await write(googleNewsUrl(t.q), rss(SAMPLE.filter((_, k) => (k + i) % 3 === 0), ['Reuters', 'Bloomberg', 'AP'][i % 3]));

  const at = (h) => new Date(NOW + h * 3600e3).toISOString().replace('.000Z', '+00:00');
  await write(CALENDAR_URLS[0], JSON.stringify([
    { title: 'Unemployment Claims', country: 'USD', date: at(-1.2), impact: 'Medium', forecast: '200K', previous: '199K' },
    { title: 'Crude Oil Inventories', country: 'USD', date: at(0.4), impact: 'Medium', forecast: '-1.2M', previous: '2.4M' },
    { title: 'Flash Manufacturing PMI', country: 'USD', date: at(19.1), impact: 'Medium', forecast: '55.4', previous: '57.0' },
    { title: 'Core PCE Price Index m/m', country: 'USD', date: at(3.2), impact: 'High', forecast: '0.3%', previous: '0.2%' },
    { title: 'Main Refinancing Rate', country: 'EUR', date: at(26), impact: 'High', forecast: '2.00%', previous: '2.00%' },
    { title: 'Building Permits', country: 'USD', date: at(5), impact: 'Low', forecast: '', previous: '' },
  ]));
  await write(CALENDAR_URLS[1], '[]');

  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'update.mjs')], {
    stdio: PASS2 ? 'inherit' : 'ignore',
    env: { ...process.env, FIXTURE_DIR: FIX, FIXTURE_NOW: new Date(NOW).toISOString(), SAMPLE: '1', STATE_DIR },
  });
  if (r.status) process.exit(r.status);
  if (!PASS2) {
    // run again with a moved tape so the alert engine has something to compare against
    const r2 = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      stdio: 'inherit', env: { ...process.env, SAMPLE_PASS: '2' },
    });
    process.exit(r2.status ?? 1);
  }
}
const STATE_DIR = process.env.STATE_DIR || path.join(ROOT, 'state', 'sample-state');
if (!PASS2) await fs.rm(STATE_DIR, { recursive: true, force: true });
main();
