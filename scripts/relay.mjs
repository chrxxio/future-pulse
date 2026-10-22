#!/usr/bin/env node
// Price relay: runs on YOUR computer, where Yahoo serves price data normally (it
// refuses many requests from GitHub's servers). Every few minutes it fetches the
// price history the app needs, uploads it to the repo's `price-relay` branch, and
// starts an update so the site refreshes right away.
//
//   node scripts/relay.mjs            one upload, then exit (for a scheduled task / cron)
//   node scripts/relay.mjs --watch    keep running, upload every 5 minutes
//   node scripts/relay.mjs --unpack bundle.json.gz out_dir    (used by the workflow)
//
// Settings, first found wins: env vars, then ~/.futures-pulse-relay.json (your home folder —
// recommended, it can never end up in the repo), then relay.config.json in the repo folder:
//   { "repo": "owner/name", "token": "github_pat_...", "trigger": true, "minutes": 5 }
//   FP_RELAY_REPO, FP_RELAY_TOKEN, FP_RELAY_TRIGGER=0, FP_RELAY_MINUTES
// The token: a fine-grained GitHub token for this one repository with
// "Contents: Read and write" and "Actions: Read and write".
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { INSTRUMENTS, MACRO } from './config.mjs';
import { fetchText, sleep, globexStatus } from './lib/util.mjs';
import { chartUrl, cacheKey } from './lib/market.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRANCH = 'price-relay';
const FILE = 'bundle.json.gz';
const MAX_AGE_MIN = 30; // the workflow ignores bundles older than this
const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];

// ---------------------------------------------------------------- unpack (workflow side)
async function unpack(bundlePath, outDir) {
  const b = JSON.parse(zlib.gunzipSync(await fs.readFile(bundlePath)).toString('utf8'));
  const at = Date.parse(b.at);
  const ageMin = (Date.now() - at) / 60e3;
  await fs.mkdir(outDir, { recursive: true });
  const info = { at: b.at, kind: b.kind, files: Object.keys(b.files || {}).length, ageMin: Math.round(ageMin), used: false };
  if (!(ageMin >= -5 && ageMin <= MAX_AGE_MIN)) {
    await fs.writeFile(path.join(outDir, '_relay.json'), JSON.stringify(info));
    console.log(`[relay] bundle is ${Math.round(ageMin)} min old — not used`);
    return;
  }
  const originFile = path.join(outDir, '_origin.json');
  const origin = await fs.readFile(originFile, 'utf8').then(JSON.parse).catch(() => ({}));
  for (const [name, text] of Object.entries(b.files)) {
    if (!/^[A-Za-z0-9._=-]+\.json$/.test(name)) continue; // only plain cache file names
    const f = path.join(outDir, name);
    await fs.writeFile(f, text);
    await fs.utimes(f, new Date(at), new Date(at)); // freshness = when your computer fetched it
    origin[name] = 'your computer (relay)';
  }
  info.used = true;
  await fs.writeFile(originFile, JSON.stringify(origin));
  await fs.writeFile(path.join(outDir, '_relay.json'), JSON.stringify(info));
  console.log(`[relay] used ${info.files} files from ${b.at} (${b.kind})`);
}

// ---------------------------------------------------------------- relay (your computer)
async function config() {
  const read = (f) => fs.readFile(f, 'utf8').then(JSON.parse).catch(() => null);
  const file = (await read(path.join(os.homedir(), '.futures-pulse-relay.json'))) || (await read(path.join(ROOT, 'relay.config.json'))) || {};
  const c = {
    repo: process.env.FP_RELAY_REPO || file.repo,
    token: process.env.FP_RELAY_TOKEN || file.token,
    trigger: process.env.FP_RELAY_TRIGGER ? process.env.FP_RELAY_TRIGGER !== '0' : file.trigger !== false,
    minutes: Number(process.env.FP_RELAY_MINUTES || file.minutes || 5),
    api: process.env.FP_RELAY_API || 'https://api.github.com',
  };
  if (!c.repo || !/^[\w.-]+\/[\w.-]+$/.test(c.repo) || !c.token) {
    throw new Error(`Set "repo" and "token" in ${path.join(os.homedir(), '.futures-pulse-relay.json')} (see the README, "Price relay").`);
  }
  return c;
}

async function gh(c, method, route, body) {
  const res = await fetch(`${c.api}/repos/${c.repo}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${c.token}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let j = {};
  try { j = text ? JSON.parse(text) : {}; } catch { /* non-JSON */ }
  return { status: res.status, ok: res.ok, j };
}

async function fetchSeries(symbol, range, interval) {
  let last;
  for (const host of HOSTS) {
    try {
      const text = await fetchText(chartUrl(host, symbol, range, interval), { timeout: 20000, retries: 1 });
      if (JSON.parse(text)?.chart?.result?.[0]) return text;
      last = new Error('empty chart');
    } catch (e) { last = e; }
  }
  throw last;
}

async function collect(full) {
  const files = {};
  const errors = [];
  const series = full ? [['1y', '1d'], ['3mo', '60m'], ['5d', '5m']] : [['5d', '5m']];
  for (const inst of INSTRUMENTS) {
    for (const symbol of inst.yahoo) {
      try {
        for (const [r, i] of series) { files[cacheKey(symbol, r, i)] = await fetchSeries(symbol, r, i); await sleep(250); }
        break; // got this market
      } catch (e) { errors.push(`${inst.id} ${symbol}: ${e.message}`); }
    }
  }
  for (const m of MACRO) {
    try { files[cacheKey(m.yahoo, '1mo', '1d')] = await fetchSeries(m.yahoo, '1mo', '1d'); await sleep(250); }
    catch (e) { errors.push(`${m.id}: ${e.message}`); }
  }
  return { files, errors };
}

async function upload(c, bundle) {
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(bundle)), { level: 9 });
  const blob = await gh(c, 'POST', '/git/blobs', { content: gz.toString('base64'), encoding: 'base64' });
  if (!blob.ok) throw new Error(`GitHub refused the upload (${blob.status}: ${blob.j.message || 'blob'}). Check the token has Contents: Read and write.`);
  const tree = await gh(c, 'POST', '/git/trees', { tree: [{ path: FILE, mode: '100644', type: 'blob', sha: blob.j.sha }] });
  if (!tree.ok) throw new Error(`tree ${tree.status}: ${tree.j.message}`);
  // a single commit with no parents, force-moved each time, so the branch never grows
  const commit = await gh(c, 'POST', '/git/commits', { message: `prices ${bundle.at}`, tree: tree.j.sha, parents: [] });
  if (!commit.ok) throw new Error(`commit ${commit.status}: ${commit.j.message}`);
  let ref = await gh(c, 'PATCH', `/git/refs/heads/${BRANCH}`, { sha: commit.j.sha, force: true });
  if (!ref.ok) ref = await gh(c, 'POST', '/git/refs', { ref: `refs/heads/${BRANCH}`, sha: commit.j.sha });
  if (!ref.ok) throw new Error(`branch ${ref.status}: ${ref.j.message}`);
  return gz.length;
}

async function runOnce(c, state) {
  const now = Date.now();
  const mkt = globexStatus(now);
  if (!mkt.open && state.last && now - state.last < 60 * 60e3) {
    console.log(`[relay] ${new Date().toLocaleTimeString()} market closed (${mkt.label}); next check within the hour`);
    return;
  }
  const full = !state.lastFull || now - state.lastFull > 30 * 60e3;
  const { files, errors } = await collect(full);
  const count = Object.keys(files).length;
  if (!count) throw new Error(`no price data fetched: ${errors.slice(0, 3).join('; ')}`);
  const bytes = await upload(c, { at: new Date(now).toISOString(), kind: full ? 'full' : 'recent', files });
  state.last = now; if (full) state.lastFull = now;
  let trig = '';
  if (c.trigger) {
    const t = await gh(c, 'POST', '/actions/workflows/update.yml/dispatches', { ref: 'main' });
    trig = t.status === 204 ? ', update started' : ` (could not start the update: ${t.status} ${t.j.message || ''}; it will pick the prices up on its next run)`;
  }
  console.log(`[relay] ${new Date().toLocaleTimeString()} sent ${count} series (${full ? 'full history' : 'latest bars'}, ${Math.round(bytes / 1024)} KB)${trig}${errors.length ? `; skipped: ${errors.join('; ')}` : ''}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--unpack') return unpack(args[1], args[2]);
  const c = await config();
  const stateFile = path.join(os.homedir(), '.futures-pulse-relay-state.json');
  const state = await fs.readFile(stateFile, 'utf8').then(JSON.parse).catch(() => ({}));
  const save = () => fs.writeFile(stateFile, JSON.stringify(state)).catch(() => {});
  if (!args.includes('--watch')) { await runOnce(c, state); await save(); return; }
  console.log(`[relay] sending prices to ${c.repo} every ${c.minutes} min. Leave this running while you trade; Ctrl+C stops it.`);
  for (;;) {
    try { await runOnce(c, state); await save(); }
    catch (e) { console.error(`[relay] ${new Date().toLocaleTimeString()} ${e.message}`); }
    await sleep(c.minutes * 60e3);
  }
}

main().catch((e) => { console.error(`[relay] ${e.message}`); process.exit(1); });
