// Scheduled catalysts: the week's economic calendar (Forex Factory public JSON).
// These are the events that WILL hit the tape at a known time.
import { fetchJSON, hash } from './util.mjs';
import { CALENDAR_URLS } from '../config.mjs';

// Which markets each kind of release tends to move.
const MAP = [
  [/fomc|federal funds|fed chair|powell|monetary policy|interest rate decision|fed .*speaks/i, ['MES', 'MNQ', 'MYM', 'M2K', 'MGC', 'SIL', 'MBT']],
  [/cpi|pce|ppi|inflation|price index/i, ['MES', 'MNQ', 'MYM', 'M2K', 'MGC', 'SIL', 'MBT']],
  [/non-farm|nonfarm|employment|unemployment|jobless|jolts|adp|payroll|claims/i, ['MES', 'MNQ', 'MYM', 'M2K', 'MGC', 'SIL']],
  [/gdp|retail sales|ism|pmi|durable|consumer (confidence|sentiment)|housing|home sales|industrial production/i, ['MES', 'MNQ', 'MYM', 'M2K', 'MGC']],
  [/crude|oil|eia|api weekly|opec|gasoline|petroleum/i, ['MCL']],
  [/treasury|bond auction|auction/i, ['MES', 'MNQ', 'MGC']],
];

export async function fetchCalendar() {
  const all = [];
  const errors = [];
  for (const url of CALENDAR_URLS) {
    try {
      const arr = await fetchJSON(url, { timeout: 12000, retries: 1 });
      if (Array.isArray(arr)) all.push(...arr);
    } catch (e) { errors.push(`${url.split('/').pop()}: ${e.message}`); }
  }
  return { raw: all, errors };
}

export function processCalendar(raw, nowMs) {
  const out = [];
  const seen = new Set();
  for (const e of raw) {
    const t = Date.parse(e.date);
    if (!Number.isFinite(t)) continue;
    const impact = e.impact || 'Low';
    // US events of medium+ impact, plus high-impact events anywhere (ECB, BoJ, China...)
    const keep = (e.country === 'USD' && (impact === 'High' || impact === 'Medium')) || impact === 'High';
    if (!keep) continue;
    if (t < nowMs - 12 * 3600e3) continue; // drop events older than 12h
    const id = 'e' + hash(`${e.title}|${e.country}|${e.date}`);
    if (seen.has(id)) continue;
    seen.add(id);
    let instruments = [];
    for (const [re, ids] of MAP) if (re.test(e.title)) instruments.push(...ids);
    if (e.country !== 'USD' && !instruments.length) instruments = ['MGC', 'MES'];
    if (e.country !== 'USD') instruments = instruments.filter((x) => ['MES', 'MNQ', 'MGC', 'SIL', 'MCL'].includes(x));
    out.push({
      id, title: e.title, country: e.country, impact, time: new Date(t).toISOString(),
      forecast: e.forecast || '', previous: e.previous || '', actual: e.actual || '',
      instruments: [...new Set(instruments)],
      minutesAway: Math.round((t - nowMs) / 60e3),
    });
  }
  return out.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}
