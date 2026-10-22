#!/usr/bin/env node
// Offline checks of the whole pipeline (no network). Run: npm test
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseFeed, scoreStory } from './lib/news.mjs';
import { INSTRUMENTS } from './config.mjs';
import { fixtureName } from './lib/util.mjs';
import { chartUrl } from './lib/market.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'fp-test-'));
let passed = 0;
const ok = (name) => { passed++; console.log('  ✓', name); };

function run(script, env) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...(env.ARG ? [env.ARG] : [])], {
    env: { ...process.env, ...env }, encoding: 'utf8',
  });
  if (r.status !== 0) { console.error(r.stdout, r.stderr); throw new Error(`${script} exited ${r.status}`); }
  return r.stdout;
}
// async variant: keeps this process's event loop free (needed for the mock API server)
function runAsync(script, env) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [path.join(ROOT, 'scripts', script), ...(env.ARG ? [env.ARG] : [])], { env: { ...process.env, ...env } });
    let out = ''; c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (out += d));
    c.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${script} exited ${code}\n${out}`))));
  });
}
async function sample(label, iso, extra = {}) {
  const dir = path.join(tmp, label);
  const env = { ARG: iso, DIST_DIR: path.join(dir, 'dist'), STATE_DIR: path.join(dir, 'state'), FIXTURE_OUT: path.join(dir, 'fx'), ...extra };
  await runAsync('sample.mjs', env);
  return { dir, env, data: JSON.parse(await fs.readFile(path.join(dir, 'dist', 'data', 'market.json'), 'utf8')) };
}

function checkShape(d, label) {
  assert.equal(d.instruments.length, INSTRUMENTS.length, `${label}: instrument count`);
  for (const i of d.instruments) {
    if (i.error) continue;
    assert.ok(Number.isFinite(i.price), `${label} ${i.id}: price`);
    assert.ok(i.atr > 0, `${label} ${i.id}: atr`);
    assert.ok(i.sentiment.score >= -100 && i.sentiment.score <= 100, `${label} ${i.id}: score range`);
    assert.ok(i.levels.length >= 6, `${label} ${i.id}: has levels`);
    for (let k = 1; k < i.levels.length; k++) assert.ok(i.levels[k - 1].price > i.levels[k].price, `${label} ${i.id}: levels sorted & unique`);
    for (const l of i.levels) {
      assert.ok(l.strength >= 1 && l.strength <= 5, 'strength 1-5');
      if (l.role === 'resistance') assert.ok(l.price > i.price, `${i.id} resistance above price`);
      if (l.role === 'support') assert.ok(l.price <= i.price, `${i.id} support at/below price`);
      assert.ok(Math.abs(Math.round(l.price / i.tick) * i.tick - l.price) < 1e-6, `${i.id} level on tick grid`);
      assert.ok(l.labels.length && l.reason, 'level explained');
    }
    if (i.nearest.support) assert.ok(i.nearest.support.price <= i.price);
    if (i.nearest.resistance) assert.ok(i.nearest.resistance.price > i.price);
    assert.ok(i.narrative.summary.length > 20, 'narrative');
  }
  const ids = d.news.map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length, 'news ids unique');
  for (let k = 1; k < d.calendar.length; k++) assert.ok(d.calendar[k - 1].time <= d.calendar[k].time, 'calendar sorted');
}
const codes = (d, id) => d.instruments.find((i) => i.id === id).levels.flatMap((l) => l.codes);

console.log('Parsers & scoring');
{
  const rss = `<rss><channel><item><title><![CDATA[Gold &amp; silver jump as dollar slides]]></title><link>https://x.test/a</link><pubDate>Thu, 22 Oct 2026 12:00:00 GMT</pubDate></item>
  <item><title>Oil falls &#8212; OPEC+ to boost output</title><link>https://x.test/b</link><pubDate>2026-10-22 05:18:18</pubDate></item></channel></rss>`;
  const items = parseFeed(rss, 'Test');
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Gold & silver jump as dollar slides');
  assert.equal(items[1].title, 'Oil falls — OPEC+ to boost output');
  assert.equal(items[1].publishedAt, Date.parse('2026-10-22T05:18:18Z'));
  ok('RSS: CDATA, entities, zone-less dates');
  const atom = `<feed><entry><title>Fed holds rates</title><link href="https://x.test/c"/><updated>2026-10-22T13:00:00Z</updated></entry></feed>`;
  assert.equal(parseFeed(atom, 'Atom')[0].url, 'https://x.test/c');
  ok('Atom entries');
  const gn = `<rss><channel><item><title>Stocks rally - Reuters</title><link>https://news.google.com/x</link><pubDate>Thu, 22 Oct 2026 12:00:00 GMT</pubDate><source url="https://reuters.com">Reuters</source></item></channel></rss>`;
  const g = parseFeed(gn, 'Google News: Stocks')[0];
  assert.equal(g.title, 'Stocks rally'); assert.equal(g.source, 'Reuters');
  ok('Google News source suffix stripped');
  const sc = (t) => scoreStory({ title: t, desc: '' }, INSTRUMENTS).effects;
  assert.ok(sc('OPEC+ agrees to cut output').MCL > 0);
  assert.ok(sc('Crude stockpiles build for third week, oversupply fears grow').MCL < 0);
  assert.ok(sc('Fed says no rush to cut rates').MES < 0, 'negated dovish -> hawkish');
  assert.ok(sc('Fed cuts rates by 25 basis points').MES > 0);
  assert.ok(sc('Gold hits record high as safe-haven demand surges').MGC > 0);
  assert.ok(!sc('Price war among airlines heats up').MGC, 'price war is not war');
  ok('directional rules (supply, Fed negation, safe haven, false positives)');
}

console.log('Pipeline scenarios');
const rth = await sample('rth', '2026-10-22T14:40:00Z'); // Thu 10:40 ET
checkShape(rth.data, 'rth');
assert.equal(rth.data.market.open, true);
const mesAll = rth.data.instruments.find((i) => i.id === 'MES');
assert.ok(mesAll.session.onh && mesAll.session.dayOpen, 'overnight + day open present during RTH');
assert.ok(rth.data.alerts.length > 0, 'alerts produced on second pass');
ok('weekday RTH: shape, sessions, alerts');

const pre = await sample('pre', '2026-10-22T11:00:00Z'); // Thu 07:00 ET (before NY open)
checkShape(pre.data, 'pre');
const mesPre = pre.data.instruments.find((i) => i.id === 'MES');
assert.equal(mesPre.session.dayOpen, null, 'no day open before 9:30');
assert.ok(!codes(pre.data, 'MES').includes('IBH'), 'no IB before day session');
ok('pre-open: no day-session levels yet');

const brk = await sample('break', '2026-10-21T21:30:00Z'); // Wed 17:30 ET
checkShape(brk.data, 'break');
assert.equal(brk.data.market.open, false);
ok('daily maintenance break');

const sat = await sample('sat', '2026-10-24T16:00:00Z'); // Saturday
checkShape(sat.data, 'sat');
assert.equal(sat.data.market.open, false);
assert.match(sat.data.market.label, /Weekend/);
const mesSat = sat.data.instruments.find((i) => i.id === 'MES');
assert.ok(mesSat.session.pdh, 'Friday becomes prior day on the weekend');
ok('weekend: levels prepared for Monday');

const sun = await sample('sun', '2026-10-25T23:30:00Z'); // Sun 19:30 ET
checkShape(sun.data, 'sun');
assert.equal(sun.data.market.open, true);
ok('Sunday evening open');

// Failure handling: a market whose data disappears keeps its last good data, flagged stale.
{
  const fx = rth.env.FIXTURE_OUT;
  for (const r of [['1y', '1d'], ['3mo', '60m'], ['5d', '5m']]) {
    for (const s of INSTRUMENTS.find((i) => i.id === 'MBT').yahoo) {
      await fs.rm(path.join(fx, fixtureName(chartUrl('https://query1.finance.yahoo.com', s, ...r))), { force: true });
    }
  }
  for (const f of await fs.readdir(fx)) if (f.startsWith('news.google.com')) await fs.rm(path.join(fx, f));
  run('update.mjs', { FIXTURE_DIR: fx, FIXTURE_NOW: '2026-10-22T14:50:00.000Z', DIST_DIR: rth.env.DIST_DIR, STATE_DIR: rth.env.STATE_DIR, SAMPLE: '1' });
  const d = JSON.parse(await fs.readFile(path.join(rth.env.DIST_DIR, 'data', 'market.json'), 'utf8'));
  const mbt = d.instruments.find((i) => i.id === 'MBT');
  assert.ok(mbt.stale && mbt.error && Number.isFinite(mbt.price), 'stale fallback');
  assert.ok(d.feeds.some((f) => f.name.startsWith('Google News') && !f.ok), 'feed failures reported');
  checkShape(d, 'failures');
  ok('missing prices fall back to last good data; failing feeds reported');
}

// AI path against a local mock of the Messages API.
{
  let seenBody = null;
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      seenBody = JSON.parse(b);
      const input = JSON.parse(seenBody.messages[0].content);
      const out = {};
      for (const i of input.instruments) {
        const h = i.headlines[0];
        out[i.symbol] = { summary: `Test summary for ${i.symbol}${h ? ` [${h.id}]` : ''}.`, levels: i.levels.slice(0, 2).map((l) => ({ price: l.price, note: 'Test note.' })), bull: 'Up case.', bear: 'Down case.', watch: 'Watch.' };
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ content: [{ type: 'text', text: 'Here you go:\n' + JSON.stringify(out) }] }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const ai = await sample('ai', '2026-10-22T14:40:00Z', { ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` });
  srv.close();
  assert.equal(seenBody.model, 'claude-haiku-5-5');
  const mes = ai.data.instruments.find((i) => i.id === 'MES');
  assert.ok(mes.ai && /Test summary/.test(mes.ai.summary), 'AI merged');
  assert.ok(ai.data.ai.enabled && ai.data.ai.generatedAt);
  ok('AI analysis requested with the right model and merged into output');
}

await fs.rm(tmp, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
