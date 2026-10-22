#!/usr/bin/env node
// One update cycle: prices -> levels -> news -> calendar -> sentiment -> narrative
// -> (optional) AI -> alerts -> dist/data/market.json. Run by GitHub Actions.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTRUMENTS, MACRO, SETTINGS } from './config.mjs';
import { pool, readJSON, writeJSON, globexStatus, hash, decimalsFor } from './lib/util.mjs';
import { loadInstrumentBars, loadMacro } from './lib/market.mjs';
import { analyzeLevels, CATS } from './lib/levels.mjs';
import { fetchAllNews, processNews, newsScore } from './lib/news.mjs';
import { fetchCalendar, processCalendar } from './lib/calendar.mjs';
import { composite } from './lib/sentiment.mjs';
import { buildNarrative } from './lib/narrative.mjs';
import { aiEnabled, shouldRunAi, runAi, buildAiPayload } from './lib/ai.mjs';
import { detectAlerts, mergeAlerts, pushAlerts } from './lib/alerts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = process.env.DIST_DIR || path.join(ROOT, 'dist');
const STATE_DIR = process.env.STATE_DIR || path.join(ROOT, 'state');
const NOW = process.env.FIXTURE_NOW ? Date.parse(process.env.FIXTURE_NOW) : Date.now();

function siteUrl() {
  if (process.env.SITE_URL) return process.env.SITE_URL;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) return null;
  const [owner, name] = repo.split('/');
  return name.toLowerCase() === `${owner.toLowerCase()}.github.io`
    ? `https://${owner.toLowerCase()}.github.io/`
    : `https://${owner.toLowerCase()}.github.io/${name}/`;
}

async function main() {
  const t0 = Date.now();
  const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

  // Copy the static app into dist/ (the workflow deploys dist/ to GitHub Pages).
  await fs.mkdir(DIST, { recursive: true });
  await fs.cp(path.join(ROOT, 'app'), DIST, { recursive: true });

  const state = (await readJSON(path.join(STATE_DIR, 'state.json'), {})) || {};
  const priceReport = process.env.PRICE_CACHE_DIR ? await readJSON(path.join(process.env.PRICE_CACHE_DIR, '_report.json'), null) : null;
  const relayInfo = process.env.PRICE_CACHE_DIR ? await readJSON(path.join(process.env.PRICE_CACHE_DIR, '_relay.json'), null) : null;
  const prev = await readJSON(path.join(STATE_DIR, 'last.json'), null);

  // ---- fetch everything in parallel ----
  const [instData, macroArr, newsRaw, cal] = await Promise.all([
    pool(INSTRUMENTS, 2, async (inst) => {
      try { return { inst, data: await loadInstrumentBars(inst) }; }
      catch (e) { return { inst, error: String(e.message || e) }; }
    }),
    pool(MACRO, 3, async (m) => {
      try { return await loadMacro(m); } catch (e) { return { id: m.id, name: m.name, error: String(e.message || e) }; }
    }),
    fetchAllNews(),
    (async () => {
      const fresh = state.calendar && NOW - state.calendar.fetchedAt < 55 * 60e3;
      if (fresh) return { raw: state.calendar.raw, errors: [], cached: true };
      const r = await fetchCalendar();
      if (r.raw.length) state.calendar = { fetchedAt: NOW, raw: r.raw };
      return { raw: r.raw.length ? r.raw : state.calendar?.raw || [], errors: r.errors, cached: !r.raw.length };
    })(),
  ]);
  log(`prices ok ${instData.filter((x) => x.data).length}/${INSTRUMENTS.length}, macro ok ${macroArr.filter((m) => !m.error).length}/${MACRO.length}, news items ${newsRaw.items.length}`);

  const macro = Object.fromEntries(macroArr.filter((m) => !m.error).map((m) => [m.id, m]));
  const news = processNews(newsRaw.items, INSTRUMENTS, NOW, state.seen || {});
  const calendar = processCalendar(cal.raw, NOW);

  // ---- per instrument ----
  const instruments = [];
  for (const { inst, data, error } of instData) {
    if (!data) {
      const p = prev?.instruments?.find((i) => i.id === inst.id);
      instruments.push(p ? { ...p, stale: true, error } : { id: inst.id, name: inst.name, group: inst.group, error });
      continue;
    }
    try {
      const lv = analyzeLevels(inst, data, NOW);
      const nres = newsScore(news, inst.id, NOW);
      const sent = composite(inst, lv.stats, news, nres, macro);
      const events = calendar.filter((e) => e.instruments.includes(inst.id));
      const narrative = buildNarrative(inst, lv, sent, events, news);
      const half = SETTINGS.newsHalfLifeHours * 60;
      const headlineIds = news
        .filter((n) => n.effects[inst.id] || n.relevant.includes(inst.id))
        .map((n) => ({ id: n.id, s: (Math.abs(n.effects[inst.id] || 0) + 0.4) * Math.pow(0.5, n.ageMin / half) * (n.impact === 'high' ? 1.5 : 1) }))
        .sort((a, b) => b.s - a.s).slice(0, 12).map((x) => x.id);
      const meta = data.meta || {};
      instruments.push({
        id: inst.id, name: inst.name, group: inst.group, dataSymbol: data.symbol, source: data.source, intraday: data.intraday,
        tick: inst.tick, decimals: lv.stats.dec || decimalsFor(inst.tick), pointValue: inst.pointValue,
        price: lv.stats.price, prevClose: lv.stats.pdc, change: lv.stats.change, changePct: lv.stats.changePct,
        asOf: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
        atr: lv.stats.atr, rangeUsed: lv.stats.rangeUsed, live: lv.stats.live,
        session: {
          open: lv.stats.sessionOpen, dayOpen: lv.stats.dayOpen, high: lv.stats.hod, low: lv.stats.lod,
          vwap: lv.stats.vwap, pdh: lv.stats.pdh, pdl: lv.stats.pdl, pdc: lv.stats.pdc,
          onh: lv.stats.onh, onl: lv.stats.onl, pivot: lv.stats.pivot,
        },
        sentiment: sent,
        levels: lv.levels,
        nearest: {
          support: lv.nearest.support && { price: lv.nearest.support.price, codes: lv.nearest.support.codes },
          resistance: lv.nearest.resistance && { price: lv.nearest.resistance.price, codes: lv.nearest.resistance.codes },
        },
        narrative,
        headlineIds,
        eventIds: events.filter((e) => e.minutesAway > -60).slice(0, 8).map((e) => e.id),
        spark: lv.spark,
      });
    } catch (e) {
      console.error(inst.id, e);
      instruments.push({ id: inst.id, name: inst.name, group: inst.group, error: String(e.message || e) });
    }
  }

  // ---- optional AI analysis ----
  const ok = instruments.filter((i) => !i.error && !i.stale);
  const signature = hash(ok.map((i) => i.id + i.sentiment.label).join() + news.filter((n) => n.impact === 'high').slice(0, 5).map((n) => n.id).join());
  let aiError = null;
  if (ok.length && shouldRunAi(state, NOW, signature)) {
    try {
      const data = await runAi(buildAiPayload(ok, news, calendar, macro));
      state.ai = { generatedAt: new Date(NOW).toISOString(), signature, model: SETTINGS.aiModel, data };
      log('AI analysis refreshed');
    } catch (e) { aiError = String(e.message || e); log('AI error:', aiError); }
  }
  const aiFresh = state.ai && NOW - Date.parse(state.ai.generatedAt) < 3 * 3600e3;
  if (aiFresh) for (const i of ok) if (state.ai.data?.[i.id]) i.ai = state.ai.data[i.id];

  // ---- assemble ----
  const out = {
    version: 1,
    generatedAt: new Date(NOW).toISOString(),
    sample: !!process.env.SAMPLE,
    market: globexStatus(NOW),
    priceSource: 'Yahoo Finance chart data (CME quotes there may be delayed)',
    repo: process.env.GITHUB_REPOSITORY || null,
    ref: process.env.GITHUB_REF_NAME || 'main',
    siteUrl: siteUrl(),
    categories: CATS,
    macro: MACRO.map((m) => macro[m.id] || { id: m.id, name: m.name, error: true }),
    instruments,
    news: news.map(({ weight, ...n }) => n),
    calendar,
    alerts: [],
    feeds: [
      ...newsRaw.health,
      { name: 'Economic calendar (Forex Factory)', ok: cal.raw.length > 0, count: cal.raw.length, error: cal.errors.join('; ') || undefined, cached: cal.cached },
      ...instData.map(({ inst, data, error }) => ({ name: `Prices: ${inst.id}${data ? ` (${data.symbol}, ${data.source})` : ''}`, ok: !!data, count: data ? data.m5.length || data.daily.length : 0, error })),
      ...(priceReport ? [{ name: `Browser-style price fetch from GitHub (${priceReport.mode})`, ok: priceReport.ok > 0, count: priceReport.ok,
        error: priceReport.failed ? `Yahoo: ${priceReport.yahoo?.blocked ? 'refusing GitHub' : 'some failed'} (${priceReport.yahoo?.lastError || priceReport.lastError || ''})${priceReport.stooq?.tried ? `; Stooq: ${priceReport.stooq.blocked ? 'refusing GitHub' : 'tried'} (${priceReport.stooq.lastError || 'ok'})` : ''}` : undefined }] : []),
      { name: 'Price relay (your computer)', ok: !!relayInfo?.used, count: relayInfo?.files || 0,
        error: !relayInfo ? 'not set up (optional; see README)' : relayInfo.used ? undefined : `last bundle ${relayInfo.ageMin} min old (computer off or relay stopped)` },
    ],
    relay: relayInfo ? { at: relayInfo.at, used: relayInfo.used, ageMin: relayInfo.ageMin } : null,
    ai: {
      enabled: aiEnabled(), model: aiEnabled() ? SETTINGS.aiModel : null,
      generatedAt: aiFresh ? state.ai.generatedAt : null, error: aiError,
    },
  };

  const fresh = detectAlerts(prev, out, NOW);
  const merged = mergeAlerts(state.alerts, fresh);
  out.alerts = merged.all;
  state.alerts = merged.all;
  const pushed = await pushAlerts(prev ? merged.added : [], out.siteUrl);

  // ---- persist ----
  const seen = { ...(state.seen || {}) };
  for (const n of news) seen[n.id] = seen[n.id] || n.firstSeen;
  for (const [k, v] of Object.entries(seen)) if (NOW - Date.parse(v) > 48 * 3600e3) delete seen[k];
  state.seen = seen;
  await writeJSON(path.join(DIST, 'data', 'market.json'), out);
  await writeJSON(path.join(STATE_DIR, 'state.json'), state);
  await writeJSON(path.join(STATE_DIR, 'last.json'), {
    generatedAt: out.generatedAt,
    instruments: instruments.filter((i) => !i.error).map((i) => i),
  });

  const summary = [
    `Updated ${out.generatedAt} — ${out.market.label}`,
    ...instruments.map((i) => i.error ? `- ${i.id}: ERROR ${i.error}` : `- ${i.id} ${i.price} ${i.sentiment.label} (${i.sentiment.score}) · ${i.levels.length} levels${i.stale ? ' (stale)' : ''}`),
    `News stories: ${news.length} (${news.filter((n) => n.kind === 'breaking').length} breaking) · events: ${calendar.length} · new alerts: ${merged.added.length} · pushed: ${pushed.sent}`,
    `Feeds failing: ${out.feeds.filter((f) => !f.ok).map((f) => f.name).join(', ') || 'none'}`,
  ].join('\n');
  log('\n' + summary);
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, '```\n' + summary + '\n```\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
