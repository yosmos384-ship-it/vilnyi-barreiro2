// VILNYI · Barreiro 2 — INTERIORS
// Three complete interior schemes (Atlantic Light / Lisboa Heritage / Noir Riverside), all textures procedural.
// API: STYLE_IDS, buildInteriors(THREE, { scene }) => { group, furnish, clear, getHotspots, update }
import * as THREE_NS from 'three';
import { FLOORS, UNITS, STYLES, BALCONIES, LEVELS, FOOTPRINT, CORNICE_Y, MANSARD_PITCH, roomsOfUnit } from './data.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export const STYLE_IDS = ['atlantic', 'lisboa', 'noir'];

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
function styleDef(id) {
  const S = STYLES.find(s => s.id === id) || STYLES[0], p = S.palette;
  if (id === 'lisboa') return {
    id, p,
    floor: () => texHerringbone('lis-floor', '#80532f', { plankL: 0.56 }),
    floorRough: 0.42,
    bathFloor: () => texHydraulic('lis-hydr', { a: '#b5652e', b: '#2f4a6b', bg: '#efe6d6', size: 0.8 }),
    hallFloor: null,
    bathWall: () => texZellige('lis-zel', '#cfdde9', { size: 0.6, tiles: 6, grout: '#e9e6df' }), bathWallH: 1.25,
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
    bathWall: () => texMicrocement('noir-mcw', '#7a756e', { size: 3 }), bathWallH: 2.45,
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
    bathWall: () => texZellige('atl-zel', '#f2efe9', { size: 0.6, tiles: 8, grout: '#e2ded7' }), bathWallH: 2.45,
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
    floor: () => tex(sd.floor(), '#ffffff', { roughness: sd.floorRough, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }, sd.id === 'lisboa' ? 3 : 2.5),
    bathFloor: () => tex(sd.bathFloor(), '#ffffff', { roughness: 0.3, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }, 1.5),
    hallFloor: () => tex((sd.hallFloor || sd.floor)(), '#ffffff', { roughness: 0.5, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }, 2),
    wall: () => tex(texPlaster('plaster'), sd.wallPaint, { roughness: 0.92 }, 1.2),
    ceiling: () => plain(sd.id === 'noir' ? '#b3aca2' : p.ceiling, { roughness: 0.95 }),
    bathWall: () => tex(sd.bathWall(), '#ffffff', { roughness: 0.25 }, 2.5),
    showerWall: () => tex(sd.showerWall(), '#ffffff', { roughness: 0.18 }, 1.2),
    splash: () => tex(sd.splash(), '#ffffff', { roughness: 0.2 }, 1.2),
    worktop: () => tex(sd.worktop(), '#ffffff', { roughness: 0.22 }, 0.4),
    feature: () => sd.feature === 'microcement' ? tex(texMicrocement('noir-feat', '#3b3b3d', { size: 3 }), '#ffffff', { roughness: 0.8 }, 1)
      : tex(texFluted('flute-' + sd.id, sd.featureColor, { size: 0.5, flutes: 16 }), '#ffffff', { roughness: 0.6 }, 4),
    joinery: () => sd.id === 'noir' ? plain(p.joinery, { roughness: 0.55 }) : plain(sd.joinery, { roughness: 0.5 }),
    joineryTall: () => sd.joineryWood ? tex(wood(), sd.id === 'atlantic' ? '#f3e7d2' : '#ffffff', { roughness: 0.6 }, 1.5) : plain(sd.joineryTall, { roughness: 0.5 }),
    wood: () => tex(wood(), '#ffffff', { roughness: 0.55 }, 1.5),
    woodDark: () => tex(texPlanks('darkwood', '#3a281c', { size: 1.2, plankW: 0.15, grain: 26, knots: 0.05, gap: 0, gapA: 0, vary: 0.08 }), '#ffffff', { roughness: 0.5 }),
    oakLight: () => tex(texPlanks('atl-wood', '#c9a978', { size: 1.2, plankW: 0.15, grain: 26, knots: 0.05, gap: 0, gapA: 0, vary: 0.08 }), '#ffffff', { roughness: 0.6 }),
    metal: () => plain(sd.metal, { metalness: 1, roughness: sd.metalRough }),
    steel: () => plain('#c8cacc', { metalness: 1, roughness: 0.28 }),
    chrome: () => plain('#e8e8e8', { metalness: 1, roughness: 0.08 }),
    cutlery: () => plain(sd.id === 'lisboa' ? '#d8b36a' : sd.id === 'noir' ? '#3a3633' : '#dcdcdc', { metalness: 1, roughness: sd.id === 'noir' ? 0.35 : 0.12 }),
    black: () => plain('#1b1b1c', { roughness: 0.45 }),
    matteBlack: () => plain('#222223', { roughness: 0.7, metalness: 0.3 }),
    blackGlass: () => plain('#070708', { roughness: 0.06, metalness: 0.3 }),
    glass: () => plain('#dfe9ea', { transparent: true, opacity: 0.16, roughness: 0.03, metalness: 0.1, depthWrite: false, side: T.DoubleSide }),
    glassware: () => plain('#f4f8f8', { transparent: true, opacity: 0.28, roughness: 0.03, metalness: 0.2, depthWrite: false }),
    wine: () => plain('#5a0d1a', { transparent: true, opacity: 0.85, roughness: 0.05 }),
    mirror: () => ({ m: std({ color: '#ffffff', metalness: 1, roughness: 0.03, emissive: '#ffffff', emissiveMap: texMirrorFake('mirror-' + sd.id, sd.wallPaint, sd.id === 'noir' ? '#3d3a37' : '#cfc6b8'), emissiveIntensity: 0.55 }), wuv: false }),
    ceramic: () => plain(sd.ceramic, { roughness: 0.12 }),
    plate: () => plain(sd.id === 'lisboa' ? '#f6f1e6' : sd.id === 'noir' ? '#2f2e2c' : '#f6f4ef', { roughness: 0.18 }),
    plate2: () => plain(sd.id === 'lisboa' ? '#2f4a6b' : sd.id === 'noir' ? '#8b7f73' : '#c9d3d9', { roughness: 0.2 }),
    white: () => plain('#ffffff', { roughness: 0.5 }),
    whiteGloss: () => plain('#f4f4f2', { roughness: 0.15 }),
    appliance: () => plain('#2a2b2d', { roughness: 0.3, metalness: 0.6 }),
    stoneware: () => plain(sd.id === 'noir' ? '#6e6258' : sd.id === 'lisboa' ? '#b5652e' : '#e8e2d6', { roughness: 0.6 }),
    sofa: () => fab(sd.sofa, sd.sofaTex === 'boucle'),
    armchair: () => fab(sd.armchair, sd.id !== 'lisboa'),
    chairFabric: () => fab(sd.chairFabric, false),
    c0: () => fab(sd.cushions[0], false), c1: () => fab(sd.cushions[1], sd.id === 'atlantic'), c2: () => fab(sd.cushions[2], false), c3: () => fab(sd.cushions[3], true),
    throw: () => fab(sd.throw, true),
    bedding: () => fab(sd.bedding, false), duvet: () => fab(sd.duvet, false), bedThrow: () => fab(sd.bedThrow, true), headboard: () => fab(sd.headboard, false),
    napkin: () => fab(sd.id === 'noir' ? '#8a8279' : sd.id === 'lisboa' ? '#e7dcc6' : '#dfe5e8', false),
    towel: () => fab(sd.id === 'noir' ? '#a39a8f' : sd.id === 'lisboa' ? '#f1ebe0' : '#ffffff', true),
    towel2: () => fab(sd.id === 'noir' ? '#3a3633' : sd.id === 'lisboa' ? '#b5652e' : '#9fb1bd', true),
    rug: () => { const t = texRug('rug-' + sd.id, sd.id, sd.rug, sd.rugAccent); return { m: std({ map: t, normalMap: normalOf(t, 4, 512), roughness: 1, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 }), wuv: false }; },
    curtain: () => fab(sd.curtain, false, { roughness: 1, side: T.DoubleSide }),
    sheer: () => fab(sd.sheer, false, { roughness: 1, side: T.DoubleSide, transparent: true, opacity: 0.6, depthWrite: false }),
    art0: () => ({ m: std({ map: texArt('art0-' + sd.id, sd.art[0], sd.art[1]), roughness: 0.8 }), wuv: false }),
    art1: () => ({ m: std({ map: texArt('art1-' + sd.id, [sd.art[0][0], sd.art[0][2], sd.art[0][1], sd.art[0][3]], (sd.art[1] + 1) % 3), roughness: 0.8 }), wuv: false }),
    art2: () => ({ m: std({ map: texArt('art2-' + sd.id, [sd.art[0][3], sd.art[0][0], sd.art[0][1]], (sd.art[1] + 2) % 3), roughness: 0.8 }), wuv: false }),
    passepartout: () => plain('#f7f5f0', { roughness: 0.9 }),
    downlight: () => plain('#ffffff', { emissive: '#fff1dc', emissiveIntensity: 30, roughness: 1 }),
    dlGlow: () => { const t = texGlow('glow'); return { m: new T.MeshBasicMaterial({ color: '#ffe7c4', map: t, transparent: true, opacity: 0.55, depthWrite: false, blending: T.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 }), wuv: false }; },
    contact: () => { const t = texContact('contact'); return { m: new T.MeshBasicMaterial({ color: '#000000', alphaMap: t, transparent: true, opacity: sd.id === 'noir' ? 0.5 : 0.42, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 }), wuv: false }; },
    ledStrip: () => plain('#ffffff', { emissive: '#ffd9a8', emissiveIntensity: 6 }),
    shade: () => ({ m: std({ color: sd.lamp, emissive: sd.lamp, emissiveIntensity: 1.4, roughness: 0.9, side: T.DoubleSide, map: texLinen('linen', { size: 0.35 }) }), wuv: true }),
    bulb: () => plain('#fff', { emissive: '#ffcf8a', emissiveIntensity: 40 }),
    flame: () => plain('#ffb347', { emissive: '#ffa53a', emissiveIntensity: 12 }),
    fabricOf: (hex) => fab(hex, false),
    artOf: (spec) => { const [k, pi] = spec.split(':').map(Number); const pal = sd.artPals[pi % sd.artPals.length]; const t = texArt(`art-${sd.id}-${k}-${pi}`, pal, k); return { m: std({ map: t, roughness: 0.85 }), wuv: false }; },
    wax: () => plain(sd.id === 'noir' ? '#2a2826' : '#f3ece0', { roughness: 0.6 }),
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
    tint: () => plain('#ffffff', { roughness: 0.55 }),
    lamina: () => plain(sd.id === 'noir' ? '#a07b4f' : sd.id === 'lisboa' ? '#b8913f' : '#e8e2d6', { roughness: 0.3, metalness: sd.id === 'atlantic' ? 0 : 1 })
  };
  return F;
}
function getMats(styleId) {
  if (MATS.has(styleId)) return MATS.get(styleId);
  const sd = styleDef(styleId), F = matFactory(sd), cache = {};
  const api = {
    sd,
    get(k) {
      if (!cache[k]) {
        let f = F[k] || F.white; let r;
        if (k.startsWith('tint:')) f = () => ({ m: std({ color: k.slice(5), roughness: 0.55 }), wuv: false });
        else if (k.startsWith('tintFab:')) f = () => F.fabricOf(k.slice(8));
        else if (k.startsWith('art:')) f = () => F.artOf(k.slice(4));
        try { r = f(); } catch (e) { r = { m: std({ color: '#ff00ff' }), wuv: false }; }
        r.m.name = `int-${styleId}-${k}`; cache[k] = r;
      }
      return cache[k];
    }
  };
  api.keys = Object.keys(F).filter(k => k !== 'fabricOf' && k !== 'artOf');
  for (let k = 0; k < ART_KINDS; k++) for (let pi = 0; pi < sd.artPals.length; pi++) api.keys.push(`art:${k}:${pi}`);
  MATS.set(styleId, api);
  return api;
}

// ───────────────────────── shared base geometries ─────────────────────────
const G = {};
const GC = new Map();
function geo(key, fn) { if (!GC.has(key)) { const g = fn(); for (const n of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(n)) g.deleteAttribute(n); GC.set(key, g); } return GC.get(key); }
function initGeos() {
  G.box = geo('box', () => new T.BoxGeometry(1, 1, 1).translate(0, 0.5, 0));
  G.cyl = geo('cyl', () => new T.CylinderGeometry(1, 1, 1, 24, 1).translate(0, 0.5, 0));
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
  light(x, y, z, color, intensity, distance) { const v = new T.Vector3(x, y, z).applyMatrix4(this.M); this.lights.push({ v, color, intensity, distance }); }
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
    for (const L of this.lights) {
      const pl = new T.PointLight(L.color, L.intensity, L.distance, 2); pl.position.copy(L.v); pl.castShadow = false; pl.name = 'int-pendant-light';
      root.add(pl);
    }
    this.extras.forEach(o => root.add(o));
    return root;
  }
}
const CEIL_GAP = 0.012; // ceiling finish sits 12 mm below BUILDING's slab soffit
const RASTER_ONLY = new Set(['contact', 'dlGlow']);
const NO_CAST = new Set(['contact', 'dlGlow', 'floor', 'bathFloor', 'hallFloor', 'ceiling', 'wall', 'bathWall', 'showerWall', 'feature', 'rug', 'sheer', 'glass', 'glassware', 'wine', 'downlight', 'bulb', 'flame', 'ledStrip', 'lawn', 'deck', 'shade', 'splash']);
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
  b.box('black', w, h, 0.03, 0, y - h / 2, 0.035);
  b.add(G.plane, 'tv', 0, y, 0.0505, 0, 0, 0, w - 0.02, h - 0.02, 1);
}
function F_vase(b, x, y, z, s = 1, stems = true) {
  const g = lathe('vase', [[0, 0], [0.05, 0], [0.07, 0.04], [0.075, 0.1], [0.055, 0.18], [0.03, 0.24], [0.034, 0.27], [0.03, 0.27], [0.0, 0.26]]);
  b.add(g, 'stoneware', x, y, z, 0, 0, 0, s, s, s);
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
  } else { // strelitzia / snake plant: tall upright blades
    const sb = leafGeo(1, 0.09, 0.12, 0.06, 0.85);
    for (let i = 0; i < 12; i++) {
      const a = i * 2.39996 + R() * 0.3, l = h * (0.55 + R() * 0.45);
      b.I('blade', sb, LEAF[i % 3], x + Math.sin(a) * 0.04, y0, z + Math.cos(a) * 0.04, 0.08 + R() * 0.22, a, (R() - 0.5) * 0.3, 1, l, 1);
    }
  }
}
function F_floorLamp(b, sd) {
  b.cyl('matteBlack', 0.14, 0.02, 0, 0, 0);
  b.cyl('metal', 0.011, 1.45, 0, 0.02, 0, true);
  const shade = lathe('fshade', [[0.2, 0], [0.2, 0.001], [0.16, 0.3], [0.159, 0.3]], 28);
  b.add(shade, 'shade', 0, 1.3, 0);
  b.sph('bulb', 0.03, 0.03, 0.03, 0, 1.4, 0, true);
}
function F_sofa(b, w, d, sd) {
  b.shadow(w + 0.14, d + 0.12);
  const armW = 0.16, seatH = 0.42, backD = 0.22;
  b.box('black', w - 0.1, 0.06, d - 0.12, 0, 0, 0);
  b.rb('sofa', w, 0.3, d, 0, 0.06, 0, 0.04);
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
  const h = 0.62, d = 0.45;
  const legs = [[-w / 2 + 0.08, -d / 2 + 0.06], [w / 2 - 0.08, -d / 2 + 0.06], [-w / 2 + 0.08, d / 2 - 0.06], [w / 2 - 0.08, d / 2 - 0.06]];
  legs.forEach(([x, z]) => b.cyl('metal', 0.012, 0.14, x, 0, z, true));
  b.rb(sd.id === 'lisboa' ? 'wood' : 'joineryTall', w, h - 0.14, d, 0, 0.14, 0, 0.008);
  const n = Math.max(2, Math.round(w / 0.5));
  for (let i = 1; i < n; i++) b.box('black', 0.004, h - 0.18, 0.004, -w / 2 + i * w / n, 0.16, d / 2);
  for (let i = 0; i < n; i++) b.box('metal', 0.012, 0.12, 0.02, -w / 2 + (i + 0.5) * w / n + (i % 2 ? -0.18 : 0.18) * (w / n) / 0.5 * 0.5, 0.36, d / 2 + 0.01);
  F_books(b, -w / 2 + 0.3, h, 0.02, 4, 0.2);
  F_vase(b, w / 2 - 0.25, h, 0, 1.0, true);
  F_candle(b, w / 2 - 0.5, h, 0.05, 0.12);
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
    b.cyl(sd.tableTop === 'nero' ? 'worktop' : 'wood', w / 2, 0.035, 0, H - 0.035, 0);
    b.add(lathe('tped', [[0, 0], [0.26, 0], [0.26, 0.02], [0.08, 0.06], [0.06, 0.7], [0.12, 0.715], [0, 0.715]], 28), sd.id === 'lisboa' ? 'wood' : 'stoneware', 0, 0, 0);
  } else {
    b.rb(sd.tableTop === 'nero' ? 'worktop' : 'wood', w, 0.035, d, 0, H - 0.035, 0, 0.006);
    for (const sx of [-1, 1]) {
      b.box('matteBlack', 0.06, H - 0.035, 0.06, sx * (w / 2 - 0.12), 0, -d / 2 + 0.12);
      b.box('matteBlack', 0.06, H - 0.035, 0.06, sx * (w / 2 - 0.12), 0, d / 2 - 0.12);
    }
    b.box('matteBlack', w - 0.3, 0.06, 0.03, 0, H - 0.1, 0);
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
    b.pf('chair', F_chairProto, cx, 0, cz, a + PI, 1);
    b.push(0, H, 0); F_placeSetting(b, px, pz, a, true); b.pop();
  });
  // centrepiece: candles + bowl with fruit
  F_candle(b, -0.1, H, 0.03, 0.18); F_candle(b, 0.1, H, -0.03, 0.14);
  b.add(lathe('cbowl', [[0, 0], [0.04, 0], [0.12, 0.06], [0.115, 0.062], [0.035, 0.008], [0, 0.008]], 24), 'stoneware', 0, H, round ? 0.14 : 0.0);
  F_fruit(b, 0, H + 0.02, round ? 0.14 : 0.0, 5);
}
function F_fruit(b, x, y, z, n) {
  const cols = ['#e6a52a', '#d9761c', '#a8bf3a', '#c9361f', '#f0c64a', '#7aa33a'];
  for (let i = 0; i < n; i++) { const a = i * 2.2, r = i === 0 ? 0 : 0.055; b.I('fruit', G.sph, 'tint', x + Math.cos(a) * r, y + 0.035 + (i === 0 ? 0.03 : 0), z + Math.sin(a) * r, 0, 0, 0, 0.036, 0.034, 0.036, cols[i % cols.length]); }
}
function F_pendant(b, sd, y0, ceil, H = 1.55, big = true) {
  const len = ceil - (y0 + H);
  b.cyl('black', 0.002, len, 0, y0 + H, 0, true);
  b.cyl('metal', 0.04, 0.012, 0, ceil - 0.012, 0);
  if (sd.id === 'lisboa') b.add(lathe('pdome', [[0.001, 0.2], [0.07, 0.19], [0.2, 0.06], [0.22, 0.0], [0.215, 0.0], [0.195, 0.055], [0.068, 0.184], [0.001, 0.194]], 32), 'metal', 0, y0 + H - 0.2 + 0.2, 0, PI);
  else if (sd.id === 'noir') b.add(lathe('pcone', [[0.001, 0.02], [0.03, 0.02], [0.16, 0.22], [0.155, 0.22], [0.026, 0.024], [0.001, 0.024]], 32), 'matteBlack', 0, y0 + H + 0.02, 0, PI);
  else { b.sph('shade', 0.2, 0.2, 0.2, 0, y0 + H - 0.2, 0); }
  b.sph('bulb', 0.035, 0.035, 0.035, 0, y0 + H - 0.14, 0, true);
}

// kitchen run along a wall: w metres, local x from -w/2..w/2, back at z=-D/2 (depth 0.62)
// opts: { tall: 0|1|2, ceil, flip (tall columns at +x end) }
function F_kitchenRun(b, sd, w, opts) {
  b.shadow(w + 0.05, 0.85, 0, 0.06);
  const D = 0.62, H = 0.9, plinth = 0.1, wt = 0.03;
  const z0 = -D / 2, fz = z0 + D - 0.02;
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
  const baseC = (bs0 + bs1) / 2;
  b.box('matteBlack', baseW, plinth, D - 0.06, baseC, 0, z0 + (D - 0.06) / 2);
  for (const s of slots) {
    const cx = s.x + s.w / 2;
    b.box('joinery', s.w - 0.004, H - plinth - wt, D - 0.02, cx, plinth, z0 + (D - 0.02) / 2);
    if (s.k === 'drawer' || s.k === 'filler') {
      for (const y of [0.36, 0.6]) b.box('black', s.w - 0.02, 0.004, 0.004, cx, y, fz + 0.021);
      if (s.w > 0.25) for (const y of [0.25, 0.5, H - wt - 0.07]) b.box('metal', Math.min(0.3, s.w * 0.5), 0.012, 0.018, cx, y, fz + 0.03);
    } else if (s.k === 'hob') {
      if (tallN >= 2) { b.box('black', s.w - 0.02, 0.004, 0.004, cx, 0.5, fz + 0.021); b.box('metal', 0.3, 0.012, 0.018, cx, 0.3, fz + 0.03); b.box('metal', 0.3, 0.012, 0.018, cx, H - wt - 0.07, fz + 0.03); }
      else {
        b.box('blackGlass', s.w - 0.02, 0.58, 0.012, cx, 0.13, fz + 0.016);
        b.box('steel', s.w - 0.02, 0.1, 0.014, cx, 0.72, fz + 0.016);
        b.box('steel', s.w - 0.1, 0.012, 0.03, cx, 0.64, fz + 0.04);
        b.box('ledStrip', 0.06, 0.012, 0.004, cx + 0.18, 0.76, fz + 0.024);
        for (let i = 0; i < 2; i++) b.cyl('black', 0.016, 0.02, cx - 0.2 + i * 0.08, 0.77, fz + 0.024, false, HP);
      }
    } else if (s.k === 'dw') { b.box('metal', 0.3, 0.012, 0.018, cx, H - wt - 0.07, fz + 0.03); }
    else if (s.k === 'sink') { b.box('metal', 0.3, 0.012, 0.018, cx, H - wt - 0.07, fz + 0.03); b.box('black', s.w - 0.02, 0.004, 0.004, cx, 0.5, fz + 0.021); }
    else if (s.k === 'wm') { // front-loading washing machine (freestanding look, white)
      b.box('whiteGloss', s.w - 0.02, 0.82 - plinth, 0.03, cx, plinth, fz + 0.005);
      b.add(G.torus, 'steel', cx, 0.42, fz + 0.035, 0, 0, 0, 0.17, 0.17, 0.3);
      b.add(G.cyl, 'blackGlass', cx, 0.42, fz + 0.025, HP, 0, 0, 0.15, 0.02, 0.15);
      b.box('black', s.w - 0.08, 0.07, 0.01, cx, 0.72, fz + 0.035);
      b.cyl('steel', 0.022, 0.015, cx + 0.2, 0.755, fz + 0.04, false, HP);
    }
  }
  b.box('worktop', baseW, wt, D, baseC, H - wt, z0 + D / 2);
  b.box('splash', baseW, Math.min(0.62, opts.ceil - H - 0.9), 0.012, baseC, H, z0 + 0.006);
  const hobSlot = slots.find(s => s.k === 'hob'), sinkSlot = slots.find(s => s.k === 'sink');
  if (hobSlot) {
    const cx = hobSlot.x + hobSlot.w / 2;
    b.add(G.box, 'hob', cx, H - 0.001, z0 + 0.33, 0, 0, 0, 0.58, 0.006, 0.51);
    const hy = H + 0.65;
    if (sd.id === 'lisboa') { b.box('joinery', 0.8, 0.26, 0.5, cx, hy, z0 + 0.25); b.box('metal', 0.82, 0.03, 0.52, cx, hy, z0 + 0.26); b.box('joinery', 0.34, opts.ceil - hy - 0.26, 0.3, cx, hy + 0.26, z0 + 0.15); }
    else { const hm = sd.id === 'noir' ? 'matteBlack' : 'steel'; b.box(hm, 0.6, 0.05, 0.5, cx, hy, z0 + 0.25); b.box(hm, 0.26, opts.ceil - hy - 0.05, 0.24, cx, hy + 0.05, z0 + 0.12); b.box('ledStrip', 0.5, 0.004, 0.01, cx, hy - 0.002, z0 + 0.42); }
    b.add(lathe('pan', [[0, 0], [0.12, 0], [0.125, 0.07], [0.12, 0.07], [0.115, 0.005], [0, 0.005]], 28), 'matteBlack', cx - 0.14, H + 0.005, z0 + 0.2);
    b.box('matteBlack', 0.03, 0.015, 0.2, cx - 0.14, H + 0.06, z0 + 0.42, 0, -0.15);
  }
  if (sinkSlot) {
    const cx = sinkSlot.x + sinkSlot.w / 2;
    b.box('steel', 0.46, 0.004, 0.38, cx, H - 0.002, z0 + 0.32);
    b.box('blackGlass', 0.42, 0.002, 0.34, cx, H - 0.0005, z0 + 0.32);
    b.cyl('metal', 0.025, 0.05, cx, H, z0 + 0.08);
    b.cyl('metal', 0.012, 0.32, cx, H + 0.05, z0 + 0.08, true);
    b.add(G.torus, 'metal', cx, H + 0.37, z0 + 0.14, 0, HP, 0, 0.06, 0.06, 0.15);
    b.cyl('metal', 0.012, 0.08, cx, H + 0.29, z0 + 0.2, true);
    b.box('metal', 0.012, 0.012, 0.06, cx + 0.04, H + 0.1, z0 + 0.06);
    b.cyl('glassware', 0.028, 0.16, cx + 0.3, H, z0 + 0.08);
  }
  const uy = H + 0.65, uh = Math.min(0.9, opts.ceil - 0.2 - uy);
  if (opts.upper !== false) for (const s of slots) {
    if (s.k === 'hob') continue;
    const cx = s.x + s.w / 2;
    if (sd.id === 'lisboa') {
      b.box('wood', s.w, 0.035, 0.26, cx, uy + 0.35, z0 + 0.13);
      if (s.k === 'drawer' || s.k === 'dw') for (let i = 0; i < Math.floor(s.w / 0.15); i++) b.add(lathe('jar', [[0, 0], [0.05, 0], [0.055, 0.14], [0.03, 0.16], [0, 0.16]], 16), i % 2 ? 'plate2' : 'stoneware', cx - s.w / 2 + 0.1 + i * 0.14, uy + 0.385, z0 + 0.12);
      b.box('ledStrip', s.w - 0.04, 0.004, 0.02, cx, uy + 0.345, z0 + 0.2);
    } else {
      b.box('joinery', s.w - 0.004, uh, 0.34, cx, uy, z0 + 0.17);
      if (s.w > 0.25) b.box('metal', 0.25, 0.012, 0.012, cx, uy + 0.02, z0 + 0.345);
      b.box('ledStrip', s.w - 0.04, 0.004, 0.02, cx, uy - 0.004, z0 + 0.3);
    }
  }
  const tallH = Math.min(2.25, opts.ceil - 0.05);
  for (const m of mods) {
    const cx = m.x + m.w / 2;
    b.box('joineryTall', m.w - 0.004, tallH, D, cx, 0, z0 + D / 2);
    if (m.k === 'fridge') {
      b.box('black', m.w - 0.02, 0.004, 0.004, cx, 0.82, fz + 0.021);
      const hx = opts.flip ? cx + m.w / 2 - 0.06 : cx - m.w / 2 + 0.06;
      b.box('metal', 0.015, 0.6, 0.02, hx, 0.95, fz + 0.03);
      b.box('metal', 0.015, 0.35, 0.02, hx, 0.4, fz + 0.03);
    } else {
      b.box('blackGlass', m.w - 0.04, 0.58, 0.012, cx, 0.62, fz + 0.016);
      b.box('steel', m.w - 0.04, 0.1, 0.014, cx, 1.2, fz + 0.016);
      b.box('steel', m.w - 0.1, 0.012, 0.03, cx, 1.14, fz + 0.04);
      b.box('blackGlass', m.w - 0.04, 0.38, 0.012, cx, 1.34, fz + 0.016);
      b.box('steel', m.w - 0.04, 0.04, 0.014, cx, 1.72, fz + 0.016);
      b.box('ledStrip', 0.05, 0.01, 0.004, cx + 0.2, 1.735, fz + 0.024);
    }
  }
  const props = slots.filter(s => (s.k === 'drawer' || s.k === 'dw' || s.k === 'wm' || s.k === 'filler') && s.w >= 0.45);
  if (props.length) {
    const c = props[0], cx = c.x + c.w / 2;
    b.rb('matteBlack', 0.2, 0.34, 0.3, cx - 0.12, H, z0 + 0.18, 0.02);
    b.box('steel', 0.18, 0.08, 0.01, cx - 0.12, H + 0.22, z0 + 0.335);
    b.box('steel', 0.14, 0.012, 0.1, cx - 0.12, H, z0 + 0.28);
    b.cyl('ceramic', 0.035, 0.07, cx - 0.12, H + 0.012, z0 + 0.28);
    b.add(lathe('kettle', [[0, 0], [0.08, 0], [0.09, 0.03], [0.08, 0.17], [0.05, 0.2], [0.0, 0.205]], 24), sd.id === 'noir' ? 'matteBlack' : sd.id === 'lisboa' ? 'metal' : 'whiteGloss', cx + 0.15, H + 0.012, z0 + 0.2);
    b.cyl('black', 0.09, 0.012, cx + 0.15, H, z0 + 0.2);
    b.add(G.torus, 'black', cx + 0.24, H + 0.12, z0 + 0.2, 0, 0, 0, 0.06, 0.07, 0.25);
    b.cyl('black', 0.01, 0.08, cx + 0.07, H + 0.14, z0 + 0.2, true, 0, 1.0);
  }
  const c2 = props.length > 1 ? props[1] : null;
  if (c2) {
    const cx = c2.x + c2.w / 2;
    b.box('wood', 0.1, 0.22, 0.14, cx - 0.15, H, z0 + 0.1, 0, -0.35);
    for (let i = 0; i < 4; i++) b.box('black', 0.018, 0.1, 0.012, cx - 0.18 + i * 0.02, H + 0.22, z0 + 0.075, 0, 0, -0.35);
    b.box('wood', 0.3, 0.42, 0.02, cx + 0.1, H, z0 + 0.02, 0, 0, -0.1);
  }
  // fruit bowl on the worktop end next to the columns
  const fb = props[props.length - 1];
  if (fb && (props.length > 2 || !c2)) {
    const cx = fb.x + fb.w / 2 + (props.length > 2 ? 0 : 0.1);
    b.add(lathe('fbowl', [[0, 0], [0.05, 0], [0.14, 0.07], [0.135, 0.072], [0.045, 0.008], [0, 0.008]], 24), 'stoneware', cx, H, z0 + 0.4);
    F_fruit(b, cx, H + 0.02, z0 + 0.4, 6);
  }
}
function F_island(b, sd, w, d, stools) {
  b.shadow(w + 0.15, d + 0.25);
  const H = 0.9;
  b.box('matteBlack', w - 0.1, 0.1, d - 0.25, 0, 0, -0.05);
  b.box(sd.id === 'atlantic' ? 'joineryTall' : 'joinery', w - 0.05, H - 0.04 - 0.1, d - 0.2, 0, 0.1, -0.06);
  b.box('worktop', w, 0.04, d, 0, H - 0.04, 0);
  // waterfall ends in Noir/Atlantic
  if (sd.id !== 'lisboa') { b.box('worktop', 0.04, H - 0.04, d, -w / 2 + 0.02, 0, 0); b.box('worktop', 0.04, H - 0.04, d, w / 2 - 0.02, 0, 0); }
  for (let i = 0; i < stools; i++) b.pf('stool', F_stoolProto, -w / 2 + (i + 0.5) * w / stools, 0, d / 2 + 0.28, PI, 1);
  F_vase(b, w / 2 - 0.25, H, -0.1, 0.8, true);
  F_books(b, -w / 2 + 0.25, H, -0.1, 2, 0.4);
}
function F_bed(b, sd, W, L) {
  b.shadow(W + 0.45, L + 0.25, 0, -0.04);
  const H = 0.3, mat = 0.24;
  // base (upholstered platform)
  b.rb('headboard', W + 0.06, H, L, 0, 0.03, 0, 0.03);
  b.box('matteBlack', W - 0.1, 0.03, L - 0.2, 0, 0, 0);
  // headboard
  const hbH = sd.id === 'lisboa' ? 1.2 : 1.05;
  if (sd.id === 'lisboa') { // cane-like panel in walnut frame
    b.rb('wood', W + 0.3, hbH, 0.07, 0, 0, -L / 2 - 0.03, 0.02);
    b.rb('headboard', W + 0.1, hbH - 0.25, 0.04, 0, 0.35, -L / 2 + 0.01, 0.02);
  } else {
    const n = sd.id === 'noir' ? 1 : 4;
    for (let i = 0; i < n; i++) { const cw = (W + 0.3) / n; b.rb('headboard', cw - 0.01, hbH, 0.1, -(W + 0.3) / 2 + cw * (i + 0.5), 0, -L / 2 - 0.03, 0.045); }
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
  const w = 0.45, d = 0.38, h = 0.5;
  b.rb(sd.id === 'noir' ? 'woodDark' : 'wood', w, h - 0.12, d, 0, 0.12, 0, 0.01);
  for (const [x, z] of [[-0.18, -0.14], [0.18, -0.14], [-0.18, 0.14], [0.18, 0.14]]) b.cyl('metal', 0.01, 0.12, x, 0, z, true);
  b.box('metal', 0.14, 0.01, 0.015, 0, 0.3, d / 2 + 0.005);
  if (withLamp) {
    const base = lathe('lampbase', [[0, 0], [0.08, 0], [0.1, 0.1], [0.07, 0.24], [0.02, 0.28], [0.0, 0.28]], 24);
    b.add(base, 'stoneware', 0.08, h, -0.04);
    b.cyl('metal', 0.006, 0.1, 0.08, h + 0.28, -0.04, true);
    b.add(lathe('tshade', [[0.16, 0], [0.16, 0.001], [0.12, 0.2], [0.119, 0.2]], 28), 'shade', 0.08, h + 0.28, -0.04);
    b.sph('bulb', 0.025, 0.025, 0.025, 0.08, h + 0.34, -0.04, true);
    F_books(b, -0.1, h, 0.06, 2, 0.2);
  }
}
function F_wardrobe(b, sd, w, h) {
  b.shadow(w + 0.08, 0.78);
  const d = 0.6, n = Math.max(1, Math.round(w / 0.5));
  b.box('joineryTall', w, h, d, 0, 0, 0);
  for (let i = 1; i < n; i++) b.box('black', 0.004, h - 0.02, 0.004, -w / 2 + i * w / n, 0.01, d / 2 + 0.001);
  for (let i = 0; i < n; i++) {
    const hx = -w / 2 + (i + 0.5) * w / n + (i % 2 ? -1 : 1) * (w / n / 2 - 0.05);
    b.box('metal', 0.014, 0.4, 0.02, hx, 0.9, d / 2 + 0.012);
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
  b.shadow(w + 0.05, 0.42);
  const d = 0.3, H = 0.8;
  b.rb(sd.id === 'noir' ? 'worktop' : 'wood', w, 0.03, d, 0, H - 0.03, 0, 0.005);
  b.box('metal', 0.02, H - 0.03, 0.02, -w / 2 + 0.04, 0, -d / 2 + 0.04); b.box('metal', 0.02, H - 0.03, 0.02, w / 2 - 0.04, 0, -d / 2 + 0.04);
  b.box('metal', 0.02, H - 0.03, 0.02, -w / 2 + 0.04, 0, d / 2 - 0.04); b.box('metal', 0.02, H - 0.03, 0.02, w / 2 - 0.04, 0, d / 2 - 0.04);
  b.box('metal', w - 0.06, 0.02, d - 0.06, 0, 0.12, 0);
  F_vase(b, w / 2 - 0.15, H, 0, 0.8, true);
  b.add(lathe('trayb', [[0, 0], [0.1, 0], [0.1, 0.015], [0.095, 0.015], [0.095, 0.004], [0, 0.004]], 24), 'metal', -w / 2 + 0.2, H, 0.02);
  b.box('metal', 0.05, 0.004, 0.02, -w / 2 + 0.2, H + 0.005, 0.02, 0.5); // keys
  F_books(b, -w / 2 + 0.2, 0.14, 0.0, 3, 0.1);
  // round mirror above
  b.add(G.cyl, 'metal', 0, 1.55, -d / 2 + 0.012, HP, 0, 0, 0.36, 0.02, 0.36);
  b.add(G.cyl, 'mirror', 0, 1.55, -d / 2 + 0.024, HP, 0, 0, 0.34, 0.006, 0.34);
}
function F_hooks(b, sd, n = 4) {
  b.box(sd.id === 'noir' ? 'woodDark' : 'wood', 0.12 + n * 0.16, 0.08, 0.02, 0, 1.72, 0.01);
  for (let i = 0; i < n; i++) { const x = -(n - 1) * 0.08 + i * 0.16; b.cyl('metal', 0.01, 0.07, x, 1.75, 0.02, true, HP); b.sph('metal', 0.014, 0.014, 0.014, x, 1.75, 0.09, true); }
  // coat & bag
  b.rb('c3', 0.4, 0.8, 0.1, -(n - 1) * 0.08, 0.9, 0.08, 0.04);
  b.rb('stoneware', 0.3, 0.26, 0.1, (n - 1) * 0.08, 1.4, 0.06, 0.03);
  b.cyl('stoneware', 0.005, 0.2, (n - 1) * 0.08, 1.62, 0.09, true, 0, 0.3);
}

// bathroom
function F_vanity(b, sd, w) {
  const d = 0.48, H = 0.86;
  b.box(sd.id === 'lisboa' ? 'wood' : 'joineryTall', w, 0.36, d, 0, H - 0.4, 0);
  b.box('black', w - 0.02, 0.003, 0.003, 0, H - 0.22, d / 2 + 0.001);
  b.box('ledStrip', w - 0.06, 0.004, 0.02, 0, H - 0.405, d / 2 - 0.05);
  b.box(sd.vanityTop === 'nero' ? 'worktop' : 'worktop', w, 0.04, d, 0, H - 0.04, 0);
  // vessel basin
  b.add(lathe('basin', [[0, 0], [0.12, 0], [0.19, 0.04], [0.2, 0.13], [0.19, 0.13], [0.18, 0.05], [0.11, 0.018], [0, 0.018]], 32), 'ceramic', 0, H, 0.03, 0, 0, 0, 1, 1, 0.8);
  // wall mounted tap
  b.cyl('metal', 0.025, 0.012, 0, H + 0.3, -d / 2 + 0.006, false, HP);
  b.cyl('metal', 0.011, 0.18, 0, H + 0.3, -d / 2 + 0.01, true, HP);
  b.cyl('metal', 0.008, 0.06, 0.1, H + 0.36, -d / 2 + 0.01, true, HP);
  // accessories
  b.cyl('stoneware', 0.035, 0.16, w / 2 - 0.12, H, -0.1);
  b.cyl('metal', 0.012, 0.03, w / 2 - 0.12, H + 0.16, -0.1);
  b.box('towel', 0.28, 0.06, 0.2, -w / 2 + 0.2, H, -0.05);
  b.box('towel2', 0.26, 0.05, 0.18, -w / 2 + 0.2, H + 0.06, -0.05, 0.1);
  // mirror (backlit)
  const mw = Math.min(w, 0.9), mh = 0.8;
  if (sd.id === 'atlantic') { b.add(G.cyl, 'ledStrip', 0, H + 0.72, -d / 2 + 0.01, HP, 0, 0, 0.36, 0.01, 0.36); b.add(G.cyl, 'mirror', 0, H + 0.72, -d / 2 + 0.03, HP, 0, 0, 0.35, 0.01, 0.35); }
  else if (sd.id === 'lisboa') { b.rb('metal', 0.56, mh + 0.04, 0.03, 0, H + 0.3, -d / 2 + 0.015, 0.02); b.box('mirror', 0.52, mh, 0.01, 0, H + 0.32, -d / 2 + 0.032); }
  else { b.box('ledStrip', mw + 0.02, mh + 0.02, 0.01, 0, H + 0.29, -d / 2 + 0.005); b.box('mirror', mw, mh, 0.02, 0, H + 0.3, -d / 2 + 0.012); }
}
function F_wc(b, sd) {
  b.box('whiteGloss', 0.5, 1.1, 0.14, 0, 0, -0.07 + 0.0); // boxed-in cistern
  b.box('worktop', 0.52, 0.02, 0.16, 0, 1.1, -0.07);
  b.box('metal', 0.2, 0.13, 0.008, 0, 0.95, 0.004);
  const bowl = lathe('wcbowl', [[0, 0], [0.16, 0.0], [0.18, 0.04], [0.18, 0.08], [0.16, 0.14], [0.0, 0.14]], 28);
  b.add(bowl, 'ceramic', 0, 0.26, 0.28, 0, 0, 0, 1, 1, 1.35);
  b.box('ceramic', 0.34, 0.14, 0.2, 0, 0.26, 0.1);
  b.add(G.cyl, 'ceramic', 0, 0.4, 0.28, 0, 0, 0, 0.18, 0.02, 0.24);
  // paper holder
  b.cyl('metal', 0.006, 0.12, 0.38, 0.72, 0.1, true, 0, HP);
  b.cyl('paper', 0.055, 0.1, 0.33, 0.72, 0.1, false, 0, HP);
}
function F_shower(b, sd, w, d, glassSide) {
  // tray/floor recess & drain; shower wall finish set by caller; glass screen on 'glassSide'
  b.box('bathFloor', w, 0.012, d, 0, 0, 0);
  b.box('steel', 0.6, 0.004, 0.04, 0, 0.012, -d / 2 + 0.1);
  // rain head + mixer on back wall (-z)
  b.box('metal', 0.02, 0.02, 0.35, 0, 2.08, -d / 2 + 0.17);
  b.box('metal', 0.25, 0.012, 0.25, 0, 2.06, -d / 2 + 0.3);
  b.cyl('metal', 0.035, 0.03, 0.2, 1.1, -d / 2, false, HP);
  b.cyl('metal', 0.035, 0.03, -0.2, 1.1, -d / 2, false, HP);
  b.box('metal', 0.012, 0.6, 0.02, 0.35, 0.9, -d / 2 + 0.02);
  b.cyl('metal', 0.02, 0.2, 0.35, 1.45, -d / 2 + 0.05, true);
  // niche shelf with bottles
  b.box('worktop', 0.35, 0.02, 0.1, -w / 2 + 0.3, 1.2, -d / 2 + 0.05);
  for (let i = 0; i < 3; i++) b.cyl(i === 1 ? 'stoneware' : 'wax', 0.025, 0.14 + i * 0.02, -w / 2 + 0.2 + i * 0.08, 1.22, -d / 2 + 0.05);
  // glass screen
  if (glassSide === 'front') { const gw = Math.min(w - 0.05, 0.9); b.box('glass', gw, 2.0, 0.008, w / 2 - gw / 2, 0.012, d / 2); b.box('metal', gw, 0.015, 0.012, w / 2 - gw / 2, 2.012, d / 2); b.box('metal', 0.015, 0.8, 0.015, w / 2 - gw, 2.0, d / 2 - 0.004, 0, 0, 0); }
  else { const gd = Math.min(d - 0.05, 0.9); const sx = glassSide === 'left' ? -1 : 1; b.box('glass', 0.008, 2.0, gd, sx * w / 2, 0.012, -d / 2 + gd / 2); b.box('metal', 0.012, 0.015, gd, sx * w / 2, 2.012, -d / 2 + gd / 2); }
}
function F_towelRail(b, sd) {
  for (let i = 0; i < 6; i++) b.cyl('metal', 0.01, 0.5, -0.25, 0.7 + i * 0.13, 0, true, 0, HP);
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
    const segX = Math.max(12, Math.round(folds * 8)), g = new T.PlaneGeometry(w, h, segX, 5);
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
  b.box('matteBlack', w + 0.7, 0.025, 0.08, 0, ceil - 0.025, 0.12);
  const sheerW = w * 0.5 + 0.05;
  for (const s of [-1, 1]) {
    const cx = s * (w / 2 - sheerW / 2 + 0.06);
    b.add(curtainGeo(sheerW, H - 0.01, Math.round(sheerW / 0.11), 0.028), 'sheer', cx, 0.01, 0.1);
    b.add(curtainGeo(0.4, H, 5, 0.05), 'curtain', s * (w / 2 + 0.13), 0.01, 0.2);
  }
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
    b.I('dlRing', G.cyl, 'matteBlack', x, c - 0.004, z, 0, 0, 0, 0.045, 0.004, 0.045);
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
        const q = placeOf(ir); b.push(q.x, 0, q.z, q.ry + PI); F_island(b, sd, iw, idp, Math.floor(iw / 0.6)); b.pop();
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
    if (artOK) {
      const ar = rectOnSide(sofa.sd, sofa.s0, sofa.s1, 0, 0.05, 'art'); const q = placeOf(ar);
      b.push(q.x, y ? 0 : 0, q.z, q.ry);
      const fr = ctx.pickFrame();
      if (sw >= 2.0) { b.push(-0.36, 0, 0); F_art(b, 0.62, 0.8, 1.72, ctx.pickArt(), fr); b.pop(); b.push(0.36, 0, 0); F_art(b, 0.62, 0.8, 1.72, ctx.pickArt(), fr); b.pop(); }
      else F_art(b, 1.0, 0.7, 1.72, ctx.pickArt(), fr);
      b.pop();
    }
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
      const blockedF = best.s2.openings.some(o => o.s1 > f0 && o.s0 < f1);
      if (!blockedF) wallFinish(b, best.s2, y, 'feature', { r0: f0, r1: f1, h0: 0.0, h1: ceil, d: 0.009, th: 0.02 });
      const q = placeOf(best.r); b.push(q.x, 0, q.z, q.ry);
      const d0 = blockedF ? 0 : 0.03;
      b.push(0, 0, d0); F_tv(b, 1.3, true);
      // low media unit
      b.shadow(1.7, 0.5, 0, 0.2); b.box('matteBlack', 1.5, 0.1, 0.32, 0, 0, 0.18); b.rb(sd.id === 'lisboa' ? 'wood' : 'joineryTall', 1.6, 0.42, 0.4, 0, 0.1, 0.2, 0.01);
      b.box('black', 0.004, 0.3, 0.004, -0.4, 0.2, 0.401); b.box('black', 0.004, 0.3, 0.004, 0.4, 0.2, 0.401);
      F_books(b, -0.55, 0.52, 0.2, 2, 0.1); F_vase(b, 0.6, 0.52, 0.22, 0.6, false);
      b.box('matteBlack', 0.4, 0.06, 0.08, 0.2, 0.52, 0.22);
      b.pop(); b.pop();
    }
    // armchair beside the coffee table
    const side = [1, -1];
    for (const sgn of side) {
      const ax = ct.cx + Math.cos(p.ry) * sgn * (0.5 + 0.65) + Math.sin(p.ry) * 0.05, az = ct.cz - Math.sin(p.ry) * sgn * (0.5 + 0.65) + Math.cos(p.ry) * 0.05;
      const facing = p.ry + (sgn > 0 ? -HP : HP) + (sgn > 0 ? 0.35 : -0.35);
      const ar = obb(ax, az, 0.42, 0.42, Math.cos(facing), -Math.sin(facing), 'arm');
      if (!pl.blocked(ar, { margin: 0.05 })) { pl.take(ar); b.push(ax, 0, az, facing); F_armchair(b, sd); b.pop(); break; }
    }
    // floor lamp at sofa end
    for (const sgn of [1, -1]) {
      const lx = p.x + Math.cos(p.ry) * sgn * (sw / 2 + 0.25) + Math.sin(p.ry) * -0.1, lz = p.z - Math.sin(p.ry) * sgn * (sw / 2 + 0.25) + Math.cos(p.ry) * -0.1;
      const lr = obb(lx, lz, 0.16, 0.16, 1, 0, 'lamp');
      if (!pl.blocked(lr)) { pl.take(lr); b.push(lx, 0, lz, 0); F_floorLamp(b, sd); b.pop(); if (unitLights.n < 2) { unitLights.n++; b.light(lx, 1.35, lz, sd.light, 1.2, 3.5); } break; }
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
    if (unitLights.n < 2) { unitLights.n++; b.light(r.cx, 1.35, r.cz, sd.light, 2.2, 4.5); }
    ctx.avoidDL.push([r.cx, r.cz]);
    ctx.diningPos = new T.Vector3(r.cx, y + 0.75, r.cz);
  }
  // 4 · sideboard / plants
  const sb = pl.againstWall({ w: 1.4, d: 0.45, tall: false, score: (s, m, r) => -Math.abs(m - s.len / 2) * 0.2 });
  if (sb) { pl.take(sb.r); doItem(b, sb.r, () => F_sideboard(b, sd, 1.4)); const ar = rectOnSide(sb.sd, sb.s0, sb.s1, 0, 0.05); const q = placeOf(ar); if (!sb.sd.openings.some(o => o.s1 > sb.s0 && o.s0 < sb.s1) && wallHeadroom(sb.sd, sb.s0, sb.s1) > 2.0) { b.push(q.x, 0, q.z, q.ry); F_art(b, 0.7, 0.9, 1.68, ctx.pickArt(), ctx.pickFrame()); b.pop(); } }
  plantsInCorners(ctx, an, pl, 2, glazing);
  curtainsFor(ctx, an, ['window', 'glassdoor']);
}
function F_diningTable2(b, sd, w) {
  b.shadow(w + 0.5, w + 1.1);
  const H = 0.75;
  b.cyl(sd.tableTop === 'nero' ? 'worktop' : 'wood', w / 2, 0.035, 0, H - 0.035, 0);
  b.add(lathe('tped2', [[0, 0], [0.22, 0], [0.22, 0.02], [0.07, 0.06], [0.05, 0.7], [0.1, 0.715], [0, 0.715]], 28), sd.id === 'lisboa' ? 'wood' : 'stoneware', 0, 0, 0);
  for (const s of [1, -1]) {
    b.pf('chair', F_chairProto, 0, 0, s * (w / 2 + 0.12), s > 0 ? PI : 0, 1);
    b.push(0, H, 0); F_placeSetting(b, 0, s * (w / 2 - 0.17), s > 0 ? 0 : PI, true); b.pop();
  }
  F_candle(b, -0.08, H, 0.0, 0.18); F_candle(b, 0.08, H, 0.0, 0.14);
  F_vase(b, 0.0, H, 0.0, 0.5, true);
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
    const kind = [0, 1, 3][(hashStr(an.room.id) + n) % 3];
    pl.take(r); F_plant(b, x, z, kind === 3 ? 1.0 : 1.2 + (n % 2) * 0.4, kind, 0.17 + (n % 2) * 0.03); n++;
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
    if (wallHeadroom(bed.sd, bed.s0, bed.s1) > 2.2) { b.push(q.x, 0, q.z, q.ry); F_art(b, Math.min(1.3, bw), 0.62, 2.0, ctx.pickArt(), ctx.pickFrame()); b.pop(); }
    // rug under lower 2/3 of bed
    const rug = rectOnSide(bed.sd, bed.s0 + 0.2, bed.s1 - 0.2, 0.9, Math.min(L + 0.7, 2.8));
    if (rectInPoly(rug, an.room.poly)) { const rq = placeOf(rug); b.push(rq.x, 0, rq.z, rq.ry); F_rug(b, rug.hw * 2, rug.hd * 2); b.pop(); }
    // foot clearance
    pl.take(rectOnSide(bed.sd, bed.s0 + 0.4, bed.s1 - 0.4, L + 0.1, L + 0.75, 'foot'));
    if (unitLights.n < 2 && !ctx.bedLight) { ctx.bedLight = true; }
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
  for (const s of an.sides) wallFinish(b, s, y, 'bathWall', { h0: 0, h1: sd.bathWallH, d: 0.013 });
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
    wallFinish(b, s, y, 'showerWall', { r0: shower.s0, r1: shower.s0 + sw, h0: 0, h1: 2.3, d: 0.022, th: 0.012 });
    const q = placeOf(shower.r);
    // glass on the open long side (the side facing the room) → local 'front'
    b.push(q.x, 0, q.z, q.ry); F_shower(b, sd, sw, d, 'front'); b.pop();
    // side walls finishing: adjacent sides at corner
    for (const s2 of an.sides) {
      if (s2 === s) continue;
      const along = (shower.r.cx - s2.a.x) * s2.u.x + (shower.r.cz - s2.a.z) * s2.u.z, dist = sideDist(s2, shower.r.cx, shower.r.cz);
      const halfAlong = Math.abs(s2.u.x * shower.r.nx + s2.u.z * shower.r.nz) > 0.9 ? shower.r.hd : shower.r.hw;
      const halfDist = Math.abs(s2.n.x * shower.r.nx + s2.n.z * shower.r.nz) > 0.9 ? shower.r.hd : shower.r.hw;
      if (Math.abs(dist - halfDist) < 0.05) wallFinish(b, s2, y, 'showerWall', { r0: along - halfAlong, r1: along + halfAlong, h0: 0, h1: 2.3, d: 0.022, th: 0.012 });
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
    b.push(minx + 0.8, 0, cz, 0); F_bistro(b, sd); b.pop();
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
export function prewarm(styleIds = STYLE_IDS, { renderer = null, sliceMs = 12 } = {}) {
  const ids = (Array.isArray(styleIds) ? styleIds : [styleIds]).filter(id => STYLE_IDS.includes(id));
  const idle = (cb) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(cb, { timeout: 200 }) : setTimeout(cb, 0));
  return new Promise((resolve) => {
    const jobs = [];
    try { initGeos(); } catch (e) { /* ignore */ }
    for (const id of ids) {
      jobs.push(() => getMats(id));
      jobs.push(() => { const m = getMats(id); m.keys.forEach(k => jobs.push(() => {
        const mat = m.get(k).m;
        if (renderer && renderer.initTexture) for (const t of [mat.map, mat.normalMap, mat.emissiveMap, mat.alphaMap]) if (t) { try { renderer.initTexture(t); } catch (e) { /* ignore */ } }
      })); });
    }
    const step = () => {
      const t0 = performance.now();
      try { while (jobs.length && performance.now() - t0 < sliceMs) jobs.shift()(); } catch (e) { /* keep going */ }
      if (jobs.length) idle(step); else resolve();
    };
    idle(step);
  });
}

// ───────────────────────── main ─────────────────────────
export function buildInteriors(THREE, { scene } = {}) {
  if (THREE && THREE !== T && THREE.REVISION) T = THREE;
  initGeos();
  const group = new THREE.Group(); group.name = 'interiors';
  if (scene) scene.add(group);
  const units = new Map(); // unitId -> { root, styleId, hotspots }
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
    const b = new Builder(mats);
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
        floorOverlay(b, room.poly, 0, isBath ? 'bathFloor' : room.use === 'hall' ? 'hallFloor' : 'floor');
        // skirting (joinery colour) around wall faces except openings
        if (!isBath) for (const s of an.sides) { wallFinish(b, s, 0, 'joinery', { h0: 0, h1: 0.09, d: 0.0, th: 0.02 }); wallFinish(b, s, 0, 'wall', { h0: 0.09, h1: ceil - CEIL_GAP, d: 0.0, th: 0.004 }); }
        if (room.use === 'kitchen-living') layoutLiving(ctx, an, pl);
        else if (room.use === 'bedroom' || room.use === 'suite') layoutBedroom(ctx, an, pl, room.use === 'bedroom' && rooms.some(r => r.use === 'suite') && unit.beds >= 2);
        else if (isBath) layoutBath(ctx, an, pl);
        else if (room.use === 'hall') layoutHall(ctx, an, pl);
        const cpoly = floor.id === 'second' ? clipConvex(room.poly, flatCeiling2()) : room.poly;
        if (cpoly.length >= 3) ceilingOverlay(b, cpoly, ceil);
        if (cpoly.length >= 3) downlights(b, cpoly, 0, ceil, room.use === 'kitchen-living' ? 1.3 : 1.2, ctx.avoidDL);
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
    root.userData = { unitId, styleId: sd.id };
    root.traverse(o => { if (o.isInstancedMesh && /flame/.test(o.name)) flames.push(o); });
    return { root, hotspots, styleId: sd.id };
  }

  function furnish(unitId, styleId) {
    return new Promise((resolve) => {
      try {
        clear(unitId);
        const u = buildUnit(unitId, styleId);
        group.add(u.root); units.set(unitId, u);
      } catch (e) { CUR_FLOOR = null; if (typeof console !== 'undefined') console.warn('[interiors] furnish failed', unitId, e); }
      resolve();
    });
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
  function update(dt) {
    time += dt || 0;
    // gentle candle flicker via shared material
    for (const sid of STYLE_IDS) {
      const m = MATS.get(sid); if (!m) continue;
      const f = m.get('flame').m; f.emissiveIntensity = 11 + Math.sin(time * 13.1) * 1.2 + Math.sin(time * 7.3) * 0.9;
    }
  }
  return { group, furnish, clear, getHotspots, update, prewarm: (ids, opts) => prewarm(ids, opts) };
}
