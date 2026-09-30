// VILNYI · Barreiro 2 — AERIAL: bird's-eye 360° panorama with landmark labels.
// export createAerial(THREE, { camera, dom, scene, environment, labelsEl, lang }) => { enable, disable, setLang, update }
// All DOM/CSS is prefixed `va-`. No side effects on import.

import { PROJECT, LANDMARKS } from './data.js';

// ---------------------------------------------------------------------------
// Verified landmark coordinates (researched Sept 2026). `source` = where the
// coordinate came from. `hint` = travel/service note, only where sourced
// (hintSource). `h` = label anchor height above ground (m).
// ---------------------------------------------------------------------------
export const LANDMARKS_VERIFIED = [
  { id: 'lavradio-station', kind: 'train', lat: 38.66185, lon: -9.05847, rank: 1,
    name: { en: 'Lavradio station', pt: 'Estação do Lavradio', he: 'תחנת הרכבת לברדיו' },
    hint: { en: 'Linha do Sado · Barreiro 3 min', pt: 'Linha do Sado · Barreiro 3 min', he: 'קו סאדו · בריירו 3 דק׳' },
    source: 'https://pt.wikipedia.org/wiki/Esta%C3%A7%C3%A3o_Ferrovi%C3%A1ria_do_Lavradio',
    hintSource: 'https://www.virail.pt/comboio-barreiro-lavradio' },
  { id: 'barreiro-ferry', kind: 'ferry', lat: 38.651865, lon: -9.078658, rank: 1,
    name: { en: 'Barreiro ferry terminal', pt: 'Terminal Fluvial do Barreiro', he: 'מסוף המעבורות בריירו' },
    hint: { en: 'Ferry to Lisbon · 20 min', pt: 'Barco para Lisboa · 20 min', he: 'מעבורת לליסבון · 20 דק׳' },
    source: 'https://mapcarta.com/Terminal_Fluvial_do_Barreiro',
    hintSource: 'https://ttsl.pt/passageiros/horarios-de-ligacoes-fluviais/ligacao-barreiro-terreiro-do-paco/' },
  { id: 'baixa-chiado', kind: 'city', lat: 38.708274, lon: -9.136343, rank: 1, h: 25,
    name: { en: 'Lisbon · Terreiro do Paço', pt: 'Lisboa · Terreiro do Paço', he: 'ליסבון · טריירו דו פאסו' },
    hint: { en: '20 min by ferry from Barreiro', pt: '20 min de barco desde o Barreiro', he: '20 דק׳ במעבורת מבריירו' },
    source: 'https://mapcarta.com/Pra%C3%A7a_do_Com%C3%A9rcio',
    hintSource: 'https://ttsl.pt/passageiros/horarios-de-ligacoes-fluviais/ligacao-barreiro-terreiro-do-paco/' },
  { id: 'parque-nacoes', kind: 'city', lat: 38.768, lon: -9.094, rank: 2, h: 40,
    name: { en: 'Lisbon · Parque das Nações', pt: 'Lisboa · Parque das Nações', he: 'ליסבון · פארק האומות' },
    source: 'https://en.wikipedia.org/wiki/Parque_das_Na%C3%A7%C3%B5es' },
  { id: 'ponte-25', kind: 'bridge', lat: 38.68917, lon: -9.17694, rank: 2, h: 70,
    name: { en: '25 de Abril Bridge', pt: 'Ponte 25 de Abril', he: 'גשר 25 באפריל' },
    source: 'https://en.wikipedia.org/wiki/25_de_Abril_Bridge' },
  { id: 'vasco-gama', kind: 'bridge', lat: 38.762, lon: -9.043, rank: 2, h: 30,
    name: { en: 'Vasco da Gama Bridge', pt: 'Ponte Vasco da Gama', he: 'גשר ואסקו דה גאמה' },
    source: 'https://en.wikipedia.org/wiki/Vasco_da_Gama_Bridge' },
  { id: 'cristo-rei', kind: 'monument', lat: 38.67861, lon: -9.17134, rank: 2, h: 110,
    name: { en: 'Cristo Rei', pt: 'Cristo Rei', he: 'כריסטו ריי' },
    source: 'https://en.wikipedia.org/wiki/Christ_the_King_(Almada)' },
  { id: 'hospital', kind: 'health', lat: 38.654541, lon: -9.060747, rank: 2, h: 15,
    name: { en: 'Hospital N. Sra. do Rosário', pt: 'Hospital N.ª Sr.ª do Rosário', he: 'בית החולים נוסה סניורה דו רוזריו' },
    hint: { en: '24 h emergency', pt: 'Urgência 24 h', he: 'מיון 24 שעות' },
    source: 'https://www.hospitaisonline.pt/setubal/hospital-de-nossa-senhora-do-rosario-barreiro',
    hintSource: 'https://www.hospitaisonline.pt/setubal/hospital-de-nossa-senhora-do-rosario-barreiro' },
  { id: 'forum-barreiro', kind: 'shopping', lat: 38.66202, lon: -9.07312, rank: 3, h: 10,
    name: { en: 'Fórum Barreiro', pt: 'Fórum Barreiro', he: 'קניון פורום בריירו' },
    source: 'https://mapcarta.com/Forum_Barreiro' },
  { id: 'airport', kind: 'airport', lat: 38.77417, lon: -9.13417, rank: 2, h: 20,
    name: { en: 'Lisbon Airport', pt: 'Aeroporto de Lisboa', he: 'נמל התעופה ליסבון' },
    source: 'https://en.wikipedia.org/wiki/Lisbon_Airport' },
  { id: 'tejo', kind: 'water', lat: 38.6762, lon: -9.05994, rank: 1,
    name: { en: 'Tagus riverside · Barra-a-Barra', pt: 'Praia Barra-a-Barra · Tejo', he: 'גדת הטז׳ו · חוף בארה-א-בארה' },
    source: 'https://mapcarta.com/Praia_Barra-a-Barra' },
  // Everyday places within ~2 km
  { id: 'usf-lavradio', kind: 'health', lat: 38.669865, lon: -9.054846, rank: 3, h: 6,
    name: { en: 'Lavradio health centre (USF)', pt: 'USF Lavradio · Centro de Saúde', he: 'מרפאת לברדיו (USF)' },
    source: 'https://www.centrosaude.pt/setubal/centro-de-saude-do-barreiro-usf-lavradio' },
  { id: 'escola-alvaro-velho', kind: 'school', lat: 38.663354, lon: -9.054237, rank: 3, h: 6,
    name: { en: 'Álvaro Velho school', pt: 'Escola Básica Álvaro Velho', he: 'בית הספר אלווארו ולו' },
    source: 'https://mapcarta.com/W234316136' },
  { id: 'continente-lavradio', kind: 'shopping', lat: 38.666807, lon: -9.047929, rank: 3, h: 4,
    name: { en: 'Continente Bom Dia supermarket', pt: 'Continente Bom Dia', he: 'סופרמרקט קונטיננטה' },
    source: 'https://mapcarta.com/pt/W985732546' },
  { id: 'parque-maria-machado', kind: 'park', lat: 38.67018, lon: -9.04817, rank: 3,
    name: { en: 'Parque Maria Machado', pt: 'Parque Maria Machado', he: 'פארק מריה מאשאדו' },
    source: 'https://mapcarta.com/Parque_Maria_Machado' },
  { id: 'farmacia-aquem-tejo', kind: 'pharmacy', lat: 38.66134, lon: -9.05028, rank: 3, h: 4,
    name: { en: 'Farmácia Aquém Tejo', pt: 'Farmácia Aquém Tejo', he: 'בית מרקחת אקן טז׳ו' },
    hint: { en: 'Open 24/7', pt: 'Aberta 24 h', he: 'פתוח 24/7' },
    source: 'https://mapcarta.com/N8390550541', hintSource: 'https://mapcarta.com/N8390550541' },
  { id: 'mercado-lavradio', kind: 'market', lat: 38.664659, lon: -9.052149, rank: 3, h: 5,
    name: { en: 'Lavradio market', pt: 'Mercado do Lavradio', he: 'שוק לברדיו' },
    source: 'https://mapcarta.com/pt/W285824534' }
];

// data.js entries not verified above are appended as-is (approximate).
function mergedLandmarks() {
  const ids = new Set(LANDMARKS_VERIFIED.map(l => l.id));
  const alias = { 'fórum-barreiro': 'forum-barreiro' };
  const extra = (LANDMARKS || []).filter(l => !ids.has(l.id) && !ids.has(alias[l.id]))
    .map(l => ({ ...l, rank: 4, verified: false }));
  return [...LANDMARKS_VERIFIED.map(l => ({ ...l, verified: true })), ...extra];
}

// ---------------------------------------------------------------------------
const UI = {
  en: { hint: 'Drag to turn 360° · scroll or pinch to zoom', north: 'Face north', site: 'Rua Eduardo Couto · Lavradio', km: 'km', m: 'm', ring: (t) => t },
  pt: { hint: 'Arraste para rodar 360° · deslize ou use dois dedos para zoom', north: 'Orientar a norte', site: 'Rua Eduardo Couto · Lavradio', km: 'km', m: 'm', ring: (t) => t },
  he: { hint: 'גררו לסיבוב 360° · גלגלת או צביטה לזום', north: 'כיוון צפון', site: 'רחוב אדוארדו קוטו · לברדיו', km: 'ק״מ', m: 'מ׳', ring: (t) => t }
};
const CARDINALS = {
  en: ['N', 'E', 'S', 'W'], pt: ['N', 'E', 'S', 'O'], he: ['צ', 'מז', 'ד', 'מע']
};
const DIR8 = {
  en: ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'],
  pt: ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'],
  he: ['צפון', 'צפון-מזרח', 'מזרח', 'דרום-מזרח', 'דרום', 'דרום-מערב', 'מערב', 'צפון-מערב']
};

// 16px stroke icons (currentColor)
const P = (d) => `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  train: P('<rect x="6" y="3" width="12" height="13" rx="3"/><path d="M6 10h12M9 20l-2 2M15 20l2 2M9.5 13h.01M14.5 13h.01"/><path d="M8 16l-1.5 3M16 16l1.5 3"/>'),
  ferry: P('<path d="M3 17c1.5 1.3 3 1.3 4.5 0s3-1.3 4.5 0 3 1.3 4.5 0 3-1.3 4.5 0"/><path d="M5 14l1-5h12l1 5"/><path d="M9 9V6h6v3M12 3v3"/>'),
  city: P('<path d="M3 21h18M5 21V10l4-2v13M9 21V5l6-2v18M15 21V9l4 2v10"/><path d="M12 8h.01M12 12h.01M12 16h.01"/>'),
  bridge: P('<path d="M2 16h20M5 16V6M19 16V6M5 7c3 6 11 6 14 0"/><path d="M9 16v-4M12 16v-3M15 16v-4"/>'),
  monument: P('<path d="M12 3v3M8 7.5h8M12 6v8M9.5 21l1-7h3l1 7M7 21h10"/>'),
  health: P('<path d="M12 7v10M7 12h10"/><rect x="3.5" y="3.5" width="17" height="17" rx="4"/>'),
  shopping: P('<path d="M6 8h12l-1 12H7L6 8z"/><path d="M9 8a3 3 0 0 1 6 0"/>'),
  road: P('<path d="M8 3L5 21M16 3l3 18M12 4v3M12 11v3M12 18v2"/>'),
  airport: P('<path d="M10.5 20l1.5-6-6 2-1-1.5 7-5V4.5a1 1 0 0 1 2 0V9.5l7 5-1 1.5-6-2 1.5 6"/>'),
  water: P('<path d="M3 9c1.5 1.3 3 1.3 4.5 0s3-1.3 4.5 0 3 1.3 4.5 0 3-1.3 4.5 0M3 14c1.5 1.3 3 1.3 4.5 0s3-1.3 4.5 0 3 1.3 4.5 0 3-1.3 4.5 0M3 19c1.5 1.3 3 1.3 4.5 0s3-1.3 4.5 0 3 1.3 4.5 0 3-1.3 4.5 0"/>'),
  school: P('<path d="M2 9l10-5 10 5-10 5z"/><path d="M6 11v5c3 2.5 9 2.5 12 0v-5M22 9v6"/>'),
  park: P('<path d="M12 21v-6M12 15c-4 0-6-2.5-6-5.5S8.5 3 12 3s6 3.5 6 6.5S16 15 12 15z"/><path d="M8 21h8"/>'),
  pharmacy: P('<rect x="3" y="8" width="18" height="8" rx="4" transform="rotate(-45 12 12)"/><path d="M9.2 9.2l5.6 5.6"/>'),
  market: P('<path d="M4 10h16l-1-5H5zM5 10v10h14V10M10 20v-5h4v5"/><path d="M8 10a2 2 0 0 1-4 0M12 10a2 2 0 0 1-4 0M16 10a2 2 0 0 1-4 0M20 10a2 2 0 0 1-4 0"/>'),
  site: P('<path d="M4 21V10l8-6 8 6v11"/><path d="M9 21v-6h6v6"/>')
};

const CSS = `
.va-root{position:absolute;inset:0;pointer-events:none;overflow:hidden;user-select:none;-webkit-user-select:none;
  font-family:inherit;color:#f4efe6;--va-gold:#d6b27a;--va-glass:rgba(14,16,20,.58);--va-line:rgba(255,255,255,.16);
  -webkit-font-smoothing:antialiased;z-index:2}
.va-root[hidden]{display:none}
.va-lm{position:absolute;left:0;top:0;will-change:transform,opacity;transition:opacity .35s ease;opacity:0}
.va-lm.va-on{opacity:var(--va-a,1)}
.va-lm .va-dot{position:absolute;left:-3.5px;top:-3.5px;width:7px;height:7px;border-radius:50%;background:#fff;
  box-shadow:0 0 0 2px rgba(14,16,20,.55),0 0 10px rgba(255,255,255,.45)}
.va-lm .va-stem{position:absolute;left:-.5px;bottom:0;width:1px;height:var(--va-stem,22px);
  background:linear-gradient(to top,rgba(255,255,255,.75),rgba(255,255,255,.12))}
.va-pill{position:absolute;left:0;bottom:var(--va-stem,22px);transform:translateX(calc(-50% + var(--va-sx,0px)));display:flex;align-items:center;gap:8px;
  padding:5px 12px 5px 5px;border-radius:999px;background:var(--va-glass);border:1px solid var(--va-line);
  -webkit-backdrop-filter:blur(12px) saturate(1.3);backdrop-filter:blur(12px) saturate(1.3);
  box-shadow:0 8px 24px rgba(0,0,0,.28);white-space:nowrap;pointer-events:auto;cursor:pointer;
  transition:border-color .2s,background .2s,transform .2s}
.va-root[dir=rtl] .va-pill{padding:5px 5px 5px 12px}
.va-pill:hover,.va-lm.va-act .va-pill{border-color:rgba(214,178,122,.7);background:rgba(20,20,22,.78)}
.va-lm.va-act{z-index:5}
.va-ic{flex:none;display:grid;place-items:center;width:26px;height:26px;border-radius:50%;
  background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);color:var(--va-gold)}
.va-tx{display:flex;flex-direction:column;line-height:1.15;min-width:0}
.va-nm{font-size:12.5px;font-weight:500;letter-spacing:.01em;color:#fbf7f0}
.va-mt{font-size:10.5px;letter-spacing:.08em;font-variant-caps:all-small-caps;font-variant-numeric:tabular-nums lining-nums;
  color:rgba(244,239,230,.68);display:flex;gap:5px}
.va-root[dir=rtl] .va-mt{letter-spacing:.02em}
.va-mt .va-d{color:var(--va-gold);font-weight:600}
.va-lm.va-far .va-nm{font-size:11.5px}
.va-lm.va-far .va-ic{width:22px;height:22px}
/* site marker */
.va-site{z-index:6}
.va-site .va-pill{background:rgba(12,12,14,.82);border-color:rgba(214,178,122,.75);padding:6px 14px 6px 6px}
.va-root[dir=rtl] .va-site .va-pill{padding:6px 6px 6px 14px}
.va-site .va-ic{background:var(--va-gold);color:#141414;border-color:transparent;width:28px;height:28px}
.va-site .va-nm{font-size:13px;letter-spacing:.04em}
.va-site .va-nm b{color:var(--va-gold);font-weight:600;letter-spacing:.14em}
.va-site .va-stem{background:linear-gradient(to top,var(--va-gold),rgba(214,178,122,.15))}
.va-site .va-dot{background:var(--va-gold);box-shadow:0 0 0 2px rgba(14,16,20,.6)}
.va-pulse{position:absolute;left:-18px;top:-18px;width:36px;height:36px;border-radius:50%;border:1.5px solid var(--va-gold);
  opacity:0;animation:va-pulse 2.4s cubic-bezier(.2,.6,.3,1) infinite}
.va-pulse.va-p2{animation-delay:1.2s}
@keyframes va-pulse{0%{transform:scale(.25);opacity:.95}100%{transform:scale(1.9);opacity:0}}
/* ring labels */
.va-ring{position:absolute;left:0;top:0;font-size:10px;letter-spacing:.14em;font-variant-caps:all-small-caps;
  font-variant-numeric:tabular-nums;color:rgba(255,255,255,.7);text-shadow:0 1px 3px rgba(0,0,0,.6);
  transition:opacity .3s;opacity:0;white-space:nowrap}
.va-ring.va-on{opacity:1}
/* compass */
.va-compass{position:absolute;top:var(--va-compass-top,16px);inset-inline-end:var(--va-compass-end,16px);width:88px;height:88px;
  pointer-events:auto;cursor:pointer;border-radius:50%;background:var(--va-glass);border:1px solid var(--va-line);
  -webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);box-shadow:0 8px 24px rgba(0,0,0,.28)}
.va-compass svg{display:block;width:100%;height:100%}
.va-compass .va-hd{font-size:9px;letter-spacing:.12em;font-variant-numeric:tabular-nums;fill:rgba(244,239,230,.8)}
.va-compass .va-card{font-size:10px;letter-spacing:.06em;font-weight:600;fill:rgba(244,239,230,.85)}
.va-compass .va-card.va-n{fill:var(--va-gold)}
.va-help{position:absolute;left:50%;bottom:var(--va-help-bottom,22px);transform:translateX(-50%);padding:7px 14px;border-radius:999px;
  background:var(--va-glass);border:1px solid var(--va-line);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);
  font-size:11px;letter-spacing:.1em;font-variant-caps:all-small-caps;color:rgba(244,239,230,.85);white-space:nowrap;
  transition:opacity .8s ease;max-width:calc(100% - 32px);overflow:hidden;text-overflow:ellipsis}
.va-help.va-gone{opacity:0}
@media (max-width:600px){
  .va-nm{font-size:11.5px}.va-mt{font-size:10px}.va-ic{width:22px;height:22px}.va-pill{gap:6px;padding:4px 10px 4px 4px}
  .va-root[dir=rtl] .va-pill{padding:4px 4px 4px 10px}
  .va-compass{width:72px;height:72px}
}
@media (prefers-reduced-motion:reduce){.va-pulse{animation:none;opacity:.5;transform:scale(1)}}
`;

// ---------------------------------------------------------------------------
export function createAerial(THREE, { camera, dom, scene, environment, labelsEl, lang = 'en' } = {}) {
  const DEG = Math.PI / 180;
  const TARGET = new THREE.Vector3(7, 5, 7);          // orbit target: building centre
  const SITE_TOP = new THREE.Vector3(7, 11.2, 7.3);   // marker anchor above the roof
  const D_MIN = 60, D_MAX = 400;
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const lat0 = PROJECT.lat, lon0 = PROJECT.lon;

  // ---- state
  let enabled = false;
  let heading = 330 * DEG;       // view bearing (0 = looking north, clockwise); Lisbon skyline in view
  let dist = 280;                // default: ~120 m above the site, 250 m out
  let elev = Math.asin(115 / 280);
  let vHeading = 0, vElev = 0;
  let lastInput = -1e9, clock = 0;
  let trans = null;              // { t, dur, p0, q0 }
  let anim = null;               // heading animation to north
  let active = null;             // highlighted landmark id
  let helpShown = true;
  let curLang = UI[lang] ? lang : 'en';

  // ---- geo
  const geo = (lat, lon) => {
    try {
      if (environment && typeof environment.geo === 'function') {
        const v = environment.geo(lat, lon);
        if (v && Number.isFinite(v.x) && Number.isFinite(v.z)) return new THREE.Vector3(v.x, 0, v.z);
      }
    } catch (e) { /* fall through */ }
    return new THREE.Vector3(7 + (lon - lon0) * Math.cos(lat0 * DEG) * 111320, 0, 7 - (lat - lat0) * 110540);
  };
  const haversineKm = (lat, lon) => {
    const R = 6371.0088, dLat = (lat - lat0) * DEG, dLon = (lon - lon0) * DEG;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat0 * DEG) * Math.cos(lat * DEG) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  };

  const items = mergedLandmarks().map(l => {
    const g = geo(l.lat, l.lon);
    return { ...l, ground: g, anchor: new THREE.Vector3(g.x, l.h || 0, g.z), km: haversineKm(l.lat, l.lon),
      el: null, w: 0, h: 0, line: null };
  });

  // ---- CSS + DOM
  let root = null, compass = null, help = null, siteEl = null, ringEls = [];
  const cardEls = [];
  let headingText = null;

  function injectCSS() {
    if (typeof document === 'undefined' || document.getElementById('va-style')) return;
    const s = document.createElement('style'); s.id = 'va-style'; s.textContent = CSS;
    document.head.appendChild(s);
  }

  const fmtDist = (km) => {
    const u = UI[curLang];
    const loc = curLang === 'pt' ? 'pt-PT' : curLang === 'he' ? 'he-IL' : 'en-GB';
    if (km < 1) return `${new Intl.NumberFormat(loc).format(Math.round(km * 1000 / 10) * 10)} ${u.m}`;
    return `${new Intl.NumberFormat(loc, { minimumFractionDigits: km < 10 ? 1 : 0, maximumFractionDigits: km < 10 ? 1 : 0 }).format(km)} ${u.km}`;
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pick = (o) => (o && (o[curLang] || o.en)) || '';

  function buildDOM() {
    if (!labelsEl || root) return;
    injectCSS();
    root = document.createElement('div');
    root.className = 'va-root'; root.hidden = true;
    labelsEl.appendChild(root);

    for (const it of items) {
      const el = document.createElement('div');
      el.className = 'va-lm'; el.dataset.id = it.id; el.dataset.kind = it.kind;
      el.innerHTML = `<div class="va-stem"></div><div class="va-dot"></div><div class="va-pill" role="button" tabindex="-1"><span class="va-ic">${ICONS[it.kind] || ICONS.city}</span><span class="va-tx"><span class="va-nm"></span><span class="va-mt"></span></span></div>`;
      const pill = el.querySelector('.va-pill');
      pill.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') setActive(it.id); });
      pill.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && active === it.id) setActive(null); });
      pill.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
      pill.addEventListener('click', (e) => { e.stopPropagation(); setActive(active === it.id && e.pointerType !== 'mouse' ? null : it.id); lastInput = clock; });
      root.appendChild(el);
      it.el = el;
    }

    siteEl = document.createElement('div');
    siteEl.className = 'va-lm va-site';
    siteEl.innerHTML = `<div class="va-pulse"></div><div class="va-pulse va-p2"></div><div class="va-stem"></div><div class="va-dot"></div><div class="va-pill"><span class="va-ic">${ICONS.site}</span><span class="va-tx"><span class="va-nm"></span><span class="va-mt"></span></span></div>`;
    siteEl.querySelector('.va-pill').addEventListener('pointerdown', e => e.stopPropagation());
    siteEl.querySelector('.va-pill').addEventListener('click', e => { e.stopPropagation(); setActive(null); });
    root.appendChild(siteEl);

    ringEls = [500, 1000, 2000].map(r => {
      const el = document.createElement('div'); el.className = 'va-ring'; root.appendChild(el);
      return { r, el };
    });

    compass = document.createElement('div');
    compass.className = 'va-compass'; compass.setAttribute('role', 'button');
    compass.innerHTML = buildCompassSVG();
    compass.addEventListener('pointerdown', e => e.stopPropagation());
    compass.addEventListener('click', (e) => { e.stopPropagation(); faceNorth(); });
    root.appendChild(compass);
    headingText = compass.querySelector('.va-hd');

    help = document.createElement('div'); help.className = 'va-help';
    root.appendChild(help);

    applyLang();
  }

  function buildCompassSVG() {
    let ticks = '';
    for (let i = 0; i < 72; i++) {
      const major = i % 18 === 0, mid = i % 9 === 0;
      const r1 = 43, r0 = major ? 36 : mid ? 38.5 : 40.5;
      const a = i * 5 * DEG;
      ticks += `<line x1="${50 + Math.sin(a) * r0}" y1="${50 - Math.cos(a) * r0}" x2="${50 + Math.sin(a) * r1}" y2="${50 - Math.cos(a) * r1}" stroke="rgba(255,255,255,${major ? .7 : mid ? .45 : .22})" stroke-width="${major ? 1.2 : .8}"/>`;
    }
    return `<svg viewBox="0 0 100 100" aria-hidden="true">
      <g class="va-dial">${ticks}
        <text class="va-card va-n" data-i="0" text-anchor="middle" dominant-baseline="central"></text>
        <text class="va-card" data-i="1" text-anchor="middle" dominant-baseline="central"></text>
        <text class="va-card" data-i="2" text-anchor="middle" dominant-baseline="central"></text>
        <text class="va-card" data-i="3" text-anchor="middle" dominant-baseline="central"></text>
      </g>
      <path d="M50 8 L53.5 15 L46.5 15 Z" fill="#d6b27a"/>
      <circle cx="50" cy="50" r="17" fill="rgba(0,0,0,.18)" stroke="rgba(255,255,255,.12)"/>
      <path d="M50 38 L53 50 L50 47.5 L47 50 Z" fill="#f4efe6" opacity=".9"/>
      <text class="va-hd" x="50" y="58" text-anchor="middle" dominant-baseline="central"></text>
    </svg>`;
  }

  function applyLang() {
    if (!root) return;
    const rtl = curLang === 'he';
    root.setAttribute('dir', rtl ? 'rtl' : 'ltr');
    root.setAttribute('lang', curLang);
    for (const it of items) {
      it.el.querySelector('.va-nm').textContent = pick(it.name);
      const hint = it.hint ? pick(it.hint) : '';
      it.el.querySelector('.va-mt').innerHTML = `<bdi class="va-d">${esc(fmtDist(it.km))}</bdi>${hint ? `<span>·</span><span>${esc(hint)}</span>` : ''}`;
      it.el.querySelector('.va-pill').setAttribute('aria-label', `${pick(it.name)}, ${fmtDist(it.km)}`);
      it.w = 0;
    }
    siteEl.querySelector('.va-nm').innerHTML = `Barreiro 2 · <b>VILNYI</b>`;
    siteEl.querySelector('.va-mt').textContent = UI[curLang].site;
    siteEl._w = 0;
    for (const r of ringEls) r.el.textContent = fmtDist(r.r / 1000);
    const c = CARDINALS[curLang];
    compass.querySelectorAll('.va-card').forEach(t => { t.textContent = c[+t.dataset.i]; });
    compass.title = UI[curLang].north;
    help.textContent = UI[curLang].hint;
  }

  // ---- 3D helpers (group added only while enabled)
  const group = new THREE.Group(); group.name = 'aerial-overlay';
  const gold = new THREE.Color('#d6b27a');
  const ringMat = new THREE.MeshBasicMaterial({ color: gold, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide });
  const pulse = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 96), ringMat);
  pulse.rotation.x = -Math.PI / 2; pulse.position.set(7, 0.25, 7.3); pulse.renderOrder = 10; pulse.name = 'aerial-pulse';
  group.add(pulse);
  const pulse2 = pulse.clone(); pulse2.material = ringMat.clone(); group.add(pulse2);
  const distRings = [500, 1000, 2000].map(r => {
    const pts = [];
    for (let i = 0; i <= 256; i++) { const a = i / 256 * Math.PI * 2; pts.push(new THREE.Vector3(7 + Math.cos(a) * r, 1.2, 7.3 + Math.sin(a) * r)); }
    const geom = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.Line(geom, new THREE.LineDashedMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, dashSize: r / 60, gapSize: r / 60, depthWrite: false }));
    line.computeLineDistances(); line.renderOrder = 9; line.name = `aerial-ring-${r}`;
    group.add(line);
    return line;
  });
  const lineMat = new THREE.LineDashedMaterial({ color: gold, transparent: true, opacity: 0, dashSize: 6, gapSize: 4, depthTest: false, depthWrite: false });
  let hoverLine = null, lineAlpha = 0, lineFor = null;

  function makeLine(it) {
    const a = new THREE.Vector3(7, 1.5, 7.3), b = new THREE.Vector3(it.ground.x, 1.5, it.ground.z);
    const len = a.distanceTo(b);
    const n = Math.max(2, Math.ceil(len / 25));
    const pts = []; for (let i = 0; i <= n; i++) pts.push(a.clone().lerp(b, i / n));
    const geom = new THREE.BufferGeometry().setFromPoints(pts);
    const m = lineMat.clone(); m.dashSize = Math.max(3, len / 90); m.gapSize = m.dashSize * 0.7;
    const line = new THREE.Line(geom, m); line.computeLineDistances(); line.renderOrder = 20; line.name = `aerial-line-${it.id}`;
    return line;
  }

  function setActive(id) {
    active = id;
    for (const it of items) it.el && it.el.classList.toggle('va-act', it.id === id);
    const it = items.find(i => i.id === id);
    if (it) {
      if (!it.line) it.line = makeLine(it);
      if (hoverLine && hoverLine !== it.line) group.remove(hoverLine);
      hoverLine = it.line; group.add(hoverLine); lineFor = id;
    } else lineFor = null;
  }

  // ---- input
  const pointers = new Map();
  let pinch0 = 0, dist0 = 0, dragMoved = 0;
  const kick = () => { lastInput = clock; anim = null; if (help && helpShown) { help.classList.add('va-gone'); helpShown = false; } };
  const clampElev = (e) => Math.min(72 * DEG, Math.max(14 * DEG, e));
  const clampDist = (d) => Math.min(D_MAX, Math.max(D_MIN, d));

  function onDown(e) {
    if (!enabled) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { dom.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    dragMoved = 0; vHeading = 0; vElev = 0; kick();
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch0 = Math.hypot(a.x - b.x, a.y - b.y) || 1; dist0 = dist;
    }
  }
  function onMove(e) {
    if (!enabled || !pointers.has(e.pointerId)) return;
    const p = pointers.get(e.pointerId);
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pointers.size === 1) {
      const k = 0.0055;
      heading -= dx * k; elev = clampElev(elev + dy * k * 0.8);
      vHeading = -dx * k * 60; vElev = dy * k * 0.8 * 60;
      dragMoved += Math.abs(dx) + Math.abs(dy);
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      dist = clampDist(dist0 * pinch0 / d);
    }
    kick();
  }
  function onUp(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch0 = 0;
    if (pointers.size === 1) { vHeading = 0; vElev = 0; }
    if (e.type === 'pointerup' && dragMoved < 4 && pointers.size === 0) setActive(null);
  }
  function onWheel(e) {
    if (!enabled) return;
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
    dist = clampDist(dist * Math.exp(dy * 0.0012));
    kick();
  }
  function onKey(e) {
    if (!enabled || (e.target && /input|textarea|select/i.test(e.target.tagName))) return;
    if (e.key === 'ArrowLeft') { heading -= 6 * DEG; kick(); }
    else if (e.key === 'ArrowRight') { heading += 6 * DEG; kick(); }
    else if (e.key === 'ArrowUp') { dist = clampDist(dist * 0.9); kick(); }
    else if (e.key === 'ArrowDown') { dist = clampDist(dist * 1.1); kick(); }
  }

  function faceNorth() {
    kick();
    let d = (-heading) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2;
    anim = { from: heading, to: heading + d, t: 0, dur: reduced ? 0.01 : 1.1 };
  }

  // ---- camera pose
  const _pos = new THREE.Vector3(), _look = new THREE.Vector3(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion();
  const UP = new THREE.Vector3(0, 1, 0);
  function pose(outPos, outQuat) {
    const hor = Math.cos(elev) * dist, alt = Math.sin(elev) * dist;
    const sx = Math.sin(heading), cz = Math.cos(heading);
    outPos.set(TARGET.x - sx * hor, TARGET.y + alt, TARGET.z + cz * hor);
    // Look above the building so it sits in the lower third and the horizon stays in frame
    const lookPitch = -Math.max(4 * DEG, elev * 0.5);
    _look.set(sx * Math.cos(lookPitch), Math.sin(lookPitch), -cz * Math.cos(lookPitch)).add(outPos);
    _m.lookAt(outPos, _look, UP);
    outQuat.setFromRotationMatrix(_m);
  }

  // ---- labels layout
  const _v = new THREE.Vector3(), _cs = new THREE.Vector3();
  const STEMS = [22, 50, 78, 106];
  function measure(el) { return { w: el.querySelector('.va-pill').offsetWidth, h: el.querySelector('.va-pill').offsetHeight }; }

  function project(p, W, H) {
    _cs.copy(p).applyMatrix4(camera.matrixWorldInverse);
    if (_cs.z > -1) return null; // behind camera
    _v.copy(p).project(camera);
    return { x: (_v.x + 1) / 2 * W, y: (1 - _v.y) / 2 * H, depth: -_cs.z };
  }

  const overlaps = (r, list) => list.some(o => r.x < o.x + o.w && r.x + r.w > o.x && r.y < o.y + o.h && r.y + r.h > o.y);

  function layout() {
    if (!root) return;
    const W = labelsEl.clientWidth || dom.clientWidth || 1, H = labelsEl.clientHeight || dom.clientHeight || 1;
    camera.updateMatrixWorld();
    const placed = [];
    const pad = 4;

    // compass + help as obstacles
    const cr = compass.getBoundingClientRect(), lr = labelsEl.getBoundingClientRect();
    placed.push({ x: cr.left - lr.left - 6, y: cr.top - lr.top - 6, w: cr.width + 12, h: cr.height + 12 });
    if (helpShown) { const hr = help.getBoundingClientRect(); placed.push({ x: hr.left - lr.left, y: hr.top - lr.top, w: hr.width, h: hr.height }); }

    // site marker first
    const sp = project(SITE_TOP, W, H);
    if (!siteEl._w) { const m = measure(siteEl); siteEl._w = m.w; siteEl._h = m.h; }
    if (sp) {
      const stem = 30;
      siteEl.style.setProperty('--va-stem', stem + 'px');
      siteEl.style.transform = `translate3d(${sp.x.toFixed(1)}px,${sp.y.toFixed(1)}px,0)`;
      siteEl.classList.add('va-on');
      placed.push({ x: sp.x - siteEl._w / 2 - pad, y: sp.y - stem - siteEl._h - pad, w: siteEl._w + pad * 2, h: siteEl._h + stem + pad * 2 });
    } else siteEl.classList.remove('va-on');

    // landmarks by priority: active, rank, then nearer
    const order = items.slice().sort((a, b) => (b.id === active) - (a.id === active) || a.rank - b.rank || a.km - b.km);
    for (const it of order) {
      const el = it.el;
      const p = project(it.anchor, W, H);
      if (!it.w) { const m = measure(el); it.w = m.w; it.h = m.h; }
      let ok = false;
      if (p && p.x > 6 && p.x < W - 6 && p.y > -20 && p.y < H + 60) {
        // keep the pill inside the viewport by sliding it sideways along its stem
        const m = 8, left = p.x - it.w / 2;
        const sx = it.w > W - 2 * m ? 0 : Math.max(m - left, Math.min(0, W - m - (left + it.w)));
        for (const stem of STEMS) {
          const r = { x: p.x - it.w / 2 + sx - pad, y: p.y - stem - it.h - pad, w: it.w + pad * 2, h: it.h + pad * 2 };
          if (r.y < 4 && it.id !== active) continue;
          if (!overlaps(r, placed) || it.id === active) {
            el.style.setProperty('--va-sx', sx.toFixed(1) + 'px');
            placed.push(r);
            placed.push({ x: p.x - 5, y: p.y - 5, w: 10, h: 10 });
            el.style.setProperty('--va-stem', stem + 'px');
            el.style.transform = `translate3d(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px,0)`;
            const far = p.depth > 4000;
            el.classList.toggle('va-far', far);
            // fade with camera distance (never below .6 so text stays legible)
            const a = Math.max(0.78, Math.min(1, 1 - (p.depth - 3000) / 30000));
            el.style.setProperty('--va-a', (it.id === active ? 1 : a).toFixed(2));
            ok = true; break;
          }
        }
      }
      el.classList.toggle('va-on', ok);
      el.style.visibility = ok ? '' : 'hidden';
      if (!ok) el.style.pointerEvents = 'none'; else el.style.pointerEvents = '';
    }

    // distance ring labels, placed straight ahead along the view heading
    for (const r of ringEls) {
      const pt = new THREE.Vector3(7 + Math.sin(heading) * r.r, 1.2, 7.3 - Math.cos(heading) * r.r);
      const p = project(pt, W, H);
      let ok = false;
      if (p) {
        const w = r.el.offsetWidth || 40, h = 14;
        const rect = { x: p.x - w / 2, y: p.y - h - 2, w, h };
        if (rect.x > 0 && rect.x + w < W && rect.y > 0 && rect.y + h < H && !overlaps(rect, placed)) {
          r.el.style.transform = `translate3d(${(p.x - w / 2).toFixed(1)}px,${(p.y - h - 2).toFixed(1)}px,0)`;
          ok = true; placed.push(rect);
        }
      }
      r.el.classList.toggle('va-on', ok);
    }

    // compass
    const hdeg = ((heading / DEG) % 360 + 360) % 360;
    const dial = compass.querySelector('.va-dial');
    dial.setAttribute('transform', `rotate(${(-hdeg).toFixed(2)} 50 50)`);
    compass.querySelectorAll('.va-card').forEach(t => {
      const a = (+t.dataset.i * 90) * DEG;
      t.setAttribute('x', (50 + Math.sin(a) * 28).toFixed(2));
      t.setAttribute('y', (50 - Math.cos(a) * 28).toFixed(2));
      t.setAttribute('transform', `rotate(${hdeg.toFixed(2)} ${(50 + Math.sin(a) * 28).toFixed(2)} ${(50 - Math.cos(a) * 28).toFixed(2)})`);
    });
    const dir = DIR8[curLang][Math.round(hdeg / 45) % 8];
    headingText.textContent = curLang === 'he' ? `${Math.round(hdeg)}°` : `${dir} ${Math.round(hdeg)}°`;
  }

  // ---- public API
  function enable() {
    if (enabled) return;
    try {
      buildDOM();
      enabled = true;
      if (root) { root.hidden = false; for (const it of items) it.w = 0; siteEl && (siteEl._w = 0); }
      if (helpShown && help) help.classList.remove('va-gone');
      if (scene && !group.parent) scene.add(group);
      // continue from where the camera is: keep its bearing around the building
      const dx = camera.position.x - TARGET.x, dz = camera.position.z - TARGET.z;
      if (Math.hypot(dx, dz) > 1) heading = Math.atan2(-dx, dz);
      trans = { t: 0, dur: reduced ? 0.01 : 1.6, p0: camera.position.clone(), q0: camera.quaternion.clone() };
      lastInput = clock;
      if (dom) {
        dom._vaTouch = dom.style.touchAction; dom.style.touchAction = 'none';
        dom.addEventListener('pointerdown', onDown);
        dom.addEventListener('pointermove', onMove);
        dom.addEventListener('pointerup', onUp);
        dom.addEventListener('pointercancel', onUp);
        dom.addEventListener('wheel', onWheel, { passive: false });
      }
      window.addEventListener('keydown', onKey);
    } catch (e) { enabled = true; }
  }

  function disable() {
    if (!enabled && !root) return;
    enabled = false;
    try {
      if (root) root.hidden = true;
      if (group.parent) group.parent.remove(group);
      pointers.clear(); setActive(null);
      if (dom) {
        dom.style.touchAction = dom._vaTouch || '';
        dom.removeEventListener('pointerdown', onDown);
        dom.removeEventListener('pointermove', onMove);
        dom.removeEventListener('pointerup', onUp);
        dom.removeEventListener('pointercancel', onUp);
        dom.removeEventListener('wheel', onWheel);
      }
      window.removeEventListener('keydown', onKey);
    } catch (e) { /* ignore */ }
  }

  function setLang(l) {
    curLang = UI[l] ? l : 'en';
    try { applyLang(); } catch (e) { /* ignore */ }
  }

  const ease = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

  function update(dt = 1 / 60) {
    if (!enabled) return;
    dt = Math.min(0.1, Math.max(0, dt || 0));
    clock += dt;
    try {
      // motion
      if (anim) {
        anim.t += dt / anim.dur;
        const k = ease(Math.min(1, anim.t));
        heading = anim.from + (anim.to - anim.from) * k;
        if (anim.t >= 1) anim = null;
      } else if (pointers.size === 0) {
        if (Math.abs(vHeading) > 1e-4 || Math.abs(vElev) > 1e-4) {
          heading += vHeading * dt; elev = clampElev(elev + vElev * dt);
          const f = Math.exp(-dt * 4); vHeading *= f; vElev *= f;
        }
        if (!reduced && clock - lastInput > 4) {
          const ramp = Math.min(1, (clock - lastInput - 4) / 2);
          heading += 2.2 * DEG * dt * ramp;
        }
      }
      pose(_pos, _q);
      if (trans) {
        trans.t += dt / trans.dur;
        const k = ease(Math.min(1, trans.t));
        camera.position.lerpVectors(trans.p0, _pos, k);
        camera.quaternion.slerpQuaternions(trans.q0, _q, k);
        if (trans.t >= 1) trans = null;
      } else {
        camera.position.copy(_pos); camera.quaternion.copy(_q);
      }
      camera.updateMatrixWorld();

      // 3D pulse rings on the ground around the building
      const ph = (clock % 2.4) / 2.4, ph2 = ((clock + 1.2) % 2.4) / 2.4;
      const s1 = 10 + ph * 26, s2 = 10 + ph2 * 26;
      pulse.scale.set(s1, s1, 1); pulse.material.opacity = reduced ? 0.35 : 0.55 * (1 - ph);
      pulse2.scale.set(s2, s2, 1); pulse2.material.opacity = reduced ? 0 : 0.55 * (1 - ph2);
      pulse2.position.copy(pulse.position); pulse2.rotation.copy(pulse.rotation);
      for (const l of distRings) l.material.opacity = 0.22 * Math.min(1, 150 / dist + 0.4);

      // hover line fade
      const want = lineFor ? 0.95 : 0;
      lineAlpha += (want - lineAlpha) * Math.min(1, dt * 8);
      if (hoverLine) {
        hoverLine.material.opacity = lineAlpha;
        if (lineAlpha < 0.01 && !lineFor) { group.remove(hoverLine); hoverLine = null; }
      }

      layout();
    } catch (e) { /* never break the render loop */ }
  }

  function setHeading(deg) { heading = deg * DEG; kick(); }

  return { enable, disable, setLang, update, setHeading, landmarks: items.map(({ el, line, ...rest }) => rest) };
}
