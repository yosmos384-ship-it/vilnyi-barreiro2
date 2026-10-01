// VILNYI · Barreiro 2 — BUILDING: exterior shell, interiors shell, core (stairs + lift), basement, roof and lot.
// Everything is generated procedurally from js/data.js. Static geometry is merged per material per floor.
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
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
    white: S({ name: 'white', color: 0xf2f2f0, roughness: 0.6 }),
    rubber: S({ name: 'rubber', color: 0x2f3134, roughness: 0.9 })
  };
  return M;
}

// ───────────────────────── geometry batcher ─────────────────────────
function createBatcher(THREE) {
  const buckets = new Map(); // `${gid}|${mat}` → { gid, mat, list }
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), s = new THREE.Vector3();
  const boxCache = new Map();
  function unitBox() { if (!boxCache.has('u')) boxCache.set('u', NI(new THREE.BoxGeometry(1, 1, 1))); return boxCache.get('u'); }
  function push(gid, mat, geo) {
    const k = gid + '|' + mat;
    let b = buckets.get(k); if (!b) { b = { gid, mat, list: [] }; buckets.set(k, b); }
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
      const parts = [];
      for (const g of list) {
        let gg = NI(g);
        if (!gg.attributes.normal) gg.computeVertexNormals();
        if (!gg.userData.keepUV) worldUV(gg);
        for (const k of Object.keys(gg.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(k)) gg.deleteAttribute(k);
        gg.morphAttributes = {};
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
      const transparent = M[mat].transparent;
      me.castShadow = !transparent && !(opts.noCast || []).includes(mat);
      me.receiveShadow = !transparent;
      groups[gid].add(me); meshes.push(me);
      for (const g of parts) if (g !== merged) g.dispose();
    }
    buckets.clear();
    return meshes;
  }
  return { box, boxAB, rboxAB, boxAlong, geo, slab, prismX, prismZ, cyl, push, finalize, worldUV };
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
  const doors = [];
  const animators = [];
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
      // wall vertical extent
      let y0 = y, y1 = ceil, inY1 = ceil;
      if (fid === 'basement') { y0 = y; y1 = isExt ? -0.3 : ceil; inY1 = ceil; }
      else if (isExt) {
        y0 = fid === 'ground' ? (frontGround ? -0.95 : -0.3) : y - 0.0;
        y1 = mans ? CORNICE_Y : (w.kind === 'party' && fid === 'second' ? ROOF.y + 0.15 : y + 3.0);
        if (w.kind === 'party' && fid === 'second') inY1 = ceil;
      }
      const openings = [...w.openings].filter(o => !(fid === 'basement' && o.type === 'garage') && !(fid === 'second' && o.type === 'slit')).sort((p, q) => p.from - q.from);
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
        else if (fid === 'second') wallPieceClipped(gid, 'wall', w, s0, s1, y0, y1, -w.t / 2, w.t / 2);
        else if (fid === 'basement' && isExt) {
          // below ramp surface where the ramp runs along the wall
          B.boxAlong(gid, 'bWall', w.a, w.b, s0, s1, y0, y1, -w.t / 2, w.t / 2);
        } else B.boxAlong(gid, fid === 'basement' ? 'bWall' : 'wall', w.a, w.b, s0, s1, y0, y1, -w.t / 2, w.t / 2);
      }
      for (const o of openings) {
        const inTower = isExt && w.a[1] === 14.7 && w.b[1] === 14.7 && F.P(o.from, 0)[0] < TOWER.x1 + 0.01 && fid !== 'second';
        if (inTower) continue; // slit handled by the tower
        let [ob, ot] = OPEN_H[o.type] || [0, 2.1];
        ob += y; ot += y;
        if (o.type === 'garage' && fid === 'ground') { ob = rampY(14.85); ot = 1.35; }
        const matW = isExt ? null : (fid === 'basement' ? 'bWall' : 'wall');
        const piece = (yy0, yy1, zinc) => {
          if (yy1 - yy0 < 1e-3) return;
          if (matW) { if (fid === 'second') wallPieceClipped(gid, matW, w, o.from, o.to, yy0, yy1, -w.t / 2, w.t / 2); else B.boxAlong(gid, matW, w.a, w.b, o.from, o.to, yy0, yy1, -w.t / 2, w.t / 2); }
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
        buildOpening(fid, w, F, o, ob, ot, isExt);
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
  const handleGeo = new THREE.CylinderGeometry(0.011, 0.011, 1, 10);
  const plateTex = new Map();
  function unitAcross(floor, F, o) {
    const sm = (o.from + o.to) / 2;
    const pA = F.P(sm, 0.45), pB = F.P(sm, -0.45);
    const rA = roomAt(floor, pA[0], pA[1]), rB = roomAt(floor, pB[0], pB[1]);
    return { rA, rB };
  }
  function makeDoor({ id, floorId, kind, F, o, y, side, max, leafMat, thick = 0.045, handleMat = 'steel', plate = null, height }) {
    const w = o.to - o.from, h = height || (OPEN_H[o.type] || [0, 2.1])[1];
    const pivot = new THREE.Object3D(); pivot.name = `door-${id}`;
    const hp = F.P(o.from + 0.01, side * 0.0);
    pivot.position.set(hp[0], y, hp[1]);
    const base = F.ry; pivot.rotation.y = base;
    const leaf = new THREE.Mesh(leafGeo, M[leafMat]); leaf.name = `door-leaf-${id}`;
    leaf.scale.set(w - 0.03, h - 0.01, thick); leaf.position.set((w - 0.02) / 2, (h - 0.01) / 2 + 0.005, 0);
    leaf.castShadow = true; leaf.receiveShadow = true; pivot.add(leaf);
    const hx = w - 0.1;
    for (const sgn of [1, -1]) {
      if (kind === 'entry' || kind === 'main') {
        if (kind === 'main' && sgn > 0) continue;
        const bar = new THREE.Mesh(handleGeo, M[handleMat]); bar.scale.set(1, kind === 'main' ? 1.4 : 0.9, 1); bar.position.set(hx, h * 0.48, sgn * (thick / 2 + 0.05)); pivot.add(bar);
        for (const yy of [-0.35, 0.35].map(v => v * (kind === 'main' ? 1.4 : 0.9))) { const st = new THREE.Mesh(handleGeo, M[handleMat]); st.scale.set(0.8, 0.05, 0.8); st.rotation.x = Math.PI / 2; st.position.set(hx, h * 0.48 + yy, sgn * (thick / 2 + 0.025)); st.scale.set(0.8, 0.05, 0.8); pivot.add(st); }
      } else {
        const lever = new THREE.Mesh(handleGeo, M[handleMat]); lever.rotation.z = Math.PI / 2; lever.scale.set(1, 0.13, 1); lever.position.set(hx - 0.05, 1.02, sgn * (thick / 2 + 0.05)); pivot.add(lever);
        const rose = new THREE.Mesh(handleGeo, M[handleMat]); rose.rotation.x = Math.PI / 2; rose.scale.set(2.2, 0.05, 2.2); rose.position.set(hx, 1.02, sgn * (thick / 2 + 0.025)); pivot.add(rose);
      }
    }
    if (plate) {
      if (!plateTex.has(plate.text)) plateTex.set(plate.text, textCanvasTexture(THREE, plate.text, { w: 256, h: 128, bg: '#b89556', fg: '#2b2219', font: '500 66px Georgia, "Times New Roman", serif' }));
      const pm = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.08), new THREE.MeshStandardMaterial({ map: plateTex.get(plate.text), metalness: 0.8, roughness: 0.3 }));
      pm.name = `unit-plate-${plate.text}`;
      pm.position.set(w / 2, 1.55, plate.side * (thick / 2 + 0.002)); if (plate.side < 0) pm.rotation.y = Math.PI;
      pivot.add(pm);
      const peep = new THREE.Mesh(handleGeo, M.brass); peep.rotation.x = Math.PI / 2; peep.scale.set(0.8, thick + 0.02, 0.8); peep.position.set(w / 2, 1.45, 0); pivot.add(peep);
    }
    G[gidOfFloor(floorId)].add(pivot);
    const center = V3(...(() => { const c = F.P((o.from + o.to) / 2, 0); return [c[0], y + 1.05, c[1]]; })());
    let cur = -1;
    const d = {
      id, floorId, kind, center, pivot, leaf,
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

  function buildOpening(fid, w, F, o, ob, ot, isExt) {
    const floor = FLOORS.find(f => f.id === fid); const y = floor.level.y;
    const gid = (fid === 'second' && isExt && (w.mansard)) ? 'second' : fid;
    const h = w.t / 2;
    const s0 = o.from, s1 = o.to;
    if (o.type === 'window' || o.type === 'glassdoor') {
      const nG = isExt ? -h + 0.17 : 0;
      if (o.type === 'window') {
        frameRect(gid, w, F, s0, s1, ob, ot, nG, 0.09, 0.06);
        const mid = s1 - s0 > 1.0 ? (s0 + s1) / 2 : null;
        if (mid) B.boxAlong(gid, 'frame', w.a, w.b, mid - 0.03, mid + 0.03, ob, ot, nG - 0.045, nG + 0.045);
        glassPane(gid, w, s0 + 0.05, s1 - 0.05, ob + 0.05, ot - 0.05, nG);
        if (isExt) {
          B.boxAlong(gid, 'stoneFine', w.a, w.b, s0 - 0.04, s1 + 0.04, ob - 0.05, ob, -h - 0.05, nG - 0.04); // external sill
          B.boxAlong(gid, 'stoneFine', w.a, w.b, s0 - 0.02, s1 + 0.02, ob - 0.03, ob, nG + 0.045, h + 0.03);  // internal sill
        }
      } else {
        // sliding glass door: two leaves, overlapping at the centre, on two tracks
        frameRect(gid, w, F, s0, s1, ob, ot, nG, 0.14, 0.06);
        const m = (s0 + s1) / 2;
        for (const [a0, a1, dn] of [[s0 + 0.04, m + 0.04, -0.035], [m - 0.04, s1 - 0.04, 0.035]]) {
          frameRect(gid, w, F, a0, a1, ob + 0.04, ot - 0.05, nG + dn, 0.05, 0.05);
          glassPane(gid, w, a0 + 0.05, a1 - 0.05, ob + 0.09, ot - 0.1, nG + dn);
        }
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

  function buildMainDoor(w, F, o, y) {
    // along axis runs east→west on the street wall: s0 = east end. Walnut leaf east, glazed sidelight west (as rendered).
    const gid = 'ground', h = w.t / 2, s0 = o.from, s1 = o.to, top = y + 2.4, nG = -h + 0.1;
    frameRect(gid, w, F, s0, s1, y, top, nG, 0.12, 0.07, false);
    const leafW = 0.98, split = s0 + 0.07 + leafW;
    B.boxAlong(gid, 'frame', w.a, w.b, split, split + 0.06, y, top, nG - 0.06, nG + 0.06);
    glassPane(gid, w, split + 0.06, s1 - 0.07, y + 0.1, top - 0.07, nG);
    B.boxAlong(gid, 'frame', w.a, w.b, split, s1, y, y + 0.1, nG - 0.05, nG + 0.05);
    const d = makeDoor({ id: 'main-entrance', floorId: 'ground', kind: 'main', F, o: { from: s0 + 0.07, to: split, type: 'main' }, y, side: 1, max: Math.PI * 0.5, leafMat: 'walnut', thick: 0.07, handleMat: 'steel', height: 2.33 });
    const hinge = F.P(s0 + 0.07, nG); d.pivot.position.set(hinge[0], y, hinge[1]);
    d.setOpen(0);
    B.boxAlong(gid, 'steel', w.a, w.b, s0, s1, y - 0.01, y + 0.005, -h - 0.03, h);
  }

  let garagePanel = null;
  function buildGarage(w, F, o, ob, ot) {
    const gid = 'ground', h = w.t / 2, s0 = o.from, s1 = o.to;
    frameRect(gid, w, F, s0, s1, ob, ot, -h + 0.08, 0.1, 0.06, false);
    const grp = new THREE.Group(); grp.name = 'garage-door';
    const W = s1 - s0 - 0.1, H = ot - ob - 0.06;
    const panel = new THREE.Mesh(new THREE.BoxGeometry(W, H, 0.05), M.garage); panel.castShadow = true; panel.receiveShadow = true;
    // proper UVs for the panel texture (horizontal grooves)
    const uv = panel.geometry.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * W, uv.getY(i) * H);
    panel.position.set(0, H / 2, 0); grp.add(panel);
    const handle = new THREE.Mesh(handleGeo, M.steel); handle.rotation.x = Math.PI / 2; handle.scale.set(1.5, 0.08, 1.5); handle.position.set(0, 0.95, -0.04); grp.add(handle);
    const c = F.P((s0 + s1) / 2, -h + 0.1); grp.position.set(c[0], ob + 0.01, c[1]); grp.rotation.y = F.ry;
    G[gid].add(grp); garagePanel = { grp, H, y0: ob + 0.01 };
    const d = { id: 'garage', floorId: 'ground', kind: 'garage', center: V3(c[0], ob + 1.1, c[1]), pivot: grp,
      setOpen(t) { t = Math.max(0, Math.min(1, +t || 0)); grp.position.y = garagePanel.y0 + t * (H - 0.25); } };
    doors.push(d);
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
  function buildLift() {
    const L = CORE.lift, sx = (L.x0 + L.x1) / 2, sz = (L.z0 + L.z1) / 2;
    const dz0 = L.doorZ[0], dz1 = L.doorZ[1], dW = dz1 - dz0;
    // shaft pit + walls are covered by the core walls; add pit floor and shaft lining
    B.boxAB('basement', 'concrete', L.x0, LEVEL_Y.basement - 1.2, L.z0, L.x1, LEVEL_Y.basement - 1.0, L.z1);
    for (const [gid, y0, y1] of [['basement', LEVEL_Y.basement - 1.2, -0.3], ['ground', -0.3, 2.7], ['first', 2.7, 5.7], ['second', 5.7, ROOF.y]]) B.boxAB(gid, 'bWall', 0, y0, L.z0 - 0.1, 0.25, y1, L.z1 + 0.05); // shaft back wall (party side)
    // cab
    const cab = new THREE.Group(); cab.name = 'lift-cab';
    const cw = 0.98, cd = 1.38, ch = 2.2; // interior
    const add = (geo, mat, x, y, z, sxx, syy, szz, name) => { const m = new THREE.Mesh(geo, M[mat] || mat); m.position.set(x, y, z); m.scale.set(sxx, syy, szz); if (name) m.name = name; m.castShadow = false; m.receiveShadow = true; cab.add(m); return m; };
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
    for (const zz of [-cd / 2 + 0.05, cd / 2 - 0.05]) { const r = add(shared.cyl, 'steel', -0.05, 0.92, zz, 0.018, cw - 0.3, 0.018); r.rotation.z = Math.PI / 2; }
    const hr = add(shared.cyl, 'steel', -cw / 2 + 0.06, 0.92, 0, 0.018, cd - 0.3, 0.018); hr.rotation.x = Math.PI / 2;
    // button panel on the south front return, facing inwards (-x)
    const panel = new THREE.Group(); panel.name = 'lift-panel';
    panel.position.set(cw / 2 - 0.002, 1.1, cd / 2 - fw / 2);
    panel.rotation.y = -Math.PI / 2; // local +z faces -x (into the cab)
    const plate = new THREE.Mesh(bx, M.darkSteel); plate.scale.set(0.16, 0.5, 0.012); plate.name = 'lift-panel-plate'; panel.add(plate);
    const labels = [['second', '2'], ['first', '1'], ['ground', '0'], ['basement', '-1']];
    const btnGeo = new THREE.CylinderGeometry(0.022, 0.022, 0.012, 20); btnGeo.rotateX(Math.PI / 2);
    labels.forEach(([fid, lab], i) => {
      const off = new THREE.MeshStandardMaterial({ color: 0xd8d8d8, metalness: 0.9, roughness: 0.25, emissive: 0x000000 });
      const tt = textCanvasTexture(THREE, lab, { w: 128, h: 128, bg: null, fg: '#1a1a1a', font: '600 70px Helvetica, Arial, sans-serif' });
      const b = new THREE.Mesh(btnGeo, off); b.name = `lift-button-${fid}`;
      b.position.set(0, 0.16 - i * 0.1, 0.012);
      b.userData.liftButton = fid;
      b.userData.setLit = (on) => { off.emissive.set(on ? 0xffb85a : 0x000000); off.emissiveIntensity = on ? 4 : 0; };
      // face the +z direction: plane mapping on cylinder cap → fix uv by using a separate label disc
      const lab2 = new THREE.Mesh(new THREE.CircleGeometry(0.018, 20), new THREE.MeshStandardMaterial({ map: tt, transparent: true, roughness: 0.4, metalness: 0 }));
      lab2.position.z = 0.0065; lab2.userData.liftButton = fid; b.add(lab2);
      panel.add(b);
    });
    // floor indicator screen above the buttons
    const scr = new THREE.Mesh(bx, M.black); scr.scale.set(0.12, 0.06, 0.01); scr.position.set(0, 0.22 + 0.005, 0.008); panel.add(scr);
    cab.add(panel);
    // cab doors (two-panel side-opening, telescopic → both panels move to +z end? use centre-opening for elegance)
    const cabDoors = [];
    for (const sgn of [-1, 1]) {
      const d = new THREE.Mesh(bx, M.steel); d.scale.set(0.025, 2.08, dW / 2 + 0.01); d.position.set(cw / 2 + 0.07, 1.04, sgn * dW / 4); d.name = 'cab-door'; cab.add(d); cabDoors.push({ m: d, sgn });
    }
    try { const cl = new THREE.PointLight(0xfff0dc, 3, 3, 2); cl.name = 'cab-light-source'; cl.position.set(0, ch - 0.15, 0); cab.add(cl); } catch (e) { /* ignore */ }
    cab.position.set(sx - 0.05, 0, sz);
    group.add(cab);
    // landing doors + stainless frames + indicators
    const landing = {};
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
      ind.position.set(x + 0.021, y + 2.3, (dz0 + dz1) / 2); ind.rotation.y = Math.PI / 2; ind.name = `lift-indicator-${fid}`; G[gid].add(ind);
      // call button
      const cbm = new THREE.MeshStandardMaterial({ color: 0xd0d0d0, metalness: 0.9, roughness: 0.25 });
      const cb = new THREE.Mesh(btnGeo, cbm); cb.rotation.y = Math.PI / 2; cb.position.set(x + 0.02, y + 1.05, dz1 + 0.22); cb.name = `lift-call-${fid}`; cb.userData.liftCall = fid; G[gid].add(cb);
      B.boxAB(gid, 'steel', x, y + 0.95, dz1 + 0.17, x + 0.012, y + 1.15, dz1 + 0.27);
      const leaves = [];
      for (const sgn of [-1, 1]) {
        const d = new THREE.Mesh(bx, M.steel); d.scale.set(0.03, 2.1, dW / 2 + 0.01); d.position.set(L.doorOnX + 0.05, y + 1.05, (dz0 + dz1) / 2 + sgn * dW / 4); d.name = `landing-door-${fid}`; d.castShadow = true; G[gid].add(d); leaves.push({ m: d, sgn, z0: d.position.z });
      }
      landing[fid] = leaves;
    }
    let cabT = 0;
    liftObj.cab = cab;
    liftObj.shaft = { x: sx, z: sz };
    liftObj.levels = levels;
    liftObj.panel = panel;
    liftObj.setCabY = (y) => { cab.position.y = +y || 0; };
    liftObj.setCabDoors = (t) => { cabT = Math.max(0, Math.min(1, +t || 0)); for (const d of cabDoors) d.m.position.z = d.sgn * (dW / 4 + cabT * (dW / 2 - 0.02)); };
    liftObj.setLandingDoors = (fid, t) => { const ls = landing[fid]; if (!ls) return; t = Math.max(0, Math.min(1, +t || 0)); for (const d of ls) d.m.position.z = d.z0 + d.sgn * t * (dW / 2 - 0.02); };
    liftObj.setCabY(0); liftObj.setCabDoors(0);
    for (const fid of ORDER) liftObj.setLandingDoors(fid, 0);
    // register elevator 'doors' (kind 'elevator') so other modules can find them
    for (const fid of ORDER) doors.push({ id: `lift-${fid}`, floorId: fid, kind: 'elevator', center: V3(L.doorOnX, LEVEL_Y[fid] + 1.05, (dz0 + dz1) / 2), pivot: landing[fid][0].m, setOpen: (t) => liftObj.setLandingDoors(fid, t) });
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
    B.boxAB(g, 'glass', sx0 + 0.03, sy0 + 0.03, 14.665, sx1 - 0.03, sy1 - 0.03, 14.675);
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
    // ramp surface with anti-slip grooves
    const nz = 26, ramp = [];
    for (let i = 0; i <= nz; i++) { const z = RAMP.zBottom + (zK - RAMP.zBottom) * i / nz; ramp.push([z, rampY(z)]); }
    const prof = [...ramp, [zK, -3.2], [RAMP.zBottom, -3.2]];
    B.prismX(g, 'concrete', prof, RAMP_X[0], RAMP_X[1]);
    for (let z = RAMP.zBottom + 0.3; z < zK - 0.2; z += 0.5) { const y = rampY(z); B.box(g, 'darkSteel', (RAMP_X[0] + RAMP_X[1]) / 2, y + 0.005, z, RAMP_X[1] - RAMP_X[0] - 0.3, 0.012, 0.05, 0, Math.atan(RAMP.slope)); }
    // ramp side walls: west retaining wall full length, east wall outside the building
    const wallTop = (z) => Math.max(rampY(z) + 1.0, z < 14.7 ? -0.3 : Math.min(yS + 1.0, rampY(z) + 1.0));
    const wp = []; for (let i = 0; i <= nz; i++) { const z = RAMP.zBottom + (zK - RAMP.zBottom) * i / nz; wp.push([z, z < 14.7 ? 0 : wallTop(z)]); }
    B.prismX(g, 'render', [[RAMP.zBottom, -2.7], ...wp, [zK, -2.7]], 10.3, RAMP_X[0]);
    // east boundary wall with grey coping (right side in the renders), outside the footprint
    B.boxAB(g, 'render', 13.88, yS - 0.4, 14.7, 14.2, yS + 1.55, zK);
    B.boxAB(g, 'capGrey', 13.84, yS + 1.05, 14.7, 13.9, yS + 1.55, zK - 0.3);
    B.boxAB(g, 'stoneFine', 13.86, yS + 1.55, 14.7, 14.22, yS + 1.6, zK);
    // low front walls & gate piers along the kerb
    B.boxAB(g, 'render', RAMP_X[1], yS - 0.2, zK - 0.25, 14.2, yS + 0.85, zK);
    // street pavement edge strip inside the lot (kerb line)
    B.boxAB(g, 'stoneFine', LOT.x0, yS - 0.15, zK - 0.06, RAMP_X[0] - 0.2, yS + 0.02, zK);
    // house number plate + letterboxes on the tower base
    const numTex = textCanvasTexture(THREE, 'VILNYI · Nº 6', { w: 512, h: 128, bg: '#2a2c2f', fg: '#e8d9b8', font: '300 54px Georgia, "Times New Roman", serif' });
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.2), new THREE.MeshStandardMaterial({ map: numTex, metalness: 0.4, roughness: 0.4 }));
    plate.position.set(6.0, 1.75, 14.856); plate.name = 'house-number'; G.site.add(plate);
    // letterbox slot + parcel box beside the entrance (individual mailboxes are in the lobby)
    B.boxAB(g, 'darkSteel', 5.55, 0.9, 14.85, 6.45, 1.3, 14.9);
    B.boxAB(g, 'steel', 5.62, 1.12, 14.9, 6.38, 1.14, 14.905);
    // entrance canopy: the first-floor balcony slab covers the entrance; add a slim steel canopy edge + downlight
    // timber slat feature on the façade (lobby window screen)
    for (let x = 7.38; x < 8.78; x += 0.085) B.boxAB('ground', 'oak', x, 0.35, 14.86, x + 0.045, 2.55, 14.93);
    B.boxAB('ground', 'frame', 7.3, 0.3, 14.85, 8.86, 0.35, 14.95); B.boxAB('ground', 'frame', 7.3, 2.55, 14.85, 8.86, 2.6, 14.95);
    // video intercom
    B.boxAB('ground', 'darkSteel', 5.3, 1.3, 14.85, 5.44, 1.55, 14.88);
    B.boxAB('ground', 'steel', 5.33, 1.43, 14.88, 5.41, 1.51, 14.885);
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
  function carGeometry(color, seed) {
    const R = rng(seed);
    const L = 4.25 + R() * 0.4, Wd = 1.78, parts = [];
    const k = L / 4.4;
    const body = [[-2.2, 0.28], [2.2, 0.28], [2.24, 0.62], [2.05, 0.8], [0.95, 0.9], [0.35, 1.36], [-1.05, 1.4], [-1.85, 0.98], [-2.22, 0.88]].map(([z, y]) => new THREE.Vector2(z * k, y));
    const gl = [[0.9, 0.9], [0.36, 1.33], [-1.02, 1.37], [-1.78, 0.97]].map(([z, y]) => new THREE.Vector2(z * k * 1.01, y + 0.005));
    const mk = (pts, w, mat) => { const g = new THREE.ExtrudeGeometry(new THREE.Shape(pts), { depth: w, bevelEnabled: true, bevelSize: 0.04, bevelThickness: 0.04, bevelSegments: 2, curveSegments: 1 }); g.translate(0, 0, -w / 2); g.rotateY(-Math.PI / 2); return { g: NI(g), mat }; };
    // extrude shape (x=z-length, y) along z(width); after rotateY(-90°): shape x → world z, extrusion → world x
    parts.push(mk(body, Wd - 0.08, 'carPaint'));
    parts.push(mk(gl, Wd - 0.02, 'carGlass'));
    const col = new THREE.Color(color);
    const cp = parts[0].g; const cols = new Float32Array(cp.attributes.position.count * 3); for (let i = 0; i < cols.length; i += 3) { cols[i] = col.r; cols[i + 1] = col.g; cols[i + 2] = col.b; } cp.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    for (const zz of [1.4 * k, -1.35 * k]) for (const xx of [-0.78, 0.78]) { const w = NI(new THREE.CylinderGeometry(0.33, 0.33, 0.22, 14)); w.rotateZ(Math.PI / 2); w.translate(xx, 0.33, zz); parts.push({ g: w, mat: 'tyre' }); const h = NI(new THREE.CylinderGeometry(0.2, 0.2, 0.23, 10)); h.rotateZ(Math.PI / 2); h.translate(xx, 0.33, zz); parts.push({ g: h, mat: 'steel' }); }
    for (const xx of [-0.62, 0.62]) { const t = NI(new THREE.BoxGeometry(0.34, 0.08, 0.04)); t.translate(xx, 0.78, -2.2 * k - 0.04); parts.push({ g: t, mat: 'tailLight' }); const hl = NI(new THREE.BoxGeometry(0.32, 0.08, 0.04)); hl.translate(xx, 0.68, 2.22 * k + 0.02); parts.push({ g: hl, mat: 'headLight' }); }
    return parts;
  }
  function buildBasement() {
    const y = LEVEL_Y.basement, gid = 'basement', ceil = y + 2.4;
    // bay lines + numbers
    const numMats = [];
    for (const p of PARKING) {
      const { x0, x1, z0, z1 } = p;
      const line = (a0, b0, a1, b1) => B.boxAB(gid, 'white', a0, y + 0.001, b0, a1, y + 0.006, b1);
      if (!p.rotated) { line(x0, z0 - 0.05, x1, z0 + 0.05); line(x0, z1 - 0.05, x1, z1 + 0.05); }
      else { line(x0 - 0.05, z0, x0 + 0.05, z1); line(x1 - 0.05, z0, x1 + 0.05, z1); }
      const t = textCanvasTexture(THREE, p.id, { w: 256, h: 128, bg: null, fg: '#f4f4f0', font: '700 92px Helvetica, Arial, sans-serif' });
      const mat = new THREE.MeshStandardMaterial({ map: t, transparent: true, roughness: 0.6 }); numMats.push(mat);
      const pl = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.45), mat); pl.name = `bay-${p.id}`;
      pl.rotation.x = -Math.PI / 2;
      if (!p.rotated) { pl.position.set(x1 - 0.55, y + 0.008, (z0 + z1) / 2); pl.rotation.z = Math.PI / 2; }
      else { pl.position.set((x0 + x1) / 2, y + 0.008, p.id === 'P5' ? z0 + 0.5 : z0 + 0.55); if (p.id !== 'P5') pl.rotation.z = Math.PI; }
      G[gid].add(pl);
      // wheel stop
      if (!p.rotated) B.boxAB(gid, 'rubber', x0 + 0.55, y, (z0 + z1) / 2 - 0.8, x0 + 0.7, y + 0.1, (z0 + z1) / 2 + 0.8);
    }
    // cars (varied tasteful colours)
    const colors = [0x1d1f22, 0xe9e9e6, 0x5b6770, 0x7a1d1d, 0x23364f, 0xb9b4a8, 0x2f4a3a, 0x8d8f91];
    PARKING.forEach((p, i) => {
      const parts = carGeometry(colors[i % colors.length], 900 + i);
      const cx = (p.x0 + p.x1) / 2, cz = (p.z0 + p.z1) / 2;
      const m = new THREE.Matrix4();
      if (!p.rotated) m.makeRotationY(Math.PI / 2 * (i % 2 ? 1 : -1)); else m.makeRotationY(p.id === 'P5' ? 0 : Math.PI);
      m.setPosition(cx + (p.rotated ? 0 : -0.15 * (i % 2 ? 1 : -1)), y, cz);
      for (const { g, mat } of parts) { g.applyMatrix4(m); g.userData.keepUV = true; if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2)); B.push(gid, mat, g); }
    });
    // columns
    for (const [x, z] of [[5.6, -5.5], [5.6, -0.8], [5.6, 3.9], [5.6, 8.9], [8.2, 1.9]]) {
      B.boxAB(gid, 'concrete', x - 0.15, y, z - 0.15, x + 0.15, ceil, z + 0.15);
      B.boxAB(gid, 'darkSteel', x - 0.155, y, z - 0.155, x + 0.155, y + 0.25, z + 0.155); // hazard band base (dark)
    }
    // ceiling: LED linear lights along aisle and bays
    for (let z = -6.5; z < 13; z += 3.0) B.boxAB('basement', 'ledPanel', 6.8, ceil - 0.03, z, 8.2, ceil - 0.005, z + 0.12);
    for (const p of PARKING.filter(p => !p.rotated)) B.boxAB('basement', 'ledPanel', 2.3, ceil - 0.03, (p.z0 + p.z1) / 2 - 0.06, 3.5, ceil - 0.005, (p.z0 + p.z1) / 2 + 0.06);
    for (const p of PARKING.filter(p => p.rotated)) B.boxAB('basement', 'ledPanel', (p.x0 + p.x1) / 2 - 0.06, ceil - 0.03, (p.z0 + p.z1) / 2 - 0.6, (p.x0 + p.x1) / 2 + 0.06, ceil - 0.005, (p.z0 + p.z1) / 2 + 0.6);
    // ceiling slab underside under the garden (outside the footprint)
    // walkway marking to the lift lobby
    for (let x = 2.9; x < 5.5; x += 0.5) B.boxAB(gid, 'white', x, y + 0.001, 6.55, x + 0.3, y + 0.006, 6.95);
    // technical-room door sign
    B.boxAB(gid, 'frame', 3.75, y + 2.15, 9.12, 4.65, y + 2.3, 9.13);
    // wall dado stripe (anthracite band) on west and rear walls
    B.boxAB(gid, 'darkSteel', 0.176, y + 0.05, -7.72, 0.19, y + 1.1, 7.05);
    B.boxAB(gid, 'darkSteel', 0.18, y + 0.05, -7.73, 8.1, y + 1.1, -7.72);
  }

  // ───────── lobby ─────────
  function buildLobby() {
    const g = 'ground', y = 0;
    // timber slat feature wall on x=2.85 face (z 11.2 → 14.45)
    B.boxAB(g, 'walnut', 2.86, y, 11.2, 2.9, 2.7, 14.5);
    for (let z = 11.25; z < 14.45; z += 0.09) B.boxAB(g, 'oak', 2.9, y + 0.05, z, 2.96, 2.65, z + 0.05);
    // warm LED coves: top and bottom of the slat wall (wall-washer glow), ceiling shadow gap around the lobby
    B.boxAB(g, 'ledWarm', 2.91, 2.66, 11.2, 2.93, 2.68, 14.5);
    B.boxAB(g, 'ledWarm', 2.91, 0.02, 11.2, 2.93, 0.04, 14.5);
    B.boxAB(g, 'ledWarm', 9.36, 2.66, 9.35, 9.38, 2.68, 14.4);
    // warm key light under the ring pendant (one of ≤2 building point lights)
    try {
      const pl = new THREE.PointLight(0xffd2a0, 10, 9, 2); pl.name = 'lobby-light'; pl.position.set(6.2, 1.95, 12.0); pl.castShadow = false; G[g].add(pl);
    } catch (e) { /* ignore */ }
    // backlit logo panel
    const lt = textCanvasTexture(THREE, 'VILNYI', { w: 1024, h: 256, bg: '#1b1714', fg: '#ffe2b0', font: '300 150px Georgia, "Times New Roman", serif' });
    const logo = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.375), new THREE.MeshStandardMaterial({ map: lt, emissive: 0xffffff, emissiveMap: lt, emissiveIntensity: 1.2, roughness: 0.5 }));
    logo.position.set(2.975, 1.65, 12.85); logo.rotation.y = Math.PI / 2; logo.name = 'lobby-logo'; G[g].add(logo);
    B.boxAB(g, 'darkSteel', 2.955, 1.44, 12.07, 2.97, 1.86, 13.63);
    B.boxAB(g, 'logo', 2.96, 1.42, 12.04, 2.965, 1.88, 12.07); B.boxAB(g, 'logo', 2.96, 1.42, 13.63, 2.965, 1.88, 13.66);
    // pendant: large brass ring
    const ring = NI(new THREE.TorusGeometry(0.55, 0.02, 8, 48)); ring.rotateX(Math.PI / 2); ring.translate(6.2, 2.05, 12.0); B.push(g, 'brass', ring);
    const ringL = NI(new THREE.TorusGeometry(0.55, 0.012, 6, 48)); ringL.rotateX(Math.PI / 2); ringL.translate(6.2, 2.03, 12.0); B.push(g, 'logo', ringL);
    for (const a of [0, 2.09, 4.19]) B.cyl(g, 'darkSteel', [6.2 + Math.cos(a) * 0.55, 2.05, 12.0 + Math.sin(a) * 0.55], [6.2, 2.7, 12.0], 0.003, 4);
    // bench (walnut on steel) against the east wall
    B.boxAB(g, 'walnut', 8.95, 0.42, 11.6, 9.4, 0.47, 13.6);
    for (const z of [11.75, 13.45]) B.boxAB(g, 'darkSteel', 9.0, 0, z - 0.03, 9.35, 0.42, z + 0.03);
    // mailboxes (8) on the east wall by the landing
    B.boxAB(g, 'darkSteel', 9.33, 0.95, 9.55, 9.4, 1.65, 10.95);
    for (let r = 0; r < 2; r++) for (let c = 0; c < 4; c++) B.boxAB(g, 'brass', 9.325, 1.02 + r * 0.32, 9.6 + c * 0.34, 9.33, 1.3 + r * 0.32, 9.9 + c * 0.34);
    // plant pot + olive bush
    B.cyl(g, 'planterDark', [8.95, 0, 14.15], [8.95, 0.6, 14.15], 0.26, 20, 0.3);
    bush(g, 8.95, 0.55, 14.15, 0.42, 'olive', 404);
    // doormat recess
    B.boxAB(g, 'darkSteel', 3.75, 0.0, 13.6, 5.15, 0.004, 14.5);
    // skirting shadow gap lines along lobby walls
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
      for (const sg of sides) for (const [a, b] of segs) {
        // skip the skirting where the inner side is outdoors (street wall behind the tower is fine)
        const mid = F.P((a + b) / 2, sg * (h + 0.3));
        if (!pointInPoly(mid[0], mid[1], FP)) continue;
        B.boxAlong(gid, 'skirting', w.a, w.b, a, b, y, y + 0.08, sg > 0 ? h : -h - 0.012, sg > 0 ? h + 0.012 : -h);
      }
    }
  }

  // ───────── pickers & highlight ─────────
  const floorPickers = [];
  const highlight = {};
  function buildPickersAndHighlight() {
    const pickMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, colorWrite: false });
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

  // ───────── cutaway ─────────
  let cutFloor = null;
  function setCutaway(fid) {
    cutFloor = fid && ORDER.includes(fid) ? fid : null;
    const idx = cutFloor ? ORDER.indexOf(cutFloor) : 99;
    const show = (gid, level) => { G[gid].visible = level <= idx; };
    show('basement', 0); show('ground', 1); show('first', 2); show('second', 3);
    G['ground-ceil'].visible = idx > 1; G['first-ceil'].visible = idx > 2; G['second-ceil'].visible = idx > 3;
    G.roofshell.visible = idx > 3 || (idx === 99); G.roof.visible = idx > 3;
    // the ground slab (in 'ground') also forms the basement ceiling: hidden when cutting at the basement
    // lift cab: hide when above the cut
    if (liftObj.cab) liftObj.cab.visible = !cutFloor || liftObj.cab.position.y <= LEVEL_Y[cutFloor] + 0.5;
    for (const d of doors) if (d.pivot && d.pivot.parent) {/* handled by group visibility */}
  }

  // ───────── assemble ─────────
  const steps = [
    () => { for (const f of FLOORS) buildWalls(f); },
    buildSlabs, buildCommonCeilings, buildStairs, buildLift, buildMansard, buildTower, buildBalconies,
    buildSite, buildBasement, buildLobby, () => { for (const f of FLOORS) buildSkirting(f); },
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
  try { B.finalize(G, M, { noCast: ['glass', 'railGlass', 'downlight', 'ledPanel', 'grass'] }); } catch (err) { if (typeof console !== 'undefined') console.warn('[building] finalize failed', err); }
  // interiors don't need shadow casting from ceiling/floor finishes inside — keep the exterior shells casting
  group.traverse(o => { if (o.isMesh && /-(ceil)/.test(o.parent ? o.parent.name : '')) o.castShadow = false; });

  if (scene) scene.add(group);

  // ───────── update ─────────
  function update(dt) {
    dt = Math.min(0.1, Math.max(0, +dt || 0));
    for (const k of Object.keys(highlight)) {
      const h = highlight[k];
      if (h.t === h.target) continue;
      h.t = h.target > h.t ? Math.min(h.target, h.t + dt * 4) : Math.max(h.target, h.t - dt * 3);
      h.g.visible = h.t > 0.001;
      h.mats[0].opacity = 0.2 * h.t; h.mats[1].opacity = 0.9 * h.t;
    }
    for (const a of animators) a(dt);
    if (cutFloor && liftObj.cab) liftObj.cab.visible = liftObj.cab.position.y <= LEVEL_Y[cutFloor] + 0.5;
  }

  return {
    group,
    floorPickers,
    highlightFloor,
    setCutaway,
    doors,
    lift: liftObj,
    update,
    // extras
    levels: LEVEL_Y,
    rampY,
    stairLayout: STAIR
  };
}
