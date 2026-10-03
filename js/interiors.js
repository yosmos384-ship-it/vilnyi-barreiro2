// VILNYI · Barreiro 2 — INTERIORS
// Six building-material packages: atlantic, lisboa, noir + natura (Japandi), riviera (Mediterranean), urban (industrial loft).
// Real CC0 PBR textures (assets/manifest.json) + CC0 glTF props; procedural canvas textures are the fallback.
// API: STYLE_IDS, prewarm(styleIds?, { renderer }), getPackageMaterial(vocabKey, styleId),
//      buildInteriors(THREE, { scene, building?, renderer? }) => { group, furnish, clear, getHotspots, update, setTimeOfDay, getTimeOfDay,
//          prewarm, setBuilding, setRenderer, getPackageMaterial, setActiveUnit, getActiveUnit, setQuality, getQuality, getInteractables, interact }
// CONTRACT4: every openable / switchable thing is a Group 'int-dyn-<id>' with userData.interact { id, kind, label{en,pt,he,ru}, toggle, isOn,
// range, sound }, animated in update(dt) (no per-frame allocations). setActiveUnit hides the other units, setQuality('low') drops
// normal/roughness/AO maps, uses 512 px albedo and hides small props. furnish() resolves after textures are uploaded and shaders compiled
// (when a renderer was given to buildInteriors / prewarm / setRenderer).
// Time of day ('day' | 'dusk' | 'night'): setTimeOfDay switches every lamp/pendant/downlight/LED/candle material and the unit's
// point lights. Each unit group carries userData.tod and userData.lamps (all lamp positions, cd, colour); emissive materials carry
// userData.emissiveTod = { day, dusk, night } (absolute emissiveIntensity per mood).
// Every material is named with the CONTRACT3 vocabulary key ('<key>' or '<key>:<variant>').
import * as THREE_NS from 'three';
import { FLOORS, UNITS, STYLES, BALCONIES, LEVELS, FOOTPRINT, CORNICE_Y, MANSARD_PITCH, roomsOfUnit } from './data.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

export const STYLE_IDS = ['atlantic', 'lisboa', 'noir', 'natura', 'riviera', 'urban'];
// new packages reuse the construction details of an existing one (kin) and add their own on top
const KIN = { atlantic: 'atlantic', lisboa: 'lisboa', noir: 'noir', natura: 'atlantic', riviera: 'lisboa', urban: 'noir' };

let T = THREE_NS; // THREE namespace (buildInteriors may pass its own)
let CUR_FLOOR = null; // floor id of the unit being built (synchronous build)

// ───────── mansard (second floor): same formula as building.js ─────────
const M_TAN = Math.tan(MANSARD_PITCH * Math.PI / 180);
const M_EDGES = FOOTPRINT.map((p, i) => [p, FOOTPRINT[(i + 1) % FOOTPRINT.length]]).filter(([p, q]) => !(p[0] === 0 && q[0] === 0));
// clear height above the 2nd-floor finished level at (x,z); Infinity on other floors
function mansardH(x, z, floorId) {
  if (floorId !== 'second') return Infinity;
  let y = Infinity;
  for (const [p, q] of M_EDGES) {
    const L = Math.hypot(q[0] - p[0], q[1] - p[1]), ux = (q[0] - p[0]) / L, uz = (q[1] - p[1]) / L, nx = -uz, nz = ux;
    const s = (x - p[0]) * ux + (z - p[1]) * uz; if (s < -1.2 || s > L + 1.2) continue;
    const d = (x - p[0]) * nx + (z - p[1]) * nz; if (d < -0.5) continue;
    y = Math.min(y, CORNICE_Y + Math.max(0, d - 0.15) * M_TAN);
  }
  return y - LEVELS.second.y;
}
// flat-ceiling polygon of the 2nd floor (building.js: mansard edges inset 0.9, party wall 0.15)
function clipConvex(poly, clip) { // Sutherland–Hodgman, clip must be convex
  let out = poly.slice();
  const area = (P) => { let a = 0; for (let i = 0; i < P.length; i++) { const [x1, z1] = P[i], [x2, z2] = P[(i + 1) % P.length]; a += x1 * z2 - x2 * z1; } return a; };
  const sg = Math.sign(area(clip));
  for (let i = 0; i < clip.length && out.length; i++) {
    const A = clip[i], B = clip[(i + 1) % clip.length];
    const inside = (P) => sg * ((B[0] - A[0]) * (P[1] - A[1]) - (B[1] - A[1]) * (P[0] - A[0])) >= -1e-9;
    const inter = (P, Q) => { const dx = Q[0] - P[0], dz = Q[1] - P[1], ex = B[0] - A[0], ez = B[1] - A[1]; const t = (ex * (P[1] - A[1]) - ez * (P[0] - A[0])) / (ez * dx - ex * dz); return [P[0] + dx * t, P[1] + dz * t]; };
    const inp = out; out = [];
    for (let j = 0; j < inp.length; j++) {
      const P = inp[j], Q = inp[(j + 1) % inp.length], pi = inside(P), qi = inside(Q);
      if (pi) out.push(P); if (pi !== qi) out.push(inter(P, Q));
    }
  }
  return out;
}
let FLAT2 = null;
function flatCeiling2() {
  if (FLAT2) return FLAT2;
  const n = FOOTPRINT.length, lines = [];
  // footprint is clockwise in (x right, z down); inward normal = (-uz, ux)
  for (let i = 0; i < n; i++) {
    const p = FOOTPRINT[i], q = FOOTPRINT[(i + 1) % n], L = Math.hypot(q[0] - p[0], q[1] - p[1]), ux = (q[0] - p[0]) / L, uz = (q[1] - p[1]) / L;
    const d = (p[0] === 0 && q[0] === 0) ? 0.15 : 0.9;
    lines.push({ px: p[0] - uz * d, pz: p[1] + ux * d, ux, uz });
  }
  FLAT2 = lines.map((a, i) => { const b = lines[(i + n - 1) % n]; const det = a.ux * b.uz - a.uz * b.ux; const t = ((b.px - a.px) * b.uz - (b.pz - a.pz) * b.ux) / det; return [a.px + a.ux * t, a.pz + a.uz * t]; });
  return FLAT2;
}
const PI = Math.PI, HP = Math.PI / 2;

// ───────────────────────── utilities ─────────────────────────
function mulberry(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function mkCanvas(n, m = n) { const c = document.createElement('canvas'); c.width = n; c.height = m; return c; }
function hex2rgb(h) { const v = parseInt(h.slice(1), 16); return [v >> 16 & 255, v >> 8 & 255, v & 255]; }
function shade(h, f) {
  const [r, g, b] = hex2rgb(h);
  const m = f >= 0 ? (c) => c + (255 - c) * f : (c) => c * (1 + f);
  return `rgb(${m(r) | 0},${m(g) | 0},${m(b) | 0})`;
}
function rgba(h, a) { const [r, g, b] = hex2rgb(h); return `rgba(${r},${g},${b},${a})`; }
function mixHex(a, b, t) {
  const A = hex2rgb(a), B = hex2rgb(b);
  const c = A.map((v, i) => Math.round(v + (B[i] - v) * t));
  return '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
}

// seamless value noise blended over the canvas (overlay)
function cloudNoise(ctx, n, cells, alpha, R, op = 'overlay') {
  const p = cells + 2, s = mkCanvas(p), c = s.getContext('2d', { willReadFrequently: true }), id = c.createImageData(p, p);
  const base = new Uint8Array(cells * cells);
  for (let i = 0; i < base.length; i++) base[i] = R() * 255 | 0;
  for (let y = 0; y < p; y++) for (let x = 0; x < p; x++) {
    const v = base[((y - 1 + cells) % cells) * cells + ((x - 1 + cells) % cells)], k = (y * p + x) * 4;
    id.data[k] = id.data[k + 1] = id.data[k + 2] = v; id.data[k + 3] = 255;
  }
  c.putImageData(id, 0, 0);
  ctx.save(); ctx.globalAlpha = alpha; ctx.globalCompositeOperation = op;
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  const cs = n / cells;
  ctx.drawImage(s, -cs * 1.5, -cs * 1.5, cs * (p), cs * (p));
  ctx.restore();
}
let GRAIN = null;
function grainNoise(ctx, n, alpha, R) { // fine noise, tiled from one shared 256px tile (no canvas read-back)
  if (!GRAIN) {
    GRAIN = mkCanvas(256); const c = GRAIN.getContext('2d', { willReadFrequently: true }), id = c.createImageData(256, 256), r = mulberry(99);
    for (let i = 0; i < id.data.length; i += 4) { const v = r() * 255 | 0; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 255; }
    c.putImageData(id, 0, 0);
  }
  ctx.save(); ctx.globalCompositeOperation = 'overlay'; ctx.globalAlpha = Math.min(1, alpha * 2.2);
  const ox = R() * 256 | 0, oy = R() * 256 | 0;
  for (let y = -oy; y < n; y += 256) for (let x = -ox; x < n; x += 256) ctx.drawImage(GRAIN, x, y);
  ctx.restore();
}
function gridLines(ctx, n, cols, rows, color, w) {
  ctx.fillStyle = color;
  for (let i = 0; i <= cols; i++) { const x = i * n / cols; ctx.fillRect(x - w / 2, 0, w, n); }
  for (let j = 0; j <= rows; j++) { const y = j * n / rows; ctx.fillRect(0, y - w / 2, n, w); }
}

// ───────────────────────── procedural textures ─────────────────────────
const TEX = new Map();
function makeTex(key, n, draw, { size = 1, srgb = true, rot = 0, m = n } = {}) {
  if (TEX.has(key)) return TEX.get(key);
  const c = mkCanvas(n, m), ctx = c.getContext('2d', { willReadFrequently: true }); // CPU raster: predictable cost, cheap normal-map readback
  try { draw(ctx, n, mulberry(hashStr(key)), m); } catch (e) { /* keep blank */ }
  const t = new T.CanvasTexture(c);
  t.wrapS = t.wrapT = T.RepeatWrapping;
  if (srgb) t.colorSpace = T.SRGBColorSpace;
  t.anisotropy = 8;
  t.repeat.set(1 / size, 1 / size);
  if (rot) { t.rotation = rot; }
  TEX.set(key, t);
  return t;
}

// normal map from the luminance of a generated colour texture (same tiling). Linear colour space.
const NRM = new Map();
function normalOf(src, strength = 2, max = 1024) {
  const key = src.uuid + '|' + strength;
  if (NRM.has(key)) return NRM.get(key);
  const img = src.image, W = Math.min(max, img.width), H = Math.min(max, img.height);
  const c = mkCanvas(W, H), ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H), px = d.data, h = new Float32Array(W * H);
  for (let i = 0, j = 0; j < h.length; i += 4, j++) h[j] = (px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11) / 255;
  const k = strength * (W / 512);
  for (let y = 0; y < H; y++) {
    const ym = ((y - 1 + H) % H) * W, yp = ((y + 1) % H) * W, y0 = y * W;
    for (let x = 0; x < W; x++) {
      const xm = (x - 1 + W) % W, xp = (x + 1) % W;
      const dx = (h[y0 + xp] - h[y0 + xm]) * k, dy = (h[yp + x] - h[ym + x]) * k;
      const l = 1 / Math.sqrt(dx * dx + dy * dy + 1), o = (y0 + x) * 4;
      px[o] = (-dx * l * 0.5 + 0.5) * 255; px[o + 1] = (dy * l * 0.5 + 0.5) * 255; px[o + 2] = (l * 0.5 + 0.5) * 255; px[o + 3] = 255;
    }
  }
  ctx.putImageData(d, 0, 0);
  const t = new T.CanvasTexture(c);
  t.wrapS = t.wrapT = T.RepeatWrapping; t.colorSpace = T.NoColorSpace; t.anisotropy = 8;
  t.repeat.copy(src.repeat); t.rotation = src.rotation; t.center.copy(src.center); t.offset.copy(src.offset);
  NRM.set(key, t);
  return t;
}

function drawPlank(ctx, x, y, L, h, base, seed, o) {
  const R = mulberry(seed);
  ctx.save(); ctx.beginPath(); ctx.rect(x, y, L, h); ctx.clip();
  ctx.fillStyle = shade(base, (R() - 0.5) * o.vary); ctx.fillRect(x, y, L, h);
  // soft tonal streak
  const g = ctx.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.3 + R() * 0.4, `rgba(0,0,0,${0.04 + R() * 0.06})`); g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.fillRect(x, y, L, h);
  for (let i = 0; i < o.grain; i++) {
    const gy = y + R() * h, amp = 0.5 + R() * h * 0.06, f = 0.004 + R() * 0.012, ph = R() * 6;
    ctx.strokeStyle = R() < 0.65 ? `rgba(40,22,8,${0.05 + R() * 0.12})` : `rgba(255,245,225,${0.04 + R() * 0.08})`;
    ctx.lineWidth = 0.5 + R() * 1.4;
    ctx.beginPath();
    for (let t = 0; t <= L + 12; t += 12) { const yy = gy + Math.sin(t * f + ph) * amp + Math.sin(t * f * 3.3 + ph) * amp * 0.35; if (t === 0) ctx.moveTo(x + t, yy); else ctx.lineTo(x + t, yy); }
    ctx.stroke();
  }
  if (R() < 0.55) { // cathedral figure
    const cx = x + L * (0.2 + R() * 0.6), cy = y + h * (0.3 + R() * 0.4);
    for (let k = 1; k < 7; k++) {
      ctx.strokeStyle = `rgba(40,22,8,${0.05 + R() * 0.07})`; ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.ellipse(cx, cy, k * L * 0.035, k * h * 0.07, 0, 0, PI * 2); ctx.stroke();
    }
  }
  if (R() < o.knots) { const kx = x + R() * L, ky = y + R() * h; ctx.fillStyle = 'rgba(40,20,5,0.35)'; ctx.beginPath(); ctx.ellipse(kx, ky, 3 + R() * 4, 2 + R() * 2, 0, 0, PI * 2); ctx.fill(); }
  // bevel / joint
  ctx.fillStyle = `rgba(0,0,0,${o.gapA})`; ctx.fillRect(x, y, L, o.gap); ctx.fillRect(x, y, o.gap, h);
  ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fillRect(x, y + o.gap, L, 1);
  ctx.restore();
}

// planks: size = metres covered by the texture, plankW in metres
function texPlanks(key, base, { size = 2.4, plankW = 0.2, lenMin = 1.0, lenMax = 2.2, gap = 2, gapA = 0.45, vary = 0.14, grain = 30, knots = 0.25, n = 1024 } = {}) {
  return makeTex(key, n, (ctx, n, R) => {
    const px = n / size, rows = Math.max(1, Math.round(size / plankW)), ph = n / rows;
    ctx.fillStyle = base; ctx.fillRect(0, 0, n, n);
    const o = { vary, grain, knots, gap, gapA };
    for (let r = 0; r < rows; r++) {
      let x = R() * n, rem = n;
      while (rem > 1) {
        let L = (lenMin + R() * (lenMax - lenMin)) * px; if (L > rem || rem - L < 0.35 * px) L = rem;
        const seed = R() * 1e9 | 0;
        drawPlank(ctx, x, r * ph, L, ph, base, seed, o);
        if (x + L > n) drawPlank(ctx, x - n, r * ph, L, ph, base, seed, o);
        x += L; rem -= L; if (x >= n) x -= n;
      }
    }
    cloudNoise(ctx, n, 8, 0.18, R);
  }, { size });
}

function texHerringbone(key, base, { plankL = 0.6, n = 1024 } = {}) {
  const size = plankL * 4; // 16 units of plankL/4
  return makeTex(key, n, (ctx, n, R) => {
    const u = n / 16; ctx.fillStyle = base; ctx.fillRect(0, 0, n, n);
    const o = { vary: 0.22, grain: 14, knots: 0.1, gap: 1.5, gapA: 0.55 };
    for (let i = -8; i <= 24; i++) for (let j = -4; j <= 6; j++) {
      const px = (i - 8 * j) * u, py = i * u;
      if (px > n + u || px < -5 * u || py > n + u || py < -5 * u) continue;
      const ci = ((i % 16) + 16) % 16, cj = (((j - 2 * Math.floor(i / 16)) % 2) + 2) % 2;
      const sA = hashStr(`${key}a${ci},${cj}`), sB = hashStr(`${key}b${ci},${cj}`);
      drawPlank(ctx, px, py, 4 * u, u, base, sA, o);
      ctx.save(); ctx.translate(px, py + u + 4 * u); ctx.rotate(-HP); drawPlank(ctx, 0, 0, 4 * u, u, base, sB, o); ctx.restore();
    }
    cloudNoise(ctx, n, 8, 0.15, R);
  }, { size, rot: PI / 4 });
}

function drawVeins(ctx, n, R, { count, color, width, alpha, soft = true, len = 90 }) {
  // veins drawn once on a layer (wrapped ×9 for seamless tiling), then composited: blurred halo + sharp line
  const L = mkCanvas(n), lc = L.getContext('2d', { willReadFrequently: true });
  lc.lineCap = 'round'; lc.lineJoin = 'round';
  for (let v = 0; v < count; v++) {
    let x = R() * n, y = R() * n, a = R() * PI * 2; const pts = [[x, y]];
    const st = n / 70;
    for (let k = 0; k < len; k++) { a += (R() - 0.5) * 0.55; x += Math.cos(a) * st; y += Math.sin(a) * st * 0.6; pts.push([x, y]); }
    lc.strokeStyle = rgba(color, alpha * (0.4 + R() * 0.6)); lc.lineWidth = width * (0.4 + R());
    for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
      lc.beginPath(); pts.forEach(([px, py], i) => i ? lc.lineTo(px + ox * n, py + oy * n) : lc.moveTo(px + ox * n, py + oy * n)); lc.stroke();
    }
  }
  if (soft) {
    const B = mkCanvas(n / 4), bc = B.getContext('2d', { willReadFrequently: true }); // cheap blur: downscale + upscale
    bc.drawImage(L, 0, 0, n / 4, n / 4);
    ctx.save(); ctx.globalAlpha = 0.9; ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(B, 0, 0, n, n); ctx.drawImage(B, 0, 0, n, n); ctx.restore();
  }
  ctx.drawImage(L, 0, 0);
}
function texMarble(key, base, vein, { size = 1.6, tiles = 0, grout = '#cfcac2', count = 9, width = 1.6, alpha = 0.7, n = 1024 } = {}) {
  return makeTex(key, n, (ctx, n, R) => {
    ctx.fillStyle = base; ctx.fillRect(0, 0, n, n);
    cloudNoise(ctx, n, 5, 0.35, R); cloudNoise(ctx, n, 18, 0.18, R);
    drawVeins(ctx, n, R, { count: count * 2, color: vein, width: width * 0.5, alpha: alpha * 0.4 });
    drawVeins(ctx, n, R, { count, color: vein, width, alpha });
    grainNoise(ctx, n, 0.03, R);
    if (tiles) gridLines(ctx, n, tiles, tiles, grout, 2);
  }, { size });
}
function texMicrocement(key, base, { size = 3, n = 512 } = {}) {
  return makeTex(key, n, (ctx, n, R) => {
    ctx.fillStyle = base; ctx.fillRect(0, 0, n, n);
    cloudNoise(ctx, n, 4, 0.3, R); cloudNoise(ctx, n, 12, 0.22, R); cloudNoise(ctx, n, 40, 0.12, R);
    for (let i = 0; i < 140; i++) {
      ctx.strokeStyle = R() < 0.5 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.05)'; ctx.lineWidth = (6 + R() * 26) * n / 1024;
      const x = R() * n, y = R() * n, r = (40 + R() * 140) * n / 1024, a = R() * PI * 2;
      ctx.beginPath(); ctx.arc(x, y, r, a, a + 0.6 + R()); ctx.stroke();
    }
    grainNoise(ctx, n, 0.04, R);
  }, { size });
}
function texAzulejo(key, { blue = '#1d4b93', bg = '#f3eee2', size = 0.56, n = 512 } = {}) {
  return makeTex(key, n, (ctx, n, R) => {
    const t = n / 4;
    for (let ty = 0; ty < 4; ty++) for (let tx = 0; tx < 4; tx++) {
      const x = tx * t, y = ty * t;
      ctx.save(); ctx.beginPath(); ctx.rect(x, y, t, t); ctx.clip();
      ctx.fillStyle = shade(bg, (R() - 0.5) * 0.05); ctx.fillRect(x, y, t, t);
      ctx.filter = 'blur(0.6px)';
      const bl = shade(blue, (R() - 0.5) * 0.15);
      // corner quarter circles (form circles across tiles)
      for (const [cx, cy] of [[x, y], [x + t, y], [x, y + t], [x + t, y + t]]) {
        ctx.fillStyle = bl; ctx.beginPath(); ctx.arc(cx, cy, t * 0.36, 0, PI * 2); ctx.fill();
        ctx.fillStyle = bg; ctx.beginPath(); ctx.arc(cx, cy, t * 0.27, 0, PI * 2); ctx.fill();
        ctx.fillStyle = bl; ctx.beginPath(); ctx.arc(cx, cy, t * 0.12, 0, PI * 2); ctx.fill();
      }
      // central flower
      const cx = x + t / 2, cy = y + t / 2;
      ctx.fillStyle = bl;
      for (let k = 0; k < 4; k++) { ctx.beginPath(); ctx.ellipse(cx + Math.cos(k * HP + PI / 4) * t * 0.14, cy + Math.sin(k * HP + PI / 4) * t * 0.14, t * 0.13, t * 0.055, k * HP + PI / 4, 0, PI * 2); ctx.fill(); }
      ctx.fillStyle = '#d9a33a'; ctx.beginPath(); ctx.arc(cx, cy, t * 0.05, 0, PI * 2); ctx.fill();
      ctx.strokeStyle = bl; ctx.lineWidth = t * 0.02;
      for (let k = 0; k < 4; k++) { ctx.beginPath(); ctx.moveTo(cx + Math.cos(k * HP) * t * 0.1, cy + Math.sin(k * HP) * t * 0.1); ctx.lineTo(cx + Math.cos(k * HP) * t * 0.36, cy + Math.sin(k * HP) * t * 0.36); ctx.stroke(); }
      ctx.filter = 'none';
      // glaze sheen
      const g = ctx.createRadialGradient(x + t * 0.3, y + t * 0.3, 0, x + t * 0.5, y + t * 0.5, t * 0.8);
      g.addColorStop(0, 'rgba(255,255,255,0.12)'); g.addColorStop(1, 'rgba(0,0,0,0.06)');
      ctx.fillStyle = g; ctx.fillRect(x, y, t, t);
      ctx.restore();
    }
    grainNoise(ctx, n, 0.03, R);
    gridLines(ctx, n, 4, 4, '#cfc9bb', 3);
  }, { size });
}
function texHydraulic(key, { a = '#b5652e', b = '#2f4a6b', bg = '#efe6d6', size = 0.8, n = 512 } = {}) {
  return makeTex(key, n, (ctx, n, R) => {
    const t = n / 4;
    for (let ty = 0; ty < 4; ty++) for (let tx = 0; tx < 4; tx++) {
      const x = tx * t, y = ty * t, cx = x + t / 2, cy = y + t / 2;
      ctx.fillStyle = bg; ctx.fillRect(x, y, t, t);
      ctx.fillStyle = a; ctx.beginPath();
      for (let k = 0; k < 8; k++) { const r = k % 2 ? t * 0.2 : t * 0.44, ang = k * PI / 4; ctx.lineTo(cx + Math.cos(ang) * r, cy + Math.sin(ang) * r); }
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = bg; ctx.beginPath(); ctx.arc(cx, cy, t * 0.14, 0, PI * 2); ctx.fill();
      ctx.fillStyle = b; ctx.save(); ctx.translate(cx, cy); ctx.rotate(PI / 4); ctx.fillRect(-t * 0.07, -t * 0.07, t * 0.14, t * 0.14); ctx.restore();
      ctx.fillStyle = b;
      for (const [qx, qy] of [[x, y], [x + t, y], [x, y + t], [x + t, y + t]]) { ctx.beginPath(); ctx.moveTo(qx, qy - t * 0.14); ctx.lineTo(qx + t * 0.14, qy); ctx.lineTo(qx, qy + t * 0.14); ctx.lineTo(qx - t * 0.14, qy); ctx.fill(); }
    }
    cloudNoise(ctx, n, 16, 0.12, R); grainNoise(ctx, n, 0.05, R);
    gridLines(ctx, n, 4, 4, 'rgba(90,80,70,0.5)', 2);
  }, { size });
}
function texZellige(key, base, { size = 0.8, tiles = 8, grout = '#d8d2c8', n = 512 } = {}) {
  return makeTex(key, n, (ctx, n, R) => {
    const t = n / tiles;
    for (let j = 0; j < tiles; j++) for (let i = 0; i < tiles; i++) {
      const x = i * t, y = j * t;
      ctx.fillStyle = shade(base, (R() - 0.5) * 0.12); ctx.fillRect(x, y, t, t);
      const g = ctx.createRadialGradient(x + t * R(), y + t * R(), 0, x + t / 2, y + t / 2, t * 0.75);
      g.addColorStop(0, 'rgba(255,255,255,0.14)'); g.addColorStop(1, `rgba(0,0,0,${0.02 + R() * 0.04})`);
      ctx.fillStyle = g; ctx.fillRect(x, y, t, t);
    }
    grainNoise(ctx, n, 0.03, R);
    gridLines(ctx, n, tiles, tiles, grout, 3);
  }, { size });
}
function texLinen(key, { size = 0.4, n = 512, boucle = false } = {}) {
  return makeTex(key, n, (ctx, n, R) => {
    ctx.fillStyle = '#e4e4e4'; ctx.fillRect(0, 0, n, n);
    if (boucle) {
      for (let i = 0; i < 9000; i++) { const x = R() * n, y = R() * n; ctx.strokeStyle = R() < 0.5 ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.16)'; ctx.lineWidth = 1 + R(); ctx.beginPath(); ctx.arc(x, y, 1.5 + R() * 2.5, 0, PI * 2); ctx.stroke(); }
    } else {
      for (let i = 0; i < n; i += 2) {
        ctx.fillStyle = `rgba(0,0,0,${R() * 0.09})`; ctx.fillRect(0, i, n, 1);
        ctx.fillStyle = `rgba(0,0,0,${R() * 0.09})`; ctx.fillRect(i, 0, 1, n);
        if (R() < 0.08) { ctx.fillStyle = `rgba(255,255,255,${R() * 0.25})`; ctx.fillRect(0, i, n, 1 + (R() * 2 | 0)); }
      }
    }
    cloudNoise(ctx, n, 10, 0.12, R);
  }, { size });
}
function texPlaster(key, { size = 2.0, n = 512, strength = 0.2 } = {}) {
  return makeTex(key, n, (ctx, n, R) => {
    ctx.fillStyle = '#ececec'; ctx.fillRect(0, 0, n, n);
    cloudNoise(ctx, n, 4, strength, R); cloudNoise(ctx, n, 14, strength * 0.7, R); cloudNoise(ctx, n, 48, strength * 0.35, R);
  }, { size });
}
function texFluted(key, base, { size = 0.6, flutes = 20, n = 512 } = {}) {
  return makeTex(key, n, (ctx, n, R) => {
    const w = n / flutes;
    for (let i = 0; i < flutes; i++) {
      const g = ctx.createLinearGradient(i * w, 0, (i + 1) * w, 0);
      g.addColorStop(0, shade(base, -0.45)); g.addColorStop(0.35, shade(base, 0.12)); g.addColorStop(0.7, shade(base, -0.05)); g.addColorStop(1, shade(base, -0.5));
      ctx.fillStyle = g; ctx.fillRect(i * w, 0, w, n);
    }
    for (let i = 0; i < 400; i++) { ctx.strokeStyle = `rgba(0,0,0,${R() * 0.12})`; ctx.lineWidth = 0.6; const x = R() * n; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + (R() - 0.5) * 3, n); ctx.stroke(); }
  }, { size });
}
function texGrass(key, { size = 1.2, n = 512 } = {}) {
  return makeTex(key, n, (ctx, n, R) => {
    ctx.fillStyle = '#4f6f2c'; ctx.fillRect(0, 0, n, n);
    cloudNoise(ctx, n, 6, 0.35, R);
    const cols = ['#6b8e3a', '#3f5e22', '#7fa24a', '#56782d', '#8aa860'];
    for (let i = 0; i < 16000; i++) {
      const x = R() * n, y = R() * n, l = 3 + R() * 6, a = -HP + (R() - 0.5) * 1.2;
      ctx.strokeStyle = cols[R() * cols.length | 0]; ctx.globalAlpha = 0.5 + R() * 0.5; ctx.lineWidth = 0.8 + R();
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }, { size });
}

// abstract art (canvas)
const ART_KINDS = 8;
function texArt(key, pal, kind, { n = 512, m = 640 } = {}) {
  return makeTex(key, n, (ctx, n, R, m) => {
    const P = (i) => pal[i % pal.length];
    ctx.fillStyle = pal[0]; ctx.fillRect(0, 0, n, m);
    cloudNoise(ctx, n, 6, 0.1, R);
    if (kind === 0) { // soft organic shapes (Matisse-like cut-outs)
      for (let i = 0; i < 5; i++) {
        ctx.fillStyle = P(1 + i % (pal.length - 1)); ctx.globalAlpha = 0.88;
        ctx.beginPath(); const cx = n * (0.2 + R() * 0.6), cy = m * (0.2 + R() * 0.6), r = n * (0.1 + R() * 0.2);
        for (let k = 0; k <= 32; k++) { const a = k / 32 * PI * 2, rr = r * (0.8 + 0.25 * Math.sin(a * 3 + i) + 0.08 * Math.sin(a * 7)); ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 1.1); }
        ctx.fill();
      }
    } else if (kind === 1) { // layered hills / dunes
      for (let i = 0; i < 4; i++) { ctx.fillStyle = P(1 + i % (pal.length - 1)); ctx.globalAlpha = 0.92; const y = m * (0.38 + i * 0.15 + R() * 0.04); ctx.beginPath(); ctx.moveTo(0, y); for (let x = 0; x <= n; x += 8) ctx.lineTo(x, y + Math.sin(x * 0.009 + i * 1.7) * 18 + Math.sin(x * 0.023 + i) * 6); ctx.lineTo(n, m); ctx.lineTo(0, m); ctx.fill(); }
      ctx.fillStyle = P(pal.length - 1); ctx.beginPath(); ctx.arc(n * 0.68, m * 0.24, n * 0.075, 0, PI * 2); ctx.fill();
    } else if (kind === 2) { // arches line drawing
      ctx.strokeStyle = P(1); ctx.lineWidth = 6; ctx.globalAlpha = 0.9;
      for (let i = 0; i < 3; i++) { const x = n * (0.22 + i * 0.28); ctx.beginPath(); ctx.moveTo(x - n * 0.1, m * 0.85); ctx.lineTo(x - n * 0.1, m * 0.45); ctx.arc(x, m * 0.45, n * 0.1, PI, 0); ctx.lineTo(x + n * 0.1, m * 0.85); ctx.stroke(); }
      ctx.fillStyle = P(2); ctx.beginPath(); ctx.arc(n * 0.5, m * 0.22, n * 0.06, 0, PI * 2); ctx.fill();
    } else if (kind === 3) { // colour field (soft-edged blocks)
      const blocks = [[0.08, 0.07, 0.84, 0.42], [0.08, 0.53, 0.84, 0.18], [0.08, 0.75, 0.84, 0.18]];
      blocks.forEach(([x, y, w, h], i) => { ctx.save(); ctx.filter = 'blur(5px)'; ctx.fillStyle = P(1 + i); ctx.globalAlpha = 0.9; ctx.fillRect(x * n, y * m, w * n, h * m); ctx.restore(); });
    } else if (kind === 4) { // ensō brush circle
      ctx.strokeStyle = P(1); ctx.lineCap = 'round';
      const cx = n / 2, cy = m * 0.46, r = n * 0.3;
      for (let k = 0; k < 150; k++) { const a0 = -1.2 + k / 150 * 5.6, a1 = a0 + 0.06; ctx.lineWidth = 26 * Math.sin(Math.min(1, k / 150) * PI) + 3 + R() * 2; ctx.globalAlpha = 0.75 + R() * 0.2; ctx.beginPath(); ctx.arc(cx, cy, r + Math.sin(k * 0.3) * 2, a0, a1); ctx.stroke(); }
      ctx.globalAlpha = 1; ctx.fillStyle = P(2); ctx.fillRect(n * 0.78, m * 0.84, 18, 18);
    } else if (kind === 5) { // botanical line drawing
      ctx.strokeStyle = P(1); ctx.lineWidth = 3; ctx.globalAlpha = 0.95;
      ctx.beginPath(); ctx.moveTo(n * 0.5, m * 0.92); ctx.bezierCurveTo(n * 0.45, m * 0.6, n * 0.58, m * 0.4, n * 0.5, m * 0.1); ctx.stroke();
      for (let i = 0; i < 9; i++) {
        const t = 0.15 + i * 0.085, y = m * (0.92 - t * 0.85), x = n * (0.5 + Math.sin(t * 5) * 0.03), sd = i % 2 ? 1 : -1, L = n * (0.2 - t * 0.08);
        ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + sd * L * 0.5, y - L * 0.55, x + sd * L, y - L * 0.25); ctx.quadraticCurveTo(x + sd * L * 0.45, y + L * 0.05, x, y); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + sd * L * 0.8, y - L * 0.25); ctx.lineWidth = 1.2; ctx.stroke(); ctx.lineWidth = 3;
      }
    } else if (kind === 6) { // Tagus seascape photograph
      const g = ctx.createLinearGradient(0, 0, 0, m); g.addColorStop(0, '#9fb6c6'); g.addColorStop(0.5, '#e9d2b4'); g.addColorStop(0.56, '#c9b8a3'); g.addColorStop(0.58, '#7890a0'); g.addColorStop(1, '#3d5566');
      ctx.fillStyle = g; ctx.globalAlpha = 1; ctx.fillRect(0, 0, n, m);
      const sg = ctx.createRadialGradient(n * 0.62, m * 0.5, 0, n * 0.62, m * 0.5, n * 0.3); sg.addColorStop(0, 'rgba(255,240,210,0.9)'); sg.addColorStop(1, 'rgba(255,240,210,0)'); ctx.fillStyle = sg; ctx.fillRect(0, 0, n, m);
      ctx.fillStyle = 'rgba(60,70,80,0.55)'; ctx.beginPath(); ctx.moveTo(0, m * 0.56); for (let x = 0; x <= n; x += 6) ctx.lineTo(x, m * 0.56 - (x > n * 0.1 && x < n * 0.45 ? 6 + ((x * 7) % 11) : 2)); ctx.lineTo(n, m * 0.56); ctx.fill();
      for (let i = 0; i < 60; i++) { ctx.fillStyle = `rgba(255,235,200,${0.1 + R() * 0.25})`; ctx.fillRect(n * (0.45 + R() * 0.35), m * (0.59 + R() * 0.2), 10 + R() * 30, 1.5); }
      ctx.lineWidth = 0; grainNoise(ctx, n, 0.06, R);
    } else { // geometric grid (Bauhaus)
      const c = 3, r = 3, cw = n * 0.84 / c, ch = m * 0.84 / r;
      for (let j = 0; j < r; j++) for (let i = 0; i < c; i++) {
        const x = n * 0.08 + i * cw, y = m * 0.08 + j * ch; ctx.fillStyle = P(1 + ((i + j) % (pal.length - 1))); ctx.globalAlpha = 0.9;
        const t = (i * 3 + j * 5) % 4;
        ctx.beginPath();
        if (t === 0) ctx.arc(x + cw / 2, y + ch / 2, Math.min(cw, ch) * 0.38, 0, PI * 2);
        else if (t === 1) ctx.arc(x + cw / 2, y + ch, Math.min(cw, ch) * 0.45, PI, 0);
        else if (t === 2) { ctx.moveTo(x + 6, y + ch - 6); ctx.lineTo(x + cw - 6, y + ch - 6); ctx.lineTo(x + cw - 6, y + 6); }
        else ctx.rect(x + cw * 0.2, y + ch * 0.2, cw * 0.6, ch * 0.6);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1; grainNoise(ctx, n, 0.05, R);
  }, { m });
}
// soft blob for contact shadows (alpha: white = shadow)
function texContact(key) {
  return makeTex(key, 128, (ctx, n) => {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, n, n);
    ctx.filter = 'blur(12px)'; ctx.fillStyle = '#fff';
    ctx.beginPath(); const r = 18, x = 22, y = 22, w = n - 44, h = n - 44;
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.fill();
    ctx.filter = 'none';
  }, { srgb: false });
}
function texEdge(key) { // v=1 (at the junction) dark → fades out
  const t = makeTex(key, 64, (ctx, n) => {
    const g = ctx.createLinearGradient(0, 0, 0, n);
    g.addColorStop(0, '#fff'); g.addColorStop(0.18, '#9a9a9a'); g.addColorStop(0.5, '#2e2e2e'); g.addColorStop(1, '#000');
    ctx.fillStyle = g; ctx.fillRect(0, 0, n, n);
  }, { srgb: false });
  t.wrapS = t.wrapT = T.ClampToEdgeWrapping;
  return t;
}
function texGlow(key) {
  return makeTex(key, 128, (ctx, n) => {
    const g = ctx.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.12, 'rgba(255,255,255,0.55)'); g.addColorStop(0.4, 'rgba(255,255,255,0.12)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, n, n); ctx.fillStyle = g; ctx.fillRect(0, 0, n, n);
  });
}
// fake room reflection for mirrors in raster (emissive, dim) — the path tracer sees a true metal mirror
function texMirrorFake(key, wall, floor) {
  return makeTex(key, 256, (ctx, n, R, m) => {
    const g = ctx.createLinearGradient(0, 0, 0, m);
    g.addColorStop(0, shade(wall, 0.25)); g.addColorStop(0.55, wall); g.addColorStop(0.8, shade(floor, 0.1)); g.addColorStop(1, shade(floor, -0.2));
    ctx.fillStyle = g; ctx.fillRect(0, 0, n, m);
    const l = ctx.createRadialGradient(n * 0.7, m * 0.08, 0, n * 0.7, m * 0.08, n * 0.55); l.addColorStop(0, 'rgba(255,248,235,0.9)'); l.addColorStop(1, 'rgba(255,248,235,0)');
    ctx.fillStyle = l; ctx.fillRect(0, 0, n, m);
    ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.fillRect(n * 0.12, m * 0.3, n * 0.22, m * 0.55); // door opening behind
    ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(n * 0.55, m * 0.22, n * 0.3, m * 0.3);
  }, { m: 512 });
}
function texRug(key, style, base, accent, { n = 512 } = {}) {
  return makeTex(key, n, (ctx, n, R) => {
    ctx.fillStyle = base; ctx.fillRect(0, 0, n, n);
    if (style === 'lisboa') { // Arraiolos-style border + motifs
      ctx.strokeStyle = shade(accent, 0.55); ctx.lineWidth = 14; ctx.strokeRect(24, 24, n - 48, n - 48);
      ctx.lineWidth = 4; ctx.strokeRect(46, 46, n - 92, n - 92);
      ctx.fillStyle = shade(accent, 0.55);
      for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) { const cx = 96 + i * (n - 192) / 4, cy = 96 + j * (n - 192) / 4; ctx.save(); ctx.translate(cx, cy); ctx.rotate(PI / 4); ctx.fillRect(-12, -12, 24, 24); ctx.restore(); }
      ctx.fillStyle = '#2f4a6b'; for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { ctx.beginPath(); ctx.arc(96 + (i + 0.5) * (n - 192) / 4, 96 + (j + 0.5) * (n - 192) / 4, 8, 0, PI * 2); ctx.fill(); }
    } else if (style === 'noir') { // abstract tonal
      ctx.fillStyle = shade(base, -0.25); ctx.beginPath(); ctx.ellipse(n * 0.3, n * 0.6, n * 0.35, n * 0.2, 0.4, 0, PI * 2); ctx.fill();
      ctx.strokeStyle = shade(accent, 0.1); ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(0, n * 0.3); ctx.bezierCurveTo(n * 0.3, n * 0.1, n * 0.6, n * 0.7, n, n * 0.5); ctx.stroke();
    } else { // jute / wool border
      ctx.strokeStyle = shade(base, -0.12); ctx.lineWidth = 26; ctx.strokeRect(13, 13, n - 26, n - 26);
    }
    for (let i = 0; i < 26000; i++) { ctx.fillStyle = R() < 0.5 ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.09)'; ctx.fillRect(R() * n, R() * n, 2, 2); }
    cloudNoise(ctx, n, 8, 0.12, R);
  }, { size: 1 });
}
function texBooks(key, { n = 256 } = {}) { // not used for geometry colours; spines
  return makeTex(key, n, (ctx, n, R) => { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, n, n); for (let i = 0; i < 12; i++) { ctx.fillStyle = `rgba(0,0,0,${0.05 + R() * 0.1})`; ctx.fillRect(0, R() * n, n, 2 + R() * 6); } }, { size: 1 });
}
function texHob(key, { n = 512 } = {}) {
  return makeTex(key, n, (ctx, n) => {
    ctx.fillStyle = '#0b0b0c'; ctx.fillRect(0, 0, n, n);
    ctx.strokeStyle = 'rgba(200,200,200,0.35)'; ctx.lineWidth = 2;
    for (const [x, y, r] of [[0.27, 0.3, 0.17], [0.73, 0.3, 0.13], [0.27, 0.72, 0.13], [0.73, 0.72, 0.17]]) { ctx.beginPath(); ctx.arc(x * n, y * n, r * n, 0, PI * 2); ctx.stroke(); ctx.beginPath(); ctx.arc(x * n, y * n, r * n * 0.3, 0, PI * 2); ctx.stroke(); }
    ctx.fillStyle = 'rgba(220,220,220,0.5)'; for (let i = 0; i < 6; i++) ctx.fillRect(n * 0.3 + i * n * 0.07, n * 0.93, n * 0.04, 4);
  }, { size: 1, srgb: true });
}
function texScreen(key, { n = 512, m = 288 } = {}) {
  return makeTex(key, n, (ctx, n, R, m) => {
    const g = ctx.createLinearGradient(0, 0, 0, m); g.addColorStop(0, '#6a8fb3'); g.addColorStop(0.55, '#e3b98a'); g.addColorStop(0.6, '#335a78'); g.addColorStop(1, '#0f2233');
    ctx.fillStyle = g; ctx.fillRect(0, 0, n, m);
    ctx.fillStyle = 'rgba(255,230,190,0.9)'; ctx.beginPath(); ctx.arc(n * 0.7, m * 0.5, 18, 0, PI * 2); ctx.fill();
    ctx.fillStyle = '#16222c'; ctx.beginPath(); ctx.moveTo(0, m * 0.6); for (let x = 0; x <= n; x += 8) ctx.lineTo(x, m * 0.6 - (R() * 20 + (x % 64 < 24 ? 16 : 0))); ctx.lineTo(n, m * 0.6); ctx.fill();
  }, { size: 1, m });
}
function texTileGrid(key, base, grout, { tilesX = 4, tilesY = 4, size = 1, n = 512, vary = 0.05 } = {}) {
  return makeTex(key, n, (ctx, n, R) => {
    const tw = n / tilesX, th = n / tilesY;
    for (let j = 0; j < tilesY; j++) for (let i = 0; i < tilesX; i++) { ctx.fillStyle = shade(base, (R() - 0.5) * vary); ctx.fillRect(i * tw, j * th, tw, th); }
    cloudNoise(ctx, n, 10, 0.1, R); grainNoise(ctx, n, 0.03, R);
    ctx.fillStyle = grout; for (let i = 0; i <= tilesX; i++) ctx.fillRect(i * tw - 1.5, 0, 3, n); for (let j = 0; j <= tilesY; j++) ctx.fillRect(0, j * th - 1.5, n, 3);
  }, { size });
}

// ───────────────────────── style definitions ─────────────────────────
function baseDef(id) {
  const S = STYLES.find(s => s.id === id) || STYLES[0], p = S.palette;
  if (id === 'lisboa') return {
    id, p,
    floor: () => texHerringbone('lis-floor', '#80532f', { plankL: 0.56 }),
    floorRough: 0.42,
    bathFloor: () => texHydraulic('lis-hydr', { a: '#b5652e', b: '#2f4a6b', bg: '#efe6d6', size: 0.8 }),
    hallFloor: null,
    bathWall: () => texZellige('lis-zel', '#cfdde9', { size: 0.6, tiles: 6, grout: '#e9e6df' }), bathWallH: 9,
    showerWall: () => texAzulejo('lis-azu', { size: 0.6 }),
    splash: () => texAzulejo('lis-azu', { size: 0.6 }),
    worktop: () => texMarble('lis-marb', '#ece6db', '#8d7f6b', { size: 1.6, count: 6, alpha: 0.45 }),
    wallPaint: '#efe6d8', feature: 'fluted-walnut', featureColor: '#6e452b',
    joinery: '#2f4a6b', joineryTall: '#2f4a6b', joineryWood: false,
    metal: '#b8913f', metalRough: 0.28,
    sofa: '#c9a47a', sofaTex: 'linen', armchair: '#b5652e', cushions: ['#b5652e', '#2f4a6b', '#e6cfa6', '#8a5a3b'], throw: '#b5652e',
    bedding: '#f4efe6', duvet: '#efe6d8', bedThrow: '#b5652e', headboard: '#2f4a6b',
    rug: '#7b3b2a', rugAccent: '#e3c9a3', wood: '#6e452b', woodTex: () => texPlanks('lis-wood', '#6e452b', { size: 1.2, plankW: 0.15, grain: 26, knots: 0.05, gap: 0, gapA: 0, vary: 0.08 }),
    curtain: '#e9dcc4', sheer: '#f5efe4', art: [['#efe6d8', '#b5652e', '#2f4a6b', '#d9a33a'], 1], artPals: [['#efe6d8', '#b5652e', '#2f4a6b', '#d9a33a'], ['#f3ead9', '#1d4b93', '#6e8fb8', '#b5652e'], ['#2f4a6b', '#e8d9bd', '#b5652e', '#d9a33a']], frames: ['metal', 'wood', 'black'], vanityTop: 'marble',
    ceramic: '#fbf8f2', tableTop: 'wood', table: 'round', lamp: '#f3e2c0', pots: '#b5652e', chairFabric: '#2f4a6b', light: 0xffc98a
  };
  if (id === 'noir') return {
    id, p,
    floor: () => texPlanks('noir-floor', '#4a3a2e', { size: 3.2, plankW: 0.22, lenMin: 1.6, lenMax: 2.8, grain: 34, vary: 0.12, gapA: 0.6 }),
    floorRough: 0.5,
    bathFloor: () => texMicrocement('noir-mc', '#5f5c58', { size: 3 }),
    hallFloor: () => texMicrocement('noir-mc', '#4c4b4a', { size: 3 }),
    bathWall: () => texMicrocement('noir-mcw', '#7a756e', { size: 3 }), bathWallH: 9,
    showerWall: () => texMarble('noir-nero', '#151516', '#e6e2da', { size: 1.4, count: 6, width: 1.2, alpha: 0.75 }),
    splash: () => texMarble('noir-nero', '#151516', '#e6e2da', { size: 1.4, count: 6, width: 1.2, alpha: 0.75 }),
    worktop: () => texMarble('noir-nero', '#151516', '#e6e2da', { size: 1.4, count: 6, width: 1.2, alpha: 0.75 }),
    wallPaint: '#c9c2b8', feature: 'microcement', featureColor: '#3b3b3d',
    joinery: '#1f1f21', joineryTall: '#3a2c22', joineryWood: true,
    metal: '#8c6a43', metalRough: 0.35,
    sofa: '#57524c', sofaTex: 'boucle', armchair: '#8c6a43', cushions: ['#a07b4f', '#2b2b2d', '#8a8279', '#c9b79c'], throw: '#a07b4f',
    bedding: '#d9d4cc', duvet: '#5b5650', bedThrow: '#a07b4f', headboard: '#3a2c22',
    rug: '#6b625a', rugAccent: '#a07b4f', wood: '#3a2c22', woodTex: () => texPlanks('noir-wood', '#3f3025', { size: 1.2, plankW: 0.15, grain: 26, knots: 0.05, gap: 0, gapA: 0, vary: 0.08 }),
    curtain: '#4a4541', sheer: '#d8d2ca', art: [['#2b2a29', '#a07b4f', '#d9d2c7', '#6b625a'], 0], artPals: [['#2b2a29', '#a07b4f', '#d9d2c7', '#6b625a'], ['#e9e4dc', '#1f1f21', '#8c6a43', '#57524c'], ['#3b3b3d', '#c9b79c', '#a07b4f', '#e6e2da']], frames: ['black', 'metal', 'woodDark'], vanityTop: 'nero',
    ceramic: '#f2f0ec', tableTop: 'nero', table: 'rect', lamp: '#f0d7b0', pots: '#2b2b2d', chairFabric: '#6b625a', light: 0xffc07a
  };
  return {
    id: 'atlantic', p,
    floor: () => texPlanks('atl-floor', '#d4c09f', { size: 3.2, plankW: 0.22, lenMin: 1.6, lenMax: 2.8, grain: 30, vary: 0.1, gapA: 0.3 }),
    floorRough: 0.55,
    bathFloor: () => texMarble('atl-estremoz-t', '#eeebe5', '#a29d95', { size: 1.2, tiles: 2, grout: '#d6d1c9', count: 7, alpha: 0.5 }),
    hallFloor: null,
    bathWall: () => texZellige('atl-zel', '#f2efe9', { size: 0.6, tiles: 8, grout: '#e2ded7' }), bathWallH: 9,
    showerWall: () => texMarble('atl-estremoz', '#eeebe5', '#a29d95', { size: 1.6, count: 7, alpha: 0.5 }),
    splash: () => texMarble('atl-estremoz', '#eeebe5', '#a29d95', { size: 1.6, count: 7, alpha: 0.5 }),
    worktop: () => texMarble('atl-estremoz', '#eeebe5', '#a29d95', { size: 1.6, count: 7, alpha: 0.5 }),
    wallPaint: '#f3efe8', feature: 'fluted-oak', featureColor: '#d2b88f',
    joinery: '#e9e2d6', joineryTall: '#cdb28a', joineryWood: true,
    metal: '#c9c4bb', metalRough: 0.3,
    sofa: '#e6ded1', sofaTex: 'boucle', armchair: '#cdb28a', cushions: ['#7c93a3', '#f4f0e8', '#c9b79c', '#a9b8c2'], throw: '#b8c4cc',
    bedding: '#fbf9f5', duvet: '#f2eee7', bedThrow: '#7c93a3', headboard: '#e0d6c6',
    rug: '#cfc4b2', rugAccent: '#b9ab94', wood: '#c9a978', woodTex: () => texPlanks('atl-wood', '#c9a978', { size: 1.2, plankW: 0.15, grain: 26, knots: 0.05, gap: 0, gapA: 0, vary: 0.08 }),
    curtain: '#ece5d8', sheer: '#fbf8f2', art: [['#f1ece3', '#7c93a3', '#c9b79c', '#2d4353'], 1], artPals: [['#f1ece3', '#7c93a3', '#c9b79c', '#2d4353'], ['#f5f1ea', '#c9a978', '#9fb1bd', '#6b7f8c'], ['#e8e2d6', '#2d4353', '#b9ab94', '#d8c3a5']], frames: ['wood', 'white', 'black'], vanityTop: 'marble',
    ceramic: '#fbfaf7', tableTop: 'wood', table: 'round', lamp: '#fff1d8', pots: '#d9cfc0', chairFabric: '#e6ded1', light: 0xffd49a
  };
}



const NEW_STYLES = {
  natura: (p) => ({
    floor: () => texPlanks('nat-floor', '#dfd2b8', { size: 3.2, plankW: 0.22, lenMin: 1.6, lenMax: 2.8, grain: 22, vary: 0.07, gapA: 0.25, knots: 0.05 }), floorRough: 0.6,
    bathFloor: () => texMarble('nat-trav', '#dccbb0', '#b9a586', { size: 1.2, count: 5, alpha: 0.35 }), hallFloor: null,
    bathWall: () => texMarble('nat-trav', '#dccbb0', '#b9a586', { size: 1.2, count: 5, alpha: 0.35 }), bathWallH: 9,
    showerWall: () => texMarble('nat-trav', '#dccbb0', '#b9a586', { size: 1.2, count: 5, alpha: 0.35 }),
    splash: () => texMarble('nat-trav', '#dccbb0', '#b9a586', { size: 1.2, count: 5, alpha: 0.35 }),
    worktop: () => texMarble('nat-trav', '#dccbb0', '#b9a586', { size: 1.2, count: 5, alpha: 0.35 }),
    wallPaint: '#ece6da', feature: 'slats', featureColor: '#c6ae86', joinery: '#cdbb9b', joineryTall: '#cdbb9b', joineryWood: true,
    metal: '#2d2c2a', metalRough: 0.45,
    sofa: '#d8cfbf', sofaTex: 'linen', armchair: '#cdbb9b', cushions: ['#8d8a78', '#efe9dc', '#2b2b28', '#bfb39d'], throw: '#b9b3a0',
    bedding: '#f3eee4', duvet: '#e2dccd', bedThrow: '#8d8a78', headboard: '#c6ae86',
    rug: '#bfb39d', rugAccent: '#a39880', wood: '#c6ae86', woodTex: () => texPlanks('nat-wood', '#c6ae86', { size: 1.2, plankW: 0.15, grain: 20, knots: 0.03, gap: 0, gapA: 0, vary: 0.06 }),
    curtain: '#e4dccb', sheer: '#f6f1e6', art: [['#ece6da', '#2b2b28', '#bfb39d', '#8d8a78'], 2], artPals: [['#ece6da', '#2b2b28', '#bfb39d', '#8d8a78'], ['#f3eee4', '#8d8a78', '#c6ae86', '#2b2b28'], ['#d8cfbf', '#2b2b28', '#efe9dc', '#a39880']], frames: ['black', 'wood', 'none'], vanityTop: 'marble',
    ceramic: '#f3f0ea', tableTop: 'wood', table: 'rect', lamp: '#fff3dc', pots: '#3a3936', chairFabric: '#d8cfbf', light: 0xffd6a0
  }),
  riviera: (p) => ({
    floor: () => texMarble('riv-lime', '#e3d9c6', '#c9bda6', { size: 1.8, count: 5, alpha: 0.3 }), floorRough: 0.45,
    bathFloor: () => texMarble('riv-lime', '#e3d9c6', '#c9bda6', { size: 1.8, count: 5, alpha: 0.3 }), hallFloor: null,
    bathWall: () => texZellige('riv-zel', '#4f7f6a', { size: 0.6, tiles: 6, grout: '#e6e0d2' }), bathWallH: 9,
    showerWall: () => texZellige('riv-zel', '#4f7f6a', { size: 0.6, tiles: 6, grout: '#e6e0d2' }),
    splash: () => texZellige('riv-terra', '#c98a5c', { size: 0.6, tiles: 6, grout: '#eadfce' }),
    worktop: () => texMarble('riv-marb', '#f1eee8', '#b5ada0', { size: 1.6, count: 6, alpha: 0.4 }),
    wallPaint: '#f6f2ea', feature: 'arches', featureColor: '#e9e0cf', joinery: '#6f8f7d', joineryTall: '#6f8f7d', joineryWood: false,
    metal: '#b89a5e', metalRough: 0.3,
    sofa: '#efe6d6', sofaTex: 'linen', armchair: '#b98b5a', cushions: ['#c26a3d', '#6f8f7d', '#f3ead9', '#d9b991'], throw: '#d9b991',
    bedding: '#fbf7ef', duvet: '#f3ecdf', bedThrow: '#c26a3d', headboard: '#b98b5a',
    rug: '#d9b991', rugAccent: '#c26a3d', wood: '#b98b5a', woodTex: () => texPlanks('riv-wood', '#b98b5a', { size: 1.2, plankW: 0.15, grain: 26, knots: 0.05, gap: 0, gapA: 0, vary: 0.08 }),
    curtain: '#f1e9da', sheer: '#fbf7ee', art: [['#f6f2ea', '#c26a3d', '#6f8f7d', '#d9b991'], 1], artPals: [['#f6f2ea', '#c26a3d', '#6f8f7d', '#d9b991'], ['#efe6d6', '#4f7f6a', '#c98a5c', '#2f5a6b'], ['#fbf7ee', '#d9a33a', '#c26a3d', '#6f8f7d']], frames: ['wood', 'metal', 'white'], vanityTop: 'marble',
    ceramic: '#fbf8f2', tableTop: 'wood', table: 'round', lamp: '#fdecc8', pots: '#b86a45', chairFabric: '#efe6d6', light: 0xffcf96
  }),
  urban: (p) => ({
    floor: () => texMicrocement('urb-conc', '#9a9790', { size: 3 }), floorRough: 0.35,
    bathFloor: () => texMicrocement('urb-terr', '#cfc8bd', { size: 2 }), hallFloor: null,
    bathWall: () => texMicrocement('urb-terr', '#cfc8bd', { size: 2 }), bathWallH: 9,
    showerWall: () => texMicrocement('urb-terr', '#cfc8bd', { size: 2 }),
    splash: () => texMicrocement('urb-steel', '#9b9c9f', { size: 2 }), worktop: () => texMicrocement('urb-steel', '#9b9c9f', { size: 2 }),
    wallPaint: '#e4e1db', feature: 'brick', featureColor: '#8a5a44', joinery: '#2a2b2d', joineryTall: '#2a2b2d', joineryWood: false,
    metal: '#1f2022', metalRough: 0.5,
    sofa: '#a65a2e', sofaTex: 'linen', armchair: '#3a3a3c', cushions: ['#d8d2c6', '#3a3a3c', '#8a6a4c', '#6d6a66'], throw: '#6d6a66',
    bedding: '#e9e6e0', duvet: '#77746f', bedThrow: '#a65a2e', headboard: '#3a3a3c',
    rug: '#6d6a66', rugAccent: '#a65a2e', wood: '#7a5a3c', woodTex: () => texPlanks('urb-wood', '#7a5a3c', { size: 1.2, plankW: 0.15, grain: 26, knots: 0.08, gap: 0, gapA: 0, vary: 0.1 }),
    curtain: '#5b5b5c', sheer: '#e9e6e0', art: [['#e4e1db', '#1f2022', '#a65a2e', '#6d6a66'], 0], artPals: [['#e4e1db', '#1f2022', '#a65a2e', '#6d6a66'], ['#1f2022', '#e4e1db', '#a65a2e', '#9a9790'], ['#cfc8bd', '#a65a2e', '#2a2b2d', '#7a5a3c']], frames: ['black', 'black', 'none'], vanityTop: 'marble',
    ceramic: '#b9b7b2', tableTop: 'wood', table: 'rect', lamp: '#ffd9a0', pots: '#2a2b2d', chairFabric: '#3a3a3c', light: 0xffb86a
  })
};
function styleDef(id) {
  const kin = KIN[id] || 'atlantic';
  const d = baseDef(kin); d.kin = kin;
  if (NEW_STYLES[id]) { const S = STYLES.find(q => q.id === id); d.p = (S && S.palette) || d.p; Object.assign(d, NEW_STYLES[id](d.p)); d.id = id; }
  return d;
}

// ───────────────────────── real assets (CC0 PBR textures + glTF props) ─────────────────────────
const ASSET_ROOT = (() => { try { return new URL('../', import.meta.url); } catch (e) { return null; } })();
const assetURL = (rel) => new URL(rel, ASSET_ROOT).href;
let MANIFEST = null, MANIFEST_P = null;
function loadManifest() {
  if (MANIFEST_P) return MANIFEST_P;
  MANIFEST_P = (async () => {
    try { const r = await fetch(assetURL('assets/manifest.json')); if (r.ok) MANIFEST = await r.json(); } catch (e) { MANIFEST = null; }
    return MANIFEST;
  })();
  return MANIFEST_P;
}
function pbrEntry(key, styleId) {
  const t = MANIFEST && MANIFEST.textures && MANIFEST.textures[key]; if (!t) return null;
  let e = t[styleId] || t.default, guard = 0;
  while (e && e.ref && guard++ < 5) { const [k, pkg] = e.ref.split('/'); e = MANIFEST.textures[k] && (MANIFEST.textures[k][pkg] || MANIFEST.textures[k].default); }
  return e || null;
}
const TEXP = new Map(); // path|size -> Promise<Texture|null>
let TEXLOADER = null;
function loadMap(path, srgb, size) {
  const k = path + '|' + size.join('x');
  if (TEXP.has(k)) return TEXP.get(k);
  if (!TEXLOADER) TEXLOADER = new T.TextureLoader();
  const p = TEXLOADER.loadAsync(assetURL(path)).then(t => {
    t.wrapS = t.wrapT = T.RepeatWrapping; t.anisotropy = 8;
    t.colorSpace = srgb ? T.SRGBColorSpace : T.NoColorSpace;
    t.repeat.set(1 / (size[0] || 1), 1 / (size[1] || size[0] || 1)); // UVs are world metres
    t.name = path; return t;
  }).catch(() => null);
  TEXP.set(k, p);
  return p;
}
const NSCALE = { 'wall-paint': 0.25, 'ceiling': 0.12, 'skirting': 0.3, 'kitchen-front': 0.4, 'joinery-wardrobe': 0.4, 'door-interior': 0.4, 'sanitary-ceramic': 0.3, 'ceramic-plate': 0.3, 'kitchen-worktop': 0.5 };
const OFFSET = { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 };
// internal material key -> CONTRACT3 vocabulary key, manifest texture key, how to use it.
//   full: albedo+normal+roughness(+ao,+metal), colour = tint || white;  detail: normal+roughness(+ao) only, keep colour;
//   name: vocabulary name only (procedural/emissive/glass)
const VOCAB = {
  floor: ['floor-main', 'full', OFFSET], hallFloor: ['floor-main', 'full', OFFSET], bathFloor: ['bath-floor', 'full', OFFSET],
  wall: ['wall-paint', 'full'], feature: ['wall-feature', 'full'], ceiling: ['ceiling', 'full'], skirting: ['skirting', 'full'],
  bathWall: ['bath-wall', 'full'], showerWall: ['shower-wall', 'full'], splash: ['kitchen-splashback', 'full'], worktop: ['kitchen-worktop', 'full'],
  joinery: ['kitchen-front', 'full'], joineryTall: ['joinery-wardrobe', 'full'],
  wood: ['wood-furniture', 'full'], woodDark: ['wood-furniture', 'full'], oakLight: ['wood-furniture', 'full'],
  metal: ['tap-metal', 'full'], chrome: ['tap-metal', 'full'], lamina: ['tap-metal', 'full'], handle: ['door-handle', 'full'],
  steel: ['appliance-steel', 'full'], appliance: ['appliance-steel', 'detail'], cutlery: ['cutlery-steel', 'detail'],
  blackGlass: ['appliance-glass-black', 'detail'], hob: ['appliance-glass-black', 'name'], tv: ['appliance-glass-black', 'name'],
  ceramic: ['sanitary-ceramic', 'detail'], white: ['sanitary-ceramic', 'detail'], whiteGloss: ['sanitary-ceramic', 'detail'],
  plate: ['ceramic-plate', 'detail'], plate2: ['ceramic-plate', 'detail'], stoneware: ['ceramic-plate', 'detail'],
  sofa: ['fabric-sofa', 'full'], armchair: ['fabric-boucle', 'detail'], chairFabric: ['fabric-linen', 'detail'],
  c0: ['fabric-linen', 'detail'], c1: ['fabric-boucle', 'detail'], c2: ['fabric-linen', 'detail'], c3: ['fabric-boucle', 'detail'],
  throw: ['fabric-boucle', 'detail'], bedding: ['fabric-linen', 'detail'], duvet: ['fabric-linen', 'detail'], bedThrow: ['fabric-boucle', 'detail'],
  headboard: ['fabric-linen', 'detail'], napkin: ['fabric-linen', 'detail'], towel: ['fabric-boucle', 'detail'], towel2: ['fabric-boucle', 'detail'],
  outCushion: ['fabric-linen', 'detail'], curtain: ['curtain-fabric', 'full'], sheer: ['window-sheer', 'full'],
  rug: ['rug', 'detail'], shade: ['lamp-shade', 'detail'], paper: ['book', 'name'], bookM: ['book', 'name'], passepartout: ['art-canvas', 'name'],
  mirror: ['mirror', 'name'], glass: ['shower-glass', 'name'], glassware: ['glass-drinking', 'name'], wine: ['wine', 'name'],
  wax: ['candle-wax', 'name'], flame: ['bulb-emissive', 'name'], bulb: ['bulb-emissive', 'name'], downlight: ['downlight-emissive', 'name'],
  ledStrip: ['led-strip-emissive', 'name'], black: ['metal-furniture', 'name'], matteBlack: ['metal-furniture', 'name'], outdoor: ['metal-furniture', 'detail'],
  deck: ['deck-teak', 'full', OFFSET], teak: ['deck-teak', 'full'], lawn: ['lawn', 'full', OFFSET], soil: ['soil', 'full'], bark: ['bark', 'full'],
  pot: ['pot-terracotta', 'detail'], terracotta: ['pot-terracotta', 'full'],
  leaf: ['plant-leaf', 'name'], leafDark: ['plant-leaf', 'name'], leafLight: ['plant-leaf', 'name'], leaf2: ['plant-leaf', 'name'], grassBlade: ['foliage', 'name'],
  rattan: ['rattan', 'full'], joint: ['floor-joint', 'name'], steelFrame: ['steel-dark', 'name'], paperLamp: ['lamp-shade', 'detail'], cushionFloor: ['fabric-linen', 'detail'], filament: ['bulb-emissive', 'name'], spot: ['downlight-emissive', 'name'],
  fruit: ['fruit', 'name'], rubber: ['rubber', 'name'], contact: ['contact-shadow', 'name'], aoEdge: ['contact-shadow', 'name'], dlGlow: ['light-glow', 'name']
};
// per-package colour multipliers for 'full' textures that are shared between packages
const TINT = {
  lisboa: { wood: '#9a6a48', woodDark: '#5a3a26', teak: '#ffffff' },
  noir: { wood: '#6b5446', woodDark: '#4a3a30', feature: '#9a9894', showerWall: '#a09d99' },
  atlantic: { woodDark: '#6b5446' },
  natura: { woodDark: '#8a7a66', feature: '#f4e6cc' },
  riviera: { woodDark: '#8a6a4a', feature: '#e9cfae' },
  urban: { woodDark: '#6b5446' }
};
const VOCAB_STYLE = {
  urban: { sofa: ['leather', 'full'], armchair: ['fabric-sofa', 'full'], headboard: ['fabric-sofa', 'full'] },
  riviera: { armchair: ['fabric-linen', 'detail'] },
  natura: { armchair: ['fabric-linen', 'detail'] }
};
function vocabOf(k, styleId) {
  if (styleId && VOCAB_STYLE[styleId] && VOCAB_STYLE[styleId][k]) return VOCAB_STYLE[styleId][k];
  if (k.startsWith('tintFab:')) return ['fabric-linen', 'detail'];
  if (k.startsWith('tint:')) return null;
  if (k.startsWith('art:') || k.startsWith('art')) return ['art-canvas', 'name'];
  return VOCAB[k] || null;
}
// apply manifest maps to a material; resolves true when textured
async function applyPBR(m, key, styleId, mode, tint) {
  const e = pbrEntry(key, styleId);
  if (!e || e.procedural || !e.maps) return false;
  const size = e.sizeMeters || [1, 1];
  const want = mode === 'full' ? ['albedo', 'normal', 'roughness', 'ao', 'metal'] : ['normal', 'roughness', 'ao'];
  const got = await Promise.all(want.map(f => e.maps[f] ? loadMap(e.maps[f], f === 'albedo', size) : Promise.resolve(null)));
  const M = Object.fromEntries(want.map((f, i) => [f, got[i]]));
  if (mode === 'full' && !M.albedo) return false;
  if (M.albedo) { m.map = M.albedo; m.color.set(tint || '#ffffff'); }
  if (M.normal && !m.userData.keepNormal) { const ns = NSCALE[key] !== undefined ? NSCALE[key] : 1; m.normalMap = M.normal; m.normalScale = new T.Vector2(ns, ns); }
  if (M.roughness) { m.roughnessMap = M.roughness; m.roughness = m.userData.roughMul || 1; }
  if (M.ao) { m.aoMap = M.ao; m.aoMapIntensity = 0.8; }
  if (M.metal) { m.metalnessMap = M.metal; m.metalness = 1; }
  m.userData.pbr = e.id || key;
  m.needsUpdate = true;
  HQ.delete(m); qualityMat(m, m.userData.qkey || key);
  return true;
}

// glTF props
const MODELS = new Map(); // name -> { parts:[{geometry, material, matrix}], size:Vector3, min:Vector3, center }
const MODEL_P = new Map();
let GLTF = null;
// CC0 models used by the layout (manifest.models); tris in brackets
const MODEL_SET = ['modern_arm_chair_01', 'mid_century_lounge_chair', 'coffee_table_round_01', 'modern_coffee_table_01', 'ceramic_vase_01',
  'standing_picture_frame_01', 'modern_ceiling_lamp_01', 'outdoor_table_chair_set_01', 'potted_plant_04',
  'carved_wooden_plate', 'lemon', 'food_apple_01', 'food_pomegranate_01', 'wooden_cutting_board'];
const MODEL_VOCAB = [[/glass/, 'glass-drinking'], [/artwork/, 'art-canvas'], [/frame/, 'wood-furniture'], [/leaves|plant_04/, 'plant-leaf'], [/pot/, 'pot-terracotta'],
  [/vase/, 'ceramic-plate'], [/globe/, 'bulb-emissive'], [/lamp/, 'metal-furniture'], [/lounge_chair/, 'leather'], [/arm_chair.*pillow/, 'leather'], [/ottoman/i, 'fabric-sofa'],
  [/arm_chair/, 'wood-furniture'], [/coffee_table_round/, 'marble-table'], [/coffee_table/, 'wood-furniture'], [/outdoor.*chair/, 'wood-furniture'], [/outdoor/, 'wood-furniture'],
  [/plate|board|shel|side_table/, 'wood-furniture'], [/apple|lemon|pomegranate/, 'fruit']];
function loadModel(name) {
  if (MODEL_P.has(name)) return MODEL_P.get(name);
  const p = (async () => {
    const info = MANIFEST && MANIFEST.models && MANIFEST.models[name];
    if (!info) return null;
    if (!GLTF) { GLTF = new GLTFLoader(); GLTF.setMeshoptDecoder(MeshoptDecoder); }
    try {
      const g = await GLTF.loadAsync(assetURL(info.file));
      g.scene.updateMatrixWorld(true);
      const parts = [];
      g.scene.traverse(o => {
        if (!o.isMesh) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const mt of mats) {
          if (!mt.userData.vocab) {
            const raw = mt.name || name; let v = 'wood-furniture';
            for (const [re, k] of MODEL_VOCAB) if (re.test(raw.toLowerCase()) || re.test(name.toLowerCase()) && !/glass|artwork/.test(raw)) { v = k; break; }
            if (/glass/.test(raw)) v = 'glass-drinking';
            mt.userData.vocab = v; mt.name = `${v}:${raw}`;
            if (v === 'bulb-emissive') { mt.emissive = new T.Color('#ffe2bd'); mt.emissiveIntensity = 6; MODEL_EMI.push(mt); todMat('bulb', mt); }
            if (mt.map) mt.map.anisotropy = 8;
            MODEL_MATS.add(mt); qualityMat(mt, null);
          }
        }
        parts.push({ geometry: o.geometry, material: Array.isArray(o.material) ? o.material[0] : o.material, matrix: o.matrixWorld.clone() });
      });
      const bb = new T.Box3().setFromObject(g.scene);
      return { parts, size: bb.getSize(new T.Vector3()), min: bb.min.clone(), center: bb.getCenter(new T.Vector3()) };
    } catch (e) { return null; }
  })().then(m => { if (m) MODELS.set(name, m); return m; });
  MODEL_P.set(name, p);
  return p;
}
const hasModel = (n) => MODELS.has(n);
function modelDims(n) { const m = MODELS.get(n); return m ? m.size : null; }

// ───────────────────────── time of day ─────────────────────────
// Emissive materials are shared by all units, so the lighting mood is module state. Factors multiply each material's
// lights-on intensity (userData.emiBase). userData.emissiveTod = absolute intensity per mood (for the exporter).
const TODS = ['day', 'dusk', 'night'];
let TOD = 'day';
const EMI = {
  downlight: { day: 0.1, dusk: 0.9, night: 1 }, spot: { day: 0.1, dusk: 0.9, night: 1 }, ledStrip: { day: 0.08, dusk: 1, night: 1 },
  bulb: { day: 0.06, dusk: 1, night: 1 }, filament: { day: 0.1, dusk: 1, night: 1 }, shade: { day: 0.18, dusk: 0.9, night: 1 },
  paperLamp: { day: 0.18, dusk: 0.9, night: 1 }, flame: { day: 0, dusk: 1, night: 1 }, dlGlow: { day: 0.12, dusk: 0.9, night: 1 },
  mirror: { day: 1, dusk: 0.6, night: 0.4 }, tv: { day: 0.6, dusk: 1, night: 1 }, ceiling: { day: 1, dusk: 0.45, night: 0.22 }
};
const POINT_TOD = { day: 0.35, dusk: 6, night: 9 };      // × lamp intensity (cd)
const POINT_REACH = { day: 1, dusk: 1.6, night: 1.9 };    // × lamp distance
const MODEL_EMI = [];
const MODEL_MATS = new Set();
function todMat(k, m) {
  const f = EMI[k]; if (!f || !m) return;
  const op = k === 'dlGlow';
  if (m.userData.emiBase === undefined) m.userData.emiBase = op ? m.opacity : m.emissiveIntensity;
  const base = m.userData.emiBase, v = base * f[TOD];
  if (op) m.opacity = v; else m.emissiveIntensity = v;
  if (k === 'flame') m.visible = f[TOD] > 0;
  m.userData.emissiveTod = { day: +(base * f.day).toFixed(3), dusk: +(base * f.dusk).toFixed(3), night: +(base * f.night).toFixed(3) };
}
function todAll() {
  for (const api of MATS.values()) for (const k of Object.keys(api.cache)) todMat(k, api.cache[k].m);
  for (const m of MODEL_EMI) todMat('bulb', m);
}

// ───────────────────────── quality (CONTRACT4) ─────────────────────────
// 'low': no normal / roughness / AO maps, 512 px albedo, small props hidden. 'high': everything.
let QUALITY = 'high', RENDERER = null;
const HQ = new WeakMap();      // material -> { map, normalMap, roughnessMap, aoMap, roughness }
const LOWTEX = new WeakMap();  // texture -> 512 px copy
const LOW_ROUGH = { floor: 0.5, hallFloor: 0.5, bathFloor: 0.3, wall: 0.92, ceiling: 0.95, worktop: 0.25, splash: 0.25, bathWall: 0.3, showerWall: 0.22, joinery: 0.5, joineryTall: 0.55, wood: 0.55, woodDark: 0.5, metal: 0.3, chrome: 0.12, steel: 0.3, handle: 0.3, skirting: 0.45, deck: 0.8, teak: 0.7 };
const LOW_HIDE = /int-inst-(bookpg|dlRing)|int-model-(food_|lemon|carved_wooden_plate|standing_picture_frame|wooden_cutting_board)|int-aoEdge/;
function lowTex(t) {
  const img = t && t.image; if (!img || !(img.width > 512)) return t;
  let l = LOWTEX.get(t);
  if (!l) {
    try {
      const c = mkCanvas(512, Math.max(1, Math.round(512 * img.height / img.width))); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      l = new T.CanvasTexture(c); l.wrapS = t.wrapS; l.wrapT = t.wrapT; l.colorSpace = t.colorSpace; l.anisotropy = 4; l.repeat.copy(t.repeat); l.offset.copy(t.offset); l.rotation = t.rotation; l.name = (t.name || '') + '@512';
    } catch (e) { l = t; }
    LOWTEX.set(t, l);
  }
  return l;
}
function qualityMat(m, k) {
  if (!m || !m.isMeshStandardMaterial) return;
  if (k) m.userData.qkey = k;
  const low = QUALITY === 'low';
  let h = HQ.get(m);
  if (low) {
    if (!h) { h = { map: m.map, normalMap: m.normalMap, roughnessMap: m.roughnessMap, aoMap: m.aoMap, roughness: m.roughness }; HQ.set(m, h); }
    const hadMaps = !!(m.normalMap || m.roughnessMap || m.aoMap);
    if (m.roughnessMap) m.roughness = LOW_ROUGH[m.userData.qkey] !== undefined ? LOW_ROUGH[m.userData.qkey] : 0.7;
    m.normalMap = null; m.roughnessMap = null; m.aoMap = null;
    if (h.map) m.map = lowTex(h.map);
    if (hadMaps) m.needsUpdate = true;
  } else if (h) {
    const change = m.normalMap !== h.normalMap || m.roughnessMap !== h.roughnessMap || m.aoMap !== h.aoMap;
    m.map = h.map; m.normalMap = h.normalMap; m.roughnessMap = h.roughnessMap; m.aoMap = h.aoMap; m.roughness = h.roughness;
    HQ.delete(m);
    if (change) m.needsUpdate = true;
  }
}
function qualityAll() {
  for (const api of MATS.values()) { for (const k of Object.keys(api.cache)) qualityMat(api.cache[k].m, k); if (api._pkg) for (const k of Object.keys(api._pkg)) qualityMat(api._pkg[k], null); }
  for (const m of MODEL_MATS) qualityMat(m, null);
}
function qualityRoot(root) {
  const low = QUALITY === 'low';
  root.traverse(o => { if (o.isMesh && LOW_HIDE.test(o.name)) o.visible = !low; });
}
const TEX_SLOTS = ['map', 'normalMap', 'roughnessMap', 'aoMap', 'metalnessMap', 'emissiveMap', 'alphaMap'];
const INITED = new WeakSet();
function uploadTextures(root) { // push every texture of this unit to the GPU now, so walking never triggers an upload
  if (!RENDERER || !RENDERER.initTexture) return 0;
  let n = 0;
  root.traverse(o => {
    if (!o.isMesh) return;
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of ms) for (const sl of TEX_SLOTS) { const t = m && m[sl]; if (t && t.image && !INITED.has(t)) { try { RENDERER.initTexture(t); INITED.add(t); n++; } catch (e) { /* ignore */ } } }
  });
  return n;
}

// ───────────────────────── materials (cached per style) ─────────────────────────
const MATS = new Map();
function std(o) {
  const m = new T.MeshStandardMaterial(o);
  return m;
}
function matFactory(sd) {
  const p = sd.p, wood = () => sd.woodTex();
  const tex = (t, color, extra = {}, ns = 0) => ({ m: std({ map: t, color, ...(ns ? { normalMap: normalOf(t, ns), normalScale: new T.Vector2(1, 1) } : {}), ...extra }), wuv: true });
  const plain = (color, extra = {}) => ({ m: std({ color, ...extra }), wuv: false });
  const fab = (color, boucle, extra = {}) => { const t = texLinen(boucle ? 'boucle' : 'linen', { boucle, size: boucle ? 0.25 : 0.35 }); return { m: std({ color, map: t, normalMap: normalOf(t, boucle ? 5 : 3, 512), normalScale: new T.Vector2(1, 1), roughness: 0.95, ...extra }), wuv: true }; };
  const F = {
    floor: () => tex(sd.floor(), '#ffffff', { roughness: sd.floorRough, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }, sd.kin === 'lisboa' ? 3 : 2.5),
    bathFloor: () => tex(sd.bathFloor(), '#ffffff', { roughness: 0.3, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }, 1.5),
    hallFloor: () => tex((sd.hallFloor || sd.floor)(), '#ffffff', { roughness: 0.5, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }, 2),
    wall: () => tex(texPlaster('plaster'), sd.wallPaint, { roughness: 0.92 }, 1.2),
    ceiling: () => plain(sd.kin === 'noir' ? '#b3aca2' : p.ceiling, { roughness: 0.95 }),
    bathWall: () => tex(sd.bathWall(), '#ffffff', { roughness: 0.25 }, 2.5),
    showerWall: () => tex(sd.showerWall(), '#ffffff', { roughness: 0.18 }, 1.2),
    splash: () => tex(sd.splash(), '#ffffff', { roughness: 0.2 }, 1.2),
    worktop: () => tex(sd.worktop(), '#ffffff', { roughness: 0.22 }, 0.4),
    feature: () => sd.feature === 'microcement' ? tex(texMicrocement('noir-feat', '#3b3b3d', { size: 3 }), '#ffffff', { roughness: 0.8 }, 1)
      : tex(texFluted('flute-' + sd.id, sd.featureColor, { size: 0.5, flutes: 16 }), '#ffffff', { roughness: 0.6 }, 4),
    skirting: () => plain(sd.kin === 'atlantic' ? '#f2efe9' : sd.kin === 'lisboa' ? '#6e452b' : '#3a2c22', { roughness: 0.4 }),
    joinery: () => sd.kin === 'noir' ? plain(p.joinery, { roughness: 0.55 }) : plain(sd.joinery, { roughness: 0.5 }),
    joineryTall: () => sd.joineryWood ? tex(wood(), sd.kin === 'atlantic' ? '#f3e7d2' : '#ffffff', { roughness: 0.6 }, 1.5) : plain(sd.joineryTall, { roughness: 0.5 }),
    wood: () => tex(wood(), '#ffffff', { roughness: 0.55 }, 1.5),
    woodDark: () => tex(texPlanks('darkwood', '#3a281c', { size: 1.2, plankW: 0.15, grain: 26, knots: 0.05, gap: 0, gapA: 0, vary: 0.08 }), '#ffffff', { roughness: 0.5 }),
    oakLight: () => tex(texPlanks('atl-wood', '#c9a978', { size: 1.2, plankW: 0.15, grain: 26, knots: 0.05, gap: 0, gapA: 0, vary: 0.08 }), '#ffffff', { roughness: 0.6 }),
    metal: () => plain(sd.metal, { metalness: 1, roughness: sd.metalRough }),
    steel: () => plain('#c8cacc', { metalness: 1, roughness: 0.28 }),
    chrome: () => plain('#e8e8e8', { metalness: 1, roughness: 0.08 }),
    cutlery: () => plain(sd.kin === 'lisboa' ? '#d8b36a' : sd.kin === 'noir' ? '#3a3633' : '#dcdcdc', { metalness: 1, roughness: sd.kin === 'noir' ? 0.35 : 0.28 }),
    black: () => plain('#1b1b1c', { roughness: 0.45 }),
    matteBlack: () => plain('#222223', { roughness: 0.7, metalness: 0.3 }),
    blackGlass: () => plain('#070708', { roughness: 0.06, metalness: 0.3 }),
    glass: () => plain('#dfe9ea', { transparent: true, opacity: 0.16, roughness: 0.03, metalness: 0.1, depthWrite: false, side: T.DoubleSide }),
    glassware: () => plain('#f4f8f8', { transparent: true, opacity: 0.28, roughness: 0.03, metalness: 0.2, depthWrite: false }),
    wine: () => plain('#5a0d1a', { transparent: true, opacity: 0.85, roughness: 0.05 }),
    mirror: () => ({ m: std({ color: '#ffffff', metalness: 1, roughness: 0.03, emissive: '#ffffff', emissiveMap: texMirrorFake('mirror-' + sd.id, sd.wallPaint, sd.kin === 'noir' ? '#3d3a37' : '#cfc6b8'), emissiveIntensity: 0.55 }), wuv: false }),
    ceramic: () => plain(sd.ceramic, { roughness: 0.12 }),
    plate: () => plain(sd.kin === 'lisboa' ? '#f6f1e6' : sd.kin === 'noir' ? '#2f2e2c' : '#f6f4ef', { roughness: 0.18 }),
    plate2: () => plain(sd.kin === 'lisboa' ? '#2f4a6b' : sd.kin === 'noir' ? '#8b7f73' : '#c9d3d9', { roughness: 0.2 }),
    white: () => plain('#ffffff', { roughness: 0.5 }),
    whiteGloss: () => plain('#f4f4f2', { roughness: 0.15 }),
    appliance: () => plain('#2a2b2d', { roughness: 0.3, metalness: 0.6 }),
    stoneware: () => plain(sd.kin === 'noir' ? '#6e6258' : sd.kin === 'lisboa' ? '#b5652e' : '#e8e2d6', { roughness: 0.6 }),
    sofa: () => fab(sd.sofa, sd.sofaTex === 'boucle'),
    armchair: () => fab(sd.armchair, sd.kin !== 'lisboa'),
    chairFabric: () => fab(sd.chairFabric, false),
    c0: () => fab(sd.cushions[0], false), c1: () => fab(sd.cushions[1], sd.kin === 'atlantic'), c2: () => fab(sd.cushions[2], false), c3: () => fab(sd.cushions[3], true),
    throw: () => fab(sd.throw, true),
    bedding: () => fab(sd.bedding, false), duvet: () => fab(sd.duvet, false), bedThrow: () => fab(sd.bedThrow, true), headboard: () => fab(sd.headboard, false),
    napkin: () => fab(sd.kin === 'noir' ? '#8a8279' : sd.kin === 'lisboa' ? '#e7dcc6' : '#dfe5e8', false),
    towel: () => fab(sd.kin === 'noir' ? '#a39a8f' : sd.kin === 'lisboa' ? '#f1ebe0' : '#ffffff', true),
    towel2: () => fab(sd.kin === 'noir' ? '#3a3633' : sd.kin === 'lisboa' ? '#b5652e' : '#9fb1bd', true),
    rug: () => { const t = texRug('rug-' + sd.id, sd.id, sd.rug, sd.rugAccent); return { m: std({ map: t, normalMap: normalOf(t, 4, 512), roughness: 1, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 }), wuv: false }; },
    curtain: () => fab(sd.curtain, false, { roughness: 1, side: T.DoubleSide }),
    sheer: () => fab(sd.sheer, false, { roughness: 1, side: T.DoubleSide, transparent: true, opacity: 0.6, depthWrite: false }),
    art0: () => ({ m: std({ map: texArt('art0-' + sd.id, sd.art[0], sd.art[1]), roughness: 0.8 }), wuv: false }),
    art1: () => ({ m: std({ map: texArt('art1-' + sd.id, [sd.art[0][0], sd.art[0][2], sd.art[0][1], sd.art[0][3]], (sd.art[1] + 1) % 3), roughness: 0.8 }), wuv: false }),
    art2: () => ({ m: std({ map: texArt('art2-' + sd.id, [sd.art[0][3], sd.art[0][0], sd.art[0][1]], (sd.art[1] + 2) % 3), roughness: 0.8 }), wuv: false }),
    passepartout: () => plain('#f7f5f0', { roughness: 0.9 }),
    downlight: () => plain('#ffffff', { emissive: '#fff1dc', emissiveIntensity: 30, roughness: 1 }),
    dlGlow: () => { const t = texGlow('glow'); return { m: new T.MeshBasicMaterial({ color: '#ffe7c4', map: t, transparent: true, opacity: 0.55, depthWrite: false, blending: T.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 }), wuv: false }; },
    aoEdge: () => { const t = texEdge('aoedge'); return { m: new T.MeshBasicMaterial({ color: '#000000', alphaMap: t, transparent: true, opacity: sd.kin === 'noir' ? 0.4 : 0.3, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 }), wuv: false }; },
    contact: () => { const t = texContact('contact'); return { m: new T.MeshBasicMaterial({ color: '#000000', alphaMap: t, transparent: true, opacity: sd.kin === 'noir' ? 0.5 : 0.42, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 }), wuv: false }; },
    ledStrip: () => plain('#ffffff', { emissive: '#ffd9a8', emissiveIntensity: 6 }),
    shade: () => ({ m: std({ color: sd.lamp, emissive: sd.lamp, emissiveIntensity: 1.4, roughness: 0.9, side: T.DoubleSide, map: texLinen('linen', { size: 0.35 }) }), wuv: true }),
    bulb: () => plain('#fff', { emissive: '#ffcf8a', emissiveIntensity: 40 }),
    flame: () => plain('#ffb347', { emissive: '#ffa53a', emissiveIntensity: 12 }),
    fabricOf: (hex) => fab(hex, false),
    artOf: (spec) => { const [k, pi] = spec.split(':').map(Number); const pal = sd.artPals[pi % sd.artPals.length]; const t = texArt(`art-${sd.id}-${k}-${pi}`, pal, k); return { m: std({ map: t, roughness: 0.85 }), wuv: false }; },
    wax: () => plain(sd.kin === 'noir' ? '#2a2826' : '#f3ece0', { roughness: 0.6 }),
    leaf: () => plain('#4d6d33', { roughness: 0.45, side: T.DoubleSide }),
    leafDark: () => plain('#34502a', { roughness: 0.5, side: T.DoubleSide }),
    leafLight: () => plain('#6f8a45', { roughness: 0.5, side: T.DoubleSide }),
    leaf2: () => plain('#7d8a62', { roughness: 0.7, side: T.DoubleSide }),
    grassBlade: () => plain('#a49a6a', { roughness: 0.8, side: T.DoubleSide }),
    bark: () => plain('#6b5a48', { roughness: 0.95 }),
    pot: () => plain(sd.pots, { roughness: 0.75 }),
    terracotta: () => plain('#b86a45', { roughness: 0.85 }),
    soil: () => plain('#3b2d22', { roughness: 1 }),
    tv: () => ({ m: std({ map: texScreen('tv'), emissive: '#ffffff', emissiveMap: texScreen('tv'), emissiveIntensity: 0.35, roughness: 0.15 }), wuv: false }),
    hob: () => ({ m: std({ map: texHob('hob'), roughness: 0.08, metalness: 0.2 }), wuv: false }),
    lawn: () => tex(texGrass('grass'), '#ffffff', { roughness: 1, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }),
    deck: () => tex(texPlanks('deck', '#9a7556', { size: 2.4, plankW: 0.14, grain: 22, vary: 0.18, gap: 3, gapA: 0.6 }), '#ffffff', { roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }),
    outdoor: () => plain('#3d3f41', { roughness: 0.45, metalness: 0.6 }),
    teak: () => tex(texPlanks('teak', '#9b6d45', { size: 1.2, plankW: 0.07, grain: 20, gap: 1, gapA: 0.4 }), '#ffffff', { roughness: 0.7 }),
    outCushion: () => fab('#e9e3d7', false),
    paper: () => plain('#f1ede4', { roughness: 0.9 }),
    fruit: () => plain('#ffffff', { roughness: 0.45 }),
    bookM: () => plain('#ffffff', { roughness: 0.8 }),
    rubber: () => plain('#101010', { roughness: 0.9 }),
    rattan: () => tex(texLinen('rattan-fb', { size: 0.3 }), '#b08a5c', { roughness: 0.75, side: T.DoubleSide }, 4),
    joint: () => plain(mixHex(p.floor, '#6b6252', 0.45), { roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 }),
    steelFrame: () => plain('#1b1c1e', { roughness: 0.5, metalness: 0.7 }),
    paperLamp: () => ({ m: std({ color: '#fbf3e2', emissive: '#ffe9c4', emissiveIntensity: 1.6, roughness: 0.95, side: T.DoubleSide, map: texLinen('linen', { size: 0.35 }) }), wuv: true }),
    cushionFloor: () => fab(sd.cushions[0], false),
    filament: () => plain('#ffd9a0', { emissive: '#ffb45a', emissiveIntensity: 40, transparent: true, opacity: 0.9, roughness: 0.1 }),
    spot: () => plain('#ffffff', { emissive: '#ffe6c8', emissiveIntensity: 30, roughness: 1 }),
    tint: () => plain('#ffffff', { roughness: 0.55 }),
    lamina: () => plain(sd.kin === 'noir' ? '#a07b4f' : sd.kin === 'lisboa' ? '#b8913f' : '#e8e2d6', { roughness: 0.3, metalness: sd.kin === 'atlantic' ? 0 : 1 })
  };
  return F;
}
const PBR_EXTRA = {
  sheer: () => ({ side: T.DoubleSide, transparent: true, opacity: 0.62, depthWrite: false, roughness: 1 }),
  curtain: () => ({ side: T.DoubleSide }), rattan: () => ({ side: T.DoubleSide }),
  worktop: () => ({ userData: { roughMul: 0.7 } }), splash: () => ({ userData: { roughMul: 0.8 } }),
  bathWall: () => ({ userData: { roughMul: 0.8 } }), showerWall: () => ({ userData: { roughMul: 0.8 } }), bathFloor: () => ({ userData: { roughMul: 0.9 } })
};
function getMats(styleId) {
  if (MATS.has(styleId)) return MATS.get(styleId);
  const sd = styleDef(styleId), F = matFactory(sd), cache = {};
  const pending = [];
  const api = {
    sd, pending, cache,
    get(k) {
      if (!cache[k]) {
        let f = F[k] || F.white; let r;
        if (k.startsWith('tint:')) f = () => ({ m: std({ color: k.slice(5), roughness: 0.55 }), wuv: false });
        else if (k.startsWith('tintFab:')) f = () => F.fabricOf(k.slice(8));
        else if (k.startsWith('art:')) f = () => F.artOf(k.slice(4));
        const voc = vocabOf(k, sd.id) || ['unknown', 'name'];
        const [vkey, mode, flags] = voc;
        const ent = MANIFEST && mode !== 'name' ? pbrEntry(vkey, sd.id) : null;
        const usePBR = !!(ent && !ent.procedural && ent.maps);
        try {
          if (usePBR && mode === 'full') {
            const x = PBR_EXTRA[k] ? PBR_EXTRA[k]() : {};
            const ud = x.userData; delete x.userData;
            r = { m: std({ color: '#d8d4cc', roughness: 0.8, ...(flags || {}), ...x }), wuv: true };
            if (ud) Object.assign(r.m.userData, ud);
          } else r = f();
        } catch (e) { r = { m: std({ color: '#ff00ff' }), wuv: false }; }
        if (usePBR) {
          r.wuv = true;
          if (sd.id === 'noir' && k === 'joinery') { // fluted smoked-oak fronts: keep a vertical flute relief
            try { const ft = texFluted('flute-noir-k', '#5a4a3e', { size: 0.4, flutes: 16 }); r.m.normalMap = normalOf(ft, 4); r.m.userData.keepNormal = true; } catch (e) { /* plain */ }
          }
          const tint = TINT[sd.id] && TINT[sd.id][k];
          const m = r.m;
          pending.push(applyPBR(m, vkey, sd.id, mode, tint).then(ok => {
            if (ok || mode !== 'full') return;
            try { const fb = f().m; m.map = fb.map; m.normalMap = fb.normalMap; m.color.copy(fb.color); m.roughness = fb.roughness; m.metalness = fb.metalness; m.needsUpdate = true; } catch (e) { /* keep flat */ }
          }).catch(() => {}));
        }
        r.m.name = !vocabOf(k, sd.id) ? k : k === vkey ? vkey : `${vkey}:${k}`;
        r.m.userData.vocab = vocabOf(k, sd.id) ? vkey : null; r.m.userData.style = sd.id;
        if (k === 'ceiling') { // raster-only lift: a down-facing surface only sees the hemisphere's ground colour (reads tan)
          const cc = new T.Color(sd.kin === 'noir' ? '#cfc9c0' : (sd.p && sd.p.ceiling) || '#fbfaf7');
          r.m.emissive = cc; r.m.emissiveIntensity = sd.kin === 'noir' ? 0.3 : 0.42; r.m.userData.rasterEmissive = true;
        }
        todMat(k, r.m);
        if (k === 'ceiling') delete r.m.userData.emissiveTod;
        qualityMat(r.m, k);
        cache[k] = r;
      }
      return cache[k];
    }
  };
  api.keys = Object.keys(F).filter(k => k !== 'fabricOf' && k !== 'artOf');
  for (let k = 0; k < ART_KINDS; k++) for (let pi = 0; pi < sd.artPals.length; pi++) api.keys.push(`art:${k}:${pi}`);
  MATS.set(styleId, api);
  return api;
}
// Named, package-resolved material (e.g. 'door-interior', 'door-handle', 'floor-main') for other modules. Textures stream in.
export function getPackageMaterial(vkey, styleId = 'atlantic') {
  const api = getMats(STYLE_IDS.includes(styleId) ? styleId : 'atlantic');
  const k = 'pkg:' + vkey;
  if (!api._pkg) api._pkg = {};
  if (api._pkg[k]) return api._pkg[k];
  const m = std({ color: '#ffffff', roughness: 0.6 }); m.name = vkey; m.userData.vocab = vkey;
  api._pkg[k] = m;
  const p = (MANIFEST ? Promise.resolve(MANIFEST) : loadManifest()).then(() => applyPBR(m, vkey, styleId, 'full')).catch(() => false);
  api.pending.push(p);
  return m;
}

// ───────────────────────── shared base geometries ─────────────────────────
const G = {};
const GC = new Map();
function geo(key, fn) { if (!GC.has(key)) { const g = fn(); for (const n of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(n)) g.deleteAttribute(n); GC.set(key, g); } return GC.get(key); }
function initGeos() {
  G.box = geo('box', () => new T.BoxGeometry(1, 1, 1).translate(0, 0.5, 0));
  G.cyl = geo('cyl', () => new T.CylinderGeometry(1, 1, 1, 24, 1).translate(0, 0.5, 0));
  G.cylHi = geo('cylHi', () => new T.CylinderGeometry(1, 1, 1, 64, 1).translate(0, 0.5, 0));
  G.cyl8 = geo('cyl8', () => new T.CylinderGeometry(1, 1, 1, 10, 1).translate(0, 0.5, 0));
  G.sph = geo('sph', () => new T.SphereGeometry(1, 16, 12));
  G.sphLo = geo('sphLo', () => new T.SphereGeometry(1, 8, 6));
  G.disc = geo('disc', () => new T.CircleGeometry(1, 24).rotateX(-HP));
  G.plane = geo('plane', () => new T.PlaneGeometry(1, 1)); // XY plane facing +z
  G.torus = geo('torus', () => new T.TorusGeometry(1, 0.08, 8, 28));
  G.fplane = geo('fplane', () => new T.PlaneGeometry(1, 1).rotateX(-HP)); // floor-facing quad, uv 0..1
}
function rbox(w, h, d, r) {
  const k = `rb${w.toFixed(2)}|${h.toFixed(2)}|${d.toFixed(2)}|${r.toFixed(3)}`;
  return geo(k, () => new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001)).translate(0, h / 2, 0));
}
function lathe(key, pts, seg = 24) { return geo('la' + key, () => new T.LatheGeometry(pts.map(([x, y]) => new T.Vector2(x, y)), seg)); }
function taper(rt, rb, seg = 24) { return geo(`tp${rt}|${rb}|${seg}`, () => new T.CylinderGeometry(rt, rb, 1, seg, 1).translate(0, 0.5, 0)); }
function extrude(key, shapeFn, depth, bevel = 0) {
  return geo('ex' + key, () => {
    const g = new T.ExtrudeGeometry(shapeFn(), { depth, bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 2, curveSegments: 12 });
    return g;
  });
}

// ───────────────────────── builder ─────────────────────────
class Builder {
  constructor(mats) {
    this.mats = mats; this.parts = new Map(); this.inst = new Map();
    this.stack = [new T.Matrix4()]; this.tmp = new T.Matrix4(); this.q = new T.Quaternion(); this.e = new T.Euler(); this.v = new T.Vector3(); this.s = new T.Vector3();
    this.lights = []; this.extras = [];
  }
  get M() { return this.stack[this.stack.length - 1]; }
  push(x, y, z, ry = 0) { const m = new T.Matrix4().makeRotationY(ry); m.setPosition(x, y, z); this.stack.push(this.M.clone().multiply(m)); return this; }
  pop() { this.stack.pop(); return this; }
  mat(x, y, z, rx, ry, rz, sx, sy, sz) {
    this.e.set(rx, ry, rz, 'YXZ'); this.q.setFromEuler(this.e);
    this.tmp.compose(this.v.set(x, y, z), this.q, this.s.set(sx, sy, sz));
    return this.M.clone().multiply(this.tmp);
  }
  add(g, mk, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
    if (this.sub && g === G.cyl) g = G.cyl8;
    if (!this.parts.has(mk)) this.parts.set(mk, []);
    this.parts.get(mk).push([g, this.mat(x, y, z, rx, ry, rz, sx, sy, sz)]);
  }
  // box: y = bottom
  box(mk, w, h, d, x, y, z, ry = 0, rx = 0, rz = 0) { this.add(G.box, mk, x, y, z, rx, ry, rz, w, h, d); }
  rb(mk, w, h, d, x, y, z, r = 0.02, ry = 0, rx = 0, rz = 0) { this.add(rbox(w, h, d, r), mk, x, y, z, rx, ry, rz); }
  cyl(mk, r, h, x, y, z, lo = false, rx = 0, rz = 0) { this.add(lo ? G.cyl8 : G.cyl, mk, x, y, z, rx, 0, rz, r, h, r); }
  sph(mk, rx_, ry_, rz_, x, y, z, lo = false) { this.add(lo ? G.sphLo : G.sph, mk, x, y, z, 0, 0, 0, rx_, ry_, rz_); }
  // instanced
  I(key, g, mk, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1, color = null) {
    if (color && (mk === 'tint' || mk === 'tintFab')) { mk = mk + ':' + color; color = null; }
    const k = key + '|' + mk;
    if (!this.inst.has(k)) this.inst.set(k, { g, mk, list: [] });
    this.inst.get(k).list.push([this.mat(x, y, z, rx, ry, rz, sx, sy, sz), color]);
  }
  // registers a lamp (world position). Every lamp is exported; at runtime the unit's 2 point lights follow the lamps nearest the camera.
  light(x, y, z, color, intensity, distance, kind = 'lamp') { const v = new T.Vector3(x, y, z).applyMatrix4(this.M); const L = { v, color, intensity, distance, kind, state: 0 }; this.lights.push(L); return L; }
  build(name) {
    const root = new T.Group(); root.name = name;
    for (const [mk, list] of this.parts) {
      const mm = this.mats.get(mk);
      let geos = list.map(([g, m]) => { const c = g.clone(); c.applyMatrix4(m); return c; });
      const anyNI = geos.some(g => !g.index);
      if (anyNI) geos = geos.map(g => g.index ? g.toNonIndexed() : g);
      let merged = null;
      try { merged = mergeGeometries(geos, false); } catch (e) { merged = null; }
      if (!merged) continue;
      if (mm.wuv) worldUV(merged);
      const mesh = new T.Mesh(merged, mm.m); mesh.name = `int-${mk}`;
      mesh.castShadow = !NO_CAST.has(mk); mesh.receiveShadow = !RASTER_ONLY.has(mk); mesh.matrixAutoUpdate = false;
      if (RASTER_ONLY.has(mk)) { mesh.userData.pathTraceIgnore = true; mesh.renderOrder = 1; }
      root.add(mesh);
    }
    for (const [k, o] of this.inst) {
      const mm = this.mats.get(o.mk);
      const im = new T.InstancedMesh(o.g, mm.m, o.list.length); im.name = `int-inst-${k}`;
      im.castShadow = !NO_CAST.has(o.mk.split(':')[0]); im.receiveShadow = !RASTER_ONLY.has(o.mk);
      if (RASTER_ONLY.has(o.mk)) { im.userData.pathTraceIgnore = true; im.renderOrder = 1; }
      o.list.forEach(([m], i) => im.setMatrixAt(i, m));
      im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere(); im.matrixAutoUpdate = false;
      root.add(im);
    }
    const lamps = [...this.lights].sort((p, q) => q.intensity - p.intensity);
    root.userData.lamps = lamps.map(L => ({ kind: L.kind, position: [+L.v.x.toFixed(3), +L.v.y.toFixed(3), +L.v.z.toFixed(3)], color: '#' + new T.Color(L.color).getHexString(), intensity: L.intensity, distance: L.distance }));
    lamps.slice(0, 2).forEach((L, i) => {
      const pl = new T.PointLight(L.color, L.intensity * POINT_TOD[TOD], L.distance * POINT_REACH[TOD], 2); pl.position.copy(L.v); pl.castShadow = false; pl.name = 'int-lamp-light-' + i;
      pl.userData.base = L.intensity; pl.userData.reach = L.distance; pl.userData.lamp = i;
      root.add(pl);
    });
    if (this.models) for (const [name, list] of this.models) {
      const M = MODELS.get(name); if (!M) continue;
      M.parts.forEach((pt, i) => {
        const im = new T.InstancedMesh(pt.geometry, pt.material, list.length); im.name = `int-model-${name}-${i}`;
        list.forEach((mm, j) => im.setMatrixAt(j, mm.clone().multiply(pt.matrix)));
        im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere(); im.matrixAutoUpdate = false;
        im.castShadow = !/glass/.test(pt.material.name); im.receiveShadow = true;
        im.userData.model = name;
        root.add(im);
      });
    }
    root._dyn = [];
    if (this.dyns) {
      const used = new Map(), boxes = new Map();
      for (const rec of this.dyns) { try { const r = makeDyn(rec, this, this.unitId || name, used, boxes); root.add(r.group); root._dyn.push(r); } catch (e) { /* skip */ } }
      for (const [mk, list] of boxes) {
        const im = new T.InstancedMesh(G.box, this.mats.get(mk).m, list.length); im.name = `int-dynbox-${mk}`; im.castShadow = false; im.receiveShadow = true; im.frustumCulled = false; im.matrixAutoUpdate = false;
        im.instanceMatrix.setUsage(T.DynamicDrawUsage);
        for (const e of list) { e.im = im; _dm.multiplyMatrices(e.group.matrix, e.mover.matrix).multiply(e.local); im.setMatrixAt(e.idx, _dm); }
        im.instanceMatrix.needsUpdate = true; root.add(im);
      }
    }
    root._lamps = lamps;
    this.extras.forEach(o => root.add(o));
    return root;
  }
}
const CEIL_GAP = 0.012; // ceiling finish sits 12 mm below BUILDING's slab soffit
const RASTER_ONLY = new Set(['contact', 'dlGlow', 'aoEdge']);
const NO_CAST = new Set(['aoEdge', 'joint', 'paperLamp', 'filament', 'spot', 'skirting', 'contact', 'dlGlow', 'floor', 'bathFloor', 'hallFloor', 'ceiling', 'wall', 'bathWall', 'showerWall', 'feature', 'rug', 'sheer', 'glass', 'glassware', 'wine', 'downlight', 'bulb', 'flame', 'ledStrip', 'lawn', 'deck', 'shade', 'splash']);
// soft contact shadow on the floor under an object (local coords, y = floor)
Builder.prototype.shadow = function (w, d, x = 0, z = 0, ry = 0, y = 0.014) {
  this.add(G.fplane, 'contact', x, y, z, 0, ry, 0, w, 1, d);
};
function worldUV(g) {
  const p = g.attributes.position, n = g.attributes.normal, uv = g.attributes.uv;
  if (!p || !n || !uv) return;
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    if (ay >= ax && ay >= az) uv.setXY(i, p.getX(i), -p.getZ(i));
    else if (ax >= az) uv.setXY(i, p.getZ(i), p.getY(i));
    else uv.setXY(i, p.getX(i), p.getY(i));
  }
  uv.needsUpdate = true;
}

// prefabs: small multi-material objects merged once, placed as InstancedMesh (one per material)
const PREFABS = new Map();
function prefab(name, fn) {
  if (PREFABS.has(name)) return PREFABS.get(name);
  const pb = new Builder({ get: () => ({ m: null, wuv: false }) });
  fn(pb);
  const out = [];
  for (const [mk, list] of pb.parts) {
    let geos = list.map(([g, m]) => { const c = g.clone(); c.applyMatrix4(m); return c; });
    if (geos.some(g => !g.index)) geos = geos.map(g => g.index ? g.toNonIndexed() : g);
    const merged = mergeGeometries(geos, false);
    if (merged) { worldUV(merged); out.push({ mk, g: merged }); }
  }
  PREFABS.set(name, out);
  return out;
}
Builder.prototype.pf = function (name, fn, x, y, z, ry = 0, s = 1, color = null, rx = 0, rz = 0) {
  const parts = prefab(name, fn);
  for (const { mk, g } of parts) this.I(name, g, mk, x, y, z, rx, ry, rz, s, s, s, mk === 'tint' || mk === 'tintFab' ? color : null);
};

// place a glTF prop: fit = { w, d, h } (any subset, uniform scale to the tightest) or { s } absolute scale; anchor: bottom-centre
Builder.prototype.model = function (name, x, y, z, ry = 0, fit = { s: 1 }) {
  const M = MODELS.get(name); if (!M) return 0;
  let s = fit.s || Infinity;
  if (!fit.s) { if (fit.w) s = Math.min(s, fit.w / M.size.x); if (fit.d) s = Math.min(s, fit.d / M.size.z); if (fit.h) s = Math.min(s, fit.h / M.size.y); if (!isFinite(s)) s = 1; }
  const norm = new T.Matrix4().makeScale(s, s, s).multiply(new T.Matrix4().makeTranslation(-M.center.x, -M.min.y, -M.center.z));
  const place = this.mat(x, y, z, 0, ry, 0, 1, 1, 1).multiply(norm);
  if (!this.models) this.models = new Map();
  if (!this.models.has(name)) this.models.set(name, []);
  this.models.get(name).push(place);
  return s;
};

// ───────────────────────── interactables (CONTRACT4) ─────────────────────────
// b.dyn(spec, parts, fx): a tappable object made of 1..n movers (each: pivot p, anim, build(d) in pivot-local coords).
//   anim: ['slide', dx, dy, dz] | ['hinge', 'x'|'y'|'z', angle] | ['scale', 'x'|'y', min] | null
//   part.reveal: only visible while open (drawer boxes, fridge contents);  part.proxy: invisible hit box (no draw call)
//   spec: { id, kind, label (LBL key), sound, range, dur, pulse (auto-off s), lamp (b.light ref), emis ('lamp'|'tv') }
//   fx: [{ type: 'stream'|'shower'|'swirl'|'light', p:[x,y,z], ... }]
const L4 = (en, pt, he, ru) => ({ en, pt, he, ru });
const LBL = {
  drawer: [L4('Open drawer', 'Abrir gaveta', 'פתח מגירה', 'Открыть ящик'), L4('Close drawer', 'Fechar gaveta', 'סגור מגירה', 'Закрыть ящик')],
  cabinet: [L4('Open cupboard', 'Abrir armário', 'פתח ארון', 'Открыть шкаф'), L4('Close cupboard', 'Fechar armário', 'סגור ארון', 'Закрыть шкаф')],
  fridge: [L4('Open fridge', 'Abrir frigorífico', 'פתח מקרר', 'Открыть холодильник'), L4('Close fridge', 'Fechar frigorífico', 'סגור מקרר', 'Закрыть холодильник')],
  freezer: [L4('Open freezer', 'Abrir congelador', 'פתח מקפיא', 'Открыть морозильник'), L4('Close freezer', 'Fechar congelador', 'סגור מקפיא', 'Закрыть морозильник')],
  oven: [L4('Open oven', 'Abrir forno', 'פתח תנור', 'Открыть духовку'), L4('Close oven', 'Fechar forno', 'סגור תנור', 'Закрыть духовку')],
  microwave: [L4('Open microwave', 'Abrir micro-ondas', 'פתח מיקרוגל', 'Открыть микроволновку'), L4('Close microwave', 'Fechar micro-ondas', 'סגור מיקרוגל', 'Закрыть микроволновку')],
  dishwasher: [L4('Open dishwasher', 'Abrir máquina de lavar loiça', 'פתח מדיח', 'Открыть посудомойку'), L4('Close dishwasher', 'Fechar máquina de lavar loiça', 'סגור מדיח', 'Закрыть посудомойку')],
  washer: [L4('Open washing machine', 'Abrir máquina de lavar', 'פתח מכונת כביסה', 'Открыть стиральную машину'), L4('Close washing machine', 'Fechar máquina de lavar', 'סגור מכונת כביסה', 'Закрыть стиральную машину')],
  tap: [L4('Turn on tap', 'Abrir torneira', 'פתח ברז', 'Открыть кран'), L4('Turn off tap', 'Fechar torneira', 'סגור ברז', 'Закрыть кран')],
  shower: [L4('Turn on shower', 'Ligar duche', 'הפעל מקלחת', 'Включить душ'), L4('Turn off shower', 'Desligar duche', 'כבה מקלחת', 'Выключить душ')],
  lid: [L4('Open toilet lid', 'Levantar tampa', 'פתח מכסה אסלה', 'Поднять крышку'), L4('Close toilet lid', 'Baixar tampa', 'סגור מכסה אסלה', 'Опустить крышку')],
  flush: [L4('Flush', 'Descarga', 'הורד מים', 'Смыть'), L4('Flushing…', 'A descarregar…', 'מוריד מים…', 'Смыв…')],
  wardrobe: [L4('Open wardrobe', 'Abrir roupeiro', 'פתח ארון בגדים', 'Открыть шкаф'), L4('Close wardrobe', 'Fechar roupeiro', 'סגור ארון בגדים', 'Закрыть шкаф')],
  lamp: [L4('Switch on lamp', 'Acender candeeiro', 'הדלק מנורה', 'Включить лампу'), L4('Switch off lamp', 'Apagar candeeiro', 'כבה מנורה', 'Выключить лампу')],
  light: [L4('Switch on light', 'Acender luz', 'הדלק אור', 'Включить свет'), L4('Switch off light', 'Apagar luz', 'כבה אור', 'Выключить свет')],
  tv: [L4('Switch on TV', 'Ligar TV', 'הדלק טלוויזיה', 'Включить ТВ'), L4('Switch off TV', 'Desligar TV', 'כבה טלוויזיה', 'Выключить ТВ')],
  curtain: [L4('Open curtains', 'Abrir cortinas', 'פתח וילונות', 'Открыть шторы'), L4('Close curtains', 'Fechar cortinas', 'סגור וילונות', 'Закрыть шторы')],
  blind: [L4('Raise blind', 'Subir estore', 'הרם תריס', 'Поднять штору'), L4('Lower blind', 'Baixar estore', 'הורד תריס', 'Опустить штору')]
};
const DYN_MAX = 60;
Builder.prototype.dyn = function (spec, parts, fx = null) {
  if (!this.dyns) this.dyns = [];
  if (this.sub || this.dyns.length >= DYN_MAX) { // nested or over budget: bake closed, not interactive
    for (const pt of parts) { if (pt.proxy || pt.reveal) continue; const q = pt.p || [0, 0, 0]; this.push(q[0], q[1], q[2], pt.ry || 0); try { pt.build(this); } catch (e) { /* skip */ } this.pop(); }
    return null;
  }
  const rec = { spec, M: this.M.clone(), parts: [], fx: fx || [] };
  for (const pt of parts) {
    const d = new Builder(this.mats); d.sub = true;
    try { pt.build(d); } catch (e) { /* skip part */ }
    rec.parts.push({ p: pt.p || [0, 0, 0], ry: pt.ry || 0, anim: pt.anim || null, reveal: !!pt.reveal, proxy: !!pt.proxy, keep: !!pt.keep, parts: d.parts });
  }
  this.dyns.push(rec);
  return rec;
};
// shared effect resources (created once)
const FX = { water: null, shower: null, swirl: null, gStream: null, gSplash: null, gShower: null, gDisc: null, proxyMat: null, lights: new Map(), active: 0 };
function fxInit() {
  if (FX.water) return;
  const streak = (key, n, dens) => makeTex(key, n, (ctx, n, R) => {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, n, n);
    for (let i = 0; i < dens; i++) { const x = R() * n, y = R() * n, l = n * (0.15 + R() * 0.5), w = 1 + R() * 2.2; ctx.fillStyle = `rgba(255,255,255,${0.25 + R() * 0.6})`; ctx.fillRect(x, y, w, l); ctx.fillRect(x, y - n, w, l); }
  }, { size: 1, srgb: false });
  const wt = streak('fx-water', 128, 90), st = streak('fx-shower', 256, 70);
  wt.repeat.set(2, 1.5); st.repeat.set(3, 1.2);
  const mk = (t, op, col) => { const m = new T.MeshBasicMaterial({ color: col, alphaMap: t, transparent: true, opacity: op, depthWrite: false, side: T.DoubleSide }); m.name = 'water-fx'; m.userData.vocab = 'water'; return m; };
  FX.water = mk(wt, 0.75, '#e6f4f8'); FX.shower = mk(st, 0.6, '#eef7fa');
  const sw = makeTex('fx-swirl', 128, (ctx, n) => {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, n, n); ctx.translate(n / 2, n / 2); ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineCap = 'round';
    for (let a = 0; a < 3; a++) { ctx.lineWidth = 5; ctx.beginPath(); for (let t = 0; t < 1; t += 0.02) { const r = t * n * 0.46, th = a * PI * 2 / 3 + t * 5.5; ctx.lineTo(Math.cos(th) * r, Math.sin(th) * r); } ctx.stroke(); }
    const g = ctx.createRadialGradient(0, 0, n * 0.2, 0, 0, n * 0.5); g.addColorStop(0, 'rgba(255,255,255,0.35)'); g.addColorStop(1, 'rgba(255,255,255,0)'); ctx.fillStyle = g; ctx.fillRect(-n / 2, -n / 2, n, n);
  }, { size: 1, srgb: false });
  FX.swirl = new T.MeshBasicMaterial({ color: '#d9eef5', alphaMap: sw, transparent: true, opacity: 0.85, depthWrite: false }); FX.swirl.name = 'water-fx'; FX.swirl.userData.vocab = 'water';
  FX.pool = new T.MeshStandardMaterial({ color: '#cfe6ee', transparent: true, opacity: 0.45, roughness: 0.05, metalness: 0.2, depthWrite: false }); FX.pool.name = 'water'; FX.pool.userData.vocab = 'water';
  FX.gStream = new T.CylinderGeometry(0.75, 1, 1, 10, 1, true).translate(0, -0.5, 0);
  FX.gSplash = new T.RingGeometry(0.35, 1, 18).rotateX(-HP);
  const cyl = new T.CylinderGeometry(1, 1.25, 1, 14, 1, true).translate(0, -0.5, 0), p1 = new T.PlaneGeometry(2.2, 1).translate(0, -0.5, 0), p2 = p1.clone().rotateY(HP), cy2 = new T.CylinderGeometry(0.5, 0.65, 1, 10, 1, true).translate(0, -0.5, 0);
  FX.gShower = mergeGeometries([cyl, cy2, p1, p2].map(g => g.toNonIndexed()), false);
  FX.gDisc = new T.CircleGeometry(1, 24).rotateX(-HP);
  FX.proxyMat = new T.MeshBasicMaterial({ visible: false }); FX.proxyMat.name = 'proxy';
}
function fxLightMat(color, intensity) {
  const k = color + '|' + intensity;
  if (!FX.lights.has(k)) { const m = new T.MeshStandardMaterial({ color: '#ffffff', emissive: color, emissiveIntensity: intensity, roughness: 1 }); m.name = 'led-strip-emissive:appliance'; m.userData.vocab = 'led-strip-emissive'; FX.lights.set(k, m); }
  return FX.lights.get(k);
}
// lights-on / lights-off variants of the shared (time-of-day driven) emissive materials, for individually switched lamps
const VARIANTS = new WeakMap();
function variantOf(m, on) {
  let v = VARIANTS.get(m);
  if (!v) { v = { on: null, off: null }; VARIANTS.set(m, v); }
  const k = on ? 'on' : 'off';
  if (!v[k]) {
    const ud = m.userData; m.userData = {};
    const c = m.clone(); m.userData = ud;
    c.userData = { vocab: ud.vocab, style: ud.style, variant: k };
    c.name = m.name;
    const base = ud.emiBase !== undefined ? ud.emiBase : m.emissiveIntensity;
    if (on) c.emissiveIntensity = base; else { c.emissiveIntensity = 0; if (c.emissiveMap) { c.emissiveMap = null; c.map = null; c.color.set('#050506'); c.roughness = 0.12; } }
    v[k] = c;
  }
  return v[k];
}
const EMIS_KEYS = new Set(['shade', 'bulb', 'paperLamp', 'filament', 'ledStrip', 'tv', 'spot']);
const DYN_BOX = new Set(['metal', 'steel', 'black']);
const _dm = new THREE_NS.Matrix4();
function makeDyn(rec, b, unitId, used, boxes) {
  fxInit();
  const spec = rec.spec, mats = b.mats;
  let id = `${spec.id}-${unitId}`; { const n = (used.get(id) || 0) + 1; used.set(id, n); if (n > 1) id = `${spec.id}-${n}-${unitId}`; }
  const group = new T.Group(); group.name = 'int-dyn-' + id; group.matrixAutoUpdate = false; group.matrix.copy(rec.M); group.matrix.decompose(group.position, group.quaternion, group.scale);
  const r = { id, kind: spec.kind, group, movers: [], reveal: [], emis: [], fx: [], inst: [], t: 0, target: 0, dur: spec.dur || 0.55, pulse: spec.pulse || 0, pulseT: 0, lamp: spec.lamp || null, state: 0, emisMode: spec.emis || null, it: null, dirty: false };
  for (const pt of rec.parts) {
    const mover = new T.Group(); mover.position.set(pt.p[0], pt.p[1], pt.p[2]); mover.rotation.y = pt.ry; mover.matrixAutoUpdate = false; mover.updateMatrix();
    for (const [mk, list] of pt.parts) {
      if (boxes && !pt.reveal && !pt.proxy && DYN_BOX.has(mk) && list.every(([g]) => g === G.box)) { // handles & trims: one InstancedMesh per unit
        if (!boxes.has(mk)) boxes.set(mk, []);
        for (const [, m] of list) { const e = { mover, local: m, group, idx: boxes.get(mk).length, im: null }; boxes.get(mk).push(e); r.inst.push(e); }
        continue;
      }
      let geos = list.map(([g, m]) => { const c = g.clone(); c.applyMatrix4(m); return c; });
      if (geos.some(g => !g.index)) geos = geos.map(g => g.index ? g.toNonIndexed() : g);
      let merged = null; try { merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false); } catch (e) { merged = null; }
      if (!merged) continue;
      const mm = pt.proxy ? { m: FX.proxyMat, wuv: false } : mats.get(mk);
      if (mm.wuv) worldUV(merged);
      const mesh = new T.Mesh(merged, mm.m); mesh.name = `int-dyn-${mk}`; mesh.castShadow = false; mesh.receiveShadow = !pt.proxy; mesh.matrixAutoUpdate = false;
      if (pt.proxy) mesh.userData.pathTraceIgnore = true;
      if (pt.reveal) { mesh.visible = false; r.reveal.push(mesh); }
      if (spec.emis && EMIS_KEYS.has(mk.split(':')[0])) { mesh.userData.baseMat = null; r.emis.push({ mesh, base: mm.m }); }
      mover.add(mesh);
    }
    group.add(mover);
    if (pt.anim) r.movers.push({ o: mover, a: pt.anim, px: pt.p[0], py: pt.p[1], pz: pt.p[2], ry: pt.ry });
  }
  for (const f of rec.fx) {
    let mesh = null, extra = null;
    if (f.type === 'stream') {
      mesh = new T.Mesh(FX.gStream, FX.water); mesh.position.set(f.p[0], f.p[1], f.p[2]); mesh.scale.set(f.r || 0.007, f.h, f.r || 0.007);
      extra = new T.Mesh(FX.gSplash, FX.water); extra.position.set(f.p[0], f.p[1] - f.h + 0.004, f.p[2]); extra.scale.setScalar(f.splash || 0.045);
    } else if (f.type === 'shower') { mesh = new T.Mesh(FX.gShower, FX.shower); mesh.position.set(f.p[0], f.p[1], f.p[2]); mesh.scale.set(f.r, f.h, f.r); }
    else if (f.type === 'swirl') { mesh = new T.Mesh(FX.gDisc, FX.swirl); mesh.position.set(f.p[0], f.p[1], f.p[2]); mesh.scale.set(f.r, 1, f.r * (f.sz || 1)); }
    else if (f.type === 'light') { mesh = new T.Mesh(G.plane, fxLightMat(f.color || '#f4f8ff', f.intensity || 2.5)); mesh.position.set(f.p[0], f.p[1], f.p[2]); mesh.rotation.y = f.ry || 0; if (f.rx) mesh.rotation.x = f.rx; mesh.scale.set(f.w, f.h, 1); }
    if (!mesh) continue;
    for (const m of [mesh, extra]) { if (!m) continue; m.visible = false; m.castShadow = false; m.receiveShadow = false; m.raycast = () => {}; m.name = 'int-fx-' + f.type; if (f.type !== 'light') { m.userData.pathTraceIgnore = true; m.renderOrder = 2; } m.updateMatrix(); m.matrixAutoUpdate = f.type === 'swirl' || m === extra; group.add(m); }
    r.fx.push({ type: f.type, mesh, extra, h: f.h || 0, base: f.splash || 0.045 });
  }
  const lbl = LBL[spec.label] || LBL.cabinet;
  const it = {
    id, kind: spec.kind, label: lbl[0], range: spec.range || 2.6, sound: spec.sound,
    toggle() { dynToggle(r); }, isOn() { return dynIsOn(r); }
  };
  if (!it.sound) delete it.sound;
  r.it = it; r.lbl = lbl;
  group.userData.interact = it;
  return r;
}
function dynIsOn(r) {
  if (r.emisMode === 'lamp') return r.state === 1 || (r.state === 0 && TOD !== 'day');
  if (r.emisMode === 'tv') return r.state !== -1;
  return r.target > 0.5;
}
function dynApplyEmis(r) {
  const on = dynIsOn(r);
  for (let i = 0; i < r.emis.length; i++) { const e = r.emis[i]; e.mesh.material = r.state === 0 ? e.base : variantOf(e.base, on); }
  if (r.lamp) r.lamp.state = r.state;
  r.it.label = r.lbl[on ? 1 : 0];
}
function dynToggle(r) {
  if (r.emisMode) {
    const on = dynIsOn(r);
    r.state = r.emisMode === 'tv' ? (on ? -1 : 0) : (on ? -1 : 1);
    dynApplyEmis(r);
    return;
  }
  if (r.pulse) { if (r.pulseT > 0) return; r.pulseT = r.pulse; r.target = 1; }
  else r.target = r.target > 0.5 ? 0 : 1;
  r.it.label = r.lbl[r.target > 0.5 ? 1 : 0];
  r.dirty = true;
}
function dynPose(r) {
  const t = r.t, e = t * t * (3 - 2 * t);
  for (let i = 0; i < r.movers.length; i++) {
    const m = r.movers[i], a = m.a, o = m.o;
    if (a[0] === 'slide') o.position.set(m.px + a[1] * e, m.py + a[2] * e, m.pz + a[3] * e);
    else if (a[0] === 'hinge') { if (a[1] === 'y') o.rotation.y = m.ry + a[2] * e; else if (a[1] === 'x') o.rotation.x = a[2] * e; else o.rotation.z = a[2] * e; }
    else if (a[0] === 'scale') { const v = 1 + (a[2] - 1) * e; if (a[1] === 'x') o.scale.x = v; else o.scale.y = v; }
    o.updateMatrix();
  }
  for (let i = 0; i < r.inst.length; i++) { const e = r.inst[i]; _dm.multiplyMatrices(e.group.matrix, e.mover.matrix).multiply(e.local); e.im.setMatrixAt(e.idx, _dm); e.im.instanceMatrix.needsUpdate = true; }
  const vis = t > 0.004;
  for (let i = 0; i < r.reveal.length; i++) r.reveal[i].visible = vis;
  for (let i = 0; i < r.fx.length; i++) { const f = r.fx[i]; f.mesh.visible = vis; if (f.extra) f.extra.visible = t > 0.6; if (f.type === 'stream') { f.mesh.scale.y = Math.max(0.001, f.h * Math.min(1, t * 1.6)); f.mesh.updateMatrix(); } }
}
// advance one unit's interactables; returns true while water is running (so the shared textures scroll)
function dynUpdate(list, dt, time) {
  let water = false;
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (r.pulseT > 0) { r.pulseT -= dt; if (r.pulseT <= 0) { r.pulseT = 0; r.target = 0; r.it.label = r.lbl[0]; } }
    if (r.t !== r.target) {
      const step = dt / r.dur;
      r.t = r.target > r.t ? Math.min(r.target, r.t + step) : Math.max(r.target, r.t - step);
      dynPose(r);
    }
    if (r.t > 0 && r.fx.length) {
      for (let k = 0; k < r.fx.length; k++) {
        const f = r.fx[k];
        if (f.type === 'light') continue;
        water = true;
        if (f.extra && f.extra.visible) { const s = f.base * (1 + 0.22 * Math.sin(time * 23 + i)); f.extra.scale.set(s, s, s); }
        if (f.type === 'swirl') { f.mesh.rotation.y = -time * 7; }
      }
    }
  }
  return water;
}

// ───────────────────────── plan analysis ─────────────────────────
const V2 = (x, z) => ({ x, z });
function polyArea(poly) { let a = 0; for (let i = 0; i < poly.length; i++) { const [x1, z1] = poly[i], [x2, z2] = poly[(i + 1) % poly.length]; a += x1 * z2 - x2 * z1; } return a / 2; }
function centroid(poly) { let x = 0, z = 0; poly.forEach(p => { x += p[0]; z += p[1]; }); return V2(x / poly.length, z / poly.length); }
function pip(x, z, poly) {
  let ins = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) ins = !ins;
  }
  return ins;
}
const PASS = new Set(['door', 'entry', 'opening', 'glassdoor', 'elevator', 'main', 'gap']);
// For each polygon edge: which walls lie along it and where their openings are
function analyseRoom(room, walls) {
  const poly = room.poly, sign = Math.sign(polyArea(poly)) || 1, sides = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz);
    if (len < 0.05) continue;
    const ux = dx / len, uz = dz / len;
    // inward normal: polygon orientation (area sign) in x/z plane
    const nx = -uz * sign, nz = ux * sign;
    const covered = [], openings = [], faces = []; let mansard = false;
    for (const w of walls) {
      const wdx = w.b[0] - w.a[0], wdz = w.b[1] - w.a[1], wl = Math.hypot(wdx, wdz);
      const wux = wdx / wl, wuz = wdz / wl;
      if (Math.abs(wux * uz - wuz * ux) > 0.02) continue; // not parallel
      const sdist = (w.a[0] - a[0]) * nx + (w.a[1] - a[1]) * nz, dist = Math.abs(sdist);
      if (dist > w.t / 2 + 0.22) continue;
      const inset = sdist > w.t / 2 + 0.03 ? sdist - w.t / 2 : 0; // wall face lies inside the polygon
      // project wall onto edge
      const pa = (w.a[0] - a[0]) * ux + (w.a[1] - a[1]) * uz, pb = (w.b[0] - a[0]) * ux + (w.b[1] - a[1]) * uz;
      const s0 = Math.max(0, Math.min(pa, pb)), s1 = Math.min(len, Math.max(pa, pb));
      if (s1 - s0 < 0.05) continue;
      covered.push([s0 - 0.25, s1 + 0.25]);
      faces.push({ s0, s1, inset });
      if (w.mansard) mansard = true;
      const dirSame = (wux * ux + wuz * uz) > 0;
      for (const o of w.openings || []) {
        let o0 = dirSame ? pa + o.from : pa - o.to, o1 = dirSame ? pa + o.to : pa - o.from;
        if (!dirSame) { o0 = pa - o.to; o1 = pa - o.from; }
        const q0 = Math.max(0, o0), q1 = Math.min(len, o1);
        if (q1 - q0 > 0.05) openings.push({ s0: q0, s1: q1, type: o.type });
      }
    }
    // gaps: parts of the edge without any wall
    covered.sort((p, q) => p[0] - q[0]);
    let cur = 0; const gaps = [];
    for (const [c0, c1] of covered) { if (c0 > cur + 0.05) gaps.push([cur, Math.min(c0, len)]); cur = Math.max(cur, c1); }
    if (cur < len - 0.05) gaps.push([cur, len]);
    for (const [g0, g1] of gaps) if (g1 - g0 > 0.3) openings.push({ s0: Math.max(0, g0), s1: Math.min(len, g1), type: 'gap' });
    sides.push({ i, a: V2(a[0], a[1]), b: V2(b[0], b[1]), len, u: V2(ux, uz), n: V2(nx, nz), openings, faces, hasWall: covered.length > 0, mansard });
  }
  // walls that intrude into the polygon become obstacles
  const obst = [];
  for (const w of walls) {
    const dx = w.b[0] - w.a[0], dz = w.b[1] - w.a[1], l = Math.hypot(dx, dz);
    const ob = obb((w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2, l / 2, w.t / 2 + 0.01, dx / l, dz / l, 'wall');
    if (ob.corners.some(([x, z]) => pip(x, z, poly)) || pip(ob.cx, ob.cz, poly)) {
      // only keep if it is really inside (not the boundary walls touching the edge)
      const inner = inflate(ob, -0.03);
      if (inner.corners.some(([x, z]) => pip(x, z, poly))) obst.push(ob);
    }
  }
  // clear zones in front of passable openings (doors swing / path)
  const zones = [];
  for (const sd of sides) for (const o of sd.openings) {
    if (!PASS.has(o.type)) continue;
    const w = o.s1 - o.s0;
    const depth = o.type === 'glassdoor' ? 0.75 : o.type === 'gap' || o.type === 'opening' ? 0.9 : Math.min(1.05, w + 0.15);
    zones.push(rectOnSide(sd, o.s0 - 0.08, o.s1 + 0.08, 0, depth, o.type));
  }
  return { room, sides, zones, obst, c: centroid(poly), area: Math.abs(polyArea(poly)) };
}
// oriented rect from side param range and depth range: returns {cx,cz,hw,hd,ux,uz,nx,nz,ry, corners}
function rectOnSide(sd, s0, s1, d0, d1, tag) {
  const sm = (s0 + s1) / 2, dm = (d0 + d1) / 2;
  const cx = sd.a.x + sd.u.x * sm + sd.n.x * dm, cz = sd.a.z + sd.u.z * sm + sd.n.z * dm;
  return obb(cx, cz, (s1 - s0) / 2, (d1 - d0) / 2, sd.u.x, sd.u.z, tag, sd.n.x, sd.n.z);
}
// oriented rect; (ux,uz) = width axis, (fx,fz) = facing (front) direction
function obb(cx, cz, hw, hd, ux, uz, tag, fx = null, fz = null) {
  let nx = -uz, nz = ux;
  if (fx !== null && nx * fx + nz * fz < 0) { nx = -nx; nz = -nz; }
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => [cx + ux * hw * i + nx * hd * j, cz + uz * hw * i + nz * hd * j]);
  return { cx, cz, hw, hd, ux, uz, nx, nz, corners, tag };
}
function inflate(r, m) { return obb(r.cx, r.cz, Math.max(0.01, r.hw + m), Math.max(0.01, r.hd + m), r.ux, r.uz, r.tag, r.nx, r.nz); }
function obbHit(A, B) {
  const axes = [[A.ux, A.uz], [A.nx, A.nz], [B.ux, B.uz], [B.nx, B.nz]];
  for (const [ax, az] of axes) {
    let a0 = 1e9, a1 = -1e9, b0 = 1e9, b1 = -1e9;
    for (const [x, z] of A.corners) { const p = x * ax + z * az; a0 = Math.min(a0, p); a1 = Math.max(a1, p); }
    for (const [x, z] of B.corners) { const p = x * ax + z * az; b0 = Math.min(b0, p); b1 = Math.max(b1, p); }
    if (a1 <= b0 + 1e-4 || b1 <= a0 + 1e-4) return false;
  }
  return true;
}
function rectInPoly(r, poly, inset = 0.0) {
  const q = inset ? inflate(r, -inset) : r;
  const c = q.corners;
  for (let i = 0; i < 4; i++) {
    const [x0, z0] = c[i], [x1, z1] = c[(i + 1) % 4];
    if (!pip(x0, z0, poly) || !pip((x0 + x1) / 2, (z0 + z1) / 2, poly)) return false;
  }
  return pip(r.cx, r.cz, poly);
}

// Placement context for one room
class Planner {
  constructor(an) { this.an = an; this.occ = [...an.obst]; this.poly = an.room.poly; }
  blocked(r, { ignoreZones = false, margin = 0 } = {}) {
    if (!rectInPoly(r, this.poly, 0.02)) return true;
    const rr = margin ? inflate(r, margin) : r;
    if (!ignoreZones) for (const z of this.an.zones) if (obbHit(r, z)) return true;
    for (const o of this.occ) if (obbHit(rr, o)) return true;
    return false;
  }
  // Items backed against a side. w along wall, d depth. tall: can't overlap windows/any opening.
  // opts.score(sd, s, rect) → higher better
  // clear height check (mansard): every corner and edge midpoint must have ≥ h headroom
  fitsH(r, h) {
    if (CUR_FLOOR !== 'second' || !h) return true;
    const c = r.corners;
    for (let i = 0; i < 4; i++) {
      const [x0, z0] = c[i], [x1, z1] = c[(i + 1) % 4];
      if (mansardH(x0, z0, CUR_FLOOR) < h || mansardH((x0 + x1) / 2, (z0 + z1) / 2, CUR_FLOOR) < h) return false;
    }
    return true;
  }
  againstWall({ w, d, tall = true, gapOK = false, sides = null, score = null, step = 0.05, margin = 0, back = 0.0, exclude = null, h = null }) {
    let best = null;
    const hh = h === null ? (tall ? 2.3 : 0.9) : h;
    for (const sd of this.an.sides) {
      if (!sd.hasWall || sd.len < w + 0.02) continue;
      if (sides && !sides(sd)) continue;
      if (exclude && exclude.includes(sd)) continue;
      for (let s = 0; s <= sd.len - w + 1e-6; s += step) {
        const s0 = s, s1 = s + w;
        let bad = false;
        for (const o of sd.openings) {
          if (o.s1 <= s0 + 0.02 || o.s0 >= s1 - 0.02) continue;
          if (o.type === 'window' && !tall) continue;
          if (o.type === 'gap' && gapOK) continue;
          bad = true; break;
        }
        if (bad) continue;
        // under the mansard: slide the item away from the slope until it fits (max 0.9 m)
        let r = null, bk = back;
        for (; bk <= back + (CUR_FLOOR === 'second' ? 0.9 : 0) + 1e-6; bk += 0.05) {
          const q = rectOnSide(sd, s0, s1, bk, bk + d, 'item');
          if (this.fitsH(q, hh)) { r = q; break; }
        }
        if (!r) continue;
        if (this.blocked(r, { margin })) continue;
        const sc = (score ? score(sd, (s0 + s1) / 2, r) : -Math.abs((s0 + s1) / 2 - sd.len / 2)) - (bk - back) * 1.5;
        if (!best || sc > best.sc) best = { sc, sd, s0, s1, r, back: bk };
      }
    }
    return best;
  }
  free({ w, d, score, margin = 0.0, angles = null, step = 0.1, h = 0.9 }) {
    let best = null; const poly = this.poly;
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9; poly.forEach(([x, z]) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); });
    const angs = angles || [[1, 0], [0, 1]];
    for (let x = x0; x <= x1; x += step) for (let z = z0; z <= z1; z += step) for (const [ux, uz] of angs) {
      const r = obb(x, z, w / 2, d / 2, ux, uz, 'free');
      if (this.blocked(r, { margin }) || !this.fitsH(r, h)) continue;
      const sc = score(r);
      if (!best || sc > best.sc) best = { sc, r };
    }
    return best;
  }
  take(r) { this.occ.push(r); return r; }
}
// convert a planner rect to placement (position + rotation). Object local: x along width, +z = front (into room)
function placeOf(r) { return { x: r.cx, z: r.cz, ry: Math.atan2(r.nx, r.nz) }; }

// ───────────────────────── furniture library (local: x = width, +z = front, y = up, origin floor centre) ─────────────────────────
function F_rug(b, w, d) { b.add(G.box, 'rug', 0, 0.0, 0, 0, 0, 0, w, 0.012, d); }
function F_art(b, w, h, y, k = 'art0', frame = 'black') {
  if (frame === 'none') { // gallery-wrapped canvas
    b.box('white', w, h, 0.03, 0, y - h / 2, 0.015);
    b.add(G.plane, k, 0, y, 0.0305, 0, 0, 0, w - 0.004, h - 0.004, 1);
    return;
  }
  const fw = frame === 'metal' ? 0.018 : 0.03;
  b.box(frame, w, h, 0.035, 0, y - h / 2, 0.0175);
  b.box('passepartout', w - fw * 2, h - fw * 2, 0.004, 0, y - h / 2 + fw, 0.036);
  const inset = Math.min(0.1, w * 0.12);
  b.add(G.plane, k, 0, y, 0.0405, 0, 0, 0, w - 2 * inset, h - 2 * inset, 1);
}
function F_tv(b, y = 1.25, big = true) {
  const w = big ? 1.45 : 1.23, h = big ? 0.83 : 0.71;
  b.dyn({ id: 'living-tv', kind: 'tv', label: 'tv', sound: 'click', emis: 'tv', range: 4 }, [
    { p: [0, y, 0], build: (d) => { d.box('black', w, h, 0.03, 0, -h / 2, 0.035); d.add(G.plane, 'tv', 0, 0, 0.0505, 0, 0, 0, w - 0.02, h - 0.02, 1); } }
  ]);
}
function F_vase(b, x, y, z, s = 1, stems = true, body = true) {
  const g = lathe('vase', [[0, 0], [0.05, 0], [0.07, 0.04], [0.075, 0.1], [0.055, 0.18], [0.03, 0.24], [0.034, 0.27], [0.03, 0.27], [0.0, 0.26]]);
  if (body) b.add(g, 'stoneware', x, y, z, 0, 0, 0, s, s, s);
  if (stems) for (let i = 0; i < 7; i++) {
    const a = i * 2.4, t = 0.18 + (i % 3) * 0.08;
    b.add(G.cyl8, 'grassBlade', x, y + 0.24 * s, z, Math.cos(a) * t, 0, Math.sin(a) * t, 0.003, 0.5 + (i % 3) * 0.12, 0.003);
    const hx = x + Math.sin(Math.sin(a) * t) * 0.55, hz = z - Math.sin(Math.cos(a) * t) * 0.55;
    b.sph('grassBlade', 0.02, 0.09, 0.02, x + (hx - x) * 1.05, y + 0.24 * s + (0.5 + (i % 3) * 0.12) * Math.cos(t) + 0.03, z + (hz - z) * 1.05, true);
  }
}
function F_books(b, x, y, z, n = 3, ry = 0) {
  const cols = ['#2f4a6b', '#e3dccf', '#b5652e', '#1f1f21', '#8c9aa3', '#c9a47a'];
  let yy = y;
  for (let i = 0; i < n; i++) {
    const w = 0.24 + (i % 2) * 0.04, d = 0.18 + (i % 3) * 0.02, h = 0.025 + (i % 2) * 0.015;
    b.I('book', G.box, 'tint', x + (i % 2) * 0.01, yy, z, 0, ry + (i - 1) * 0.08, 0, w, h, d, cols[(i * 3 + n) % cols.length]);
    b.I('bookpg', G.box, 'paper', x + (i % 2) * 0.01, yy + 0.003, z, 0, ry + (i - 1) * 0.08, 0, w - 0.012, h - 0.006, d + 0.002);
    yy += h;
  }
}
function F_candle(b, x, y, z, h = 0.2, brass = true) {
  if (brass) {
    b.add(lathe('csk', [[0, 0], [0.04, 0], [0.04, 0.008], [0.012, 0.02], [0.009, 0.12], [0.018, 0.13], [0.018, 0.14], [0, 0.14]], 16), 'metal', x, y, z);
    y += 0.14;
  }
  b.cyl('wax', 0.011, h, x, y, z);
  b.cyl('black', 0.0008, 0.012, x, y + h, z, true);
  b.sph('flame', 0.006, 0.016, 0.006, x, y + h + 0.022, z, true);
}
// leaf blade along +y from its base: width profile, V-fold and backward bend (+z)
function leafGeo(len, wid, fold = 0.25, bend = 0.3, tip = 0.8) {
  return geo(`leaf${len}|${wid}|${fold}|${bend}|${tip}`, () => {
    const g = new T.PlaneGeometry(1, 1, 2, 7); g.translate(0, 0.5, 0);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const u = p.getX(i) * 2, t = p.getY(i); // u -1..1, t 0..1
      const w = wid * (t < tip ? Math.pow(Math.sin(PI * 0.5 * t / tip), 0.6) : (1 - t) / (1 - tip));
      p.setXYZ(i, u * w * 0.5, t * len, Math.abs(u) * w * fold * 0.5 + bend * len * t * t);
    }
    g.computeVertexNormals();
    return g;
  });
}
function F_plant(b, x, z, h = 1.4, kind = 0, potR = 0.18) {
  b.shadow(potR * 3.2, potR * 3.2, x, z);
  const pot = lathe('pot2', [[0, 0], [0.78, 0], [0.86, 0.04], [0.97, 0.55], [1, 0.95], [1.02, 1], [0.94, 1], [0.92, 0.96], [0, 0.96]], 28);
  const ph = potR * 2.2;
  b.add(pot, 'pot', x, 0, z, 0, 0, 0, potR, ph, potR);
  b.add(G.disc, 'soil', x, ph * 0.94, z, 0, 0, 0, potR * 0.9, 1, potR * 0.9);
  const y0 = ph * 0.94;
  const R = mulberry(hashStr(`pl${x.toFixed(2)}${z.toFixed(2)}${kind}`));
  const LEAF = ['leaf', 'leafDark', 'leafLight'];
  if (kind === 0) { // fiddle-leaf fig: slender trunk, big glossy leaves clustered up the stem
    const lg = leafGeo(0.3, 0.22, 0.18, 0.25, 0.6);
    b.add(taper(0.012, 0.02, 8), 'bark', x, y0, z, 0, 0, 0, 1, h * 0.85, 1);
    for (let i = 0; i < 30; i++) {
      const t = 0.3 + (i / 30) * 0.7, a = i * 2.39996 + R() * 0.4, r = 0.03 + R() * 0.05;
      const ly = y0 + t * h * 0.85;
      b.I('fig', lg, LEAF[i % 3], x + Math.sin(a) * r, ly, z + Math.cos(a) * r, 0.6 + R() * 0.6 - t * 0.3, a, (R() - 0.5) * 0.5, 1 - t * 0.25, 1 - t * 0.25, 1);
    }
  } else if (kind === 1) { // kentia palm: arching fronds of narrow leaflets
    const lf = leafGeo(0.32, 0.035, 0.1, 0.4, 0.75);
    const nF = 8;
    for (let f = 0; f < nF; f++) {
      const a = f / nF * PI * 2 + R() * 0.4, tilt = 0.12 + R() * 0.3, L = Math.min(0.95, h * (0.65 + R() * 0.2));
      // rachis as 5 short segments following an arc
      let px = x, py = y0, pz = z, ang = tilt;
      for (let k = 0; k < 6; k++) {
        const seg = L / 6, dx = Math.sin(a) * Math.sin(ang) * seg, dz = Math.cos(a) * Math.sin(ang) * seg, dy = Math.cos(ang) * seg;
        b.I('rachis', G.cyl8, 'leafDark', px, py, pz, ang, a, 0, 0.004, seg, 0.004);
        for (const sgn of [-1, 1]) if (k > 0) b.I('leaflet', lf, LEAF[(f + k) % 3], px + dx * 0.5, py + dy * 0.5, pz + dz * 0.5, ang + 0.9, a + sgn * 1.1, sgn * 0.2, 1 - k * 0.1, 1 - k * 0.1, 1);
        px += dx; py += dy; pz += dz; ang += 0.14;
      }
    }
  } else if (kind === 2) { // olive shrub: woody branches, many small grey-green leaves
    const ol = leafGeo(0.07, 0.014, 0.1, 0.1, 0.7);
    for (let i = 0; i < 5; i++) { const a = i * 1.26 + R() * 0.3; b.add(taper(0.006, 0.014, 6), 'bark', x, y0, z, 0.35 + R() * 0.3, a, 0, 1, h * 0.75, 1); }
    for (let i = 0; i < 160; i++) {
      const a = R() * PI * 2, r = Math.sqrt(R()) * h * 0.3, yy = y0 + h * (0.35 + R() * 0.55);
      b.I('olv', ol, i % 2 ? 'leaf2' : 'leafLight', x + Math.sin(a) * r, yy, z + Math.cos(a) * r, R() * 2 - 0.5, R() * 6.28, R() - 0.5);
    }
  } else if (kind === 4) { // citrus tree: clear stem, round crown, fruit
    const cl = leafGeo(0.09, 0.04, 0.15, 0.15, 0.7), cy = y0 + h * 0.72, cr = Math.min(0.34, h * 0.26);
    b.add(taper(0.011, 0.018, 8), 'bark', x, y0, z, 0, 0, 0.04, 1, h * 0.6, 1);
    for (let i = 0; i < 4; i++) { const a = i * 1.57 + R(); b.add(taper(0.004, 0.009, 6), 'bark', x, y0 + h * 0.52, z, 0.7, a, 0, 1, cr * 0.9, 1); }
    for (let i = 0; i < 150; i++) {
      const a = R() * PI * 2, e = Math.acos(2 * R() - 1), rr = cr * (0.55 + R() * 0.45);
      b.I('cit', cl, LEAF[i % 3], x + Math.sin(e) * Math.cos(a) * rr, cy + Math.cos(e) * rr * 0.85, z + Math.sin(e) * Math.sin(a) * rr, R() * 2 - 1, R() * 6.28, R() - 0.5);
    }
    for (let i = 0; i < 9; i++) { const a = R() * PI * 2, e = 0.6 + R() * 1.9, rr = cr * 0.92; b.I('citf', G.sphLo, 'tint', x + Math.sin(e) * Math.cos(a) * rr, cy + Math.cos(e) * rr * 0.85, z + Math.sin(e) * Math.sin(a) * rr, 0, 0, 0, 0.028, 0.028, 0.028, i % 3 ? '#e8962a' : '#e9c23a'); }
  } else { // strelitzia / snake plant: tall upright blades
    const sb = leafGeo(1, 0.09, 0.12, 0.06, 0.85);
    for (let i = 0; i < 12; i++) {
      const a = i * 2.39996 + R() * 0.3, l = h * (0.55 + R() * 0.45);
      b.I('blade', sb, LEAF[i % 3], x + Math.sin(a) * 0.04, y0, z + Math.cos(a) * 0.04, 0.08 + R() * 0.22, a, (R() - 0.5) * 0.3, 1, l, 1);
    }
  }
}
// ── package-specific pieces (natura / riviera / urban) ──
function archGeo(w, h, depth) {
  return geo(`arch${w.toFixed(2)}|${h.toFixed(2)}|${depth}`, () => {
    const r = w / 2, sh = new T.Shape();
    sh.moveTo(-r, 0); sh.lineTo(r, 0); sh.lineTo(r, h - r); sh.absarc(0, h - r, r, 0, PI, false); sh.lineTo(-r, 0);
    return new T.ExtrudeGeometry(sh, { depth, bevelEnabled: false, curveSegments: 20 });
  });
}
// arched wall niche (riviera): tinted plaster arch with a raised rim, timber shelves and pottery. Local: wall at z=0, facing +z
function F_archNiche(b, sd, w, h, shelves = true, seed = 0) {
  b.add(archGeo(w + 0.07, h + 0.035, 0.012), 'wall', 0, 0, 0.004);      // rim
  b.add(archGeo(w, h, 0.006), 'feature', 0, 0.0, 0.0125);                // recessed colour field
  if (!shelves) return;
  const ys = [0.95, 1.4, 1.82].filter(y => y < h - w / 2 + 0.05);
  ys.forEach((y, i) => {
    b.rb('wood', w - 0.04, 0.028, 0.16, 0, y, 0.1, 0.006);
    const k = (i + seed) % 3;
    if (k === 0) { b.add(lathe('amph', [[0, 0], [0.04, 0], [0.075, 0.07], [0.07, 0.14], [0.03, 0.2], [0.035, 0.24], [0, 0.24]], 18), 'terracotta', -w * 0.2, y + 0.028, 0.1); F_books(b, w * 0.16, y + 0.028, 0.1, 2, 0.1); }
    else if (k === 1) { b.add(lathe('jar', [[0, 0], [0.05, 0], [0.055, 0.14], [0.03, 0.16], [0, 0.16]], 16), 'stoneware', w * 0.2, y + 0.028, 0.1); b.add(lathe('bowl', [[0, 0], [0.06, 0], [0.11, 0.05], [0.105, 0.052], [0.055, 0.006], [0, 0.006]], 24), 'plate2', -w * 0.15, y + 0.028, 0.1); }
    else { b.add(lathe('amph', [[0, 0], [0.04, 0], [0.075, 0.07], [0.07, 0.14], [0.03, 0.2], [0.035, 0.24], [0, 0.24]], 18), 'stoneware', 0, y + 0.028, 0.1, 0, 0, 0, 0.8, 0.8, 0.8); }
  });
}
// stone floor joints as thin geometry (running bond px × pz), clipped to the room polygon
function floorJoints(b, poly, px = 0.9, pz = 0.6, y = 0.0068) {
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9; poly.forEach(([x, z]) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); });
  const W = 0.004;
  for (let row = Math.floor(z0 / pz); row * pz < z1; row++) {
    const z = row * pz;
    if (z > z0 + 0.03) { // course line: intervals of x inside the polygon
      const xs = [];
      for (let i = 0; i < poly.length; i++) { const [ax, az] = poly[i], [bx, bz] = poly[(i + 1) % poly.length]; if ((az > z) !== (bz > z)) xs.push(ax + (z - az) / (bz - az) * (bx - ax)); }
      xs.sort((p, q) => p - q);
      for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > 0.05) b.add(G.fplane, 'joint', (xs[i] + xs[i + 1]) / 2, y, z, 0, 0, 0, xs[i + 1] - xs[i] - 0.02, 1, W);
    }
    const off = (((row % 2) + 2) % 2) * px / 2;
    for (let x = Math.floor(x0 / px) * px + off; x < x1; x += px) {
      const za = Math.max(z, z0), zb = Math.min(z + pz, z1);
      if (zb - za < 0.05 || !pip(x, za + 0.02, poly) || !pip(x, zb - 0.02, poly) || x < x0 + 0.03 || x > x1 - 0.03) continue;
      b.add(G.fplane, 'joint', x, y, (za + zb) / 2, 0, 0, 0, W, 1, zb - za);
    }
  }
}
// ceiling track with adjustable spot heads (urban)
function trackLights(b, poly, ceil, avoid = []) {
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9; poly.forEach(([x, z]) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); });
  const alongZ = (z1 - z0) >= (x1 - x0), L = alongZ ? z1 - z0 : x1 - x0, Wd = alongZ ? x1 - x0 : z1 - z0;
  const rows = Wd > 3.2 ? [0.3, 0.7] : [0.5], c = ceil - CEIL_GAP;
  rows.forEach((t, ri) => {
    const off = (alongZ ? x0 : z0) + Wd * t, a0 = (alongZ ? z0 : x0) + 0.5, a1 = (alongZ ? z1 : x1) - 0.5;
    const P = (a) => alongZ ? [off, a] : [a, off];
    // track in segments where inside polygon
    for (let a = a0; a < a1 - 0.01; a += 0.5) { const [x, z] = P(a + 0.25); if (pip(x, z, poly)) b.I('track', G.box, 'matteBlack', x, c - 0.022, z, 0, alongZ ? 0 : HP, 0, 0.034, 0.022, 0.5); }
    for (let a = a0 + 0.35, i = 0; a < a1; a += 1.05, i++) {
      const [x, z] = P(a); if (!pip(x, z, poly) || avoid.some(([ax, az]) => Math.hypot(ax - x, az - z) < 0.45)) continue;
      const tilt = ((i + ri) % 2 ? 1 : -1) * 0.45;
      b.push(x, c - 0.022, z, alongZ ? 0 : HP);
      b.cyl('matteBlack', 0.008, 0.05, 0, -0.05, 0, true);
      b.add(G.cyl, 'matteBlack', 0, -0.155, 0, 0, 0, tilt * 0.4, 0.034, 0.11, 0.034);
      b.add(G.disc, 'spot', 0, -0.1562, 0, PI, 0, tilt * 0.4, 0.027, 1, 0.027);
      b.pop();
      b.I('dlGlow', G.disc, 'dlGlow', x, c - 0.002, z, PI, 0, 0, 0.22, 1, 0.22);
    }
  });
}
// black steel shelving with oak shelves (urban). Local: back at z=-d/2
function F_steelShelves(b, sd, w, h = 1.9) {
  const d = 0.36; b.shadow(w + 0.1, d + 0.14);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box('steelFrame', 0.025, h, 0.025, sx * (w / 2 - 0.0125), 0, sz * (d / 2 - 0.0125));
  for (const sx of [-1, 1]) { b.box('steelFrame', 0.02, 0.02, d, sx * (w / 2 - 0.0125), h - 0.02, 0); b.box('steelFrame', 0.012, 0.012, Math.hypot(d, 0.5), sx * (w / 2 - 0.0125), 0.4, 0, 0, Math.atan2(0.5, d)); }
  b.box('steelFrame', w, 0.02, 0.02, 0, h - 0.02, -d / 2 + 0.01);
  const ys = [0.12, 0.52, 0.92, 1.32, 1.72].filter(y => y < h - 0.1);
  ys.forEach((y, i) => {
    b.rb('wood', w - 0.03, 0.03, d - 0.02, 0, y, 0, 0.004);
    const t = y + 0.03;
    if (i === 0) { b.rb('c3', 0.36, 0.26, 0.28, -w / 2 + 0.28, t, 0, 0.03); b.rb('stoneware', 0.3, 0.2, 0.26, w / 2 - 0.26, t, 0, 0.02); }
    else if (i === 1) { for (let k = 0; k < 7; k++) b.I('bookV', G.box, 'tint', -w / 2 + 0.1 + k * 0.042, t, -0.02, 0, 0, (k === 6 ? 0.22 : 0), 0.034, 0.2 + (k % 3) * 0.025, 0.15, ['#2a2b2d', '#a65a2e', '#d8d2c6', '#6d6a66', '#7a5a3c'][k % 5]); F_vase(b, w / 2 - 0.2, t, 0, 0.75, false); }
    else if (i === 2) { F_books(b, -w / 2 + 0.24, t, 0, 3, 0.15); if (hasModel('standing_picture_frame_01')) b.model('standing_picture_frame_01', 0.08, t, -0.04, -0.2, { h: 0.24 }); F_tableLamp(b, sd, w / 2 - 0.16, t, 0, 0.8, 0.8); }
    else if (i === 3) { b.add(lathe('pot2', [[0, 0], [0.78, 0], [0.86, 0.04], [0.97, 0.55], [1, 0.95], [1.02, 1], [0.94, 1], [0.92, 0.96], [0, 0.96]], 28), 'pot', -w / 2 + 0.2, t, 0, 0, 0, 0, 0.07, 0.12, 0.07); const lf = leafGeo(0.22, 0.05, 0.1, 0.5, 0.7); for (let k = 0; k < 10; k++) b.I('trail', lf, k % 2 ? 'leaf' : 'leafLight', -w / 2 + 0.2, t + 0.11, 0, 0.9 + (k % 3) * 0.35, k * 0.63, 0, 1, 1, 1); for (let k = 0; k < 5; k++) b.I('bookV', G.box, 'tint', w / 2 - 0.34 + k * 0.045, t, -0.02, 0, 0, 0, 0.036, 0.19 + (k % 2) * 0.03, 0.15, ['#e4e1db', '#2a2b2d', '#a65a2e'][k % 3]); }
    else { b.rb('stoneware', 0.34, 0.14, 0.26, 0, t, 0, 0.02); }
  });
}
// glazed black-steel frame in a living-room opening (urban): posts, head rail, glazed transom and, where wide enough, a fixed side light
function steelScreens(ctx, an) {
  const { b } = ctx;
  for (const s of an.sides) for (const o of s.openings) {
    if (o.type !== 'opening') continue;
    const w = o.s1 - o.s0, d = -0.11, th = 0.04, head = OPEN_H.opening[1];
    const P = (a0, a1, h0, h1, mk = 'steelFrame', dd = d, t = th) => sidePanelRaw(b, s, a0, a1, h0, h1, mk, 0, dd, t);
    P(o.s0, o.s0 + 0.04, 0, head); P(o.s1 - 0.04, o.s1, 0, head); P(o.s0, o.s1, head - 0.04, head); P(o.s0, o.s1, 2.04, 2.08);
    P(o.s0 + 0.04, o.s1 - 0.04, 2.08, head - 0.04, 'glass', d + 0.016, 0.008);
    for (let a = o.s0 + 0.45; a < o.s1 - 0.3; a += 0.45) P(a - 0.01, a + 0.01, 2.08, head - 0.04);
    if (w >= 1.5) { // fixed side light, keeps ≥ 0.9 m clear
      const e = o.s0 + (w - 0.94);
      P(e - 0.04, e, 0, 2.04); P(o.s0 + 0.04, e - 0.04, 0, 0.05);
      for (const hy of [0.72, 1.38]) P(o.s0 + 0.04, e - 0.04, hy, hy + 0.02);
      P(o.s0 + 0.04, e - 0.04, 0.05, 2.04, 'glass', d + 0.016, 0.008);
    }
  }
}
function F_bonsai(b, x, y, z, s = 1) {
  b.rb('matteBlack', 0.24 * s, 0.05 * s, 0.15 * s, x, y, z, 0.008);
  b.box('soil', 0.21 * s, 0.004, 0.12 * s, x, y + 0.048 * s, z);
  let px = x - 0.03 * s, py = y + 0.05 * s, pz = z;
  const segs = [[0.5, 0.07], [-0.55, 0.07], [0.7, 0.06], [-0.2, 0.05]];
  segs.forEach(([rz, l], i) => { b.add(taper(0.006 * s * (1 - i * 0.15) + 0.002, 0.011 * s * (1 - i * 0.15) + 0.002, 6), 'bark', px, py, pz, 0, 0, rz, 1, l * s * 1.1, 1); px += -Math.sin(rz) * l * s; py += Math.cos(rz) * l * s; });
  const pads = [[0, 0.01, 0.075], [-0.085, -0.05, 0.055], [0.09, -0.035, 0.06], [0.02, -0.09, 0.045]];
  pads.forEach(([dx, dy, r], i) => b.sph(i % 2 ? 'leafDark' : 'leaf', r * s, r * 0.45 * s, r * 0.8 * s, px + dx * s, py + dy * s, pz + (i % 2 ? 0.02 : -0.01) * s, true));
}
// floor cushions (natura)
function F_floorCushions(b, sd) {
  b.shadow(0.7, 0.7);
  b.rb('cushionFloor', 0.6, 0.11, 0.6, 0, 0, 0, 0.045);
  b.rb('c1', 0.52, 0.1, 0.52, 0.03, 0.1, -0.02, 0.045, 0.3);
}
function F_chairRattan(pb) {
  for (const [x, z] of [[-0.2, -0.19], [0.2, -0.19], [-0.2, 0.19], [0.2, 0.19]]) pb.add(taper(0.016, 0.012, 8), 'wood', x, 0, z, 0, 0, 0, 1, 0.44, 1);
  pb.add(G.torus, 'wood', 0, 0.2, 0, HP, 0, 0, 0.2, 0.2, 0.12);
  pb.add(G.cyl, 'rattan', 0, 0.43, 0, 0, 0, 0, 0.24, 0.025, 0.23);
  pb.add(rbox(0.4, 0.04, 0.38, 0.018), 'chairFabric', 0, 0.455, 0.01);
  pb.add(geo('rback', () => new T.CylinderGeometry(0.235, 0.235, 0.34, 20, 1, true, PI - 1.15, 2.3)), 'rattan', 0, 0.66, 0.0);
  pb.add(geo('rrail', () => new T.TorusGeometry(0.235, 0.012, 6, 20, 2.3).rotateX(HP).rotateY(HP + 1.15)), 'wood', 0, 0.83, 0);
  for (const a of [PI - 1.15, PI + 1.15]) pb.add(taper(0.011, 0.012, 6), 'wood', Math.sin(a) * 0.235, 0.45, Math.cos(a) * 0.235, 0, 0, 0, 1, 0.38, 1);
}
function F_chairSteel(pb) {
  for (const [x, z] of [[-0.2, -0.19], [0.2, -0.19], [-0.2, 0.19], [0.2, 0.19]]) pb.add(G.box, 'steelFrame', x, 0, z, 0, 0, 0, 0.018, 0.44, 0.018);
  pb.add(G.box, 'steelFrame', 0, 0.42, 0, 0, 0, 0, 0.42, 0.018, 0.4);
  pb.add(rbox(0.43, 0.05, 0.41, 0.02), 'sofa', 0, 0.438, 0);
  for (const x of [-0.2, 0.2]) pb.add(G.box, 'steelFrame', x, 0.44, -0.2, -0.14, 0, 0, 0.018, 0.4, 0.018);
  pb.add(rbox(0.42, 0.16, 0.035, 0.014), 'sofa', 0, 0.68, -0.245, -0.14);
}
const chairOf = (sd) => sd.id === 'riviera' ? ['chairRattan', F_chairRattan] : sd.id === 'urban' ? ['chairSteel', F_chairSteel] : ['chair', F_chairProto];
function F_tableLamp(b, sd, x, y, z, s = 1, power = 0.8) {
  const L = power ? b.light(x, y + 0.32 * s, z + 0.12, sd.light, power, 3.4, 'table-lamp') : null;
  const spec = { id: 'lamp-table', kind: 'lamp', label: 'lamp', sound: 'click', emis: 'lamp', lamp: L };
  const proxy = { p: [x, y, z], proxy: true, build: (d) => d.box('white', 0.3 * s, 0.5 * s, 0.3 * s, 0, 0, 0) };
  if (sd.id === 'urban') { // bare Edison bulb on a steel stem
    b.cyl('matteBlack', 0.06 * s, 0.015, x, y, z); b.cyl('matteBlack', 0.008, 0.22 * s, x, y, z, true);
    b.dyn(spec, [{ p: [x, y, z], build: (d) => d.sph('filament', 0.04 * s, 0.055 * s, 0.04 * s, 0, 0.27 * s, 0, true) }, proxy]);
  } else if (sd.id === 'natura') { // paper lantern on a low wooden foot
    b.cyl('wood', 0.07 * s, 0.03, x, y, z);
    b.dyn(spec, [{ p: [x, y, z], build: (d) => d.sph('paperLamp', 0.12 * s, 0.15 * s, 0.12 * s, 0, 0.18 * s, 0) }, proxy]);
  } else {
    b.add(lathe('lampbase', [[0, 0], [0.08, 0], [0.1, 0.1], [0.07, 0.24], [0.02, 0.28], [0.0, 0.28]], 24), sd.id === 'riviera' ? 'terracotta' : 'stoneware', x, y, z, 0, 0, 0, s, s, s);
    b.cyl('metal', 0.006, 0.1 * s, x, y + 0.28 * s, z, true);
    b.dyn(spec, [{ p: [x, y, z], build: (d) => { d.add(lathe('tshade', [[0.16, 0], [0.16, 0.001], [0.12, 0.2], [0.119, 0.2]], 28), 'shade', 0, 0.28 * s, 0, 0, 0, 0, s, s, s); d.sph('bulb', 0.025, 0.025, 0.025, 0, 0.34 * s, 0, true); } }, proxy]);
  }
}
function F_floorLamp(b, sd) {
  b.cyl('matteBlack', 0.14, 0.02, 0, 0, 0);
  b.cyl('metal', 0.011, 1.45, 0, 0.02, 0, true);
  const L = b.light(0, 1.35, 0, sd.light, 1.2, 3.8, 'floor-lamp');
  b.dyn({ id: 'lamp-floor', kind: 'lamp', label: 'lamp', sound: 'click', emis: 'lamp', lamp: L }, [
    { p: [0, 1.3, 0], build: (d) => { d.add(lathe('fshade', [[0.2, 0], [0.2, 0.001], [0.16, 0.3], [0.159, 0.3]], 28), 'shade', 0, 0, 0); d.sph('bulb', 0.03, 0.03, 0.03, 0, 0.1, 0, true); } },
    { p: [0, 0, 0], proxy: true, build: (d) => d.box('white', 0.36, 1.65, 0.36, 0, 0, 0) }
  ]);
}
function F_sofa(b, w, d, sd) {
  b.shadow(w + 0.14, d + 0.12);
  if (sd.id === 'natura') { // low platform daybed-sofa: timber deck, loose linen cushions
    b.box('matteBlack', w - 0.3, 0.07, d - 0.3, 0, 0, 0);
    b.rb('wood', w, 0.09, d, 0, 0.07, 0, 0.012);
    const n = w > 2.0 ? 3 : 2, iw = w - 0.36, cw = iw / n;
    for (let i = 0; i < n; i++) {
      const cx = -w / 2 + 0.04 + cw * (i + 0.5);
      b.rb('sofa', cw - 0.012, 0.17, d - 0.26, cx, 0.16, 0.09, 0.055);
      b.rb('sofa', cw - 0.03, 0.36, 0.17, cx, 0.31, -d / 2 + 0.17, 0.07, 0, -0.16);
    }
    b.rb('c0', 0.45, 0.42, 0.12, -w / 2 + 0.34, 0.36, -d / 2 + 0.36, 0.055, 0.1, -0.3, 0.04);
    b.rb('c2', 0.6, 0.2, 0.2, w / 2 - 0.75, 0.33, 0.05, 0.09, -0.2);   // bolster
    b.rb('throw', 0.42, 0.045, 0.3, -w / 2 + 0.5, 0.33, 0.2, 0.018, 0.08);
    // side tray on the deck with a tea set
    const tx = w / 2 - 0.16;
    if (hasModel('tea_set_01')) b.model('tea_set_01', tx, 0.16, 0.05, 0.4, { w: 0.26 }); else { b.cyl('stoneware', 0.05, 0.08, tx, 0.16, 0.0); b.cyl('stoneware', 0.03, 0.04, tx - 0.02, 0.16, 0.15); }
    return;
  }
  const armW = 0.16, seatH = 0.42, backD = 0.22;
  if (sd.id === 'urban') { for (const sx of [-1, 1]) { b.box('steelFrame', 0.03, 0.12, d - 0.1, sx * (w / 2 - 0.1), 0, 0); } }
  else b.box('black', w - 0.1, 0.06, d - 0.12, 0, 0, 0);
  b.rb('sofa', w, sd.id === 'urban' ? 0.24 : 0.3, d, 0, sd.id === 'urban' ? 0.12 : 0.06, 0, 0.04);
  b.rb('sofa', armW, 0.62 - 0.06, d, -w / 2 + armW / 2, 0.06, 0, 0.06);
  b.rb('sofa', armW, 0.62 - 0.06, d, w / 2 - armW / 2, 0.06, 0, 0.06);
  b.rb('sofa', w - 0.02, 0.78 - 0.3, backD - 0.04, 0, 0.3, -d / 2 + backD / 2, 0.05);
  const inner = w - 2 * armW, n = inner > 2.1 ? 3 : 2, cw = inner / n;
  for (let i = 0; i < n; i++) {
    const cx = -inner / 2 + cw * (i + 0.5);
    b.rb('sofa', cw - 0.01, 0.14, d - backD - 0.02, cx, 0.36, (backD) / 2 - 0.01, 0.05);
    b.rb('sofa', cw - 0.02, 0.44, 0.2, cx, seatH + 0.06, -d / 2 + backD + 0.06, 0.08, 0, -0.18);
  }
  const ck = ['c0', 'c1', 'c2', 'c3'];
  const cs = [[-inner / 2 + 0.26, 0.05, 0.12], [-inner / 2 + 0.6, -0.08, -0.06], [inner / 2 - 0.26, -0.06, -0.14], [inner / 2 - 0.62, 0.1, 0.05]];
  cs.forEach(([x, rz, ry], i) => b.rb(ck[i], i % 2 ? 0.42 : 0.5, i % 2 ? 0.42 : 0.5, 0.13, x, 0.5, -d / 2 + backD + 0.2, 0.06, ry, -0.28, rz));
  // throw over the arm and seat
  b.rb('throw', 0.5, 0.02, d * 0.8, w / 2 - armW - 0.28, 0.505, 0.02, 0.01, 0.05);
  b.rb('throw', 0.46, 0.02, d * 0.72, w / 2 - armW / 2 + 0.02, 0.64, 0.02, 0.01, 0.0, 0, 0.06);
  b.rb('throw', 0.02, 0.36, d * 0.7, w / 2 + 0.005, 0.28, 0.02, 0.008);
}
function F_armchair(b, sd) {
  b.shadow(0.98, 0.98);
  const mn = sd.kin === 'noir' ? 'mid_century_lounge_chair' : 'modern_arm_chair_01';
  if (hasModel(mn)) { b.model(mn, 0, 0, 0, 0, { w: sd.kin === 'noir' ? 0.86 : 0.8, d: 0.9 }); return; }
  const w = 0.78, d = 0.8;
  for (const [x, z] of [[-0.32, -0.3], [0.32, -0.3], [-0.32, 0.3], [0.32, 0.3]]) b.cyl('wood', 0.018, 0.14, x, 0, z, true);
  b.rb('armchair', w, 0.28, d, 0, 0.14, 0, 0.06);
  b.rb('armchair', w, 0.5, 0.18, 0, 0.36, -d / 2 + 0.09, 0.08, 0, -0.12);
  b.rb('armchair', 0.13, 0.26, d - 0.1, -w / 2 + 0.065, 0.4, 0.04, 0.05);
  b.rb('armchair', 0.13, 0.26, d - 0.1, w / 2 - 0.065, 0.4, 0.04, 0.05);
  b.rb('c1', 0.4, 0.3, 0.12, 0, 0.5, -d / 2 + 0.24, 0.05, 0.08, -0.25);
}
function F_coffeeTable(b, sd, w = 1.0, d = 0.6) {
  if (sd.table === 'round') b.shadow(w * 0.85, w * 0.85); else b.shadow(w + 0.05, d + 0.05);
  const mn = sd.table === 'round' ? 'coffee_table_round_01' : 'modern_coffee_table_01';
  if (hasModel(mn)) {
    const round = sd.table === 'round';
    const sc = round ? b.model(mn, 0, 0, 0, 0, { w: w * 0.95 }) : b.model(mn, 0, 0, 0, HP, { w: d, d: w });
    const top = modelDims(mn).y * sc;
    F_books(b, round ? -0.14 : -w * 0.22, top, 0.04, 2, 0.3);
    F_vase(b, round ? 0.16 : w * 0.24, top, -0.06, 0.7, false);
    if (hasModel('carved_wooden_plate')) b.model('carved_wooden_plate', round ? 0.02 : 0.02, top, 0.2, 0, { w: 0.24 });
    return;
  }
  if (sd.table === 'round') {
    b.cyl('wood', w / 2, 0.035, 0, 0.34, 0);
    b.cyl('wood', w * 0.3, 0.34, 0, 0, 0);
    F_books(b, -0.12, 0.375, 0.05, 3, 0.3); F_vase(b, 0.18, 0.375, -0.08, 0.7, true);
  } else {
    b.rb('worktop', w, 0.04, d, 0, 0.32, 0, 0.01);
    b.box('matteBlack', w - 0.2, 0.32, d - 0.2, 0, 0, 0);
    F_books(b, -w * 0.22, 0.36, 0.02, 3, -0.1); F_vase(b, w * 0.25, 0.36, -0.05, 0.7, true);
  }
  // small bowl
  b.add(lathe('bowl', [[0, 0], [0.06, 0], [0.11, 0.05], [0.105, 0.052], [0.055, 0.006], [0, 0.006]], 24), 'stoneware', 0.05, sd.table === 'round' ? 0.375 : 0.36, 0.2);
}
function F_sideboard(b, sd, w) {
  b.shadow(w + 0.12, 0.6);
  const h = 0.62, d = 0.45, mk = sd.kin === 'lisboa' ? 'wood' : 'joineryTall', bh = h - 0.14, cd = d - 0.02;
  const legs = [[-w / 2 + 0.08, -d / 2 + 0.06], [w / 2 - 0.08, -d / 2 + 0.06], [-w / 2 + 0.08, d / 2 - 0.06], [w / 2 - 0.08, d / 2 - 0.06]];
  legs.forEach(([x, z]) => b.cyl('metal', 0.012, 0.14, x, 0, z, true));
  F_carcass(b, mk, w, bh, cd, 0, 0.14, -0.01, { top: true, side: mk, back: mk });
  b.box(mk, w - 0.036, 0.014, cd - 0.04, 0, 0.14 + bh * 0.5, -0.01);
  const n = Math.max(2, Math.round(w / 0.5)), dw = w / n;
  for (let i = 1; i < n; i++) if (i % 2 === 0) b.box(mk, 0.016, bh - 0.02, cd - 0.02, -w / 2 + i * dw, 0.15, -0.01);
  for (let i = 0; i < n; i++) { // contents (static, hidden behind the doors)
    const cx = -w / 2 + (i + 0.5) * dw;
    if (i % 2) { for (let k = 0; k < 4; k++) b.add(G.cyl, 'plate', cx - 0.04, 0.16 + k * 0.012, 0, 0, 0, 0, 0.1, 0.008, 0.1); for (let k = 0; k < 3; k++) b.cyl('glassware', 0.032, 0.1, cx - dw / 2 + 0.08 + k * 0.09, 0.154 + bh * 0.5, 0.02); }
    else { b.rb('c2', dw - 0.14, 0.1, 0.26, cx, 0.16, 0, 0.02); b.rb('c0', dw - 0.16, 0.08, 0.24, cx, 0.26, 0, 0.02); b.rb('paper', 0.2, 0.14, 0.26, cx, 0.154 + bh * 0.5, 0, 0.008); }
  }
  for (let i = 0; i < n; i++) {
    const left = i % 2 === 0, hx = -w / 2 + (left ? i : i + 1) * dw;
    b.dyn({ id: 'living-sideboard', kind: 'cabinet', label: 'cabinet', sound: 'door' }, [
      { p: [hx, 0.14, d / 2 - 0.02], anim: ['hinge', 'y', left ? -1.7 : 1.7], build: (dd) => { dd.box(mk, dw - 0.004, bh - 0.004, 0.02, (left ? 1 : -1) * dw / 2, 0.002, 0.01); dd.box('metal', 0.012, 0.12, 0.02, (left ? 1 : -1) * (dw - 0.05), bh / 2 - 0.06, 0.03); } }
    ]);
  }
  F_books(b, -w / 2 + 0.3, h, 0.02, 4, 0.2);
  if (sd.id === 'natura') F_bonsai(b, w / 2 - 0.24, h, 0, 1.25);
  else if (hasModel('ceramic_vase_01')) { b.model('ceramic_vase_01', w / 2 - 0.22, h, -0.02, 0.6, { h: 0.4 }); F_vase(b, w / 2 - 0.22, h + 0.28, -0.02, 0.5, true, false); }
  else F_vase(b, w / 2 - 0.25, h, 0, 1.0, true);
  if (hasModel('standing_picture_frame_01')) b.model('standing_picture_frame_01', -w / 2 + 0.62, h, -0.06, 0.25, { h: 0.25 });
  F_tableLamp(b, sd, w / 2 - 0.58, h, 0.0, 1, 0.9);
}
function F_chairProto(pb) {
  // dining chair: seat 0.46 high, 0.46 wide
  for (const [x, z] of [[-0.2, -0.19], [0.2, -0.19], [-0.2, 0.19], [0.2, 0.19]]) pb.add(taper(0.014, 0.011, 8), 'wood', x, 0, z, 0, 0, 0, 1, 0.43, 1);
  pb.box('wood', 0.44, 0.03, 0.42, 0, 0.42, 0);
  pb.add(rbox(0.44, 0.06, 0.42, 0.025), 'chairFabric', 0, 0.44, 0.005);
  pb.add(taper(0.012, 0.014, 8), 'wood', -0.2, 0.45, -0.2, -0.12, 0, 0, 1, 0.38, 1);
  pb.add(taper(0.012, 0.014, 8), 'wood', 0.2, 0.45, -0.2, -0.12, 0, 0, 1, 0.38, 1);
  pb.add(rbox(0.44, 0.2, 0.04, 0.015), 'chairFabric', 0, 0.64, -0.24, -0.12);
}
function F_stoolProto(pb) {
  pb.add(G.cyl, 'metal', 0, 0, 0, 0, 0, 0, 0.18, 0.012, 0.18);
  pb.add(G.cyl, 'metal', 0, 0, 0, 0, 0, 0, 0.022, 0.65, 0.022);
  pb.add(G.torus, 'metal', 0, 0.28, 0, HP, 0, 0, 0.16, 0.16, 0.16);
  pb.add(rbox(0.4, 0.07, 0.38, 0.03), 'chairFabric', 0, 0.65, 0);
  pb.add(rbox(0.38, 0.14, 0.04, 0.02), 'chairFabric', 0, 0.74, -0.18, -0.15);
}
// Cutlery prototypes (true size)
function P_fork(pb) {
  pb.add(G.box, 'cutlery', 0, 0, 0.02, 0.0, 0, 0, 0.011, 0.003, 0.13);
  pb.add(G.box, 'cutlery', 0, 0.0, 0.1, 0.04, 0, 0, 0.022, 0.002, 0.03);
  for (let i = 0; i < 4; i++) pb.add(G.box, 'cutlery', -0.0085 + i * 0.0057, 0.0012, 0.135, 0.06, 0, 0, 0.0028, 0.0018, 0.045);
}
function P_knife(pb) {
  pb.add(G.box, 'cutlery', 0, 0, -0.02, 0, 0, 0, 0.012, 0.005, 0.1);
  pb.add(G.box, 'cutlery', 0.002, 0.0, 0.1, 0, 0, 0, 0.017, 0.0018, 0.13);
}
function P_spoon(pb) {
  pb.add(G.box, 'cutlery', 0, 0, 0, 0, 0, 0, 0.01, 0.003, 0.13);
  pb.add(G.sph, 'cutlery', 0, 0.006, 0.1, 0, 0, 0, 0.018, 0.006, 0.028);
}
function P_wineGlass(pb) {
  const pts = [[0, 0], [0.036, 0], [0.036, 0.002], [0.004, 0.006], [0.0035, 0.1], [0.02, 0.11], [0.039, 0.14], [0.042, 0.18], [0.037, 0.215], [0.035, 0.215], [0.039, 0.18], [0.036, 0.14], [0.018, 0.113], [0, 0.11]];
  pb.add(lathe('wglass', pts, 20), 'glassware', 0, 0, 0);
}
function P_waterGlass(pb) {
  pb.add(lathe('tumbler', [[0, 0], [0.034, 0], [0.037, 0.1], [0.034, 0.1], [0.031, 0.008], [0, 0.008]], 20), 'glassware', 0, 0, 0);
}
function P_plate(pb) {
  pb.add(lathe('plate', [[0, 0], [0.09, 0], [0.1, 0.008], [0.135, 0.018], [0.138, 0.02], [0.134, 0.021], [0.1, 0.012], [0.09, 0.006], [0, 0.006]], 32), 'plate', 0, 0, 0);
  pb.add(lathe('plate2', [[0, 0], [0.06, 0], [0.07, 0.006], [0.1, 0.016], [0.102, 0.018], [0.098, 0.018], [0.07, 0.01], [0.06, 0.005], [0, 0.005]], 32), 'plate2', 0, 0.007, 0);
}
function P_napkin(pb) { pb.add(rbox(0.12, 0.012, 0.2, 0.005), 'napkin', 0, 0, 0); }
function F_placeSetting(b, x, z, ry, wine = true) {
  b.push(x, 0, z, ry);
  // local: +z toward diner (edge of table). y given by caller's push
  b.pf('plate', P_plate, 0, 0, 0);
  b.pf('napkinS', P_napkin, -0.22, 0.0, 0.0);
  b.pf('fork', P_fork, -0.22, 0.013, 0.02, PI);
  b.pf('knife', P_knife, 0.17, 0.0025, 0.0, PI);
  b.pf('spoon', P_spoon, 0.2, 0.0015, 0.0, PI);
  b.pf('wglass', P_wineGlass, 0.2, 0, -0.2);
  b.pf('tumbler', P_waterGlass, 0.08, 0, -0.23);
  if (wine) b.add(lathe('wine', [[0, 0.114], [0.016, 0.116], [0.03, 0.13], [0.035, 0.145], [0, 0.145]], 20), 'wine', 0.2, 0, -0.2);
  b.pop();
}
function F_diningTable(b, sd, n, round, w, d) {
  if (round) b.shadow(w + 0.75, w + 0.75); else b.shadow(w + 0.5, d + 1.0);
  const H = 0.75;
  if (round) {
    b.add(G.cylHi, sd.tableTop === 'nero' ? 'worktop' : 'wood', 0, H - 0.035, 0, 0, 0, 0, w / 2, 0.035, w / 2);
    b.add(lathe('tped', [[0, 0], [0.26, 0], [0.26, 0.02], [0.08, 0.06], [0.06, 0.7], [0.12, 0.715], [0, 0.715]], 28), sd.kin === 'lisboa' ? 'wood' : 'stoneware', 0, 0, 0);
  } else {
    b.rb(sd.tableTop === 'nero' ? 'worktop' : 'wood', w, 0.035, d, 0, H - 0.035, 0, 0.006);
    for (const sx of [-1, 1]) {
      b.box(sd.id === 'natura' ? 'wood' : 'matteBlack', 0.06, H - 0.035, 0.06, sx * (w / 2 - 0.12), 0, -d / 2 + 0.12);
      b.box(sd.id === 'natura' ? 'wood' : 'matteBlack', 0.06, H - 0.035, 0.06, sx * (w / 2 - 0.12), 0, d / 2 - 0.12);
    }
    b.box(sd.id === 'natura' ? 'wood' : 'matteBlack', w - 0.3, 0.06, 0.03, 0, H - 0.1, 0);
  }
  // seats
  const seats = [];
  if (round) { for (let i = 0; i < n; i++) { const a = i / n * PI * 2 + PI / 4; seats.push([Math.sin(a), Math.cos(a), a]); } }
  else {
    const per = n / 2;
    for (let i = 0; i < per; i++) { const x = -w / 2 + (i + 0.5) * w / per; seats.push([x / 1, 1, 0, true]); seats.push([x, -1, PI, true]); }
  }
  seats.forEach(([sx, sz, a, rect]) => {
    const rChair = round ? w / 2 + 0.12 : 0, rSet = round ? w / 2 - 0.17 : 0;
    const cx = rect ? sx : sx * rChair, cz = rect ? sz * (d / 2 + 0.12) : sz * rChair;
    const px = rect ? sx : sx * rSet, pz = rect ? sz * (d / 2 - 0.17) : sz * rSet;
    b.pf(...chairOf(sd), cx, 0, cz, a + PI, 1);
    b.push(0, H, 0); F_placeSetting(b, px, pz, a, true); b.pop();
  });
  // centrepiece: candles + bowl with fruit
  F_candle(b, -0.1, H, 0.03, 0.18); F_candle(b, 0.1, H, -0.03, 0.14);
  b.add(lathe('cbowl', [[0, 0], [0.04, 0], [0.12, 0.06], [0.115, 0.062], [0.035, 0.008], [0, 0.008]], 24), 'stoneware', 0, H, round ? 0.14 : 0.0);
  if (!F_fruitModels(b, 0, H + 0.012, round ? 0.14 : 0.0, 0)) F_fruit(b, 0, H + 0.02, round ? 0.14 : 0.0, 5);
}
// real fruit (glTF) in a bowl; returns false if the models are missing
function F_fruitModels(b, x, y, z, seed = 0) {
  if (!hasModel('lemon') || !hasModel('food_apple_01')) return false;
  const pts = [[0, 0, 'food_apple_01', 0.085], [0.06, 0.03, 'lemon', 0.085], [-0.05, 0.045, 'lemon', 0.08], [-0.02, -0.06, hasModel('food_pomegranate_01') ? 'food_pomegranate_01' : 'food_apple_01', 0.09]];
  pts.forEach(([dx, dz, n, h], i) => b.model(n, x + dx, y + (i ? 0.012 : 0.02), z + dz, seed + i * 1.7, { h }));
  return true;
}
function F_fruit(b, x, y, z, n) {
  const cols = ['#e6a52a', '#d9761c', '#a8bf3a', '#c9361f', '#f0c64a', '#7aa33a'];
  for (let i = 0; i < n; i++) { const a = i * 2.2, r = i === 0 ? 0 : 0.055; b.I('fruit', G.sph, 'tint', x + Math.cos(a) * r, y + 0.035 + (i === 0 ? 0.03 : 0), z + Math.sin(a) * r, 0, 0, 0, 0.036, 0.034, 0.036, cols[i % cols.length]); }
}
function F_pendant(b, sd, y0, ceil, H = 1.55, big = true) {
  const len = ceil - (y0 + H);
  const L = b.light(0, y0 + H - 0.25, 0, sd.light, 2.2, 5.0, 'pendant');
  const spec = { id: 'lamp-pendant', kind: 'lamp', label: 'light', sound: 'click', emis: 'lamp', lamp: L, range: 3.2 };
  const proxy = { p: [0, y0 + H - 0.45, 0], proxy: true, build: (d) => d.box('white', 0.6, 0.55, 0.6, 0, 0, 0) };
  b.cyl('black', 0.002, len, 0, y0 + H, 0, true);
  if (sd.id === 'urban') { // three bare Edison bulbs at staggered heights
    b.box('matteBlack', 0.7, 0.02, 0.06, 0, ceil - 0.02 - CEIL_GAP, 0);
    const pts = [[-0.28, 0.1], [0, -0.08], [0.28, 0.16]];
    pts.forEach(([x, dy]) => { const by = y0 + H - 0.1 + dy; b.cyl('black', 0.0025, ceil - by - 0.02, x, by, 0, true); b.cyl('metal', 0.016, 0.05, x, by - 0.05, 0, true); });
    proxy.build = (d) => d.box('white', 0.8, 0.6, 0.3, 0, 0, 0);
    b.dyn(spec, [{ p: [0, y0 + H - 0.1, 0], build: (d) => pts.forEach(([x, dy]) => d.sph('filament', 0.045, 0.062, 0.045, x, dy - 0.11, 0, false)) }, proxy]);
    return;
  }
  if (sd.id === 'natura') { // washi paper lantern
    b.cyl('wood', 0.035, 0.012, 0, ceil - 0.012 - CEIL_GAP, 0);
    for (const dy of [-0.12, 0, 0.12]) { const rr = Math.sqrt(Math.max(0, 1 - (dy / 0.24) ** 2)) * 0.3; b.add(G.torus, 'wood', 0, y0 + H - 0.24 + dy, 0, HP, 0, 0, rr + 0.002, rr + 0.002, 0.045); }
    b.cyl('wood', 0.05, 0.012, 0, y0 + H - 0.012, 0);
    b.dyn(spec, [{ p: [0, y0 + H - 0.24, 0], build: (d) => d.sph('paperLamp', 0.3, 0.24, 0.3, 0, 0, 0) }, proxy]);
    return;
  }
  if (sd.id === 'riviera') { // woven rattan dome
    b.cyl('metal', 0.04, 0.012, 0, ceil - 0.012 - CEIL_GAP, 0);
    b.add(lathe('rdome', [[0.03, 0.3], [0.1, 0.285], [0.2, 0.22], [0.28, 0.1], [0.3, 0.0]], 32), 'rattan', 0, y0 + H - 0.3, 0);
    b.add(G.torus, 'wood', 0, y0 + H - 0.3, 0, HP, 0, 0, 0.3, 0.3, 0.14);
    b.dyn(spec, [{ p: [0, y0 + H - 0.16, 0], build: (d) => d.sph('bulb', 0.04, 0.04, 0.04, 0, 0, 0, true) }, proxy]);
    return;
  }
  b.cyl('metal', 0.04, 0.012, 0, ceil - 0.012, 0);
  if (sd.kin === 'lisboa') b.add(lathe('pdome', [[0.001, 0.2], [0.07, 0.19], [0.2, 0.06], [0.22, 0.0], [0.215, 0.0], [0.195, 0.055], [0.068, 0.184], [0.001, 0.194]], 32), 'metal', 0, y0 + H - 0.2 + 0.2, 0, PI);
  else if (sd.kin === 'noir') b.add(lathe('pcone', [[0.001, 0.02], [0.03, 0.02], [0.16, 0.22], [0.155, 0.22], [0.026, 0.024], [0.001, 0.024]], 32), 'matteBlack', 0, y0 + H + 0.02, 0, PI);
  else if (hasModel('modern_ceiling_lamp_01')) { const dm = modelDims('modern_ceiling_lamp_01'); b.model('modern_ceiling_lamp_01', 0, ceil - dm.y, 0, 0, { s: 1 }); proxy.p = [0, ceil - dm.y, 0]; proxy.build = (d) => d.box('white', Math.max(0.4, dm.x), Math.min(0.6, dm.y), Math.max(0.4, dm.z), 0, 0, 0); b.dyn(spec, [proxy]); return; }
  else { b.dyn(spec, [{ p: [0, y0 + H - 0.2, 0], build: (d) => { d.sph('shade', 0.2, 0.2, 0.2, 0, 0, 0); d.sph('bulb', 0.035, 0.035, 0.035, 0, 0.06, 0, true); } }, proxy]); return; }
  b.dyn(spec, [{ p: [0, y0 + H - 0.14, 0], build: (d) => d.sph('bulb', 0.035, 0.035, 0.035, 0, 0, 0, true) }, proxy]);
}

// cabinet front in pivot-local coords: x from x0..x0+w, y 0..h, z 0..0.02 (+z = room side). hd: 'top'|'bottom'|'left'|'right'|null handle position
function F_front(d, sd, x0, w, h, hd = 'top', mk = 'joinery') {
  const FT = 0.02, cx = x0 + w / 2;
  d.box(mk, w - 0.004, h - 0.004, FT, cx, 0.002, FT / 2);
  if (sd.id === 'riviera' && w > 0.28 && h > 0.2) { const r = Math.min(0.055, h * 0.28), z = FT + 0.005, t = 0.01, ww = w - 0.012, hh = h - 0.012; d.box(mk, ww, r, t, cx, 0.006, z); d.box(mk, ww, r, t, cx, 0.006 + hh - r, z); d.box(mk, r, hh - 2 * r, t, cx - ww / 2 + r / 2, 0.006 + r, z); d.box(mk, r, hh - 2 * r, t, cx + ww / 2 - r / 2, 0.006 + r, z); }
  if (!hd || w < 0.22) return;
  const z = FT + 0.022;
  if (hd === 'top' || hd === 'bottom') { const hw = Math.min(0.3, w * 0.5), y = hd === 'top' ? h - 0.07 : 0.05; d.box('metal', hw, 0.012, 0.014, cx, y, z); d.box('metal', 0.01, 0.01, 0.024, cx - hw / 2 + 0.02, y + 0.001, FT + 0.01); d.box('metal', 0.01, 0.01, 0.024, cx + hw / 2 - 0.02, y + 0.001, FT + 0.01); }
  else { const hh = Math.min(0.5, h * 0.4), x = hd === 'left' ? x0 + 0.045 : x0 + w - 0.045, y = h > 1.2 ? Math.min(h - hh - 0.1, Math.max(0.1, 1.0 - hh / 2)) : (h - hh) / 2; d.box('metal', 0.013, hh, 0.014, x, y, z); d.box('metal', 0.01, 0.01, 0.024, x, y + 0.03, FT + 0.01); d.box('metal', 0.01, 0.01, 0.024, x, y + hh - 0.04, FT + 0.01); }
}
// hollow carcass (static): sides, bottom, back; mk for visible faces
function F_carcass(b, mk, w, h, d, cx, y, zc, { top = false, side = 'white', back = 'white' } = {}) {
  const t = 0.018;
  b.box(side, t, h, d, cx - w / 2 + t / 2, y, zc); b.box(side, t, h, d, cx + w / 2 - t / 2, y, zc);
  b.box(mk, w - 2 * t, t, d, cx, y, zc); b.box(back, w - 2 * t, h - t, 0.008, cx, y + t, zc - d / 2 + 0.004);
  if (top) b.box(mk, w - 2 * t, t, d, cx, y + h - t, zc);
}
// open-top drawer box in slide-pivot coords (front at z=0, box extends to -depth)
function F_drawerBox(d, w, h, depth, y = 0.03) {
  const t = 0.014;
  d.box('white', w, 0.012, depth, 0, y, -depth / 2);
  d.box('white', t, h, depth, -w / 2 + t / 2, y, -depth / 2); d.box('white', t, h, depth, w / 2 - t / 2, y, -depth / 2);
  d.box('white', w, h, t, 0, y, -depth + t / 2);
}
// kitchen run along a wall: w metres, local x from -w/2..w/2, back at z=-D/2 (depth 0.62)
// opts: { tall: 0|1|2, ceil, flip (tall columns at +x end) }
function F_kitchenRun(b, sd, w, opts) {
  b.shadow(w + 0.05, 0.85, 0, 0.06);
  b.light(0, 1.4, 0.35, 0xffe6c8, 1.2, 4.0, 'under-cabinet');
  const D = 0.62, H = 0.9, plinth = 0.1, wt = 0.03, FT = 0.02;
  const z0 = -D / 2, zf = z0 + D - FT, cd = D - FT - 0.01, zc = z0 + 0.005 + cd / 2; // zf: back face of the fronts; carcass depth/centre
  const tallN = opts.tall || 0;
  let x = -w / 2; const mods = [];
  if (tallN >= 1) { mods.push({ k: 'fridge', x, w: 0.6 }); x += 0.6; }
  if (tallN >= 2) { mods.push({ k: 'ovenTall', x, w: 0.6 }); x += 0.6; }
  const baseStart = x, baseW = w / 2 - x;
  const prio = opts.prio || ['hob', 'sink', 'dw', 'drawer', 'wm'];
  let used = 0; const picked = new Set();
  for (const k of prio) if (used + 0.6 <= baseW + 1e-3) { picked.add(k); used += 0.6; }
  let extra = baseW - used;
  const slots = []; let bx = baseStart;
  for (const k of ['drawer', 'hob', 'sink', 'dw', 'wm']) {
    if (!picked.has(k)) continue;
    let ww = 0.6; if (k === 'drawer' && extra > 0) { ww += extra; extra = 0; }
    slots.push({ k, x: bx, w: ww }); bx += ww;
  }
  if (extra > 0.01) { slots.push({ k: 'filler', x: bx, w: extra }); bx += extra; }
  // mirror so the tall columns sit at the +x end when requested
  let bs0 = baseStart, bs1 = baseStart + baseW;
  if (opts.flip) { for (const m of [...mods, ...slots]) m.x = -(m.x + m.w); [bs0, bs1] = [-bs1, -bs0]; }
  const baseC = (bs0 + bs1) / 2, flip = !!opts.flip;
  const openSide = flip ? 'left' : 'right';   // door handles away from the tall columns
  b.box('matteBlack', baseW, plinth, D - 0.06, baseC, 0, z0 + (D - 0.06) / 2);
  const bh = H - plinth - wt;                // base front height
  const oven = (cx, y, ww, hh, idp) => {     // built-in oven: cavity + drop-down door + interior light
    b.box('matteBlack', ww, 0.012, cd, cx, y, zc); b.box('matteBlack', 0.012, hh, cd, cx - ww / 2 + 0.006, y, zc); b.box('matteBlack', 0.012, hh, cd, cx + ww / 2 - 0.006, y, zc); b.box('matteBlack', ww, hh, 0.012, cx, y, zc - cd / 2 + 0.006); b.box('matteBlack', ww, 0.012, cd, cx, y + hh - 0.012, zc);
    b.dyn({ id: idp, kind: 'oven', label: 'oven', sound: 'door', dur: 0.7 }, [
      { p: [cx, y, zf], anim: ['hinge', 'x', 1.48], build: (d) => { d.box('blackGlass', ww - 0.006, hh - 0.004, 0.022, 0, 0.002, 0.011); d.box('steel', ww - 0.1, 0.014, 0.014, 0, hh - 0.07, 0.05); d.box('steel', 0.012, 0.012, 0.03, -ww / 2 + 0.07, hh - 0.069, 0.033); d.box('steel', 0.012, 0.012, 0.03, ww / 2 - 0.07, hh - 0.069, 0.033); } },
      { p: [cx, y, zc], reveal: true, build: (d) => { for (const yy of [0.14, 0.32]) { for (let i = 0; i < 9; i++) d.box('steel', 0.004, 0.004, cd - 0.06, -ww / 2 + 0.05 + i * (ww - 0.1) / 8, yy, 0); d.box('steel', ww - 0.04, 0.005, 0.005, 0, yy, cd / 2 - 0.04); d.box('steel', ww - 0.04, 0.005, 0.005, 0, yy, -cd / 2 + 0.04); } d.box('matteBlack', ww - 0.1, 0.03, cd - 0.14, 0, 0.145, 0); } }
    ], [{ type: 'light', p: [cx, y + hh - 0.02, zc], rx: HP, w: ww - 0.1, h: cd - 0.1, color: '#ffb866', intensity: 3 }]);
  };
  for (const s of slots) {
    const cx = s.x + s.w / 2, endA = Math.abs(s.x - bs0) < 1e-3, endB = Math.abs(s.x + s.w - bs1) < 1e-3;
    F_carcass(b, 'white', s.w, bh, cd, cx, plinth, zc);
    if (endA) b.box('joinery', 0.006, bh, D - 0.004, s.x + 0.003, plinth, z0 + D / 2);
    if (endB) b.box('joinery', 0.006, bh, D - 0.004, s.x + s.w - 0.003, plinth, z0 + D / 2);
    const iw = s.w - 0.05;
    if (s.k === 'drawer' || (s.k === 'hob' && tallN >= 2)) {
      const hs = s.k === 'hob' ? [0.36, bh - 0.36 - 0.06] : [0.26, 0.24, bh - 0.5];   // bottom → top
      if (s.k === 'hob') b.box('joinery', s.w - 0.004, 0.06, FT, cx, plinth + bh - 0.06, zf + FT / 2); // fixed rail under the hob
      let y = plinth;
      hs.forEach((hh, i) => {
        const top = i === hs.length - 1, yy = y;
        b.dyn({ id: 'kitchen-drawer', kind: 'drawer', label: 'drawer', sound: 'drawer', dur: 0.45 }, [
          { p: [cx, yy, zf], anim: ['slide', 0, 0, 0.4], build: (d) => F_front(d, sd, -s.w / 2, s.w, hh, 'top') },
          { p: [cx, yy, zf], anim: ['slide', 0, 0, 0.4], reveal: true, build: (d) => {
            F_drawerBox(d, iw, Math.max(0.07, hh - 0.09), cd - 0.05);
            if (top && s.k !== 'hob') { // cutlery tray
              const n = 4, tw = iw - 0.06; d.box('wood', tw, 0.006, 0.3, 0, 0.044, -0.2);
              for (let k = 0; k <= n; k++) d.box('wood', 0.006, 0.03, 0.3, -tw / 2 + k * tw / n, 0.044, -0.2);
              for (let k = 0; k < n; k++) for (let j = 0; j < 3; j++) d.box('cutlery', 0.014 + (k % 2) * 0.006, 0.004, 0.19, -tw / 2 + (k + 0.3 + j * 0.2) * tw / n, 0.052 + j * 0.003, -0.2 + (j - 1) * 0.012, (j - 1) * 0.03);
            } else if (i === 1 || s.k === 'hob') { // pans & lids
              d.add(lathe('pan', [[0, 0], [0.12, 0], [0.125, 0.07], [0.12, 0.07], [0.115, 0.005], [0, 0.005]], 28), 'matteBlack', -iw / 2 + 0.16, 0.044, -0.2);
              d.add(lathe('pot2', [[0, 0], [0.1, 0], [0.105, 0.11], [0.1, 0.11], [0.095, 0.006], [0, 0.006]], 24), 'steel', iw / 2 - 0.15, 0.044, -0.26);
              d.box('matteBlack', 0.025, 0.014, 0.16, -iw / 2 + 0.16, 0.1, -0.03);
            } else { for (let k = 0; k < 3; k++) d.rb(k % 2 ? 'towel2' : 'towel', 0.2, 0.05, 0.3, -iw / 2 + 0.14 + k * 0.01, 0.045 + k * 0.05, -0.22, 0.012); d.cyl('glassware', 0.04, 0.14, iw / 2 - 0.1, 0.044, -0.2); d.cyl('glassware', 0.04, 0.14, iw / 2 - 0.1, 0.044, -0.32); }
          } }
        ]);
        y += hh;
      });
    } else if (s.k === 'filler') {
      if (s.w < 0.22) b.box('joinery', s.w - 0.004, bh, FT, cx, plinth, zf + FT / 2);
      else b.dyn({ id: 'kitchen-cabinet', kind: 'cabinet', label: 'cabinet', sound: 'door' }, [
        { p: [flip ? s.x + s.w : s.x, plinth, zf], anim: ['hinge', 'y', flip ? 1.75 : -1.75], build: (d) => F_front(d, sd, flip ? -s.w : 0, s.w, bh, openSide) },
        { p: [cx, plinth, zc], reveal: true, build: (d) => { d.box('white', iw, 0.016, cd - 0.04, 0, bh * 0.5, 0); for (let k = 0; k < 2; k++) d.cyl('glassware', 0.035, 0.26, -0.04 + k * 0.08, 0.02, 0.05 * k); d.cyl('stoneware', 0.045, 0.12, 0, bh * 0.5 + 0.016, 0); } }
      ]);
    } else if (s.k === 'hob') {
      b.box('steel', s.w - 0.006, 0.1, 0.022, cx, plinth + bh - 0.1, zf + 0.011);
      b.box('ledStrip', 0.06, 0.012, 0.004, cx + 0.18, plinth + bh - 0.06, zf + 0.024);
      for (let i = 0; i < 2; i++) b.cyl('black', 0.016, 0.02, cx - 0.2 + i * 0.08, plinth + bh - 0.05, zf + 0.022, false, HP);
      oven(cx, plinth + 0.02, s.w - 0.04, bh - 0.13, 'kitchen-oven');
    } else if (s.k === 'dw') {
      b.dyn({ id: 'kitchen-dishwasher', kind: 'dishwasher', label: 'dishwasher', sound: 'door', dur: 0.8 }, [
        { p: [cx, plinth, zf], anim: ['hinge', 'x', 1.5], build: (d) => { F_front(d, sd, -s.w / 2, s.w, bh, 'top'); d.box('steel', s.w - 0.05, bh - 0.05, 0.012, 0, 0.025, -0.006); } },
        { p: [cx, plinth, zf], anim: ['slide', 0, 0, 0.42], reveal: true, build: (d) => {
          const rw = iw - 0.03, rd = cd - 0.08; // lower rack with plates
          for (let k = 0; k <= 6; k++) d.box('steel', 0.004, 0.004, rd, -rw / 2 + k * rw / 6, 0.12, -rd / 2 - 0.02);
          for (const zz of [-0.02, -rd - 0.02]) { d.box('steel', rw, 0.004, 0.004, 0, 0.12, zz); d.box('steel', rw, 0.004, 0.004, 0, 0.24, zz); }
          for (const xx of [-rw / 2, rw / 2]) d.box('steel', 0.004, 0.004, rd, xx, 0.24, -rd / 2 - 0.02);
          for (let k = 0; k < 6; k++) d.add(G.cyl, 'plate', -rw / 2 + 0.08, 0.26, -0.08 - k * 0.055, HP - 0.15, 0, 0, 0.12, 0.008, 0.12);
          for (let k = 0; k < 4; k++) d.cyl('glassware', 0.035, 0.1, rw / 2 - 0.08, 0.125, -0.1 - k * 0.09);
        } },
        { p: [cx, plinth, zc], reveal: true, build: (d) => { d.box('steel', iw, bh - 0.04, 0.006, 0, 0.02, -cd / 2 + 0.012); d.box('steel', 0.006, bh - 0.04, cd - 0.02, -iw / 2, 0.02, 0); d.box('steel', 0.006, bh - 0.04, cd - 0.02, iw / 2, 0.02, 0); for (let k = 0; k <= 5; k++) d.box('steel', 0.004, 0.004, cd - 0.1, -iw / 2 + 0.04 + k * (iw - 0.08) / 5, bh * 0.6, 0); } }
      ]);
    } else if (s.k === 'sink') {
      b.dyn({ id: 'kitchen-cabinet', kind: 'cabinet', label: 'cabinet', sound: 'door' }, [
        { p: [flip ? s.x + s.w : s.x, plinth, zf], anim: ['hinge', 'y', flip ? 1.75 : -1.75], build: (d) => F_front(d, sd, flip ? -s.w : 0, s.w, bh, openSide) },
        { p: [cx, plinth, zc], reveal: true, build: (d) => { d.rb('whiteGloss', 0.24, 0.34, 0.26, -0.1, 0.02, 0.05, 0.03); d.cyl('tint:#3f7fbf', 0.04, 0.24, 0.15, 0.02, 0.1); d.cyl('tint:#e9c84a', 0.035, 0.2, 0.2, 0.02, -0.02); d.cyl('whiteGloss', 0.02, 0.2, 0.05, bh - 0.4, -0.12); } }
      ]);
    } else if (s.k === 'wm') { // front-loading washing machine, porthole door opens
      b.box('whiteGloss', s.w - 0.02, bh - 0.01, 0.03, cx, plinth, zf + 0.005);
      b.add(G.cyl, 'matteBlack', cx, 0.42, zf - 0.03, -HP, 0, 0, 0.145, 0.12, 0.145);
      b.box('black', s.w - 0.08, 0.07, 0.01, cx, 0.72, zf + 0.022);
      b.cyl('steel', 0.022, 0.015, cx + 0.2, 0.755, zf + 0.026, false, HP);
      b.dyn({ id: 'kitchen-washer', kind: 'cabinet', label: 'washer', sound: 'door' }, [
        { p: [cx - 0.18, 0.42, zf + 0.022], anim: ['hinge', 'y', -1.9], build: (d) => { d.add(G.torus, 'steel', 0.18, 0, 0.012, 0, 0, 0, 0.17, 0.17, 0.3); d.add(G.cyl, 'blackGlass', 0.18, 0, 0.004, HP, 0, 0, 0.15, 0.02, 0.15); } },
        { p: [cx, 0.42, zf - 0.05], reveal: true, build: (d) => { d.rb('towel', 0.2, 0.08, 0.1, -0.02, -0.11, 0, 0.03); d.rb('towel2', 0.16, 0.07, 0.1, 0.04, -0.06, -0.01, 0.03); } }
      ]);
    }
  }
  // worktop with a real sink cut-out
  const hobSlot = slots.find(s => s.k === 'hob'), sinkSlot = slots.find(s => s.k === 'sink');
  if (sinkSlot) {
    const cx = sinkSlot.x + sinkSlot.w / 2, sw = 0.44, sdp = 0.36, sz = z0 + 0.34, sb = 0.17; // bowl: sw × sdp, centre z, depth
    const x0 = cx - sw / 2, x1 = cx + sw / 2, zb = sz - sdp / 2, zF = sz + sdp / 2;
    if (x0 - bs0 > 0.001) b.box('worktop', x0 - bs0, wt, D, (bs0 + x0) / 2, H - wt, z0 + D / 2);
    if (bs1 - x1 > 0.001) b.box('worktop', bs1 - x1, wt, D, (x1 + bs1) / 2, H - wt, z0 + D / 2);
    b.box('worktop', sw, wt, zb - z0, cx, H - wt, (z0 + zb) / 2); b.box('worktop', sw, wt, z0 + D - zF, cx, H - wt, (zF + z0 + D) / 2);
    b.box('steel', sw, 0.006, sdp, cx, H - sb, sz);
    b.box('steel', 0.006, sb - 0.002, sdp, x0 + 0.003, H - sb, sz); b.box('steel', 0.006, sb - 0.002, sdp, x1 - 0.003, H - sb, sz);
    b.box('steel', sw, sb - 0.002, 0.006, cx, H - sb, zb + 0.003); b.box('steel', sw, sb - 0.002, 0.006, cx, H - sb, zF - 0.003);
    b.cyl('matteBlack', 0.022, 0.003, cx, H - sb + 0.006, sz);
    const tz = z0 + 0.08, tipZ = z0 + 0.2, tipY = H + 0.29;
    b.dyn({ id: 'kitchen-tap', kind: 'tap', label: 'tap', sound: 'water', dur: 0.25 }, [
      { p: [cx, H, tz], keep: true, build: (d) => { d.cyl('metal', 0.025, 0.05, 0, 0, 0); d.cyl('metal', 0.012, 0.32, 0, 0.05, 0, true); d.add(G.torus, 'metal', 0, 0.37, 0.06, 0, HP, 0, 0.06, 0.06, 0.15); d.cyl('metal', 0.012, 0.08, 0, 0.29, 0.12, true); } },
      { p: [cx + 0.025, H + 0.1, tz], anim: ['hinge', 'z', -0.7], build: (d) => { d.box('metal', 0.06, 0.012, 0.012, 0.03, -0.006, 0); } },
      { p: [cx, H, tz + 0.06], proxy: true, build: (d) => { d.box('white', 0.2, 0.46, 0.28, 0, 0, 0); } }
    ], [{ type: 'stream', p: [cx, tipY, tipZ], h: tipY - (H - sb + 0.008), r: 0.006, splash: 0.05 }]);
    b.cyl('glassware', 0.028, 0.16, cx + 0.3, H, z0 + 0.08);
  } else b.box('worktop', baseW, wt, D, baseC, H - wt, z0 + D / 2);
  b.box('splash', baseW, Math.min(0.62, opts.ceil - H - 0.9), 0.012, baseC, H, z0 + 0.006);
  if (hobSlot) {
    const cx = hobSlot.x + hobSlot.w / 2;
    b.add(G.box, 'hob', cx, H - 0.001, z0 + 0.33, 0, 0, 0, 0.58, 0.006, 0.51);
    const hy = H + 0.65;
    if (sd.kin === 'lisboa') { b.box('joinery', 0.8, 0.26, 0.5, cx, hy, z0 + 0.25); b.box('metal', 0.82, 0.03, 0.52, cx, hy, z0 + 0.26); b.box('joinery', 0.34, opts.ceil - hy - 0.26, 0.3, cx, hy + 0.26, z0 + 0.15); }
    else { const hm = sd.kin === 'noir' ? 'matteBlack' : 'steel'; b.box(hm, 0.6, 0.05, 0.5, cx, hy, z0 + 0.25); b.box(hm, 0.26, opts.ceil - hy - 0.05, 0.24, cx, hy + 0.05, z0 + 0.12); }
    const hl = b.light(cx, hy - 0.1, z0 + 0.3, 0xffe6c8, 0.7, 2.2, 'hood-light');
    b.dyn({ id: 'kitchen-hood-light', kind: 'lamp', label: 'light', sound: 'click', emis: 'lamp', lamp: hl }, [
      { p: [cx, hy, z0 + 0.25], build: (d) => { d.box('ledStrip', 0.5, 0.004, 0.03, 0, -0.003, 0.15); } },
      { p: [cx, hy, z0 + 0.25], proxy: true, build: (d) => { d.box('white', 0.62, 0.12, 0.52, 0, -0.03, 0); } }
    ]);
    b.add(lathe('pan', [[0, 0], [0.12, 0], [0.125, 0.07], [0.12, 0.07], [0.115, 0.005], [0, 0.005]], 28), 'matteBlack', cx - 0.14, H + 0.005, z0 + 0.2);
    b.box('matteBlack', 0.03, 0.015, 0.2, cx - 0.14, H + 0.06, z0 + 0.42, 0, -0.15);
  }
  const uy = H + 0.65, uh = Math.min(0.9, opts.ceil - 0.2 - uy), ud = 0.34;
  if (opts.upper !== false) for (const s of slots) {
    if (s.k === 'hob') continue;
    const cx = s.x + s.w / 2;
    if (sd.kin === 'lisboa' || sd.id === 'urban') {
      b.box('wood', s.w, 0.035, 0.26, cx, uy + 0.35, z0 + 0.13);
      if (sd.id === 'urban') { b.box('wood', s.w, 0.035, 0.26, cx, uy + 0.02, z0 + 0.13); b.box('steelFrame', 0.02, 0.37, 0.02, cx - s.w / 2 + 0.02, uy, z0 + 0.25); b.box('steelFrame', 0.02, 0.37, 0.02, cx + s.w / 2 - 0.02, uy, z0 + 0.25); if (s.k === 'sink' || s.k === 'wm') for (let i = 0; i < 3; i++) b.cyl('glassware', 0.035, 0.11, cx - 0.14 + i * 0.14, uy + 0.055, z0 + 0.12); }
      if (s.k === 'drawer' || s.k === 'dw') for (let i = 0; i < Math.floor(s.w / 0.15); i++) b.add(lathe('jar', [[0, 0], [0.05, 0], [0.055, 0.14], [0.03, 0.16], [0, 0.16]], 16), i % 2 ? 'plate2' : 'stoneware', cx - s.w / 2 + 0.1 + i * 0.14, uy + 0.385, z0 + 0.12);
      b.box('ledStrip', s.w - 0.04, 0.004, 0.02, cx, uy + 0.345, z0 + 0.2);
    } else {
      const cdp = ud - 0.018, zcc = z0 + cdp / 2;
      F_carcass(b, 'joinery', s.w - 0.004, uh, cdp, cx, uy, zcc, { top: true, side: 'joinery', back: 'white' });
      b.box('ledStrip', s.w - 0.04, 0.004, 0.02, cx, uy - 0.004, z0 + 0.3);
      if (s.w < 0.22) { b.box('joinery', s.w - 0.004, uh, 0.018, cx, uy, z0 + cdp + 0.009); continue; }
      const iw = s.w - 0.05;
      b.dyn({ id: 'kitchen-wallcab', kind: 'cabinet', label: 'cabinet', sound: 'door' }, [
        { p: [flip ? s.x + s.w : s.x, uy, z0 + cdp], anim: ['hinge', 'y', flip ? 1.75 : -1.75], build: (d) => { const x0 = flip ? -s.w : 0; d.box('joinery', s.w - 0.006, uh - 0.004, 0.018, x0 + s.w / 2, 0.002, 0.009); if (s.w > 0.25) d.box('metal', 0.012, 0.25, 0.012, flip ? x0 + 0.04 : x0 + s.w - 0.04, 0.03, 0.026); } },
        { p: [cx, uy, zcc], reveal: true, build: (d) => {
          for (const yy of [uh * 0.36, uh * 0.68]) d.box('white', iw, 0.014, cdp - 0.03, 0, yy, 0);
          for (let k = 0; k < 5; k++) d.add(G.cyl, 'plate', -iw / 2 + 0.15, 0.022 + k * 0.012, 0, 0, 0, 0, 0.11, 0.008, 0.11);
          for (let k = 0; k < Math.floor(iw / 0.1); k++) d.cyl('glassware', 0.034, 0.1, -iw / 2 + 0.06 + k * 0.1, uh * 0.36 + 0.014, 0.02);
          for (let k = 0; k < 3; k++) d.add(lathe('jar', [[0, 0], [0.05, 0], [0.055, 0.14], [0.03, 0.16], [0, 0.16]], 16), k % 2 ? 'plate2' : 'stoneware', -iw / 2 + 0.09 + k * 0.13, uh * 0.68 + 0.014, 0);
        } }
      ]);
    }
  }
  const tallH = Math.min(2.25, opts.ceil - 0.05);
  for (const m of mods) {
    const cx = m.x + m.w / 2, iw = m.w - 0.05, hs = flip ? 1 : -1; // hinge on the outer side of the column
    F_carcass(b, 'joineryTall', m.w - 0.004, tallH, cd, cx, 0, zc, { top: true, side: 'joineryTall', back: 'whiteGloss' });
    b.box('joineryTall', 0.006, tallH, D - 0.004, m.x + (flip ? m.w - 0.003 : 0.003), 0, z0 + D / 2);
    const door = (id, kind, label, y, hh, inner, fx) => b.dyn({ id, kind, label, sound: 'door', dur: 0.7 }, [
      { p: [cx + hs * m.w / 2, y, zf], anim: ['hinge', 'y', hs * 1.85], build: (d) => F_front(d, sd, hs < 0 ? 0 : -m.w, m.w, hh, hs < 0 ? 'right' : 'left', 'joineryTall') },
      { p: [cx + hs * m.w / 2, y, zf], anim: ['hinge', 'y', hs * 1.85], reveal: true, build: (d) => { const x0 = hs < 0 ? 0.04 : -m.w + 0.04; d.box('whiteGloss', m.w - 0.08, hh - 0.06, 0.03, x0 + (m.w - 0.08) / 2, 0.03, -0.015); if (kind === 'fridge') for (const yy of [0.12, hh * 0.45, hh * 0.75]) { d.box('whiteGloss', m.w - 0.12, 0.05, 0.08, x0 + (m.w - 0.08) / 2, yy, -0.07); d.cyl('glassware', 0.03, 0.2, x0 + 0.1, yy + 0.02, -0.07); d.cyl('tint:#3c6b3a', 0.03, 0.24, x0 + 0.19, yy + 0.02, -0.07); d.cyl('tint:#e8e0c8', 0.032, 0.17, x0 + 0.3, yy + 0.02, -0.07); } } },
      { p: [cx, y, zc], reveal: true, build: inner }
    ], fx);
    if (m.k === 'fridge') {
      const fy = 0.03, fh = 0.78, ry = 0.84, rh = tallH - 0.86;
      b.box('whiteGloss', m.w - 0.04, 0.03, cd, cx, 0.81, zc);
      door('kitchen-freezer', 'fridge', 'freezer', fy, fh, (d) => {
        for (const yy of [0.02, 0.27, 0.52]) { d.box('glassware', iw - 0.02, 0.2, 0.012, 0, yy, cd / 2 - 0.1); d.box('whiteGloss', iw - 0.02, 0.012, cd - 0.14, 0, yy, -0.02); d.rb('tint:#d7e3ea', 0.2, 0.09, 0.16, -0.1, yy + 0.014, -0.05, 0.02); d.rb('tint:#b7c9a8', 0.16, 0.07, 0.2, 0.13, yy + 0.014, -0.03, 0.02); }
      }, [{ type: 'light', p: [cx, fy + fh - 0.03, zc], rx: HP, w: iw - 0.06, h: cd - 0.2, color: '#eaf4ff', intensity: 1.6 }]);
      door('kitchen-fridge', 'fridge', 'fridge', ry, rh, (d) => {
        const sh = [0.02, rh * 0.26, rh * 0.5, rh * 0.74], sdp = cd - 0.16, zz = -0.05;
        for (const yy of sh) d.box('glassware', iw - 0.02, 0.008, sdp, 0, yy, zz);
        d.box('whiteGloss', iw - 0.03, 0.16, sdp - 0.04, 0, sh[0] + 0.01, zz); d.box('glassware', iw - 0.03, 0.17, 0.008, 0, sh[0] + 0.01, zz + sdp / 2 - 0.02);
        for (let k = 0; k < 3; k++) d.add(lathe('bottle', [[0, 0], [0.036, 0], [0.036, 0.17], [0.014, 0.24], [0.014, 0.29], [0, 0.29]], 14), k === 1 ? 'tint:#3c6b3a' : 'glassware', -iw / 2 + 0.07 + k * 0.085, sh[1] + 0.008, zz - 0.05);
        d.rb('tint:#f1e3a0', 0.16, 0.07, 0.12, iw / 2 - 0.12, sh[1] + 0.008, zz, 0.02); d.cyl('tint:#c9452f', 0.05, 0.09, iw / 2 - 0.12, sh[1] + 0.078, zz);
        d.add(lathe('fbowl', [[0, 0], [0.05, 0], [0.14, 0.07], [0.135, 0.072], [0.045, 0.008], [0, 0.008]], 24), 'plate', -0.08, sh[2] + 0.008, zz, 0, 0, 0, 0.8, 0.8, 0.8);
        for (let k = 0; k < 4; k++) d.sph(k % 2 ? 'tint:#c9361f' : 'tint:#7aa33a', 0.034, 0.032, 0.034, -0.08 + Math.cos(k * 1.6) * 0.05, sh[2] + 0.06, zz + Math.sin(k * 1.6) * 0.05, true);
        d.rb('tint:#e9e2d2', 0.14, 0.1, 0.14, iw / 2 - 0.11, sh[2] + 0.008, zz, 0.015); d.rb('tint:#4a7ab0', 0.09, 0.2, 0.09, iw / 2 - 0.28, sh[2] + 0.008, zz - 0.03, 0.012);
        for (let k = 0; k < 4; k++) d.cyl(k % 2 ? 'tint:#e8e0c8' : 'tint:#b5652e', 0.035, 0.1, -iw / 2 + 0.07 + k * 0.1, sh[3] + 0.008, zz);
        d.rb('tint:#f3f0e8', 0.07, 0.24, 0.07, iw / 2 - 0.08, sh[3] + 0.008, zz - 0.03, 0.01);
      }, [{ type: 'light', p: [cx, ry + rh - 0.04, zc - 0.03], rx: HP, w: iw - 0.06, h: cd - 0.2, color: '#eaf4ff', intensity: 2.2 }, { type: 'light', p: [cx, ry + rh / 2, zc - cd / 2 + 0.012], w: iw - 0.02, h: rh - 0.04, color: '#f4f8fb', intensity: 0.9 }]);
    } else {
      const oy = 0.6, oh = 0.6, my = 1.3, mh = 0.4;
      b.dyn({ id: 'kitchen-cabinet', kind: 'cabinet', label: 'cabinet', sound: 'door' }, [
        { p: [cx + hs * m.w / 2, 0.03, zf], anim: ['hinge', 'y', hs * 1.75], build: (d) => F_front(d, sd, hs < 0 ? 0 : -m.w, m.w, oy - 0.05, hs < 0 ? 'right' : 'left', 'joineryTall') },
        { p: [cx, 0.03, zc], reveal: true, build: (d) => { d.box('white', iw, 0.014, cd - 0.04, 0, 0.26, 0); d.add(lathe('pot2', [[0, 0], [0.1, 0], [0.105, 0.11], [0.1, 0.11], [0.095, 0.006], [0, 0.006]], 24), 'steel', -0.08, 0.02, 0); d.rb('matteBlack', 0.3, 0.05, 0.36, 0.02, 0.275, 0, 0.01); } }
      ]);
      b.box('joineryTall', m.w - 0.004, 0.02, FT, cx, oy - 0.02, zf + FT / 2);
      oven(cx, oy, m.w - 0.04, oh, 'kitchen-oven');
      b.box('steel', m.w - 0.04, 0.1, 0.022, cx, oy + oh, zf + 0.011);
      b.box('ledStrip', 0.05, 0.01, 0.004, cx + 0.2, oy + oh + 0.05, zf + 0.024);
      // microwave: side-hinged glass door, lit cavity with a turntable
      const mw = m.w - 0.04;
      b.box('matteBlack', mw, mh, 0.012, cx, my, zc - cd / 2 + 0.2); b.box('matteBlack', mw, 0.012, cd - 0.2, cx, my, zc + 0.1); b.box('matteBlack', mw, 0.012, cd - 0.2, cx, my + mh - 0.012, zc + 0.1);
      b.dyn({ id: 'kitchen-microwave', kind: 'oven', label: 'microwave', sound: 'door' }, [
        { p: [cx - mw / 2, my, zf], anim: ['hinge', 'y', -1.7], build: (d) => { d.box('blackGlass', mw - 0.004, mh - 0.004, 0.022, mw / 2, 0.002, 0.011); d.box('steel', 0.012, mh - 0.12, 0.014, mw - 0.04, 0.06, 0.04); } },
        { p: [cx, my, zc + 0.1], reveal: true, build: (d) => { d.add(G.cyl, 'glassware', 0, 0.02, 0, 0, 0, 0, 0.14, 0.006, 0.14); d.cyl('ceramic', 0.045, 0.08, 0, 0.026, 0); } }
      ], [{ type: 'light', p: [cx, my + mh - 0.02, zc + 0.1], rx: HP, w: mw - 0.1, h: 0.2, color: '#fff0d0', intensity: 2 }]);
      b.box('steel', m.w - 0.04, 0.04, 0.022, cx, my + mh, zf + 0.011);
      b.dyn({ id: 'kitchen-cabinet', kind: 'cabinet', label: 'cabinet', sound: 'door' }, [
        { p: [cx + hs * m.w / 2, my + mh + 0.04, zf], anim: ['hinge', 'y', hs * 1.75], build: (d) => F_front(d, sd, hs < 0 ? 0 : -m.w, m.w, tallH - (my + mh + 0.04), null, 'joineryTall') },
        { p: [cx, my + mh + 0.04, zc], reveal: true, build: (d) => { d.box('white', iw, 0.014, cd - 0.04, 0, 0.0, 0); for (let k = 0; k < 4; k++) d.rb(k % 2 ? 'tint:#d9cdb4' : 'tint:#8aa0b4', 0.1, 0.22, 0.2, -iw / 2 + 0.08 + k * 0.12, 0.014, 0, 0.01); } }
      ]);
    }
  }
  const props = slots.filter(s => (s.k === 'drawer' || s.k === 'dw' || s.k === 'wm' || s.k === 'filler') && s.w >= 0.45);
  if (props.length) {
    const c = props[0], cx = c.x + c.w / 2;
    b.rb('matteBlack', 0.2, 0.34, 0.3, cx - 0.12, H, z0 + 0.18, 0.02);
    b.box('steel', 0.18, 0.08, 0.01, cx - 0.12, H + 0.22, z0 + 0.335);
    b.box('steel', 0.14, 0.012, 0.1, cx - 0.12, H, z0 + 0.28);
    b.cyl('ceramic', 0.035, 0.07, cx - 0.12, H + 0.012, z0 + 0.28);
    b.add(lathe('kettle', [[0, 0], [0.08, 0], [0.09, 0.03], [0.08, 0.17], [0.05, 0.2], [0.0, 0.205]], 24), sd.kin === 'noir' ? 'matteBlack' : sd.kin === 'lisboa' ? 'metal' : 'whiteGloss', cx + 0.15, H + 0.012, z0 + 0.2);
    b.cyl('black', 0.09, 0.012, cx + 0.15, H, z0 + 0.2);
    b.add(G.torus, 'black', cx + 0.24, H + 0.12, z0 + 0.2, 0, 0, 0, 0.06, 0.07, 0.25);
    b.cyl('black', 0.01, 0.08, cx + 0.07, H + 0.14, z0 + 0.2, true, 0, 1.0);
  }
  const c2 = props.length > 1 ? props[1] : null;
  if (c2) {
    const cx = c2.x + c2.w / 2;
    b.box('wood', 0.1, 0.22, 0.14, cx - 0.15, H, z0 + 0.1, 0, -0.35);
    for (let i = 0; i < 4; i++) b.box('black', 0.018, 0.1, 0.012, cx - 0.18 + i * 0.02, H + 0.22, z0 + 0.075, 0, 0, -0.35);
    if (hasModel('wooden_cutting_board')) b.model('wooden_cutting_board', cx + 0.12, H, z0 + 0.2, 0.3, { w: 0.4 });
    else b.box('wood', 0.3, 0.42, 0.02, cx + 0.1, H, z0 + 0.02, 0, 0, -0.1);
  }
  // fruit bowl on the worktop end next to the columns
  const fb = props[props.length - 1];
  if (fb && (props.length > 2 || !c2)) {
    const cx = fb.x + fb.w / 2 + (props.length > 2 ? 0 : 0.1);
    if (hasModel('carved_wooden_plate') && F_fruitModels(b, cx, H + 0.02, z0 + 0.38, 2)) b.model('carved_wooden_plate', cx, H, z0 + 0.38, 0, { w: 0.3 });
    else { b.add(lathe('fbowl', [[0, 0], [0.05, 0], [0.14, 0.07], [0.135, 0.072], [0.045, 0.008], [0, 0.008]], 24), 'stoneware', cx, H, z0 + 0.4); F_fruit(b, cx, H + 0.02, z0 + 0.4, 6); }
  }
}
function F_island(b, sd, w, d, stools) {
  b.shadow(w + 0.15, d + 0.25);
  const H = 0.9;
  b.box('matteBlack', w - 0.1, 0.1, d - 0.25, 0, 0, -0.05);
  b.box(sd.kin === 'atlantic' ? 'joineryTall' : 'joinery', w - 0.05, H - 0.04 - 0.1, d - 0.2, 0, 0.1, -0.06);
  b.box('worktop', w, 0.04, d, 0, H - 0.04, 0);
  // waterfall ends in Noir/Atlantic
  if (sd.kin !== 'lisboa') { b.box('worktop', 0.04, H - 0.04, d, -w / 2 + 0.02, 0, 0); b.box('worktop', 0.04, H - 0.04, d, w / 2 - 0.02, 0, 0); }
  for (let i = 0; i < stools; i++) b.pf('stool', F_stoolProto, -w / 2 + (i + 0.5) * w / stools, 0, d / 2 + 0.28, PI, 1);
  F_vase(b, w / 2 - 0.25, H, -0.1, 0.8, true);
  F_books(b, -w / 2 + 0.25, H, -0.1, 2, 0.4);
}
function F_bed(b, sd, W, L) {
  b.shadow(W + 0.45, L + 0.25, 0, -0.04);
  const H = 0.3, mat = 0.24;
  // base (upholstered platform)
  if (sd.id === 'natura') b.rb('wood', W + 0.4, 0.1, L + 0.16, 0, 0.1, 0.02, 0.012); // floating timber deck
  b.rb(sd.id === 'natura' ? 'wood' : 'headboard', W + 0.06, H, L, 0, 0.03, 0, 0.03);
  b.box('matteBlack', W - 0.1, 0.03, L - 0.2, 0, 0, 0);
  // headboard
  const hbH = sd.kin === 'lisboa' ? 1.2 : 1.05;
  if (sd.kin === 'lisboa') { // cane-like panel in walnut frame
    b.rb('wood', W + 0.3, hbH, 0.07, 0, 0, -L / 2 - 0.03, 0.02);
    b.rb('headboard', W + 0.1, hbH - 0.25, 0.04, 0, 0.35, -L / 2 + 0.01, 0.02);
  } else {
    const n = sd.kin === 'noir' ? 1 : 4;
    if (sd.id === 'natura') { b.rb('wood', W + 0.4, 0.62, 0.05, 0, 0.2, -L / 2 - 0.02, 0.01); for (let i = 0; i < Math.round((W + 0.36) / 0.07); i++) b.I('hbslat', G.box, 'wood', -(W + 0.36) / 2 + 0.035 + i * 0.07, 0.22, -L / 2 + 0.012, 0, 0, 0, 0.03, 0.58, 0.018); }
    else for (let i = 0; i < n; i++) { const cw = (W + 0.3) / n; b.rb('headboard', cw - 0.01, hbH, 0.1, -(W + 0.3) / 2 + cw * (i + 0.5), 0, -L / 2 - 0.03, 0.045); }
  }
  // mattress
  b.rb('bedding', W, mat, L - 0.04, 0, H + 0.03, 0.0, 0.05);
  // duvet (folded back at top)
  b.rb('duvet', W + 0.08, 0.06, L * 0.72, 0, H + 0.03 + mat - 0.03, L * 0.14 + 0.02, 0.03);
  b.rb('duvet', W + 0.08, 0.34, 0.05, 0, H + 0.03 + mat - 0.34 + 0.08, L / 2 + 0.01, 0.02); // front drop
  b.rb('duvet', 0.05, 0.3, L * 0.72, -W / 2 - 0.04, H + 0.03 + mat - 0.26, L * 0.14 + 0.02, 0.02);
  b.rb('duvet', 0.05, 0.3, L * 0.72, W / 2 + 0.04, H + 0.03 + mat - 0.26, L * 0.14 + 0.02, 0.02);
  b.rb('duvet', W + 0.06, 0.08, 0.3, 0, H + 0.03 + mat - 0.02, -L / 2 + L * 0.28 + 0.05, 0.04); // fold
  // throw across foot
  b.rb('bedThrow', W + 0.12, 0.03, 0.5, 0, H + 0.03 + mat + 0.03, L / 2 - 0.35, 0.012);
  b.rb('bedThrow', W + 0.12, 0.28, 0.03, 0, H + 0.03 + mat - 0.24, L / 2 + 0.05, 0.012);
  // pillows
  const py = H + 0.03 + mat;
  const np = W > 1.3 ? 2 : 1;
  for (let i = 0; i < np; i++) {
    const px = np === 1 ? 0 : (i ? 1 : -1) * W / 4;
    b.rb('bedding', W / np - 0.08, 0.16, 0.5, px, py - 0.02, -L / 2 + 0.3, 0.07, 0, -0.5);
    b.rb('bedding', W / np - 0.12, 0.15, 0.45, px, py + 0.02, -L / 2 + 0.4, 0.07, 0, -0.35);
  }
  b.rb('c0', 0.5, 0.3, 0.12, 0, py + 0.04, -L / 2 + 0.58, 0.05, 0, -0.3);
  if (W > 1.3) { b.rb('c2', 0.4, 0.28, 0.12, -0.42, py + 0.04, -L / 2 + 0.58, 0.05, 0.15, -0.3); b.rb('c2', 0.4, 0.28, 0.12, 0.42, py + 0.04, -L / 2 + 0.58, 0.05, -0.15, -0.3); }
}
function F_bedside(b, sd, withLamp = true) {
  b.shadow(0.56, 0.5);
  const w = 0.45, d = 0.38, h = 0.5, mk = sd.kin === 'noir' ? 'woodDark' : 'wood', bh = h - 0.12;
  F_carcass(b, mk, w, bh, d - 0.02, 0, 0.12, -0.01, { top: true, side: mk, back: mk });
  for (const [x, z] of [[-0.18, -0.14], [0.18, -0.14], [-0.18, 0.14], [0.18, 0.14]]) b.cyl('metal', 0.01, 0.12, x, 0, z, true);
  b.dyn({ id: 'bed-drawer', kind: 'drawer', label: 'drawer', sound: 'drawer', dur: 0.4 }, [
    { p: [0, 0.12, d / 2 - 0.02], anim: ['slide', 0, 0, 0.24], build: (dd) => { dd.box(mk, w - 0.004, bh - 0.004, 0.02, 0, 0.002, 0.01); dd.box('metal', 0.14, 0.01, 0.015, 0, bh / 2, 0.027); } },
    { p: [0, 0.12, d / 2 - 0.02], anim: ['slide', 0, 0, 0.24], reveal: true, build: (dd) => { F_drawerBox(dd, w - 0.06, bh - 0.12, d - 0.07, 0.04); dd.box('tint:#2f4a6b', 0.14, 0.025, 0.2, -0.06, 0.054, -0.15, 0.2); dd.box('paper', 0.13, 0.02, 0.19, -0.06, 0.057, -0.15, 0.2); dd.rb('c1', 0.12, 0.05, 0.16, 0.1, 0.054, -0.16, 0.015); } }
  ]);
  if (withLamp) {
    F_tableLamp(b, sd, 0.08, h, -0.04, 1, 0.7);
    F_books(b, -0.1, h, 0.06, 2, 0.2);
  }
}
function F_wardrobe(b, sd, w, h) {
  b.shadow(w + 0.08, 0.78);
  const d = 0.6, n = Math.max(2, Math.min(4, Math.round(w / 0.55))), dw = w / n, cd = d - 0.022, zc = -0.011;
  F_carcass(b, 'joineryTall', w, h, cd, 0, 0, zc, { top: true, side: 'joineryTall', back: 'joineryTall' });
  b.box('joineryTall', w - 0.036, 0.018, cd - 0.03, 0, h - 0.42, zc);          // hat shelf
  b.cyl('metal', 0.012, w - 0.04, -w / 2 + 0.02, h - 0.5, zc, true, 0, -HP);      // hanging rail
  const R = mulberry(hashStr('wr' + w.toFixed(2) + sd.id)), cl = ['c0', 'c1', 'c2', 'c3', 'bedding', 'duvet', 'bedThrow', 'napkin'];
  for (let x = -w / 2 + 0.12, i = 0; x < w / 2 - 0.1; x += 0.085 + R() * 0.05, i++) { // clothes on hangers
    const len = 0.6 + R() * 0.45, k = cl[(R() * cl.length) | 0];
    b.box(k, 0.035, len, 0.42, x, h - 0.56 - len, zc, 0, 0, (R() - 0.5) * 0.04);
    b.box('wood', 0.012, 0.03, 0.4, x, h - 0.555, zc); b.cyl('metal', 0.003, 0.05, x, h - 0.53, zc, true);
  }
  for (let i = 0; i < 3; i++) b.box(cl[(i * 3) % cl.length], 0.3, 0.048, 0.36, -w / 2 + 0.22, h - 0.4 + i * 0.05, zc);
  b.box('paper', 0.34, 0.2, 0.3, w / 2 - 0.25, h - 0.4, zc); b.box('wood', 0.3, 0.13, 0.4, -w / 2 + 0.24, 0.02, zc); b.box('paper', 0.3, 0.12, 0.4, -w / 2 + 0.24, 0.15, zc);
  for (let i = 0; i < n; i++) {
    const left = i % 2 === 0, hx = -w / 2 + (left ? i : i + 1) * dw, sg = left ? 1 : -1;
    b.dyn({ id: 'wardrobe-door', kind: 'wardrobe', label: 'wardrobe', sound: 'door', dur: 0.7, range: 3 }, [
      { p: [hx, 0, d / 2 - 0.022], anim: ['hinge', 'y', -sg * 1.7], build: (dd) => { dd.box('joineryTall', dw - 0.004, h - 0.006, 0.022, sg * dw / 2, 0.003, 0.011); dd.box('metal', 0.014, 0.4, 0.02, sg * (dw - 0.05), 0.9, 0.034); if (sd.id === 'riviera') { const r = 0.06, ww = dw - 0.03, hh = h - 0.03; dd.box('joineryTall', ww, r, 0.01, sg * dw / 2, 0.015, 0.027); dd.box('joineryTall', ww, r, 0.01, sg * dw / 2, 0.015 + hh - r, 0.027); dd.box('joineryTall', r, hh, 0.01, sg * (0.015 + r / 2), 0.015, 0.027); dd.box('joineryTall', r, hh, 0.01, sg * (dw - 0.015 - r / 2), 0.015, 0.027); } } }
    ]);
  }
}
function F_desk(b, sd, w) {
  b.shadow(w + 0.1, 1.0, 0, 0.2);
  const d = 0.55, H = 0.74;
  b.rb('wood', w, 0.03, d, 0, H - 0.03, 0, 0.006);
  for (const sx of [-1, 1]) { b.box('matteBlack', 0.03, H - 0.03, 0.03, sx * (w / 2 - 0.05), 0, -d / 2 + 0.05); b.box('matteBlack', 0.03, H - 0.03, 0.03, sx * (w / 2 - 0.05), 0, d / 2 - 0.05); }
  b.box('joinery', 0.4, 0.14, d - 0.06, w / 2 - 0.25, H - 0.17, 0);
  // laptop
  b.box('steel', 0.32, 0.012, 0.22, -0.05, H, 0.02);
  b.box('steel', 0.32, 0.21, 0.008, -0.05, H + 0.012, -0.09, 0, -0.25);
  b.add(G.plane, 'blackGlass', -0.05, H + 0.115, -0.083, -0.25, 0, 0, 0.3, 0.19, 1);
  // desk lamp
  b.cyl('matteBlack', 0.07, 0.015, w / 2 - 0.15, H, -0.15);
  b.cyl('matteBlack', 0.007, 0.4, w / 2 - 0.15, H, -0.15, true, 0, 0.35);
  b.add(lathe('dlamp', [[0.001, 0.12], [0.02, 0.12], [0.07, 0.0], [0.068, 0], [0.018, 0.115], [0.001, 0.115]], 20), 'matteBlack', w / 2 - 0.29, H + 0.28, -0.1, PI);
  b.sph('bulb', 0.02, 0.02, 0.02, w / 2 - 0.29, H + 0.25, -0.1, true);
  F_books(b, -w / 2 + 0.2, H, -0.12, 3, 0.05);
  b.cyl('stoneware', 0.04, 0.1, -w / 2 + 0.45, H, -0.15);
  for (let i = 0; i < 3; i++) b.cyl('black', 0.004, 0.16, -w / 2 + 0.44 + i * 0.01, H + 0.02, -0.15, true, 0.1 * (i - 1), 0.1);
  // chair
  b.pf('chair', F_chairProto, 0, 0, d / 2 + 0.05, PI, 1);
}
function F_console(b, sd, w) {
  if (hasModel('potted_plant_04')) b.model('potted_plant_04', -w / 2 + 0.45, 0.8, -0.04, 0.5, { h: 0.27 });
  b.shadow(w + 0.05, 0.42);
  const d = 0.3, H = 0.8;
  b.rb(sd.kin === 'noir' ? 'worktop' : 'wood', w, 0.03, d, 0, H - 0.03, 0, 0.005);
  b.box('metal', 0.02, H - 0.03, 0.02, -w / 2 + 0.04, 0, -d / 2 + 0.04); b.box('metal', 0.02, H - 0.03, 0.02, w / 2 - 0.04, 0, -d / 2 + 0.04);
  b.box('metal', 0.02, H - 0.03, 0.02, -w / 2 + 0.04, 0, d / 2 - 0.04); b.box('metal', 0.02, H - 0.03, 0.02, w / 2 - 0.04, 0, d / 2 - 0.04);
  b.box('metal', w - 0.06, 0.02, d - 0.06, 0, 0.12, 0);
  F_vase(b, w / 2 - 0.15, H, 0, 0.8, true);
  b.add(lathe('trayb', [[0, 0], [0.1, 0], [0.1, 0.015], [0.095, 0.015], [0.095, 0.004], [0, 0.004]], 24), 'metal', 0.02, H, 0.03, 0, 0, 0, 0.8, 1, 0.8);
  b.box('metal', 0.05, 0.004, 0.02, 0.02, H + 0.005, 0.03, 0.5); // keys
  F_tableLamp(b, sd, -w / 2 + 0.17, H, -0.02, 0.85, 0.8);
  F_books(b, -w / 2 + 0.2, 0.14, 0.0, 3, 0.1);
  // round mirror above
  b.add(G.cyl, 'metal', 0, 1.55, -d / 2 + 0.012, HP, 0, 0, 0.36, 0.02, 0.36);
  b.add(G.cyl, 'mirror', 0, 1.55, -d / 2 + 0.024, HP, 0, 0, 0.34, 0.006, 0.34);
}
function F_hooks(b, sd, n = 4) {
  b.box(sd.kin === 'noir' ? 'woodDark' : 'wood', 0.12 + n * 0.16, 0.08, 0.02, 0, 1.72, 0.01);
  for (let i = 0; i < n; i++) { const x = -(n - 1) * 0.08 + i * 0.16; b.cyl('metal', 0.01, 0.07, x, 1.75, 0.02, true, HP); b.sph('metal', 0.014, 0.014, 0.014, x, 1.75, 0.09, true); }
  // coat & bag
  b.rb('c3', 0.4, 0.8, 0.1, -(n - 1) * 0.08, 0.9, 0.08, 0.04);
  b.rb('stoneware', 0.3, 0.26, 0.1, (n - 1) * 0.08, 1.4, 0.06, 0.03);
  b.cyl('stoneware', 0.005, 0.2, (n - 1) * 0.08, 1.62, 0.09, true, 0, 0.3);
}

// bathroom
function F_vanity(b, sd, w) {
  const d = 0.48, H = 0.86;
  b.light(0, 1.75, 0.35, 0xfff0dc, 1.1, 3.2, 'mirror-light');
  if (sd.id === 'riviera') { b.box('worktop', w, 0.07, d, 0, H - 0.11, 0); for (const sx of [-1, 1]) b.box('metal', 0.02, 0.24, 0.02, sx * (w / 2 - 0.12), H - 0.35, -d / 2 + 0.02); b.cyl('metal', 0.008, w - 0.2, -w / 2 + 0.1, H - 0.3, d / 2 - 0.06, true, 0, -HP); b.rb('towel', 0.3, 0.3, 0.04, 0.1, H - 0.6, d / 2 - 0.06, 0.012); }
  else {
    const mk = sd.kin === 'lisboa' ? 'wood' : 'joineryTall', bh = 0.36, cd = d - 0.02;
    F_carcass(b, mk, w, bh, cd, 0, H - 0.4, -0.01, { top: false, side: mk, back: mk });
    b.dyn({ id: 'bath-drawer', kind: 'drawer', label: 'drawer', sound: 'drawer', dur: 0.45 }, [
      { p: [0, H - 0.4, d / 2 - 0.02], anim: ['slide', 0, 0, 0.3], build: (dd) => { dd.box(mk, w - 0.004, bh - 0.004, 0.02, 0, 0.002, 0.01); dd.box('black', w - 0.02, 0.004, 0.003, 0, bh / 2, 0.021); dd.box('metal', Math.min(0.3, w * 0.4), 0.01, 0.014, 0, bh - 0.06, 0.03); } },
      { p: [0, H - 0.4, d / 2 - 0.02], anim: ['slide', 0, 0, 0.3], reveal: true, build: (dd) => { F_drawerBox(dd, w - 0.06, bh - 0.12, cd - 0.14, 0.03); for (let k = 0; k < 3; k++) dd.rb(k % 2 ? 'towel2' : 'towel', 0.2, 0.045, 0.24, -w / 2 + 0.18, 0.044 + k * 0.045, -0.17, 0.012); for (let k = 0; k < 3; k++) dd.cyl(k === 1 ? 'stoneware' : 'wax', 0.024, 0.11 + k * 0.01, w / 2 - 0.12 - k * 0.07, 0.044, -0.12); } }
    ]);
  }
  b.box('ledStrip', w - 0.06, 0.004, 0.02, 0, H - 0.405, d / 2 - 0.05);
  b.box('worktop', w, 0.04, d, 0, H - 0.04, 0);
  // vessel basin
  b.add(lathe('basin', [[0, 0], [0.12, 0], [0.19, 0.04], [0.2, 0.13], [0.19, 0.13], [0.18, 0.05], [0.11, 0.018], [0, 0.018]], 32), 'ceramic', 0, H, 0.03, 0, 0, 0, 1, 1, 0.8);
  b.cyl('metal', 0.016, 0.003, 0, H + 0.018, 0.03);
  // wall mounted tap: spout over the basin, lever turns, water runs into the bowl
  const ty = H + 0.3, tz = -d / 2 + 0.01;
  b.dyn({ id: 'bath-tap', kind: 'tap', label: 'tap', sound: 'water', dur: 0.25 }, [
    { p: [0, ty, tz], keep: true, build: (dd) => { dd.cyl('metal', 0.025, 0.012, 0, 0, -0.004, false, HP); dd.cyl('metal', 0.011, 0.18, 0, 0, 0, true, HP); dd.cyl('metal', 0.025, 0.012, 0.1, 0.06, -0.004, false, HP); } },
    { p: [0.1, ty + 0.06, tz], anim: ['hinge', 'z', -0.9], build: (dd) => { dd.cyl('metal', 0.008, 0.06, 0, 0, 0, true, HP); dd.box('metal', 0.01, 0.05, 0.01, 0, 0, 0.055); } },
    { p: [0.04, ty - 0.1, tz], proxy: true, build: (dd) => dd.box('white', 0.3, 0.3, 0.24, 0, 0, 0.1) }
  ], [{ type: 'stream', p: [0, ty - 0.008, tz + 0.172], h: ty - 0.008 - (H + 0.022), r: 0.005, splash: 0.04 }]);
  // accessories
  b.cyl('stoneware', 0.035, 0.16, w / 2 - 0.12, H, -0.1);
  b.cyl('metal', 0.012, 0.03, w / 2 - 0.12, H + 0.16, -0.1);
  b.box('towel', 0.28, 0.06, 0.2, -w / 2 + 0.2, H, -0.05);
  b.box('towel2', 0.26, 0.05, 0.18, -w / 2 + 0.2, H + 0.06, -0.05, 0.1);
  // mirror (backlit)
  const mw = Math.min(w, 0.9), mh = 0.8;
  if (sd.kin === 'atlantic') { b.add(G.cyl, 'ledStrip', 0, H + 0.72, -d / 2 + 0.01, HP, 0, 0, 0.36, 0.01, 0.36); b.add(G.cyl, 'mirror', 0, H + 0.72, -d / 2 + 0.03, HP, 0, 0, 0.35, 0.01, 0.35); }
  else if (sd.kin === 'lisboa') { b.rb('metal', 0.56, mh + 0.04, 0.03, 0, H + 0.3, -d / 2 + 0.015, 0.02); b.box('mirror', 0.52, mh, 0.01, 0, H + 0.32, -d / 2 + 0.032); }
  else { b.box('ledStrip', mw + 0.02, mh + 0.02, 0.01, 0, H + 0.29, -d / 2 + 0.005); b.box('mirror', mw, mh, 0.02, 0, H + 0.3, -d / 2 + 0.012); }
}
function F_wc(b, sd) {
  b.box('whiteGloss', 0.5, 1.1, 0.14, 0, 0, -0.07 + 0.0); // boxed-in cistern
  b.box('worktop', 0.52, 0.02, 0.16, 0, 1.1, -0.07);
  const by = 0.26, bz = 0.28, sz = 1.35;
  b.add(lathe('wcbowl2', [[0, 0], [0.16, 0.0], [0.18, 0.04], [0.18, 0.08], [0.165, 0.14], [0.14, 0.14]], 28), 'ceramic', 0, by, bz, 0, 0, 0, 1, 1, sz);
  b.add(lathe('wcinner', [[0.14, 0.14], [0.12, 0.085], [0.07, 0.035], [0, 0.028]], 28), 'ceramic', 0, by, bz, 0, 0, 0, 1, 1, sz);
  b.add(G.disc, 'glassware', 0, by + 0.062, bz, 0, 0, 0, 0.095, 1, 0.095 * sz);   // standing water
  b.box('ceramic', 0.34, 0.14, 0.2, 0, by, 0.1);
  b.add(G.torus, 'ceramic', 0, by + 0.148, bz, HP, 0, 0, 0.15, 0.15 * sz, 0.14);    // seat ring
  b.dyn({ id: 'wc-lid', kind: 'toilet-lid', label: 'lid', sound: 'click', dur: 0.6 }, [
    { p: [0, by + 0.162, bz - 0.215], anim: ['hinge', 'x', -1.72], build: (d) => { d.add(G.cyl, 'ceramic', 0, 0, 0.215, 0, 0, 0, 0.172, 0.014, 0.172 * sz); d.box('ceramic', 0.2, 0.014, 0.05, 0, 0, 0.02); } }
  ]);
  b.dyn({ id: 'wc-flush', kind: 'toilet-flush', label: 'flush', sound: 'flush', dur: 0.18, pulse: 3.6 }, [
    { p: [0, 0.95, 0.0], anim: ['slide', 0, 0, -0.005], build: (d) => { d.box('metal', 0.2, 0.13, 0.008, 0, 0, 0.004); d.box('black', 0.003, 0.11, 0.002, 0.02, 0.01, 0.009); } },
    { p: [0, 0.9, 0.0], proxy: true, build: (d) => d.box('white', 0.3, 0.24, 0.06, 0, 0, 0.03) }
  ], [{ type: 'swirl', p: [0, by + 0.066, bz], r: 0.105, sz }]);
  // paper holder
  b.cyl('metal', 0.006, 0.12, 0.38, 0.72, 0.1, true, 0, HP);
  b.cyl('paper', 0.055, 0.1, 0.33, 0.72, 0.1, false, 0, HP);
}
function F_shower(b, sd, w, d, glassSide) {
  // tray/floor recess & drain; shower wall finish set by caller; glass screen on 'glassSide'
  b.box('bathFloor', w, 0.012, d, 0, 0, 0);
  b.box('steel', 0.6, 0.004, 0.04, 0, 0.012, -d / 2 + 0.1);
  // rain head + mixer on back wall (-z): tap the mixer or the head to run the shower
  b.dyn({ id: 'bath-shower', kind: 'shower', label: 'shower', sound: 'water', dur: 0.35, range: 3 }, [
    { p: [0, 2.06, -d / 2], keep: true, build: (dd) => { dd.box('metal', 0.02, 0.02, 0.35, 0, 0.02, 0.17); dd.box('metal', 0.25, 0.012, 0.25, 0, 0, 0.3); dd.cyl('metal', 0.035, 0.03, -0.2, -0.96, 0, false, HP); } },
    { p: [0.2, 1.1, -d / 2], anim: ['hinge', 'z', -1.2], build: (dd) => { dd.cyl('metal', 0.035, 0.03, 0, 0, 0, false, HP); dd.box('metal', 0.012, 0.06, 0.012, 0, 0, 0.04); } },
    { p: [0, 0.95, -d / 2], proxy: true, build: (dd) => { dd.box('white', 0.6, 0.34, 0.1, 0, 0, 0.05); dd.box('white', 0.3, 0.12, 0.3, 0, 1.05, 0.3); } }
  ], [{ type: 'shower', p: [0, 2.055, -d / 2 + 0.3], h: 2.03, r: 0.11 }]);
  b.box('metal', 0.012, 0.6, 0.02, 0.35, 0.9, -d / 2 + 0.02);
  b.cyl('metal', 0.02, 0.2, 0.35, 1.45, -d / 2 + 0.05, true);
  // niche shelf with bottles
  b.box('worktop', 0.35, 0.02, 0.1, -w / 2 + 0.3, 1.2, -d / 2 + 0.05);
  for (let i = 0; i < 3; i++) b.cyl(i === 1 ? 'stoneware' : 'wax', 0.025, 0.14 + i * 0.02, -w / 2 + 0.2 + i * 0.08, 1.22, -d / 2 + 0.05);
  // glass screen
  if (sd.id === 'urban' && glassSide === 'front') { const gw = Math.min(w - 0.05, 0.9), gx = w / 2 - gw / 2; b.box('glass', gw, 2.0, 0.008, gx, 0.012, d / 2); for (const x of [gx - gw / 2 + 0.0125, gx + gw / 2 - 0.0125, gx]) b.box('steelFrame', 0.025, 2.04, 0.03, x, 0, d / 2); for (const y of [0, 0.68, 1.36, 2.015]) b.box('steelFrame', gw, 0.025, 0.03, gx, y, d / 2); }
  else if (glassSide === 'front') { const gw = Math.min(w - 0.05, 0.9); b.box('glass', gw, 2.0, 0.008, w / 2 - gw / 2, 0.012, d / 2); b.box('metal', gw, 0.015, 0.012, w / 2 - gw / 2, 2.012, d / 2); b.box('metal', 0.015, 0.8, 0.015, w / 2 - gw, 2.0, d / 2 - 0.004, 0, 0, 0); }
  else { const gd = Math.min(d - 0.05, 0.9); const sx = glassSide === 'left' ? -1 : 1; b.box('glass', 0.008, 2.0, gd, sx * w / 2, 0.012, -d / 2 + gd / 2); b.box('metal', 0.012, 0.015, gd, sx * w / 2, 2.012, -d / 2 + gd / 2); }
}
function F_towelRail(b, sd) {
  for (let i = 0; i < 6; i++) b.cyl('metal', 0.01, 0.5, 0.25, 0.7 + i * 0.13, 0, true, 0, HP);
  b.cyl('metal', 0.014, 0.85, -0.25, 0.62, 0, true); b.cyl('metal', 0.014, 0.85, 0.25, 0.62, 0, true);
  b.rb('towel', 0.36, 0.55, 0.03, 0, 0.8, 0.03, 0.01);
  b.rb('towel2', 0.3, 0.35, 0.035, 0.02, 1.02, 0.05, 0.01);
}

// outdoor
function F_bistro(b, sd) {
  b.shadow(1.6, 0.9);
  b.cyl('outdoor', 0.3, 0.02, 0, 0.72, 0);
  b.cyl('outdoor', 0.02, 0.72, 0, 0, 0, true);
  b.cyl('outdoor', 0.2, 0.012, 0, 0, 0);
  for (const s of [-1, 1]) {
    b.push(s * 0.52, 0, 0, s > 0 ? -HP : HP);
    for (const [x, z] of [[-0.18, -0.18], [0.18, -0.18], [-0.18, 0.18], [0.18, 0.18]]) b.cyl('outdoor', 0.01, 0.44, x, 0, z, true);
    b.box('teak', 0.42, 0.02, 0.42, 0, 0.44, 0);
    for (let i = 0; i < 3; i++) b.box('teak', 0.42, 0.05, 0.015, 0, 0.58 + i * 0.08, -0.2);
    b.box('outdoor', 0.015, 0.34, 0.015, -0.2, 0.44, -0.2); b.box('outdoor', 0.015, 0.34, 0.015, 0.2, 0.44, -0.2);
    b.pop();
  }
  b.cyl('glassware', 0.035, 0.1, 0.08, 0.74, 0.05);
  b.cyl('plate2', 0.05, 0.08, -0.1, 0.74, -0.05);
}
function F_planter(b, w, d, h, kind = 1) {
  b.rb('outdoor', w, h, d, 0, 0, 0, 0.01);
  b.box('soil', w - 0.04, 0.01, d - 0.04, 0, h - 0.03, 0);
  const R = mulberry(hashStr(`pl${w}${d}${kind}`));
  const n = Math.round(w * 6);
  for (let i = 0; i < n; i++) {
    const x = -w / 2 + 0.08 + (w - 0.16) * (i + R() * 0.5) / n, z = (R() - 0.5) * (d - 0.1);
    for (let k = 0; k < 7; k++) { const a = k * 0.9 + R(), t = 0.2 + R() * 0.35; b.I('grass', G.box, kind === 1 ? 'grassBlade' : 'leaf', x, h - 0.03, z, 0, a, t, 0.012, 0.35 + R() * 0.3, 0.003); }
  }
}
function F_lounger(b) {
  b.shadow(0.95, 2.2);
  b.box('teak', 0.7, 0.05, 1.95, 0, 0.26, 0);
  for (const [x, z] of [[-0.3, -0.85], [0.3, -0.85], [-0.3, 0.85], [0.3, 0.85]]) b.box('teak', 0.05, 0.26, 0.05, x, 0, z);
  b.rb('outCushion', 0.66, 0.07, 1.25, 0, 0.31, 0.3, 0.03);
  b.rb('outCushion', 0.66, 0.07, 0.65, 0, 0.36, -0.62, 0.03, 0, 0.6);
  b.rb('c1', 0.4, 0.25, 0.1, 0, 0.6, -0.72, 0.04, 0, 0.6);
  b.rb('throw', 0.6, 0.02, 0.5, 0.02, 0.38, 0.65, 0.01, 0.2);
}
function F_olive(b, x, z, h = 3.2, s = 1) {
  const R = mulberry(hashStr(`olive${x}${z}`));
  // twisted trunk: several tapered segments
  let px = x, pz = z, py = 0;
  for (let i = 0; i < 4; i++) {
    const l = h * 0.14, ax = (R() - 0.5) * 0.35, az = (R() - 0.5) * 0.35;
    b.add(taper(0.075 * s - i * 0.012, 0.09 * s - i * 0.012, 10), 'bark', px, py, pz, ax, 0, az, 1, l, 1);
    px += Math.sin(az) * -l * 0 + Math.sin(-az) * l * 0.0; py += l * 0.98;
  }
  // branches + canopy clusters
  for (let i = 0; i < 5; i++) {
    const a = i * 1.3 + R(), t = 0.5 + R() * 0.3, l = h * 0.3;
    b.add(taper(0.02, 0.04, 8), 'bark', px, py, pz, Math.cos(a) * t, 0, Math.sin(a) * t, 1, l, 1);
  }
  for (let i = 0; i < 70; i++) {
    const a = R() * PI * 2, r = Math.sqrt(R()) * h * 0.36, yy = py + h * 0.14 + R() * h * 0.28 - r * 0.25;
    const c = R() < 0.5 ? '#7d8a62' : R() < 0.5 ? '#98a27c' : '#66744f';
    b.I('olcl', G.sphLo, 'tint', px + Math.cos(a) * r, yy, pz + Math.sin(a) * r, 0, R() * 3, 0, 0.18 + R() * 0.12, 0.1 + R() * 0.06, 0.18 + R() * 0.12, c);
  }
}
function F_bollard(b, x, z) { b.cyl('outdoor', 0.05, 0.45, x, 0, z); b.cyl('ledStrip', 0.045, 0.04, x, 0.38, z); b.cyl('outdoor', 0.06, 0.02, x, 0.45, z); }

// curtains: along a side opening, local x along, drawn to the sides; returns built into builder with ry already
function curtainGeo(w, h, folds, amp) {
  const k = `curt${w.toFixed(2)}|${h.toFixed(2)}|${folds}|${amp}`;
  return geo(k, () => {
    const segX = Math.max(12, Math.round(folds * 8)), g = new T.PlaneGeometry(w, h, segX, 3);
    const p = g.attributes.position, R = mulberry(hashStr(k)), ph = [];
    for (let i = 0; i <= folds; i++) ph.push(0.75 + R() * 0.5);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), v = p.getY(i) / h + 0.5, u = x / w + 0.5;
      const fi = Math.max(0, Math.min(folds, Math.floor(u * folds))), a = amp * ph[fi] * (1 + 0.3 * (1 - v));
      p.setZ(i, Math.sin(u * folds * PI * 2) * a + Math.sin(u * folds * PI * 4 + 1) * a * 0.18);
    }
    g.translate(0, h / 2, 0); g.computeVertexNormals();
    return g;
  });
}
function F_curtains(b, sd, w, ceil, glassdoor) {
  const H = ceil - 0.08;
  if (sd.id === 'urban') { // roller blind, half lowered; a tap rolls it up
    const head = glassdoor ? 2.5 : 2.3, drop = glassdoor ? 0.75 : 0.6;
    b.box('matteBlack', w + 0.06, 0.07, 0.07, 0, head, 0.085);
    b.dyn({ id: 'window-blind', kind: 'curtain', label: 'blind', sound: 'drawer', dur: 0.9, range: 3.2 }, [
      { p: [0, head, 0.075], anim: ['scale', 'y', 0.06], build: (d) => d.box('sheer', w + 0.02, drop, 0.003, 0, -drop, 0) },
      { p: [0, head - drop - 0.018, 0.075], anim: ['slide', 0, drop * 0.94, 0], build: (d) => d.box('matteBlack', w + 0.02, 0.018, 0.012, 0, 0, 0) }
    ]);
    return;
  }
  const sheers = (sheerW, hh, off, z, folds, amp) => b.dyn({ id: 'window-curtain', kind: 'curtain', label: 'curtain', sound: 'drawer', dur: 1.1, range: 3.2 },
    [-1, 1].map(sg => ({ p: [sg * (w / 2 + off), 0.01, z], anim: ['scale', 'x', 0.2], build: (d) => d.add(curtainGeo(sheerW, hh, folds, amp), 'sheer', -sg * sheerW / 2, 0, 0) })));
  if (sd.id === 'natura') { // linen sheers only, on a recessed track
    const sheerW = w * 0.5 + 0.12;
    sheers(sheerW, H + 0.06, 0.16, 0.12, Math.round(sheerW / 0.1), 0.03);
    return;
  }
  b.box('matteBlack', w + 0.7, 0.025, 0.08, 0, ceil - 0.025, 0.12);
  const sheerW = w * 0.5 + 0.05;
  sheers(sheerW, H - 0.01, 0.06, 0.1, Math.round(sheerW / 0.11), 0.028);
  for (const sg of [-1, 1]) b.add(curtainGeo(0.4, H, 5, 0.05), 'curtain', sg * (w / 2 + 0.13), 0.01, 0.2);
}
// ───────────────────────── finishes: floors, walls, ceilings ─────────────────────────
const OPEN_H = { door: [0, 2.1], entry: [0, 2.2], elevator: [0, 2.1], window: [0.9, 2.3], glassdoor: [0, 2.5], opening: [0, 2.3], slit: [0.2, 2.6], garage: [0, 2.4], main: [0, 2.4], gap: [0, 9] };
function floorOverlay(b, poly, y, mk) {
  const shape = new T.Shape(poly.map(([x, z]) => new T.Vector2(x, -z)));
  const g = new T.ShapeGeometry(shape).rotateX(-HP);
  g.translate(0, y + 0.005, 0);
  b.add(g, mk);
}
// wall panel on a side from s0..s1, heights h0..h1, offset d from edge (thickness th)
function sidePanel(b, sd, s0, s1, h0, h1, mk, y, d = 0.0, th = 0.008) {
  if (s1 - s0 < 0.01 || h1 - h0 < 0.01) return;
  if (CUR_FLOOR === 'second') { // follow the mansard slope in 10 cm steps
    const at = (s) => mansardH(sd.a.x + sd.u.x * s + sd.n.x * (d + 0.01), sd.a.z + sd.u.z * s + sd.n.z * (d + 0.01), CUR_FLOOR) - 0.015;
    if (Math.min(at(s0), at(s1), at((s0 + s1) / 2)) < h1) {
      const n = Math.max(1, Math.ceil((s1 - s0) / 0.1));
      for (let i = 0; i < n; i++) {
        const a = s0 + (s1 - s0) * i / n, c = s0 + (s1 - s0) * (i + 1) / n, top = Math.min(h1, at(a), at(c));
        if (top - h0 > 0.01) sidePanelRaw(b, sd, a, c, h0, top, mk, y, d, th);
      }
      return;
    }
  }
  sidePanelRaw(b, sd, s0, s1, h0, h1, mk, y, d, th);
}
function sidePanelRaw(b, sd, s0, s1, h0, h1, mk, y, d, th) {
  const sm = (s0 + s1) / 2, cx = sd.a.x + sd.u.x * sm + sd.n.x * (d + th / 2), cz = sd.a.z + sd.u.z * sm + sd.n.z * (d + th / 2);
  const ry = Math.atan2(sd.n.x, sd.n.z);
  b.add(G.box, mk, cx, y + h0, cz, 0, ry, 0, s1 - s0, h1 - h0, th);
}
// covers a side with a finish, leaving openings clear. range limits [r0,r1] along the side
function wallFinish(b, sd, y, mk, { h0 = 0, h1 = 2.7, r0 = 0, r1 = null, d = 0.0, th = 0.008, face = true } = {}) {
  if (!sd.hasWall) return;
  r1 = r1 === null ? sd.len : r1;
  // wall faces only (not gaps)
  const segs = [];
  for (const f of sd.faces) segs.push([Math.max(r0, f.s0), Math.min(r1, f.s1), f.inset]);
  for (const [a0, a1, inset] of segs) {
    if (a1 - a0 < 0.01) continue;
    const cuts = sd.openings.filter(o => o.s1 + 0.06 > a0 && o.s0 - 0.06 < a1).sort((p, q) => p.s0 - q.s0);
    let cur = a0;
    for (const o0 of cuts) {
      // BUILDING's door casings stand 50 mm proud of the opening: stop finishes short of them
      const cas = (o0.type === 'door' || o0.type === 'entry') ? 0.052 : 0;
      const o = cas ? { ...o0, s0: o0.s0 - cas, s1: o0.s1 + cas } : o0;
      const [oh0, oh1c] = OPEN_H[o.type] || [0, 2.2], oh1 = oh1c + cas;
      if (o.s0 > cur) sidePanel(b, sd, cur, o.s0, h0, h1, mk, y, d + inset, th);
      // below/above the opening
      const q0 = Math.max(cur, o.s0), q1 = Math.min(a1, o.s1);
      if (oh0 > h0) sidePanel(b, sd, q0, q1, h0, Math.min(h1, oh0), mk, y, d + inset, th);
      if (oh1 < h1) sidePanel(b, sd, q0, q1, Math.max(h0, oh1), h1, mk, y, d + inset, th);
      cur = Math.max(cur, o.s1);
    }
    if (cur < a1) sidePanel(b, sd, cur, a1, h0, h1, mk, y, d + inset, th);
  }
}
// fill wall-less edges of a room with a 10 cm partition (outside the polygon) and treat them as walls from now on
function closeGaps(b, an, ceil) {
  for (const sd of an.sides) {
    const gaps = sd.openings.filter(o => o.type === 'gap');
    if (!gaps.length) continue;
    for (const g of gaps) {
      // stretch to the neighbouring real wall faces (analysis pads covered ranges by 0.25)
      let lo = 0, hi = sd.len;
      for (const f of sd.faces) { if (f.s1 <= g.s0 + 0.3) lo = Math.max(lo, f.s1); if (f.s0 >= g.s1 - 0.3) hi = Math.min(hi, f.s0); }
      g.s0 = Math.min(g.s0, Math.max(lo, g.s0 - 0.3)); g.s1 = Math.max(g.s1, Math.min(hi, g.s1 + 0.3));
      sidePanelRaw(b, sd, g.s0 - 0.02, g.s1 + 0.02, 0, ceil, 'wall', 0, -0.1, 0.1);
      sd.faces.push({ s0: g.s0, s1: g.s1, inset: 0 });
    }
    sd.openings = sd.openings.filter(o => o.type !== 'gap');
    sd.hasWall = true;
  }
  an.zones = an.zones.filter(z => z.tag !== 'gap');
}
// baked ambient occlusion at wall/floor and wall/ceiling junctions (alpha-gradient decals, raster only)
const AO_CUT = new Set(['door', 'entry', 'opening', 'glassdoor', 'gap', 'elevator', 'main']);
function aoEdges(b, an, ceil) {
  for (const sd of an.sides) {
    if (!sd.hasWall) continue;
    const ry = Math.atan2(sd.n.x, sd.n.z);
    for (const f of sd.faces) {
      const cuts = sd.openings.filter(o => AO_CUT.has(o.type) && o.s1 > f.s0 && o.s0 < f.s1).sort((p, q) => p.s0 - q.s0);
      const segs = []; let cur = Math.max(0, f.s0);
      for (const o of cuts) { if (o.s0 - 0.06 > cur) segs.push([cur, o.s0 - 0.06]); cur = Math.max(cur, o.s1 + 0.06); }
      if (Math.min(sd.len, f.s1) > cur) segs.push([cur, Math.min(sd.len, f.s1)]);
      for (const [s0, s1] of segs) {
        const len = s1 - s0; if (len < 0.08) continue;
        const sm = (s0 + s1) / 2, at = (dd) => [sd.a.x + sd.u.x * sm + sd.n.x * (f.inset + dd), sd.a.z + sd.u.z * sm + sd.n.z * (f.inset + dd)];
        const fl = at(0.15); b.add(G.fplane, 'aoEdge', fl[0], 0.0085, fl[1], 0, ry, 0, len, 1, 0.3);
        if (wallHeadroom(sd, s0, s1) < ceil - 0.05) continue;
        const wl = at(0.0235);
        b.add(G.plane, 'aoEdge', wl[0], 0.09 + 0.14, wl[1], 0, ry, PI, len, 0.28, 1);
        const glazed = sd.openings.some(o => o.type === 'glassdoor' && o.s1 > s0 && o.s0 < s1);
        if (!glazed) b.add(G.plane, 'aoEdge', wl[0], ceil - CEIL_GAP - 0.002 - 0.13, wl[1], 0, ry, 0, len, 0.26, 1);
      }
    }
  }
}
function ceilingOverlay(b, poly, ceil) {
  const shape = new T.Shape(poly.map(([x, z]) => new T.Vector2(x, z)));
  const g = new T.ShapeGeometry(shape).rotateX(HP); g.translate(0, ceil - CEIL_GAP, 0);
  b.add(g, 'ceiling');
}
function downlights(b, poly, y, ceil, spacing = 1.25, avoid = []) {
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9; poly.forEach(([x, z]) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); });
  const nx = Math.max(1, Math.round((x1 - x0) / spacing)), nz = Math.max(1, Math.round((z1 - z0) / spacing));
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
    const x = x0 + (i + 0.5) * (x1 - x0) / nx, z = z0 + (j + 0.5) * (z1 - z0) / nz;
    if (!pip(x, z, poly)) continue;
    if (avoid.some(([ax, az]) => Math.hypot(ax - x, az - z) < 0.6)) continue;
    const c = y + ceil - CEIL_GAP;
    b.I('dlRing', G.cyl8, 'matteBlack', x, c - 0.004, z, 0, 0, 0, 0.045, 0.004, 0.045);
    b.I('dl', G.disc, 'downlight', x, c - 0.0045, z, PI, 0, 0, 0.035, 1, 0.035);
    b.I('dlGlow', G.disc, 'dlGlow', x, c - 0.002, z, PI, 0, 0, 0.32, 1, 0.32);
  }
}

// ───────────────────────── layout per room ─────────────────────────
function wallHeadroom(sd, s0, s1) { // clear height at the wall face along a side range (mansard)
  if (CUR_FLOOR !== 'second') return Infinity;
  let m = Infinity;
  for (const s of [s0, (s0 + s1) / 2, s1]) m = Math.min(m, mansardH(sd.a.x + sd.u.x * s + sd.n.x * 0.05, sd.a.z + sd.u.z * s + sd.n.z * 0.05, CUR_FLOOR));
  return m;
}
function glassLen(sd) { return sd.openings.filter(o => o.type === 'window' || o.type === 'glassdoor').reduce((a, o) => a + o.s1 - o.s0, 0); }
function sideDist(sdA, x, z) { return (x - sdA.a.x) * sdA.n.x + (z - sdA.a.z) * sdA.n.z; }
function doItem(b, r, fn, back = 0) { const p = placeOf(r); b.push(p.x, 0, p.z, p.ry); fn(); b.pop(); }

function layoutLiving(ctx, an, pl) {
  const { b, sd, y, ceil, unitLights } = ctx;
  const glazing = [...an.sides].sort((p, q) => glassLen(q) - glassLen(p))[0];
  const hasGlass = glassLen(glazing) > 0.5;
  const dG = (r) => hasGlass ? sideDist(glazing, r.cx, r.cz) : 0;
  const area = an.area;
  // 1 · kitchen run
  let kW = Math.min(3.6, Math.max(2.4, area / 6.5));
  let kit = null;
  for (let w = kW; w >= 1.8 && !kit; w -= 0.3) kit = pl.againstWall({ w, d: 0.62, tall: true, h: 2.45, sides: (s) => s !== glazing, score: (s, m, r) => dG(r) * 1.0 - Math.abs(Math.min(m - w / 2, s.len - m - w / 2)) * 0.8 });
  let kitchenRect = null;
  if (kit) {
    kitchenRect = pl.take(kit.r); ctx.kitchenPos = { x: kit.r.cx, z: kit.r.cz };
    const p = placeOf(kit.r), lx = { x: Math.cos(p.ry), z: -Math.sin(p.ry) };
    const nearA = kit.s0 < kit.sd.len - kit.s1; // tall columns at the corner end
    const sAlong = lx.x * kit.sd.u.x + lx.z * kit.sd.u.z; // +1 if local x == side u
    const flip = nearA ? sAlong < 0 : sAlong > 0;
    const tall = kit.r.hw * 2 >= 3.3 ? 2 : 1;
    b.push(p.x, 0, p.z, p.ry); F_kitchenRun(b, sd, kit.r.hw * 2, { tall, ceil, flip }); b.pop();
    // work zone in front
    const wz = rectOnSide(kit.sd, kit.s0, kit.s1, 0.62, 0.62 + 0.95, 'kzone');
    // island if room is wide enough
    const depthAvail = (() => { let m = 0; for (const [x, z] of an.room.poly) m = Math.max(m, sideDist(kit.sd, x, z)); return m; })();
    if (depthAvail > 3.9 && kit.r.hw * 2 >= 2.4) {
      const iw = Math.min(2.2, kit.r.hw * 2 - 0.6), idp = 0.95;
      const ir = rectOnSide(kit.sd, (kit.s0 + kit.s1) / 2 - iw / 2, (kit.s0 + kit.s1) / 2 + iw / 2, 0.62 + 1.05, 0.62 + 1.05 + idp, 'island');
      const withStools = rectOnSide(kit.sd, (kit.s0 + kit.s1) / 2 - iw / 2, (kit.s0 + kit.s1) / 2 + iw / 2, 0.62 + 1.05, 0.62 + 1.05 + idp + 0.55, 'island');
      if (!pl.blocked(withStools)) {
        pl.take(withStools);
        const q = placeOf(ir); b.push(q.x, 0, q.z, q.ry); F_island(b, sd, iw, idp, Math.floor(iw / 0.6)); b.pop();
        ctx.islandRect = ir;
      } else pl.take(wz);
    } else pl.take(wz);
  }
  // 2 · sofa + TV/living group
  let sofa = null;
  const bbL = an.room.poly.reduce((a, [x, z]) => [Math.min(a[0], x), Math.min(a[1], z), Math.max(a[2], x), Math.max(a[3], z)], [1e9, 1e9, -1e9, -1e9]);
  const narrow = Math.min(bbL[2] - bbL[0], bbL[3] - bbL[1]) < 3.3;
  for (const w of narrow ? [1.8, 1.6] : [2.2, 2.0, 1.8, 1.6]) {
    const facesKitchen = (r) => { // sofa looking straight at the kitchen run from < 2.7 m = cramped
      if (!kitchenRect) return 0;
      const vx = kitchenRect.cx - r.cx, vz = kitchenRect.cz - r.cz, dd = Math.hypot(vx, vz);
      return (vx * r.nx + vz * r.nz) / dd > 0.7 && dd < 2.9 ? 1 : 0;
    };
    sofa = pl.againstWall({ w, d: 0.95, tall: false, gapOK: false, margin: 0.02, h: 1.0, score: (s, m, r) => -dG(r) * 1.2 - (kitchenRect ? -Math.hypot(r.cx - kitchenRect.cx, r.cz - kitchenRect.cz) * 0.6 : 0) - (s === glazing ? 3 : 0) - Math.abs(m - s.len / 2) * 0.1 - facesKitchen(r) * 6 });
    if (sofa) break;
  }
  let livingC = null;
  if (sofa) {
    pl.take(sofa.r);
    const sw = sofa.r.hw * 2;
    doItem(b, sofa.r, () => F_sofa(b, sw, 0.95, sd));
    const p = placeOf(sofa.r); livingC = { x: p.x + Math.sin(p.ry) * 1.2, z: p.z + Math.cos(p.ry) * 1.2 };
    // art above sofa (not on window)
    const artOK = !sofa.sd.openings.some(o => o.type === 'window' && o.s1 > sofa.s0 && o.s0 < sofa.s1) && wallHeadroom(sofa.sd, sofa.s0, sofa.s1) > 2.2;
    const NEWP = !!NEW_STYLES[sd.id];
    const stretch = (sdw, m) => { let g0 = 0, g1 = sdw.len; for (const o of sdw.openings) { if (o.s1 <= m) g0 = Math.max(g0, o.s1 + 0.05); else if (o.s0 >= m) g1 = Math.min(g1, o.s0 - 0.05); else return null; } return [g0, g1]; };
    let featSofa = false;
    const drawSofaArt = () => { // deferred: the sofa wall may become the feature wall (new packages)
      const sm = (sofa.s0 + sofa.s1) / 2, ss = featSofa ? stretch(sofa.sd, sm) : null;
      let off = 0, arch = false;
      if (ss && artOK) {
        const hF = Math.min(ceil - CEIL_GAP, wallHeadroom(sofa.sd, ss[0], ss[1]));
        if (sd.feature === 'arches') { arch = true; }
        else {
          const r0 = sd.feature === 'brick' ? ss[0] : Math.max(ss[0], sofa.s0 - 0.35), r1 = sd.feature === 'brick' ? ss[1] : Math.min(ss[1], sofa.s1 + 0.35);
          wallFinish(b, sofa.sd, y, 'feature', { r0, r1, h0: 0, h1: ceil, d: 0.009, th: 0.02 }); off = 0.03;
          if (sd.feature === 'slats') { for (let a = r0 + 0.035; a < r1 - 0.02; a += 0.07) sidePanelRaw(b, sofa.sd, a - 0.015, a + 0.015, 0, hF - 0.01, 'wood', y, 0.029, 0.022); off = 0.052; }
        }
      }
      if (!artOK) return;
      const ar = rectOnSide(sofa.sd, sofa.s0, sofa.s1, 0, 0.05, 'art'); const q = placeOf(ar);
      b.push(q.x - sofa.sd.n.x * (0.025 - off), 0, q.z - sofa.sd.n.z * (0.025 - off), q.ry);
      const fr = ctx.pickFrame();
      if (arch) { F_archNiche(b, sd, Math.min(sw - 0.3, 1.9), 2.2, false); b.push(0, 0, 0.02); F_art(b, 0.62, 0.8, 1.66, ctx.pickArt(), 'wood'); b.pop(); }
      else if (sw >= 2.0) { b.push(-0.36, 0, 0); F_art(b, 0.62, 0.8, 1.72, ctx.pickArt(), fr); b.pop(); b.push(0.36, 0, 0); F_art(b, 0.62, 0.8, 1.72, ctx.pickArt(), fr); b.pop(); }
      else F_art(b, 1.0, 0.7, 1.72, ctx.pickArt(), fr);
      b.pop();
    };
    // coffee table in front + rug
    const ct = obb(p.x + Math.sin(p.ry) * (0.475 + 0.45 + 0.3), p.z + Math.cos(p.ry) * (0.475 + 0.45 + 0.3), 0.5, 0.3, Math.cos(p.ry), -Math.sin(p.ry), 'ct');
    const rug = obb(p.x + Math.sin(p.ry) * 1.0, p.z + Math.cos(p.ry) * 1.0, Math.min(1.5, sw / 2 + 0.35), 1.0, Math.cos(p.ry), -Math.sin(p.ry), 'rug');
    if (!pl.blocked(ct)) {
      pl.take(ct); b.push(ct.cx, 0, ct.cz, p.ry); F_coffeeTable(b, sd, sd.table === 'round' ? 0.8 : 1.0, 0.6); b.pop();
      if (rectInPoly(rug, an.room.poly)) { b.push(rug.cx, 0, rug.cz, p.ry); F_rug(b, rug.hw * 2, rug.hd * 2); b.pop(); }
    }
    // TV on facing wall: ray from sofa centre along facing dir
    let best = null;
    for (const s2 of an.sides) {
      if (!s2.hasWall || s2.mansard) continue;
      const dot = s2.n.x * Math.sin(p.ry) + s2.n.z * Math.cos(p.ry); if (dot > -0.95) continue;
      const dist = sideDist(s2, p.x, p.z); if (dist < 2.0 || dist > 5) continue;
      const m = (p.x - s2.a.x) * s2.u.x + (p.z - s2.a.z) * s2.u.z;
      const r = rectOnSide(s2, m - 0.8, m + 0.8, 0, 0.42, 'tv');
      if (m - 0.8 < 0 || m + 0.8 > s2.len) continue;
      if (s2.openings.some(o => o.s1 > m - 0.8 && o.s0 < m + 0.8)) continue;
      if (pl.blocked(r) || wallHeadroom(s2, m - 0.8, m + 0.8) < 2.1) continue;
      best = { s2, m, r };
    }
    if (best) {
      pl.take(best.r);
      // feature wall panel behind
      const fw = Math.min(2.6, best.s2.len);
      let f0 = Math.max(0, best.m - fw / 2), f1 = Math.min(best.s2.len, f0 + fw);
      let blockedF = best.s2.openings.some(o => o.s1 > f0 && o.s0 < f1);
      if (NEWP) { // new packages: use the clear stretch of the TV wall, or fall back to the sofa wall
        const ts = stretch(best.s2, best.m);
        if (ts && ts[1] - ts[0] >= (sd.feature === 'arches' ? 2.6 : 1.9)) { blockedF = false; const half = sd.feature === 'brick' ? 99 : 1.3; f0 = Math.max(ts[0], best.m - half); f1 = Math.min(ts[1], best.m + half); }
        else { blockedF = true; featSofa = true; }
        if (sd.feature === 'arches') featSofa = true;
      }
      const hF = Math.min(ceil - CEIL_GAP, wallHeadroom(best.s2, f0, f1));
      if (sd.feature === 'arches') { // riviera: plain plaster wall with two arched niches flanking the TV
        if (!blockedF) for (const sg of [-1, 1]) { if (best.m + sg * 1.06 - 0.27 < f0 || best.m + sg * 1.06 + 0.27 > f1) continue; const ar = rectOnSide(best.s2, best.m + sg * 1.06 - 0.24, best.m + sg * 1.06 + 0.24, 0, 0.05); const qa = placeOf(ar); b.push(qa.x - best.s2.n.x * 0.025, 0, qa.z - best.s2.n.z * 0.025, qa.ry); F_archNiche(b, sd, 0.46, Math.min(2.05, hF - 0.2), true, sg > 0 ? 1 : 0); b.pop(); }
      } else if (!blockedF) {
        wallFinish(b, best.s2, y, 'feature', { r0: f0, r1: f1, h0: 0.0, h1: ceil, d: 0.009, th: 0.02 });
        if (sd.feature === 'slats') { // natura: vertical timber battens over the ash panel
          for (let a = f0 + 0.035; a < f1 - 0.02; a += 0.07) sidePanelRaw(b, best.s2, a - 0.015, a + 0.015, 0.0, hF - 0.01, 'wood', y, 0.029, 0.022);
        }
      }
      const q = placeOf(best.r); b.push(q.x, 0, q.z, q.ry);
      const d0 = blockedF ? 0 : sd.feature === 'slats' ? 0.052 : sd.feature === 'arches' ? 0 : 0.03;
      b.push(0, 0, d0); F_tv(b, 1.3, true);
      // low media unit
      b.shadow(1.7, 0.5, 0, 0.2); b.box('matteBlack', 1.5, 0.1, 0.32, 0, 0, 0.18); b.rb(sd.kin === 'lisboa' ? 'wood' : 'joineryTall', 1.6, 0.42, 0.4, 0, 0.1, 0.2, 0.01);
      b.box('black', 0.004, 0.3, 0.004, -0.4, 0.2, 0.401); b.box('black', 0.004, 0.3, 0.004, 0.4, 0.2, 0.401);
      F_books(b, -0.55, 0.52, 0.2, 2, 0.1); F_vase(b, 0.6, 0.52, 0.22, 0.6, false);
      b.box('matteBlack', 0.4, 0.06, 0.08, 0.2, 0.52, 0.22);
      b.pop(); b.pop();
    }
    if (NEWP && !best) featSofa = true;
    drawSofaArt();
    // armchair beside the coffee table
    const side = [1, -1]; let seatDone = 0;
    for (const sgn of side) {
      const ax = ct.cx + Math.cos(p.ry) * sgn * (0.5 + 0.65) + Math.sin(p.ry) * 0.05, az = ct.cz - Math.sin(p.ry) * sgn * (0.5 + 0.65) + Math.cos(p.ry) * 0.05;
      const facing = p.ry + (sgn > 0 ? -HP : HP) + (sgn > 0 ? 0.35 : -0.35);
      const ar = obb(ax, az, 0.42, 0.42, Math.cos(facing), -Math.sin(facing), 'arm');
      if (!pl.blocked(ar, { margin: 0.05 })) { pl.take(ar); b.push(ax, 0, az, facing); if (sd.id === 'natura' && seatDone) F_floorCushions(b, sd); else F_armchair(b, sd); b.pop(); seatDone++; if (sd.id !== 'natura' || seatDone > 1) break; }
    }
    // floor lamp at sofa end
    for (const sgn of [1, -1]) {
      const lx = p.x + Math.cos(p.ry) * sgn * (sw / 2 + 0.25) + Math.sin(p.ry) * -0.1, lz = p.z - Math.sin(p.ry) * sgn * (sw / 2 + 0.25) + Math.cos(p.ry) * -0.1;
      const lr = obb(lx, lz, 0.16, 0.16, 1, 0, 'lamp');
      if (!pl.blocked(lr)) { pl.take(lr); b.push(lx, 0, lz, 0); F_floorLamp(b, sd); b.pop(); break; }
    }
  }
  // 3 · dining table
  const kc = kitchenRect ? { x: kitchenRect.cx, z: kitchenRect.cz } : an.c;
  const opts = [
    { round: sd.table === 'round', n: 4, w: sd.table === 'round' ? 1.1 : 1.5, d: sd.table === 'round' ? 1.1 : 0.9 },
    { round: false, n: 4, w: 1.3, d: 0.8 },
    { round: true, n: 2, w: 0.85, d: 0.85, two: true }
  ];
  let dining = null;
  for (const o of opts) {
    const fw = o.round ? (o.two ? o.w : o.w + 1.0) : o.w + 0.0, fd = o.round ? o.w + 1.0 : o.d + 1.1;
    const res = pl.free({ w: fw + 0.1, d: fd, angles: [[1, 0], [0, 1]], step: 0.05, h: 1.9, score: (r) => -Math.hypot(r.cx - (kc.x + an.c.x) / 2, r.cz - (kc.z + an.c.z) / 2) - (livingC ? 0 : 0) });
    if (res) { dining = { o, r: res.r }; break; }
  }
  if (dining) {
    const { o, r } = dining; pl.take(r);
    const ry = Math.atan2(r.nx, r.nz);
    b.push(r.cx, 0, r.cz, ry + (o.round && o.two ? 0 : 0));
    if (o.two) { // two place settings facing each other along local z
      F_diningTable2(b, sd, o.w);
    } else F_diningTable(b, sd, o.n, o.round, o.w, o.d);
    b.pop();
    b.push(r.cx, 0, r.cz, ry); F_pendant(b, sd, 0, ceil, 1.6); b.pop();
    ctx.avoidDL.push([r.cx, r.cz]);
    ctx.diningPos = new T.Vector3(r.cx, y + 0.75, r.cz);
  }
  // 4 · sideboard / plants
  if (sd.id === 'urban') { try { steelScreens(ctx, an); } catch (e) { /* decorative */ } }
  let sb = null;
  if (sd.id === 'urban') {
    const sh = pl.againstWall({ w: 1.3, d: 0.4, tall: true, h: 2.0, sides: (s) => s !== glazing, score: (s, m, r) => -Math.abs(m - s.len / 2) * 0.2 });
    if (sh) { pl.take(sh.r); doItem(b, sh.r, () => F_steelShelves(b, sd, 1.3)); }
    else sb = pl.againstWall({ w: 1.4, d: 0.45, tall: false, score: (s, m, r) => -Math.abs(m - s.len / 2) * 0.2 });
  } else sb = pl.againstWall({ w: 1.4, d: 0.45, tall: false, score: (s, m, r) => -Math.abs(m - s.len / 2) * 0.2 });
  if (sb) { pl.take(sb.r); doItem(b, sb.r, () => F_sideboard(b, sd, 1.4)); const ar = rectOnSide(sb.sd, sb.s0, sb.s1, 0, 0.05); const q = placeOf(ar); if (!sb.sd.openings.some(o => o.s1 > sb.s0 && o.s0 < sb.s1) && wallHeadroom(sb.sd, sb.s0, sb.s1) > 2.0) { b.push(q.x, 0, q.z, q.ry); if (sd.id === 'riviera') { F_archNiche(b, sd, 1.1, 2.1, false); b.push(0, 0, 0.02); F_art(b, 0.5, 0.62, 1.62, ctx.pickArt(), 'wood'); b.pop(); } else F_art(b, 0.7, 0.9, 1.68, ctx.pickArt(), ctx.pickFrame()); b.pop(); } }
  plantsInCorners(ctx, an, pl, 2, glazing);
  curtainsFor(ctx, an, ['window', 'glassdoor']);
}
function F_diningTable2(b, sd, w) {
  b.shadow(w + 0.5, w + 1.1);
  const H = 0.75;
  b.add(G.cylHi, sd.tableTop === 'nero' ? 'worktop' : 'wood', 0, H - 0.035, 0, 0, 0, 0, w / 2, 0.035, w / 2);
  b.add(lathe('tped2', [[0, 0], [0.22, 0], [0.22, 0.02], [0.07, 0.06], [0.05, 0.7], [0.1, 0.715], [0, 0.715]], 28), sd.kin === 'lisboa' ? 'wood' : 'stoneware', 0, 0, 0);
  for (const s of [1, -1]) {
    b.pf(...chairOf(sd), 0, 0, s * (w / 2 + 0.12), s > 0 ? PI : 0, 1);
    b.push(0, H, 0); F_placeSetting(b, 0, s * (w / 2 - 0.17), s > 0 ? 0 : PI, true); b.pop();
  }
  F_candle(b, -0.08, H, 0.0, 0.18); F_candle(b, 0.08, H, 0.0, 0.14);
  F_vase(b, 0.0, H, 0.0, 0.55, false);
}
function plantsInCorners(ctx, an, pl, max, glazing) {
  const { b } = ctx; let n = 0;
  const poly = an.room.poly;
  const pts = poly.map(([x, z], i) => {
    const [px, pz] = poly[(i - 1 + poly.length) % poly.length], [qx, qz] = poly[(i + 1) % poly.length];
    const ax = px - x, az = pz - z, bx = qx - x, bz = qz - z, la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
    return [x + (ax / la + bx / lb) * 0.42, z + (az / la + bz / lb) * 0.42];
  }).filter(([x, z]) => pip(x, z, poly));
  pts.sort((p, q) => (glazing ? sideDist(glazing, p[0], p[1]) - sideDist(glazing, q[0], q[1]) : 0));
  for (const [x, z] of pts) {
    if (n >= max) break;
    const r = obb(x, z, 0.3, 0.3, 1, 0, 'plant');
    if (pl.blocked(r) || !pl.fitsH(r, 1.75)) continue;
    const kinds = ctx.sd.id === 'riviera' ? [2, 4] : ctx.sd.id === 'natura' ? [3, 1] : ctx.sd.id === 'urban' ? [0, 3] : [0, 1, 3];
    const kind = kinds[(hashStr(an.room.id) + n) % kinds.length];
    pl.take(r); F_plant(b, x, z, kind === 3 ? 1.0 : kind === 4 ? 1.5 : 1.2 + (n % 2) * 0.4, kind, 0.17 + (n % 2) * 0.03); n++;
  }
}
function curtainsFor(ctx, an, types) {
  const { b, sd, ceil } = ctx;
  for (const s of an.sides) for (const o of s.openings) {
    if (!types.includes(o.type)) continue;
    if (wallHeadroom(s, o.s0 - 0.3, o.s1 + 0.3) < ceil - 0.05) continue; // dormer under the mansard: no ceiling track
    const w = o.s1 - o.s0;
    const r = rectOnSide(s, o.s0, o.s1, 0, 0.1); const q = placeOf(r);
    b.push(r.cx - s.n.x * 0.05, 0, r.cz - s.n.z * 0.05, q.ry); F_curtains(b, sd, w, ceil, o.type === 'glassdoor'); b.pop();
  }
}

function layoutBedroom(ctx, an, pl, isSecond) {
  const { b, sd, y, ceil, unitLights } = ctx;
  const glazing = [...an.sides].sort((p, q) => glassLen(q) - glassLen(p))[0];
  const W = isSecond && an.area < 11 ? 1.4 : (an.area > 12.5 ? 1.8 : 1.6), L = 2.05;
  // bed headboard against a wall, needs 0.6 clearance both sides and 0.7 at the foot
  let bed = null;
  for (const bw of [W, 1.6, 1.4, 1.2, 0.9]) {
    bed = pl.againstWall({ w: bw + 1.0, d: L + 0.1, tall: false, h: 1.25, margin: 0, score: (s, m, r) => -Math.abs(m - s.len / 2) * 0.5 + (s === glazing ? -4 : 0) + (glassLen(s) === 0 ? 1 : 0) - (s.mansard ? 1 : 0) });
    if (bed) { bed.bw = bw; break; }
  }
  if (bed) {
    const bw = bed.bw; pl.take(bed.r);
    const inner = rectOnSide(bed.sd, bed.s0 + 0.5, bed.s1 - 0.5, 0.07, L + 0.07);
    const p = placeOf(inner); b.push(p.x, 0, p.z, p.ry); b.push(0, 0, L / 2 + 0.0); F_bed(b, sd, bw, L); b.pop();
    ctx.focus = { x: p.x + Math.sin(p.ry) * L * 0.35, z: p.z + Math.cos(p.ry) * L * 0.35, fx: Math.sin(p.ry), fz: Math.cos(p.ry) };
    // bedside tables
    for (const sg of [-1, 1]) { b.push(sg * (bw / 2 + 0.3), 0, 0.26); F_bedside(b, sd, true); b.pop(); }
    b.pop();
    // pendant lights either side for noir/lisboa, art above bed otherwise
    const wr = rectOnSide(bed.sd, bed.s0, bed.s1, 0, 0.05); const q = placeOf(wr);
    if (wallHeadroom(bed.sd, bed.s0, bed.s1) > 2.2) { b.push(q.x, 0, q.z, q.ry); if (sd.id === 'riviera') F_archNiche(b, sd, Math.min(bw + 0.5, bed.r.hw * 2 - 0.1), 2.05, false); else F_art(b, Math.min(1.3, bw), 0.62, 2.0, ctx.pickArt(), ctx.pickFrame()); b.pop(); }
    // rug under lower 2/3 of bed
    const rug = rectOnSide(bed.sd, bed.s0 + 0.2, bed.s1 - 0.2, 0.9, Math.min(L + 0.7, 2.8));
    if (rectInPoly(rug, an.room.poly)) { const rq = placeOf(rug); b.push(rq.x, 0, rq.z, rq.ry); F_rug(b, rug.hw * 2, rug.hd * 2); b.pop(); }
    // foot clearance
    pl.take(rectOnSide(bed.sd, bed.s0 + 0.4, bed.s1 - 0.4, L + 0.1, L + 0.75, 'foot'));

  }
  // wardrobe: tall, prefer wall with no windows
  let wr = null;
  for (const w of [2.4, 2.0, 1.8, 1.5, 1.2, 1.0]) { wr = pl.againstWall({ w, d: 0.6, tall: true, h: 2.42, score: (s, m, r) => -Math.min(m - w / 2, s.len - m - w / 2) + (s === glazing ? -5 : 0) }); if (wr) break; }
  if (wr) { pl.take(wr.r); pl.take(rectOnSide(wr.sd, wr.s0, wr.s1, 0.6, 1.3, 'wfront')); doItem(b, wr.r, () => F_wardrobe(b, sd, wr.r.hw * 2, Math.min(2.4, ceil - 0.05))); }
  // desk in bedroom 2 (prefer under/near window)
  if (isSecond) {
    let dk = null;
    for (const w of [1.2, 1.0, 0.9]) { dk = pl.againstWall({ w, d: 0.95, tall: false, score: (s, m, r) => (glassLen(s) > 0 ? 1 : 0) - Math.abs(m - s.len / 2) * 0.1 }); if (dk) break; }
    if (dk) { pl.take(dk.r); const r2 = rectOnSide(dk.sd, dk.s0, dk.s1, 0, 0.55); doItem(b, r2, () => F_desk(b, sd, dk.r.hw * 2)); }
  } else {
    // armchair or bench corner
    const ch = pl.free({ w: 0.9, d: 0.9, step: 0.1, score: (r) => glazing ? -sideDist(glazing, r.cx, r.cz) : 0 });
    if (ch) { pl.take(ch.r); b.push(ch.r.cx, 0, ch.r.cz, Math.atan2(an.c.x - ch.r.cx, an.c.z - ch.r.cz)); F_armchair(b, sd); b.pop(); }
  }
  plantsInCorners(ctx, an, pl, 1, glazing);
  curtainsFor(ctx, an, ['window', 'glassdoor']);
}

function layoutBath(ctx, an, pl) {
  const { b, sd, y, ceil, mats } = ctx;
  // wall finish
  for (const s of an.sides) wallFinish(b, s, y, 'bathWall', { h0: 0, h1: Math.min(sd.bathWallH, ctx.ceil - CEIL_GAP), d: 0.013 });
  // shower: the short end with no door; prefer a corner
  const sides = an.sides.filter(s => s.hasWall);
  let shower = null;
  const sw = 0.9;
  for (const s of sides) {
    for (const [s0, corner] of [[0, 'a'], [s.len - sw, 'b']]) {
      if (s0 < 0) continue;
      const depth = Math.min(1.3, (() => { let m = 0; for (const [x, z] of an.room.poly) m = Math.max(m, sideDist(s, x, z)); return m; })() - 0.0);
      if (depth < 0.8) continue;
      const r = rectOnSide(s, s0, s0 + sw, 0, Math.min(depth, 1.25), 'shower');
      if (s.openings.some(o => o.s1 > s0 && o.s0 < s0 + sw && o.type !== 'window')) continue;
      if (pl.blocked(r)) continue;
      const sc = (s.openings.some(o => o.type === 'window') ? -1 : 0) + r.hd * 2;
      if (!shower || sc > shower.sc) shower = { s, s0, r, sc, corner };
    }
  }
  if (shower) {
    pl.take(shower.r);
    // marble/azulejo on the 3 shower walls: back side and neighbours inside the footprint
    const s = shower.s, d = shower.r.hd * 2;
    wallFinish(b, s, y, 'showerWall', { r0: shower.s0, r1: shower.s0 + sw, h0: 0, h1: ctx.ceil - CEIL_GAP - 0.002, d: 0.022, th: 0.012 });
    const q = placeOf(shower.r);
    // glass on the open long side (the side facing the room) → local 'front'
    b.push(q.x, 0, q.z, q.ry); F_shower(b, sd, sw, d, 'front'); b.pop();
    // side walls finishing: adjacent sides at corner
    for (const s2 of an.sides) {
      if (s2 === s) continue;
      const along = (shower.r.cx - s2.a.x) * s2.u.x + (shower.r.cz - s2.a.z) * s2.u.z, dist = sideDist(s2, shower.r.cx, shower.r.cz);
      const halfAlong = Math.abs(s2.u.x * shower.r.nx + s2.u.z * shower.r.nz) > 0.9 ? shower.r.hd : shower.r.hw;
      const halfDist = Math.abs(s2.n.x * shower.r.nx + s2.n.z * shower.r.nz) > 0.9 ? shower.r.hd : shower.r.hw;
      if (Math.abs(dist - halfDist) < 0.05) wallFinish(b, s2, y, 'showerWall', { r0: along - halfAlong, r1: along + halfAlong, h0: 0, h1: ctx.ceil - CEIL_GAP - 0.002, d: 0.022, th: 0.012 });
    }
  }
  // vanity
  let van = null;
  for (const w of [1.2, 1.0, 0.8, 0.6]) { van = pl.againstWall({ w, d: 0.5, tall: true, score: (s, m) => -Math.abs(m - s.len / 2) * 0.3 }); if (van) break; }
  if (van) { pl.take(van.r); pl.take(rectOnSide(van.sd, van.s0, van.s1, 0.5, 1.1, 'vfront')); doItem(b, van.r, () => F_vanity(b, sd, van.r.hw * 2)); }
  // WC
  const wc = pl.againstWall({ w: 0.55, d: 0.62, tall: true, score: (s, m) => -Math.abs(m - s.len / 2) * 0.1 });
  if (wc) { pl.take(wc.r); pl.take(rectOnSide(wc.sd, wc.s0 - 0.1, wc.s1 + 0.1, 0.62, 1.1, 'wcfront')); doItem(b, wc.r, () => { b.push(0, 0, -0.31); F_wc(b, sd); b.pop(); }); }
  // towel rail
  const tr = pl.againstWall({ w: 0.55, d: 0.1, tall: true, score: () => 0 });
  if (tr) { pl.take(tr.r); doItem(b, tr.r, () => { b.push(0, 0, -0.03); F_towelRail(b, sd); b.pop(); }); }
  // small plant or bath mat
  const mat = pl.free({ w: 0.7, d: 0.45, step: 0.05, score: (r) => shower ? -Math.hypot(r.cx - shower.r.cx, r.cz - shower.r.cz) : 0 });
  if (mat) { b.push(mat.r.cx, 0, mat.r.cz, Math.atan2(mat.r.nx, mat.r.nz)); b.rb('towel', 0.7, 0.012, 0.45, 0, 0, 0, 0.005); b.pop(); }
}

function layoutHall(ctx, an, pl) {
  const { b, sd } = ctx;
  const con = pl.againstWall({ w: 0.9, d: 0.3, tall: false, score: (s, m) => -Math.abs(m - s.len / 2) * 0.2 })
    || pl.againstWall({ w: 0.7, d: 0.25, tall: false });
  if (con) { pl.take(con.r); doItem(b, con.r, () => F_console(b, sd, con.r.hw * 2)); }
  const hk = pl.againstWall({ w: 0.7, d: 0.3, tall: true, score: () => 0 });
  if (hk) { pl.take(hk.r); doItem(b, hk.r, () => { b.push(0, 0, -0.15); F_hooks(b, sd, 3); b.pop(); }); }
  // runner rug along the long axis
  const bbox = an.room.poly.reduce((a, [x, z]) => [Math.min(a[0], x), Math.min(a[1], z), Math.max(a[2], x), Math.max(a[3], z)], [1e9, 1e9, -1e9, -1e9]);
  const w = bbox[2] - bbox[0], d = bbox[3] - bbox[1];
  const rw = w > d ? Math.min(2.6, w - 0.8) : 0.7, rd = w > d ? 0.7 : Math.min(2.6, d - 0.8);
  const rr = obb(an.c.x, an.c.z, rw / 2, rd / 2, 1, 0, 'rug');
  if (rw > 0.5 && rd > 0.5 && rectInPoly(rr, an.room.poly)) { b.push(an.c.x, 0, an.c.z, 0); F_rug(b, rw, rd); b.pop(); }
  plantsInCorners(ctx, an, pl, 1, null);
}

function layoutBalcony(ctx, bal, y, dirOut) {
  const { b, sd } = ctx;
  const [x0, z0] = bal.poly[0], [x1, z1] = bal.poly[2];
  let minx = Math.min(x0, x1), maxx = Math.max(x0, x1), minz = Math.min(z0, z1), maxz = Math.max(z0, z1);
  // BUILDING: glass 0.07 in from the outer edge and the sides; façade face at z = -0.15 / 14.85
  minx += 0.09; maxx -= 0.09;
  if (dirOut < 0) { minz += 0.09; maxz = Math.min(maxz, -0.16); } else { maxz -= 0.09; minz = Math.max(minz, 14.86); }
  bal = { ...bal, poly: [[minx, minz], [maxx, minz], [maxx, maxz], [minx, maxz]] };
  const w = maxx - minx, d = maxz - minz;
  // deck tiles
  floorOverlay(b, bal.poly, y, 'deck');
  const cz = (minz + maxz) / 2;
  // bistro set near one end, planters at the other
  if (w > 2.0) {
    if (hasModel('outdoor_table_chair_set_01') && d >= 1.0) { b.push(minx + 1.05, 0, cz, 0); b.shadow(1.8, 0.85); b.model('outdoor_table_chair_set_01', 0, 0, 0, HP, { d: 1.75, w: Math.min(0.8, d - 0.35) }); b.pop(); }
    else { b.push(minx + 0.8, 0, cz, 0); F_bistro(b, sd); b.pop(); }
    b.push(maxx - 0.55, 0, cz + (dirOut > 0 ? 0.2 : -0.2), 0); F_planter(b, 0.8, 0.35, 0.45, 1); b.pop();
    if (w > 5) { b.push((minx + maxx) / 2 + 1.3, 0, cz, dirOut > 0 ? PI : 0); F_lounger2(b, sd); b.pop(); F_plant(b, (minx + maxx) / 2 - 0.6, cz + dirOut * 0.3, 1.0, 2, 0.2); }
  }
  return { center: new T.Vector3((minx + maxx) / 2, y, cz), minx, maxx, minz, maxz };
}
function F_lounger2(b, sd) { // compact outdoor armchair pair
  for (const s of [-1, 1]) {
    b.push(s * 0.45, 0, 0, s * 0.2);
    b.box('teak', 0.62, 0.3, 0.6, 0, 0, 0); b.rb('outCushion', 0.56, 0.1, 0.56, 0, 0.3, 0.02, 0.03); b.rb('outCushion', 0.56, 0.4, 0.12, 0, 0.35, -0.25, 0.04, 0, -0.2);
    b.pop();
  }
  b.cyl('teak', 0.22, 0.4, 0, 0, 0.45);
}
// Gardens: BUILDING owns the lawn (top y = -0.12), the teak deck (top -0.015), fence, boundary walls, planting beds and trees.
// We only furnish them: dining set on the deck, lounger + side table on the lawn, lanterns, potted plants.
const DECK_TOP = -0.015, LAWN_TOP = -0.12;
function layoutGarden(ctx, room, y) {
  const { b, sd } = ctx;
  const poly = room.poly;
  const deck = BALCONIES.find(q => q.deck && q.unit.includes(ctx.unitId));
  const bb = poly.reduce((a, [x, z]) => [Math.min(a[0], x), Math.min(a[1], z), Math.max(a[2], x), Math.max(a[3], z)], [1e9, 1e9, -1e9, -1e9]);
  let center = new T.Vector3((bb[0] + bb[2]) / 2, y, (bb[1] + bb[3]) / 2);
  if (deck) {
    const xs = deck.poly.map(p => p[0]), zs = deck.poly.map(p => p[1]);
    const dx0 = Math.min(...xs), dz0 = Math.min(...zs), dz1 = Math.max(...zs);
    const dx1 = Math.min(Math.max(...xs), 12.2 + dz0 * (2.7 / 7.9) - 0.25); // building's angled boundary
    // dining set on the deck, clear of the sliding doors (≥ 0.9 m from the façade)
    const tx = dx0 + Math.min(1.5, (dx1 - dx0) / 2), tz = dz0 + 0.95;
    b.push(tx, DECK_TOP, tz, 0);
    b.shadow(1.9, 1.9);
    b.rb('teak', 1.4, 0.04, 0.8, 0, 0.71, 0, 0.01);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box('outdoor', 0.05, 0.71, 0.05, sx * 0.62, 0, sz * 0.32);
    for (const sx of [-0.35, 0.35]) for (const sz of [-1, 1]) {
      b.push(sx, 0, sz * 0.62, sz > 0 ? PI : 0);
      for (const [lx, lz] of [[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2]]) b.box('outdoor', 0.025, 0.42, 0.025, lx, 0, lz);
      b.box('teak', 0.46, 0.03, 0.46, 0, 0.4, 0); b.rb('outCushion', 0.44, 0.05, 0.44, 0, 0.43, 0, 0.02);
      b.box('outdoor', 0.025, 0.4, 0.025, -0.2, 0.43, -0.21); b.box('outdoor', 0.025, 0.4, 0.025, 0.2, 0.43, -0.21);
      for (let k = 0; k < 3; k++) b.box('teak', 0.44, 0.06, 0.02, 0, 0.55 + k * 0.1, -0.22);
      b.pop();
    }
    F_vase(b, 0.0, 0.75, 0, 0.6, true); F_candle(b, 0.3, 0.75, 0.1, 0.12, false);
    b.push(0, 0.75, 0); F_placeSetting(b, -0.35, 0.22, 0, false); F_placeSetting(b, 0.35, 0.22, 0, false); b.pop();
    b.pop();
    // lanterns + big pot at the deck corner
    for (const [lx, lz] of [[dx0 + 0.25, dz0 + 0.25], [dx1 - 0.35, dz0 + 0.25]]) { b.push(lx, DECK_TOP, lz, 0); F_lantern(b); b.pop(); }
    b.push(0, DECK_TOP, 0, 0); F_plant(b, dx1 - 0.4, dz1 - 0.45, 1.2, 3, 0.24); b.pop();
    // lounger + side table on the lawn, turned to the afternoon sun
    const lx = ctx.unitId === '0.A' ? 3.9 : 7.95, lz = -4.3;
    b.push(lx, LAWN_TOP, lz, ctx.unitId === '0.A' ? 0.35 : -0.25); F_lounger(b); b.push(0.62, 0, -0.3); b.shadow(0.5, 0.5); b.cyl('teak', 0.2, 0.45, 0, 0, 0); b.cyl('glassware', 0.035, 0.12, 0.05, 0.45, 0); F_books(b, -0.06, 0.45, 0.04, 2, 0.4); b.pop(); b.pop();
    center = new T.Vector3((dx0 + dx1) / 2, y, (dz0 + dz1) / 2);
  }
  return { center };
}
function F_lantern(b) {
  b.shadow(0.4, 0.4);
  b.box('outdoor', 0.24, 0.02, 0.24, 0, 0, 0);
  for (const [x, z] of [[-0.11, -0.11], [0.11, -0.11], [-0.11, 0.11], [0.11, 0.11]]) b.box('outdoor', 0.015, 0.42, 0.015, x, 0.02, z);
  b.box('glass', 0.21, 0.4, 0.21, 0, 0.02, 0);
  b.box('outdoor', 0.26, 0.03, 0.26, 0, 0.44, 0);
  b.cyl('outdoor', 0.03, 0.06, 0, 0.47, 0);
  F_candle(b, 0, 0.02, 0, 0.14, false);
}
// ───────────────────────── hotspots ─────────────────────────
const WALKABLE = new Set(['wall', 'foot', 'wfront', 'vfront', 'wcfront', 'kzone']);
function roomHotspots(an, floorY, extra) {
  const r = an.room, out = [];
  const occ = (extra && extra.occ) || [];
  const freeAt = (x, z) => {
    if (!pip(x, z, r.poly)) return false;
    if (mansardH(x, z, r.floor) < 1.9) return false;
    for (const s of an.sides) if (sideDist(s, x, z) < (an.area > 8 ? 0.6 : 0.3)) return false;
    const pt = obb(x, z, 0.32, 0.32, 1, 0, 'eye');
    return !occ.some(o => !WALKABLE.has(o.tag) && obbHit(pt, o)) && !an.obst.some(o => obbHit(pt, o));
  };
  const findFree = (x, z) => {
    if (freeAt(x, z)) return { x, z };
    for (let rad = 0.15; rad < 2.5; rad += 0.15) for (let k = 0; k < 12; k++) { const a = k / 12 * PI * 2, px = x + Math.cos(a) * rad, pz = z + Math.sin(a) * rad; if (freeAt(px, pz)) return { x: px, z: pz }; }
    return { x, z };
  };
  const eye = floorY + 1.6;
  // stand near the main door into the room looking to the far side / centroid
  const doorZ = an.zones.filter(z => z.tag !== 'glassdoor');
  const c = an.c;
  // candidate free points; prefer near the entrance door but as far from the centre as possible (to see the room)
  let bx0 = 1e9, bx1 = -1e9, bz0 = 1e9, bz1 = -1e9; r.poly.forEach(([x, z]) => { bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); bz0 = Math.min(bz0, z); bz1 = Math.max(bz1, z); });
  const target = extra && extra.focus ? extra.focus : { x: c.x, z: c.z };
  let from = null, fs = -1e9;
  const clear = (x, z) => { const pt = obb(x, z, 0.55, 0.55, 1, 0, 'eye'); return occ.filter(o => !WALKABLE.has(o.tag) && obbHit(pt, o)).length; };
  for (let x = bx0 + 0.1; x < bx1; x += 0.15) for (let z = bz0 + 0.1; z < bz1; z += 0.15) {
    if (!freeAt(x, z)) continue;
    const dT = Math.hypot(x - target.x, z - target.z);
    const dDoor = doorZ.length ? Math.min(...doorZ.map(q => Math.hypot(q.cx - x, q.cz - z))) : 0;
    const f = extra && extra.focus;
    const sc = f && f.fx !== undefined
      ? Math.min(dT, 3.6) + ((x - f.x) * f.fx + (z - f.z) * f.fz) / Math.max(0.1, dT) * 1.2 - clear(x, z) * 0.5 - (dT < 1.8 ? 3 : 0)
      : Math.min(dT, 3.2) - Math.max(0, dDoor - 1.2) * 0.8 - clear(x, z) * 0.6;
    if (sc > fs) { fs = sc; from = { x, z }; }
  }
  if (!from) from = findFree(c.x, c.z);
  const small = r.use === 'bath' || r.use === 'wc' || an.area < 4.5;
  if (small && doorZ.length) { // step ~0.5 m inside the door
    const q = doorZ[0];
    for (const k of [0.55, 0.45, 0.35, 0.25]) { const x = q.cx + q.nx * (k - q.hd), z = q.cz + q.nz * (k - q.hd); if (pip(x, z, r.poly)) { from = { x, z }; break; } }
  }
  let far = { x: target.x, z: target.z };
  if (!(extra && extra.focus)) {
    let fd = -1; const k = small ? 0.4 : 0.25;
    for (const [x, z] of r.poly) { const d = Math.hypot(x - from.x, z - from.z); if (d > fd) { fd = d; far = { x: x + (c.x - x) * k, z: z + (c.z - z) * k }; } }
  }
  const glass = [...an.sides].sort((p, q) => glassLen(q) - glassLen(p))[0];
  if (!(extra && extra.focus) && glass && glassLen(glass) > 0.5 && r.use === 'kitchen-living') {
    const g = glass.openings.filter(o => o.type === 'window' || o.type === 'glassdoor').sort((p, q) => (q.s1 - q.s0) - (p.s1 - p.s0))[0];
    const m = (g.s0 + g.s1) / 2; const gx = glass.a.x + glass.u.x * m, gz = glass.a.z + glass.u.z * m;
    far = { x: (far.x + gx) / 2, z: (far.z + gz) / 2 };
  }
  out.push({ roomId: r.id, name: r.name, position: new T.Vector3(from.x, eye, from.z), lookAt: new T.Vector3(far.x, floorY + (extra && extra.focus ? 0.95 : small ? 1.3 : 1.25), far.z) });
  if (r.use === 'kitchen-living' || an.area > 13) {
    // second viewpoint from the far corner looking back (toward kitchen/dining)
    let best = null, bd = -1;
    for (const [x, z] of r.poly) {
      const q = findFree(x + (c.x - x) * 0.18, z + (c.z - z) * 0.18);
      const d = Math.hypot(q.x - from.x, q.z - from.z) - clear(q.x, q.z) * 1.2;
      if (freeAt(q.x, q.z) && d > bd) { bd = d; best = q; }
    }
    if (best) {
      let tgt = extra && extra.diningPos ? extra.diningPos : new T.Vector3(c.x, floorY + 1.1, c.z);
      const kp = extra && extra.kitchenPos;
      if (Math.hypot(tgt.x - best.x, tgt.z - best.z) < 2.2) tgt = kp && Math.hypot(kp.x - best.x, kp.z - best.z) > 1.8 ? new T.Vector3(kp.x, floorY + 1.1, kp.z) : new T.Vector3((c.x + from.x) / 2, floorY + 1.1, (c.z + from.z) / 2);
      out.push({ roomId: r.id, name: { en: r.name.en + ' · view 2', pt: r.name.pt + ' · vista 2', he: r.name.he + ' · מבט 2' }, position: new T.Vector3(best.x, eye, best.z), lookAt: new T.Vector3(tgt.x, floorY + 1.0, tgt.z) });
    }
  }
  return out;
}

// ───────────────────────── prewarm ─────────────────────────
// Generates (and optionally uploads) all procedural textures/materials of the given styles in small idle slices,
// so a later furnish()/style switch only builds geometry. Safe to call before buildInteriors().
// prewarm()                     → the three launch packages
// prewarm('riviera')            → that package plus its two neighbours in STYLE_IDS (lazy: what a style switcher can reach next)
// prewarm(['natura','urban'])   → exactly those
export function prewarm(styleIds = ['atlantic', 'lisboa', 'noir'], { renderer = null, neighbours = true } = {}) {
  let ids;
  if (typeof styleIds === 'string') {
    const i = STYLE_IDS.indexOf(styleIds), n = STYLE_IDS.length;
    ids = i < 0 ? [] : neighbours ? [STYLE_IDS[i], STYLE_IDS[(i + 1) % n], STYLE_IDS[(i + n - 1) % n]] : [STYLE_IDS[i]];
  } else ids = (Array.isArray(styleIds) ? styleIds : []).filter(id => STYLE_IDS.includes(id));
  if (renderer) RENDERER = renderer;
  return (async () => {
    try { initGeos(); } catch (e) { /* ignore */ }
    await loadManifest();
    const models = Promise.all(MODEL_SET.map(n => loadModel(n)));
    for (const id of ids) {
      const m = getMats(id);
      const keys = Object.keys(VOCAB).filter(k => { const v = vocabOf(k, id); return v && v[1] !== 'name'; });
      for (const k of keys) { try { m.get(k); } catch (e) { /* ignore */ } }
      await Promise.all(m.pending.slice());
      if (renderer && renderer.initTexture) for (const k of keys) { const mm = m.get(k).m; for (const t of [mm.map, mm.normalMap, mm.roughnessMap, mm.aoMap, mm.metalnessMap]) if (t) { try { renderer.initTexture(t); } catch (e) { /* ignore */ } } }
      await new Promise(r => setTimeout(r, 0));
    }
    await models;
  })().catch(() => {});
}

// ───────────────────────── main ─────────────────────────
export function buildInteriors(THREE, { scene, building = null, renderer = null } = {}) {
  if (THREE && THREE !== T && THREE.REVISION) T = THREE;
  if (renderer) RENDERER = renderer;
  initGeos();
  const group = new THREE.Group(); group.name = 'interiors';
  if (scene) scene.add(group);
  const units = new Map(); // unitId -> { root, styleId, hotspots }
  const unitList = [];     // same records, for allocation-free iteration
  let activeUnit = null, peekT = 0;
  const flames = [];
  let time = 0;

  function disposeRoot(root) {
    root.traverse(o => {
      if (o.isMesh && o.geometry && !o.isInstancedMesh) { if (![...GC.values()].includes(o.geometry)) o.geometry.dispose(); }
      if (o.isInstancedMesh && o.dispose) o.dispose();
    });
  }
  function clear(unitId = null) {
    const ids = unitId ? [unitId] : [...units.keys()];
    for (const id of ids) {
      const u = units.get(id); if (!u) continue;
      group.remove(u.root); disposeRoot(u.root); units.delete(id);
      const ix = unitList.indexOf(u); if (ix >= 0) unitList.splice(ix, 1);
      markDirty();
    }
  }
  function buildUnit(unitId, styleId) {
    const unit = UNITS.find(u => u.id === unitId);
    if (!unit) throw new Error('unknown unit ' + unitId);
    const floor = FLOORS.find(f => f.id === unit.floor);
    CUR_FLOOR = floor.id;
    const y = floor.level.y, ceil = floor.level.ceiling || 2.7;
    const mats = getMats(STYLE_IDS.includes(styleId) ? styleId : 'atlantic');
    const sd = mats.sd;
    const b = new Builder(mats); b.unitId = unitId;
    const ctx = { b, sd, mats, y: 0, ceil, unitLights: { n: 0 }, avoidDL: [], unitId, floorId: floor.id };
    { // per-unit deterministic artwork & frame choice (no repeats inside a unit)
      const R = mulberry(hashStr('art' + unitId + sd.id)), list = [];
      for (let k = 0; k < ART_KINDS; k++) for (let pi = 0; pi < sd.artPals.length; pi++) list.push(`art:${k}:${pi}`);
      for (let i = list.length - 1; i > 0; i--) { const j = R() * (i + 1) | 0; [list[i], list[j]] = [list[j], list[i]]; }
      let ai = 0, fi = 0; const fr = [...sd.frames, 'none'];
      ctx.pickArt = () => list[ai++ % list.length];
      ctx.pickFrame = () => fr[(fi++ + (hashStr(unitId) % fr.length)) % fr.length];
    }
    const rooms = roomsOfUnit(unitId);
    const hotspots = [];
    b.push(0, y, 0, 0);
    for (const room of rooms) {
      try {
        if (room.use === 'garden') {
          const g = layoutGarden(ctx, room, 0);
          hotspots.push({ roomId: room.id, name: room.name, position: new THREE.Vector3(g.center.x + 1.2, y + 1.6, g.center.z - 1.5), lookAt: new THREE.Vector3(g.center.x - 1, y + 1.3, 1.5) });
          hotspots.push({ roomId: room.id, name: { en: room.name.en + ' · view 2', pt: room.name.pt + ' · vista 2', he: room.name.he + ' · מבט 2' }, position: new THREE.Vector3(g.center.x, y + 1.6, -1.2), lookAt: new THREE.Vector3(g.center.x - 0.8, y + 1.2, g.center.z - 2.5) });
          continue;
        }
        const an = analyseRoom(room, floor.walls);
        const pl = new Planner(an);
        ctx.diningPos = null; ctx.focus = null; ctx.kitchenPos = null;
        const isBath = room.use === 'bath' || room.use === 'wc';
        if (isBath) closeGaps(b, an, ceil); // wet rooms must be closed (data.js has no wall between some en-suites and the lift shaft)
        floorOverlay(b, room.poly, 0, isBath ? 'bathFloor' : room.use === 'hall' ? 'hallFloor' : 'floor');
        if (sd.id === 'riviera') { try { floorJoints(b, room.poly, 0.9, 0.6); } catch (e) { /* decorative */ } }
        // skirting (joinery colour) around wall faces except openings
        if (!isBath) for (const s of an.sides) { wallFinish(b, s, 0, 'skirting', { h0: 0, h1: 0.09, d: 0.0, th: 0.02 }); wallFinish(b, s, 0, 'wall', { h0: 0.09, h1: ceil - CEIL_GAP, d: 0.0, th: 0.004 }); }
        if (room.use === 'kitchen-living') layoutLiving(ctx, an, pl);
        else if (room.use === 'bedroom' || room.use === 'suite') layoutBedroom(ctx, an, pl, room.use === 'bedroom' && rooms.some(r => r.use === 'suite') && unit.beds >= 2);
        else if (isBath) layoutBath(ctx, an, pl);
        else if (room.use === 'hall') layoutHall(ctx, an, pl);
        const cpoly = floor.id === 'second' ? clipConvex(room.poly, flatCeiling2()) : room.poly;
        if (cpoly.length >= 3) ceilingOverlay(b, cpoly, ceil);
        try { aoEdges(b, an, ceil); } catch (e) { /* decorative */ }
        if (cpoly.length >= 3) { if (sd.id === 'urban' && (room.use === 'kitchen-living' || room.use === 'hall')) trackLights(b, cpoly, ceil, ctx.avoidDL); else downlights(b, cpoly, 0, ceil, room.use === 'kitchen-living' ? 1.3 : 1.2, ctx.avoidDL); }
        ctx.avoidDL = [];
        hotspots.push(...roomHotspots(an, y, { diningPos: ctx.diningPos, occ: pl.occ, focus: ctx.focus, kitchenPos: ctx.kitchenPos }));
      } catch (e) {
        if (typeof console !== 'undefined') console.warn('[interiors] room', room.id, e);
      }
    }
    // balconies of this unit (not ground decks: garden handles those)
    for (const bal of BALCONIES) {
      if (!bal.unit.includes(unitId) || bal.deck) continue;
      const lvl = FLOORS.find(f => f.id === bal.level); if (!lvl || lvl.id !== floor.id) continue;
      try {
        let poly = bal.poly;
        if (bal.split !== undefined) { // shared slab: keep this unit's half
          const idx = bal.unit.indexOf(unitId); const [a, c] = [poly[0], poly[2]];
          poly = idx === 0 ? [[a[0], a[1]], [bal.split - 0.1, a[1]], [bal.split - 0.1, c[1]], [a[0], c[1]]] : [[bal.split + 0.1, a[1]], [c[0], a[1]], [c[0], c[1]], [bal.split + 0.1, c[1]]];
        }
        const out = poly[0][1] < 0 || poly[2][1] < 0 ? -1 : 1;
        const info = layoutBalcony(ctx, { ...bal, poly }, 0, out);
        const edgeZ = out < 0 ? 0 : 14.7;
        hotspots.push({ roomId: bal.id, name: { en: 'Balcony', pt: 'Varanda', he: 'מרפסת' }, position: new THREE.Vector3(info.center.x, y + 1.6, edgeZ + out * 0.35), lookAt: new THREE.Vector3(info.center.x + (out > 0 ? -2 : 2), y + 1.4, edgeZ + out * 12) });
      } catch (e) { if (typeof console !== 'undefined') console.warn('[interiors] balcony', bal.id, e); }
    }
    b.pop();
    CUR_FLOOR = null;
    const root = b.build(`interiors-${unitId}`);
    root.userData = { ...root.userData, unitId, styleId: sd.id, tod: TOD };
    attachCameraProbe(root);
    root.traverse(o => { if (o.isInstancedMesh && /flame/.test(o.name)) flames.push(o); });
    return { root, hotspots, styleId: sd.id };
  }

  const tokens = new Map();
  const timeout = (ms) => new Promise(r => setTimeout(r, ms));
  let assetsReady = null;
  function ensureAssets() {
    if (!assetsReady) assetsReady = loadManifest().then(() => Promise.all(MODEL_SET.map(n => loadModel(n)))).catch(() => null);
    return assetsReady;
  }
  // furnish: waits (bounded) for the manifest + glTF props, builds synchronously, then waits (bounded) for the package's PBR textures
  async function furnish(unitId, styleId) {
    const tk = (tokens.get(unitId) || 0) + 1; tokens.set(unitId, tk);
    try { await Promise.race([ensureAssets(), timeout(15000)]); } catch (e) { /* procedural fallback */ }
    if (tokens.get(unitId) !== tk) return;
    let u = null;
    try {
      clear(unitId);
      u = buildUnit(unitId, styleId);
      u.id = unitId; u.floor = (UNITS.find(q => q.id === unitId) || {}).floor;
      qualityRoot(u.root);
      group.add(u.root); units.set(unitId, u); unitList.push(u);
      applyActive(); markDirty();
      try { skinDoors(unitId, u.styleId); } catch (e) { /* optional */ }
    } catch (e) { CUR_FLOOR = null; if (typeof console !== 'undefined') console.warn('[interiors] furnish failed', unitId, e); }
    if (u) {
      const api = getMats(u.styleId); try { await Promise.race([Promise.all(api.pending.slice()), timeout(20000)]); } catch (e) { /* streamed */ }
      if (tokens.get(unitId) !== tk) return;
      // everything on the GPU before we report ready: textures uploaded, shader programs compiled
      try { uploadTextures(u.root); } catch (e) { /* optional */ }
      try { if (RENDERER && RENDERER.compile && scene) { const vis = u.root.visible; u.root.visible = true; for (const r of u.root._dyn) for (const m of r.reveal) m.visible = true; RENDERER.compile(u.root, compileCam, scene); for (const r of u.root._dyn) for (const m of r.reveal) m.visible = r.t > 0.004; u.root.visible = vis; } } catch (e) { /* optional */ }
    }
  }
  // Package door finish on BUILDING's interior door leaves of this unit (only if a building was passed in)
  const doorSkins = new Map(); // mesh -> original material
  function skinDoors(unitId, styleId) {
    const doors = building && building.doors; if (!Array.isArray(doors)) return;
    const unit = UNITS.find(q => q.id === unitId); if (!unit) return;
    const rooms = roomsOfUnit(unitId);
    const leaf = getPackageMaterial('door-interior', styleId), handle = getPackageMaterial('door-handle', styleId);
    for (const d of doors) {
      if (d.kind !== 'door' || d.floorId !== unit.floor || !d.center || !d.pivot) continue;
      const near = rooms.some(r => { const c = centroid(r.poly); return pip(d.center.x, d.center.z, r.poly) || [[0.3, 0], [-0.3, 0], [0, 0.3], [0, -0.3]].some(([dx, dz]) => pip(d.center.x + dx, d.center.z + dz, r.poly)); });
      if (!near) continue;
      d.pivot.traverse(o => {
        if (!o.isMesh || !o.material || Array.isArray(o.material)) return;
        const orig = doorSkins.has(o) ? doorSkins.get(o) : o.material;
        const n = (orig.name || '').toLowerCase();
        const target = /steel|brass|handle|chrome/.test(n) ? handle : /lacquer|walnut|door|leaf/.test(n) ? leaf : null;
        if (!target) return;
        if (!doorSkins.has(o)) doorSkins.set(o, orig);
        o.material = target;
      });
    }
  }
  function getHotspots(unitId) {
    const u = units.get(unitId);
    if (u) return u.hotspots.map(h => ({ ...h, position: h.position.clone(), lookAt: h.lookAt.clone() }));
    // not furnished yet: compute plain room hotspots
    const unit = UNITS.find(q => q.id === unitId); if (!unit) return [];
    const floor = FLOORS.find(f => f.id === unit.floor);
    const out = [];
    for (const room of roomsOfUnit(unitId)) {
      if (room.use === 'garden') { const c = centroid(room.poly); out.push({ roomId: room.id, name: room.name, position: new THREE.Vector3(c.x, floor.level.y + 1.6, c.z), lookAt: new THREE.Vector3(c.x, floor.level.y + 1.3, 2) }); continue; }
      try { out.push(...roomHotspots(analyseRoom(room, floor.walls), floor.level.y, null)); } catch (e) { /* skip */ }
    }
    return out;
  }
  // ── time of day ──
  function setTimeOfDay(tod) {
    if (!TODS.includes(tod)) tod = tod === 'golden' ? 'dusk' : 'day';
    TOD = tod; todAll();
    group.userData.tod = tod;
    for (const u of units.values()) {
      u.root.userData.tod = tod;
      u.root.traverse(o => { if (o.isPointLight && o.userData.base !== undefined) { o.distance = (o.userData.reach || o.distance) * POINT_REACH[tod]; } });
      for (const r of u.root._dyn || []) if (r.emisMode) r.it.label = r.lbl[dynIsOn(r) ? 1 : 0];
    }
    return tod;
  }
  // the unit's two point lights follow the two lamps nearest to the camera, so every room is lit when you are in it
  function attachCameraProbe(root) {
    const probe = root.getObjectByName('int-floor') || root.children.find(o => o.isMesh);
    if (!probe) return;
    probe.frustumCulled = false;
    const v = new THREE.Vector3();
    probe.onBeforeRender = (r, sc, cam) => { if (cam && cam.isPerspectiveCamera) { cam.getWorldPosition(v); root._camPos = v; } };
  }
  const compileCam = new THREE.PerspectiveCamera(60, 1.6, 0.05, 200);
  const markDirty = () => { try { if (scene) { scene.userData.interactDirty = true; if (scene.dispatchEvent) scene.dispatchEvent(EV_DIRTY); } } catch (e) { /* optional */ } };
  const EV_DIRTY = { type: 'interact-dirty' };
  const lampFactor = (L) => L.state === -1 ? 0 : L.state === 1 ? Math.max(POINT_TOD[TOD], POINT_TOD.dusk) : POINT_TOD[TOD];
  function roamLights(u, retarget) {
    const cam = u.root._camPos, lamps = u.root._lamps;
    if (!lamps || !lamps.length) return;
    const lights = u.lights || (u.lights = u.root.children.filter(o => o.isPointLight));
    const n = lights.length; if (!n) return;
    if (retarget && cam && lamps.length > n) { // the n lamps nearest the camera (switched-off lamps never win)
      let i0 = -1, i1 = -1, d0 = 1e9, d1 = 1e9;
      for (let i = 0; i < lamps.length; i++) {
        const L = lamps[i]; if (L.state === -1) continue;
        const dx = L.v.x - cam.x, dy = (L.v.y - cam.y) * 3, dz = L.v.z - cam.z, d = Math.sqrt(dx * dx + dy * dy + dz * dz) - L.intensity * 0.4 - (L.state === 1 ? 1.5 : 0);
        if (d < d0) { d1 = d0; i1 = i0; d0 = d; i0 = i; } else if (d < d1) { d1 = d; i1 = i; }
      }
      for (let w = 0; w < 2 && w < n; w++) {
        const li = w === 0 ? i0 : i1; if (li < 0) continue;
        let has = false; for (let k = 0; k < n; k++) if (lights[k].userData.lamp === li) has = true;
        if (has) continue;
        let slot = -1; for (let k = 0; k < n; k++) { const cur = lights[k].userData.lamp; if (cur !== i0 && cur !== i1) { slot = k; break; } }
        if (slot < 0) continue;
        const L = lamps[li], pl = lights[slot];
        pl.position.copy(L.v); pl.color.set(L.color); pl.distance = L.distance * POINT_REACH[TOD]; pl.userData.reach = L.distance;
        pl.userData.base = L.intensity; pl.userData.lamp = li; pl.intensity = 0;
      }
    }
    for (let k = 0; k < n; k++) { const pl = lights[k], L = lamps[pl.userData.lamp]; const t = pl.userData.base * (L ? lampFactor(L) : POINT_TOD[TOD]); pl.intensity += (t - pl.intensity) * 0.2; }
  }
  // ── visibility: only the active unit (plus units seen through an open entry door within 6 m) ──
  let entryDoors = null;
  function entryDoorOf(u) {
    if (!building || !Array.isArray(building.doors)) return null;
    if (!entryDoors) entryDoors = new Map();
    if (entryDoors.has(u.id)) return entryDoors.get(u.id);
    const unit = UNITS.find(q => q.id === u.id), room = unit && roomsOfUnit(u.id).find(r => r.id === unit.startRoom);
    let best = null, bd = 2.5;
    if (room) { const c = centroid(room.poly); for (const d of building.doors) { if (d.kind !== 'entry' || d.floorId !== unit.floor || !d.center) continue; const dist = Math.hypot(d.center.x - c.x, d.center.z - c.z); if (dist < bd) { bd = dist; best = d; } } }
    entryDoors.set(u.id, best);
    return best;
  }
  function applyActive() {
    const act = activeUnit ? units.get(activeUnit) : null, cam = act && act.root._camPos;
    for (let i = 0; i < unitList.length; i++) {
      const u = unitList[i];
      let vis = !activeUnit || u.id === activeUnit;
      if (!vis && act && u.floor === act.floor) {
        const mine = entryDoorOf(act), theirs = entryDoorOf(u);
        if (theirs && (theirs.t || 0) > 0.05 && (!mine || (mine.t || 0) > 0.05) && cam && Math.hypot(theirs.center.x - cam.x, theirs.center.z - cam.z) < 6) vis = true;
      }
      if (u.root.visible !== vis) u.root.visible = vis;
    }
  }
  function setActiveUnit(unitId) { activeUnit = unitId && UNITS.some(q => q.id === unitId) ? unitId : null; applyActive(); return activeUnit; }
  function setQuality(q) {
    q = q === 'low' ? 'low' : 'high';
    if (q === QUALITY) return q;
    QUALITY = q; qualityAll();
    for (let i = 0; i < unitList.length; i++) { qualityRoot(unitList[i].root); try { uploadTextures(unitList[i].root); } catch (e) { /* optional */ } }
    return q;
  }
  // interactables of a unit (ids, kinds, state) — for WALK/APP checks and UI lists
  function getInteractables(unitId) {
    const u = units.get(unitId); if (!u) return [];
    return u.root._dyn.map(r => ({ id: r.id, kind: r.kind, label: r.it.label, on: dynIsOn(r), object: r.group }));
  }
  function interact(id, on) { // programmatic toggle (tests, UI buttons); on: optional target state
    for (let i = 0; i < unitList.length; i++) { const L = unitList[i].root._dyn; for (let k = 0; k < L.length; k++) if (L[k].id === id) { if (on === undefined || dynIsOn(L[k]) !== !!on) dynToggle(L[k]); return dynIsOn(L[k]); } }
    return null;
  }
  let roamT = 0;
  function update(dt) {
    dt = Math.min(0.1, dt || 0); time += dt;
    roamT -= dt; const retarget = roamT <= 0; if (retarget) roamT = 0.2;
    let water = false;
    for (let i = 0; i < unitList.length; i++) {
      const u = unitList[i];
      if (!u.root.visible) continue;
      roamLights(u, retarget);
      if (u.root._dyn.length && dynUpdate(u.root._dyn, dt, time)) water = true;
    }
    if (water && FX.water) { FX.water.alphaMap.offset.y = (time * 1.9) % 1; FX.shower.alphaMap.offset.y = (time * 2.6) % 1; }
    if (activeUnit) { peekT -= dt; if (peekT <= 0) { peekT = 0.3; applyActive(); } }
    // gentle candle flicker via shared material
    if (EMI.flame[TOD]) for (let i = 0; i < STYLE_IDS.length; i++) {
      const m = MATS.get(STYLE_IDS[i]); if (!m || !m.cache.flame) continue;
      m.cache.flame.m.emissiveIntensity = (11 + Math.sin(time * 13.1) * 1.2 + Math.sin(time * 7.3) * 0.9) * EMI.flame[TOD];
    }
  }
  function setBuilding(b) { building = b || null; entryDoors = null; }
  function setRenderer(r) { RENDERER = r || null; }
  group.userData.tod = TOD;
  return { group, furnish, clear, getHotspots, update, setTimeOfDay, getTimeOfDay: () => TOD, prewarm: (ids, opts) => prewarm(ids, opts), setBuilding, setRenderer, getPackageMaterial,
    setActiveUnit, getActiveUnit: () => activeUnit, setQuality, getQuality: () => QUALITY, getInteractables, interact };
}
