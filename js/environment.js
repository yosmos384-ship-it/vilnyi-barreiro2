// VILNYI · Barreiro 2 — ENVIRONMENT (agent: ENVIRONMENT)
//
// export function buildEnvironment(THREE, { scene, renderer, quality:'high'|'low' }) => {
//   group, sun, setTimeOfDay('day'|'golden'|'dusk'), geo(lat, lon) => Vector3, update(dt, camera),
//   heightAt(x, z), timeOfDay, waterY
// }
//
// Camera assumptions: near 0.05 … 1, far 30 000 … 60 000 m. The sky dome follows the camera and is drawn
// behind everything (depthTest off), so it never gets clipped. Nothing in this module is further than ~20 km.
// Far land/skyline materials use polygonOffset against the water, so a 24-bit depth buffer with near 0.05 works.
//
// World: x = east, z = south, y = up, metres. Origin of geo() = PROJECT.lat/lon at x = 7, z = 7 (building centre).

import { PROJECT, LOT, STREET, STREET_Y, LANDMARKS } from './data.js';

let T = null; // THREE namespace (set in buildEnvironment)

const DEG = Math.PI / 180;
const LAT0 = PROJECT.lat, LON0 = PROJECT.lon;
const M_LAT = 110540;
const M_LON = 111320 * Math.cos(LAT0 * DEG);

export const WATER_Y = -12.7;     // Tagus mean level: street is +11.85 m on the drawings → river ≈ 12.7 m below y=0
const PAVE_Y = STREET_Y;          // -0.85 pavement
const TERR_FLAT = STREET_Y - 0.13; // -0.98 terrain / yards level on the plateau around the site
const NEAR_Y = TERR_FLAT;         // detailed ground around the lot
const ROAD_UP = 0.03;             // asphalt above terrain (kerb = PAVE_UP - ROAD_UP = 10 cm)
const PAVE_UP = 0.13;             // pavements: TERR_FLAT + 0.13 = STREET_Y (-0.85)
const FAR_Y = -6;                 // generic far land height
const SINK = 2.0;                 // buildings extend this far below their base (slopes)
const GRID = { x0: -3053, x1: 3067, z0: -1253, z1: 3337, cell: 30 };  // local terrain (30 m cells)
const FLAT = { x0: -143, x1: 157, z0: -25, z1: 157 };                 // flat plateau around the site
const NEARG = { x0: -53, x1: 67, z0: -23, z1: 47 };                   // terrain cells replaced by detailed ground (lot cut out)
const FARG = { cell: 255, x0: -3053 - 255 * 76, x1: 3067 + 255 * 52, z0: -1253 - 255 * 83, z1: 3337 + 255 * 30 };
const NEAR_R = 790;               // procedural streets/houses radius around the site

// ---------------------------------------------------------------- small utils
function rngFrom(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

export function geoXZ(lat, lon) {
  return [7 + (lon - LON0) * M_LON, 7 - (lat - LAT0) * M_LAT];
}

// Lavradio shoreline (x → z); land is south (z larger)
function zShore(x) {
  let z = -859 + 32 * Math.sin(x / 410 + 0.7) + 16 * Math.sin(x / 160 + 2.1);
  if (x < -1500) z += (-1500 - x) * 0.75;   // Barreiro peninsula tip bends south-west
  if (x > 800) z += (x - 800) * 0.22;       // Baixa da Banheira / Moita inlet
  return z;
}
export function zRail(x) { return -485 + x * 0.058; } // railway through Lavradio station

// Land polygons in world metres (south bank incl. Almada/Barreiro/Montijo; north bank = Lisbon)
function southPoly() {
  const P = [[-19300, 11000], [16000, 11000], [16000, -12400], [9400, -12370], [7575, -9610], [5053, -6625],
    [6445, -4193], [7300, -2000], [6500, 1500], [4500, 400]];
  for (let x = 3800; x >= -2950; x -= 50) P.push([x, zShore(x)]);
  P.push([-3100, 500], [-2750, 1240], [-2900, 1700], [-3600, 2300], [-4200, 3300], [-6000, 3000], [-6700, 1500],
    [-6670, 357], [-7600, -900], [-8575, -2403], [-9892, -1983], [-10760, -1420], [-12325, -867], [-17094, 7], [-19270, 900]);
  return P;
}
const LISBON_POLY = [[-23000, -2300], [-16190, -2979], [-14450, -2757], [-11146, -3531], [-8797, -4083], [-7623, -4249],
  [-6305, -4968], [-4913, -6516], [-4305, -8174], [-3870, -10717], [-3783, -12596], [-4305, -14033], [-1870, -17902],
  [-1870, -22600], [-23000, -22600]];
let SOUTH_POLY = null;

function polySD(P, x, z) { // signed distance, + inside
  let inside = false, d2 = Infinity;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [xi, zi] = P[i], [xj, zj] = P[j];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
    const ex = xj - xi, ez = zj - zi, l2 = ex * ex + ez * ez || 1;
    const t = clamp(((x - xi) * ex + (z - zi) * ez) / l2, 0, 1);
    const dx = x - (xi + ex * t), dz = z - (zi + ez * t);
    d2 = Math.min(d2, dx * dx + dz * dz);
  }
  const d = Math.sqrt(d2);
  return inside ? d : -d;
}
function vnoise(x, z) {
  return Math.sin(x * 0.0041 + 1.3) * Math.cos(z * 0.0033 - 0.4) + 0.5 * Math.sin(x * 0.011 - z * 0.009 + 2.0);
}

// Terrain height (m). Flat plateau around the site, falling gently north to the river.
export function heightAt(x, z) {
  if (!SOUTH_POLY) SOUTH_POLY = southPoly();
  if (x >= FLAT.x0 && x <= FLAT.x1 && z >= FLAT.z0 && z <= FLAT.z1) return TERR_FLAT;
  const inLocal = x >= GRID.x0 && x <= GRID.x1 && z >= GRID.z0 && z <= GRID.z1;
  const sd = polySD(SOUTH_POLY, x, z);
  if (sd > -400) {
    const dx = Math.max(FLAT.x0 - x, 0, x - FLAT.x1), dz = Math.max(FLAT.z0 - z, 0, z - FLAT.z1);
    const d = Math.hypot(dx, dz);
    let h = TERR_FLAT + vnoise(x, z) * 1.6 * Math.min(1, d / 200);
    const north = Math.max(0, FLAT.z0 - z);
    h -= Math.min(north, 330) * 0.022 + Math.max(0, north - 330) * 0.003; // Lavradio slope down to the river
    const toShore = z - zShore(x);
    if (toShore < 140 && x > -3000 && x < 3000) h = lerp(WATER_Y + 1.6, h, smooth(10, 140, toShore)); // low waterfront
    if (x < -8500) h = WATER_Y + 1.2 + smooth(0, 280, sd) * 96 + vnoise(x, z) * 4 * smooth(0, 400, sd); // Almada cliffs
    h = Math.max(h, WATER_Y + 1.2);
    if (!inLocal && x >= -8500) {
      const out = Math.max(GRID.x0 - x, x - GRID.x1, GRID.z0 - z, z - GRID.z1);
      h = FAR_Y + vnoise(x * 0.3, z * 0.3) * 4 * smooth(0, 600, out);
    } else if (inLocal) {
      const e = Math.min(x - GRID.x0, GRID.x1 - x, z - GRID.z0, GRID.z1 - z);
      if (e < 400) h = lerp(FAR_Y, h, smooth(0, 400, e));
    }
    return lerp(WATER_Y - 3, h, smooth(-8, 25, sd));
  }
  const ld = polySD(LISBON_POLY, x, z);
  if (ld > -400) {
    const h = WATER_Y + 2 + smooth(0, 1500, ld) * 85 + (vnoise(x * 0.6, z * 0.6) + 1) * 22 * smooth(0, 500, ld)
      + smooth(1500, 5000, ld) * 40 + (x < -13000 ? smooth(0, 2500, ld) * 110 : 0); // seven hills, Monsanto (W)
    return lerp(WATER_Y - 3, h, smooth(-8, 30, ld));
  }
  return WATER_Y - 3;
}
// Height of the rendered local terrain mesh (same triangulation as buildGridMesh) — use to seat objects.
const _gh = new Map();
function gridH(i, j) {
  const k = i * 100003 + j;
  let v = _gh.get(k);
  if (v === undefined) { v = Math.max(WATER_Y + 0.02, heightAt(GRID.x0 + i * GRID.cell, GRID.z0 + j * GRID.cell)); _gh.set(k, v); }
  return v;
}
export function groundY(x, z) {
  if (x > NEARG.x0 && x < NEARG.x1 && z > NEARG.z0 && z < NEARG.z1) return NEAR_Y;
  if (x < GRID.x0 || x > GRID.x1 || z < GRID.z0 || z > GRID.z1) return heightAt(x, z);
  const fx = (x - GRID.x0) / GRID.cell, fz = (z - GRID.z0) / GRID.cell;
  const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
  const a = gridH(i, j), b = gridH(i + 1, j), c = gridH(i, j + 1), d = gridH(i + 1, j + 1);
  // triangles (a,c,b) and (b,c,d): split along the b–c diagonal (u + v = 1)
  if (u + v <= 1) return a + (b - a) * u + (c - a) * v;
  return d + (c - d) * (1 - u) + (b - d) * (1 - v);
}
export function isLand(x, z) { return heightAt(x, z) > WATER_Y + 0.5; }

// ---------------------------------------------------------------- geometry builder
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

class GB {
  constructor() { this.p = []; this.n = []; this.u = []; this.c = []; this.col = [1, 1, 1]; this.fixUV = null; }
  plain(on = true) { this.fixUV = on ? [0.005, 0.9985] : null; return this; } // plain plaster texel of the façade atlas
  get empty() { return this.p.length === 0; }
  // arrays are sRGB 0..1 (like CSS), THREE.Color instances are used as-is (linear), strings/numbers parsed as sRGB hex
  color(c) {
    let k;
    if (c && c.isColor) k = c;
    else if (Array.isArray(c)) k = new T.Color().setRGB(c[0], c[1], c[2], T.SRGBColorSpace);
    else k = new T.Color(c);
    this.col = [k.r, k.g, k.b];
    return this;
  }
  _v(p, n, u) { if (this.fixUV) u = this.fixUV; this.p.push(p[0], p[1], p[2]); this.n.push(n[0], n[1], n[2]); this.u.push(u[0], u[1]); this.c.push(this.col[0], this.col[1], this.col[2]); }
  tri(a, b, c, ua = [0, 0], ub = [1, 0], uc = [0, 1], out) {
    let n = cross(sub(b, a), sub(c, a));
    if (out && dot3(n, out) < 0) { [b, c] = [c, b]; [ub, uc] = [uc, ub]; n = [-n[0], -n[1], -n[2]]; }
    n = norm3(n);
    this._v(a, n, ua); this._v(b, n, ub); this._v(c, n, uc);
  }
  quad(a, b, c, d, uvs, out) {
    uvs = uvs || [[0, 0], [1, 0], [1, 1], [0, 1]];
    const n = cross(sub(b, a), sub(c, a));
    if (out && dot3(n, out) < 0) { [a, b, c, d] = [d, c, b, a]; uvs = [uvs[3], uvs[2], uvs[1], uvs[0]]; }
    this.tri(a, b, c, uvs[0], uvs[1], uvs[2]);
    this.tri(a, c, d, uvs[0], uvs[2], uvs[3]);
  }
  // axis-aligned box with world-scaled uvs (s = metres per texture repeat)
  box(x0, y0, z0, x1, y1, z1, s = 1, skip = { bottom: true }) {
    const U = (a, b) => [a / s, b / s];
    if (!skip.top) this.quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], [U(x0, z0), U(x1, z0), U(x1, z1), U(x0, z1)], [0, 1, 0]);
    if (!skip.bottom) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [U(x0, z0), U(x1, z0), U(x1, z1), U(x0, z1)], [0, -1, 0]);
    if (!skip.px) this.quad([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0], [U(z0, y0), U(z1, y0), U(z1, y1), U(z0, y1)], [1, 0, 0]);
    if (!skip.nx) this.quad([x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [U(z1, y0), U(z0, y0), U(z0, y1), U(z1, y1)], [-1, 0, 0]);
    if (!skip.pz) this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [U(x0, y0), U(x1, y0), U(x1, y1), U(x0, y1)], [0, 0, 1]);
    if (!skip.nz) this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [U(x1, y0), U(x0, y0), U(x0, y1), U(x1, y1)], [0, 0, -1]);
    return this;
  }
  // box centred at (cx, cz) rotated by ry around y
  rbox(cx, cz, w, d, y0, y1, ry, s = 1) {
    const g = new T.BoxGeometry(w, y1 - y0, d);
    const m = new T.Matrix4().makeRotationY(ry).setPosition(cx, (y0 + y1) / 2, cz);
    this.geom(g, m, s);
    g.dispose();
    return this;
  }
  geom(g, m, s = 1) {
    const gg = g.index ? g.toNonIndexed() : g;
    const P = gg.attributes.position, N = gg.attributes.normal, UV = gg.attributes.uv;
    const v = new T.Vector3(), nn = new T.Vector3();
    const nm = new T.Matrix3().getNormalMatrix(m || new T.Matrix4());
    for (let i = 0; i < P.count; i++) {
      v.fromBufferAttribute(P, i); if (m) v.applyMatrix4(m);
      if (N) { nn.fromBufferAttribute(N, i).applyMatrix3(nm).normalize(); } else nn.set(0, 1, 0);
      this.p.push(v.x, v.y, v.z); this.n.push(nn.x, nn.y, nn.z);
      if (this.fixUV) this.u.push(this.fixUV[0], this.fixUV[1]);
      else if (UV) this.u.push(UV.getX(i) / s, UV.getY(i) / s); else this.u.push(0, 0);
      this.c.push(this.col[0], this.col[1], this.col[2]);
    }
    if (gg !== g) gg.dispose();
    return this;
  }
  build() {
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new T.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new T.Float32BufferAttribute(this.u, 2));
    g.setAttribute('color', new T.Float32BufferAttribute(this.c, 3));
    g.computeBoundingSphere();
    return g;
  }
}

// ---------------------------------------------------------------- procedural canvas textures
function canvasTex(size, draw, { repeat = true, srgb = true, aniso = 8, h = size } = {}) {
  const c = document.createElement('canvas');
  c.width = size; c.height = h;
  const ctx = c.getContext('2d');
  draw(ctx, size, h);
  const t = new T.CanvasTexture(c);
  if (srgb) t.colorSpace = T.SRGBColorSpace;
  if (repeat) { t.wrapS = t.wrapT = T.RepeatWrapping; }
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

function makeTextures(rng, aniso) {
  const tex = {};
  // Asphalt — 8 m tile
  tex.asphalt = canvasTex(512, (g, s) => {
    g.fillStyle = '#56575a'; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 26000; i++) {
      const v = 60 + rng() * 70 | 0;
      g.fillStyle = `rgba(${v},${v},${v + 3},${0.35 + rng() * 0.4})`;
      g.fillRect(rng() * s, rng() * s, 1 + rng() * 1.6, 1 + rng() * 1.6);
    }
    for (let i = 0; i < 6; i++) { // soft repair patches
      const v = 70 + rng() * 25 | 0;
      g.fillStyle = `rgba(${v},${v},${v + 2},0.12)`;
      g.beginPath(); g.ellipse(rng() * s, rng() * s, 30 + rng() * 90, 15 + rng() * 40, rng() * 3, 0, Math.PI * 2); g.fill();
    }
    g.strokeStyle = 'rgba(28,28,30,0.55)'; g.lineWidth = 1.2;
    for (let i = 0; i < 9; i++) { // cracks
      let x = rng() * s, y = rng() * s; g.beginPath(); g.moveTo(x, y);
      for (let k = 0; k < 14; k++) { x += (rng() - 0.5) * 26; y += (rng() - 0.3) * 20; g.lineTo(x, y); }
      g.stroke();
    }
  }, { aniso });
  // White limestone calçada — 1.6 m tile, ~6.5 cm cubes laid in slightly irregular rows
  tex.calcada = canvasTex(512, (g, s) => {
    g.fillStyle = '#9a958b'; g.fillRect(0, 0, s, s);
    const n = 24, cs = s / n;
    for (let r = 0; r < n; r++) {
      const off = (r % 2) * cs * 0.5 + (rng() - 0.5) * 4;
      for (let c = -1; c <= n; c++) {
        const w = cs * (0.78 + rng() * 0.18), hh = cs * (0.78 + rng() * 0.18);
        const x = c * cs + off + (rng() - 0.5) * 2.5, y = r * cs + (rng() - 0.5) * 2.5;
        const v = 214 + rng() * 26 | 0, wv = rng() < 0.06 ? -40 : 0;
        g.fillStyle = `rgb(${v + wv},${v - 3 + wv},${v - 10 + wv})`;
        const rr = 3;
        g.beginPath();
        g.moveTo(x + rr, y); g.lineTo(x + w - rr, y); g.quadraticCurveTo(x + w, y, x + w, y + rr);
        g.lineTo(x + w, y + hh - rr); g.quadraticCurveTo(x + w, y + hh, x + w - rr, y + hh);
        g.lineTo(x + rr, y + hh); g.quadraticCurveTo(x, y + hh, x, y + hh - rr);
        g.lineTo(x, y + rr); g.quadraticCurveTo(x, y, x + rr, y); g.fill();
      }
    }
    for (let i = 0; i < 1400; i++) { g.fillStyle = `rgba(80,76,70,${rng() * 0.12})`; g.fillRect(rng() * s, rng() * s, 2, 2); }
  }, { aniso });
  // Rubble stone (garden wall bases) — 2 m tile
  tex.stone = canvasTex(256, (g, s) => {
    g.fillStyle = '#8c8578'; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 90; i++) {
      const x = rng() * s, y = rng() * s, r = 10 + rng() * 16, v = 170 + rng() * 50 | 0;
      g.fillStyle = `rgb(${v},${v - 8},${v - 22})`;
      g.beginPath();
      for (let k = 0; k < 7; k++) { const a = k / 7 * Math.PI * 2; const rr = r * (0.7 + rng() * 0.4); g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr * 0.75); }
      g.closePath(); g.fill();
    }
  }, { aniso });
  // Wrought-iron loops (balcony / gate), alpha
  tex.iron = canvasTex(256, (g, s, h) => {
    g.clearRect(0, 0, s, h);
    g.strokeStyle = '#ffffff'; g.lineWidth = 7;
    g.strokeRect(4, 4, s - 8, h - 8);
    g.lineWidth = 5;
    for (let i = 0; i < 4; i++) {
      const cx = (i + 0.5) * s / 4;
      g.beginPath(); g.ellipse(cx, h * 0.5, s / 9, h * 0.34, 0, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.moveTo(i * s / 4, 6); g.lineTo(i * s / 4, h - 6); g.stroke();
    }
  }, { aniso, srgb: true, h: 128 });
  // Green garden fence mesh, alpha
  tex.fence = canvasTex(128, (g, s) => {
    g.clearRect(0, 0, s, s);
    g.strokeStyle = '#2f5a3c'; g.lineWidth = 3;
    for (let i = 0; i <= 8; i++) { g.beginPath(); g.moveTo(i * s / 8, 0); g.lineTo(i * s / 8, s); g.stroke(); }
    g.lineWidth = 2;
    for (let i = 0; i <= 16; i++) { g.beginPath(); g.moveTo(0, i * s / 16); g.lineTo(s, i * s / 16); g.stroke(); }
    g.fillStyle = '#2f5a3c'; g.fillRect(0, 0, s, 8); g.fillRect(0, s - 8, s, 8);
  }, { aniso });
  // Terracotta roof tiles (canal tiles), white-ish so instance colour tints it
  tex.tiles = canvasTex(256, (g, s) => {
    g.fillStyle = '#f2f2f2'; g.fillRect(0, 0, s, s);
    const cols = 16, rows = 16;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = c * s / cols, y = r * s / rows;
        const grd = g.createLinearGradient(x, 0, x + s / cols, 0);
        const v = 0.86 + rng() * 0.14;
        grd.addColorStop(0, `rgba(0,0,0,${0.35})`);
        grd.addColorStop(0.5, `rgba(255,255,255,${0.15 * v})`);
        grd.addColorStop(1, `rgba(0,0,0,${0.35})`);
        g.fillStyle = grd; g.fillRect(x, y, s / cols, s / rows);
        g.fillStyle = `rgba(0,0,0,${0.25 + rng() * 0.2})`; g.fillRect(x, y + s / rows - 2, s / cols, 2);
        if (rng() < 0.08) { g.fillStyle = 'rgba(60,40,20,0.25)'; g.fillRect(x, y, s / cols, s / rows); }
      }
    }
  }, { aniso });
  // Dry yard / verge ground (earth, straw, weeds) — 6 m tile, tinted by vertex colour
  tex.yard = canvasTex(256, (g, s) => {
    g.fillStyle = '#bfb39c'; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 5000; i++) {
      const t = rng();
      g.fillStyle = t < 0.5 ? `rgba(${150 + rng() * 60 | 0},${130 + rng() * 50 | 0},${80 + rng() * 40 | 0},0.5)` : t < 0.8 ? `rgba(${110 + rng() * 40 | 0},${115 + rng() * 40 | 0},${70 + rng() * 30 | 0},0.45)` : `rgba(90,80,65,0.35)`;
      g.fillRect(rng() * s, rng() * s, 1 + rng() * 3, 1 + rng() * 5);
    }
  }, { aniso });
  // Soft radial glow (street-lamp light pools, halos)
  tex.glow = canvasTex(128, (g, s) => {
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.35, 'rgba(255,255,255,0.45)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, s, s);
  }, { repeat: false });
  return tex;
}

// ---------------------------------------------------------------- sky
// Gradient + sun + procedural cumulus dome. Outputs display colours without tone mapping so that the
// scene fog (applied after tone mapping in r160) can match its horizon colour exactly.
const SKY_VS = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); // radius 900 m, follows the camera
}`;
const SKY_FS = /* glsl */`
uniform vec3 zenith; uniform vec3 horizon; uniform vec3 horizonAway; uniform vec3 mid; uniform vec3 ground; uniform vec3 sunCol; uniform vec3 glowCol;
uniform vec3 sunDir; uniform float sunSize; uniform float cloudCover; uniform vec3 cloudLit; uniform vec3 cloudShade;
uniform float time; uniform float stars;
varying vec3 vDir;
float h21(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }
float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y); }
float fbm(vec2 p){ float a=0.5, s=0.0; for(int i=0;i<5;i++){ s+=a*vn(p); p=p*2.03+vec2(1.7,9.2); a*=0.5; } return s; }
void main() {
  vec3 d = normalize(vDir);
  float y = d.y;
  float sd = max(dot(d, sunDir), 0.0);
  vec2 hd = normalize(d.xz + 1e-5), hs = normalize(sunDir.xz + 1e-5);
  float toward = 0.5 + 0.5 * dot(hd, hs);
  vec3 hor = mix(horizonAway, horizon, pow(toward, 1.6));
  float yy = clamp(y, 0.0, 1.0);
  vec3 col = mix(hor, mid, smoothstep(0.0, 0.22, pow(yy, 0.8)));
  col = mix(col, zenith, smoothstep(0.12, 0.85, yy));
  // warm glow around the sun near the horizon
  float hz = 1.0 - smoothstep(0.0, 0.45, abs(y));
  col += glowCol * (pow(sd, 6.0) * 0.55 + pow(sd, 32.0) * 0.6) * (0.35 + 0.65 * hz);
  // below horizon: blend to ground haze
  col = mix(col, ground, smoothstep(0.0, -0.08, y));
  // clouds on a virtual plane
  if (y > 0.015 && cloudCover > 0.0) {
    vec2 uv = d.xz / (y + 0.08) * 1.3 + vec2(time * 0.004, time * 0.0016);
    float n = fbm(uv);
    float n2 = fbm(uv * 2.4 + 3.1);
    float c = smoothstep(1.0 - cloudCover, 1.0 - cloudCover + 0.28, n * 0.8 + n2 * 0.3);
    float shade = smoothstep(0.35, 0.9, n2);
    vec3 cc = mix(cloudLit, cloudShade, shade * 0.7);
    cc += glowCol * pow(sd, 4.0) * 0.5;
    float fade = smoothstep(0.015, 0.2, y);
    col = mix(col, cc, c * fade * 0.92);
  }
  // sun disc
  float disc = smoothstep(cos(sunSize), cos(sunSize * 0.6), dot(d, sunDir));
  col += sunCol * disc;
  // stars at dusk
  if (stars > 0.0 && y > 0.1) {
    vec2 g = d.xz / (y + 0.3) * 420.0;
    vec2 fg = fract(g) - 0.5;
    float s = step(0.9975, h21(floor(g))) * smoothstep(0.25, 0.7, y) * smoothstep(0.22, 0.05, length(fg)) * h21(floor(g) + 7.0);
    col += vec3(s) * stars;
  }
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

function makeSky() {
  const mat = new T.ShaderMaterial({
    name: 'env-sky',
    uniforms: {
      zenith: { value: new T.Color() }, horizon: { value: new T.Color() }, horizonAway: { value: new T.Color() }, mid: { value: new T.Color() }, ground: { value: new T.Color() },
      sunCol: { value: new T.Color() }, glowCol: { value: new T.Color() }, sunDir: { value: new T.Vector3(0, 1, 0) },
      sunSize: { value: 0.012 }, cloudCover: { value: 0.35 }, cloudLit: { value: new T.Color() }, cloudShade: { value: new T.Color() },
      time: { value: 0 }, stars: { value: 0 }
    },
    vertexShader: SKY_VS, fragmentShader: SKY_FS,
    side: T.BackSide, depthWrite: false, depthTest: false, fog: false, toneMapped: false
  });
  const mesh = new T.Mesh(new T.SphereGeometry(900, 48, 24), mat);
  mesh.name = 'env-sky';
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  mesh.userData.noPick = true;
  return mesh;
}

// Time-of-day presets. Sun azimuth from north, clockwise; Lisbon 38.67°N, late September.
// 'day' ≈ 15:00, 'golden' ≈ 18:15 (az 255°, alt 14°), 'dusk' ≈ 19:40 (sun just below the horizon).
const TOD = {
  day: {
    az: 212, alt: 46, sun: '#fff4e6', sunI: 3.4,
    zenith: '#2f6fc0', mid: '#79a6dc', horizon: '#d6e3ef', away: '#c3d7ec', fogCol: '#c9d9e8', ground: '#b9c6cf', glow: '#fff3d8', sunDisc: 6.0,
    cloud: 0.36, cloudLit: '#ffffff', cloudShade: '#aeb8c6',
    hemiSky: '#bcd6f0', hemiGround: '#b59e82', hemiI: 0.55, env: 0.9,
    fog: 0.000055, exposure: 1.0, lamps: 0, city: 0, stars: 0, water: '#3f6f8f', waterSky: '#9fc0dc'
  },
  golden: {
    az: 255, alt: 14, sun: '#ffb070', sunI: 3.6,
    zenith: '#3b6db0', mid: '#86a9d0', horizon: '#f6cf9f', away: '#c8d3df', fogCol: '#d9d5cf', ground: '#c9b39b', glow: '#ffb66a', sunDisc: 5.0,
    cloud: 0.28, cloudLit: '#fff0dc', cloudShade: '#a9a2a8',
    hemiSky: '#b9c8e0', hemiGround: '#b08e6c', hemiI: 0.4, env: 0.6,
    fog: 0.000065, exposure: 1.0, lamps: 0, city: 0.15, stars: 0, water: '#3c5f7a', waterSky: '#d9c3a8'
  },
  dusk: {
    az: 276, alt: 3.5, sun: '#ff9a6a', sunI: 0.35,
    zenith: '#1b2748', mid: '#46557e', horizon: '#ee9a6c', away: '#8b8aa3', fogCol: '#77738a', ground: '#3a3c4a', glow: '#ff8a55', sunDisc: 0.0,
    cloud: 0.18, cloudLit: '#f0a283', cloudShade: '#4a4a62',
    hemiSky: '#5a6c9a', hemiGround: '#3e3136', hemiI: 0.35, env: 0.25,
    fog: 0.00007, exposure: 1.0, lamps: 1, city: 1, stars: 0.5, water: '#1b2438', waterSky: '#6b5a70'
  }
};

export function sunDirection(az, alt) {
  const a = az * DEG, e = alt * DEG;
  return new T.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)).normalize();
}

// ---------------------------------------------------------------- terrain & water
function terrainColor(x, z, h, rnd) {
  // dry late-summer Portugal: straw fields, olive scrub, pale urban ground
  const r = Math.hypot(x - 7, z - 7);
  const n = vnoise(x * 2.3, z * 2.3);
  let c;
  if (x < -3200 && z < -1500) c = [0.60, 0.58, 0.55];            // Lisbon urban fabric (seen from 8–12 km)
  else if (r < NEAR_R - 40) c = [0.62, 0.6, 0.55];                 // paved / built-up ground between houses
  else if (r < 3400 && n > -0.2) c = [0.58, 0.56, 0.5];            // Barreiro / Baixa da Banheira town ground
  else c = n > 0.3 ? [0.42, 0.45, 0.3] : [0.6, 0.55, 0.4];         // dry fields & pine woods
  if (z - zShore(x) < 130 && z - zShore(x) > 12 && r < 3000) c = [0.46, 0.52, 0.32]; // riverside park
  if (h < WATER_Y + 1.6) c = [0.55, 0.52, 0.45]; // shore mud / sand
  const k = 0.93 + rnd * 0.1;
  return [c[0] * k, c[1] * k, c[2] * k];
}

let _tc = null;
function buildGridMesh(x0, z0, nx, nz, cell, skipCell, name) {
  const rng = rngFrom(nx * 131 + nz);
  _tc = new T.Color();
  const H = new Float32Array((nx + 1) * (nz + 1));
  // land never dips below the water surface (water is drawn without depth write underneath everything)
  for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) H[j * (nx + 1) + i] = Math.max(WATER_Y + 0.02, heightAt(x0 + i * cell, z0 + j * cell));
  const pos = [], col = [], idx = [], map = new Int32Array((nx + 1) * (nz + 1)).fill(-1);
  const vid = (i, j) => {
    const k = j * (nx + 1) + i;
    if (map[k] < 0) {
      const x = x0 + i * cell, z = z0 + j * cell, h = H[k];
      map[k] = pos.length / 3;
      pos.push(x, h, z);
      const tc = terrainColor(x, z, h, rng());
      _tc.setRGB(tc[0], tc[1], tc[2], T.SRGBColorSpace);
      col.push(_tc.r, _tc.g, _tc.b);
    }
    return map[k];
  };
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const hs = [H[j * (nx + 1) + i], H[j * (nx + 1) + i + 1], H[(j + 1) * (nx + 1) + i], H[(j + 1) * (nx + 1) + i + 1]];
    if (Math.max(...hs) < WATER_Y + 0.05) continue;
    const cx = x0 + (i + 0.5) * cell, cz = z0 + (j + 0.5) * cell;
    if (skipCell && skipCell(cx, cz)) continue;
    const a = vid(i, j), b = vid(i + 1, j), c = vid(i, j + 1), d = vid(i + 1, j + 1);
    const wet = (k) => k < WATER_Y + 0.05;
    // skip triangles lying entirely at water level (smooth diagonal shoreline instead of a staircase)
    if (!(wet(hs[0]) && wet(hs[2]) && wet(hs[1]))) idx.push(a, c, b);
    if (!(wet(hs[1]) && wet(hs[2]) && wet(hs[3]))) idx.push(b, c, d);
  }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new T.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  const m = new T.Mesh(g, null);
  m.name = name;
  return m;
}

function buildTerrain(C) {
  const mat = new T.MeshStandardMaterial({ name: 'env-terrain', vertexColors: true, roughness: 1, metalness: 0, envMapIntensity: 0.6 });
  C.mats.terrain = mat;
  const out = new T.Group(); out.name = 'env-terrain';
  const nx = (GRID.x1 - GRID.x0) / GRID.cell, nz = (GRID.z1 - GRID.z0) / GRID.cell;
  const local = buildGridMesh(GRID.x0, GRID.z0, nx, nz, GRID.cell,
    (x, z) => x > NEARG.x0 && x < NEARG.x1 && z > NEARG.z0 && z < NEARG.z1, 'env-terrain-local');
  local.material = mat; local.receiveShadow = true;
  out.add(local);
  const fx = Math.round((FARG.x1 - FARG.x0) / FARG.cell), fz = Math.round((FARG.z1 - FARG.z0) / FARG.cell);
  const far = buildGridMesh(FARG.x0, FARG.z0, fx, fz, FARG.cell,
    (x, z) => x > GRID.x0 && x < GRID.x1 && z > GRID.z0 && z < GRID.z1, 'env-terrain-far');
  far.material = mat;
  out.add(far);
  return out;
}

const WATER_VS = /* glsl */`
varying vec3 vWorld;
#include <fog_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const WATER_FS = /* glsl */`
uniform float time; uniform vec3 deep; uniform vec3 skyLow; uniform vec3 skyHigh; uniform vec3 sunCol; uniform vec3 sunDir;
uniform float lights;
varying vec3 vWorld;
#include <fog_pars_fragment>
float h21(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }
float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y); }
vec2 grad(vec2 p){ float e = 0.35; return vec2(vn(p+vec2(e,0.0))-vn(p-vec2(e,0.0)), vn(p+vec2(0.0,e))-vn(p-vec2(0.0,e))) / (2.0*e); }
void main() {
  vec3 V = cameraPosition - vWorld;
  float dist = length(V); V /= dist;
  vec2 p = vWorld.xz;
  float fade = 1.0 / (1.0 + dist * 0.004);
  vec2 g = grad(p * 0.09 + vec2(time * 0.21, time * 0.13)) * 0.55
         + grad(p * 0.23 + vec2(-time * 0.33, time * 0.27)) * 0.3
         + grad(p * 0.021 + vec2(time * 0.05, -time * 0.04)) * 0.6;
  float amp = 0.22 * (0.12 + 0.88 * fade);
  vec3 N = normalize(vec3(-g.x * amp, 1.0, -g.y * amp));
  vec3 R = reflect(-V, N);
  float fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
  vec3 sky = mix(skyLow, skyHigh, pow(clamp(R.y, 0.0, 1.0), 0.5));
  vec3 col = mix(deep, sky, clamp(fres * 1.15, 0.0, 1.0));
  float s = max(dot(R, sunDir), 0.0);
  col += sunCol * (pow(s, 900.0) * 6.0 + pow(s, 120.0) * 0.35);
  // dusk: shimmering reflections of the far shore lights
  if (lights > 0.0) {
    float band = smoothstep(-2600.0, -8000.0, vWorld.z) * smoothstep(0.0, 0.06, fres);
    float sp = step(0.985, vn(vec2(vWorld.x * 0.05, vWorld.z * 0.004 + time * 0.8)));
    col += vec3(1.0, 0.78, 0.45) * sp * band * lights * 0.6;
  }
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

function buildWater(C) {
  const mat = new T.ShaderMaterial({
    name: 'env-water',
    uniforms: T.UniformsUtils.merge([T.UniformsLib.fog, {
      time: { value: 0 }, deep: { value: new T.Color('#3f6f8f') }, skyLow: { value: new T.Color('#c9dcef') },
      skyHigh: { value: new T.Color('#5d8fc9') }, sunCol: { value: new T.Color('#fff4e6') }, sunDir: { value: new T.Vector3(0, 1, 0) },
      lights: { value: 0 }
    }]),
    vertexShader: WATER_VS, fragmentShader: WATER_FS, fog: true, toneMapped: false,
    depthWrite: false // drawn first (renderOrder); land drawn after always wins → no z-fighting at 10 km
  });
  C.mats.water = mat;
  const g = new T.PlaneGeometry(70000, 60000, 1, 1).rotateX(-Math.PI / 2);
  const m = new T.Mesh(g, mat);
  m.position.set(-4000, WATER_Y, -8000);
  m.name = 'env-tagus';
  m.renderOrder = -10;
  return m;
}

// ---------------------------------------------------------------- façade textures (windows with roller shutters)
// One tile = 4 bays (3.2 m) × 4 storeys (3 m). Walls are tinted by vertex colour.
const BAY = 3.2, STOREY = 3.0, TILE_U = 4 * BAY, TILE_V = 4 * STOREY;
function makeFacadeTextures(rng, size, aniso) {
  const layout = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    const kind = rng() < 0.18 ? 'door' : rng() < 0.25 ? 'wide' : 'win';
    layout.push({ r, c, kind: r === 3 && kind === 'door' ? 'door' : (kind === 'door' ? 'win' : kind), shutter: rng() * 0.75, lit: rng() < 0.42, warm: rng() });
  }
  const px = size / 16; // pixels per 0.8 m unit (bay = 4 units, storey = 3.75 units)
  const bw = size / 4, sh = size / 4;
  const rectOf = (L) => {
    const x0 = L.c * bw, y0 = L.r * sh; // canvas y down: row 0 = top storey
    let w = L.kind === 'wide' ? 0.62 : L.kind === 'door' ? 0.36 : 0.40;
    const x = x0 + bw * (0.5 - w / 2), W = bw * w;
    const top = y0 + sh * (L.kind === 'door' ? 0.22 : 0.22), bot = y0 + sh * (L.kind === 'door' ? 0.98 : 0.72);
    return { x, y: top, w: W, h: bot - top };
  };
  const map = canvasTex(size, (g, s) => {
    g.fillStyle = '#f4f2ee'; g.fillRect(0, 0, s, s);
    // subtle plaster noise & dirt streaks
    for (let i = 0; i < 9000; i++) { const v = 225 + rng() * 30 | 0; g.fillStyle = `rgba(${v},${v},${v - 4},0.25)`; g.fillRect(rng() * s, rng() * s, 2, 2); }
    for (let r = 0; r < 4; r++) { // storey bands (slab edges)
      g.fillStyle = 'rgba(0,0,0,0.05)'; g.fillRect(0, r * sh + sh - 3, s, 3);
    }
    for (const L of layout) {
      const R = rectOf(L);
      // frame
      g.fillStyle = '#e9e6df'; g.fillRect(R.x - px * 0.12, R.y - px * 0.12, R.w + px * 0.24, R.h + px * 0.24);
      // glass
      const grd = g.createLinearGradient(0, R.y, 0, R.y + R.h);
      grd.addColorStop(0, '#2a3440'); grd.addColorStop(1, '#475563');
      g.fillStyle = grd; g.fillRect(R.x, R.y, R.w, R.h);
      g.fillStyle = 'rgba(255,255,255,0.10)'; g.fillRect(R.x, R.y, R.w * 0.5, R.h);
      // mullion
      g.fillStyle = '#d8d4cc'; g.fillRect(R.x + R.w / 2 - 1.5, R.y, 3, R.h);
      // roller shutter (estore) with box
      const shH = R.h * L.shutter;
      g.fillStyle = '#d9d5cc'; g.fillRect(R.x, R.y, R.w, shH);
      g.fillStyle = 'rgba(0,0,0,0.12)';
      for (let y = R.y; y < R.y + shH; y += 4) g.fillRect(R.x, y, R.w, 1);
      g.fillStyle = '#ccc7bd'; g.fillRect(R.x - px * 0.12, R.y - px * 0.34, R.w + px * 0.24, px * 0.24);
      // sill
      if (L.kind !== 'door') { g.fillStyle = '#fbfaf7'; g.fillRect(R.x - px * 0.25, R.y + R.h, R.w + px * 0.5, px * 0.14); g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(R.x - px * 0.2, R.y + R.h + px * 0.14, R.w + px * 0.4, px * 0.08); }
    }
  }, { aniso });
  const lit = canvasTex(size, (g, s) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, s, s);
    for (const L of layout) {
      if (!L.lit) continue;
      const R = rectOf(L);
      const y0 = R.y + R.h * L.shutter;
      g.fillStyle = L.warm < 0.75 ? '#ffc27a' : '#dfe6ff';
      g.globalAlpha = 0.55 + L.warm * 0.45;
      g.fillRect(R.x, y0, R.w, R.y + R.h - y0);
      g.globalAlpha = 1;
    }
  }, { aniso });
  return { map, lit };
}

// ---------------------------------------------------------------- building primitives (merged)
// Wall box with façade UVs: base = ground level of the building (windows start there)
function facadeBox(gb, x0, z0, x1, z1, base, top, sink = SINK, uoff = 0) {
  const bays = (len) => Math.max(1, Math.round(len / BAY));
  const storeys = Math.max(1, Math.round((top - base) / STOREY));
  const vs = (y) => (y - base) / ((top - base) / storeys) / 4;
  const y0 = base - sink;
  const P = [[0.004, 0.998], [0.006, 0.998], [0.006, 0.999], [0.004, 0.999]]; // plain plaster texel
  const face = (ax, az, bx, bz, out) => {
    const len = Math.hypot(bx - ax, bz - az), nb = bays(len) / 4;
    gb.quad([ax, base, az], [bx, base, bz], [bx, top, bz], [ax, top, az], [[uoff, 0], [uoff + nb, 0], [uoff + nb, vs(top)], [uoff, vs(top)]], out);
    if (sink > 0) gb.quad([ax, y0, az], [bx, y0, bz], [bx, base, bz], [ax, base, az], P, out);
  };
  face(x0, z1, x1, z1, [0, 0, 1]);
  face(x1, z0, x0, z0, [0, 0, -1]);
  face(x1, z1, x1, z0, [1, 0, 0]);
  face(x0, z0, x0, z1, [-1, 0, 0]);
}
// Hipped tile roof over rectangle (with overhang), world-scaled uv (tile texture 3 m)
function hipRoof(gb, x0, z0, x1, z1, y, pitch = 0.45, ov = 0.35) {
  x0 -= ov; z0 -= ov; x1 += ov; z1 += ov;
  const w = x1 - x0, d = z1 - z0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const rh = Math.min(w, d) / 2 * pitch;
  const S = 3;
  if (w >= d) {
    const r0 = [x0 + d / 2, y + rh, cz], r1 = [x1 - d / 2, y + rh, cz];
    const sl = Math.hypot(d / 2, rh) / S;
    gb.quad([x0, y, z1], [x1, y, z1], r1, r0, [[x0 / S, 0], [x1 / S, 0], [r1[0] / S, sl], [r0[0] / S, sl]], [0, 1, 1]);
    gb.quad([x1, y, z0], [x0, y, z0], r0, r1, [[-x1 / S, 0], [-x0 / S, 0], [-r0[0] / S, sl], [-r1[0] / S, sl]], [0, 1, -1]);
    gb.tri([x1, y, z1], [x1, y, z0], r1, [z1 / S, 0], [z0 / S, 0], [cz / S, sl], [1, 1, 0]);
    gb.tri([x0, y, z0], [x0, y, z1], r0, [z0 / S, 0], [z1 / S, 0], [cz / S, sl], [-1, 1, 0]);
  } else {
    const r0 = [cx, y + rh, z0 + w / 2], r1 = [cx, y + rh, z1 - w / 2];
    const sl = Math.hypot(w / 2, rh) / S;
    gb.quad([x1, y, z1], [x1, y, z0], r0, r1, [[z1 / S, 0], [z0 / S, 0], [r0[2] / S, sl], [r1[2] / S, sl]], [1, 1, 0]);
    gb.quad([x0, y, z0], [x0, y, z1], r1, r0, [[z0 / S, 0], [z1 / S, 0], [r1[2] / S, sl], [r0[2] / S, sl]], [-1, 1, 0]);
    gb.tri([x0, y, z1], [x1, y, z1], r1, [x0 / S, 0], [x1 / S, 0], [cx / S, sl], [0, 1, 1]);
    gb.tri([x1, y, z0], [x0, y, z0], r0, [x1 / S, 0], [x0 / S, 0], [cx / S, sl], [0, 1, -1]);
  }
  return rh;
}
// Gable roof, ridge along x (alongX) or z
function gableRoof(gb, x0, z0, x1, z1, y, alongX, pitch = 0.5, ov = 0.35, gableCol) {
  x0 -= ov; z0 -= ov; x1 += ov; z1 += ov;
  const S = 3;
  if (alongX) {
    const cz = (z0 + z1) / 2, rh = (z1 - z0) / 2 * pitch, sl = Math.hypot((z1 - z0) / 2, rh) / S;
    gb.quad([x0, y, z1], [x1, y, z1], [x1, y + rh, cz], [x0, y + rh, cz], [[x0 / S, 0], [x1 / S, 0], [x1 / S, sl], [x0 / S, sl]], [0, 1, 1]);
    gb.quad([x1, y, z0], [x0, y, z0], [x0, y + rh, cz], [x1, y + rh, cz], [[-x1 / S, 0], [-x0 / S, 0], [-x0 / S, sl], [-x1 / S, sl]], [0, 1, -1]);
    return rh;
  }
  const cx = (x0 + x1) / 2, rh = (x1 - x0) / 2 * pitch, sl = Math.hypot((x1 - x0) / 2, rh) / S;
  gb.quad([x1, y, z1], [x1, y, z0], [cx, y + rh, z0], [cx, y + rh, z1], [[z1 / S, 0], [z0 / S, 0], [z0 / S, sl], [z1 / S, sl]], [1, 1, 0]);
  gb.quad([x0, y, z0], [x0, y, z1], [cx, y + rh, z1], [cx, y + rh, z0], [[z0 / S, 0], [z1 / S, 0], [z1 / S, sl], [z0 / S, sl]], [-1, 1, 0]);
  return rh;
}
// Gable-end triangles (wall material) for gableRoof
function gableEnds(gb, x0, z0, x1, z1, y, alongX, pitch = 0.5) {
  if (alongX) {
    const cz = (z0 + z1) / 2, rh = (z1 - z0) / 2 * (pitch) * ((z1 - z0) / 2) / ((z1 - z0) / 2);
    gb.tri([x0, y, z0], [x0, y, z1], [x0, y + rh, cz], [0, 0], [1, 0], [0.5, 0.5], [-1, 0, 0]);
    gb.tri([x1, y, z1], [x1, y, z0], [x1, y + rh, cz], [0, 0], [1, 0], [0.5, 0.5], [1, 0, 0]);
  } else {
    const cx = (x0 + x1) / 2, rh = (x1 - x0) / 2 * pitch;
    gb.tri([x0, y, z1], [x1, y, z1], [cx, y + rh, z1], [0, 0], [1, 0], [0.5, 0.5], [0, 0, 1]);
    gb.tri([x1, y, z0], [x0, y, z0], [cx, y + rh, z0], [0, 0], [1, 0], [0.5, 0.5], [0, 0, -1]);
  }
}

// ---------------------------------------------------------------- chunked merged-geometry collector
class Chunks {
  constructor(size = 200) { this.size = size; this.map = new Map(); }
  gb(x, z, key) {
    const k = `${key}|${Math.floor(x / this.size)}|${Math.floor(z / this.size)}`;
    let g = this.map.get(k);
    if (!g) { g = new GB(); this.map.set(k, g); }
    return g;
  }
  meshes(mats, parent, { cast = () => false, receive = true } = {}) {
    for (const [k, gb] of this.map) {
      if (gb.empty) continue;
      const [key] = k.split('|');
      const m = new T.Mesh(gb.build(), mats[key]);
      m.name = `env-${key}-${k.split('|').slice(1).join('_')}`;
      m.castShadow = cast(m);
      m.receiveShadow = receive;
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      parent.add(m);
    }
    this.map.clear();
  }
}

// ---------------------------------------------------------------- Lavradio street grid
const ROW_Z = 22.2, ROW_DZ = 62;        // E–W streets: centre lines (Rua Eduardo Couto = 22.2: pavement 17.4–19.3, road 19.3–25.1, pavement 25.1–27.0)
const HALF = 4.8, ROAD_HALF = 2.9;      // half street width incl. pavements / half road width
function ewStreets() {
  const out = [];
  for (let k = -14; k <= 14; k++) {
    const r = rngFrom(9000 + k)();
    const z = ROW_Z + k * ROW_DZ + (k === 0 ? 0 : (r - 0.5) * 10);
    out.push(z);
  }
  return out;
}
function nsStreets() {
  // x = 60 and x = -52 bound the site's block; others ~104 m apart with jitter
  const out = [-52, 60];
  for (let k = 1; k <= 8; k++) {
    out.push(60 + k * 104 + (rngFrom(7100 + k)() - 0.5) * 18);
    out.push(-52 - k * 104 + (rngFrom(7200 + k)() - 0.5) * 18);
  }
  return out.sort((a, b) => a - b);
}

// Rectangles reserved for explicit geometry (lot + real neighbours) — the generator keeps out
const RESERVED = [
  { x0: -11.5, x1: 29.5, z0: -8.6, z1: 17.4 },   // lot + pink house (W) + white house (E)
  { x0: -3, x1: 31, z0: -27, z1: -8.6 },         // modern houses behind the rear wall (explicit)
  { x0: 45, x1: 65, z0: -440, z1: -400 }         // slim tower seen from the plot
];
const inReserved = (x0, z0, x1, z1) => RESERVED.some(r => x1 > r.x0 && x0 < r.x1 && z1 > r.z0 && z0 < r.z1);

const HOUSE_COLS = ['#f4f1ea', '#f6f2e6', '#efe7d6', '#f1d9c6', '#e9c9b3', '#f3e3b8', '#e6e2d8', '#dfe3e2', '#f5efe0', '#eed8cf', '#f6f4ef', '#e8d8b8'];
const BLOCK_COLS = ['#efe4cf', '#e7cdbd', '#eadcc4', '#f1ead9', '#e4c7b5', '#ddd4c3'];
const ROOF_COLS = ['#b5563a', '#a94d33', '#c0613f', '#9c4a34', '#b8603f', '#a8583b'];

// ---------------------------------------------------------------- materials
function makeMaterials(C, tex, fac) {
  const M = C.mats;
  M.facade = new T.MeshStandardMaterial({ name: 'env-facade', map: fac.map, vertexColors: true, roughness: 0.88, metalness: 0,
    emissive: new T.Color('#ffffff'), emissiveMap: fac.lit, emissiveIntensity: 0, envMapIntensity: 0.7 });
  M.city = new T.MeshStandardMaterial({ name: 'env-city', map: fac.map, vertexColors: true, roughness: 0.9, metalness: 0,
    emissive: new T.Color('#ffffff'), emissiveMap: fac.lit, emissiveIntensity: 0, envMapIntensity: 0.5 });
  M.roof = new T.MeshStandardMaterial({ name: 'env-roof', map: tex.tiles, vertexColors: true, roughness: 0.78, metalness: 0, envMapIntensity: 0.6 });
  M.plain = new T.MeshStandardMaterial({ name: 'env-plain', vertexColors: true, roughness: 0.85, metalness: 0, envMapIntensity: 0.7 });
  M.metal = new T.MeshStandardMaterial({ name: 'env-metal', vertexColors: true, roughness: 0.45, metalness: 0.6, envMapIntensity: 0.9 });
  M.asphalt = new T.MeshStandardMaterial({ name: 'env-asphalt', map: tex.asphalt, color: '#ffffff', roughness: 0.94, metalness: 0, envMapIntensity: 0.5 });
  M.calcada = new T.MeshStandardMaterial({ name: 'env-calcada', map: tex.calcada, color: '#ffffff', roughness: 0.8, metalness: 0, envMapIntensity: 0.6 });
  M.stone = new T.MeshStandardMaterial({ name: 'env-stone', map: tex.stone, color: '#ffffff', roughness: 0.9, envMapIntensity: 0.6 });
  M.yard = new T.MeshStandardMaterial({ name: 'env-yard', map: tex.yard, vertexColors: true, roughness: 1, envMapIntensity: 0.5 });
  M.iron = new T.MeshStandardMaterial({ name: 'env-iron', map: tex.iron, color: '#f2f2ee', alphaTest: 0.5, side: T.DoubleSide, roughness: 0.6, metalness: 0.2 });
  M.fence = new T.MeshStandardMaterial({ name: 'env-fence', map: tex.fence, color: '#ffffff', alphaTest: 0.5, side: T.DoubleSide, roughness: 0.7 });
  M.glassDark = new T.MeshStandardMaterial({ name: 'env-window', color: '#28313a', roughness: 0.08, metalness: 0.2, envMapIntensity: 1.2,
    emissive: new T.Color('#ffb56b'), emissiveIntensity: 0 });
  M.lampHead = new T.MeshStandardMaterial({ name: 'env-lamp', color: '#e8e6e0', emissive: new T.Color('#ffc98a'), emissiveIntensity: 0, roughness: 0.3 });
  M.cable = new T.LineBasicMaterial({ name: 'env-cable', color: '#202224', transparent: true, opacity: 0.85 });
  M.glow = new T.MeshBasicMaterial({ name: 'env-glow', map: tex.glow, color: '#ffb870', transparent: true, opacity: 0, depthWrite: false,
    blending: T.AdditiveBlending, toneMapped: false });
  M.pool = new T.MeshBasicMaterial({ name: 'env-lightpool', map: tex.glow, color: '#ffae62', transparent: true, opacity: 0, depthWrite: false,
    blending: T.AdditiveBlending, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  M.tree = new T.MeshStandardMaterial({ name: 'env-tree', vertexColors: true, roughness: 0.95, flatShading: true, envMapIntensity: 0.5 });
  M.car = new T.MeshStandardMaterial({ name: 'env-car', vertexColors: true, roughness: 0.32, metalness: 0.45, envMapIntensity: 1.0 });
  M.redSteel = new T.MeshStandardMaterial({ name: 'env-bridge-red', color: '#b5432e', roughness: 0.6, metalness: 0.2 });
  M.concrete = new T.MeshStandardMaterial({ name: 'env-concrete', color: '#d9d6cf', roughness: 0.9 });
  M.lights = new T.PointsMaterial({ name: 'env-citylights', size: 2.2, sizeAttenuation: false, vertexColors: true, transparent: true,
    opacity: 0, depthWrite: false, toneMapped: false, fog: false });
  M.redLights = new T.PointsMaterial({ name: 'env-aviation', size: 3, sizeAttenuation: false, color: '#ff3a2a', transparent: true, opacity: 0,
    depthWrite: false, toneMapped: false, fog: false });
  for (const k in M) if (M[k].map && M[k] !== M.glow && M[k] !== M.pool) M[k].map.colorSpace = T.SRGBColorSpace;
}

// world-scaled horizontal quad (y may vary per corner)
function hquad(gb, x0, z0, x1, z1, y00, y10, y11, y01, s) {
  const U = (x, z) => [x / s, -z / s];
  gb.quad([x0, y00, z0], [x1, y10, z0], [x1, y11, z1], [x0, y01, z1], [U(x0, z0), U(x1, z0), U(x1, z1), U(x0, z1)], [0, 1, 0]);
}

// ---------------------------------------------------------------- neighbourhood generator
function inCircle(x, z, r = NEAR_R) { return Math.hypot(x - 7, z - 7) < r; }
function landOK(x0, z0, x1, z1) {
  return [[x0, z0], [x1, z0], [x0, z1], [x1, z1]].every(([x, z]) => heightAt(x, z) > WATER_Y + 1.4 && z - zShore(x) > 45 && inCircle(x, z));
}

// Street network geometry (asphalt + calçada pavements with kerbs), following the terrain
function buildStreets(C, ew, ns, extra) {
  const onFlat = (x, z) => x >= FLAT.x0 && x <= FLAT.x1 && z >= FLAT.z0 && z <= FLAT.z1;
  const lift = (x, z, up) => groundY(x, z) + up + (onFlat(x, z) ? 0 : 0.1);
  const seg = 10;
  // strip along a polyline direction: axis 'x' (E–W street at z = c) or 'z' (N–S at x = c)
  const strip = (axis, c, a0, a1) => {
    if (a1 - a0 < 1) return;
    const n = Math.max(1, Math.ceil((a1 - a0) / seg));
    for (let i = 0; i < n; i++) {
      const s0 = a0 + (a1 - a0) * i / n, s1 = a0 + (a1 - a0) * (i + 1) / n;
      const P = (s, o) => axis === 'x' ? [s, o] : [o, s];
      const mid = P((s0 + s1) / 2, c);
      const road = C.chunks.gb(mid[0], mid[1], 'asphalt'), pave = C.chunks.gb(mid[0], mid[1], 'calcada');
      const band = (gb, o0, o1, up, S) => {
        const A = P(s0, o0), B = P(s1, o0), Cc = P(s1, o1), D = P(s0, o1);
        const y = (p) => lift(p[0], p[1], up);
        const U = (p) => [p[0] / S, -p[1] / S];
        gb.quad([A[0], y(A), A[1]], [B[0], y(B), B[1]], [Cc[0], y(Cc), Cc[1]], [D[0], y(D), D[1]], [U(A), U(B), U(Cc), U(D)], [0, 1, 0]);
      };
      band(road, c - ROAD_HALF, c + ROAD_HALF, ROAD_UP, 8);
      band(pave, c - HALF, c - ROAD_HALF, PAVE_UP, 1.6);
      band(pave, c + ROAD_HALF, c + HALF, PAVE_UP, 1.6);
      // kerb faces (limestone)
      for (const o of [c - ROAD_HALF, c + ROAD_HALF]) {
        const A = P(s0, o), B = P(s1, o);
        const yA0 = lift(A[0], A[1], ROAD_UP), yB0 = lift(B[0], B[1], ROAD_UP);
        const yA1 = lift(A[0], A[1], PAVE_UP), yB1 = lift(B[0], B[1], PAVE_UP);
        const out = axis === 'x' ? [0, 0, o < c ? 1 : -1] : [o < c ? 1 : -1, 0, 0];
        pave.quad([A[0], yA0, A[1]], [B[0], yB0, B[1]], [B[0], yB1, B[1]], [A[0], yA1, A[1]], [[0, 0], [1, 0], [1, 0.08], [0, 0.08]], out);
      }
    }
  };
  const span = (c, axis) => { // extent of the street inside circle & on land
    const R = NEAR_R, out = [];
    let a = null;
    for (let s = -R + 7; s <= R + 7; s += 10) {
      const x = axis === 'x' ? s : c, z = axis === 'x' ? c : s;
      const ok = inCircle(x, z, R) && heightAt(x, z) > WATER_Y + 1.4 && z - zShore(x) > 25;
      if (ok && a === null) a = s;
      if (!ok && a !== null) { out.push([a, s - 10]); a = null; }
    }
    if (a !== null) out.push([a, R + 7]);
    return out;
  };
  for (const z of ew) for (const [a0, a1] of span(z, 'x')) strip('x', z, a0, a1);
  const nsList = ns.map(x => ({ x, zMax: Infinity }));
  if (extra) nsList.push(extra);
  for (const { x, zMax } of nsList) for (const [a0, a1b] of span(x, 'z')) {
    const a1 = Math.min(a1b, zMax - HALF);
    if (a1 <= a0) continue;
    // cut at E–W streets
    let cur = a0;
    for (const z of ew) {
      if (z + HALF < cur || z - HALF > a1) continue;
      strip('z', x, cur, Math.min(a1, z - HALF));
      cur = z + HALF;
    }
    strip('z', x, cur, a1);
  }
}

function addTree(C, x, z, scale = 1, kind = 0) {
  if (!C.trees) C.trees = [];
  C.trees.push({ x, z, y: groundY(x, z), s: scale, kind });
}

function addHouse(C, rng, x0, z0, x1, z1, frontZ, opts = {}) {
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const base = Math.min(groundY(x0, z0), groundY(x1, z0), groundY(x0, z1), groundY(x1, z1)) + 0.05;
  const storeys = opts.storeys || (rng() < 0.22 ? 1 : 2);
  const top = base + storeys * STOREY + 0.3;
  const modern = opts.modern ?? rng() < 0.16;
  const wall = new T.Color(opts.color || (modern ? (rng() < 0.5 ? '#f3f3f1' : '#9aa0a4') : HOUSE_COLS[rng() * HOUSE_COLS.length | 0]));
  const fb = C.chunks.gb(cx, cz, 'facade').color(wall);
  facadeBox(fb, x0, z0, x1, z1, base, top, SINK, (rng() * 4 | 0) / 4);
  if (modern) {
    const pl = C.chunks.gb(cx, cz, 'plain').color(wall.clone().multiplyScalar(0.9));
    pl.box(x0 - 0.05, top, z0 - 0.05, x1 + 0.05, top + 0.45, z1 + 0.05, 1);
  } else {
    const rc = new T.Color(ROOF_COLS[rng() * ROOF_COLS.length | 0]);
    const rb = C.chunks.gb(cx, cz, 'roof').color(rc);
    const pitch = 0.36 + rng() * 0.12;
    if (rng() < 0.6 || opts.hip) hipRoof(rb, x0, z0, x1, z1, top, pitch, 0.4);
    else {
      const alongX = (x1 - x0) > (z1 - z0);
      gableRoof(rb, x0, z0, x1, z1, top, alongX, pitch, 0.4);
      const gb2 = C.chunks.gb(cx, cz, 'plain').color(wall);
      gableEnds(gb2, x0, z0, x1, z1, top, alongX, pitch * ((alongX ? (z1 - z0) : (x1 - x0)) + 0.8) / ((alongX ? (z1 - z0) : (x1 - x0))) );
    }
    // eave soffit band
    const pl = C.chunks.gb(cx, cz, 'plain').color([0.93, 0.92, 0.9]);
    pl.box(x0 - 0.02, top - 0.25, z0 - 0.02, x1 + 0.02, top, z1 + 0.02, 1, { bottom: true, top: true });
    if (rng() < 0.5) { // chimney
      const chx = lerp(x0 + 1, x1 - 1, rng()), chz = lerp(z0 + 1, z1 - 1, rng());
      pl.color(wall).box(chx - 0.3, top, chz - 0.3, chx + 0.3, top + 2.2, chz + 0.3, 1);
    }
  }
  // street-side balcony on some 2-storey houses
  if (storeys >= 2 && rng() < 0.35 && frontZ !== undefined) {
    const s = Math.sign(frontZ - cz), zf = s > 0 ? z1 : z0;
    const bx0 = lerp(x0, x1, 0.2), bx1 = lerp(x0, x1, 0.8);
    const pl = C.chunks.gb(cx, cz, 'plain').color(wall);
    const za = Math.min(zf, zf + s * 1.1), zb = Math.max(zf, zf + s * 1.1);
    pl.box(bx0, base + STOREY - 0.15, za, bx1, base + STOREY + 0.05, zb, 1, {});
    pl.color([0.95, 0.95, 0.94]).box(bx0, base + STOREY + 0.05, s > 0 ? zb - 0.06 : za, bx1, base + STOREY + 1.0, s > 0 ? zb : za + 0.06, 1);
  }
  // low front garden wall with gate pillars along the pavement
  if (frontZ !== undefined && Math.hypot(cx - 7, cz - 7) < 260) {
    const pl = C.chunks.gb(cx, cz, 'plain').color(opts.wallCol || [0.95, 0.94, 0.91]);
    const zf = frontZ;
    const y0 = groundY(cx, zf) - 0.3;
    pl.box(x0 - 0.3, y0, zf - 0.1, x1 + 0.3, y0 + 1.25 + 0.3, zf + 0.1, 1);
  }
  if (opts.tree !== false && rng() < 0.35) addTree(C, lerp(x0, x1, rng()), frontZ !== undefined ? lerp(cz, frontZ, 0.75) : cz, 0.7 + rng() * 0.5, rng() < 0.3 ? 1 : 0);
  return { base, top };
}

function addBlock(C, rng, x0, z0, x1, z1, frontZ, storeys = 4) {
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const base = Math.min(groundY(x0, z0), groundY(x1, z0), groundY(x0, z1), groundY(x1, z1)) + 0.05;
  const top = base + storeys * STOREY + 0.2;
  const wall = new T.Color(BLOCK_COLS[rng() * BLOCK_COLS.length | 0]);
  const fb = C.chunks.gb(cx, cz, 'facade').color(wall);
  facadeBox(fb, x0, z0, x1, z1, base, top, SINK, (rng() * 4 | 0) / 4);
  const rc = new T.Color(ROOF_COLS[rng() * ROOF_COLS.length | 0]);
  // parapet/cornice + low hipped roof
  const pl = C.chunks.gb(cx, cz, 'plain').color(wall.clone().multiplyScalar(0.94));
  pl.box(x0 - 0.25, top, z0 - 0.25, x1 + 0.25, top + 0.4, z1 + 0.25, 1, {});
  hipRoof(C.chunks.gb(cx, cz, 'roof').color(rc), x0 + 0.2, z0 + 0.2, x1 - 0.2, z1 - 0.2, top + 0.4, 0.32, 0);
  // yellow balconies on both long façades (floors 1..n-1)
  const yb = C.chunks.gb(cx, cz, 'plain');
  const yellow = rng() < 0.75 ? [0.93, 0.77, 0.3] : [0.94, 0.9, 0.82];
  const alongX = (x1 - x0) >= (z1 - z0);
  const len = alongX ? x1 - x0 : z1 - z0;
  const nb = Math.floor(len / 6.4);
  for (const side of [-1, 1]) {
    for (let b = 0; b < nb; b++) {
      if ((b + (side > 0 ? 0 : 1)) % 2) continue;
      const a0 = (alongX ? x0 : z0) + (len - nb * 6.4) / 2 + b * 6.4 + 0.6, a1 = a0 + 5.2;
      for (let f = 1; f < storeys; f++) {
        const y = base + f * STOREY - 0.1;
        yb.color(yellow);
        if (alongX) {
          const zf = side > 0 ? z1 : z0, za = Math.min(zf, zf + side * 1.25), zb = Math.max(zf, zf + side * 1.25);
          yb.box(a0, y, za, a1, y + 1.05, zb, 1, { bottom: false });
        } else {
          const xf = side > 0 ? x1 : x0, xa = Math.min(xf, xf + side * 1.25), xb = Math.max(xf, xf + side * 1.25);
          yb.box(xa, y, a0, xb, y + 1.05, a1, 1, { bottom: false });
        }
      }
    }
  }
  // parked cars along the street
  if (frontZ !== undefined && rng() < 0.8 && Math.hypot(cx - 7, cz - 7) < 380) {
    const n = Math.floor((x1 - x0) / 5.5);
    const dir = Math.sign(frontZ - cz);
    for (let i = 0; i < n; i++) if (rng() < 0.65) C.cars.push({ x: x0 + 2.7 + i * 5.5 + (rng() - 0.5), z: frontZ + dir * (HALF - ROAD_HALF + 1.0), ry: dir > 0 ? 0 : Math.PI, col: rng() });
  }
  return { base, top };
}

const VIEW_X = 10; // N–S street north of the site's block: the balcony "glimpse" of the Tejo (cf. site-tejo.jpg)
function fillNeighbourhood(C, rng) {
  const ew = ewStreets(), ns0 = nsStreets();
  const zView = ew[13]; // E–W street behind the site's block; the view street runs north from it
  C.ew = ew; C.ns = ns0;
  buildStreets(C, ew, ns0, { x: VIEW_X, zMax: zView });
  for (let i = 0; i < ew.length - 1; i++) {
    const ns = ew[i + 1] <= zView + 0.01 ? [...ns0, VIEW_X].sort((a, b) => a - b) : ns0;
    for (let j = 0; j < ns.length - 1; j++) {
      const zA = ew[i] + HALF, zB = ew[i + 1] - HALF, xA = ns[j] + HALF, xB = ns[j + 1] - HALF;
      if (zB - zA < 20 || xB - xA < 20) continue;
      const mid = (zA + zB) / 2;
      // two rows of parcels, back to back; each faces its own E–W street
      for (const row of [0, 1]) {
        const front = row === 0 ? zA : zB, back = mid, dir = row === 0 ? 1 : -1; // dir: from front into the parcel
        let x = xA;
        // a 1970s block row; forced on the next street north-west of the site (site-rear.jpg)
        const forced = i === 12 && row === 1 && ns[j + 1] === -52;
        const blockRow = forced || rng() < 0.28;
        while (x < xB - 6) {
          const r = rng();
          if (blockRow && xB - x > 26 && r < 0.75) {
            const w = Math.min(xB - x - 2, 26 + rng() * 22);
            const set = 3 + rng() * 2, d = 11 + rng() * 1.5;
            const z0 = dir > 0 ? front + set : front - set - d, z1 = z0 + d;
            // keep a view corridor to the river from the 2nd-floor rear balconies (the "glimpse")
            const inCone = z1 < 0 && Math.abs((x + w / 2) - 7) < 30 + (-z1) * 0.25;
            if (!inCone && !inReserved(x, z0, x + w, z1) && landOK(x, z0, x + w, z1)) addBlock(C, rng, x + 1, z0, x + w - 1, z1, front, rng() < 0.2 ? 5 : 4);
            // trees in front of blocks
            if (rng() < 0.7) addTree(C, x + w * rng(), front + dir * (set * 0.5), 0.9 + rng() * 0.4, 0);
            x += w + 2 + rng() * 4;
            continue;
          }
          const w = 8 + rng() * 5;
          const set = 2 + rng() * 4, d = 8.5 + rng() * 4;
          const z0 = dir > 0 ? front + set : front - set - d, z1 = z0 + d;
          const x0 = x + 0.8, x1 = x + w - (rng() < 0.4 ? 0 : 1.2); // some are semi-detached (touching)
          if (!inReserved(x0 - 1, Math.min(front, z0), x1 + 1, Math.max(front, z1)) && landOK(x0, z0, x1, z1)) {
            addHouse(C, rng, x0, z0, x1, z1, front);
            // backyard tree
            if (rng() < 0.3) { const k = rng(); addTree(C, lerp(x0, x1, rng()), dir > 0 ? z1 + 3 : z0 - 3, 0.7 + rng() * 0.6, k < 0.35 ? 1 : k < 0.55 ? 2 : 0); }
            if (rng() < 0.18 && Math.hypot(x - 7, front - 7) < 420) {
              const sz = front - dir * (HALF - ROAD_HALF + 1.0);
              C.cars.push({ x: x + w / 2, z: sz, ry: dir > 0 ? Math.PI : 0, col: rng() });
            }
          }
          x += w;
        }
      }
    }
  }
}

// ---------------------------------------------------------------- the real neighbours (site photos)
function buildNeighbours(C, rng) {
  const g = C.near; // near-detail merged builders
  const Y = PAVE_Y, G = NEAR_Y;
  const pink = [0.9, 0.62, 0.53], white = [0.95, 0.94, 0.91], wall = [0.95, 0.945, 0.93];

  // --- WEST: pink 2-storey house no. 4, attached to the party wall at x = 0 (front set back ~3.6 m)
  {
    const x0 = -10.8, x1 = -0.02, z0 = 1.2, z1 = 13.8, base = Y + 0.15, top = base + 6.1;
    g.facade.color(pink); facadeBox(g.facade, x0, z0, x1, z1, base, top, 0.4, 0.25);
    // eaves & tile roof (hipped, visible overhang as in the photo)
    g.plain.color([0.93, 0.9, 0.87]).box(x0 - 0.6, top - 0.2, z0 - 0.6, x1 + 0.02, top + 0.02, z1 + 0.6, 1, {});
    const rc = new T.Color('#b1553a'); g.roof.color(rc);
    hipRoof(g.roof, x0, z0, x1 - 0.3, z1, top, 0.42, 0.6);
    // first-floor balcony slab with wrought-iron loops railing (street side)
    g.plain.color(pink).box(-8.7, base + 3.0, z1, -0.6, base + 3.2, z1 + 1.2, 1, {});
    C.ironQuads.push({ x0: -8.7, x1: -0.6, z: z1 + 1.18, y0: base + 3.2, y1: base + 4.1 });
    C.ironQuads.push({ side: true, x: -8.7, z0: z1, z1: z1 + 1.18, y0: base + 3.2, y1: base + 4.1 });
    // ground floor: shutters/door recess darker
    g.plain.color([0.25, 0.18, 0.15]).box(-4.6, base, z1 - 0.01, -1.8, base + 2.3, z1 + 0.02, 1);
    // front wall with pink pillars + stone base, and gate no. 4
    const fz = 17.25;
    g.stone.box(-10.8, Y - 0.2, fz - 0.12, -3.2, Y + 0.55, fz + 0.12, 1.4);
    g.stone.box(-0.95, Y - 0.2, fz - 0.12, 0.0, Y + 0.55, fz + 0.12, 1.4);
    for (const px of [-10.8, -4.0, -3.2 - 0.6, -0.95]) g.plain.color(pink).box(px, Y - 0.2, fz - 0.2, px + 0.6, Y + 1.45, fz + 0.2, 1);
    g.plain.color([0.72, 0.62, 0.55]).box(-3.2, Y - 0.2, fz - 0.12, -1.2, Y + 0.2, fz + 0.12, 1); // gate threshold
    C.ironQuads.push({ x0: -3.15, x1: -0.98, z: fz, y0: Y + 0.2, y1: Y + 1.35 });   // gate
    C.ironQuads.push({ x0: -10.2, x1: -4.05, z: fz, y0: Y + 0.55, y1: Y + 1.25 });   // railing on wall
    // side walls of its front yard
    g.plain.color(wall).box(-10.8, Y - 0.2, 13.8, -10.6, Y + 1.3, fz, 1);
    // yard floor (tiles)
    g.plain.color([0.7, 0.66, 0.6]).box(-10.6, Y - 0.2, 13.8, -0.02, Y + 0.05, fz - 0.12, 1, { bottom: true });
    // rear annex / garden wall
    g.plain.color(wall).box(-10.8, G - 0.2, -7.9, -0.02, G + 2.0, -7.7, 1);
    g.facade.color(pink); facadeBox(g.facade, -10.8, -3.5, -0.02, 1.2, G + 0.1, G + 3.2, 0.4, 0.5);
    g.plain.color([0.93, 0.9, 0.87]).box(-10.9, G + 3.2, -3.6, -0.02, G + 3.45, 1.3, 1, {});
    // the house beyond (a pink/cream terrace continuing west)
  }

  // --- EAST: white 2-storey house with terracotta roof and round window (gable facing the street)
  {
    const x0 = 16.4, x1 = 27.8, z0 = 0.5, z1 = 12.6, base = Y + 0.6, top = base + 6.0;
    g.facade.color(white); facadeBox(g.facade, x0, z0, x1, z1, base, top, 1.6, 0.5);
    const rc = new T.Color('#bf5a37'); g.roof.color(rc);
    gableRoof(g.roof, x0, z0, x1, z1, top, false, 0.5, 0.45);
    g.plain.color(white); gableEnds(g.plain, x0, z0, x1, z1, top, false, 0.5 * (x1 - x0 + 0.9) / (x1 - x0));
    // barge boards
    g.plain.color([0.97, 0.97, 0.96]).box(x0 - 0.45, top - 0.2, z1 + 0.35, x1 + 0.45, top, z1 + 0.5, 1, {});
    // round window in the gable (dark glass disc + white ring)
    C.roundWin = { x: 22.1, y: top - 0.2 + 1.3, z: z1 + 0.02 };
    // brick pier at the right corner (as in the photo)
    const brick = [0.62, 0.3, 0.24];
    g.plain.color(brick).box(x1 - 0.9, base - 1.5, z1 - 0.9, x1, top, z1, 1);
    // ground floor windows + garage
    g.plain.color([0.28, 0.3, 0.33]).box(17.2, base + 0.3, z1 - 0.02, 19.6, base + 2.4, z1 + 0.01, 1);
    // front garden: white wall + green mesh fence on top, low planting
    const fz = 17.3;
    g.plain.color(wall).box(14.4, Y - 0.3, fz - 0.15, 29.5, Y + 1.25, fz + 0.1, 1);
    g.plain.color(wall).box(14.2, Y - 0.3, -7.9, 14.45, Y + 1.25, fz, 1); // wall along the lot's east side (front part)
    C.fenceQuads.push({ x0: 14.9, x1: 29.5, z: fz - 0.02, y0: Y + 1.25, y1: Y + 2.05 });
    g.yard.color([0.62, 0.64, 0.46]).box(14.45, G - 0.2, 12.6, 29.5, Y + 0.3, fz - 0.15, 6, { bottom: true });
    addTree(C, 19.2, 15.0, 0.85, 1); addTree(C, 25.5, 15.3, 0.7, 2);
  }

  // --- rear/side boundary walls of the lot (white, ~2.2 m) — BUILDING owns the front low wall
  {
    const H = 2.3;
    g.plain.color(wall).box(-0.2, G - 0.3, -8.1, 14.5, G + H, -7.85, 1);          // rear
    g.plain.color(wall).box(-0.25, G - 0.3, -8.1, -0.02, G + H, 1.2, 1);          // west rear part
    // copings
    g.plain.color([0.86, 0.85, 0.82]).box(-0.25, G + H, -8.15, 14.5, G + H + 0.06, -7.8, 1, {});
  }

  // --- behind the rear wall: modern grey/white semi-detached pair + a white block edge (site-plot.jpg)
  {
    const base = G + 0.05;
    const gw = [0.94, 0.94, 0.93], gr = [0.45, 0.47, 0.5];
    // pair A (NW) and B (NE), flat roofs with white upper floor over dark grey ground floor
    for (const [x0, x1] of [[-1.5, 9.8], [15.5, 29]]) {
      const z0 = -24.5, z1 = -12.0;
      g.facade.color(gr); facadeBox(g.facade, x0, z0, x1, z1, base, base + 3.0, 0.5, 0.75);
      g.facade.color(gw); facadeBox(g.facade, x0, z0, x1, z1, base + 3.0, base + 6.2, 0, 0.25);
      g.plain.color(gw).box(x0 - 0.1, base + 6.2, z0 - 0.1, x1 + 0.1, base + 6.6, z1 + 0.1, 1, {});
      g.plain.color(wall).box(x0, G - 0.3, -12.0, x1, G + 1.8, -11.8, 1);
    }
    // gable house in the centre background (white, pitched, grey ground floor) as in site-street.jpg
    const x0 = -3.5, x1 = 5.0, z0 = -34, z1 = -25.5, b2 = groundY(1, -30) + 0.05;
    g.facade.color([0.45, 0.46, 0.48]); facadeBox(g.facade, x0, z0, x1, z1, b2, b2 + 3, 1, 0);
    g.facade.color([0.95, 0.95, 0.94]); facadeBox(g.facade, x0, z0, x1, z1, b2 + 3, b2 + 6, 0, 0.5);
    g.plain.color([0.95, 0.95, 0.94]); gableEnds(g.plain, x0, z0, x1, z1, b2 + 6, true, 0.55 * (z1 - z0 + 0.6) / (z1 - z0));
    g.metal.color([0.62, 0.63, 0.64]); gableRoof(g.metal, x0, z0, x1, z1, b2 + 6, true, 0.55, 0.3);
  }

  // --- slim tower in the distance (site-plot.jpg, grain silo / water tower look)
  {
    const x = 55, z = -420, b = groundY(x, z);
    g.plain.color([0.86, 0.87, 0.88]).box(x - 1.3, b - 1, z - 1.3, x + 1.3, b + 21, z + 1.3, 1, {});
    g.plain.color([0.76, 0.77, 0.78]).box(x - 1.7, b + 21, z - 1.7, x + 1.7, b + 23, z + 1.7, 1, {});
  }

  // --- houses opposite the lot, south side of Rua Eduardo Couto (2-storey, set back behind front walls)
  // generated by the neighbourhood filler (row facing the street) — nothing explicit needed.
}

// ---------------------------------------------------------------- street furniture: poles, cables, lamps
function buildStreetFurniture(C, rng) {
  const g = C.near;
  const zN = STREET.zKerb + 0.35, zS = ROW_Z + HALF - 0.35; // pole lines on both pavements
  const Y = PAVE_Y;
  // Rua Eduardo Couto: concrete utility poles on the south pavement, cables across to the houses (as in the photo)
  const poles = [];
  for (let x = -120; x <= 140; x += 34) poles.push([x + (rng() - 0.5) * 3, zS]);
  const lampPts = [];
  for (const [x, z] of poles) {
    const y0 = groundY(x, z) + PAVE_UP;
    // tapered concrete pole 9 m
    const pg = new T.CylinderGeometry(0.1, 0.16, 9, 8);
    g.plain.color([0.72, 0.71, 0.68]).geom(pg, new T.Matrix4().makeTranslation(x, y0 + 4.5, z));
    pg.dispose();
    // cross-arm
    g.plain.color([0.4, 0.4, 0.4]).box(x - 0.6, y0 + 8.4, z - 0.05, x + 0.6, y0 + 8.5, z + 0.05, 1, {});
    // lamp arm + head towards the road
    const ag = new T.CylinderGeometry(0.035, 0.035, 1.6, 6);
    g.metal.color([0.5, 0.5, 0.5]).geom(ag, new T.Matrix4().makeRotationX(Math.PI / 2 - 0.15).setPosition(x, y0 + 7.1, z - 0.8));
    ag.dispose();
    lampPts.push([x, y0 + 6.95, z - 1.55]);
  }
  // lamps on the north pavement too (wall-mounted on the houses side), offset
  for (let x = -103; x <= 140; x += 34) {
    if (x > -4 && x < 18) continue; // not in front of the lot
    const z = zN; const y0 = groundY(x, z) + PAVE_UP;
    const pg = new T.CylinderGeometry(0.06, 0.09, 6.2, 8);
    g.metal.color([0.28, 0.3, 0.31]).geom(pg, new T.Matrix4().makeTranslation(x, y0 + 3.1, z));
    pg.dispose();
    lampPts.push([x, y0 + 6.1, z + 0.45]);
    const ag = new T.CylinderGeometry(0.03, 0.03, 0.9, 6);
    g.metal.color([0.28, 0.3, 0.31]).geom(ag, new T.Matrix4().makeRotationX(Math.PI / 2).setPosition(x, y0 + 6.2, z + 0.25));
    ag.dispose();
  }
  // lamp heads (instanced) + glow sprites + light pools on the ground
  const headG = new T.CylinderGeometry(0.22, 0.32, 0.18, 10);
  const heads = new T.InstancedMesh(headG, C.mats.lampHead, lampPts.length);
  heads.name = 'env-streetlamp-heads';
  const m4 = new T.Matrix4();
  lampPts.forEach(([x, y, z], i) => heads.setMatrixAt(i, m4.makeTranslation(x, y, z)));
  C.group.add(heads);
  // glows & pools merged
  const glowGB = new GB(), poolGB = new GB();
  for (const [x, y, z] of lampPts) {
    const s = 1.2;
    // camera-facing is not needed for small halos: cross of 3 quads
    for (const a of [0, Math.PI / 3, 2 * Math.PI / 3]) {
      const dx = Math.cos(a) * s, dz = Math.sin(a) * s;
      glowGB.quad([x - dx, y - s - 0.1, z - dz], [x + dx, y - s - 0.1, z + dz], [x + dx, y + s - 0.1, z + dz], [x - dx, y + s - 0.1, z - dz]);
    }
    const r = 7, yg = groundY(x, z) + ROAD_UP + 0.02;
    poolGB.quad([x - r, yg, z + r], [x + r, yg, z + r], [x + r, yg, z - r], [x - r, yg, z - r], [[0, 0], [1, 0], [1, 1], [0, 1]]);
  }
  const glow = new T.Mesh(glowGB.build(), C.mats.glow); glow.name = 'env-streetlamp-halos'; glow.renderOrder = 5;
  const pool = new T.Mesh(poolGB.build(), C.mats.pool); pool.name = 'env-streetlamp-pools'; pool.renderOrder = 4;
  C.group.add(glow, pool);
  C.lampPts = lampPts;

  // Overhead cables: sagging catenaries between poles + drops across the street to façades
  const pts = [];
  const cable = (a, b, sag) => {
    const n = 14;
    for (let i = 0; i < n; i++) {
      const t0 = i / n, t1 = (i + 1) / n;
      const P = (t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t) - sag * 4 * t * (1 - t), lerp(a[2], b[2], t)];
      pts.push(...P(t0), ...P(t1));
    }
  };
  for (let i = 0; i < poles.length - 1; i++) {
    const [xa, za] = poles[i], [xb, zb] = poles[i + 1];
    const ya = groundY(xa, za) + PAVE_UP, yb = groundY(xb, zb) + PAVE_UP;
    for (const [dx, dy, sag] of [[-0.5, 8.45, 0.55], [0.5, 8.45, 0.6], [0, 7.6, 0.8]]) cable([xa + dx, ya + dy, za], [xb + dx, yb + dy, zb], sag);
  }
  // service drops to the houses on the north side (pink house) and the diagonal across the lot (photo)
  const p0 = poles.find(p => p[0] > -20) || poles[0];
  const yP = groundY(p0[0], p0[1]) + PAVE_UP;
  cable([p0[0], yP + 8.3, p0[1]], [-2.0, PAVE_Y + 6.0, 13.8], 0.5);
  cable([p0[0], yP + 8.3, p0[1]], [-4.0, PAVE_Y + 5.8, 13.8], 0.55);
  for (let i = 1; i < poles.length; i += 2) {
    const [x, z] = poles[i]; const y = groundY(x, z) + PAVE_UP;
    if (x > -3 && x < 17) continue;
    cable([x, y + 8.2, z], [x + 3, PAVE_Y + 5.6, STREET.zKerb - 3.5], 0.4);
    cable([x, y + 8.2, z], [x - 2, PAVE_Y + 5.6, ROW_Z + HALF + 4.0], 0.35);
  }
  const lg = new T.BufferGeometry();
  lg.setAttribute('position', new T.Float32BufferAttribute(pts, 3));
  const lines = new T.LineSegments(lg, C.mats.cable);
  lines.name = 'env-overhead-cables';
  C.group.add(lines);
}

// ---------------------------------------------------------------- trees & cars (instanced)
function treeGeometries() {
  // kind 0: round broadleaf (plane / lime), kind 1: cypress / pine-like column, kind 2: umbrella pine
  const mk = (parts) => {
    const gb = new GB();
    for (const [geo, m, col] of parts) { gb.color(col); gb.geom(geo, m); geo.dispose(); }
    return gb.build();
  };
  const trunk = [0.36, 0.28, 0.2];
  const g0 = mk([
    [new T.CylinderGeometry(0.12, 0.2, 3.2, 5, 1, true), new T.Matrix4().makeTranslation(0, 1.6, 0), trunk],
    [new T.IcosahedronGeometry(2.4, 1), new T.Matrix4().makeScale(1, 0.85, 1).setPosition(0, 4.6, 0), [0.33, 0.42, 0.22]],
    [new T.IcosahedronGeometry(1.6, 0), new T.Matrix4().makeTranslation(1.2, 5.5, 0.6), [0.38, 0.47, 0.25]],
    [new T.IcosahedronGeometry(1.5, 0), new T.Matrix4().makeTranslation(-1.1, 5.2, -0.7), [0.3, 0.39, 0.2]]
  ]);
  const g1 = mk([
    [new T.CylinderGeometry(0.1, 0.14, 1.2, 4, 1, true), new T.Matrix4().makeTranslation(0, 0.6, 0), trunk],
    [new T.ConeGeometry(1.1, 7, 7), new T.Matrix4().makeTranslation(0, 4.3, 0), [0.2, 0.3, 0.17]]
  ]);
  const g2 = mk([
    [new T.CylinderGeometry(0.16, 0.26, 7, 5, 1, true), new T.Matrix4().makeRotationZ(0.1).setPosition(0.3, 3.5, 0), trunk],
    [new T.IcosahedronGeometry(3, 1), new T.Matrix4().makeScale(1.3, 0.45, 1.2).setPosition(0.6, 7.6, 0), [0.25, 0.35, 0.2]]
  ]);
  return [g0, g1, g2];
}

function buildTrees(C) {
  const geos = treeGeometries();
  const byKind = [[], [], []];
  for (const t of C.trees || []) byKind[t.kind].push(t);
  const m4 = new T.Matrix4(), q = new T.Quaternion(), e = new T.Euler(), v = new T.Vector3(), sc = new T.Vector3();
  const rng = rngFrom(4242);
  byKind.forEach((list, k) => {
    if (!list.length) { geos[k].dispose(); return; }
    const im = new T.InstancedMesh(geos[k], C.mats.tree, list.length);
    im.name = `env-trees-${k}`;
    const col = new T.Color();
    list.forEach((t, i) => {
      e.set(0, rng() * Math.PI * 2, 0); q.setFromEuler(e);
      const s = t.s * (0.85 + rng() * 0.3);
      im.setMatrixAt(i, m4.compose(v.set(t.x, t.y - 0.1, t.z), q, sc.set(s, s * (0.9 + rng() * 0.2), s)));
      const k2 = 0.85 + rng() * 0.3; im.setColorAt(i, col.setRGB(k2, k2 * (0.95 + rng() * 0.1), k2 * 0.9));
    });
    im.castShadow = true; im.receiveShadow = true;
    im.computeBoundingSphere();
    C.group.add(im);
  });
}

function carGeometry() {
  const gb = new GB();
  const body = [1, 1, 1], glass = [0.08, 0.1, 0.12], tyre = [0.07, 0.07, 0.07], chrome = [0.75, 0.75, 0.75];
  // lower body (rounded-ish by stacking), cabin, windows, wheels, lights
  gb.color(body).rbox(0, 0, 4.2, 1.75, 0.3, 0.95, 0);
  gb.color(body).rbox(0, 0, 4.0, 1.7, 0.95, 1.0, 0);
  // trapezoid cabin as a lofted box (hatchback)
  const cabinShape = (w, y0, y1, xf0, xb0, xf1, xb1) => {
    const hw = w / 2, v = (x, y, z) => [x, y, z];
    const A = v(xb0, y0, -hw), B = v(xf0, y0, -hw), Cc = v(xf1, y1, -hw * 0.9), D = v(xb1, y1, -hw * 0.9);
    const E = v(xb0, y0, hw), F = v(xf0, y0, hw), G = v(xf1, y1, hw * 0.9), H = v(xb1, y1, hw * 0.9);
    return { A, B, C: Cc, D, E, F, G, H };
  };
  const c = cabinShape(1.6, 1.0, 1.45, 1.05, -1.75, 0.2, -1.45);
  gb.color(glass);
  gb.quad(c.B, c.F, c.G, c.C, null, [1, 0.5, 0]);   // windscreen
  gb.quad(c.E, c.A, c.D, c.H, null, [-1, 0.3, 0]);  // rear window
  gb.quad(c.A, c.B, c.C, c.D, null, [0, 0, -1]);    // side windows
  gb.quad(c.F, c.E, c.H, c.G, null, [0, 0, 1]);
  gb.color(body);
  gb.quad(c.D, c.C, c.G, c.H, null, [0, 1, 0]);     // roof
  // wheels
  const wg = new T.CylinderGeometry(0.31, 0.31, 0.22, 8).rotateX(Math.PI / 2);
  for (const [x, z] of [[1.3, 0.78], [-1.3, 0.78], [1.3, -0.78], [-1.3, -0.78]]) gb.color(tyre).geom(wg, new T.Matrix4().makeTranslation(x, 0.31, z));
  wg.dispose();
  // lights
  gb.color([1, 0.95, 0.85]).rbox(2.1, 0.55, 0.04, 0.3, 0.72, 0.82, 0);
  gb.color([1, 0.95, 0.85]).rbox(2.1, -0.55, 0.04, 0.3, 0.72, 0.82, 0);
  gb.color([0.6, 0.05, 0.05]).rbox(-2.1, 0.6, 0.04, 0.25, 0.78, 0.9, 0);
  gb.color([0.6, 0.05, 0.05]).rbox(-2.1, -0.6, 0.04, 0.25, 0.78, 0.9, 0);
  gb.color(chrome).rbox(2.12, 0, 0.04, 0.8, 0.42, 0.55, 0);
  return gb.build();
}
const CAR_COLS = ['#1d1f22', '#f0f0ee', '#9ea3a8', '#2d3a4f', '#6e7378', '#7a1e1e', '#e9e5da', '#3b4b3a', '#b8bcc0', '#101216'];

function buildCars(C) {
  const list = C.cars;
  if (!list.length) return;
  const geo = carGeometry();
  const im = new T.InstancedMesh(geo, C.mats.car, list.length);
  im.name = 'env-parked-cars';
  const m4 = new T.Matrix4(), q = new T.Quaternion(), v = new T.Vector3(), s = new T.Vector3(1, 1, 1), col = new T.Color();
  list.forEach((c, i) => {
    q.setFromAxisAngle(new T.Vector3(0, 1, 0), c.ry + (c.col - 0.5) * 0.04);
    const y = c.y !== undefined ? c.y : groundY(c.x, c.z) + ROAD_UP;
    im.setMatrixAt(i, m4.compose(v.set(c.x, y, c.z), q, s));
    col.set(CAR_COLS[Math.floor(c.col * 997) % CAR_COLS.length]);
    im.setColorAt(i, col);
  });
  im.castShadow = true; im.receiveShadow = true;
  im.computeBoundingSphere();
  C.group.add(im);
}

// wrought-iron and fence quads (alpha-tested)
function buildAlphaQuads(C) {
  const iron = new GB(), fence = new GB();
  for (const q of C.ironQuads) {
    if (q.side) iron.quad([q.x, q.y0, q.z0], [q.x, q.y0, q.z1], [q.x, q.y1, q.z1], [q.x, q.y1, q.z0], [[0, 0], [(q.z1 - q.z0) / 1.6, 0], [(q.z1 - q.z0) / 1.6, 1], [0, 1]]);
    else iron.quad([q.x0, q.y0, q.z], [q.x1, q.y0, q.z], [q.x1, q.y1, q.z], [q.x0, q.y1, q.z], [[0, 0], [(q.x1 - q.x0) / 1.6, 0], [(q.x1 - q.x0) / 1.6, 1], [0, 1]]);
  }
  for (const q of C.fenceQuads) fence.quad([q.x0, q.y0, q.z], [q.x1, q.y0, q.z], [q.x1, q.y1, q.z], [q.x0, q.y1, q.z], [[0, 0], [(q.x1 - q.x0) / 1.2, 0], [(q.x1 - q.x0) / 1.2, (q.y1 - q.y0) / 1.2], [0, (q.y1 - q.y0) / 1.2]]);
  if (!iron.empty) { const m = new T.Mesh(iron.build(), C.mats.iron); m.name = 'env-wrought-iron'; m.castShadow = true; C.group.add(m); }
  if (!fence.empty) { const m = new T.Mesh(fence.build(), C.mats.fence); m.name = 'env-green-fence'; C.group.add(m); }
  if (C.roundWin) {
    const { x, y, z } = C.roundWin;
    const ring = new T.Mesh(new T.TorusGeometry(0.42, 0.07, 8, 24), C.mats.plain);
    ring.geometry.setAttribute('color', new T.Float32BufferAttribute(new Array(ring.geometry.attributes.position.count * 3).fill(0.97), 3));
    ring.position.set(x, y, z + 0.04); ring.name = 'env-round-window-frame';
    const disc = new T.Mesh(new T.CircleGeometry(0.42, 24), C.mats.glassDark);
    disc.position.set(x, y, z + 0.02); disc.name = 'env-round-window';
    C.group.add(ring, disc);
  }
}

// ---------------------------------------------------------------- far shore: Lisbon, Barreiro, Seixal, Montijo
function lm(id) { const l = LANDMARKS.find(o => o.id === id); return l ? geoXZ(l.lat, l.lon) : null; }

function buildFarCity(C, rng, low) {
  const gb = new GB(); // uses city material (façade atlas, tiny scale)
  const lightPos = [], lightCol = [];
  const addLights = (x0, z0, x1, z1, y0, y1, n) => {
    for (let i = 0; i < n; i++) {
      const x = lerp(x0, x1, rng()), z = lerp(z0, z1, rng()), y = lerp(y0, y1, rng());
      lightPos.push(x, y, z);
      const w = rng();
      if (w < 0.6) lightCol.push(1.0, 0.72, 0.4); else if (w < 0.85) lightCol.push(1.0, 0.85, 0.62); else lightCol.push(0.8, 0.88, 1.0);
    }
  };
  const block = (x, z, w, d, h, col, lights = true) => {
    const b = heightAt(x, z);
    if (b <= WATER_Y + 0.5) return;
    gb.color(col);
    facadeBox(gb, x - w / 2, z - d / 2, x + w / 2, z + d / 2, b, b + h, 6, (rng() * 4 | 0) / 4);
    gb.plain(true).box(x - w / 2, b + h, z - d / 2, x + w / 2, b + h + 0.1, z + d / 2, 1, {}).plain(false);
    if (lights) addLights(x - w / 2, z + d / 2 + 1, x + w / 2, z + d / 2 + 1, b + 2, b + h - 1, Math.ceil(w * h / 90));
  };
  const cityCols = ['#ece6da', '#f2efe8', '#e6d6c0', '#ddd8cf', '#f0e2cf', '#d9cbb8', '#efe9e0', '#cfd3d6'];
  const col = () => { const c = new T.Color(cityCols[rng() * cityCols.length | 0]); return c; };
  // Lisbon: fill the north bank polygon near the shore (layers get taller inland)
  for (let i = 0; i < 2600; i++) {
    const x = lerp(-17500, -2500, rng()), z = lerp(-17000, -2800, rng());
    const sd = polySD(LISBON_POLY, x, z);
    if (sd < 40 || sd > 3200) continue;
    const toBaixa = Math.hypot(x + 9150, z + 4350);
    const tall = rng() < 0.08 + (x > -8500 ? 0.1 : 0);
    const h = tall ? 30 + rng() * 60 : 9 + rng() * 14;
    const w = 25 + rng() * 55, d = 20 + rng() * 40;
    block(x, z, w, d, toBaixa < 900 ? Math.min(h, 22) : h, col());
  }
  // Parque das Nações towers
  const pn = lm('parque-nacoes');
  if (pn) {
    for (let i = 0; i < 40; i++) block(pn[0] + (rng() - 0.5) * 1400, pn[1] + (rng() - 0.3) * 1400, 30 + rng() * 30, 25 + rng() * 25, 25 + rng() * 45, col());
    block(pn[0] - 300, pn[1] + 200, 22, 22, 145, [0.9, 0.92, 0.94]);       // Vasco da Gama tower (approx.)
  }
  // Amoreiras / Marquês / Av. da República towers (tallest far skyline accents)
  for (const [x, z, h] of [[-11200, -7300, 90], [-11050, -7250, 85], [-10300, -7400, 75], [-9400, -9800, 100], [-9700, -10200, 110], [-8600, -11200, 80], [-7700, -10800, 95], [-8200, -8800, 70]]) block(x, z, 30, 30, h, col());
  // South bank (Barreiro town west, Seixal, Almada), low
  for (let i = 0; i < 900; i++) {
    const x = lerp(-11000, -3100, rng()), z = lerp(-1400, 3000, rng());
    if (heightAt(x, z) <= WATER_Y + 1 || Math.hypot(x - 7, z - 7) < 3000) continue;
    block(x, z, 20 + rng() * 30, 14 + rng() * 20, 9 + rng() * 12, col());
  }
  // Mid belt: terraces continuing the Lavradio street grid out to MID_R, then scattered houses to 3.6 km
  const roofC = () => new T.Color(ROOF_COLS[rng() * ROOF_COLS.length | 0]);
  const MID_R = low ? 1500 : 1900;
  const midOK = (x, z) => heightAt(x, z) > WATER_Y + 1.4 && z - zShore(x) > 45 &&
    x > GRID.x0 + 60 && x < GRID.x1 - 60 && z > GRID.z0 + 60 && z < GRID.z1 - 60;
  const terrace = (x0, x1, zf, dir, blk) => {
    const d = blk ? 11.5 : 9 + rng() * 2, set = blk ? 4 : 2 + rng() * 2;
    const z0 = dir > 0 ? zf + set : zf - set - d, z1 = z0 + d;
    const b = Math.min(groundY(x0, z0), groundY(x1, z1), groundY(x0, z1), groundY(x1, z0));
    const h = blk ? (rng() < 0.3 ? 15 : 12) : (rng() < 0.25 ? 3.3 : 6.3);
    gb.color(blk ? col() : new T.Color(HOUSE_COLS[rng() * HOUSE_COLS.length | 0]));
    facadeBox(gb, x0, z0, x1, z1, b, b + h, 2.5, (rng() * 4 | 0) / 4);
    gb.plain(true).color(roofC());
    hipRoof(gb, x0, z0, x1, z1, b + h, blk ? 0.3 : 0.42, 0.3);
    gb.plain(false);
    if (rng() < 0.5) addLights(x0, dir > 0 ? z0 - 0.5 : z1 + 0.5, x1, dir > 0 ? z0 - 0.5 : z1 + 0.5, b + 1.5, b + h - 1, blk ? 5 : 2);
  };
  for (let k = -40; k <= 40; k++) {
    const zs = ROW_Z + k * ROW_DZ;
    for (const dir of [1, -1]) {
      const zf = zs + dir * HALF;
      let x = -MID_R + ((k * 37) % 50);
      while (x < MID_R) {
        const blk = rng() < 0.22, w = blk ? 26 + rng() * 22 : 10 + rng() * 22;
        const xm = x + w / 2, r = Math.hypot(xm - 7, zf - 7);
        const gapStreet = ((Math.floor((xm + 5000) / 104)) !== Math.floor((x + w + 12 + 5000) / 104)); // N–S street every ~104 m
        if (r > NEAR_R + 8 && r < MID_R && rng() < 0.8 && midOK(x, zf) && midOK(x + w, zf + dir * 15)) terrace(x, x + w, zf, dir, blk);
        x += w + (gapStreet ? 12 : 1 + rng() * 3);
      }
    }
  }
  for (let i = 0; i < (low ? 1200 : 2400); i++) {
    const a = rng() * Math.PI * 2, r = Math.sqrt(lerp(MID_R * MID_R, 3600 * 3600, rng()));
    const x = 7 + Math.cos(a) * r, z = 7 + Math.sin(a) * r;
    if (!midOK(x, z) || !midOK(x + 30, z + 30)) continue;
    terrace(x, x + 12 + rng() * 24, z, rng() < 0.5 ? 1 : -1, rng() < 0.3);
  }
  // Montijo / Alcochete (east, very low)
  for (let i = 0; i < 400; i++) {
    const x = lerp(3300, 14000, rng()), z = lerp(-11000, 2500, rng());
    if (heightAt(x, z) <= WATER_Y + 1 || Math.hypot(x - 7, z - 7) < 3200) continue;
    block(x, z, 20 + rng() * 30, 14 + rng() * 20, 7 + rng() * 8, col(), rng() < 0.6);
  }
  const mesh = new T.Mesh(gb.build(), C.mats.city);
  mesh.name = 'env-far-city';
  mesh.matrixAutoUpdate = false;
  C.group.add(mesh);
  // mid-range belt (3–8 km, Barreiro / Baixa da Banheira) is handled by the same loops above
  const lg = new T.BufferGeometry();
  lg.setAttribute('position', new T.Float32BufferAttribute(lightPos, 3));
  lg.setAttribute('color', new T.Float32BufferAttribute(lightCol, 3));
  const pts = new T.Points(lg, C.mats.lights);
  pts.name = 'env-city-lights'; pts.frustumCulled = false;
  C.group.add(pts);
}

function buildBridges(C) {
  const redGB = new GB(), conGB = new GB();
  const cablePts = [], stayPts = [];
  const catenary = (a, b, sag, n = 24) => {
    for (let i = 0; i < n; i++) {
      const P = (t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t) - sag * 4 * t * (1 - t), lerp(a[2], b[2], t)];
      cablePts.push(...P(i / n), ...P((i + 1) / n));
    }
  };
  // --- 25 de Abril: main span 1013 m, towers 190 m, deck 70 m above water, roughly N–S (az ~ 20°)
  const p25 = lm('ponte-25');
  if (p25) {
    const [cx, cz] = p25;
    const ang = -17 * DEG; const dir = [Math.sin(ang), -Math.cos(ang)]; // unit vector towards the north bank (Alcântara, NNW)
    const at = (s, off = 0) => [cx + dir[0] * s - dir[1] * off, cz + dir[1] * s + dir[0] * off];
    const W = WATER_Y;
    const deckY = W + 70, towerH = 190;
    // towers at ±506 m
    for (const s of [-506, 506]) {
      for (const o of [-12, 12]) {
        const [x, z] = at(s, o);
        redGB.rbox(x, z, 7, 7, W - 2, W + towerH, -ang);
      }
      for (const h of [deckY + 5, W + towerH - 50, W + towerH - 3]) { const [x, z] = at(s, 0); redGB.rbox(x, z, 28, 5, h, h + 5, -ang); }
    }
    // deck truss (as a red box) from south anchorage to north
    const s0 = -1500, s1 = 1300;
    const n = 28;
    for (let i = 0; i < n; i++) {
      const sa = lerp(s0, s1, i / n), sb = lerp(s0, s1, (i + 1) / n), sm = (sa + sb) / 2;
      const [x, z] = at(sm, 0);
      const y = sm < -506 ? lerp(deckY - 18, deckY, (sm - s0) / (-506 - s0)) : sm > 506 ? lerp(deckY, deckY - 10, (sm - 506) / (s1 - 506)) : deckY;
      redGB.rbox(x, z, 24, sb - sa + 1, y - 9, y, -ang);
      // approach viaduct piers
      if (sm < -560 || sm > 560) conGB.rbox(x, z, 16, 8, W - 2, y - 9, -ang);
    }
    // main cables
    for (const o of [-12, 12]) {
      const A = at(-1100, o), B = at(-506, o), Cc = at(506, o), D = at(1000, o);
      catenary([A[0], deckY - 5, A[1]], [B[0], W + towerH, B[1]], -30, 12);
      catenary([B[0], W + towerH, B[1]], [Cc[0], W + towerH, Cc[1]], 110, 40);
      catenary([Cc[0], W + towerH, Cc[1]], [D[0], deckY - 5, D[1]], -30, 12);
    }
  }
  // --- Cristo Rei: 82 m pedestal + 28 m statue on the Almada cliff
  const cr = lm('cristo-rei');
  if (cr) {
    const [x, z] = cr; const b = heightAt(x, z);
    conGB.rbox(x, z, 26, 26, b - 3, b + 20, 0);
    // pedestal: four legs portal
    conGB.rbox(x, z, 20, 20, b + 20, b + 75, 0);
    conGB.rbox(x, z, 26, 26, b + 75, b + 82, 0);
    conGB.rbox(x, z, 5, 5, b + 82, b + 104, 0);       // statue body
    conGB.rbox(x, z, 28, 3.5, b + 99, b + 103, 0.2); // arms spread
    conGB.rbox(x, z, 3, 3, b + 104, b + 108, 0);      // head
  }
  // --- Vasco da Gama: 12.3 km long, low viaduct (deck ~ 14 m), cable-stayed main span near the north bank
  const vg = lm('vasco-gama');
  if (vg) {
    const N = geoXZ(38.7785, -9.0885);      // Sacavém end (north bank)
    const S = geoXZ(38.7170, -8.9850);      // Samouco / Montijo end (south bank)
    const len = Math.hypot(S[0] - N[0], S[1] - N[1]);
    const ux = (S[0] - N[0]) / len, uz = (S[1] - N[1]) / len;
    const ang = Math.atan2(ux, uz);
    const W = WATER_Y;
    const segs = Math.ceil(len / 180);
    for (let i = 0; i < segs; i++) {
      const t0 = i / segs, t1 = (i + 1) / segs, tm = (t0 + t1) / 2;
      const x = lerp(N[0], S[0], tm), z = lerp(N[1], S[1], tm);
      const d = tm * len;
      const y = W + (d > 1200 && d < 2400 ? 45 : d < 1200 ? lerp(10, 45, d / 1200) : d < 3500 ? lerp(45, 14, (d - 2400) / 1100) : 14);
      conGB.rbox(x, z, 30, len / segs + 1, y - 2.2, y, ang);
      conGB.rbox(x, z, 8, 3, W - 2, y - 2.2, ang);
    }
    // two H pylons (150 m) near the north end with fan stays
    for (const d of [1400, 1820]) {
      const x = N[0] + ux * d, z = N[1] + uz * d;
      conGB.rbox(x, z, 34, 6, W - 2, W + 150, ang);
      for (let k = 1; k <= 6; k++) {
        for (const sgn of [-1, 1]) {
          const e = sgn * k * 35;
          stayPts.push(x, W + 150 - k * 6, z, x + ux * e, W + 45, z + uz * e);
        }
      }
    }
  }
  if (!redGB.empty) {
    const m = new T.Mesh(redGB.build(), C.mats.redSteel); m.name = 'env-ponte-25-abril'; C.group.add(m);
  }
  if (!conGB.empty) {
    const m = new T.Mesh(conGB.build(), C.mats.concrete); m.name = 'env-bridges-cristo-rei'; C.group.add(m);
  }
  const lg = new T.BufferGeometry(); lg.setAttribute('position', new T.Float32BufferAttribute(cablePts, 3));
  const lines = new T.LineSegments(lg, new T.LineBasicMaterial({ color: '#a8432f', transparent: true, opacity: 0.8 }));
  lines.name = 'env-bridge-cables'; C.group.add(lines);
  C.mats.bridgeCable = lines.material;
  const sg = new T.BufferGeometry(); sg.setAttribute('position', new T.Float32BufferAttribute(stayPts, 3));
  const stays = new T.LineSegments(sg, new T.LineBasicMaterial({ color: '#e8e8e4', transparent: true, opacity: 0.7 }));
  stays.name = 'env-vasco-da-gama-stays'; C.group.add(stays);
}

// ---------------------------------------------------------------- detailed ground around the lot
function buildNearGround(C) {
  // flat yards at NEAR_Y in NEARG, minus the lot and minus the street band (streets are separate meshes)
  const gb = C.near.yard;
  const S = 6;
  const rects = [];
  const zS0 = ROW_Z - HALF, zS1 = ROW_Z + HALF; // Rua Eduardo Couto band
  // north of the street, excluding the lot
  rects.push([NEARG.x0, NEARG.z0, LOT.x0, zS0], [LOT.x1, NEARG.z0, NEARG.x1, zS0], [LOT.x0, NEARG.z0, LOT.x1, LOT.zRear]);
  rects.push([NEARG.x0, zS1, NEARG.x1, NEARG.z1]);
  for (const [x0, z0, x1, z1] of rects) {
    // skip where N–S streets cross (x = -52, 60)
    const cuts = C.ns.filter(x => x + HALF > x0 && x - HALF < x1).sort((a, b) => a - b);
    let cx = x0;
    for (const x of cuts) { if (x - HALF > cx) { gb.color([0.78, 0.74, 0.64]); hquad(gb, cx, z0, x - HALF, z1, NEAR_Y, NEAR_Y, NEAR_Y, NEAR_Y, S); } cx = x + HALF; }
    if (x1 > cx) { gb.color([0.78, 0.74, 0.64]); hquad(gb, cx, z0, x1, z1, NEAR_Y, NEAR_Y, NEAR_Y, NEAR_Y, S); }
  }
  // soil floor deep under the lot so a missing lot never shows a hole to the void
  const soil = C.near.plain.color([0.42, 0.37, 0.3]);
  hquad(soil, LOT.x0, LOT.zRear, LOT.x1, LOT.zFront, -3.4, -3.4, -3.4, -3.4, 4);
  // earth skirts around the lot opening (seen only if the building leaves gaps)
  const yT = NEAR_Y, yB = -3.4;
  soil.quad([LOT.x0, yB, LOT.zRear], [LOT.x1, yB, LOT.zRear], [LOT.x1, yT, LOT.zRear], [LOT.x0, yT, LOT.zRear], null, [0, 0, 1]);
  soil.quad([LOT.x0, yB, LOT.zFront], [LOT.x0, yB, LOT.zRear], [LOT.x0, yT, LOT.zRear], [LOT.x0, yT, LOT.zFront], null, [1, 0, 0]);
  soil.quad([LOT.x1, yB, LOT.zRear], [LOT.x1, yB, LOT.zFront], [LOT.x1, yT, LOT.zFront], [LOT.x1, yT, LOT.zRear], null, [-1, 0, 0]);
  soil.quad([LOT.x1, yB, LOT.zFront], [LOT.x0, yB, LOT.zFront], [LOT.x0, PAVE_Y, LOT.zFront], [LOT.x1, PAVE_Y, LOT.zFront], null, [0, 0, -1]);
}

// ---------------------------------------------------------------- main
export function buildEnvironment(THREE, { scene, renderer, quality = 'high' } = {}) {
  T = THREE;
  const low = quality === 'low';
  const group = new T.Group();
  group.name = 'environment';
  const rng = rngFrom(0x5EED2835);
  const aniso = renderer && renderer.capabilities ? Math.min(8, renderer.capabilities.getMaxAnisotropy()) : 4;
  const C = { group, mats: {}, chunks: new Chunks(420), cars: [], trees: [], ironQuads: [], fenceQuads: [], ew: [], ns: [] };
  const safe = (name, fn) => { try { fn(); } catch (e) { console.warn('[environment] ' + name, e); } };

  const tex = makeTextures(rng, aniso);
  const fac = makeFacadeTextures(rng, low ? 512 : 1024, aniso);
  makeMaterials(C, tex, fac);
  C.near = { facade: new GB(), plain: new GB(), roof: new GB(), stone: new GB(), yard: new GB(), metal: new GB() };

  // --- sky, lights, fog
  const sky = makeSky();
  group.add(sky);
  const sun = new T.DirectionalLight(0xffffff, 3);
  sun.name = 'env-sun';
  sun.castShadow = true;
  sun.shadow.mapSize.set(low ? 1024 : 2048, low ? 1024 : 2048);
  Object.assign(sun.shadow.camera, { left: -25, right: 25, top: 25, bottom: -25, near: 1, far: 220 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  sun.shadow.radius = 3;
  sun.target.position.set(7, 0, 7);
  group.add(sun, sun.target);
  const hemi = new T.HemisphereLight(0xbcd6f0, 0xb59e82, 0.5);
  hemi.name = 'env-hemisphere';
  group.add(hemi);
  scene.fog = new T.FogExp2(0xc9dcef, 0.00006);

  // --- terrain, water, streets, neighbourhood
  safe('terrain', () => group.add(buildTerrain(C)));
  safe('water', () => group.add(buildWater(C)));
  safe('neighbourhood', () => fillNeighbourhood(C, rng));
  safe('neighbours', () => buildNeighbours(C, rng));
  safe('near-ground', () => buildNearGround(C));
  safe('street-furniture', () => buildStreetFurniture(C, rng));
  // parked cars on Rua Eduardo Couto (keep the lot frontage clear)
  const zParkS = ROW_Z + ROAD_HALF - 1.05, zParkN = ROW_Z - ROAD_HALF + 1.05;
  for (const [x, z, ry, col] of [[-34, zParkS, Math.PI, 0.1], [-27.6, zParkS, Math.PI, 0.35], [26, zParkS, Math.PI, 0.52], [38.5, zParkS, Math.PI, 0.03],
    [-22, zParkN, 0, 0.61], [-40, zParkN, 0, 0.21], [33, zParkN, 0, 0.83]]) C.cars.push({ x, z, ry, col, y: ROAD_UP + TERR_FLAT });
  safe('trees', () => buildTrees(C));
  safe('cars', () => buildCars(C));
  safe('alpha', () => buildAlphaQuads(C));
  safe('far-city', () => buildFarCity(C, rng, low));
  safe('bridges', () => buildBridges(C));
  safe('meshes', () => {
    C.chunks.meshes(C.mats, group, { cast: () => false, receive: true });
    for (const k in C.near) {
      if (C.near[k].empty) continue;
      const m = new T.Mesh(C.near[k].build(), C.mats[k]);
      m.name = `env-near-${k}`;
      m.castShadow = true; m.receiveShadow = true;
      group.add(m);
    }
  });
  // shadow casting only for things near the building
  // (chunked neighbourhood meshes are created with castShadow = false; only the env-near-* meshes, trees and cars cast)

  // two warm point lights at the two street lamps nearest the entrance (dusk only; intensity 0 otherwise)
  const lampLights = [];
  safe('lamp-lights', () => {
    const near = (C.lampPts || []).slice().sort((a, b) => Math.hypot(a[0] - 7, a[2] - 18) - Math.hypot(b[0] - 7, b[2] - 18)).slice(0, 2);
    for (const [x, y, z] of near) {
      const L = new T.PointLight(0xffb46b, 0, 28, 1.6);
      L.position.set(x, y - 0.3, z);
      L.name = 'env-streetlamp-light';
      group.add(L); lampLights.push(L);
    }
  });

  scene.add(group);

  // --- time of day
  const col = (h) => new T.Color(h);
  let current = 'golden';
  let envFactor = 1;
  const applyEnvFactor = () => {
    scene.traverse(o => {
      if (!o.isMesh || !o.material) return;
      const list = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of list) {
        if (m.envMapIntensity === undefined || m.userData.envSkip) continue;
        if (m.userData.envBase === undefined) m.userData.envBase = m.envMapIntensity;
        m.envMapIntensity = m.userData.envBase * envFactor;
      }
    });
  };
  function setTimeOfDay(name) {
    const P = TOD[name] || TOD.golden;
    current = TOD[name] ? name : 'golden';
    const d = sunDirection(P.az, P.alt);
    sun.position.set(7 + d.x * 120, Math.max(d.y, 0.035) * 120, 7 + d.z * 120);
    sun.color.set(P.sun); sun.intensity = P.sunI;
    const U = sky.material.uniforms;
    U.zenith.value.set(P.zenith); U.horizon.value.set(P.horizon); U.horizonAway.value.set(P.away); U.mid.value.set(P.mid); U.ground.value.set(P.fogCol);
    U.glowCol.value.set(P.glow); U.sunCol.value.set(P.sun).multiplyScalar(P.sunDisc); U.sunDir.value.copy(d);
    U.cloudCover.value = P.cloud; U.cloudLit.value.set(P.cloudLit); U.cloudShade.value.set(P.cloudShade); U.stars.value = P.stars;
    hemi.color.set(P.hemiSky); hemi.groundColor.set(P.hemiGround); hemi.intensity = P.hemiI;
    scene.fog.color.set(P.fogCol); scene.fog.density = P.fog;
    scene.background = col(P.fogCol);
    const W = C.mats.water && C.mats.water.uniforms;
    if (W) {
      W.deep.value.set(P.water); W.skyLow.value.set(P.waterSky); W.skyHigh.value.set(P.zenith);
      W.sunCol.value.set(P.sun).multiplyScalar(P.alt > 0 ? 1 : 0.3); W.sunDir.value.copy(d); W.lights.value = P.city;
    }
    const M = C.mats;
    M.facade.emissiveIntensity = P.lamps * 1.4;
    M.city.emissiveIntensity = P.city * 2.2;
    M.lights.opacity = P.city; M.redLights.opacity = P.city;
    M.lampHead.emissiveIntensity = P.lamps * 6;
    M.glow.opacity = P.lamps * 0.6; M.pool.opacity = P.lamps * 0.13;
    M.glassDark.emissiveIntensity = P.lamps * 0.8;
    M.cable.color.set(name === 'dusk' ? '#0b0c10' : '#202224');
    for (const L of lampLights) L.intensity = P.lamps * 22;
    envFactor = P.env;
    applyEnvFactor();
  }

  function geo(lat, lon) {
    const [x, z] = geoXZ(lat, lon);
    return new T.Vector3(x, Math.max(WATER_Y, heightAt(x, z)), z);
  }

  let time = 0, envTimer = 0;
  function update(dt = 0.016, camera) {
    time += Math.min(dt || 0, 0.1);
    if (camera) sky.position.copy(camera.getWorldPosition ? camera.getWorldPosition(new T.Vector3()) : camera.position);
    sky.material.uniforms.time.value = time;
    if (C.mats.water) C.mats.water.uniforms.time.value = time;
    envTimer += dt || 0;
    if (envTimer > 2) { envTimer = 0; if (envFactor !== 1) applyEnvFactor(); } // materials added later (interiors) get the same factor
  }

  setTimeOfDay('golden');

  return {
    group, sun, hemi, setTimeOfDay, geo, update,
    get timeOfDay() { return current; },
    heightAt: (x, z) => groundY(x, z),
    waterY: WATER_Y,
    street: { zKerb: STREET.zKerb, zRoad0: ROW_Z - ROAD_HALF, zRoad1: ROW_Z + ROAD_HALF, zFar: ROW_Z + HALF, pavementY: PAVE_Y, roadY: TERR_FLAT + ROAD_UP }
  };
}
