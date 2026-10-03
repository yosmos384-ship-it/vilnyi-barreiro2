// VILNYI · Barreiro 2 — sales app (APP agent).
import {
  PROJECT, BANK, PAYMENT_PLAN, LEVELS, FLOORS, UNITS, STYLES, LANDMARKS, PARKING, BALCONIES, PRICE_PER_M2, TIMES_OF_DAY,
  unitById, floorById
} from './data.js';
import { t, L, setLang, getLang, langInfo, fmtMoney, fmtNum, LANGS, DICTS } from './i18n.js';
import { drawFloorplan, unitRoomAreas, floorUnits } from './floorplan.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } }
};

const RES_FLOORS = ['ground', 'first', 'second'];
const unitToken = id => id.replace('.', '');
const tokenToUnit = tok => { const m = /^(\d)([a-c])$/i.exec(tok || ''); return m ? `${m[1]}.${m[2].toUpperCase()}` : null; };
const styleById = id => STYLES.find(s => s.id === id) || STYLES[0];

// ---------------------------------------------------------------- state
const state = {
  overrides: {},              // unitId -> status from db
  filters: { type: 'all', floor: 'all', max: null, availOnly: false },
  openFloor: null,
  planView: 'plan',
  tod: 'day',                 // light: day · dusk · night (page ↔ 3D ↔ 360° tour ↔ gallery)
  todChosen: false,
  style: {},                  // unitId -> styleId
  res: { unitId: null, styleId: 'atlantic', step: 1, data: {}, ref: null, saved: null },
  db: null, user: null, isOwner: false, canWrite: null,
  landmarks: LANDMARKS,
  mapFocus: null,
  route: ''
};
const statusOf = id => state.overrides[id] || unitById(id)?.status || 'available';
const isAvail = id => statusOf(id) === 'available';
const priceOf = (id, styleId) => (unitById(id)?.price || 0) + (styleById(styleId).extra || 0);
const PRICE_MIN = Math.min(...UNITS.map(u => u.price));
const PRICE_MAX = Math.max(...UNITS.map(u => u.price));
// Price per m² of interior area: the project rate from data.js (falls back to the unit's own ratio).
const ppmOf = u => PRICE_PER_M2 || Math.round(u.price / u.area);
const ppmFmt = (n = PRICE_PER_M2) => `<bdi class="ppm">${fmtMoney(n)} / ${esc(t('misc.m2'))}</bdi>`;
const once = k => { try { if (sessionStorage.getItem(k)) return false; sessionStorage.setItem(k, '1'); return true; } catch (e) { if (once[k]) return false; once[k] = true; return true; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const reducedMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------- utilities
function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
}

function selectText(el) {
  try {
    if (el.select) { el.focus(); el.select(); return; }
    const r = document.createRange(); r.selectNodeContents(el);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  } catch (e) { /* ignore */ }
}

function copyText(text, targetEl, btn) {
  const done = () => { if (btn) { const o = btn.textContent; btn.textContent = t('foot.copied'); setTimeout(() => { btn.textContent = o; }, 1600); } };
  const fail = () => { if (targetEl) selectText(targetEl); toast(t('misc.copyFailed')); };
  try {
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, fail);
    else fail();
  } catch (e) { fail(); }
}

function floorName(id) { return L(floorById(id)?.label); }
function levelMark(id) { return LEVELS[id]?.drawing || ''; }
function areaFmt(n) { return `${fmtNum(n, 2)} ${t('misc.m2')}`; }

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371.0088, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const ICONS = {
  train: 'M7 3h10a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM5 10h14M8.5 13h.01M15.5 13h.01M8 21l2-5M16 21l-2-5',
  ferry: 'M3 15h18l-2.5 5h-13L3 15ZM6 15v-5h12v5M9 10V6h6v4M12 3v3',
  city: 'M3 21h18M5 21V10l5-3v14M10 21V4l6 3v14M16 21V11h3v10',
  bridge: 'M2 17h20M5 17V5M19 17V5M5 6c3 6.5 11 6.5 14 0M9 10.5V17M15 10.5V17M12 11.5V17',
  monument: 'M12 2v4M10 6h4M10.5 6 9 20h6l-1.5-14M6 21h12M8 9l4-1 4 1',
  health: 'M9 3h6v6h6v6h-6v6H9v-6H3V9h6V3Z',
  shopping: 'M5 8h14l-1.2 12H6.2L5 8ZM9 8a3 3 0 0 1 6 0',
  road: 'M8 3 4 21M16 3l4 18M12 4v3M12 11v3M12 18v2',
  airport: 'M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5Z',
  water: 'M2 8c2.5-2 5-2 7.5 0s5 2 7.5 0 3.5-1.5 5 0M2 13c2.5-2 5-2 7.5 0s5 2 7.5 0 3.5-1.5 5 0M2 18c2.5-2 5-2 7.5 0s5 2 7.5 0 3.5-1.5 5 0',
  school: 'M2 9l10-5 10 5-10 5L2 9ZM6 11v5c3.5 2.5 8.5 2.5 12 0v-5M22 9v6',
  park: 'M12 22v-6M7 16h10l-5-8-5 8ZM8.5 11h7L12 4l-3.5 7Z',
  market: 'M4 10h16M5 10l1.5-6h11L19 10M6 10v10h12V10M10 20v-5h4v5',
  pharmacy: 'M9 3h6v6h6v6h-6v6H9v-6H3V9h6V3Z',
  supermarket: 'M3 4h2.5l2.4 11h10.6L21 7H7M10 20h.01M17 20h.01',
  energy: 'M13 2 4 14h7l-1 8 9-12h-7l1-8Z',
  pv: 'M3 18 6 8h12l3 10H3ZM4.5 13h15M9 8l-1 10M15 8l1 10M12 2v3M5 4l1.5 1.5M19 4l-1.5 1.5',
  lift: 'M5 3h14v18H5V3ZM12 3v18M8.5 9 7 11h3L8.5 9ZM15.5 15 14 13h3l-1.5 2Z',
  parking: 'M4 3h16v18H4V3ZM9 17V7h4a3 3 0 0 1 0 6H9',
  mansard: 'M2 20h20M4 20V11l3-7h10l3 7v9M8 20v-5h3v5M14 11h3v3h-3z',
  garden: 'M12 21v-7M12 14c-4 0-6-3-6-6 3 0 6 2 6 6ZM12 12c0-4 2-7 6-7 0 4-2 7-6 7ZM5 21h14'
};
const icon = (k, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[k] || ICONS.city}"/></svg>`;

// ---------------------------------------------------------------- i18n & theme
// Flags are small inline SVGs (20 × 14, rounded by CSS): emoji flags do not render on Windows.
const FLAGS = {
  en: '<rect width="20" height="14" fill="#1f3a7a"/><path d="M0 0l20 14M20 0L0 14" stroke="#fff" stroke-width="2.8"/><path d="M0 0l20 14M20 0L0 14" stroke="#c8202f" stroke-width="1.1"/><path d="M10 0v14M0 7h20" stroke="#fff" stroke-width="4.6"/><path d="M10 0v14M0 7h20" stroke="#c8202f" stroke-width="2.6"/>',
  pt: '<rect width="20" height="14" fill="#d8232a"/><rect width="8" height="14" fill="#1b6b3a"/><circle cx="8" cy="7" r="3.1" fill="#f5c400"/><path d="M6.5 5.2h3v2.4a1.5 1.5 0 0 1-3 0z" fill="#fff" stroke="#d8232a" stroke-width=".7"/>',
  he: '<rect width="20" height="14" fill="#fff"/><rect y="1.6" width="20" height="2" fill="#1d4fb5"/><rect y="10.4" width="20" height="2" fill="#1d4fb5"/><path d="M10 4.5l2.2 3.8H7.8zM10 9.5 7.8 5.7h4.4z" fill="none" stroke="#1d4fb5" stroke-width=".7" stroke-linejoin="round"/>',
  ru: '<rect width="20" height="14" fill="#fff"/><rect y="4.67" width="20" height="4.67" fill="#1c4aa6"/><rect y="9.33" width="20" height="4.67" fill="#d52b1e"/>'
};
const flagSvg = id => `<svg class="flag" viewBox="0 0 20 14" width="20" height="14" aria-hidden="true" focusable="false">${FLAGS[id] || ''}</svg>`;

function renderLangUI() {
  const cur = getLang();
  $('#langFlag').innerHTML = flagSvg(cur);
  $('#langCode').textContent = langInfo().short;
  $('#langMenu').innerHTML = LANGS.map(l => `<button type="button" class="lang-opt" role="menuitemradio" aria-checked="${l.id === cur}" data-lang="${l.id}" tabindex="-1">${flagSvg(l.id)}<bdi lang="${l.id}">${esc(l.name)}</bdi><svg class="tick" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3.2L13 5"/></svg></button>`).join('');
}
function langMenu(open, focus = true) {
  const btn = $('#langBtn'), menu = $('#langMenu');
  if (open === !menu.hidden) return;
  menu.hidden = !open;
  btn.setAttribute('aria-expanded', open);
  if (open && focus) (menu.querySelector('[aria-checked="true"]') || menu.firstElementChild)?.focus();
}
function bindLang() {
  const btn = $('#langBtn'), menu = $('#langMenu');
  btn.addEventListener('click', () => langMenu(menu.hidden));
  btn.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); langMenu(true); }
  });
  menu.addEventListener('click', e => {
    const o = e.target.closest('[data-lang]');
    if (!o) return;
    langMenu(false);
    applyLang(o.dataset.lang);
    btn.focus({ preventScroll: true });
  });
  menu.addEventListener('keydown', e => {
    const items = $$('[data-lang]', menu);
    const i = items.indexOf(document.activeElement);
    const move = n => { e.preventDefault(); items[(n + items.length) % items.length]?.focus(); };
    if (e.key === 'ArrowDown') move(i + 1);
    else if (e.key === 'ArrowUp') move(i - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(items.length - 1);
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); langMenu(false); btn.focus({ preventScroll: true }); }
    else if (e.key === 'Tab') langMenu(false);
  });
  document.addEventListener('pointerdown', e => { if (!menu.hidden && !e.target.closest('#lang')) langMenu(false); });
}

function applyLang(l, rerender = true) {
  setLang(l);
  const info = langInfo();
  const root = document.documentElement;
  root.lang = info.id;
  root.dir = info.dir;
  store.set('vb2.lang', info.id);
  renderLangUI();
  for (const el of $$('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of $$('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  document.title = t('meta.title');
  renderPalette();
  viewerApi?.setLang?.(info.id);
  viewerApi?.setPhotorealLabels?.(ptLabels());
  try { siteMap?.setLang?.(info.id); } catch (e) { /* ignore */ }
  updatePhotorealUI();
  if (rerender) renderAll();
}

// Five colour themes. Each one is a set of CSS tokens in site.css keyed by :root[data-palette]; "night" is the dark theme
// (data-theme="dark"). With nothing chosen the page follows prefers-color-scheme (Stone in light, Night in dark).
const PALETTES = [
  { id: 'stone', a: '#f4f1eb', b: '#8a5a1c' },
  { id: 'sand', a: '#efe3cd', b: '#9a4520' },
  { id: 'sage', a: '#e6ebdf', b: '#2f6144' },
  { id: 'atlantic', a: '#e4eaef', b: '#1d587c' },
  { id: 'night', a: '#151412', b: '#c8964f' }
];
function currentPalette() {
  const root = document.documentElement;
  const p = root.getAttribute('data-palette');
  if (PALETTES.some(x => x.id === p)) return p;
  const th = root.getAttribute('data-theme');
  if (th === 'dark') return 'night';
  if (th === 'light') return 'stone';
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'night' : 'stone';
}
function setPalette(id, save = true) {
  if (!PALETTES.some(x => x.id === id)) return;
  const root = document.documentElement;
  root.setAttribute('data-palette', id);
  root.setAttribute('data-theme', id === 'night' ? 'dark' : 'light');   // also re-themes the location map (it watches data-theme)
  if (save) store.set('vb2.palette', id);
  renderPalette();
}
function renderPalette() {
  const cur = currentPalette();
  for (const host of $$('#palTop, #palMenu')) {
    host.innerHTML = PALETTES.map(p => `<button type="button" class="pal-b" role="radio" aria-checked="${p.id === cur}" tabindex="${p.id === cur ? 0 : -1}" data-palette="${p.id}" style="--sw-a:${p.a};--sw-b:${p.b}" title="${esc(t('theme.' + p.id))}" aria-label="${esc(t('theme.' + p.id))}"></button>`).join('');
  }
}
function initTheme() {
  let saved = store.get('vb2.palette');
  if (!saved) { const old = store.get('vb2.theme'); saved = old === 'dark' ? 'night' : old === 'light' ? 'stone' : null; }
  if (saved && PALETTES.some(x => x.id === saved)) setPalette(saved, false);
  for (const host of $$('#palTop, #palMenu')) {
    host.addEventListener('click', e => {
      const b = e.target.closest('[data-palette]');
      if (!b) return;
      setPalette(b.dataset.palette);
      host.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true });
    });
    host.addEventListener('keydown', e => {
      const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!dir) return;
      e.preventDefault();
      const step = document.documentElement.dir === 'rtl' && /Left|Right/.test(e.key) ? -dir : dir;
      const i = PALETTES.findIndex(x => x.id === currentPalette());
      setPalette(PALETTES[(i + step + PALETTES.length) % PALETTES.length].id);
      host.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true });
    });
  }
  try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => renderPalette()); } catch (e) { /* old browsers */ }
}

// ---------------------------------------------------------------- home: static parts
function renderFacts() {
  const area = UNITS.reduce((s, u) => s + u.area, 0);
  const types = [...new Set(UNITS.map(u => u.type))].sort().join(' · ');
  const items = [
    [UNITS.length, t('hero.fact.units')],
    [types, t('hero.fact.types')],
    [Math.round(area), t('hero.fact.area')],
    [`${PARKING.length} / ${UNITS.length}`, t('hero.fact.parking')],
    [PROJECT.timeline.find(x => x.key === 'keys')?.date || PROJECT.timeline[PROJECT.timeline.length - 1]?.date || '', t('hero.fact.keys')]
  ];
  $('#facts').innerHTML = items.map(([b, s]) => `<li><b>${esc(b)}</b><span>${esc(s)}</span></li>`).join('');
  const avail = UNITS.filter(u => isAvail(u.id));
  const from = Math.min(...(avail.length ? avail : UNITS).map(u => u.price));
  $('#heroPrice').innerHTML = `<span>${esc(t('hero.from'))} <b><bdi>${fmtMoney(from)}</bdi></b></span>${ppmFmt()}`;
}

// Façade floor bands, calibrated to assets/facade-day.jpg (1368 × 1167 px).
const FACADE_BANDS = {
  second: '408,478 440,398 1258,82 1368,214 1368,404 1256,396 1180,402 500,548 496,478',
  first: '496,548 1180,402 1256,396 1368,404 1368,640 1262,642 1190,668 425,748 425,640 496,630',
  ground: '425,748 1190,668 1262,642 1368,640 1368,1167 866,1167 836,1004 408,1004 405,960'
};
const FACADE_TAG = { second: [24, 26], first: [22, 49], ground: [20, 72] }; // % positions (left, top)

const bandPts = f => FACADE_BANDS[f].split(' ').map(p => p.split(',').map(Number));
function bandBox(f) {
  const pts = bandPts(f), xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  return { x0, x1, y0, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

function renderFacade() {
  const svg = $('#facadeSvg');
  const open = state.openFloor;
  // each floor has a clipped, undimmed copy of the photo: the selected floor "lights up" while the rest of the image dims
  svg.innerHTML = `<defs>${RES_FLOORS.map(f => `<clipPath id="flClip-${f}"><polygon points="${FACADE_BANDS[f]}"/></clipPath>`).join('')}</defs>`
    + RES_FLOORS.map(f => `<image class="fl-lit${open === f ? ' is-on' : ''}" data-lit="${f}" href="assets/facade-day.jpg" width="1368" height="1167" preserveAspectRatio="none" clip-path="url(#flClip-${f})"/>`).join('')
    + RES_FLOORS.map(f => `<polygon class="fl-band${open === f ? ' is-on' : ''}" data-floor="${f}" points="${FACADE_BANDS[f]}" tabindex="0" role="button" aria-label="${esc(floorName(f))}"/>`).join('');
  let tags = $('#facadeTags');
  if (!tags) { tags = document.createElement('div'); tags.id = 'facadeTags'; tags.className = 'facade-tags'; $('#facade').insertBefore(tags, $('#facadeTip')); }
  tags.innerHTML = RES_FLOORS.map(f => {
    const us = floorUnits(f);
    const avail = us.filter(u => isAvail(u.id)).length;
    const [x, y] = FACADE_TAG[f];
    return `<button type="button" class="ftag${open === f ? ' is-on' : ''}" data-floor="${f}" style="left:${x}%;top:${y}%"><span class="mono">${levelMark(f)}</span><b>${esc(floorName(f).split(' · ')[0])}</b><em>${avail}/${us.length}</em></button>`;
  }).join('');
}
// Selection state without re-rendering (keeps CSS transitions running).
function syncFloorState() {
  const f = state.openFloor;
  $$('#facadeSvg .fl-band, #facadeSvg .fl-lit, #facadeTags .ftag, #floorList .floor-row').forEach(el => {
    const on = (el.dataset.floor || el.dataset.lit) === f;
    el.classList.toggle('is-on', on);
    if (el.classList.contains('floor-row')) el.setAttribute('aria-expanded', on);
  });
}

function renderFloorList() {
  $('#floorList').innerHTML = [...RES_FLOORS].reverse().map(f => {
    const us = floorUnits(f);
    const avail = us.filter(u => isAvail(u.id));
    const from = avail.length ? Math.min(...avail.map(u => u.price)) : null;
    const types = [...new Set(us.map(u => u.type))].join(' · ');
    return `<li><button type="button" class="floor-row${state.openFloor === f ? ' is-on' : ''}" data-floor="${f}" aria-expanded="${state.openFloor === f}">
      <span class="floor-lvl">${levelMark(f)}</span>
      <span><span class="floor-name">${esc(floorName(f))}</span>
      <span class="floor-meta">${esc(t('sel.units', { n: us.length }))} · ${types}${from ? ` · ${esc(t('sel.from', { p: fmtMoney(from) }))}` : ''}</span></span>
      <span class="floor-dots">${us.map(u => `<i class="dot st-${statusOf(u.id)}" title="${u.id}"></i>`).join('')}</span>
    </button></li>`;
  }).join('');
  $('#legend').innerHTML = ['available', 'reserved', 'sold'].map(s => `<span><i class="dot st-${s}"></i>${esc(t('status.' + s))}</span>`).join('');
}

function matches(u) {
  const f = state.filters;
  if (f.type !== 'all' && u.type !== f.type) return false;
  if (f.floor !== 'all' && u.floor !== f.floor) return false;
  if (f.max != null && u.price > f.max) return false;
  if (f.availOnly && !isAvail(u.id)) return false;
  return true;
}

function renderFilters() {
  const f = state.filters;
  const chip = (group, val, label) => `<button type="button" class="chip" data-fg="${group}" data-fv="${val}" aria-pressed="${f[group] === val}">${esc(label)}</button>`;
  const max = f.max ?? PRICE_MAX;
  const n = UNITS.filter(matches).length;
  $('#filters').innerHTML = `
    <div class="fgroup"><span>${esc(t('filter.type'))}</span><div class="chips">${chip('type', 'all', t('filter.all'))}${chip('type', 'T1', 'T1')}${chip('type', 'T2', 'T2')}</div></div>
    <div class="fgroup"><span>${esc(t('filter.floor'))}</span><div class="chips">${chip('floor', 'all', t('filter.all'))}${RES_FLOORS.map(fl => chip('floor', fl, LEVELS[fl].label)).join('')}</div></div>
    <div class="fgroup"><span>${esc(t('filter.price'))}</span><div class="frange">
      <input type="range" id="fMax" min="${PRICE_MIN}" max="${PRICE_MAX}" step="100" value="${max}" aria-label="${esc(t('filter.price'))}">
      <output id="fMaxOut">${esc(t('filter.upto', { p: fmtMoney(max) }))}</output></div></div>
    <div class="fgroup"><span>&nbsp;</span><div class="chips"><button type="button" class="chip" id="fAvail" aria-pressed="${f.availOnly}">${esc(t('filter.availableOnly'))}</button></div></div>
    <span class="fcount" id="fCount">${esc(t('filter.count', { n }))}</span>`;
}

function renderTable() {
  const rows = UNITS.map(u => {
    const st = statusOf(u.id);
    const out = u.outdoor ? `${fmtNum(u.outdoor, 1)} ${t('misc.m2')} ${t('outdoor.' + u.outdoorKind)}` : '—';
    return `<tr data-unit="${u.id}" class="${matches(u) ? '' : 'is-dim'}">
      <td class="t-id">${u.id}</td>
      <td class="t-floor">${esc(floorName(u.floor))}</td>
      <td class="t-type">${u.type}</td>
      <td class="t-area">${areaFmt(u.area)}</td>
      <td class="t-out">${esc(out)}</td>
      <td class="t-aspect">${u.aspect.join(' · ')}</td>
      <td class="t-price"><bdi>${fmtMoney(u.price)}</bdi><small>${ppmFmt(ppmOf(u))}</small></td>
      <td class="t-ppm">${ppmFmt(ppmOf(u))}</td>
      <td class="t-status"><span class="pill st-${st}">${esc(t('status.' + st))}</span></td>
      <td class="t-go"><a href="#unit-${unitToken(u.id)}" aria-label="${esc(t('unit.apartment', { id: u.id }))}">→</a></td>
    </tr>`;
  }).join('');
  const none = UNITS.filter(matches).length === 0;
  $('#availTable').innerHTML = `<thead><tr>
    <th>${esc(t('table.unit'))}</th><th class="t-floor">${esc(t('table.floor'))}</th><th>${esc(t('table.type'))}</th><th>${esc(t('table.area'))}</th>
    <th class="t-out">${esc(t('table.outdoor'))}</th><th class="t-aspect">${esc(t('table.aspect'))}</th><th>${esc(t('table.price'))}</th><th class="t-ppm">${esc(t('table.perM2'))}</th><th>${esc(t('table.status'))}</th><th class="t-go"></th>
    </tr></thead><tbody>${rows}</tbody>`;
  $('#availNote').innerHTML = none
    ? `<span class="empty">${esc(t('filter.none'))} <button type="button" class="btn btn-line btn-sm" id="fReset">${esc(t('filter.reset'))}</button></span>`
    : `${esc(t('price.perM2Note', { p: `${fmtMoney(PRICE_PER_M2)}` }))} · ${esc(t('hero.note'))}`;
  const fc = $('#fCount'); if (fc) fc.textContent = t('filter.count', { n: UNITS.filter(matches).length });
}

function unitTip(u) {
  const st = statusOf(u.id);
  const out = u.outdoor ? `${fmtNum(u.outdoor, 1)} ${t('misc.m2')} ${t('outdoor.' + u.outdoorKind)}` : '';
  return `<b><bdi>${u.id}</bdi> · <bdi>${u.type}</bdi></b>${areaFmt(u.area)}${out ? ` · ${esc(out)}` : ''}<br><bdi>${fmtMoney(u.price)}</bdi> · ${ppmFmt(ppmOf(u))} <span class="pill st-${st}">${esc(t('status.' + st))}</span>`;
}

// The floor card: a glass card over the façade image (a bottom sheet on phones) with the floor's plan and its apartments.
const sheetMode = () => !!window.matchMedia?.('(max-width: 719px)').matches;
const floorUI = { seq: 0 };

function renderFloorCard() {
  const card = $('#floorCard');
  const f = state.openFloor;
  if (!f || !card) return;
  const floor = floorById(f);
  const us = floorUnits(f);
  const plan = state.planView === 'plan'
    ? drawFloorplan(f, { label: L, status: statusOf, dim: id => !matches(unitById(id)), title: floorName(f) })
    : `<div class="pp-drawing"><img src="${floor.plan}" alt="${esc(t('plan.drawing.alt', { floor: floorName(f) }))}" loading="lazy"></div>`;
  const chips = us.map(u => {
    const st = statusOf(u.id);
    return `<a class="flc-chip${matches(u) ? '' : ' is-dim'}" href="#unit-${unitToken(u.id)}" data-unit="${u.id}" aria-label="${esc(t('unit.apartment', { id: u.id }))} · ${u.type} · ${esc(areaFmt(u.area))} · ${esc(fmtMoney(u.price))} · ${esc(t('status.' + st))}">
      <span class="c-top"><b class="c-id">${u.id}</b><span class="c-type">${u.type}</span><span class="c-go" aria-hidden="true">→</span></span>
      <span class="c-area">${areaFmt(u.area)}</span>
      <span class="c-price"><bdi>${fmtMoney(u.price)}</bdi></span>
      <span class="pill st-${st}">${esc(t('status.' + st))}</span>
    </a>`;
  }).join('');
  card.innerHTML = `
    <div class="flc-grab" aria-hidden="true"></div>
    <header class="flc-head">
      <div class="flc-ttl"><span class="flc-lvl"><bdi class="mono">${levelMark(f)}</bdi>${floorName(f).includes(' · ') ? ` · ${esc(floorName(f).split(' · ').slice(1).join(' · '))}` : ''}</span><h3 id="flcTitle">${esc(floorName(f).split(' · ')[0])}</h3></div>
      <div class="flc-rail" role="group" aria-label="${esc(t('plan.floors'))}">${[...RES_FLOORS].reverse().map(x => `<button type="button" data-floor="${x}" aria-pressed="${x === f}" aria-label="${esc(floorName(x))}" title="${esc(floorName(x))}">${LEVELS[x].label}</button>`).join('')}</div>
      <button type="button" class="icon-btn flc-close" data-act="closePlan" aria-label="${esc(t('plan.close'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    </header>
    <div class="flc-plan" id="ppPlan">${plan}<div class="fp-tip" id="fpTip" hidden></div></div>
    ${us.length ? `<div class="flc-chips">${chips}</div>` : ''}
    <footer class="flc-foot">
      <div class="seg" role="group">
        <button type="button" class="seg-b${state.planView === 'plan' ? ' is-on' : ''}" data-pv="plan">${esc(t('plan.view.plan'))}</button>
        <button type="button" class="seg-b${state.planView === 'drawing' ? ' is-on' : ''}" data-pv="drawing">${esc(t('plan.view.drawing'))}</button>
      </div>
      <span title="${esc(t('price.perM2'))}"><span class="sr">${esc(t('price.perM2'))} </span><b>${ppmFmt()}</b></span>
    </footer>`;
}

// Zoom / pan the façade photo so the selected floor sits in the part of the image the card leaves free.
function focusScene(f) {
  const view = $('#facadeView'), scene = $('#facadeScene');
  if (!view || !scene) return;
  if (!f || !FACADE_BANDS[f]) { scene.style.transform = ''; return; }
  const W = view.clientWidth, H = view.clientHeight;
  if (!W || !H) return;
  const sw = W, sh = W * 1167 / 1368, k = W / 1368;
  const bb = bandBox(f), bx = bb.cx * k, by = bb.cy * k;
  const sheet = sheetMode();
  const s = sheet ? Math.max(1.2, (H / sh) * 1.04) : 1.1;
  const fx = sheet ? W * 0.5 : W * 0.76, fy = H * (sheet ? 0.52 : 0.5);
  // origin 0 0: p → p·s + T; the band centre lands on the focus point, clamped so the photo always covers the view
  const fit = (T, size, viewSize) => { const lo = viewSize - size * s, hi = 0; return lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, T)); };
  const Tx = fit(fx - bx * s, sw, W), Ty = fit(fy - by * s, sh, H);
  scene.style.transformOrigin = '0 0';
  scene.style.transform = `translate(${Tx.toFixed(1)}px, ${Ty.toFixed(1)}px) scale(${s.toFixed(3)})`;
}

// Where the card unfolds from: the band's box, as a clip-path inset of the card.
function bandInset(f, card) {
  const band = $(`#facadeSvg .fl-band[data-floor="${f}"]`);
  const c = card.getBoundingClientRect();
  if (!band || !c.width) return `inset(46% 30% 46% 30% round 12px)`;
  const b = band.getBoundingClientRect();
  let top = Math.max(0, b.top - c.top), bottom = Math.max(0, c.bottom - b.bottom);
  let left = Math.max(0, b.left - c.left), right = Math.max(0, c.right - b.right);
  if (top + bottom > c.height - 24) { const mid = Math.min(c.height - 12, Math.max(12, (b.top + b.bottom) / 2 - c.top)); top = mid - 12; bottom = c.height - mid - 12; }
  if (left + right > c.width - 24) { left = b.left > c.left + c.width / 2 ? c.width - 28 : 0; right = left ? 0 : c.width - 28; }
  return `inset(${top.toFixed(0)}px ${right.toFixed(0)}px ${bottom.toFixed(0)}px ${left.toFixed(0)}px round 10px)`;
}

// The band "lifts off": a tinted copy of its outline flies to the card and dissolves into it.
function bandGhost(f, card, ms) {
  const band = $(`#facadeSvg .fl-band[data-floor="${f}"]`);
  if (!band || !document.body.animate) return;
  const b = band.getBoundingClientRect(), c = card.getBoundingClientRect();
  if (b.width < 8 || b.height < 8 || !c.width) return;
  const bb = bandBox(f);
  const rel = bandPts(f).map(([x, y]) => [(x - bb.x0) / (bb.x1 - bb.x0) * 100, (y - bb.y0) / (bb.y1 - bb.y0) * 100]);
  const out = rel.map(([x, y]) => { const dx = x - 50, dy = y - 50, m = 50 / Math.max(Math.abs(dx), Math.abs(dy), 0.001); return [50 + dx * m, 50 + dy * m]; });
  const poly = a => `polygon(${a.map(([x, y]) => `${x.toFixed(1)}% ${y.toFixed(1)}%`).join(', ')})`;
  const g = document.createElement('div');
  g.className = 'flc-ghost';
  g.style.cssText = `left:${b.left}px;top:${b.top}px;width:${b.width}px;height:${b.height}px;transform-origin:0 0`;
  document.body.appendChild(g);
  const a = g.animate([
    { transform: 'none', clipPath: poly(rel), opacity: 0.8 },
    { opacity: 0.45, offset: 0.6 },
    { transform: `translate(${(c.left - b.left).toFixed(1)}px, ${(c.top - b.top).toFixed(1)}px) scale(${(c.width / b.width).toFixed(3)}, ${(c.height / b.height).toFixed(3)})`, clipPath: poly(out), opacity: 0 }
  ], { duration: ms, easing: 'cubic-bezier(.3, .7, .2, 1)' });
  const done = () => g.remove();
  a.finished.then(done, done);
}

function animateCardIn(f, card) {
  if (reducedMotion() || !card.animate) return;
  const ms = 450, ease = 'cubic-bezier(.2, .75, .2, 1)';
  card.getAnimations?.().forEach(a => a.cancel());
  bandGhost(f, card, ms);
  if (sheetMode()) card.animate([{ transform: 'translateY(104%)' }, { transform: 'none' }], { duration: ms, easing: ease });
  else card.animate([{ clipPath: bandInset(f, card), opacity: 0.35 }, { opacity: 1, offset: 0.5 }, { clipPath: 'inset(0px 0px 0px 0px round 14px)', opacity: 1 }], { duration: ms, easing: ease });
}

function openFloor(f, { animate = true } = {}) {
  const next = RES_FLOORS.includes(f) || f === 'basement' ? f : null;
  if (!next) { closeFloor(animate); return; }
  const facade = $('#facade'), card = $('#floorCard');
  const prev = state.openFloor;
  const seq = ++floorUI.seq;
  if (!$('#sel3d').hidden) setSelView('facade');
  state.openFloor = next;
  renderFloorCard();
  card.hidden = false;
  card.style.transform = '';
  const wasOpen = facade.classList.contains('is-open');
  facade.classList.add('is-open');
  const sheet = sheetMode();
  document.body.classList.toggle('no-scroll', sheet || !$('#imm').hidden || !$('#modal').hidden);
  syncFloorState();
  if (animate && prev !== next) animateCardIn(next, card);
  focusScene(next);
  if (sheet && !wasOpen && animate && !reducedMotion()) facade.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' });
  if (!sheet) {
    // tablet / desktop: the card lives on the façade, so bring the façade into view only if most of it is off screen
    const r = $('#facadeSlot').getBoundingClientRect();
    const visible = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
    if (visible < r.height * 0.6) $('#facadeSlot').scrollIntoView({ behavior: animate && !reducedMotion() ? 'smooth' : 'auto', block: 'center' });
  }
  if (seq === floorUI.seq) (prev && wasOpen ? card.querySelector('.flc-rail [aria-pressed="true"]') : card.querySelector('.flc-close'))?.focus({ preventScroll: true });
}

function closeFloor(animate = true) {
  const f = state.openFloor;
  const facade = $('#facade'), card = $('#floorCard');
  if (!f && card.hidden) return;
  const seq = ++floorUI.seq;
  const sheet = sheetMode();
  const hadFocus = card.contains(document.activeElement);
  state.openFloor = null;
  const finish = () => {
    if (seq !== floorUI.seq) return;
    card.hidden = true; card.innerHTML = ''; card.style.transform = '';
    facade.classList.remove('is-open');
    focusScene(null);
    if ($('#imm').hidden && $('#modal').hidden) document.body.classList.remove('no-scroll');
    if (hadFocus && f) $(`#facadeSvg .fl-band[data-floor="${f}"]`)?.focus?.({ preventScroll: true });
  };
  syncFloorState();
  if (!sheet) { facade.classList.remove('is-open'); focusScene(null); }   // the photo brightens while the card folds away
  if (!animate || reducedMotion() || !card.animate || card.hidden) { finish(); return; }
  card.getAnimations?.().forEach(a => a.cancel());
  const from = getComputedStyle(card).transform;
  const a = sheet
    ? card.animate([{ transform: from === 'none' ? 'translateY(0)' : from }, { transform: 'translateY(104%)' }], { duration: 260, easing: 'cubic-bezier(.4, 0, .8, .4)', fill: 'forwards' })
    : card.animate([{ clipPath: 'inset(0px 0px 0px 0px round 14px)', opacity: 1 }, { clipPath: f ? bandInset(f, card) : 'inset(46% 30% 46% 30% round 12px)', opacity: 0 }], { duration: 300, easing: 'cubic-bezier(.4, 0, .6, 1)', fill: 'forwards' });
  const end = () => { try { a.cancel(); } catch (e) { /* done */ } finish(); };
  a.finished.then(end, () => finish());
}

// Close from the UI (X, tap outside, Escape, drag down): the address goes back to the section, without scrolling.
function dismissFloor() {
  if (!state.openFloor) return;
  closeFloor(true);
  if (state.route.startsWith('floor-')) { try { history.replaceState(null, '', '#apartments'); } catch (e) { /* sandboxed */ } state.route = 'apartments'; }
}

function renderSpecs() {
  const specs = [['energy', 'bld.energy', 'bld.energyT'], ['pv', 'bld.pv', 'bld.pvT'], ['lift', 'bld.lift', 'bld.liftT'], ['parking', 'bld.parking', 'bld.parkingT'], ['mansard', 'bld.mansard', 'bld.mansardT'], ['garden', 'bld.outdoor', 'bld.outdoorT']];
  $('#specs').innerHTML = specs.map(([i, h, p]) => `<li>${icon(i)}<b>${esc(t(h))}</b><span>${esc(t(p))}</span></li>`).join('');
  $('#timeline').innerHTML = PROJECT.timeline.map(x => `<li><span class="tl-date">${esc(x.date)}</span><span class="tl-label">${esc(L(x.label))}</span></li>`).join('');
  $('#finishCards').innerHTML = STYLES.map(s => packageCard(s, { asButton: false })).join('');
}

function finishCard(s, asButton, pressed = false) {
  const p = s.palette;
  const sw = [p.floor, p.wall, p.joinery, p.worktop, p.accent, p.metal, p.fabric];
  const delta = s.extra ? `+ ${fmtMoney(s.extra)}` : t('unit.included');
  const inner = `<div class="swatches" aria-hidden="true">${sw.map(c => `<i style="background:${c}"></i>`).join('')}</div>
    <h4>${esc(L(s.name))}</h4><p>${esc(L(s.blurb))}</p><span class="fdelta">${esc(delta)}</span>`;
  return asButton
    ? `<button type="button" class="fcard" data-style="${s.id}" aria-pressed="${pressed}">${inner}</button>`
    : `<div class="fcard">${inner}</div>`;
}

async function renderLocation() {
  $('#addr').innerHTML = `${esc(PROJECT.address)}<br><span class="fineprint">${esc(PROJECT.postcode)} · ${esc(PROJECT.region)}</span>`;
  $('#mapsLink').href = PROJECT.googleMaps;
  $('#earthLink').href = PROJECT.googleEarth;
  const sv = $('#streetLink');
  if (PROJECT.streetView) sv.href = PROJECT.streetView; else sv.hidden = true;
  $('#coords').textContent = `${PROJECT.lat.toFixed(6)}, ${PROJECT.lon.toFixed(6)}`;
  const list = state.landmarks
    .map(l => ({ ...l, km: haversineKm(PROJECT.lat, PROJECT.lon, l.lat, l.lon) }))
    .sort((a, b) => a.km - b.km);
  $('#distList').innerHTML = list.map(l => `<li><button type="button" class="dist-b${state.mapFocus === l.id ? ' is-on' : ''}" data-lm="${esc(l.id)}" aria-pressed="${state.mapFocus === l.id}">${icon(l.kind)}<span>${esc(L(l.name))}</span><span class="km">${fmtNum(l.km, l.km < 10 ? 1 : 0)} ${esc(t('misc.km'))}</span></button></li>`).join('');
}

// ---------------------------------------------------------------- location map (sitemap.js, lazy)
let siteMap = null;
function initSiteMap() {
  const box = $('#siteMap');
  if (!box || initSiteMap._started) return;
  const startMap = async () => {
    if (initSiteMap._started) return;
    initSiteMap._started = true;
    try {
      const m = await import('./sitemap.js');
      siteMap = await m.createSiteMap(box, { lang: getLang(), onOpen3D: () => openImmersive('aerial') });
      if (state.mapFocus) siteMap?.highlight?.(state.mapFocus);
    } catch (e) {
      console.warn('[app] site map unavailable', e);
      box.classList.add('is-failed');
      box.innerHTML = `<div class="loc-map-fail"><img src="assets/site-street.jpg" alt=""><p>${esc(t('loc.mapFail'))}</p><a class="btn btn-light" href="${esc(PROJECT.googleMaps)}" target="_blank" rel="noopener">${esc(t('loc.maps'))}</a></div>`;
    }
  };
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { io.disconnect(); startMap(); } }, { rootMargin: '600px 0px' });
    io.observe(box);
  } else startMap();
}

function focusLandmark(id) {
  state.mapFocus = state.mapFocus === id ? null : id;
  $$('#distList [data-lm]').forEach(b => { const on = b.dataset.lm === state.mapFocus; b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', on); });
  try { siteMap?.highlight?.(state.mapFocus); } catch (e) { /* ignore */ }
  const box = $('#siteMap');
  if (state.mapFocus && box) {
    const r = box.getBoundingClientRect();
    if (r.bottom < 60 || r.top > window.innerHeight - 120) box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// ---------------------------------------------------------------- contact (sales: G-International · developer: VILNYI)
const CICON = {
  wa: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.6a9.4 9.4 0 0 0-8.1 14.2L2.6 21.4l4.7-1.2A9.4 9.4 0 1 0 12 2.6Zm0 1.7a7.7 7.7 0 1 1-3.9 14.3l-.3-.2-2.8.7.8-2.7-.2-.3A7.7 7.7 0 0 1 12 4.3ZM9 7.6c-.2 0-.5.1-.7.4-.3.3-1 .9-1 2.2s1 2.5 1.1 2.7c.1.2 1.9 2.9 4.5 3.9 2.2.9 2.6.7 3.1.7.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.1-.3-.2-.6-.3l-1.9-.9c-.2-.1-.4-.1-.6.1l-.8 1c-.2.2-.3.2-.6.1-.3-.1-1.1-.4-2.1-1.3-.8-.7-1.3-1.6-1.5-1.8-.1-.3 0-.4.1-.5l.4-.5c.1-.2.2-.3.3-.5.1-.2 0-.3 0-.5l-.9-2c-.2-.4-.4-.4-.5-.4H9Z"/></svg>',
  web: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.4 2.6 14.600 0 17M12 3.5c-2.6 2.4-2.6 14.600 0 17"/></svg>',
  fb: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M13.2 20.4v-7h2.3l.4-2.6h-2.700V9.300c0-.8.4-1.300 1.300-1.300h1.500V5.700c-.5-.1-1.200-.2-2-.2-2 0-3.200 1.200-3.200 3.400v1.900H8.600v2.600h2.200v7"/></svg>',
  ig: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4.500"/><circle cx="12" cy="12" r="3.600"/><path d="M16.700 7.300h.01"/></svg>',
  mail: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.500" y="5.500" width="17" height="13" rx="2"/><path d="M4 7l8 6 8-6"/></svg>'
};
const waUrl = (text = '') => {
  const n = String(PROJECT.contact.whatsapp || '').replace(/\D/g, '');
  return n ? `https://wa.me/${n}${text ? `?text=${encodeURIComponent(text)}` : ''}` : '';
};
const hostOf = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return url; } };
let contactSeq = 0;
// One contact block for the footer, the unit page, the reservation confirmation and the interest form.
// The email row only appears once PROJECT.contact.email is filled in; `text` pre-fills the WhatsApp message.
function contactHtml({ text = '', note = false, waLabel = null } = {}) {
  const c = PROJECT.contact, id = `ct${++contactSeq}`;
  const wa = waUrl(text);
  return `<div class="contact">
    <p class="contact-co"><span class="k">${esc(t('contact.sales'))}</span><b>${esc(c.company || PROJECT.brand)}</b></p>
    ${note ? `<p class="contact-note">${esc(t('contact.note'))}</p>` : ''}
    ${c.phone ? `<div class="copyline"><span class="val tel" id="${id}p">${esc(c.phone)}</span><button type="button" class="copybtn" data-copy="${esc(c.phone)}" data-copy-target="#${id}p" aria-label="${esc(t('foot.copy'))} · ${esc(t('contact.phone'))}">${esc(t('foot.copy'))}</button></div>` : ''}
    ${c.email ? `<div class="copyline"><span class="val" id="${id}e" dir="ltr">${esc(c.email)}</span><button type="button" class="copybtn" data-copy="${esc(c.email)}" data-copy-target="#${id}e" aria-label="${esc(t('foot.copy'))} · ${esc(t('contact.email'))}">${esc(t('foot.copy'))}</button></div>` : ''}
    <div class="contact-links">
      ${wa ? `<a class="btn btn-wa" href="${esc(wa)}" target="_blank" rel="noopener">${CICON.wa}<span>${esc(waLabel || t('contact.whatsapp'))}</span></a>` : ''}
      ${c.website ? `<a class="clink" href="${esc(c.website)}" target="_blank" rel="noopener">${CICON.web}<span dir="ltr">${esc(hostOf(c.website))}</span></a>` : ''}
      ${c.facebook ? `<a class="clink is-icon" href="${esc(c.facebook)}" target="_blank" rel="noopener" aria-label="Facebook" title="Facebook">${CICON.fb}</a>` : ''}
      ${c.instagram ? `<a class="clink is-icon" href="${esc(c.instagram)}" target="_blank" rel="noopener" aria-label="Instagram" title="Instagram">${CICON.ig}</a>` : ''}
    </div>
  </div>`;
}

function renderFooter() {
  $('#footDev').innerHTML = `<span class="k">${esc(t('contact.developer'))}</span><b>${esc(PROJECT.developer)}</b><bdi dir="ltr">${esc(PROJECT.postcode)}, Portugal</bdi>`;
  const cr = $('#footCredits');
  if (cr) cr.innerHTML = ['foot.creditRenders', 'foot.creditAssets', 'foot.creditMap'].map(k => esc(t(k))).join(' ');
  $('#footContact').innerHTML = contactHtml();
  $('#adminLink').hidden = !state.isOwner;
}

function renderHome() {
  renderFacts();
  renderFacade();
  renderFloorList();
  renderFilters();
  renderTable();
  renderFloorCard();
  renderSpecs();
  renderLocation();
}

function renderAll() {
  renderHome();
  renderFooter();
  if (state.route && !isHomeRoute(state.route)) renderPage(state.route, false);
  if (unitUI.id) renderUnitSheet(true);
  updateImmLabels();
}

// ---------------------------------------------------------------- floor selection (events)
function bindHome() {
  const facade = $('#facade');
  const tip = $('#facadeTip');
  const hoverFloor = (f) => {
    $$('.fl-band').forEach(b => b.classList.toggle('is-hover', b.dataset.floor === f));
    $$('.floor-row').forEach(b => b.classList.toggle('is-hover', b.dataset.floor === f));
  };
  facade.addEventListener('pointermove', e => {
    const band = e.target.closest?.('#floorCard') ? null : e.target.closest?.('[data-floor]');
    if (!band) { tip.hidden = true; hoverFloor(null); return; }
    const f = band.dataset.floor;
    hoverFloor(f);
    if (e.pointerType !== 'mouse' || f === state.openFloor) { tip.hidden = true; return; }
    const us = floorUnits(f);
    tip.textContent = `${floorName(f)} · ${us.filter(u => isAvail(u.id)).length}/${us.length} ${t('status.available').toLowerCase()}`;
    const r = facade.getBoundingClientRect();
    tip.hidden = false;
    tip.style.left = `${Math.min(e.clientX - r.left + 14, r.width - tip.offsetWidth - 8)}px`;
    tip.style.top = `${Math.max(e.clientY - r.top - 36, 6)}px`;
  });
  facade.addEventListener('pointerleave', () => { tip.hidden = true; hoverFloor(null); });
  // tap a floor: its plan opens over the image; tap another floor: the card re-opens from that band; tap outside: it folds back
  facade.addEventListener('click', e => {
    if (e.target.closest('#floorCard')) return;
    const band = e.target.closest?.('[data-floor]');
    if (band) { if (band.dataset.floor !== state.openFloor) go(`floor-${band.dataset.floor}`); return; }
    dismissFloor();
  });
  facade.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset?.floor && !e.target.closest('#floorCard') && e.target.tagName !== 'BUTTON') { e.preventDefault(); go(`floor-${e.target.dataset.floor}`); }
  });
  $('#floorList').addEventListener('click', e => {
    const b = e.target.closest('[data-floor]');
    if (!b) return;
    if (state.openFloor === b.dataset.floor) dismissFloor();
    else go(`floor-${b.dataset.floor}`);
  });
  $('#floorList').addEventListener('pointerover', e => hoverFloor(e.target.closest('[data-floor]')?.dataset.floor || null));
  window.addEventListener('resize', () => {
    if (!state.openFloor) return;
    focusScene(state.openFloor);
    document.body.classList.toggle('no-scroll', sheetMode() || !$('#imm').hidden || !$('#modal').hidden || !!tourApi?.isOpen?.());
  });

  // façade / 3D toggle
  $('#selFacadeTab').addEventListener('click', () => setSelView('facade'));
  $('#sel3dTab').addEventListener('click', () => setSelView('3d'));
  $('#sel3dLoad').addEventListener('click', () => mountSel3d());

  // floor card
  const panel = $('#floorCard');
  panel.addEventListener('click', e => {
    const pv = e.target.closest('[data-pv]');
    if (pv) { state.planView = pv.dataset.pv; renderFloorCard(); panel.querySelector(`[data-pv="${state.planView}"]`)?.focus({ preventScroll: true }); return; }
    if (e.target.closest('[data-act="closePlan"]')) { dismissFloor(); return; }
    const fl = e.target.closest('.flc-rail [data-floor]');
    if (fl) { if (fl.dataset.floor !== state.openFloor) go(`floor-${fl.dataset.floor}`); return; }
    const chip = e.target.closest('.flc-chip[data-unit]');
    if (chip) { unitUI.from = chip.getBoundingClientRect(); return; }   // the link itself navigates to #unit-…
    const u = e.target.closest('svg [data-unit]');
    if (u) { unitUI.from = unitOrigin(u.dataset.unit) || u.getBoundingClientRect(); go(`unit-${unitToken(u.dataset.unit)}`); }
  });
  panel.addEventListener('keydown', e => {
    const u = e.target.closest?.('svg [data-unit]');
    if (u && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); go(`unit-${unitToken(u.dataset.unit)}`); }
  });
  // phones: the sheet can be dragged down by its handle / header to close it
  let drag = null;
  panel.addEventListener('pointerdown', e => {
    if (!sheetMode() || !e.target.closest('.flc-grab, .flc-head') || e.target.closest('button, a')) return;
    drag = { y: e.clientY, t: performance.now(), dy: 0, id: e.pointerId };
    try { panel.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
  });
  panel.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.dy = Math.max(0, e.clientY - drag.y);
    panel.style.transform = drag.dy ? `translateY(${drag.dy}px)` : '';
  });
  const dragEnd = e => {
    if (!drag || (e.pointerId != null && e.pointerId !== drag.id)) return;
    const v = drag.dy / Math.max(1, performance.now() - drag.t);
    const shut = drag.dy > 110 || (drag.dy > 28 && v > 0.5);
    const dy = drag.dy;
    drag = null;
    if (shut) { dismissFloor(); return; }
    panel.style.transform = '';
    if (dy && !reducedMotion()) panel.animate?.([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 200, easing: 'cubic-bezier(.2, .7, .2, 1)' });
  };
  panel.addEventListener('pointerup', dragEnd);
  panel.addEventListener('pointercancel', dragEnd);
  let hoverId = null;
  const setUnitHover = (id, ev) => {
    if (id !== hoverId) {
      hoverId = id;
      $$('#floorCard [data-unit]').forEach(el => el.classList.toggle('is-hover', el.dataset.unit === id));
    }
    const tipEl = $('#fpTip');
    if (!tipEl) return;
    if (id && ev && ev.target.closest('svg')) {
      const plan = $('#ppPlan').getBoundingClientRect();
      tipEl.innerHTML = unitTip(unitById(id));
      tipEl.hidden = false;
      const x = ev.clientX - plan.left, y = ev.clientY - plan.top;
      tipEl.style.left = `${Math.max(6, Math.min(x + 14, plan.width - tipEl.offsetWidth - 6))}px`;
      tipEl.style.top = `${y + 16 + tipEl.offsetHeight > plan.height ? y - tipEl.offsetHeight - 12 : y + 16}px`;
    } else tipEl.hidden = true;
  };
  panel.addEventListener('pointermove', e => setUnitHover(e.target.closest?.('[data-unit]')?.dataset.unit || null, e));
  panel.addEventListener('pointerleave', () => setUnitHover(null));
  panel.addEventListener('focusin', e => { const id = e.target.closest?.('[data-unit]')?.dataset.unit; if (id) setUnitHover(id); });

  // filters
  $('#filters').addEventListener('click', e => {
    const c = e.target.closest('[data-fg]');
    if (c) { state.filters[c.dataset.fg] = c.dataset.fv; refreshFiltered(); return; }
    if (e.target.closest('#fAvail')) { state.filters.availOnly = !state.filters.availOnly; refreshFiltered(); }
  });
  $('#filters').addEventListener('input', e => {
    if (e.target.id !== 'fMax') return;
    const v = +e.target.value;
    state.filters.max = v >= PRICE_MAX ? null : v;
    $('#fMaxOut').textContent = t('filter.upto', { p: fmtMoney(v) });
    renderTable(); renderFloorCard();
  });
  $('#availNote').addEventListener('click', e => {
    if (e.target.closest('#fReset')) { state.filters = { type: 'all', floor: 'all', max: null, availOnly: false }; refreshFiltered(); }
  });
  $('#availTable').addEventListener('click', e => {
    const tr = e.target.closest('tr[data-unit]');
    if (tr && !e.target.closest('a')) go(`unit-${unitToken(tr.dataset.unit)}`);
  });
}

function refreshFiltered() {
  const focusId = document.activeElement?.id;
  renderFilters(); renderTable(); renderFloorCard();
  if (focusId) document.getElementById(focusId)?.focus();
}

function setSelView(v) {
  const is3d = v === '3d';
  $('#selFacadeTab').classList.toggle('is-on', !is3d); $('#selFacadeTab').setAttribute('aria-selected', !is3d);
  $('#sel3dTab').classList.toggle('is-on', is3d); $('#sel3dTab').setAttribute('aria-selected', is3d);
  $('#facadeSlot').hidden = is3d;
  if (is3d && state.openFloor) dismissFloor();
  $('#sel3d').hidden = !is3d;
  if (is3d) mountSel3d();
  else if (!is3d && host && host.parentElement === $('#sel3d')) host.remove();
}

// ---------------------------------------------------------------- 3D viewer glue
let viewerApi = null;
let viewerFailed = false;
let host = null;
let loadEl = null;
let returnMount = null;

async function getViewer() {
  if (viewerApi) return viewerApi;
  if (viewerFailed) return null;
  if (!getViewer._p) {
    getViewer._p = (async () => {
      host = document.createElement('div');
      host.className = 'v-host';
      try {
        const mod = await import('./viewer.js');
        const inner = document.createElement('div');
        inner.className = 'v-inner';
        host.appendChild(inner);
        loadEl = document.createElement('div');
        loadEl.className = 'v-load';
        loadEl.innerHTML = `<div><div class="lbl">${esc(t('v.loading'))}</div><div class="bar"><i></i></div></div>`;
        host.appendChild(loadEl);
        const dbg = /^(127\.0\.0\.1|localhost)$/.test(location.hostname) ? (window.__vb2 ||= {}) : null;
        const v = mod.createViewer(inner, { floorLabel: f => `${floorName(f)} · ${levelMark(f)}`, lang: getLang(), quality: dbg?.quality });
        if (dbg) dbg.viewer = v;   // local test hook only
        v.on('progress', ({ p }) => {
          const bar = loadEl.querySelector('i'); if (bar) bar.style.width = `${Math.round(p * 100)}%`;
          if (p >= 1) loadEl.hidden = true;
        });
        v.on('error', ({ error }) => { console.warn('[app] viewer error', error); });
        v.on('floor-select', ({ floorId }) => {
          if (!$('#imm').hidden) closeImmersive(false);
          go(`floor-${floorId}`);
        });
        v.on('mode', ({ mode, prev }) => {
          updateImmModes(mode);
          // arriving on the street: say how to get in (once per session)
          if (mode === 'walk' && prev !== 'walk') setTimeout(() => { if (v.getPose?.()?.outside && once('vb2.hintStreet')) toast(t('walk.streetHint'), 5200); }, 300);
        });
        v.on('place', info => {
          updatePlace(info);
          if (info && info.unitId && once('vb2.coach')) toast(t('walk.coach'), 5200);   // first time in an apartment
        });
        v.on('photoreal', ev => onPhotoreal(ev));
        v.setPhotorealLabels?.(ptLabels());
        viewerApi = v;
        // 'golden' stays the default exterior look until the visitor uses the Day / Dusk / Night switch
        if (state.todChosen) v.ready.then(() => v.setTimeOfDay(state.tod), () => {});
        v.ready.then(() => updateImmModes(v.getMode()), err => { failViewer(err); });
        return v;
      } catch (e) {
        failViewer(e);
        return null;
      }
    })();
  }
  return getViewer._p;
}

function failViewer(err) {
  console.warn('[app] 3D unavailable', err);
  viewerFailed = true;
  if (!host) return;
  host.innerHTML = `<div class="v-fail"><img src="assets/street-dusk.jpg" alt=""><p>${esc(t('sel.3d.failed'))}</p></div>`;
}

function mount(parent) {
  if (!host || !parent) return;
  if (host.parentElement !== parent) parent.appendChild(host);
  requestAnimationFrame(() => viewerApi?.resize?.());
}

async function mountSel3d() {
  $('#sel3dPoster').hidden = true;
  const v = await getViewer();
  if (!$('#sel3d').hidden) mount($('#sel3d'));
  if (!v) return;
  try { await v.ready; } catch (e) { return; }
  if (!$('#sel3d').hidden && host.parentElement === $('#sel3d')) v.setMode('exterior');
}

async function openImmersive(mode = 'exterior', opts = {}) {
  const imm = $('#imm');
  returnMount = host?.parentElement && host.parentElement !== $('#immStage') ? host.parentElement : returnMount;
  imm.hidden = false;
  showImmBar();
  document.body.classList.add('no-scroll');
  updateImmLabels();
  const v = await getViewer();
  mount($('#immStage'));
  if (!v) return;
  $('#immClose').focus({ preventScroll: true });
  try { await v.ready; } catch (e) { return; }
  let ok = true;
  if (mode === 'keep') { requestAnimationFrame(() => v.resize()); return; }
  if (mode === 'aerial') ok = await v.setMode('aerial');
  else if (mode === 'walk') ok = opts.unitId ? await v.walkUnit(opts.unitId) : await v.setMode('walk', opts);
  else ok = await v.setMode('exterior');
  if (!ok) { toast(t('v.unavailable')); await v.setMode('exterior'); }
}

function closeImmersive(restore = true) {
  const imm = $('#imm');
  if (imm.hidden) return;
  imm.hidden = true;
  showImmBar();
  if (!(state.openFloor && sheetMode())) document.body.classList.remove('no-scroll');
  $('#immPlace').hidden = true;
  if (viewerApi?.isPhotoreal?.() && !(restore && returnMount && returnMount.id === 'tour')) togglePhotoreal(false);
  if (host) {
    if (restore && returnMount && returnMount.isConnected && returnMount.offsetParent !== null) {
      mount(returnMount);
      if (returnMount === $('#sel3d')) viewerApi?.setMode('exterior');
    } else host.remove();
  }
  returnMount = null;
}

// ---------------------------------------------------------------- photoreal (path tracing)
const pr = { state: 'off' };
function ptLabels() {
  return { name: t('pt.name'), preparing: t('pt.preparing'), moving: t('pt.moving'), sample: t('pt.sample'), samples: t('pt.samples'), error: t('pt.error') };
}
function onPhotoreal(ev) {
  const prev = pr.state;
  if (ev.state === 'error') {
    pr.state = 'off';
    if (prev !== 'off' || ev.error) toast(t('v.pt.error'), 4200);
  } else if (ev.state === 'loading') pr.state = 'loading';
  else if (ev.state === 'on') { if (prev !== 'on') toast(t('v.pt.hint'), 3600); pr.state = 'on'; }
  else if (ev.state === 'off') pr.state = 'off';
  updatePhotorealUI();
}
function updatePhotorealUI() {
  const on = pr.state === 'on' || pr.state === 'loading';
  const aerial = viewerApi?.getMode?.() === 'aerial';
  for (const b of $$('#prBtn, [data-tour="photoreal"]')) {
    b.setAttribute('aria-pressed', on);
    b.classList.toggle('is-busy', pr.state === 'loading');
    b.disabled = aerial;
    b.title = aerial ? t('v.pt.aerial') : '';
    const lab = b.querySelector('[data-i18n]') || b;
    if (lab !== b || b.dataset.tour) lab.textContent = t(on ? 'v.photorealOn' : 'v.photoreal');
    if (b.id === 'prBtn') b.setAttribute('aria-label', t(on ? 'v.photorealOn' : 'v.photoreal'));
  }
}
async function togglePhotoreal(force) {
  const v = await getViewer();
  if (!v) { toast(t('v.unavailable')); return false; }
  try { await v.ready; } catch (e) { return false; }
  const want = typeof force === 'boolean' ? force : !(pr.state === 'on' || pr.state === 'loading');
  if (want && v.getMode() === 'aerial') { toast(t('v.pt.aerial')); return false; }
  if (want) { pr.state = 'loading'; updatePhotorealUI(); }
  const ok = await v.setPhotoreal(want);
  pr.state = v.isPhotoreal() ? 'on' : 'off';
  updatePhotorealUI();
  return ok;
}

// Phones: the 3D bar is one compact row over the view. It slides away 3 s after the visitor starts walking
// and comes back with a tap on the top edge (#immPeek).
const immUI = { timer: 0 };
const immCompact = () => !!window.matchMedia?.('(max-width: 700px), (max-height: 500px)').matches;
function showImmBar() {
  clearTimeout(immUI.timer); immUI.timer = 0;
  $('#imm').classList.remove('bar-hidden');
}
function hideImmBarSoon() {
  const imm = $('#imm');
  if (immUI.timer || imm.hidden || imm.classList.contains('bar-hidden') || !immCompact() || !imm.classList.contains('is-walk')) return;
  immUI.timer = setTimeout(() => {
    immUI.timer = 0;
    if (imm.hidden || !immCompact() || !imm.classList.contains('is-walk')) return;
    if ($('#immBar').contains(document.activeElement)) document.activeElement.blur();
    imm.classList.add('bar-hidden');
  }, 3000);
}

function updateImmModes(mode) {
  $('#imm').classList.toggle('is-walk', mode === 'walk');
  if (mode !== 'walk') showImmBar();
  $$('#immGo [data-go]').forEach(b => { b.disabled = !!viewerApi && !viewerApi.has('walk'); });
  $$('#immModes [data-mode]').forEach(b => {
    b.classList.toggle('is-on', b.dataset.mode === mode);
    b.setAttribute('aria-pressed', b.dataset.mode === mode);
    if (viewerApi) {
      const need = b.dataset.mode === 'aerial' ? 'aerial' : b.dataset.mode === 'walk' ? 'walk' : null;
      b.disabled = need ? !viewerApi.has(need) && viewerApi.modules && Object.values(viewerApi.modules()).some(Boolean) && !viewerApi.has(need) : false;
    }
  });
  const hint = $('#immPlace');
  if (mode === 'exterior') { hint.textContent = t('sel.3d.hint'); hint.hidden = false; }
  else hint.hidden = true;
  // the tour bar on a unit page mirrors walk state
  $$('[data-tour]').forEach(b => { if (b.dataset.tour === 'walk') b.setAttribute('aria-pressed', mode === 'walk'); });
  if (viewerApi && !viewerApi.isPhotoreal?.() && pr.state === 'on') pr.state = 'off';
  updatePhotorealUI();
}

function updatePlace(info) {
  if (!info || $('#imm').hidden) return;
  const hint = $('#immPlace');
  if (info.unitId) {
    const u = unitById(info.unitId);
    hint.textContent = `${info.unitId} · ${u?.type || ''} · ${floorName(u?.floor)}`;
    hint.hidden = false;
  } else if (info.inLift) {
    hint.textContent = t('unit.lift');
    hint.hidden = false;
  } else if (info.floorId) {
    hint.textContent = floorName(info.floorId);
    hint.hidden = false;
  }
}

function updateImmLabels() {
  mountViewSwitch();
  for (const el of $$('#imm [data-i18n]')) el.textContent = t(el.dataset.i18n);
  const tb = $('#immTod');
  if (tb) tb.innerHTML = TIMES_OF_DAY.map(x => `<button type="button" data-tod="${x.id}" aria-pressed="${x.id === state.tod}" aria-label="${esc(todName(x.id))}" title="${esc(todName(x.id))}">${TOD_ICON[x.id] || ''}</button>`).join('');
}

function bindImmersive() {
  $('#immClose').addEventListener('click', () => closeImmersive());
  $('#immModes').addEventListener('click', async e => {
    const b = e.target.closest('[data-mode]');
    if (!b || !viewerApi) return;
    const ok = await viewerApi.setMode(b.dataset.mode);
    if (!ok) toast(t('v.unavailable'));
  });
  $('#prBtn').addEventListener('click', () => togglePhotoreal());
  // entry points: the lobby (street door) and the basement car park (foot of the ramp)
  $('#immGo').addEventListener('click', async e => {
    const b = e.target.closest('[data-go]');
    if (!b || !viewerApi) return;
    let ok = false;
    try { ok = b.dataset.go === 'parking' ? await viewerApi.goToParking() : await viewerApi.goToLobby(); } catch (err) { ok = false; }
    if (!ok) toast(t('v.unavailable'));
  });
  // compact bar: hide while walking, show again from the top edge or on any use of the bar
  $('#immStage').addEventListener('pointerdown', () => hideImmBarSoon(), { capture: true, passive: true });
  $('#immBar').addEventListener('pointerdown', () => showImmBar(), { passive: true });
  $('#immBar').addEventListener('focusin', () => showImmBar());
  $('#immPeek').addEventListener('click', () => { showImmBar(); $('#immClose').focus({ preventScroll: true }); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (!$('#modal').hidden) closeModal();
      else if (!$('#imm').hidden) closeImmersive();
      else if (tourApi?.isOpen?.()) return;
      else if (unitUI.id) go(`floor-${unitById(unitUI.id).floor}`);
      else if (state.openFloor) dismissFloor();
      return;
    }
    if (!$('#imm').hidden && /^(Arrow|[wasdWASD]$)/.test(e.key) && !e.target.closest?.('#immBar')) hideImmBarSoon();
  });
}

// ---------------------------------------------------------------- routing
const HOME_SECTIONS = ['', 'top', 'apartments', 'gallery-renders', 'location', 'building'];
function isHomeRoute(r) { return HOME_SECTIONS.includes(r) || r.startsWith('floor-') || r.startsWith('unit-') || r === 'interest' || r === '3d' || r === 'aerial'; }

function go(token) {
  if (location.hash === `#${token}`) route();
  else location.hash = token;
}

function showHome(show) {
  $('#home').hidden = !show;
  $('#page').hidden = show;
  if (show && host && host.parentElement === $('#sel3d')) requestAnimationFrame(() => viewerApi?.resize());
}

function detachHostFromPage() {
  if (host && $('#page').contains(host)) {
    host.remove();
    if (viewerApi?.isPhotoreal?.()) togglePhotoreal(false);
  }
}

function route() {
  const r = decodeURIComponent(location.hash.replace(/^#/, ''));
  const prev = state.route;
  state.route = r;
  $$('.nav a').forEach(a => a.classList.toggle('is-on', a.getAttribute('href') === `#${r}`));
  $('#nav').classList.remove('is-open'); $('#menuBtn').setAttribute('aria-expanded', 'false');
  if (isHomeRoute(r)) {
    const wasPage = !$('#page').hidden;
    detachHostFromPage();
    showHome(true);
    if (r.startsWith('unit-')) {
      // the apartment opens in place, over the floor card on the façade (also for direct links)
      const u = unitById(tokenToUnit(r.slice(5)));
      if (!u) { closeUnit(false); toast(t('unit.notfound')); route.booted = true; return; }
      const fresh = wasPage || !route.booted;
      if (fresh) document.getElementById('apartments')?.scrollIntoView({ behavior: 'auto', block: 'start' });
      openUnit(u.id, { animate: !fresh });
    } else if (r.startsWith('floor-')) {
      if (unitUI.id) closeUnit(!wasPage);
      // arriving from another page or by a direct link: show the selector first; a tap on the façade never scrolls
      if (wasPage || !route.booted) document.getElementById('apartments')?.scrollIntoView({ behavior: 'auto', block: 'start' });
      openFloor(r.slice(6), { animate: !!route.booted && !wasPage });
    } else if (r === 'interest') {
      openInterest();
    } else if (r === '3d' || r === 'aerial') {
      openImmersive(r === 'aerial' ? 'aerial' : 'exterior');
    } else {
      if (unitUI.id) closeUnit(false);
      if (state.openFloor && r !== 'apartments') closeFloor(false);
      const target = r ? document.getElementById(r) : null;
      if (target) requestAnimationFrame(() => target.scrollIntoView({ behavior: wasPage ? 'auto' : 'smooth', block: 'start' }));
      else if (wasPage || !r) window.scrollTo({ top: 0, behavior: 'auto' });
    }
    route.booted = true;
    return;
  }
  route.booted = true;
  if (unitUI.id) closeUnit(false);
  if (state.openFloor) closeFloor(false);
  renderPage(r, prev !== r);
}

function renderPage(r, scrollTop) {
  detachHostFromPage();
  showHome(false);
  const page = $('#page');
  if (r === 'reserve' || r.startsWith('reserve-')) renderReserve(page, r === 'reserve' ? null : tokenToUnit(r.slice(8)));
  else if (r === 'admin') renderAdmin(page);
  else { showHome(true); return; }
  if (scrollTop) window.scrollTo({ top: 0, behavior: 'auto' });
}

// ---------------------------------------------------------------- photoreal renders, materials, 360° tour, gallery
// renders/manifest.json lists Blender Cycles stills and 360° panoramas. Its file paths are relative to the SITE root,
// so they are made absolute here and handed to tour.js as a blob: manifest (tour.js resolves paths against the manifest URL).
const renders = { m: null, url: null, commonUrl: null, p: null };
const absUrl = f => { try { return new URL(f, document.baseURI).href; } catch (e) { return f; } };
const blobJson = o => { try { return URL.createObjectURL(new Blob([JSON.stringify(o)], { type: 'application/json' })); } catch (e) { return null; } };
function i18nAll(key) { const o = {}; for (const l of LANGS) o[l.id] = DICTS[l.id][key] || DICTS.en[key]; return o; }
function withRu(name) {
  if (!name || typeof name !== 'object' || name.ru || !name.en) return name;
  const prev = getLang(); setLang('ru');
  const ru = String(name.en).split(' · ').map(p => { const m = /^view (\d+)$/.exec(p); return m ? `вид ${m[1]}` : L({ en: p }); }).join(' · ');
  setLang(prev);
  return { ...name, ru };
}
function loadRenders() {
  if (!renders.p) {
    renders.p = (async () => {
      try {
        const r = await fetch('renders/manifest.json', { cache: 'no-cache' });
        if (!r.ok) throw new Error(`renders ${r.status}`);
        const j = await r.json();
        const fix = (o, nameKey) => {
          if (!o || typeof o !== 'object') return;
          if (o.file) o.file = absUrl(o.file);
          if (o.thumb) o.thumb = absUrl(o.thumb);
          for (const v of Object.values(o.variants || {})) { if (v && v.file) v.file = absUrl(v.file); if (v && v.thumb) v.thumb = absUrl(v.thumb); }
          if (nameKey && DICTS.en[nameKey]) o.name = i18nAll(nameKey); else o.name = withRu(o.name);
        };
        for (const u of Object.values(j.units || {})) for (const pk of Object.values(u || {})) { (pk.panos || []).forEach(p => fix(p)); (pk.stills || []).forEach(s => fix(s)); }
        j.exterior = (j.exterior || []).filter(s => !s.variantOf);
        j.common = (j.common || []).filter(s => !s.variantOf);
        (j.exterior || []).forEach(s => fix(s, `ext.${s.id}`));
        (j.common || []).forEach(s => fix(s, `common.${s.id}`));
        renders.m = j;
        renders.url = blobJson(j);
        renders.commonUrl = blobJson({ ...j, units: {}, exterior: j.common || [] });
      } catch (e) { console.warn('[app] renders manifest unavailable', e); renders.m = null; }
      return renders.m;
    })();
  }
  return renders.p;
}
const STILL_ORDER = ['living', 'kitchen', 'bedroom', 'bedroom2', 'bathroom', 'balcony', 'garden'];
function unitStills(unitId, pkg) {
  const list = renders.m?.units?.[unitId]?.[pkg]?.stills || [];
  const rank = s => { const i = STILL_ORDER.indexOf(s.kind); return i < 0 ? 50 : i; };
  return [...list].sort((a, b) => rank(a) - rank(b));
}
const hasPanos = (unitId, pkg) => !!renders.m?.units?.[unitId]?.[pkg]?.panos?.length;
const extStill = id => renders.m?.exterior?.find(s => s.id === id) || null;

// CC0 material textures (assets/manifest.json → textures[key][package|default].maps.albedo)
const materials = { m: null, p: null };
function loadMaterials() {
  if (!materials.p) {
    materials.p = fetch('assets/manifest.json', { cache: 'no-cache' })
      .then(r => (r.ok ? r.json() : null)).then(j => { materials.m = j; return j; })
      .catch(() => null);
  }
  return materials.p;
}
const SPEC_TEX = {
  floor: ['floor-main'], walls: ['wall-paint', 'wall-feature'], bath: ['bath-wall'], sanitary: ['tap-metal'],
  kitchen: ['kitchen-front', 'kitchen-worktop'], appliances: ['appliance-steel'], doors: ['door-interior'], windows: ['aluminium-frame', 'window-sheer']
};
const SPEC_COLOR = { floor: 'floor', walls: 'wall', bath: 'bathTile', sanitary: 'metal', kitchen: 'joinery', appliances: 'metal', doors: 'joinery', windows: 'wall' };
function texFor(key, pkg) {
  const e = materials.m?.textures?.[key];
  const ent = e?.[pkg] || e?.default;
  const src = ent?.maps?.albedo;
  return src ? { src, name: ent.name || ent.id || key } : null;
}
function boardHtml(styleId) {
  const s = styleById(styleId);
  return `<div class="board">${(s.spec || []).map(row => {
    const texs = (SPEC_TEX[row.k] || []).map(k => texFor(k, s.id)).filter(Boolean);
    const sw = texs.length
      ? texs.map(x => `<img src="${esc(x.src)}" alt="" title="${esc(x.name)}" loading="lazy" decoding="async">`).join('')
      : `<i style="background:${esc(s.palette[SPEC_COLOR[row.k]] || s.palette.wall)}"></i>`;
    return `<div class="board-row"><div class="sw${texs.length > 1 ? ' is-pair' : ''}" aria-hidden="true">${sw}</div>
      <div class="board-t"><span class="k">${esc(t('spec.' + row.k))}</span><p>${esc(L(row))}</p></div></div>`;
  }).join('')}</div>`;
}
const tierOf = s => L(s.name).split(' · ')[0];
const nameOf = s => { const p = L(s.name).split(' · '); return p.length > 1 ? p.slice(1).join(' · ') : p[0]; };
const deltaOf = s => (s.extra ? t('pkg.delta', { p: fmtMoney(s.extra) }) : t('pkg.included'));

// The 360° tour (tour.js) — one instance, opened over the page.
let tourApi = null, tourP = null, tourUnit = null;
function getTour() {
  if (tourApi) return Promise.resolve(tourApi);
  if (!tourP) {
    tourP = (async () => {
      await loadRenders();
      const [THREE, m] = await Promise.all([import('three'), import('./tour.js')]);
      const api = await m.createTour(document.body, {
        THREE, manifestUrl: renders.url || undefined, lang: getLang(), timeOfDay: state.tod,
        onClose: () => { if (!(sheetMode() && (state.openFloor || unitUI.id)) && $('#imm').hidden) document.body.classList.remove('no-scroll'); },
        onPackageChange: pkg => onTourPackage(pkg),
        onTimeOfDayChange: tod => setTod(tod, 'tour')
      });
      tourApi = api;
      return api;
    })();
    tourP.catch(() => { tourP = null; });
  }
  return tourP;
}
async function openTour(unitId, pkg, roomId, opts = {}) {
  unitId = unitId || '1.C';
  pkg = pkg || state.style[unitId] || 'atlantic';
  tourUnit = unitId;
  const slow = setTimeout(() => toast(t('tour.loading'), 2400), 350);
  try {
    const tr = await getTour();
    clearTimeout(slow);
    if (!$('#imm').hidden) closeImmersive(false);
    if (opts.timeOfDay && opts.timeOfDay !== state.tod) setTod(opts.timeOfDay, 'tour');
    mountViewSwitch();
    // panoId / yaw: the exact panorama and heading to continue from (tour.js uses them when it supports them, else the room)
    const ok = await tr.open(unitId, pkg, roomId || undefined, { timeOfDay: state.tod, panoId: opts.panoId, position: opts.position, yaw: opts.yaw });
    if (ok === false) toast(t('tour.failed'), 4200);
    return ok !== false;
  } catch (e) {
    clearTimeout(slow);
    console.warn('[app] 360 tour unavailable', e);
    toast(t('tour.failed'), 4200);
    return false;
  }
}
function onTourPackage(pkg) {
  if (!tourUnit || !STYLES.some(s => s.id === pkg)) return;
  state.style[tourUnit] = pkg;
  if (unitUI.id === tourUnit) renderUnitSheet(true);
}

// ---------------------------------------------------------------- 3D ⇄ photoreal, from the same place
// A two-segment switch in the 3D bar and in the 360° tour. 3D → Photoreal opens the nearest panorama of the apartment
// (same room preferred, within 4 m) at the same heading; Photoreal → 3D puts the walker on the panorama's spot, looking
// the same way. Package and light carry over. The last choice is remembered for the session.
const viewPref = {
  get() { try { return sessionStorage.getItem('vb2.view'); } catch (e) { return viewPref.v || null; } },
  set(v) { viewPref.v = v; try { sessionStorage.setItem('vb2.view', v); } catch (e) { /* blocked */ } }
};
const viewSwitchHtml = on => `<div class="seg seg-dark view-sw" role="group" aria-label="${esc(t('view.label'))}">
  <button type="button" class="seg-b${on === '3d' ? ' is-on' : ''}" data-view="3d" aria-pressed="${on === '3d'}">${esc(t('view.3d'))}</button>
  <button type="button" class="seg-b${on === 'photo' ? ' is-on' : ''}" data-view="photo" aria-pressed="${on === 'photo'}">${esc(t('view.photo'))}</button></div>`;
function mountViewSwitch() {
  const bar = $('#viewSw');
  if (bar) bar.outerHTML = viewSwitchHtml('3d').replace('view-sw"', 'view-sw" id="viewSw"');
  const slot = tourApi?.slot || $('.tr-root .tr-slot');   // the tour's host slot: never re-rendered by tour.js
  if (slot) slot.innerHTML = viewSwitchHtml('photo');
}
function panoSet(unitId, pkg) {
  const um = renders.m?.units?.[unitId];
  if (!um) return null;
  const id = um[pkg]?.panos?.length ? pkg : STYLES.map(x => x.id).find(i => um[i]?.panos?.length);
  return id ? { pkg: id, panos: um[id].panos } : null;
}
function nearestPano(unitId, pkg, pose, maxD = 4) {
  const set = panoSet(unitId, pkg);
  if (!set) return null;
  let best = null, bd = Infinity;
  for (const p of set.panos) {
    if (!Array.isArray(p.position) || Math.abs(p.position[1] - pose.y) > 1.5) continue;
    const d = Math.hypot(p.position[0] - pose.x, p.position[2] - pose.z);
    const score = d + (p.roomId && p.roomId === pose.roomId ? 0 : 1.5);     // same room preferred
    if (d <= maxD && score < bd) { bd = score; best = { pano: p, d, pkg: set.pkg }; }
  }
  return best;
}
// No panorama here (street, lobby, stairs, lift, car park): the closest photoreal still instead.
function fallbackStill(pose) {
  const m = renders.m;
  if (!m) return null;
  const by = (list, ids) => { for (const id of ids) { const x = (list || []).find(q => q.id === id); if (x) return x; } return null; };
  const night = state.tod === 'night', dusk = state.tod === 'dusk';
  if (pose && pose.unitId) {
    const st = unitStills(pose.unitId, state.style[pose.unitId] || STYLES[0].id);
    return st.find(q => q.roomId === pose.roomId) || st[0] || null;
  }
  if (!pose || pose.outside) return by(m.exterior, night ? ['street-eye-night', 'entrance-night', 'street-night'] : dusk ? ['entrance-dusk', 'street-dusk'] : ['street-eye', 'entrance-day']) || (m.exterior || [])[0] || null;
  if (pose.inLift) return by(m.common, ['lift-interior', 'lobby']);
  if (pose.floorId === 'basement') return by(m.common, ['basement', 'carpark-2', 'carpark-ramp']);
  if (pose.floorId === 'ground') return by(m.common, night ? ['lobby-night', 'lobby-2-night', 'lobby'] : ['lobby', 'lobby-2']);
  return by(m.common, ['landing-first', 'lobby']);
}
function openLightbox(still) {
  const src = stillSrc(still);
  const name = typeof still.name === 'string' ? still.name : L(still.name);
  openModal(`<figure class="lb"><img src="${esc(src)}" alt="${esc(name || '')}"><figcaption><span id="modalTitle">${esc(name || t('gal.title'))}</span><button type="button" class="btn btn-line btn-sm" data-close>${esc(t('int.close'))}</button></figcaption></figure>`);
  $('#modalCard').classList.add('is-lb');
  $('#modalCard [data-close]').onclick = closeModal;
}
let switching = false;
async function toPhotoreal() {
  if (switching) return false;
  switching = true;
  try {
    await loadRenders();
    const v = viewerApi;
    let pose = v?.getPose?.() || null;
    if (pose?.riding) {                                    // in the lift: switch on arrival
      toast(t('view.waitLift'), 2600);
      for (let i = 0; i < 80 && pose?.riding; i++) { await sleep(250); pose = v.getPose?.() || null; }
    }
    if (pose && pose.unitId) {
      const hit = nearestPano(pose.unitId, state.style[pose.unitId] || v.currentUnit?.() && state.style[v.currentUnit()] || STYLES[0].id, pose);
      if (hit) {
        viewPref.set('photo');
        toPhotoreal.last = { unitId: pose.unitId, panoId: hit.pano.id, d: hit.d, yaw: pose.yaw, from: { x: pose.x, y: pose.y, z: pose.z } };
        // the tour picks the panorama nearest to the walker's eye position and opens it at the same heading
        return await openTour(pose.unitId, state.style[pose.unitId] || hit.pkg, hit.pano.roomId, { timeOfDay: state.tod, position: [pose.x, pose.y, pose.z], yaw: pose.yaw });
      }
    }
    const still = fallbackStill(pose);
    if (!still) { toast(t('tour.failed'), 4200); return false; }
    openLightbox(still);
    toast(t('view.noPano'), 4200);
    return false;
  } finally { switching = false; }
}
async function toRealtime() {
  if (switching || !tourApi?.isOpen?.()) return false;
  switching = true;
  try {
    const g = tourApi.getState?.() || null, dbg = g ? null : (tourApi._debug?.() || {});
    const d = g ? { pkg: g.packageId, id: g.panoId, yaw: g.yaw } : dbg;
    const unitId = g?.unitId || tourUnit, pkg = d.pkg || state.style[unitId] || STYLES[0].id;
    const list = renders.m?.units?.[unitId]?.[pkg]?.panos || [];
    const pano = Array.isArray(g?.position) ? { id: g.panoId, position: g.position } : (list.find(p => p.id === d.id) || list[d.idx] || null);
    viewPref.set('3d');
    if (STYLES.some(x => x.id === pkg)) state.style[unitId] = pkg;
    tourApi.close();
    const v = await getViewer();
    if (!v) { toast(t('sel.3d.failed'), 4200); return false; }
    await openImmersive('keep');
    try { await v.ready; } catch (e) { toast(t('sel.3d.failed'), 4200); return false; }
    await v.selectUnit(unitId, pkg);
    if (state.todChosen) v.setTimeOfDay(state.tod);
    const ok = pano && Array.isArray(pano.position)
      ? await v.setPose({ x: pano.position[0], y: pano.position[1], z: pano.position[2], yaw: Number.isFinite(d.yaw) ? d.yaw : 0 })
      : await v.walkUnit(unitId);
    toRealtime.last = { unitId, pkg, panoId: pano?.id || null, yaw: d.yaw, to: pano?.position || null };
    if (unitUI.id === unitId) renderUnitSheet(true);
    if (!ok) toast(t('v.unavailable'));
    return !!ok;
  } finally { switching = false; }
}
document.addEventListener('click', e => {
  const b = e.target.closest('.view-sw [data-view]');
  if (!b) return;
  e.stopPropagation();
  if (b.dataset.view === 'photo' && !b.closest('.tr-root')) toPhotoreal();
  else if (b.dataset.view === '3d' && b.closest('.tr-root')) toRealtime();
});
if (/^(127\.0\.0\.1|localhost)$/.test(location.hostname)) (window.__vb2 ||= {}).app = { toPhotoreal, toRealtime, tour: () => tourApi, last: () => ({ photo: toPhotoreal.last, real: toRealtime.last }) };   // local test hook only

// Gallery section: three createGallery instances (exterior · common areas · apartments by package).
const gal = { ext: null, common: null, units: null, pkg: 'lisboa', started: false };
function initGallery() {
  const box = $('#galleryBox');
  if (!box || gal.started) return;
  const start = async () => {
    if (gal.started) return;
    gal.started = true;
    await loadRenders();
    if (!renders.m) { box.innerHTML = `<p class="fineprint">${esc(t('gal.empty'))}</p>`; return; }
    try {
      const m = await import('./tour.js');
      const lang = getLang();
      const onOpenPano = o => { if (o && o.unitId) openTour(o.unitId, o.packageId, o.roomId, { timeOfDay: o.timeOfDay }); };
      [gal.ext, gal.common, gal.units] = await Promise.all([
        m.createGallery($('#galExt'), { manifestUrl: renders.url, lang, include: 'exterior', timeOfDay: state.tod, onOpenPano }),
        m.createGallery($('#galCommon'), { manifestUrl: renders.commonUrl, lang, include: 'exterior', timeOfDay: state.tod, onOpenPano }),
        m.createGallery($('#galUnits'), { manifestUrl: renders.url, lang, include: 'interior', packageId: gal.pkg, timeOfDay: state.tod, onOpenPano })
      ]);
      renderGalleryChips();
    } catch (e) {
      console.warn('[app] gallery unavailable', e);
      box.innerHTML = `<p class="fineprint">${esc(t('gal.empty'))}</p>`;
    }
  };
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { io.disconnect(); start(); } }, { rootMargin: '800px 0px' });
    io.observe(box);
  } else start();
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-galpkg]');
  if (!b) return;
  gal.pkg = b.dataset.galpkg;
  renderGalleryChips();
  try { gal.units?.setFilter?.({ packageId: gal.pkg, include: 'interior' }); } catch (err) { /* gallery optional */ }
});
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => initGallery()); else setTimeout(() => initGallery(), 0);
function renderGalleryChips() {
  const el = $('#galPkgs');
  if (!el) return;
  el.innerHTML = STYLES.map(s => `<button type="button" class="chip" data-galpkg="${s.id}" aria-pressed="${gal.pkg === s.id}">${esc(tierOf(s))} · ${esc(nameOf(s))}</button>`).join('');
}

// Package cards (unit page, reservation, building section)
function packageCard(s, { pressed = false, asButton = true, thumb = null, compact = false } = {}) {
  const p = s.palette;
  const visual = thumb
    ? `<span class="pk-img"><img src="${esc(thumb)}" alt="" loading="lazy" decoding="async"></span>`
    : `<span class="swatches" aria-hidden="true">${[p.floor, p.wall, p.joinery, p.worktop, p.accent, p.metal].map(c => `<i style="background:${c}"></i>`).join('')}</span>`;
  const inner = `${visual}<span class="pk-tier">${esc(tierOf(s))}</span><span class="pk-name">${esc(nameOf(s))}</span>
    ${compact ? '' : `<span class="pk-blurb">${esc(L(s.blurb))}</span>`}<span class="fdelta">${esc(deltaOf(s))}</span>`;
  return asButton
    ? `<button type="button" class="pkcard" data-style="${s.id}" aria-pressed="${pressed}">${inner}</button>`
    : `<div class="pkcard">${inner}</div>`;
}

// ---------------------------------------------------------------- light: day · dusk · night
const TOD_ICON = {
  day: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.8"/><path d="M12 3v2.2M12 18.800V21M3 12h2.200M18.800 12H21M5.600 5.600l1.600 1.600M16.800 16.800l1.600 1.600M5.600 18.400l1.600-1.600M16.800 7.200l1.600-1.600"/></svg>',
  dusk: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.500 16a4.500 4.500 0 0 1 9 0M3 16h18M6 20h12M12 6v2.500M5.300 9.300l1.700 1.700M18.700 9.300 17 11"/></svg>',
  night: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.500 14.200A7.800 7.800 0 0 1 9.800 4.500a7.800 7.800 0 1 0 9.700 9.700Z"/></svg>'
};
const todName = id => L(TIMES_OF_DAY.find(x => x.id === id)?.name) || id;
function todSwitchHtml(cls = '') {
  return `<div class="tod3${cls ? ' ' + cls : ''}" role="group" aria-label="${esc(t('v.time'))}">${TIMES_OF_DAY.map(x => `<button type="button" data-tod="${x.id}" aria-pressed="${x.id === state.tod}" aria-label="${esc(todName(x.id))}" title="${esc(todName(x.id))}">${TOD_ICON[x.id] || ''}</button>`).join('')}</div>`;
}
// One light state for the whole site: the realtime 3D, the 360° tour, the galleries and the apartment sheet follow it.
function setTod(id, src = 'page') {
  if (!TIMES_OF_DAY.some(x => x.id === id)) return;
  const changed = state.tod !== id;
  state.tod = id; state.todChosen = true;
  $$('.tod3 [data-tod]').forEach(b => b.setAttribute('aria-pressed', b.dataset.tod === id));
  try { viewerApi?.setTimeOfDay?.(id); } catch (e) { /* optional */ }
  if (src !== 'tour') { try { tourApi?.setTimeOfDay?.(id); } catch (e) { /* optional */ } }
  for (const g of [gal.ext, gal.common, gal.units]) { try { g?.setTimeOfDay?.(id); } catch (e) { /* optional */ } }
  if (changed && unitUI.id) refreshUnitHero();
}
document.addEventListener('click', e => {
  const b = e.target.closest('.tod3 [data-tod]');
  if (!b || b.closest('.tr-root')) return;
  // phones: the 3D bar shows one button that cycles day → dusk → night
  if (b.closest('#immBar') && immCompact()) {
    const ids = TIMES_OF_DAY.map(x => x.id);
    setTod(ids[(ids.indexOf(state.tod) + 1) % ids.length]);
    requestAnimationFrame(() => $('#immTod [aria-pressed="true"]')?.focus({ preventScroll: true }));
  } else setTod(b.dataset.tod);
});

// ---------------------------------------------------------------- apartment sheet (opens in place, over the floor card)
// One unit experience: tapping an apartment (chip, plan, table row or a #unit-… link) expands it into a sheet over the dimmed
// façade — full height on phones, a wide two-column card on desktop. Back returns to the floor card, X to the building.
const unitUI = { id: null, seq: 0, from: null, loaded: false };
const unitTitle = u => `<bdi>${u.id}</bdi><span class="sep">·</span><bdi>${u.type}</bdi><span class="sep">·</span><bdi>${fmtNum(u.area, 2)} ${esc(t('misc.m2'))}</bdi>`;
const stillSrc = s => s?.variants?.[state.tod]?.file || s?.file || '';

function unitHeroSlides(u, pkg) {
  const stills = unitStills(u.id, pkg);
  if (!stills.length) {
    const p = styleById(pkg).palette;
    return `<figure class="us-slide is-empty" style="--c1:${p.wall};--c2:${p.floor};--c3:${p.joinery}"><div><span class="swatches" aria-hidden="true">${[p.floor, p.wall, p.joinery, p.worktop, p.accent, p.metal].map(c => `<i style="background:${c}"></i>`).join('')}</span><p>${esc(renders.m || unitUI.loaded ? t('pkg.noRenders') : t('tour.loading'))}</p></div></figure>`;
  }
  return stills.map((s, i) => `<figure class="us-slide"><img src="${esc(stillSrc(s))}" alt="${esc(L(s.name) || '')}" ${i ? 'loading="lazy"' : 'fetchpriority="high"'} decoding="async" draggable="false"><figcaption>${esc(L(s.name) || '')}</figcaption></figure>`).join('');
}
function refreshUnitHero() {
  const u = unitById(unitUI.id), strip = $('#usStrip');
  if (!u || !strip) return;
  const x = strip.scrollLeft;
  strip.innerHTML = unitHeroSlides(u, state.style[u.id] || STYLES[0].id);
  strip.scrollLeft = x;
  updateStillCount();
}
function updateStillCount() {
  const strip = $('#usStrip'), out = $('#usCount');
  if (!strip || !out) return;
  const n = strip.querySelectorAll('.us-slide:not(.is-empty)').length;
  out.hidden = n < 2;
  if (n > 1) out.textContent = `${Math.min(n, Math.round(Math.abs(strip.scrollLeft) / Math.max(1, strip.clientWidth)) + 1)} / ${n}`;
}

function renderUnitSheet(keep = false) {
  const sheet = $('#unitSheet');
  const u = unitById(unitUI.id);
  if (!sheet || !u) return;
  const sc = keep ? { y: $('.us-scroll', sheet)?.scrollTop || 0, b: $('.us-body', sheet)?.scrollTop || 0, pk: $('#usPk', sheet)?.scrollLeft || 0, st: $('#usStrip', sheet)?.scrollLeft || 0, board: $('#usBoard', sheet)?.open, rooms: $('#usRooms', sheet)?.open } : null;
  const styleId = state.style[u.id] || STYLES[0].id, style = styleById(styleId);
  const st = statusOf(u.id);
  const idx = UNITS.indexOf(u);
  const prev = UNITS[(idx + UNITS.length - 1) % UNITS.length], next = UNITS[(idx + 1) % UNITS.length];
  const garden = u.outdoorKind === 'garden';
  const bay = PARKING.find(p => p.unit === u.id);
  const rooms = unitRoomAreas(u.id);
  const roomRows = rooms.map(r => {
    const name = r.name ? L(r.name) : (r.use === 'deck' ? t('unit.garden') : t('unit.balcony'));
    return `<tr${r.use === 'balcony' || r.use === 'deck' || r.use === 'garden' ? ' class="sub"' : ''}><td>${esc(name)}</td><td>${fmtNum(r.area, 1)} ${esc(t('misc.m2'))}</td></tr>`;
  }).join('') + (bay ? `<tr class="sub"><td>${esc(t('unit.parking'))} · ${bay.id}</td><td>${fmtNum((bay.x1 - bay.x0) * (bay.z1 - bay.z0), 1)} ${esc(t('misc.m2'))}</td></tr>` : '');
  const chev = d => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
  const fact = (k, v) => `<div><span class="k">${esc(k)}</span><span class="v">${v}</span></div>`;
  sheet.innerHTML = `
    <div class="us-grab" aria-hidden="true"></div>
    <header class="us-bar">
      <button type="button" class="icon-btn us-back" data-us="back" aria-label="${esc(t('unit.backFloor'))}" title="${esc(t('unit.backFloor'))}">${chev('M14.500 5.500 8 12l6.500 6.500')}</button>
      <div class="us-ttl"><span class="us-eyebrow">${esc(floorName(u.floor).split(' · ')[0])} · <bdi class="mono">${levelMark(u.floor)}</bdi></span><h3 id="usTitle">${unitTitle(u)}</h3></div>
      <div class="us-nav">
        <button type="button" class="icon-btn" data-us="prev" aria-label="${esc(t('unit.prev'))} · ${prev.id}" title="${esc(t('unit.prev'))} · ${prev.id}">${chev('M14.500 5.500 8 12l6.500 6.500')}</button>
        <button type="button" class="icon-btn" data-us="next" aria-label="${esc(t('unit.next'))} · ${next.id}" title="${esc(t('unit.next'))} · ${next.id}">${chev('M9.500 5.500 16 12l-6.500 6.500')}</button>
      </div>
      <button type="button" class="icon-btn us-x" data-us="close" aria-label="${esc(t('v.close'))}" title="${esc(t('v.close'))}">${chev('M6 6l12 12M18 6 6 18')}</button>
    </header>
    <div class="us-body">
      <div class="us-media">
        <div class="us-hero">
          <div class="us-strip" id="usStrip" tabindex="0" aria-label="${esc(t('gal.title'))}">${unitHeroSlides(u, styleId)}</div>
          <div class="us-hero-top">${todSwitchHtml('tod3-glass')}<span class="us-count" id="usCount" hidden></span></div>
          <div class="us-dots" role="group" aria-label="${esc(t('pkg.title'))}">${STYLES.map(s => `<button type="button" data-style="${s.id}" aria-pressed="${s.id === styleId}" aria-label="${esc(L(s.name))}" title="${esc(L(s.name))}" style="--d1:${s.palette.floor};--d2:${s.palette.accent}"></button>`).join('')}</div>
        </div>
      </div>
      <div class="us-scroll">
        <div class="us-price">
          <div><span class="h-small">${esc(t('unit.price'))}</span><div class="price-big" id="usTotal"><bdi>${fmtMoney(priceOf(u.id, styleId))}</bdi></div>
            <p class="price-ppm">${ppmFmt(ppmOf(u))} · ${esc(L(style.name))} ${style.extra ? `<bdi>+ ${fmtMoney(style.extra)}</bdi>` : `· ${esc(t('unit.included'))}`}</p></div>
          <span class="pill st-${st}">${esc(t('status.' + st))}</span>
        </div>
        ${st === 'available' ? '' : `<p class="notice">${esc(t('unit.notAvailable', { status: t('status.' + st).toLowerCase() }))}</p>`}
        <div class="us-cta">
          <button type="button" class="btn ${viewPref.get() === '3d' ? 'btn-line' : 'btn-bronze'}" data-us="tour">${esc(t('tour.photoreal'))}</button>
          <button type="button" class="btn ${viewPref.get() === '3d' ? 'btn-bronze' : 'btn-line'}" data-us="walk">${esc(t('unit.walkStreet'))}</button>
          ${st === 'available' ? `<a class="btn btn-solid" href="#reserve-${unitToken(u.id)}">${esc(t('nav.reserve'))}</a>` : `<button type="button" class="btn btn-solid" data-act="interest" data-unit="${u.id}">${esc(t('unit.interest'))}</button>`}
        </div>
        <div class="us-facts">
          ${fact(t('unit.interior'), `<b>${areaFmt(u.area)}</b>`)}
          ${fact(garden ? t('unit.garden') : t('unit.balcony'), `<b>${fmtNum(u.outdoor, 1)} ${esc(t('misc.m2'))}</b>`)}
          ${fact(t('unit.beds'), `<b>${u.beds}</b>`)}
          ${fact(t('unit.baths'), `<b>${u.baths}</b>`)}
          ${fact(t('unit.aspect'), `<b>${u.aspect.join(' · ')}</b>`)}
          ${fact(t('unit.parking'), `<b>${esc(u.parking)}</b>`)}
        </div>
        <section>
          <div class="block-h"><h4>${esc(t('unit.plan'))}</h4></div>
          <div class="us-plan" id="usPlan">${drawFloorplan(u.floor, { label: L, status: statusOf, only: u.id, focus: u.id, title: `${u.id} · ${floorName(u.floor)}` })}</div>
        </section>
        <section>
          <div class="block-h"><h4>${esc(t('pkg.title'))}</h4><p class="fineprint">${esc(t('pkg.note'))}</p></div>
          <div class="pk-row" id="usPk">${STYLES.map(s => { const s0 = unitStills(u.id, s.id)[0]; return packageCard(s, { pressed: s.id === styleId, thumb: s0 ? (s0.thumb || s0.file) : null, compact: true }); }).join('')}</div>
        </section>
        <details class="us-fold" id="usBoard"${sc?.board ? ' open' : ''}><summary>${esc(t('pkg.board'))} · ${esc(nameOf(style))}</summary>${boardHtml(styleId)}</details>
        <details class="us-fold" id="usRooms"${sc?.rooms ? ' open' : ''}><summary>${esc(t('unit.rooms'))}</summary><table class="rooms"><tbody>${roomRows}</tbody></table><p class="fineprint" style="margin-top:10px">${esc(t('unit.roomsNote'))}</p></details>
        <div class="us-more">
          <button type="button" class="chip" data-us="inside">${esc(t('unit.walkInside'))}</button>
          <button type="button" class="chip" data-us="balcony">${esc(garden ? t('unit.gardenView') : t('unit.balconyView'))}</button>
          <button type="button" class="chip" data-us="lift">${esc(t('unit.lift.take'))}</button>
          <button type="button" class="chip" data-act="interest" data-unit="${u.id}">${esc(t('unit.interest'))}</button>
        </div>
        ${contactHtml({ note: true, text: `Barreiro 2 · ${t('unit.apartment', { id: u.id })} (${u.type}, ${fmtNum(u.area, 2)} m²)` })}
        <p class="fineprint">${esc(t('hero.note'))}</p>
      </div>
    </div>`;
  const svg = $('#usPlan svg', sheet);
  if (svg?.dataset.focus) svg.setAttribute('viewBox', svg.dataset.focus);
  if (sc) {
    const a = $('.us-scroll', sheet), b = $('.us-body', sheet), c = $('#usPk', sheet), d = $('#usStrip', sheet);
    if (a) a.scrollTop = sc.y; if (b) b.scrollTop = sc.b; if (c) c.scrollLeft = sc.pk; if (d) d.scrollLeft = sc.st;
  } else $('#usPk [aria-pressed="true"]', sheet)?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
  $('#usStrip', sheet)?.addEventListener('scroll', () => updateStillCount(), { passive: true });
  updateStillCount();
}

// The plan starts on the whole floor and zooms to the apartment.
function zoomUnitPlan() {
  const svg = $('#usPlan svg');
  if (!svg?.dataset.focus || !svg.dataset.full || reducedMotion()) return;
  const a = svg.dataset.full.split(' ').map(Number), b = svg.dataset.focus.split(' ').map(Number);
  const t0 = performance.now() + 260, ms = 700;
  svg.setAttribute('viewBox', a.join(' '));
  const step = now => {
    if (!svg.isConnected) return;
    const u = Math.max(0, Math.min(1, (now - t0) / ms)), e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
    svg.setAttribute('viewBox', a.map((v, i) => (v + (b[i] - v) * e).toFixed(1)).join(' '));
    if (u < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function rectInset(r, c, round = 14) {
  if (!r || !c.width) return `inset(40% 20% 40% 20% round ${round}px)`;
  const cl = (v, max) => Math.max(0, Math.min(max, v));
  return `inset(${cl(r.top - c.top, c.height - 20).toFixed(0)}px ${cl(c.right - r.right, c.width - 20).toFixed(0)}px ${cl(c.bottom - r.bottom, c.height - 20).toFixed(0)}px ${cl(r.left - c.left, c.width - 20).toFixed(0)}px round ${round}px)`;
}
const unitOrigin = id => {
  const el = $(`#floorCard .flc-chip[data-unit="${id}"]`);
  const r = el?.getBoundingClientRect();
  return r && r.width ? r : null;
};

function openUnit(id, { animate = true } = {}) {
  const u = unitById(id), sheet = $('#unitSheet');
  if (!u || !sheet) return;
  const was = unitUI.id;
  const seq = ++unitUI.seq;
  if (state.openFloor !== u.floor) openFloor(u.floor, { animate: false });
  const from = unitUI.from || unitOrigin(u.id);
  unitUI.from = null;
  unitUI.id = u.id;
  renderUnitSheet(false);
  sheet.hidden = false;
  sheet.style.transform = '';
  $('#selGrid').classList.add('has-unit');
  const sheetM = sheetMode();
  if (sheetM) document.body.classList.add('no-scroll');
  else {
    const r = $('#selGrid').getBoundingClientRect();
    const visible = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
    if (visible < Math.min(r.height, window.innerHeight) * 0.7) $('#selGrid').scrollIntoView({ behavior: 'auto', block: 'start' });
  }
  sheet.getAnimations?.().forEach(a => a.cancel());
  if (animate && !reducedMotion() && sheet.animate) {
    if (was && was !== u.id) {
      const dir = (UNITS.indexOf(u) > UNITS.indexOf(unitById(was)) ? 1 : -1) * (document.documentElement.dir === 'rtl' ? -1 : 1);
      $('.us-body', sheet)?.animate([{ opacity: 0, transform: `translateX(${dir * 28}px)` }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.2, .7, .2, 1)' });
    } else if (!was) {
      // shared-element morph: the sheet grows out of the tapped chip
      const c = sheet.getBoundingClientRect();
      sheet.animate([{ clipPath: rectInset(from, c, 9), opacity: 0.5 }, { opacity: 1, offset: 0.45 }, { clipPath: `inset(0px 0px 0px 0px round ${sheetM ? 0 : 14}px)`, opacity: 1 }], { duration: 400, easing: 'cubic-bezier(.2, .75, .2, 1)' });
    }
  }
  if (!was || was !== u.id) zoomUnitPlan();
  $('.us-back', sheet)?.focus({ preventScroll: true });
  if (!unitUI.loaded) {
    Promise.all([loadRenders(), loadMaterials()]).then(() => {
      unitUI.loaded = true;
      if (unitUI.id && !$('#unitSheet').hidden) renderUnitSheet(true);
    });
  }
  if (seq !== unitUI.seq) return;
}

function closeUnit(animate = true) {
  const sheet = $('#unitSheet');
  const id = unitUI.id;
  if (!sheet || (!id && sheet.hidden)) return;
  const seq = ++unitUI.seq;
  unitUI.id = null;
  const finish = () => {
    if (seq !== unitUI.seq) return;
    sheet.hidden = true; sheet.innerHTML = ''; sheet.style.transform = '';
    $('#selGrid').classList.remove('has-unit');
    if (!(sheetMode() && state.openFloor) && $('#imm').hidden && $('#modal').hidden) document.body.classList.remove('no-scroll');
  };
  sheet.getAnimations?.().forEach(a => a.cancel());
  if (!animate || reducedMotion() || !sheet.animate || sheet.hidden) { finish(); return; }
  const c = sheet.getBoundingClientRect();
  const to = state.openFloor ? unitOrigin(id) : null;
  const a = sheet.animate(to
    ? [{ clipPath: `inset(0px 0px 0px 0px round 14px)`, opacity: 1 }, { opacity: 1, offset: 0.6 }, { clipPath: rectInset(to, c, 9), opacity: 0 }]
    : [{ opacity: 1 }, { opacity: 0 }], { duration: to ? 340 : 200, easing: 'cubic-bezier(.4, 0, .6, 1)', fill: 'forwards' });
  a.finished.then(() => { try { a.cancel(); } catch (e) { /* done */ } finish(); }, () => finish());
  if (to) $(`#floorCard .flc-chip[data-unit="${id}"]`)?.focus({ preventScroll: true });
}

// X: everything folds away and the building image is back.
function dismissAll() {
  const hadUnit = !!unitUI.id;
  if (hadUnit) { const keep = state.openFloor; state.openFloor = null; closeUnit(true); state.openFloor = keep; }
  closeFloor(!hadUnit);
  if (/^(unit|floor)-/.test(state.route)) { try { history.replaceState(null, '', '#apartments'); } catch (e) { /* sandboxed */ } state.route = 'apartments'; }
}

async function unitAction(u, action) {
  const sid = state.style[u.id] || STYLES[0].id;
  if (action === 'tour') { viewPref.set('photo'); await openTour(u.id, sid, undefined, { timeOfDay: state.tod }); return; }
  viewPref.set('3d');
  const v = await getViewer();
  if (!v) { toast(t('sel.3d.failed'), 4200); return; }
  await openImmersive('keep');
  try { await v.ready; } catch (e) { toast(t('sel.3d.failed'), 4200); return; }
  await v.selectUnit(u.id, sid);
  let ok = true;
  if (action === 'walk') ok = await v.goToStreet();              // from the street: tap the front door, lobby, lift
  else if (action === 'inside') ok = await v.walkUnit(u.id);
  else if (action === 'balcony') ok = await v.balconyView(u.id);
  else if (action === 'lift') ok = await v.takeLift(u.floor === 'ground' ? 'basement' : 'ground', u.floor);
  if (!ok) toast(t('v.unavailable'));
}

function bindUnitSheet() {
  const sheet = $('#unitSheet');
  const stepUnit = d => {
    const i = UNITS.findIndex(x => x.id === unitUI.id);
    if (i >= 0) go(`unit-${unitToken(UNITS[(i + d + UNITS.length) % UNITS.length].id)}`);
  };
  sheet.addEventListener('click', e => {
    const u = unitById(unitUI.id);
    if (!u) return;
    const sb = e.target.closest('[data-style]');
    if (sb) {
      if (state.style[u.id] === sb.dataset.style) return;
      state.style[u.id] = sb.dataset.style;
      renderUnitSheet(true);
      $(`#usPk [data-style="${sb.dataset.style}"]`)?.scrollIntoView?.({ block: 'nearest', inline: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
      (sb.closest('.us-dots') ? $(`.us-dots [data-style="${sb.dataset.style}"]`) : $(`#usPk [data-style="${sb.dataset.style}"]`))?.focus({ preventScroll: true });
      if (viewerApi && viewerApi.currentUnit?.() === u.id) viewerApi.selectUnit(u.id, sb.dataset.style);
      return;
    }
    const b = e.target.closest('[data-us]');
    if (!b) return;
    const a = b.dataset.us;
    if (a === 'back') go(`floor-${u.floor}`);
    else if (a === 'close') dismissAll();
    else if (a === 'prev') stepUnit(-1);
    else if (a === 'next') stepUnit(1);
    else unitAction(u, a);
  });
  sheet.addEventListener('keydown', e => {
    if (e.target.id !== 'usStrip' || !/^Arrow(Left|Right)$/.test(e.key)) return;
    e.preventDefault();
    e.target.scrollBy({ left: (e.key === 'ArrowRight' ? 1 : -1) * e.target.clientWidth, behavior: reducedMotion() ? 'auto' : 'smooth' });
  });
  // header gestures: swipe sideways = previous / next apartment; on phones drag down = back to the floor
  let d = null;
  sheet.addEventListener('pointerdown', e => {
    if (!e.target.closest('.us-grab, .us-bar') || e.target.closest('button, a')) return;
    d = { x: e.clientX, y: e.clientY, t: performance.now(), dx: 0, dy: 0, id: e.pointerId, axis: null };
    try { sheet.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
  });
  sheet.addEventListener('pointermove', e => {
    if (!d || e.pointerId !== d.id) return;
    d.dx = e.clientX - d.x; d.dy = e.clientY - d.y;
    if (!d.axis && Math.hypot(d.dx, d.dy) > 8) d.axis = Math.abs(d.dx) > Math.abs(d.dy) ? 'x' : 'y';
    if (d.axis === 'y' && sheetMode()) sheet.style.transform = d.dy > 0 ? `translateY(${d.dy}px)` : '';
  });
  const end = e => {
    if (!d || (e.pointerId != null && e.pointerId !== d.id)) return;
    const g = d; d = null;
    const u = unitById(unitUI.id);
    if (g.axis === 'x' && Math.abs(g.dx) > 56) { stepUnit((g.dx < 0 ? 1 : -1) * (document.documentElement.dir === 'rtl' ? -1 : 1)); return; }
    if (g.axis === 'y' && sheetMode() && u) {
      const v = g.dy / Math.max(1, performance.now() - g.t);
      if (g.dy > 120 || (g.dy > 30 && v > 0.5)) {
        // slide the rest of the way down, then show the floor card
        const a = sheet.animate?.([{ transform: `translateY(${g.dy}px)` }, { transform: 'translateY(104%)' }], { duration: 200, easing: 'ease-in', fill: 'forwards' });
        const done = () => { closeUnit(false); go(`floor-${u.floor}`); };
        if (a && !reducedMotion()) a.finished.then(done, done); else done();
        return;
      }
      sheet.style.transform = '';
      if (g.dy > 0 && !reducedMotion()) sheet.animate?.([{ transform: `translateY(${g.dy}px)` }, { transform: 'none' }], { duration: 200, easing: 'cubic-bezier(.2, .7, .2, 1)' });
    }
  };
  sheet.addEventListener('pointerup', end);
  sheet.addEventListener('pointercancel', end);
}

// ---------------------------------------------------------------- reservation
const COUNTRIES = ['PT', 'IL', 'GB', 'FR', 'DE', 'ES', 'IT', 'NL', 'BE', 'CH', 'IE', 'LU', 'US', 'CA', 'BR', 'AO', 'MZ', 'UA', 'PL', 'RO', 'CY', 'SE', 'NO', 'DK', 'AE', 'ZA', 'AU', 'CN', 'IN'];
const DIAL = { PT: '351', IL: '972', GB: '44', FR: '33', DE: '49', ES: '34', IT: '39', NL: '31', BE: '32', CH: '41', IE: '353', LU: '352', US: '1', CA: '1', BR: '55', AO: '244', MZ: '258', UA: '380', PL: '48', RO: '40', CY: '357', SE: '46', NO: '47', DK: '45', AE: '971', ZA: '27', AU: '61', CN: '86', IN: '91' };
function countryName(code) {
  try { return new Intl.DisplayNames([langInfo().locale], { type: 'region' }).of(code); } catch (e) { return code; }
}
function makeRef(unitId) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  const rnd = (window.crypto?.getRandomValues) ? window.crypto.getRandomValues(new Uint32Array(4)) : [0, 0, 0, 0].map(() => Math.floor(Math.random() * 1e9));
  for (let i = 0; i < 4; i++) s += abc[rnd[i] % abc.length];
  return `VB2-${unitToken(unitId)}-${s}`;
}
function planFor(unitId, styleId) {
  const total = priceOf(unitId, styleId);
  const fee = PAYMENT_PLAN.reservationFee;
  const rows = PAYMENT_PLAN.steps.map(s => ({ key: s.key, pct: s.pct, label: L(s.label), amount: Math.round(total * s.pct / 100) }));
  return { total, fee, rows, cpcvBalance: rows[0].amount - fee };
}

function renderReserve(page, preset) {
  const R = state.res;
  if (preset && preset !== R.unitId) { R.unitId = preset; R.step = 1; R.ref = null; R.saved = null; }
  if (preset && state.style[preset]) R.styleId = state.style[preset];
  if (!R.unitId || !isAvail(R.unitId)) {
    if (R.step < 4) { const first = UNITS.find(u => isAvail(u.id)); if (!R.unitId || (R.unitId && !isAvail(R.unitId))) R.unitId = preset && isAvail(preset) ? preset : (R.unitId && isAvail(R.unitId) ? R.unitId : first?.id || null); }
  }
  const steps = ['res.step1', 'res.step2', 'res.step3', 'res.step4'];
  page.innerHTML = `<div class="wrap res">
    <div class="sec-head" style="margin-bottom:0"><p class="eyebrow">${esc(t('res.eyebrow'))}</p><h2>${esc(t('res.title'))}</h2><p class="lede">${esc(t('res.lede', { fee: fmtMoney(PAYMENT_PLAN.reservationFee) }))}</p></div>
    <ol class="stepper">${steps.map((k, i) => `<li class="${i + 1 === R.step ? 'is-on' : i + 1 < R.step ? 'is-done' : ''}"${i + 1 === R.step ? ' aria-current="step"' : ''}><span>${esc(t(k))}</span></li>`).join('')}</ol>
    <div class="res-card" id="resCard"></div>
  </div>`;
  const card = $('#resCard', page);
  if (R.step === 1) resStep1(card);
  else if (R.step === 2) resStep2(card);
  else if (R.step === 3) resStep3(card);
  else resStep4(card);
}

function summaryHtml(R) {
  const u = unitById(R.unitId);
  if (!u) return '';
  const s = styleById(R.styleId);
  return `<div class="summary">
    <span class="h-small">${esc(t('res.summary'))}</span>
    <h4><bdi>${u.id}</bdi> · <bdi>${u.type}</bdi> · <bdi>${fmtNum(u.area, 2)}</bdi> ${esc(t('misc.m2'))}</h4>
    <p class="fineprint">${esc(floorName(u.floor))} · ${esc(t('unit.parkingBay', { bay: u.parking }))}</p>
    <div class="row"><span>${esc(t('res.base'))}</span><span>${fmtMoney(u.price)}</span></div>
    <div class="row"><span>${esc(t('price.perM2'))}</span><span>${ppmFmt(ppmOf(u))}</span></div>
    <div class="row"><span>${esc(t('res.finish'))} · ${esc(L(s.name))}</span><span>${s.extra ? '+ ' + fmtMoney(s.extra) : esc(t('unit.included'))}</span></div>
    <div class="row total"><span>${esc(t('res.total'))}</span><span>${fmtMoney(priceOf(u.id, s.id))}</span></div>
    <div class="row"><span>${esc(t('pay.deposit'))}</span><span>${fmtMoney(PAYMENT_PLAN.reservationFee)}</span></div>
  </div>`;
}

function resStep1(card) {
  const R = state.res;
  card.innerHTML = `<div class="res-grid">
    <div style="display:grid;gap:20px;min-width:0">
      <div class="field"><span class="lbl">${esc(t('res.choose'))}</span>
        <div class="unit-pick">${UNITS.map(u => `<button type="button" data-pick="${u.id}" aria-pressed="${u.id === R.unitId}" ${isAvail(u.id) ? '' : 'disabled'}><b>${u.id}</b><span>${u.type} · ${fmtNum(u.area, 1)} ${esc(t('misc.m2'))}</span><span>${isAvail(u.id) ? fmtMoney(u.price) : esc(t('status.' + statusOf(u.id)))}</span></button>`).join('')}</div>
      </div>
      <div class="field"><span class="lbl">${esc(t('res.finish'))}</span>
        <div class="pk-row">${STYLES.map(s => { const s0 = R.unitId ? unitStills(R.unitId, s.id)[0] : null; return packageCard(s, { pressed: s.id === R.styleId, thumb: s0 ? (s0.thumb || s0.file) : null, compact: true }); }).join('')}</div>
      </div>
    </div>
    ${R.unitId ? summaryHtml(R) : `<p class="notice">${esc(t('res.unavailable'))}</p>`}
  </div>
  <div class="res-actions"><a class="btn-text" href="${R.unitId ? `#unit-${unitToken(R.unitId)}` : '#apartments'}">← ${esc(t('res.back'))}</a><button type="button" class="btn btn-bronze" data-next ${R.unitId ? '' : 'disabled'}>${esc(t('res.next'))}</button></div>`;
  card.onclick = e => {
    const p = e.target.closest('[data-pick]');
    if (p) { R.unitId = p.dataset.pick; if (state.style[R.unitId]) R.styleId = state.style[R.unitId]; resStep1(card); return; }
    const s = e.target.closest('[data-style]');
    if (s) { R.styleId = s.dataset.style; if (R.unitId) state.style[R.unitId] = R.styleId; resStep1(card); return; }
    if (e.target.closest('[data-next]') && R.unitId) { R.step = 2; renderReserve($('#page')); }
  };
}

function resStep2(card) {
  const R = state.res;
  const d = R.data;
  if (!d.lang) d.lang = getLang();
  if (!d.dial) d.dial = { he: '972', pt: '351', ru: '351' }[getLang()] || '351';
  if (!d.contactPref) d.contactPref = 'email';
  const dialOpts = [...new Set(Object.values(DIAL))].sort((a, b) => a - b).map(c => `<option value="${c}"${c === d.dial ? ' selected' : ''}>+${c}</option>`).join('');
  const countries = COUNTRIES.map(c => ({ c, n: countryName(c) })).sort((a, b) => a.n.localeCompare(b.n, langInfo().locale));
  const sources = ['web', 'social', 'referral', 'agent', 'sign', 'other'];
  card.innerHTML = `<form id="resForm" novalidate>
    <div class="res-grid">
      <div class="fields">
        <div class="field full"><label for="rName">${esc(t('f.name'))}</label><input id="rName" name="name" autocomplete="name" required value="${esc(d.name || '')}"><span class="err" hidden></span></div>
        <div class="field full"><label for="rEmail">${esc(t('f.email'))}</label><input id="rEmail" name="email" type="email" autocomplete="email" inputmode="email" required value="${esc(d.email || '')}"><span class="err" hidden></span></div>
        <div class="field full"><label for="rPhone">${esc(t('f.phone'))}</label>
          <div class="phone-row"><select id="rDial" name="dial" aria-label="${esc(t('f.code'))}">${dialOpts}</select><input id="rPhone" name="phone" type="tel" autocomplete="tel-national" inputmode="tel" required value="${esc(d.phone || '')}"></div><span class="err" hidden></span></div>
        <div class="field"><label for="rCountry">${esc(t('f.country'))}</label><select id="rCountry" name="country" required><option value="">${esc(t('f.select'))}</option>${countries.map(({ c, n }) => `<option value="${c}"${d.country === c ? ' selected' : ''}>${esc(n)}</option>`).join('')}<option value="OTHER"${d.country === 'OTHER' ? ' selected' : ''}>${esc(t('src.other'))}</option></select><span class="err" hidden></span></div>
        <div class="field"><label for="rLang">${esc(t('f.lang'))}</label><select id="rLang" name="lang">${LANGS.map(l => `<option value="${l.id}"${d.lang === l.id ? ' selected' : ''}>${esc(l.name)}</option>`).join('')}</select></div>
        <div class="field full"><label for="rNif">${esc(t('f.nif'))} <span class="opt">(${esc(t('f.optional'))})</span></label><input id="rNif" name="nif" inputmode="numeric" autocomplete="off" value="${esc(d.nif || '')}"><span class="hint">${esc(t('f.nifHint'))}</span></div>
        <div class="field"><label for="rSource">${esc(t('f.source'))}</label><select id="rSource" name="source"><option value="">${esc(t('f.select'))}</option>${sources.map(s => `<option value="${s}"${d.source === s ? ' selected' : ''}>${esc(t('src.' + s))}</option>`).join('')}</select></div>
        <div class="field"><span class="lbl" id="rCpL">${esc(t('f.contactPref'))}</span><div class="radios" role="radiogroup" aria-labelledby="rCpL">${['email', 'phone', 'whatsapp'].map(c => `<label><input type="radio" name="contactPref" value="${c}"${d.contactPref === c ? ' checked' : ''}>${esc(t('cp.' + c))}</label>`).join('')}</div></div>
        <div class="field full"><label class="consent"><input type="checkbox" id="rConsent" name="consent"${d.consent ? ' checked' : ''}><span>${esc(t('f.consent'))}</span></label><span class="err" hidden></span></div>
      </div>
      ${summaryHtml(R)}
    </div>
    <div class="res-actions"><button type="button" class="btn-text" data-back>← ${esc(t('res.back'))}</button><button type="submit" class="btn btn-bronze">${esc(t('res.next'))}</button></div>
  </form>`;
  const form = $('#resForm', card);
  const collect = () => {
    const fd = new FormData(form);
    Object.assign(d, { name: (fd.get('name') || '').trim(), email: (fd.get('email') || '').trim(), dial: fd.get('dial'), phone: (fd.get('phone') || '').trim(), country: fd.get('country') || '', lang: fd.get('lang'), nif: (fd.get('nif') || '').trim(), source: fd.get('source') || '', contactPref: fd.get('contactPref') || 'email', consent: $('#rConsent', form).checked });
  };
  $('#rCountry', form).addEventListener('change', e => {
    const dial = DIAL[e.target.value];
    if (dial && !$('#rPhone', form).value) $('#rDial', form).value = dial;
  });
  form.addEventListener('input', () => collect());
  $('[data-back]', form).addEventListener('click', () => { collect(); R.step = 1; renderReserve($('#page')); });
  form.addEventListener('submit', e => {
    e.preventDefault();
    collect();
    const errs = [];
    const setErr = (id, msgKey) => {
      const f = $(id, form).closest('.field');
      const er = $('.err', f);
      f.classList.toggle('has-err', !!msgKey);
      er.hidden = !msgKey; er.textContent = msgKey ? t(msgKey) : '';
      if (msgKey) errs.push(id);
    };
    setErr('#rName', d.name.length < 2 ? 'err.required' : null);
    setErr('#rEmail', !d.email ? 'err.required' : (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email) ? 'err.email' : null));
    setErr('#rPhone', (d.phone.replace(/\D/g, '').length < 6) ? (d.phone ? 'err.phone' : 'err.required') : null);
    setErr('#rCountry', !d.country ? 'err.required' : null);
    setErr('#rConsent', !d.consent ? 'err.consent' : null);
    if (errs.length) { $(errs[0], form).focus(); return; }
    if (!R.ref || !R.ref.includes(unitToken(R.unitId))) R.ref = makeRef(R.unitId);
    R.step = 3;
    renderReserve($('#page'));
  });
}

function resStep3(card) {
  const R = state.res;
  const u = unitById(R.unitId);
  const p = planFor(R.unitId, R.styleId);
  const hasBank = !!BANK.iban;
  card.innerHTML = `<div class="res-grid">
    <div style="display:grid;gap:18px;min-width:0">
      <h3 class="h-mid">${esc(t('pay.title', { unit: u.id }))}</h3>
      <div class="table-wrap"><table class="plan-table">
        <thead><tr><th>${esc(t('pay.due'))}</th><th>€</th></tr></thead>
        <tbody>
          <tr class="now"><td>${esc(t('pay.reservation'))}<span class="note">${esc(t('pay.reservationNote'))}</span></td><td>${fmtMoney(p.fee)}</td></tr>
          ${p.rows.map((r, i) => `<tr><td>${esc(r.label)}<span class="note">${esc(t('pay.pct', { pct: r.pct }))}${i === 0 ? ` · ${esc(t('pay.balance'))}: ${fmtMoney(p.cpcvBalance)}` : ''}</span></td><td>${fmtMoney(r.amount)}</td></tr>`).join('')}
          <tr><td><b>${esc(t('res.total'))}</b></td><td><b>${fmtMoney(p.total)}</b></td></tr>
        </tbody></table></div>
      <p class="fineprint">${esc(t('pay.terms'))}</p>
    </div>
    <div style="display:grid;gap:14px;align-content:start;min-width:0">
      <div class="refbox"><span class="h-small">${esc(t('pay.reference'))}</span><span class="ref" id="payRef">${esc(R.ref)}</span><span class="fineprint">${esc(t('pay.refNote'))}</span></div>
      <div class="summary"><span class="h-small">${esc(t('pay.bank'))}</span>
        <div class="row"><span>${esc(t('pay.deposit'))}</span><b>${fmtMoney(p.fee)}</b></div>
        <div class="bank">
          <div class="row"><span>${esc(t('pay.beneficiary'))}</span><span>${esc(BANK.beneficiary)}</span></div>
          ${hasBank ? `
            ${BANK.bank ? `<div class="row"><span>${esc(t('pay.bankName'))}</span><span>${esc(BANK.bank)}</span></div>` : ''}
            <div class="row"><span>${esc(t('pay.iban'))}</span><span class="mono" style="user-select:all">${esc(BANK.iban)}</span></div>
            ${BANK.bic ? `<div class="row"><span>${esc(t('pay.bic'))}</span><span class="mono">${esc(BANK.bic)}</span></div>` : ''}`
            : `<p class="fineprint">${esc(t('pay.bankPending'))}</p>`}
        </div>
      </div>
    </div>
  </div>
  <div class="res-actions"><button type="button" class="btn-text" data-back>← ${esc(t('res.back'))}</button><button type="button" class="btn btn-bronze" data-confirm>${esc(t('res.confirm'))}</button></div>`;
  $('[data-back]', card).onclick = () => { R.step = 2; renderReserve($('#page')); };
  $('[data-confirm]', card).onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = t('res.saving');
    R.saved = await saveReservation();
    R.step = 4;
    renderReserve($('#page'));
    window.scrollTo({ top: 0, behavior: 'auto' });
  };
}

function reservationDoc() {
  const R = state.res, d = R.data;
  const p = planFor(R.unitId, R.styleId);
  return {
    unitId: R.unitId, styleId: R.styleId, name: d.name, email: d.email, phone: `+${d.dial} ${d.phone}`,
    country: d.country, lang: d.lang, nif: d.nif || '', source: d.source || '', contactPref: d.contactPref,
    ref: R.ref, total: p.total, deposit: p.fee, createdAt: new Date().toISOString()
  };
}

async function withTimeout(p, ms) {
  let tm; const to = new Promise((_, rej) => { tm = setTimeout(() => rej(new Error('timeout')), ms); });
  try { return await Promise.race([p, to]); } finally { clearTimeout(tm); }
}

// Each visitor writes only their own document (reservations/<id>, leads/<id>);
// only the owner can read the collection. Every submission is appended to `all`.
async function appendOwn(col, doc) {
  const uid = await state.user?.id?.();
  if (!uid) { const e = new Error('no user'); e.code = 'invalid_argument'; throw e; }
  const ref = state.db.collection(col).doc(uid);
  let prev = [];
  try { const snap = await ref.get(); const d = snap?.data?.(); if (d && Array.isArray(d.all)) prev = d.all; } catch (e) { /* first write */ }
  await ref.set({ ...doc, all: [...prev, doc].slice(-20) });
}

async function saveReservation() {
  const doc = reservationDoc();
  if (!state.db || state.canWrite === false) return { ok: false, offline: true, doc };
  try {
    await withTimeout(appendOwn('reservations', doc), 12000);
    return { ok: true, doc };
  } catch (e) {
    console.warn('[app] reservation save failed', e);
    if (e && e.code === 'invalid_argument') state.canWrite = false;
    return { ok: false, offline: e?.code === 'invalid_argument', failed: e?.code !== 'invalid_argument', doc };
  }
}

function reservationText(doc) {
  const u = unitById(doc.unitId);
  const s = styleById(doc.styleId);
  const p = planFor(doc.unitId, doc.styleId);
  const lines = [
    `Barreiro 2 · VILNYI — ${t('res.eyebrow')}`,
    `${t('done.ref')}: ${doc.ref}`,
    `${t('res.choose')}: ${u.id} · ${u.type} · ${fmtNum(u.area, 2)} m² · ${floorName(u.floor)}`,
    `${t('res.finish')}: ${L(s.name)}${s.extra ? ` (+ ${fmtMoney(s.extra)})` : ''}`,
    `${t('res.total')}: ${fmtMoney(p.total)}`,
    `${t('pay.deposit')}: ${fmtMoney(p.fee)}`,
    '',
    `${t('f.name')}: ${doc.name}`,
    `${t('f.email')}: ${doc.email}`,
    `${t('f.phone')}: ${doc.phone}`,
    `${t('f.country')}: ${doc.country === 'OTHER' ? t('src.other') : countryName(doc.country)}`,
    `${t('f.lang')}: ${LANGS.find(l => l.id === doc.lang)?.name || doc.lang}`,
    doc.nif ? `NIF: ${doc.nif}` : null,
    doc.source ? `${t('f.source')} ${t('src.' + doc.source)}` : null,
    `${t('f.contactPref')}: ${t('cp.' + doc.contactPref)}`,
    `${doc.createdAt}`
  ];
  return lines.filter(x => x != null).join('\n');
}

function resStep4(card) {
  const R = state.res;
  const res = R.saved || { ok: false, offline: true, doc: reservationDoc() };
  const doc = res.doc;
  const first = (doc.name || '').split(' ')[0];
  const text = reservationText(doc);
  card.innerHTML = `<div class="done">
    <div class="tick"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>
    <h3>${esc(t('done.title', { name: first }))}</h3>
    <p>${esc(res.ok ? t('done.saved', { unit: doc.unitId }) : res.failed ? t('done.failed') : t('done.offline'))}</p>
    <div class="refbox" style="justify-items:center"><span class="h-small">${esc(t('done.ref'))}</span><span class="ref">${esc(doc.ref)}</span></div>
    <textarea class="copyarea" id="doneText" readonly aria-label="${esc(t('res.summary'))}">${esc(text)}</textarea>
    <div class="done-actions">
      <button type="button" class="btn btn-solid" id="doneCopy">${esc(t('done.copy'))}</button>
      <a class="btn btn-line" href="#apartments">${esc(t('done.again'))}</a>
    </div>
    ${contactHtml({ text, waLabel: t('contact.sendWa') })}
    <p class="fineprint">${esc(BANK.iban ? '' : t('pay.bankPending'))}</p>
  </div>`;
  $('#doneCopy', card).onclick = e => copyText(text, $('#doneText', card), e.currentTarget);
}

// ---------------------------------------------------------------- interest modal
function openModal(html) {
  $('#modalCard').innerHTML = html;
  $('#modal').hidden = false;
  document.body.classList.add('no-scroll');
  const f = $('#modalCard input, #modalCard button');
  f?.focus();
}
function closeModal() {
  $('#modal').hidden = true;
  $('#modalCard').classList.remove('is-lb');
  if ($('#imm').hidden && !(state.openFloor && sheetMode())) document.body.classList.remove('no-scroll');
  if (state.route === 'interest') { try { history.replaceState(null, '', '#top'); } catch (e) { /* sandboxed */ } }
}

function openInterest(unitId = '') {
  openModal(`<form id="intForm" novalidate style="display:grid;gap:16px">
    <div style="display:flex;justify-content:space-between;gap:10px;align-items:start"><h3 id="modalTitle">${esc(t('int.title'))}</h3>
    <button type="button" class="icon-btn" data-close aria-label="${esc(t('int.close'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
    <p class="fineprint">${esc(t('int.lede'))}</p>
    <div class="field"><label for="iName">${esc(t('f.name'))}</label><input id="iName" name="name" autocomplete="name" required><span class="err" hidden></span></div>
    <div class="field"><label for="iEmail">${esc(t('f.email'))}</label><input id="iEmail" name="email" type="email" autocomplete="email" required><span class="err" hidden></span></div>
    <div class="field"><label for="iPhone">${esc(t('f.phone'))} <span class="opt">(${esc(t('f.optional'))})</span></label><input id="iPhone" name="phone" type="tel" autocomplete="tel" placeholder="+351 …"></div>
    <div class="field"><label for="iUnit">${esc(t('int.unit'))}</label><select id="iUnit" name="unit"><option value="">${esc(t('int.any'))}</option>${UNITS.map(u => `<option value="${u.id}"${u.id === unitId ? ' selected' : ''}>${u.id} · ${u.type} · ${fmtMoney(u.price)}</option>`).join('')}</select></div>
    <label class="consent"><input type="checkbox" id="iConsent"><span>${esc(t('f.consent'))}</span></label><span class="err" id="iConsentErr" hidden></span>
    <button type="submit" class="btn btn-bronze">${esc(t('int.send'))}</button>
    ${contactHtml({ text: `Barreiro 2 · ${t('int.title')}${unitId ? ` · ${unitId}` : ''}` })}
  </form>`);
  const form = $('#intForm');
  $('[data-close]', form).onclick = closeModal;
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(form);
    const doc = { name: (fd.get('name') || '').trim(), email: (fd.get('email') || '').trim(), phone: (fd.get('phone') || '').trim(), unitId: fd.get('unit') || '', lang: getLang(), createdAt: new Date().toISOString() };
    let bad = null;
    const mark = (id, key) => { const f = $(id, form).closest('.field'); const er = $('.err', f); f.classList.toggle('has-err', !!key); er.hidden = !key; er.textContent = key ? t(key) : ''; if (key && !bad) bad = id; };
    mark('#iName', doc.name.length < 2 ? 'err.required' : null);
    mark('#iEmail', !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(doc.email) ? (doc.email ? 'err.email' : 'err.required') : null);
    const cons = $('#iConsent', form).checked;
    $('#iConsentErr').hidden = cons; $('#iConsentErr').textContent = cons ? '' : t('err.consent');
    if (bad) { $(bad, form).focus(); return; }
    if (!cons) return;
    let ok = false;
    if (state.db && state.canWrite !== false) {
      try { await withTimeout(appendOwn('leads', doc), 12000); ok = true; } catch (err) { if (err?.code === 'invalid_argument') state.canWrite = false; }
    }
    const text = `Barreiro 2 · ${t('int.title')}\n${doc.name}\n${doc.email}\n${doc.phone}\n${doc.unitId || t('int.any')}`;
    $('#modalCard').innerHTML = `<div style="display:grid;gap:14px"><h3 id="modalTitle">${esc(t('int.title'))}</h3>
      <p>${esc(ok ? t('int.thanks') : t('int.offline'))}</p>
      ${ok ? '' : `<textarea class="copyarea" id="intText" readonly style="min-height:120px">${esc(text)}</textarea>
      <button type="button" class="btn btn-solid" id="intCopy">${esc(t('done.copy'))}</button>`}
      ${contactHtml({ text: ok ? '' : text, waLabel: ok ? null : t('contact.sendWa') })}
      <button type="button" class="btn btn-line" data-close>${esc(t('int.close'))}</button></div>`;
    $('#modalCard [data-close]').onclick = closeModal;
    const ic = $('#intCopy'); if (ic) ic.onclick = ev => copyText(text, $('#intText'), ev.currentTarget);
  });
}

// ---------------------------------------------------------------- admin
let adminUnsubs = [];
function renderAdmin(page) {
  adminUnsubs.forEach(u => { try { u(); } catch (e) { /* ignore */ } });
  adminUnsubs = [];
  if (!state.isOwner) {
    page.innerHTML = `<div class="wrap"><div class="sec-head"><h2>${esc(t('admin.title'))}</h2><p class="lede">${esc(t('admin.denied'))}</p></div><a class="btn btn-line" href="#top">${esc(t('unit.back'))}</a></div>`;
    return;
  }
  page.innerHTML = `<div class="wrap" style="display:grid;gap:40px">
    <div class="sec-head" style="margin:0"><p class="eyebrow">VILNYI</p><h2>${esc(t('admin.title'))}</h2><p class="lede">${esc(state.db ? t('admin.lede') : t('admin.nodb'))}</p></div>
    <section><h3 class="h-mid" style="margin-bottom:14px">${esc(t('admin.units'))}</h3><div class="admin-units" id="adUnits"></div></section>
    <section><h3 class="h-mid" style="margin-bottom:14px">${esc(t('admin.reservations'))}</h3><div class="table-wrap" id="adRes"><p class="fineprint">${esc(t('admin.none'))}</p></div></section>
    <section><h3 class="h-mid" style="margin-bottom:14px">${esc(t('admin.leads'))}</h3><div class="table-wrap" id="adLeads"><p class="fineprint">${esc(t('admin.none'))}</p></div></section>
  </div>`;
  const drawUnits = () => {
    const el = $('#adUnits'); if (!el) return;
    el.innerHTML = UNITS.map(u => `<div class="admin-unit"><div style="display:flex;justify-content:space-between;align-items:baseline"><b>${u.id}</b><span class="fineprint">${u.type} · ${fmtMoney(u.price)}</span></div>
      <div class="seg">${['available', 'reserved', 'sold'].map(s => `<button type="button" class="seg-b${statusOf(u.id) === s ? ' is-on' : ''}" data-ad-unit="${u.id}" data-ad-st="${s}" ${state.db ? '' : 'disabled'}>${esc(t('status.' + s))}</button>`).join('')}</div></div>`).join('');
  };
  drawUnits();
  state.onStatusChange = drawUnits;
  $('#adUnits').addEventListener('click', async e => {
    const b = e.target.closest('[data-ad-st]');
    if (!b || !state.db) return;
    const id = b.dataset.adUnit, st = b.dataset.adSt;
    try { await state.db.collection('units').doc(id).set({ status: st, updatedAt: new Date().toISOString() }); toast(`${id} · ${t('status.' + st)}`); }
    catch (err) { toast(err?.message || 'Error'); }
  });
  if (!state.db) return;
  const table = (rows, cols) => rows.length ? `<table class="admin-table"><thead><tr>${cols.map(c => `<th>${esc(c[0])}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${cols.map(c => `<td>${c[1](r)}</td>`).join('')}</tr>`).join('')}</tbody></table>` : `<p class="fineprint">${esc(t('admin.none'))}</p>`;
  const fmtDate = s => { try { return new Date(s).toLocaleString(langInfo().locale, { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return esc(s); } };
  try {
    adminUnsubs.push(state.db.collection('reservations').limit(500).onSnapshot(snap => {
      const rows = snap.docs.flatMap(d => { const x = d.data() || {}; return Array.isArray(x.all) && x.all.length ? x.all : [x]; }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      const el = $('#adRes'); if (!el) return;
      el.innerHTML = table(rows, [
        [t('admin.date'), r => fmtDate(r.createdAt)], [t('done.ref'), r => `<span class="mono">${esc(r.ref)}</span>`],
        [t('table.unit'), r => `${esc(r.unitId)} · ${esc(L(styleById(r.styleId).name))}`], [t('f.name'), r => esc(r.name)],
        [t('admin.contact'), r => `${esc(r.email)}<br>${esc(r.phone)}<br><span class="fineprint">${esc(r.contactPref)} · ${esc(r.lang)}</span>`],
        [t('f.country'), r => esc(r.country)], ['NIF', r => esc(r.nif)], [t('f.source'), r => esc(r.source)],
        [t('res.total'), r => fmtMoney(r.total || 0)]
      ]);
    }, err => console.warn(err)));
    adminUnsubs.push(state.db.collection('leads').limit(500).onSnapshot(snap => {
      const rows = snap.docs.flatMap(d => { const x = d.data() || {}; return Array.isArray(x.all) && x.all.length ? x.all : [x]; }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      const el = $('#adLeads'); if (!el) return;
      el.innerHTML = table(rows, [
        [t('admin.date'), r => fmtDate(r.createdAt)], [t('f.name'), r => esc(r.name)], [t('f.email'), r => esc(r.email)],
        [t('f.phone'), r => esc(r.phone)], [t('int.unit'), r => esc(r.unitId || '—')], [t('f.lang'), r => esc(r.lang)]
      ]);
    }, err => console.warn(err)));
  } catch (e) { console.warn(e); }
}

// ---------------------------------------------------------------- runtime capabilities
async function initCapabilities() {
  const use = window.claude?.use;
  if (typeof use !== 'function') return;
  let db = null, user = null;
  try { [db, user] = await Promise.all([use.call(window.claude, 'db').catch(() => null), use.call(window.claude, 'user').catch(() => null)]); } catch (e) { /* none */ }
  state.db = db;
  state.user = user;
  try { state.isOwner = user ? !!(await user.isOwner()) : false; } catch (e) { state.isOwner = false; }
  try { state.canWrite = user ? await user.can('data.write') : null; } catch (e) { state.canWrite = null; }
  if (state.isOwner) { $('#adminLink').hidden = false; }
  if (db) {
    try {
      db.collection('units').onSnapshot(snap => {
        const o = {};
        for (const d of snap.docs) {
          const s = d.data()?.status;
          if (['available', 'reserved', 'sold'].includes(s) && unitById(d.id)) o[d.id] = s;
        }
        state.overrides = o;
        renderFloorList(); renderFacade(); renderTable(); renderFloorCard(); renderFacts();
        state.onStatusChange?.();
        if (unitUI.id) renderUnitSheet(true);
      }, err => console.warn('[app] units', err));
    } catch (e) { console.warn(e); }
  }
  if (state.route === 'admin') renderPage('admin', false);
}

async function initLandmarks() {
  try {
    const m = await import('./aerial.js');
    if (Array.isArray(m.LANDMARKS_VERIFIED) && m.LANDMARKS_VERIFIED.length) { state.landmarks = m.LANDMARKS_VERIFIED; renderLocation(); }
  } catch (e) { /* aerial module not present: use data.js landmarks */ }
}

// ---------------------------------------------------------------- boot
function bindGlobal() {
  bindLang();
  $('#menuBtn').addEventListener('click', () => {
    const open = !$('#nav').classList.contains('is-open');
    $('#nav').classList.toggle('is-open', open);
    $('#menuBtn').setAttribute('aria-expanded', open);
  });
  document.addEventListener('click', e => {
    const lm = e.target.closest('#distList [data-lm]');
    if (lm) { focusLandmark(lm.dataset.lm); return; }
    if (e.target.closest('#coordsCopy')) { copyText(`${PROJECT.lat}, ${PROJECT.lon}`, $('#coords'), e.target.closest('#coordsCopy')); return; }
    const c = e.target.closest('[data-copy]');
    if (c) { copyText(c.dataset.copy, c.dataset.copyTarget ? $(c.dataset.copyTarget) : null, c); return; }
    const a = e.target.closest('[data-act]');
    if (!a) return;
    if (a.dataset.act === 'explore') openImmersive('walk', { street: true });
    else if (a.dataset.act === 'aerial') openImmersive('aerial');
    else if (a.dataset.act === 'interest' && !a.closest('#page')) openInterest(a.dataset.unit || '');
  });
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
  window.addEventListener('hashchange', route);
}

function boot() {
  initTheme();
  const saved = store.get('vb2.lang');
  applyLang(saved && LANGS.some(l => l.id === saved) ? saved : 'en', false);
  renderHome();
  renderFooter();
  bindGlobal();
  bindHome();
  bindUnitSheet();
  bindImmersive();
  updateImmLabels();
  route();
  initCapabilities();
  initLandmarks();
  initSiteMap();
}

try { boot(); } catch (e) { console.error('[app] boot failed', e); }
