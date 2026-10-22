// News: fetch RSS, de-duplicate across outlets, classify impact, and score how
// each headline is likely to push each instrument. The scoring is a transparent
// keyword rule set (no black box) — every effect carries the rule that fired.
import { fetchText, hash, pool } from './util.mjs';
import { FEEDS, NEWS_TOPICS, googleNewsUrl, SETTINGS } from '../config.mjs';

// ---------- RSS parsing (no dependencies) ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
export function decode(s = '') {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENT[e.toLowerCase()] ?? m;
    })
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : '';
};
const attr = (xml, name, a) => {
  const m = xml.match(new RegExp(`<${name}[^>]*\\s${a}="([^"]*)"`, 'i'));
  return m ? m[1] : '';
};

function parseDate(s) {
  if (!s) return null;
  s = s.trim();
  // "2026-10-22 05:18:18" (no zone) — treat as UTC
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s)) s = s.replace(' ', 'T') + 'Z';
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

export function parseFeed(xml, feedName) {
  const items = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks) {
    let title = decode(tag(b, 'title'));
    let link = decode(tag(b, 'link')) || attr(b, 'link', 'href');
    const pub = parseDate(decode(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date')));
    let source = decode(tag(b, 'source')) || feedName;
    const desc = decode(tag(b, 'description') || tag(b, 'summary'));
    // Google News titles end with " - Outlet"
    if (feedName.startsWith('Google News') && source && title.endsWith(` - ${source}`)) {
      title = title.slice(0, -(source.length + 3));
    }
    if (!title || !link) continue;
    items.push({ title, url: link.trim(), publishedAt: pub, source, feed: feedName, desc: desc.slice(0, 280) });
  }
  return items;
}

export async function fetchAllNews() {
  const jobs = [
    ...FEEDS.map((f) => ({ ...f })),
    ...NEWS_TOPICS.map((t) => ({ name: `Google News: ${t.name}`, url: googleNewsUrl(t.q), weight: 1 })),
  ];
  const health = [];
  const results = await pool(jobs, 6, async (f) => {
    try {
      const xml = await fetchText(f.url, { timeout: 12000, retries: 1 });
      const items = parseFeed(xml, f.name).map((i) => ({ ...i, weight: f.weight || 1, official: !!f.official }));
      health.push({ name: f.name, ok: true, count: items.length });
      return items;
    } catch (e) {
      health.push({ name: f.name, ok: false, count: 0, error: String(e.message || e).slice(0, 120) });
      return [];
    }
  });
  return { items: results.flat(), health: health.sort((a, b) => a.name.localeCompare(b.name)) };
}

// ---------- de-duplication ----------
const STOP = new Set('a an the of to in on for and or as at by with from is are be its it this that after amid over vs us u.s. says said new will could may might why how what'.split(' '));
const words = (t) => t.toLowerCase().replace(/[^a-z0-9$%. ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
function similar(a, b) {
  const A = new Set(a), B = new Set(b);
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / Math.max(1, Math.min(A.size, B.size));
}

export function dedupe(items, nowMs) {
  const maxAge = SETTINGS.newsMaxAgeHours * 3600e3;
  const fresh = items
    .filter((i) => i.publishedAt && nowMs - i.publishedAt < maxAge && i.publishedAt - nowMs < 15 * 60e3)
    .sort((a, b) => a.publishedAt - b.publishedAt);
  const stories = [];
  for (const it of fresh) {
    const w = words(it.title);
    const match = stories.find((s) => similar(s.w, w) >= 0.7);
    if (match) {
      if (!match.sources.includes(it.source)) match.sources.push(it.source);
      match.weight = Math.max(match.weight, it.weight);
      match.official = match.official || it.official;
      continue;
    }
    stories.push({ ...it, w, sources: [it.source] });
  }
  return stories;
}

// ---------- classification + scoring ----------
// Groups: EQ (all equity index), NQ (tech tilt), RTY (small caps), GC, SI, CL, BTC.
// Effects are signed weights; + = bullish for that market.
const R = (re, fx, tag, impact = 'med', unless = null) => ({ re, fx, tag, impact, unless });
const NOT_DOVISH = /\b(no rush to cut|not (yet )?(ready to )?cut|won'?t cut|unlikely to cut|against (rate )?cuts?|delay\w* (rate )?cuts?|hold(s|ing)? off on (rate )?cuts?|push\w* back (on|against) (rate )?cuts?|fewer (rate )?cuts|(rate[- ])?cut (bets|hopes|expectations) (fade|dim|pared|recede)|pare\w* (back )?(rate[- ])?cut)/i;
const NOT_HAWKISH = /\b(no (more )?rate hikes?|rules? out (rate )?hikes?|end of (the )?(rate[- ])?hik\w*|hikes? (are )?off the table)\b/i;
const RULES = [
  R(/\b(rate cuts?|cuts? (interest )?rates|dovish|eas(e|es|ing) policy|lower(ing)? rates|pivot to cuts)\b/i,
    { EQ: 2, NQ: 1, RTY: 1, GC: 2, SI: 1.5, BTC: 1.5, CL: 0.5 }, 'Dovish Fed / rate cuts', 'high', NOT_DOVISH),
  R(/\b(rate hikes?|raises? (interest )?rates|hawkish|higher for longer|tighten(ing)?)\b/i,
    { EQ: -2, NQ: -1, RTY: -1, GC: -1.5, SI: -1, BTC: -1.5 }, 'Hawkish Fed / higher rates', 'high', NOT_HAWKISH),
  R(NOT_DOVISH, { EQ: -1.5, NQ: -0.7, RTY: -0.7, GC: -1, SI: -0.7, BTC: -1 }, 'Hawkish Fed / higher rates', 'high'),
  R(NOT_HAWKISH, { EQ: 1, NQ: 0.5, GC: 0.7, BTC: 0.5 }, 'Dovish Fed / rate cuts', 'med'),
  R(/\b(inflation|cpi|pce|consumer prices|price index)\b.{0,40}\b(hotter|higher than expected|accelerat\w*|jumps?|surges?|tops? (estimates|expectations|forecasts)|sticky|heats? up|rises? more)/i,
    { EQ: -2, NQ: -0.5, RTY: -0.5, GC: -0.5, BTC: -1 }, 'Hot inflation', 'high'),
  R(/\b(hot|hotter|sticky|firm|stubborn)(-than-expected)? (inflation|cpi|pce|price data)\b/i,
    { EQ: -2, NQ: -0.5, RTY: -0.5, GC: -0.5, BTC: -1 }, 'Hot inflation', 'high'),
  R(/\b(inflation|cpi|pce|consumer prices|price index)\b.{0,40}\b(cool\w*|eases?|slows?|softer|lower than expected|below (estimates|expectations|forecasts)|falls?|moderat\w*)/i,
    { EQ: 2, NQ: 0.5, RTY: 0.5, GC: 1, BTC: 1 }, 'Cooling inflation', 'high'),
  R(/\b(payrolls|jobs report|job growth|hiring|nonfarm|employment report)\b.{0,40}\b(beats?|strong\w*|surges?|jumps?|tops?|better than expected|blowout|robust)/i,
    { EQ: 0.5, GC: -1, SI: -0.5, BTC: -0.5 }, 'Strong jobs data', 'high'),
  R(/\b(jobless claims|unemployment claims|unemployment rate|layoffs)\b.{0,30}\b(fall\w*|fell|drop\w*|declin\w*|lowest|ease\w*)/i,
    { EQ: 0.4, GC: -0.7, SI: -0.3 }, 'Strong jobs data'),
  R(/\b(payrolls|jobs report|job growth|hiring|nonfarm|jobless claims|unemployment)\b.{0,40}\b(miss\w*|weak\w*|slow\w*|disappoint\w*|worse than expected|rises?|jumps?|surges?|cools?)/i,
    { EQ: -0.7, RTY: -1, GC: 1.5, SI: 0.5, CL: -0.5 }, 'Weak labor data', 'high'),
  R(/\b(recession|economic slowdown|contraction|downturn|stagflation|hard landing)\b/i,
    { EQ: -1.5, RTY: -1, CL: -1.5, GC: 1, SI: -0.5, BTC: -0.5 }, 'Growth scare'),
  R(/\b((?<!(trade|price|bidding|talent|culture|tariff|currency) )war|invasion|invades?|missiles?|air ?strikes?|strikes? on|attacks?|attacked|escalat\w*|military action|drones?|retaliat\w*|blockade|shelling)\b/i,
    { EQ: -1.2, NQ: -0.3, GC: 2, SI: 1, CL: 1, BTC: -0.5 }, 'Geopolitical escalation', 'high'),
  R(/\b(ceasefire|cease-fire|peace (deal|talks|agreement|plan)|truce|de-?escalat\w*|hostage deal)\b/i,
    { EQ: 1, GC: -1.5, SI: -0.5, CL: -1.5 }, 'De-escalation'),
  R(/\b(iran|israel|middle east|saudi|gulf|hormuz|red sea|houthis?|tanker|oil (field|facility|refinery|infrastructure)|libya|venezuela|russian oil)\b.{0,60}\b(attack\w*|strikes?|seiz\w*|disrupt\w*|clos\w*|halt\w*|blockade|threat\w*|sanction\w*)|\b(attack\w*|strikes?|disrupt\w*|threat\w*)\b.{0,60}\b(hormuz|tankers?|oil (field|facility|refinery|infrastructure)|saudi)/i,
    { CL: 2.5, GC: 0.5 }, 'Oil supply risk (geopolitical)', 'high'),
  R(/\b(opec\+?|saudi|production|output|supply|exports?)\b.{0,40}\b(cuts?|curbs?|reduc\w*|disrupt\w*|outages?|halt\w*|shut\w*)|\b(inventory|stockpiles?|inventories) (draw|fall|drop|declin\w*)|\bcrude draw\b|supply disruption/i,
    { CL: 2.5 }, 'Oil supply tightening'),
  R(/\b(opec\+?|output|production|supply)\b.{0,40}\b(increas\w*|boost\w*|hikes?|raises?|ramp\w*|surge\w*|glut)|\b(inventory|stockpiles?|inventories) (build|rise|jump|swell)|\bcrude build\b|oversuppl\w*/i,
    { CL: -2.5 }, 'Oil supply increasing'),
  R(/\b(oil|crude|fuel) demand\b.{0,30}\b(weak\w*|slump\w*|falls?|concerns?|worr\w*|soft\w*)/i,
    { CL: -1.5 }, 'Weak oil demand'),
  R(/\b(dollar|greenback|dxy)\b.{0,30}\b(rall\w*|surg\w*|jumps?|strengthen\w*|climbs?|gains?|rises?|firms?|soars?)/i,
    { GC: -1.5, SI: -1, CL: -0.5, EQ: -0.4, BTC: -0.5 }, 'Stronger dollar'),
  R(/\b(dollar|greenback|dxy)\b.{0,30}\b(slump\w*|falls?|slid\w*|slides?|weaken\w*|drops?|tumbl\w*|declin\w*|sinks?)/i,
    { GC: 1.5, SI: 1, CL: 0.5, EQ: 0.3, BTC: 0.5 }, 'Weaker dollar'),
  R(/\b(treasury )?yields?\b.{0,30}\b(rise|rises|rising|jump\w*|surg\w*|climb\w*|spik\w*|soar\w*|hits? .{0,10}high)|\bbond (selloff|sell-off|rout|vigilantes)\b/i,
    { EQ: -1, NQ: -1, RTY: -0.7, GC: -1, BTC: -0.5 }, 'Rising yields'),
  R(/\byields?\b.{0,30}\b(fall|falls|falling|drop\w*|slid\w*|slides?|tumbl\w*|declin\w*|retreat\w*|ease|eases)|\bbond rally\b/i,
    { EQ: 0.8, NQ: 0.6, RTY: 0.5, GC: 1 }, 'Falling yields'),
  R(/\b(tariffs?|trade war|export (controls|curbs|ban)|import dut(y|ies)|retaliatory|trade barriers)\b.{0,50}\b(new|impos\w*|raises?|hikes?|threat\w*|announc\w*|expand\w*|escalat\w*|steeper|slaps?)|\b(impos\w*|threat\w*|announc\w*|slaps?)\b.{0,30}\btariffs?\b/i,
    { EQ: -1.5, NQ: -0.7, RTY: -0.5, GC: 1, CL: -0.5, BTC: -0.5 }, 'Trade escalation', 'high'),
  R(/\b(tariffs?|trade war|export controls)\b.{0,50}\b(paus\w*|delay\w*|exempt\w*|deal|agreement|lift\w*|roll(s|ed)? back|truce|eas\w*|reliefs?)|\btrade (deal|agreement|truce)\b/i,
    { EQ: 1.5, NQ: 0.5, GC: -0.5, CL: 0.3 }, 'Trade relief', 'high'),
  R(/\b(government shutdown|debt ceiling|debt limit|default|credit rating (cut|downgrade)|downgrades? .{0,20}(us|u\.s\.|sovereign))\b/i,
    { EQ: -1, GC: 1.5, BTC: 0.5 }, 'Fiscal risk'),
  R(/\bbank (failure|collapse|run)s?\b|\bliquidity crisis\b|\bcontagion\b|\bcredit (crunch|event)\b|\bbankruptcy\b/i,
    { EQ: -1.5, RTY: -1, GC: 1.5, CL: -0.5 }, 'Financial stress', 'high'),
  R(/\b(stimulus|tax cuts?|quantitative easing|liquidity injection|spending (bill|package) (passes|approved|signed))\b/i,
    { EQ: 1.5, RTY: 0.5, GC: 0.5, BTC: 1 }, 'Stimulus'),
  R(/\bchina\b.{0,40}\b(stimulus|rate cut|easing|support measures)\b/i,
    { CL: 1, SI: 0.7, EQ: 0.4 }, 'China stimulus'),
  R(/\b(safe[- ]haven|flight to safety|risk[- ]off)\b/i,
    { GC: 1.5, SI: 0.5, EQ: -1, BTC: -0.5 }, 'Risk-off flows'),
  R(/\b(risk[- ]on|risk appetite)\b/i, { EQ: 1, GC: -0.5, BTC: 0.5 }, 'Risk-on flows'),
  R(/\bcentral banks?\b.{0,40}\b(buy\w*|purchas\w*|add\w*|accumulat\w*)\b.{0,20}\bgold\b/i, { GC: 1.5 }, 'Central-bank gold buying'),
  R(/\b(hurricane|tropical storm)\b.{0,60}\b(gulf|refiner\w*|offshore|production)\b/i, { CL: 1 }, 'Gulf storm supply risk'),
  R(/\b(bitcoin|crypto)\b.{0,40}\b(etf inflows|approval|adoption|reserve|record inflows)\b/i, { BTC: 2 }, 'Crypto inflows / adoption'),
  R(/\b(bitcoin|crypto)\b.{0,40}\b(hack\w*|exploit\w*|ban\w*|crackdown|outflows|liquidat\w*)\b/i, { BTC: -2 }, 'Crypto stress'),
  R(/\b(beats?|tops?|surpass\w*) (\w+ ){0,3}(estimates|expectations|forecasts)|raises? (its )?(guidance|outlook|forecast)|record (revenue|profit|earnings)/i,
    { _subject: 1.2 }, 'Earnings beat'),
  R(/\bmiss(es|ed)? (\w+ ){0,3}(estimates|expectations|forecasts)|cuts? (its )?(guidance|outlook|forecast)|profit warning|warns? (on|of) (sales|profit|demand)/i,
    { _subject: -1.2 }, 'Earnings miss'),
];

// What a headline is "about" — used to route generic price-action words.
const SUBJECT = {
  EQ: /\b(stocks?|equit(y|ies)|s&p|s&p 500|spx|nasdaq|dow|wall street|index futures|stock futures|stock market|megacaps?|magnificent seven)\b/i,
  NQ: /\b(nasdaq|tech|technology|chips?|chipmakers?|semiconductors?|ai stocks?|artificial intelligence|nvidia|apple|microsoft|alphabet|google|amazon|meta|tesla|broadcom|amd|tsmc|netflix|palantir)\b/i,
  RTY: /\b(russell|small[- ]caps?|regional banks?)\b/i,
  GC: /\b(gold|bullion|precious metals?)\b/i,
  SI: /\b(silver|precious metals?)\b/i,
  CL: /\b(oil|crude|wti|brent|opec\+?|gasoline|refiner\w*|petroleum|energy prices)\b/i,
  BTC: /\b(bitcoin|btc|crypto\w*|ether|ethereum)\b/i,
  MACRO: /\b(fed|federal reserve|fomc|powell|fed chair|inflation|cpi|pce|payrolls|jobs report|jobless|unemployment|gdp|treasury|yields?|bonds?|dollar|tariffs?|recession|economy|economic|white house|congress|sanctions?|war|ceasefire|opec|central bank)\b/i,
};
const UP = /\b(rall\w*|surg\w*|jumps?|jumped|soar\w*|gains?|gained|climb\w*|rebound\w*|record high|all-time high|hits? (a )?record|higher|rises?|rising|rose|advanc\w*|boost\w*|upbeat|bullish|spikes?|best day)\b/i;
const DOWN = /\b(plung\w*|tumbl\w*|slump\w*|sinks?|sank|slid\w*|slides?|falls?|falling|fell|drops?|dropped|declin\w*|sell-?off|lower|losses|loses|bearish|crash\w*|rout|worst day|slips?|retreat\w*)\b/i;

const HIGH_IMPACT = /\b(fomc|fed (decision|statement|minutes|chair)|federal reserve (decision|raises|cuts|holds)|rate decision|cpi|pce|nonfarm|payrolls|jobs report|gdp|opec\+? (decision|meeting|agrees|cuts|boosts)|emergency|invasion|war|tariffs?|shutdown|default|bank (failure|collapse)|crash|plunges?|record (high|low)|hormuz)\b/i;
const FORWARD = /\b(ahead of|set to|expected to|will (decide|announce|release|meet|report)|looms?|next week|this week|later today|tomorrow|on deck|braces? for|awaits?|preview|could (spark|trigger|move)|due (out|today|tomorrow))\b/i;

const GROUP_OF = { equity: 'EQ', gold: 'GC', silver: 'SI', oil: 'CL', crypto: 'BTC' };
export const groupKeys = (inst) => {
  const g = [GROUP_OF[inst.group]];
  if (inst.tags.includes('tech')) g.push('NQ');
  if (inst.tags.includes('smallcap')) g.push('RTY');
  return g;
};

export function scoreStory(story, instruments) {
  const text = `${story.title}. ${story.desc || ''}`;
  const title = story.title;
  const subjects = Object.entries(SUBJECT).filter(([, re]) => re.test(text)).map(([k]) => k);
  const fired = [];
  const fx = {}; // group -> effect
  const addFx = (g, v) => { fx[g] = (fx[g] || 0) + v; };
  let impact = 'low';
  const bump = (lvl) => { const o = { low: 0, med: 1, high: 2 }; if (o[lvl] > o[impact]) impact = lvl; };

  for (const r of RULES) {
    if (!r.re.test(text)) continue;
    if (r.unless && r.unless.test(text)) continue;
    fired.push(r.tag);
    bump(r.impact);
    for (const [g, v] of Object.entries(r.fx)) {
      if (g === '_subject') {
        for (const s of subjects) if (s !== 'MACRO') addFx(s, v);
      } else addFx(g, v);
    }
  }
  // Generic price-action wording ("gold jumps", "stocks slide") applies to the subject.
  const up = UP.test(title), down = DOWN.test(title);
  if (up !== down) {
    const v = up ? 1 : -1;
    const direct = subjects.filter((s) => s !== 'MACRO');
    if (direct.length) { fired.push(up ? 'Price action: up' : 'Price action: down'); bump('med'); }
    for (const s of direct) addFx(s, v);
  }
  if (HIGH_IMPACT.test(text)) bump('high');
  if (!fired.length && subjects.length) bump('low');
  // Official releases are high impact only when they are policy news (not e.g. enforcement notices)
  if (story.official && (fired.length || /\b(fomc|monetary policy|statement|minutes|discount rate|interest rate|policy rate|balance sheet|economic projections|beige book)\b/i.test(text))) bump('high');

  // Map group effects onto each instrument.
  const effects = {};
  const relevant = [];
  for (const inst of instruments) {
    const gs = groupKeys(inst);
    let v = 0;
    for (const g of gs) v += fx[g] || 0;
    // equities inherit broad EQ moves; NQ/RTY add their own tilt on top
    if (gs.length > 1) v = (fx.EQ || 0) + (fx[gs[1]] || 0);
    // the S&P is ~1/3 megacap tech, so it inherits part of a tech-specific move
    if (inst.tags.includes('spx')) v += 0.3 * (fx.NQ || 0);
    // silver follows gold when no silver-specific rule fired
    if (inst.group === 'silver' && fx.SI === undefined) v = 0.6 * (fx.GC || 0);
    const aboutIt = gs.some((g) => subjects.includes(g));
    if (Math.abs(v) >= 0.25) effects[inst.id] = +v.toFixed(2);
    if (aboutIt || Math.abs(v) >= 0.25) relevant.push(inst.id);
  }
  const relevantToMarkets = relevant.length > 0 || subjects.length > 0;
  return {
    effects, relevant, subjects, rules: [...new Set(fired)], impact,
    forward: FORWARD.test(text), relevantToMarkets,
  };
}

export function processNews(rawItems, instruments, nowMs, prevSeen = {}) {
  const stories = dedupe(rawItems, nowMs);
  const out = [];
  for (const s of stories) {
    const sc = scoreStory(s, instruments);
    if (!sc.relevantToMarkets) continue;
    const ageMin = Math.round((nowMs - s.publishedAt) / 60e3);
    const id = 'n' + hash(s.title.toLowerCase().slice(0, 80));
    const kind = ageMin <= SETTINGS.breakingMinutes && sc.impact !== 'low' ? 'breaking'
      : sc.forward ? 'catalyst' : 'news';
    out.push({
      id, title: s.title, url: s.url, source: s.source, sources: s.sources.slice(0, 8),
      publishedAt: new Date(s.publishedAt).toISOString(), ageMin,
      impact: sc.impact, kind, effects: sc.effects, relevant: sc.relevant, rules: sc.rules,
      official: !!s.official, desc: s.desc || '',
      firstSeen: prevSeen[id] || new Date(nowMs).toISOString(),
      isNew: !prevSeen[id],
      weight: s.weight,
    });
  }
  out.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  return out.slice(0, 250);
}

// News pressure on one instrument in [-1, 1] + the stories behind it.
export function newsScore(news, instId, nowMs) {
  const half = SETTINGS.newsHalfLifeHours * 3600e3;
  const impW = { low: 0.6, med: 1, high: 1.5 };
  let total = 0, count = 0;
  const contrib = [];
  for (const n of news) {
    const e = n.effects[instId];
    if (!e) continue;
    const age = nowMs - Date.parse(n.publishedAt);
    const decay = Math.pow(0.5, age / half);
    const breadth = Math.min(2, 1 + 0.25 * (n.sources.length - 1));
    const v = e * impW[n.impact] * breadth * decay * (n.weight || 1);
    total += v; count++;
    contrib.push({ id: n.id, v });
  }
  contrib.sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
  // direction share (net / gross) scaled by how much news there is
  const gross = contrib.reduce((s, c) => s + Math.abs(c.v), 0);
  const score = gross ? (total / gross) * Math.tanh(gross / 8) : 0;
  return { score, raw: total, count, top: contrib.slice(0, 8) };
}
