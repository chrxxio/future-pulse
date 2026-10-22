// Detect what changed since the previous run and (optionally) push it to the phone.
import { fmt, hash } from './util.mjs';
import { SETTINGS } from '../config.mjs';
import { etClock } from './narrative.mjs';

export function detectAlerts(prev, cur, nowMs) {
  const alerts = [];
  const t = new Date(nowMs).toISOString();
  // crosses / sentiment flips can legitimately repeat, so they dedupe per 30-min bucket
  const bucket = Math.floor(nowMs / (30 * 60e3));
  const add = (type, instrument, text, priority = 3, extra = {}) => {
    const key = type === 'cross' || type === 'sentiment' ? `${type}|${instrument}|${text}|${bucket}` : `${type}|${extra.newsId || extra.eventId || text}`;
    alerts.push({ id: 'a' + hash(key), time: t, type, instrument, text, priority, ...extra });
  };

  if (prev?.instruments) {
    const prevById = Object.fromEntries(prev.instruments.map((i) => [i.id, i]));
    for (const i of cur.instruments) {
      const p = prevById[i.id];
      if (!p || p.price == null || i.price == null) continue;
      const dec = i.decimals;
      // Level crosses (strength 3+ levels from the previous run); at most the 2 strongest
      const crossed = (p.levels || [])
        .filter((l) => l.strength >= 3 && ((p.price < l.price && i.price > l.price) || (p.price > l.price && i.price < l.price)))
        .sort((a, b) => b.weight - a.weight).slice(0, 2);
      for (const l of crossed) {
        const up = i.price > l.price;
        add('cross', i.id, `${i.id} crossed ${up ? 'above' : 'below'} ${fmt(l.price, dec)} (${l.codes.slice(0, 3).join(' + ')})`,
          l.strength >= 4 ? 4 : 3, { direction: up ? 'up' : 'down' });
      }
      // Sentiment regime change
      if (p.sentiment?.label && p.sentiment.label !== i.sentiment.label) {
        const crossedZero = Math.sign(p.sentiment.score) !== Math.sign(i.sentiment.score) && Math.abs(i.sentiment.score) >= 15;
        add('sentiment', i.id, `${i.id} sentiment ${p.sentiment.label} → ${i.sentiment.label} (${i.sentiment.score > 0 ? '+' : i.sentiment.score < 0 ? '−' : ''}${Math.abs(i.sentiment.score)})`,
          crossedZero ? 4 : 2);
      }
    }
  }
  // New high-impact headlines (skipped on the very first run, when everything is "new")
  for (const n of prev ? cur.news : []) {
    if (!n.isNew || n.impact !== 'high' || n.ageMin > 120) continue;
    const marks = Object.entries(n.effects).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 4)
      .map(([k, v]) => `${k}${v > 0 ? '▲' : '▼'}`).join(' ');
    add('news', null, `${n.title}${marks ? ` — ${marks}` : ''}`, n.kind === 'breaking' ? 5 : 4, { url: n.url, newsId: n.id });
  }
  // Upcoming high-impact events (once, ~30 min before)
  for (const e of cur.calendar) {
    if (e.impact !== 'High' || e.minutesAway < 0 || e.minutesAway > 35) continue;
    add('event', null, `${e.country} ${e.title} at ${etClock(e.time)}${e.forecast ? `, forecast ${e.forecast}` : ''}${e.previous ? `, previous ${e.previous}` : ''}`, 4, { eventId: e.id });
  }
  return alerts;
}

export function mergeAlerts(history = [], fresh = []) {
  const known = new Set(history.map((a) => a.id));
  const added = fresh.filter((a) => !known.has(a.id));
  return { all: [...added, ...history].slice(0, 80), added };
}

export async function pushAlerts(alerts, siteUrl) {
  const topic = process.env.NTFY_TOPIC;
  const discord = process.env.DISCORD_WEBHOOK_URL;
  if (!topic && !discord) return { sent: 0 };
  const minPriority = Number(process.env.PUSH_MIN_PRIORITY || 4);
  const list = alerts.filter((a) => a.priority >= minPriority).slice(0, SETTINGS.maxPushPerRun);
  let sent = 0;
  for (const a of list) {
    const title = a.type === 'news' ? 'Market-moving headline' : a.type === 'event' ? 'Event in ~30 min'
      : a.type === 'cross' ? 'Level cross' : 'Sentiment shift';
    try {
      if (topic) {
        await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
          method: 'POST',
          body: a.text,
          headers: {
            Title: title, Priority: String(Math.min(5, a.priority)), Tags: a.type === 'news' ? 'newspaper' : 'chart_with_upwards_trend',
            ...(a.url || siteUrl ? { Click: a.url || siteUrl } : {}),
          },
          signal: AbortSignal.timeout(10000),
        });
      }
      if (discord) {
        await fetch(discord, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: `**${title}** — ${a.text}${a.url ? `\n${a.url}` : ''}` }),
          signal: AbortSignal.timeout(10000),
        });
      }
      sent++;
    } catch { /* a failed push never breaks the update */ }
  }
  return { sent };
}
