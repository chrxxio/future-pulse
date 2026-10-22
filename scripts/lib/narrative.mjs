// Rule-based narrative: plain-English read of levels + sentiment + catalysts.
// Everything here is analysis derived from the numbers; the app labels it so.
import { fmt } from './util.mjs';

const tag = (l) => l.codes.slice(0, 3).join(' + ');
const px = (l, dec) => fmt(l.price, dec);

function timeUntil(min) {
  if (min < 0) return `${Math.abs(min)} min ago`;
  if (min < 60) return `in ${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return `in ${h}h${m ? ` ${m}m` : ''}`;
}

export function etClock(iso) {
  return new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }) + ' ET';
}

export function buildNarrative(inst, lv, sent, events, news) {
  const { stats } = lv;
  const dec = stats.dec;
  const lean = sent.score >= 15 ? 'bullish' : sent.score <= -15 ? 'bearish' : 'neutral';
  const c = sent.components;
  const parts = [];

  if (stats.change != null) {
    parts.push(`${inst.id} is ${stats.change >= 0 ? 'up' : 'down'} ${fmt(Math.abs(stats.change), dec)} (${fmt(Math.abs(stats.changePct), 2)}%) vs the prior close`
      + `${stats.vwap ? `, ${stats.price >= stats.vwap ? 'above' : 'below'} session VWAP` : ''}`
      + `${stats.pivot ? ` and ${stats.price >= stats.pivot ? 'above' : 'below'} the daily pivot` : ''}.`);
  }
  const newsTxt = sent.newsCount === 0 ? 'no scored headlines'
    : c.news >= 15 ? 'news flow leans bullish' : c.news <= -15 ? 'news flow leans bearish' : 'news flow is mixed';
  const macTxt = c.macro >= 15 ? 'macro is a tailwind' : c.macro <= -15 ? 'macro is a headwind' : 'macro is neutral';
  parts.push(`Technicals ${c.technical >= 15 ? 'lean bullish' : c.technical <= -15 ? 'lean bearish' : 'are balanced'}, ${newsTxt}, and ${macTxt}.`);
  if (stats.rangeUsed != null) {
    const pct = Math.round(stats.rangeUsed * 100);
    parts.push(`${pct}% of the 14-day ATR (${fmt(stats.atr, dec)}) is already used${pct >= 90 ? ' — the day is extended, so follow-through gets harder.' : '.'}`);
  }

  // Playbook around the nearest significant levels.
  const sig = lv.levels.filter((l) => l.strength >= 2);
  const ups = sig.filter((l) => l.dist > 0).sort((a, b) => a.dist - b.dist);
  const downs = sig.filter((l) => l.dist <= 0).sort((a, b) => b.dist - a.dist);
  const [R1, R2] = ups, [S1, S2] = downs;
  const play = [];
  if (S1 && R1) {
    play.push(`Range in focus: ${px(S1, dec)} (${tag(S1)}) to ${px(R1, dec)} (${tag(R1)}).`);
  }
  if (R1) {
    play.push(`Bull case: acceptance above ${px(R1, dec)}${R2 ? ` opens ${px(R2, dec)} (${tag(R2)})` : ''}.`);
  }
  if (S1) {
    play.push(`Bear case: losing ${px(S1, dec)}${S2 ? ` targets ${px(S2, dec)} (${tag(S2)})` : ''}.`);
  }
  if (lean !== 'neutral' && (lean === 'bullish' ? S1 : R1)) {
    const key = lean === 'bullish' ? S1 : R1;
    play.push(`Bias stays ${lean} while price holds ${lean === 'bullish' ? 'above' : 'below'} ${px(key, dec)}.`);
  }

  const risk = events
    .filter((e) => e.minutesAway > -60 && e.minutesAway < 24 * 60)
    .slice(0, 4)
    .map((e) => `${e.impact} impact: ${e.country} ${e.title} at ${etClock(e.time)} (${timeUntil(e.minutesAway)})`
      + `${e.forecast ? `, forecast ${e.forecast}` : ''}${e.previous ? `, previous ${e.previous}` : ''}.`);

  // Context line on each nearby level.
  const soon = events.find((e) => e.impact === 'High' && e.minutesAway > -15 && e.minutesAway < 6 * 60);
  const topNews = sent.drivers.find((d) => d.kind === 'news');
  const newsById = Object.fromEntries(news.map((n) => [n.id, n]));
  for (const l of lv.levels) {
    if (Math.abs(l.distAtr) > 1.5) continue;
    const bits = [];
    if (l.role === 'testing') bits.push('Price is testing this level now.');
    if (l.role === 'resistance' || l.role === 'testing') {
      bits.push(lean === 'bearish' ? 'Bearish backdrop — sellers have the edge here.'
        : lean === 'bullish' ? 'Bullish backdrop — a break-and-hold above is in play.'
          : 'Mixed backdrop — treat as two-way.');
    } else {
      bits.push(lean === 'bullish' ? 'Bullish backdrop — buyers have the edge here.'
        : lean === 'bearish' ? 'Bearish backdrop — a break below is in play.'
          : 'Mixed backdrop — treat as two-way.');
    }
    if (topNews && Math.abs(c.news) >= 20) {
      const n = newsById[topNews.newsId];
      if (n) bits.push(`News driver: ${n.rules[0] || 'headline flow'}.`);
    }
    if (soon && Math.abs(l.distAtr) <= 0.8) bits.push(`${soon.title} ${timeUntil(soon.minutesAway)} can move price through this level.`);
    l.context = bits.join(' ');
  }

  return { lean, summary: parts.join(' '), playbook: play, eventRisk: risk };
}
