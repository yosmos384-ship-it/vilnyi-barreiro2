// VILNYI · Barreiro 2 — WALK: first-person walkthrough, HUD, stairs and lift.
// Depends only on data.js and the BUILDING contract API (doors[], lift{...}, floorPickers).
import { FLOORS, CORE, BALCONIES, FOOTPRINT, UNITS } from './data.js';

// ───────────────────────────── constants ─────────────────────────────
const EYE = 1.62;
const RADIUS = 0.25;
const WALK_SPEED = 1.45;          // m/s
const RUN_SPEED = 2.6;
const TURN_SPEED = 1.9;           // rad/s (keys / HUD)
const LOOK_SPEED = 1.0;           // rad/s pitch (look up / down buttons)
const STEP_TOL = 0.45;            // max height change per move step (stairs)
const DOOR_NEAR = 1.4;
const DOOR_FAR = 2.1;
const DOOR_TIME = 0.7;            // s to open / close a leaf
const LIFT_DOOR_TIME = 0.9;
const LIFT_SPEED = 1.0;           // m/s average
const PITCH_MIN = -1.3, PITCH_MAX = 1.15;
const PASSABLE = new Set(['door', 'entry', 'opening', 'glassdoor', 'main', 'elevator']);
const LEAF = new Set(['door', 'entry', 'main']);

const FLOOR_BY_ID = Object.fromEntries(FLOORS.map(f => [f.id, f]));
const ORDER = FLOORS.slice().sort((a, b) => a.level.y - b.level.y).map(f => f.id);
const LEVEL_Y = Object.fromEntries(FLOORS.map(f => [f.id, f.level.y]));
const LEVEL_YS = ORDER.map(id => LEVEL_Y[id]);
const ALIAS = { '-1': 'basement', '0': 'ground', '1': 'first', '2': 'second', b: 'basement', g: 'ground', r: 'ground' };
const normFloor = (id) => (id == null ? null : FLOOR_BY_ID[id] ? id : ALIAS[String(id).toLowerCase()] || null);

// Stair layout (switch-back, two flights per storey) — documented for BUILDING:
//   floor landing  z ∈ [z0, zLand]         full width, at each level y
//   flight 1 (up)  x ∈ [xMid, x1], z zLand → zTurn   (east half, climbing southwards)
//   mid landing    z ∈ [zTurn, z1]         full width, at (y0+y1)/2
//   flight 2 (up)  x ∈ [x0, xMid], z zTurn → zLand   (west half, climbing northwards) arriving at next level
const ST = CORE.stairs;
export const STAIR_LAYOUT = {
  x0: ST.x0, x1: ST.x1, z0: ST.z0, z1: ST.z1,
  xMid: (ST.x0 + ST.x1) / 2, zLand: ST.z0 + 1.15, zTurn: ST.z1 - 1.10
};
const SL = STAIR_LAYOUT;
const STOREYS = ORDER.slice(0, -1).map((id, i) => {
  const y0 = LEVEL_Y[id], y1 = LEVEL_Y[ORDER[i + 1]];
  return { y0, y1, ym: (y0 + y1) / 2 };
});

const LIFT = CORE.lift;
const CAB_C = { x: (LIFT.x0 + LIFT.x1) / 2, z: (LIFT.z0 + LIFT.z1) / 2 };
const LIFT_DOOR_PT = { x: LIFT.doorOnX, z: (LIFT.doorZ[0] + LIFT.doorZ[1]) / 2 };

const T = {
  en: { hint: 'Drag to look · Double-click to walk', hintTouch: 'Drag to look · Double-tap to walk', plan: 'Plan', lift: 'Lift', apartment: 'Apartment', balcony: 'Balcony', terrace: 'Terrace', deck: 'Garden deck', fwd: 'Forward', back: 'Back', left: 'Turn left', right: 'Turn right', lookUp: 'Look up', lookDown: 'Look down', up: 'Up', down: 'Down', floor: 'Floor', close: 'Close plan' },
  pt: { hint: 'Arraste para olhar · Duplo clique para andar', hintTouch: 'Arraste para olhar · Toque duplo para andar', plan: 'Planta', lift: 'Elevador', apartment: 'Apartamento', balcony: 'Varanda', terrace: 'Terraço', deck: 'Deck do jardim', fwd: 'Avançar', back: 'Recuar', left: 'Rodar à esquerda', right: 'Rodar à direita', lookUp: 'Olhar para cima', lookDown: 'Olhar para baixo', up: 'Subir', down: 'Descer', floor: 'Piso', close: 'Fechar planta' },
  he: { hint: 'גררו כדי להסתכל · לחיצה כפולה כדי ללכת', hintTouch: 'גררו כדי להסתכל · הקשה כפולה כדי ללכת', plan: 'תוכנית', lift: 'מעלית', apartment: 'דירה', balcony: 'מרפסת', terrace: 'טרסה', deck: 'דק גינה', fwd: 'קדימה', back: 'אחורה', left: 'פנייה שמאלה', right: 'פנייה ימינה', lookUp: 'הבט למעלה', lookDown: 'הבט למטה', up: 'למעלה', down: 'למטה', floor: 'קומה', close: 'סגירת תוכנית' }
};

// ───────────────────────────── small helpers ─────────────────────────────
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const approach = (v, target, step) => (v < target ? Math.min(target, v + step) : Math.max(target, v - step));
const smooth = (t) => t * t * (3 - 2 * t);
const easeInOut = (u) => 0.5 - 0.5 * Math.cos(Math.PI * clamp(u, 0, 1));
const wrapAngle = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

function pointInPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
function polyCentroid(poly) {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const f = poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
    a += f; cx += (poly[j][0] + poly[i][0]) * f; cz += (poly[j][1] + poly[i][1]) * f;
  }
  if (Math.abs(a) < 1e-9) return { x: poly[0][0], z: poly[0][1] };
  return { x: cx / (3 * a), z: cz / (3 * a) };
}
// Oriented wall rectangle: centre line a→b, half thickness ht.
function makeSeg(a, b, t, extra) {
  const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
  if (L < 1e-4) return null;
  return Object.assign({ ax: a[0], az: a[1], ux: dx / L, uz: dz / L, L, ht: t / 2, cond: null }, extra || {});
}
// Push point p ({x,z}) out of seg rectangle inflated by r. Returns true if moved.
function pushOut(p, s, r) {
  const rx = p.x - s.ax, rz = p.z - s.az;
  let u = rx * s.ux + rz * s.uz;
  let v = -rx * s.uz + rz * s.ux;
  const cu = clamp(u, 0, s.L), cv = clamp(v, -s.ht, s.ht);
  const du = u - cu, dv = v - cv, d = Math.hypot(du, dv);
  if (d >= r) return false;
  if (d < 1e-7) {
    const pen = [s.ht - v, v + s.ht, u, s.L - u];
    const k = pen.indexOf(Math.min(...pen));
    if (k === 0) v = s.ht + r; else if (k === 1) v = -(s.ht + r); else if (k === 2) u = -r; else u = s.L + r;
  } else {
    u = cu + (du / d) * r; v = cv + (dv / d) * r;
  }
  p.x = s.ax + u * s.ux - v * s.uz;
  p.z = s.az + u * s.uz + v * s.ux;
  return true;
}
function segDist(x, z, s) {
  const rx = x - s.ax, rz = z - s.az;
  const u = rx * s.ux + rz * s.uz, v = -rx * s.uz + rz * s.ux;
  return Math.hypot(u - clamp(u, 0, s.L), v - clamp(v, -s.ht, s.ht));
}
function clipEdgeZMax(p, q, zc) {
  if (p[1] <= zc && q[1] <= zc) return [p, q];
  if (p[1] > zc && q[1] > zc) return null;
  const t = (zc - p[1]) / (q[1] - p[1]);
  const m = [p[0] + (q[0] - p[0]) * t, zc];
  return p[1] <= zc ? [p, m] : [m, q];
}

// Stair heights at plan point (all storeys), or null if outside the stair box.
function inStairBox(x, z) { return x >= SL.x0 - 0.3 && x <= SL.x1 && z >= SL.z0 && z <= SL.z1 + 0.3; }
function stairHeights(x, z) {
  if (z <= SL.zLand) return LEVEL_YS;
  if (z >= SL.zTurn) return STOREYS.map(s => s.ym);
  const k = (z - SL.zLand) / (SL.zTurn - SL.zLand);
  if (x >= SL.xMid) return STOREYS.map(s => s.y0 + k * (s.ym - s.y0));
  return STOREYS.map(s => s.y1 + k * (s.ym - s.y1));
}
function nearestFloorId(y) {
  let best = ORDER[0], bd = Infinity;
  for (const id of ORDER) { const d = Math.abs(LEVEL_Y[id] - y); if (d < bd - 1e-6) { bd = d; best = id; } }
  return best;
}
function balconiesOf(floorId) { return BALCONIES.filter(b => b.level === floorId); }

// ───────────────────────────── CSS ─────────────────────────────
const CSS = `
.vw-root.vw-root{pointer-events:none}
.vw-root{position:absolute;inset:0;pointer-events:none;z-index:6;color:#f5f1ea;font-family:inherit;-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;
 --vw-glass:rgba(18,17,16,.62);--vw-glass-hi:rgba(30,28,26,.74);--vw-line:rgba(255,255,255,.16);--vw-line-hi:rgba(255,255,255,.34);--vw-accent:#cdb07a;--vw-inset:18px;--vw-b:44px;touch-action:none;line-height:1.25}
.vw-root[hidden]{display:none!important}
.vw-glass{background:var(--vw-glass);-webkit-backdrop-filter:blur(16px) saturate(135%);backdrop-filter:blur(18px) saturate(140%);border:1px solid var(--vw-line);border-radius:14px;text-shadow:0 1px 1px rgba(0,0,0,.25);box-shadow:0 10px 34px rgba(0,0,0,.22)}
.vw-cap{font-size:10px;letter-spacing:.18em;text-transform:uppercase;font-weight:500;opacity:.66}
.vw-label{position:absolute;inset-block-start:var(--vw-top,var(--vw-inset));inset-inline-start:var(--vw-inset);padding:10px 16px 11px;max-width:min(62vw,340px);transition:opacity .3s}
.vw-room{font-size:15px;font-weight:400;letter-spacing:.01em;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vw-unit{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--vw-accent);margin-top:5px}
.vw-unit:empty{display:none}
.vw-hint{position:absolute;inset-block-end:calc(var(--vw-inset) + 6px);left:50%;transform:translateX(-50%);padding:8px 16px;border-radius:999px;font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;white-space:nowrap;opacity:0;transition:opacity .8s}
.vw-hint.vw-on{opacity:.9}
.vw-pad{position:absolute;inset-block-end:var(--vw-inset);inset-inline-start:var(--vw-inset);pointer-events:none}
.vw-padgrid{display:grid;grid-template-columns:repeat(3,var(--vw-b));grid-template-rows:repeat(3,var(--vw-b));gap:5px;direction:ltr}
.vw-padhub{grid-column:2;grid-row:2;align-self:center;justify-self:center;width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.28);box-shadow:0 0 0 1px rgba(0,0,0,.15)}
.vw-btn{pointer-events:auto;appearance:none;-webkit-appearance:none;margin:0;padding:0;font:inherit;color:inherit;width:44px;height:44px;border-radius:12px;display:grid;place-items:center;cursor:pointer;touch-action:none;outline:none;
 background:var(--vw-glass);-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);border:1px solid var(--vw-line);transition:background .18s,border-color .18s,color .18s,box-shadow .18s}
.vw-btn:hover{border-color:var(--vw-line-hi);background:var(--vw-glass-hi)}
.vw-btn:focus-visible{border-color:var(--vw-accent)}
.vw-btn.vw-down{background:rgba(205,176,122,.26);border-color:var(--vw-accent);color:#fff}
.vw-btn svg{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round}
.vw-pad .vw-fwd{grid-column:2;grid-row:1}.vw-pad .vw-left{grid-column:1;grid-row:2}.vw-pad .vw-back{grid-column:2;grid-row:3}.vw-pad .vw-right{grid-column:3;grid-row:2}
.vw-pad .vw-btn,.vw-look .vw-btn{width:var(--vw-b);height:var(--vw-b)}
.vw-pad .vw-btn svg{width:20px;height:20px;stroke-width:1.5}
.vw-row{display:flex;align-items:flex-end;gap:8px;pointer-events:none}
.vw-look{display:flex;flex-direction:column;gap:5px;pointer-events:none;direction:ltr}
.vw-look .vw-btn svg{width:18px;height:18px}
.vw-mapwrap{position:absolute;inset-block-end:var(--vw-inset);inset-inline-end:var(--vw-inset);display:flex;flex-direction:column;align-items:flex-end;gap:8px;pointer-events:none}
[dir=rtl] .vw-mapwrap,.vw-root[dir=rtl] .vw-mapwrap{align-items:flex-start}
.vw-maptoggle{width:auto;padding:0 14px 0 12px;gap:8px;display:inline-flex;align-items:center;font-size:10px;letter-spacing:.18em;text-transform:uppercase}
.vw-maptoggle[aria-pressed=true]{border-color:var(--vw-accent);color:var(--vw-accent)}
.vw-map{pointer-events:auto;padding:10px;background:rgba(14,13,12,.78);display:none;position:relative}
.vw-map.vw-open{display:block;animation:vw-in .28s ease-out}
.vw-map canvas{display:block;cursor:crosshair;touch-action:none}
.vw-map .vw-cap{position:absolute;inset-block-start:10px;inset-inline-start:12px;pointer-events:none}
.vw-lift{position:absolute;inset-block-start:calc(var(--vw-top,var(--vw-inset)) + 2px);inset-inline-end:var(--vw-inset);width:104px;padding:14px 0 14px;display:flex;flex-direction:column;align-items:center;gap:12px;pointer-events:auto;opacity:0;transform:translateY(-6px);visibility:hidden;transition:opacity .35s,transform .35s,visibility 0s .35s}
.vw-lift.vw-open{opacity:1;transform:none;visibility:visible;transition:opacity .35s,transform .35s,visibility 0s}
.vw-lift-ind{direction:ltr;width:70px;height:48px;border-radius:9px;border:1px solid var(--vw-line);background:rgba(0,0,0,.38);display:flex;align-items:center;justify-content:center;gap:6px;font-variant-numeric:tabular-nums}
.vw-lift-num{font-size:26px;font-weight:300;letter-spacing:.02em;min-width:28px;text-align:center;color:#fff}
.vw-lift-dir{width:12px;height:14px;color:var(--vw-accent);opacity:0;transition:opacity .2s}
.vw-lift-dir svg{width:12px;height:14px;fill:currentColor}
.vw-lift-dir.vw-on{opacity:1;animation:vw-blink 1.1s ease-in-out infinite}
.vw-lift-btns{display:flex;flex-direction:column;gap:9px}
.vw-lbtn{direction:ltr;unicode-bidi:isolate;border-radius:50%;font-size:14px;font-weight:400;letter-spacing:.02em;font-variant-numeric:tabular-nums}
.vw-lbtn.vw-lit{border-color:var(--vw-accent);color:var(--vw-accent);box-shadow:0 0 0 1px rgba(205,176,122,.5) inset,0 0 16px rgba(205,176,122,.35)}
.vw-lbtn.vw-here{background:rgba(255,255,255,.08)}
.vw-lift-ud{direction:ltr;display:flex;gap:8px;padding-top:10px;border-top:1px solid var(--vw-line);width:78px;justify-content:center}
.vw-lift-ud .vw-btn{width:34px;height:34px;border-radius:10px}
.vw-lift-ud svg{width:14px;height:14px}
@keyframes vw-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes vw-blink{0%,100%{opacity:1}50%{opacity:.35}}
@media (pointer:coarse){.vw-root{--vw-b:48px}}
@media (max-width:560px){.vw-root{--vw-inset:12px}.vw-maptoggle span{display:none}.vw-maptoggle{width:var(--vw-b);padding:0;justify-content:center}.vw-label{max-width:56vw}.vw-lift{width:84px;padding:10px 0;gap:9px}.vw-lift-ind{width:58px;height:40px}.vw-lift-num{font-size:22px}.vw-lift-btns{gap:6px}.vw-lbtn{width:38px;height:38px;font-size:13px}.vw-lift-ud{width:66px;padding-top:8px}.vw-lift-ud .vw-btn{width:30px;height:30px}.vw-hint{inset-block-end:calc(var(--vw-inset) + 3 * var(--vw-b) + 26px);white-space:normal;text-align:center;width:max-content;max-width:78vw;line-height:1.5}}
@media (prefers-reduced-motion:reduce){.vw-root *{transition:none!important;animation:none!important}}
`;
const ICON = {
  up: '<svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
  left: '<svg viewBox="0 0 24 24"><path d="M5.2 10A7.5 7.5 0 1 1 7 17.3"/><path d="M4.5 4.5v5.8h5.8"/></svg>',
  right: '<svg viewBox="0 0 24 24"><path d="M18.8 10A7.5 7.5 0 1 0 17 17.3"/><path d="M19.5 4.5v5.8h-5.8"/></svg>',
  plan: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="1"/><path d="M10 4.5v7h10.5M10 15v4.5"/></svg>',
  aup: '<svg viewBox="0 0 24 24"><path d="M12 19.5V5M6 11l6-6 6 6"/></svg>',
  adown: '<svg viewBox="0 0 24 24"><path d="M12 4.5V19M6 13l6 6 6-6"/></svg>',
  aleft: '<svg viewBox="0 0 24 24"><path d="M19.5 12H5M11 6l-6 6 6 6"/></svg>',
  aright: '<svg viewBox="0 0 24 24"><path d="M4.5 12H19M13 6l6 6-6 6"/></svg>',
  lookup: '<svg viewBox="0 0 24 24"><path d="M5 4.5h14"/><path d="M12 20V9M7 14l5-5 5 5"/></svg>',
  lookdown: '<svg viewBox="0 0 24 24"><path d="M5 19.5h14"/><path d="M12 4v11M7 10l5 5 5-5"/></svg>',
  tri: '<svg viewBox="0 0 12 14"><path d="M6 1l5 6H1z"/><path d="M6 13l5-6H1z" opacity="0"/></svg>'
};

function injectCSS() {
  if (typeof document === 'undefined' || document.getElementById('vw-style')) return;
  const s = document.createElement('style');
  s.id = 'vw-style';
  s.textContent = CSS;
  document.head.appendChild(s);
}

// ───────────────────────────── main ─────────────────────────────
export function createWalker(THREE, { camera, dom, scene, building, overlay } = {}) {
  const lift = building && building.lift ? building.lift : null;
  if (building && building.stairLayout && typeof building.stairLayout === 'object') {
    for (const k of Object.keys(SL)) if (Number.isFinite(building.stairLayout[k])) SL[k] = building.stairLayout[k];
  }
  const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  let langOverride = null;
  const lang = () => {
    const l = (langOverride || (typeof document !== 'undefined' && document.documentElement.lang) || 'en').slice(0, 2).toLowerCase();
    return T[l] ? l : 'en';
  };
  const tr = (k) => T[lang()][k] || T.en[k];

  // ── state ──
  const pos = { x: 6.1, z: 12 };
  let feetY = 0, eyeY = EYE, floorId = 'ground';
  let yaw = 0, pitch = 0, yawVel = 0, pitchVel = 0;
  const vel = { x: 0, z: 0 };
  let enabled = false, placed = false, clock = 0;
  let auto = null;                 // auto-walk target {x,z,stuck}
  const keys = new Set();
  const hudIn = { fwd: false, back: false, left: false, right: false, lup: false, ldown: false };
  let wheelImpulse = 0;
  const listeners = [];
  let lastState = null;
  let hintTimer = 0;

  // ── doors ──
  const doorRecs = [];
  for (const d of (building && building.doors) || []) {
    if (!d || !LEAF.has(d.kind) || typeof d.setOpen !== 'function') continue;
    const interior = d.kind === 'door';
    doorRecs.push({ d, t: interior ? 1 : 0, target: interior ? 1 : 0, interior, cx: d.center ? d.center.x : 0, cz: d.center ? d.center.z : 0 });
  }
  function findDoor(fid, x, z) {
    let best = null, bd = 0.8;
    for (const r of doorRecs) {
      if (r.d.floorId !== fid) continue;
      const dd = Math.hypot(r.cx - x, r.cz - z);
      if (dd < bd) { bd = dd; best = r; }
    }
    return best;
  }

  // ── lift state ──
  const LIFT_Y = Object.assign({}, LEVEL_Y, (lift && lift.levels) || {});
  let cabY = LIFT_Y.ground, cabLevel = 'ground', liftDoor = 0, appliedLiftDoor = -1, liftInit = false;
  const jobs = [];
  let job = null;
  let rideSway = 0;

  // ── collision segments per floor ──
  const segCache = new Map();
  function segsFor(fid) {
    if (segCache.has(fid)) return segCache.get(fid);
    const f = FLOOR_BY_ID[fid];
    const segs = [];
    const add = (s) => { if (s) segs.push(s); };
    for (const w of f.walls) {
      const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
      if (L < 1e-4) continue;
      const ux = (w.b[0] - w.a[0]) / L, uz = (w.b[1] - w.a[1]) / L;
      const P = (s) => [w.a[0] + ux * s, w.a[1] + uz * s];
      const ops = (w.openings || []).filter(o => PASSABLE.has(o.type)).sort((a, b) => a.from - b.from);
      let cur = 0;
      for (const o of ops) {
        if (o.from > cur) add(makeSeg(P(cur), P(o.from), w.t));
        if (o.type === 'elevator') {
          add(makeSeg(P(o.from), P(o.to), w.t, { y0: 2.1, cond: () => !(cabLevel === fid && !job?.moving && liftDoor > 0.7) }));
        } else if (LEAF.has(o.type)) {
          const m = P((o.from + o.to) / 2);
          const rec = findDoor(fid, m[0], m[1]);
          if (rec) add(makeSeg(P(o.from), P(o.to), w.t, { y0: o.type === 'main' ? 2.4 : 2.1, cond: () => rec.t < 0.5 }));
        }
        cur = Math.max(cur, o.to);
      }
      if (cur < L) add(makeSeg(P(cur), P(L), w.t));
    }
    // lift shaft sides (N/S) — solid on every level
    add(makeSeg([LIFT.x0 - 0.3, LIFT.z0], [LIFT.x1, LIFT.z0], 0.1));
    add(makeSeg([LIFT.x0 - 0.3, LIFT.z1], [LIFT.x1, LIFT.z1], 0.1));
    // stairs: central balustrade between the flights, back wall behind the half landing
    add(makeSeg([SL.xMid, SL.zLand], [SL.xMid, SL.zTurn], 0.08, { y0: -3.2, y1: 4.0 }));
    add(makeSeg([SL.x0 - 0.3, SL.z1 + 0.04], [SL.x1, SL.z1 + 0.04], 0.08));
    // balcony balustrades (all edges except the building side)
    const onFacade = (p, q) => (Math.abs(p[1]) < 0.02 && Math.abs(q[1]) < 0.02) || (Math.abs(p[1] - 14.7) < 0.02 && Math.abs(q[1] - 14.7) < 0.02);
    for (const b of balconiesOf(fid)) {
      if (b.deck) continue;
      const poly = b.poly;
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i], q = poly[(i + 1) % poly.length];
        if (!onFacade(p, q)) add(makeSeg(p, q, 0.06, { y1: 1.05 }));
      }
      if (b.split != null) {
        const zs = poly.map(p => p[1]);
        add(makeSeg([b.split, Math.min(...zs)], [b.split, Math.max(...zs)], 0.06, { y1: 1.6 }));
      }
    }
    // gardens (ground): boundary walls & fence, clipped to the garden side of the rear façade
    for (const r of f.rooms) {
      if (r.use !== 'garden') continue;
      for (let i = 0; i < r.poly.length; i++) {
        const c = clipEdgeZMax(r.poly[i], r.poly[(i + 1) % r.poly.length], -0.02);
        if (!c) continue;
        if (c[0][1] > -0.3 && c[1][1] > -0.3) continue;
        add(makeSeg(c[0], c[1], 0.1, { y1: 1.8 }));
      }
    }
    segCache.set(fid, segs);
    return segs;
  }
  function resolve(p, fid) {
    const segs = segsFor(fid);
    for (let it = 0; it < 4; it++) {
      let moved = false;
      for (const s of segs) {
        if (s.cond && !s.cond()) continue;
        if (pushOut(p, s, RADIUS)) moved = true;
      }
      if (!moved) break;
    }
    return p;
  }
  function clearance(x, z, fid) {
    let m = Infinity;
    for (const s of segsFor(fid)) m = Math.min(m, segDist(x, z, s));
    return m;
  }
  function inRegion(x, z, fid) {
    if (fid === 'basement') return true;
    if (pointInPoly(x, z, FOOTPRINT)) return true;
    for (const b of balconiesOf(fid)) if (pointInPoly(x, z, b.poly)) return true;
    if (fid === 'ground') for (const r of FLOOR_BY_ID.ground.rooms) if (r.use === 'garden' && pointInPoly(x, z, r.poly)) return true;
    return false;
  }
  function surfaceAt(x, z, ref) {
    const cands = inStairBox(x, z) ? stairHeights(x, z) : LEVEL_YS;
    let best = null, bd = Infinity;
    for (const c of cands) { const d = Math.abs(c - ref); if (d < bd) { bd = d; best = c; } }
    return bd <= STEP_TOL ? best : null;
  }
  const inCabArea = (x, z) => x < LIFT.x1 - 0.02 && x > LIFT.x0 - 0.3 && z > LIFT.z0 && z < LIFT.z1;
  const playerInCab = () => inCabArea(pos.x, pos.z);

  function tryStep(nx, nz) {
    const p = resolve({ x: nx, z: nz }, floorId);
    const h = surfaceAt(p.x, p.z, feetY);
    if (h === null) return false;
    const nf = nearestFloorId(h);
    if (!inRegion(p.x, p.z, nf)) return false;
    // never enter the shaft unless the cab is here with open doors
    if (inCabArea(p.x, p.z) && !inCabArea(pos.x, pos.z) && !(cabLevel === nf && liftDoor > 0.7)) return false;
    pos.x = p.x; pos.z = p.z; feetY = h; floorId = nf;
    return true;
  }
  function moveBy(dx, dz) {
    const len = Math.hypot(dx, dz);
    if (len < 1e-7) return 0;
    const n = Math.max(1, Math.ceil(len / 0.06));
    const sx = dx / n, sz = dz / n;
    let moved = 0;
    for (let i = 0; i < n; i++) {
      const ox = pos.x, oz = pos.z;
      if (!tryStep(pos.x + sx, pos.z + sz)) {
        if (!(Math.abs(sx) > 1e-6 && tryStep(pos.x + sx, pos.z)) && !(Math.abs(sz) > 1e-6 && tryStep(pos.x, pos.z + sz))) break;
      }
      moved += Math.hypot(pos.x - ox, pos.z - oz);
    }
    return moved;
  }

  // ── placement ──
  function lookDir(dx, dy, dz) {
    const h = Math.hypot(dx, dz);
    if (h > 1e-5) yaw = Math.atan2(-dx, -dz);
    pitch = clamp(Math.atan2(dy, Math.max(h, 1e-5)), PITCH_MIN, PITCH_MAX);
  }
  function stopMotion() {
    vel.x = vel.z = 0; yawVel = pitchVel = 0; auto = null; hideRing();
  }
  function cancelLift() {
    const all = (job ? [job] : []).concat(jobs.splice(0));
    if (job) { cabY = LIFT_Y[job.to]; cabLevel = job.to; }
    job = null;
    for (const j of all) try { j.resolve(false); } catch (e) { /* ignore */ }
    litButtons();
  }
  function placeAt(x, z, fid) {
    floorId = fid; feetY = LEVEL_Y[fid];
    const h = surfaceAt(x, z, feetY);
    if (h !== null) { feetY = h; floorId = nearestFloorId(h); }
    const p = resolve({ x, z }, floorId);
    pos.x = p.x; pos.z = p.z;
    eyeY = feetY + EYE;
    placed = true;
    stopMotion();
    if (inCabArea(pos.x, pos.z)) {
      if (job) cancelLift();
      setCab(LIFT_Y[floorId], floorId); liftDoor = 1; applyLiftDoors(true);
    }
  }
  function teleport(position, lookAt) {
    if (!position) return;
    if (job && job.carry) cancelLift();
    const guess = nearestFloorId((position.y ?? EYE) - 1.0);
    placeAt(position.x, position.z, guess);
    if (lookAt) lookDir(lookAt.x - pos.x, lookAt.y - eyeY, lookAt.z - pos.z);
    applyCamera();
    emitState(true);
  }
  function bestPoint(poly, fid) {
    const xs = poly.map(p => p[0]), zs = poly.map(p => p[1]);
    const c = polyCentroid(poly);
    let best = { x: c.x, z: c.z }, bs = -Infinity;
    const step = 0.1;
    for (let x = Math.min(...xs) + 0.05; x < Math.max(...xs); x += step) {
      for (let z = Math.min(...zs) + 0.05; z < Math.max(...zs); z += step) {
        if (!pointInPoly(x, z, poly)) continue;
        const cl = Math.min(clearance(x, z, fid), 0.85);
        const score = cl - 0.06 * Math.hypot(x - c.x, z - c.z);
        if (score > bs) { bs = score; best = { x, z }; }
      }
    }
    return best;
  }
  function freeDistance(x, z, ang, fid, max = 12) {
    const dx = -Math.sin(ang), dz = -Math.cos(ang);
    for (let d = 0.2; d < max; d += 0.1) {
      const px = x + dx * d, pz = z + dz * d;
      if (clearance(px, pz, fid) < 0.05 || !inRegion(px, pz, fid)) return d;
    }
    return max;
  }
  function goToUnit(unitId, roomId) {
    const u = UNITS.find(v => v.id === unitId);
    if (!u) return false;
    const f = FLOOR_BY_ID[u.floor];
    const rid = roomId || u.startRoom;
    const room = f.rooms.find(r => r.id === rid) || f.rooms.find(r => r.id === u.startRoom);
    const bal = !room ? BALCONIES.find(b => b.id === rid) : null;
    const poly = room ? room.poly : bal ? bal.poly : null;
    if (!poly) return false;
    if (job && job.carry) cancelLift();
    const p = bestPoint(poly, f.id);
    placeAt(p.x, p.z, f.id);
    const view = f.rooms.find(r => r.id === u.viewRoom);
    if (room && view && room.id !== view.id && room.id === u.startRoom) {
      const q = bestPoint(view.poly, f.id);
      lookDir(q.x - pos.x, -0.08, q.z - pos.z);
    } else {
      let ba = 0, bd = -1;
      for (let i = 0; i < 32; i++) {
        const a = (i / 32) * Math.PI * 2;
        const d = freeDistance(pos.x, pos.z, a, f.id);
        if (d > bd + 0.05) { bd = d; ba = a; }
      }
      yaw = ba; pitch = -0.06;
    }
    applyCamera();
    emitState(true);
    return true;
  }
  function goToLift(fidIn) {
    const fid = normFloor(fidIn) || floorId;
    if (job) cancelLift();
    floorId = fid;
    placeAt(CAB_C.x - 0.12, CAB_C.z, fid);
    yaw = -Math.PI / 2; pitch = -0.04;   // facing the doors (+x)
    applyCamera();
    emitState(true);
  }

  // ── lift mechanics ──
  function setCab(y, level) {
    cabY = y; cabLevel = level;
    try { lift && lift.setCabY && lift.setCabY(y); } catch (e) { /* guard */ }
  }
  function applyLiftDoors(force) {
    if (!lift) return;
    if (!force && Math.abs(appliedLiftDoor - liftDoor) < 1e-4) return;
    appliedLiftDoor = liftDoor;
    const e = smooth(liftDoor);
    try { lift.setCabDoors && lift.setCabDoors(e); } catch (err) { /* guard */ }
    for (const id of ORDER) {
      try { lift.setLandingDoors && lift.setLandingDoors(id, id === cabLevel ? e : 0); } catch (err) { /* guard */ }
    }
  }
  function panelButtons() {
    const out = [];
    if (lift && lift.panel) lift.panel.traverse(o => { if (o.userData && o.userData.liftButton != null) out.push(o); });
    return out;
  }
  function litButtons() {
    const lit = new Set(jobs.map(j => j.to));
    if (job) lit.add(job.to);
    for (const b of panelButtons()) {
      const on = lit.has(normFloor(b.userData.liftButton));
      if (b.userData.__vwLit !== on) { b.userData.__vwLit = on; try { b.userData.setLit && b.userData.setLit(on); } catch (e) { /* guard */ } }
    }
    hud.liftBtns.forEach((el, id) => el.classList.toggle('vw-lit', lit.has(id)));
  }
  function enqueue(to, carry) {
    return new Promise((resolveP) => {
      jobs.push({ to, carryReq: carry, resolve: resolveP });
      litButtons();
    });
  }
  function ride(fidIn) {
    const to = normFloor(fidIn);
    if (!to) return Promise.resolve(false);
    if (!playerInCab() || (job && !job.carry)) {
      if (job) cancelLift();
      goToLift(floorId);
    }
    const last = jobs.length ? jobs[jobs.length - 1].to : job ? job.to : cabLevel;
    if (last === to && !job && cabLevel === to) { liftDoor = Math.max(liftDoor, 0.01); return Promise.resolve(true); }
    chime('press');
    return enqueue(to, true);
  }
  function stepLift(dt) {
    if (!job && jobs.length) {
      job = jobs.shift();
      job.phase = cabLevel === job.to ? 'opening' : 'closing';
      job.carry = false;
      litButtons();
    }
    if (job) {
      if (job.phase === 'closing') {
        if (playerInCab()) { // step back from the door line so the doors can close
          auto = null;
          pos.x = approach(pos.x, Math.min(pos.x, CAB_C.x + 0.12), dt * 1.2);
          pos.z = approach(pos.z, CAB_C.z, dt * 0.8);
        }
        liftDoor = approach(liftDoor, 0, dt / LIFT_DOOR_TIME);
        if (liftDoor <= 0) {
          job.phase = 'moving'; job.moving = true;
          job.carry = playerInCab() && Math.abs(feetY - cabY) < 0.5;
          job.fromY = cabY; job.toY = LIFT_Y[job.to];
          job.dur = Math.max(1.6, Math.abs(job.toY - job.fromY) / LIFT_SPEED);
          job.t = 0; job.fromLevel = cabLevel; cabLevel = null;
          if (job.carry) { auto = null; vel.x = vel.z = 0; }
        }
      } else if (job.phase === 'moving') {
        job.t += dt;
        const u = clamp(job.t / job.dur, 0, 1);
        const y = job.fromY + (job.toY - job.fromY) * easeInOut(u);
        setCab(y, null);
        if (job.carry) {
          feetY = y; floorId = nearestFloorId(y);
          rideSway = reduceMotion ? 0 : Math.sin(Math.PI * u) * (0.006 * Math.sin(job.t * 7.3) + 0.003 * Math.sin(job.t * 13.1 + 1.3));
        }
        if (u >= 1) {
          setCab(job.toY, job.to);
          if (job.carry) { feetY = job.toY; floorId = job.to; eyeY = feetY + EYE; rideSway = 0; chime('arrive'); }
          job.moving = false; job.phase = 'opening';
        }
      } else if (job.phase === 'opening') {
        liftDoor = approach(liftDoor, 1, dt / LIFT_DOOR_TIME);
        if (liftDoor >= 1) {
          const j = job; job = null;
          litButtons();
          try { j.resolve(true); } catch (e) { /* guard */ }
        }
      }
    } else {
      // idle: open for the walker when he is in the cab or near the landing door; call the cab if needed
      const inCab = playerInCab();
      const near = Math.hypot(pos.x - LIFT_DOOR_PT.x, pos.z - LIFT_DOOR_PT.z) < 1.5 && Math.abs(feetY - LEVEL_Y[floorId]) < 0.3;
      if (inCab || near) {
        if (cabLevel === floorId) liftDoor = approach(liftDoor, 1, dt / LIFT_DOOR_TIME);
        else enqueue(floorId, false);
      } else liftDoor = approach(liftDoor, 0, dt / LIFT_DOOR_TIME);
    }
    applyLiftDoors(false);
  }

  // ── audio ──
  let audio = null;
  function unlockAudio() {
    try {
      if (!audio) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        audio = new AC();
      }
      if (audio.state === 'suspended') audio.resume();
    } catch (e) { audio = null; }
  }
  function chime(kind) {
    if (!audio || audio.state !== 'running') return;
    try {
      const now = audio.currentTime;
      const master = audio.createGain();
      master.gain.value = 0.9;
      const lp = audio.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 3800;
      master.connect(lp); lp.connect(audio.destination);
      const notes = kind === 'arrive' ? [[1318.5, 0], [1046.5, 0.24]] : [[1174.7, 0]];
      const vol = kind === 'arrive' ? 0.055 : 0.035;
      for (const [f, t0] of notes) {
        for (const [mult, g] of [[1, vol], [2.01, vol * 0.22], [3.0, vol * 0.06]]) {
          const o = audio.createOscillator(), gn = audio.createGain();
          o.type = 'sine'; o.frequency.value = f * mult;
          gn.gain.setValueAtTime(0.0001, now + t0);
          gn.gain.exponentialRampToValueAtTime(g, now + t0 + 0.012);
          gn.gain.exponentialRampToValueAtTime(0.0001, now + t0 + 1.4);
          o.connect(gn); gn.connect(master);
          o.start(now + t0); o.stop(now + t0 + 1.5);
        }
      }
    } catch (e) { /* ignore */ }
  }

  // ── HUD ──
  injectCSS();
  const hud = buildHud();
  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function buildHud() {
    const h = { liftBtns: new Map() };
    if (typeof document === 'undefined') return h;
    const root = el('div', 'vw-root');
    root.style.pointerEvents = 'none';
    root.hidden = true;
    root.setAttribute('data-vw', '');
    h.root = root;
    // label
    const label = el('div', 'vw-label vw-glass');
    h.floor = el('div', 'vw-cap'); h.room = el('div', 'vw-room'); h.unit = el('div', 'vw-unit');
    h.room.dir = 'auto';
    label.append(h.floor, h.room, h.unit);
    // hint
    h.hint = el('div', 'vw-hint vw-glass');
    // pad
    const pad = el('div', 'vw-pad');
    const padGrid = el('div', 'vw-padgrid');
    pad.append(padGrid);
    const mk = (cls, icon, key) => {
      const b = el('button', 'vw-btn ' + cls, ICON[icon]);
      b.type = 'button';
      b.dataset.k = key;
      const down = (e) => { e.preventDefault(); unlockAudio(); hudIn[key] = true; b.classList.add('vw-down'); try { b.setPointerCapture(e.pointerId); } catch (er) { /* */ } };
      const up = () => { hudIn[key] = false; b.classList.remove('vw-down'); };
      b.addEventListener('pointerdown', down);
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
      b.addEventListener('lostpointercapture', up);
      b.addEventListener('contextmenu', (e) => e.preventDefault());
      return b;
    };
    h.pad = { fwd: mk('vw-fwd', 'aup', 'fwd'), left: mk('vw-left', 'aleft', 'left'), back: mk('vw-back', 'adown', 'back'), right: mk('vw-right', 'aright', 'right'),
      lup: mk('vw-lup', 'lookup', 'lup'), ldown: mk('vw-ldown', 'lookdown', 'ldown') };
    padGrid.append(h.pad.fwd, h.pad.left, el('span', 'vw-padhub'), h.pad.right, h.pad.back);
    const look = el('div', 'vw-look');
    look.append(h.pad.lup, h.pad.ldown);
    // map
    const mapWrap = el('div', 'vw-mapwrap');
    h.mapPanel = el('div', 'vw-map vw-glass');
    h.mapCap = el('div', 'vw-cap');
    h.canvas = el('canvas');
    h.mapPanel.append(h.canvas, h.mapCap);
    h.mapBtn = el('button', 'vw-btn vw-maptoggle');
    h.mapBtn.type = 'button';
    h.mapBtn.setAttribute('aria-pressed', 'false');
    h.mapBtn.addEventListener('click', () => { unlockAudio(); setMapOpen(!mapOpen); });
    h.canvas.addEventListener('pointerdown', onMapPointer);
    const row = el('div', 'vw-row');
    row.append(h.mapBtn, look);
    mapWrap.append(h.mapPanel, row);
    // lift panel
    const lp = el('div', 'vw-lift vw-glass');
    lp.setAttribute('role', 'group');
    h.liftHead = el('div', 'vw-cap');
    const ind = el('div', 'vw-lift-ind');
    h.liftDir = el('span', 'vw-lift-dir', ICON.tri);
    h.liftNum = el('span', 'vw-lift-num', '0');
    ind.append(h.liftDir, h.liftNum);
    const btns = el('div', 'vw-lift-btns');
    for (const id of ORDER.slice().reverse()) {
      const f = FLOOR_BY_ID[id];
      const b = el('button', 'vw-btn vw-lbtn', String(f.level.label).replace('-', '−'));
      b.type = 'button';
      b.addEventListener('click', (e) => { e.stopPropagation(); unlockAudio(); ride(id); });
      h.liftBtns.set(id, b);
      btns.append(b);
    }
    const ud = el('div', 'vw-lift-ud');
    h.liftUp = el('button', 'vw-btn', ICON.up); h.liftUp.type = 'button';
    h.liftDown = el('button', 'vw-btn', ICON.down); h.liftDown.type = 'button';
    h.liftUp.addEventListener('click', () => { unlockAudio(); stepFloor(1); });
    h.liftDown.addEventListener('click', () => { unlockAudio(); stepFloor(-1); });
    ud.append(h.liftUp, h.liftDown);
    lp.append(h.liftHead, ind, btns, ud);
    h.lift = lp;
    root.append(label, h.hint, pad, mapWrap, lp);
    root.addEventListener('pointerdown', unlockAudio, { passive: true });
    root.addEventListener('dblclick', (e) => e.preventDefault());
    root.addEventListener('gesturestart', (e) => e.preventDefault());
    root.addEventListener('wheel', (e) => { if (e.target.closest && e.target.closest('.vw-btn,.vw-map')) e.preventDefault(); }, { passive: false });
    if (overlay) overlay.appendChild(root);
    return h;
  }
  function refreshHudText() {
    if (!hud.root) return;
    const l = lang();
    hud.root.setAttribute('lang', l);
    hud.hint.textContent = coarse ? tr('hintTouch') : tr('hint');
    hud.mapBtn.innerHTML = ICON.plan + '<span>' + tr('plan') + '</span>';
    hud.pad.fwd.setAttribute('aria-label', tr('fwd'));
    hud.pad.back.setAttribute('aria-label', tr('back'));
    hud.pad.left.setAttribute('aria-label', tr('left'));
    hud.pad.right.setAttribute('aria-label', tr('right'));
    hud.pad.lup.setAttribute('aria-label', tr('lookUp'));
    hud.pad.ldown.setAttribute('aria-label', tr('lookDown'));
    for (const k in hud.pad) hud.pad[k].title = hud.pad[k].getAttribute('aria-label');
    hud.mapBtn.setAttribute('aria-label', tr('plan'));
    hud.liftHead.textContent = tr('lift');
    hud.lift.setAttribute('aria-label', tr('lift'));
    hud.liftUp.setAttribute('aria-label', tr('up'));
    hud.liftDown.setAttribute('aria-label', tr('down'));
    hud.liftBtns.forEach((b, id) => b.setAttribute('aria-label', tr('floor') + ' ' + FLOOR_BY_ID[id].level.label));
    lastLabelKey = '';
  }
  function stepFloor(dir) {
    const base = jobs.length ? jobs[jobs.length - 1].to : job ? job.to : (cabLevel || floorId);
    const i = ORDER.indexOf(base) + dir;
    if (i >= 0 && i < ORDER.length) ride(ORDER[i]);
  }
  let lastLabelKey = '';
  function updateLabel(st) {
    if (!hud.root) return;
    const l = lang();
    const key = [l, st.floorId, st.roomId, st.unitId, st.inLift].join('|');
    if (key === lastLabelKey) return;
    lastLabelKey = key;
    const f = FLOOR_BY_ID[st.floorId];
    hud.floor.textContent = (f.label[l] || f.label.en) + ' · ' + f.level.label;
    let name = '';
    if (st.inLift) name = tr('lift');
    else if (st.room) name = st.room.name ? (st.room.name[l] || st.room.name.en) : '';
    hud.room.textContent = name || ' ';
    hud.unit.textContent = st.unitId ? tr('apartment') + ' ' + st.unitId : '';
    hud.mapCap.textContent = (f.label[l] || f.label.en);
  }
  function updateLiftPanel() {
    if (!hud.root) return;
    const show = playerInCab() && (!job || job.carry || !job.moving);
    hud.lift.classList.toggle('vw-open', !!show);
    const y = job && job.moving ? cabY : LIFT_Y[cabLevel || floorId];
    const nf = nearestFloorId(y);
    const txt = String(FLOOR_BY_ID[nf].level.label).replace('-', '−');
    if (hud.liftNum.textContent !== txt) hud.liftNum.textContent = txt;
    const moving = job && job.moving;
    hud.liftDir.classList.toggle('vw-on', !!moving);
    hud.liftDir.style.transform = moving && job.toY < job.fromY ? 'rotate(180deg)' : '';
    hud.liftBtns.forEach((b, id) => b.classList.toggle('vw-here', !moving && id === cabLevel));
  }

  // ── mini-map ──
  let mapOpen = false, mapStatic = null, mapKey = '', mapXf = null, mapDirtyPose = '';
  function setMapOpen(v) {
    mapOpen = !!v;
    if (!hud.root) return;
    hud.mapPanel.classList.toggle('vw-open', mapOpen);
    hud.mapBtn.setAttribute('aria-pressed', String(mapOpen));
    mapKey = ''; mapDirtyPose = '';
  }
  function mapBounds(fid) {
    const f = FLOOR_BY_ID[fid];
    const pts = [];
    for (const w of f.walls) pts.push(w.a, w.b);
    for (const b of balconiesOf(fid)) pts.push(...b.poly);
    for (const r of f.rooms) if (r.use !== 'ramp') pts.push(...r.poly);
    const xs = pts.map(p => p[0]), zs = pts.map(p => p[1]);
    return { x0: Math.min(...xs) - 0.5, x1: Math.max(...xs) + 0.5, z0: Math.min(...zs) - 0.5, z1: Math.max(...zs) + 0.5 };
  }
  function buildMapStatic(fid, unitId) {
    const bb = mapBounds(fid);
    const W = bb.x1 - bb.x0, H = bb.z1 - bb.z0;
    const maxW = 220, maxH = 230;
    const s = Math.min(maxW / W, maxH / H);
    const cw = Math.round(W * s), ch = Math.round(H * s) + 18;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const xf = { s, ox: -bb.x0 * s, oz: -bb.z0 * s + 18, cw, ch, dpr };
    const cv = document.createElement('canvas');
    cv.width = cw * dpr; cv.height = ch * dpr;
    const g = cv.getContext('2d');
    g.scale(dpr, dpr);
    const X = (x) => xf.ox + x * s, Z = (z) => xf.oz + z * s;
    const path = (poly) => { g.beginPath(); poly.forEach((p, i) => (i ? g.lineTo(X(p[0]), Z(p[1])) : g.moveTo(X(p[0]), Z(p[1])))); g.closePath(); };
    const f = FLOOR_BY_ID[fid];
    for (const r of f.rooms) {
      if (r.use === 'ramp') continue;
      path(r.poly);
      g.fillStyle = r.use === 'garden' ? 'rgba(140,170,120,.13)' : unitId && r.unit === unitId ? 'rgba(205,176,122,.17)' : 'rgba(255,255,255,.035)';
      g.fill();
    }
    for (const b of balconiesOf(fid)) {
      path(b.poly);
      const mine = unitId && (b.unit || []).includes(unitId);
      g.fillStyle = mine ? 'rgba(205,176,122,.12)' : 'rgba(255,255,255,.05)';
      g.fill();
      if (!b.deck) { g.setLineDash([2, 2]); g.strokeStyle = 'rgba(255,255,255,.45)'; g.lineWidth = 1; g.stroke(); g.setLineDash([]); }
    }
    // stairs treads
    g.strokeStyle = 'rgba(255,255,255,.22)'; g.lineWidth = 0.75;
    for (let z = SL.zLand; z <= SL.zTurn + 1e-6; z += (SL.zTurn - SL.zLand) / 8) {
      g.beginPath(); g.moveTo(X(SL.x0), Z(z)); g.lineTo(X(SL.x1), Z(z)); g.stroke();
    }
    g.beginPath(); g.moveTo(X(SL.xMid), Z(SL.zLand)); g.lineTo(X(SL.xMid), Z(SL.zTurn)); g.stroke();
    // lift
    g.strokeStyle = 'rgba(255,255,255,.28)';
    g.strokeRect(X(LIFT.x0 + 0.1), Z(LIFT.z0 + 0.15), (LIFT.x1 - LIFT.x0 - 0.2) * s, (LIFT.z1 - LIFT.z0 - 0.3) * s);
    g.beginPath(); g.moveTo(X(LIFT.x0 + 0.1), Z(LIFT.z0 + 0.15)); g.lineTo(X(LIFT.x1 - 0.1), Z(LIFT.z1 - 0.15));
    g.moveTo(X(LIFT.x1 - 0.1), Z(LIFT.z0 + 0.15)); g.lineTo(X(LIFT.x0 + 0.1), Z(LIFT.z1 - 0.15)); g.stroke();
    // walls
    g.lineCap = 'butt';
    for (const w of f.walls) {
      const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
      const ux = (w.b[0] - w.a[0]) / L, uz = (w.b[1] - w.a[1]) / L;
      const P = (d) => [w.a[0] + ux * d, w.a[1] + uz * d];
      const ops = (w.openings || []).slice().sort((a, b) => a.from - b.from);
      let cur = 0;
      const solid = (d0, d1) => {
        if (d1 - d0 < 1e-3) return;
        const p = P(d0), q = P(d1);
        g.strokeStyle = 'rgba(246,241,232,.92)'; g.lineWidth = Math.max(1.4, w.t * s);
        g.beginPath(); g.moveTo(X(p[0]), Z(p[1])); g.lineTo(X(q[0]), Z(q[1])); g.stroke();
      };
      for (const o of ops) {
        solid(cur, o.from);
        if (['window', 'glassdoor', 'slit', 'main'].includes(o.type)) {
          const p = P(o.from), q = P(o.to);
          g.strokeStyle = 'rgba(160,200,225,.85)'; g.lineWidth = 1;
          g.beginPath(); g.moveTo(X(p[0]), Z(p[1])); g.lineTo(X(q[0]), Z(q[1])); g.stroke();
        } else if (o.type === 'garage') {
          const p = P(o.from), q = P(o.to);
          g.strokeStyle = 'rgba(255,255,255,.4)'; g.lineWidth = 1; g.setLineDash([3, 2]);
          g.beginPath(); g.moveTo(X(p[0]), Z(p[1])); g.lineTo(X(q[0]), Z(q[1])); g.stroke(); g.setLineDash([]);
        }
        cur = Math.max(cur, o.to);
      }
      solid(cur, L);
    }
    // north mark
    g.fillStyle = 'rgba(255,255,255,.55)'; g.font = '600 9px system-ui, sans-serif'; g.textAlign = 'center';
    const nx = cw - 12;
    g.beginPath(); g.moveTo(nx, 4); g.lineTo(nx + 3.5, 11); g.lineTo(nx - 3.5, 11); g.closePath(); g.fill();
    g.fillText('N', nx, 20);
    return { cv, xf };
  }
  function drawMap(st) {
    if (!mapOpen || !hud.canvas) return;
    const key = st.floorId + '|' + (st.unitId || '');
    if (key !== mapKey) {
      mapKey = key;
      const m = buildMapStatic(st.floorId, st.unitId);
      mapStatic = m.cv; mapXf = m.xf;
      hud.canvas.width = mapStatic.width; hud.canvas.height = mapStatic.height;
      hud.canvas.style.width = mapXf.cw + 'px'; hud.canvas.style.height = mapXf.ch + 'px';
      mapDirtyPose = '';
    }
    const pose = pos.x.toFixed(2) + ',' + pos.z.toFixed(2) + ',' + yaw.toFixed(2);
    if (pose === mapDirtyPose) return;
    mapDirtyPose = pose;
    const g = hud.canvas.getContext('2d');
    const { s, ox, oz, dpr } = mapXf;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, hud.canvas.width, hud.canvas.height);
    g.drawImage(mapStatic, 0, 0);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const px = ox + pos.x * s, pz = oz + pos.z * s;
    const ang = Math.atan2(-Math.cos(yaw), -Math.sin(yaw)); // canvas angle of forward (x right, z down)
    const r = 34;
    const grad = g.createRadialGradient(px, pz, 2, px, pz, r);
    grad.addColorStop(0, 'rgba(205,176,122,.55)'); grad.addColorStop(1, 'rgba(205,176,122,0)');
    g.fillStyle = grad;
    g.beginPath(); g.moveTo(px, pz); g.arc(px, pz, r, ang - 0.55, ang + 0.55); g.closePath(); g.fill();
    g.save(); g.translate(px, pz); g.rotate(ang);
    g.beginPath(); g.moveTo(7, 0); g.lineTo(-4.5, 4.8); g.lineTo(-2.2, 0); g.lineTo(-4.5, -4.8); g.closePath();
    g.fillStyle = '#cdb07a'; g.fill(); g.lineWidth = 1.2; g.strokeStyle = 'rgba(255,255,255,.95)'; g.stroke();
    g.restore();
  }
  function onMapPointer(e) {
    if (!mapXf) return;
    e.preventDefault(); e.stopPropagation();
    const r = hud.canvas.getBoundingClientRect();
    const cx = (e.clientX - r.left) * (mapXf.cw / r.width), cz = (e.clientY - r.top) * (mapXf.ch / r.height);
    const x = (cx - mapXf.ox) / mapXf.s, z = (cz - mapXf.oz) / mapXf.s;
    if (job && job.carry) return;
    const fid = floorId;
    const h = surfaceAt(x, z, LEVEL_Y[fid]);
    if (h === null || !inRegion(x, z, fid) || clearance(x, z, fid) < RADIUS * 0.8 || inCabArea(x, z)) return;
    const keepYaw = yaw, keepPitch = pitch;
    placeAt(x, z, fid);
    yaw = keepYaw; pitch = keepPitch;
    applyCamera();
    emitState(true);
  }

  // ── walk target marker ──
  let ring = null, ringFade = 0;
  function showRing(x, y, z) {
    if (!scene) return;
    if (!ring) {
      const geo = new THREE.RingGeometry(0.17, 0.2, 48);
      geo.rotateX(-Math.PI / 2);
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false });
      ring = new THREE.Mesh(geo, mat);
      const dot = new THREE.Mesh(new THREE.CircleGeometry(0.035, 24).rotateX(-Math.PI / 2), mat);
      dot.position.y = 0.001;
      ring.add(dot);
      ring.name = 'walk-target';
      ring.renderOrder = 10;
      ring.userData.noWalkRaycast = true;
      ring.raycast = () => {};
      dot.raycast = () => {};
      scene.add(ring);
    }
    ring.position.set(x, y + 0.015, z);
    ring.visible = true;
    ring.material.opacity = 0.85;
    ringFade = 0;
  }
  function hideRing() { if (ring) ring.visible = false; }

  // ── picking ──
  const raycaster = new THREE.Raycaster();
  raycaster.far = 40;
  const pickerSet = new Set(((building && building.floorPickers) || []).map(p => p && p.mesh).filter(Boolean));
  let lastPick = null;
  function usable(o) {
    if (!o || o.userData?.noWalkRaycast || pickerSet.has(o) || o.isSprite || o.isPoints || o.isLine) return false;
    for (let a = o; a; a = a.parent) if (!a.visible) return false;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const m = mats[0];
    if (!m || m.visible === false || m.colorWrite === false || m.opacity === 0) return false;
    if (m.transparent && m.opacity < 0.6) return false;    // glass: look through it
    return true;
  }
  function ndc(clientX, clientY) {
    const r = dom.getBoundingClientRect();
    return new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  }
  function pickPanel(clientX, clientY) {
    if (!lift || !lift.panel || !playerInCab()) return null;
    raycaster.setFromCamera(ndc(clientX, clientY), camera);
    const hits = raycaster.intersectObject(lift.panel, true);
    for (const h of hits) {
      for (let o = h.object; o; o = o.parent) {
        if (o.userData && o.userData.liftButton != null) return normFloor(o.userData.liftButton);
        if (o === lift.panel) break;
      }
    }
    return null;
  }
  // Tap-to-walk target by ray-marching the plan data (walls, rails, floors, stairs) — independent of the
  // scene's mesh complexity (the OSM context can be ~1M triangles) and of furniture.
  function marchTarget(o, d) {
    const fid = floorId, base = LEVEL_Y[fid];
    const occ = segsFor(fid);
    const hl = Math.hypot(d.x, d.z) || 1e-6;
    const back = (x, z, dist) => ({ x: x - (d.x / hl) * dist, z: z - (d.z / hl) * dist });
    let g = feetY, lastIn = { x: pos.x, z: pos.z };
    const STEP = 0.04;
    for (let t = 0.05; t < 22; t += STEP) {
      const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
      const cands = inStairBox(x, z) ? stairHeights(x, z) : LEVEL_YS;
      let best = g, bd = Infinity;
      for (const c of cands) { const dd = Math.abs(c - g); if (dd < bd) { bd = dd; best = c; } }
      if (bd < 0.7) g = best;
      if (y <= g + 0.002) return { x, z, y: g, hit: 'floor' };
      const ry = y - base;
      for (const sg of occ) {
        const y0 = sg.y0 != null ? sg.y0 : -0.2, y1 = sg.y1 != null ? sg.y1 : 2.75;
        if (ry < y0 || ry > y1) continue;
        if (segDist(x, z, sg) < 0.015) { const b = back(x, z, 0.4 + RADIUS * 0.2); return { x: b.x, z: b.z, y: g, hit: 'wall' }; }
      }
      if (inRegion(x, z, fid)) lastIn = { x, z };
      if (ry > 2.75 && !inStairBox(x, z)) return { x, z, y: g, hit: 'ceiling' };
    }
    return { x: lastIn.x, z: lastIn.z, y: g, hit: 'none' };
  }
  function walkToScreen(clientX, clientY) {
    if (job && job.carry) return false;
    camera.updateMatrixWorld();
    raycaster.setFromCamera(ndc(clientX, clientY), camera);
    const o = raycaster.ray.origin, d = raycaster.ray.direction;
    const tg = marchTarget({ x: o.x, y: o.y, z: o.z }, d);
    if (Math.hypot(tg.x - pos.x, tg.z - pos.z) < 0.15) return false;
    lastPick = tg;
    return walkTo(tg.x, tg.z, tg.y);
  }
  function walkTo(x, z, yHint) {
    if (job && job.carry) return false;
    auto = { x, z, stuck: 0 };
    const sy = surfaceAt(x, z, yHint != null ? yHint : feetY);
    showRing(x, sy != null ? sy : (yHint != null ? yHint : feetY), z);
    return true;
  }

  // ── input ──
  const ptr = { id: null, x: 0, y: 0, sx: 0, sy: 0, t0: 0, moved: 0, lastT: 0, vx: 0, vy: 0 };
  let lastTap = { t: -1e9, x: 0, y: 0 };
  const touches = new Set();
  const LOOK_K = () => 0.0036 * ((camera.fov || 60) / 60);
  function on(target, type, fn, opts) { target.addEventListener(type, fn, opts); listeners.push([target, type, fn, opts]); }
  function onPointerDown(e) {
    if (e.button !== undefined && e.button > 0 && e.pointerType === 'mouse') return;
    unlockAudio();
    touches.add(e.pointerId);
    if (ptr.id !== null) return;
    ptr.id = e.pointerId; ptr.x = ptr.sx = e.clientX; ptr.y = ptr.sy = e.clientY;
    ptr.t0 = ptr.lastT = performance.now(); ptr.moved = 0; ptr.vx = ptr.vy = 0;
    yawVel = pitchVel = 0;
    try { dom.setPointerCapture(e.pointerId); } catch (er) { /* */ }
    dom.style.cursor = 'grabbing';
    hideHint();
  }
  function onPointerMove(e) {
    if (e.pointerId !== ptr.id) return;
    const dx = e.clientX - ptr.x, dy = e.clientY - ptr.y;
    ptr.x = e.clientX; ptr.y = e.clientY;
    ptr.moved += Math.abs(dx) + Math.abs(dy);
    if (touches.size > 1) return;
    const k = LOOK_K();
    yaw += dx * k;
    pitch = clamp(pitch + dy * k, PITCH_MIN, PITCH_MAX);
    const now = performance.now(), dtm = Math.max(1, now - ptr.lastT) / 1000;
    ptr.lastT = now;
    ptr.vx = ptr.vx * 0.6 + (dx * k / dtm) * 0.4;
    ptr.vy = ptr.vy * 0.6 + (dy * k / dtm) * 0.4;
  }
  function onPointerUp(e) {
    touches.delete(e.pointerId);
    if (e.pointerId !== ptr.id) return;
    ptr.id = null;
    dom.style.cursor = 'grab';
    const now = performance.now();
    if (now - ptr.lastT < 70 && ptr.moved > 8) { yawVel = clamp(ptr.vx, -6, 6); pitchVel = clamp(ptr.vy, -4, 4); }
    const touch = e.pointerType !== 'mouse';
    const isTap = ptr.moved < (touch ? 14 : 9) && now - ptr.t0 < (touch ? 400 : 350) && e.type === 'pointerup';
    if (!isTap) { lastTap.t = -1e9; return; }
    // single tap: only the 3D lift buttons react; everything else waits for the second tap
    const fid = pickPanel(e.clientX, e.clientY);
    if (fid) { ride(fid); lastTap.t = -1e9; return; }
    if (now - lastTap.t < (touch ? 420 : 380) && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < (touch ? 48 : 36)) {
      lastTap.t = -1e9;
      walkToScreen(e.clientX, e.clientY);
    } else lastTap = { t: now, x: e.clientX, y: e.clientY };
  }
  function onWheel(e) {
    e.preventDefault();
    wheelImpulse = clamp(wheelImpulse - Math.sign(e.deltaY) * 0.35, -1.2, 1.2);
    auto = null;
  }
  const KEYMAP = { KeyW: 'f', ArrowUp: 'f', KeyS: 'b', ArrowDown: 'b', KeyA: 'sl', KeyD: 'sr', ArrowLeft: 'tl', ArrowRight: 'tr', KeyQ: 'tl', KeyE: 'tr', PageUp: 'lu', PageDown: 'ld', KeyR: 'lu', KeyF: 'ld', ShiftLeft: 'run', ShiftRight: 'run' };
  function onKeyDown(e) {
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const k = KEYMAP[e.code];
    if (!k) return;
    if (k !== 'run') e.preventDefault();
    unlockAudio();
    keys.add(k);
    if (k !== 'run') { auto = null; hideRing(); hideHint(); }
  }
  function onKeyUp(e) { const k = KEYMAP[e.code]; if (k) keys.delete(k); }
  function onBlur() { keys.clear(); for (const k in hudIn) hudIn[k] = false; }
  function onContext(e) { e.preventDefault(); }
  function onTouchStart(e) { if (e.cancelable) e.preventDefault(); } // belt-and-braces with touch-action:none: no double-tap zoom, no scroll

  const padLit = {};
  function syncPadHighlight() {
    if (!hud.pad) return;
    const st = { fwd: keys.has('f') || hudIn.fwd, back: keys.has('b') || hudIn.back, left: keys.has('tl') || hudIn.left, right: keys.has('tr') || hudIn.right, lup: keys.has('lu') || hudIn.lup, ldown: keys.has('ld') || hudIn.ldown };
    for (const k in st) if (padLit[k] !== st[k]) { padLit[k] = st[k]; hud.pad[k].classList.toggle('vw-down', st[k]); }
  }
  function hideHint() { if (hud.hint) hud.hint.classList.remove('vw-on'); hintTimer = 0; }

  // ── state emission ──
  const changeCbs = [];
  function locate() {
    const f = FLOOR_BY_ID[floorId];
    const inLift = playerInCab();
    let room = null, unitId = null, roomId = null;
    if (inLift) room = f.rooms.find(r => r.use === 'lift') || null;
    if (!room) room = f.rooms.find(r => r.use !== 'garden' && r.use !== 'ramp' && pointInPoly(pos.x, pos.z, r.poly)) || null;
    if (!room) {
      const b = balconiesOf(floorId).find(bb => pointInPoly(pos.x, pos.z, bb.poly));
      if (b) {
        const units = b.unit || [];
        unitId = units.length > 1 && b.split != null ? (pos.x < b.split ? units[0] : units[1]) : units[0] || null;
        room = { id: b.id, unit: unitId, name: nameOf(b) };
      }
    }
    if (!room) room = f.rooms.find(r => r.use === 'garden' && pointInPoly(pos.x, pos.z, r.poly)) || null;
    if (!room && lastState && lastState.floorId === floorId && lastState.room) room = lastState.room;
    if (room) { roomId = room.id; unitId = room.unit || unitId || null; }
    return { floorId, roomId, unitId, inLift, room };
  }
  function nameOf(b) {
    const k = b.deck ? 'deck' : b.id.includes('front') && b.level === 'first' ? 'terrace' : 'balcony';
    return { en: T.en[k], pt: T.pt[k], he: T.he[k] };
  }
  function emitState(force) {
    const st = locate();
    const changed = !lastState || st.floorId !== lastState.floorId || st.roomId !== lastState.roomId || st.unitId !== lastState.unitId || st.inLift !== lastState.inLift;
    lastState = st;
    updateLabel(st);
    if (changed || force === 'always') {
      const pub = { floorId: st.floorId, roomId: st.roomId, unitId: st.unitId, inLift: st.inLift };
      for (const cb of changeCbs) { try { cb(pub); } catch (e) { /* guard */ } }
    }
    return st;
  }

  // ── per-frame ──
  function applyCamera() {
    if (!camera) return;
    camera.rotation.order = 'YXZ';
    camera.position.set(pos.x, eyeY + rideSway, pos.z);
    camera.rotation.set(pitch, yaw, reduceMotion ? 0 : rideSway * 0.35, 'YXZ');
    camera.updateMatrixWorld();
  }
  function stepDoors(dt) {
    const riding = job && job.carry && job.moving;
    for (const r of doorRecs) {
      if (r.interior) continue;       // interior doors stay as BUILDING set them (open by default)
      const same = r.d.floorId === floorId && !riding && Math.abs(feetY - LEVEL_Y[floorId]) < 0.5;
      const d = Math.hypot(pos.x - r.cx, pos.z - r.cz);
      if (same && d < DOOR_NEAR) r.target = 1;
      else if (!same || d > DOOR_FAR) r.target = 0;
      if (r.t !== r.target) {
        r.t = approach(r.t, r.target, dt / DOOR_TIME);
        try { r.d.setOpen(smooth(r.t)); } catch (e) { /* guard */ }
      }
    }
  }
  function update(dtIn) {
    const dt = clamp(dtIn || 0, 0, 0.05);
    clock += dt;
    if (!enabled) { if (job) stepLift(dt); return; }
    // look inertia
    if (ptr.id === null && (Math.abs(yawVel) > 1e-4 || Math.abs(pitchVel) > 1e-4)) {
      yaw += yawVel * dt; pitch = clamp(pitch + pitchVel * dt, PITCH_MIN, PITCH_MAX);
      const damp = Math.exp(-dt * 5.5);
      yawVel *= damp; pitchVel *= damp;
      if (Math.abs(yawVel) < 0.003) yawVel = 0;
      if (Math.abs(pitchVel) < 0.003) pitchVel = 0;
    }
    // turning
    const turn = (keys.has('tl') || hudIn.left ? 1 : 0) - (keys.has('tr') || hudIn.right ? 1 : 0);
    if (turn) yaw += turn * TURN_SPEED * dt;
    const lookV = (keys.has('lu') || hudIn.lup ? 1 : 0) - (keys.has('ld') || hudIn.ldown ? 1 : 0);
    if (lookV) { pitch = clamp(pitch + lookV * LOOK_SPEED * dt, PITCH_MIN, PITCH_MAX); pitchVel = 0; }
    syncPadHighlight();
    yaw = wrapAngle(yaw);
    // desired velocity
    const riding = job && job.carry && (job.moving || job.phase === 'closing');
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    let fwd = (keys.has('f') || hudIn.fwd ? 1 : 0) - (keys.has('b') || hudIn.back ? 1 : 0);
    const side = (keys.has('sr') ? 1 : 0) - (keys.has('sl') ? 1 : 0);
    if (wheelImpulse) { fwd += wheelImpulse; wheelImpulse = approach(wheelImpulse, 0, dt * 2.2); }
    let dvx = 0, dvz = 0;
    const speed = keys.has('run') ? RUN_SPEED : WALK_SPEED;
    if (fwd || side || turn) auto = auto && !(fwd || side) ? auto : null;
    if (fwd || side) {
      dvx = (fx * fwd + rx * side) * speed; dvz = (fz * fwd + rz * side) * speed;
      const m = Math.hypot(dvx, dvz); if (m > speed) { dvx *= speed / m; dvz *= speed / m; }
      if (!auto) hideRing();
    } else if (auto) {
      const ax = auto.x - pos.x, az = auto.z - pos.z, d = Math.hypot(ax, az);
      if (d < 0.06) { auto = null; ringFade = 0.001; }
      else {
        const s = Math.min(WALK_SPEED, 0.35 + d * 1.6);
        dvx = (ax / d) * s; dvz = (az / d) * s;
      }
    }
    if (riding) { dvx = dvz = 0; auto = null; }
    const k = 1 - Math.exp(-dt * 9);
    vel.x += (dvx - vel.x) * k; vel.z += (dvz - vel.z) * k;
    if (!dvx && !dvz && Math.hypot(vel.x, vel.z) < 0.02) vel.x = vel.z = 0;
    const want = Math.hypot(vel.x, vel.z) * dt;
    if (want > 0) {
      const moved = moveBy(vel.x * dt, vel.z * dt);
      if (auto) {
        if (moved < want * 0.3) auto.stuck += dt; else auto.stuck = 0;
        if (auto.stuck > 0.3) { auto = null; ringFade = 0.001; }
      }
      if (moved < want * 0.2) { vel.x *= 0.5; vel.z *= 0.5; }
    }
    // ring fade
    if (ring && ring.visible && (ringFade > 0 || !auto)) {
      ringFade += dt;
      ring.material.opacity = Math.max(0, 0.85 * (1 - ringFade / 0.5));
      if (ringFade >= 0.5) hideRing();
    }
    stepLift(dt);
    stepDoors(dt);
    // eye height (smooth over stairs; exact while riding)
    if (job && job.carry && job.moving) eyeY = feetY + EYE;
    else eyeY += (feetY + EYE - eyeY) * (1 - Math.exp(-dt * 14));
    if (!(job && job.carry && job.moving)) rideSway = 0;
    applyCamera();
    const st = emitState(false);
    updateLiftPanel();
    drawMap(st);
    if (hintTimer > 0) { hintTimer -= dt; if (hintTimer <= 0) hideHint(); }
  }

  // ── enable / disable ──
  const saved = {};
  function enable() {
    if (enabled) return;
    enabled = true;
    if (dom) {
      saved.touchAction = dom.style.touchAction; saved.cursor = dom.style.cursor; saved.us = dom.style.userSelect;
      dom.style.touchAction = 'none'; dom.style.cursor = 'grab'; dom.style.userSelect = 'none';
      on(dom, 'pointerdown', onPointerDown, { passive: true });
      on(dom, 'pointermove', onPointerMove, { passive: true });
      on(dom, 'pointerup', onPointerUp, { passive: true });
      on(dom, 'pointercancel', onPointerUp, { passive: true });
      on(dom, 'wheel', onWheel, { passive: false });
      on(dom, 'contextmenu', onContext, false);
      on(dom, 'dblclick', onContext, false);            // walking is handled on pointerup; never select/zoom
      on(dom, 'gesturestart', onContext, false);        // iOS pinch/double-tap zoom
      on(dom, 'touchstart', onTouchStart, { passive: false });
    }
    on(window, 'keydown', onKeyDown, false);
    on(window, 'keyup', onKeyUp, false);
    on(window, 'blur', onBlur, false);
    if (camera) { saved.order = camera.rotation.order; }
    if (!liftInit) { liftInit = true; setCab(cabY, cabLevel); applyLiftDoors(true); }
    if (!placed) {
      const lobby = FLOOR_BY_ID.ground.rooms.find(r => r.use === 'lobby');
      if (lobby) {
        const p = bestPoint(lobby.poly, 'ground');
        placeAt(p.x, p.z, 'ground');
        yaw = 0; pitch = -0.05;
      } else placeAt(pos.x, pos.z, floorId);
    }
    if (hud.root) {
      refreshHudText();
      hud.root.hidden = false;
      hud.hint.classList.add('vw-on');
      hintTimer = 6;
    }
    applyCamera();
    emitState('always');
  }
  function disable() {
    if (!enabled) return;
    enabled = false;
    for (const [t, type, fn, opts] of listeners.splice(0)) t.removeEventListener(type, fn, opts);
    onBlur();
    ptr.id = null; touches.clear();
    stopMotion();
    if (dom) { dom.style.touchAction = saved.touchAction || ''; dom.style.cursor = saved.cursor || ''; dom.style.userSelect = saved.us || ''; }
    if (camera && saved.order) camera.rotation.order = saved.order;
    if (hud.root) hud.root.hidden = true;
    if (job && job.carry) { // finish the ride instantly so nobody is left in the shaft
      const to = job.to;
      cancelLift();
      setCab(LIFT_Y[to], to); feetY = LIFT_Y[to]; floorId = to; eyeY = feetY + EYE; liftDoor = 1; applyLiftDoors(true);
    }
  }
  function dispose() {
    disable();
    if (hud.root && hud.root.parentNode) hud.root.parentNode.removeChild(hud.root);
    if (ring && ring.parent) { ring.parent.remove(ring); ring.geometry.dispose(); ring.material.dispose(); }
    try { audio && audio.close(); } catch (e) { /* */ }
  }

  return {
    enable, disable, isEnabled: () => enabled,
    teleport, goToUnit, goToLift, ride,
    onChange(cb) { if (typeof cb === 'function') changeCbs.push(cb); return () => { const i = changeCbs.indexOf(cb); if (i >= 0) changeCbs.splice(i, 1); }; },
    update,
    // extras
    walkTo(x, z) { return walkTo(x, z); },
    setLang(l) { langOverride = l; refreshHudText(); },
    setMapOpen,
    getState() {
      const st = lastState || locate();
      return { floorId: st.floorId, roomId: st.roomId, unitId: st.unitId, inLift: st.inLift, x: pos.x, z: pos.z, feetY, eyeY, yaw, pitch, cabY, cabLevel, liftDoor, riding: !!(job && job.moving), autoWalking: !!auto };
    },
    dispose
  };
}
