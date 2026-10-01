// VILNYI · Barreiro 2 — sales app (APP agent).
import {
  PROJECT, BANK, PAYMENT_PLAN, LEVELS, FLOORS, UNITS, STYLES, LANDMARKS, PARKING, BALCONIES,
  unitById, floorById
} from './data.js';
import { t, L, setLang, getLang, langInfo, fmtMoney, fmtNum, LANGS } from './i18n.js';
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
function applyLang(l, rerender = true) {
  setLang(l);
  const info = langInfo();
  const root = document.documentElement;
  root.lang = info.id;
  root.dir = info.dir;
  store.set('vb2.lang', info.id);
  $('#langSel').value = info.id;
  for (const el of $$('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of $$('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  document.title = t('meta.title');
  viewerApi?.setLang?.(info.id);
  viewerApi?.setPhotorealLabels?.(ptLabels());
  try { siteMap?.setLang?.(info.id); } catch (e) { /* ignore */ }
  updatePhotorealUI();
  if (rerender) renderAll();
}

function effectiveTheme() {
  const a = document.documentElement.getAttribute('data-theme');
  if (a) return a;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function initTheme() {
  const saved = store.get('vb2.theme');
  if (saved === 'dark' || saved === 'light') document.documentElement.setAttribute('data-theme', saved);
  $('#themeBtn').addEventListener('click', () => {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    store.set('vb2.theme', next);
  });
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
    [PROJECT.timeline.find(x => x.key === 'keys')?.date || 'Q4 2028', t('hero.fact.keys')]
  ];
  $('#facts').innerHTML = items.map(([b, s]) => `<li><b>${esc(b)}</b><span>${esc(s)}</span></li>`).join('');
}

// Façade floor bands, calibrated to assets/facade-day.jpg (1368 × 1167 px).
const FACADE_BANDS = {
  second: '408,478 440,398 1258,82 1368,214 1368,404 1256,396 1180,402 500,548 496,478',
  first: '496,548 1180,402 1256,396 1368,404 1368,640 1262,642 1190,668 425,748 425,640 496,630',
  ground: '425,748 1190,668 1262,642 1368,640 1368,1167 866,1167 836,1004 408,1004 405,960'
};
const FACADE_TAG = { second: [24, 26], first: [22, 49], ground: [20, 72] }; // % positions (left, top)

function renderFacade() {
  const svg = $('#facadeSvg');
  svg.innerHTML = RES_FLOORS.map(f => `<polygon class="fl-band${state.openFloor === f ? ' is-on' : ''}" data-floor="${f}" points="${FACADE_BANDS[f]}" tabindex="0" role="button" aria-label="${esc(floorName(f))}"/>`).join('');
  let tags = $('#facadeTags');
  if (!tags) { tags = document.createElement('div'); tags.id = 'facadeTags'; tags.className = 'facade-tags'; $('#facade').appendChild(tags); }
  tags.innerHTML = RES_FLOORS.map(f => {
    const us = floorUnits(f);
    const avail = us.filter(u => isAvail(u.id)).length;
    const [x, y] = FACADE_TAG[f];
    return `<button type="button" class="ftag${state.openFloor === f ? ' is-on' : ''}" data-floor="${f}" style="left:${x}%;top:${y}%"><span class="mono">${levelMark(f)}</span><b>${esc(floorName(f).split(' · ')[0])}</b><em>${avail}/${us.length}</em></button>`;
  }).join('');
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
      <input type="range" id="fMax" min="${PRICE_MIN}" max="${PRICE_MAX}" step="5000" value="${max}" aria-label="${esc(t('filter.price'))}">
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
      <td class="t-price">${fmtMoney(u.price)}</td>
      <td class="t-status"><span class="pill st-${st}">${esc(t('status.' + st))}</span></td>
      <td class="t-go"><a href="#unit-${unitToken(u.id)}" aria-label="${esc(t('unit.apartment', { id: u.id }))}">→</a></td>
    </tr>`;
  }).join('');
  const none = UNITS.filter(matches).length === 0;
  $('#availTable').innerHTML = `<thead><tr>
    <th>${esc(t('table.unit'))}</th><th class="t-floor">${esc(t('table.floor'))}</th><th>${esc(t('table.type'))}</th><th>${esc(t('table.area'))}</th>
    <th class="t-out">${esc(t('table.outdoor'))}</th><th class="t-aspect">${esc(t('table.aspect'))}</th><th>${esc(t('table.price'))}</th><th>${esc(t('table.status'))}</th><th class="t-go"></th>
    </tr></thead><tbody>${rows}</tbody>`;
  $('#availNote').innerHTML = none
    ? `<span class="empty">${esc(t('filter.none'))} <button type="button" class="btn btn-line btn-sm" id="fReset">${esc(t('filter.reset'))}</button></span>`
    : esc(t('hero.note'));
  const fc = $('#fCount'); if (fc) fc.textContent = t('filter.count', { n: UNITS.filter(matches).length });
}

function unitTip(u) {
  const st = statusOf(u.id);
  const out = u.outdoor ? `${fmtNum(u.outdoor, 1)} ${t('misc.m2')} ${t('outdoor.' + u.outdoorKind)}` : '';
  return `<b><bdi>${u.id}</bdi> · <bdi>${u.type}</bdi></b>${areaFmt(u.area)}${out ? ` · ${esc(out)}` : ''}<br>${fmtMoney(u.price)} <span class="pill st-${st}">${esc(t('status.' + st))}</span>`;
}

function renderPlanPanel() {
  const panel = $('#planPanel');
  const f = state.openFloor;
  if (!f) { panel.hidden = true; panel.innerHTML = ''; return; }
  panel.hidden = false;
  const floor = floorById(f);
  const svg = drawFloorplan(f, { label: L, status: statusOf, dim: id => !matches(unitById(id)), title: floorName(f) });
  const us = floorUnits(f);
  panel.innerHTML = `
    <div class="pp-head">
      <h3 class="pp-title">${esc(floorName(f))}<span class="mono">${levelMark(f)}</span></h3>
      <div class="pp-tools">
        <div class="seg" role="tablist">
          <button type="button" class="seg-b${state.planView === 'plan' ? ' is-on' : ''}" data-pv="plan">${esc(t('plan.view.plan'))}</button>
          <button type="button" class="seg-b${state.planView === 'drawing' ? ' is-on' : ''}" data-pv="drawing">${esc(t('plan.view.drawing'))}</button>
        </div>
        <button type="button" class="icon-btn" data-act="closePlan" aria-label="${esc(t('plan.close'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
      </div>
    </div>
    <div class="pp-body">
      <div class="pp-plan" id="ppPlan">${state.planView === 'plan' ? svg : `<div class="pp-drawing"><img src="${floor.plan}" alt="${esc(t('plan.drawing.alt', { floor: floorName(f) }))}" loading="lazy"></div>`}<div class="fp-tip" id="fpTip" hidden></div></div>
      <div class="pp-units">
        <p class="pp-hint">${esc(t('plan.hover'))}</p>
        ${us.map(u => {
          const st = statusOf(u.id);
          return `<a class="pp-unit${matches(u) ? '' : ' is-dim'}" href="#unit-${unitToken(u.id)}" data-unit="${u.id}">
            <span class="pp-id">${u.id}</span>
            <span class="pp-info"><b>${u.type}</b> · ${areaFmt(u.area)}<br>${u.outdoor ? `${fmtNum(u.outdoor, 1)} ${t('misc.m2')} ${esc(t('outdoor.' + u.outdoorKind))} · ` : ''}${u.aspect.join(' · ')}</span>
            <span class="pp-price">${fmtMoney(u.price)}<br><span class="pill st-${st}">${esc(t('status.' + st))}</span></span>
          </a>`;
        }).join('')}
      </div>
    </div>`;
}

function renderSpecs() {
  const specs = [['energy', 'bld.energy', 'bld.energyT'], ['pv', 'bld.pv', 'bld.pvT'], ['lift', 'bld.lift', 'bld.liftT'], ['parking', 'bld.parking', 'bld.parkingT'], ['mansard', 'bld.mansard', 'bld.mansardT'], ['garden', 'bld.outdoor', 'bld.outdoorT']];
  $('#specs').innerHTML = specs.map(([i, h, p]) => `<li>${icon(i)}<b>${esc(t(h))}</b><span>${esc(t(p))}</span></li>`).join('');
  $('#timeline').innerHTML = PROJECT.timeline.map(x => `<li><span class="tl-date">${esc(x.date)}</span><span class="tl-label">${esc(L(x.label))}</span></li>`).join('');
  $('#finishCards').innerHTML = STYLES.map(s => finishCard(s, false)).join('');
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

function renderFooter() {
  $('#footDev').innerHTML = `${esc(PROJECT.developer)}<br>${esc(PROJECT.postcode)}, Portugal`;
  const c = PROJECT.contact;
  let html = `<div class="copyline"><span class="val" id="footEmail">${esc(c.email)}</span><button type="button" class="copybtn" data-copy="${esc(c.email)}" data-copy-target="#footEmail">${esc(t('foot.copy'))}</button></div>`;
  if (c.phone) html += `<div class="copyline"><span class="val" id="footPhone">${esc(c.phone)}</span><button type="button" class="copybtn" data-copy="${esc(c.phone)}" data-copy-target="#footPhone">${esc(t('foot.copy'))}</button></div>`;
  $('#footContact').innerHTML = html;
  $('#adminLink').hidden = !state.isOwner;
}

function renderHome() {
  renderFacts();
  renderFacade();
  renderFloorList();
  renderFilters();
  renderTable();
  renderPlanPanel();
  renderSpecs();
  renderLocation();
}

function renderAll() {
  renderHome();
  renderFooter();
  if (state.route && !isHomeRoute(state.route)) renderPage(state.route, false);
  updateImmLabels();
}

// ---------------------------------------------------------------- floor selection
function openFloor(f, scroll = true) {
  state.openFloor = RES_FLOORS.includes(f) || f === 'basement' ? f : null;
  renderFacade(); renderFloorList(); renderPlanPanel();
  if (scroll && state.openFloor) requestAnimationFrame(() => $('#planPanel').scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

function bindHome() {
  const facade = $('#facade');
  const tip = $('#facadeTip');
  const hoverFloor = (f) => {
    $$('.fl-band').forEach(b => b.classList.toggle('is-hover', b.dataset.floor === f));
    $$('.floor-row').forEach(b => b.classList.toggle('is-hover', b.dataset.floor === f));
  };
  facade.addEventListener('pointermove', e => {
    const band = e.target.closest?.('[data-floor]');
    if (!band) { tip.hidden = true; hoverFloor(null); return; }
    const f = band.dataset.floor;
    hoverFloor(f);
    if (e.pointerType !== 'mouse') return;
    const us = floorUnits(f);
    tip.textContent = `${floorName(f)} · ${us.filter(u => isAvail(u.id)).length}/${us.length} ${t('status.available').toLowerCase()}`;
    const r = facade.getBoundingClientRect();
    tip.hidden = false;
    tip.style.left = `${Math.min(e.clientX - r.left + 14, r.width - tip.offsetWidth - 8)}px`;
    tip.style.top = `${Math.max(e.clientY - r.top - 36, 6)}px`;
  });
  facade.addEventListener('pointerleave', () => { tip.hidden = true; hoverFloor(null); });
  facade.addEventListener('click', e => {
    const band = e.target.closest?.('[data-floor]');
    if (band) go(`floor-${band.dataset.floor}`);
  });
  facade.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset?.floor) { e.preventDefault(); go(`floor-${e.target.dataset.floor}`); }
  });
  $('#floorList').addEventListener('click', e => {
    const b = e.target.closest('[data-floor]');
    if (!b) return;
    if (state.openFloor === b.dataset.floor) { state.openFloor = null; openFloor(null, false); history.replaceState(null, '', '#apartments'); }
    else go(`floor-${b.dataset.floor}`);
  });
  $('#floorList').addEventListener('pointerover', e => hoverFloor(e.target.closest('[data-floor]')?.dataset.floor || null));

  // façade / 3D toggle
  $('#selFacadeTab').addEventListener('click', () => setSelView('facade'));
  $('#sel3dTab').addEventListener('click', () => setSelView('3d'));
  $('#sel3dLoad').addEventListener('click', () => mountSel3d());

  // plan panel
  const panel = $('#planPanel');
  panel.addEventListener('click', e => {
    const pv = e.target.closest('[data-pv]');
    if (pv) { state.planView = pv.dataset.pv; renderPlanPanel(); return; }
    if (e.target.closest('[data-act="closePlan"]')) { openFloor(null, false); history.replaceState(null, '', '#apartments'); return; }
    const u = e.target.closest('svg [data-unit]');
    if (u) go(`unit-${unitToken(u.dataset.unit)}`);
  });
  panel.addEventListener('keydown', e => {
    const u = e.target.closest?.('svg [data-unit]');
    if (u && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); go(`unit-${unitToken(u.dataset.unit)}`); }
  });
  let hoverId = null;
  const setUnitHover = (id, ev) => {
    if (id !== hoverId) {
      hoverId = id;
      $$('#planPanel [data-unit]').forEach(el => el.classList.toggle('is-hover', el.dataset.unit === id));
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
    renderTable(); renderPlanPanel();
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
  renderFilters(); renderTable(); renderPlanPanel();
  if (focusId) document.getElementById(focusId)?.focus();
}

function setSelView(v) {
  const is3d = v === '3d';
  $('#selFacadeTab').classList.toggle('is-on', !is3d); $('#selFacadeTab').setAttribute('aria-selected', !is3d);
  $('#sel3dTab').classList.toggle('is-on', is3d); $('#sel3dTab').setAttribute('aria-selected', is3d);
  $('#facade').hidden = is3d;
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
        v.on('mode', ({ mode }) => updateImmModes(mode));
        v.on('place', info => updatePlace(info));
        v.on('photoreal', ev => onPhotoreal(ev));
        v.setPhotorealLabels?.(ptLabels());
        viewerApi = v;
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
  document.body.classList.remove('no-scroll');
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

function updateImmModes(mode) {
  $$('#immModes [data-mode]').forEach(b => {
    b.classList.toggle('is-on', b.dataset.mode === mode);
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
  for (const el of $$('#imm [data-i18n]')) el.textContent = t(el.dataset.i18n);
  $('#todSel').value = viewerApi?.getTimeOfDay?.() || 'golden';
}

function bindImmersive() {
  $('#immClose').addEventListener('click', () => closeImmersive());
  $('#immModes').addEventListener('click', async e => {
    const b = e.target.closest('[data-mode]');
    if (!b || !viewerApi) return;
    const ok = await viewerApi.setMode(b.dataset.mode);
    if (!ok) toast(t('v.unavailable'));
  });
  $('#todSel').addEventListener('change', e => viewerApi?.setTimeOfDay(e.target.value));
  $('#prBtn').addEventListener('click', () => togglePhotoreal());
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!$('#modal').hidden) closeModal();
    else if (!$('#imm').hidden) closeImmersive();
  });
}

// ---------------------------------------------------------------- routing
const HOME_SECTIONS = ['', 'top', 'apartments', 'location', 'building'];
function isHomeRoute(r) { return HOME_SECTIONS.includes(r) || r.startsWith('floor-') || r === 'interest' || r === '3d' || r === 'aerial'; }

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
    if (r.startsWith('floor-')) {
      openFloor(r.slice(6), true);
    } else if (r === 'interest') {
      openInterest();
    } else if (r === '3d' || r === 'aerial') {
      openImmersive(r === 'aerial' ? 'aerial' : 'exterior');
    } else {
      const target = r ? document.getElementById(r) : null;
      if (target) requestAnimationFrame(() => target.scrollIntoView({ behavior: wasPage ? 'auto' : 'smooth', block: 'start' }));
      else if (wasPage || !r) window.scrollTo({ top: 0, behavior: 'auto' });
    }
    return;
  }
  renderPage(r, prev !== r);
}

function renderPage(r, scrollTop) {
  detachHostFromPage();
  showHome(false);
  const page = $('#page');
  if (r.startsWith('unit-')) renderUnit(page, tokenToUnit(r.slice(5)));
  else if (r === 'reserve' || r.startsWith('reserve-')) renderReserve(page, r === 'reserve' ? null : tokenToUnit(r.slice(8)));
  else if (r === 'admin') renderAdmin(page);
  else { showHome(true); return; }
  if (scrollTop) window.scrollTo({ top: 0, behavior: 'auto' });
}

// ---------------------------------------------------------------- unit page
function renderUnit(page, id) {
  const u = unitById(id);
  if (!u) {
    page.innerHTML = `<div class="wrap"><p class="lede">${esc(t('unit.notfound'))}</p><a class="btn btn-line" href="#apartments">${esc(t('unit.back'))}</a></div>`;
    return;
  }
  const styleId = state.style[u.id] || 'atlantic';
  const style = styleById(styleId);
  const st = statusOf(u.id);
  const idx = UNITS.indexOf(u);
  const prev = UNITS[(idx + UNITS.length - 1) % UNITS.length], next = UNITS[(idx + 1) % UNITS.length];
  const rooms = unitRoomAreas(u.id);
  const bay = PARKING.find(p => p.unit === u.id);
  const garden = u.outdoorKind === 'garden';
  const view = state.unitPlanView || 'plan';
  const dirWord = { N: t('aspect.N'), S: t('aspect.S'), E: t('aspect.E'), W: t('aspect.W') };

  const roomRows = rooms.map(r => {
    const name = r.name ? L(r.name) : (r.use === 'deck' ? t('unit.garden') : t('unit.balcony'));
    return `<tr${r.use === 'balcony' || r.use === 'deck' || r.use === 'garden' ? ' class="sub"' : ''}><td>${esc(name)}</td><td>${fmtNum(r.area, 1)} ${esc(t('misc.m2'))}</td></tr>`;
  }).join('') + (bay ? `<tr class="sub"><td>${esc(t('unit.parking'))} · ${bay.id}</td><td>${fmtNum((bay.x1 - bay.x0) * (bay.z1 - bay.z0), 1)} ${esc(t('misc.m2'))}</td></tr>` : '');

  const planHtml = view === 'plan'
    ? drawFloorplan(u.floor, { label: L, status: statusOf, only: u.id, title: `${u.id} · ${floorName(u.floor)}` })
    : `<div class="pp-drawing"><img src="${floorById(u.floor).plan}" alt="${esc(t('plan.drawing.alt', { floor: floorName(u.floor) }))}" loading="lazy"></div>`;

  page.innerHTML = `<div class="wrap unit" data-unit="${u.id}">
    <nav class="crumbs">
      <a class="btn-text" href="#apartments">← ${esc(t('unit.back'))}</a>
      <span style="display:flex;gap:18px"><a class="btn-text" href="#unit-${unitToken(prev.id)}">${esc(t('unit.prev'))} · <bdi>${prev.id}</bdi></a><a class="btn-text" href="#unit-${unitToken(next.id)}"><bdi>${next.id}</bdi> · ${esc(t('unit.next'))}</a></span>
    </nav>
    <header class="unit-head">
      <p class="eyebrow">${esc(floorName(u.floor))} · <bdi class="mono">${levelMark(u.floor)}</bdi></p>
      <h1 class="unit-title"><bdi>${u.id}</bdi><span class="sep">·</span><bdi>${u.type}</bdi><span class="sep">·</span><bdi class="num">${fmtNum(u.area, 2)}</bdi> <span class="mono">${esc(t('misc.m2'))}</span></h1>
      <div><span class="pill st-${st}">${esc(t('status.' + st))}</span></div>
    </header>
    <div class="unit-grid">
      <div class="unit-main">
        <section>
          <div class="block-h"><h3>${esc(t('unit.tour'))}</h3></div>
          <div class="tour" id="tour">
            <div class="tour-poster" id="tourPoster">
              <img src="assets/${u.floor === 'second' ? 'street-dusk' : 'facade-day'}.jpg" alt="">
              <div class="tp-in"><button type="button" class="btn btn-light" data-tour="start">${esc(t('unit.tour.start'))}</button><p>${esc(t('unit.tour.note'))}</p></div>
            </div>
          </div>
          <div class="tour-bar">
            <button type="button" class="btn btn-line" data-tour="walk" aria-pressed="false">${esc(t('unit.walk'))}</button>
            <button type="button" class="btn btn-line" data-tour="views" aria-pressed="false">${esc(t('unit.views'))}</button>
            <button type="button" class="btn btn-line" data-tour="balcony">${esc(garden ? t('unit.gardenView') : t('unit.balconyView'))}</button>
            <button type="button" class="btn btn-line" data-tour="lift">${esc(t('unit.lift.take'))}</button>
            <button type="button" class="btn btn-line btn-pr" data-tour="photoreal" aria-pressed="false">${esc(t('v.photoreal'))}</button>
            <button type="button" class="btn btn-line" data-tour="full">${esc(t('unit.fullscreen'))}</button>
          </div>
          <div class="hotspots" id="hotspots" hidden></div>
        </section>
        <section>
          <div class="block-h"><h3>${esc(t('unit.finish'))}</h3><p class="fineprint">${esc(t('unit.finishNote'))}</p></div>
          <div class="finish-pick" id="finishPick">${STYLES.map(s => finishCard(s, true, s.id === styleId)).join('')}</div>
        </section>
        <section>
          <div class="block-h"><h3>${esc(t('unit.plan'))}</h3>
            <div class="seg"><button type="button" class="seg-b${view === 'plan' ? ' is-on' : ''}" data-upv="plan">${esc(t('plan.view.plan'))}</button><button type="button" class="seg-b${view === 'drawing' ? ' is-on' : ''}" data-upv="drawing">${esc(t('plan.view.drawing'))}</button></div>
          </div>
          <div class="unit-plan">${planHtml}</div>
        </section>
        <section>
          <div class="block-h"><h3>${esc(t('unit.rooms'))}</h3></div>
          <table class="rooms"><tbody>${roomRows}</tbody></table>
          <p class="fineprint" style="margin-top:10px">${esc(t('unit.roomsNote'))}</p>
        </section>
      </div>
      <aside class="unit-aside">
        <div class="price-card">
          <span class="h-small">${esc(t('unit.price'))}</span>
          <div class="price-big" id="uTotal">${fmtMoney(priceOf(u.id, styleId))}</div>
          <div class="price-rows">
            <div><span>${esc(t('res.base'))} ${u.id}</span><span>${fmtMoney(u.price)}</span></div>
            <div><span id="uStyleName">${esc(L(style.name))}</span><span id="uStyleExtra">${style.extra ? '+ ' + fmtMoney(style.extra) : esc(t('unit.included'))}</span></div>
          </div>
          ${st === 'available' ? '' : `<p class="notice">${esc(t('unit.notAvailable', { status: t('status.' + st).toLowerCase() }))}</p>`}
          <div class="price-actions">
            ${st === 'available' ? `<a class="btn btn-bronze" href="#reserve-${unitToken(u.id)}">${esc(t('unit.reserve'))}</a>` : ''}
            <button type="button" class="btn btn-line" data-act="interest" data-unit="${u.id}">${esc(t('unit.interest'))}</button>
          </div>
          <p class="fineprint">${esc(t('hero.note'))}</p>
        </div>
        <div>
          <h3 class="h-small" style="margin-bottom:10px">${esc(t('unit.specs'))}</h3>
          <div class="kv">
            <div><span class="k">${esc(t('unit.interior'))}</span><span class="v big">${areaFmt(u.area)}</span></div>
            <div><span class="k">${esc(garden ? t('unit.garden') : t('unit.balcony'))}</span><span class="v big">${fmtNum(u.outdoor, 1)} ${esc(t('misc.m2'))}</span></div>
            <div><span class="k">${esc(t('unit.beds'))}</span><span class="v">${u.beds}</span></div>
            <div><span class="k">${esc(t('unit.baths'))}</span><span class="v">${u.baths}</span></div>
            <div class="wide"><span class="k">${esc(t('unit.aspect'))}</span><span class="v">${u.aspect.map(a => esc(dirWord[a] || a)).join('<br>')}</span></div>
            <div class="wide"><span class="k">${esc(t('unit.parking'))}</span><span class="v">${esc(t('unit.parkingBay', { bay: u.parking }))}</span></div>
            <div><span class="k">${esc(t('unit.level'))}</span><span class="v"><span class="mono">${levelMark(u.floor)}</span></span></div>
            <div><span class="k">${esc(t('unit.lift'))}</span><span class="v">${esc(t('unit.liftYes'))}</span></div>
          </div>
        </div>
      </aside>
    </div>
  </div>`;
  bindUnit(page, u);
}

function bindUnit(page, u) {
  const tourEl = $('#tour', page);
  const hotEl = $('#hotspots', page);
  const msg = (text) => {
    let m = $('.tour-msg', tourEl);
    if (!text) { m?.remove(); return; }
    if (!m) { m = document.createElement('div'); m.className = 'tour-msg'; tourEl.appendChild(m); }
    m.textContent = text;
  };
  const start = async () => {
    $('#tourPoster', page)?.remove();
    const v = await getViewer();
    if (!tourEl.isConnected) return null;
    mount(tourEl);
    if (!v) { msg(t('sel.3d.failed')); return null; }
    try { await v.ready; } catch (e) { return null; }
    await v.selectUnit(u.id, state.style[u.id] || 'atlantic');
    return v;
  };
  const renderHotspots = (v) => {
    const hs = v.hotspots(u.id) || [];
    hotEl.innerHTML = hs.map((h, i) => `<button type="button" class="chip" data-hs="${i}">${esc(L(h.name))}</button>`).join('');
    hotEl.hidden = !hs.length;
    hotEl._hs = hs;
  };
  page.addEventListener('click', async e => {
    const b = e.target.closest('[data-tour]');
    if (b) {
      const action = b.dataset.tour;
      if (action === 'full') {
        const v = await getViewer();
        if (!v) return;
        if (!host.parentElement || host.parentElement !== tourEl) { await start(); }
        await openImmersive(v.getMode() === 'walk' ? 'keep' : 'exterior');
        return;
      }
      if (action === 'photoreal') {
        const cur = viewerApi?.isPhotoreal?.();
        if (!cur) {
          const v0 = await start();
          if (!v0) return;
          if (v0.getMode() !== 'walk') await v0.walkUnit(u.id);
        }
        msg(null);
        await togglePhotoreal();
        return;
      }
      const v = await start();
      if (!v) return;
      msg(null);
      let ok = true;
      if (action === 'start' || action === 'walk') ok = await v.walkUnit(u.id);
      else if (action === 'views') { renderHotspots(v); b.setAttribute('aria-pressed', 'true'); if (hotEl._hs?.length) ok = await v.lookFrom(hotEl._hs[0]); }
      else if (action === 'balcony') ok = await v.balconyView(u.id);
      else if (action === 'lift') ok = await v.takeLift(u.floor === 'ground' ? 'basement' : 'ground', u.floor);
      if (!ok) msg(t('v.unavailable'));
      return;
    }
    const hs = e.target.closest('[data-hs]');
    if (hs && viewerApi) {
      $$('[data-hs]', hotEl).forEach(x => x.setAttribute('aria-pressed', x === hs));
      viewerApi.lookFrom(hotEl._hs[+hs.dataset.hs]);
      return;
    }
    const sb = e.target.closest('[data-style]');
    if (sb) {
      const sid = sb.dataset.style;
      state.style[u.id] = sid;
      $$('[data-style]', page).forEach(x => x.setAttribute('aria-pressed', x.dataset.style === sid));
      const s = styleById(sid);
      $('#uTotal', page).textContent = fmtMoney(priceOf(u.id, sid));
      $('#uStyleName', page).textContent = L(s.name);
      $('#uStyleExtra', page).textContent = s.extra ? '+ ' + fmtMoney(s.extra) : t('unit.included');
      if (viewerApi && host?.parentElement === tourEl) viewerApi.selectUnit(u.id, sid);
      return;
    }
    const pv = e.target.closest('[data-upv]');
    if (pv) { state.unitPlanView = pv.dataset.upv; detachHostFromPage(); renderUnit(page, u.id); return; }
    const intr = e.target.closest('[data-act="interest"]');
    if (intr) openInterest(intr.dataset.unit);
  });
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
    <div class="sec-head" style="margin-bottom:0"><p class="eyebrow">${esc(t('res.eyebrow'))}</p><h2>${esc(t('res.title'))}</h2><p class="lede">${esc(t('res.lede'))}</p></div>
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
        <div class="finish-pick">${STYLES.map(s => finishCard(s, true, s.id === R.styleId)).join('')}</div>
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
  const email = PROJECT.contact.email;
  const text = reservationText(doc);
  card.innerHTML = `<div class="done">
    <div class="tick"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>
    <h3>${esc(t('done.title', { name: first }))}</h3>
    <p>${esc(res.ok ? t('done.saved', { unit: doc.unitId }) : res.failed ? t('done.failed') : t('done.offline'))}</p>
    <div class="refbox" style="justify-items:center"><span class="h-small">${esc(t('done.ref'))}</span><span class="ref">${esc(doc.ref)}</span></div>
    ${res.ok ? '' : `<div class="copyline" style="justify-content:center"><span class="fineprint">${esc(t('done.sendTo'))}</span><span class="val" id="doneEmail">${esc(email)}</span><button type="button" class="copybtn" data-copy="${esc(email)}" data-copy-target="#doneEmail">${esc(t('foot.copy'))}</button></div>`}
    <textarea class="copyarea" id="doneText" readonly aria-label="${esc(t('res.summary'))}">${esc(text)}</textarea>
    <div class="done-actions">
      <button type="button" class="btn btn-solid" id="doneCopy">${esc(t('done.copy'))}</button>
      <a class="btn btn-line" href="#apartments">${esc(t('done.again'))}</a>
    </div>
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
  if ($('#imm').hidden) document.body.classList.remove('no-scroll');
  if (state.route === 'interest') history.replaceState(null, '', '#top');
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
    const email = PROJECT.contact.email;
    const text = `Barreiro 2 · ${t('int.title')}\n${doc.name}\n${doc.email}\n${doc.phone}\n${doc.unitId || t('int.any')}`;
    $('#modalCard').innerHTML = `<div style="display:grid;gap:14px"><h3 id="modalTitle">${esc(t('int.title'))}</h3>
      <p>${esc(ok ? t('int.thanks') : t('int.offline'))}</p>
      ${ok ? '' : `<div class="copyline"><span class="val" id="intEmail">${esc(email)}</span><button type="button" class="copybtn" data-copy="${esc(email)}" data-copy-target="#intEmail">${esc(t('foot.copy'))}</button></div>
      <textarea class="copyarea" id="intText" readonly style="min-height:120px">${esc(text)}</textarea>
      <button type="button" class="btn btn-solid" id="intCopy">${esc(t('done.copy'))}</button>`}
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
        renderFloorList(); renderFacade(); renderTable(); renderPlanPanel();
        state.onStatusChange?.();
        if (state.route.startsWith('unit-')) { detachHostFromPage(); }
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
  $('#langSel').addEventListener('change', e => applyLang(e.target.value));
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
    if (a.dataset.act === 'explore') openImmersive('exterior');
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
  bindImmersive();
  route();
  initCapabilities();
  initLandmarks();
  initSiteMap();
}

try { boot(); } catch (e) { console.error('[app] boot failed', e); }
