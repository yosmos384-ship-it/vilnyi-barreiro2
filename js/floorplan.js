// VILNYI · Barreiro 2 — crisp SVG floor plans drawn from data.js (APP agent).
// drawFloorplan(floorId, opts) => SVG markup string. Plan units are metres × S (S user units per metre).
// Units carry data-unit="<id>" for event delegation.
//   opts: { label(obj) => string, status(unitId) => 'available'|'reserved'|'sold',
//           dim(unitId) => bool, selected: unitId|null, only: unitId|null (unit page: others muted),
//           showRooms: true, showLabels: true, title: string, focus: unitId (adds data-focus / data-full view boxes) }
import { FLOORS, BALCONIES, UNITS, PARKING, floorById, unitById } from './data.js';

export const S = 50;           // user units per metre
const PAD = 1.2;               // metres of margin

export function polyArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, z1] = poly[i], [x2, z2] = poly[(i + 1) % poly.length];
    a += x1 * z2 - x2 * z1;
  }
  return Math.abs(a / 2);
}

export function polyCentroid(poly) {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, z1] = poly[i], [x2, z2] = poly[(i + 1) % poly.length];
    const f = x1 * z2 - x2 * z1;
    a += f; cx += (x1 + x2) * f; cz += (z1 + z2) * f;
  }
  if (Math.abs(a) < 1e-9) return poly[0];
  return [cx / (3 * a), cz / (3 * a)];
}

const s = n => Math.round(n * S * 10) / 10;
const pts = poly => poly.map(([x, z]) => `${s(x)},${s(z)}`).join(' ');
const esc = v => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function bounds(floor) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  const add = ([x, z]) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); };
  for (const w of floor.walls) { add(w.a); add(w.b); }
  for (const r of floor.rooms) r.poly.forEach(add);
  for (const b of BALCONIES.filter(b => b.level === floor.id)) b.poly.forEach(add);
  return { x0, x1, z0, z1 };
}

// Wall pieces between openings, extended by t/2 at the wall's own ends so corners close.
function wallMarkup(w) {
  const [ax, az] = w.a, [bx, bz] = w.b;
  const len = Math.hypot(bx - ax, bz - az);
  if (len < 1e-6) return { solid: '', details: '' };
  const ux = (bx - ax) / len, uz = (bz - az) / len;
  const nx = -uz, nz = ux;
  const h = w.t / 2;
  const ops = [...(w.openings || [])].sort((p, q) => p.from - q.from);
  const pieces = [];
  let d = -h;
  for (const o of ops) {
    if (o.from > d + 1e-3) pieces.push([d, o.from]);
    d = Math.max(d, o.to);
  }
  if (len + h > d + 1e-3) pieces.push([d, len + h]);
  const P = (t, off) => [ax + ux * t + nx * off, az + uz * t + nz * off];
  let solid = '';
  for (const [d0, d1] of pieces) solid += `<polygon points="${pts([P(d0, -h), P(d1, -h), P(d1, h), P(d0, h)])}"/>`;
  let details = '';
  const line = (a, b, cls) => `<line class="${cls}" x1="${s(a[0])}" y1="${s(a[1])}" x2="${s(b[0])}" y2="${s(b[1])}"/>`;
  for (const o of ops) {
    const wdt = o.to - o.from;
    const frame = `<polygon class="fp-win" points="${pts([P(o.from, -h), P(o.to, -h), P(o.to, h), P(o.from, h)])}"/>`;
    if (o.type === 'window' || o.type === 'slit') {
      details += frame + line(P(o.from, 0), P(o.to, 0), 'fp-glass');
    } else if (o.type === 'glassdoor' || o.type === 'main') {
      details += frame
        + line(P(o.from, -h * 0.35), P(o.from + wdt * 0.55, -h * 0.35), 'fp-glass')
        + line(P(o.from + wdt * 0.45, h * 0.35), P(o.to, h * 0.35), 'fp-glass');
    } else if (o.type === 'door' || o.type === 'entry') {
      const hinge = P(o.from, 0);
      const tip = [hinge[0] + nx * wdt, hinge[1] + nz * wdt];
      const end = P(o.to, 0);
      details += line(hinge, tip, 'fp-leaf');
      details += `<path class="fp-arc" d="M${s(tip[0])},${s(tip[1])} A${s(wdt)},${s(wdt)} 0 0 1 ${s(end[0])},${s(end[1])}"/>`;
    } else if (o.type === 'elevator' || o.type === 'garage') {
      details += line(P(o.from, 0), P(o.to, 0), 'fp-leaf');
    }
  }
  return { solid, details };
}

function stairsMarkup(floor) {
  const st = floor.rooms.find(r => r.use === 'stairs');
  if (!st) return '';
  const xs = st.poly.map(p => p[0]), zs = st.poly.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
  const mid = (x0 + x1) / 2;
  let out = `<line class="fp-thin" x1="${s(mid)}" y1="${s(z0 + 0.9)}" x2="${s(mid)}" y2="${s(z1 - 0.9)}"/>`;
  for (let z = z0 + 0.9; z <= z1 - 0.9 + 1e-6; z += 0.28) {
    out += `<line class="fp-thin" x1="${s(x0 + 0.08)}" y1="${s(z)}" x2="${s(x1 - 0.08)}" y2="${s(z)}"/>`;
  }
  return out;
}

function liftMarkup(floor) {
  const l = floor.rooms.find(r => r.use === 'lift');
  if (!l) return '';
  const xs = l.poly.map(p => p[0]), zs = l.poly.map(p => p[1]);
  const x0 = Math.min(...xs) + 0.12, x1 = Math.max(...xs) - 0.12, z0 = Math.min(...zs) + 0.12, z1 = Math.max(...zs) - 0.12;
  return `<rect class="fp-liftbox" x="${s(x0)}" y="${s(z0)}" width="${s(x1 - x0)}" height="${s(z1 - z0)}"/>`
    + `<line class="fp-thin" x1="${s(x0)}" y1="${s(z0)}" x2="${s(x1)}" y2="${s(z1)}"/><line class="fp-thin" x1="${s(x1)}" y1="${s(z0)}" x2="${s(x0)}" y2="${s(z1)}"/>`;
}

export function floorUnits(floorId) {
  return UNITS.filter(u => u.floor === floorId);
}

export function drawFloorplan(floorId, opts = {}) {
  const floor = floorById(floorId);
  if (!floor) return '';
  const label = opts.label || (o => (o && (o.en || o)) || '');
  const status = opts.status || (id => unitById(id)?.status || 'available');
  const dim = opts.dim || (() => false);
  const only = opts.only || null;
  const b = bounds(floor);
  const vb = [s(b.x0 - PAD), s(b.z0 - PAD), s(b.x1 - b.x0 + PAD * 2.4), s(b.z1 - b.z0 + PAD * 2.8)];
  // opts.focus = unitId: the box of that unit (rooms + its balcony / garden) is published as data-focus so the caller can zoom to it
  let focusAttr = '';
  if (opts.focus) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    const add = ([x, z]) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); };
    for (const r of floor.rooms) if (r.unit === opts.focus) r.poly.forEach(add);
    for (const bal of BALCONIES) if (bal.level === floorId && bal.unit.includes(opts.focus)) bal.poly.forEach(add);
    if (Number.isFinite(x0)) {
      const m = 0.8;
      focusAttr = ` data-full="${vb.join(' ')}" data-focus="${[s(x0 - m), s(z0 - m), s(x1 - x0 + 2 * m), s(z1 - z0 + 2 * m)].join(' ')}"`;
    }
  }
  let out = `<svg class="fp"${focusAttr} viewBox="${vb.join(' ')}" role="img" aria-label="${esc(opts.title || label(floor.label))}" preserveAspectRatio="xMidYMid meet">`;

  // balconies / decks / gardens
  for (const bal of BALCONIES.filter(x => x.level === floorId)) {
    const owner = bal.unit.length === 1 ? bal.unit[0] : null;
    const muted = only && !bal.unit.includes(only);
    out += `<polygon class="fp-bal${bal.deck ? ' is-deck' : ''}${muted ? ' is-muted' : ''}${only && !muted ? ' is-only' : ''}" ${owner && !only ? `data-unit="${owner}"` : ''} points="${pts(bal.poly)}"/>`;
    if (bal.split != null) out += `<line class="fp-thin" x1="${s(bal.split)}" y1="${s(bal.poly[0][1])}" x2="${s(bal.split)}" y2="${s(bal.poly[2][1])}"/>`;
  }

  // rooms, grouped by unit
  const byUnit = new Map();
  for (const r of floor.rooms) {
    const k = r.unit || '_common';
    if (!byUnit.has(k)) byUnit.set(k, []);
    byUnit.get(k).push(r);
  }
  for (const [unitId, rooms] of byUnit) {
    if (unitId === '_common') {
      out += `<g class="fp-common">`;
      for (const r of rooms) out += `<polygon class="fp-room is-${r.use}" points="${pts(r.poly)}"/>`;
      out += `</g>`;
      continue;
    }
    const st = status(unitId);
    const cls = ['fp-unit', `st-${st}`];
    if (dim(unitId)) cls.push('is-dim');
    if (opts.selected === unitId) cls.push('is-selected');
    if (only && only !== unitId) cls.push('is-muted');
    if (only === unitId) cls.push('is-only');
    const u = unitById(unitId);
    const interactive = !only;
    out += `<g class="${cls.join(' ')}"${interactive ? ` data-unit="${unitId}" tabindex="0" role="link" aria-label="${esc(`${unitId} · ${u ? u.type : ''}`)}"` : ''}>`;
    for (const r of rooms) out += `<polygon class="fp-room is-${r.use}" data-room="${r.id}" points="${pts(r.poly)}"/>`;
    out += `</g>`;
  }

  out += `<g class="fp-fixtures">${stairsMarkup(floor)}${liftMarkup(floor)}</g>`;

  if (floorId === 'basement') {
    for (const p of PARKING) {
      const mine = only && p.unit === only;
      out += `<rect class="fp-bay${only && !mine ? ' is-muted' : ''}${mine ? ' is-only' : ''}" x="${s(p.x0)}" y="${s(p.z0)}" width="${s(p.x1 - p.x0)}" height="${s(p.z1 - p.z0)}"/>`;
      out += `<text class="fp-baylabel${mine ? ' is-only' : ''}" x="${s((p.x0 + p.x1) / 2)}" y="${s((p.z0 + p.z1) / 2)}">${p.id}</text>`;
    }
  }

  let solid = '', details = '';
  for (const w of floor.walls) { const m = wallMarkup(w); solid += m.solid; details += m.details; }
  out += `<g class="fp-walls">${solid}</g><g class="fp-open">${details}</g>`;

  // room labels (unit view) — names + measured areas
  if (opts.showRooms !== false && only) {
    out += `<g class="fp-roomlabels">`;
    for (const r of floor.rooms) {
      if (r.unit !== only) continue;
      const [cx, cz] = polyCentroid(r.poly);
      const a = polyArea(r.poly);
      const small = a < 3.2;
      out += `<text class="fp-roomname${small ? ' is-small' : ''}" x="${s(cx)}" y="${s(cz - 0.1)}">${esc(label(r.name))}</text>`;
      out += `<text class="fp-roomarea${small ? ' is-small' : ''}" x="${s(cx)}" y="${s(cz + (small ? 0.3 : 0.42))}">${a.toFixed(1)} m²</text>`;
    }
    out += `</g>`;
  }

  // unit badges on the floor overview
  if (opts.showLabels !== false && !only) {
    for (const u of floorUnits(floorId)) {
      const main = floor.rooms.find(r => r.id === u.viewRoom) || floor.rooms.find(r => r.unit === u.id);
      if (!main) continue;
      const [cx, cz] = polyCentroid(main.poly);
      out += `<g class="fp-badge st-${status(u.id)}${dim(u.id) ? ' is-dim' : ''}" data-unit="${u.id}" transform="translate(${s(cx)},${s(cz)})">`
        + `<circle r="${S * 0.95}"/><text class="fp-badge-id" y="${S * 0.08}">${u.id}</text><text class="fp-badge-type" y="${S * 0.52}">${u.type}</text></g>`;
    }
  }

  // north arrow + scale bar (drawing conventions)
  const nx = b.x1 + PAD * 0.7, nz = b.z0 + 0.4;
  out += `<g class="fp-north" transform="translate(${s(nx)},${s(nz)})"><circle r="${S * 0.55}"/><path d="M0,${-S * 0.45} L${S * 0.2},${S * 0.3} L0,${S * 0.18} L${-S * 0.2},${S * 0.3} Z"/><text y="${-S * 0.72}">N</text></g>`;
  const sy = b.z1 + PAD * 1.2, sx = b.x0;
  out += `<g class="fp-scale"><line x1="${s(sx)}" y1="${s(sy)}" x2="${s(sx + 5)}" y2="${s(sy)}"/>`;
  for (let i = 0; i <= 5; i++) out += `<line x1="${s(sx + i)}" y1="${s(sy - (i % 5 === 0 ? 0.24 : 0.13))}" x2="${s(sx + i)}" y2="${s(sy)}"/>`;
  out += `<text x="${s(sx)}" y="${s(sy + 0.6)}">0</text><text x="${s(sx + 5)}" y="${s(sy + 0.6)}">5 m</text></g>`;
  out += `</svg>`;
  return out;
}

// Rooms with measured areas for a unit (from plan polygons) plus its balcony/deck share.
export function unitRoomAreas(unitId) {
  const rows = [];
  for (const f of FLOORS) {
    for (const r of f.rooms) if (r.unit === unitId) rows.push({ ...r, floor: f.id, area: polyArea(r.poly) });
  }
  for (const b of BALCONIES) {
    if (!b.unit.includes(unitId)) continue;
    let a = polyArea(b.poly);
    if (b.split != null) {
      const xs = b.poly.map(p => p[0]), zs = b.poly.map(p => p[1]);
      const left = b.unit.indexOf(unitId) === 0;
      const w = left ? b.split - Math.min(...xs) : Math.max(...xs) - b.split;
      a = w * (Math.max(...zs) - Math.min(...zs));
    }
    rows.push({ id: b.id, unit: unitId, use: b.deck ? 'deck' : 'balcony', area: a, name: null, floor: b.level });
  }
  return rows;
}
