// Composite sentiment: technical structure + news flow + cross-asset macro.
import { clamp, fmt } from './util.mjs';
import { technicalScore } from './levels.mjs';

// Sensitivities to the macro tape. Signs follow the usual cross-asset
// relationships (higher VIX = risk-off; stronger dollar weighs on metals/oil;
// higher yields weigh on long-duration tech and non-yielding gold).
const MACRO_BETA = {
  equity: { VIX: -0.5, DXY: -0.15, US10Y: -0.35 },
  tech: { VIX: -0.45, DXY: -0.1, US10Y: -0.45 },
  smallcap: { VIX: -0.45, DXY: -0.15, US10Y: -0.4 },
  gold: { VIX: 0.15, DXY: -0.5, US10Y: -0.35 },
  silver: { VIX: -0.05, DXY: -0.5, US10Y: -0.3 },
  oil: { VIX: -0.3, DXY: -0.4, US10Y: 0 },
  crypto: { VIX: -0.45, DXY: -0.3, US10Y: -0.25 },
};
// Size of a "meaningful" daily move for each macro input.
const SCALE = { VIX: 6, DXY: 0.45, US10Y: 6 }; // VIX %, DXY %, 10Y bps

export function macroScore(inst, macro) {
  const key = inst.tags.includes('tech') ? 'tech' : inst.tags.includes('smallcap') ? 'smallcap' : inst.group;
  const beta = MACRO_BETA[key] || MACRO_BETA.equity;
  const drivers = [];
  let s = 0, w = 0;
  for (const [id, b] of Object.entries(beta)) {
    const m = macro[id];
    if (!m || !b) continue;
    const move = id === 'US10Y' ? m.change * 100 : m.changePct; // bps for yields
    const v = Math.tanh(move / SCALE[id]) * Math.sign(b);
    s += v * Math.abs(b); w += Math.abs(b);
    if (Math.abs(move) >= SCALE[id] * 0.25) {
      const what = id === 'US10Y'
        ? `10Y yield ${move > 0 ? '+' : ''}${move.toFixed(1)} bps`
        : `${m.name} ${move > 0 ? '+' : ''}${move.toFixed(2)}%`;
      drivers.push({ kind: 'macro', effect: v * Math.abs(b), text: `${what} — ${v > 0 ? 'tailwind' : 'headwind'} for ${inst.id}.` });
    }
  }
  return { score: w ? clamp(s / w, -1, 1) : 0, drivers };
}

export function label(score) {
  if (score >= 40) return 'Strong Bullish';
  if (score >= 15) return 'Bullish';
  if (score > -15) return 'Neutral';
  if (score > -40) return 'Bearish';
  return 'Strong Bearish';
}

export function composite(inst, stats, news, newsRes, macro) {
  const tech = technicalScore(stats);
  const mac = macroScore(inst, macro);
  // fewer headlines -> news gets less say
  const newsW = newsRes.count === 0 ? 0 : newsRes.count < 3 ? 0.18 : 0.3;
  const W = { tech: 0.5, news: newsW, macro: 0.2 };
  const tot = W.tech + W.news + W.macro;
  const raw = (W.tech * tech.score + W.news * newsRes.score + W.macro * mac.score) / tot;
  const score = Math.round(clamp(raw, -1, 1) * 100);

  // Agreement between components -> confidence.
  const signs = [tech.score, newsRes.count ? newsRes.score : null, mac.score]
    .filter((x) => x !== null && Math.abs(x) > 0.1).map(Math.sign);
  const agree = signs.length ? Math.abs(signs.reduce((a, b) => a + b, 0)) / signs.length : 0;
  const confidence = signs.length < 2 ? 'Low' : agree === 1 ? 'High' : agree >= 0.33 ? 'Medium' : 'Low';

  const drivers = [...tech.drivers.map((d) => ({ ...d, effect: d.effect * W.tech }))];
  const byId = Object.fromEntries(news.map((n) => [n.id, n]));
  for (const c of newsRes.top.slice(0, 4)) {
    const n = byId[c.id];
    if (!n) continue;
    drivers.push({
      kind: 'news', effect: Math.tanh(c.v / 3) * W.news, newsId: n.id,
      text: `${n.rules[0] || 'Headline'}: “${n.title}” (${n.sources.length > 1 ? `${n.sources.length} outlets` : n.source}).`,
    });
  }
  drivers.push(...mac.drivers.map((d) => ({ ...d, effect: d.effect * W.macro })));
  drivers.sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect));

  return {
    score, label: label(score), confidence,
    components: {
      technical: Math.round(tech.score * 100),
      news: Math.round(newsRes.score * 100),
      macro: Math.round(mac.score * 100),
    },
    weights: W,
    newsCount: newsRes.count,
    drivers: drivers.slice(0, 10).map((d) => ({ ...d, effect: +d.effect.toFixed(3) })),
  };
}

export { fmt };
