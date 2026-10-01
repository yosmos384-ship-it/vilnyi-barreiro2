// VILNYI · Barreiro 2 — SITEMAP: north-up vector location plan drawn from real OpenStreetMap data.
// export createSiteMap(container, { lang, onOpen3D }) => Promise<{ setLang(lang), highlight(landmarkId|null), dispose() }>
// Data: data/osm.json (already in the local building frame, metres) rotated to north-up with SITE_FRAME.north.
// Rendering: one SVG (merged paths per class, LOD by zoom) + an HTML overlay for markers/labels that keep screen size.
// All DOM/CSS is prefixed `sm-`. Colours derive from the site's CSS variables (light + dark). No side effects on import.

import { PROJECT, LANDMARKS, SITE_FRAME, geoToLocal, FOOTPRINT, LOT } from './data.js';

const NS = 'http://www.w3.org/2000/svg';

// ---------------------------------------------------------------------------
// i18n (own strings only)
const T = {
  en: {
    aria: 'Map of the area around Barreiro 2, Rua Eduardo Couto, Lavradio',
    help: 'Drag to move · scroll, pinch or double-tap to zoom · arrow keys and + / − on the keyboard',
    loading: 'Drawing the map…', error: 'The map data could not be loaded.',
    zin: 'Zoom in', zout: 'Zoom out', centre: 'Centre on Barreiro 2',
    maps: 'Open in Google Maps', earth: 'Google Earth 3D', street: 'Street View', v3d: 'View in 3D',
    site: 'Barreiro 2', siteSub: 'Rua Eduardo Couto · Lavradio', water: 'Tagus Estuary',
    walk: (n) => `≈ ${n} min on foot`, from: 'from Barreiro 2', line: 'straight line',
    m: 'm', km: 'km', north: 'N', northAria: 'North is up', legendPlot: 'The plot'
  },
  pt: {
    aria: 'Mapa da zona do Barreiro 2, Rua Eduardo Couto, Lavradio',
    help: 'Arraste para mover · roda, dois dedos ou toque duplo para zoom · setas e + / − no teclado',
    loading: 'A desenhar o mapa…', error: 'Não foi possível carregar os dados do mapa.',
    zin: 'Aproximar', zout: 'Afastar', centre: 'Centrar no Barreiro 2',
    maps: 'Abrir no Google Maps', earth: 'Google Earth 3D', street: 'Street View', v3d: 'Ver em 3D',
    site: 'Barreiro 2', siteSub: 'Rua Eduardo Couto · Lavradio', water: 'Estuário do Tejo',
    walk: (n) => `≈ ${n} min a pé`, from: 'do Barreiro 2', line: 'em linha reta',
    m: 'm', km: 'km', north: 'N', northAria: 'Norte para cima', legendPlot: 'O lote'
  },
  he: {
    aria: 'מפת הסביבה של בריירו 2, רחוב אדוארדו קוטו, לברדיו',
    help: 'גררו להזזה · גלגלת, צביטה או הקשה כפולה לזום · חצים ו־+ / − במקלדת',
    loading: 'משרטטים את המפה…', error: 'לא ניתן לטעון את נתוני המפה.',
    zin: 'התקרבות', zout: 'התרחקות', centre: 'מרכוז על בריירו 2',
    maps: 'פתיחה ב־Google Maps', earth: 'Google Earth בתלת־ממד', street: 'Street View', v3d: 'צפייה בתלת־ממד',
    site: 'בריירו 2', siteSub: 'רחוב אדוארדו קוטו · לברדיו', water: 'שפך הטז׳ו',
    walk: (n) => `כ־${n} דק׳ הליכה`, from: 'מבריירו 2', line: 'בקו אווירי',
    m: 'מ׳', km: 'ק״מ', north: 'צ', northAria: 'הצפון למעלה', legendPlot: 'המגרש'
  },
  ru: {
    aria: 'Карта района вокруг Barreiro 2, Rua Eduardo Couto, Лавраду',
    help: 'Перетаскивайте для перемещения · колесо, щипок или двойное касание для масштаба · стрелки и + / − на клавиатуре',
    loading: 'Рисуем карту…', error: 'Не удалось загрузить данные карты.',
    zin: 'Приблизить', zout: 'Отдалить', centre: 'К Barreiro 2',
    maps: 'Открыть в Google Maps', earth: 'Google Earth 3D', street: 'Просмотр улиц', v3d: 'Смотреть в 3D',
    site: 'Barreiro 2', siteSub: 'Rua Eduardo Couto · Лавраду', water: 'Эстуарий Тежу',
    walk: (n) => `≈ ${n} мин пешком`, from: 'от Barreiro 2', line: 'по прямой',
    m: 'м', km: 'км', north: 'С', northAria: 'Север сверху', legendPlot: 'Участок'
  }
};
const tr = (lang) => T[lang] || T.en;

// ---------------------------------------------------------------------------
// icons (24-unit stroke icons, currentColor)
const I = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${d}</svg>`;
const ICON = {
  train: I('<rect x="6" y="3" width="12" height="13" rx="3"/><path d="M6 10h12M9.5 13h.01M14.5 13h.01M8 16l-2 5M16 16l2 5M7 19h10"/>'),
  ferry: I('<path d="M3 18c1.5 1.2 3 1.2 4.5 0s3-1.2 4.5 0 3 1.2 4.5 0 3-1.2 4.5 0"/><path d="M5 15l1-5h12l1 5M9 10V7h6v3M12 4v3"/>'),
  city: I('<path d="M3 21h18M5 21V10l4-2v13M9 21V5l6-2v18M15 21V9l4 2v10"/>'),
  bridge: I('<path d="M2 17h20M5 17V6M19 17V6M5 7c3 5 11 5 14 0M9 17v-5M12 17v-4M15 17v-5"/>'),
  monument: I('<path d="M12 3v3M9 6h6M12 6v11M8 21h8M10 17h4l1 4H9z"/>'),
  health: I('<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 8v8M8 12h8"/>'),
  shopping: I('<path d="M5 8h14l-1 12H6z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>'),
  airport: I('<path d="M3 13l8-2 1-7c.2-1 1.8-1 2 0l1 7 6 2v2l-6-1-1 5 2 1v1l-4-1-4 1v-1l2-1-1-5-6 1z" transform="translate(-1 0) scale(1)"/>'),
  water: I('<path d="M3 9c2-1.5 4-1.5 6 0s4 1.5 6 0 4-1.5 6 0M3 14c2-1.5 4-1.5 6 0s4 1.5 6 0 4-1.5 6 0M3 19c2-1.5 4-1.5 6 0s4 1.5 6 0 4-1.5 6 0"/>'),
  school: I('<path d="M2 9l10-5 10 5-10 5z"/><path d="M6 11v5c3 2.5 9 2.5 12 0v-5M22 9v6"/>'),
  park: I('<path d="M12 21v-6M12 15c-4 0-6-2.5-6-5.5S8.5 3 12 3s6 3.5 6 6.5-2 5.5-6 5.5z"/>'),
  pharmacy: I('<rect x="3" y="8" width="18" height="8" rx="4" transform="rotate(-45 12 12)"/><path d="M9.2 9.2l5.6 5.6"/>'),
  market: I('<path d="M3 10l2-6h14l2 6M3 10c0 1.7 1.3 3 3 3s3-1.3 3-3c0 1.7 1.3 3 3 3s3-1.3 3-3c0 1.7 1.3 3 3 3s3-1.3 3-3M5 13v8h14v-8"/>'),
  road: I('<path d="M8 3L5 21M16 3l3 18M12 5v2M12 11v2M12 17v2"/>'),
  pin: I('<circle cx="12" cy="10" r="3"/><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/>'),
  plus: I('<path d="M12 5v14M5 12h14"/>'),
  minus: I('<path d="M5 12h14"/>'),
  target: I('<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>'),
  ext: I('<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
  globe: I('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.8 2.6 4 5.6 4 9s-1.2 6.4-4 9c-2.8-2.6-4-5.6-4-9s1.2-6.4 4-9z"/>'),
  person: I('<circle cx="12" cy="5" r="2"/><path d="M10 22l1-7-2-2 1-5h4l1 5-2 2 1 7M8 12l2-4M16 12l-2-4"/>'),
  cube: I('<path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M3 7l9 5 9-5M12 12v10"/>'),
  mapi: I('<path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>')
};

// ---------------------------------------------------------------------------
// CSS (injected once)
const CSS = `
.sm-root{position:relative;display:grid;gap:12px;font-family:var(--f-body,system-ui,sans-serif);color:var(--ink,#1b1a17)}
.sm-stage{position:relative;overflow:hidden;height:clamp(380px,64vh,640px);background:var(--sm-ground,#f4f1eb);border:1px solid var(--line,#d6cfc3);border-radius:var(--r,2px);touch-action:none;user-select:none;-webkit-user-select:none;cursor:grab;outline:none;-webkit-tap-highlight-color:transparent;isolation:isolate}
.sm-stage.sm-drag{cursor:grabbing}
.sm-stage:focus-visible{box-shadow:0 0 0 2px var(--bronze,#8a5a1c) inset}
@media (max-width:560px){.sm-stage{height:min(72vh,560px)}}
.sm-svg{position:absolute;inset:0;width:100%;height:100%;display:block}
.sm-svg text{font-family:var(--f-body,system-ui,sans-serif)}
.sm-ov{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.sm-ovi{position:absolute;left:0;top:0;width:0;height:0}
.sm-at{position:absolute;left:0;top:0;width:0;height:0}
.sm-mk{position:absolute;left:0;top:0;transform:translate(-50%,-50%);pointer-events:auto;display:grid;place-items:center;width:30px;height:30px;padding:0;border-radius:50%;border:1px solid var(--sm-mkline);background:var(--card,#fbfaf7);color:var(--ink,#1b1a17);box-shadow:0 1px 2px rgba(0,0,0,.08),0 4px 12px -4px rgba(0,0,0,.18);cursor:pointer;transition:background .18s,color .18s,transform .18s,border-color .18s}
.sm-mk svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.sm-mk.sm-r3{width:24px;height:24px}.sm-mk.sm-r3 svg{width:13px;height:13px}
.sm-mk:hover,.sm-mk:focus-visible,.sm-mk.sm-on{background:var(--bronze,#8a5a1c);color:var(--on-bronze,#fff);border-color:var(--bronze,#8a5a1c);transform:translate(-50%,-50%) scale(1.12);outline:none}
.sm-nm{position:absolute;left:0;top:0;white-space:nowrap;font-size:11.5px;line-height:1.2;font-weight:500;letter-spacing:.01em;color:var(--ink,#1b1a17);text-shadow:0 0 2px var(--sm-ground),0 0 3px var(--sm-ground),0 0 5px var(--sm-ground),0 0 8px var(--sm-ground);transform:translate(20px,-50%);pointer-events:none;transition:opacity .2s}
.sm-nm.sm-r3n{font-size:10.5px;color:var(--ink-2,#57524a);transform:translate(16px,-50%)}
.sm-nm.sm-hide{opacity:0}
.sm-site{position:absolute;left:0;top:0;pointer-events:none}
.sm-ring{position:absolute;left:-9px;top:-9px;width:18px;height:18px;border-radius:50%;border:1.5px solid var(--bronze,#8a5a1c);animation:sm-pulse 2.6s cubic-bezier(.2,.6,.3,1) infinite;opacity:0}
.sm-ring.sm-ring2{animation-delay:1.3s}
.sm-dot{position:absolute;left:-5px;top:-5px;width:10px;height:10px;border-radius:50%;background:var(--bronze,#8a5a1c);box-shadow:0 0 0 3px var(--sm-ground),0 0 0 4px var(--bronze,#8a5a1c)}
.sm-site.sm-big .sm-dot{opacity:0}
.sm-site.sm-flip .sm-flag{transform:translate(calc(-100% - 26px),calc(-100% - 22px));padding:0 12px 0 0;border-left:0;border-right:1px solid var(--bronze,#8a5a1c);text-align:right}
.sm-site.sm-flip .sm-flag::before{left:auto;right:-27px;transform:scaleX(-1)}
@keyframes sm-pulse{0%{transform:scale(1);opacity:.75}100%{transform:scale(4.2);opacity:0}}
@media (prefers-reduced-motion:reduce){.sm-ring{animation:none;opacity:.5;transform:scale(2)}.sm-ring2{display:none}}
.sm-flag{position:absolute;left:0;top:0;transform:translate(26px,calc(-100% - 22px));white-space:nowrap;padding:0 0 0 12px;border-left:1px solid var(--bronze,#8a5a1c)}
.sm-flag::before{content:"";position:absolute;left:-27px;bottom:-22px;width:27px;height:22px;background:linear-gradient(to top right,transparent calc(50% - .6px),var(--bronze,#8a5a1c) calc(50% - .6px),var(--bronze,#8a5a1c) calc(50% + .6px),transparent calc(50% + .6px))}
.sm-flag b{display:block;font-family:var(--f-display,Georgia,serif);font-weight:500;font-size:22px;line-height:1;letter-spacing:.01em;color:var(--ink,#1b1a17);text-shadow:0 0 3px var(--sm-ground),0 0 6px var(--sm-ground),0 0 10px var(--sm-ground)}
.sm-flag span{display:block;margin-top:4px;font-size:9.5px;font-weight:500;letter-spacing:.14em;text-transform:uppercase;color:var(--bronze,#8a5a1c);text-shadow:0 0 3px var(--sm-ground),0 0 6px var(--sm-ground)}
.sm-flag .sm-eb{margin:0 0 3px;font-family:var(--f-mono,monospace);font-size:9px;letter-spacing:.2em;color:var(--ink-3,#8b8479)}
@media (max-width:560px){.sm-flag b{font-size:18px}.sm-flag span{font-size:8.5px;letter-spacing:.1em}}
:root[lang="he"] .sm-flag span,:root[lang="ru"] .sm-flag span{letter-spacing:.04em}
.sm-wl{position:absolute;left:0;top:0;transform:translate(-50%,-50%);white-space:nowrap;font-family:var(--f-display,Georgia,serif);font-style:italic;font-size:19px;letter-spacing:.32em;text-transform:uppercase;color:var(--sm-watertext);pointer-events:none;opacity:.95}
:root[lang="he"] .sm-wl{letter-spacing:.08em;font-style:normal}
.sm-ptr{position:absolute;left:0;top:0;pointer-events:auto;display:flex;align-items:center;gap:6px;padding:4px 9px 4px 5px;border-radius:999px;background:var(--card,#fbfaf7);border:1px solid var(--line,#d6cfc3);color:var(--ink,#1b1a17);font-size:11px;line-height:1.1;font-weight:500;white-space:nowrap;box-shadow:0 4px 14px -6px rgba(0,0,0,.25);cursor:pointer;transform:translate(-50%,-50%)}
.sm-ptr i{display:grid;place-items:center;width:18px;height:18px;border-radius:50%;background:var(--bronze-soft,rgba(138,90,28,.12));color:var(--bronze,#8a5a1c);font-style:normal}
.sm-ptr i svg{width:11px;height:11px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}
.sm-ptr em{font-style:normal;color:var(--ink-3,#8b8479);font-family:var(--f-mono,monospace);font-size:10px}
.sm-ptr:hover,.sm-ptr:focus-visible{border-color:var(--bronze,#8a5a1c);outline:none}
.sm-tip{position:absolute;left:0;top:0;z-index:5;pointer-events:none;min-width:150px;max-width:250px;padding:10px 12px;background:var(--card,#fbfaf7);border:1px solid var(--line,#d6cfc3);border-radius:var(--r,2px);box-shadow:var(--shadow,0 12px 32px -12px rgba(0,0,0,.3));font-size:12.5px;line-height:1.35;opacity:0;transition:opacity .15s;white-space:normal}
.sm-tip.sm-show{opacity:1}
.sm-tip b{display:block;font-weight:600;font-size:13px}
.sm-tip .sm-h{color:var(--ink-2,#57524a);margin-top:2px}
.sm-tip .sm-d{margin-top:6px;padding-top:6px;border-top:1px solid var(--line,#d6cfc3);color:var(--bronze,#8a5a1c);font-weight:500;font-variant-numeric:tabular-nums}
.sm-tip .sm-d small{display:block;color:var(--ink-3,#8b8479);font-weight:400;font-size:11px}
.sm-ctl{position:absolute;right:12px;top:12px;display:grid;gap:0;background:var(--card,#fbfaf7);border:1px solid var(--line,#d6cfc3);border-radius:var(--r,2px);box-shadow:0 4px 14px -8px rgba(0,0,0,.3);z-index:4}
.sm-ctl button{display:grid;place-items:center;width:38px;height:38px;border:0;background:none;color:var(--ink,#1b1a17);padding:0;cursor:pointer}
.sm-ctl button+button{border-top:1px solid var(--line,#d6cfc3)}
.sm-ctl button:hover{color:var(--bronze,#8a5a1c)}
.sm-ctl button:focus-visible{outline:2px solid var(--bronze,#8a5a1c);outline-offset:-2px}
.sm-ctl button[disabled]{opacity:.35;cursor:default}
.sm-ctl svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.sm-north{position:absolute;left:14px;top:12px;width:40px;height:52px;z-index:4;pointer-events:none;color:var(--ink,#1b1a17)}
.sm-north svg{width:100%;height:100%;overflow:visible}
.sm-scale{position:absolute;left:14px;bottom:12px;z-index:4;pointer-events:none;font-family:var(--f-mono,monospace);font-size:10px;color:var(--ink-2,#57524a);text-shadow:0 0 3px var(--sm-ground),0 0 6px var(--sm-ground)}
.sm-scale i{display:block;height:5px;margin-top:3px;border:1px solid var(--ink,#1b1a17);border-top:0;background:linear-gradient(90deg,var(--ink,#1b1a17) 0 50%,transparent 50% 100%);background-size:50% 100%;background-repeat:no-repeat;opacity:.8}
.sm-attr{position:absolute;right:0;bottom:0;z-index:4;padding:3px 8px;font-size:10px;line-height:1.3;color:var(--ink-3,#8b8479);background:color-mix(in srgb,var(--sm-ground) 82%,transparent);border-top-left-radius:var(--r,2px)}
.sm-attr a{color:inherit;text-decoration:none}
.sm-attr a:hover{text-decoration:underline}
.sm-msg{position:absolute;inset:0;display:grid;place-items:center;font-size:13px;letter-spacing:.06em;color:var(--ink-3,#8b8479);z-index:6;pointer-events:none}
.sm-help{position:absolute;left:50%;top:12px;transform:translateX(-50%);z-index:3;padding:5px 12px;border-radius:999px;background:color-mix(in srgb,var(--card,#fbfaf7) 90%,transparent);border:1px solid var(--line,#d6cfc3);font-size:11px;color:var(--ink-2,#57524a);white-space:nowrap;pointer-events:none;transition:opacity .6s;max-width:calc(100% - 180px);overflow:hidden;text-overflow:ellipsis}
.sm-help.sm-gone{opacity:0}
@media (max-width:560px){.sm-help{display:none}}
.sm-bar{display:flex;flex-wrap:wrap;gap:8px}
.sm-b{display:inline-flex;align-items:center;justify-content:center;gap:9px;min-height:44px;padding:0 16px;border-radius:var(--r,2px);border:1px solid var(--line-strong,#b9b0a2);background:none;color:var(--ink,#1b1a17);font:inherit;font-size:.76rem;font-weight:500;letter-spacing:.09em;text-transform:uppercase;text-decoration:none;white-space:nowrap;cursor:pointer;transition:background .2s,color .2s,border-color .2s}
.sm-b svg{width:17px;height:17px;flex:none;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.sm-b:hover{border-color:var(--ink,#1b1a17)}
.sm-b:focus-visible{outline:2px solid var(--bronze,#8a5a1c);outline-offset:2px}
.sm-b.sm-pri{background:var(--bronze,#8a5a1c);border-color:var(--bronze,#8a5a1c);color:var(--on-bronze,#fff)}
.sm-b.sm-pri:hover{background:var(--bronze-2,#6f4712);border-color:var(--bronze-2,#6f4712)}
:root[lang="he"] .sm-b{letter-spacing:.02em;font-size:.86rem}
@media (max-width:560px){.sm-bar{display:grid;grid-template-columns:1fr 1fr}.sm-b{padding:0 10px;font-size:.7rem;letter-spacing:.05em;white-space:normal;text-align:center;line-height:1.15}.sm-b.sm-pri,.sm-b:last-child{grid-column:1/-1}.sm-ptr span{display:none}.sm-ptr{padding:4px 8px 4px 5px}}
.sm-svg .sm-water{fill:var(--sm-water)}
.sm-svg .sm-shore{fill:none;stroke:var(--sm-shore);stroke-linejoin:round;stroke-linecap:round}
.sm-svg .sm-shore2{fill:none;stroke:var(--sm-water2);stroke-linejoin:round}
.sm-svg .sm-island{fill:var(--sm-ground)}
.sm-svg .sm-lu-grey{fill:var(--sm-grey)}
.sm-svg .sm-lu-green{fill:var(--sm-green)}
.sm-svg .sm-lu-park{fill:var(--sm-park)}
.sm-svg .sm-lu-wet{fill:var(--sm-wet)}
.sm-svg .sm-lu-sand{fill:var(--sm-sand)}
.sm-svg .sm-lu-pitch{fill:var(--sm-pitch);stroke:var(--sm-pitchline)}
.sm-svg .sm-lu-parking{fill:var(--sm-parking)}
.sm-svg .sm-lu-cem{fill:var(--sm-green)}
.sm-svg .sm-wethatch{fill:none;stroke:var(--sm-wetline)}
.sm-svg .sm-rc{fill:none;stroke:var(--sm-casing);stroke-linecap:round;stroke-linejoin:round}
.sm-svg .sm-rc.sm-maj{stroke:var(--sm-majcasing)}
.sm-svg .sm-rf{fill:none;stroke:var(--sm-road);stroke-linecap:round;stroke-linejoin:round}
.sm-svg .sm-rf.sm-maj{stroke:var(--sm-major)}
.sm-svg .sm-rp{fill:none;stroke:var(--sm-path);stroke-linecap:round;stroke-linejoin:round}
.sm-svg .sm-rail{fill:none;stroke:var(--sm-rail);stroke-linejoin:round}
.sm-svg .sm-raild{fill:none;stroke:var(--sm-ground);stroke-linejoin:round}
.sm-svg .sm-railx{fill:none;stroke:var(--sm-rail);opacity:.35;stroke-linejoin:round}
.sm-svg .sm-plat{fill:none;stroke:var(--sm-bldapt);stroke-linecap:butt}
.sm-svg .sm-bsh{fill:var(--sm-bshadow)}
.sm-svg .sm-b-res{fill:var(--sm-bldres)}
.sm-svg .sm-b-apt{fill:var(--sm-bldapt)}
.sm-svg .sm-b-ind{fill:var(--sm-bldind)}
.sm-svg .sm-b-pub{fill:var(--sm-bldpub)}
.sm-svg .sm-bedge{fill:none;stroke:var(--sm-bldedge);stroke-linejoin:round}
.sm-svg .sm-bar{fill:none;stroke:var(--sm-barrier)}
.sm-svg .sm-tree{fill:var(--sm-tree)}
.sm-svg .sm-lot{fill:var(--sm-lotfill);stroke:var(--bronze,#8a5a1c)}
.sm-svg .sm-plotb{fill:var(--bronze,#8a5a1c)}
.sm-svg .sm-meas{fill:none;stroke:var(--bronze,#8a5a1c);stroke-linecap:round}
.sm-svg .sm-lbl text{fill:var(--sm-text);stroke:var(--sm-ground);paint-order:stroke;stroke-linejoin:round}
.sm-svg .sm-lbl.sm-l1 text{font-weight:500;letter-spacing:.02em}
.sm-svg .sm-lbl.sm-l2 text{font-weight:400;letter-spacing:.015em}
.sm-svg .sm-lbl.sm-l3 text{fill:var(--sm-textminor);font-weight:400}
.sm-svg .sm-lbl.sm-lp text{fill:var(--sm-textminor);font-style:italic}
.sm-svg .sm-lbl.sm-lr text{fill:var(--sm-rail);font-style:italic;letter-spacing:.04em}
.sm-svg .sm-lbl text.sm-home{fill:var(--bronze,#8a5a1c);font-weight:600}
`;

// ---------------------------------------------------------------------------
// colour helpers
function parseColor(s) {
  s = String(s || '').trim();
  let m;
  if ((m = s.match(/^#([0-9a-f]{3})$/i))) return [...m[1]].map(c => parseInt(c + c, 16));
  if ((m = s.match(/^#([0-9a-f]{6})/i))) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16));
  if ((m = s.match(/rgba?\(([^)]+)\)/i))) return m[1].split(/[ ,/]+/).slice(0, 3).map(Number);
  return null;
}
const hex = (c) => '#' + c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
function mix(a, b, t) { const A = parseColor(a), B = parseColor(b); if (!A || !B) return a; return hex(A.map((v, i) => v + (B[i] - v) * t)); }
const lum = (c) => { const p = parseColor(c) || [255, 255, 255]; return (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) / 255; };

function palette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n, f) => (cs.getPropertyValue(n) || '').trim() || f;
  const paper = v('--paper', v('--bg', '#f4f1eb'));
  const ink = v('--ink', '#1b1a17');
  const bronze = v('--bronze', v('--accent', '#8a5a1c'));
  const ink2 = v('--ink-2', mix(paper, ink, .7)), ink3 = v('--ink-3', mix(paper, ink, .5));
  const dark = lum(paper) < 0.4;
  const G = dark ? '#5f7f4c' : '#86a36a';
  const water = dark ? mix(paper, '#3c6a80', .40) : mix(paper, '#7fa9ba', .44);
  return {
    ground: paper,
    grey: mix(paper, ink, dark ? .03 : .035),
    green: mix(paper, G, dark ? .20 : .22),
    park: mix(paper, G, dark ? .27 : .30),
    pitch: mix(paper, G, dark ? .34 : .40),
    pitchline: dark ? mix(paper, ink, .16) : mix(paper, '#ffffff', .75),
    wet: mix(paper, dark ? '#4f7560' : '#93ae98', dark ? .16 : .2),
    wetline: mix(paper, dark ? '#5f8a70' : '#7f9f86', dark ? .35 : .4),
    sand: mix(paper, '#d6bd86', dark ? .13 : .3),
    parking: mix(paper, ink, dark ? .05 : .055),
    water, water2: dark ? mix(water, '#6fa2ba', .18) : mix(water, '#ffffff', .28),
    shore: dark ? mix(water, '#8fbdd0', .35) : mix(water, '#44748a', .38),
    watertext: dark ? mix(water, '#b7d6e3', .75) : mix(water, '#2d5568', .8),
    bldres: mix(paper, ink, dark ? .10 : .11),
    bldapt: mix(paper, ink, dark ? .15 : .17),
    bldind: mix(paper, '#7f8c99', dark ? .16 : .24),
    bldpub: dark ? mix(mix(paper, ink, .1), bronze, .12) : mix(paper, bronze, .16),
    bldedge: dark ? mix(paper, '#000000', .45) : mix(paper, ink, .28),
    bshadow: dark ? 'rgba(0,0,0,.42)' : 'rgba(58,44,26,.13)',
    road: dark ? mix(paper, ink, .19) : mix(paper, '#ffffff', .92),
    major: dark ? mix(paper, bronze, .2) : mix('#ffffff', '#ebcf9c', .52),
    casing: dark ? mix(paper, '#000000', .5) : mix(paper, ink, .19),
    majcasing: dark ? mix(paper, '#000000', .6) : mix(paper, bronze, .42),
    path: mix(paper, ink, dark ? .3 : .3),
    rail: mix(paper, ink, dark ? .5 : .55),
    tree: mix(paper, dark ? '#5d8a47' : '#5f8c48', dark ? .42 : .5),
    barrier: mix(paper, ink, .3),
    text: ink2, textminor: ink3,
    lotfill: dark ? 'rgba(200,150,79,.2)' : 'rgba(138,90,28,.14)',
    mkline: v('--line-strong', mix(paper, ink, .3))
  };
}

// ---------------------------------------------------------------------------
// geometry helpers: local (x,z) -> map (u east, v south-down) metres, north-up
const NX = SITE_FRAME.north.x, NZ = SITE_FRAME.north.z;
const EX = -NZ, EZ = NX; // east in local
const toMap = (x, z) => [x * EX + z * EZ, -(x * NX + z * NZ)];
const SITE_L = { x: 6.94, z: 7.35 };
const SITE = toMap(SITE_L.x, SITE_L.z);
const f1 = (n) => (Math.round(n * 10) / 10).toString();

function pathOf(pts, close) {
  let s = '';
  for (let i = 0; i < pts.length; i++) s += (i ? 'L' : 'M') + f1(pts[i][0]) + ' ' + f1(pts[i][1]);
  return close ? s + 'Z' : s;
}
function pip(pt, poly) {
  let c = false; const x = pt[0], y = pt[1];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function area(poly) { let a = 0; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]); return Math.abs(a / 2); }
function centroid(poly) { let x = 0, y = 0; const n = poly.length - 1 || 1; for (let i = 0; i < n; i++) { x += poly[i][0]; y += poly[i][1]; } return [x / n, y / n]; }

// join open polylines end-to-start (optionally reversing)
function joinChains(lines, tol = 0.6, allowReverse = false) {
  let chains = lines.map(l => l.slice());
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < chains.length; i++) {
      for (let j = 0; j < chains.length; j++) {
        if (i === j) continue;
        const a = chains[i], b = chains[j];
        if (dist(a[a.length - 1], b[0]) < tol) { chains[i] = a.concat(b.slice(1)); }
        else if (allowReverse && dist(a[a.length - 1], b[b.length - 1]) < tol) { chains[i] = a.concat(b.slice(0, -1).reverse()); }
        else if (allowReverse && dist(a[0], b[0]) < tol) { chains[i] = b.slice(1).reverse().concat(a); }
        else continue;
        chains.splice(j, 1); changed = true; break outer;
      }
    }
  }
  return chains;
}

// ---------------------------------------------------------------------------
const ROAD = {
  // class: [metres, min px, casing?, show from scale, label tier]
  trunk: ['maj', 14, 2.4, 0], trunk_link: ['maj', 8, 1.4, 0], motorway: ['maj', 16, 2.6, 0], motorway_link: ['maj', 8, 1.4, 0],
  primary: ['maj', 12, 2.2, 0], primary_link: ['maj', 7, 1.3, 0], secondary: ['maj', 11, 2.0, 0], secondary_link: ['maj', 7, 1.2, 0],
  tertiary: ['ter', 9.5, 1.6, 0], tertiary_link: ['ter', 7, 1.2, 0],
  residential: ['res', 7, 1.05, 0], unclassified: ['res', 7, 1.05, 0], living_street: ['res', 6, 1.0, 0], construction: ['res', 6, .8, 0],
  pedestrian: ['ped', 5, .8, .8], service: ['svc', 4.2, .55, .75], track: ['path', 2.5, .6, 1.3],
  footway: ['path', 1.6, .55, 1.3], path: ['path', 1.6, .55, 1.3], cycleway: ['path', 1.8, .55, 1.3], steps: ['path', 2, .7, 1.8]
};
const RCLS = { // draw classes
  maj: { m: 12, min: 2.2, from: 0, rank: 1 }, ter: { m: 9.5, min: 1.6, from: 0, rank: 2 },
  res: { m: 7, min: 1.0, from: 0, rank: 3 }, ped: { m: 5, min: .8, from: .8, rank: 4 },
  svc: { m: 4.2, min: .55, from: .75, rank: 5 }, path: { m: 1.6, min: .6, from: 1.3, rank: 6 }
};
const NAME_FIX = { 'Rua Edurado Couto': 'Rua Eduardo Couto', 'Rual Alexandre Herculano': 'Rua Alexandre Herculano' };

function bldClass(k) {
  if (k === 'apartments') return 'apt';
  if (['industrial', 'shed', 'roof', 'garages', 'garage', 'service', 'ruins', 'warehouse'].includes(k)) return 'ind';
  if (['school', 'church', 'stadium', 'sports_hall', 'office', 'commercial', 'retail', 'public', 'hospital', 'civic', 'chapel', 'university', 'kindergarten'].includes(k)) return 'pub';
  return 'res';
}
function luClass(k) {
  if (['grass', 'recreation_ground', 'greenfield', 'farmyard', 'allotments', 'meadow', 'village_green', 'orchard', 'farmland', 'forest', 'sports_centre'].includes(k)) return 'green';
  if (k === 'cemetery') return 'cem';
  if (['park', 'garden', 'playground', 'water_park', 'nature_reserve'].includes(k)) return 'park';
  if (k === 'pitch') return 'pitch';
  if (k === 'wetland') return 'wet';
  if (['sand', 'beach'].includes(k)) return 'sand';
  if (['industrial', 'brownfield', 'railway', 'construction', 'retail', 'commercial'].includes(k)) return 'grey';
  return null;
}

// ---------------------------------------------------------------------------
async function loadLandmarks() {
  let list = null;
  try {
    const m = await import('./aerial.js');
    if (Array.isArray(m.LANDMARKS_VERIFIED)) {
      const ids = new Set(m.LANDMARKS_VERIFIED.map(l => l.id));
      const alias = { 'fórum-barreiro': 'forum-barreiro' };
      const extra = (LANDMARKS || []).filter(l => !ids.has(l.id) && !ids.has(alias[l.id])).map(l => ({ ...l, rank: 4 }));
      list = [...m.LANDMARKS_VERIFIED, ...extra];
    }
  } catch (e) { /* fall back */ }
  if (!list) list = (LANDMARKS || []).map(l => ({ ...l, rank: l.kind === 'train' || l.kind === 'ferry' ? 1 : 2 }));
  return list.map(l => {
    const p = geoToLocal(l.lat, l.lon);
    const m = toMap(p.x, p.z);
    return { ...l, u: m[0], v: m[1], d: Math.hypot(p.x - SITE_L.x, p.z - SITE_L.z) };
  });
}

function injectCSS() {
  if (document.getElementById('sm-style')) return;
  const st = document.createElement('style');
  st.id = 'sm-style'; st.textContent = CSS;
  document.head.appendChild(st);
}
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const sv = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };

// ===========================================================================
export async function createSiteMap(container, { lang = 'en', onOpen3D } = {}) {
  injectCSS();
  let L = T[lang] ? lang : 'en';
  let disposed = false;
  const cleanups = [];
  const on = (t, ev, fn, opt) => { t.addEventListener(ev, fn, opt); cleanups.push(() => t.removeEventListener(ev, fn, opt)); };

  // ---------------- DOM skeleton
  const root = el('div', 'sm-root');
  const stage = el('div', 'sm-stage');
  stage.dir = 'ltr';
  stage.tabIndex = 0;
  stage.setAttribute('role', 'application');
  stage.setAttribute('aria-roledescription', 'map');
  const helpId = 'sm-help-' + Math.random().toString(36).slice(2, 8);
  stage.setAttribute('aria-describedby', helpId);
  const svg = sv('svg', { class: 'sm-svg', 'aria-hidden': 'true' });
  const defs = sv('defs'); svg.appendChild(defs);
  const world = sv('g'); svg.appendChild(world);
  const ov = el('div', 'sm-ov'); const ovi = el('div', 'sm-ovi'); ov.appendChild(ovi);
  const ptrLayer = el('div', 'sm-ov');
  const tip = el('div', 'sm-tip'); tip.setAttribute('role', 'status');
  const ctl = el('div', 'sm-ctl');
  const bIn = el('button', '', ICON.plus), bOut = el('button', '', ICON.minus), bCtr = el('button', '', ICON.target);
  [bIn, bOut, bCtr].forEach(b => { b.type = 'button'; ctl.appendChild(b); });
  const north = el('div', 'sm-north');
  const scale = el('div', 'sm-scale', '<span></span><i></i>');
  const attr = el('div', 'sm-attr', '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> · EU-DEM');
  const help = el('div', 'sm-help'); help.id = helpId;
  const msg = el('div', 'sm-msg');
  stage.append(svg, ov, ptrLayer, north, scale, ctl, help, attr, tip, msg);

  const bar = el('div', 'sm-bar');
  const b3d = el('button', 'sm-b sm-pri'); b3d.type = 'button';
  const aMaps = el('a', 'sm-b'), aEarth = el('a', 'sm-b'), aStreet = el('a', 'sm-b');
  [[aMaps, PROJECT.googleMaps], [aEarth, PROJECT.googleEarth], [aStreet, PROJECT.streetView]].forEach(([a, h]) => { a.href = h || '#'; a.target = '_blank'; a.rel = 'noopener'; });
  bar.append(b3d, aMaps, aEarth, aStreet);
  root.append(stage, bar);
  container.appendChild(root);
  on(b3d, 'click', () => { try { onOpen3D && onOpen3D(); } catch (e) { /* host handles */ } });

  // ---------------- theme
  function applyTheme() {
    const p = palette();
    for (const k in p) root.style.setProperty('--sm-' + k, p[k]);
  }
  applyTheme();
  const mo = new MutationObserver(applyTheme);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
  cleanups.push(() => mo.disconnect());
  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  if (mq) { const f = () => applyTheme(); mq.addEventListener ? mq.addEventListener('change', f) : mq.addListener(f); cleanups.push(() => mq.removeEventListener ? mq.removeEventListener('change', f) : mq.removeListener(f)); }

  north.innerHTML = `<svg viewBox="0 0 40 52"><text x="20" y="11" text-anchor="middle" font-family="var(--f-display,Georgia,serif)" font-size="13" font-weight="600" fill="currentColor" class="sm-nlet">N</text>
    <path d="M20 16 L26 44 L20 39 Z" fill="currentColor"/><path d="M20 16 L14 44 L20 39 Z" fill="none" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/></svg>`;

  function applyText() {
    const t = tr(L);
    stage.setAttribute('aria-label', t.aria);
    help.textContent = t.help;
    bIn.setAttribute('aria-label', t.zin); bIn.title = t.zin;
    bOut.setAttribute('aria-label', t.zout); bOut.title = t.zout;
    bCtr.setAttribute('aria-label', t.centre); bCtr.title = t.centre;
    north.setAttribute('aria-label', t.northAria); north.setAttribute('role', 'img');
    const nl = north.querySelector('.sm-nlet'); if (nl) nl.textContent = t.north;
    b3d.innerHTML = ICON.cube + `<span>${t.v3d}</span>`;
    aMaps.innerHTML = ICON.mapi + `<span>${t.maps}</span>`;
    aEarth.innerHTML = ICON.globe + `<span>${t.earth}</span>`;
    aStreet.innerHTML = ICON.person + `<span>${t.street}</span>`;
    if (msg.dataset.k) msg.textContent = t[msg.dataset.k];
  }
  msg.dataset.k = 'loading';
  applyText();

  // ---------------- view state
  let W = stage.clientWidth || 800, H = stage.clientHeight || 500;
  const view = { cx: SITE[0], cy: SITE[1], s: 1 };
  let sMin = 0.2, sMax = 14;
  const homeScale = () => Math.min(W, H) / 500;
  function limits() { sMin = Math.max(W, H) / 3000; sMax = 14; }
  limits();
  view.s = homeScale();

  // ---------------- data
  let data = null, landmarks = [];
  try {
    const [res, lms] = await Promise.all([
      fetch(new URL('../data/osm.json', import.meta.url)).then(r => { if (!r.ok) throw new Error('osm ' + r.status); return r.json(); }).catch(() => null),
      loadLandmarks().catch(() => [])
    ]);
    data = res; landmarks = lms;
    if (!data) throw new Error('no data');
  } catch (e) {
    msg.dataset.k = 'error'; msg.textContent = tr(L).error;
  }
  if (disposed) return api();

  // ---------------- build layers
  const G = {}; // named groups
  const mkG = (name, parent = world, attrs = {}) => { const g = sv('g', attrs); parent.appendChild(g); G[name] = g; return g; };
  const addPath = (g, cls, d, attrs = {}) => { if (!d) return null; const p = sv('path', { class: cls, d, ...attrs }); g.appendChild(p); return p; };
  const dyn = []; // [element, attr, fn(s)]
  const lod = []; // [element, minScale, maxScale]

  // background ground (big)
  world.appendChild(sv('rect', { x: -40000, y: -40000, width: 80000, height: 80000, fill: 'var(--sm-ground)' }));

  // vignette mask for land detail
  const mask = sv('mask', { id: 'sm-mask', maskUnits: 'userSpaceOnUse', x: -4000, y: -4000, width: 8000, height: 8000 });
  const rg = sv('radialGradient', { id: 'sm-rg', gradientUnits: 'userSpaceOnUse', cx: SITE[0], cy: SITE[1], r: 1250 });
  rg.append(sv('stop', { offset: '0.7', 'stop-color': '#fff' }), sv('stop', { offset: '1', 'stop-color': '#000' }));
  defs.append(rg, mask);
  mask.appendChild(sv('rect', { x: -4000, y: -4000, width: 8000, height: 8000, fill: 'url(#sm-rg)' }));
  const wetPat = sv('pattern', { id: 'sm-wetp', patternUnits: 'userSpaceOnUse', width: 14, height: 9 });
  wetPat.appendChild(sv('path', { class: 'sm-wethatch', d: 'M2 5h4M9 2h3M8 8h4', 'stroke-width': 0.9, 'stroke-linecap': 'round' }));
  defs.appendChild(wetPat);

  const land = mkG('land', world, { mask: 'url(#sm-mask)' });
  const waterG = mkG('water');
  const land2 = mkG('land2', world, { mask: 'url(#sm-mask)' });
  const topG = mkG('top');
  const lblG = mkG('labels', world);

  let waterPoly = null, islands = [];
  const chainsByName = new Map();
  const pois = [];

  if (data) {
    const M = (p) => toMap(p[0], p[1]);
    // ---- landuse & leisure & amenity
    const luD = { grey: '', green: '', park: '', wet: '', sand: '', pitch: '', cem: '', parking: '' };
    for (const o of data.lu || []) { const c = luClass(o.k); if (c) luD[c] += pathOf(o.p.map(M), true); }
    for (const o of data.g || []) { const c = luClass(o.k); if (c) luD[c] += pathOf(o.p.map(M), true); }
    for (const o of data.am || []) { if (o.k === 'parking') luD.parking += pathOf(o.p.map(M), true); else if (o.k === 'school') luD.grey += pathOf(o.p.map(M), true); }
    addPath(land, 'sm-lu-grey', luD.grey);
    addPath(land, 'sm-lu-sand', luD.sand);
    addPath(land, 'sm-lu-green', luD.green);
    addPath(land, 'sm-lu-cem', luD.cem);
    addPath(land, 'sm-lu-wet', luD.wet);
    addPath(land, 'sm-lu-wet', luD.wet, { fill: 'url(#sm-wetp)', style: 'fill:url(#sm-wetp)' });
    addPath(land, 'sm-lu-park', luD.park);
    const pk = addPath(land, 'sm-lu-parking', luD.parking); if (pk) lod.push([pk, 1.1]);
    const pit = addPath(land, 'sm-lu-pitch', luD.pitch); if (pit) dyn.push([pit, 'stroke-width', s => 1 / s]);

    // ---- water: stitch coastline + closed water bodies
    const W0 = (data.w || []).map(l => l.map(M));
    const closed = W0.filter(l => l.length > 3 && dist(l[0], l[l.length - 1]) < 0.01);
    const open = W0.filter(l => !(l.length > 3 && dist(l[0], l[l.length - 1]) < 0.01));
    const chains = joinChains(open, 0.6, false);
    let main = null; const joinedClosed = [];
    for (const c of chains) {
      if (c.length > 3 && dist(c[0], c[c.length - 1]) < 0.6) joinedClosed.push(c);
      else if (!main || c.length > main.length) main = c;
    }
    const shoreD = [];
    if (main) {
      // close the open coastline through a far arc; pick the side the DEM says is water
      const R = 30000;
      const ang = (p) => Math.atan2(p[1] - SITE[1], p[0] - SITE[0]);
      const far = (a) => [SITE[0] + Math.cos(a) * R, SITE[1] + Math.sin(a) * R];
      const a0 = ang(main[main.length - 1]), a1 = ang(main[0]);
      const build = (dir) => {
        const poly = main.slice();
        let d = a1 - a0;
        if (dir > 0) { while (d <= 0) d += Math.PI * 2; } else { while (d >= 0) d -= Math.PI * 2; }
        const n = Math.max(8, Math.ceil(Math.abs(d) / 0.08));
        for (let i = 0; i <= n; i++) poly.push(far(a0 + d * i / n));
        poly.push(main[0]);
        return poly;
      };
      const cand = [build(1), build(-1)];
      // score with DEM: null cells = water
      const tr0 = data.terrain;
      const score = [0, 0];
      if (tr0 && tr0.h) {
        for (let j = 0; j < tr0.N; j += 2) for (let i = 0; i < tr0.N; i += 2) {
          const h = tr0.h[j * tr0.N + i];
          const p = toMap(tr0.x0 + i * tr0.step, tr0.z0 + j * tr0.step);
          const isW = h == null || h < 0.5;
          for (let k = 0; k < 2; k++) if (pip(p, cand[k]) === isW) score[k]++;
        }
      }
      waterPoly = score[1] > score[0] ? cand[1] : cand[0];
      shoreD.push(pathOf(main, false));
    }
    let wD = waterPoly ? pathOf(waterPoly, true) : '';
    for (const c of closed) wD += pathOf(c, true);
    for (const c of joinedClosed) {
      const cen = centroid(c);
      if (waterPoly && pip(cen, waterPoly)) islands.push(c); else wD += pathOf(c, true);
    }
    for (const c of chains) if (c !== main && !joinedClosed.includes(c)) shoreD.push(pathOf(c, false));
    for (const c of closed) shoreD.push(pathOf(c, true));
    addPath(waterG, 'sm-water', wD, { 'fill-rule': 'nonzero' });
    for (const c of islands) shoreD.push(pathOf(c, true));
    // soft light band inside the shoreline (clipped to water) + crisp shoreline
    const sh2 = addPath(waterG, 'sm-shore2', shoreD.join(''));
    if (sh2) {
      dyn.push([sh2, 'stroke-width', s => 10 / s]);
      const cp = sv('clipPath', { id: 'sm-wclip' }); cp.appendChild(sv('path', { d: wD }));
      defs.appendChild(cp); sh2.setAttribute('clip-path', 'url(#sm-wclip)');
    }
    addPath(waterG, 'sm-island', islands.map(c => pathOf(c, true)).join(''));
    const sh = addPath(waterG, 'sm-shore', shoreD.join(''));
    if (sh) dyn.push([sh, 'stroke-width', s => 1.1 / s]);

    // ---- rail
    const railD = { rail: '', x: '', plat: '' };
    for (const r of data.rail || []) {
      const pts = r.p.map(M);
      if (r.k === 'rail' || r.k === 'light_rail' || r.k === 'narrow_gauge') railD.rail += pathOf(pts, false);
      else if (r.k === 'platform') railD.plat += pathOf(pts, dist(pts[0], pts[pts.length - 1]) < 0.1);
      else if (r.k === 'disused' || r.k === 'abandoned') railD.x += pathOf(pts, false);
    }
    const rx = addPath(land2, 'sm-railx', railD.x);
    if (rx) { dyn.push([rx, 'stroke-width', s => 1 / s]); dyn.push([rx, 'stroke-dasharray', s => `${3 / s} ${3 / s}`]); lod.push([rx, 0.9]); }

    // ---- roads
    const rd = {}; for (const c in RCLS) rd[c] = '';
    for (const r of data.r || []) {
      const def = ROAD[r.k]; if (!def) continue;
      const pts = r.p.map(M);
      rd[def[0]] += pathOf(pts, false);
      if (r.n) {
        const nm = NAME_FIX[r.n] || r.n;
        if (!chainsByName.has(nm)) chainsByName.set(nm, { ways: [], rank: 9 });
        const e = chainsByName.get(nm); e.ways.push(pts); e.rank = Math.min(e.rank, RCLS[def[0]].rank);
      }
    }
    const order = ['path', 'svc', 'ped', 'res', 'ter', 'maj'];
    for (const c of order) {
      if (c === 'path') continue;
      const cfg = RCLS[c];
      const p = addPath(land2, 'sm-rc' + (c === 'maj' || c === 'ter' ? ' sm-maj' : ''), rd[c]);
      if (!p) continue;
      dyn.push([p, 'stroke-width', s => (Math.max(cfg.min, cfg.m * s) + (c === 'maj' ? 1.6 : 1.2)) / s]);
      if (cfg.from) lod.push([p, cfg.from]);
      if (c === 'svc') lod.push([p, 1.4, 'casing']);
    }
    const pp = addPath(land2, 'sm-rp', rd.path);
    if (pp) { dyn.push([pp, 'stroke-width', s => Math.max(0.7, 1.4 * Math.sqrt(s / 2)) / s]); dyn.push([pp, 'stroke-dasharray', s => `${2.5 / s} ${2.2 / s}`]); lod.push([pp, RCLS.path.from]); }
    for (const c of order) {
      if (c === 'path') continue;
      const cfg = RCLS[c];
      const p = addPath(land2, 'sm-rf' + (c === 'maj' || c === 'ter' ? ' sm-maj' : ''), rd[c]);
      if (!p) continue;
      dyn.push([p, 'stroke-width', s => Math.max(cfg.min, cfg.m * s) / s]);
      if (cfg.from) lod.push([p, cfg.from]);
    }
    // rail on top of roads (it bridges/level-crosses)
    const rl = addPath(land2, 'sm-rail', railD.rail);
    const rdash = addPath(land2, 'sm-raild', railD.rail);
    const railW = s => Math.min(4.2, Math.max(1.7, 2.6 * Math.sqrt(s)));
    if (rl) dyn.push([rl, 'stroke-width', s => railW(s) / s]);
    if (rdash) { dyn.push([rdash, 'stroke-width', s => Math.max(0.6, railW(s) - 1.6) / s]); dyn.push([rdash, 'stroke-dasharray', s => `${7 / s} ${7 / s}`]); lod.push([rdash, 0.6]); }
    const pl = addPath(land2, 'sm-plat', railD.plat);
    if (pl) { dyn.push([pl, 'stroke-width', s => Math.max(2, 4 * s) / s]); lod.push([pl, 0.8]); }

    // ---- buildings
    const bD = { res: '', apt: '', ind: '', pub: '' }; let allB = '';
    for (const b of data.b || []) {
      const pts = b.p.map(M);
      // the plot is empty today: skip anything overlapping our lot
      const d = pathOf(pts, true);
      const c = bldClass(b.k);
      bD[c] += d; allB += d;
      if (b.nm) { const a = area(pts); pois.push({ name: b.nm, at: centroid(pts), a }); }
    }
    const shadow = addPath(land2, 'sm-bsh', allB);
    if (shadow) { dyn.push([shadow, 'transform', s => `translate(${1.1 / s} ${1.5 / s})`]); lod.push([shadow, 0.9]); }
    for (const c of ['res', 'apt', 'ind', 'pub']) addPath(land2, 'sm-b-' + c, bD[c]);
    const edge = addPath(land2, 'sm-bedge', allB);
    if (edge) { dyn.push([edge, 'stroke-width', s => 0.6 / s]); lod.push([edge, 1.6]); }

    // ---- barriers & trees
    const barD = (data.bar || []).map(o => pathOf(o.p.map(M), false)).join('');
    const bar_ = addPath(land2, 'sm-bar', barD);
    if (bar_) { dyn.push([bar_, 'stroke-width', s => 0.8 / s]); lod.push([bar_, 3]); }
    let tD = '';
    for (const t of data.t || []) {
      const [u, v] = M(t); const r = 2.3 + ((Math.abs(t[0] * 7.3 + t[1] * 3.1) % 1) * 1.4);
      tD += `M${f1(u - r)} ${f1(v)}a${f1(r)} ${f1(r)} 0 1 0 ${f1(2 * r)} 0a${f1(r)} ${f1(r)} 0 1 0 ${f1(-2 * r)} 0`;
    }
    const trees = addPath(land2, 'sm-tree', tD, { opacity: 0.8 });
    if (trees) lod.push([trees, 1.7]);
  }

  // ---- the plot (always, even without OSM)
  {
    const lot = [[LOT.x0, LOT.zRear], [LOT.x1, LOT.zRear], [LOT.x1, LOT.zFront], [LOT.x0, LOT.zFront]].map(p => toMap(p[0], p[1]));
    const lp = addPath(topG, 'sm-lot', pathOf(lot, true));
    dyn.push([lp, 'stroke-width', s => 1.2 / s]);
    dyn.push([lp, 'stroke-dasharray', s => `${3 / s} ${2 / s}`]);
    const fp = FOOTPRINT.map(p => toMap(p[0], p[1]));
    addPath(topG, 'sm-plotb', pathOf(fp, true));
  }
  const meas = sv('line', { class: 'sm-meas', x1: SITE[0], y1: SITE[1], x2: SITE[0], y2: SITE[1], visibility: 'hidden' });
  topG.appendChild(meas);
  dyn.push([meas, 'stroke-width', s => 1.4 / s]);
  dyn.push([meas, 'stroke-dasharray', s => `${1 / s} ${5 / s}`]);

  // ---------------- street-name chains
  const labelChains = [];
  for (const [name, e] of chainsByName) {
    const cs = joinChains(e.ways, 0.6, true);
    for (const c of cs) {
      const cum = [0];
      for (let i = 1; i < c.length; i++) cum.push(cum[i - 1] + dist(c[i - 1], c[i]));
      const len = cum[cum.length - 1];
      if (len < 25) continue;
      const mid = c[Math.floor(c.length / 2)];
      if (dist(mid, SITE) > 1250 && dist(c[0], SITE) > 1250) continue;
      labelChains.push({ name, pts: c, cum, len, rank: name === 'Rua Eduardo Couto' ? 0 : e.rank });
    }
  }
  labelChains.sort((a, b) => a.rank - b.rank || b.len - a.len);
  labelChains.forEach((c, i) => { c.id = 'sm-c' + i; });

  // ---------------- text measuring
  const mctx = document.createElement('canvas').getContext('2d');
  const bodyFont = () => (getComputedStyle(document.documentElement).getPropertyValue('--f-body') || 'system-ui').trim();
  const tw = (text, px, weight = 400, italic = false) => { mctx.font = `${italic ? 'italic ' : ''}${weight} ${px}px ${bodyFont()}`; return mctx.measureText(text).width * 1.03 + text.length * px * 0.02; };
  const TIER = (rank) => rank <= 2 ? { g: 'sm-l1', px: 11.5, w: 500 } : rank <= 4 ? { g: 'sm-l2', px: 10.5, w: 400 } : { g: 'sm-l3', px: 9.5, w: 400 };

  // label groups (font size is in map units => updated per zoom)
  const lblGroups = {};
  for (const k of ['sm-l1', 'sm-l2', 'sm-l3', 'sm-lp']) {
    const g = sv('g', { class: 'sm-lbl ' + k }); lblG.appendChild(g); lblGroups[k] = g;
    const px = k === 'sm-l1' ? 11.5 : k === 'sm-l2' ? 10.5 : k === 'sm-lp' ? 10 : 9.5;
    dyn.push([g, 'font-size', s => px / s]);
    dyn.push([g, 'stroke-width', s => 3.2 / s]);
  }
  const pathDefs = new Map();
  function defPath(chain, rev) {
    const id = chain.id + (rev ? 'r' : '');
    if (!pathDefs.has(id)) {
      const pts = rev ? chain.pts.slice().reverse() : chain.pts;
      const p = sv('path', { id, d: pathOf(pts, false) }); defs.appendChild(p); pathDefs.set(id, p);
    }
    return id;
  }
  function ptAt(chain, t) {
    const { cum, pts } = chain; let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= t) lo = m; else hi = m; }
    const seg = cum[hi] - cum[lo] || 1, k = (t - cum[lo]) / seg;
    return [pts[lo][0] + (pts[hi][0] - pts[lo][0]) * k, pts[lo][1] + (pts[hi][1] - pts[lo][1]) * k, lo];
  }
  function turning(chain, t0, t1) {
    const a = ptAt(chain, t0), b = ptAt(chain, t1);
    const idx = [];
    for (let i = a[2] + 1; i <= b[2]; i++) idx.push(i);
    const P = [[a[0], a[1]], ...idx.map(i => chain.pts[i]), [b[0], b[1]]];
    let tot = 0, mx = 0, prev = null;
    for (let i = 1; i < P.length; i++) {
      const dx = P[i][0] - P[i - 1][0], dy = P[i][1] - P[i - 1][1];
      if (Math.hypot(dx, dy) < 0.5) continue;
      const an = Math.atan2(dy, dx);
      if (prev != null) { let d = Math.abs(an - prev); if (d > Math.PI) d = 2 * Math.PI - d; tot += d; mx = Math.max(mx, d); }
      prev = an;
    }
    return { tot, mx, dx: b[0] - a[0], dy: b[1] - a[1] };
  }

  // ---------------- overlay: landmarks, site, water label
  const siteEl = el('div', 'sm-site', '<div class="sm-ring"></div><div class="sm-ring sm-ring2"></div><div class="sm-dot"></div><div class="sm-flag"><p class="sm-eb">VILNYI</p><b></b><span></span></div>');
  const siteAt = el('div', 'sm-at'); siteAt.appendChild(siteEl); ovi.appendChild(siteAt);
  let waterLabel = null;
  if (waterPoly) {
    // find an open-water point reasonably close to the site
    const shoreS = [];
    const chainPts = waterPoly.filter(p => dist(p, SITE) < 5000);
    for (let i = 0; i < chainPts.length; i += 3) shoreS.push(chainPts[i]);
    for (const c of islands) for (let i = 0; i < c.length; i += 3) shoreS.push(c[i]);
    let best = null, bs = -1e9;
    for (let y = -2200; y <= 400; y += 70) for (let x = -1800; x <= 1800; x += 70) {
      const p = [SITE[0] + x, SITE[1] + y];
      if (!pip(p, waterPoly) || islands.some(c => pip(p, c))) continue;
      let md = 1e9; for (const q of shoreS) { const d = dist(p, q); if (d < md) md = d; }
      const sc = Math.min(md, 380) * 1.2 - dist(p, SITE) * 0.35;
      if (md > 160 && sc > bs) { bs = sc; best = p; }
    }
    if (best) { waterLabel = el('div', 'sm-wl'); const a = el('div', 'sm-at'); a.appendChild(waterLabel); ovi.appendChild(a); waterLabel._at = a; waterLabel._p = best; }
  }

  const mks = [];
  for (const l of landmarks) {
    if (l.id === 'tejo' && waterLabel && l.d < 3000) { /* still show beach marker */ }
    const at = el('div', 'sm-at');
    const b = el('button', 'sm-mk' + (l.rank >= 3 ? ' sm-r3' : ''), ICON[l.kind] || ICON.pin);
    b.type = 'button';
    const nm = el('div', 'sm-nm' + (l.rank >= 3 ? ' sm-r3n' : ''));
    nm.dir = 'auto';
    at.append(nm, b); ovi.appendChild(at);
    const m = { l, at, b, nm, ptr: null };
    mks.push(m);
    on(b, 'pointerenter', (e) => { if (e.pointerType === 'mouse') showTip(m); });
    on(b, 'pointerleave', (e) => { if (e.pointerType === 'mouse' && active !== m) hideTip(); });
    on(b, 'focus', () => showTip(m));
    on(b, 'blur', () => { if (active !== m) hideTip(); });
    on(b, 'click', (e) => { e.stopPropagation(); if (suppressClick) return; active = active === m ? null : m; if (active) showTip(m); else hideTip(); });
    on(b, 'pointerdown', (e) => { if (e.pointerType !== 'mouse') { e.stopPropagation(); onDown(e); } });
  }
  // far landmarks: edge pointers (rank 1 only unless highlighted)
  for (const m of mks) {
    const p = el('button', 'sm-ptr'); p.type = 'button';
    p.innerHTML = '<i><svg viewBox="0 0 12 12"><path d="M2 6h8M7 3l3 3-3 3"/></svg></i><span></span><em></em>';
    p.hidden = true; ptrLayer.appendChild(p); m.ptr = p;
    on(p, 'click', (e) => { e.stopPropagation(); flyToLandmark(m); });
  }

  let active = null, hl = null;
  const fmtD = (m) => {
    const t = tr(L);
    if (m < 1000) return `${Math.round(m / 10) * 10} ${t.m}`;
    const km = m / 1000;
    return `${km.toLocaleString(L === 'he' ? 'he-IL' : L === 'pt' ? 'pt-PT' : L === 'ru' ? 'ru-RU' : 'en-GB', { maximumFractionDigits: km < 10 ? 1 : 0 })} ${t.km}`;
  };
  const nameOf = (l) => (l.name && (l.name[L] || l.name.en)) || l.id;
  const hintOf = (l) => (l.hint && (l.hint[L] || l.hint.en)) || '';
  function showTip(m) {
    const t = tr(L), l = m.l;
    const walk = l.d < 3500 ? `<small>${t.walk(Math.max(1, Math.round(l.d * 1.3 / 80)))}</small>` : '';
    tip.innerHTML = `<b></b>${hintOf(l) ? '<div class="sm-h"></div>' : ''}<div class="sm-d">${fmtD(l.d)} <span class="sm-f"></span>${walk}</div>`;
    tip.querySelector('b').textContent = nameOf(l);
    if (hintOf(l)) tip.querySelector('.sm-h').textContent = hintOf(l);
    tip.querySelector('.sm-f').textContent = `· ${t.line}`;
    tip.dir = (L === 'he') ? 'rtl' : 'ltr';
    tip._m = m;
    placeTip();
    tip.classList.add('sm-show');
    meas.setAttribute('x2', l.u); meas.setAttribute('y2', l.v); meas.setAttribute('visibility', 'visible');
    mks.forEach(k => k.b.classList.toggle('sm-on', k === m || k === hl));
  }
  function hideTip() {
    tip.classList.remove('sm-show'); tip._m = null; active = null;
    if (hl) { showTip(hl); return; }
    meas.setAttribute('visibility', 'hidden');
    mks.forEach(k => k.b.classList.toggle('sm-on', k === hl));
  }
  function screenOf(u, v) { return [W / 2 + (u - view.cx) * view.s, H / 2 + (v - view.cy) * view.s]; }
  function placeTip() {
    const m = tip._m; if (!m) return;
    let [x, y] = screenOf(m.l.u, m.l.v);
    const inView = x > 0 && x < W && y > 0 && y < H;
    if (!inView && m.ptr && !m.ptr.hidden) { x = m.ptr._x; y = m.ptr._y; }
    const tw_ = tip.offsetWidth || 180, th = tip.offsetHeight || 70;
    let tx = x + 20, ty = y - th - 14;
    if (tx + tw_ > W - 8) tx = x - tw_ - 20;
    if (tx < 8) tx = 8;
    if (ty < 8) ty = y + 22;
    if (ty + th > H - 8) ty = H - th - 8;
    tx = Math.max(8, Math.min(W - tw_ - 8, tx)); ty = Math.max(8, ty);
    tip.style.transform = `translate(${Math.round(tx)}px,${Math.round(ty)}px)`;
  }
  function applyLang() {
    const t = tr(L);
    applyText();
    siteEl.querySelector('b').textContent = t.site;
    siteEl.querySelector('span').textContent = t.siteSub;
    siteEl._fw = 0;
    if (waterLabel) waterLabel.textContent = t.water;
    for (const m of mks) {
      const n = nameOf(m.l);
      m.nm.textContent = n;
      m.b.setAttribute('aria-label', `${n} — ${fmtD(m.l.d)} ${t.from}`);
      m.ptr.querySelector('span').textContent = n.replace(/^(Lisbon|Lisboa|ליסבון) · /, '');
      m.ptr.querySelector('em').textContent = fmtD(m.l.d);
      m.ptr.setAttribute('aria-label', `${n} — ${fmtD(m.l.d)}`);
    }
    if (tip._m) showTip(tip._m);
    layoutLabels(true);
  }

  // ---------------- label layout (collision grid in screen px, pan-invariant)
  let lastLayoutS = -1;
  function layoutLabels(force) {
    const s = view.s;
    if (!force && Math.abs(Math.log(s / lastLayoutS)) < 0.02) return;
    lastLayoutS = s;
    for (const k in lblGroups) lblGroups[k].textContent = '';
    const CELL = 6, occ = new Set();
    const key = (x, y) => ((x / CELL) | 0) + ',' + ((y / CELL) | 0);
    const box = (x0, y0, x1, y1, test) => {
      for (let y = Math.floor(y0 / CELL); y <= Math.floor(y1 / CELL); y++)
        for (let x = Math.floor(x0 / CELL); x <= Math.floor(x1 / CELL); x++) {
          const k = x + ',' + y; if (test) { if (occ.has(k)) return false; } else occ.add(k);
        }
      return true;
    };
    const placed = new Map();
    for (const c of labelChains) if (c.rank === 0) placeChain(c);
    // reserve: site marker + flag
    const sx = SITE[0] * s, sy = SITE[1] * s;
    box(sx - 12, sy - 12, sx + 12, sy + 12, false);
    const fw = Math.max(tw(tr(L).site, 22, 500), tw(tr(L).siteSub, 9.5, 500) * 1.35) + 20;
    box(sx + 24, sy - 88, sx + 30 + fw, sy - 20, false);
    // landmarks (in order of rank)
    const vis = mks.slice().sort((a, b) => a.l.rank - b.l.rank || a.l.d - b.l.d);
    for (const m of vis) {
      const x = m.l.u * s, y = m.l.v * s, r = m.l.rank >= 3 ? 12 : 15;
      const minS = m.l.rank >= 3 ? 0.7 : 0;
      const showMk = s >= minS || m === hl;
      m.at.style.display = showMk ? '' : 'none';
      if (!showMk) { m._vis = false; continue; }
      m._vis = true;
      box(x - r, y - r, x + r, y + r, false);
      const w = tw(nameOf(m.l), m.l.rank >= 3 ? 10.5 : 11.5, 500);
      const wantName = (m.l.rank <= 2 || s >= 2.4 || m === hl) && m.l.d < 6000;
      const ok = wantName && box(x + r + 2, y - 8, x + r + 6 + w, y + 8, true);
      m.nm.classList.toggle('sm-hide', !ok);
      if (ok) box(x + r + 2, y - 8, x + r + 6 + w, y + 8, false);
    }
    function placeChain(c) {
      const cls = RCLS_OF_RANK(c.rank, s); if (!cls) return;
      const tier = TIER(c.rank);
      const textPx = tw(c.name, tier.px, tier.w) + 18;
      const need = textPx / s;
      if (need > c.len * 0.96) return;
      const mine = placed.get(c.name) || [];
      if (mine.length >= 3) return;
      const step = Math.max(need / 3, 15);
      const cands = [];
      for (let t = need / 2; t <= c.len - need / 2; t += step) cands.push(t);
      cands.sort((a, b) => Math.abs(a - c.len / 2) - Math.abs(b - c.len / 2));
      let n = 0;
      for (const t of cands) {
        if (n >= 2 || mine.length >= 3) break;
        const q = ptAt(c, t);
        if (dist(q, SITE) > 1200) continue;
        if (mine.some(o => dist(o, q) * s < 420)) continue;
        const tn = turning(c, t - need / 2, t + need / 2);
        if (tn.tot > 0.75 || tn.mx > 0.42) continue;
        // sample span for collisions
        const samples = [];
        const ns = Math.max(3, Math.ceil(textPx / 5));
        let ok = true;
        for (let i = 0; i <= ns; i++) {
          const p = ptAt(c, t - need / 2 + need * i / ns);
          const x = p[0] * s, y = p[1] * s;
          samples.push([x, y]);
          if (!box(x - 4, y - 5, x + 4, y + 5, true)) { ok = false; break; }
        }
        if (!ok) continue;
        for (const [x, y] of samples) box(x - 4, y - 5, x + 4, y + 5, false);
        const rev = tn.dx < 0 || (Math.abs(tn.dx) < 1e-6 && tn.dy > 0);
        const id = defPath(c, rev);
        const off = rev ? c.len - t : t;
        const text = sv('text', { dy: '0.35em' });
        if (c.rank === 0) text.setAttribute('class', 'sm-home');
        const tp = sv('textPath', { href: '#' + id, startOffset: f1(off), 'text-anchor': 'middle' });
        tp.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#' + id);
        tp.textContent = c.name;
        text.appendChild(tp);
        lblGroups[tier.g].appendChild(text);
        mine.push(q); placed.set(c.name, mine); n++;
      }
    }
    for (const c of labelChains) if (c.rank > 0) placeChain(c);
    // named buildings (POI) at close zoom
    if (s >= 2.6) {
      const seen = new Set(landmarks.map(l => nameOf(l).toLowerCase()));
      for (const p of pois.slice().sort((a, b) => b.a - a.a)) {
        const low = p.name.toLowerCase();
        if ([...seen].some(n => n.includes(low) || low.includes(n))) continue;
        const w = tw(p.name, 10, 400, true); const x = p.at[0] * s, y = p.at[1] * s;
        if (!box(x - w / 2, y - 7, x + w / 2, y + 7, true)) continue;
        box(x - w / 2, y - 7, x + w / 2, y + 7, false);
        const tx = sv('text', { x: f1(p.at[0]), y: f1(p.at[1]), dy: '0.35em', 'text-anchor': 'middle' });
        tx.textContent = p.name.length > 34 ? p.name.slice(0, 32) + '…' : p.name;
        lblGroups['sm-lp'].appendChild(tx);
      }
    }
  }
  function RCLS_OF_RANK(rank, s) {
    if (rank <= 3) return true;
    if (rank === 4) return s >= 1.0;
    if (rank === 5) return s >= 1.8;
    return s >= 3.2;
  }

  // ---------------- render loop
  let raf = 0, lastS = -1, layoutTimer = 0;
  function request() { if (!raf && !disposed) raf = requestAnimationFrame(frame); }
  function clampView() {
    view.s = Math.max(sMin, Math.min(sMax, view.s));
    const R = 2200;
    view.cx = Math.max(SITE[0] - R, Math.min(SITE[0] + R, view.cx));
    view.cy = Math.max(SITE[1] - R, Math.min(SITE[1] + R, view.cy));
  }
  function frame() {
    raf = 0;
    if (anim) stepAnim();
    if (inertia) stepInertia();
    clampView();
    const s = view.s;
    const tx = W / 2 - view.cx * s, ty = H / 2 - view.cy * s;
    world.setAttribute('transform', `matrix(${s} 0 0 ${s} ${tx.toFixed(2)} ${ty.toFixed(2)})`);
    ovi.style.transform = `translate(${tx.toFixed(2)}px,${ty.toFixed(2)}px)`;
    if (s !== lastS) {
      lastS = s;
      for (const [e, a, fn] of dyn) e.setAttribute(a, fn(s));
      for (const [e, min, kind] of lod) {
        if (kind === 'casing') continue;
        e.style.display = s >= min ? '' : 'none';
      }
      siteAt.style.transform = `translate(${SITE[0] * s}px,${SITE[1] * s}px)`;
      siteEl.classList.toggle('sm-big', s > 5);
      if (waterLabel) { waterLabel._at.style.transform = `translate(${waterLabel._p[0] * s}px,${waterLabel._p[1] * s}px)`; waterLabel.style.fontSize = (s < 0.5 ? 16 : s < 1.5 ? 19 : 22) + 'px'; }
      for (const m of mks) m.at.style.transform = `translate(${(m.l.u * s).toFixed(1)}px,${(m.l.v * s).toFixed(1)}px)`;
      updateScale();
      bIn.disabled = s >= sMax * 0.999; bOut.disabled = s <= sMin * 1.001;
      clearTimeout(layoutTimer);
      if (lastLayoutS < 0) layoutLabels(true);
      else layoutTimer = setTimeout(() => layoutLabels(false), anim || pinch ? 220 : 90);
    }
    {
      const sx = W / 2 + (SITE[0] - view.cx) * s;
      const fw = siteEl._fw || (siteEl._fw = (siteEl.querySelector('.sm-flag').offsetWidth || 200));
      const flip = sx + 30 + fw > W - 8 && sx - 30 - fw > 8;
      if (flip !== siteEl._flip) { siteEl._flip = flip; siteEl.classList.toggle('sm-flip', flip); }
    }
    updatePointers();
    placeTip();
    if (anim || inertia) request();
  }
  function updateScale() {
    const nice = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
    const target = Math.min(120, W * 0.22) / view.s;
    let m = nice[0]; for (const n of nice) if (n <= target) m = n;
    const t = tr(L);
    scale.querySelector('span').textContent = m >= 1000 ? `${m / 1000} ${t.km}` : `${m} ${t.m}`;
    scale.querySelector('i').style.width = Math.round(m * view.s) + 'px';
  }
  function updatePointers() {
    const pad = 26, used = [];
    for (const m of mks) {
      const want = (m.l.rank === 1 || m === hl) && m.l.id !== 'tejo';
      const [x, y] = screenOf(m.l.u, m.l.v);
      const inside = x > 8 && x < W - 8 && y > 8 && y < H - 8;
      if (!want || inside) { m.ptr.hidden = true; continue; }
      // intersect ray from centre with inset rect
      const cx = W / 2, cy = H / 2, dx = x - cx, dy = y - cy;
      const hw = W / 2 - pad - 40, hh = H / 2 - pad - 6;
      const k = Math.min(hw / Math.abs(dx || 1e-6), hh / Math.abs(dy || 1e-6));
      let px = cx + dx * k, py = cy + dy * k;
      const mx_ = W < 560 ? 44 : 96; px = Math.max(mx_, Math.min(W - mx_, px)); py = Math.max(84, Math.min(H - 52, py));
      for (let i = 0; i < 4; i++) { const hit = used.find(u => Math.abs(u[0] - px) < 150 && Math.abs(u[1] - py) < 28); if (!hit) break; py += (py < cy ? 30 : -30); }
      used.push([px, py]);
      m.ptr.hidden = false; m.ptr._x = px; m.ptr._y = py;
      m.ptr.style.transform = `translate(${Math.round(px)}px,${Math.round(py)}px) translate(-50%,-50%)`;
      const a = Math.atan2(dy, dx) * 180 / Math.PI;
      m.ptr.querySelector('i svg').style.transform = `rotate(${a.toFixed(0)}deg)`;
    }
  }

  // ---------------- animation
  let anim = null, inertia = null;
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  function animateTo(cx, cy, s, ms = 420) {
    s = Math.max(sMin, Math.min(sMax, s));
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    inertia = null;
    if (reduce || ms <= 0) { view.cx = cx; view.cy = cy; view.s = s; anim = null; request(); return; }
    anim = { t0: performance.now(), ms, a: { ...view }, b: { cx, cy, s } };
    request();
  }
  function stepAnim() {
    const k = Math.min(1, (performance.now() - anim.t0) / anim.ms), e = ease(k);
    const { a, b } = anim;
    const s = Math.exp(Math.log(a.s) + (Math.log(b.s) - Math.log(a.s)) * e);
    // keep the zoom focus stable: interpolate centre in screen-consistent way
    view.s = s;
    view.cx = a.cx + (b.cx - a.cx) * e; view.cy = a.cy + (b.cy - a.cy) * e;
    if (k >= 1) { view.s = b.s; view.cx = b.cx; view.cy = b.cy; anim = null; }
  }
  function stepInertia() {
    view.cx -= inertia.vx / view.s; view.cy -= inertia.vy / view.s;
    inertia.vx *= 0.9; inertia.vy *= 0.9;
    if (Math.hypot(inertia.vx, inertia.vy) < 0.3) inertia = null;
  }
  function zoomAt(factor, sx, sy, ms = 0) {
    const s1 = Math.max(sMin, Math.min(sMax, view.s * factor));
    const mx = view.cx + (sx - W / 2) / view.s, my = view.cy + (sy - H / 2) / view.s;
    const cx = mx - (sx - W / 2) / s1, cy = my - (sy - H / 2) / s1;
    if (ms) animateTo(cx, cy, s1, ms); else { anim = null; inertia = null; view.cx = cx; view.cy = cy; view.s = s1; request(); }
  }
  function home(ms = 480) { animateTo(SITE[0], SITE[1], homeScale(), ms); }
  function flyToLandmark(m) {
    const l = m.l;
    if (l.d < 2600) {
      const s = Math.min((W - 140) / Math.max(1, Math.abs(l.u - SITE[0])), (H - 170) / Math.max(1, Math.abs(l.v - SITE[1])), homeScale() * 1.4);
      animateTo((l.u + SITE[0]) / 2, (l.v + SITE[1]) / 2, s, 520);
    }
    active = m; showTip(m);
  }

  // ---------------- input
  const ptrs = new Map();
  let drag = null, pinch = null, suppressClick = false, lastTap = null, helpTimer = 0;
  function rel(e) { const r = stage.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  function hideHelp() { if (!help.classList.contains('sm-gone')) { help.classList.add('sm-gone'); } }
  function onDown(e) {
    if (e.button != null && e.button > 0) return;
    const p = rel(e);
    ptrs.set(e.pointerId, p);
    anim = null; inertia = null;
    if (ptrs.size === 1) { drag = { x: p[0], y: p[1], moved: false, t: performance.now(), hist: [[p[0], p[1], performance.now()]], id: e.pointerId, type: e.pointerType }; suppressClick = false; }
    else if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      pinch = { d: dist(a, b), s: view.s, m: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
      if (drag) drag.moved = true; suppressClick = true;
    }
  }
  on(stage, 'pointerdown', (e) => {
    if (e.target.closest && e.target.closest('.sm-ctl, .sm-attr, .sm-ptr')) return;
    onDown(e);
  });
  on(window, 'pointermove', (e) => {
    if (!ptrs.has(e.pointerId)) return;
    const p = rel(e);
    const prev = ptrs.get(e.pointerId);
    ptrs.set(e.pointerId, p);
    if (pinch && ptrs.size >= 2) {
      const [a, b] = [...ptrs.values()];
      const d = dist(a, b), m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const f = (pinch.s * d / pinch.d) / view.s;
      zoomAt(f, m[0], m[1]);
      view.cx -= (m[0] - pinch.m[0]) / view.s; view.cy -= (m[1] - pinch.m[1]) / view.s;
      pinch.m = m; hideHelp(); request();
      return;
    }
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moved && Math.hypot(p[0] - drag.x, p[1] - drag.y) > 5) {
      drag.moved = true; suppressClick = true; stage.classList.add('sm-drag');
      try { stage.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }
    if (drag.moved) {
      view.cx -= (p[0] - prev[0]) / view.s; view.cy -= (p[1] - prev[1]) / view.s;
      drag.hist.push([p[0], p[1], performance.now()]); if (drag.hist.length > 6) drag.hist.shift();
      hideHelp(); request();
    }
  });
  const up = (e) => {
    if (!ptrs.has(e.pointerId)) return;
    const p = ptrs.get(e.pointerId);
    ptrs.delete(e.pointerId);
    if (pinch) { if (ptrs.size < 2) { pinch = null; const rest = [...ptrs.entries()][0]; if (rest) drag = { x: rest[1][0], y: rest[1][1], moved: true, id: rest[0], hist: [] }; else drag = null; } return; }
    if (!drag || drag.id !== e.pointerId) return;
    stage.classList.remove('sm-drag');
    const d = drag; drag = null;
    if (d.moved) {
      const h = d.hist; const now = performance.now();
      if (h.length >= 2 && now - h[h.length - 1][2] < 60) {
        const a = h[0], b = h[h.length - 1], dt = Math.max(16, b[2] - a[2]);
        inertia = { vx: (b[0] - a[0]) / dt * 16, vy: (b[1] - a[1]) / dt * 16 };
        if (Math.hypot(inertia.vx, inertia.vy) < 2) inertia = null; else request();
      }
      setTimeout(() => { suppressClick = false; }, 0);
      return;
    }
    // tap
    const now = performance.now();
    const onMarker = e.target.closest && e.target.closest('.sm-mk');
    if (lastTap && now - lastTap.t < 320 && dist(lastTap.p, p) < 30 && !onMarker) {
      lastTap = null; zoomAt(2, p[0], p[1], 300); hideHelp();
    } else {
      lastTap = { t: now, p };
      if (!onMarker && e.pointerType !== 'mouse' && active) { active = null; hideTip(); }
    }
  };
  on(window, 'pointerup', up); on(window, 'pointercancel', up);
  on(stage, 'click', (e) => { if (!e.target.closest('.sm-mk, .sm-ptr, .sm-ctl, a') && active && !suppressClick) { active = null; hideTip(); } });
  on(stage, 'dblclick', (e) => { e.preventDefault(); });
  on(stage, 'wheel', (e) => {
    e.preventDefault();
    const p = rel(e);
    let dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
    const f = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0022));
    zoomAt(f, p[0], p[1]); hideHelp();
  }, { passive: false });
  on(stage, 'keydown', (e) => {
    if (e.target !== stage) return;
    const k = e.key, step = 90;
    let h = true;
    if (k === 'ArrowLeft') animateTo(view.cx - step / view.s, view.cy, view.s, 160);
    else if (k === 'ArrowRight') animateTo(view.cx + step / view.s, view.cy, view.s, 160);
    else if (k === 'ArrowUp') animateTo(view.cx, view.cy - step / view.s, view.s, 160);
    else if (k === 'ArrowDown') animateTo(view.cx, view.cy + step / view.s, view.s, 160);
    else if (k === '+' || k === '=') zoomAt(1.6, W / 2, H / 2, 220);
    else if (k === '-' || k === '_') zoomAt(1 / 1.6, W / 2, H / 2, 220);
    else if (k === '0' || k === 'Home') home();
    else if (k === 'Escape') { active = null; hideTip(); }
    else h = false;
    if (h) { e.preventDefault(); hideHelp(); }
  });
  on(bIn, 'click', () => zoomAt(1.8, W / 2, H / 2, 280));
  on(bOut, 'click', () => zoomAt(1 / 1.8, W / 2, H / 2, 280));
  on(bCtr, 'click', () => home());
  helpTimer = setTimeout(hideHelp, 7000);
  cleanups.push(() => clearTimeout(helpTimer));

  // resize
  const ro = new ResizeObserver(() => {
    const w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h || (w === W && h === H)) return;
    W = w; H = h; limits(); lastS = -1; request();
  });
  ro.observe(stage); cleanups.push(() => ro.disconnect());
  // fonts can change label widths
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (!disposed) layoutLabels(true); });

  W = stage.clientWidth || W; H = stage.clientHeight || H; limits();
  view.s = homeScale();
  if (data) { msg.textContent = ''; delete msg.dataset.k; }
  applyLang();
  lastS = -1; frame();

  function api() {
    return {
      setLang(lang2) { L = T[lang2] ? lang2 : 'en'; if (!disposed) applyLang(); },
      highlight(id) {
        const m = mks.find(k => k.l.id === id) || null;
        hl = m;
        if (!m) { active = null; hideTip(); lastLayoutS = -1; request(); return; }
        flyToLandmark(m); lastLayoutS = -1; request();
      },
      dispose() {
        disposed = true;
        if (raf) cancelAnimationFrame(raf);
        clearTimeout(layoutTimer);
        cleanups.forEach(f => { try { f(); } catch (e) { /* ignore */ } });
        root.remove();
      }
    };
  }
  return api();
}
