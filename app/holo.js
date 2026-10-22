// Desktop "light-string globe": every tracked thing is a warm, old-school bulb.
//   Planets on orbit strings  = markets (green bullish, red bearish, amber neutral; size = conviction)
//   Moons above/below a planet = its key levels (red = resistance overhead, green = support below)
//   Fairy lights on the globe  = headlines, grouped by region (blinking = breaking)
//   Beams                       = which markets a headline moves
//   Outer light string          = scheduled releases on a 24-hour clock (blue = high impact)
(() => {
'use strict';
const FP = window.FP;
const cv = document.getElementById('holo');
if (!FP || !cv) return;
const ctx = cv.getContext('2d');
const glow = document.createElement('canvas');
const gctx = glow.getContext('2d');
const tip = document.getElementById('holoTip');
const ui = document.getElementById('holoUi');
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const TAU = Math.PI * 2;

// ---------- palette: incandescent bulbs on a winter night ----------
const C = {
  green: [76, 222, 128], red: [255, 74, 56], amber: [255, 168, 64], blue: [86, 150, 255],
  warm: [255, 214, 158], wire: [255, 186, 118], gold: [255, 196, 92], cream: [255, 236, 206],
};
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0, Math.min(1, a))})`;
const sentCol = (s) => (s >= 15 ? C.green : s <= -15 ? C.red : C.amber);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const hashN = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967295; };

// ---------- camera ----------
const cam = { yaw: 0.55, pitch: 0.42, zoom: 1, vyaw: 0, vpitch: 0 };
const D = 8;
let W = 0, H = 0, DPR = 1, cx = 0, cy = 0, tcx = 0, F = 0;
let cyw = 1, syw = 0, cpt = 1, spt = 0;
let enabled = false, raf = 0, last = 0, T = 0, spin = 0, lastInteract = -1e9, dirty = true;
// adaptive quality: 2 = bloom every frame, 1 = bloom refreshed every 3rd frame, 0 = no bloom + lower resolution
let quality = 2, frameNo = 0, costAvg = 0;

function resize() {
  DPR = Math.min(quality === 0 ? 1.25 : 2, window.devicePixelRatio || 1);
  W = window.innerWidth; H = window.innerHeight;
  cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
  cv.style.width = W + 'px'; cv.style.height = H + 'px';
  glow.width = Math.max(1, Math.round(W / 4)); glow.height = Math.max(1, Math.round(H / 4));
  makeStars();
  dirty = true;
}
function layoutTarget() {
  const left = FP.panelRight();
  const right = FP.sheetOpen() ? 472 : 0;
  const avail = Math.max(320, Math.min(W - left - right - 40, H - 120));
  tcx = left + (W - left - right) / 2;
  cy = H * 0.5 - 10;
  F = avail * 0.19 * D * cam.zoom;
}
function setCam() { cyw = Math.cos(cam.yaw); syw = Math.sin(cam.yaw); cpt = Math.cos(cam.pitch); spt = Math.sin(cam.pitch); }
function view(p) {
  const x = p[0] * cyw + p[2] * syw, z0 = -p[0] * syw + p[2] * cyw, y = p[1];
  return [x, y * cpt - z0 * spt, y * spt + z0 * cpt];
}
function proj(p) {
  const q = view(p);
  const s = F / (D - q[2]);
  return { x: cx + q[0] * s, y: cy - q[1] * s, z: q[2], k: (s * D) / F };
}
const rotY = (p, a) => { const c = Math.cos(a), s = Math.sin(a); return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c]; };
const rotX = (p, a) => { const c = Math.cos(a), s = Math.sin(a); return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c]; };
const depthA = (z) => 0.38 + 0.62 * clamp((z + 3) / 6, 0, 1);

// ---------- static geometry ----------
const FAIRY = [];
for (let i = 0, N = 520; i < N; i++) {
  const y = 1 - (i / (N - 1)) * 2, r = Math.sqrt(1 - y * y), th = i * 2.399963;
  FAIRY.push({ p: [Math.cos(th) * r, y, Math.sin(th) * r], ph: hashN('f' + i) * TAU, sp: 0.6 + hashN('s' + i) * 1.6 });
}
const LINES = [];
for (const lat of [-60, -30, 0, 30, 60]) {
  const a = (lat * Math.PI) / 180, pts = [];
  for (let k = 0; k <= 96; k++) { const t = (k / 96) * TAU; pts.push([Math.cos(a) * Math.cos(t), Math.sin(a), Math.cos(a) * Math.sin(t)]); }
  LINES.push({ pts, eq: lat === 0 });
}
for (let lon = 0; lon < 180; lon += 30) {
  const b = (lon * Math.PI) / 180, pts = [];
  for (let k = 0; k <= 96; k++) { const t = (k / 96) * TAU; pts.push([Math.cos(t) * Math.cos(b), Math.sin(t), Math.cos(t) * Math.sin(b)]); }
  LINES.push({ pts });
}
const REGIONS = {
  equity: { name: 'Equities', lat: 20, lon: 15 },
  macro: { name: 'Fed, rates & data', lat: -14, lon: 85 },
  oil: { name: 'Energy', lat: 24, lon: 160 },
  geo: { name: 'Geopolitics & trade', lat: -24, lon: 225 },
  metal: { name: 'Metals', lat: 30, lon: 290 },
  crypto: { name: 'Crypto', lat: -32, lon: 335 },
};
const ll = (lat, lon, r = 1) => { const a = (lat * Math.PI) / 180, b = (lon * Math.PI) / 180; return [Math.cos(a) * Math.cos(b) * r, Math.sin(a) * r, Math.cos(a) * Math.sin(b) * r]; };

const RINGS = [
  { r: 1.48, tilt: 0.2, node: 0.0, speed: 0.035, phase: 0, groups: ['equity'] },
  { r: 1.82, tilt: -0.34, node: 1.2, speed: 0.027, phase: 0.8, groups: ['gold', 'silver'] },
  { r: 2.16, tilt: 0.46, node: 2.4, speed: 0.021, phase: 2.4, groups: ['oil', 'crypto'] },
];
const CAL_R = 2.55;
const ringPt = (ring, th) => rotY(rotX([ring.r * Math.cos(th), 0, ring.r * Math.sin(th)], ring.tilt), ring.node);
const calPt = (th) => [CAL_R * Math.cos(th), 0, CAL_R * Math.sin(th)];
const NOW_TH = Math.PI / 2;

// ---------- scene from data ----------
let scene = { planets: [], news: [], events: [], beams: [], meanScore: 0 };
let selected = null, hover = null, hits = [];
const layers = Object.assign({ markets: true, levels: true, news: true, beams: true, calendar: true }, FP.store.get('holoLayers', {}));

function regionOf(n) {
  const r = (n.rules || []).join(' ');
  if (/Geopolitical|De-escalation|Trade|Oil supply risk/.test(r)) return 'geo';
  if (/Fed|inflation|jobs|labor|yields|dollar|Fiscal|Stimulus|Growth|Financial stress|Risk/.test(r)) return 'macro';
  const e = n.effects || {};
  const top = Object.entries(e).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0]?.[0] || (n.relevant || [])[0];
  if (top === 'MCL') return 'oil';
  if (top === 'MGC' || top === 'SIL') return 'metal';
  if (top === 'MBT') return 'crypto';
  return top ? 'equity' : 'macro';
}

function setData(d) {
  if (!d) return;
  const insts = d.instruments.filter((i) => Number.isFinite(i.price));
  const planets = [];
  RINGS.forEach((ring, ri) => {
    const members = insts.filter((i) => ring.groups.includes(i.group) || (ri === 2 && !RINGS.some((r) => r.groups.includes(i.group))));
    members.forEach((i, k) => {
      const s = i.sentiment?.score || 0;
      const recentAlert = (d.alerts || []).some((a) => a.instrument === i.id && Date.now() - Date.parse(a.time) < 30 * 60e3);
      const breaking = (d.news || []).some((n) => n.kind === 'breaking' && Math.abs(n.effects?.[i.id] || 0) >= 1);
      planets.push({
        id: i.id, inst: i, ring, th0: (k / members.length) * TAU + ring.phase, score: s, color: sentCol(s),
        size: 6.5 + Math.min(100, Math.abs(s)) / 10,
        levels: (i.levels || []).filter((l) => l.strength >= 3 && Math.abs(l.distAtr) <= 1.5),
        pulse: recentAlert || breaking,
      });
    });
  });
  const news = (d.news || []).filter((n) => n.ageMin < 36 * 60).slice(0, 180).map((n) => {
    const reg = REGIONS[regionOf(n)];
    const net = Object.values(n.effects || {}).reduce((a, b) => a + b, 0);
    const u = hashN(n.id), v = hashN(n.id + 'v');
    return {
      n, reg, p: ll(reg.lat + (u - 0.5) * 30, reg.lon + (v - 0.5) * 46, 1.012),
      color: net > 0.3 ? C.green : net < -0.3 ? C.red : C.warm,
      size: n.impact === 'high' ? 3.4 : n.impact === 'med' ? 2.5 : 1.8,
      fresh: Math.exp(-n.ageMin / 720), breaking: n.kind === 'breaking', ph: u * TAU,
    };
  });
  const byId = Object.fromEntries(planets.map((p) => [p.id, p]));
  const beams = [];
  for (const o of news.filter((x) => x.n.impact === 'high' || x.breaking).slice(0, 26)) {
    Object.entries(o.n.effects || {}).filter(([, v]) => Math.abs(v) >= 1)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 3)
      .forEach(([id, v], k) => { if (byId[id]) beams.push({ from: o, to: byId[id], color: v > 0 ? C.green : C.red, ph: hashN(o.n.id + id) + k * 0.3, strong: o.breaking }); });
  }
  const events = (d.calendar || []).filter((e) => e.minutesAway > -180 && e.minutesAway < 24 * 60).map((e) => ({
    e, th: NOW_TH - (e.minutesAway / 1440) * TAU, high: e.impact === 'High', past: e.minutesAway < 0,
  }));
  const scores = planets.map((p) => p.score);
  scene = { planets, news, events, beams, meanScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0 };
  ticker(d);
  dirty = true;
}

// ---------- background ----------
let starCanvas = null;
function makeStars() {
  starCanvas = document.createElement('canvas');
  starCanvas.width = Math.round(W * DPR); starCanvas.height = Math.round(H * DPR);
  const s = starCanvas.getContext('2d'); // stars only; the night-sky gradient is the canvas's CSS background
  for (let i = 0; i < 340; i++) {
    const x = hashN('x' + i) * starCanvas.width, y = hashN('y' + i) * starCanvas.height, r = (0.3 + hashN('r' + i) * 1.1) * DPR;
    s.fillStyle = `rgba(214,226,255,${0.15 + hashN('a' + i) * 0.5})`;
    s.beginPath(); s.arc(x, y, r, 0, TAU); s.fill();
  }
}

// ---------- bulbs ----------
// Glows and glass are pre-rendered once per color and stamped with drawImage (fast).
const SPR = new Map();
function sprite(kind, c) {
  const key = kind + c.join(',');
  let s = SPR.get(key);
  if (s) return s;
  s = document.createElement('canvas'); s.width = s.height = 128;
  const g2 = s.getContext('2d');
  const g = kind === 'halo'
    ? g2.createRadialGradient(64, 64, 0, 64, 64, 64)
    : g2.createRadialGradient(52, 52, 0, 64, 64, 64);
  if (kind === 'halo') { g.addColorStop(0, rgba(c, 0.62)); g.addColorStop(0.22, rgba(c, 0.26)); g.addColorStop(0.55, rgba(c, 0.07)); g.addColorStop(1, rgba(c, 0)); }
  else { g.addColorStop(0, 'rgba(255,250,235,1)'); g.addColorStop(0.45, rgba(c, 1)); g.addColorStop(0.98, rgba(c.map((v) => v * 0.55), 1)); g.addColorStop(1, rgba(c, 0)); }
  g2.fillStyle = g; g2.fillRect(0, 0, 128, 128);
  SPR.set(key, s);
  return s;
}
function halo(x, y, r, c, a) {
  if (a <= 0.01 || r < 0.5) return;
  ctx.globalAlpha = Math.min(1, a); ctx.drawImage(sprite('halo', c), x - r, y - r, r * 2, r * 2); ctx.globalAlpha = 1;
}
function miniBulb(x, y, r, c, a) {
  if (a <= 0.01) return;
  halo(x, y, r * 4.2, c, a);
  ctx.globalAlpha = Math.min(1, a); ctx.drawImage(sprite('glass', c), x - r, y - r, r * 2, r * 2); ctx.globalAlpha = 1;
}
// Old-school C9 bulb: glass teardrop on a ribbed socket, pointing along `ang` (0 = up).
function c9(x, y, r, c, a, ang = 0, lit = 1) {
  halo(x, y - Math.cos(ang) * r * 0.6, r * 6.5, c, a * lit);
  ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
  // socket
  ctx.fillStyle = `rgba(28,52,34,${0.95 * a})`;
  ctx.beginPath(); ctx.roundRect ? ctx.roundRect(-r * 0.58, r * 0.72, r * 1.16, r * 0.95, r * 0.18) : ctx.rect(-r * 0.58, r * 0.72, r * 1.16, r * 0.95); ctx.fill();
  ctx.strokeStyle = `rgba(90,130,96,${0.55 * a})`; ctx.lineWidth = Math.max(0.6, r * 0.09);
  for (let k = 1; k <= 3; k++) { const yy = r * 0.72 + (k * r * 0.95) / 4; ctx.beginPath(); ctx.moveTo(-r * 0.5, yy); ctx.lineTo(r * 0.5, yy); ctx.stroke(); }
  // glass
  ctx.beginPath();
  ctx.moveTo(0, -r * 2.05);
  ctx.bezierCurveTo(r * 0.72, -r * 1.45, r * 1.05, -r * 0.45, r * 0.98, r * 0.1);
  ctx.arc(0, r * 0.1, r * 0.98, 0, Math.PI);
  ctx.bezierCurveTo(-r * 1.05, -r * 0.45, -r * 0.72, -r * 1.45, 0, -r * 2.05);
  const g = ctx.createRadialGradient(-r * 0.2, -r * 0.6, r * 0.1, 0, -r * 0.3, r * 2.1);
  const hot = lit > 0.5 ? [255, 248, 228] : c;
  g.addColorStop(0, rgba(hot, a)); g.addColorStop(0.35, rgba(c, a * (0.6 + 0.4 * lit))); g.addColorStop(1, rgba(c.map((v) => v * 0.45), a));
  ctx.fillStyle = g; ctx.fill();
  // glint
  ctx.fillStyle = `rgba(255,255,255,${0.55 * a * lit})`;
  ctx.beginPath(); ctx.ellipse(-r * 0.38, -r * 0.95, r * 0.14, r * 0.42, -0.35, 0, TAU); ctx.fill();
  ctx.restore();
}

// ---------- drawing ----------
function strokePath(pts, color, width, dash) {
  ctx.strokeStyle = color; ctx.lineWidth = width;
  if (dash) ctx.setLineDash(dash);
  ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.stroke();
  if (dash) ctx.setLineDash([]);
}
function drawWireCircle(fn, n, alphaFront, alphaBack, width) {
  // split into front/back runs so the far side reads dimmer
  let run = [], front = null;
  const flush = () => { if (run.length > 1) strokePath(run, rgba(C.wire, front ? alphaFront : alphaBack), width); };
  for (let k = 0; k <= n; k++) {
    const P = proj(fn((k / n) * TAU));
    const f = P.z >= 0;
    if (front === null) front = f;
    if (f !== front) { run.push(P); flush(); run = [P]; front = f; } else run.push(P);
  }
  flush();
}

function draw() {
  setCam();
  cx += (tcx - cx) * 0.12;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (starCanvas) ctx.drawImage(starCanvas, 0, 0);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  hits = [];
  const g0 = (p) => rotY(p, spin);

  // warm core
  const coreC = scene.meanScore >= 15 ? C.green : scene.meanScore <= -15 ? C.red : C.amber;
  const R0 = F / D;
  halo(cx, cy, R0 * 0.95, coreC, 0.28 + (reduce ? 0 : 0.05 * Math.sin(T * 1.3)));

  // globe wires
  for (const L of LINES) {
    const pts = L.pts.map((p) => proj(g0(p)));
    let run = [], fr = null;
    const flush = () => { if (run.length > 1) strokePath(run, rgba(C.wire, fr ? (L.eq ? 0.32 : 0.17) : 0.055), L.eq ? 1.2 : 0.9); };
    for (const P of pts) { const f = P.z >= 0; if (fr === null) fr = f; if (f !== fr) { run.push(P); flush(); run = [P]; fr = f; } else run.push(P); }
    flush();
  }
  // scanning latitude
  if (!reduce) {
    const lat = Math.sin(T * 0.35) * 1.15;
    const pts = [];
    for (let k = 0; k <= 96; k++) { const t = (k / 96) * TAU; pts.push(proj(g0([Math.cos(lat) * Math.cos(t), Math.sin(lat), Math.cos(lat) * Math.sin(t)]))); }
    strokePath(pts, rgba(C.gold, 0.16), 2.2);
  }

  // orbit strings + calendar string
  if (layers.markets) for (const ring of RINGS) drawWireCircle((t) => ringPt(ring, t), 120, 0.2, 0.07, 1.1);
  if (layers.calendar) drawWireCircle(calPt, 160, 0.24, 0.08, 1.2);

  ctx.globalCompositeOperation = 'lighter';
  // fairy lights (globe texture)
  for (const f of FAIRY) {
    const P = proj(g0(f.p));
    const tw = reduce ? 0.8 : 0.55 + 0.45 * Math.sin(T * f.sp + f.ph);
    const a = (P.z >= 0 ? 0.5 : 0.12) * tw;
    ctx.fillStyle = rgba(C.warm, a);
    const s = (P.z >= 0 ? 1.3 : 0.9) * P.k;
    ctx.fillRect(P.x - s / 2, P.y - s / 2, s, s);
  }

  // collect depth-sorted objects
  const objs = [];
  if (layers.news) for (const o of scene.news) {
    const P = proj(g0(o.p)); o.P = P;
    objs.push({ z: P.z, fn: () => drawNews(o, P) });
  }
  if (layers.markets) for (const pl of scene.planets) {
    const th = pl.th0 + (reduce ? 0 : T * pl.ring.speed);
    pl.th = th; pl.w = ringPt(pl.ring, th);
    const P = proj(pl.w); pl.P = P;
    objs.push({ z: P.z, fn: () => drawPlanet(pl, P) });
  }
  if (layers.calendar) {
    for (const ev of scene.events) { const P = proj(calPt(ev.th)); ev.P = P; objs.push({ z: P.z, fn: () => drawEvent(ev, P) }); }
  }
  // beams (under bulbs)
  if (layers.beams && layers.news && layers.markets) for (const b of scene.beams) drawBeam(b, g0);
  objs.sort((a, b) => a.z - b.z).forEach((o) => o.fn());
  if (layers.calendar) drawClock();

  // bloom: downsample + additive upscale (refreshed less often on slower machines)
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (!window.__noBloom && quality > 0) {
  if (quality === 2 || frameNo % 3 === 0) {
    gctx.globalCompositeOperation = 'copy';
    gctx.imageSmoothingQuality = 'high';
    gctx.drawImage(cv, 0, 0, glow.width, glow.height);
  }
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.55; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(glow, 0, 0, cv.width, cv.height);
  ctx.globalAlpha = 1;
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

  // crisp labels last
  if (layers.news) drawRegionLabels(g0);
  if (layers.markets) for (const pl of scene.planets) labelPlanet(pl);
  if (layers.calendar) for (const ev of scene.events) labelEvent(ev);
}

function drawNews(o, P) {
  const back = P.z < 0;
  let a = (back ? 0.22 : 1) * (0.35 + 0.65 * o.fresh);
  if (o.breaking && !reduce) a *= Math.sin(T * 5 + o.ph) > -0.2 ? 1 : 0.18; // old chaser blink
  const r = o.size * P.k * (hover?.ref === o ? 1.5 : 1);
  miniBulb(P.x, P.y, r, o.color, a);
  if (o.breaking && !back && !reduce) {
    const u = (T * 0.7 + o.ph) % 1;
    ctx.strokeStyle = rgba(C.gold, 0.5 * (1 - u)); ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(P.x, P.y, r + u * 18, 0, TAU); ctx.stroke();
  }
  if (!back) hits.push({ x: P.x, y: P.y, r: Math.max(6, r * 2), z: P.z, type: 'news', ref: o });
}

function drawPlanet(pl, P) {
  const a = depthA(P.z);
  const r = pl.size * P.k * 0.82;
  const isSel = selected === pl.id, isHov = hover?.ref === pl;
  // comet trail along the orbit string
  if (!reduce) for (let k = 1; k <= 14; k++) {
    const Q = proj(ringPt(pl.ring, pl.th - k * 0.022));
    ctx.fillStyle = rgba(pl.color, (0.32 * (1 - k / 14)) * a);
    ctx.beginPath(); ctx.arc(Q.x, Q.y, Math.max(0.6, r * 0.45 * (1 - k / 16)), 0, TAU); ctx.fill();
  }
  // level moons: a vertical price column next to the bulb
  if (layers.levels && pl.levels.length) {
    const hl = isSel || isHov;
    const px = P.x - r * 2.2, perAtr = (hl ? 52 : 26) * P.k;
    const shownL = hl ? pl.levels : pl.levels.filter((l) => Math.abs(l.distAtr) <= 0.8);
    const top = Math.min(0, ...shownL.map((l) => -l.distAtr)), bot = Math.max(0, ...shownL.map((l) => -l.distAtr));
    ctx.strokeStyle = rgba(C.wire, (hl ? 0.42 : 0.18) * a); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(px, P.y + Math.min(top, 0) * perAtr - 4); ctx.lineTo(px, P.y + Math.max(bot, 0) * perAtr + 4); ctx.stroke();
    ctx.strokeStyle = rgba(C.gold, 0.8 * a); ctx.beginPath(); ctx.moveTo(px - 5, P.y); ctx.lineTo(px + 5, P.y); ctx.stroke();
    const near = hl ? pl.levels : [pl.levels.filter((l) => l.dist > 0).sort((a, b) => a.dist - b.dist)[0], pl.levels.filter((l) => l.dist <= 0).sort((a, b) => b.dist - a.dist)[0]].filter(Boolean);
    for (const l of near) {
      const ly = P.y - l.distAtr * perAtr;
      const col = l.role === 'resistance' ? C.red : l.role === 'support' ? C.green : C.gold;
      miniBulb(px, ly, (0.9 + l.strength * 0.32) * P.k, col, (hl ? 1 : 0.55) * a);
      if (hl) hits.push({ x: px, y: ly, r: 7, z: P.z + 0.01, type: 'level', ref: { pl, l } });
    }
  }
  const flick = reduce ? 1 : 0.93 + 0.07 * Math.sin(T * 9 + pl.th0 * 7) * Math.sin(T * 3.1 + pl.th0);
  c9(P.x, P.y, r, pl.color, a, 0, flick);
  if (pl.pulse && !reduce) {
    const u = (T * 0.55 + pl.th0) % 1;
    ctx.strokeStyle = rgba(pl.color, 0.55 * (1 - u) * a); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(P.x, P.y - r * 0.5, r * 2 + u * 34 * P.k, 0, TAU); ctx.stroke();
  }
  if (isSel || isHov) {
    const rr = r * 3.2, rot = reduce ? 0 : T * 0.6;
    ctx.strokeStyle = rgba(C.gold, isSel ? 0.95 : 0.6); ctx.lineWidth = 1.6;
    for (let q = 0; q < 4; q++) {
      const a0 = rot + (q * Math.PI) / 2;
      ctx.beginPath(); ctx.arc(P.x, P.y - r * 0.5, rr, a0 - 0.32, a0 + 0.32); ctx.stroke();
    }
  }
  hits.push({ x: P.x, y: P.y - r * 0.5, r: Math.max(14, r * 2.4), z: P.z + 0.5, type: 'planet', ref: pl });
}

function drawBeam(b, g0) {
  const A = g0(b.from.p), B = b.to.w;
  if (!B) return;
  const m = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2];
  const ml = Math.hypot(...m) || 1;
  const lift = ml + 0.55;
  const Cp = [(m[0] / ml) * lift, (m[1] / ml) * lift, (m[2] / ml) * lift];
  const at = (t) => { const u = 1 - t; return [u * u * A[0] + 2 * u * t * Cp[0] + t * t * B[0], u * u * A[1] + 2 * u * t * Cp[1] + t * t * B[1], u * u * A[2] + 2 * u * t * Cp[2] + t * t * B[2]]; };
  const pts = []; for (let k = 0; k <= 28; k++) pts.push(proj(at(k / 28)));
  const hl = hover && (hover.ref === b.from || hover.ref === b.to);
  strokePath(pts, rgba(b.color, hl ? 0.5 : b.strong ? 0.22 : 0.11), hl ? 1.6 : 1);
  if (!reduce) for (let k = 0; k < 2; k++) {
    const t = (T * 0.22 + b.ph + k * 0.5) % 1;
    const P = proj(at(t));
    miniBulb(P.x, P.y, 1.4 * P.k, b.color, hl ? 1 : 0.7);
  }
}

function drawEvent(ev, P) {
  const a = depthA(P.z) * (ev.past ? 0.35 : 1);
  const r = (ev.high ? 4.4 : 3.2) * P.k;
  // hang outward from the string, like a light set
  const center = proj([0, 0, 0]);
  const ang = Math.atan2(P.x - center.x, -(P.y - center.y));
  const col = ev.high ? C.blue : C.amber;
  const lit = ev.past ? 0.25 : ev.e.minutesAway < 60 && !reduce ? (Math.sin(T * 4) > 0 ? 1 : 0.4) : 1;
  c9(P.x, P.y, r, col, a, ang, lit);
  hits.push({ x: P.x + Math.sin(ang) * r, y: P.y - Math.cos(ang) * r, r: Math.max(9, r * 2.2), z: P.z + 0.3, type: 'event', ref: ev });
}

function drawClock() {
  // hour ticks and the "now" marker on the release string
  for (let h = 0; h < 24; h += 3) {
    const P = proj(calPt(NOW_TH - (h / 24) * TAU));
    ctx.fillStyle = rgba(C.warm, (P.z >= 0 ? 0.55 : 0.18) * (h === 0 ? 0 : 1));
    ctx.beginPath(); ctx.arc(P.x, P.y, 1.6 * P.k, 0, TAU); ctx.fill();
  }
  const N = proj(calPt(NOW_TH));
  miniBulb(N.x, N.y, 3 * N.k, C.gold, 1);
}

function label(x, y, parts, align = 'left') {
  ctx.textAlign = align; ctx.textBaseline = 'middle';
  let xx = x;
  if (align === 'left') for (const [txt, font, col] of parts) { ctx.font = font; ctx.fillStyle = col; ctx.fillText(txt, xx, y); xx += ctx.measureText(txt).width + 5; }
  else { ctx.font = parts[0][1]; ctx.fillStyle = parts[0][2]; ctx.fillText(parts.map((p) => p[0]).join(' '), x, y); }
}
const FONT = (w, s) => `${w} ${s}px Archivo, system-ui, sans-serif`;

function labelPlanet(pl) {
  const P = pl.P; if (!P) return;
  const a = depthA(P.z);
  const r = pl.size * P.k * 0.82;
  const x = P.x + r * 1.6, y = P.y - r * 0.7;
  const i = pl.inst, s = pl.score;
  ctx.shadowColor = 'rgba(0,0,0,.85)'; ctx.shadowBlur = 6;
  label(x, y, [
    [i.id, FONT(800, 15), rgba(C.cream, a)],
    [`${s > 0 ? '▲ +' : s < 0 ? '▼ −' : ''}${Math.abs(s)}`, FONT(700, 13), rgba(pl.color, a)],
  ]);
  ctx.font = FONT(500, 12); ctx.fillStyle = rgba(C.cream, 0.62 * a);
  ctx.fillText(`${FP.fmt(i.price, i.decimals)}  ${i.changePct == null ? '' : FP.sign(i.changePct, 2) + '%'}`, x, y + 16);
  ctx.shadowBlur = 0;
}
function labelEvent(ev) {
  const P = ev.P; if (!P || P.z < -0.4 || ev.past) return;
  if (!ev.high && hover?.ref !== ev) return;
  ctx.shadowColor = 'rgba(0,0,0,.85)'; ctx.shadowBlur = 5;
  ctx.font = FONT(600, 11.5); ctx.fillStyle = rgba(C.cream, 0.78 * depthA(P.z)); ctx.textAlign = 'center';
  const short = ev.e.title.length > 26 ? ev.e.title.slice(0, 25) + '…' : ev.e.title;
  ctx.fillText(`${short}, ${FP.etTime(ev.e.time)}`, P.x, P.y + 20 * P.k + 6);
  ctx.shadowBlur = 0; ctx.textAlign = 'left';
}
function drawRegionLabels(g0) {
  const counts = {};
  for (const o of scene.news) counts[o.reg.name] = (counts[o.reg.name] || 0) + 1;
  ctx.textAlign = 'center';
  for (const reg of Object.values(REGIONS)) {
    if (!counts[reg.name]) continue;
    const P = proj(g0(ll(reg.lat + 13, reg.lon, 1.02)));
    if (P.z < 0.25) continue;
    // stay out of the way of market labels
    if (layers.markets && scene.planets.some((pl) => pl.P && Math.abs(pl.P.x + 50 - P.x) < 95 && Math.abs(pl.P.y - P.y) < 34)) continue;
    ctx.font = FONT(600, 11); ctx.fillStyle = rgba(C.warm, 0.55 * clamp(P.z, 0, 1));
    ctx.fillText(`${reg.name} (${counts[reg.name]})`, P.x, P.y);
  }
  ctx.textAlign = 'left';
}

// ---------- tooltip ----------
function tipHtml(h) {
  const { esc, fmt, sign, ago, until, etTime } = FP;
  if (h.type === 'planet') {
    const i = h.ref.inst, s = i.sentiment, ns = i.nearest || {};
    return `<b>${esc(i.id)}</b> <span class="m">${esc(i.name)}</span><br>
      <span class="big">${fmt(i.price, i.decimals)}</span> <span class="${i.change >= 0 ? 'up' : 'down'}">${i.changePct == null ? '' : sign(i.changePct, 2) + '%'}</span><br>
      <span class="${s.score >= 15 ? 'up' : s.score <= -15 ? 'down' : ''}">${esc(s.label)} ${sign(s.score, 0)}</span> <span class="m">${esc(s.confidence)} confidence</span><br>
      ${ns.support ? `<span class="up">Support ${fmt(ns.support.price, i.decimals)}</span> <span class="m">${esc(ns.support.codes.slice(0, 2).join(' + '))}</span><br>` : ''}
      ${ns.resistance ? `<span class="down">Resistance ${fmt(ns.resistance.price, i.decimals)}</span> <span class="m">${esc(ns.resistance.codes.slice(0, 2).join(' + '))}</span><br>` : ''}
      <span class="m">Click for the full level ladder</span>`;
  }
  if (h.type === 'level') {
    const { pl, l } = h.ref, i = pl.inst;
    return `<b>${esc(i.id)} ${fmt(l.price, i.decimals)}</b> <span class="${l.role === 'resistance' ? 'down' : 'up'}">${esc(l.role)}</span><br>
      <span class="m">${esc(l.labels.slice(0, 3).join(' + '))}</span><br>${sign(l.dist, i.decimals)} pts, ${Math.abs(l.distAtr).toFixed(2)} ATR, strength ${l.strength}/5`;
  }
  if (h.type === 'news') {
    const n = h.ref.n;
    const fx = Object.entries(n.effects || {}).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 6)
      .map(([k, v]) => `<span class="${v > 0 ? 'up' : 'down'}">${esc(k)} ${v > 0 ? '▲' : '▼'}</span>`).join(' ');
    return `<b>${esc(n.title)}</b><br><span class="m">${esc(n.source)}${n.sources.length > 1 ? ` + ${n.sources.length - 1} more` : ''}, ${ago(n.publishedAt)}, ${esc(n.impact === 'med' ? 'medium' : n.impact)} impact</span>
      ${fx ? `<br>${fx}` : ''}${n.rules?.length ? `<br><span class="m">${esc(n.rules.join(', '))}</span>` : ''}<br><span class="m">Click to open the article</span>`;
  }
  if (h.type === 'event') {
    const e = h.ref.e;
    return `<b>${esc(e.country)} ${esc(e.title)}</b><br>${etTime(e.time)} ET, ${until(e.time)}<br><span class="${e.impact === 'High' ? 'down' : ''}">${esc(e.impact)} impact</span>
      ${e.forecast ? ` <span class="m">forecast ${esc(e.forecast)}</span>` : ''}${e.previous ? ` <span class="m">previous ${esc(e.previous)}</span>` : ''}
      ${e.instruments?.length ? `<br><span class="m">Moves ${esc(e.instruments.join(', '))}</span>` : ''}`;
  }
  return '';
}
function pick(x, y) {
  let best = null, bz = -Infinity;
  for (const h of hits) {
    const d = Math.hypot(h.x - x, h.y - y);
    if (d <= h.r && (h.z > bz || (h.z === bz && d < Math.hypot(best.x - x, best.y - y)))) { best = h; bz = h.z; }
  }
  return best;
}
function showTip(h, x, y) {
  if (!h) { tip.hidden = true; return; }
  tip.innerHTML = tipHtml(h);
  tip.hidden = false;
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  tip.style.left = Math.min(W - tw - 12, x + 16) + 'px';
  tip.style.top = Math.min(H - th - 12, Math.max(12, y - th / 2)) + 'px';
}

// ---------- interaction ----------
let drag = null;
cv.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: 0 }; cv.setPointerCapture(e.pointerId); cv.style.cursor = 'grabbing'; });
cv.addEventListener('pointermove', (e) => {
  if (drag) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    cam.yaw += dx * 0.0055; cam.pitch = clamp(cam.pitch + dy * 0.004, -0.15, 1.15);
    cam.vyaw = dx * 0.0055; drag.x = e.clientX; drag.y = e.clientY;
    lastInteract = T; dirty = true; tip.hidden = true;
    return;
  }
  const h = pick(e.clientX, e.clientY);
  if (h?.ref !== hover?.ref) { hover = h; dirty = true; }
  cv.style.cursor = h ? 'pointer' : 'grab';
  showTip(h, e.clientX, e.clientY);
});
cv.addEventListener('pointerup', (e) => {
  const wasClick = drag && drag.moved < 5;
  drag = null; cv.style.cursor = 'grab';
  if (!wasClick) return;
  tip.hidden = true;
  const h = pick(e.clientX, e.clientY);
  if (!h) return;
  if (h.type === 'planet' || h.type === 'level') FP.openDetail((h.ref.pl || h.ref).id);
  else if (h.type === 'news') window.open(FP.safeUrl(h.ref.n.url), '_blank', 'noopener');
  else if (h.type === 'event') FP.setTab('events');
});
cv.addEventListener('pointerleave', () => { hover = null; tip.hidden = true; dirty = true; });
cv.addEventListener('wheel', (e) => { e.preventDefault(); cam.zoom = clamp(cam.zoom * Math.exp(-e.deltaY * 0.0012), 0.6, 1.9); lastInteract = T; dirty = true; }, { passive: false });

// ---------- HUD (layer toggles, legend, ticker) ----------
function buildUi() {
  const L = [['markets', 'Markets'], ['levels', 'Level moons'], ['news', 'Headlines'], ['beams', 'Beams'], ['calendar', 'Release string']];
  ui.innerHTML = `
    <div class="holo-tools" role="toolbar" aria-label="Globe layers">
      ${L.map(([k, t]) => `<button class="chip" data-layer="${k}" aria-pressed="${!!layers[k]}">${t}</button>`).join('')}
      <button class="chip" data-holo-reset>Reset view</button>
      <button class="chip" data-layout="classic">Phone layout</button>
    </div>
    <div class="holo-legend">
      <div><i style="background:rgb(${C.green});color:rgb(${C.green})"></i>Bullish market</div>
      <div><i style="background:rgb(${C.red});color:rgb(${C.red})"></i>Bearish market</div>
      <div><i style="background:rgb(${C.amber});color:rgb(${C.amber})"></i>Neutral market</div>
      <div><i style="background:rgb(${C.warm});color:rgb(${C.warm})"></i>Headline (blinking = breaking)</div>
      <div><i style="background:rgb(${C.blue});color:rgb(${C.blue})"></i>High-impact release</div>
      <p>Bulb size shows conviction. Moons beside each market are its key levels: red above price, green below. Drag to turn, scroll to zoom.</p>
    </div>
    <div class="holo-ticker" aria-label="High-impact headlines"><div class="tk"></div></div>`;
  ui.querySelector('.holo-tools').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.layer) { layers[b.dataset.layer] = !layers[b.dataset.layer]; b.setAttribute('aria-pressed', layers[b.dataset.layer]); FP.store.set('holoLayers', layers); dirty = true; }
    if (b.hasAttribute('data-holo-reset')) { cam.yaw = 0.55; cam.pitch = 0.42; cam.zoom = 1; dirty = true; }
  });
}
function ticker(d) {
  const tk = ui.querySelector('.tk'); if (!tk) return;
  const items = (d.news || []).filter((n) => n.impact === 'high' || n.kind === 'breaking').slice(0, 14);
  if (!items.length) { tk.innerHTML = '<span class="ti m">No high-impact headlines right now.</span>'; tk.classList.remove('run'); return; }
  const html = items.map((n) => {
    const fx = Object.entries(n.effects || {}).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 3)
      .map(([k, v]) => `<span class="${v > 0 ? 'up' : 'down'}">${FP.esc(k)} ${v > 0 ? '▲' : '▼'}</span>`).join(' ');
    return `<a class="ti" href="${FP.esc(FP.safeUrl(n.url))}" target="_blank" rel="noopener">${n.kind === 'breaking' ? '<span class="bulb"></span>' : ''}${FP.esc(n.title)} <span class="m">${FP.esc(n.source)}, ${FP.ago(n.publishedAt)}</span> ${fx}</a>`;
  }).join('');
  tk.innerHTML = html + (reduce ? '' : html);
  tk.classList.toggle('run', !reduce);
  tk.style.animationDuration = `${Math.max(40, items.length * 9)}s`;
}

// ---------- loop ----------
function loop(ts) {
  raf = 0;
  if (!enabled) return;
  const dt = Math.min(0.05, (ts - last) / 1000 || 0); last = ts;
  if (!reduce) {
    T += dt; spin += dt * 0.035;
    if (!drag) {
      if (T - lastInteract > 6) cam.yaw += dt * 0.045;
      else { cam.yaw += cam.vyaw; cam.vyaw *= 0.92; }
    }
  }
  layoutTarget();
  if (!reduce || dirty || Math.abs(tcx - cx) > 0.5) {
    draw(); dirty = false; frameNo++;
    // adapt to the real frame interval (includes compositing), not just our draw time
    if (!reduce && dt > 0) costAvg = frameNo < 5 ? dt * 1000 : costAvg * 0.95 + dt * 1000 * 0.05;
    if (frameNo > 30 && frameNo % 20 === 0 && costAvg > 24 && quality > 0) {
      quality--; costAvg = 16; frameNo = 0; if (quality === 0) resize();
    }
  }
  if (!document.hidden) raf = requestAnimationFrame(loop);
}
function start() { if (!raf && enabled) { last = performance.now(); raf = requestAnimationFrame(loop); } }

window.FPHolo = {
  enable(on) {
    enabled = on;
    if (on) { if (!ui.childElementCount) buildUi(); resize(); layoutTarget(); cx = tcx; if (FP.data) setData(FP.data); start(); }
    else { cancelAnimationFrame(raf); raf = 0; tip.hidden = true; }
  },
  setData(d) { if (ui.childElementCount) setData(d); else { buildUi(); setData(d); } },
  select(id) { selected = id; dirty = true; },
  relayout() { dirty = true; },
  // dev aid: average ms per frame for n frames
  bench(n = 30) { const t0 = performance.now(); for (let i = 0; i < n; i++) { T += 0.016; draw(); } return +((performance.now() - t0) / n).toFixed(2); },
};
window.addEventListener('resize', () => { if (enabled) resize(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) start(); });
if (FP.onHoloReady) FP.onHoloReady();
})();
