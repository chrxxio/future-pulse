// Optional AI analysis via the Claude API (set the ANTHROPIC_API_KEY secret).
// The model only sees the numbers and headlines this run collected, and must
// cite headline ids — it is told not to add facts of its own.
import { SETTINGS } from '../config.mjs';

const SYSTEM = `You are a futures market analyst writing for a discretionary day trader who reads on a phone.
You receive JSON with live CME micro futures data: price, ATR, computed support/resistance levels (with what each level is), a sentiment score with its components, recent headlines (each with an id), and scheduled economic events.
Rules:
- Use ONLY the data provided. Do not add news, numbers, quotes, or events that are not in the input.
- When a headline supports a point, cite its id in square brackets, e.g. [n1a2b].
- Explain WHY key levels matter right now, combining structure (what the level is, how it was tested) with the news/economic/social context in the headlines and events.
- Be specific with prices. Keep each string short (max ~35 words).
- This is analysis, not financial advice; never tell the reader to buy or sell.
Return ONLY a JSON object, no prose, shaped as:
{"<SYMBOL>": {"summary": string, "levels": [{"price": number, "note": string}], "bull": string, "bear": string, "watch": string}}
Include every symbol in the input. 2-4 levels per symbol, chosen from the provided levels.`;

export function aiEnabled() {
  return !!process.env.ANTHROPIC_API_KEY;
}

export function shouldRunAi(state, nowMs, signature) {
  if (!aiEnabled()) return false;
  const lastAt = state.ai?.generatedAt ? Date.parse(state.ai.generatedAt) : 0;
  if (nowMs - lastAt >= SETTINGS.aiIntervalMinutes * 60e3) return true;
  // re-run early when something important changed (sentiment flip / new high-impact story)
  return state.ai?.signature !== signature && nowMs - lastAt >= 10 * 60e3;
}

export async function runAi(payload) {
  const body = {
    model: SETTINGS.aiModel,
    max_tokens: 6000,
    system: SYSTEM,
    messages: [{ role: 'user', content: JSON.stringify(payload) }],
  };
  const base = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${j?.error?.message || 'error'}`);
  const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('AI returned no JSON');
  return JSON.parse(text.slice(start, end + 1));
}

// Compact input for the model.
export function buildAiPayload(instruments, news, calendar, macro) {
  const newsById = Object.fromEntries(news.map((n) => [n.id, n]));
  return {
    asOf: new Date().toISOString(),
    macro: Object.fromEntries(Object.values(macro).map((m) => [m.id, { price: m.price, changePct: +m.changePct.toFixed(2) }])),
    events: calendar.filter((e) => e.minutesAway > -60 && e.minutesAway < 36 * 60).slice(0, 15)
      .map((e) => ({ title: e.title, country: e.country, impact: e.impact, time: e.time, forecast: e.forecast, previous: e.previous })),
    instruments: instruments.map((i) => ({
      symbol: i.id, name: i.name, price: i.price, changePct: i.changePct, atr: i.atr,
      sentiment: { score: i.sentiment.score, label: i.sentiment.label, ...i.sentiment.components },
      levels: i.levels.filter((l) => Math.abs(l.distAtr) <= 1.6 && l.strength >= 2)
        .map((l) => ({ price: l.price, role: l.role, strength: l.strength, what: l.labels.join(' + '), tested: l.tests })),
      headlines: i.headlineIds.slice(0, 6).map((id) => newsById[id]).filter(Boolean)
        .map((n) => ({ id: n.id, title: n.title, source: n.source, outlets: n.sources.length, minutesAgo: n.ageMin, impact: n.impact, effect: n.effects[i.id] })),
    })),
  };
}
