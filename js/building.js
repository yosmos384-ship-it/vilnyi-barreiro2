// VILNYI · Barreiro 2 — BUILDING: exterior shell, interiors shell, core (stairs + lift), basement, roof and lot.
// Everything is generated procedurally from js/data.js. Static geometry is merged per material per floor.
import { mergeGeometries, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import {
  LEVELS, SLAB, STREET_Y, CORNICE_Y, MANSARD_PITCH, LOT, FOOTPRINT, CORE, FLOORS,
  PARKING, RAMP, BALCONIES, ROOF
} from './data.js';

const ORDER = ['basement', 'ground', 'first', 'second'];
const LEVEL_Y = { basement: LEVELS.basement.y, ground: LEVELS.ground.y, first: LEVELS.first.y, second: LEVELS.second.y };
const TOP_Y = { basement: 0, ground: 3.0, first: 6.0, second: ROOF.y };
const ZF = 14.7;                       // street façade line
const TOWER = { x0: 0, x1: 2.9, z0: 14.2, top: 7.25, cap: 0.42, proj: 0.16, slit: [1.23, 1.58], slitY: [0.25, 5.55] };
const SLOPE_RUN = (ROOF.y - CORNICE_Y) / Math.tan(MANSARD_PITCH * Math.PI / 180); // ≈0.94 m
const DORMER_TOP = 8.78;
const OPEN_H = { door: [0, 2.1], entry: [0, 2.2], elevator: [0, 2.1], window: [0.9, 2.3], glassdoor: [0, 2.5], opening: [0, 2.3], slit: [0.2, 2.6], main: [0, 2.4], garage: [-1.2, 1.15] };
const RAMP_X = [10.45, 13.73];
const STAIR = { x0: CORE.stairs.x0, x1: CORE.stairs.x1, z0: CORE.stairs.z0, z1: CORE.stairs.z1, xMid: (CORE.stairs.x0 + CORE.stairs.x1) / 2, zLand: CORE.stairs.z0 + 1.15, zTurn: CORE.stairs.z1 - 1.10 };
const LIFTC = { x: 0.85, z: 8.0, w: 1.0, d: 1.4, doorX: 1.33, landX: 1.41 };

const NI = (g) => (g && g.index ? g.toNonIndexed() : g);
// deterministic random
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function pointInPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1];
    if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi + 1e-12) + xi)) inside = !inside;
  }
  return inside;
}
// ramp surface height at z (15 % with soft transitions)
function rampY(z) {
  const zs = 16.9, ys = RAMP.yTop - (RAMP.zTop - zs) * 0.04;
  if (z >= zs) return RAMP.yTop - (RAMP.zTop - z) * 0.04;
  return Math.max(RAMP.yBottom, ys - (zs - z) * RAMP.slope);
}

// ───────────────────────── procedural textures ─────────────────────────
function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function noiseFill(g, w, h, base, amp, n, r0 = 1, r1 = 3, rnd = Math.random) {
  g.fillStyle = base; g.fillRect(0, 0, w, h);
  for (let i = 0; i < n; i++) {
    const v = (rnd() - 0.5) * amp;
    g.fillStyle = v > 0 ? `rgba(255,255,255,${v})` : `rgba(0,0,0,${-v})`;
    const r = r0 + rnd() * (r1 - r0);
    g.fillRect(rnd() * w, rnd() * h, r, r);
  }
}
function blotches(g, w, h, n, rmax, alpha, rnd, dark = true) {
  for (let i = 0; i < n; i++) {
    const x = rnd() * w, y = rnd() * h, r = rmax * (0.3 + rnd() * 0.7);
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    const c = dark ? '0,0,0' : '255,255,255';
    gr.addColorStop(0, `rgba(${c},${alpha * rnd()})`); gr.addColorStop(1, `rgba(${c},0)`);
    g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
}

function createTextures(THREE, renderer) {
  const aniso = Math.min(8, (renderer && renderer.capabilities && renderer.capabilities.getMaxAnisotropy) ? renderer.capabilities.getMaxAnisotropy() : 4);
  const tex = (canvas, mw, mh, color = true) => {
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(1 / mw, 1 / mh);
    t.anisotropy = aniso;
    if (color) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };
  const T = {};
  const R = rng(1234);
  // tileable height field → tangent-space normal map (canvas)
  const normalFromHeight = (hf, w, h, strength) => {
    const c = makeCanvas(w, h), g = c.getContext('2d'), img = g.createImageData(w, h), d = img.data;
    const H = (x, y) => hf[((y + h) % h) * w + ((x + w) % w)];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * strength, dy = (H(x, y + 1) - H(x, y - 1)) * strength;
      const l = Math.hypot(dx, dy, 1), i = (y * w + x) * 4;
      d[i] = (-dx / l * 0.5 + 0.5) * 255; d[i + 1] = (dy / l * 0.5 + 0.5) * 255; d[i + 2] = (1 / l * 0.5 + 0.5) * 255; d[i + 3] = 255;
    }
    g.putImageData(img, 0, 0); return c;
  };
  // smooth tileable value noise (sum of octaves)
  const valueNoise = (w, h, cells, octaves, rnd) => {
    const out = new Float32Array(w * h);
    let amp = 1, total = 0;
    for (let o = 0; o < octaves; o++, cells *= 2, amp *= 0.5) {
      const grid = new Float32Array(cells * cells).map(() => rnd());
      const G = (i, j) => grid[((j % cells) + cells) % cells * cells + ((i % cells) + cells) % cells];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const fx = x / w * cells, fy = y / h * cells, i = Math.floor(fx), j = Math.floor(fy);
        let tx = fx - i, ty = fy - j; tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
        const v = G(i, j) * (1 - tx) * (1 - ty) + G(i + 1, j) * tx * (1 - ty) + G(i, j + 1) * (1 - tx) * ty + G(i + 1, j + 1) * tx * ty;
        out[y * w + x] += v * amp;
      }
      total += amp;
    }
    for (let i = 0; i < out.length; i++) out[i] /= total;
    return out;
  };
  // render / stucco (tile 2 m): colour + fine trowelled normal map
  { const c = makeCanvas(512, 512), g = c.getContext('2d');
    noiseFill(g, 512, 512, '#f0ece4', 0.05, 26000, 1, 2, R); blotches(g, 512, 512, 60, 120, 0.03, R);
    T.render = tex(c, 2, 2);
    const N = 256, hf = valueNoise(N, N, 16, 4, R);
    for (let i = 0; i < hf.length; i++) hf[i] += (R() - 0.5) * 0.18; // sand grain
    T.renderNormal = tex(normalFromHeight(hf, N, N, 1.6), 1, 1, false);
    T.plasterNormal = tex(normalFromHeight(hf, N, N, 0.5), 1.5, 1.5, false); }
  // interior plaster (subtle)
  { const c = makeCanvas(256, 256), g = c.getContext('2d'); noiseFill(g, 256, 256, '#f1ede6', 0.025, 6000, 1, 2, R); T.plaster = tex(c, 2, 2); }
  // zinc standing seam (seam every 0.5 m; tile 1 m across x 2 m down the slope)
  { const W = 256, Hh = 512, c = makeCanvas(W, Hh), g = c.getContext('2d');
    g.fillStyle = '#3f4144'; g.fillRect(0, 0, W, Hh);
    // pre-patinated zinc: soft mottling + faint vertical streaks
    blotches(g, W, Hh, 40, 70, 0.08, R, false); blotches(g, W, Hh, 40, 70, 0.1, R);
    for (let i = 0; i < 6000; i++) { const v = (R() - 0.5) * 0.05; g.fillStyle = v > 0 ? `rgba(255,255,255,${v})` : `rgba(0,0,0,${-v})`; g.fillRect(R() * W, R() * Hh, 1, 6 + R() * 20); }
    for (const x of [0, 128]) { g.fillStyle = '#606368'; g.fillRect(x, 0, 3, Hh); g.fillStyle = '#7a7d82'; g.fillRect(x + 3, 0, 2, Hh); g.fillStyle = '#2a2b2e'; g.fillRect(x + 5, 0, 4, Hh); }
    T.zinc = tex(c, 1, 2);
    // height: raised seam ridge (≈25 mm) + very subtle pan waviness (oil-canning)
    const NW = 256, NH = 256, hf = valueNoise(NW, NH, 4, 2, R), hz = new Float32Array(NW * NH);
    for (let y = 0; y < NH; y++) for (let x = 0; x < NW; x++) {
      const u = (x % 128) / 128; // position within a pan (0.5 m)
      const d = Math.min(u, 1 - u) * 128; // px from seam
      const seam = d < 4 ? 1 - d / 4 : 0;
      const pan = Math.sin(u * Math.PI) * (hf[y * NW + x] - 0.5) * 0.35;
      hz[y * NW + x] = seam * 3.2 + pan;
    }
    T.zincNormal = tex(normalFromHeight(hz, NW, NH, 2.2), 1, 2, false); }
  // brick: long format 29 x 5 cm, 1 cm recessed joints (tile 1.2 m x 0.6 m)
  { const W = 1024, H = 512, c = makeCanvas(W, H), g = c.getContext('2d');
    const NW = 512, NH = 256, hb = new Float32Array(NW * NH);
    g.fillStyle = '#8f857c'; g.fillRect(0, 0, W, H);
    for (let i = 0; i < 20000; i++) { g.fillStyle = `rgba(${R() > 0.5 ? '255,255,255' : '0,0,0'},${R() * 0.12})`; g.fillRect(R() * W, R() * H, 1, 1); }
    const ppm = W / 1.2, bw = 0.29 * ppm, j = 0.01 * ppm;
    const rows = 10, rh = H / rows;
    const hn = valueNoise(NW, NH, 32, 2, R);
    for (let r = 0; r < rows; r++) {
      const y = r * rh, off = (r % 2) * (bw + j) / 2;
      for (let x = -off; x < W; x += bw + j) {
        const hue = 9 + R() * 12, sat = 36 + R() * 20, lit = 28 + R() * 13;
        g.fillStyle = `hsl(${hue},${sat}%,${lit}%)`;
        g.fillRect(x, y, bw, rh - j);
        // fired-clay speckle + darker ends
        for (let k = 0; k < 18; k++) { g.fillStyle = `rgba(0,0,0,${R() * 0.14})`; g.fillRect(x + R() * bw, y + R() * (rh - j), 1 + R() * 5, 1 + R() * 2); }
        const eg = g.createLinearGradient(x, 0, x + bw, 0); eg.addColorStop(0, 'rgba(0,0,0,0.12)'); eg.addColorStop(0.15, 'rgba(0,0,0,0)'); eg.addColorStop(0.85, 'rgba(0,0,0,0)'); eg.addColorStop(1, 'rgba(0,0,0,0.12)');
        g.fillStyle = eg; g.fillRect(x, y, bw, rh - j);
        // height: brick face raised, softly rounded arrises
        const x0 = Math.floor(x / 2), x1 = Math.floor((x + bw) / 2), y0 = Math.floor(y / 2), y1 = Math.floor((y + rh - j) / 2);
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
          const ex = Math.min(xx - x0, x1 - 1 - xx), ey = Math.min(yy - y0, y1 - 1 - yy), e = Math.min(ex, ey);
          const px = ((xx % NW) + NW) % NW;
          hb[yy * NW + px] = Math.min(1, 0.45 + e * 0.35) + (hn[yy * NW + px] - 0.5) * 0.25;
        }
      }
    }
    // mortar shadowing (slightly darker in the upper joint)
    g.fillStyle = 'rgba(0,0,0,0.18)';
    for (let r = 0; r < rows; r++) g.fillRect(0, r * rh + rh - j, W, 1.5);
    T.brick = tex(c, 1.2, 0.6); T.brickNormal = tex(normalFromHeight(hb, NW, NH, 2.4), 1.2, 0.6, false); }
  // lobby stone: 120 x 60 large format, warm limestone
  { const c = makeCanvas(1024, 1024), g = c.getContext('2d');
    noiseFill(g, 1024, 1024, '#d8d0c3', 0.05, 30000, 1, 2, R); blotches(g, 1024, 1024, 80, 140, 0.05, R); blotches(g, 1024, 1024, 40, 90, 0.08, R, false);
    g.strokeStyle = 'rgba(120,108,92,0.22)'; g.lineWidth = 1;
    for (let i = 0; i < 26; i++) { g.beginPath(); let x = R() * 1024, y = R() * 1024; g.moveTo(x, y); for (let k = 0; k < 8; k++) { x += (R() - 0.3) * 90; y += (R() - 0.5) * 60; g.lineTo(x, y); } g.stroke(); }
    g.fillStyle = 'rgba(90,80,70,0.55)';
    for (let i = 0; i <= 2; i++) g.fillRect(0, i * 512 - 1, 1024, 2);
    for (let r = 0; r < 4; r++) for (let i = 0; i <= 2; i++) g.fillRect(i * 512 + (r % 2) * 256 - 1, r * 256, 2, 256);
    // (tile image covers 2.4 m x 2.4 m: 4 rows of 0.6, 2 cols of 1.2)
    g.fillStyle = '#d8d0c3';
    T.stone = tex(c, 2.4, 2.4); }
  // stair / sill stone (fine grain)
  { const c = makeCanvas(256, 256), g = c.getContext('2d'); noiseFill(g, 256, 256, '#cfc7ba', 0.08, 9000, 1, 2, R); T.stoneFine = tex(c, 1, 1); }
  // oak timber (soffits, slats) — grain along v
  const timber = (base, dark, seed, mw) => {
    const r = rng(seed), c = makeCanvas(256, 1024), g = c.getContext('2d');
    g.fillStyle = base; g.fillRect(0, 0, 256, 1024);
    for (let i = 0; i < 220; i++) { const x = r() * 256, w = 0.5 + r() * 2.5; g.fillStyle = `rgba(${dark},${0.05 + r() * 0.18})`; g.fillRect(x, 0, w, 1024); }
    for (let i = 0; i < 16; i++) { const y = r() * 1024; const gr = g.createLinearGradient(0, y, 0, y + 80); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(0.5, `rgba(${dark},0.08)`); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, y, 256, 80); }
    return tex(c, mw, mw * 2);
  };
  T.oak = timber('#b98a5a', '70,40,20', 7, 0.6);
  T.walnut = timber('#6b4630', '30,16,8', 9, 0.6);
  T.teak = timber('#9c6b43', '50,28,12', 11, 0.9);
  // basement concrete
  { const c = makeCanvas(512, 512), g = c.getContext('2d'); noiseFill(g, 512, 512, '#b9b6b0', 0.07, 20000, 1, 3, R); blotches(g, 512, 512, 50, 100, 0.06, R); T.concrete = tex(c, 3, 3); }
  // roof gravel
  { const c = makeCanvas(256, 256), g = c.getContext('2d'); noiseFill(g, 256, 256, '#a9a59e', 0.35, 14000, 1, 3, R); T.gravel = tex(c, 1, 1); }
  // lawn
  { const c = makeCanvas(512, 512), g = c.getContext('2d'); noiseFill(g, 512, 512, '#5b7a37', 0.25, 50000, 1, 3, R); blotches(g, 512, 512, 60, 90, 0.12, R); T.lawn = tex(c, 3, 3); }
  // soil / mulch
  { const c = makeCanvas(256, 256), g = c.getContext('2d'); noiseFill(g, 256, 256, '#4a3b2f', 0.35, 12000, 1, 3, R); T.soil = tex(c, 1, 1); }
  // paving (grey stone slabs 60x40)
  { const c = makeCanvas(512, 512), g = c.getContext('2d'); noiseFill(g, 512, 512, '#a7a39c', 0.08, 16000, 1, 2, R);
    for (let r = 0; r < 6; r++) for (let k = 0; k < 4; k++) { g.fillStyle = `rgba(${R() > 0.5 ? '255,255,255' : '0,0,0'},${R() * 0.06})`; g.fillRect(k * 128 + (r % 2) * 64, r * 85, 128, 85); }
    g.fillStyle = 'rgba(60,58,54,0.45)'; for (let r = 0; r <= 6; r++) g.fillRect(0, r * 85.33 - 1, 512, 2);
    for (let r = 0; r < 6; r++) for (let k = 0; k <= 4; k++) g.fillRect(k * 128 + (r % 2) * 64 - 1, r * 85.33, 2, 85.33);
    T.paving = tex(c, 2.4, 2.4); }
  // PV cells
  { const c = makeCanvas(256, 384), g = c.getContext('2d'); g.fillStyle = '#1b2440'; g.fillRect(0, 0, 256, 384);
    for (let i = 0; i < 6; i++) for (let k = 0; k < 10; k++) { g.fillStyle = `rgb(${28 + R() * 6},${40 + R() * 6},${78 + R() * 10})`; g.fillRect(4 + i * 41.5, 4 + k * 37.8, 38, 34.5); }
    g.fillStyle = '#b8bcc2'; g.fillRect(0, 0, 256, 3); g.fillRect(0, 381, 256, 3); g.fillRect(0, 0, 3, 384); g.fillRect(253, 0, 3, 384);
    T.pv = new THREE.CanvasTexture(c); T.pv.colorSpace = THREE.SRGBColorSpace; T.pv.anisotropy = aniso; }
  // garage door: horizontal panels (tile 3 m x 2.4 m)
  { const c = makeCanvas(512, 512), g = c.getContext('2d'); noiseFill(g, 512, 512, '#2c2f33', 0.04, 8000, 1, 2, R);
    for (let i = 1; i < 5; i++) { g.fillStyle = '#16181b'; g.fillRect(0, i * 102.4 - 2, 512, 3); g.fillStyle = '#3a3e43'; g.fillRect(0, i * 102.4 + 1, 512, 1); }
    T.garage = tex(c, 3.0, 2.35); }
  // hazard stripes (yellow/black, 45°; tile 0.4 m)
  { const c = makeCanvas(128, 128), g = c.getContext('2d'); g.fillStyle = '#e6b520'; g.fillRect(0, 0, 128, 128); g.fillStyle = '#17181a';
    for (let i = -2; i < 4; i++) { g.beginPath(); g.moveTo(i * 64, 128); g.lineTo(i * 64 + 32, 128); g.lineTo(i * 64 + 160, 0); g.lineTo(i * 64 + 128, 0); g.closePath(); g.fill(); }
    T.hazard = tex(c, 0.4, 0.4); }
  return T;
}

// ───────────────────────── materials ─────────────────────────
function createMaterials(THREE, T) {
  const S = (o) => new THREE.MeshStandardMaterial(o);
  const M = {
    render: S({ name: 'render', color: 0xffffff, map: T.render, normalMap: T.renderNormal, normalScale: new THREE.Vector2(0.55, 0.55), roughness: 0.9 }),
    wall: S({ name: 'wall', color: 0xfbf8f3, map: T.plaster, normalMap: T.plasterNormal, normalScale: new THREE.Vector2(0.25, 0.25), roughness: 0.93 }),
    ceiling: S({ name: 'ceiling', color: 0xfaf8f4, map: T.plaster, roughness: 0.97 }),
    zinc: S({ name: 'zinc', color: 0x9a9ca0, map: T.zinc, normalMap: T.zincNormal, normalScale: new THREE.Vector2(0.9, 0.9), metalness: 0.45, roughness: 0.42, envMapIntensity: 0.8 }),
    zincTrim: S({ name: 'zincTrim', color: 0x34363a, metalness: 0.6, roughness: 0.42 }),
    brick: S({ name: 'brick', color: 0xffffff, map: T.brick, normalMap: T.brickNormal, normalScale: new THREE.Vector2(1.1, 1.1), roughness: 0.86 }),
    capGrey: S({ name: 'capGrey', color: 0x7b7c7a, map: T.plaster, roughness: 0.85 }),
    frame: S({ name: 'frame', color: 0x2a2c2f, metalness: 0.55, roughness: 0.38 }),
    glass: new THREE.MeshPhysicalMaterial({ name: 'glass', color: 0x6f7f86, metalness: 0, roughness: 0.02, ior: 1.52, specularIntensity: 1, transparent: true, opacity: 0.34, envMapIntensity: 1.8, depthWrite: false }),
    railGlass: new THREE.MeshPhysicalMaterial({ name: 'railGlass', color: 0x9bb9b1, metalness: 0, roughness: 0.02, ior: 1.52, specularIntensity: 1, transparent: true, opacity: 0.2, envMapIntensity: 1.5, depthWrite: false, side: THREE.DoubleSide }),
    glassEdge: new THREE.MeshPhysicalMaterial({ name: 'glassEdge', color: 0x5f8f80, metalness: 0, roughness: 0.05, ior: 1.52, transparent: true, opacity: 0.75, envMapIntensity: 1.2 }),
    frosted: S({ name: 'frosted', color: 0xe8eeee, transparent: true, opacity: 0.72, roughness: 0.6 }),
    stoneFine: S({ name: 'stoneFine', color: 0xffffff, map: T.stoneFine, roughness: 0.62 }),
    stone: S({ name: 'stone', color: 0xffffff, map: T.stone, roughness: 0.28, metalness: 0.02 }),
    baseFloor: S({ name: 'baseFloor', color: 0xd9cfbf, map: T.plaster, roughness: 0.75 }),
    oak: S({ name: 'oak', color: 0xffffff, map: T.oak, roughness: 0.62 }),
    walnut: S({ name: 'walnut', color: 0xffffff, map: T.walnut, roughness: 0.45 }),
    teak: S({ name: 'teak', color: 0xffffff, map: T.teak, roughness: 0.7 }),
    lacquer: S({ name: 'lacquer', color: 0xf6f5f1, roughness: 0.3 }),
    brass: S({ name: 'brass', color: 0xc39a55, metalness: 1, roughness: 0.3 }),
    steel: S({ name: 'steel', color: 0xcfd3d6, metalness: 1, roughness: 0.28 }),
    darkSteel: S({ name: 'darkSteel', color: 0x2b2b2d, metalness: 0.7, roughness: 0.45 }),
    concrete: S({ name: 'concrete', color: 0xffffff, map: T.concrete, roughness: 0.85 }),
    bCeil: S({ name: 'bCeil', color: 0xf4f2ee, map: T.plaster, roughness: 0.95 }),
    epoxy: S({ name: 'epoxy', color: 0x8d8f91, map: T.concrete, roughness: 0.4 }),
    bWall: S({ name: 'bWall', color: 0xe9e6e0, map: T.concrete, roughness: 0.9 }),
    skirting: S({ name: 'skirting', color: 0xeeebe5, roughness: 0.5 }),
    gravel: S({ name: 'gravel', color: 0xffffff, map: T.gravel, roughness: 1 }),
    lawn: S({ name: 'lawn', color: 0xffffff, map: T.lawn, roughness: 1 }),
    soil: S({ name: 'soil', color: 0xffffff, map: T.soil, roughness: 1 }),
    paving: S({ name: 'paving', color: 0xffffff, map: T.paving, roughness: 0.82 }),
    garage: S({ name: 'garage', color: 0xffffff, map: T.garage, metalness: 0.35, roughness: 0.5 }),
    pv: S({ name: 'pv', color: 0xffffff, map: T.pv, metalness: 0.3, roughness: 0.18 }),
    leaf: S({ name: 'leaf', color: 0x4b5e34, roughness: 0.85, flatShading: true }),
    oliveLight: S({ name: 'oliveLight', color: 0x8e9a74, roughness: 0.75, flatShading: true }),
    grassDry: S({ name: 'grassDry', color: 0xb9ad7e, roughness: 0.9, side: THREE.DoubleSide }),
    pebble: S({ name: 'pebble', color: 0xd9d4ca, roughness: 0.7 }),
    ledWarm: S({ name: 'ledWarm', color: 0xfff1dc, emissive: 0xffc98a, emissiveIntensity: 5, roughness: 0.5 }),
    olive: S({ name: 'olive', color: 0x5f6d45, roughness: 0.8, flatShading: true }),
    grass: S({ name: 'grass', color: 0x98a06a, roughness: 0.9, side: THREE.DoubleSide }),
    ivy: S({ name: 'ivy', color: 0x34502a, roughness: 0.8, side: THREE.DoubleSide, flatShading: true }),
    trunk: S({ name: 'trunk', color: 0x6d5f50, roughness: 0.95 }),
    planterDark: S({ name: 'planterDark', color: 0x3a3b3d, roughness: 0.7 }),
    downlight: S({ name: 'downlight', color: 0xfff3dd, emissive: 0xffdcaa, emissiveIntensity: 14, roughness: 0.4 }),
    ledPanel: S({ name: 'ledPanel', color: 0xf8fbff, emissive: 0xfff4e6, emissiveIntensity: 6, roughness: 0.4 }),
    logo: S({ name: 'logo', color: 0xfff1d8, emissive: 0xffd49a, emissiveIntensity: 6, roughness: 0.5 }),
    mirror: S({ name: 'mirror', color: 0xe8eef2, metalness: 1, roughness: 0.02 }),
    black: S({ name: 'black', color: 0x121212, roughness: 0.5 }),
    tyre: S({ name: 'tyre', color: 0x1a1a1a, roughness: 0.85 }),
    carGlass: S({ name: 'carGlass', color: 0x1b2127, metalness: 0.6, roughness: 0.08 }),
    carPaint: new THREE.MeshPhysicalMaterial({ name: 'carPaint', color: 0xffffff, vertexColors: true, metalness: 0.55, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.08 }),
    tailLight: S({ name: 'tailLight', color: 0x7a1010, emissive: 0x5a0808, emissiveIntensity: 0.6, roughness: 0.3 }),
    headLight: S({ name: 'headLight', color: 0xf2f2ee, emissive: 0x404040, roughness: 0.2, metalness: 0.4 }),
    bronze: S({ name: 'bronze', color: 0x4a3a2a, metalness: 0.85, roughness: 0.36 }),
    slatW: S({ name: 'slatW', color: 0xffffff, map: T.oak, roughness: 0.55 }),
    kerb: S({ name: 'kerb', color: 0xc9c6bf, map: T.concrete, roughness: 0.8 }),
    pipeRed: S({ name: 'pipeRed', color: 0xb3261e, roughness: 0.42, metalness: 0.1 }),
    galv: S({ name: 'galv', color: 0xb9bcbf, metalness: 0.85, roughness: 0.5 }),
    yellow: S({ name: 'yellow', color: 0xe2b21c, roughness: 0.6 }),
    hazard: S({ name: 'hazard', color: 0xffffff, map: T.hazard, roughness: 0.6 }),
    ledGreen: S({ name: 'ledGreen', color: 0x9dffb0, emissive: 0x2cff6a, emissiveIntensity: 3, roughness: 0.4 }),
    ledRedOff: S({ name: 'ledRedOff', color: 0x5a1210, roughness: 0.35 }),
    evWhite: S({ name: 'evWhite', color: 0xf1f1ef, roughness: 0.32 }),
    leather: S({ name: 'leather', color: 0x9a6b45, roughness: 0.6 }),
    alloy: S({ name: 'alloy', color: 0xc9cdd1, metalness: 1, roughness: 0.28 }),
    carTrim: S({ name: 'carTrim', color: 0x15161a, roughness: 0.62 }),
    carPlate: S({ name: 'carPlate', color: 0xf3f3ee, roughness: 0.5 }),
    white: S({ name: 'white', color: 0xf2f2f0, roughness: 0.6 }),
    rubber: S({ name: 'rubber', color: 0x2f3134, roughness: 0.9 })
  };
  for (const k of Object.keys(M)) { const sp = PBR[k]; M[k].userData.internal = k; M[k].userData.baseRough = M[k].roughness; if (sp) M[k].name = sp.name; }
  return M;
}

// internal material → CONTRACT3 vocabulary name (+ manifest texture key, tint and tweaks once the real CC0 maps are in)
const PBR = {
  render:     { name: 'render-white', key: 'render-white', color: 0xffffff, ns: 0.8 },
  wall:       { name: 'plaster-white', key: 'plaster-white', color: 0xfbf7f0, ns: 0.5, maps: ['albedo', 'normal'] },
  ceiling:    { name: 'ceiling-white', key: 'ceiling-white', color: 0xfbf9f5, ns: 0.4, maps: ['albedo', 'normal'] },
  bCeil:      { name: 'ceiling-white:basement', color: 0xf2f0ec, ns: 0.4 },
  bWall:      { name: 'plaster-white:basement', key: 'render-white', color: 0xeeebe5, ns: 0.6 },
  zinc:       { name: 'zinc-standing-seam', key: 'zinc-standing-seam', color: 0xffffff, ns: 0.6, env: 0.9 },
  zincTrim:   { name: 'zinc-standing-seam:trim', color: 0xcfcfcf, ns: 0.6 },
  brick:      { name: 'brick-facade', key: 'brick-facade', color: 0xb8998b, ns: 1.2 },
  capGrey:    { name: 'concrete:cap', color: 0x9a9a97 },
  frame:      { name: 'aluminium-frame', color: 0xffffff },
  glass:      { name: 'glass-window' }, railGlass: { name: 'glass-railing' }, glassEdge: { name: 'glass-railing:edge' }, frosted: { name: 'glass-railing:frosted' },
  stoneFine:  { name: 'stone-coping', key: 'stone-coping', color: 0xf1ede6 },
  stone:      { name: 'lobby-floor-stone', key: 'lobby-floor-stone', color: 0xffffff, roughMul: 0.75 },
  baseFloor:  { name: 'concrete:screed', color: 0xe3d9c9 },
  oak:        { name: 'timber-soffit', key: 'timber-soffit', color: 0xffffff, rot: true },
  walnut:     { name: 'door-walnut', key: 'door-walnut', color: 0xffffff, rot: true, bright: 1.6 },
  teak:       { name: 'deck-teak', key: 'deck-teak', color: 0xd9b58c },
  lacquer:    { name: 'door-interior', style: 'atlantic', color: 0xf7f6f2 },
  brass:      { name: 'brass' },
  steel:      { name: 'handrail-steel' },
  darkSteel:  { name: 'steel-dark' },
  concrete:   { name: 'concrete', key: 'concrete' },
  epoxy:      { name: 'concrete:epoxy', key: 'concrete', color: 0x9a9c9e, roughMul: 0.55 },
  skirting:   { name: 'skirting', color: 0xf1eee8 },
  gravel:     { name: 'gravel', key: 'gravel' }, lawn: { name: 'lawn', key: 'lawn' }, soil: { name: 'soil' },
  pebble:     { name: 'gravel:pebble', color: 0xf2efe8 },
  paving:     { name: 'paving-calcada', key: 'paving-calcada' },
  garage:     { name: 'garage-door' },
  trunk:      { name: 'bark' },
  planterDark:{ name: 'planter-concrete:dark', color: 0x6a6b6c },
  leaf: { name: 'foliage:leaf' }, olive: { name: 'foliage:olive' }, oliveLight: { name: 'foliage:olive-light' }, grass: { name: 'foliage:grass' }, grassDry: { name: 'foliage:grass-dry' }, ivy: { name: 'foliage:ivy' },
  ledWarm: { name: 'led-strip-emissive' }, ledPanel: { name: 'led-strip-emissive:panel' }, logo: { name: 'led-strip-emissive:logo' }, downlight: { name: 'downlight-emissive' },
  mirror: { name: 'mirror' }, pv: { name: 'pv-panel' }, white: { name: 'paint-white' }, black: { name: 'plastic-black' },
  bronze: { name: 'aluminium-frame:bronze' }, slatW: { name: 'lobby-wall-walnut-slats', key: 'lobby-wall-walnut-slats', color: 0xffffff, rot: true, bright: 2.6 }, kerb: { name: 'kerb-stone', key: 'kerb-stone' },
  pipeRed: { name: 'paint-red' }, galv: { name: 'steel-galvanised' }, yellow: { name: 'paint-yellow' }, hazard: { name: 'paint-hazard' }, ledGreen: { name: 'led-strip-emissive:green' }, ledRedOff: { name: 'plastic-red' },
  evWhite: { name: 'plastic-white' }, leather: { name: 'leather' }, alloy: { name: 'car-rim' }, carTrim: { name: 'car-trim' }, carPlate: { name: 'car-plate' },
  tyre: { name: 'car-tyre' }, carGlass: { name: 'car-glass' }, carPaint: { name: 'car-paint' }, tailLight: { name: 'car-taillight' }, headLight: { name: 'car-headlight' }, rubber: { name: 'rubber' }
};

// Real CC0 PBR maps (assets/manifest.json). Async and non-blocking: the procedural canvas maps stay until a full set has loaded,
// and stay for good if anything fails (e.g. inside a sandboxed artifact where assets/ is not reachable).
function loadPBR(THREE, M, renderer, onDone) {
  let base;
  try { base = new URL('../', import.meta.url); if (!/^https?:$/.test(base.protocol)) return false; } catch (e) { return false; }
  const aniso = Math.min(8, (renderer && renderer.capabilities && renderer.capabilities.getMaxAnisotropy) ? renderer.capabilities.getMaxAnisotropy() : 4);
  let lowMem = false;
  try { lowMem = (typeof matchMedia === 'function' && matchMedia('(max-width: 820px)').matches) || (navigator.deviceMemory && navigator.deviceMemory <= 4); } catch (e) { /* ignore */ }
  const shrink = (t) => { // phones: 512 px maps
    if (!lowMem || !t.image || t.image.width <= 512) return t;
    try { const c = makeCanvas(512, 512); c.getContext('2d').drawImage(t.image, 0, 0, 512, 512); const n = new THREE.CanvasTexture(c); t.dispose(); return n; } catch (e) { return t; }
  };
  const loader = new THREE.TextureLoader();
  const cache = new Map();
  const img = (path) => { if (!cache.has(path)) cache.set(path, new Promise((res, rej) => loader.load(new URL(path, base).href, (t) => res(shrink(t)), undefined, rej))); return cache.get(path); };
  fetch(new URL('assets/manifest.json', base)).then(r => r.ok ? r.json() : Promise.reject(new Error('manifest ' + r.status))).then((man) => {
    const jobs = [];
    for (const k of Object.keys(PBR)) {
      const sp = PBR[k], mat = M[k]; if (!sp.key || !mat) continue;
      const ent = man.textures && man.textures[sp.key]; const set = ent && (ent.default || ent[sp.style || 'atlantic']);
      if (!set || set.procedural || !set.maps || !set.maps.albedo) continue;
      const names = (sp.maps || (lowMem ? ['albedo', 'normal'] : ['albedo', 'normal', 'roughness'])).filter(n => set.maps[n]);
      jobs.push(Promise.all(names.map(n => img(set.maps[n]))).then((texs) => {
        const size = set.sizeMeters || [1, 1];
        const mk = (i, srgb) => { const t = texs[i].clone(); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(1 / size[0], 1 / size[1]); if (sp.rot) { t.rotation = Math.PI / 2; } t.anisotropy = aniso; t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.needsUpdate = true; return t; };
        const get = (n, srgb) => { const i = names.indexOf(n); return i < 0 ? null : mk(i, srgb); };
        mat.map = get('albedo', true);
        mat.normalMap = get('normal', false); mat.bumpMap = null;
        if (mat.normalMap) { mat.normalMapType = THREE.TangentSpaceNormalMap; const s = sp.ns != null ? sp.ns : 1; mat.normalScale = new THREE.Vector2(s, s); }
        mat.roughnessMap = get('roughness', false); if (mat.roughnessMap) mat.roughness = sp.roughMul != null ? sp.roughMul : 1;
        mat.aoMap = get('ao', false); if (mat.aoMap) mat.aoMapIntensity = 0.8;
        mat.metalnessMap = get('metal', false); if (mat.metalnessMap) mat.metalness = 1;
        const c = new THREE.Color(sp.color != null ? sp.color : 0xffffff); if (sp.bright) c.multiplyScalar(sp.bright); mat.color.copy(c);
        if (sp.env != null) mat.envMapIntensity = sp.env;
        mat.userData.pbr = set.id; mat.needsUpdate = true;
      }).catch(() => { /* keep the procedural look for this material */ }));
    }
    return Promise.all(jobs);
  }).then(() => { if (onDone) onDone(); }).catch(() => { if (onDone) onDone(); /* procedural fallback */ });
  return true;
}

// ───────────────────────── geometry batcher ─────────────────────────
const TAGGED = new Set(['glass']);
function createBatcher(THREE) {
  const buckets = new Map(); // `${gid}|${mat}` → { gid, mat, list }
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), s = new THREE.Vector3();
  const boxCache = new Map();
  function unitBox() { if (!boxCache.has('u')) boxCache.set('u', NI(new THREE.BoxGeometry(1, 1, 1))); return boxCache.get('u'); }
  let curTag = null; // when set, geometry goes to its own mesh carrying userData.opening
  function withTag(tag, fn) { const prev = curTag; curTag = tag; try { return fn(); } finally { curTag = prev; } }
  function push(gid, mat, geo) {
    const k = gid + '|' + mat;
    let b = buckets.get(k); if (!b) { b = { gid, mat, list: [] }; buckets.set(k, b); }
    if (curTag && TAGGED.has(mat)) geo.userData = { ...geo.userData, tag: curTag };   // (clone() shares userData by reference)
    b.list.push(geo);
  }
  // box by centre + size + optional rotations (ry about y, then rx about local x)
  function box(gid, mat, cx, cy, cz, sx, sy, sz, ry = 0, rx = 0, rz = 0) {
    if (sx <= 1e-4 || sy <= 1e-4 || sz <= 1e-4) return null;
    const g = unitBox().clone();
    e.set(rx, ry, rz, 'YXZ'); q.setFromEuler(e);
    m4.compose(v.set(cx, cy, cz), q, s.set(sx, sy, sz));
    g.applyMatrix4(m4); push(gid, mat, g); return g;
  }
  // bevelled box (softened arrises catch the light like real render/stone)
  function rboxAB(gid, mat, x0, y0, z0, x1, y1, z1, r = 0.02) {
    const sx = Math.abs(x1 - x0), sy = Math.abs(y1 - y0), sz = Math.abs(z1 - z0);
    if (sx < 1e-3 || sy < 1e-3 || sz < 1e-3) return null;
    const rr = Math.min(r, sx / 2 - 1e-4, sy / 2 - 1e-4, sz / 2 - 1e-4);
    if (rr < 0.004) return boxAB(gid, mat, x0, y0, z0, x1, y1, z1);
    const g = NI(new RoundedBoxGeometry(sx, sy, sz, 2, rr));
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2); push(gid, mat, g); return g;
  }
  function boxAB(gid, mat, x0, y0, z0, x1, y1, z1) {
    return box(gid, mat, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0));
  }
  // box aligned to the wall a→b spanning s0..s1 along it, n0..n1 across (left normal), y0..y1
  function boxAlong(gid, mat, a, b, s0, s1, y0, y1, n0, n1) {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]); const ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L;
    const nx = -uz, nz = ux; const sm = (s0 + s1) / 2, nm = (n0 + n1) / 2;
    return box(gid, mat, a[0] + ux * sm + nx * nm, (y0 + y1) / 2, a[1] + uz * sm + nz * nm, s1 - s0, y1 - y0, n1 - n0, Math.atan2(-uz, ux));
  }
  function geo(gid, mat, g, matrix) { let gg = NI(g).clone(); if (matrix) gg.applyMatrix4(matrix); push(gid, mat, gg); return gg; }
  // horizontal polygon slab (pts [[x,z]...]), holes [[[x,z]...]], from y0 to y1
  function slab(gid, mat, pts, y0, y1, holes = []) {
    const sh = new THREE.Shape(pts.map(p => new THREE.Vector2(p[0], -p[1])));
    for (const h of holes) sh.holes.push(new THREE.Path(h.map(p => new THREE.Vector2(p[0], -p[1]))));
    const g = new THREE.ExtrudeGeometry(sh, { depth: y1 - y0, bevelEnabled: false, curveSegments: 1 });
    g.rotateX(-Math.PI / 2); g.translate(0, y0, 0);
    push(gid, mat, NI(g)); return g;
  }
  // polygon in the (z,y) plane extruded along x from x0 to x1
  function prismX(gid, mat, zy, x0, x1) {
    const sh = new THREE.Shape(zy.map(p => new THREE.Vector2(p[0], p[1])));
    const g = new THREE.ExtrudeGeometry(sh, { depth: x1 - x0, bevelEnabled: false, curveSegments: 1 });
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) { const lx = pos.getX(i), ly = pos.getY(i), lz = pos.getZ(i); pos.setXYZ(i, x1 - lz, ly, lx); }
    g.computeVertexNormals();
    push(gid, mat, NI(g)); return g;
  }
  // polygon in (x,y) plane extruded along z from z0 to z1
  function prismZ(gid, mat, xy, z0, z1) {
    const sh = new THREE.Shape(xy.map(p => new THREE.Vector2(p[0], p[1])));
    const g = new THREE.ExtrudeGeometry(sh, { depth: z1 - z0, bevelEnabled: false, curveSegments: 1 });
    g.translate(0, 0, z0);
    push(gid, mat, NI(g)); return g;
  }
  function cyl(gid, mat, p0, p1, r, seg = 10, r1) {
    const a = new THREE.Vector3(...p0), b = new THREE.Vector3(...p1); const L = a.distanceTo(b); if (L < 1e-4) return null;
    const g = NI(new THREE.CylinderGeometry(r1 != null ? r1 : r, r, L, seg, 1));
    const dir = b.clone().sub(a).normalize(); q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    m4.compose(a.clone().add(b).multiplyScalar(0.5), q, s.set(1, 1, 1)); g.applyMatrix4(m4); push(gid, mat, g); return g;
  }
  // world-space planar UVs (metres) so every textured material tiles consistently
  function worldUV(g) {
    const p = g.attributes.position, n = g.attributes.normal; if (!n) g.computeVertexNormals();
    const nn = g.attributes.normal; const uv = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i += 3) {
      // per-face projection chosen from the face normal (avoids stretched seams)
      let ax = 0, ay = 0, az = 0;
      for (let k = 0; k < 3 && i + k < p.count; k++) { ax += Math.abs(nn.getX(i + k)); ay += Math.abs(nn.getY(i + k)); az += Math.abs(nn.getZ(i + k)); }
      for (let k = 0; k < 3 && i + k < p.count; k++) {
        const x = p.getX(i + k), y = p.getY(i + k), z = p.getZ(i + k);
        let u, w;
        if (ay >= ax && ay >= az) { u = x; w = -z; } else if (ax >= az) { u = -z; w = y; } else { u = x; w = y; }
        uv[(i + k) * 2] = u; uv[(i + k) * 2 + 1] = w;
      }
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }
  function finalize(groups, M, opts = {}) {
    const meshes = [];
    for (const { gid, mat, list } of buckets.values()) {
      if (!list.length) continue;
      const parts = [], ranges = []; let tri = 0;
      for (const g of list) {
        let gg = NI(g);
        if (!gg.attributes.normal) gg.computeVertexNormals();
        if (!gg.userData.keepUV) worldUV(gg);
        for (const k of Object.keys(gg.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(k)) gg.deleteAttribute(k);
        gg.morphAttributes = {};
        const nt = gg.attributes.position.count / 3; if (gg.userData.tag) ranges.push({ a: tri, b: tri + nt, tag: gg.userData.tag }); tri += nt;
        parts.push(gg);
      }
      let merged = null;
      try { merged = mergeGeometries(parts, false); } catch (err) { merged = null; }
      if (!merged) { // fall back to separate meshes
        for (const g of parts) { const me = new THREE.Mesh(g, M[mat]); me.name = `${gid}-${mat}`; groups[gid].add(me); meshes.push(me); }
        continue;
      }
      merged.computeBoundingSphere(); merged.computeBoundingBox();
      const me = new THREE.Mesh(merged, M[mat]); me.name = `${gid}-${mat}`;
      if (ranges.length) { // one draw call for all the fixed glazing of a floor; a ray hit still resolves to its opening through a proxy object
        const prox = new Map();
        for (const r of ranges) { const key = `w${r.tag.wallIndex}o${r.tag.openingIndex}`; if (!prox.has(key)) { const p = new THREE.Object3D(); p.name = `opening-${r.tag.floorId}-${key}-${mat}`; p.userData.opening = { ...r.tag }; p.material = M[mat]; me.add(p); prox.set(key, p); } r.proxy = prox.get(key); }
        me.raycast = function (rc, hits) { const n0 = hits.length; THREE.Mesh.prototype.raycast.call(this, rc, hits); for (let i = n0; i < hits.length; i++) { const f = hits[i].faceIndex; for (let k = 0; k < ranges.length; k++) if (f >= ranges[k].a && f < ranges[k].b) { hits[i].object = ranges[k].proxy; break; } } };
      }
      const transparent = M[mat].transparent;
      me.castShadow = !transparent && !(opts.noCast || []).includes(mat);
      me.receiveShadow = !transparent;
      const det = opts.detail && groups[gid + '-det'] && !opts.envelope(gid, mat);
      groups[det ? gid + '-det' : gid].add(me); meshes.push(me);
      for (const g of parts) if (g !== merged) g.dispose();
    }
    buckets.clear();
    return meshes;
  }
  return { withTag, box, boxAB, rboxAB, boxAlong, geo, slab, prismX, prismZ, cyl, push, finalize, worldUV };
}

// ───────────────────────── plan helpers ─────────────────────────
const TAN = Math.tan(MANSARD_PITCH * Math.PI / 180);
const FP = FOOTPRINT;
const BASE_POLY = [[0, -7.9], [8.2, -7.9], [10.9, 1.9], [13.88, 1.9], [13.88, 14.7], [0, 14.7]];
// mansard edges: all footprint edges except the west party wall (x = 0)
const MANSARD_EDGES = FP.map((p, i) => [p, FP[(i + 1) % FP.length]]).filter(([p, q]) => !(p[0] === 0 && q[0] === 0));
function edgeInward(p, q) { // unit direction + inward normal (footprint is clockwise in x-right/z-down → inward = right normal)
  const L = Math.hypot(q[0] - p[0], q[1] - p[1]); const ux = (q[0] - p[0]) / L, uz = (q[1] - p[1]) / L;
  return { L, ux, uz, nx: -uz, nz: ux };
}
// inward distance to the nearest mansard edge (only if the foot of the perpendicular lies on the edge ±1 m)
function mansardInnerY(x, z) {
  let y = Infinity;
  for (const [p, q] of MANSARD_EDGES) {
    const e = edgeInward(p, q);
    const s = (x - p[0]) * e.ux + (z - p[1]) * e.uz; if (s < -1.2 || s > e.L + 1.2) continue;
    const d = (x - p[0]) * e.nx + (z - p[1]) * e.nz;
    if (d < -0.5) continue;
    y = Math.min(y, CORNICE_Y + Math.max(0, d - 0.15) * TAN);
  }
  return y;
}
// offset polygon: per-edge outward distances (negative = inward)
function offsetPoly(poly, dist) {
  const n = poly.length, lines = [];
  for (let i = 0; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n]; const e = edgeInward(p, q); const d = dist(i, p, q);
    lines.push({ px: p[0] - e.nx * d, pz: p[1] - e.nz * d, ux: e.ux, uz: e.uz });
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const A = lines[(i - 1 + n) % n], B = lines[i];
    const den = A.ux * B.uz - A.uz * B.ux;
    if (Math.abs(den) < 1e-9) { out.push([B.px, B.pz]); continue; }
    const t = ((B.px - A.px) * B.uz - (B.pz - A.pz) * B.ux) / den;
    out.push([A.px + A.ux * t, A.pz + A.uz * t]);
  }
  return out;
}
const isParty = (p, q) => p[0] === 0 && q[0] === 0;
const polyArea = (poly) => { let a = 0; for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p[0] * q[1] - q[0] * p[1]; } return Math.abs(a / 2); };
function roomAt(floor, x, z) { for (const r of floor.rooms) if (pointInPoly(x, z, r.poly)) return r; return null; }

function textCanvasTexture(THREE, text, { w = 256, h = 128, bg = '#b8913f', fg = '#2a2118', font = '600 64px Georgia, serif', border = null } = {}) {
  const c = makeCanvas(w, h), g = c.getContext('2d');
  if (bg) { g.fillStyle = bg; g.fillRect(0, 0, w, h); }
  if (border) { g.strokeStyle = border; g.lineWidth = 4; g.strokeRect(6, 6, w - 12, h - 12); }
  g.fillStyle = fg; g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, w / 2, h / 2 + 2);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}

// ═════════════════════════ main ═════════════════════════
export function buildBuilding(THREE, { scene, renderer } = {}) {
  const group = new THREE.Group(); group.name = 'building';
  const T = createTextures(THREE, renderer);
  const M = createMaterials(THREE, T);
  const B = createBatcher(THREE);
  const GIDS = ['site', 'basement', 'ground', 'ground-ceil', 'first', 'first-ceil', 'second', 'second-ceil', 'roofshell', 'roof'];
  const G = {};
  for (const id of GIDS) { G[id] = new THREE.Group(); G[id].name = 'building-' + id; group.add(G[id]); }
  // per floor: '-int' = fit-out (partitions, interior doors, furniture of the common areas, car-park contents), '-det' = small fittings
  // that only matter when you are on that floor. Both are children of the floor group, so 'building-<floor>' still holds the whole floor.
  for (const id of [...ORDER, 'site']) for (const sfx of id === 'site' ? ['-det'] : ['-int', '-det']) { const g = new THREE.Group(); g.name = 'building-' + id + sfx; G[id + sfx] = g; G[id].add(g); }
  for (const id of ORDER) { const g = new THREE.Group(); g.name = 'building-' + id + '-doors'; G[id + '-doors'] = g; G[id + '-int'].add(g); }   // interior door leaves (not needed from the street)
  const doors = [];
  const animators = [];
  const dyn = (o) => { o.userData.dyn = true; return o; };   // objects that move after the build (everything else gets frozen matrices)

  // ───────── tap-to-interact (CONTRACT4): smooth toggles driven from update(dt), no per-frame allocations ─────────
  const activeTweens = [];
  const interactables = [];
  const smooth = (t) => t * t * (3 - 2 * t);
  const L4 = (en, pt, he, ru) => ({ en, pt, he, ru });
  const LBL = {
    doorO: L4('Open door', 'Abrir porta', 'פתיחת דלת', 'Открыть дверь'), doorC: L4('Close door', 'Fechar porta', 'סגירת דלת', 'Закрыть дверь'),
    slideO: L4('Slide door open', 'Abrir porta de correr', 'פתיחת דלת הזזה', 'Открыть раздвижную дверь'), slideC: L4('Slide door closed', 'Fechar porta de correr', 'סגירת דלת הזזה', 'Закрыть раздвижную дверь'),
    winO: L4('Open window', 'Abrir janela', 'פתיחת חלון', 'Открыть окно'), winC: L4('Close window', 'Fechar janela', 'סגירת חלון', 'Закрыть окно'),
    garO: L4('Open garage door', 'Abrir portão da garagem', 'פתיחת שער החניון', 'Открыть ворота гаража'), garC: L4('Close garage door', 'Fechar portão da garagem', 'סגירת שער החניון', 'Закрыть ворота гаража'),
    call: L4('Call the lift', 'Chamar o elevador', 'הזמנת מעלית', 'Вызвать лифт'),
    mailO: L4('Open mailbox', 'Abrir caixa de correio', 'פתיחת תיבת דואר', 'Открыть почтовый ящик'), mailC: L4('Close mailbox', 'Fechar caixa de correio', 'סגירת תיבת דואר', 'Закрыть почтовый ящик'),
    bell: L4('Ring the intercom', 'Tocar ao intercomunicador', 'צלצול באינטרקום', 'Позвонить в домофон'),
    evO: L4('Start charging', 'Iniciar carregamento', 'התחלת טעינה', 'Начать зарядку'), evC: L4('Stop charging', 'Parar carregamento', 'עצירת טעינה', 'Остановить зарядку')
  };
  // obj.userData.interact = { id, kind, label, toggle(), isOn(), range, sound }; apply(t) receives the eased 0..1 state
  function mkToggle(obj, { id, kind, sound = 'click', range = 2.6, open, close, speed = 1.6, apply, initial = 0, auto = 0, ease = true }) {
    const st = { t: initial, target: initial, speed, apply, ease, active: false, skip: false, hold: 0, auto };
    const it = {
      id, kind, sound, range,
      get label() { return st.target > 0.5 ? (close || open) : open; },
      toggle() { st.target = st.target > 0.5 ? 0 : 1; st.skip = false; st.hold = 0; if (!st.active) { st.active = true; activeTweens.push(st); } },
      isOn() { return st.target > 0.5; },
      set(v) { st.t = st.target = v; st.skip = true; }   // state pushed from outside (e.g. walk.js auto-doors): stop our tween
    };
    it.state = st;
    if (obj) { obj.userData.interact = it; interactables.push(obj); }
    return it;
  }
  function stepTweens(dt) {
    for (let i = activeTweens.length - 1; i >= 0; i--) {
      const s = activeTweens[i];
      let done = s.skip;
      if (!done) {
        if (s.t < s.target) s.t = Math.min(s.target, s.t + dt * s.speed); else if (s.t > s.target) s.t = Math.max(s.target, s.t - dt * s.speed);
        s.apply(s.ease ? smooth(s.t) : s.t);
        if (s.t === s.target) {
          if (s.auto > 0 && s.target === 1) { s.hold += dt; if (s.hold >= s.auto) { s.hold = 0; s.target = 0; } }
          else done = true;
        }
      }
      if (done) { s.skip = false; s.active = false; activeTweens[i] = activeTweens[activeTweens.length - 1]; activeTweens.pop(); }
    }
  }
  // doors[] entries: setOpen(t) keeps working exactly as before; a tap animates through the same function
  function wireDoor(d) {
    if (d.kind === 'elevator' || !d.pivot) return;
    const raw = d.setOpen, gar = d.kind === 'garage', init = d.kind === 'door' ? 1 : 0;
    const it = mkToggle(d.pivot, { id: 'door-' + d.id, kind: gar ? 'garage' : 'door', sound: gar ? 'garage' : 'door', range: gar ? 6 : 3.5, open: gar ? LBL.garO : LBL.doorO, close: gar ? LBL.garC : LBL.doorC, speed: gar ? 0.3 : 1.4, apply: (t) => { raw(t); d.t = t; }, initial: init });
    d.t = init; d.interact = it;
    d.setOpen = (t) => { t = Math.max(0, Math.min(1, +t || 0)); it.set(t); d.t = t; raw(t); };
  }

  const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
  const shared = { box: new THREE.BoxGeometry(1, 1, 1), cyl: new THREE.CylinderGeometry(1, 1, 1, 12), sph: new THREE.SphereGeometry(1, 12, 8) };

  // ───────── walls with openings ─────────
  function frameAxes(w) {
    const a = w.a, b = w.b; const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L;
    return { a, b, L, ux, uz, nx: -uz, nz: ux, ry: Math.atan2(-uz, ux), P: (s, n) => [a[0] + ux * s + (-uz) * n, a[1] + uz * s + ux * n] };
  }
  // sloped-top wall piece (second floor partitions under the mansard)
  function wallPieceClipped(gid, mat, w, s0, s1, y0, y1, n0, n1) {
    const F = frameAxes(w); const N = 8; const top = [];
    let clipped = false;
    for (let i = 0; i <= N; i++) {
      const s = s0 + (s1 - s0) * i / N; const p = F.P(s, (n0 + n1) / 2);
      const yy = Math.min(y1, mansardInnerY(p[0], p[1]) - 0.01); if (yy < y1 - 1e-3) clipped = true;
      top.push([s, Math.max(y0 + 0.05, yy)]);
    }
    if (!clipped) return B.boxAlong(gid, mat, w.a, w.b, s0, s1, y0, y1, n0, n1);
    const pts = [[s0, y0], [s1, y0], ...top.reverse()];
    const sh = new THREE.Shape(pts.map(p => new THREE.Vector2(p[0], p[1])));
    const g = new THREE.ExtrudeGeometry(sh, { depth: n1 - n0, bevelEnabled: false, curveSegments: 1 });
    // local (s, y, n) → world
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const s = pos.getX(i), y = pos.getY(i), n = n0 + pos.getZ(i);
      const p = F.P(s, n); pos.setXYZ(i, p[0], y, p[1]);
    }
    g.computeVertexNormals();
    // extrusion direction flips handedness when mapped: fix winding if needed
    const ni = NI(g); flipIfInward(ni, F, n0, n1);
    B.push(gid, mat, ni); return ni;
  }
  function flipIfInward(g, F, n0, n1) {
    // test: normals of faces on the n1 side should point +n
    const p = g.attributes.position, n = g.attributes.normal; if (!n) return;
    let score = 0;
    for (let i = 0; i < p.count; i++) { const dn = (p.getX(i) - F.a[0]) * F.nx + (p.getZ(i) - F.a[1]) * F.nz; const side = dn > (n0 + n1) / 2 ? 1 : -1; score += side * (n.getX(i) * F.nx + n.getZ(i) * F.nz); }
    if (score < 0) {
      for (let i = 0; i < p.count; i += 3) { for (const att of [p, n]) { const t = [att.getX(i + 1), att.getY(i + 1), att.getZ(i + 1)]; att.setXYZ(i + 1, att.getX(i + 2), att.getY(i + 2), att.getZ(i + 2)); att.setXYZ(i + 2, ...t); } }
      g.computeVertexNormals();
    }
  }

  // exterior walls: render skin outside, plaster skin inside
  function extPiece(gid, w, s0, s1, y0, y1, opts = {}) {
    if (s1 - s0 < 1e-3 || y1 - y0 < 1e-3) return;
    const t = w.t, h = t / 2; const outMat = opts.outMat || 'render';
    const iy0 = Math.max(y0, opts.inY0 != null ? opts.inY0 : y0), iy1 = Math.min(y1, opts.inY1 != null ? opts.inY1 : y1);
    if (opts.inMat === null || iy1 <= iy0) { B.boxAlong(gid, outMat, w.a, w.b, s0, s1, y0, y1, -h, h); return; }
    B.boxAlong(gid, outMat, w.a, w.b, s0, s1, y0, y1, -h, h - 0.015);
    B.boxAlong(gid, opts.inMat || 'wall', w.a, w.b, s0, s1, iy0, iy1, h - 0.015, h);
  }

  function buildWalls(floor) {
    const fid = floor.id, y = floor.level.y, gid = fid;
    const ceil = y + (fid === 'basement' ? 2.4 : 2.7);
    for (const w of floor.walls) {
      const F = frameAxes(w);
      const isExt = w.kind === 'ext' || (w.kind === 'party' && w.a[0] === 0 && w.b[0] === 0);
      const mans = fid === 'second' && w.kind === 'ext';
      const frontGround = fid === 'ground' && w.kind === 'ext' && w.a[1] === 14.7 && w.b[1] === 14.7;
      const gi = (isExt || w.kind === 'core' || fid === 'basement') ? fid : fid + '-int';   // partitions = fit-out (hidden on inactive floors)
      // wall vertical extent
      let y0 = y, y1 = ceil, inY1 = ceil;
      if (fid === 'basement') { y0 = y; y1 = isExt ? -0.3 : ceil; inY1 = ceil; }
      else if (isExt) {
        y0 = fid === 'ground' ? (frontGround ? -0.95 : -0.3) : y - 0.0;
        y1 = mans ? CORNICE_Y : (w.kind === 'party' && fid === 'second' ? ROOF.y + 0.15 : y + 3.0);
        if (w.kind === 'party' && fid === 'second') inY1 = ceil;
      }
      const openings = [...w.openings].filter(o => !(fid === 'second' && o.type === 'slit')).sort((p, q) => p.from - q.from);
      const pieces = [];
      let s = 0;
      for (const o of openings) { if (o.from > s) pieces.push([s, o.from]); s = Math.max(s, o.to); }
      if (s < F.L) pieces.push([s, F.L]);
      // skip the street façade behind the brick tower (the tower builds its own front)
      const clipTower = (s0, s1) => {
        if (!(isExt && w.a[1] === 14.7 && w.b[1] === 14.7 && fid !== 'basement' && fid !== 'second')) return [[s0, s1]];
        const sT = F.L - TOWER.x1; // x = 2.9 in along coordinates (a is the east end)
        if (s1 <= sT) return [[s0, s1]]; if (s0 >= sT) return []; return [[s0, sT]];
      };
      for (const [a0, a1] of pieces) for (const [s0, s1] of clipTower(a0, a1)) {
        if (isExt && fid !== 'basement') extPiece(gid, w, s0, s1, y0, y1, { inY0: y, inY1 });
        else if (fid === 'second') wallPieceClipped(gi, 'wall', w, s0, s1, y0, y1, -w.t / 2, w.t / 2);
        else if (fid === 'basement' && isExt) {
          // below ramp surface where the ramp runs along the wall
          B.boxAlong(gid, 'bWall', w.a, w.b, s0, s1, y0, y1, -w.t / 2, w.t / 2);
        } else B.boxAlong(gi, fid === 'basement' ? 'bWall' : 'wall', w.a, w.b, s0, s1, y0, y1, -w.t / 2, w.t / 2);
      }
      for (const o of openings) {
        if (fid === 'basement' && o.type === 'garage') { // the ramp passes through: solid only below the ramp surface
          B.boxAlong(gid, 'bWall', w.a, w.b, o.from, o.to, y0, rampY(14.7) - 0.02, -w.t / 2, w.t / 2); continue;
        }
        const inTower = isExt && w.a[1] === 14.7 && w.b[1] === 14.7 && F.P(o.from, 0)[0] < TOWER.x1 + 0.01 && fid !== 'second';
        if (inTower) continue; // slit handled by the tower
        let [ob, ot] = OPEN_H[o.type] || [0, 2.1];
        ob += y; ot += y;
        if (o.type === 'garage' && fid === 'ground') { ob = rampY(14.85); ot = 1.35; }
        const matW = isExt ? null : (fid === 'basement' ? 'bWall' : 'wall');
        const piece = (yy0, yy1, zinc) => {
          if (yy1 - yy0 < 1e-3) return;
          if (matW) { if (fid === 'second') wallPieceClipped(gi, matW, w, o.from, o.to, yy0, yy1, -w.t / 2, w.t / 2); else B.boxAlong(gi, matW, w.a, w.b, o.from, o.to, yy0, yy1, -w.t / 2, w.t / 2); }
          else extPiece(zinc ? 'roofshell' : gid, w, o.from, o.to, yy0, yy1, { outMat: zinc ? 'zinc' : 'render', inY0: y, inY1, inMat: zinc ? 'wall' : undefined });
        };
        if (mans) {
          piece(y0, Math.min(ob, CORNICE_Y));
          piece(Math.max(ob, CORNICE_Y), ob, true);
          piece(ot, DORMER_TOP, true);
          buildDormer(w, F, o, ob, ot);
        } else {
          piece(y0, ob);
          piece(ot, y1);
        }
        B.withTag({ floorId: fid, wallIndex: floor.walls.indexOf(w), openingIndex: w.openings.indexOf(o), type: o.type }, () => buildOpening(fid, w, F, o, ob, ot, isExt, gi, mans));
      }
    }
  }

  // ───────── dormers ─────────
  const dormerHoles = new Map(); // wall key → [[u0,u1,yTop]]
  function wallKey(a, b) { return `${a[0]},${a[1]}>${b[0]},${b[1]}`; }
  function buildDormer(w, F, o, ob, ot) {
    const g = 'roofshell', h = w.t / 2, j = 0.12, DT = DORMER_TOP, rt = 0.07;
    const s0 = o.from - j, s1 = o.to + j;
    // jambs (front face)
    B.boxAlong(g, 'zinc', w.a, w.b, s0, o.from, CORNICE_Y, DT, -h - 0.02, h);
    B.boxAlong(g, 'zinc', w.a, w.b, o.to, s1, CORNICE_Y, DT, -h - 0.02, h);
    // cheeks: triangles from the façade plane back to the slope
    const back = (DT + rt - CORNICE_Y) / TAN; // depth from outer face
    for (const [sa, sb] of [[s0, s0 + 0.04], [s1 - 0.04, s1]]) {
      const tri = [[0, CORNICE_Y], [0, DT + rt], [back, DT + rt]];
      const sh = new THREE.Shape(tri.map(p => new THREE.Vector2(p[0], p[1])));
      const geo = new THREE.ExtrudeGeometry(sh, { depth: sb - sa, bevelEnabled: false });
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) { const d = pos.getX(i), yy = pos.getY(i), ss = sa + pos.getZ(i); const p = F.P(ss, -h + d); pos.setXYZ(i, p[0], yy, p[1]); }
      const ng = NI(geo); ng.computeVertexNormals();
      // make it double sided-safe by adding flipped copy
      B.push(g, 'zinc', ng);
      const fl = ng.clone(); const fp = fl.attributes.position;
      for (let i = 0; i < fp.count; i += 3) { const t = [fp.getX(i + 1), fp.getY(i + 1), fp.getZ(i + 1)]; fp.setXYZ(i + 1, fp.getX(i + 2), fp.getY(i + 2), fp.getZ(i + 2)); fp.setXYZ(i + 2, ...t); }
      fl.computeVertexNormals(); B.push(g, 'zinc', fl);
    }
    // dormer roof + drip edge
    B.boxAlong(g, 'zincTrim', w.a, w.b, s0 - 0.04, s1 + 0.04, DT, DT + rt, -h - 0.06, -h + back + 0.05);
    // plaster reveal inside (ceiling of the dormer)
    B.boxAlong(g, 'ceiling', w.a, w.b, o.from, o.to, ot, ot + 0.01, -h + 0.02, -h + back);
    const k = wallKey(w.a, w.b); if (!dormerHoles.has(k)) dormerHoles.set(k, []);
    dormerHoles.get(k).push([s0, s1, DT + rt]);
  }

  // ───────── openings: windows, glass doors, doors ─────────
  const leafGeo = new THREE.BoxGeometry(1, 1, 1);
  function mbox(sx, sy, sz) { const g = NI(new THREE.BoxGeometry(sx, sy, sz)); B.worldUV(g); return g; }
  const handleGeo = new THREE.CylinderGeometry(0.011, 0.011, 1, 10);
  const UNIT_IDS = ['0.A', '0.B', '1.A', '1.B', '1.C', '2.A', '2.B', '2.C'];
  let brassAtlasCache = null;
  function brassAtlas() {
    if (brassAtlasCache) return brassAtlasCache;
    const cv = makeCanvas(1024, 512), c2 = cv.getContext('2d');
    const gr = c2.createLinearGradient(0, 0, 0, 512); gr.addColorStop(0, '#c7a765'); gr.addColorStop(0.5, '#b89552'); gr.addColorStop(1, '#c2a05c'); c2.fillStyle = gr; c2.fillRect(0, 0, 1024, 512);
    for (let i = 0; i < 2600; i++) { c2.fillStyle = `rgba(${i % 2 ? '255,240,200' : '60,40,10'},0.05)`; c2.fillRect((i * 97.3) % 1024, (i * 53.7) % 512, 26, 1); }
    UNIT_IDS.forEach((u, i) => { const cx = (i % 4) * 256 + 128, cy = Math.floor(i / 4) * 256 + 128;
      c2.strokeStyle = 'rgba(60,40,15,0.55)'; c2.lineWidth = 3; c2.strokeRect(cx - 119, cy - 119, 238, 238);
      c2.strokeStyle = 'rgba(60,40,15,0.4)'; c2.lineWidth = 2; c2.strokeRect(cx - 69, cy - 75, 126, 62);
      c2.fillStyle = '#2b2219'; c2.font = '600 50px Georgia, "Times New Roman", serif'; c2.textAlign = 'center'; c2.textBaseline = 'middle'; c2.fillText(u, cx - 6, cy - 42); c2.fillRect(cx - 82, cy + 34, 164, 13); c2.beginPath(); c2.arc(cx + 90, cy - 44, 10, 0, 7); c2.fill(); });
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    const mat = new THREE.MeshStandardMaterial({ map: t, metalness: 0.85, roughness: 0.32 }); mat.name = 'brass:unit-plates';
    // uv rectangle of a unit's cell [u0, v0, du, dv], of its name plate, and a plain brass texel
    const cell = (u) => { const i = Math.max(0, UNIT_IDS.indexOf(u)); return [(i % 4) / 4, 1 - (Math.floor(i / 4) + 1) / 2, 0.25, 0.5]; };
    const plateUV = (u) => { const i = Math.max(0, UNIT_IDS.indexOf(u)), cx = (i % 4) * 256 + 128, cy = Math.floor(i / 4) * 256 + 128; return [(cx - 70) / 1024, 1 - (cy - 12) / 512, 128 / 1024, 64 / 512]; };
    const plain = (u) => { const c = cell(u); return [c[0] + 0.004, c[1] + 0.008]; };
    brassAtlasCache = { mat, cell, plateUV, plain };
    return brassAtlasCache;
  }
  function unitAcross(floor, F, o) {
    const sm = (o.from + o.to) / 2;
    const pA = F.P(sm, 0.45), pB = F.P(sm, -0.45);
    const rA = roomAt(floor, pA[0], pA[1]), rB = roomAt(floor, pB[0], pB[1]);
    return { rA, rB };
  }
  let curOpening = null;
  function makeDoor({ id, floorId, kind, F, o, y, side, max, leafMat, thick = 0.045, handleMat = 'steel', plate = null, height }) {
    const w = o.to - o.from, h = height || (OPEN_H[o.type] || [0, 2.1])[1];
    const pivot = new THREE.Object3D(); pivot.name = `door-${id}`;
    const hp = F.P(o.from + 0.01, side * 0.0);
    pivot.position.set(hp[0], y, hp[1]);
    const base = F.ry; pivot.rotation.y = base;
    const leaf = new THREE.Mesh(mbox(w - 0.03, h - 0.01, thick), M[leafMat]); leaf.name = `door-leaf-${id}`;
    if (curOpening) { leaf.userData.opening = { ...curOpening }; pivot.userData.opening = { ...curOpening }; }
    leaf.position.set((w - 0.02) / 2, (h - 0.01) / 2 + 0.005, 0);
    leaf.castShadow = false; leaf.receiveShadow = true; pivot.add(leaf); dyn(pivot);
    const hx = w - 0.1, hgs = [];
    const hadd = (px, py, pz, rx, rz, sx, sy, sz) => { const g = NI(handleGeo.clone()); g.applyMatrix4(new THREE.Matrix4().compose(V3(px, py, pz), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, 0, rz)), V3(sx, sy, sz))); hgs.push(g); };
    for (const sgn of [1, -1]) {
      if (kind === 'entry' || kind === 'main') {
        const k = kind === 'main' ? 1.4 : 0.9;
        hadd(hx, h * 0.48, sgn * (thick / 2 + 0.05), 0, 0, 1, k, 1);
        for (const yy of [-0.35 * k, 0.35 * k]) hadd(hx, h * 0.48 + yy, sgn * (thick / 2 + 0.025), Math.PI / 2, 0, 0.8, 0.05, 0.8);
      } else {
        hadd(hx - 0.05, 1.02, sgn * (thick / 2 + 0.05), 0, Math.PI / 2, 1, 0.13, 1);
        hadd(hx, 1.02, sgn * (thick / 2 + 0.025), Math.PI / 2, 0, 2.2, 0.05, 2.2);
      }
    }
    if (plate && handleMat === 'brass') hadd(w / 2, 1.45, 0, Math.PI / 2, 0, 0.8, thick + 0.02, 0.8);   // peephole
    let hwMat = M[handleMat];
    if (plate && plate.text) { // unit plate: part of the hardware mesh, textured from the shared brass atlas
      const A = brassAtlas(), pl = A.plain(plate.text), r = A.plateUV(plate.text);
      for (const g of hgs) { const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, pl[0], pl[1]); }
      const pg = NI(new THREE.PlaneGeometry(0.16, 0.08)), uv = pg.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, r[0] + uv.getX(i) * r[2], r[1] + uv.getY(i) * r[3]);
      if (plate.side < 0) pg.rotateY(Math.PI);
      pg.translate(w / 2, 1.55, plate.side * (thick / 2 + 0.002)); hgs.push(pg); hwMat = A.mat;
    }
    const hw = new THREE.Mesh(mergeGeometries(hgs, false), hwMat); hw.name = `door-leaf-${id}-hw`; pivot.add(hw);
    if (curOpening) hw.userData.opening = { ...curOpening };
    G[kind === 'door' ? (floorId === 'basement' ? 'basement-det' : floorId + '-doors') : floorId].add(pivot);
    const center = V3(...(() => { const c = F.P((o.from + o.to) / 2, 0); return [c[0], y + 1.05, c[1]]; })());
    let cur = -1;
    const d = {
      id, floorId, kind, center, pivot, leaf, opening: curOpening ? { ...curOpening } : null,
      setOpen(t) { t = Math.max(0, Math.min(1, +t || 0)); if (t === cur) return; cur = t; pivot.rotation.y = base - side * max * t; }
    };
    doors.push(d);
    return d;
  }
  const gidOfFloor = (fid) => fid;

  function frameRect(gid, w, F, s0, s1, y0, y1, n, depth, bar = 0.055, bottom = true) {
    B.boxAlong(gid, 'frame', w.a, w.b, s0, s0 + bar, y0, y1, n - depth / 2, n + depth / 2);
    B.boxAlong(gid, 'frame', w.a, w.b, s1 - bar, s1, y0, y1, n - depth / 2, n + depth / 2);
    B.boxAlong(gid, 'frame', w.a, w.b, s0, s1, y1 - bar, y1, n - depth / 2, n + depth / 2);
    if (bottom) B.boxAlong(gid, 'frame', w.a, w.b, s0, s1, y0, y0 + bar, n - depth / 2, n + depth / 2);
  }
  function glassPane(gid, w, s0, s1, y0, y1, n) { B.boxAlong(gid, 'glass', w.a, w.b, s0, s1, y0, y1, n - 0.006, n + 0.006); }

  // ───────── baked-looking ambient occlusion: vertex-alpha gradient quads (1 draw call per group, no lights, no textures) ─────────
  const aoBuf = {};
  const AO_K = 2;   // material opacity is 0.5 → vertex alpha carries 2× the wanted darkness
  function aoQuad(gid, ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, a0, a1) { // a,b at darkness a0 · c,d at a1
    const o = aoBuf[gid] || (aoBuf[gid] = { p: [], c: [] });
    o.p.push(ax, ay, az, bx, by, bz, cx, cy, cz, ax, ay, az, cx, cy, cz, dx, dy, dz);
    const A = Math.min(1, a0 * AO_K), Z = Math.min(1, a1 * AO_K), r = 0.11, g = 0.09, b = 0.075;
    o.c.push(r, g, b, A, r, g, b, A, r, g, b, Z, r, g, b, A, r, g, b, Z, r, g, b, Z);
  }
  // vertical gradient on a wall face (n = offset across the wall), from height yA (darkness aA) to yB (aB)
  function aoWall(gid, F, s0, s1, n, yA, aA, yB, aB) {
    const p = F.P(s0, n), q = F.P(s1, n);
    aoQuad(gid, p[0], yA, p[1], q[0], yA, q[1], q[0], yB, q[1], p[0], yB, p[1], aA, aB);
  }
  // horizontal gradient on a floor/ceiling along a wall, from offset nA (darkness aA) to nB (aB)
  function aoFlat(gid, F, s0, s1, y, nA, aA, nB, aB) {
    const p = F.P(s0, nA), q = F.P(s1, nA), r = F.P(s1, nB), t = F.P(s0, nB);
    aoQuad(gid, p[0], y, p[1], q[0], y, q[1], r[0], y, r[1], t[0], y, t[1], aA, aB);
  }
  function buildAOMeshes() {
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    mat.name = 'ao-overlay'; M.aoOverlay = mat;
    for (const gid of Object.keys(aoBuf)) {
      const o = aoBuf[gid]; if (!o.p.length || !G[gid]) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(o.p, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(o.c, 4));
      const m = new THREE.Mesh(g, mat); m.name = `highlight-ao-${gid}`;   // ('highlight' keeps it out of the GLB export and the path tracer: raster-only shading) m.renderOrder = 2;
      m.userData.pathTraceIgnore = true; m.userData.ui = true; m.userData.noWalkRaycast = true; m.userData.rasterOnly = true;
      m.raycast = () => {};
      G[gid].add(m);
    }
  }

  // ───────── operable sashes: tilt windows and sliding glass-door leaves ─────────
  // All sashes of a floor are two instanced meshes per type (frame + glass). Each sash has a proxy Object3D that owns its transform,
  // carries userData.interact / userData.opening, and is what a raycast hit reports as `object`.
  const SASH = { slide: { W0: 1.45, H0: 2.41, bar: 0.05, depth: 0.05 }, tilt: { W0: 0.5, H0: 1.28, bar: 0.042, depth: 0.06 } };
  const sashQ = {};
  function makeSash({ fid, gid, F, a0, a1, y0, y1, n, mode, travel = 0 }) {
    const W = a1 - a0, H = y1 - y0; if (W < 0.12 || H < 0.2) return null;
    const U = SASH[mode], tag = curOpening ? { ...curOpening } : null;
    const key = tag ? `${fid}-w${tag.wallIndex}o${tag.openingIndex}` : `${fid}-${interactables.length}`;
    const pv = new THREE.Object3D(); pv.name = `sash-${key}`;
    const p = F.P(a0, n); pv.position.set(p[0], y0, p[1]); pv.rotation.order = 'YXZ'; pv.rotation.y = F.ry; pv.scale.set(W / U.W0, H / U.H0, 1);
    pv.material = M.frame;           // lets generic "is this hit solid?" checks treat the proxy like the frame it stands for
    if (tag) pv.userData.opening = tag;
    G[gid].add(pv);
    const rec = { pv, im: null, ig: null, i: 0 };
    const k = gid + '|' + mode; (sashQ[k] || (sashQ[k] = { gid, mode, list: [] })).list.push(rec);
    const push = () => { pv.updateMatrix(); pv.matrixWorldNeedsUpdate = true; if (rec.im) { rec.im.setMatrixAt(rec.i, pv.matrix); rec.im.instanceMatrix.needsUpdate = true; rec.ig.setMatrixAt(rec.i, pv.matrix); rec.ig.instanceMatrix.needsUpdate = true; } };
    const bx = pv.position.x, bz = pv.position.z;
    mkToggle(pv, mode === 'slide'
      ? { id: 'slider-' + key, kind: 'door', sound: 'door', range: 3.5, open: LBL.slideO, close: LBL.slideC, speed: 1.1, apply: (t) => { pv.position.x = bx - F.ux * travel * t; pv.position.z = bz - F.uz * travel * t; push(); } }
      : { id: 'window-' + key, kind: 'window', sound: 'click', range: 3, open: LBL.winO, close: LBL.winC, speed: 2.2, apply: (t) => { pv.rotation.x = 0.11 * t; push(); } });
    return pv;
  }
  function buildSashMeshes() {
    const geos = {};
    for (const mode of Object.keys(SASH)) {
      const { W0: W, H0: H, bar, depth } = SASH[mode];
      const parts = [[bar / 2, H / 2, 0, bar, H, depth], [W - bar / 2, H / 2, 0, bar, H, depth], [W / 2, H - bar / 2, 0, W - 2 * bar, bar, depth], [W / 2, bar / 2, 0, W - 2 * bar, bar, depth]];
      if (mode === 'slide') parts.push([bar / 2, 1.05, depth / 2 + 0.018, 0.022, 0.32, 0.036]); else parts.push([W - bar / 2, H / 2, depth / 2 + 0.014, 0.02, 0.13, 0.028]);
      const gl = new THREE.BoxGeometry(W - 2 * bar + 0.012, H - 2 * bar + 0.012, 0.012); gl.translate(W / 2, H / 2, 0);
      geos[mode] = { fr: boxesGeo(parts), gl };
    }
    for (const k of Object.keys(sashQ)) {
      const { gid, mode, list } = sashQ[k];
      const im = new THREE.InstancedMesh(geos[mode].fr, M.frame, list.length), ig = new THREE.InstancedMesh(geos[mode].gl, M.glass, list.length);
      im.name = `sashes-${gid}-${mode}-frame`; ig.name = `sashes-${gid}-${mode}-glass`; im.castShadow = false; im.receiveShadow = true; ig.castShadow = false; ig.renderOrder = 1;
      list.forEach((r, i) => { r.im = im; r.ig = ig; r.i = i; r.pv.updateMatrix(); im.setMatrixAt(i, r.pv.matrix); ig.setMatrixAt(i, r.pv.matrix); });
      for (const m of [im, ig]) {
        m.instanceMatrix.needsUpdate = true; m.computeBoundingSphere(); m.computeBoundingBox(); m.userData.env = true;
        m.raycast = function (rc, hits) { const n0 = hits.length; THREE.InstancedMesh.prototype.raycast.call(this, rc, hits); for (let i = n0; i < hits.length; i++) { const r = list[hits[i].instanceId]; if (r) hits[i].object = r.pv; } };
        G[gid].add(m);
      }
    }
  }

  function buildOpening(fid, w, F, o, ob, ot, isExt, gi, mans) {
    const floor = FLOORS.find(f => f.id === fid); const y = floor.level.y;
    curOpening = { floorId: fid, wallIndex: floor.walls.indexOf(w), openingIndex: w.openings.indexOf(o), type: o.type };
    const gid = gi || fid;
    const h = w.t / 2;
    const s0 = o.from, s1 = o.to;
    if (o.type === 'window' || o.type === 'glassdoor') {
      const nG = isExt ? -h + 0.17 : 0;
      if (o.type === 'window') {
        frameRect(gid, w, F, s0, s1, ob, ot, nG, 0.09, 0.06);
        const mid = s1 - s0 > 1.0 ? (s0 + s1) / 2 : null;
        if (mid) { // fixed light + mullion; the other half is a tilt sash
          B.boxAlong(gid, 'frame', w.a, w.b, mid - 0.03, mid + 0.03, ob, ot, nG - 0.045, nG + 0.045);
          glassPane(gid, w, s0 + 0.05, mid - 0.02, ob + 0.05, ot - 0.05, nG);
        }
        makeSash({ fid, gid, F, a0: mid ? mid + 0.03 : s0 + 0.06, a1: s1 - 0.06, y0: ob + 0.06, y1: ot - 0.06, n: nG + 0.012, mode: 'tilt' });
        if (isExt) {
          B.boxAlong(gid, 'stoneFine', w.a, w.b, s0 - 0.04, s1 + 0.04, ob - 0.05, ob, -h - 0.05, nG - 0.04); // external sill
          B.boxAlong(gid, 'stoneFine', w.a, w.b, s0 - 0.02, s1 + 0.02, ob - 0.03, ob, nG + 0.045, h + 0.03);  // internal sill
          if (!mans) aoWall(fid, F, s0 - 0.02, s1 + 0.02, -h - 0.004, ob - 0.05, 0.2, ob - 0.42, 0);            // drip shading under the sill
        }
      } else {
        // sliding glass door: fixed leaf on the outer track, sliding leaf on the inner track (opens on tap)
        frameRect(gid, w, F, s0, s1, ob, ot, nG, 0.14, 0.06);
        const m = (s0 + s1) / 2;
        frameRect(gid, w, F, s0 + 0.04, m + 0.04, ob + 0.04, ot - 0.05, nG - 0.035, 0.05, 0.05);
        glassPane(gid, w, s0 + 0.09, m - 0.01, ob + 0.09, ot - 0.1, nG - 0.035);
        makeSash({ fid, gid, F, a0: m - 0.04, a1: s1 - 0.04, y0: ob + 0.04, y1: ot - 0.05, n: nG + 0.035, mode: 'slide', travel: m - s0 - 0.08 });
        if (isExt) B.boxAlong(gid, 'darkSteel', w.a, w.b, s0, s1, ob - 0.02, ob + 0.005, -h - 0.02, h);
      }
      return;
    }
    if (o.type === 'door' || o.type === 'entry') {
      // casing
      const cm = o.type === 'entry' ? 'walnut' : 'lacquer';
      const bar = 0.04;
      const hH = (OPEN_H[o.type])[1];
      if (fid !== 'basement' || o.type === 'door') {
        for (const sgn of [-1, 1]) {
          B.boxAlong(gid, cm, w.a, w.b, s0 - 0.05, s0 + 0.01, y, y + hH + 0.05, sgn * (h + 0.012) - 0.006 * sgn, sgn * (h + 0.012) + 0.006 * sgn);
          B.boxAlong(gid, cm, w.a, w.b, s1 - 0.01, s1 + 0.05, y, y + hH + 0.05, sgn * (h + 0.012) - 0.006 * sgn, sgn * (h + 0.012) + 0.006 * sgn);
          B.boxAlong(gid, cm, w.a, w.b, s0 - 0.05, s1 + 0.05, y + hH - 0.01, y + hH + 0.05, sgn * (h + 0.012) - 0.006 * sgn, sgn * (h + 0.012) + 0.006 * sgn);
        }
      }
      // jamb lining
      B.boxAlong(gid, cm, w.a, w.b, s0, s0 + 0.012, y, y + hH, -h, h);
      B.boxAlong(gid, cm, w.a, w.b, s1 - 0.012, s1, y, y + hH, -h, h);
      B.boxAlong(gid, cm, w.a, w.b, s0, s1, y + hH - 0.012, y + hH, -h, h);
      const { rA, rB } = unitAcross(floor, F, o);
      const idx = doors.length;
      if (o.type === 'entry') {
        const unitSide = rA && rA.unit ? 1 : -1; const unit = (unitSide > 0 ? rA : rB) || {};
        makeDoor({ id: `${fid}-entry-${unit.unit || idx}`, floorId: fid, kind: 'entry', F, o: { ...o, from: s0 + 0.012, to: s1 - 0.012 }, y, side: unitSide, max: Math.PI * 0.52, leafMat: 'walnut', thick: 0.06, handleMat: 'brass', plate: { text: unit.unit || '', side: -unitSide } });
      } else {
        const score = (r) => !r ? -1 : (['hall', 'landing', 'lobby', 'stairs'].includes(r.use) ? 0 : 1) + (r.poly ? polyArea(r.poly) / 1000 : 0);
        const side = score(rA) >= score(rB) ? 1 : -1;
        const leafM = fid === 'basement' ? 'darkSteel' : 'lacquer';
        const d = makeDoor({ id: `${fid}-door-${idx}`, floorId: fid, kind: 'door', F, o: { ...o, from: s0 + 0.012, to: s1 - 0.012 }, y, side, max: Math.PI * 80 / 180, leafMat: leafM, thick: 0.042, handleMat: 'steel' });
        d.setOpen(1);
      }
      return;
    }
    if (o.type === 'main') { buildMainDoor(w, F, o, y); return; }
    if (o.type === 'garage' && fid === 'ground') { buildGarage(w, F, o, ob, ot); return; }
    if (o.type === 'opening' && fid !== 'basement') {
      // plaster reveal head only
      return;
    }
  }

  // merged boxes → one geometry; list of [cx, cy, cz, sx, sy, sz]
  function boxesGeo(list) {
    const gs = list.map(([cx, cy, cz, sx, sy, sz]) => { const g = NI(new THREE.BoxGeometry(sx, sy, sz)); g.translate(cx, cy, cz); return g; });
    return mergeGeometries(gs, false);
  }
  // text plate (canvas) — o: { bg, fg, font, pw, glow, metal, flat, rz }. Signs are queued and baked into one atlas per group.
  const signQ = [];
  function label(gid, text, x, y, z, ry, w, h, o = {}) {
    const rec = { gid, text, x, y, z, ry, w, h, o, name: 'sign-' + text.replace(/[^\w.-]+/g, '-') };
    signQ.push(rec); return rec;
  }
  function buildSigns() {
    const sets = new Map();
    for (const r of signQ) {
      const gid = G[r.gid + '-det'] ? r.gid + '-det' : r.gid;
      const k = gid + '|' + (r.o.glow ? 'glow' : 'plain') + '|' + (r.o.bg === null ? 'alpha' : 'opaque');
      if (!sets.has(k)) sets.set(k, { gid, glow: !!r.o.glow, alpha: r.o.bg === null, list: [] });
      r.pw = r.o.pw || 512; r.ph = Math.max(32, Math.round(r.pw * r.h / r.w)); sets.get(k).list.push(r);
    }
    for (const set of sets.values()) {
      const list = set.list.slice().sort((a, b) => b.ph - a.ph); let sc = 1, AH = 0; const AW = 1024, pad = 4;
      for (; sc > 0.2; sc *= 0.85) { // shelf packing, shrink until it fits 1024 x 1024
        let x = 0, y = 0, rowH = 0, ok = true;
        for (const r of list) { const w = Math.min(AW, Math.round(r.pw * sc)), h = Math.round(r.ph * sc * (w / (r.pw * sc))); if (x + w > AW) { x = 0; y += rowH + pad; rowH = 0; } r.ax = x; r.ay = y; r.aw = w; r.ah = h; x += w + pad; rowH = Math.max(rowH, h); if (y + h > 1024) { ok = false; break; } }
        AH = y + rowH; if (ok) break;
      }
      let H2 = 64; while (H2 < AH) H2 *= 2;
      const cv = makeCanvas(AW, H2), g = cv.getContext('2d'), geos = []; let glow = 0;
      for (const r of list) {
        const o = r.o, k = r.aw / r.pw;
        g.save(); g.translate(r.ax, r.ay); g.beginPath(); g.rect(0, 0, r.aw, r.ah); g.clip(); g.scale(k, k);
        if (o.bg !== null) { g.fillStyle = o.bg === undefined ? '#2a2c2f' : o.bg; g.fillRect(0, 0, r.pw, r.ph); }
        if (o.border) { g.strokeStyle = o.border; g.lineWidth = 4; g.strokeRect(6, 6, r.pw - 12, r.ph - 12); }
        g.fillStyle = o.fg || '#f2efe8'; g.font = o.font || `600 ${Math.round(r.ph * 0.56)}px Helvetica, Arial, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(r.text, r.pw / 2, r.ph / 2 + 2);
        g.restore();
        const pg = NI(new THREE.PlaneGeometry(r.w, r.h)), uv = pg.attributes.uv;
        for (let i = 0; i < uv.count; i++) uv.setXY(i, (r.ax + uv.getX(i) * r.aw) / AW, 1 - (r.ay + (1 - uv.getY(i)) * r.ah) / H2);
        pg.applyMatrix4(new THREE.Matrix4().compose(V3(r.x, r.y, r.z), new THREE.Quaternion().setFromEuler(o.flat ? new THREE.Euler(-Math.PI / 2, 0, o.rz || 0) : new THREE.Euler(0, r.ry, 0)), V3(1, 1, 1)));
        geos.push(pg); glow += o.glow || 0;
      }
      const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
      const mat = new THREE.MeshStandardMaterial({ map: t, roughness: 0.5, metalness: 0, transparent: set.alpha });
      if (set.glow) { mat.emissive = new THREE.Color(0xffffff); mat.emissiveMap = t; mat.emissiveIntensity = glow / list.length; }
      mat.name = set.glow ? 'led-strip-emissive:sign' : 'signage';
      const m = new THREE.Mesh(mergeGeometries(geos, false), mat); m.name = `signs-${set.gid}-${set.glow ? 'glow' : 'plain'}${set.alpha ? '-alpha' : ''}`; m.receiveShadow = !set.alpha;
      G[set.gid].add(m);
    }
  }

  // Street entrance: full-height glazed door + sidelight in a slim bronze frame (leaf east, sidelight west).
  function buildMainDoor(w, F, o, y) {
    const gid = 'ground', h = w.t / 2, s0 = o.from, s1 = o.to, top = y + 2.42, nG = -h + 0.12, fb = 0.05, fd = 0.07;
    B.boxAlong(gid, 'bronze', w.a, w.b, s0, s0 + fb, y, top, nG - fd, nG + fd);
    B.boxAlong(gid, 'bronze', w.a, w.b, s1 - fb, s1, y, top, nG - fd, nG + fd);
    B.boxAlong(gid, 'bronze', w.a, w.b, s0, s1, top - fb, top, nG - fd, nG + fd);
    const leafW = 1.0, split = s0 + fb + leafW;
    B.boxAlong(gid, 'bronze', w.a, w.b, split, split + fb, y, top - fb, nG - fd, nG + fd);
    glassPane(gid, w, split + fb, s1 - fb, y + 0.03, top - fb, nG);
    B.boxAlong(gid, 'bronze', w.a, w.b, split + fb, s1 - fb, y, y + 0.03, nG - 0.03, nG + 0.03);
    // stone threshold + stainless strip
    B.boxAlong(gid, 'stoneFine', w.a, w.b, s0 - 0.04, s1 + 0.04, y - 0.03, y + 0.003, -h - 0.07, h + 0.02);
    B.boxAlong(gid, 'steel', w.a, w.b, s0 + fb, split, y + 0.003, y + 0.009, nG - 0.03, nG + 0.03);
    // leaf
    const W = leafW - 0.012, H = top - fb - y - 0.014, st = 0.075, br = 0.2;
    const pivot = dyn(new THREE.Object3D()); pivot.name = 'door-main-entrance';
    const hp = F.P(s0 + fb + 0.006, nG); pivot.position.set(hp[0], y + 0.01, hp[1]);
    const base = F.ry; pivot.rotation.y = base;
    const fr = new THREE.Mesh(boxesGeo([[st / 2, H / 2, 0, st, H, 0.05], [W - st / 2, H / 2, 0, st, H, 0.05], [W / 2, H - st / 2, 0, W - 2 * st, st, 0.05], [W / 2, br / 2, 0, W - 2 * st, br, 0.05]]), M.bronze);
    fr.name = 'door-frame-main-entrance'; fr.castShadow = false;
    const gl = new THREE.Mesh(new THREE.BoxGeometry(W - 2 * st + 0.01, H - st - br + 0.01, 0.012), M.glass); gl.position.set(W / 2, br + (H - st - br) / 2, 0); gl.name = 'door-leaf-main-entrance';
    const hx = W - st - 0.07, hy = 1.12, hl = 1.4;
    const hg = [];
    for (const sg of [-1, 1]) { const c = NI(new THREE.CylinderGeometry(0.015, 0.015, hl, 10)); c.translate(hx, hy, sg * 0.07); hg.push(c); for (const yy of [-0.5, 0.5]) { const b = NI(new THREE.BoxGeometry(0.014, 0.014, 0.05)); b.translate(hx, hy + yy, sg * 0.045); hg.push(b); } }
    const hd = new THREE.Mesh(mergeGeometries(hg.map(g => { for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k); return g; }), false), M.steel); hd.name = 'door-handle-main-entrance';
    for (const m of [fr, gl, hd]) { if (curOpening) m.userData.opening = { ...curOpening }; pivot.add(m); }
    if (curOpening) pivot.userData.opening = { ...curOpening };
    G['ground-det'].add(pivot);
    const c = F.P((s0 + s1) / 2, 0); let cur = -1;
    const d = { id: 'main-entrance', floorId: 'ground', kind: 'main', center: V3(c[0], y + 1.05, c[1]), pivot, leaf: gl, opening: curOpening ? { ...curOpening } : null,
      setOpen(t) { t = Math.max(0, Math.min(1, +t || 0)); if (t === cur) return; cur = t; pivot.rotation.y = base - Math.PI * 0.5 * t; } };
    doors.push(d); d.setOpen(0);
  }

  // Car-park entrance: sectional door in a framed portal; the sections really run up the tracks and back under the ceiling.
  function buildGarage(w, F, o, ob, ot) {
    const gid = 'ground', h = w.t / 2, s0 = o.from, s1 = o.to, jw = 0.1, lh = 0.14;
    B.boxAlong(gid, 'darkSteel', w.a, w.b, s0, s0 + jw, ob, ot, -h - 0.05, h + 0.03);
    B.boxAlong(gid, 'darkSteel', w.a, w.b, s1 - jw, s1, ob, ot, -h - 0.05, h + 0.03);
    B.boxAlong(gid, 'darkSteel', w.a, w.b, s0, s1, ot - lh, ot, -h - 0.05, h + 0.03);
    const W = s1 - s0 - 2 * jw + 0.06, H = ot - lh - ob + 0.03, N = 5, hs = H / N, R = 0.32, Hv = H - hs / 2, nD = h + 0.07;
    const grp = new THREE.Group(); grp.name = 'garage-door';   // (sections move, the group itself is static)
    const c = F.P((s0 + s1) / 2, nD); grp.position.set(c[0], ob, c[1]); grp.rotation.y = F.ry;
    const sg = new THREE.BoxGeometry(W, hs - 0.008, 0.045);
    { const uv = sg.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * W, uv.getY(i) * hs); }
    const secIM = new THREE.InstancedMesh(sg, M.garage, N); secIM.name = 'garage-door-panel'; secIM.castShadow = true; secIM.receiveShadow = true;
    const slotList = []; for (let k = 0; k < 5; k++) slotList.push([(k - 2) * (W / 5.4), 0, -0.023, W / 7.5, hs * 0.34, 0.006]);
    const slots = dyn(new THREE.Mesh(boxesGeo(slotList.slice(0, 5)), M.carGlass)); slots.name = 'garage-door-slots'; slots.rotation.order = 'XYZ';
    const seal = dyn(new THREE.Mesh(mbox(W, 0.03, 0.05), M.rubber)); seal.name = 'garage-door-seal';
    for (const m of [secIM, slots, seal]) { if (curOpening) m.userData.opening = { ...curOpening }; grp.add(m); }
    if (curOpening) grp.userData.opening = { ...curOpening };
    G['ground-det'].add(grp);
    const gm = new THREE.Matrix4();
    const place = (t) => {
      const travel = t * (H + 0.25);
      for (let i = 0; i < N; i++) {
        const s = (i + 0.5) * hs + travel; let yy, zz, a;
        if (s <= Hv) { yy = s; zz = 0; a = 0; }
        else if (s <= Hv + R * Math.PI / 2) { a = (s - Hv) / R; yy = Hv + R * Math.sin(a); zz = R * (1 - Math.cos(a)); }
        else { a = Math.PI / 2; yy = Hv + R; zz = R + (s - Hv - R * Math.PI / 2); }
        gm.makeRotationX(a); gm.setPosition(0, yy, zz); secIM.setMatrixAt(i, gm);
        if (i === 3) { slots.position.set(0, yy, zz); slots.rotation.x = a; }
        if (i === 0) { const o = -hs / 2 + 0.012; seal.position.set(0, yy + o * Math.cos(a), zz + o * Math.sin(a)); seal.rotation.x = a; }
      }
      secIM.instanceMatrix.needsUpdate = true;
    };
    secIM.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, H * 0.6, H * 0.5), H * 1.5); secIM.boundingBox = new THREE.Box3(new THREE.Vector3(-W, -0.5, -0.5), new THREE.Vector3(W, H + 1, H + 1.5));
    place(0);
    // tracks + operator (inside)
    const yT = ob + Hv + R + 0.05;
    for (const s of [s0 + jw - 0.02, s1 - jw + 0.02]) {
      B.boxAlong(gid, 'galv', w.a, w.b, s - 0.02, s + 0.02, ob, yT, nD + 0.03, nD + 0.07);
      B.boxAlong(gid, 'galv', w.a, w.b, s - 0.02, s + 0.02, yT, yT + 0.04, nD + 0.03, nD + H + 0.5);
    }
    B.boxAlong(gid, 'galv', w.a, w.b, (s0 + s1) / 2 - 0.02, (s0 + s1) / 2 + 0.02, yT + 0.1, yT + 0.14, nD, nD + H + 0.8);
    B.boxAlong(gid, 'evWhite', w.a, w.b, (s0 + s1) / 2 - 0.12, (s0 + s1) / 2 + 0.12, yT + 0.02, yT + 0.2, nD + H + 0.5, nD + H + 0.9);
    const cc = F.P((s0 + s1) / 2, 0);
    const d = { id: 'garage', floorId: 'ground', kind: 'garage', center: V3(cc[0], ob + 1.1, cc[1]), pivot: grp, leaf: secIM, opening: curOpening ? { ...curOpening } : null,
      setOpen(t) { place(Math.max(0, Math.min(1, +t || 0))); } };
    doors.push(d);
    // outside: height-limit sign, P sign, signal light, wall lights (street face z = 14.85)
    const xa = F.P(s0, 0)[0], xb = F.P(s1, 0)[0], xw = Math.min(xa, xb), xe = Math.max(xa, xb), xm = (xw + xe) / 2, zf = 14.853;
    label(gid, 'ALTURA MÁX. 2,10 m', xm, ot + 0.2, zf + 0.012, 0, 1.1, 0.2, { bg: '#e6b520', fg: '#17181a', pw: 512 });
    B.boxAB(gid, 'darkSteel', xm - 0.57, ot + 0.08, zf, xm + 0.57, ot + 0.32, zf + 0.01);
    label(gid, 'P', xw - 0.42, 1.95, zf + 0.012, 0, 0.3, 0.3, { bg: '#1d4f9c', fg: '#ffffff', pw: 128, font: '700 96px Helvetica, Arial, sans-serif' });
    B.boxAB(gid, 'darkSteel', xw - 0.36, 0.92, zf, xw - 0.22, 1.3, zf + 0.09);
    B.cyl(gid, 'ledRedOff', [xw - 0.29, 1.21, zf + 0.085], [xw - 0.29, 1.21, zf + 0.1], 0.042, 14);
    B.cyl(gid, 'ledGreen', [xw - 0.29, 1.02, zf + 0.085], [xw - 0.29, 1.02, zf + 0.1], 0.042, 14);
    B.boxAB(gid, 'darkSteel', xw - 0.37, 1.3, zf, xw - 0.21, 1.33, zf + 0.14);
    for (const x of [xw - 0.29, xe + 0.225]) { // up/down wall lights
      B.boxAB(gid, 'darkSteel', x - 0.045, 1.62, zf, x + 0.045, 1.86, zf + 0.09);
      B.boxAB(gid, 'ledWarm', x - 0.03, 1.86, zf + 0.02, x + 0.03, 1.865, zf + 0.07);
      B.boxAB(gid, 'ledWarm', x - 0.03, 1.615, zf + 0.02, x + 0.03, 1.62, zf + 0.07);
    }
  }

  // ───────── slabs, floors, ceilings ─────────
  const STAIR_HOLE = [[0.25, 10.1], [2.75, 10.1], [2.75, 14.55], [0.25, 14.55]];
  const SHAFT_HOLE = [[0.25, 7.15], [1.55, 7.15], [1.55, 8.85], [0.25, 8.85]];
  const RAMP_WALL_X = [10.3, 10.3];
  function buildSlabs() {
    // basement floor
    B.slab('basement', 'epoxy', BASE_POLY, LEVEL_Y.basement - 0.3, LEVEL_Y.basement);
    // ground slab (basement ceiling) — notch for the ramp void
    const gPoly = [[0, 0], [12.2, 0], [13.88, 4.9], [13.88, 9.2], [RAMP_WALL_X[0], 9.2], [RAMP_WALL_X[0], 14.7], [0, 14.7]];
    B.slab('ground', 'bCeil', gPoly, -0.3, -0.02, [STAIR_HOLE, SHAFT_HOLE]);
    B.slab('ground', 'baseFloor', gPoly, -0.02, -0.004, [STAIR_HOLE, SHAFT_HOLE]);
    // garden slabs over the basement (outside the footprint)
    const garden = [[[0, -7.9], [8.2, -7.9], [10.36, 0], [0, 0]], [[10.36, 0], [12.2, 0], [12.85, 1.9], [10.9, 1.9]], [[12.85, 1.9], [13.88, 1.9], [13.88, 4.9]]];
    for (const p of garden) B.slab('site', 'bCeil', p, -0.3, -0.14);
    // upper slabs
    for (const fid of ['first', 'second']) {
      const y = LEVEL_Y[fid];
      B.slab(fid, 'ceiling', FP, y - 0.3, y - 0.02, [STAIR_HOLE, SHAFT_HOLE]);
      B.slab(fid, 'baseFloor', FP, y - 0.02, y - 0.004, [STAIR_HOLE, SHAFT_HOLE]);
    }
    // common-area stone floors
    for (const f of FLOORS) {
      if (f.id === 'basement') continue;
      for (const r of f.rooms) if (r.use === 'landing' || r.use === 'lobby') {
        const poly = r.use === 'lobby' ? [[2.75, 9.2], [9.5, 9.2], [9.5, 14.55], [2.75, 14.55]] : r.poly.map(p => [p[0], p[1]]);
        if (r.use === 'landing') { poly[0][0] = poly[3][0] = 1.55; poly[0][1] = poly[1][1] = 7.15; }
        B.slab(f.id, 'stone', poly, f.level.y - 0.02, f.level.y);
        { // large-format joints (1.20 x 0.60) as fine recessed-looking lines
          const xs = poly.map(p => p[0]), zs = poly.map(p => p[1]); const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs), yj = f.level.y;
          for (let z = z0 + 0.6; z < z1 - 0.05; z += 0.6) B.boxAB(f.id, 'capGrey', x0, yj, z - 0.0015, x1, yj + 0.0012, z + 0.0015);
          let row = 0; for (let z = z0; z < z1 - 0.01; z += 0.6, row++) for (let x = x0 + (row % 2 ? 0.6 : 1.2); x < x1 - 0.05; x += 1.2) B.boxAB(f.id, 'capGrey', x - 0.0015, yj, z, x + 0.0015, yj + 0.0012, Math.min(z + 0.6, z1));
        }
      }
      // floor landing of the stairs
      B.slab(f.id, 'stone', [[0.25, 8.95], [2.75, 8.95], [2.75, 10.1], [0.25, 10.1]], f.level.y - 0.02, f.level.y);
      // threshold between landing and stair box
      B.slab(f.id, 'stone', [[1.55, 8.6], [2.75, 8.6], [2.75, 8.95], [1.55, 8.95]], f.level.y - 0.02, f.level.y);
    }
    B.slab('basement', 'stone', [[1.55, 7.0], [2.75, 7.0], [2.75, 10.1], [0.25, 10.1], [0.25, 8.95], [1.55, 8.95]], LEVEL_Y.basement, LEVEL_Y.basement + 0.012);
    // second floor ceiling under the mansard + roof deck
    const ceilPoly = offsetPoly(FP, (i, p, q) => isParty(p, q) ? -0.15 : -0.9);
    const SKY = ROOF.skylight;
    B.slab('roof', 'ceiling', ceilPoly, 8.7, 9.1, [SKY]);
    const roofPoly = offsetPoly(FP, (i, p, q) => isParty(p, q) ? -0.15 : 0.17 - SLOPE_RUN);
    B.slab('roof', 'gravel', roofPoly, 9.1, ROOF.y, [SKY]);
    // skylight: curb + glass
    const [sx0, sz0] = SKY[0], [sx1, sz1] = SKY[2];
    B.boxAB('roof', 'render', sx0 - 0.12, ROOF.y, sz0 - 0.12, sx1 + 0.12, ROOF.y + 0.3, sz0);
    B.boxAB('roof', 'render', sx0 - 0.12, ROOF.y, sz1, sx1 + 0.12, ROOF.y + 0.3, sz1 + 0.12);
    B.boxAB('roof', 'render', sx0 - 0.12, ROOF.y, sz0, sx0, ROOF.y + 0.3, sz1);
    B.boxAB('roof', 'render', sx1, ROOF.y, sz0, sx1 + 0.12, ROOF.y + 0.3, sz1);
    B.boxAB('roof', 'wall', sx0, 8.7, sz0, sx1, ROOF.y + 0.3, sz0 + 0.01);
    B.boxAB('roof', 'wall', sx0, 8.7, sz1 - 0.01, sx1, ROOF.y + 0.3, sz1);
    B.boxAB('roof', 'wall', sx0, 8.7, sz0, sx0 + 0.01, ROOF.y + 0.3, sz1);
    B.boxAB('roof', 'wall', sx1 - 0.01, 8.7, sz0, sx1, ROOF.y + 0.3, sz1);
    B.boxAB('roof', 'frame', sx0 - 0.14, ROOF.y + 0.3, sz0 - 0.14, sx1 + 0.14, ROOF.y + 0.36, sz1 + 0.14);
    B.boxAB('roof', 'glass', sx0 - 0.08, ROOF.y + 0.36, sz0 - 0.08, sx1 + 0.08, ROOF.y + 0.38, sz1 + 0.08);
    // coping around the roof edge
    const copOut = offsetPoly(FP, (i, p, q) => isParty(p, q) ? 0.15 : 0.17 - SLOPE_RUN + 0.1);
    const copIn = offsetPoly(FP, (i, p, q) => isParty(p, q) ? -0.05 : 0.17 - SLOPE_RUN - 0.18);
    B.slab('roof', 'zincTrim', copOut, ROOF.y, ROOF.y + 0.16, [copIn]);
    // lift overrun
    B.boxAB('roof', 'render', -0.15, ROOF.y, 6.95, 1.75, ROOF.y + 1.05, 9.05);
    B.boxAB('roof', 'zincTrim', -0.17, ROOF.y + 1.05, 6.93, 1.77, ROOF.y + 1.12, 9.07);
    // solar water tanks / vents (T.Q.)
    for (const [x, z] of [[12.3, 1.2], [12.6, 12.9]]) B.cyl('roof', 'darkSteel', [x, ROOF.y, z], [x, ROOF.y + 0.6, z], 0.18, 12);
  }

  // ───────── common-area ceilings (downlights) ─────────
  function downlight(gid, x, y, z, r = 0.05) {
    B.cyl(gid, 'darkSteel', [x, y - 0.004, z], [x, y + 0.002, z], r + 0.018, 14);
    B.cyl(gid, 'downlight', [x, y - 0.008, z], [x, y - 0.003, z], r, 14);
  }
  function buildCommonCeilings() {
    for (const f of FLOORS) {
      const y = f.level.y, ceil = y + (f.id === 'basement' ? 2.4 : 2.7), gid = f.id + '-ceil';
      if (f.id === 'basement') continue;
      if (f.id === 'ground') {
        for (const x of [4.2, 6.2, 8.2]) for (const z of [10.0, 13.6]) downlight(gid, x, ceil, z);
        for (const x of [2.5, 4.2, 6.0]) downlight(gid, x, ceil, 8.2);
        B.boxAB(gid, 'ledWarm', 1.8, ceil - 0.025, 7.26, 8.1, ceil - 0.01, 7.29);
        B.boxAB(gid, 'ceiling', 1.65, ceil - 0.06, 7.25, 8.15, ceil - 0.025, 7.5);
      } else {
        for (const x of [2.3, 4.0, 5.7, 7.0]) downlight(gid, x, ceil, 7.9);
        B.boxAB(gid, 'ledWarm', 1.8, ceil - 0.025, 7.26, 7.25, ceil - 0.01, 7.29);   // cove over the entry doors
        B.boxAB(gid, 'ceiling', 1.65, ceil - 0.06, 7.25, 7.3, ceil - 0.025, 7.5);     // floating ceiling edge hiding the strip
      }
      downlight(gid, 2.1, ceil, 9.5);
    }
  }

  // ───────── stairs ─────────
  function buildStairs() {
    const S = STAIR, xm = S.xMid, gap = 0.04;
    for (let k = 0; k < ORDER.length - 1; k++) {
      const lo = ORDER[k], hi = ORDER[k + 1];
      const y0 = LEVEL_Y[lo], y1 = LEVEL_Y[hi];
      const gid = lo; // the flights live with the lower storey
      const n = Math.round((y1 - y0) / CORE.stairs.riser), n1 = Math.ceil(n / 2), n2 = n - n1, r = (y1 - y0) / n;
      const ym = y0 + n1 * r;
      const t1 = (S.zTurn - S.zLand) / (n1 - 1), t2 = (S.zTurn - S.zLand) / (n2 - 1);
      // flight 1 (east half) climbing south
      const prof1 = [[S.zLand, y0 - 0.02]];
      for (let i = 0; i < n1 - 1; i++) { const z = S.zLand + i * t1; prof1.push([z, y0 + (i + 1) * r - 0.03], [z + t1, y0 + (i + 1) * r - 0.03]); }
      prof1.push([S.zTurn, ym - 0.3]);
      const under1 = 0.22 / Math.cos(Math.atan2(ym - y0, S.zTurn - S.zLand));
      prof1.push([S.zLand + 0.28, y0 - under1 + 0.02]);
      B.prismX(gid, 'wall', prof1, xm + gap, S.x1);
      for (let i = 0; i < n1 - 1; i++) {
        const z = S.zLand + i * t1, yt = y0 + (i + 1) * r;
        B.boxAB(gid, 'stoneFine', xm + gap, yt - 0.03, z - 0.02, S.x1, yt, z + t1);
      }
      // flight 2 (west half) climbing north
      const prof2 = [[S.zTurn, ym - 0.02]];
      for (let j = 0; j < n2 - 1; j++) { const z = S.zTurn - j * t2; prof2.push([z, ym + (j + 1) * r - 0.03], [z - t2, ym + (j + 1) * r - 0.03]); }
      prof2.push([S.zLand, y1 - 0.3]);
      prof2.push([S.zTurn - 0.3, ym - 0.24]);
      B.prismX(gid, 'wall', prof2, S.x0, xm - gap);
      for (let j = 0; j < n2 - 1; j++) {
        const z = S.zTurn - j * t2, yt = ym + (j + 1) * r;
        B.boxAB(gid, 'stoneFine', S.x0, yt - 0.03, z - t2, xm - gap, yt, z + 0.02);
      }
      // mid landing
      B.boxAB(gid, 'wall', S.x0, ym - 0.28, S.zTurn, S.x1, ym - 0.03, 14.55);
      B.boxAB(gid, 'stoneFine', S.x0, ym - 0.03, S.zTurn, S.x1, ym, 14.55);
      // central wall-stringer between flights (low plaster upstand following the flights)
      const cs = [[S.zLand - 0.02, y0 - 0.3], [S.zLand - 0.02, y1 + 0.9], [S.zTurn, ym + 0.9], [S.zTurn, ym - 0.3]];
      // (a sloped dwarf wall is visually heavy: use a slim steel+glass balustrade instead)
      const hrH = 0.9;
      // handrails (steel tube) — central, both flights
      B.cyl(gid, 'steel', [xm + gap + 0.03, y0 + hrH, S.zLand], [xm + gap + 0.03, ym + hrH, S.zTurn], 0.021, 10);
      B.cyl(gid, 'steel', [xm - gap - 0.03, ym + hrH, S.zTurn], [xm - gap - 0.03, y1 + hrH, S.zLand], 0.021, 10);
      // glass balustrade panels (parallelograms) between the flights
      const gp = [[S.zLand, y1 - 0.25], [S.zLand, y1 + hrH - 0.05], [S.zTurn, ym + hrH - 0.05], [S.zTurn, ym - 0.25]];
      const gpl = [[S.zLand, y0 - 0.05], [S.zLand, y0 + hrH - 0.05], [S.zTurn, ym + hrH - 0.05], [S.zTurn, ym - 0.05]];
      B.prismX(gid, 'railGlass', gpl.map(p => p), xm - 0.008, xm + 0.008);
      B.prismX(gid, 'railGlass', gp.map(p => p), xm - 0.008, xm + 0.008);
      // wall handrails with brackets
      for (const [x, ya, za, yb, zb] of [[S.x1 - 0.06, y0 + hrH, S.zLand, ym + hrH, S.zTurn], [S.x0 + 0.06, ym + hrH, S.zTurn, y1 + hrH, S.zLand]]) {
        B.cyl(gid, 'steel', [x, ya, za], [x, yb, zb], 0.02, 10);
        for (let u = 0.15; u < 1; u += 0.35) { const yy = ya + (yb - ya) * u, zz = za + (zb - za) * u; B.cyl(gid, 'steel', [x, yy - 0.01, zz], [x + (x > xm ? 0.06 : -0.06), yy - 0.01, zz], 0.007, 6); }
      }
      // glass guard on the landing over the flight below
      B.boxAB(gid, 'railGlass', xm - 0.01, ym - 0.05, S.zTurn - 0.02, xm + 0.01, ym + hrH, S.zTurn + 0.02);
      void cs;
    }
    // top floor guard across the flight well
    const yT = LEVEL_Y.second;
    B.boxAB('second', 'railGlass', STAIR.xMid, yT, STAIR.zLand - 0.01, STAIR.x1, yT + 1.0, STAIR.zLand + 0.01);
    B.cyl('second', 'steel', [STAIR.xMid, yT + 1.0, STAIR.zLand], [STAIR.x1, yT + 1.0, STAIR.zLand], 0.021, 10);
    B.boxAB('second', 'railGlass', STAIR.xMid - 0.01, yT, STAIR.zLand, STAIR.xMid + 0.01, yT + 1.0, STAIR.zTurn);
    B.cyl('second', 'steel', [STAIR.xMid, yT + 1.0, STAIR.zLand], [STAIR.xMid, yT + 1.0, STAIR.zTurn], 0.021, 10);
    // stairwell pendant: emissive tube column hanging from the skylight
    B.cyl('second-ceil', 'ledPanel', [STAIR.xMid, 5.6, 12.0], [STAIR.xMid, 8.7, 12.0], 0.012, 6);
  }

  // ───────── lift ─────────
  const levels = { basement: LEVEL_Y.basement, ground: 0, first: 3, second: 6 };
  const liftObj = {};
  function liftOpening(fid) {
    const f = FLOORS.find(v => v.id === fid); if (!f) return null;
    for (let wi = 0; wi < f.walls.length; wi++) { const oi = f.walls[wi].openings.findIndex(o => o.type === 'elevator'); if (oi >= 0) return { floorId: fid, wallIndex: wi, openingIndex: oi, type: 'elevator' }; }
    return null;
  }
  function buildLift() {
    const L = CORE.lift, sx = (L.x0 + L.x1) / 2, sz = (L.z0 + L.z1) / 2;
    const dz0 = L.doorZ[0], dz1 = L.doorZ[1], dW = dz1 - dz0;
    // shaft pit + walls are covered by the core walls; add pit floor and shaft lining
    B.boxAB('basement', 'concrete', L.x0, LEVEL_Y.basement - 1.2, L.z0, L.x1, LEVEL_Y.basement - 1.0, L.z1);
    for (const [gid, y0, y1] of [['basement', LEVEL_Y.basement - 1.2, -0.3], ['ground', -0.3, 2.7], ['first', 2.7, 5.7], ['second', 5.7, ROOF.y]]) B.boxAB(gid, gid === 'basement' ? 'bWall' : 'wall', 0, y0, L.z0 - 0.1, 0.25, y1, L.z1 + 0.05); // shaft back wall (party side)
    // cab
    const cab = dyn(new THREE.Group()); cab.name = 'lift-cab';
    const cw = 0.98, cd = 1.38, ch = 2.2; // interior
    const cabParts = {};
    const add = (geo, mat, x, y, z, sxx, syy, szz, name, axis) => { // static cab parts are merged per material below
      let g;
      if (geo === shared.box) { g = mbox(sxx, syy, szz); g.translate(x, y, z); }
      else { g = NI(geo.clone()); g.scale(sxx, syy, szz); if (axis === 'z') g.rotateZ(Math.PI / 2); else if (axis === 'x') g.rotateX(Math.PI / 2); g.translate(x, y, z); }
      (cabParts[mat] || (cabParts[mat] = [])).push(g);
    };
    const bx = shared.box;
    // cab coordinates: origin at cab floor centre; +x towards the doors
    add(bx, 'stone', 0, -0.03, 0, cw + 0.08, 0.06, cd + 0.08, 'cab-floor');
    add(bx, 'darkSteel', 0, -0.2, 0, cw + 0.1, 0.28, cd + 0.1);
    add(bx, 'walnut', -cw / 2 - 0.02, ch / 2, 0, 0.04, ch, cd + 0.04, 'cab-back');
    add(bx, 'mirror', -cw / 2 + 0.002, 1.35, 0, 0.01, 1.4, cd - 0.3, 'cab-mirror');
    add(bx, 'walnut', 0, ch / 2, -cd / 2 - 0.02, cw + 0.04, ch, 0.04);
    add(bx, 'walnut', 0, ch / 2, cd / 2 + 0.02, cw + 0.04, ch, 0.04);
    // front return panels either side of the door (stainless)
    const fw = (cd - dW) / 2;
    add(bx, 'steel', cw / 2 + 0.02, ch / 2, -cd / 2 + fw / 2 - 0.02, 0.04, ch, fw + 0.04);
    add(bx, 'steel', cw / 2 + 0.02, ch / 2, cd / 2 - fw / 2 + 0.02, 0.04, ch, fw + 0.04);
    add(bx, 'steel', cw / 2 + 0.02, ch - 0.05, 0, 0.04, 0.1, dW);
    // ceiling with light panel
    add(bx, 'white', 0, ch + 0.03, 0, cw + 0.08, 0.06, cd + 0.08);
    add(bx, 'ledPanel', 0, ch - 0.002, 0, cw - 0.25, 0.01, cd - 0.3, 'cab-light');
    add(bx, 'darkSteel', 0, ch + 0.4, 0, cw + 0.1, 0.5, cd + 0.1); // top structure
    // handrails
    for (const zz of [-cd / 2 + 0.05, cd / 2 - 0.05]) add(shared.cyl, 'steel', -0.05, 0.92, zz, 0.018, cw - 0.3, 0.018, null, 'z');
    add(shared.cyl, 'steel', -cw / 2 + 0.06, 0.92, 0, 0.018, cd - 0.3, 0.018, null, 'x');
    for (const k of Object.keys(cabParts)) { const m = new THREE.Mesh(mergeGeometries(cabParts[k], false), M[k]); m.name = `cab-${k}`; m.castShadow = false; m.receiveShadow = true; cab.add(m); }
    // button panel on the south front return, facing inwards (-x)
    const panel = new THREE.Group(); panel.name = 'lift-panel';
    panel.position.set(cw / 2 - 0.002, 1.1, cd / 2 - fw / 2);
    panel.rotation.y = -Math.PI / 2; // local +z faces -x (into the cab)
    const plate = new THREE.Mesh(boxesGeo([[0, 0, 0, 0.16, 0.5, 0.012], [0, 0.225, 0.008, 0.12, 0.06, 0.01]]), M.darkSteel); plate.name = 'lift-panel-plate'; panel.add(plate);
    const labels = [['second', '2'], ['first', '1'], ['ground', '0'], ['basement', '-1']];
    const btnGeo = new THREE.CylinderGeometry(0.022, 0.022, 0.012, 20); btnGeo.rotateX(Math.PI / 2);
    labels.forEach(([fid, lab], i) => {
      const tt = textCanvasTexture(THREE, lab, { w: 128, h: 128, bg: '#d6d6d6', fg: '#1a1a1a', font: '600 70px Helvetica, Arial, sans-serif' });
      const off = new THREE.MeshStandardMaterial({ color: 0xffffff, map: tt, metalness: 0.75, roughness: 0.3, emissive: 0x000000 });
      const bg0 = NI(btnGeo.clone()); { const uv = bg0.attributes.uv; for (let k = 0; k < uv.count; k++) uv.setXY(k, 0.03, 0.03); }
      const face = NI(new THREE.CircleGeometry(0.019, 20)); face.translate(0, 0, 0.0065);
      const b = new THREE.Mesh(mergeGeometries([bg0, face], false), off); b.name = `lift-button-${fid}`;
      b.position.set(0, 0.16 - i * 0.1, 0.012);
      b.userData.liftButton = fid;
      b.userData.setLit = (on) => { off.emissive.setHex(on ? 0xffb85a : 0x000000); off.emissiveIntensity = on ? 4 : 0; };
      b.userData.interact = { id: 'lift-button-' + fid, kind: 'lift-button', sound: 'lift', range: 2.2, label: L4('Floor ' + lab, 'Piso ' + lab, 'קומה ' + lab, 'Этаж ' + lab), toggle() { liftObj.call(fid, 'panel'); }, isOn() { return liftObj.target === fid; } };
      interactables.push(b);
      panel.add(b);
    });
    // floor indicator screen above the buttons
    cab.add(panel);
    // cab doors (two-panel side-opening, telescopic → both panels move to +z end? use centre-opening for elegance)
    const cabDoors = [];
    for (const sgn of [-1, 1]) {
      const d = dyn(new THREE.Mesh(mbox(0.025, 2.08, dW / 2 + 0.01), M.steel)); d.position.set(cw / 2 + 0.07, 1.04, sgn * dW / 4); d.name = 'cab-door'; cab.add(d); cabDoors.push({ m: d, sgn });
    }
    try { const cl = new THREE.PointLight(0xfff0dc, 3, 3, 2); cl.name = 'cab-light-source'; cl.position.set(0, ch - 0.15, 0); cab.add(cl); } catch (e) { /* ignore */ }
    cab.position.set(sx - 0.05, 0, sz);
    group.add(cab);
    // landing doors + stainless frames + indicators
    const landing = {}, callMats = {};
    for (const fid of ORDER) {
      const y = LEVEL_Y[fid];
      const gid = fid;
      const x = L.doorOnX + 0.11;
      B.boxAB(gid, 'steel', x - 0.02, y, dz0 - 0.07, x + 0.02, y + 2.18, dz0);
      B.boxAB(gid, 'steel', x - 0.02, y, dz1, x + 0.02, y + 2.18, dz1 + 0.07);
      B.boxAB(gid, 'steel', x - 0.02, y + 2.1, dz0 - 0.07, x + 0.02, y + 2.18, dz1 + 0.07);
      B.boxAB(gid, 'steel', L.doorOnX - 0.1, y - 0.005, dz0 - 0.02, x, y + 0.004, dz1 + 0.02); // sill
      // indicator (emissive digit)
      const tt = textCanvasTexture(THREE, fid === 'basement' ? '-1' : String(ORDER.indexOf(fid) - 1), { w: 128, h: 64, bg: '#0d0d0f', fg: '#ffcf8a', font: '600 44px Helvetica, Arial, sans-serif' });
      const ind = new THREE.Mesh(new THREE.PlaneGeometry(0.14, 0.07), new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff, emissiveMap: tt, emissiveIntensity: 2.5, roughness: 0.3 }));
      ind.position.set(x + 0.021, y + 2.3, (dz0 + dz1) / 2); ind.rotation.y = Math.PI / 2; ind.name = `lift-indicator-${fid}`; G[gid + '-det'].add(ind);
      // call button
      const cbm = new THREE.MeshStandardMaterial({ color: 0xd0d0d0, metalness: 0.9, roughness: 0.25 });
      const cb = new THREE.Mesh(btnGeo, cbm); cb.rotation.y = Math.PI / 2; cb.position.set(x + 0.02, y + 1.05, dz1 + 0.22); cb.name = `lift-call-${fid}`; cb.userData.liftCall = fid; G[gid + '-det'].add(cb);
      const cp = new THREE.Mesh(mbox(0.012, 0.24, 0.12), M.steel); cp.position.set(x + 0.006, y + 1.05, dz1 + 0.22); cp.name = `lift-call-plate-${fid}`; cp.userData.liftCall = fid; G[gid + '-det'].add(cp);
      const callIt = { id: 'lift-call-' + fid, kind: 'lift-call', sound: 'lift', range: 3, label: LBL.call, toggle() { liftObj.call(fid, 'landing'); }, isOn() { return liftObj.target === fid; } };
      cb.userData.interact = callIt; cp.userData.interact = callIt; interactables.push(cb, cp); callMats[fid] = cbm;
      const leaves = [];
      for (const sgn of [-1, 1]) {
        const d = dyn(new THREE.Mesh(mbox(0.03, 2.1, dW / 2 + 0.01), M.steel)); d.position.set(L.doorOnX + 0.05, y + 1.05, (dz0 + dz1) / 2 + sgn * dW / 4); d.name = `landing-door-${fid}`; d.userData.opening = liftOpening(fid); d.userData.interact = callIt; interactables.push(d); d.castShadow = false; G[gid].add(d); leaves.push({ m: d, sgn, z0: d.position.z });
      }
      landing[fid] = leaves;
    }
    let cabT = 0;
    const landT = { basement: 0, ground: 0, first: 0, second: 0 };
    const rawCabDoors = (t) => { cabT = t; for (let i = 0; i < cabDoors.length; i++) { const d = cabDoors[i]; d.m.position.z = d.sgn * (dW / 4 + t * (dW / 2 - 0.02)); } };
    const rawLanding = (fid, t) => { const ls = landing[fid]; if (!ls) return; landT[fid] = t; for (let i = 0; i < ls.length; i++) { const d = ls[i]; d.m.position.z = d.z0 + d.sgn * t * (dW / 2 - 0.02); } };
    const clamp01 = (t) => Math.max(0, Math.min(1, +t || 0));
    // tap-to-call controller (used by the landing call buttons and the cab panel when no other module takes the request)
    const job = { on: false, phase: 0, y0: 0, y1: 0, u: 0, dur: 1 };
    const lit = (fid) => { for (let i = 0; i < ORDER.length; i++) { const k = ORDER[i], m = callMats[k]; if (m) { m.emissive.setHex(k === fid ? 0xffb85a : 0x000000); m.emissiveIntensity = k === fid ? 3 : 0; } } for (let i = 0; i < panel.children.length; i++) { const c = panel.children[i]; if (c.userData.setLit) c.userData.setLit(c.userData.liftButton === fid); } };
    const stop = () => { if (job.on) { job.on = false; liftObj.target = null; lit(null); } };
    liftObj.cab = cab;
    liftObj.shaft = { x: sx, z: sz };
    liftObj.levels = levels;
    liftObj.panel = panel;
    liftObj.target = null;          // floor id the cab is travelling to on a tap (null when idle)
    liftObj.onRequest = null;       // optional hook (floorId, source) => true when another module (walk.js) performs the ride itself
    liftObj.setCabY = (y) => { stop(); cab.position.y = +y || 0; };
    liftObj.setCabDoors = (t) => { stop(); rawCabDoors(clamp01(t)); };
    liftObj.setLandingDoors = (fid, t) => { stop(); rawLanding(fid, clamp01(t)); };
    liftObj.getState = () => { liftState.y = cab.position.y; liftState.cabDoors = cabT; liftState.moving = job.on && job.phase === 1; liftState.target = liftObj.target; return liftState; };
    const liftState = { y: 0, cabDoors: 0, moving: false, target: null, landing: landT };
    liftObj.call = (fid, source) => {
      if (!(fid in levels)) return false;
      if (typeof liftObj.onRequest === 'function') { try { if (liftObj.onRequest(fid, source || 'tap') === true) return true; } catch (e) { /* fall through to the built-in ride */ } }
      job.on = true; job.phase = Math.abs(cab.position.y - levels[fid]) < 0.01 ? 2 : 0; liftObj.target = fid; lit(fid);
      return true;
    };
    animators.push((dt) => {
      if (!job.on) return;
      const fid = liftObj.target;
      if (job.phase === 0) { // close every door
        let open = cabT; for (let i = 0; i < ORDER.length; i++) open = Math.max(open, landT[ORDER[i]]);
        if (open > 0) { const v = Math.max(0, open - dt * 1.3); if (cabT > v) rawCabDoors(v); for (let i = 0; i < ORDER.length; i++) if (landT[ORDER[i]] > v) rawLanding(ORDER[i], v); return; }
        job.y0 = cab.position.y; job.y1 = levels[fid]; job.u = 0; job.dur = Math.max(1.6, Math.abs(job.y1 - job.y0) / 1.1); job.phase = 1;
      } else if (job.phase === 1) { // travel (ease in/out)
        job.u = Math.min(1, job.u + dt / job.dur); cab.position.y = job.y0 + (job.y1 - job.y0) * smooth(job.u);
        if (job.u >= 1) job.phase = 2;
      } else { // open at the landing
        const v = Math.min(1, Math.max(cabT, landT[fid]) + dt * 1.1); rawCabDoors(v); rawLanding(fid, v);
        if (v >= 1) { job.on = false; liftObj.target = null; lit(null); }
      }
    });
    cab.position.y = 0; rawCabDoors(0);
    for (const fid of ORDER) rawLanding(fid, 0);
    // register elevator 'doors' (kind 'elevator') so other modules can find them
    for (const fid of ORDER) doors.push({ id: `lift-${fid}`, floorId: fid, kind: 'elevator', center: V3(L.doorOnX, LEVEL_Y[fid] + 1.05, (dz0 + dz1) / 2), pivot: landing[fid][0].m, opening: liftOpening(fid), setOpen: (t) => liftObj.setLandingDoors(fid, t) });
  }

  // ───────── mansard (72° zinc) with dormer notches, interior lining ─────────
  function slopePlane(gid, mat, p, q, nBot, nTop, yBot, yTop, notches, endBot, endTop, inward) {
    // (s,f) polygon → world; s along edge p→q; f 0..1 bottom→top
    const e = edgeInward(p, q);
    const [sa0, sb0] = endBot, [sa1, sb1] = endTop;
    // banded quads: robust against triangulation across notches
    const ns = notches.filter(([n0, n1]) => n1 > sa0 && n0 < sb0);
    const cuts = [...new Set([0, 1, ...ns.map(n => Math.min(1, Math.max(0, n[2])))])].sort((x, y) => x - y);
    const verts = [];
    const quad = (s0a, s1a, fa, s0b, s1b, fb) => { verts.push(s0a, fa, 0, s1a, fa, 0, s1b, fb, 0, s0a, fa, 0, s1b, fb, 0, s0b, fb, 0); };
    for (let c = 0; c < cuts.length - 1; c++) {
      const fa = cuts[c], fb = cuts[c + 1]; if (fb - fa < 1e-5) continue;
      const La = sa0 + (sa1 - sa0) * fa, Ra = sb0 + (sb1 - sb0) * fa, Lb = sa0 + (sa1 - sa0) * fb, Rb = sb0 + (sb1 - sb0) * fb;
      const blk = ns.filter(n => n[2] >= fb - 1e-6).map(n => [n[0], n[1]]).sort((x, y) => x[0] - y[0]);
      let curA = La, curB = Lb;
      for (const [n0, n1] of blk) { if (n0 > curA) quad(curA, n0, fa, curB, n0, fb); curA = Math.max(curA, n1); curB = Math.max(curB, n1); }
      if (Ra > curA) quad(curA, Ra, fa, curB, Rb, fb);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const s = pos.getX(i), f = pos.getY(i);
      const n = nBot + (nTop - nBot) * f, y = yBot + (yTop - yBot) * f;
      pos.setXYZ(i, p[0] + e.ux * s + e.nx * n, y, p[1] + e.uz * s + e.nz * n);
    }
    g.computeVertexNormals();
    // orient: outer zinc faces outward (−n, +y); lining faces inward (+n, −y)
    const nrm = g.attributes.normal; const want = inward ? 1 : -1;
    const dot = nrm.getX(0) * e.nx + nrm.getZ(0) * e.nz;
    if (Math.sign(dot) !== want) {
      for (let i = 0; i < pos.count; i += 3) { const t = [pos.getX(i + 1), pos.getY(i + 1), pos.getZ(i + 1)]; pos.setXYZ(i + 1, pos.getX(i + 2), pos.getY(i + 2), pos.getZ(i + 2)); pos.setXYZ(i + 2, ...t); }
      g.computeVertexNormals();
    }
    if (mat === 'zinc') { // uv: seams run down the slope, 0.5 m pitch
      const uv = new Float32Array(pos.count * 2); const L = (yTop - yBot) / Math.sin(MANSARD_PITCH * Math.PI / 180);
      for (let i = 0; i < pos.count; i++) { const x = pos.getX(i), z = pos.getZ(i); uv[2 * i] = (x - p[0]) * e.ux + (z - p[1]) * e.uz; uv[2 * i + 1] = ((pos.getY(i) - yBot) / (yTop - yBot)) * L; }
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); g.userData.keepUV = true;
    }
    B.push(gid, mat, g);
  }
  function buildMansard() {
    const O0 = offsetPoly(FP, (i, p, q) => isParty(p, q) ? 0 : 0.15);
    const O1 = offsetPoly(FP, (i, p, q) => isParty(p, q) ? 0 : 0.15 - SLOPE_RUN);
    const I0 = offsetPoly(FP, (i, p, q) => isParty(p, q) ? -0.15 : -0.15);
    const I1 = offsetPoly(FP, (i, p, q) => isParty(p, q) ? -0.15 : -0.15 - (8.7 - CORNICE_Y) / TAN);
    const n = FP.length;
    for (let i = 0; i < n; i++) {
      const p = FP[i], q = FP[(i + 1) % n]; if (isParty(p, q)) continue;
      const e = edgeInward(p, q);
      const proj = (v) => (v[0] - p[0]) * e.ux + (v[1] - p[1]) * e.uz;
      const holes = dormerHoles.get(wallKey(p, q)) || [];
      const fz = (y) => (y - CORNICE_Y) / (ROOF.y - CORNICE_Y);
      slopePlane('roofshell', 'zinc', p, q, -0.15, -0.15 + SLOPE_RUN, CORNICE_Y, ROOF.y, holes.map(([a, b, yt]) => [a, b, fz(yt)]), [proj(O0[i]), proj(O0[(i + 1) % n])], [proj(O1[i]), proj(O1[(i + 1) % n])], false);
      { // seams: square ribs running up the slope, stopping at dormers and hips
        const a0 = proj(O0[i]), b0 = proj(O0[(i + 1) % n]), a1 = proj(O1[i]), b1 = proj(O1[(i + 1) % n]);
        const P3 = (s, f) => { const nn = -0.15 + SLOPE_RUN * f - 0.012 * Math.sin(MANSARD_PITCH * Math.PI / 180); return [p[0] + e.ux * s + e.nx * nn, CORNICE_Y + (ROOF.y - CORNICE_Y) * f + 0.012 * Math.cos(MANSARD_PITCH * Math.PI / 180), p[1] + e.uz * s + e.nz * nn]; };
        for (let s = Math.ceil((Math.min(a0, a1) + 0.05) / 0.5) * 0.5; s < Math.max(b0, b1) - 0.05; s += 0.5) {
          let f0 = 0, f1 = 1;
          if (s < a0) f0 = Math.max(f0, (s - a0) / (a1 - a0)); if (s < a1) f1 = Math.min(f1, (s - a0) / (a1 - a0));
          if (s > b0) f0 = Math.max(f0, (s - b0) / (b1 - b0)); if (s > b1) f1 = Math.min(f1, (s - b0) / (b1 - b0));
          for (const [h0, h1, yt] of holes) if (s > h0 - 0.06 && s < h1 + 0.06) f0 = Math.max(f0, fz(yt));
          if (f1 - f0 > 0.03) B.cyl('roofshell', 'zincTrim', P3(s, f0), P3(s, f1), 0.016, 4);
        }
      }
      // interior lining (second floor), notched at the window openings
      const w2 = FLOORS.find(f => f.id === 'second').walls.find(w => w.a[0] === p[0] && w.a[1] === p[1] && w.b[0] === q[0] && w.b[1] === q[1]);
      const ln = (w2 ? w2.openings.filter(o => o.type !== 'slit') : []).map(o => [o.from, o.to, ((OPEN_H[o.type] || [0, 2.3])[1] + 6 - CORNICE_Y) / (8.7 - CORNICE_Y)]);
      slopePlane('second', 'wall', p, q, 0.15, 0.15 + (8.7 - CORNICE_Y) / TAN, CORNICE_Y, 8.7, ln, [proj(I0[i]), proj(I0[(i + 1) % n])], [proj(I1[i]), proj(I1[(i + 1) % n])], true);
      // gutter / cornice band
      const L = e.L;
      B.boxAlong('roofshell', 'zincTrim', p, q, proj(O0[i]) - 0.02, proj(O0[(i + 1) % n]) + 0.02, CORNICE_Y - 0.1, CORNICE_Y + 0.03, -0.24, -0.12);
      void L;
      // dormer interior reveals (triangles between the window plane and the sloped lining)
      for (const o of (w2 ? w2.openings.filter(o => o.type !== 'slit') : [])) {
        const ot = 6 + (OPEN_H[o.type] || [0, 2.3])[1];
        const dn = (ot - CORNICE_Y) / TAN;
        for (const s of [o.from, o.to]) {
          const tri = [[0.15, CORNICE_Y], [0.15, ot], [0.15 + dn, ot]];
          const sh = new THREE.Shape(tri.map(v => new THREE.Vector2(v[0], v[1])));
          const gg = NI(new THREE.ExtrudeGeometry(sh, { depth: 0.02, bevelEnabled: false }));
          const ps = gg.attributes.position;
          for (let k = 0; k < ps.count; k++) { const nn = ps.getX(k), yy = ps.getY(k), ss = s - 0.01 + ps.getZ(k); ps.setXYZ(k, p[0] + e.ux * ss + e.nx * nn, yy, p[1] + e.uz * ss + e.nz * nn); }
          gg.computeVertexNormals(); B.push('second', 'wall', gg);
          const fl = gg.clone(); const fp = fl.attributes.position;
          for (let k = 0; k < fp.count; k += 3) { const t = [fp.getX(k + 1), fp.getY(k + 1), fp.getZ(k + 1)]; fp.setXYZ(k + 1, fp.getX(k + 2), fp.getY(k + 2), fp.getZ(k + 2)); fp.setXYZ(k + 2, ...t); }
          fl.computeVertexNormals(); B.push('second', 'wall', fl);
        }
        B.boxAlong('second', 'wall', p, q, o.from, o.to, ot, ot + 0.01, -0.05, 0.15 + dn + 0.02);
      }
    }
    // party wall parapet above the roof & west gable coping
    B.boxAB('roofshell', 'zincTrim', -0.17, ROOF.y + 0.15, -0.17, 0.17, ROOF.y + 0.21, 14.87);
  }

  // ───────── brick stair tower ─────────
  function buildTower() {
    const g = 'roofshell', z1 = 14.85 + TOWER.proj, z0 = TOWER.z0, x1 = TOWER.x1 + 0.05;
    const [sx0, sx1] = TOWER.slit, [sy0, sy1] = TOWER.slitY, yb = -0.95, yt = TOWER.top;
    // front face (with slit)
    B.boxAB(g, 'brick', 0, yb, 14.55, sx0, yt, z1);
    B.boxAB(g, 'brick', sx1, yb, 14.55, x1, yt, z1);
    B.boxAB(g, 'brick', sx0, yb, 14.55, sx1, sy0, z1);
    B.boxAB(g, 'brick', sx0, sy1, 14.55, sx1, yt, z1);
    // east face and rear (above the roof)
    B.boxAB(g, 'brick', x1 - 0.2, 6.0, z0, x1, yt, 14.55);
    B.boxAB(g, 'brick', x1 - 0.2, yb, 14.55, x1, 6.0, 14.85);
    B.boxAB(g, 'brick', 0, 6.3, z0, x1, yt, z0 + 0.2);
    // cap (grey render band like the renders) + roof
    B.rboxAB(g, 'capGrey', -0.02, yt, z0 - 0.02, x1 + 0.03, yt + TOWER.cap, z1 + 0.03, 0.015);
    B.boxAB(g, 'zincTrim', 0.05, yt - 0.25, z0 + 0.2, x1 - 0.2, yt - 0.05, 14.55);
    // interior plaster face of the stairwell front
    B.boxAB(g, 'wall', 0.25, -2.7, 14.53, sx0, 6.0, 14.55);
    B.boxAB(g, 'wall', sx1, -2.7, 14.53, 2.75, 6.0, 14.55);
    B.boxAB(g, 'wall', sx0, -2.7, 14.53, sx1, sy0, 14.55);
    B.boxAB(g, 'wall', sx0, sy1, 14.53, sx1, 6.0, 14.55);
    // slit window: deep dark frame + glass
    B.boxAB(g, 'frame', sx0, sy0, 14.62, sx0 + 0.04, sy1, 14.72); B.boxAB(g, 'frame', sx1 - 0.04, sy0, 14.62, sx1, sy1, 14.72);
    B.boxAB(g, 'frame', sx0, sy0, 14.62, sx1, sy0 + 0.04, 14.72); B.boxAB(g, 'frame', sx0, sy1 - 0.04, 14.62, sx1, sy1, 14.72);
    for (const yy of [2.85, 5.85].filter(v => v < sy1)) B.boxAB(g, 'frame', sx0, yy - 0.02, 14.63, sx1, yy + 0.02, 14.71);
    for (const [fid, ya, yb2] of [['ground', sy0 + 0.03, 2.83], ['first', 2.87, sy1 - 0.03]]) {
      const f = FLOORS.find(v => v.id === fid); let tag = null;
      f.walls.forEach((w, wi) => { const oi = w.openings.findIndex(o => o.type === 'slit'); if (oi >= 0) tag = { floorId: fid, wallIndex: wi, openingIndex: oi, type: 'slit' }; });
      B.withTag(tag, () => B.boxAB(g, 'glass', sx0 + 0.03, ya, 14.665, sx1 - 0.03, yb2, 14.675));
    }
    B.boxAB(g, 'stoneFine', sx0 - 0.02, sy0 - 0.04, 14.62, sx1 + 0.02, sy0, z1 + 0.03);
  }

  // ───────── balconies ─────────
  function buildBalconies() {
    for (const b of BALCONIES) {
      if (b.deck) continue;
      const y = LEVEL_Y[b.level], gid = b.level;
      const xs = b.poly.map(p => p[0]), zs = b.poly.map(p => p[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
      const front = z0 >= 14.6; // street side
      const zo = front ? z1 : z0, zi = front ? Math.max(z0, 14.85) : Math.min(z1, -0.15);
      const za = Math.min(zo, zi), zb = Math.max(zo, zi);
      const th = b.dormer ? 0.3 : 0.34;
      B.rboxAB(gid, 'render', x0, y - th, za - (front ? 0.02 : 0), x1, y - 0.03, zb + (front ? 0 : 0.02), 0.03);
      // drip groove under the outer edge
      B.boxAB(gid, 'darkSteel', x0 + 0.08, y - th - 0.004, front ? zo - 0.06 : zo + 0.05, x1 - 0.08, y - th + 0.002, front ? zo - 0.05 : zo + 0.06);
      B.boxAB(gid, 'stoneFine', x0 + 0.02, y - 0.03, za + (front ? 0 : 0.02), x1 - 0.02, y - 0.012, zb - (front ? 0.02 : 0));
      // timber soffit + downlights
      B.boxAB(gid, 'oak', x0 + 0.06, y - th - 0.02, za + (front ? 0 : 0.06), x1 - 0.06, y - th, zb - (front ? 0.06 : 0));
      const n = Math.max(1, Math.round((x1 - x0) / 1.6));
      for (let i = 0; i < n; i++) downlight(gid, x0 + (x1 - x0) * (i + 0.5) / n, y - th - 0.02, (za + zb) / 2 + (front ? 0.2 : -0.2), 0.035);
      // frameless glass balustrade fixed to the slab edge
      const hh = 1.05, gz = front ? zo - 0.07 : zo + 0.07;
      B.boxAB(gid, 'railGlass', x0 + 0.07, y + 0.02, gz - 0.009, x1 - 0.07, y + hh, gz + 0.009);
      B.boxAB(gid, 'glassEdge', x0 + 0.07, y + hh, gz - 0.009, x1 - 0.07, y + hh + 0.004, gz + 0.009);
      B.boxAB(gid, 'steel', x0 + 0.06, y - 0.012, gz - 0.025, x1 - 0.06, y + 0.03, gz + 0.025);
      for (const xe of [x0 + 0.07, x1 - 0.07]) {
        B.boxAB(gid, 'glassEdge', xe - 0.009, y + hh, Math.min(gz, front ? 14.85 : -0.15), xe + 0.009, y + hh + 0.004, Math.max(gz, front ? 14.85 : -0.15));
        B.boxAB(gid, 'railGlass', xe - 0.009, y + 0.02, Math.min(gz, front ? 14.85 : -0.15), xe + 0.009, y + hh, Math.max(gz, front ? 14.85 : -0.15));
        B.boxAB(gid, 'steel', xe - 0.025, y - 0.012, Math.min(gz, front ? 14.85 : -0.15), xe + 0.025, y + 0.03, Math.max(gz, front ? 14.85 : -0.15));
      }
      if (b.id === '1.front') {
        B.boxAB(gid, 'ledWarm', 3.4, y - th - 0.024, 15.12, 7.1, y - th - 0.018, 15.16); // linear LED over the entrance path
        B.boxAB(gid, 'darkSteel', 3.4, y - th - 0.022, 15.08, 7.1, y - th - 0.019, 15.2);
      }
      if (b.split != null) B.boxAB(gid, 'frosted', b.split - 0.01, y, za, b.split + 0.01, y + 1.8, zb);
      if (b.planters) {
        for (const [a0, a1] of [[3.1, 5.5], [7.2, 9.9], [10.6, 13.1]]) {
          const pz0 = zo - 0.5, pz1 = zo - 0.14;
          B.rboxAB(gid, 'capGrey', a0, y - 0.01, pz0, a1, y + 0.42, pz1, 0.02);
          B.boxAB(gid, 'soil', a0 + 0.04, y + 0.36, pz0 + 0.04, a1 - 0.04, y + 0.4, pz1 - 0.04);
          plantBed(gid, a0 + 0.1, a1 - 0.1, pz0 + 0.1, pz1 - 0.1, y + 0.4, 0.55, 7 + Math.floor(a0 * 3));
        }
      }
    }
    // Juliet guard in the third front dormer (no balcony slab in data)
    const y2 = LEVEL_Y.second;
    B.boxAB('second', 'railGlass', 3.28, y2 + 0.05, 14.66, 6.18, y2 + 1.05, 14.68);
    B.boxAB('second', 'darkSteel', 3.28, y2, 14.64, 6.18, y2 + 0.06, 14.7);
  }

  // ───────── plants (stylised, merged) ─────────
  function bush(gid, x, y, z, r, mat = 'leaf', seed = 1) {
    const R = rng(seed);
    const n = 3 + Math.floor(R() * 3);
    for (let i = 0; i < n; i++) {
      const a = R() * Math.PI * 2, d = r * 0.45 * R();
      const rr = r * (0.5 + R() * 0.4);
      const g = NI(new THREE.IcosahedronGeometry(1, 1));
      const m = new THREE.Matrix4().compose(V3(x + Math.cos(a) * d, y + rr * 0.7, z + Math.sin(a) * d), new THREE.Quaternion().setFromEuler(new THREE.Euler(R(), R(), R())), V3(rr, rr * 0.75, rr));
      g.applyMatrix4(m); jitter(g, 0.12 * rr, R); B.push(gid, mat, g);
    }
  }
  function jitter(g, amt, R) { const p = g.attributes.position; const map = new Map(); for (let i = 0; i < p.count; i++) { const k = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`; if (!map.has(k)) map.set(k, [(R() - 0.5) * amt, (R() - 0.5) * amt, (R() - 0.5) * amt]); const d = map.get(k); p.setXYZ(i, p.getX(i) + d[0], p.getY(i) + d[1], p.getZ(i) + d[2]); } g.computeVertexNormals(); }
  function grassClump(gid, x, y, z, h, seed, mat = 'grass') {
    // arching blades: 3-segment tapered ribbons, two tones
    const R = rng(seed); const n = 16;
    for (let i = 0; i < n; i++) {
      const a = R() * Math.PI * 2, hh = h * (0.55 + R() * 0.55), w0 = 0.018 + R() * 0.01, arch = 0.25 + R() * 0.5;
      const dx = Math.cos(a), dz = Math.sin(a), px = -dz, pz = dx;
      const pts = [];
      for (let k = 0; k <= 3; k++) {
        const t = k / 3, r = arch * hh * t * t, yy = y + hh * (t - 0.35 * arch * t * t), w = w0 * (1 - t * 0.92);
        const cx = x + dx * (r + 0.02), cz = z + dz * (r + 0.02);
        pts.push([cx - px * w, yy, cz - pz * w], [cx + px * w, yy, cz + pz * w]);
      }
      const v = [];
      for (let k = 0; k < 3; k++) { const [p0, p1, p2, p3] = [pts[2 * k], pts[2 * k + 1], pts[2 * k + 2], pts[2 * k + 3]]; v.push(...p0, ...p1, ...p3, ...p0, ...p3, ...p2); }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3)); g.computeVertexNormals();
      B.push(gid, R() < 0.3 ? 'grassDry' : mat, g);
    }
  }
  function plantBed(gid, x0, x1, z0, z1, y, h, seed) {
    const R = rng(seed);
    const area = (x1 - x0) * (z1 - z0), n = Math.max(4, Math.round(area * 11));
    for (let i = 0; i < n; i++) {
      const x = x0 + R() * (x1 - x0), z = z0 + R() * (z1 - z0);
      const k = R();
      if (k < 0.55) grassClump(gid, x, y, z, h * (0.7 + R() * 0.6), seed * 31 + i);
      else if (k < 0.85) bush(gid, x, y - 0.05, z, 0.14 + R() * 0.16, R() < 0.5 ? 'leaf' : 'olive', seed * 17 + i);
      else bush(gid, x, y - 0.05, z, 0.1 + R() * 0.08, 'ivy', seed * 13 + i);
    }
  }
  function tree(gid, x, y, z, h, seed) {
    // multi-stem olive: tapered, twisting limbs + many small silver-green leaf clusters
    const R = rng(seed);
    const limb = (p, dir, len, r0, depth) => {
      const segs = 4; let cur = p.slice(), d = dir.slice(), r = r0;
      for (let s2 = 0; s2 < segs; s2++) {
        d = [d[0] + (R() - 0.5) * 0.5, d[1] + 0.15, d[2] + (R() - 0.5) * 0.5]; const l = Math.hypot(...d); d = d.map(v => v / l);
        const nxt = [cur[0] + d[0] * len / segs, cur[1] + d[1] * len / segs, cur[2] + d[2] * len / segs];
        B.cyl(gid, 'trunk', cur, nxt, r * 0.8, 7, r); cur = nxt; r *= 0.8;
      }
      if (depth > 0) for (let k = 0; k < 2; k++) limb(cur, [d[0] + (R() - 0.5) * 1.4, d[1], d[2] + (R() - 0.5) * 1.4], len * 0.55, r, depth - 1);
      else canopyAt(cur);
    };
    const canopyAt = (c) => {
      for (let i = 0; i < 7; i++) {
        const rr = 0.13 + R() * 0.13;
        const g = NI(new THREE.IcosahedronGeometry(1, 1));
        g.applyMatrix4(new THREE.Matrix4().compose(V3(c[0] + (R() - 0.5) * 0.7, c[1] + (R() - 0.3) * 0.35, c[2] + (R() - 0.5) * 0.7), new THREE.Quaternion().setFromEuler(new THREE.Euler(R(), R(), R())), V3(rr, rr * 0.7, rr)));
        jitter(g, 0.35 * rr, R); B.push(gid, R() < 0.45 ? 'oliveLight' : 'olive', g);
      }
    };
    B.cyl(gid, 'trunk', [x, y - 0.05, z], [x, y + 0.25, z], 0.085, 8, 0.1);
    limb([x, y + 0.25, z], [-0.35, 1, 0.1], h * 0.55, 0.075, 1);
    limb([x, y + 0.25, z], [0.4, 1, -0.1], h * 0.6, 0.07, 1);
  }
  function ivyStrip(gid, x, z0, y0, y1, seed, nz) { // climbing ivy on the tower face
    const R = rng(seed);
    for (let y = y0; y < y1; y += 0.09) {
      const k = Math.sin(y * 2.3 + seed) * 0.12;
      for (let j = 0; j < 3; j++) {
        const r = 0.045 + R() * 0.045;
        const g = NI(new THREE.IcosahedronGeometry(1, 0));
        g.applyMatrix4(new THREE.Matrix4().compose(V3(x + k + (R() - 0.5) * 0.22, y + R() * 0.1, z0 + nz * (0.03 + R() * 0.05)), new THREE.Quaternion().setFromEuler(new THREE.Euler(R() * 3, R() * 3, 0)), V3(r, r, r * 0.45)));
        B.push(gid, 'ivy', g);
      }
    }
  }

  // ───────── lot: front yard, ramp, garden ─────────
  function buildSite() {
    const g = 'site', zK = LOT.zFront, yS = STREET_Y;
    // front yard slab (entrance terrace) – from façade to kerb, x 0..~10.4
    // path: slopes gently (8%) from street to entrance
    const pathX = [3.45, 5.45];
    B.prismX(g, 'paving', [[14.7, -0.4], [14.7, -0.01], [15.5, -0.01], [zK, yS], [zK, yS - 0.4]], pathX[0], pathX[1]);
    B.prismX(g, 'gravel', [[z1Tower(), -1.1], [z1Tower(), yS - 0.02], [zK, yS - 0.04], [zK, -1.1]], LOT.x0, pathX[0]);
    B.prismX(g, 'gravel', [[14.7, -1.1], [14.7, -0.6], [zK, yS - 0.04], [zK, -1.1]], pathX[1], RAMP_X[0] - 0.15);
    const R0 = rng(777);
    const planter = (x0, x1, z0, z1, h, seed, treeAt) => {
      const yb = yS - 0.02, yt = yb + h, t = 0.12;
      B.rboxAB(g, 'render', x0, yb, z0, x1, yt, z0 + t, 0.015); B.rboxAB(g, 'render', x0, yb, z1 - t, x1, yt, z1, 0.015);
      B.rboxAB(g, 'render', x0, yb, z0, x0 + t, yt, z1, 0.015); B.rboxAB(g, 'render', x1 - t, yb, z0, x1, yt, z1, 0.015);
      B.rboxAB(g, 'stoneFine', x0 - 0.02, yt, z0 - 0.02, x1 + 0.02, yt + 0.04, z1 + 0.02, 0.012);
      // recessed step light towards the path
      if (x1 < 4) B.boxAB(g, 'downlight', x1 + 0.001, yb + 0.18, (z0 + z1) / 2 - 0.12, x1 + 0.006, yb + 0.23, (z0 + z1) / 2 + 0.12);
      else if (x0 > 5) B.boxAB(g, 'downlight', x0 - 0.006, yb + 0.18, (z0 + z1) / 2 - 0.12, x0 - 0.001, yb + 0.23, (z0 + z1) / 2 + 0.12);
      B.boxAB(g, 'soil', x0 + t, yt - 0.12, z0 + t, x1 - t, yt - 0.06, z1 - t);
      for (let k = 0; k < (x1 - x0) * (z1 - z0) * 40; k++) { const r = 0.02 + R0() * 0.025; B.box(g, 'pebble', x0 + t + 0.03 + R0() * (x1 - x0 - 2 * t - 0.06), yt - 0.065, z0 + t + 0.03 + R0() * (z1 - z0 - 2 * t - 0.06), r * 1.4, r * 0.6, r, R0() * 3); }
      plantBed(g, x0 + 0.2, x1 - 0.2, z0 + 0.2, z1 - 0.2, yt - 0.08, 0.7, seed);
      if (treeAt) tree(g, treeAt[0], yt - 0.08, treeAt[1], 3.0, seed + 99);
      const R = rng(seed + 5);
      for (let x = x0 + 0.3; x < x1 - 0.2; x += 0.55 + R() * 0.4) { const len = 0.15 + R() * 0.4; for (let yy = 0; yy < len; yy += 0.05) { const r = 0.03 + R() * 0.03; const gg = NI(new THREE.IcosahedronGeometry(1, 0)); gg.applyMatrix4(new THREE.Matrix4().compose(V3(x + (R() - 0.5) * 0.12, yt + 0.02 - yy, z1 + 0.02 + R() * 0.03), new THREE.Quaternion().setFromEuler(new THREE.Euler(R() * 3, R() * 3, 0)), V3(r, r, r * 0.5))); B.push(g, 'ivy', gg); } }
    };
    planter(LOT.x0 + 0.05, pathX[0] - 0.1, 15.95, 17.2, 0.7, 21, null);
    planter(pathX[1] + 0.12, RAMP_X[0] - 0.3, 15.45, 17.2, 0.95, 41, [7.9, 16.3]);
    // bed at the foot of the tower
    B.boxAB(g, 'soil', 0.05, yS - 0.05, z1Tower(), 2.9, yS + 0.05, z1Tower() + 0.6);
    plantBed(g, 0.1, 2.85, z1Tower() + 0.05, z1Tower() + 0.55, yS + 0.05, 0.6, 51);
    // climbing ivy on the tower
    ivyStrip(g, 0.6, z1Tower(), yS, 6.2, 3, 1);
    ivyStrip(g, 2.25, z1Tower(), yS, 7.2, 5, 1);
    // ramp surface with anti-slip grooves (15 %), ending where it meets the basement floor
    const zR0 = Math.max(RAMP.zBottom, 16.9 - ((RAMP.yTop - 0.5 * 0.04) - RAMP.yBottom) / RAMP.slope);
    const nz = 26, ramp = [];
    for (let i = 0; i <= nz; i++) { const z = zR0 + (zK - zR0) * i / nz; ramp.push([z, rampY(z)]); }
    const prof = [...ramp, [zK, -3.2], [zR0, -3.2]];
    B.prismX(g, 'concrete', prof, RAMP_X[0], RAMP_X[1]);
    for (let z = zR0 + 0.4; z < 16.75; z += 0.3) { const y = rampY(z); B.box(g, 'darkSteel', (RAMP_X[0] + RAMP_X[1]) / 2, y + 0.003, z, RAMP_X[1] - RAMP_X[0] - 0.5, 0.012, 0.1, 0, -Math.atan(RAMP.slope)); }
    // kerbs both sides (interrupted at the door line)
    const kerbProf = (za, zb) => { const n = Math.max(2, Math.ceil((zb - za) / 0.6)); const lo = [], hi = []; for (let i = 0; i <= n; i++) { const z = za + (zb - za) * i / n; lo.push([z, rampY(z) - 0.02]); hi.push([z, rampY(z) + 0.1]); } return [...lo, ...hi.reverse()]; };
    const kW = [RAMP_X[0], RAMP_X[0] + 0.14], kE = [RAMP_X[1] - 0.14, RAMP_X[1]];
    for (const [za, zb, xs] of [[6.2, 14.45, kW], [15.0, zK - 0.35, kW], [zR0 + 0.3, 14.45, kE], [15.0, zK - 0.35, kE]]) B.prismX(g, 'kerb', kerbProf(za, zb), xs[0], xs[1]);
    // drainage channels: foot of the ramp and behind the pavement
    for (const zc of [zR0 + 0.12, 17.02]) {
      const y = zc < 10 ? RAMP.yBottom : rampY(zc);
      B.boxAB(g, 'darkSteel', RAMP_X[0] + 0.16, y + 0.001, zc - 0.09, RAMP_X[1] - 0.16, y + 0.005, zc + 0.09);
      for (let x = RAMP_X[0] + 0.2; x < RAMP_X[1] - 0.22; x += 0.09) B.boxAB(g, 'galv', x, y + 0.005, zc - 0.085, x + 0.045, y + 0.011, zc + 0.085);
    }
    // ramp side walls: west retaining wall (stops short of the foot so cars can turn into the aisle), outside it steps down with the ramp
    const wallTop = (z) => Math.min(yS + 1.0, rampY(z) + 1.0);
    const wp = [[6.2, 0], [14.7, 0]]; for (let i = 0; i <= 8; i++) { const z = 14.7 + (zK - 14.7) * i / 8; wp.push([z, wallTop(z)]); }
    B.prismX(g, 'render', [[6.2, -2.7], ...wp, [zK, -2.7]], 10.3, RAMP_X[0]);
    B.boxAB(g, 'hazard', 10.28, -2.7, 6.08, RAMP_X[0] + 0.02, -1.6, 6.2);
    // low-level wall lights along the ramp
    for (const z of [7.6, 10.0, 12.4, 15.5, 16.6]) {
      const y = rampY(z) + (z > 14.7 ? 0.42 : 1.25);
      for (const [x, sg] of [[RAMP_X[0], 1], [RAMP_X[1], -1]]) {
        if (z > 14.7 && sg < 0) { B.boxAB(g, 'ledWarm', x - 0.006, y, z - 0.1, x, y + 0.04, z + 0.1); continue; }
        B.boxAB(g, 'darkSteel', Math.min(x, x + sg * 0.05), y, z - 0.11, Math.max(x, x + sg * 0.05), y + 0.07, z + 0.11);
        B.boxAB(g, 'ledWarm', Math.min(x + sg * 0.005, x + sg * 0.045), y - 0.005, z - 0.09, Math.max(x + sg * 0.005, x + sg * 0.045), y, z + 0.09);
      }
    }
    // east boundary wall with grey coping (right side in the renders), outside the footprint
    B.boxAB(g, 'render', RAMP_X[1], yS - 0.6, 14.85, 14.2, yS + 1.55, zK);
    B.boxAB(g, 'capGrey', RAMP_X[1] - 0.012, yS + 1.05, 14.85, RAMP_X[1], yS + 1.55, zK - 0.3);
    B.boxAB(g, 'stoneFine', RAMP_X[1] - 0.02, yS + 1.55, 14.85, 14.22, yS + 1.6, zK);
    // street pavement edge strip inside the lot (kerb line)
    B.boxAB(g, 'stoneFine', LOT.x0, yS - 0.15, zK - 0.06, RAMP_X[0] - 0.2, yS + 0.02, zK);
    // ── street entrance: stone landing, mat well, cube planters, canopy with LED, intercom, illuminated number ──
    B.rboxAB(g, 'stoneFine', 2.96, -0.42, 14.86, 6.3, -0.004, 15.5, 0.01);
    B.boxAB(g, 'steel', 3.83, -0.004, 14.93, 5.07, 0.002, 15.47);
    B.boxAB(g, 'rubber', 3.85, -0.004, 14.95, 5.05, 0.007, 15.45);
    for (let z = 14.99; z < 15.44; z += 0.05) B.boxAB(g, 'darkSteel', 3.86, 0.007, z, 5.04, 0.01, z + 0.012);
    for (const [x0, sd] of [[3.02, 301], [5.8, 302]]) {
      B.rboxAB(g, 'planterDark', x0, -0.004, 14.9, x0 + 0.42, 0.52, 15.32, 0.012);
      B.boxAB(g, 'soil', x0 + 0.03, 0.47, 14.93, x0 + 0.39, 0.5, 15.29);
      bush(g, x0 + 0.21, 0.44, 15.11, 0.3, 'leaf', sd);
    }
    const eg = 'ground';
    B.boxAB(eg, 'bronze', 3.4, 2.5, 14.85, 5.46, 2.56, 15.95);
    B.boxAB(eg, 'bronze', 3.4, 2.44, 15.91, 5.46, 2.5, 15.95);
    B.boxAB(eg, 'bronze', 3.4, 2.44, 14.85, 3.44, 2.5, 15.91); B.boxAB(eg, 'bronze', 5.42, 2.44, 14.85, 5.46, 2.5, 15.91);
    B.boxAB(eg, 'oak', 3.44, 2.492, 14.86, 5.42, 2.5, 15.91);
    B.boxAB(eg, 'ledWarm', 3.5, 2.484, 15.84, 5.36, 2.492, 15.87);
    for (const x of [4.0, 4.86]) downlight(eg, x, 2.492, 15.3, 0.04);
    // video intercom
    { const ic = new THREE.Group(); ic.name = 'intercom'; ic.position.set(5.415, 1.42, 14.85);
      const btn = []; for (let r = 0; r < 4; r++) for (let c = 0; c < 2; c++) btn.push([-0.03 + c * 0.06, -0.1925 + r * 0.045, 0.025, 0.04, 0.025, 0.006]);
      const plate = new THREE.Mesh(boxesGeo([[0, 0, 0.011, 0.17, 0.48, 0.022], ...btn]), M.steel); plate.name = 'intercom-plate'; plate.receiveShadow = true;
      const cam = NI(new THREE.CylinderGeometry(0.021, 0.021, 0.012, 14)); cam.rotateX(Math.PI / 2); cam.translate(0, 0.19, 0.028);
      const bars = []; for (let i = 0; i < 3; i++) bars.push([0, 0.1375 + i * 0.012, 0.023, 0.08, 0.005, 0.002]);
      const bits = new THREE.Mesh(mergeGeometries([cam, boxesGeo(bars)], false), M.black); bits.name = 'intercom-camera';
      const sm = new THREE.MeshStandardMaterial({ color: 0x0b0e12, emissive: 0x9fd0ff, emissiveIntensity: 0, roughness: 0.15, metalness: 0.3 }); sm.name = 'led-strip-emissive:screen';
      const scr = new THREE.Mesh(new THREE.BoxGeometry(0.126, 0.11, 0.004), sm); scr.position.set(0, 0.055, 0.024); scr.name = 'intercom-screen';
      ic.add(plate, bits, scr); G[eg + '-det'].add(ic);
      mkToggle(ic, { id: 'intercom', kind: 'intercom', sound: 'click', range: 3, open: LBL.bell, speed: 5, auto: 5, ease: false, apply: (t) => { sm.emissiveIntensity = 2.6 * t; } });
    }
    // illuminated house number
    B.boxAB(eg, 'ledWarm', 5.735, 1.565, 14.851, 6.665, 2.135, 14.858);
    B.boxAB(eg, 'bronze', 5.75, 1.58, 14.85, 6.65, 2.12, 14.88);
    label(eg, '6', 5.97, 1.85, 14.883, 0, 0.36, 0.44, { bg: null, fg: '#fff0d6', glow: 2.2, pw: 256, font: '300 250px Georgia, "Times New Roman", serif' }).name = 'house-number';
    label(eg, 'VILNYI', 6.36, 1.93, 14.883, 0, 0.44, 0.12, { bg: null, fg: '#fff0d6', glow: 1.6, pw: 512, font: '400 100px Georgia, "Times New Roman", serif' });
    label(eg, 'Rua Eduardo Couto', 6.36, 1.76, 14.883, 0, 0.44, 0.06, { bg: null, fg: '#e8d9b8', glow: 1.0, pw: 512, font: '400 44px Helvetica, Arial, sans-serif' });
    // timber slat feature on the façade (lobby window screen)
    for (let x = 7.38; x < 8.78; x += 0.085) B.boxAB('ground', 'oak', x, 0.35, 14.86, x + 0.045, 2.55, 14.93);
    B.boxAB('ground', 'frame', 7.3, 0.3, 14.85, 8.86, 0.35, 14.95); B.boxAB('ground', 'frame', 7.3, 2.55, 14.85, 8.86, 2.6, 14.95);
    // ── rear garden ──
    const yG = -0.12;
    B.prismX(g, 'lawn', [[-7.9, yG - 0.02], [-7.9, yG], [-2.5, yG], [-2.5, yG - 0.02]], 0, 6.1);
    // 0.B garden follows the angled boundary
    const gb = [[6.1, -7.9], [9.5, -7.9], [11.47, -2.5], [6.1, -2.5]];
    B.slab(g, 'lawn', gb, yG - 0.02, yG);
    // decks (teak boards)
    for (const d of BALCONIES.filter(b => b.deck)) {
      const xs = d.poly.map(p => p[0]), zs = d.poly.map(p => p[1]);
      const x0 = Math.min(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
      const xAt = (z) => Math.min(Math.max(...xs), 12.2 + z * (2.7 / 7.9) - 0.25);
      const x1 = xAt(z0);
      B.slab(g, 'concrete', [[x0, z0], [xAt(z0), z0], [xAt(z1), z1], [x0, z1]], -0.3, -0.06);
      for (let z = z0 + 0.01; z < z1 - 0.01; z += 0.145) B.boxAB(g, 'teak', x0 + 0.01, -0.06, z, xAt(z) - 0.01, -0.015, Math.min(z + 0.135, z1 - 0.005));
      // deck downlights in the step
      for (let x = x0 + 0.6; x < x1; x += 1.4) B.boxAB(g, 'downlight', x, -0.1, z0 - 0.005, x + 0.12, -0.08, z0);
    }
    // timber fence between 0.A and 0.B (slatted)
    for (let z = -7.85; z < -0.05; z += 0.11) B.boxAB(g, 'teak', 6.06, yG, z, 6.14, yG + 1.6, z + 0.07);
    B.boxAB(g, 'darkSteel', 6.05, yG + 1.6, -7.9, 6.15, yG + 1.63, 0);
    // white boundary walls (rear + west + angled east)
    const bw = (a, b, h = 2.0) => { B.boxAlong(g, 'render', a, b, 0, Math.hypot(b[0] - a[0], b[1] - a[1]), yG - 0.2, yG + h, -0.2, 0); B.boxAlong(g, 'stoneFine', a, b, -0.02, Math.hypot(b[0] - a[0], b[1] - a[1]) + 0.02, yG + h, yG + h + 0.04, -0.23, 0.03); };
    bw([LOT.x0, -7.9], [9.5, -7.9]);
    bw([9.5, -7.9], [12.2, 0]);
    bw([LOT.x0, 0], [LOT.x0, -7.9]);
    // planting along the walls and small olive trees in each garden
    plantBed(g, 0.3, 5.8, -7.6, -7.0, yG, 0.9, 61);
    plantBed(g, 6.4, 8.0, -7.6, -7.0, yG, 0.9, 62);
    tree(g, 1.4, yG, -6.2, 3.4, 71);
    tree(g, 7.4, yG, -5.6, 3.0, 72);
    for (const [x, z, s] of [[4.6, -6.9, 81], [9.1, -3.4, 82], [0.8, -3.2, 83]]) bush(g, x, yG, z, 0.45, 'leaf', s);
  }
  const z1Tower = () => 14.85 + TOWER.proj;

  // ───────── basement car park ─────────
  // Cars: lofted side profile with wheel arches, tumblehome greenhouse, glazing, lights, mirrors, alloy wheels (~3k tris each, merged per material).
  const CAR_SPECS = {
    hatch: { L: 4.05, W: 1.76, H: 1.47, gc: 0.16, r: 0.31, fo: 0.82, wb: 2.55, hood: 0.9, belt: 0.97, cowl: 1.05, roofF: 1.8, roofR: 3.5, rearB: 3.93, deck: 1.02 },
    sedan: { L: 4.7, W: 1.82, H: 1.43, gc: 0.15, r: 0.33, fo: 0.9, wb: 2.8, hood: 0.88, belt: 0.95, cowl: 1.3, roofF: 2.05, roofR: 3.3, rearB: 4.0, deck: 0.99, trunk: true },
    suv: { L: 4.5, W: 1.88, H: 1.68, gc: 0.21, r: 0.37, fo: 0.9, wb: 2.7, hood: 1.06, belt: 1.13, cowl: 1.2, roofF: 1.9, roofR: 3.95, rearB: 4.36, deck: 1.2, rails: true },
    ev: { L: 4.65, W: 1.85, H: 1.44, gc: 0.15, r: 0.345, fo: 0.85, wb: 2.9, hood: 0.84, belt: 0.94, cowl: 1.12, roofF: 1.98, roofR: 3.05, rearB: 4.42, deck: 1.0, ev: true }
  };
  function carParts(sp, color) {
    const { L, W, H, gc, r } = sp, hl = L / 2, zOf = (d) => hl - d, cl = (v) => Math.max(0, Math.min(1, v));
    const zf = zOf(sp.fo), zr = zf - sp.wb, ra = r + 0.035, bs = 0.045, tw = 0.21;
    const zc = zOf(sp.cowl), zrf = zOf(sp.roofF), zrr = zOf(sp.roofR), zrb = zOf(sp.rearB);
    const parts = []; const add = (g, mat) => { g = NI(g); g.userData.keepUV = true; if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2)); parts.push({ g, mat }); return g; };
    const fx = (y, z, f0) => (f0 - 0.2 * cl((y - sp.belt) / (H - sp.belt))) * (1 - 0.1 * Math.pow(Math.abs(z) / hl, 3)) * (1 - 0.05 * Math.pow(cl((gc + 0.3 - y) / 0.3), 2));
    const warp = (g, f0 = 1) => { const p = g.attributes.position; for (let i = 0; i < p.count; i++) p.setX(i, p.getX(i) * fx(p.getY(i), p.getZ(i), f0)); return g; };
    const ext = (pts, width) => { const d = width - 2 * bs; const g = new THREE.ExtrudeGeometry(new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(z, y))), { depth: d, bevelEnabled: true, bevelSize: bs, bevelThickness: bs, bevelOffset: -bs, bevelSegments: 3, curveSegments: 1 }); g.translate(0, 0, -d / 2); g.rotateY(-Math.PI / 2); return g; };
    const paint = (g, f0) => { warp(g, f0); let c = g; try { c = toCreasedNormals(g, 0.7); } catch (e) { c = NI(g); c.computeVertexNormals(); } const col = new THREE.Color(color), n = c.attributes.position.count, a = new Float32Array(n * 3); for (let i = 0; i < n; i++) { a[3 * i] = col.r; a[3 * i + 1] = col.g; a[3 * i + 2] = col.b; } c.setAttribute('color', new THREE.BufferAttribute(a, 3)); return add(c, 'carPaint'); };
    const arch = (z0) => { const a0 = Math.asin((gc - r) / ra), out = [], n = 8; for (let i = 0; i <= n; i++) { const a = Math.PI - a0 - (Math.PI - 2 * a0) * i / n; out.push([z0 + ra * Math.cos(a), r + ra * Math.sin(a)]); } return out; };
    // lower body
    const body = [[hl - 0.1, gc], [hl - 0.02, gc + 0.07], [hl, gc + 0.18], [hl, sp.hood - 0.24], [hl - 0.025, sp.hood - 0.12], [hl - 0.09, sp.hood - 0.04], [hl - 0.26, sp.hood], [hl - 0.26 + ((hl + zc) / 2 - hl + 0.26) * 0.5, sp.hood + (sp.belt - sp.hood) * 0.36], [(hl + zc) / 2, sp.hood + (sp.belt - sp.hood) * 0.62], [zc + 0.05, sp.belt], [zrb, sp.deck]];
    if (sp.trunk) body.push([-hl + 0.16, sp.deck - 0.015]);
    body.push([-hl + 0.05, sp.deck - 0.07], [-hl + 0.01, sp.deck - 0.2], [-hl, gc + 0.36], [-hl + 0.03, gc + 0.1], [-hl + 0.1, gc], ...arch(zr), ...arch(zf));
    paint(ext(body, W), 1);
    // greenhouse (tumblehome)
    const roofArc = []; for (let i = 0; i <= 6; i++) { const u = i / 6; roofArc.push([zrf + (zrr - zrf) * u, H - 0.035 - 0.01 * u + 0.04 * Math.sin(Math.PI * u)]); }
    const gh = [[zc + 0.05, sp.belt - 0.03], [zc + 0.05 + (zrf - zc - 0.05) * 0.9, sp.belt - 0.03 + (H - 0.035 - sp.belt + 0.03) * 0.93], ...roofArc, [zrr + (zrb + 0.02 - zrr) * 0.1, H - 0.045 + (sp.deck - 0.03 - H + 0.045) * 0.07], [zrb + 0.02, sp.deck - 0.03]];
    paint(ext(gh, W), 0.965);
    // wheel wells / underbody
    add(new THREE.BoxGeometry(W - 0.5, sp.belt - 0.2 - gc, L - 0.5).translate(0, (sp.belt - 0.2 + gc) / 2 + 0.01, 0), 'carTrim');
    // side glazing + B pillar
    const k = (H - 0.11 - sp.belt - 0.06) / (H - 0.045 - sp.deck);
    const sw = [[zc - 0.1, sp.belt + 0.05], [zrf - 0.1, H - 0.1], [zrr + 0.14, H - 0.11], [zrr + (zrb - zrr) * k + 0.16, sp.belt + 0.06]];
    const zb = zrf * 0.42 + zrr * 0.58;
    for (const sg of [-1, 1]) {
      const g = NI(new THREE.ShapeGeometry(new THREE.Shape(sw.map(([z, y]) => new THREE.Vector2(z, y)))));
      const p = g.attributes.position; for (let i = 0; i < p.count; i++) { const z = p.getX(i), y = p.getY(i); p.setXYZ(i, sg * (W / 2 + 0.004), y, z); }
      if (sg > 0) { for (let i = 0; i < p.count; i += 3) { const t = [p.getX(i + 1), p.getY(i + 1), p.getZ(i + 1)]; p.setXYZ(i + 1, p.getX(i + 2), p.getY(i + 2), p.getZ(i + 2)); p.setXYZ(i + 2, ...t); } }
      warp(g, 0.965); g.computeVertexNormals();
      { const nn = g.attributes.normal; if (nn.getX(0) * sg < 0) { for (let i = 0; i < p.count; i += 3) { const t = [p.getX(i + 1), p.getY(i + 1), p.getZ(i + 1)]; p.setXYZ(i + 1, p.getX(i + 2), p.getY(i + 2), p.getZ(i + 2)); p.setXYZ(i + 2, ...t); } g.computeVertexNormals(); } }
      add(g, 'carGlass');
      add(warp(NI(new THREE.BoxGeometry(0.006, H - 0.2 - sp.belt, 0.075)).translate(sg * (W / 2 + 0.006), (H - 0.1 + sp.belt + 0.04) / 2, zb), 0.965), 'carTrim');
      // door shut lines, handles, mirror, sill
      for (const z of [zc - 0.12, zb - 0.02, zrr + (sp.trunk ? 0.45 : 0.3)]) add(warp(NI(new THREE.BoxGeometry(0.004, sp.belt - gc - 0.2, 0.012)).translate(sg * (W / 2 + 0.001), (sp.belt + gc) / 2 + 0.05, z)), 'carTrim');
      for (const z of [zb + 0.2, zrr + (sp.trunk ? 0.6 : 0.45)]) add(warp(NI(new THREE.BoxGeometry(0.02, 0.025, 0.14)).translate(sg * (W / 2 + 0.006), sp.belt - 0.1, z)), 'alloy');
      add(new THREE.BoxGeometry(0.16, 0.09, 0.08).translate(sg * (W / 2 * 0.95 + 0.07), sp.belt + 0.09, zc - 0.14), 'carTrim');
      add(warp(NI(new THREE.BoxGeometry(0.014, sp.rails ? 0.16 : 0.07, sp.wb - 2 * ra - 0.16)).translate(sg * (W / 2 + 0.004), gc + (sp.rails ? 0.1 : 0.05), (zf + zr) / 2)), 'carTrim');
      if (sp.rails) add(new THREE.BoxGeometry(0.04, 0.035, (zrf - zrr) * 0.82).translate(sg * W * 0.335, H + 0.012, (zrf + zrr) / 2), 'carTrim');
      // lights
      if (!sp.ev) { add(new THREE.BoxGeometry(0.4, 0.1, 0.06).translate(sg * (W / 2 - 0.4), sp.hood - 0.15, hl - 0.022), 'headLight'); add(new THREE.BoxGeometry(0.34, 0.11, 0.05).translate(sg * (W / 2 - 0.38), sp.deck - 0.19, -hl + 0.02), 'tailLight'); }
      // wheels
      for (const z of [zf, zr]) {
        const x = sg * (W / 2 - tw / 2 - 0.025);
        const ty = NI(new THREE.LatheGeometry([[r * 0.6, -tw / 2], [r * 0.92, -tw / 2], [r, -tw / 2 + 0.035], [r, tw / 2 - 0.035], [r * 0.92, tw / 2], [r * 0.6, tw / 2]].map(([a, b]) => new THREE.Vector2(a, b)), 18)); ty.rotateZ(Math.PI / 2); ty.translate(x, r, z); add(ty, 'tyre');
        add(new THREE.CylinderGeometry(r * 0.63, r * 0.63, tw * 0.86, 16).rotateZ(Math.PI / 2).translate(x, r, z), 'alloy');
        add(new THREE.CylinderGeometry(r * 0.56, r * 0.56, tw * 0.9, 16).rotateZ(Math.PI / 2).translate(x, r, z), 'carTrim');
        add(new THREE.CylinderGeometry(r * 0.16, r * 0.16, tw * 0.98, 10).rotateZ(Math.PI / 2).translate(x, r, z), 'alloy');
        for (let s = 0; s < 5; s++) add(new THREE.BoxGeometry(0.02, r * 0.58, 0.05).translate(0, r * 0.3, 0).rotateX(s * Math.PI * 2 / 5 + 0.3).translate(x + sg * (tw * 0.45 + 0.008), r, z), 'alloy');
      }
    }
    // windscreen + rear screen
    const screen = (A, Bp, s0, s1, inset, sgn = 1) => {
      const dz = Bp[0] - A[0], dy = Bp[1] - A[1], len = Math.hypot(dz, dy), nz = sgn * dy / len, ny = -sgn * dz / len, off = 0.012;
      const P = (s) => [A[0] + dz * s + nz * off, A[1] + dy * s + ny * off];
      const a = P(s0), b = P(s1), ha = W / 2 * fx(a[1], a[0], 0.965) - inset, hb = W / 2 * fx(b[1], b[0], 0.965) - inset;
      const v = [-ha, a[1], a[0], ha, a[1], a[0], hb, b[1], b[0], -ha, a[1], a[0], hb, b[1], b[0], -hb, b[1], b[0]];
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3)); g.computeVertexNormals();
      const n = g.attributes.normal; if (n.getY(0) * ny + n.getZ(0) * nz < 0) { const p = g.attributes.position; for (let i = 0; i < 6; i += 3) { const t = [p.getX(i + 1), p.getY(i + 1), p.getZ(i + 1)]; p.setXYZ(i + 1, p.getX(i + 2), p.getY(i + 2), p.getZ(i + 2)); p.setXYZ(i + 2, ...t); } g.computeVertexNormals(); }
      add(g, 'carGlass');
    };
    screen(gh[0], gh[1], 0.1, 0.97, 0.1);
    screen(gh[gh.length - 1], gh[gh.length - 2], 0.12, 0.96, 0.11, -1);
    // front / rear details
    if (sp.ev) {
      add(new THREE.BoxGeometry(W * 0.8, 0.035, 0.08).translate(0, sp.hood - 0.1, hl - 0.02), 'headLight');
      add(new THREE.BoxGeometry(W * 0.82, 0.04, 0.08).translate(0, sp.deck - 0.15, -hl + 0.02), 'tailLight');
      add(new THREE.BoxGeometry(W * 0.5, 0.08, 0.06).translate(0, gc + 0.16, hl - 0.012), 'carTrim');
    } else add(new THREE.BoxGeometry(W * 0.56, 0.22, 0.06).translate(0, gc + 0.3, hl - 0.012), 'carTrim');
    add(new THREE.BoxGeometry(0.46, 0.11, 0.012).translate(0, gc + (sp.ev ? 0.34 : 0.3), hl + 0.022), 'carPlate');
    add(new THREE.BoxGeometry(0.46, 0.11, 0.012).translate(0, sp.deck - 0.36, -hl - 0.004), 'carPlate');
    add(new THREE.BoxGeometry(W * 0.7, 0.1, 0.05).translate(0, gc + 0.08, -hl + 0.02), 'carTrim');
    return { parts, zf, zr, port: [-(W / 2 + 0.012), sp.belt - 0.14, zr - 0.5] };
  }

  function buildBasement() {
    const y = LEVEL_Y.basement, gid = 'basement-int', ceil = y + 2.4;
    if (!M.pathPaint) { M.pathPaint = new THREE.MeshStandardMaterial({ color: 0x4d8467, roughness: 0.7 }); M.pathPaint.name = 'paint-green'; }
    const line = (a0, b0, a1, b1, m = 'white', h = 0.005) => B.boxAB(gid, m, Math.min(a0, a1), y + 0.001, Math.min(b0, b1), Math.max(a0, a1), y + h, Math.max(b0, b1));
    const plan = { P1: ['sedan', 0x2b2e33, 1], P2: ['ev', 0xe4e3de, -1], P3: ['suv', 0x5d6a73, 1], P4: ['hatch', 0x6e2424, -1], P5: ['hatch', 0x8a9399, 1], P6: ['sedan', 0x1f2f47, 1], P7: ['suv', 0xb5ac98, 1], P8: ['hatch', 0x33483a, -1] };
    const chargers = new Set(['P1', 'P2', 'P3', 'P7']);
    const zWall = 14.7 - 0.175;
    const evBody = NI(new RoundedBoxGeometry(0.28, 0.44, 0.124, 2, 0.02)); evBody.translate(0, 0, 0.062);
    const evFace = (() => { const scr = NI(new THREE.BoxGeometry(0.16, 0.22, 0.004)); scr.translate(0, 0.05, 0.126); const hook = NI(new THREE.TorusGeometry(0.11, 0.012, 6, 16)); hook.translate(0, -0.38, 0.03); return mergeGeometries([scr, hook], false); })();
    const evLed = new THREE.BoxGeometry(0.12, 0.012, 0.003);
    const evCharger = (id, cx, cy, cz, ry) => {
      const g = new THREE.Group(); g.name = `ev-charger-${id}`; g.position.set(cx, cy, cz); g.rotation.y = ry;
      const lm = new THREE.MeshStandardMaterial({ color: 0x9dffb0, emissive: 0x2cff6a, emissiveIntensity: 3, roughness: 0.4 }); lm.name = 'led-strip-emissive:ev';
      const body = new THREE.Mesh(evBody, M.evWhite), face = new THREE.Mesh(evFace, M.black), led = new THREE.Mesh(evLed, lm); led.position.set(0, 0.135, 0.129);
      body.receiveShadow = true; g.add(body, face, led); G[gid].add(g);
      mkToggle(g, { id: 'ev-charger-' + id, kind: 'ev-charger', sound: 'click', range: 3, open: LBL.evO, close: LBL.evC, speed: 4, ease: false, apply: (t) => { lm.emissive.setRGB(0.17 * (1 - t) + 0.1 * t, 1 - 0.55 * t, 0.42 * (1 - t) + 1.0 * t); lm.color.setRGB(0.6, 1 - 0.3 * t, 0.7 + 0.3 * t); } });
    };
    for (const p of PARKING) {
      const { x0, x1, z0, z1 } = p, rot = !!p.rotated, mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
      // bay lines (sides + corner ticks at the open end) and floor number
      if (!rot) { line(x0, z0 - 0.05, x1, z0 + 0.05); line(x0, z1 - 0.05, x1, z1 + 0.05); }
      else { line(x0 - 0.05, z0, x0 + 0.05, z1); line(x1 - 0.05, z0, x1 + 0.05, z1); }
      const fo = { flat: true, bg: null, fg: '#f4f4f0', pw: 256, font: '700 92px Helvetica, Arial, sans-serif' };
      if (!rot) label(gid, p.id, x1 + 0.42, y + 0.008, mz, 0, 0.9, 0.45, { ...fo, rz: Math.PI / 2 }).name = `bay-${p.id}`;
      else if (p.id === 'P5') label(gid, p.id, x1 + 0.5, y + 0.008, mz, 0, 0.9, 0.45, { ...fo, rz: Math.PI / 2 }).name = `bay-${p.id}`;
      else label(gid, p.id, mx, y + 0.008, z0 - 0.4, 0, 0.9, 0.45, { ...fo, rz: Math.PI }).name = `bay-${p.id}`;
      // wheel stop + wall plate with the apartment
      const headZ = p.id === 'P5' ? 8.9 : zWall;
      if (!rot) { B.rboxAB(gid, 'rubber', x0 + 0.75, y, mz - 0.85, x0 + 0.9, y + 0.1, mz + 0.85, 0.02); for (const dz of [-0.5, 0.5]) B.boxAB(gid, 'yellow', x0 + 0.748, y + 0.02, mz + dz - 0.12, x0 + 0.902, y + 0.102, mz + dz + 0.12); }
      else { B.rboxAB(gid, 'rubber', mx - 0.85, y, z1 - 0.7, mx + 0.85, y + 0.1, z1 - 0.55, 0.02); for (const dx of [-0.5, 0.5]) B.boxAB(gid, 'yellow', mx + dx - 0.12, y + 0.02, z1 - 0.702, mx + dx + 0.12, y + 0.102, z1 - 0.548); }
      const po = { bg: '#22262b', fg: '#f4f1ea', pw: 512, border: '#c9a35a', font: '600 78px Helvetica, Arial, sans-serif' };
      if (!rot) label(gid, `${p.id} · ${p.unit}`, 0.182, y + 1.85, mz, Math.PI / 2, 0.62, 0.2, po);
      else label(gid, `${p.id} · ${p.unit}`, p.id === 'P5' ? 5.0 : mx, y + 1.85, headZ - 0.007, Math.PI, 0.62, 0.2, po);
      // EV wall box
      let wb = null;
      if (chargers.has(p.id)) {
        if (!rot) { wb = [0.24, y + 1.2, mz + 0.8]; evCharger(p.id, 0.176, y + 1.2, mz + 0.8, Math.PI / 2); }
        else { wb = [mx + 0.8, y + 1.2, headZ - 0.06]; evCharger(p.id, mx + 0.8, y + 1.2, headZ, Math.PI); }
      }
      // car
      const [type, col, dir] = plan[p.id] || ['hatch', 0x888888, 1];
      const sp = CAR_SPECS[type], car = carParts(sp, col), m = new THREE.Matrix4();
      const ax = dir > 0 ? car.zf : -car.zr; // distance from the car centre to the axle that meets the wheel stop
      if (!rot) { m.makeRotationY(dir > 0 ? -Math.PI / 2 : Math.PI / 2); m.setPosition(x0 + 0.9 + sp.r + ax, y, mz); }
      else { m.makeRotationY(dir > 0 ? 0 : Math.PI); m.setPosition(mx, y, z1 - 0.7 - sp.r - ax); }
      for (const { g, mat } of car.parts) { g.applyMatrix4(m); B.push(gid, mat, g); }
      if (sp.ev && wb) { // plugged in: cable from the wall box to the charge port
        const port = V3(...car.port).applyMatrix4(m);
        const curve = new THREE.CatmullRomCurve3([V3(wb[0] + 0.06, wb[1] - 0.2, wb[2]), V3(wb[0] + 0.14, y + 0.5, wb[2] - 0.05), V3((wb[0] + port.x) / 2 + 0.05, y + 0.04, (wb[2] + port.z) / 2 + 0.25), V3(port.x, y + 0.45, port.z + 0.18), V3(port.x, port.y, port.z + 0.03)]);
        const tube = NI(new THREE.TubeGeometry(curve, 28, 0.012, 6, false)); tube.userData.keepUV = true; B.push(gid, 'black', tube);
        B.boxAB(gid, 'evWhite', port.x - 0.035, port.y - 0.035, port.z - 0.01, port.x + 0.035, port.y + 0.035, port.z + 0.06);
        B.boxAB(gid, 'ledGreen', port.x - 0.012, port.y + 0.036, port.z, port.x + 0.012, port.y + 0.04, port.z + 0.03);
      }
    }
    // columns with yellow/black guards
    const cols = [[5.6, -5.5], [5.6, -0.8], [5.6, 3.9], [5.6, 8.9], [8.2, 1.9]];
    for (const [x, z] of cols) {
      B.boxAB(gid, 'concrete', x - 0.15, y, z - 0.15, x + 0.15, ceil, z + 0.15);
      B.boxAB(gid, 'hazard', x - 0.165, y, z - 0.165, x + 0.165, y + 1.0, z + 0.165);
    }
    // CO sensors
    for (const [x, z] of [cols[1], cols[3], cols[4]]) { B.rboxAB(gid, 'evWhite', x + 0.15, y + 1.55, z - 0.06, x + 0.19, y + 1.71, z + 0.06, 0.008); B.boxAB(gid, 'ledGreen', x + 0.19, y + 1.68, z - 0.01, x + 0.192, y + 1.69, z + 0.01); B.boxAB(gid, 'black', x + 0.19, y + 1.58, z - 0.035, x + 0.192, y + 1.64, z + 0.035); }
    // ceiling: linear LED fittings along the aisle and over the bays
    for (let z = -6.5; z < 13; z += 3.0) { B.boxAB(gid, 'evWhite', 6.78, ceil - 0.05, z - 0.03, 8.22, ceil, z + 0.15); B.boxAB(gid, 'ledPanel', 6.8, ceil - 0.056, z, 8.2, ceil - 0.05, z + 0.12); }
    for (const p of PARKING.filter(p => !p.rotated)) { const mz = (p.z0 + p.z1) / 2; B.boxAB(gid, 'evWhite', 2.28, ceil - 0.05, mz - 0.09, 3.52, ceil, mz + 0.09); B.boxAB(gid, 'ledPanel', 2.3, ceil - 0.056, mz - 0.06, 3.5, ceil - 0.05, mz + 0.06); }
    for (const p of PARKING.filter(p => p.rotated)) { const mx = (p.x0 + p.x1) / 2, mz = (p.z0 + p.z1) / 2; B.boxAB(gid, 'evWhite', mx - 0.09, ceil - 0.05, mz - 0.62, mx + 0.09, ceil, mz + 0.62); B.boxAB(gid, 'ledPanel', mx - 0.06, ceil - 0.056, mz - 0.6, mx + 0.06, ceil - 0.05, mz + 0.6); }
    // exposed services: sprinkler main + branches with heads, cable tray on hangers
    const yp = ceil - 0.16;
    B.cyl(gid, 'pipeRed', [6.45, yp, -7.3], [6.45, yp, 14.2], 0.036, 10);
    for (let z = -6.9; z < 14.2; z += 2.6) { B.cyl(gid, 'galv', [6.45, yp, z], [6.45, ceil, z], 0.005, 5); B.boxAB(gid, 'galv', 6.4, yp - 0.045, z - 0.012, 6.5, yp + 0.045, z + 0.012); }
    for (const z of [-6.1, -3.75, -1.4, 0.95, 3.3]) {
      B.cyl(gid, 'pipeRed', [6.45, yp, z], [1.2, yp, z], 0.018, 8);
      for (const x of [1.6, 3.9]) { B.cyl(gid, 'galv', [x, yp - 0.06, z], [x, yp, z], 0.012, 8); B.cyl(gid, 'galv', [x, yp - 0.07, z], [x, yp - 0.062, z], 0.03, 10); }
    }
    for (const z of [-4.0, 0.0, 5.0, 11.8]) { const xe = z > 9 ? 9.6 : 8.4; B.cyl(gid, 'pipeRed', [6.45, yp, z], [xe, yp, z], 0.018, 8); B.cyl(gid, 'galv', [xe - 0.3, yp - 0.06, z], [xe - 0.3, yp, z], 0.012, 8); B.cyl(gid, 'galv', [xe - 0.3, yp - 0.07, z], [xe - 0.3, yp - 0.062, z], 0.03, 10); }
    const yt = ceil - 0.34, tx0 = 8.75, tx1 = 9.05, tz0 = -2.4, tz1 = 9.2;
    B.boxAB(gid, 'galv', tx0, yt, tz0, tx1, yt + 0.012, tz1); B.boxAB(gid, 'galv', tx0, yt, tz0, tx0 + 0.012, yt + 0.06, tz1); B.boxAB(gid, 'galv', tx1 - 0.012, yt, tz0, tx1, yt + 0.06, tz1);
    for (let z = tz0 + 0.3; z < tz1; z += 1.8) { for (const x of [tx0 - 0.01, tx1 + 0.01]) B.cyl(gid, 'galv', [x, yt - 0.02, z], [x, ceil, z], 0.005, 5); B.boxAB(gid, 'galv', tx0 - 0.03, yt - 0.03, z - 0.015, tx1 + 0.03, yt, z + 0.015); }
    for (const [dx, rr] of [[0.06, 0.014], [0.11, 0.012], [0.16, 0.016], [0.22, 0.01]]) B.cyl(gid, 'black', [tx0 + dx, yt + 0.012 + rr, tz0 + 0.05], [tx0 + dx, yt + 0.012 + rr, tz1 - 0.05], rr, 6);
    // painted pedestrian route from the aisle to the lift lobby
    line(2.9, 4.1, 6.3, 4.66, 'pathPaint', 0.004); line(2.0, 4.1, 2.9, 7.0, 'pathPaint', 0.004);
    line(2.9, 4.08, 6.3, 4.12); line(2.9, 4.64, 6.3, 4.68); line(1.98, 4.08, 2.9, 4.12); line(1.98, 4.1, 2.02, 7.0); line(2.88, 4.66, 2.92, 7.0);
    for (let x = 5.9; x < 6.9; x += 0.34) line(x + 0.44, 4.1, x + 0.6, 4.66);                // zebra on to the aisle
    for (let z = 4.9; z < 6.8; z += 0.9) for (const sx of [-1, 1]) line(2.45 + sx * 0.11, z, 2.45 + sx * 0.11 + 0.1, z + 0.28); // footprints
    // lift lobby: glazed screen with glass door, exit sign
    const zl = 7.1;
    B.boxAB('basement', 'darkSteel', 1.55, y, zl - 0.03, 1.7, ceil, zl + 0.03); B.boxAB('basement', 'darkSteel', 2.62, y, zl - 0.03, 2.78, ceil, zl + 0.03);
    B.boxAB('basement', 'darkSteel', 1.7, y + 2.14, zl - 0.03, 2.62, y + 2.2, zl + 0.03); B.boxAB('basement', 'glass', 1.7, y + 2.2, zl - 0.006, 2.62, ceil - 0.02, zl + 0.006);
    for (const z of [8.02, 8.92]) B.boxAB('basement', 'darkSteel', 2.72, y, z - 0.03, 2.78, ceil, z + 0.03);
    B.boxAB('basement', 'darkSteel', 2.72, y, zl, 2.78, y + 0.1, 8.95); B.boxAB('basement', 'darkSteel', 2.72, ceil - 0.06, zl, 2.78, ceil, 8.95);
    B.boxAB('basement', 'glass', 2.744, y + 0.1, zl + 0.03, 2.756, ceil - 0.06, 7.99); B.boxAB('basement', 'glass', 2.744, y + 0.1, 8.05, 2.756, ceil - 0.06, 8.89);
    {
      const W = 0.9, H = 2.12, st = 0.05, pivot = dyn(new THREE.Object3D()); pivot.name = 'door-basement-lobby'; pivot.position.set(1.71, y + 0.01, zl);
      const fr = new THREE.Mesh(boxesGeo([[st / 2, H / 2, 0, st, H, 0.04], [W - st / 2, H / 2, 0, st, H, 0.04], [W / 2, H - st / 2, 0, W - 2 * st, st, 0.04], [W / 2, 0.06, 0, W - 2 * st, 0.12, 0.04], [W - 0.12, 1.05, 0, 0.03, 0.4, 0.1]]), M.darkSteel); fr.castShadow = false; fr.name = 'door-frame-basement-lobby';
      const gl = new THREE.Mesh(new THREE.BoxGeometry(W - 2 * st + 0.01, H - st - 0.12 + 0.01, 0.01), M.glass); gl.position.set(W / 2, 0.12 + (H - st - 0.12) / 2, 0); gl.name = 'door-leaf-basement-lobby';
      pivot.add(fr, gl); G['basement-det'].add(pivot); let cur = -1;
      const d = { id: 'basement-lobby', floorId: 'basement', kind: 'door', center: V3(2.16, y + 1.05, zl), pivot, leaf: gl, opening: null,
        setOpen(t) { t = Math.max(0, Math.min(1, +t || 0)); if (t === cur) return; cur = t; pivot.rotation.y = -t * Math.PI * 80 / 180; } };
      doors.push(d); d.setOpen(1);
    }
    label(gid, 'ELEVADOR · SAÍDA', 2.16, y + 2.29, zl - 0.04, Math.PI, 0.9, 0.13, { bg: '#1c7a45', fg: '#ffffff', glow: 1.6, pw: 512 });
    // fire hose cabinet + extinguisher by the lobby
    B.rboxAB(gid, 'pipeRed', 0.38, y + 0.75, 6.87, 1.02, y + 1.5, 7.05, 0.012); B.boxAB(gid, 'glass', 0.45, y + 0.83, 6.862, 0.95, y + 1.42, 6.87);
    { const reel = NI(new THREE.TorusGeometry(0.2, 0.05, 6, 18)); reel.translate(0.7, y + 1.12, 6.9); B.push(gid, 'evWhite', reel); }
    label(gid, 'INCÊNDIO', 0.7, y + 1.62, 7.045, Math.PI, 0.6, 0.12, { bg: '#b3261e', fg: '#ffffff', pw: 256 });
    B.cyl(gid, 'pipeRed', [1.3, y + 0.8, 6.95], [1.3, y + 1.28, 6.95], 0.07, 14); B.cyl(gid, 'black', [1.3, y + 1.28, 6.95], [1.3, y + 1.37, 6.95], 0.024, 8); B.boxAB(gid, 'black', 1.24, y + 1.33, 6.94, 1.36, y + 1.36, 6.96);
    B.boxAB(gid, 'galv', 1.22, y + 1.0, 7.0, 1.38, y + 1.04, 7.05);
    // bike rack with two bikes (west wall pocket in front of the lobby)
    for (const z of [4.75, 5.45, 6.15]) { B.cyl(gid, 'galv', [0.5, y, z], [0.5, y + 0.8, z], 0.022, 8); B.cyl(gid, 'galv', [1.2, y, z], [1.2, y + 0.8, z], 0.022, 8); B.cyl(gid, 'galv', [0.5, y + 0.8, z], [1.2, y + 0.8, z], 0.022, 8); }
    const bike = (cx, z, mat) => {
      const wy = y + 0.34, f = cx - 0.52, r = cx + 0.52;
      for (const x of [f, r]) { const t = NI(new THREE.TorusGeometry(0.325, 0.016, 5, 18)); t.translate(x, wy, z); B.push(gid, 'tyre', t); B.cyl(gid, 'alloy', [x, wy, z - 0.03], [x, wy, z + 0.03], 0.03, 8); }
      const bb = [cx - 0.05, wy - 0.04, z], seat = [cx + 0.14, wy + 0.5, z], head = [cx - 0.42, wy + 0.52, z];
      B.cyl(gid, mat, bb, seat, 0.016, 6); B.cyl(gid, mat, seat, head, 0.016, 6); B.cyl(gid, mat, bb, [head[0] + 0.02, head[1] - 0.1, z], 0.018, 6);
      B.cyl(gid, mat, bb, [r, wy, z], 0.012, 6); B.cyl(gid, mat, seat, [r, wy, z], 0.011, 6); B.cyl(gid, 'alloy', head, [f, wy, z], 0.013, 6);
      B.cyl(gid, 'alloy', [seat[0], seat[1], z], [seat[0] + 0.04, seat[1] + 0.14, z], 0.011, 6); B.boxAB(gid, 'black', seat[0] - 0.08, seat[1] + 0.13, z - 0.06, seat[0] + 0.16, seat[1] + 0.17, z + 0.06);
      B.cyl(gid, 'alloy', [head[0] - 0.02, head[1] + 0.12, z - 0.24], [head[0] - 0.02, head[1] + 0.12, z + 0.24], 0.011, 6); B.cyl(gid, 'alloy', head, [head[0] - 0.02, head[1] + 0.12, z], 0.012, 6);
    };
    bike(1.02, 4.9, 'pipeRed'); bike(1.0, 5.6, 'darkSteel');
    // convex mirror at the foot of the ramp
    { const zc = 2.075, cap = NI(new THREE.SphereGeometry(0.55, 18, 6, 0, Math.PI * 2, 0, 0.58)); cap.rotateX(Math.PI / 2); cap.translate(12.2, y + 1.85, zc + 0.16 - 0.55 * Math.cos(0.58)); B.push(gid, 'mirror', cap);
      const rim = NI(new THREE.TorusGeometry(0.305, 0.02, 6, 24)); rim.translate(12.2, y + 1.85, zc + 0.16); B.push(gid, 'pipeRed', rim); B.cyl(gid, 'galv', [12.2, y + 1.85, zc], [12.2, y + 1.85, zc + 0.15], 0.02, 8); }
    // signage
    label(gid, 'ÁREA TÉCNICA', 4.2, y + 2.26, 8.893, Math.PI, 0.7, 0.11, { pw: 512 });
    label(gid, 'PISO -1', 10.293, y + 1.75, 10.4, -Math.PI / 2, 1.0, 0.3, { bg: '#22262b', fg: '#e8d9b8', pw: 512 });
    label(gid, 'SAÍDA', 10.293, y + 1.75, 7.2, -Math.PI / 2, 0.7, 0.22, { bg: '#1c7a45', fg: '#ffffff', glow: 1.4, pw: 256 });
    // wall dado band (anthracite) on the west and rear walls
    B.boxAB(gid, 'darkSteel', 0.176, y + 0.05, -7.72, 0.19, y + 1.1, 7.05);
    B.boxAB(gid, 'darkSteel', 0.18, y + 0.05, -7.73, 8.1, y + 1.1, -7.72);
  }


  // ───────── lobby ─────────
  function buildLobby() {
    const g = 'ground-int', y = 0;
    // timber slat feature wall on the west wall (z 11.2 → 14.5): sealed backing, plinth and valance — no light behind the slats
    B.boxAB(g, 'darkSteel', 2.852, y, 11.2, 2.9, 2.7, 14.5);
    for (let z = 11.24; z < 14.46; z += 0.09) B.boxAB(g, 'slatW', 2.9, y + 0.1, z, 2.955, 2.6, z + 0.05);
    B.boxAB(g, 'bronze', 2.9, y, 11.2, 2.97, y + 0.1, 14.5);
    B.boxAB(g, 'bronze', 2.9, 2.6, 11.2, 3.06, 2.7, 14.5);
    B.boxAB(g, 'ledWarm', 2.985, 2.593, 11.26, 3.03, 2.6, 14.44);   // wall-washer under the valance, in front of the slats
    // backlit logo: bronze panel floating in front of the slats with a halo
    B.boxAB(g, 'logo', 2.957, 1.4, 12.02, 2.966, 1.9, 13.68);
    B.boxAB(g, 'bronze', 2.966, 1.43, 12.05, 2.98, 1.87, 13.65);
    const lt = textCanvasTexture(THREE, 'VILNYI', { w: 1024, h: 256, bg: '#2b2118', fg: '#ffe2b0', font: '300 150px Georgia, "Times New Roman", serif' });
    const logo = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.375), new THREE.MeshStandardMaterial({ map: lt, emissive: 0xffffff, emissiveMap: lt, emissiveIntensity: 1.3, roughness: 0.5, metalness: 0.3 }));
    logo.material.name = 'led-strip-emissive:sign'; logo.position.set(2.9815, 1.65, 12.85); logo.rotation.y = Math.PI / 2; logo.name = 'lobby-logo'; G[g].add(logo);
    // warm key light under the ring pendant (one of ≤2 building point lights)
    try { const pl = new THREE.PointLight(0xffd2a0, 10, 9, 2); pl.name = 'lobby-light'; pl.position.set(6.2, 1.95, 12.0); pl.castShadow = false; G[g].add(pl); } catch (e) { /* ignore */ }
    // pendant: large brass ring
    const ring = NI(new THREE.TorusGeometry(0.55, 0.02, 8, 48)); ring.rotateX(Math.PI / 2); ring.translate(6.2, 2.05, 12.0); B.push(g, 'brass', ring);
    const ringL = NI(new THREE.TorusGeometry(0.55, 0.012, 6, 48)); ringL.rotateX(Math.PI / 2); ringL.translate(6.2, 2.03, 12.0); B.push(g, 'logo', ringL);
    for (const a of [0, 2.09, 4.19]) B.cyl(g, 'darkSteel', [6.2 + Math.cos(a) * 0.55, 2.05, 12.0 + Math.sin(a) * 0.55], [6.2, 2.7, 12.0], 0.003, 4);
    // brass inlay framing the centre of the stone floor
    for (const [x0, z0, x1, z1] of [[4.0, 10.2, 8.4, 10.212], [4.0, 13.788, 8.4, 13.8], [4.0, 10.2, 4.012, 13.8], [8.388, 10.2, 8.4, 13.8]]) B.boxAB(g, 'brass', x0, y, z0, x1, y + 0.0015, z1);
    // east wall (x = 9.4): numbered brass mailboxes, large mirror over a concierge console
    const xe = 9.4;
    B.boxAB(g, 'bronze', xe - 0.075, 0.96, 9.66, xe, 1.68, 11.14);
    const units = UNIT_IDS;
    { const A = brassAtlas(), mm = A.mat;
      const dw = 0.335, dh = 0.31, dt = 0.016, hx = xe - 0.082, geos = [], hz = [];
      units.forEach((u, i) => {
        const c = i % 4, r = Math.floor(i / 4), yb = 1.0 + (1 - r) * 0.33, z0 = 9.7 + c * 0.355;
        B.boxAB(g, 'black', xe - 0.0765, yb + 0.012, z0 + 0.012, xe - 0.075, yb + dh - 0.012, z0 + dw - 0.012);   // dark cavity behind the door
        const bg = new THREE.BoxGeometry(dt, dh, dw), uv = bg.attributes.uv, cl = A.cell(u), pl = A.plain(u);
        for (let k = 0; k < uv.count; k++) { const onFront = k >= 4 && k < 8; uv.setXY(k, onFront ? cl[0] + uv.getX(k) * cl[2] : pl[0], onFront ? cl[1] + uv.getY(k) * cl[3] : pl[1]); }
        const ng = NI(bg); ng.translate(hx, yb + dh / 2, z0 + dw / 2); geos.push(ng); hz.push(z0);
      });
      const mg = mergeGeometries(geos, false), per = mg.attributes.position.count / units.length;
      const P = mg.attributes.position, N = mg.attributes.normal, P0 = P.array.slice(), N0 = N.array.slice();
      mg.computeBoundingBox(); mg.boundingBox.expandByScalar(0.36); mg.computeBoundingSphere(); mg.boundingSphere.radius += 0.36;
      const mb = dyn(new THREE.Mesh(mg, mm)); mb.name = 'mailboxes'; mb.receiveShadow = true; G[g].add(mb);
      const prox = units.map((u, i) => {
        const p = new THREE.Object3D(); p.name = `mailbox-${u}`; p.material = mm; mb.add(p);
        mkToggle(p, { id: 'mailbox-' + u, kind: 'mailbox', sound: 'click', range: 2.6, open: LBL.mailO, close: LBL.mailC, speed: 2.4, apply: (tt) => {
          const a = -1.75 * tt, cs = Math.cos(a), sn = Math.sin(a), z0 = hz[i];
          for (let k = i * per; k < (i + 1) * per; k++) {
            const j = k * 3, dx = P0[j] - hx, dz = P0[j + 2] - z0;
            P.array[j] = hx + dx * cs + dz * sn; P.array[j + 2] = z0 - dx * sn + dz * cs;
            N.array[j] = N0[j] * cs + N0[j + 2] * sn; N.array[j + 2] = -N0[j] * sn + N0[j + 2] * cs;
          }
          P.needsUpdate = true; N.needsUpdate = true;
        } });
        return p;
      });
      mb.raycast = function (rc, hits) { const n0 = hits.length; THREE.Mesh.prototype.raycast.call(this, rc, hits); for (let i = n0; i < hits.length; i++) { const p = prox[Math.floor(hits[i].faceIndex * 3 / per)]; if (p) hits[i].object = p; } };
    }
    label(g, 'CORREIO', xe - 0.002, 1.78, 10.4, -Math.PI / 2, 0.5, 0.07, { bg: null, fg: '#6b5a44', pw: 512, font: '500 60px Helvetica, Arial, sans-serif' });
    B.boxAB(g, 'bronze', xe - 0.03, 0.98, 11.56, xe, 2.48, 13.64);
    B.boxAB(g, 'mirror', xe - 0.034, 1.01, 11.59, xe - 0.03, 2.45, 13.61);
    // console: floating walnut body, stone top, bronze legs, lamp and tray
    B.rboxAB(g, 'walnut', xe - 0.42, 0.58, 11.8, xe, 0.84, 13.4, 0.008);
    B.rboxAB(g, 'stoneFine', xe - 0.44, 0.84, 11.78, xe, 0.875, 13.42, 0.006);
    for (const z of [11.86, 13.3]) { B.boxAB(g, 'bronze', xe - 0.4, 0, z, xe - 0.37, 0.58, z + 0.03); B.boxAB(g, 'bronze', xe - 0.06, 0, z, xe - 0.03, 0.58, z + 0.03); }
    for (const z of [12.2, 12.6, 13.0]) B.boxAB(g, 'brass', xe - 0.424, 0.7, z - 0.06, xe - 0.42, 0.712, z + 0.06);
    B.cyl(g, 'brass', [xe - 0.2, 0.875, 13.15], [xe - 0.2, 0.885, 13.15], 0.07, 16); B.cyl(g, 'brass', [xe - 0.2, 0.885, 13.15], [xe - 0.2, 1.2, 13.15], 0.01, 8);
    B.cyl(g, 'ledWarm', [xe - 0.2, 1.18, 13.15], [xe - 0.2, 1.4, 13.15], 0.11, 16, 0.08);
    B.boxAB(g, 'bronze', xe - 0.34, 0.875, 12.0, xe - 0.1, 0.89, 12.34); B.boxAB(g, 'stoneFine', xe - 0.31, 0.89, 12.04, xe - 0.14, 0.9, 12.28);
    B.cyl(g, 'planterDark', [xe - 0.2, 0.875, 12.62], [xe - 0.2, 1.03, 12.62], 0.06, 12, 0.075); bush(g, xe - 0.2, 1.0, 12.62, 0.13, 'olive', 406);
    // upholstered bench on the north wall
    B.rboxAB(g, 'walnut', 7.62, 0.2, 9.32, 9.2, 0.4, 9.78, 0.01);
    B.rboxAB(g, 'leather', 7.64, 0.4, 9.33, 9.18, 0.48, 9.77, 0.02);
    for (const x of [7.72, 9.07]) B.boxAB(g, 'bronze', x, 0, 9.36, x + 0.03, 0.2, 9.74);
    // planter in the south-east corner
    B.cyl(g, 'planterDark', [8.95, 0, 14.12], [8.95, 0.62, 14.12], 0.25, 20, 0.3);
    bush(g, 8.95, 0.56, 14.12, 0.42, 'olive', 404); grassClump(g, 8.95, 0.6, 14.12, 0.9, 405, 'grass');
    // mat well inside the door
    B.boxAB(g, 'bronze', 3.73, 0.0, 13.58, 5.17, 0.003, 14.52); B.boxAB(g, 'black', 3.75, 0.0, 13.6, 5.15, 0.006, 14.5);
    // stair door: bronze portal, glazed leaf (held open) + fixed glazed guard beside the flight, wayfinding
    const zs0 = 9.5, zs1 = 11.1, xs = 2.75, zm = 10.46;
    B.boxAB('ground', 'bronze', xs - 0.105, 0, zs0, xs + 0.105, 2.3, zs0 + 0.035); B.boxAB('ground', 'bronze', xs - 0.105, 0, zs1 - 0.035, xs + 0.105, 2.3, zs1); B.boxAB('ground', 'bronze', xs - 0.105, 2.265, zs0, xs + 0.105, 2.3, zs1);
    B.boxAB('ground', 'bronze', xs - 0.03, 0, zm, xs + 0.03, 2.265, zm + 0.04); B.boxAB('ground', 'bronze', xs - 0.03, 0, zm + 0.04, xs + 0.03, 0.1, zs1 - 0.035);
    B.boxAB('ground', 'glass', xs - 0.006, 0.1, zm + 0.04, xs + 0.006, 2.265, zs1 - 0.035);
    {
      const W = zm - zs0 - 0.045, H = 2.24, st = 0.05;
      const pivot = dyn(new THREE.Object3D()); pivot.name = 'door-ground-stairs'; pivot.position.set(xs + 0.03, 0.005, zs0 + 0.04); const base = -Math.PI / 2; pivot.rotation.y = base; // leaf along +z when closed
      const fr = new THREE.Mesh(boxesGeo([[st / 2, H / 2, 0, st, H, 0.04], [W - st / 2, H / 2, 0, st, H, 0.04], [W / 2, H - st / 2, 0, W - 2 * st, st, 0.04], [W / 2, 0.075, 0, W - 2 * st, 0.15, 0.04], [W - 0.1, 1.1, 0, 0.025, 0.5, 0.1]]), M.bronze); fr.castShadow = false; fr.name = 'door-frame-ground-stairs';
      const gl = new THREE.Mesh(new THREE.BoxGeometry(W - 2 * st + 0.01, H - st - 0.15 + 0.01, 0.01), M.glass); gl.position.set(W / 2, 0.15 + (H - st - 0.15) / 2, 0); gl.name = 'door-leaf-ground-stairs';
      pivot.add(fr, gl); G['ground-det'].add(pivot); let cur = -1;
      const d = { id: 'ground-stairs', floorId: 'ground', kind: 'door', center: V3(xs, 1.05, (zs0 + zm) / 2), pivot, leaf: gl, opening: null,
        setOpen(t) { t = Math.max(0, Math.min(1, +t || 0)); if (t === cur) return; cur = t; pivot.rotation.y = base + t * Math.PI / 2; } };
      doors.push(d); d.setOpen(1);
    }
    label(g, 'ESCADAS  ·  GARAGEM -1', 2.853, 2.5, 10.3, Math.PI / 2, 1.3, 0.14, { bg: '#4a3a2a', fg: '#ffe7c2', glow: 0.9, pw: 1024 });
    label(g, 'ELEVADOR  ·  GARAGEM -1', 1.662, 2.46, 8.0, Math.PI / 2, 0.86, 0.09, { bg: '#4a3a2a', fg: '#ffe7c2', glow: 0.9, pw: 1024 });
    // ceiling cove along the east wall
    B.boxAB(g, 'ledWarm', xe - 0.04, 2.66, 9.35, xe - 0.02, 2.68, 14.4);
  }

  // ───────── skirting ─────────
  function buildSkirting(floor) {
    if (floor.id === 'basement') return;
    const y = floor.level.y, gid = floor.id;
    for (const w of floor.walls) {
      const F = frameAxes(w); const h = w.t / 2;
      const sides = w.kind === 'ext' || w.kind === 'party' ? [1] : [-1, 1];
      let s = 0; const segs = [];
      for (const o of [...w.openings].sort((a, b) => a.from - b.from)) {
        const bottom = (OPEN_H[o.type] || [0])[0];
        if (bottom > 0.1 && o.type !== 'garage') continue;
        if (o.from > s) segs.push([s, o.from]); s = Math.max(s, o.to);
      }
      if (s < F.L) segs.push([s, F.L]);
      const gs = w.kind === 'core' ? gid : gid + '-int', ga = gid + '-int', ceil = y + 2.7;
      for (const sg of sides) for (const [a, b] of segs) {
        // skip the skirting where the inner side is outdoors (street wall behind the tower is fine)
        const mid = F.P((a + b) / 2, sg * (h + 0.3));
        if (!pointInPoly(mid[0], mid[1], FP)) continue;
        B.boxAlong(gs, 'skirting', w.a, w.b, a, b, y, y + 0.08, sg > 0 ? h : -h - 0.012, sg > 0 ? h + 0.012 : -h);
        if (b - a < 0.12) continue;
        // soft contact shading: wall foot, floor edge, wall head and ceiling edge
        const nf = sg * (h + 0.003), n1 = sg * (h + 0.014), n2 = sg * (h + 0.4);
        aoWall(ga, F, a, b, nf, y + 0.08, 0.3, y + 0.55, 0);
        aoFlat(ga, F, a, b, y + 0.004, n1, 0.36, sg * (h + 0.45), 0);
        if (floor.id !== 'second' || mansardInnerY(mid[0], mid[1]) > ceil + 0.3) {
          aoWall(ga, F, a, b, nf, ceil - 0.012, 0.3, ceil - 0.5, 0);
          aoFlat(ga, F, a, b, ceil - 0.012, sg * (h + 0.003), 0.28, sg * (h + 0.45), 0);
        }
      }
    }
  }

  // exterior shading that a sun shadow map cannot give: under balconies, under the cornice, at the foot of the garden façade
  function buildExteriorAO() {
    const fz = { a: [0, 14.855], b: [14, 14.855], P: null }, rz = { a: [0, -0.155], b: [14, -0.155] };
    const FZ = (z) => ({ P: (sx, n) => [sx, z + n] });
    for (const b of BALCONIES) {
      if (b.deck) continue;
      const y = LEVEL_Y[b.level], xs = b.poly.map(p => p[0]), zs = b.poly.map(p => p[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), front = Math.min(...zs) >= 14.6, th = b.dormer ? 0.3 : 0.34;
      const F = FZ(front ? 14.855 : -0.155), gid = b.level === 'second' ? 'first' : (b.level === 'first' ? 'ground' : 'ground');
      aoWall(gid, F, x0, x1, 0, y - th, 0.34, y - th - 0.75, 0);
    }
    // cornice / gutter line (first-floor wall head)
    aoWall('second', FZ(14.855), 2.95, 13.88, 0, 6.3, 0.26, 5.9, 0);
    aoWall('second', FZ(-0.155), 0, 12.2, 0, 6.3, 0.26, 5.9, 0);
    aoWall('second', { P: (sz, n) => [14.035 + n, sz] }, 4.9, 14.7, 0, 6.3, 0.26, 5.9, 0);
    // foot of the garden façade
    aoWall('ground', FZ(-0.155), 0, 12.2, 0, -0.14, 0.24, 0.42, 0);
    void fz; void rz;
  }

  // ───────── pickers & highlight ─────────
  const floorPickers = [];
  const highlight = {};
  function buildPickersAndHighlight() {
    const pickMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, colorWrite: false });
    pickMat.visible = false;   // still raycastable, but costs no draw call
    const spans = { ground: [-0.85, 3.0], first: [3.0, 6.0], second: [6.0, ROOF.y + 0.2] };
    for (const fid of ['ground', 'first', 'second']) {
      const [y0, y1] = spans[fid];
      const sh = new THREE.Shape(FP.map(p => new THREE.Vector2(p[0], -p[1])));
      const g = new THREE.ExtrudeGeometry(sh, { depth: y1 - y0, bevelEnabled: false }); g.rotateX(-Math.PI / 2); g.translate(0, y0, 0);
      // grow slightly to include balconies & tower
      g.computeBoundingBox();
      const m = new THREE.Mesh(g, pickMat); m.name = `floor-picker-${fid}`; m.userData.floorId = fid; m.scale.set(1, 1, 1);
      const bb = new THREE.Mesh(new THREE.BoxGeometry(14.3, y1 - y0, 17.6), pickMat); // incl. balconies (z −1.3 … 16.0)
      bb.position.set(6.94, (y0 + y1) / 2, 7.35); bb.name = `floor-picker-${fid}`; bb.userData.floorId = fid;
      bb.userData.pathTraceIgnore = true; bb.userData.ui = true;
      group.add(bb); floorPickers.push({ floorId: fid, mesh: bb });
      g.dispose(); void m;
      // highlight: soft emissive band on street & rear façades + outline glow
      const hm = new THREE.MeshBasicMaterial({ color: 0xe9c98f, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, blending: THREE.AdditiveBlending });
      const hg = new THREE.Group(); hg.name = `highlight-${fid}`; hg.visible = false; hg.userData.pathTraceIgnore = true; hg.userData.ui = true;
      const bandH = y1 - y0 - 0.1;
      const mk = (w, x, z, ry) => { const p = new THREE.Mesh(new THREE.PlaneGeometry(w, bandH), hm); p.position.set(x, (y0 + y1) / 2, z); p.rotation.y = ry; p.renderOrder = 10; hg.add(p); };
      const off = fid === 'second' ? 0.25 : 0.0;
      mk(13.88, 6.94, ZF + 0.18 + (fid === 'first' ? 1.35 : fid === 'second' ? 0.0 : 0.02) - off, 0);
      mk(12.2, 6.1, -0.18 - (fid === 'first' ? 1.35 : 0) + off, Math.PI);
      mk(9.8, 13.88 + 0.18 - off, 9.8, Math.PI / 2);
      // thin bright lines at slab edges
      const lm = new THREE.MeshBasicMaterial({ color: 0xffd79a, transparent: true, opacity: 0, toneMapped: false, depthWrite: false });
      for (const yy of [y0 + 0.02, y1 - 0.02]) {
        for (const [w, x, z] of [[14.1, 6.94, ZF + 0.2], [12.4, 6.1, -0.2]]) { const l = new THREE.Mesh(new THREE.BoxGeometry(w, 0.025, 0.025), lm); l.position.set(x, yy, z + (fid === 'first' ? (z > 5 ? 1.35 : -1.35) : 0)); hg.add(l); }
      }
      group.add(hg);
      highlight[fid] = { g: hg, mats: [hm, lm], t: 0, target: 0 };
    }
  }
  function highlightFloor(fid) {
    for (const k of Object.keys(highlight)) highlight[k].target = k === fid ? 1 : 0;
  }

  // ───────── visibility: cutaway + active floor ─────────
  let cutFloor = null, activeFloor = null, garageOpen = false;
  const LV = { basement: 0, ground: 1, first: 2, second: 3 };
  function applyVisibility() {
    const idx = cutFloor ? LV[cutFloor] : 99, af = cutFloor ? null : activeFloor, all = af === null, ext = af === 'exterior';
    for (let i = 0; i < ORDER.length; i++) {
      const fid = ORDER[i], here = all || af === fid;
      // floor group = envelope (walls, slabs, glazing, balconies, stairs, entry + lift doors): always there so the building stays whole
      G[fid].visible = LV[fid] <= idx && (fid !== 'basement' || all || af === 'basement' || af === 'ground' || garageOpen);
      // fit-out and small fittings: only where somebody can see them
      G[fid + '-int'].visible = fid === 'basement' ? (here || garageOpen) : (here || ext);
      G[fid + '-det'].visible = here || ext;
      G[fid + '-doors'].visible = here;
      if (fid !== 'basement') G[fid + '-ceil'].visible = idx > LV[fid] && (here || ext);
    }
    G['site-det'].visible = all || ext || af === 'ground';
    G.roofshell.visible = idx > 3;
    G.roof.visible = idx > 3 && (all || ext || af === 'second');
    if (liftObj.cab) liftObj.cab.visible = !cutFloor || liftObj.cab.position.y <= LEVEL_Y[cutFloor] + 0.5;
  }
  function setCutaway(fid) { cutFloor = fid && ORDER.includes(fid) ? fid : null; applyVisibility(); }
  // floorId: 'basement'|'ground'|'first'|'second' while walking there · 'exterior' for the orbit view (car park contents hidden) · null = everything
  function setActiveFloor(fid) { activeFloor = fid === 'exterior' || ORDER.includes(fid) ? fid : null; applyVisibility(); }

  // ───────── quality switch ─────────
  let quality = 'high';
  const KEEP_NORMAL = new Set(['render', 'brick', 'zinc', 'stone', 'wall']);
  const VEG_LOW = new Set(['grass', 'grassDry', 'ivy']);
  const vegMeshes = [], extraLights = [];
  function lowTex(t) {
    if (!t || !t.image || !(t.image.width > 512)) return t;
    if (t.userData.low) return t.userData.low;
    try {
      const c = makeCanvas(512, 512); c.getContext('2d').drawImage(t.image, 0, 0, 512, 512);
      const n = new THREE.CanvasTexture(c); n.wrapS = t.wrapS; n.wrapT = t.wrapT; n.repeat.copy(t.repeat); n.rotation = t.rotation; n.colorSpace = t.colorSpace; n.anisotropy = 2;
      t.userData.low = n; return n;
    } catch (e) { return t; }
  }
  function applyQuality() {
    const low = quality === 'low';
    for (const k of Object.keys(M)) {
      const m = M[k], u = m.userData; if (!m.isMeshStandardMaterial) continue;
      if (u.hq) { m.map = u.hq.map; m.normalMap = u.hq.normalMap; m.roughnessMap = u.hq.roughnessMap; m.aoMap = u.hq.aoMap; m.roughness = u.hq.roughness; u.hq = null; m.needsUpdate = true; }
      if (!low) continue;
      u.hq = { map: m.map, normalMap: m.normalMap, roughnessMap: m.roughnessMap, aoMap: m.aoMap, roughness: m.roughness };
      m.map = lowTex(m.map);
      m.normalMap = KEEP_NORMAL.has(k) ? lowTex(m.normalMap) : null;
      if (m.roughnessMap) { m.roughnessMap = null; m.roughness = u.baseRough != null ? u.baseRough : 0.8; }
      m.aoMap = null; m.needsUpdate = true;
    }
    for (let i = 0; i < vegMeshes.length; i++) vegMeshes[i].visible = !low;
    for (let i = 0; i < extraLights.length; i++) extraLights[i].visible = !low;
  }
  function setQuality(q) { const n = q === 'low' ? 'low' : 'high'; if (n === quality) return; quality = n; applyQuality(); warmTextures(); }
  // upload every texture now so nothing is uploaded while walking
  function warmTextures() {
    if (!renderer || typeof renderer.initTexture !== 'function') return;
    const seen = new Set();
    const one = (m) => { if (!m) return; for (const k of ['map', 'normalMap', 'roughnessMap', 'aoMap', 'metalnessMap', 'emissiveMap', 'bumpMap']) { const t = m[k]; if (t && t.image && !seen.has(t)) { seen.add(t); try { renderer.initTexture(t); } catch (e) { /* ignore */ } } } };
    group.traverse(o => { if (o.isMesh) { if (Array.isArray(o.material)) o.material.forEach(one); else one(o.material); } });
  }

  // ───────── assemble ─────────
  const steps = [
    () => { for (const f of FLOORS) buildWalls(f); },
    buildSlabs, buildCommonCeilings, buildStairs, buildLift, buildMansard, buildTower, buildBalconies,
    buildSite, buildBasement, buildLobby, () => { for (const f of FLOORS) buildSkirting(f); }, buildExteriorAO,
    () => { // PV panels on the flat roof (3 × 6), tilted 10° towards the south
      const pv = { ...ROOF.pv, w: ROOF.pv.d, d: ROOF.pv.w }, x0 = 2.62, z0 = 4.75, gapX = 0.02, gapZ = 1.05;
      const tilt = pv.tilt * Math.PI / 180;
      for (let r = 0; r < pv.rows; r++) for (let c = 0; c < pv.cols; c++) {
        const cx = x0 + c * (pv.w + gapX) + pv.w / 2, cz = z0 + r * (pv.d * Math.cos(tilt) + gapZ) + pv.d / 2;
        const lift = ROOF.y + 0.25 + Math.sin(tilt) * pv.d / 2;
        const g = NI(new THREE.BoxGeometry(pv.w, 0.04, pv.d));
        // uv: whole panel texture
        const uv = g.attributes.uv; void uv; g.userData.keepUV = true;
        g.applyMatrix4(new THREE.Matrix4().compose(V3(cx, lift, cz), new THREE.Quaternion().setFromEuler(new THREE.Euler(tilt, 0, 0)), V3(1, 1, 1)));
        B.push('roof', 'pv', g);
        B.boxAB('roof', 'steel', cx - pv.w / 2 + 0.05, ROOF.y, cz + pv.d / 2 * Math.cos(tilt) - 0.05, cx - pv.w / 2 + 0.09, lift - 0.02, cz + pv.d / 2 * Math.cos(tilt) - 0.01);
        B.boxAB('roof', 'steel', cx + pv.w / 2 - 0.09, ROOF.y, cz + pv.d / 2 * Math.cos(tilt) - 0.05, cx + pv.w / 2 - 0.05, lift - 0.02, cz + pv.d / 2 * Math.cos(tilt) - 0.01);
      }
    },
    buildPickersAndHighlight
  ];
  for (const s of steps) { try { s(); } catch (err) { if (typeof console !== 'undefined') console.warn('[building] step failed', s.name || '', err); } }
  // shadow casters: only what shapes the light (envelope, partitions, slabs, trees); small fittings never enter the shadow pass
  const CAST = new Set(['render', 'wall', 'ceiling', 'zinc', 'zincTrim', 'brick', 'capGrey', 'baseFloor', 'bCeil', 'bWall', 'concrete', 'stone', 'stoneFine', 'teak', 'garage', 'kerb', 'olive', 'oliveLight', 'leaf', 'trunk', 'pv', 'planterDark', 'carPaint']);
  const noCast = Object.keys(M).filter(k => !CAST.has(k));
  const ENVELOPE = new Set(['render', 'wall', 'ceiling', 'bCeil', 'bWall', 'zinc', 'zincTrim', 'brick', 'stone', 'stoneFine', 'frame', 'glass', 'railGlass', 'oak', 'steel', 'concrete', 'epoxy']);
  const SITE_DET = new Set(['downlight', 'ledWarm', 'hazard', 'steel', 'rubber', 'capGrey', 'galv']);
  try { B.finalize(G, M, { noCast, detail: true, envelope: (gid, mat) => gid === 'site' ? !SITE_DET.has(mat) : ENVELOPE.has(mat) }); } catch (err) { if (typeof console !== 'undefined') console.warn('[building] finalize failed', err); }
  try { buildSashMeshes(); buildSigns(); } catch (err) { if (typeof console !== 'undefined') console.warn('[building] sashes/signs failed', err); }
  try { buildAOMeshes(); } catch (err) { if (typeof console !== 'undefined') console.warn('[building] ao failed', err); }
  for (const d of doors) { try { wireDoor(d); } catch (e) { /* keep the plain door */ } }
  const garageDoor = doors.find(d => d.kind === 'garage') || null;
  // interiors don't need shadow casting from ceiling/floor finishes inside — keep the exterior shells casting
  group.traverse(o => {
    if (o.isMesh && /-(ceil|int)$/.test(o.parent ? o.parent.name : '') && !/-wall$|plaster/.test(o.name + (o.material && o.material.name || ''))) o.castShadow = false;
    if (o.isMesh && o.material && VEG_LOW.has(o.material.userData.internal)) vegMeshes.push(o);
    if (o.isPointLight) extraLights.push(o);
  });

  group.traverse(o => { if (o.isMesh && o.material && !o.material.name) o.material.name = /picker|highlight/.test(o.name + (o.parent ? o.parent.name : '')) ? 'helper' : /button|call/.test(o.name) ? 'lift-steel:button' : 'signage'; });
  // static objects: frozen local matrices (three.js then skips recomposing ~500 matrices every frame)
  (function freeze(o) { o.updateMatrix(); if (!o.userData.dyn && o !== group) o.matrixAutoUpdate = false; for (let i = 0; i < o.children.length; i++) freeze(o.children[i]); })(group);
  group.updateMatrixWorld(true);
  if (scene) scene.add(group);
  const pbrState = { loaded: false };
  const ready = new Promise((resolve) => {
    let fin = false;
    const done = () => { if (fin) return; fin = true; try { for (const k of Object.keys(M)) { M[k].userData.hq = null; if (M[k].userData.pbr) pbrState.loaded = true; } if (quality === 'low') applyQuality(); warmTextures(); } catch (e) { /* ignore */ } resolve(); };
    try { if (loadPBR(THREE, M, renderer, done) === false) done(); } catch (e) { done(); }
    try { setTimeout(done, 25000); } catch (e) { /* ignore */ }
  });
  applyVisibility();

  // ───────── update ─────────
  const HL = Object.keys(highlight);
  let cabStill = 9, lastCabY = 0;
  function update(dt) {
    dt = Math.min(0.1, Math.max(0, +dt || 0));
    for (let i = 0; i < HL.length; i++) {
      const h = highlight[HL[i]];
      if (h.t === h.target) continue;
      h.t = h.target > h.t ? Math.min(h.target, h.t + dt * 4) : Math.max(h.target, h.t - dt * 3);
      h.g.visible = h.t > 0.001;
      h.mats[0].opacity = 0.2 * h.t; h.mats[1].opacity = 0.9 * h.t;
    }
    stepTweens(dt);
    for (let i = 0; i < animators.length; i++) animators[i](dt);
    if (garageDoor) { const go = garageDoor.t > 0.01; if (go !== garageOpen) { garageOpen = go; applyVisibility(); } }
    const cab = liftObj.cab;
    if (cab) {
      const y = cab.position.y; if (y !== lastCabY) { lastCabY = y; cabStill = 0; } else if (cabStill < 9) cabStill += dt;
      let v = true;
      if (cutFloor) v = y <= LEVEL_Y[cutFloor] + 0.5;
      else if (activeFloor && activeFloor !== 'exterior') v = cabStill < 1.5 || Math.abs(y - LEVEL_Y[activeFloor]) < 1.6 || liftObj.getState().cabDoors > 0;
      if (cab.visible !== v) cab.visible = v;
    }
  }
  function dispose() {
    const seen = new Set();
    const tex = (m) => { for (const k of ['map', 'normalMap', 'roughnessMap', 'aoMap', 'metalnessMap', 'emissiveMap', 'bumpMap']) { const t = m[k]; if (t && !seen.has(t)) { seen.add(t); if (t.userData && t.userData.low) t.userData.low.dispose(); t.dispose(); } } };
    group.traverse(o => { if (!o.isMesh) return; if (o.geometry) o.geometry.dispose(); const ms = Array.isArray(o.material) ? o.material : [o.material]; for (const m of ms) if (m && !seen.has(m)) { seen.add(m); tex(m); m.dispose(); } });
    for (const k of Object.keys(M)) { const m = M[k]; if (!seen.has(m)) { tex(m); m.dispose(); } if (m.userData.hq) for (const t of Object.values(m.userData.hq)) if (t && t.isTexture) t.dispose(); }
    if (group.parent) group.parent.remove(group);
    activeTweens.length = 0; animators.length = 0;
  }

  return {
    group,
    floorPickers,
    highlightFloor,
    setCutaway,
    setActiveFloor,
    setQuality,
    doors,
    lift: liftObj,
    update,
    // extras
    interactables,                 // every Object3D carrying userData.interact (raycast this list directly for taps)
    ready,                         // resolves when the PBR maps are loaded (or skipped) and uploaded to the GPU
    dispose,
    materials: M, pbr: pbrState,
    levels: LEVEL_Y,
    rampY,
    stairLayout: STAIR
  };
}
