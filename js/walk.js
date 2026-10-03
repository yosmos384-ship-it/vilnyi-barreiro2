// VILNYI · Barreiro 2 — WALK: first-person walkthrough, HUD, stairs and lift.
// Depends only on data.js and the BUILDING contract API (doors[], lift{...}, floorPickers).
import { FLOORS, CORE, BALCONIES, FOOTPRINT, UNITS, LOT, RAMP, STREET_Y, LEVELS } from './data.js';

// ───────────────────────────── constants ─────────────────────────────
const EYE = 1.62;
const RADIUS = 0.25;
const WALK_SPEED = 1.45;          // m/s
const TAP_WALK = 2.5;             // m walked per double tap
const RUN_SPEED = 2.6;
const TURN_SPEED = 1.9;           // rad/s (keys / HUD)
const LOOK_SPEED = 1.0;           // rad/s pitch (look up / down buttons)
const STEP_TOL = 0.45;            // max height change per move step (stairs)
const DOOR_NEAR = 1.4;
const DOOR_FAR = 2.1;
const DOOR_TIME = 0.6;            // s to open / close a leaf
const DOOR_HOLD = 6;              // s a tapped door keeps its state before auto behaviour resumes
const DOUBLE_MS = 400;            // double-tap window; a single tap acts after it
const DT_MAX = 0.1;
const LIFT_DOOR_TIME = 0.9;
const LIFT_SPEED = 1.0;           // m/s average
const PITCH_MIN = -1.3, PITCH_MAX = 1.15;
// Every opening is passable (client request): windows, slits and the garage included. Leaves (doors) block
// while closed and auto-open as you approach; the lift landing door only when the cab is there.
const PASSABLE = new Set(['door', 'entry', 'opening', 'glassdoor', 'main', 'elevator', 'window', 'slit', 'garage']);
const LEAF = new Set(['door', 'entry', 'main', 'garage']);
const DROP_TOL = 0.5;             // larger drops become a gentle float-down
const ENTER_STEP = 0.95;          // max step up when climbing into the building through an opening from outside
const BODY_LO = 0.25, BODY_HI = 1.7; // vertical band (above feet) that collides with walls
const AREA = 60;                  // free exterior walking within ±60 m of the site
const BASE_POLY = [[0, -7.9], [8.2, -7.9], [10.9, 1.9], [13.88, 1.9], [13.88, 14.7], [0, 14.7]];
const RAMP_X = [10.45, 13.73];
const PATH_X = [3.45, 5.45];      // entrance path in the front yard
const ROOF_Y = (LEVELS.roof && LEVELS.roof.y) || 9.3;

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
  en: { hint: 'Drag to look · Double-click to walk · Click to open', hintTouch: 'Drag to look · Double-tap to walk · Tap to open', plan: 'Plan', lift: 'Lift', apartment: 'Apartment', balcony: 'Balcony', terrace: 'Terrace', deck: 'Garden deck', outside: 'Outside', fwd: 'Forward', back: 'Back', left: 'Turn left', right: 'Turn right', lookUp: 'Look up', lookDown: 'Look down', stepL: 'Step left', stepR: 'Step right', hideUi: 'Hide controls', tap: 'Tap', openDoor: 'Open door', closeDoor: 'Close door', garageDoor: 'Garage door', showUi: 'Show controls', up: 'Up', down: 'Down', floor: 'Floor', close: 'Close plan' },
  pt: { hint: 'Arraste para olhar · Duplo clique para andar · Clique para abrir', hintTouch: 'Arraste para olhar · Toque duplo para andar · Toque para abrir', plan: 'Planta', lift: 'Elevador', apartment: 'Apartamento', balcony: 'Varanda', terrace: 'Terraço', deck: 'Deck do jardim', outside: 'Exterior', fwd: 'Avançar', back: 'Recuar', left: 'Rodar à esquerda', right: 'Rodar à direita', lookUp: 'Olhar para cima', lookDown: 'Olhar para baixo', stepL: 'Passo à esquerda', stepR: 'Passo à direita', hideUi: 'Ocultar controlos', tap: 'Toque', openDoor: 'Abrir porta', closeDoor: 'Fechar porta', garageDoor: 'Portão da garagem', showUi: 'Mostrar controlos', up: 'Subir', down: 'Descer', floor: 'Piso', close: 'Fechar planta' },
  he: { hint: 'גררו כדי להסתכל · לחיצה כפולה כדי ללכת · לחיצה לפתיחה', hintTouch: 'גררו כדי להסתכל · הקשה כפולה כדי ללכת · הקשה לפתיחה', plan: 'תוכנית', lift: 'מעלית', apartment: 'דירה', balcony: 'מרפסת', terrace: 'טרסה', deck: 'דק גינה', outside: 'בחוץ', fwd: 'קדימה', back: 'אחורה', left: 'פנייה שמאלה', right: 'פנייה ימינה', lookUp: 'הבט למעלה', lookDown: 'הבט למטה', stepL: 'צעד שמאלה', stepR: 'צעד ימינה', hideUi: 'הסתרת הפקדים', tap: 'הקישו', openDoor: 'פתיחת דלת', closeDoor: 'סגירת דלת', garageDoor: 'שער החניון', showUi: 'הצגת הפקדים', up: 'למעלה', down: 'למטה', floor: 'קומה', close: 'סגירת תוכנית' },
  ru: { hint: 'Ведите, чтобы осмотреться · Двойной клик — идти · Клик — открыть', hintTouch: 'Ведите пальцем — осмотреться · Двойное касание — идти · Касание — открыть', plan: 'План', lift: 'Лифт', apartment: 'Квартира', balcony: 'Балкон', terrace: 'Терраса', deck: 'Терраса в саду', outside: 'Снаружи', fwd: 'Вперёд', back: 'Назад', left: 'Повернуть налево', right: 'Повернуть направо', lookUp: 'Вверх', lookDown: 'Вниз', stepL: 'Шаг влево', stepR: 'Шаг вправо', hideUi: 'Скрыть управление', tap: 'Нажмите', openDoor: 'Открыть дверь', closeDoor: 'Закрыть дверь', garageDoor: 'Гаражные ворота', showUi: 'Показать управление', up: 'Вверх', down: 'Вниз', floor: 'Этаж', close: 'Закрыть план' }
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
    const a = poly[i], b = poly[j], xi = a[0], zi = a[1], xj = b[0], zj = b[1];
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
    const p0 = s.ht - v, p1 = v + s.ht, p2 = u, p3 = s.L - u, mn = Math.min(p0, p1, p2, p3);
    const k = mn === p0 ? 0 : mn === p1 ? 1 : mn === p2 ? 2 : 3;
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
function pushStairHeights(out, x, z) {   // no allocations: appends to `out`
  if (z <= SL.zLand) { for (let i = 0; i < LEVEL_YS.length; i++) out.push(LEVEL_YS[i]); return; }
  const turn = z >= SL.zTurn, k = (z - SL.zLand) / (SL.zTurn - SL.zLand), east = x >= SL.xMid;
  for (let i = 0; i < STOREYS.length; i++) {
    const s = STOREYS[i];
    out.push(turn ? s.ym : east ? s.y0 + k * (s.ym - s.y0) : s.y1 + k * (s.ym - s.y1));
  }
}
function nearestFloorId(y) {
  let best = ORDER[0], bd = Infinity;
  for (let i = 0; i < ORDER.length; i++) { const id = ORDER[i], d = Math.abs(LEVEL_Y[id] - y); if (d < bd - 1e-6) { bd = d; best = id; } }
  return best;
}
function balconiesOf(floorId) { return BALCONIES.filter(b => b.level === floorId); }

// ───────────────────────────── CSS ─────────────────────────────
const CSS = `
.vw-root.vw-root{pointer-events:none}
.vw-root{position:absolute;inset:0;pointer-events:none;z-index:6;color:#f5f1ea;font-family:inherit;-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;
 --vw-glass:rgba(18,17,16,.62);--vw-glass-hi:rgba(30,28,26,.74);--vw-line:rgba(255,255,255,.16);--vw-line-hi:rgba(255,255,255,.34);--vw-accent:#cdb07a;--vw-inset:18px;--vw-b:44px;--vw-sb:env(safe-area-inset-bottom,0px);--vw-st:env(safe-area-inset-top,0px);--vw-sx:max(env(safe-area-inset-left,0px),env(safe-area-inset-right,0px));touch-action:none;line-height:1.25}
.vw-root[hidden]{display:none!important}
.vw-glass{background:var(--vw-glass);-webkit-backdrop-filter:blur(16px) saturate(135%);backdrop-filter:blur(18px) saturate(140%);border:1px solid var(--vw-line);border-radius:14px;text-shadow:0 1px 1px rgba(0,0,0,.25);box-shadow:0 10px 34px rgba(0,0,0,.22)}
.vw-cap{font-size:10px;letter-spacing:.18em;text-transform:uppercase;font-weight:500;opacity:.66}
.vw-label{position:absolute;inset-block-start:var(--vw-top,var(--vw-inset));inset-inline-start:var(--vw-inset);padding:10px 16px 11px;max-width:min(62vw,340px);transition:opacity .3s}
.vw-room{font-size:15px;font-weight:400;letter-spacing:.01em;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vw-unit{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--vw-accent);margin-top:5px}
.vw-unit:empty{display:none}
.vw-hint{position:absolute;inset-block-end:calc(var(--vw-inset) + 6px);left:50%;transform:translateX(-50%);padding:8px 16px;border-radius:999px;font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;white-space:nowrap;opacity:0;transition:opacity .8s}
.vw-hint.vw-on{opacity:.9}
.vw-chip{transition:opacity .25s;text-transform:none;letter-spacing:.04em;font-size:12px}
.vw-chip.vw-on{opacity:.95}
.vw-pad{position:absolute;bottom:calc(var(--vw-inset) + var(--vw-sb));left:calc(var(--vw-inset) + var(--vw-sx));pointer-events:none}
.vw-padgrid{display:grid;grid-template-columns:repeat(3,var(--vw-b));grid-template-rows:repeat(3,var(--vw-b));gap:5px;direction:ltr}
.vw-padhub{grid-column:2;grid-row:2;align-self:center;justify-self:center;width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.28);box-shadow:0 0 0 1px rgba(0,0,0,.15)}
.vw-btn{pointer-events:auto;appearance:none;-webkit-appearance:none;margin:0;padding:0;font:inherit;color:inherit;width:44px;height:44px;border-radius:12px;display:grid;place-items:center;cursor:pointer;touch-action:none;outline:none;
 background:var(--vw-glass);-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);border:1px solid var(--vw-line);transition:background .18s,border-color .18s,color .18s,box-shadow .18s}
.vw-btn:hover{border-color:var(--vw-line-hi);background:var(--vw-glass-hi)}
.vw-btn:focus-visible{border-color:var(--vw-accent)}
.vw-btn.vw-down{background:rgba(205,176,122,.26);border-color:var(--vw-accent);color:#fff}
.vw-btn svg{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round}
.vw-pad .vw-fwd{grid-column:2;grid-row:1}.vw-pad .vw-left{grid-column:1;grid-row:2}.vw-pad .vw-back{grid-column:2;grid-row:3}.vw-pad .vw-right{grid-column:3;grid-row:2}
.vw-padgrid .vw-btn{width:var(--vw-b);height:var(--vw-b);position:relative}
.vw-padgrid .vw-btn::after{content:'';position:absolute;inset:-3px}
.vw-pad2 .vw-lup{grid-column:2;grid-row:1}.vw-pad2 .vw-sl{grid-column:1;grid-row:2}.vw-pad2 .vw-sr{grid-column:3;grid-row:2}.vw-pad2 .vw-ldown{grid-column:2;grid-row:3}
.vw-pad2 .vw-eye{grid-column:1;grid-row:1;align-self:start;justify-self:start}.vw-pad2 .vw-maptoggle{grid-column:3;grid-row:1}
.vw-pad2 .vw-btn svg{width:18px;height:18px}
.vw-debug{position:absolute;inset-block-start:calc(var(--vw-inset) + var(--vw-st) + 34px);left:calc(var(--vw-inset) + var(--vw-sx));margin:0;padding:6px 8px;max-width:78%;font:10px/1.35 ui-monospace,Menlo,Consolas,monospace;color:#d8ffd8;background:rgba(0,0,0,.72);border:1px solid rgba(120,255,120,.35);border-radius:8px;white-space:pre-wrap;pointer-events:none;direction:ltr;text-align:left;z-index:3}
.vw-pad .vw-btn svg{width:20px;height:20px;stroke-width:1.5}
.vw-mapwrap{position:absolute;bottom:calc(var(--vw-inset) + var(--vw-sb));right:calc(var(--vw-inset) + var(--vw-sx));display:flex;flex-direction:column;align-items:flex-end;gap:8px;pointer-events:none;direction:ltr}
.vw-maptoggle{padding:0}
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
@media (pointer:coarse) and (max-width:560px){.vw-root{--vw-b:42px}.vw-padgrid{gap:4px}}
@media (max-width:560px){.vw-root{--vw-inset:12px}.vw-label{max-width:56vw}.vw-lift{width:84px;padding:10px 0;gap:9px}.vw-lift-ind{width:58px;height:40px}.vw-lift-num{font-size:22px}.vw-lift-btns{gap:6px}.vw-lbtn{width:38px;height:38px;font-size:13px}.vw-lift-ud{width:66px;padding-top:8px}.vw-lift-ud .vw-btn{width:30px;height:30px}.vw-hint{inset-block-end:calc(var(--vw-inset) + 3 * var(--vw-b) + 26px);white-space:normal;text-align:center;width:max-content;max-width:78vw;line-height:1.5}}
.vw-padgrid .vw-eye{width:32px;height:32px;border-radius:50%;opacity:.8}
.vw-padgrid .vw-eye svg{width:15px;height:15px}
.vw-hide .vw-label,.vw-hide .vw-hint,.vw-hide .vw-pad,.vw-hide .vw-lift,.vw-hide .vw-map,.vw-hide .vw-maptoggle,.vw-hide .vw-pad2 .vw-btn:not(.vw-eye),.vw-hide .vw-pad2 .vw-padhub{opacity:0!important;visibility:hidden!important;pointer-events:none!important;transition:opacity .25s,visibility 0s .25s}
.vw-hide .vw-btn:not(.vw-eye),.vw-hide .vw-map canvas{pointer-events:none!important}
.vw-hide .vw-eye{opacity:.3!important;background:rgba(18,17,16,.3)}
/* compact (phones): light controls tucked into the corners, nothing over the centre of the view */
.vw-compact{--vw-inset:10px;--vw-b:34px}
.vw-compact .vw-padgrid{gap:4px}
.vw-compact .vw-btn{border-radius:10px;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);box-shadow:none}
.vw-compact .vw-padgrid .vw-btn{opacity:.55;transition:opacity .6s,background .18s,border-color .18s}
.vw-compact.vw-idle .vw-padgrid .vw-btn{opacity:.25}
.vw-compact .vw-padgrid .vw-btn.vw-down{opacity:1;transition:opacity .05s}
.vw-compact .vw-padgrid .vw-btn svg{width:16px;height:16px}
.vw-compact .vw-padhub{width:4px;height:4px;opacity:.6}
.vw-compact .vw-padgrid .vw-eye{width:26px;height:26px}
.vw-compact .vw-padgrid .vw-eye svg{width:13px;height:13px}
.vw-compact .vw-map{padding:6px}
.vw-compact .vw-label{inset-block-start:calc(var(--vw-top,var(--vw-inset)) + var(--vw-st));inset-inline-start:calc(var(--vw-inset) + var(--vw-sx));padding:4px 11px 5px;border-radius:999px;display:flex;align-items:baseline;gap:.45em;max-width:calc(100% - 2 * var(--vw-inset) - 2 * var(--vw-sx));box-sizing:border-box;white-space:nowrap;overflow:hidden;background:rgba(18,17,16,.5);box-shadow:none;opacity:0;transition:opacity .6s}
.vw-compact .vw-label.vw-show{opacity:.92}
.vw-compact .vw-label>*{margin:0;font-size:11px;letter-spacing:.03em;text-transform:none;font-weight:400;opacity:1;flex:0 1 auto;overflow:hidden;text-overflow:ellipsis}
.vw-compact .vw-label>.vw-cap{opacity:.72}
.vw-compact .vw-label>*+*:not(:empty)::before{content:'·';margin-inline-end:.45em;opacity:.55;color:#f5f1ea}
.vw-compact .vw-hint{inset-block-end:auto;inset-block-start:calc(var(--vw-top,var(--vw-inset)) + var(--vw-st) + 32px);padding:5px 12px;font-size:9.5px;letter-spacing:.1em;white-space:normal;text-align:center;width:max-content;max-width:86%;line-height:1.4;background:rgba(18,17,16,.5);box-shadow:none}
.vw-compact .vw-lift{inset-block-start:calc(var(--vw-top,var(--vw-inset)) + var(--vw-st) + 32px);inset-inline-end:calc(var(--vw-inset) + var(--vw-sx));width:auto;flex-direction:row;padding:5px 8px;gap:6px;border-radius:12px;direction:ltr;background:rgba(18,17,16,.5);box-shadow:none}
.vw-compact .vw-chip{font-size:11px;letter-spacing:.03em}
.vw-compact.vw-inlift .vw-chip{inset-block-start:calc(var(--vw-top,var(--vw-inset)) + var(--vw-st) + 80px)}
.vw-compact .vw-lift>.vw-cap{display:none}
.vw-compact .vw-lift-ind{width:40px;height:30px;gap:3px;border-radius:8px}
.vw-compact .vw-lift-num{font-size:17px;min-width:14px}
.vw-compact .vw-lift-dir{width:9px;height:11px}.vw-compact .vw-lift-dir svg{width:9px;height:11px}
.vw-compact .vw-lift-btns{flex-direction:row-reverse;gap:5px}
.vw-compact .vw-lbtn{width:30px;height:30px;font-size:12px;border-radius:50%}
.vw-compact .vw-lift-ud{border-top:0;border-left:1px solid var(--vw-line);padding:0 0 0 6px;width:auto;gap:4px}
.vw-compact .vw-lift-ud .vw-btn{width:26px;height:26px;border-radius:8px}
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
  eye: '<svg viewBox="0 0 24 24"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/></svg>',
  eyeoff: '<svg viewBox="0 0 24 24"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><path d="M4 4l16 16"/></svg>',
  stepl: '<svg viewBox="0 0 24 24"><path d="M11 6l-6 6 6 6M19 6l-6 6 6 6"/></svg>',
  stepr: '<svg viewBox="0 0 24 24"><path d="M13 6l6 6-6 6M5 6l6 6-6 6"/></svg>',
  tri: '<svg viewBox="0 0 12 14"><path d="M6 1l5 6H1z"/><path d="M6 13l5-6H1z" opacity="0"/></svg>'
};

let hintSeen = false;   // the hint shows once per session
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
  const rawLang = () => (langOverride || (typeof document !== 'undefined' && document.documentElement.lang) || 'en').slice(0, 2).toLowerCase();

  // ── state ──
  const pos = { x: 6.1, z: 12 };
  let feetY = 0, eyeY = EYE, floorId = 'ground';
  let yaw = 0, pitch = 0, yawVel = 0, pitchVel = 0;
  const vel = { x: 0, z: 0 };
  let enabled = false, placed = false, clock = 0;
  let auto = null;                 // auto-walk target {x,z,stuck}
  const keys = new Set();
  const hudIn = { fwd: false, back: false, left: false, right: false, lup: false, ldown: false, sl: false, sr: false };
  let wheelImpulse = 0;
  const listeners = [];
  let lastState = null;
  let hintTimer = 0;

  // ── doors ──
  const doorRecs = [];
  for (const d of (building && building.doors) || []) {
    if (!d || !LEAF.has(d.kind) || typeof d.setOpen !== 'function') continue;
    const interior = d.kind === 'door';      // BUILDING opens interior doors by default
    const big = d.kind === 'garage';
    doorRecs.push({ d, t: interior ? 1 : 0, target: interior ? 1 : 0, interior, cx: d.center ? d.center.x : 0, cz: d.center ? d.center.z : 0,
      y: LEVEL_Y[d.floorId] ?? 0, near: big ? 4.2 : DOOR_NEAR, far: big ? 5.4 : DOOR_FAR, hold: 0, synth: null, time: big ? 2.0 : DOOR_TIME });
  }
  function findDoor(fid, x, z) {
    let best = null, bd = 1.0;
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

  // ── collision: wall segments of ALL levels with their world height band, bucketed in a 2 m grid ──
  const SEGS = [];
  let grid = null;
  function addSeg(a, b, t, wy0, wy1, extra) {
    const sg = makeSeg(a, b, t, extra);
    if (!sg) return null;
    sg.wy0 = wy0; sg.wy1 = wy1; SEGS.push(sg); grid = null;
    return sg;
  }
  const boxSeg = (x0, z0, x1, z1, wy0, wy1) => (x1 - x0 >= z1 - z0
    ? addSeg([x0, (z0 + z1) / 2], [x1, (z0 + z1) / 2], z1 - z0, wy0, wy1)
    : addSeg([(x0 + x1) / 2, z0], [(x0 + x1) / 2, z1], x1 - x0, wy0, wy1));
  function buildSegs() {
    for (const f of FLOORS) {
      const fid = f.id, y0 = f.level.y;
      const nxt = ORDER[ORDER.indexOf(fid) + 1];
      // basement walls stop below the surrounding grade (front yard −0.85) so the plinth doesn't block the façade openings
      const y1 = fid === 'basement' ? -1.0 : nxt ? LEVEL_Y[nxt] : ROOF_Y;
      for (const w of f.walls) {
        const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
        if (L < 1e-4) continue;
        const ux = (w.b[0] - w.a[0]) / L, uz = (w.b[1] - w.a[1]) / L;
        const P = (d) => [w.a[0] + ux * d, w.a[1] + uz * d];
        const solid = (d0, d1) => { if (d1 - d0 > 1e-3) addSeg(P(d0), P(d1), w.t, y0, y1); };
        const ops = (w.openings || []).slice().sort((a, b) => a.from - b.from);
        let cur = 0;
        for (const o of ops) {
          if (o.from > cur) solid(cur, o.from);
          if (!PASSABLE.has(o.type)) solid(o.from, o.to);
          else if (o.type === 'elevator') {
            addSeg(P(o.from), P(o.to), w.t, y0, y1, { cond: () => !(cabLevel === fid && !job?.moving && liftDoor > 0.7) });
          } else if (LEAF.has(o.type)) {
            const m = P((o.from + o.to) / 2);
            const rec = findDoor(fid, m[0], m[1]);
            if (rec) addSeg(P(o.from), P(o.to), w.t, y0, y1, { cond: () => rec.t < 0.5 });
          }
          cur = Math.max(cur, o.to);
        }
        if (cur < L) solid(cur, L);
      }
      // balcony balustrades (all edges except the building side), split screens
      const onFacade = (p, q) => (Math.abs(p[1]) < 0.02 && Math.abs(q[1]) < 0.02) || (Math.abs(p[1] - 14.7) < 0.02 && Math.abs(q[1] - 14.7) < 0.02);
      for (const b of balconiesOf(fid)) {
        if (b.deck) continue;
        const poly = b.poly;
        for (let i = 0; i < poly.length; i++) {
          const p = poly[i], q = poly[(i + 1) % poly.length];
          if (!onFacade(p, q)) addSeg(p, q, 0.06, y0 - 0.2, y0 + 1.05);
        }
        if (b.split != null) {
          const zs = poly.map(p => p[1]);
          addSeg([b.split, Math.min(...zs)], [b.split, Math.max(...zs)], 0.06, y0 - 0.2, y0 + 1.6);
        }
      }
      // gardens: boundary walls & the fence between them (not along the rear façade)
      for (const r of f.rooms) {
        if (r.use !== 'garden') continue;
        for (let i = 0; i < r.poly.length; i++) {
          const c = clipEdgeZMax(r.poly[i], r.poly[(i + 1) % r.poly.length], -0.02);
          if (!c) continue;
          if (c[0][1] > -0.3 && c[1][1] > -0.3) continue;
          addSeg(c[0], c[1], 0.1, -0.5, 1.8);
        }
      }
    }
    const yb = LEVEL_Y.basement;
    // lift shaft sides (N/S), stair centre wall + back wall — all levels
    addSeg([LIFT.x0 - 0.3, LIFT.z0], [LIFT.x1, LIFT.z0], 0.1, yb, ROOF_Y);
    addSeg([LIFT.x0 - 0.3, LIFT.z1], [LIFT.x1, LIFT.z1], 0.1, yb, ROOF_Y);
    addSeg([SL.xMid, SL.zLand], [SL.xMid, SL.zTurn], 0.08, yb, ROOF_Y);
    addSeg([SL.x0 - 0.3, SL.z1 + 0.04], [SL.x1, SL.z1 + 0.04], 0.08, yb, ROOF_Y);
    // lot: brick tower, ramp retaining walls, planters, east boundary wall
    boxSeg(0, 14.7, 2.9, 15.01, -1.2, ROOF_Y);
    addSeg([RAMP_X[0] - 0.08, RAMP.zBottom], [RAMP_X[0] - 0.08, LOT.zFront], 0.15, yb, 0.15);
    boxSeg(13.88, 14.7, 14.2, LOT.zFront, -1.3, 0.75);
    boxSeg(LOT.x0 + 0.05, 15.95, PATH_X[0] - 0.1, 17.2, -1.0, -0.15);
    boxSeg(PATH_X[1] + 0.12, 15.45, RAMP_X[0] - 0.3, 17.2, -1.0, 0.1);
  }
  function addContext(osm) {   // real neighbours from data/osm.json (already in the local frame)
    const inLot = (x, z) => x > LOT.x0 - 0.5 && x < LOT.x1 + 0.5 && z > LOT.zRear - 0.5 && z < LOT.zFront + 0.5;
    const near = (p) => p.some(([x, z]) => Math.abs(x - 7) < AREA + 15 && Math.abs(z - 7) < AREA + 15);
    let n = 0;
    for (const b of (osm && osm.b) || []) {
      const ring = b && b.p;
      if (!Array.isArray(ring) || ring.length < 3 || !near(ring)) continue;
      const c = polyCentroid(ring);
      if (inLot(c.x, c.z)) continue;
      for (let i = 0; i < ring.length - 1; i++) { addSeg(ring[i], ring[i + 1], 0.2, -15, 60); n++; }
    }
    for (const w of (osm && osm.bar) || []) {
      const line = w && w.p;
      if (!Array.isArray(line) || line.length < 2 || !near(line) || line.some(([x, z]) => inLot(x, z))) continue;
      for (let i = 0; i < line.length - 1; i++) addSeg(line[i], line[i + 1], 0.15, -15, 1.6);
    }
    return n;
  }
  const CELL = 2;
  function cellKey(i, j) { return i * 4096 + j; }
  function buildGrid() {
    grid = new Map();
    for (const sg of SEGS) {
      const ex = sg.ax + sg.ux * sg.L, ez = sg.az + sg.uz * sg.L, pad = sg.ht + 1.0;
      const i0 = Math.floor((Math.min(sg.ax, ex) - pad) / CELL), i1 = Math.floor((Math.max(sg.ax, ex) + pad) / CELL);
      const j0 = Math.floor((Math.min(sg.az, ez) - pad) / CELL), j1 = Math.floor((Math.max(sg.az, ez) + pad) / CELL);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const k = cellKey(i, j);
        let a = grid.get(k); if (!a) grid.set(k, a = []);
        a.push(sg);
      }
    }
  }
  const NONE = [];
  function segsAt(x, z) {
    if (!grid) buildGrid();
    return grid.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL))) || NONE;
  }
  const activeAt = (sg, fy) => sg.wy0 < fy + BODY_HI && sg.wy1 > fy + BODY_LO && (!sg.cond || sg.cond());
  function resolve(p, fy) {
    const segs = segsAt(p.x, p.z);
    for (let it = 0; it < 4; it++) {
      let moved = false;
      for (let i = 0; i < segs.length; i++) { const sg = segs[i]; if (activeAt(sg, fy) && pushOut(p, sg, RADIUS)) moved = true; }
      if (!moved) break;
    }
    return p;
  }
  function clearance(x, z, fidOrY) {
    const fy = typeof fidOrY === 'number' ? fidOrY : LEVEL_Y[fidOrY] ?? feetY;
    let m = Infinity;
    for (const sg of segsAt(x, z)) if (sg.wy0 < fy + BODY_HI && sg.wy1 > fy + BODY_LO) m = Math.min(m, segDist(x, z, sg));
    return m;
  }

  buildSegs();

  // ── ground model: every walkable surface at a plan point; you stand on the highest one within reach ──
  let envGround = null;
  const rampY = (z) => {
    if (building && typeof building.rampY === 'function') { try { const y = building.rampY(z); if (Number.isFinite(y)) return y; } catch (e) { /* */ } }
    const zs = 16.9, ys = RAMP.yTop - (RAMP.zTop - zs) * 0.04;
    if (z >= zs) return RAMP.yTop - (RAMP.zTop - z) * 0.04;
    return Math.max(RAMP.yBottom, ys - (zs - z) * RAMP.slope);
  };
  const inRamp = (x, z) => x > RAMP_X[0] && x < RAMP_X[1] && z > RAMP.zBottom && z < LOT.zFront;
  const inFoot = (x, z) => pointInPoly(x, z, FOOTPRINT);
  function extGround(x, z) {
    if (x >= LOT.x0 && x <= LOT.x1 && z >= LOT.zRear && z <= LOT.zFront) {
      if (z > 14.7) {
        if (x > PATH_X[0] && x < PATH_X[1]) return z <= 15.5 ? 0 : STREET_Y * (z - 15.5) / (LOT.zFront - 15.5);
        return STREET_Y;
      }
      return -0.12;                                   // gardens & side yard
    }
    if (z > LOT.zFront - 0.01 && z < 31 && Math.abs(x - 7) < 45) return STREET_Y;   // pavements + Rua Eduardo Couto
    if (envGround) { try { const y = envGround(x, z); if (Number.isFinite(y) && y > -40) return y; } catch (e) { /* */ } }
    return z > LOT.zFront ? STREET_Y : -0.12;
  }
  const SURF = [];                 // scratch list reused by every query
  const stepP = { x: 0, z: 0 };    // scratch point for collision steps
  function surfaces(x, z) {
    const out = SURF; out.length = 0;
    if (Math.abs(x - 7) > AREA || Math.abs(z - 7) > AREA) return out;
    const ramp = inRamp(x, z), foot = inFoot(x, z);
    if (inStairBox(x, z)) pushStairHeights(out, x, z);
    else {
      if (ramp) out.push(rampY(z));
      else if (pointInPoly(x, z, BASE_POLY)) out.push(LEVEL_Y.basement);
      if (foot) {
        if (!(x > 9.55 && z > 9.2)) out.push(LEVEL_Y.ground);   // no ground slab over the ramp void
        out.push(LEVEL_Y.first, LEVEL_Y.second);
      }
    }
    if (!foot) {
      for (let i = 0; i < BALCONIES.length; i++) { const b = BALCONIES[i]; if (pointInPoly(x, z, b.poly)) out.push(b.deck ? 0 : LEVEL_Y[b.level]); }
      if (!ramp) out.push(extGround(x, z));
    }
    return out;
  }
  function pickSurface(cands, ref, up) {
    let best = null;
    for (let i = 0; i < cands.length; i++) { const c = cands[i]; if (c <= ref + up && (best === null || c > best)) best = c; }
    return best;
  }
  function surfaceAt(x, z, ref, up = STEP_TOL) { return pickSurface(surfaces(x, z), ref, up); }
  function floorOf(x, z, h) {
    if (!inFoot(x, z) && !inRamp(x, z) && !(h < -1.4 && pointInPoly(x, z, BASE_POLY))) {
      for (let i = 0; i < BALCONIES.length; i++) { const b = BALCONIES[i]; if (!b.deck && pointInPoly(x, z, b.poly) && Math.abs(LEVEL_Y[b.level] - h) < 0.3) return b.level; }
      return 'ground';
    }
    return nearestFloorId(h);
  }
  function inRegion(x, z, fid) {     // a slab of that level exists here (helpers & mini-map)
    const y = LEVEL_Y[fid];
    const c = surfaces(x, z);
    for (let i = 0; i < c.length; i++) if (Math.abs(c[i] - y) < 0.3) return true;
    return false;
  }
  const inCabArea = (x, z) => x < LIFT.x1 - 0.02 && x > LIFT.x0 - 0.3 && z > LIFT.z0 && z < LIFT.z1;
  const playerInCab = () => inCabArea(pos.x, pos.z);

  // ── float-down (stepping out of a window with nothing beneath) ──
  let fall = null;
  function startFall(to, dx, dz) {
    const drop = feetY - to;
    const l = Math.hypot(dx, dz) || 1;
    fall = { y0: feetY, y1: to, t: 0, dur: drop > 1.5 ? 1.5 : clamp(0.35 + drop * 0.45, 0.4, 1.5), dx: dx / l, dz: dz / l, drift: drop > 1.5 ? 0.55 : 0.25 };
    auto = null; vel.x = vel.z = 0;
  }
  function stepFall(dt) {
    const f = fall;
    const u0 = clamp(f.t / f.dur, 0, 1);
    f.t += dt;
    const u = clamp(f.t / f.dur, 0, 1);
    // drift away from the façade while descending, as long as we stay above the same landing surface
    const dd = f.drift * (easeInOut(u) - easeInOut(u0));
    if (dd > 0) {
      const nx = pos.x + f.dx * dd, nz = pos.z + f.dz * dd;
      const h = pickSurface(surfaces(nx, nz), f.y1, 0.05);
      if (h !== null && Math.abs(h - f.y1) < 0.05) { stepP.x = nx; stepP.z = nz; resolve(stepP, f.y1); pos.x = stepP.x; pos.z = stepP.z; }
    }
    feetY = f.y0 + (f.y1 - f.y0) * easeInOut(u);
    eyeY = feetY + EYE;
    if (u >= 1) { feetY = f.y1; floorId = floorOf(pos.x, pos.z, feetY); fall = null; }
  }

  function tryStep(nx, nz) {
    stepP.x = nx; stepP.z = nz;
    const p = resolve(stepP, feetY);
    const entering = !inFoot(pos.x, pos.z) && inFoot(p.x, p.z);
    const h = surfaceAt(p.x, p.z, feetY, entering ? ENTER_STEP : STEP_TOL);
    if (h === null) return false;
    // never enter the shaft unless the cab is here with open doors
    if (inCabArea(p.x, p.z) && !inCabArea(pos.x, pos.z) && !(cabLevel === nearestFloorId(h) && liftDoor > 0.7)) return false;
    const px = p.x, pz = p.z, dx = px - pos.x, dz = pz - pos.z;
    pos.x = px; pos.z = pz;
    if (h < feetY - DROP_TOL) { startFall(h, dx, dz); return 'fall'; }
    feetY = h; floorId = floorOf(px, pz, h);
    return true;
  }
  function moveBy(dx, dz) {
    const len = Math.hypot(dx, dz);
    if (len < 1e-7 || fall) return 0;
    const n = Math.max(1, Math.ceil(len / 0.06));
    const sx = dx / n, sz = dz / n;
    let moved = 0;
    for (let i = 0; i < n; i++) {
      const ox = pos.x, oz = pos.z;
      let r = tryStep(pos.x + sx, pos.z + sz);
      if (!r) r = (Math.abs(sx) > 1e-6 && tryStep(pos.x + sx, pos.z)) || (Math.abs(sz) > 1e-6 && tryStep(pos.x, pos.z + sz));
      if (!r) break;
      moved += Math.hypot(pos.x - ox, pos.z - oz);
      if (r === 'fall') break;
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
  function placeAt(x, z, fid, refY) {
    floorId = fid; feetY = refY != null ? refY : LEVEL_Y[fid];
    fall = null;
    const h = surfaceAt(x, z, feetY + 0.05, 0.3);
    if (h !== null) feetY = h;
    const p = resolve({ x, z }, feetY);
    pos.x = p.x; pos.z = p.z;
    floorId = floorOf(pos.x, pos.z, feetY);
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
    const ref = (Number.isFinite(position.y) ? position.y : EYE) - EYE;
    placeAt(position.x, position.z, nearestFloorId(ref), ref);
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

  let noiseBuf = null;
  const waters = new Map();          // key → { src, g } running water loops
  function noise() {
    if (!noiseBuf) {
      const n = Math.floor(audio.sampleRate * 2);
      noiseBuf = audio.createBuffer(1, n, audio.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    }
    const src = audio.createBufferSource();
    src.buffer = noiseBuf; src.loop = true;
    return src;
  }
  function stopWater(key) {
    const w = waters.get(key);
    if (!w) return;
    waters.delete(key);
    try {
      const now = audio.currentTime;
      w.g.gain.cancelScheduledValues(now); w.g.gain.setValueAtTime(Math.max(0.0001, w.g.gain.value), now);
      w.g.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
      w.src.stop(now + 0.35);
    } catch (e) { /* */ }
  }
  // kind: 'water' (loop; on=false stops it) | 'flush' | 'door' | 'drawer' | 'click' | 'lift'. Only sounds after a user gesture.
  function playSound(kind, on = true, key = kind) {
    lastSound = kind + (kind === 'water' ? (on ? ':on' : ':off') : '');
    if (kind === 'water' && !on) { stopWater(key); return true; }
    if (!audio || audio.state !== 'running') return false;
    try {
      const now = audio.currentTime, out = audio.destination;
      if (kind === 'lift') { chime('arrive'); return true; }
      if (kind === 'water') {
        if (waters.has(key)) return true;
        if (waters.size >= 3) stopWater(waters.keys().next().value);
        const src = noise(), hp = audio.createBiquadFilter(), bp = audio.createBiquadFilter(), g = audio.createGain();
        hp.type = 'highpass'; hp.frequency.value = 700;
        bp.type = 'bandpass'; bp.frequency.value = 2600; bp.Q.value = 0.5;
        g.gain.setValueAtTime(0.0001, now); g.gain.exponentialRampToValueAtTime(0.05, now + 0.35);
        src.connect(hp); hp.connect(bp); bp.connect(g); g.connect(out);
        src.start(now, Math.random());
        waters.set(key, { src, g });
        return true;
      }
      if (kind === 'flush') {
        const src = noise(), lp = audio.createBiquadFilter(), g = audio.createGain();
        lp.type = 'lowpass'; lp.Q.value = 2.5;
        lp.frequency.setValueAtTime(3200, now); lp.frequency.exponentialRampToValueAtTime(900, now + 0.9); lp.frequency.exponentialRampToValueAtTime(220, now + 2.5);
        g.gain.setValueAtTime(0.0001, now); g.gain.exponentialRampToValueAtTime(0.13, now + 0.12);
        g.gain.setValueAtTime(0.11, now + 1.2); g.gain.exponentialRampToValueAtTime(0.0001, now + 2.5);
        src.connect(lp); lp.connect(g); g.connect(out);
        src.start(now, Math.random()); src.stop(now + 2.6);
        return true;
      }
      if (kind === 'click') {
        const o = audio.createOscillator(), g = audio.createGain();
        o.type = 'triangle'; o.frequency.setValueAtTime(1900, now); o.frequency.exponentialRampToValueAtTime(900, now + 0.03);
        g.gain.setValueAtTime(0.05, now); g.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
        o.connect(g); g.connect(out); o.start(now); o.stop(now + 0.06);
        return true;
      }
      // 'door' / 'drawer': soft thud (+ a short slide for drawers)
      const drawer = kind === 'drawer';
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(drawer ? 140 : 95, now + (drawer ? 0.16 : 0)); o.frequency.exponentialRampToValueAtTime(drawer ? 80 : 52, now + (drawer ? 0.3 : 0.16));
      g.gain.setValueAtTime(0.0001, now); g.gain.setValueAtTime(drawer ? 0.07 : 0.13, now + (drawer ? 0.16 : 0.001)); g.gain.exponentialRampToValueAtTime(0.0001, now + (drawer ? 0.34 : 0.22));
      o.connect(g); g.connect(out); o.start(now); o.stop(now + 0.4);
      const src = noise(), f = audio.createBiquadFilter(), ng = audio.createGain();
      f.type = drawer ? 'bandpass' : 'lowpass'; f.frequency.value = drawer ? 650 : 800; f.Q.value = drawer ? 1.2 : 0.7;
      ng.gain.setValueAtTime(0.0001, now); ng.gain.exponentialRampToValueAtTime(drawer ? 0.03 : 0.04, now + 0.012);
      ng.gain.exponentialRampToValueAtTime(0.0001, now + (drawer ? 0.2 : 0.07));
      src.connect(f); f.connect(ng); ng.connect(out); src.start(now, Math.random()); src.stop(now + 0.3);
      return true;
    } catch (e) { return false; }
  }
  let lastSound = '';

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
    h.label = label;
    h.floor = el('div', 'vw-cap'); h.room = el('div', 'vw-room'); h.unit = el('div', 'vw-unit');
    h.room.dir = 'auto';
    label.append(h.floor, h.room, h.unit);
    // hint
    h.hint = el('div', 'vw-hint vw-glass');
    h.chip = el('div', 'vw-hint vw-chip vw-glass');
    h.chip.dir = 'auto';
    // pad
    const pad = el('div', 'vw-pad');
    const padGrid = el('div', 'vw-padgrid');
    pad.append(padGrid);
    // press-and-hold button: reacts on touchstart / pointerdown / mousedown (never waits for a click)
    const mk = (cls, icon, key) => {
      const b = el('button', 'vw-btn ' + cls, ICON[icon]);
      b.type = 'button';
      b.dataset.k = key;
      const down = (e) => { if (e.cancelable) e.preventDefault(); poke(); hudIn[key] = true; b.classList.add('vw-down'); };
      const up = (e) => { if (e && e.type === 'touchend' && e.cancelable) e.preventDefault(); hudIn[key] = false; b.classList.remove('vw-down'); unlockAudio(); };
      b.addEventListener('touchstart', down, { passive: false });
      b.addEventListener('touchend', up, { passive: false });
      b.addEventListener('touchcancel', up);
      b.addEventListener('pointerdown', down);
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
      b.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') up(e); });
      b.addEventListener('mousedown', down);
      b.addEventListener('mouseup', up);
      b.addEventListener('contextmenu', (e) => e.preventDefault());
      return b;
    };
    // one-shot button: fires on touchend (no 300 ms click delay), click is the fallback
    const fast = (b, fn) => {
      let at = -1e9, tx = 0, ty = 0;
      b.addEventListener('touchstart', (e) => { const t = e.changedTouches[0]; tx = t.clientX; ty = t.clientY; poke(); }, { passive: true });
      b.addEventListener('touchend', (e) => {
        const t = e.changedTouches[0];
        if (Math.hypot(t.clientX - tx, t.clientY - ty) > 24) return;
        if (e.cancelable) e.preventDefault();
        at = performance.now(); unlockAudio(); fn(e);
      }, { passive: false });
      b.addEventListener('click', (e) => { e.stopPropagation(); if (performance.now() - at < 700) return; unlockAudio(); fn(e); });
    };
    h.fast = fast;
    h.pad = { fwd: mk('vw-fwd', 'aup', 'fwd'), left: mk('vw-left', 'aleft', 'left'), back: mk('vw-back', 'adown', 'back'), right: mk('vw-right', 'aright', 'right'),
      lup: mk('vw-lup', 'lookup', 'lup'), ldown: mk('vw-ldown', 'lookdown', 'ldown'), sl: mk('vw-sl', 'stepl', 'sl'), sr: mk('vw-sr', 'stepr', 'sr') };
    padGrid.append(h.pad.fwd, h.pad.left, el('span', 'vw-padhub'), h.pad.right, h.pad.back);
    // map + second cluster (bottom-right): look up / down, step left / right, plan and eye in the corners
    const mapWrap = el('div', 'vw-mapwrap');
    h.mapPanel = el('div', 'vw-map vw-glass');
    h.mapCap = el('div', 'vw-cap');
    h.canvas = el('canvas');
    h.mapPanel.append(h.canvas, h.mapCap);
    h.mapBtn = el('button', 'vw-btn vw-maptoggle');
    h.mapBtn.type = 'button';
    h.mapBtn.setAttribute('aria-pressed', 'false');
    fast(h.mapBtn, () => setMapOpen(!mapOpen));
    h.canvas.addEventListener('pointerdown', onMapPointer);
    h.eye = el('button', 'vw-btn vw-eye', ICON.eye);
    h.eye.type = 'button';
    fast(h.eye, () => setControlsVisible(uiHidden));
    const pad2 = el('div', 'vw-padgrid vw-pad2');
    pad2.append(h.eye, h.pad.lup, h.mapBtn, h.pad.sl, el('span', 'vw-padhub'), h.pad.sr, h.pad.ldown);
    mapWrap.append(h.mapPanel, pad2);
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
      fast(b, () => ride(id));
      h.liftBtns.set(id, b);
      btns.append(b);
    }
    const ud = el('div', 'vw-lift-ud');
    h.liftUp = el('button', 'vw-btn', ICON.up); h.liftUp.type = 'button';
    h.liftDown = el('button', 'vw-btn', ICON.down); h.liftDown.type = 'button';
    fast(h.liftUp, () => stepFloor(1));
    fast(h.liftDown, () => stepFloor(-1));
    ud.append(h.liftUp, h.liftDown);
    lp.append(h.liftHead, ind, btns, ud);
    h.lift = lp;
    root.append(label, h.hint, h.chip, pad, mapWrap, lp);
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
    hud.mapBtn.innerHTML = ICON.plan;
    hud.pad.fwd.setAttribute('aria-label', tr('fwd'));
    hud.pad.back.setAttribute('aria-label', tr('back'));
    hud.pad.left.setAttribute('aria-label', tr('left'));
    hud.pad.right.setAttribute('aria-label', tr('right'));
    hud.pad.lup.setAttribute('aria-label', tr('lookUp'));
    hud.pad.ldown.setAttribute('aria-label', tr('lookDown'));
    hud.pad.sl.setAttribute('aria-label', tr('stepL'));
    hud.pad.sr.setAttribute('aria-label', tr('stepR'));
    for (const k in hud.pad) hud.pad[k].title = hud.pad[k].getAttribute('aria-label');
    hud.mapBtn.setAttribute('aria-label', tr('plan'));
    hud.eye.setAttribute('aria-label', tr(uiHidden ? 'showUi' : 'hideUi'));
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
  let lastLabelKey = '', labelUntil = 0;
  // ── compact (phone) mode, idle fade, hide-all ──
  let compactForce = null, compact = false, uiHidden = false, lastPoke = 0, mapOpenedAt = 0;
  function isCompactAuto() {
    if (typeof window === 'undefined') return false;
    const w = (overlay && overlay.clientWidth) || window.innerWidth, h = (overlay && overlay.clientHeight) || window.innerHeight;
    return coarse && Math.min(w, h) < 600;
  }
  function applyCompact() {
    compact = compactForce != null ? compactForce : isCompactAuto();
    if (hud.root) hud.root.classList.toggle('vw-compact', compact);
    mapKey = '';
  }
  function setCompact(v) { compactForce = v == null ? null : !!v; applyCompact(); }
  function setControlsVisible(v) {
    uiHidden = !v;
    if (!hud.root) return;
    hud.root.classList.toggle('vw-hide', uiHidden);
    hud.eye.innerHTML = uiHidden ? ICON.eyeoff : ICON.eye;
    hud.eye.setAttribute('aria-label', tr(uiHidden ? 'showUi' : 'hideUi'));
    hud.eye.setAttribute('aria-pressed', String(uiHidden));
    if (!uiHidden) { poke(); labelUntil = clock + 3; }
  }
  function poke() { lastPoke = clock; }
  function stepHudFade() {
    if (!hud.root) return;
    if (hudIn.fwd || hudIn.back || hudIn.left || hudIn.right || hudIn.lup || hudIn.ldown || hudIn.sl || hudIn.sr) lastPoke = clock;
    hud.root.classList.toggle('vw-idle', compact && clock - lastPoke > 2.5);
    hud.label.classList.toggle('vw-show', !compact || clock < labelUntil);
    if (compact && mapOpen && clock - mapOpenedAt > 8) setMapOpen(false);   // the plan never lingers over the view
  }
  function updateLabel(st) {
    if (!hud.root) return;
    const l = lang();
    const key = [l, st.floorId, st.roomId, st.unitId, st.inLift].join('|');
    if (key === lastLabelKey) return;
    lastLabelKey = key;
    labelUntil = clock + 3;
    const f = FLOOR_BY_ID[st.floorId];
    hud.floor.textContent = (f.label[l] || f.label.en) + ' · ' + f.level.label;
    let name = '';
    if (st.inLift) name = tr('lift');
    else if (st.room) name = st.room.name ? (st.room.name[l] || st.room.name.en) : '';
    hud.room.textContent = name || ' ';
    hud.unit.textContent = st.unitId ? tr('apartment') + ' \u2066' + st.unitId + '\u2069' : '';
    hud.mapCap.textContent = (f.label[l] || f.label.en);
  }
  function updateLiftPanel() {
    if (!hud.root) return;
    const show = playerInCab() && (!job || job.carry || !job.moving);
    hud.lift.classList.toggle('vw-open', !!show);
    hud.root.classList.toggle('vw-inlift', !!show);
    if (show && compact && hintTimer > 0) hideHint();
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
    mapOpen = !!v; mapOpenedAt = clock;
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
    const maxW = compact ? 150 : 220, maxH = compact ? 160 : 230;
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
    const px = clamp(ox + pos.x * s, 8, mapXf.cw - 8), pz = clamp(oz + pos.z * s, 26, mapXf.ch - 8);   // outside: pinned to the edge
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
    const h = surfaceAt(x, z, feetY + 0.05, 0.3);
    if (h === null || Math.abs(h - feetY) > 0.6 || clearance(x, z, h) < RADIUS * 0.8 || inCabArea(x, z)) return;
    const keepYaw = yaw, keepPitch = pitch;
    placeAt(x, z, fid, h);
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
    ring.material.color.setRGB(1, 1, 1);
    ringFade = 0; ringShake = 0;
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
  // ── tap-to-interact (CONTRACT4: obj.userData.interact = { id, kind, label, toggle(), isOn(), range, sound }) ──
  // A small cached list of interactable roots (collected every 2 s or when flagged dirty); picking tests their bounding
  // spheres first and only then raycasts that one object — never the whole scene.
  const inter = { list: [], byObj: new Map(), at: -1e9, dirty: true, stamp: 0 };
  const _box = new THREE.Box3(), _sph = new THREE.Sphere(), _hits = [], _v = new THREE.Vector3();
  const _cRay = new THREE.Ray();
  const DOORISH = new Set(['door', 'garage', 'window', 'wardrobe']);
  const SOUND_OF = { door: 'door', garage: 'door', window: 'door', wardrobe: 'door', cabinet: 'door', fridge: 'door', oven: 'door', dishwasher: 'door', mailbox: 'door',
    drawer: 'drawer', tap: 'water', shower: 'water', 'toilet-flush': 'flush', 'toilet-lid': 'click', lamp: 'click', tv: 'click', curtain: 'drawer', 'lift-call': 'click', 'lift-button': 'click' };
  function sphereOf(e) {
    try {
      _box.setFromObject(e.obj);
      if (_box.isEmpty()) { e.obj.getWorldPosition(e.c); e.r = 0.4; }
      else { _box.getBoundingSphere(_sph); e.c.copy(_sph.center); e.r = Math.max(0.08, _sph.radius); }
    } catch (err) { e.r = 0.5; }
  }
  function isUnder(o, root) { for (let a = o; a; a = a.parent) if (a === root) return true; return false; }
  function matchDoor(e) {       // an interactable that is one of building.doors → walk.js drives it (collision + auto-open stay in sync)
    const it = e.it;
    for (let i = 0; i < doorRecs.length; i++) {
      const r = doorRecs[i], d = r.d;
      if (it.id != null && it.id === d.id) return r;
      if (d.pivot && d.pivot.isObject3D && isUnder(e.obj, d.pivot)) return r;
      if (d.leaf && d.leaf.isObject3D && isUnder(e.obj, d.leaf)) return r;
    }
    if (it.kind === 'door' || it.kind === 'garage') {
      for (let i = 0; i < doorRecs.length; i++) {
        const r = doorRecs[i];
        if (Math.hypot(e.c.x - r.cx, e.c.z - r.cz) < 0.7 && e.c.y > r.y - 0.3 && e.c.y < r.y + 2.8) return r;
      }
    }
    return null;
  }
  function interEntry(obj, it, rec) {
    let e = inter.byObj.get(obj);
    if (!e) {
      e = { obj, it, rec: rec || null, c: new THREE.Vector3(), r: 0.5, stamp: 0, synth: false };
      inter.byObj.set(obj, e);
      sphereOf(e);
      if (!e.rec) e.rec = matchDoor(e);
    }
    e.it = it; e.stamp = inter.stamp;
    inter.list.push(e);
    return e;
  }
  function visitInter(o) {
    const it = o.userData && o.userData.interact;
    if (it && typeof it === 'object' && (typeof it.toggle === 'function' || o.userData.liftButton != null)) interEntry(o, it, null);
  }
  function hasInterAround(o) {
    for (let a = o; a; a = a.parent) if (a.userData && a.userData.interact) return true;
    return false;
  }
  function refreshInteractables() {
    inter.stamp++; inter.list.length = 0; inter.at = clock; inter.dirty = false;
    if (scene && scene.userData) scene.userData.interactDirty = false;
    try { if (scene) scene.traverse(visitInter); } catch (e) { /* guard */ }
    // every building door is tappable even when its owner did not tag it
    for (let i = 0; i < doorRecs.length; i++) {
      const r = doorRecs[i], pv = r.d.pivot;
      if (!pv || !pv.isObject3D) continue;
      let tagged = hasInterAround(pv) || !!(r.d.leaf && r.d.leaf.isObject3D && hasInterAround(r.d.leaf));
      for (let k = 0; k < inter.list.length && !tagged; k++) if (inter.list[k].rec === r) tagged = true;
      if (tagged) continue;
      if (!r.synth) r.synth = { id: 'door:' + r.d.id, kind: r.d.kind === 'garage' ? 'garage' : 'door', range: r.d.kind === 'door' ? 3.5 : 4.5, toggle() {}, isOn: () => r.target > 0.5 };
      const e = interEntry(pv, r.synth, r);
      e.synth = true;
    }
    if (inter.byObj.size > inter.list.length + 64) for (const [o, e] of inter.byObj) if (e.stamp !== inter.stamp) inter.byObj.delete(o);
    return inter.list.length;
  }
  const markInterDirty = () => { inter.dirty = true; };
  function visibleChain(o) { for (let a = o; a; a = a.parent) if (a.visible === false) return false; return true; }
  // is the straight line from the eye blocked by a wall / closed door / slab before `dist`?
  function occluded(ox, oy, oz, dx, dy, dz, dist, isDoor) {
    const end = dist - 0.15;
    for (let t = 0.25; t < end; t += 0.12) {
      const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t;
      if (inFoot(x, z) && (y < feetY - 0.06 || y > feetY + 2.95)) return true;
      const segs = segsAt(x, z);
      for (let i = 0; i < segs.length; i++) {
        const sg = segs[i];
        if (sg.ht < 0.04 || sg.wy0 > y || sg.wy1 < y || (sg.cond && (isDoor || !sg.cond()))) continue;
        if (segDist(x, z, sg) < 0.01) return true;
      }
    }
    return false;
  }
  const rangeOf = (e) => (Number.isFinite(e.it.range) ? e.it.range : DOORISH.has(e.it.kind) ? 3.5 : 2.6);
  // precise = raycast the candidate objects (gestures only); otherwise spheres only (cheap; centre-of-screen hint)
  function pickInteract(ray, precise) {
    if (inter.dirty || clock - inter.at > 2) refreshInteractables();
    const o = ray.origin, d = ray.direction;
    let best = null, bd = Infinity;
    for (let i = 0; i < inter.list.length; i++) {
      const e = inter.list[i];
      const range = rangeOf(e);
      const ex = e.c.x - o.x, ey = e.c.y - o.y, ez = e.c.z - o.z;
      if (Math.sqrt(ex * ex + ey * ey + ez * ez) - e.r > range + 0.6 || !visibleChain(e.obj)) continue;
      let dist;
      if (precise) {
        sphereOf(e);                                   // animated parts move: refresh just this one
        _sph.center.copy(e.c); _sph.radius = e.r + 0.02;
        if (!ray.intersectsSphere(_sph)) continue;
        _hits.length = 0;
        raycaster.ray.copy(ray); raycaster.near = 0; raycaster.far = range + 0.05;
        try { raycaster.intersectObject(e.obj, true, _hits); } catch (err) { continue; }
        dist = Infinity;
        for (let k = 0; k < _hits.length; k++) {       // nearest hit that belongs to this interactable (not to a nested one)
          let owner = null;
          for (let a = _hits[k].object; a; a = a.parent) { if (a === e.obj) { owner = e.obj; break; } if (a.userData && a.userData.interact) { owner = a; break; } }
          if (owner === e.obj) { dist = _hits[k].distance; break; }
        }
        _hits.length = 0;
      } else {
        const t = ex * d.x + ey * d.y + ez * d.z;
        if (t < 0.15) continue;
        const px = d.x * t - ex, py = d.y * t - ey, pz = d.z * t - ez;
        const rr = Math.min(e.r * 0.75, 0.6);
        if (px * px + py * py + pz * pz > rr * rr) continue;
        dist = Math.max(0.1, t - e.r * 0.5);
      }
      if (dist > range || dist >= bd) continue;
      if (occluded(o.x, o.y, o.z, d.x, d.y, d.z, dist, !!e.rec)) continue;
      bd = dist; best = e;
    }
    raycaster.far = 40;
    return best;
  }
  function labelOf(e) {
    if (e.rec && (e.synth || !e.it.label)) return tr(e.rec.d.kind === 'garage' ? 'garageDoor' : e.rec.target > 0.5 ? 'closeDoor' : 'openDoor');
    const lb = e.it.label;
    if (!lb) return '';
    return typeof lb === 'string' ? lb : (lb[rawLang()] || lb[lang()] || lb.en || '');
  }
  let chipUntil = 0, hoverE = null, lastInteract = null;
  function showChip(text, sec) {
    if (!hud.chip || !text) return;
    if (hud.chip.textContent !== text) hud.chip.textContent = text;
    hud.chip.classList.add('vw-on');
    chipUntil = clock + sec;
    hideHint();
  }
  function doInteract(e) {
    const it = e.it, obj = e.obj;
    const kind = it.kind || 'click';
    let on = true;
    lastInteract = it.id != null ? it.id : kind;
    const lb = obj.userData && obj.userData.liftButton;
    if (lb != null && normFloor(lb)) {                   // 3D lift panel button → ride (walk.js owns the lift)
      showChip(labelOf(e), 1.4);
      ride(normFloor(lb));
      return true;
    }
    if (e.rec) {                                         // a building door: toggle + hold, collision stays in sync
      const r = e.rec, label = labelOf(e);
      r.target = r.target > 0.5 ? 0 : 1; r.hold = DOOR_HOLD;
      playSound('door');
      showChip(label, 1.4);
      hoverE = e;
      return true;
    }
    if (kind === 'lift-call') {                          // landing call button → bring the cab to that floor
      const cf = normFloor(obj.userData.liftCall) || floorId;
      showChip(labelOf(e), 1.4);
      playSound('click');
      if (!job && !jobs.length && cabLevel !== cf) enqueue(cf, false);
      return true;
    }
    const label = labelOf(e);
    try { if (typeof it.toggle === 'function') it.toggle(); } catch (err) { /* an owner's error must not break walking */ }
    try { on = typeof it.isOn === 'function' ? !!it.isOn() : true; } catch (err) { on = true; }
    const snd = it.sound || SOUND_OF[kind] || 'click';
    if (snd === 'water') playSound('water', on, 'w:' + (it.id != null ? it.id : obj.uuid));
    else if (snd !== 'none') playSound(snd);
    showChip(label, 1.6);
    hoverE = e;
    return true;
  }
  // screen point → world ray without allocating
  const _ndc = new THREE.Vector2(), _tapRay = new THREE.Ray();
  function rayAt(clientX, clientY, out) {
    const r = dom.getBoundingClientRect();
    _ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    applyCamera();
    raycaster.setFromCamera(_ndc, camera);
    return out.copy(raycaster.ray);
  }
  const pending = { e: null, at: 0 };          // single tap waiting for the double-tap window to pass
  function stepInteract() {
    if (pending.e && performance.now() - pending.at >= DOUBLE_MS) { const e = pending.e; pending.e = null; doInteract(e); }
  }
  function stepHover() {                       // ~4 Hz: "tap to open" chip when the screen centre is over something in reach
    if (hud.chip && chipUntil && clock > chipUntil) { hud.chip.classList.remove('vw-on'); chipUntil = 0; }
    if (uiHidden || fall || (job && job.moving)) return;
    _cRay.origin.set(pos.x, eyeY, pos.z);
    const cp = Math.cos(pitch);
    _cRay.direction.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
    const e = pickInteract(_cRay, false);
    if (e !== hoverE) {
      hoverE = e;
      if (e) { const lb = labelOf(e); if (lb) showChip(tr('tap') + ' · ' + lb, 2.4); }
    }
  }

  // Double-tap / double-click ANYWHERE: always walk forward 2.5 m along the current view direction (projected on the
  // floor). The tapped point only biases the heading when it lies on the floor within 60° of the view direction.
  // Collision slides along walls and passes through openings; if fully blocked the ring shakes — never "nothing".
  function walkToScreen(clientX, clientY) {
    if ((job && job.carry) || fall) return false;
    let hx = -Math.sin(yaw), hz = -Math.cos(yaw);
    if (Number.isFinite(clientX) && Number.isFinite(clientY)) {
      const d = rayAt(clientX, clientY, _tapRay).direction;
      const hl = Math.hypot(d.x, d.z);
      if (d.y < -0.02 && hl > 0.05) {
        const bx = d.x / hl, bz = d.z / hl;
        if (bx * hx + bz * hz >= 0.5) { hx = bx; hz = bz; }
      }
    }
    return walkTo(pos.x + hx * TAP_WALK, pos.z + hz * TAP_WALK);
  }
  function walkTo(x, z, yHint) {
    if ((job && job.carry) || fall) return false;
    auto = { x, z, stuck: 0, sx: pos.x, sz: pos.z, best: 0 };
    const sy = surfaceAt(x, z, yHint != null ? yHint : feetY, 0.6);
    showRing(x, sy != null && sy > feetY - DROP_TOL ? sy : feetY, z);
    return true;
  }
  let ringShake = 0, ringBase = null;
  function shakeRing() {
    if (!ring || !ring.visible) {
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      showRing(pos.x + fx * 0.9, feetY, pos.z + fz * 0.9);
    }
    ringBase = ring ? ring.position.clone() : null;
    ringShake = 0.45; ringFade = 0;
  }
  function stepRing(dt) {
    if (!ring || !ring.visible) return;
    if (ringShake > 0 && ringBase) {
      ringShake = Math.max(0, ringShake - dt);
      const k = ringShake / 0.45;
      const rx = Math.cos(yaw), rz = -Math.sin(yaw);
      const off = reduceMotion ? 0 : Math.sin(ringShake * 70) * 0.06 * k;
      ring.position.set(ringBase.x + rx * off, ringBase.y, ringBase.z + rz * off);
      ring.material.color.setRGB(1, 1 - 0.45 * k, 1 - 0.55 * k);
      ring.material.opacity = 0.85;
      if (ringShake === 0) { ring.material.color.setRGB(1, 1, 1); ringFade = 0.001; }
      return;
    }
    if (ringFade > 0 || !auto) {
      ringFade += dt;
      ring.material.opacity = Math.max(0, 0.85 * (1 - ringFade / 0.5));
      if (ringFade >= 0.5) hideRing();
    }
  }

  // ── input ──
  // Bullet-proof for iOS webviews: everything is listened for on `window` in the CAPTURE phase while enabled, from
  // three independent event families — touch events, pointer events, mouse events (+ click / dblclick as a last
  // resort). One gesture has one "source"; touch events win over touch-pointers when both arrive; nothing depends on
  // pointer capture or on event.target (real controls are skipped with closest()); a lost touchend / pointerup is
  // healed by the next touchstart / pointerdown.
  const lastTap = { t: -1e9, x: 0, y: 0 };
  const LOOK_K = () => 0.0036 * ((camera.fov || 60) / 60);
  function on(target, type, fn, opts) { target.addEventListener(type, fn, opts); listeners.push([target, type, fn, opts]); }
  const TAP_MS = 700, TAP_MOVE = 16, TAP_PX = 40;      // a tap: < 16 px travel, < 700 ms; double tap: < 400 ms, < 40 px apart
  let inputRoot = null;
  function pickInputRoot() {
    let r = overlay && overlay.parentElement;
    while (r && dom && !r.contains(dom)) r = r.parentElement;
    return r || (dom && dom.parentElement) || dom;
  }
  const CONTROL_SEL = 'button,a,input,select,textarea,label,summary,[role=button],[role=slider],[role=dialog],dialog,[contenteditable],.vw-map,[data-walk-ui],[data-walk-ignore]';
  function isControl(t) {
    if (t && t.nodeType === 3) t = t.parentElement;
    return !!(t && t.closest && t.closest(CONTROL_SEL));
  }
  const _rect = { l: 0, t: 0, r: 0, b: 0, at: -1 };
  function inView(x, y) {            // inside the canvas rectangle (cached ~4×/s)
    const now = performance.now();
    if (now - _rect.at > 250) { const r = dom.getBoundingClientRect(); _rect.l = r.left; _rect.t = r.top; _rect.r = r.right; _rect.b = r.bottom; _rect.at = now; }
    return x >= _rect.l && x <= _rect.r && y >= _rect.t && y <= _rect.b;
  }

  // diagnostics (ring buffer, no allocations while logging)
  const dbg = { on: false, el: null, ev: [], i: 0, n: 0, lastT: 0, gest: '', gestN: 0, fps: 0, fN: 0, fT: 0, corner: 0, cornerT: 0, src: '' };
  for (let i = 0; i < 6; i++) dbg.ev.push({ type: '', tag: '', dt: 0, n: 0 });
  function logEv(e, n) {
    const now = performance.now(), r = dbg.ev[dbg.i];
    const t = e.target;
    r.type = e.type + (e.pointerType ? ':' + e.pointerType : ''); r.tag = t && t.tagName ? t.tagName.toLowerCase() : '?'; r.dt = dbg.lastT ? Math.round(now - dbg.lastT) : 0; r.n = n;
    dbg.lastT = now; dbg.i = (dbg.i + 1) % 6; dbg.n++;
  }
  function gesture(name) { dbg.gest = name; dbg.gestN++; }
  function setDebug(v) {
    dbg.on = !!v;
    if (!hud.root) return;
    if (dbg.on && !dbg.el) { dbg.el = el('pre', 'vw-debug'); hud.root.appendChild(dbg.el); }
    if (dbg.el) dbg.el.style.display = dbg.on ? 'block' : 'none';
    if (dbg.on) renderDebug();
  }
  function renderDebug() {
    if (!dbg.on || !dbg.el) return;
    let s = 'walk debug · fps ' + dbg.fps + ' · upd ' + perf.avg.toFixed(2) + ' ms\n' +
      'PE ' + (typeof window.PointerEvent === 'function' ? 1 : 0) + ' TE ' + ('ontouchstart' in window ? 1 : 0) + ' mtp ' + (navigator.maxTouchPoints || 0) + ' · src ' + (dbg.src || '-') + ' · ' + (window.top !== window ? 'iframe' : 'top') + '\n' +
      'gesture #' + dbg.gestN + ': ' + (dbg.gest || '-') + '\n' +
      'pos ' + pos.x.toFixed(1) + ',' + pos.z.toFixed(1) + ' y ' + feetY.toFixed(2) + ' yaw ' + (yaw * 57.3).toFixed(0) + '°\n';
    for (let k = 0; k < 6; k++) { const r = dbg.ev[(dbg.i + k) % 6]; if (r.type) s += r.type + ' <' + r.tag + '> +' + r.dt + 'ms' + (r.n ? ' n' + r.n : '') + '\n'; }
    dbg.el.textContent = s;
  }

  // double tap / dblclick: ALWAYS walk forward (see walkToScreen); single tap: toggles an interactable in reach once
  // the double-tap window has passed, so the first tap of a double tap never opens anything
  let lastTapAt = -1e9, lastWalkAt = -1e9, lastEndAt = -1e9;   // used to ignore the click / dblclick that follows a handled gesture
  function handleTap(x, y, now) {
    lastTapAt = performance.now();
    // five quick taps in the top-left corner toggle the diagnostic overlay
    if (x < _rect.l + 90 && y < _rect.t + 90) {
      if (now - dbg.cornerT > 3000) { dbg.corner = 0; dbg.cornerT = now; }
      if (++dbg.corner >= 5) { dbg.corner = 0; setDebug(!dbg.on); }
    }
    if (now - lastTap.t < DOUBLE_MS && Math.hypot(x - lastTap.x, y - lastTap.y) < TAP_PX) {
      lastTap.t = -1e9; pending.e = null; lastWalkAt = now;
      gesture('double-tap → walk');
      if (!walkToScreen(x, y)) shakeRing();
      return true;
    }
    gesture('tap');
    lastTap.t = now; lastTap.x = x; lastTap.y = y;
    const e = pickInteract(rayAt(x, y, _tapRay), true);
    if (e) { pending.e = e; pending.at = performance.now(); return false; }
    pending.e = null;
    const fid = pickPanel(x, y);            // lift panel buttons that carry no interact tag
    if (fid) { ride(fid); lastTap.t = -1e9; }
    return false;
  }
  let dragMode = 'follow';           // 'follow': the view turns towards the drag (drag right → look right, drag up → look up); 'grab': the scene follows the finger
  function setDragMode(m) { dragMode = m === 'grab' ? 'grab' : 'follow'; return dragMode; }
  const drag = { lastT: 0, vx: 0, vy: 0 };
  function lookBy(dx, dy) {
    const k = LOOK_K() * (dragMode === 'follow' ? -1 : 1);
    yaw += dx * k;
    pitch = clamp(pitch + dy * k, PITCH_MIN, PITCH_MAX);
    const now = performance.now(), dtm = Math.max(4, now - drag.lastT) / 1000;
    drag.lastT = now;
    drag.vx = drag.vx * 0.6 + (dx * k / dtm) * 0.4;
    drag.vy = drag.vy * 0.6 + (dy * k / dtm) * 0.4;
  }
  function lookStart() { drag.lastT = performance.now(); drag.vx = drag.vy = 0; yawVel = pitchVel = 0; }
  function lookEnd(movedPx) {
    if (performance.now() - drag.lastT < 80 && movedPx > 8) { yawVel = clamp(drag.vx, -6, 6); pitchVel = clamp(drag.vy, -4, 4); }
  }

  // ── one gesture state for all event families ──
  // G.src: which family owns the current gesture ('touch' | 'pointer' | 'mouse'); G.n: contacts now; G.maxN: most at once
  const G = { src: '', n: 0, maxN: 0, sx: 0, sy: 0, cx: 0, cy: 0, pd: 0, t0: 0, lastT: 0, moved: 0, pinch: 0, ptype: '' };
  const pts = new Map();             // pointer family: pointerId → {x, y}
  const ptPool = [];
  function gReset() { G.src = ''; G.n = 0; G.maxN = 0; G.moved = 0; G.pinch = 0; for (const p of pts.values()) ptPool.push(p); pts.clear(); }
  const stamp = (e) => (e && e.timeStamp > 0 ? e.timeStamp : performance.now());   // event time: immune to slow handlers
  function gBegin(src, x, y, n, ptype, ts) {         // first contact of a gesture
    G.src = src; G.n = n; G.maxN = n; G.sx = G.cx = x; G.sy = G.cy = y; G.pd = 0; G.moved = 0; G.pinch = 0; G.ptype = ptype || src;
    G.t0 = ts; G.lastT = performance.now();
    dbg.src = src;
    lookStart(); hideHint(); poke();
    if (dom) dom.style.cursor = 'grabbing';
  }
  function gRebase(cx, cy, pd, n) { G.cx = cx; G.cy = cy; G.pd = pd; G.n = n; if (n > G.maxN) G.maxN = n; G.lastT = performance.now(); }
  function gMove(cx, cy, pd) {                       // centroid moved (1 finger: look; 2 fingers: turn + pinch walk)
    const dx = cx - G.cx, dy = cy - G.cy;
    G.cx = cx; G.cy = cy; G.lastT = performance.now();
    G.moved = Math.max(G.moved, Math.hypot(cx - G.sx, cy - G.sy));
    if (G.n >= 2) {
      const dd = pd - G.pd; G.pd = pd;
      G.pinch += Math.abs(dd);
      if (G.moved > TAP_MOVE || G.pinch > TAP_MOVE) {
        lookBy(dx, dy);
        if (Math.abs(dd) > 0.01 && !fall && !(job && job.carry)) {    // pinch out = forward, pinch in = back
          const m = clamp(dd * 0.012, -0.25, 0.25);
          auto = null; moveBy(-Math.sin(yaw) * m, -Math.cos(yaw) * m);
        }
      }
    } else lookBy(dx, dy);
  }
  function gEnd(x, y, cancelled, ts) {               // last contact lifted
    const dur = ts - G.t0, moved = G.moved, maxN = G.maxN, pinch = G.pinch;
    gReset(); lastEndAt = performance.now();
    unlockAudio();                                   // touchend / pointerup / mouseup count as user activation (touchstart does not on iOS)
    if (dom) dom.style.cursor = 'grab';
    if (cancelled) { lastTap.t = -1e9; pending.e = null; gesture('cancel'); return false; }
    if (maxN >= 2) {
      lastTap.t = -1e9; pending.e = null;
      if (moved < TAP_MOVE && pinch < TAP_MOVE && dur < 500) { gesture('two-finger tap'); if (uiHidden) setControlsVisible(true); }
      else gesture(pinch > moved ? 'pinch → move' : 'two-finger drag → turn');
      return false;
    }
    if (moved < TAP_MOVE && dur < TAP_MS) return handleTap(x, y, ts);
    lookEnd(moved);
    lastTap.t = -1e9; pending.e = null;                // a drag is never a tap
    gesture('drag → look');
    return false;
  }

  // touch events
  function touchGeom(tl) {            // centroid + spread of the current touches → G-ready numbers in _tg
    let cx = 0, cy = 0;
    const n = tl.length;
    for (let i = 0; i < n; i++) { cx += tl[i].clientX; cy += tl[i].clientY; }
    _tg.cx = cx / (n || 1); _tg.cy = cy / (n || 1);
    _tg.pd = n >= 2 ? Math.hypot(tl[0].clientX - tl[1].clientX, tl[0].clientY - tl[1].clientY) : 0;
  }
  const _tg = { cx: 0, cy: 0, pd: 0 };
  function onTouchStart(e) {
    logEv(e, e.touches.length);
    const t0 = e.changedTouches[0];
    const fresh = e.touches.length === e.changedTouches.length;        // no older finger is still down
    if (G.src === 'touch' && !fresh) {                                  // one more finger joins
      if (e.cancelable) e.preventDefault();
      touchGeom(e.touches); gRebase(_tg.cx, _tg.cy, _tg.pd, e.touches.length);
      return;
    }
    if (isControl(e.target) || !t0 || !inView(t0.clientX, t0.clientY)) { if (G.src === 'touch') gReset(); return; }
    if (e.cancelable) e.preventDefault();       // no double-tap zoom, no scroll, no synthetic mouse events
    touchGeom(e.touches);
    if (G.src === 'pointer' && G.ptype === 'touch' && performance.now() - G.t0 < 700) {   // same finger already seen as a pointer: touch takes over
      G.src = 'touch'; dbg.src = 'touch'; for (const p of pts.values()) ptPool.push(p); pts.clear();
      gRebase(_tg.cx, _tg.cy, _tg.pd, e.touches.length);
      return;
    }
    // a fresh touch always starts clean — this also heals a lost touchend / pointerup
    gBegin('touch', _tg.cx, _tg.cy, e.touches.length, 'touch', stamp(e));
    G.pd = _tg.pd;
  }
  function onTouchMove(e) {
    if (G.src !== 'touch') return;
    if (e.cancelable) e.preventDefault();        // the page / webview never scrolls or zooms while walking
    touchGeom(e.touches);
    if (e.touches.length !== G.n) { gRebase(_tg.cx, _tg.cy, _tg.pd, e.touches.length); return; }
    gMove(_tg.cx, _tg.cy, _tg.pd);
  }
  function onTouchEnd(e) {
    logEv(e, e.touches.length);
    if (G.src !== 'touch') return;
    if (e.cancelable) e.preventDefault();
    if (e.touches.length > 0) { touchGeom(e.touches); gRebase(_tg.cx, _tg.cy, _tg.pd, e.touches.length); return; }
    const t = e.changedTouches[0];
    gEnd(t ? t.clientX : G.cx, t ? t.clientY : G.cy, e.type === 'touchcancel', stamp(e));
  }

  // pointer events (mouse, pen, and touch when no touch events arrive)
  function ptrGeom() {
    let cx = 0, cy = 0, n = 0, ax = 0, ay = 0, pd = 0;
    for (const p of pts.values()) { cx += p.x; cy += p.y; if (n === 0) { ax = p.x; ay = p.y; } else if (n === 1) pd = Math.hypot(p.x - ax, p.y - ay); n++; }
    _tg.cx = cx / (n || 1); _tg.cy = cy / (n || 1); _tg.pd = pd;
  }
  function onPointerDown(e) {
    logEv(e, 0);
    poke();
    if (G.src === 'touch' || G.src === 'mouse') return;
    if (e.pointerType === 'mouse' && e.button > 0) return;
    const now = performance.now();
    if (G.src === 'pointer' && (pts.has(e.pointerId) || e.isPrimary || now - G.lastT > 1200)) gReset();   // stale gesture (lost pointerup)
    if (G.src !== 'pointer') {
      if (isControl(e.target) || !inView(e.clientX, e.clientY)) return;
      const p = ptPool.pop() || { x: 0, y: 0 }; p.x = e.clientX; p.y = e.clientY; pts.set(e.pointerId, p);
      gBegin('pointer', e.clientX, e.clientY, 1, e.pointerType || 'mouse', stamp(e));
      return;
    }
    const p = ptPool.pop() || { x: 0, y: 0 }; p.x = e.clientX; p.y = e.clientY; pts.set(e.pointerId, p);
    ptrGeom(); gRebase(_tg.cx, _tg.cy, _tg.pd, pts.size);
  }
  function onPointerMove(e) {
    if (G.src !== 'pointer') return;
    const p = pts.get(e.pointerId);
    if (!p) return;
    if (e.pointerType === 'mouse' && e.buttons === 0) { onPointerUp(e); return; }   // released outside the window
    p.x = e.clientX; p.y = e.clientY;
    ptrGeom(); gMove(_tg.cx, _tg.cy, _tg.pd);
  }
  function onPointerUp(e) {
    if (e.type !== 'pointermove') logEv(e, 0);
    if (G.src !== 'pointer' || !pts.has(e.pointerId)) return;
    ptPool.push(pts.get(e.pointerId)); pts.delete(e.pointerId);
    if (pts.size > 0) { ptrGeom(); gRebase(_tg.cx, _tg.cy, _tg.pd, pts.size); return; }
    gEnd(e.clientX, e.clientY, e.type === 'pointercancel', stamp(e));
  }

  // mouse events — only where PointerEvent does not exist
  const NO_PE = typeof window === 'undefined' || typeof window.PointerEvent !== 'function';
  function onMouseDown(e) {
    logEv(e, 0);
    if (!NO_PE || G.src === 'touch' || e.button > 0 || performance.now() - lastEndAt < 500) return;
    if (isControl(e.target) || !inView(e.clientX, e.clientY)) return;
    gBegin('mouse', e.clientX, e.clientY, 1, 'mouse', stamp(e));
  }
  function onMouseMove(e) { if (G.src === 'mouse') { if (e.buttons === 0) gEnd(e.clientX, e.clientY, false, stamp(e)); else gMove(e.clientX, e.clientY, 0); } }
  function onMouseUp(e) { logEv(e, 0); if (G.src === 'mouse') gEnd(e.clientX, e.clientY, false, stamp(e)); }

  // click / dblclick: last-resort tap sources (when the end of a gesture never reached us)
  function onClick(e) {
    logEv(e, 0);
    if (isControl(e.target) || !inView(e.clientX, e.clientY)) return;
    const now = performance.now();
    if (now - lastEndAt > 700 && !G.src) { unlockAudio(); handleTap(e.clientX, e.clientY, stamp(e)); }   // no gesture end reached us for this tap
  }
  function onDblClick(e) {
    logEv(e, 0);
    if (isControl(e.target) || !inView(e.clientX, e.clientY)) return;
    e.preventDefault();
    const now = performance.now();
    if (now - lastWalkAt > 700) { lastWalkAt = now; lastTap.t = -1e9; pending.e = null; gesture('dblclick → walk'); if (!walkToScreen(e.clientX, e.clientY)) shakeRing(); }
  }
  function onGesture(e) { logEv(e, 0); if (inView(e.clientX || _rect.l + 1, e.clientY || _rect.t + 1) || G.src) e.preventDefault(); }
  function onCtxMenu(e) { if (!isControl(e.target) && inView(e.clientX, e.clientY)) e.preventDefault(); }
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

  const padLit = { fwd: false, back: false, left: false, right: false, lup: false, ldown: false, sl: false, sr: false };
  function litKey(k, on) { if (padLit[k] !== on) { padLit[k] = on; hud.pad[k].classList.toggle('vw-down', on); } }
  function syncPadHighlight() {
    if (!hud.pad) return;
    litKey('fwd', keys.has('f') || hudIn.fwd); litKey('back', keys.has('b') || hudIn.back);
    litKey('left', keys.has('tl') || hudIn.left); litKey('right', keys.has('tr') || hudIn.right);
    litKey('lup', keys.has('lu') || hudIn.lup); litKey('ldown', keys.has('ld') || hudIn.ldown);
    litKey('sl', keys.has('sl') || hudIn.sl); litKey('sr', keys.has('sr') || hudIn.sr);
  }
  function hideHint() { if (hud.hint) hud.hint.classList.remove('vw-on'); hintTimer = 0; }

  // ── state emission ──
  const changeCbs = [];
  function locate() {
    const f = FLOOR_BY_ID[floorId];
    const inLift = playerInCab();
    let room = null, unitId = null, roomId = null;
    if (inLift) room = f.rooms.find(r => r.use === 'lift') || null;
    const outside = !inFoot(pos.x, pos.z) && !(floorId === 'basement' && pointInPoly(pos.x, pos.z, BASE_POLY));
    if (!room && !outside) room = f.rooms.find(r => r.use !== 'garden' && r.use !== 'ramp' && pointInPoly(pos.x, pos.z, r.poly)) || null;
    if (!room) {
      const b = balconiesOf(floorId).find(bb => pointInPoly(pos.x, pos.z, bb.poly));
      if (b) {
        const units = b.unit || [];
        unitId = units.length > 1 && b.split != null ? (pos.x < b.split ? units[0] : units[1]) : units[0] || null;
        room = { id: b.id, unit: unitId, name: nameOf(b) };
      }
    }
    if (!room) room = f.rooms.find(r => r.use === 'garden' && pointInPoly(pos.x, pos.z, r.poly)) || null;
    if (!room) room = f.rooms.find(r => r.use === 'ramp' && pointInPoly(pos.x, pos.z, r.poly)) || null;
    if (!room && outside) room = { id: 'outside', unit: null, name: { en: T.en.outside, pt: T.pt.outside, he: T.he.outside } };
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
  let doorOpening = false;      // a door right in front of us is on its way open → an auto-walk waits instead of giving up
  function stepDoors(dt) {
    const riding = job && job.carry && job.moving;
    doorOpening = false;
    for (let i = 0; i < doorRecs.length; i++) {
      const r = doorRecs[i];
      const near = Math.abs(feetY - r.y) < 1.4, d = Math.hypot(pos.x - r.cx, pos.z - r.cz);
      if (r.hold > 0) r.hold -= dt;                                  // tapped: keep that state for a while
      else {
        const same = !riding && near;
        if (same && d < r.near) r.target = 1;
        else if (!r.interior && (!same || d > r.far)) r.target = 0;   // interior doors stay open once open
      }
      if (r.t < 0.5 && r.target === 1 && near && d < 1.3) doorOpening = true;
      if (r.t !== r.target) {
        r.t = approach(r.t, r.target, dt / r.time);
        try { r.d.setOpen(smooth(r.t)); } catch (e) { /* guard */ }
      }
    }
  }
  function update(dtIn) {
    const dt = clamp(dtIn || 0, 0, DT_MAX);
    clock += dt;
    if (!enabled) { if (job) stepLift(dt); return; }
    const t0 = performance.now();
    // look inertia
    if (!G.src && (Math.abs(yawVel) > 1e-4 || Math.abs(pitchVel) > 1e-4)) {
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
    const side = (keys.has('sr') || hudIn.sr ? 1 : 0) - (keys.has('sl') || hudIn.sl ? 1 : 0);
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
    if (riding || fall) { dvx = dvz = 0; auto = null; }
    const k = 1 - Math.exp(-dt * 9);
    vel.x += (dvx - vel.x) * k; vel.z += (dvz - vel.z) * k;
    if (!dvx && !dvz && Math.hypot(vel.x, vel.z) < 0.02) vel.x = vel.z = 0;
    const want = Math.hypot(vel.x, vel.z) * dt;
    if (want > 0) {
      const moved = moveBy(vel.x * dt, vel.z * dt);
      if (auto) {
        auto.best = Math.max(auto.best, Math.hypot(pos.x - auto.sx, pos.z - auto.sz));
        if (moved < want * 0.3 && !doorOpening) auto.stuck += dt; else auto.stuck = 0;
        if (auto.stuck > 0.3) {
          const blocked = auto.best < 0.15;
          auto = null; ringFade = 0.001;
          if (blocked) shakeRing();
        }
      }
      if (moved < want * 0.2) { vel.x *= 0.5; vel.z *= 0.5; }
    }
    if (fall) stepFall(dt);
    stepRing(dt);
    stepLift(dt);
    stepDoors(dt);
    // eye height (smooth over stairs; exact while riding)
    if ((job && job.carry && job.moving) || fall) eyeY = feetY + EYE;
    else eyeY += (feetY + EYE - eyeY) * (1 - Math.exp(-dt * 14));
    if (!(job && job.carry && job.moving)) rideSway = 0;
    applyCamera();
    stepInteract();
    // HUD / bookkeeping at a low rate (no per-frame DOM work or allocations): state 8 Hz, plan + hover hint 4 Hz
    if (clock - tickAt >= 0.125 || floorId !== tickFloor) {
      tickAt = clock; tickFloor = floorId; tickN++;
      if (scene && scene.userData && scene.userData.interactDirty) inter.dirty = true;
      const st = emitState(false);
      updateLiftPanel();
      stepHudFade();
      if (tickN & 1) { drawMap(st); stepHover(); if (dbg.on) renderDebug(); }
    } else if (job && job.moving) updateLiftPanel();
    if (hintTimer > 0) { hintTimer -= dt; if (hintTimer <= 0) hideHint(); }
    const tN = performance.now(), ms = tN - t0;
    dbg.fN++; if (tN - dbg.fT >= 1000) { dbg.fps = Math.round(dbg.fN * 1000 / (tN - dbg.fT)); dbg.fN = 0; dbg.fT = tN; }
    perf.n++; perf.avg += (ms - perf.avg) * (perf.n < 30 ? 1 / perf.n : 0.03); if (ms > perf.max) perf.max = ms;
  }
  let tickAt = -1, tickFloor = '', tickN = 0;
  const perf = { avg: 0, max: 0, n: 0 };
  function getPerf() { const r = { avgMs: perf.avg, maxMs: perf.max, frames: perf.n, interactables: inter.list.length, segments: SEGS.length }; perf.max = 0; return r; }
  function goToStreet() {
    let mx = 4.45, mz = 14.7;
    for (let i = 0; i < doorRecs.length; i++) if (doorRecs[i].d.kind === 'main') { mx = doorRecs[i].cx; mz = doorRecs[i].cz; }
    const x = clamp(mx, PATH_X[0] + 0.5, PATH_X[1] - 0.5);
    _v.set(x, STREET_Y + EYE, LOT.zFront + 0.5);
    teleport(_v, { x: mx, y: 1.15, z: mz });
    return true;
  }

  // ── enable / disable ──
  function liftRequest(fid, source) {
    if (!enabled) return false;
    const f = normFloor(fid);
    if (!f) return false;
    if (source === 'landing' || !playerInCab()) { if (!job && !jobs.length && cabLevel !== f) enqueue(f, false); }
    else ride(f);
    return true;
  }
  const saved = {};
  let ctxState = 0;   // 0 = not loaded, 1 = loading, 2 = done
  function loadContext() {
    if (!envGround && scene) {
      const env = scene.getObjectByName && scene.getObjectByName('environment');
      const fn = env && (env.userData.groundY || env.userData.heightAt || env.heightAt);
      if (typeof fn === 'function') envGround = fn;
    }
    if (ctxState) return;
    ctxState = 1;
    if (!envGround) import('./environment.js').then(m => { if (!envGround) envGround = m.groundY || m.heightAt || null; }).catch(() => {});
    try {
      if (typeof fetch !== 'function') return;
      fetch(new URL('../data/osm.json', import.meta.url)).then(r => (r.ok ? r.json() : null)).then(j => { if (j) addContext(j); ctxState = 2; }).catch(() => { ctxState = 2; });
    } catch (e) { ctxState = 2; }
  }

  // Teleport just inside a wall opening, facing inwards. info = { floorId, wallIndex, openingIndex } or a world
  // point (Vector3 / {x,y,z} / {point}) on or near a façade opening. Returns { floorId, x, z } or false.
  function nearestOpening(p) {
    let best = null, bd = 2.5;
    for (const f of FLOORS) {
      const y = f.level.y;
      if (Number.isFinite(p.y) && (p.y < y - 0.6 || p.y > y + 3.0)) continue;
      f.walls.forEach((w, wi) => (w.openings || []).forEach((o, oi) => {
        if (!PASSABLE.has(o.type) || o.type === 'elevator') return;
        const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
        const sg = makeSeg([w.a[0] + (w.b[0] - w.a[0]) * o.from / L, w.a[1] + (w.b[1] - w.a[1]) * o.from / L], [w.a[0] + (w.b[0] - w.a[0]) * o.to / L, w.a[1] + (w.b[1] - w.a[1]) * o.to / L], w.t);
        const d = sg ? segDist(p.x, p.z, sg) : Infinity;
        if (d < bd) { bd = d; best = { f, w, o, wi, oi }; }
      }));
    }
    return best;
  }
  function enterAt(info) {
    if (!info) return false;
    let hit = null;
    if (info.floorId != null && Number.isInteger(info.wallIndex)) {
      const f = FLOOR_BY_ID[normFloor(info.floorId)];
      const w = f && f.walls[info.wallIndex];
      const o = w && w.openings && w.openings[info.openingIndex || 0];
      if (o) hit = { f, w, o };
    } else {
      const p = info.isVector3 || Number.isFinite(info.x) ? info : (info.point || info.position);
      if (p && Number.isFinite(p.x) && Number.isFinite(p.z)) hit = nearestOpening(p);
    }
    if (!hit) return false;
    const { f, w, o } = hit;
    const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    const ux = (w.b[0] - w.a[0]) / L, uz = (w.b[1] - w.a[1]) / L;
    const m = (o.from + o.to) / 2;
    const mx = w.a[0] + ux * m, mz = w.a[1] + uz * m;
    let nx = -uz, nz = ux;
    const inside = (x, z) => (f.id === 'basement' ? pointInPoly(x, z, BASE_POLY) : inFoot(x, z));
    const a = inside(mx + nx * 0.8, mz + nz * 0.8), b = inside(mx - nx * 0.8, mz - nz * 0.8);
    if (a && b) {   // interior wall: enter on the side away from the viewer
      const cx = camera ? camera.position.x : pos.x, cz = camera ? camera.position.z : pos.z;
      if ((cx - mx) * nx + (cz - mz) * nz > 0) { nx = -nx; nz = -nz; }
    } else if (!a) { nx = -nx; nz = -nz; }
    if (job && job.carry) cancelLift();
    placeAt(mx + nx * (w.t / 2 + 0.55), mz + nz * (w.t / 2 + 0.55), f.id);
    lookDir(nx * 4, -0.25, nz * 4);
    applyCamera();
    emitState(true);
    return { floorId: floorId, x: pos.x, z: pos.z };
  }

  function enable() {
    if (enabled) return;
    enabled = true;
    if (dom) {
      inputRoot = pickInputRoot();
      // no scrolling, zooming, text selection or long-press call-outs on the canvas and its container
      saved.styles = [];
      for (const elx of (inputRoot && inputRoot !== dom ? [dom, inputRoot] : [dom])) {
        const st = elx.style;
        saved.styles.push([elx, st.touchAction, st.userSelect, st.webkitUserSelect, st.webkitTouchCallout, st.webkitTapHighlightColor]);
        st.touchAction = 'none'; st.userSelect = 'none'; st.webkitUserSelect = 'none'; st.webkitTouchCallout = 'none'; st.webkitTapHighlightColor = 'transparent';
      }
      saved.cursor = dom.style.cursor; dom.style.cursor = 'grab';
      const W = window, C = { capture: true, passive: false }, CP = { capture: true, passive: true };
      on(W, 'touchstart', onTouchStart, C);
      on(W, 'touchmove', onTouchMove, C);
      on(W, 'touchend', onTouchEnd, C);
      on(W, 'touchcancel', onTouchEnd, C);
      on(W, 'pointerdown', onPointerDown, CP);
      on(W, 'pointermove', onPointerMove, CP);
      on(W, 'pointerup', onPointerUp, CP);
      on(W, 'pointercancel', onPointerUp, CP);
      on(W, 'mousedown', onMouseDown, CP);
      on(W, 'mousemove', onMouseMove, CP);
      on(W, 'mouseup', onMouseUp, CP);
      on(W, 'click', onClick, CP);
      on(W, 'dblclick', onDblClick, C);
      on(W, 'gesturestart', onGesture, C);          // iOS pinch / double-tap zoom
      on(W, 'gesturechange', onGesture, C);
      on(W, 'gestureend', onGesture, C);
      on(W, 'contextmenu', onCtxMenu, C);
      on(dom, 'wheel', onWheel, { passive: false });
      _rect.at = -1;
      let dbgWanted = false;
      try { dbgWanted = /walkdebug/i.test(location.hash + location.search) || /walkdebug/i.test(window.top.location.hash); } catch (e) { /* cross-origin parent */ }
      if (dbgWanted) setDebug(true);
    }
    loadContext();
    on(window, 'keydown', onKeyDown, false);
    on(window, 'keyup', onKeyUp, false);
    on(window, 'blur', onBlur, false);
    on(window, 'resize', applyCompact, { passive: true });
    on(window, 'interact-dirty', markInterDirty, false);
    if (scene && scene.addEventListener) scene.addEventListener('interact-dirty', markInterDirty);
    inter.dirty = true;
    if (camera) { saved.order = camera.rotation.order; }
    if (lift) {
      // BUILDING routes its own lift taps / calls through this hook while we are walking (walk.js performs the ride)
      lift.onRequest = liftRequest;
      if (!job && typeof lift.getState === 'function') {      // pick up where the building's own lift animation left the cab
        try { const y = lift.getState().y; if (Number.isFinite(y)) { cabY = y; cabLevel = nearestFloorId(y); liftInit = false; } } catch (e) { /* */ }
      }
    }
    if (!liftInit) { liftInit = true; setCab(LIFT_Y[cabLevel] ?? cabY, cabLevel); applyLiftDoors(true); }
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
      applyCompact(); poke(); labelUntil = clock + 3;
      let seen = hintSeen;
      try { seen = seen || sessionStorage.getItem('vw-hint') === '1'; } catch (e) { /* storage may be blocked */ }
      if (!seen) {
        hud.hint.classList.add('vw-on'); hintTimer = 4; hintSeen = true;
        try { sessionStorage.setItem('vw-hint', '1'); } catch (e) { /* */ }
      }
    }
    applyCamera();
    emitState('always');
  }
  function disable() {
    if (!enabled) return;
    enabled = false;
    for (const [t, type, fn, opts] of listeners.splice(0)) t.removeEventListener(type, fn, opts);
    onBlur();
    gReset();
    stopMotion();
    for (const [elx, ta, us, wus, wtc, wth] of saved.styles || []) { const st = elx.style; st.touchAction = ta; st.userSelect = us; st.webkitUserSelect = wus; st.webkitTouchCallout = wtc; st.webkitTapHighlightColor = wth; }
    saved.styles = [];
    if (dom) dom.style.cursor = saved.cursor || '';
    fall = null; pending.e = null;
    if (scene && scene.removeEventListener) scene.removeEventListener('interact-dirty', markInterDirty);
    for (const k of Array.from(waters.keys())) stopWater(k);
    if (hud.chip) hud.chip.classList.remove('vw-on');
    if (camera && saved.order) camera.rotation.order = saved.order;
    if (lift && lift.onRequest === liftRequest) lift.onRequest = null;
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
    enterAt,
    setLang(l) { langOverride = l; hoverE = null; refreshHudText(); },
    setMapOpen,
    setCompact, setControlsVisible,
    playSound, refreshInteractables, setDragMode, getPerf, goToStreet, setDebug,
    getDebug() { renderDebug(); return { on: dbg.on, fps: dbg.fps, src: dbg.src, gesture: dbg.gest, gestures: dbg.gestN, events: dbg.n, text: dbg.el ? dbg.el.textContent : '' }; },
    getState() {
      const st = locate();
      return { floorId: st.floorId, roomId: st.roomId, unitId: st.unitId, inLift: st.inLift, x: pos.x, z: pos.z, feetY, eyeY, yaw, pitch, cabY, cabLevel, liftDoor, riding: !!(job && job.moving), autoWalking: !!auto, falling: !!fall, outside: !inFoot(pos.x, pos.z), compact, controlsHidden: uiHidden, dragMode, lastSound, lastInteract, chip: hud.chip && hud.chip.classList.contains('vw-on') ? hud.chip.textContent : '' };
    },
    dispose
  };
}
