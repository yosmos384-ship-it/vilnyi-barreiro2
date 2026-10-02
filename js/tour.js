// VILNYI · Barreiro 2 — photoreal 360° tour (Matterport-style) over Blender Cycles equirect panoramas.
//
//   export async function createTour(container, { THREE, manifestUrl, lang, timeOfDay?, onClose, onPackageChange, onTimeOfDayChange })
//     => { open(unitId, packageId, roomId?, { timeOfDay? }?) → Promise<boolean>, setPackage(packageId), setTimeOfDay('day'|'dusk'|'night'),
//          setLang(lang), close(), dispose(), isOpen() }
//   export async function createGallery(container, { manifestUrl, lang, unitId?, packageId?, include?, timeOfDay?, onOpenPano? })
//     => { setLang(lang), setFilter({ unitId, packageId, include }), setTimeOfDay(id), open(index), close(), dispose(), count() }
//
// Manifest additions understood here (all optional):
//   pano.variants  = { dusk: { file, thumb? }, night: { file, thumb? } }   (the base `file`/`thumb` is DAY; same camera, same yawOffset)
//   still.variants = { dusk: { file, thumb? }, night: { file, thumb? } }   (unit stills and `exterior` entries)
//   still.roomId / still.panoId  → lets the gallery match a still to its 360° pano (falls back to matching the names)
//   pano.initialYaw (rad) or pano.lookAt [x,y,z]; pano.links as indices or pano ids; any package id (unknown ones get a chip too).
//
// ── Panorama yaw convention (the ONE thing the renderer and this viewer must agree on) ──────────────
//   World frame = three.js / data.js: x east, y up, z south (towards the street). "World yaw" ψ is the
//   heading of a horizontal view direction  d(ψ) = (−sin ψ, 0, −cos ψ):  ψ = 0 looks along −Z (rear/Tagus),
//   ψ = +π/2 looks along −X (west); +ψ turns LEFT (counter-clockwise seen from above). Camera.rotation.y = ψ.
//   An equirect image column u ∈ [0,1) shows longitude λ = (u − 0.5)·2π to the RIGHT of the image centre
//   (normal panorama: right in the image = clockwise from above). The manifest's `yawOffset` is the world
//   yaw of the image's CENTRE column, i.e. column u looks at ψ = yawOffset − (u − 0.5)·2π.
//   → Blender: a Cycles equirect camera with rotation (X=90°, Y=0, Z=θ) looks at Blender +Y = three −Z
//     when θ = 0, and θ (CCW about Blender +Z) maps 1:1 to ψ — so  yawOffset = θ  (radians).
//   Implementation: inverted sphere (scale −1,1,1) whose texture centre faces −X, rotated by
//     mesh.rotation.y = yawOffset + SPHERE_YAW_BASE.
export const SPHERE_YAW_BASE = -Math.PI / 2;

import { STYLES, FLOORS, BALCONIES, unitById, floorById } from './data.js';

const EYE = 1.6;                // camera height above the floor at every pano (marker floor = pos.y − EYE)
const R_SPHERE = 10;
const FOV_MIN = 35, FOV_MAX = 90, FOV_DEFAULT = 75;
const MOVE_MS = 600, PKG_MS = 450, SHARPEN_MS = 320;
const TURN_STEP = Math.PI / 6;
const TAU = Math.PI * 2;
const TODS = ['day', 'dusk', 'night'];
// requested state → what to show when a pano lacks it (nearest available first; day always exists)
const TOD_FALLBACK = { day: ['day'], dusk: ['dusk', 'night', 'day'], night: ['night', 'dusk', 'day'] };
const normTod = (t) => (TODS.includes(t) ? t : 'day');
function srcFor(item, tod) {
  for (const k of TOD_FALLBACK[tod] || TOD_FALLBACK.day) {
    if (k === 'day') break;
    const v = item.variants && item.variants[k];
    if (v) return { file: v.file, thumb: v.thumb || null, tod: k };
  }
  return { file: item.file, thumb: item.thumb || null, tod: 'day' };
}
const DTAP_MS = 350, DTAP_PX = 30, NUDGE_MS = 400;

// ─────────────────────────────── i18n ───────────────────────────────
const T = {
  en: {
    caption: 'Photoreal 360°', apartment: 'Apartment', close: 'Close', fullscreen: 'Full screen', map: 'Plan', gyro: 'Motion',
    fwd: 'Move forward', back: 'Move back', left: 'Turn left', right: 'Turn right', pkg: 'Finish package',
    hint: 'Drag to look around · double-click the floor to move', hintTouch: 'Drag to look · double-tap the floor to move',
    loading: 'Loading view…', error: 'This view could not be loaded', notRendered: 'Not rendered yet',
    emptyCap: 'Blender Cycles · in production', emptyTitle: 'Photoreal renders are being produced',
    emptyBody: 'The 360° walkthrough of apartment {u} is being path-traced in Blender Cycles — every room, in all three finish packages. It will appear here automatically as soon as it is published.',
    emptyBodyAll: 'Photoreal stills and 360° panoramas are being path-traced in Blender Cycles right now. They will appear here automatically as soon as they are published.',
    gallery: 'Photoreal renders', exterior: 'Exterior', interior: 'Interiors', prev: 'Previous', next: 'Next', of: 'of', view360: '360°',
    light: 'Time of day', day: 'Day', dusk: 'Dusk', night: 'Night', open360: 'Open the 360° view'
  },
  pt: {
    caption: 'Fotorrealista 360°', apartment: 'Apartamento', close: 'Fechar', fullscreen: 'Ecrã inteiro', map: 'Planta', gyro: 'Movimento',
    fwd: 'Avançar', back: 'Recuar', left: 'Rodar à esquerda', right: 'Rodar à direita', pkg: 'Pacote de acabamentos',
    hint: 'Arraste para olhar · duplo clique no chão para avançar', hintTouch: 'Arraste para olhar · toque duplo no chão para avançar',
    loading: 'A carregar…', error: 'Não foi possível carregar esta vista', notRendered: 'Ainda não renderizado',
    emptyCap: 'Blender Cycles · em produção', emptyTitle: 'Os renders fotorrealistas estão a ser produzidos',
    emptyBody: 'A visita 360° do apartamento {u} está a ser calculada em Blender Cycles — todas as divisões, nos três pacotes de acabamentos. Aparecerá aqui automaticamente assim que for publicada.',
    emptyBodyAll: 'As imagens fotorrealistas e os panoramas 360° estão a ser calculados em Blender Cycles. Aparecerão aqui automaticamente assim que forem publicados.',
    gallery: 'Renders fotorrealistas', exterior: 'Exterior', interior: 'Interiores', prev: 'Anterior', next: 'Seguinte', of: 'de', view360: '360°',
    light: 'Hora do dia', day: 'Dia', dusk: 'Entardecer', night: 'Noite', open360: 'Abrir a vista 360°'
  },
  he: {
    caption: 'פוטוריאליסטי 360°', apartment: 'דירה', close: 'סגירה', fullscreen: 'מסך מלא', map: 'תוכנית', gyro: 'תנועה',
    fwd: 'קדימה', back: 'אחורה', left: 'פנייה שמאלה', right: 'פנייה ימינה', pkg: 'חבילת גמר',
    hint: 'גררו כדי להסתכל · לחיצה כפולה על הרצפה כדי להתקדם', hintTouch: 'גררו כדי להסתכל · הקשה כפולה על הרצפה כדי להתקדם',
    loading: 'טוען…', error: 'לא ניתן לטעון את התצוגה', notRendered: 'טרם רונדר',
    emptyCap: 'Blender Cycles · בהפקה', emptyTitle: 'ההדמיות הפוטוריאליסטיות בהפקה',
    emptyBody: 'סיור ה-360° בדירה {u} מרונדר כעת ב-Blender Cycles — כל החדרים, בשלוש חבילות הגמר. הוא יופיע כאן אוטומטית מיד עם פרסומו.',
    emptyBodyAll: 'הדמיות פוטוריאליסטיות ופנורמות 360° מרונדרות כעת ב-Blender Cycles. הן יופיעו כאן אוטומטית מיד עם פרסומן.',
    gallery: 'הדמיות פוטוריאליסטיות', exterior: 'חוץ', interior: 'פנים', prev: 'הקודם', next: 'הבא', of: 'מתוך', view360: '360°',
    light: 'שעת היום', day: 'יום', dusk: 'דמדומים', night: 'לילה', open360: 'פתיחת תצוגת 360°'
  },
  ru: {
    caption: 'Фотореализм 360°', apartment: 'Квартира', close: 'Закрыть', fullscreen: 'Во весь экран', map: 'План', gyro: 'Гироскоп',
    fwd: 'Вперёд', back: 'Назад', left: 'Повернуть влево', right: 'Повернуть вправо', pkg: 'Пакет отделки',
    hint: 'Перетащите, чтобы осмотреться · двойной клик по полу — перейти', hintTouch: 'Проведите, чтобы осмотреться · двойное касание пола — перейти',
    loading: 'Загрузка…', error: 'Не удалось загрузить вид', notRendered: 'Ещё не отрендерено',
    emptyCap: 'Blender Cycles · в работе', emptyTitle: 'Фотореалистичные рендеры готовятся',
    emptyBody: '360°-тур по квартире {u} сейчас рендерится в Blender Cycles — все комнаты, во всех трёх пакетах отделки. Он появится здесь автоматически сразу после публикации.',
    emptyBodyAll: 'Фотореалистичные изображения и 360°-панорамы сейчас рендерятся в Blender Cycles и появятся здесь автоматически.',
    gallery: 'Фотореалистичные рендеры', exterior: 'Экстерьер', interior: 'Интерьеры', prev: 'Назад', next: 'Далее', of: 'из', view360: '360°',
    light: 'Время суток', day: 'День', dusk: 'Сумерки', night: 'Ночь', open360: 'Открыть 360°'
  }
};
const normLang = (l) => { const k = String(l || (typeof document !== 'undefined' && document.documentElement.lang) || 'en').slice(0, 2).toLowerCase(); return T[k] ? k : 'en'; };
const pick = (obj, lang) => { if (obj == null) return ''; if (typeof obj === 'string') return obj; return obj[lang] || obj.en || obj.pt || Object.values(obj)[0] || ''; };

// ─────────────────────────────── icons ───────────────────────────────
const ICON = {
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  fs: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  fsx: '<svg viewBox="0 0 24 24"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>',
  plan: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="1"/><path d="M10 4.5v7h10.5M10 15v4.5"/></svg>',
  gyro: '<svg viewBox="0 0 24 24"><rect x="7.5" y="3.5" width="9" height="17" rx="2"/><path d="M3 9.5c-1 1.6-1 3.4 0 5M21 9.5c1 1.6 1 3.4 0 5"/></svg>',
  aup: '<svg viewBox="0 0 24 24"><path d="M12 19.5V5M6 11l6-6 6 6"/></svg>',
  adown: '<svg viewBox="0 0 24 24"><path d="M12 4.5V19M6 13l6 6 6-6"/></svg>',
  tleft: '<svg viewBox="0 0 24 24"><path d="M5.2 10A7.5 7.5 0 1 1 7 17.3"/><path d="M4.5 4.5v5.8h5.8"/></svg>',
  tright: '<svg viewBox="0 0 24 24"><path d="M18.8 10A7.5 7.5 0 1 0 17 17.3"/><path d="M19.5 4.5v5.8h-5.8"/></svg>',
  chev: '<svg viewBox="0 0 24 24"><path d="M7 14l5-5 5 5"/></svg>',
  aperture: '<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="27"/><path d="M32 5l9 24M59 32l-24 9M32 59l-9-24M5 32l24-9M51.1 12.9L38 35M51.1 51.1L29 38M12.9 51.1L26 29M12.9 12.9L35 26"/></svg>',
  prev: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>',
  day: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6"/></svg>',
  dusk: '<svg viewBox="0 0 24 24"><path d="M7.5 16a4.5 4.5 0 0 1 9 0"/><path d="M3 16h18M6.5 19.5h11M12 6v2.4M4.9 9.6l1.7 1.6M19.1 9.6l-1.7 1.6"/></svg>',
  night: '<svg viewBox="0 0 24 24"><path d="M19.5 14.2A8 8 0 0 1 9.8 4.5a8 8 0 1 0 9.7 9.7z"/></svg>',
  pano: '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="12" rx="9" ry="4"/><path d="M12 3v2M12 19v2"/></svg>'
};

// ─────────────────────────────── CSS ───────────────────────────────
const CSS = `
.tr-root{position:absolute;inset:0;z-index:60;overflow:hidden;overscroll-behavior:contain;background:#0c0b0a;color:#f3efe8;font-family:var(--f-body,'Jost','Avenir Next','Segoe UI',system-ui,sans-serif);line-height:1.25;
 -webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;touch-action:none;
 --tr-glass:rgba(17,16,15,.56);--tr-glass-hi:rgba(30,28,26,.72);--tr-line:rgba(255,255,255,.15);--tr-line-hi:rgba(255,255,255,.34);--tr-accent:#cdb07a;--tr-in:14px;--tr-b:44px;
 --tr-top:calc(env(safe-area-inset-top,0px) + var(--tr-in));--tr-bot:calc(env(safe-area-inset-bottom,0px) + var(--tr-in))}
.tr-root.tr-fixed{position:fixed}
.tr-root[hidden]{display:none!important}
.tr-root *{box-sizing:border-box}
.tr-stage{position:absolute;inset:0;cursor:grab;touch-action:none;outline:none}
.tr-stage.tr-drag{cursor:grabbing}
.tr-stage canvas{display:block;width:100%;height:100%}
.tr-shade{position:absolute;inset:0;pointer-events:none;background:linear-gradient(180deg,rgba(0,0,0,.42),rgba(0,0,0,0) 22%,rgba(0,0,0,0) 74%,rgba(0,0,0,.38))}
.tr-glass{background:var(--tr-glass);-webkit-backdrop-filter:blur(16px) saturate(140%);backdrop-filter:blur(16px) saturate(140%);border:1px solid var(--tr-line);box-shadow:0 10px 34px rgba(0,0,0,.24)}
.tr-cap{font-size:10px;letter-spacing:.2em;text-transform:uppercase;font-weight:500;opacity:.7}
.tr-btn{appearance:none;-webkit-appearance:none;margin:0;padding:0;font:inherit;color:inherit;width:40px;height:40px;border-radius:12px;display:inline-grid;place-items:center;cursor:pointer;outline:none;flex:none;
 background:var(--tr-glass);-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);border:1px solid var(--tr-line);transition:background .18s,border-color .18s,color .18s,opacity .18s}
.tr-btn:hover{background:var(--tr-glass-hi);border-color:var(--tr-line-hi)}
.tr-btn:focus-visible{border-color:var(--tr-accent)}
.tr-btn[aria-pressed=true]{color:var(--tr-accent);border-color:rgba(205,176,122,.6)}
.tr-btn:active,.tr-btn.tr-down{background:rgba(205,176,122,.24);border-color:var(--tr-accent)}
.tr-btn[hidden]{display:none}
.tr-btn svg{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round}
/* top bar */
.tr-top{position:absolute;inset-block-start:var(--tr-top);inset-inline:var(--tr-in);display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"title act" "pk pk";gap:10px;align-items:start;pointer-events:none;z-index:3}
.tr-title{grid-area:title;pointer-events:auto;border-radius:14px;padding:9px 15px 10px;min-width:0;max-width:440px;justify-self:start}
.tr-room{font-family:var(--f-display,'Cormorant','Cormorant Garamond',Georgia,serif);font-size:21px;font-weight:500;letter-spacing:.005em;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tr-title .tr-cap b{color:var(--tr-accent);font-weight:500;unicode-bidi:isolate}
.tr-title .tr-cap{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tr-act{grid-area:act;display:flex;gap:8px;pointer-events:auto}
.tr-pk{grid-area:pk;pointer-events:auto;border-radius:14px;padding:3px;justify-self:start;min-width:0;max-width:100%;position:relative;overflow:hidden}
.tr-pks{position:relative;display:flex;gap:2px;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;-webkit-overflow-scrolling:touch;touch-action:pan-x;overscroll-behavior:contain;scroll-behavior:smooth;border-radius:11px}
.tr-pks::-webkit-scrollbar{display:none}
.tr-pk:before,.tr-pk:after{content:"";position:absolute;top:3px;bottom:3px;width:30px;pointer-events:none;opacity:0;transition:opacity .2s;z-index:1}
.tr-pk:before{left:3px;background:linear-gradient(90deg,rgba(17,16,15,.92),rgba(17,16,15,0));border-radius:11px 0 0 11px}
.tr-pk:after{right:3px;background:linear-gradient(270deg,rgba(17,16,15,.92),rgba(17,16,15,0));border-radius:0 11px 11px 0}
.tr-pk.tr-ml:before,.tr-pk.tr-mr:after{opacity:1}
.tr-pkb{flex:0 0 auto;appearance:none;border:0;margin:0;font:inherit;color:rgba(243,239,232,.74);background:transparent;border-radius:11px;padding:9px 13px 10px;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:3px;min-width:0;transition:background .2s,color .2s;outline:none}
.tr-tod{display:flex;align-items:center;gap:2px;padding:3px;border-radius:12px;height:40px;flex:none}
.tr-tod[hidden]{display:none}
.tr-todb{appearance:none;border:0;margin:0;padding:0;font:inherit;width:32px;height:32px;border-radius:9px;display:grid;place-items:center;cursor:pointer;background:transparent;color:rgba(243,239,232,.66);outline:none;transition:background .2s,color .2s}
.tr-todb svg{width:17px;height:17px;stroke:currentColor;fill:none;stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round}
.tr-todb:hover{color:#fff;background:rgba(255,255,255,.07)}
.tr-todb:focus-visible{box-shadow:0 0 0 1px var(--tr-accent) inset}
.tr-todb[aria-pressed=true]{background:rgba(205,176,122,.2);color:var(--tr-accent);box-shadow:0 0 0 1px rgba(205,176,122,.55) inset}
.tr-todb[disabled]{opacity:.3;cursor:not-allowed}
.tr-pkb:hover{color:#fff;background:rgba(255,255,255,.06)}
.tr-pkb:focus-visible{box-shadow:0 0 0 1px var(--tr-accent) inset}
.tr-pkb[aria-pressed=true]{background:rgba(205,176,122,.17);color:#fff;box-shadow:0 0 0 1px rgba(205,176,122,.55) inset}
.tr-pkb[disabled]{opacity:.35;cursor:not-allowed}
.tr-pkt{display:flex;align-items:center;gap:7px;font-size:10.5px;letter-spacing:.18em;text-transform:uppercase;font-weight:500;white-space:nowrap}
.tr-pkd{width:9px;height:9px;border-radius:50%;box-shadow:0 0 0 1px rgba(255,255,255,.35);flex:none}
.tr-pkn{font-size:11.5px;opacity:.62;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;display:none}
.tr-bar{position:absolute;inset-block-start:0;inset-inline:0;height:2px;overflow:hidden;opacity:0;transition:opacity .3s;z-index:4;pointer-events:none}
.tr-bar.tr-on{opacity:1}
.tr-bar:after{content:"";position:absolute;inset-block:0;width:34%;background:linear-gradient(90deg,transparent,var(--tr-accent),transparent);animation:tr-slide 1.3s ease-in-out infinite}
@keyframes tr-slide{from{left:-34%}to{left:100%}}
/* hotspots */
.tr-hsl{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.tr-hs{position:absolute;left:0;top:0;pointer-events:auto;appearance:none;margin:0;font:inherit;color:#fff;display:inline-flex;align-items:center;gap:7px;padding:5px 12px 5px 5px;border-radius:999px;cursor:pointer;white-space:nowrap;font-size:12.5px;letter-spacing:.02em;outline:none;
 background:rgba(17,16,15,.5);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);border:1px solid var(--tr-line);transition:opacity .25s,background .2s,border-color .2s;will-change:transform}
.tr-hs i{width:22px;height:22px;border-radius:50%;display:grid;place-items:center;background:rgba(255,255,255,.12);flex:none}
.tr-hs i svg{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.tr-hs:hover,.tr-hs:focus-visible,.tr-hs.tr-hot{background:rgba(30,28,26,.74);border-color:rgba(205,176,122,.7)}
.tr-hs.tr-fwd i{background:var(--tr-accent);color:#17130c}
.tr-hs[hidden]{display:none}
/* pad */
.tr-pad{position:absolute;inset-block-end:var(--tr-bot);inset-inline-start:var(--tr-in);display:grid;grid-template-columns:repeat(3,var(--tr-b));grid-template-rows:repeat(3,var(--tr-b));gap:5px;direction:ltr;z-index:3}
.tr-pad .tr-btn{width:var(--tr-b);height:var(--tr-b)}
.tr-pad .tr-btn svg{width:20px;height:20px;stroke-width:1.5}
.tr-pad .tr-f{grid-column:2;grid-row:1}.tr-pad .tr-l{grid-column:1;grid-row:2}.tr-pad .tr-r{grid-column:3;grid-row:2}.tr-pad .tr-b{grid-column:2;grid-row:3}
.tr-hub{grid-column:2;grid-row:2;align-self:center;justify-self:center;width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.3)}
.tr-btn.tr-off{opacity:.38}
/* map */
.tr-map{position:absolute;inset-block-end:var(--tr-bot);inset-inline-end:var(--tr-in);border-radius:14px;padding:9px 10px 8px;z-index:3;display:none;flex-direction:column;gap:6px;max-width:44vw}
.tr-map.tr-open{display:flex;animation:tr-in .28s ease-out}
.tr-map svg{display:block;width:var(--tr-mapw,150px);height:auto;max-height:34vh;overflow:visible}
.tr-map .tr-mroom{fill:rgba(255,255,255,.05);stroke:rgba(255,255,255,.42);stroke-width:1;vector-effect:non-scaling-stroke}
.tr-map .tr-mroom.tr-cur{fill:rgba(205,176,122,.14)}
.tr-map .tr-mbal{fill:none;stroke:rgba(255,255,255,.28);stroke-dasharray:2 2;stroke-width:1;vector-effect:non-scaling-stroke}
.tr-map .tr-mdot{fill:#f3efe8;stroke:rgba(0,0,0,.4);stroke-width:1;vector-effect:non-scaling-stroke;cursor:pointer;transition:fill .2s}
.tr-map .tr-mdot:hover{fill:var(--tr-accent)}
.tr-map .tr-mdot.tr-cur{fill:var(--tr-accent);stroke:#fff}
.tr-map .tr-mhit{fill:transparent;cursor:pointer}
.tr-map .tr-cone{fill:url(#tr-cone-g);pointer-events:none}
/* hint, busy, toast */
.tr-hint{position:absolute;left:50%;inset-block-end:calc(var(--tr-bot) + 4px);transform:translateX(-50%);padding:8px 16px;border-radius:999px;font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;white-space:nowrap;opacity:0;transition:opacity .8s;pointer-events:none;z-index:2}
.tr-hint.tr-on{opacity:.92}
.tr-busy{position:absolute;left:50%;top:50%;width:38px;height:38px;margin:-19px 0 0 -19px;border-radius:50%;border:1.5px solid rgba(255,255,255,.18);border-top-color:var(--tr-accent);animation:tr-spin .9s linear infinite;opacity:0;transition:opacity .25s;pointer-events:none;z-index:2}
.tr-busy.tr-on{opacity:1}
@keyframes tr-spin{to{transform:rotate(360deg)}}
@keyframes tr-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.tr-toast{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);padding:10px 18px;border-radius:12px;font-size:13px;opacity:0;transition:opacity .3s;pointer-events:none;z-index:4;text-align:center}
.tr-toast.tr-on{opacity:1}
/* empty state */
.tr-empty{position:absolute;inset:0;display:none;place-items:center;padding:calc(var(--tr-top) + 60px) 24px calc(var(--tr-bot) + 24px);z-index:2;
 background:radial-gradient(120% 80% at 50% 0%,#2a2520 0%,#141210 55%,#0c0b0a 100%)}
.tr-empty:before{content:"";position:absolute;inset:-40%;background:conic-gradient(from 0deg,transparent 0 70%,rgba(205,176,122,.07) 80%,transparent 90%);animation:tr-spin 14s linear infinite;pointer-events:none}
.tr-empty.tr-on{display:grid}
.tr-ecard{position:relative;max-width:440px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:14px;animation:tr-in .5s ease-out}
.tr-ecard svg{width:58px;height:58px;stroke:var(--tr-accent);fill:none;stroke-width:1.1;animation:tr-spin 24s linear infinite;opacity:.9}
.tr-etitle{font-family:var(--f-display,'Cormorant','Cormorant Garamond',Georgia,serif);font-size:clamp(26px,6.4vw,34px);font-weight:500;line-height:1.08;letter-spacing:.005em}
.tr-ebody{font-size:14px;line-height:1.6;color:rgba(243,239,232,.72);max-width:38ch}
.tr-ebtn{margin-top:8px;appearance:none;font:inherit;color:#f3efe8;background:transparent;border:1px solid rgba(205,176,122,.6);border-radius:999px;padding:11px 26px;font-size:11px;letter-spacing:.2em;text-transform:uppercase;cursor:pointer;pointer-events:auto}
.tr-ebtn:hover{background:rgba(205,176,122,.14)}
.tr-root.tr-isempty .tr-pk,.tr-root.tr-isempty .tr-pad,.tr-root.tr-isempty .tr-map,.tr-root.tr-isempty .tr-hint,.tr-root.tr-isempty [data-k=map],.tr-root.tr-isempty [data-k=gyro],.tr-root.tr-isempty .tr-shade{display:none!important}
@media (min-width:760px){
 .tr-root{--tr-in:20px}
 .tr-top{grid-template-columns:auto minmax(0,1fr) auto;grid-template-areas:"title pk act"}
 .tr-act{justify-self:end}
 .tr-pk{justify-self:center}
 .tr-pkb{padding:8px 14px 9px}
 .tr-map{--tr-mapw:190px}
}
@media (min-width:1100px){ .tr-pkn{display:block} }
@media (max-width:759px){
 .tr-capx{display:none} .tr-room{font-size:19px}
 .tr-hint{inset-block-end:calc(var(--tr-bot) + 214px);max-width:calc(100% - 28px);white-space:normal;text-align:center;border-radius:14px;line-height:1.5}
 .tr-tod{position:absolute;inset-block-start:calc(100% + 10px);inset-inline-end:0;flex-direction:column;height:auto;width:40px;border-radius:13px}
 .tr-todb{width:32px;height:34px}
}
@media (prefers-reduced-motion:reduce){ .tr-empty:before,.tr-ecard svg{animation:none} }
[dir=rtl] .tr-hs{padding:5px 5px 5px 12px}

/* ── gallery ── */
.tr-gal{font-family:var(--f-body,'Jost',system-ui,sans-serif);color:var(--ink,#1b1a17)}
.tr-gsec+.tr-gsec{margin-top:26px}
.tr-gh{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:0 0 12px;padding-bottom:8px;border-bottom:1px solid var(--line,#d6cfc3)}
.tr-gh h3{margin:0;font-family:var(--f-display,'Cormorant',Georgia,serif);font-weight:500;font-size:22px;letter-spacing:.005em}
.tr-gh span{font-size:10.5px;letter-spacing:.18em;text-transform:uppercase;color:var(--ink-3,#857d71)}
.tr-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(220px,44vw),1fr));gap:10px}
.tr-gi{position:relative;appearance:none;border:0;padding:0;margin:0;background:var(--paper-2,#e9e4da);border-radius:var(--r,2px);overflow:hidden;cursor:zoom-in;aspect-ratio:16/10;display:block;width:100%;outline:none}
.tr-gi img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transition:transform .6s cubic-bezier(.2,.7,.2,1),opacity .4s;opacity:0}
.tr-gi img.tr-ld{opacity:1}
.tr-gi:hover img{transform:scale(1.035)}
.tr-gi:focus-visible{box-shadow:0 0 0 2px var(--accent,#8a5a1c)}
.tr-gi figcaption{position:absolute;inset-inline:0;inset-block-end:0;padding:22px 12px 9px;color:#fff;font-size:12.5px;letter-spacing:.02em;text-align:start;background:linear-gradient(0deg,rgba(0,0,0,.6),transparent)}
.tr-g360{position:absolute;inset-block-start:8px;inset-inline-end:8px;display:inline-flex;align-items:center;gap:5px;padding:4px 8px 4px 6px;border-radius:999px;background:rgba(17,16,15,.6);color:#fff;font-size:10px;letter-spacing:.14em;-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.2)}
.tr-g360 svg{width:13px;height:13px;stroke:currentColor;fill:none;stroke-width:1.5}
.tr-gtools{display:flex;justify-content:flex-end;margin-bottom:12px}
.tr-gtools .tr-tod{background:var(--card,#fbfaf7);border:1px solid var(--line,#d6cfc3);position:static;flex-direction:row;height:40px;width:auto}
.tr-gtools .tr-todb{color:var(--ink-2,#5b544a);width:32px;height:32px}
.tr-gtools .tr-todb:hover{color:var(--ink,#1b1a17);background:rgba(0,0,0,.05)}
.tr-gtools .tr-todb[aria-pressed=true]{color:var(--accent,#8a5a1c);background:var(--bronze-soft,rgba(138,90,28,.12));box-shadow:0 0 0 1px var(--accent,#8a5a1c) inset}
.tr-lbz{grid-area:1/1;display:grid;grid-template:minmax(0,1fr)/minmax(0,1fr);transform-origin:0 0;will-change:transform;min-width:0;min-height:0}
.tr-lbbar .tr-lbr{display:flex;gap:8px;align-items:center}
.tr-lb .tr-tod{position:static;flex-direction:row;height:40px;width:auto;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.15)}
.tr-lb .tr-todb{width:32px;height:32px}
.tr-lb360[hidden]{display:none}
.tr-lb360{width:auto;padding:0 12px 0 10px;gap:7px;display:inline-flex;align-items:center;font-size:10px;letter-spacing:.16em}
.tr-gempty{padding:34px 20px;text-align:center;border:1px solid var(--line,#d6cfc3);border-radius:var(--r,2px);display:flex;flex-direction:column;align-items:center;gap:10px}
.tr-gempty svg{width:40px;height:40px;stroke:var(--accent,#8a5a1c);fill:none;stroke-width:1.2;animation:tr-spin 24s linear infinite}
.tr-gempty b{font-family:var(--f-display,'Cormorant',Georgia,serif);font-size:22px;font-weight:500}
.tr-gempty p{margin:0;font-size:14px;line-height:1.55;color:var(--ink-2,#5b544a);max-width:44ch}
.tr-lb{position:fixed;inset:0;z-index:1000;background:#0b0a09;color:#f3efe8;display:none;touch-action:none;-webkit-user-select:none;user-select:none;font-family:var(--f-body,'Jost',system-ui,sans-serif)}
.tr-lb.tr-on{display:block;animation:tr-in .25s ease-out}
.tr-lbtrack{position:absolute;inset:0;display:flex;will-change:transform;direction:ltr}
.tr-lbs{flex:0 0 100%;height:100%;position:relative;overflow:hidden;display:grid;grid-template:minmax(0,1fr)/minmax(0,1fr);padding:calc(env(safe-area-inset-top,0px) + 64px) 12px calc(env(safe-area-inset-bottom,0px) + 70px)}
.tr-lbs img{width:100%;height:100%;object-fit:contain;grid-area:1/1;transition:opacity .4s}
.tr-lbs img.tr-th{filter:blur(8px);transform:scale(1.002)}
.tr-lbs img.tr-full{opacity:0}
.tr-lbs img.tr-full.tr-ld{opacity:1}
.tr-lbbar{position:absolute;inset-block-start:calc(env(safe-area-inset-top,0px) + 14px);inset-inline:14px;display:flex;align-items:center;justify-content:space-between;gap:12px;z-index:2}
.tr-lbcap{position:absolute;inset-block-end:calc(env(safe-area-inset-bottom,0px) + 20px);inset-inline:70px;text-align:center;font-size:13px;letter-spacing:.03em;z-index:2}
.tr-lbcap .tr-cap{display:block;margin-bottom:4px}
.tr-lbnav{position:absolute;top:50%;transform:translateY(-50%);z-index:2}
.tr-lbnav.tr-p{inset-inline-start:14px}.tr-lbnav.tr-n{inset-inline-end:14px}
[dir=rtl] .tr-lbnav svg{transform:scaleX(-1)}
@media (max-width:640px){ .tr-lbnav{display:none} }
`;
function injectCSS() {
  if (typeof document === 'undefined' || document.getElementById('tr-style')) return;
  const s = document.createElement('style');
  s.id = 'tr-style';
  s.textContent = CSS;
  document.head.appendChild(s);
}
function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const wrapPI = (a) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };
const easeInOut = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ─────────────────────────────── manifest ───────────────────────────────
const manifestCache = new Map(); // href -> { t, p }
function defaultManifestUrl() { return new URL('../renders/manifest.json', import.meta.url); }
function loadManifest(url, force) {
  let href = String(url || defaultManifestUrl());
  try { href = new URL(href, typeof location !== 'undefined' ? location.href : undefined).href; } catch (e) { /* keep */ }
  const c = manifestCache.get(href);
  // successful loads are kept for 60 s, failures retried after 15 s (renders keep arriving while the site is open)
  if (c && !force && Date.now() - c.t < (c.ok ? 60000 : 15000)) return c.p;
  const rec = { t: Date.now(), ok: false, p: null };
  rec.p = fetch(href, { cache: 'no-cache' })
    .then(r => { if (!r.ok) throw new Error('manifest ' + r.status); return r.json(); })
    .then(j => { const m = normalizeManifest(j, href); rec.ok = !!m; return m; })
    .catch(() => null);
  manifestCache.set(href, rec);
  return rec.p;
}
function normalizeManifest(j, base) {
  if (!j || typeof j !== 'object') return null;
  const abs = (f) => { if (!f || typeof f !== 'string') return null; try { return new URL(f, base).href; } catch (e) { return null; } };
  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
  const vnorm = (v, thumbFallback) => {
    const o = {};
    if (v && typeof v === 'object') for (const k of ['dusk', 'night']) {
      const e = v[k];
      const f = abs(typeof e === 'string' ? e : e && e.file);
      if (f) o[k] = { file: f, thumb: abs(e && e.thumb) || (thumbFallback ? f : null) };
    }
    return o;
  };
  const units = {};
  const src = j.units && typeof j.units === 'object' ? j.units : {};
  for (const uid of Object.keys(src)) {
    const pk = src[uid];
    if (!pk || typeof pk !== 'object') continue;
    for (const pid of Object.keys(pk)) {
      const e = pk[pid] || {};
      const rawP = Array.isArray(e.panos) ? e.panos : [];
      const panos = [];
      const remap = new Map();
      rawP.forEach((p, i) => {
        if (!p || !abs(p.file)) return;
        const pos = Array.isArray(p.position) && p.position.length >= 3 && p.position.every(n => typeof n === 'number' && isFinite(n)) ? p.position.slice(0, 3) : null;
        remap.set(i, panos.length);
        panos.push({
          id: String(p.id != null ? p.id : uid + '-' + i), roomId: p.roomId || null, name: p.name || null,
          file: abs(p.file), thumb: abs(p.thumb), variants: vnorm(p.variants, false), pos: pos || [0, EYE, 0], hasPos: !!pos,
          yawOffset: num(p.yawOffset, 0), initialYaw: typeof p.initialYaw === 'number' ? p.initialYaw : null,
          lookAt: Array.isArray(p.lookAt) && p.lookAt.length >= 3 ? p.lookAt : null,
          rawLinks: Array.isArray(p.links) ? p.links : null
        });
      });
      panos.forEach((p, i) => {
        let links = [];
        if (p.rawLinks) {
          for (const l of p.rawLinks) {
            let k = typeof l === 'number' ? remap.get(l) : panos.findIndex(q => q.id === String(l));
            if (k != null && k >= 0 && k !== i && !links.includes(k)) links.push(k);
          }
        } else {
          // no links given: connect to the nearest panos within 7 m
          links = panos.map((q, k) => [k, Math.hypot(q.pos[0] - p.pos[0], q.pos[2] - p.pos[2])]).filter(([k, d]) => k !== i && d < 7).sort((a, b) => a[1] - b[1]).slice(0, 6).map(a => a[0]);
        }
        p.links = links;
        delete p.rawLinks;
      });
      const stills = (Array.isArray(e.stills) ? e.stills : []).filter(s => s && abs(s.file)).map(s => ({ file: abs(s.file), thumb: abs(s.thumb) || abs(s.file), name: s.name || null, variants: vnorm(s.variants, true), roomId: s.roomId || null, panoId: s.panoId != null ? String(s.panoId) : null }));
      if (!panos.length && !stills.length) continue;
      (units[uid] = units[uid] || {})[pid] = { panos, stills };
    }
  }
  const exterior = (Array.isArray(j.exterior) ? j.exterior : []).filter(s => s && abs(s.file)).map((s, i) => ({ id: s.id || 'ext' + i, file: abs(s.file), thumb: abs(s.thumb) || abs(s.file), name: s.name || null, pano: !!s.pano, variants: vnorm(s.variants, true) }));
  if (!Object.keys(units).length && !exterior.length) return null;
  return { units, exterior };
}

// ─────────────────────────────── geometry helpers (data.js) ───────────────────────────────
const ROOM_BY_ID = new Map();
for (const f of FLOORS) for (const r of f.rooms) ROOM_BY_ID.set(r.id, { ...r, floor: f.id, y: f.level.y });
function rayPolyDist(px, pz, dx, dz, poly) {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, az] = poly[i], [bx, bz] = poly[(i + 1) % poly.length];
    const ex = bx - ax, ez = bz - az;
    const den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((ax - px) * ez - (az - pz) * ex) / den;
    const s = ((ax - px) * dz - (az - pz) * dx) / den;
    if (t > 1e-3 && s >= 0 && s <= 1 && t < best) best = t;
  }
  return best;
}
const yawOf = (dx, dz) => Math.atan2(-dx, -dz);

// ─────────────────────────────── image / texture loading ───────────────────────────────
function loadImage(url, priority) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.decoding = 'async';
    try { img.fetchPriority = priority || 'auto'; } catch (e) { /* old browsers */ }
    img.onload = () => { const d = img.decode ? img.decode().catch(() => {}) : Promise.resolve(); d.then(() => res(img)); };
    img.onerror = () => rej(new Error('image ' + url));
    img.src = url;
  });
}

class TexLRU {
  constructor(max, make, inUse) { this.max = max; this.make = make; this.inUse = inUse; this.map = new Map(); this.inflight = new Map(); }
  peek(url) { const t = this.map.get(url); if (t) { this.map.delete(url); this.map.set(url, t); } return t || null; }
  load(url, priority) {
    const hit = this.peek(url);
    if (hit) return Promise.resolve(hit);
    if (this.inflight.has(url)) return this.inflight.get(url);
    const p = loadImage(url, priority).then(img => {
      this.inflight.delete(url);
      if (this.dead) throw new Error('disposed');
      const tex = this.make(img);
      this.map.set(url, tex);
      this.evict();
      return tex;
    }, e => { this.inflight.delete(url); throw e; });
    this.inflight.set(url, p);
    return p;
  }
  evict() {
    while (this.map.size > this.max) {
      let victim = null;
      for (const [k, t] of this.map) if (!this.inUse(t)) { victim = k; break; }
      if (!victim) break;
      const t = this.map.get(victim);
      this.map.delete(victim);
      try { t.dispose(); } catch (e) { /* */ }
    }
  }
  clear() { for (const t of this.map.values()) { try { t.dispose(); } catch (e) { /* */ } } this.map.clear(); }
}

// ═══════════════════════════════════ TOUR ═══════════════════════════════════
export async function createTour(container, { THREE, manifestUrl = defaultManifestUrl(), lang, timeOfDay, onClose, onPackageChange, onTimeOfDayChange } = {}) {
  if (!THREE) throw new Error('createTour: THREE is required');
  injectCSS();
  let L = normLang(lang);
  const tr = (k) => (T[L] && T[L][k]) || T.en[k] || k;
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── DOM ──
  const root = el('div', 'tr-root');
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  const cs = container === document.body ? 'static' : getComputedStyle(container).position;
  if (container === document.body || cs === 'static') root.classList.add('tr-fixed');
  const stage = el('div', 'tr-stage');
  stage.tabIndex = -1;
  const shade = el('div', 'tr-shade');
  const hsLayer = el('div', 'tr-hsl');
  const bar = el('div', 'tr-bar');
  const busy = el('div', 'tr-busy');
  const toast = el('div', 'tr-toast tr-glass');
  const hint = el('div', 'tr-hint tr-glass');
  // top bar
  const top = el('div', 'tr-top');
  const titleBox = el('div', 'tr-title tr-glass');
  const capEl = el('div', 'tr-cap');
  const roomEl = el('div', 'tr-room');
  roomEl.dir = 'auto';
  titleBox.append(capEl, roomEl);
  const pkBox = el('div', 'tr-pk tr-glass');
  pkBox.setAttribute('role', 'group');
  const pkScroll = el('div', 'tr-pks');
  pkBox.append(pkScroll);
  const pkBtns = new Map();
  function addPkBtn(id, colour) {
    const b = el('button', 'tr-pkb');
    b.type = 'button';
    b.dataset.pk = id;
    b.innerHTML = `<span class="tr-pkt"><span class="tr-pkd"></span><span class="tr-pkl"></span></span><span class="tr-pkn"></span>`;
    b.querySelector('.tr-pkd').style.background = colour || '#b9b0a2';
    b.addEventListener('click', () => { if (!b.disabled) userSetPackage(id); });
    pkBtns.set(id, b);
    pkScroll.append(b);
    return b;
  }
  for (const s of STYLES) addPkBtn(s.id, s.palette && s.palette.floor);
  function updatePkFades() {
    const c = pkScroll.getBoundingClientRect();
    const f = pkScroll.firstElementChild, l = pkScroll.lastElementChild;
    if (!f || !c.width) return;
    let lo = Infinity, hi = -Infinity;
    for (const e of [f, l]) { const r = e.getBoundingClientRect(); lo = Math.min(lo, r.left); hi = Math.max(hi, r.right); }
    pkBox.classList.toggle('tr-ml', lo < c.left - 3);
    pkBox.classList.toggle('tr-mr', hi > c.right + 3);
  }
  pkScroll.addEventListener('scroll', updatePkFades, { passive: true });
  pkScroll.addEventListener('wheel', (e) => { if (pkScroll.scrollWidth > pkScroll.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)) { e.preventDefault(); pkScroll.scrollBy({ left: e.deltaY, behavior: 'auto' }); } }, { passive: false });
  function revealPk(id, instant) {
    const b = pkBtns.get(id);
    if (!b || !pkScroll.clientWidth) return;
    const c = pkScroll.getBoundingClientRect(), r = b.getBoundingClientRect();
    const delta = (r.left + r.width / 2) - (c.left + c.width / 2);
    try { pkScroll.scrollBy({ left: delta, behavior: instant ? 'auto' : 'smooth' }); } catch (e) { pkScroll.scrollLeft += delta; }
    setTimeout(updatePkFades, instant ? 0 : 350);
  }
  // light switch: day / dusk / night
  const todBox = el('div', 'tr-tod tr-glass');
  todBox.setAttribute('role', 'group');
  const todBtns = new Map();
  for (const id of TODS) {
    const b = el('button', 'tr-todb', ICON[id]);
    b.type = 'button';
    b.dataset.tod = id;
    b.addEventListener('click', (e) => { e.stopPropagation(); if (!b.disabled) userSetTod(id); });
    todBtns.set(id, b);
    todBox.append(b);
  }
  const act = el('div', 'tr-act');
  const mkBtn = (k, icon) => { const b = el('button', 'tr-btn', ICON[icon]); b.type = 'button'; b.dataset.k = k; return b; };
  const mapBtn = mkBtn('map', 'plan');
  const gyroBtn = mkBtn('gyro', 'gyro');
  const fsBtn = mkBtn('fs', 'fs');
  const closeBtn = mkBtn('close', 'close');
  const canGyro = coarse && typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;
  gyroBtn.hidden = !canGyro;
  const fsTarget = () => root;
  const canFS = !!(root.requestFullscreen || root.webkitRequestFullscreen);
  fsBtn.hidden = !canFS;
  mapBtn.setAttribute('aria-pressed', 'false');
  gyroBtn.setAttribute('aria-pressed', 'false');
  act.append(todBox, mapBtn, gyroBtn, fsBtn, closeBtn);
  top.append(titleBox, pkBox, act);
  // pad
  const pad = el('div', 'tr-pad');
  const padF = mkBtn('fwd', 'aup'); padF.classList.add('tr-f');
  const padB = mkBtn('back', 'adown'); padB.classList.add('tr-b');
  const padL = mkBtn('left', 'tleft'); padL.classList.add('tr-l');
  const padR = mkBtn('right', 'tright'); padR.classList.add('tr-r');
  pad.append(padF, padL, el('span', 'tr-hub'), padR, padB);
  // map
  const mapBox = el('div', 'tr-map tr-glass');
  const mapCap = el('div', 'tr-cap');
  const SVGNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(SVGNS, 'svg');
  mapBox.append(mapCap, svg);
  // empty state
  const empty = el('div', 'tr-empty');
  const ecard = el('div', 'tr-ecard');
  const eCap = el('div', 'tr-cap'), eTitle = el('div', 'tr-etitle'), eBody = el('div', 'tr-ebody'), eBtn = el('button', 'tr-ebtn');
  eBtn.type = 'button';
  ecard.append(el('div', null, ICON.aperture), eCap, eTitle, eBody, eBtn);
  empty.append(ecard);
  stage.append(hsLayer);
  root.append(stage, shade, empty, busy, toast, hint, bar, top, pad, mapBox);
  container.appendChild(root);

  // ── three ──
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  } catch (e) {
    renderer = null;
  }
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV_DEFAULT, 1, 0.05, 200);
  camera.rotation.order = 'YXZ';
  if (renderer) {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setClearColor(0x0c0b0a, 1);
    stage.prepend(renderer.domElement);
  }
  const maxAniso = renderer ? renderer.capabilities.getMaxAnisotropy() : 1;
  const maxTex = renderer ? renderer.capabilities.maxTextureSize : 4096;
  const blank = new THREE.DataTexture(new Uint8Array([12, 11, 10, 255]), 1, 1);
  blank.colorSpace = THREE.SRGBColorSpace;
  blank.needsUpdate = true;
  const sphereGeo = new THREE.SphereGeometry(R_SPHERE, 64, 32);
  sphereGeo.scale(-1, 1, 1);
  const mkSphere = () => {
    const m = new THREE.Mesh(sphereGeo, new THREE.MeshBasicMaterial({ map: blank, transparent: true, opacity: 1, depthTest: false, depthWrite: false, toneMapped: false }));
    m.visible = false;
    m.frustumCulled = false;
    scene.add(m);
    return m;
  };
  const spheres = [mkSphere(), mkSphere()];
  let front = 0;
  const markers = new THREE.Group();
  markers.renderOrder = 10;
  scene.add(markers);
  const ringTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    grd.addColorStop(0, 'rgba(255,255,255,0.16)');
    grd.addColorStop(0.52, 'rgba(255,255,255,0.10)');
    grd.addColorStop(0.66, 'rgba(255,255,255,0.95)');
    grd.addColorStop(0.74, 'rgba(255,255,255,0.95)');
    grd.addColorStop(0.86, 'rgba(255,255,255,0.18)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 256, 256);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const markerGeo = new THREE.PlaneGeometry(1, 1);
  markerGeo.rotateX(-Math.PI / 2);
  const mkMarkerMat = () => new THREE.MeshBasicMaterial({ map: ringTex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, side: THREE.DoubleSide, opacity: 0.85 });
  const cursor = new THREE.Mesh(markerGeo, mkMarkerMat());
  cursor.material.opacity = 0.5;
  cursor.visible = false;
  cursor.renderOrder = 11;
  cursor.scale.setScalar(0.55);
  scene.add(cursor);

  const inUse = (t) => spheres.some(s => s.material.map === t) || (trans && trans.tex === t);
  const makeTex = (img, isThumb) => {
    let source = img;
    const lim = isThumb ? 1024 : maxTex;
    if (img.width > lim || isThumb) {
      const w = Math.min(img.width, lim), h = Math.round(w * img.height / img.width);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d');
      if (isThumb && 'filter' in g) g.filter = 'blur(1.5px)';
      g.drawImage(img, 0, 0, w, h);
      source = c;
    }
    const tex = new THREE.Texture(source);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = maxAniso;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    try { if (renderer) renderer.initTexture(tex); } catch (e) { /* upload lazily */ }
    return tex;
  };
  const fullCache = new TexLRU(coarse ? 4 : 6, (img) => makeTex(img, false), inUse);
  const thumbCache = new TexLRU(24, (img) => makeTex(img, true), inUse);

  // ── state ──
  let manifest = null;
  let isOpenFlag = false, disposed = false;
  let cur = null;          // { unitId, pkg, list, idx, shown }
  let tod = normTod(timeOfDay);
  let nudgeAnim = null;
  let yaw = 0, pitch = 0, fov = FOV_DEFAULT, fovMul = 1;
  let yawVel = 0, pitchVel = 0;
  let turnAnim = null;     // { from, to, t, dur }
  let trans = null;
  let navTok = 0;
  let dirty = true, raf = 0, lastT = 0;
  let mapOpen = typeof innerWidth === 'number' ? innerWidth >= 900 : true;
  let hsItems = [];        // { idx, mesh, chip, rel:Vector3, yaw, dist }
  let hotIdx = -1;
  let fwdIdx = -1;
  let hintTimer = 0;
  const keys = new Set();
  let gyro = null;

  // ── text ──
  function refreshText() {
    root.setAttribute('lang', L);
    root.dir = L === 'he' ? 'rtl' : 'ltr';
    for (const [id, b] of pkBtns) {
      const s = STYLES.find(x => x.id === id);
      const nm = s ? pick(s.name, L) : id.charAt(0).toUpperCase() + id.slice(1);
      const parts = nm.split(' · ');
      b.querySelector('.tr-pkl').textContent = parts[0];
      b.querySelector('.tr-pkn').textContent = parts.slice(1).join(' · ') || '';
      b.title = b.disabled ? nm + ' — ' + tr('notRendered') : nm;
      b.setAttribute('aria-label', nm);
    }
    pkBox.setAttribute('aria-label', tr('pkg'));
    todBox.setAttribute('aria-label', tr('light'));
    for (const [id, b] of todBtns) { b.setAttribute('aria-label', tr(id)); b.title = b.disabled ? tr(id) + ' — ' + tr('notRendered') : tr(id); }
    setTimeout(updatePkFades, 0);
    const lab = (b, k) => { b.setAttribute('aria-label', tr(k)); b.title = tr(k); };
    lab(mapBtn, 'map'); lab(gyroBtn, 'gyro'); lab(fsBtn, 'fullscreen'); lab(closeBtn, 'close');
    lab(padF, 'fwd'); lab(padB, 'back'); lab(padL, 'left'); lab(padR, 'right');
    hint.textContent = coarse ? tr('hintTouch') : tr('hint');
    toast.textContent = tr('error');
    eCap.textContent = tr('emptyCap');
    eTitle.textContent = tr('emptyTitle');
    eBody.textContent = cur && cur.unitId ? tr('emptyBody').replace('{u}', cur.unitId) : tr('emptyBodyAll');
    eBtn.textContent = tr('close');
    updateTitle();
    buildMap();
    for (const h of hsItems) h.chip.querySelector('span').textContent = panoName(cur.list[h.idx]);
  }
  function panoName(p) {
    if (!p) return '';
    const n = pick(p.name, L);
    if (n) return n;
    const r = p.roomId && ROOM_BY_ID.get(p.roomId);
    return r ? pick(r.name, L) : p.id;
  }
  function updateTitle() {
    const p = cur && cur.list && cur.list[cur.idx];
    const u = cur && cur.unitId;
    capEl.innerHTML = '';
    if (u) {
      capEl.append(document.createTextNode(tr('apartment') + ' '));
      const b = document.createElement('b'); b.textContent = u; b.dir = 'ltr';
      const x = el('span', 'tr-capx'); x.textContent = ' · ' + tr('caption');
      capEl.append(b, x);
    }
    else capEl.textContent = tr('caption');
    roomEl.textContent = p ? panoName(p) : (u ? '' : tr('caption'));
    root.setAttribute('aria-label', (u ? tr('apartment') + ' ' + u + ' · ' : '') + tr('caption'));
  }
  function updatePkButtons() {
    const avail = (cur && manifest && manifest.units[cur.unitId]) || {};
    let added = false;
    for (const id of Object.keys(avail)) if (!pkBtns.has(id)) { addPkBtn(id); added = true; }
    for (const [id, b] of pkBtns) {
      const ok = !!(avail[id] && avail[id].panos && avail[id].panos.length);
      b.disabled = !ok;
      b.setAttribute('aria-pressed', String(!!cur && cur.pkg === id));
    }
    if (added) refreshText();
    if (cur) revealPk(cur.pkg, true);
    updateTodButtons();
  }
  function updateTodButtons() {
    // a state is disabled only when NO pano of this unit/package has it
    const list = (cur && cur.list) || [];
    // highlight what is actually on screen (a pano without the requested state shows its nearest one)
    const cp = list[cur ? cur.idx : -1];
    const shownTod = cp ? srcFor(cp, tod).tod : tod;
    for (const [id, b] of todBtns) {
      const ok = id === 'day' || list.some(p => p.variants && p.variants[id]);
      b.disabled = !ok;
      b.setAttribute('aria-pressed', String(shownTod === id));
      b.title = ok ? tr(id) : tr(id) + ' — ' + tr('notRendered');
    }
    todBox.hidden = !list.length;
  }

  // ── mini-map ──
  let mapEls = null, lastConeKey = '';
  function buildMap() {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    mapEls = null;
    lastConeKey = '';
    if (!cur || !cur.list || !cur.list.length) return;
    const unit = unitById(cur.unitId);
    const fl = unit ? floorById(unit.floor) : null;
    mapCap.textContent = tr('map') + (fl ? ' · ' + pick(fl.label, L) : '');
    const rooms = fl ? fl.rooms.filter(r => r.unit === cur.unitId) : [];
    const bals = unit ? BALCONIES.filter(b => b.level === unit.floor && b.unit.includes(cur.unitId)) : [];
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    const grow = (x, z) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); };
    for (const r of rooms) for (const [x, z] of r.poly) grow(x, z);
    for (const b of bals) for (const [x, z] of b.poly) grow(x, z);
    for (const p of cur.list) if (p.hasPos) grow(p.pos[0], p.pos[2]);
    if (!isFinite(x0)) return;
    const padM = 0.7;
    x0 -= padM; z0 -= padM; x1 += padM; z1 += padM;
    svg.setAttribute('viewBox', `${x0} ${z0} ${x1 - x0} ${z1 - z0}`);
    const mk = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
    const defs = mk('defs', {});
    const g = mk('radialGradient', { id: 'tr-cone-g', cx: '0', cy: '0', r: '1', gradientUnits: 'userSpaceOnUse', gradientTransform: 'scale(2.4)' });
    g.append(mk('stop', { offset: '0', 'stop-color': '#cdb07a', 'stop-opacity': '.75' }), mk('stop', { offset: '1', 'stop-color': '#cdb07a', 'stop-opacity': '0' }));
    defs.append(g);
    svg.append(defs);
    const pts = (poly) => poly.map(([x, z]) => x + ',' + z).join(' ');
    for (const b of bals) svg.append(mk('polygon', { class: 'tr-mbal', points: pts(b.poly) }));
    const roomEls = new Map();
    for (const r of rooms) {
      const e = mk('polygon', { class: 'tr-mroom', points: pts(r.poly) });
      const t = document.createElementNS(SVGNS, 'title'); t.textContent = pick(r.name, L); e.append(t);
      roomEls.set(r.id, e);
      svg.append(e);
    }
    const cone = mk('path', { class: 'tr-cone', d: '' });
    svg.append(cone);
    const dots = [];
    cur.list.forEach((p, i) => {
      if (!p.hasPos) return;
      const hit = mk('circle', { class: 'tr-mhit', cx: p.pos[0], cy: p.pos[2], r: 0.55 });
      const dot = mk('circle', { class: 'tr-mdot', cx: p.pos[0], cy: p.pos[2], r: 0.2 });
      const t = document.createElementNS(SVGNS, 'title'); t.textContent = panoName(p); hit.append(t);
      const go = (e) => { e.stopPropagation(); e.preventDefault(); goTo(i, 'move'); };
      hit.addEventListener('click', go); dot.addEventListener('click', go);
      svg.append(hit, dot);
      dots[i] = dot;
    });
    mapEls = { roomEls, cone, dots };
    updateMapState();
  }
  function updateMapState() {
    if (!mapEls || !cur) return;
    const p = cur.list[cur.idx];
    mapEls.dots.forEach((d, i) => d && d.classList.toggle('tr-cur', i === cur.idx));
    mapEls.roomEls.forEach((e, id) => e.classList.toggle('tr-cur', !!p && p.roomId === id));
    if (!p || !p.hasPos) { mapEls.cone.setAttribute('d', ''); return; }
    const hf = Math.atan(Math.tan((fov * fovMul) * Math.PI / 360) * camera.aspect);
    const key = yaw.toFixed(3) + hf.toFixed(3) + cur.idx;
    if (key === lastConeKey) return;
    lastConeKey = key;
    const r = 2.4, x = p.pos[0], z = p.pos[2];
    const a = (ang) => [x - Math.sin(ang) * r, z - Math.cos(ang) * r];
    const [ax, az] = a(yaw + hf), [bx, bz] = a(yaw - hf);
    mapEls.cone.setAttribute('d', `M${x},${z} L${ax},${az} A${r},${r} 0 0 1 ${bx},${bz} Z`);
    mapEls.cone.setAttribute('transform', '');
    const gr = svg.querySelector('#tr-cone-g');
    if (gr) gr.setAttribute('gradientTransform', `translate(${x} ${z}) scale(${r})`);
  }
  function setMapOpen(v) {
    mapOpen = !!v;
    mapBox.classList.toggle('tr-open', mapOpen);
    mapBtn.setAttribute('aria-pressed', String(mapOpen));
  }

  // ── hotspots ──
  function clearHotspots() {
    for (const h of hsItems) { markers.remove(h.mesh); h.mesh.material.dispose(); h.chip.remove(); }
    hsItems = [];
    hotIdx = -1;
  }
  function buildHotspots() {
    clearHotspots();
    if (!cur) return;
    const p = cur.list[cur.idx];
    if (!p) return;
    for (const j of p.links) {
      const q = cur.list[j];
      if (!q) continue;
      const rel = new THREE.Vector3(q.pos[0] - p.pos[0], (q.pos[1] - EYE) - p.pos[1], q.pos[2] - p.pos[2]);
      const dist = Math.hypot(rel.x, rel.z);
      if (dist < 0.15) continue;
      const mesh = new THREE.Mesh(markerGeo, mkMarkerMat());
      mesh.position.copy(rel);
      // real-world ring (≈0.6 m) that grows a little with distance so far targets stay legible
      mesh.scale.setScalar(0.62 * (1 + Math.max(0, dist - 2) * 0.07));
      mesh.renderOrder = 10;
      mesh.userData.idx = j;
      markers.add(mesh);
      const chip = el('button', 'tr-hs', `<i>${ICON.chev}</i><span></span>`);
      chip.type = 'button';
      chip.querySelector('span').textContent = panoName(q);
      chip.dir = 'auto';
      chip.addEventListener('pointerdown', (e) => e.stopPropagation());
      chip.addEventListener('click', (e) => { e.stopPropagation(); goTo(j, 'move'); });
      chip.addEventListener('pointerenter', () => { hotIdx = j; dirty = true; });
      chip.addEventListener('pointerleave', () => { if (hotIdx === j) hotIdx = -1; dirty = true; });
      hsLayer.append(chip);
      hsItems.push({ idx: j, mesh, chip, rel, dist, yaw: yawOf(rel.x, rel.z) });
    }
    dirty = true;
  }
  const _v = new THREE.Vector3();
  function layoutHotspots() {
    const w = stage.clientWidth, h = stage.clientHeight;
    const vis = hsItems.length && !trans;
    // ▲ target = linked pano closest to the view direction (within 75°)
    let best = -1, bestA = 75 * Math.PI / 180;
    for (const it of hsItems) { const a = Math.abs(wrapPI(it.yaw - yaw)); if (a < bestA) { bestA = a; best = it.idx; } }
    fwdIdx = best;
    const placed = [];
    if (vis) {
      const sr = stage.getBoundingClientRect();
      for (const o of [pad, mapOpen ? mapBox : null]) {
        if (!o) continue;
        const r = o.getBoundingClientRect();
        if (r.width) placed.push({ x: r.left - sr.left, y: r.top - sr.top, w: r.width, h: r.height });
      }
    }
    const order = hsItems.slice().sort((a, b) => a.dist - b.dist);
    for (const it of order) {
      const hot = it.idx === hotIdx, fw = it.idx === fwdIdx;
      it.mesh.visible = !!vis;
      it.mesh.material.opacity = hot ? 1 : fw ? 0.92 : 0.7;
      it.mesh.material.color.set(hot || fw ? 0xf0dcb0 : 0xffffff);
      if (!vis) { it.chip.hidden = true; continue; }
      _v.copy(it.rel).applyMatrix4(camera.matrixWorldInverse);
      if (_v.z > -0.2) { it.chip.hidden = true; continue; }
      _v.copy(it.rel).project(camera);
      let x = (_v.x * 0.5 + 0.5) * w, y = (-_v.y * 0.5 + 0.5) * h;
      if (x < -60 || x > w + 60 || y < -40 || y > h + 80) { it.chip.hidden = true; continue; }
      it.chip.hidden = false;
      it.chip.classList.toggle('tr-fwd', fw);
      it.chip.classList.toggle('tr-hot', hot);
      const cw = it.chip.offsetWidth || 100, ch = it.chip.offsetHeight || 32;
      let top = y - ch - 18 * (1 + 2 / Math.max(1, it.dist)), left = x - cw / 2;
      left = clamp(left, 8, w - cw - 8);
      top = clamp(top, 70, h - ch - 8);
      for (let k = 0; k < 8; k++) {
        const hitR = placed.find(r => left < r.x + r.w + 4 && left + cw + 4 > r.x && top < r.y + r.h + 4 && top + ch + 4 > r.y);
        if (!hitR) break;
        top = hitR.y - ch - 6;
      }
      placed.push({ x: left, y: top, w: cw, h: ch });
      it.chip.style.transform = `translate3d(${left.toFixed(1)}px,${top.toFixed(1)}px,0)`;
    }
  }

  // ── transitions ──
  function startTransition(tex, pano, mode, travel, dur) {
    if (trans) finishTransition();
    return new Promise((resolve) => {
      const from = spheres[front], to = spheres[1 - front];
      to.material.map = tex;
      to.rotation.y = (pano.yawOffset || 0) + SPHERE_YAW_BASE;
      to.material.opacity = 0;
      to.position.set(0, 0, 0);
      to.visible = true;
      to.renderOrder = 2;
      from.renderOrder = 1;
      trans = { t: 0, dur: (reduceMotion ? Math.min(dur, 250) : dur) / 1000, from, to, travel: reduceMotion ? null : travel, mode, resolve, tex };
      dirty = true;
    });
  }
  function finishTransition() {
    const t = trans;
    if (!t) return;
    trans = null;
    t.from.visible = false;
    t.from.position.set(0, 0, 0);
    t.from.material.map = blank;
    t.to.position.set(0, 0, 0);
    t.to.material.opacity = 1;
    t.to.renderOrder = 1;
    front = spheres.indexOf(t.to);
    fovMul = 1;
    dirty = true;
    t.resolve();
  }
  function stepTransition(dt) {
    const t = trans;
    t.t += dt;
    const u = clamp(t.t / t.dur, 0, 1);
    const e = easeInOut(u);
    t.to.material.opacity = t.mode === 'move' ? smooth(0.12, 0.88, u) : e;
    if (t.travel) {
      t.from.position.copy(t.travel).multiplyScalar(-e);
      t.to.position.copy(t.travel).multiplyScalar(1 - e);
      fovMul = 1 - 0.075 * Math.sin(Math.PI * u);
    }
    dirty = true;
    if (u >= 1) finishTransition();
  }

  // ── navigation ──
  function setBusy(v) { busy.classList.toggle('tr-on', !!v); }
  function showToast() { toast.classList.add('tr-on'); clearTimeout(showToast.t); showToast.t = setTimeout(() => toast.classList.remove('tr-on'), 2600); }
  async function acquire(pano) {
    const src = srcFor(pano, tod);
    const full = fullCache.peek(src.file);
    if (full) return { tex: full, full: true, fullP: Promise.resolve(full), file: src.file };
    const fullP = fullCache.load(src.file, 'high');
    fullP.catch(() => {});
    if (!src.thumb) { const t = await fullP; return { tex: t, full: true, fullP, file: src.file }; }
    const thumbP = thumbCache.load(src.thumb, 'high');
    const first = await Promise.race([
      fullP.then(t => ({ tex: t, full: true }), () => null),
      thumbP.then(t => ({ tex: t, full: false }), () => null)
    ]);
    if (first) return { ...first, fullP, file: src.file };
    // whichever resolved first failed: wait for the other
    try { return { tex: await fullP, full: true, fullP, file: src.file }; } catch (e) { /* */ }
    return { tex: await thumbP, full: false, fullP, file: src.file };
  }
  async function goTo(idx, mode = 'move') {
    if (!cur || !cur.list[idx] || disposed) return false;
    if (idx === cur.idx && mode === 'move') return false;
    const tok = ++navTok;
    const pano = cur.list[idx];
    const prev = cur.list[cur.idx];
    const busyT = setTimeout(() => { if (tok === navTok) setBusy(true); }, 160);
    let got;
    try { got = await acquire(pano); } catch (e) { got = null; }
    clearTimeout(busyT);
    if (tok !== navTok || !isOpenFlag) return false;
    setBusy(false);
    if (!got) { showToast(); return false; }
    let travel = null;
    if (mode === 'move' && prev && prev !== pano && spheres[front].visible) {
      const dx = pano.pos[0] - prev.pos[0], dz = pano.pos[2] - prev.pos[2];
      const d = Math.hypot(dx, dz);
      if (d > 0.05) travel = new THREE.Vector3(dx / d, 0, dz / d).multiplyScalar(Math.min(d, 4) * 0.6);
    }
    clearHotspots();
    cur.idx = idx;
    cur.shown = got.file;
    updateTodButtons();
    updateTitle();
    updateMapState();
    const first = !spheres[front].visible;
    await startTransition(got.tex, pano, travel ? 'move' : 'fade', travel, travel ? MOVE_MS : first ? 380 : PKG_MS);
    if (tok !== navTok) return true;
    buildHotspots();
    if (!got.full) {
      bar.classList.add('tr-on');
      got.fullP.then(t => {
        if (tok !== navTok || !isOpenFlag) return;
        bar.classList.remove('tr-on');
        return startTransition(t, pano, 'fade', null, SHARPEN_MS).then(() => { if (tok === navTok) schedulePreload(); });
      }, () => { if (tok === navTok) bar.classList.remove('tr-on'); });
    } else {
      bar.classList.remove('tr-on');
      schedulePreload();
    }
    return true;
  }
  let preloadTimer = 0;
  function schedulePreload() {
    clearTimeout(preloadTimer);
    const tok = navTok;
    preloadTimer = setTimeout(async () => {
      if (!cur || tok !== navTok) return;
      const p = cur.list[cur.idx];
      const order = p.links.slice().sort((a, b) => {
        const A = hsItems.find(h => h.idx === a), B = hsItems.find(h => h.idx === b);
        return (A ? Math.abs(wrapPI(A.yaw - yaw)) : 9) - (B ? Math.abs(wrapPI(B.yaw - yaw)) : 9);
      });
      // queue: the link straight ahead, then the other light states of THIS pano, then the remaining links
      const jobs = [];
      const linkJob = (j) => { const q = cur.list[j]; if (q) { const s = srcFor(q, tod); jobs.push(s); } };
      if (order.length) linkJob(order[0]);
      for (const k of TODS) {
        if (k === tod) continue;
        const s = k === 'day' ? { file: p.file, thumb: p.thumb } : (p.variants[k] || null);
        if (s && s.file !== cur.shown && !jobs.some(x => x.file === s.file)) jobs.push(s);
      }
      for (const j of order.slice(1)) linkJob(j);
      for (const s of jobs.slice(0, fullCache.max - 1)) {
        if (!cur || tok !== navTok || !isOpenFlag) return;
        if (s.thumb) { try { await thumbCache.load(s.thumb, 'low'); } catch (e) { /* */ } }
        try { await fullCache.load(s.file, 'low'); } catch (e) { /* */ }
      }
    }, 450);
  }
  function linkInDirection(dirYaw, maxAngle, preferPoint) {
    if (!cur) return -1;
    let best = -1, bestS = Infinity;
    for (const it of hsItems) {
      const a = Math.abs(wrapPI(it.yaw - dirYaw));
      if (a > maxAngle) continue;
      const s = preferPoint ? Math.hypot(it.rel.x - preferPoint.x, it.rel.z - preferPoint.z) + a * 1.5 : a;
      if (s < bestS) { bestS = s; best = it.idx; }
    }
    return best;
  }
  // "forward nudge": a 400 ms FOV squeeze so the walk gesture always answers, even with nowhere to go
  function nudge() {
    if (trans) return;
    nudgeAnim = { t: 0, dur: NUDGE_MS / 1000, amp: reduceMotion ? 0.02 : 0.07 };
    dirty = true;
  }
  function moveForward() { const j = linkInDirection(yaw, 75 * Math.PI / 180); if (j >= 0) goTo(j, 'move'); else nudge(); }
  function moveBack() {
    let best = -1, bestA = 105 * Math.PI / 180;
    for (const it of hsItems) { const a = Math.abs(wrapPI(it.yaw - yaw)); if (a > bestA) { bestA = a; best = it.idx; } }
    if (best >= 0) goTo(best, 'move'); else nudge();
  }
  function turn(sign) {
    const from = turnAnim ? turnAnim.to : yaw;
    turnAnim = { from: yaw, to: from + sign * TURN_STEP, t: 0, dur: reduceMotion ? 0.01 : 0.32 };
    yawVel = 0;
    dirty = true;
  }

  // ── open / package ──
  function initialYawFor(p) {
    if (typeof p.initialYaw === 'number') return p.initialYaw;
    if (p.lookAt) return yawOf(p.lookAt[0] - p.pos[0], p.lookAt[2] - p.pos[2]);
    const room = p.roomId && ROOM_BY_ID.get(p.roomId);
    if (room && p.hasPos) {
      // face the longest line of sight inside the room (smoothed) — usually the window / the depth of the room
      const N = 72, d = [];
      for (let k = 0; k < N; k++) { const a = k / N * TAU; d.push(Math.min(15, rayPolyDist(p.pos[0], p.pos[2], -Math.sin(a), -Math.cos(a), room.poly))); }
      let best = 0, bestV = -1;
      for (let k = 0; k < N; k++) { let s = 0; for (let o = -3; o <= 3; o++) s += d[(k + o + N) % N]; if (s > bestV) { bestV = s; best = k; } }
      return best / N * TAU;
    }
    if (p.links.length) { const q = cur.list[p.links[0]]; return yawOf(q.pos[0] - p.pos[0], q.pos[2] - p.pos[2]); }
    return p.yawOffset || 0;
  }
  function showEmpty(v) {
    empty.classList.toggle('tr-on', !!v);
    root.classList.toggle('tr-isempty', !!v);
    eBody.textContent = cur && cur.unitId ? tr('emptyBody').replace('{u}', cur.unitId) : tr('emptyBodyAll');
  }
  function resetView() {
    spheres.forEach(s => { s.visible = false; s.material.map = blank; s.position.set(0, 0, 0); });
    if (trans) { const r = trans.resolve; trans = null; r(); }
    clearHotspots();
  }
  async function open(unitId, packageId, roomId, opts) {
    if (disposed) return false;
    if (opts && opts.timeOfDay) tod = normTod(opts.timeOfDay);
    const tok = ++navTok;
    if (!isOpenFlag) {
      isOpenFlag = true;
      root.hidden = false;
      resize();
      startLoop();
      addGlobal();
      try { stage.focus({ preventScroll: true }); } catch (e) { /* */ }
    }
    resetView();
    cur = { unitId, pkg: packageId, list: [], idx: -1, shown: null };
    updateTitle();
    showEmpty(false);
    setBusy(true);
    manifest = await loadManifest(manifestUrl);
    if (tok !== navTok || !isOpenFlag) return false;
    setBusy(false);
    const um = manifest && manifest.units[unitId];
    let pkg = packageId;
    if (!um || !um[pkg] || !um[pkg].panos.length) pkg = um ? (STYLES.map(s => s.id).find(id => um[id] && um[id].panos.length) || Object.keys(um).find(k => um[k].panos.length)) : null;
    if (!pkg) {
      cur.pkg = packageId;
      updatePkButtons(); refreshText();
      showEmpty(true);
      return false;
    }
    cur.pkg = pkg;
    cur.list = um[pkg].panos;
    const unit = unitById(unitId);
    let idx = -1;
    if (roomId) idx = cur.list.findIndex(p => p.roomId === roomId || p.id === roomId);
    if (idx < 0 && unit && unit.viewRoom) idx = cur.list.findIndex(p => p.roomId === unit.viewRoom);
    if (idx < 0) idx = 0;
    updatePkButtons();
    refreshText();
    yaw = initialYawFor(cur.list[idx]); pitch = 0; fov = FOV_DEFAULT; yawVel = pitchVel = 0; turnAnim = null;
    cur.idx = -1;
    showHint();
    if (pkg !== packageId && typeof onPackageChange === 'function') { try { onPackageChange(pkg); } catch (e) { /* */ } }
    return goTo(idx, 'fade');
  }
  async function switchPackage(pkgId) {
    if (!cur || !manifest || cur.pkg === pkgId) return false;
    const um = manifest.units[cur.unitId];
    const e = um && um[pkgId];
    if (!e || !e.panos.length) return false;
    const old = cur.list[cur.idx];
    let idx = old ? e.panos.findIndex(p => p.id === old.id) : -1;
    if (idx < 0 && old) {
      let bd = Infinity;
      e.panos.forEach((p, i) => { const d = Math.hypot(p.pos[0] - old.pos[0], p.pos[2] - old.pos[2]) + (p.roomId === old.roomId ? 0 : 100); if (d < bd) { bd = d; idx = i; } });
    }
    if (idx < 0) idx = 0;
    cur.pkg = pkgId;
    cur.list = e.panos;
    cur.idx = -1;
    updatePkButtons();
    buildMap();
    return goTo(idx, 'pkg');
  }
  function switchTod(id) {
    id = normTod(id);
    if (tod === id) return Promise.resolve(false);
    tod = id;
    updateTodButtons();
    if (!cur || !isOpenFlag || !cur.list.length || cur.idx < 0) return Promise.resolve(true);
    const p = cur.list[cur.idx];
    if (srcFor(p, tod).file === cur.shown) { schedulePreload(); return Promise.resolve(true); }   // this pano has no such variant: keep what is shown
    return goTo(cur.idx, 'pkg').then(() => true);
  }
  function userSetTod(id) {
    switchTod(id).then(ok => { if (ok && typeof onTimeOfDayChange === 'function') { try { onTimeOfDayChange(tod); } catch (e) { /* */ } } });
  }
  function userSetPackage(id) {
    switchPackage(id).then(ok => { if (ok && typeof onPackageChange === 'function') { try { onPackageChange(id); } catch (e) { /* */ } } });
  }
  function close() {
    if (!isOpenFlag) return;
    isOpenFlag = false;
    navTok++;
    root.hidden = true;
    stopLoop();
    removeGlobal();
    setGyro(false);
    setBusy(false);
    bar.classList.remove('tr-on');
    clearTimeout(preloadTimer);
    try { if (document.fullscreenElement === root) document.exitFullscreen().catch(() => {}); } catch (e) { /* */ }
    resetView();
    if (typeof onClose === 'function') { try { onClose(); } catch (e) { /* */ } }
  }
  function showHint() {
    hint.classList.add('tr-on');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => hint.classList.remove('tr-on'), 4200);
  }

  // ── input ──
  const pointers = new Map();
  let drag = null, pinch = null, lastTap = null;
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function rayAt(cx, cy) {
    const r = stage.getBoundingClientRect();
    ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    camera.updateMatrixWorld();
    raycaster.setFromCamera(ndc, camera);
    return raycaster.ray;
  }
  function markerAt(cx, cy) {
    if (!hsItems.length || trans) return -1;
    rayAt(cx, cy);
    const hits = raycaster.intersectObjects(hsItems.map(h => h.mesh), false);
    return hits.length ? hits[0].object.userData.idx : -1;
  }
  function floorPointAt(cx, cy) {
    const ray = rayAt(cx, cy);
    if (ray.direction.y > -0.04) return null;
    const t = -EYE / ray.direction.y;
    return ray.direction.clone().multiplyScalar(t);
  }
  function onDown(e) {
    if (!isOpenFlag) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    try { stage.setPointerCapture(e.pointerId); } catch (er) { /* */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now(), moved: 0, lt: performance.now() };
      yawVel = pitchVel = 0;
      turnAnim = null;
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), fov };
      drag = null;
    }
    cursor.visible = false;
    hint.classList.remove('tr-on');
  }
  function onMove(e) {
    if (!isOpenFlag) return;
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d > 10) { fov = clamp(pinch.fov * pinch.d / d, FOV_MIN, FOV_MAX); dirty = true; }
      return;
    }
    if (drag && drag.id === e.pointerId) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      if (drag.moved > 4) stage.classList.add('tr-drag');
      const k = (fov * fovMul * Math.PI / 180) / Math.max(1, stage.clientHeight);
      const now = performance.now(), dtm = Math.max(1, now - drag.lt) / 1000;
      drag.lt = now;
      const dyaw = dx * k, dpitch = dy * k;
      if (gyro) gyro.offset += dyaw; else yaw += dyaw;
      pitch = clamp(pitch + dpitch, -1.45, 1.45);
      yawVel = yawVel * 0.6 + (dyaw / dtm) * 0.4;
      pitchVel = pitchVel * 0.6 + (dpitch / dtm) * 0.4;
      dirty = true;
      return;
    }
    if (e.pointerType === 'mouse' && !pointers.size) {
      // hover: marker highlight + floor cursor ring
      const m = markerAt(e.clientX, e.clientY);
      if (m !== hotIdx) { hotIdx = m; dirty = true; }
      stage.style.cursor = m >= 0 ? 'pointer' : '';
      const fp = m < 0 && !trans ? floorPointAt(e.clientX, e.clientY) : null;
      if (fp && Math.hypot(fp.x, fp.z) < 9) { cursor.position.copy(fp); cursor.visible = true; } else cursor.visible = false;
      dirty = true;
    }
  }
  function onUp(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    stage.classList.remove('tr-drag');
    if (pinch) { if (pointers.size < 2) pinch = null; drag = null; return; }
    if (!drag || drag.id !== e.pointerId) return;
    const d = drag; drag = null;
    const now = performance.now();
    if (now - d.lt > 80) { yawVel = 0; pitchVel = 0; }
    // a tap = finger lifted close to where it landed (net displacement, real fingers jitter) and quickly.
    // Double-tap is detected here by hand (two taps < 350 ms and < 30 px apart) — never via 'dblclick', which iOS does not deliver reliably.
    if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 12 && now - d.t0 < DTAP_MS) {
      yawVel = pitchVel = 0;
      const m = markerAt(e.clientX, e.clientY);
      if (m >= 0) { lastTap = null; goTo(m, 'move'); return; }
      if (lastTap && now - lastTap.t < DTAP_MS && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < DTAP_PX) {
        lastTap = null;
        doubleTap(e.clientX, e.clientY);
      } else lastTap = { t: now, x: e.clientX, y: e.clientY };
    }
  }
  function doubleTap(cx, cy) {
    const ray = rayAt(cx, cy);
    const dyaw = yawOf(ray.direction.x, ray.direction.z);
    const fp = floorPointAt(cx, cy);
    const j = linkInDirection(dyaw, 60 * Math.PI / 180, fp && Math.hypot(fp.x, fp.z) < 12 ? fp : null);
    if (j >= 0) goTo(j, 'move'); else nudge();
  }
  function onWheel(e) {
    if (!isOpenFlag) return;
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    fov = clamp(fov + dy * 0.03, FOV_MIN, FOV_MAX);
    dirty = true;
  }
  function onKey(e) {
    if (!isOpenFlag) return;
    const tg = e.target;
    if (tg && (tg.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName))) return;
    const k = e.key;
    if (e.type === 'keyup') { keys.delete(k); return; }
    if (k === 'Escape') { e.preventDefault(); close(); return; }
    if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'a' || k === 'd') { e.preventDefault(); keys.add(k); turnAnim = null; dirty = true; return; }
    if (e.repeat) return;
    if (k === 'ArrowUp' || k === 'w') { e.preventDefault(); moveForward(); }
    else if (k === 'ArrowDown' || k === 's') { e.preventDefault(); moveBack(); }
    else if (k === '+' || k === '=') { fov = clamp(fov - 8, FOV_MIN, FOV_MAX); dirty = true; }
    else if (k === '-' || k === '_') { fov = clamp(fov + 8, FOV_MIN, FOV_MAX); dirty = true; }
  }
  if (typeof window !== 'undefined' && window.PointerEvent) {
    stage.addEventListener('pointerdown', onDown);
    stage.addEventListener('pointermove', onMove);
    stage.addEventListener('pointerup', onUp);
    stage.addEventListener('pointercancel', onUp);
  } else {
    // very old WebKit: same handlers fed from touch + mouse events
    const each = (fn) => (e) => { if (e.target.closest && e.target.closest('.tr-hs')) return; e.preventDefault(); for (const t of e.changedTouches) fn({ pointerId: t.identifier, clientX: t.clientX, clientY: t.clientY, pointerType: 'touch', button: 0 }); };
    stage.addEventListener('touchstart', each(onDown), { passive: false });
    stage.addEventListener('touchmove', each(onMove), { passive: false });
    stage.addEventListener('touchend', each(onUp), { passive: false });
    stage.addEventListener('touchcancel', each(onUp), { passive: false });
    const mouse = (fn) => (e) => fn({ pointerId: 1, clientX: e.clientX, clientY: e.clientY, pointerType: 'mouse', button: e.button });
    stage.addEventListener('mousedown', mouse(onDown));
    window.addEventListener('mousemove', mouse(onMove));
    window.addEventListener('mouseup', mouse(onUp));
  }
  stage.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !pointers.size) { cursor.visible = false; hotIdx = -1; dirty = true; } });
  stage.addEventListener('wheel', onWheel, { passive: false });
  stage.addEventListener('dblclick', (e) => e.preventDefault());
  stage.addEventListener('contextmenu', (e) => e.preventDefault());
  root.addEventListener('gesturestart', (e) => e.preventDefault());
  const onBlur = () => keys.clear();
  function addGlobal() { window.addEventListener('keydown', onKey); window.addEventListener('keyup', onKey); window.addEventListener('blur', onBlur); }
  function removeGlobal() { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKey); window.removeEventListener('blur', onBlur); keys.clear(); }

  // buttons
  const press = (b, fn) => { b.addEventListener('click', (e) => { e.stopPropagation(); fn(); }); b.addEventListener('pointerdown', (e) => e.stopPropagation()); };
  press(padF, moveForward);
  press(padB, moveBack);
  // hold ◀ ▶ = keep turning in 30° steps
  for (const [b, s] of [[padL, 1], [padR, -1]]) {
    let holdT = 0;
    const stop = () => { clearInterval(holdT); holdT = 0; b.classList.remove('tr-down'); };
    b.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); turn(s); b.classList.add('tr-down'); clearInterval(holdT); holdT = setInterval(() => turn(s), 330); });
    b.addEventListener('pointerup', stop); b.addEventListener('pointercancel', stop); b.addEventListener('pointerleave', stop);
    b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); turn(s); } });
  }
  press(mapBtn, () => setMapOpen(!mapOpen));
  press(closeBtn, close);
  eBtn.addEventListener('click', close);
  press(fsBtn, () => {
    try {
      const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
      if (fsEl) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
      const t = fsTarget();
      const p = (t.requestFullscreen || t.webkitRequestFullscreen).call(t);
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* not allowed */ }
  });
  const onFsChange = () => { const on = (document.fullscreenElement || document.webkitFullscreenElement) === root; fsBtn.innerHTML = on ? ICON.fsx : ICON.fs; setTimeout(resize, 50); };
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);
  press(gyroBtn, () => setGyro(!gyro));
  mapBox.addEventListener('pointerdown', (e) => e.stopPropagation());
  top.addEventListener('pointerdown', (e) => e.stopPropagation());

  // ── gyroscope (off by default) ──
  const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)), _z = new THREE.Vector3(0, 0, 1), _q0 = new THREE.Quaternion(), _f = new THREE.Vector3();
  function onOrient(ev) {
    if (!gyro || ev.alpha == null) return;
    const deg = Math.PI / 180;
    const orient = ((screen.orientation && screen.orientation.angle) || window.orientation || 0) * deg;
    _e.set(ev.beta * deg, ev.alpha * deg, -ev.gamma * deg, 'YXZ');
    _q.setFromEuler(_e).multiply(_q1).multiply(_q0.setFromAxisAngle(_z, -orient));
    _f.set(0, 0, -1).applyQuaternion(_q);
    const gy = Math.atan2(-_f.x, -_f.z), gp = Math.asin(clamp(_f.y, -1, 1));
    if (gyro.offset == null) gyro.offset = yaw - gy;
    gyro.yaw = gy; gyro.pitch = gp;
    dirty = true;
  }
  async function setGyro(on) {
    if (!on) {
      if (gyro) { window.removeEventListener('deviceorientation', onOrient); gyro = null; }
      gyroBtn.setAttribute('aria-pressed', 'false');
      return;
    }
    try {
      const DOE = window.DeviceOrientationEvent;
      if (DOE && typeof DOE.requestPermission === 'function') { const r = await DOE.requestPermission(); if (r !== 'granted') return; }
    } catch (e) { return; }
    gyro = { offset: null, yaw: null, pitch: 0 };
    window.addEventListener('deviceorientation', onOrient);
    gyroBtn.setAttribute('aria-pressed', 'true');
  }

  // ── loop ──
  function resize() {
    if (!renderer) return;
    const w = Math.max(1, root.clientWidth), h = Math.max(1, root.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    dirty = true;
  }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (isOpenFlag) resize(); }) : null;
  if (ro) ro.observe(root); else window.addEventListener('resize', resize);
  function update(dt) {
    if (trans) { nudgeAnim = null; stepTransition(dt); }
    else if (nudgeAnim) {
      nudgeAnim.t += dt;
      const u = clamp(nudgeAnim.t / nudgeAnim.dur, 0, 1);
      fovMul = 1 - nudgeAnim.amp * Math.sin(Math.PI * u) * (1 - 0.35 * u);
      if (u >= 1) { fovMul = 1; nudgeAnim = null; }
      dirty = true;
    }
    if (turnAnim) {
      turnAnim.t += dt;
      const u = clamp(turnAnim.t / turnAnim.dur, 0, 1);
      yaw = turnAnim.from + (turnAnim.to - turnAnim.from) * easeInOut(u);
      if (u >= 1) turnAnim = null;
      dirty = true;
    }
    const kl = keys.has('ArrowLeft') || keys.has('a'), kr = keys.has('ArrowRight') || keys.has('d');
    if (kl !== kr) { yaw += (kl ? 1 : -1) * 1.5 * dt; dirty = true; }
    if (!drag && (Math.abs(yawVel) > 1e-4 || Math.abs(pitchVel) > 1e-4)) {
      const decay = Math.exp(-dt * 4.2);
      if (gyro) gyro.offset += yawVel * dt; else yaw += yawVel * dt;
      pitch = clamp(pitch + pitchVel * dt, -1.45, 1.45);
      yawVel *= decay; pitchVel *= decay;
      if (Math.abs(yawVel) < 0.002) yawVel = 0;
      if (Math.abs(pitchVel) < 0.002) pitchVel = 0;
      dirty = true;
    }
    if (gyro && gyro.yaw != null && gyro.offset != null) { yaw = gyro.yaw + gyro.offset; pitch = gyro.pitch; }
  }
  function render() {
    if (!renderer) return;
    camera.fov = clamp(fov * fovMul, 20, 100);
    camera.updateProjectionMatrix();
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
    camera.updateMatrixWorld();
    layoutHotspots();
    renderer.render(scene, camera);
    updateMapState();
  }
  function frame(t) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.1, Math.max(0, (t - (lastT || t)) / 1000));
    lastT = t;
    update(dt);
    if (dirty) { dirty = false; render(); }
  }
  function startLoop() { if (!raf) { lastT = 0; dirty = true; raf = requestAnimationFrame(frame); } }
  function stopLoop() { if (raf) cancelAnimationFrame(raf); raf = 0; }

  setMapOpen(mapOpen);
  refreshText();
  if (!renderer) { showEmpty(true); }

  return {
    open: (unitId, packageId, roomId, opts) => open(unitId, packageId, roomId, opts).catch(() => false),
    setTimeOfDay: (id) => switchTod(id).catch(() => false),
    getTimeOfDay: () => tod,
    setPackage: (id) => { if (cur && isOpenFlag && cur.list.length) return switchPackage(id).catch(() => false); if (cur) cur.pkg = id; return Promise.resolve(false); },
    setLang: (l) => { L = normLang(l); refreshText(); dirty = true; },
    close,
    isOpen: () => isOpenFlag,
    dispose() {
      if (disposed) return;
      close();
      disposed = true;
      fullCache.dead = thumbCache.dead = true;
      clearHotspots();
      fullCache.clear(); thumbCache.clear();
      sphereGeo.dispose(); markerGeo.dispose(); ringTex.dispose(); blank.dispose();
      spheres.forEach(s => s.material.dispose()); cursor.material.dispose();
      if (ro) ro.disconnect(); else window.removeEventListener('resize', resize);
      document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('webkitfullscreenchange', onFsChange);
      if (renderer) { renderer.dispose(); try { renderer.forceContextLoss(); } catch (e) { /* */ } }
      root.remove();
    },
    // for tests / integration
    _debug: () => ({ tod, shown: cur && cur.shown && cur.shown.split('/').pop(), yaw, pitch, fov, idx: cur && cur.idx, pkg: cur && cur.pkg, id: cur && cur.list[cur.idx] && cur.list[cur.idx].id, links: hsItems.map(h => h.idx), fwd: fwdIdx, cached: [...fullCache.map.keys()].length })
  };
}

// ═══════════════════════════════════ GALLERY ═══════════════════════════════════
export async function createGallery(container, { manifestUrl = defaultManifestUrl(), lang, unitId = null, packageId = null, include = 'all', timeOfDay, onOpenPano } = {}) {
  injectCSS();
  let L = normLang(lang);
  let tod = normTod(timeOfDay);
  const tr = (k) => (T[L] && T[L][k]) || T.en[k] || k;
  const filter = { unitId, packageId, include };
  const canPano = typeof onOpenPano === 'function';
  const root = el('div', 'tr-gal');
  container.appendChild(root);
  const lb = el('div', 'tr-lb');
  lb.setAttribute('role', 'dialog');
  lb.setAttribute('aria-modal', 'true');
  const track = el('div', 'tr-lbtrack');
  const lbBar = el('div', 'tr-lbbar');
  const counter = el('div', 'tr-cap');
  const lbRight = el('div', 'tr-lbr');
  const lb360 = el('button', 'tr-btn tr-lb360', ICON.pano + '<span>360°</span>'); lb360.type = 'button';
  const lbClose = el('button', 'tr-btn', ICON.close); lbClose.type = 'button';
  const mkTod = () => {
    const box = el('div', 'tr-tod');
    box.setAttribute('role', 'group');
    for (const id of TODS) {
      const b = el('button', 'tr-todb', ICON[id]);
      b.type = 'button'; b.dataset.tod = id;
      b.addEventListener('click', (e) => { e.stopPropagation(); if (!b.disabled) setTod(id); });
      box.append(b);
    }
    return box;
  };
  const lbTod = mkTod(), gridTod = mkTod();
  lbRight.append(lbTod, lb360, lbClose);
  lbBar.append(counter, lbRight);
  const lbPrev = el('button', 'tr-btn tr-lbnav tr-p', ICON.prev); lbPrev.type = 'button';
  const lbNext = el('button', 'tr-btn tr-lbnav tr-n', ICON.next); lbNext.type = 'button';
  const lbCap = el('div', 'tr-lbcap');
  lb.append(track, lbBar, lbPrev, lbNext, lbCap);
  document.body.appendChild(lb);
  let manifest = null, items = [], idx = 0, openFlag = false, disposed = false;

  const nrm = (v) => String(v || '').trim().toLowerCase();
  function findPano(it) {
    if (!canPano || it.group !== 'interior' || !manifest) return null;
    const e = manifest.units[it.unitId] && manifest.units[it.unitId][it.pkg];
    if (!e || !e.panos.length) return null;
    let p = it.panoId ? e.panos.find(q => q.id === it.panoId) : null;
    if (!p && it.roomId) p = e.panos.find(q => q.roomId === it.roomId);
    if (!p && !it.roomId && !it.panoId) {
      const n = nrm(pick(it.name, 'en'));
      if (n) p = e.panos.find(q => nrm(pick(q.name, 'en')) === n || (q.roomId && ROOM_BY_ID.get(q.roomId) && nrm(ROOM_BY_ID.get(q.roomId).name.en) === n));
    }
    return p ? { unitId: it.unitId, packageId: it.pkg, roomId: p.roomId || p.id, panoId: p.id } : null;
  }
  function collect() {
    const out = [];
    if (!manifest) return out;
    const wantExt = filter.include === 'all' || filter.include === 'exterior';
    const wantInt = filter.include === 'all' || filter.include === 'interior';
    if (wantExt) for (const s of manifest.exterior) if (!s.pano) out.push({ ...s, group: 'exterior' });
    if (wantInt) {
      const uids = filter.unitId ? [filter.unitId] : Object.keys(manifest.units).sort();
      for (const u of uids) {
        const um = manifest.units[u];
        if (!um) continue;
        const pids = filter.packageId ? [filter.packageId] : STYLES.map(s => s.id).filter(id => um[id]).concat(Object.keys(um).filter(k => !STYLES.some(s => s.id === k)));
        for (const p of pids) if (um[p]) for (const s of um[p].stills) out.push({ ...s, group: 'interior', unitId: u, pkg: p });
      }
    }
    for (const it of out) it.match = findPano(it);
    return out;
  }
  const styleName = (id) => { const s = STYLES.find(x => x.id === id); return s ? pick(s.name, L) : id; };
  function caption(it, inLb) {
    const n = pick(it.name, L);
    if (it.group === 'exterior') return n || tr('exterior');
    return [n, it.unitId && !filter.unitId && !inLb ? tr('apartment') + ' ' + it.unitId : '', it.pkg && !filter.packageId ? styleName(it.pkg).split(' · ')[0] : ''].filter(Boolean).join(' · ');
  }
  function syncTod() {
    const has = (k) => k === 'day' || items.some(it => it.variants && it.variants[k]);
    const any = has('dusk') || has('night');
    for (const box of [lbTod, gridTod]) {
      box.hidden = !any;
      box.setAttribute('aria-label', tr('light'));
      for (const b of box.children) {
        const id = b.dataset.tod;
        b.disabled = !has(id);
        b.setAttribute('aria-pressed', String(id === tod));
        b.setAttribute('aria-label', tr(id)); b.title = tr(id);
      }
    }
    return any;
  }
  function render() {
    root.innerHTML = '';
    root.dir = L === 'he' ? 'rtl' : 'ltr';
    root.setAttribute('lang', L);
    items = collect();
    if (!items.length) {
      const e = el('div', 'tr-gempty', ICON.aperture);
      const b = el('b'); b.textContent = tr('emptyTitle');
      const p = el('p'); p.textContent = filter.unitId ? tr('emptyBody').replace('{u}', filter.unitId) : tr('emptyBodyAll');
      const c = el('div', 'tr-cap'); c.textContent = tr('emptyCap');
      e.append(c, b, p);
      root.append(e);
      return;
    }
    if (syncTod()) { const tools = el('div', 'tr-gtools'); tools.append(gridTod); root.append(tools); }
    const groups = [['exterior', tr('exterior')], ['interior', tr('interior')]];
    for (const [g, title] of groups) {
      const list = items.map((it, i) => [it, i]).filter(([it]) => it.group === g);
      if (!list.length) continue;
      const sec = el('section', 'tr-gsec');
      const h = el('div', 'tr-gh');
      const h3 = el('h3'); h3.textContent = title;
      const n = el('span'); n.textContent = String(list.length);
      h.append(h3, n);
      const grid = el('div', 'tr-grid');
      for (const [it, i] of list) {
        const b = el('button', 'tr-gi');
        b.type = 'button';
        const img = new Image();
        img.loading = 'lazy'; img.decoding = 'async'; img.alt = caption(it);
        img.onload = () => img.classList.add('tr-ld');
        img.src = srcFor(it, tod).thumb || srcFor(it, tod).file;
        const fc = el('figcaption'); fc.textContent = caption(it); fc.dir = 'auto';
        b.append(img, fc);
        if (it.match) b.append(el('span', 'tr-g360', ICON.pano + '<span>360°</span>'));
        b.addEventListener('click', () => openAt(i));
        grid.append(b);
      }
      sec.append(h, grid);
      root.append(sec);
    }
  }
  function setTod(id) {
    id = normTod(id);
    if (id === tod) return;
    tod = id;
    render();
    if (openFlag) { buildSlides(); show(idx, false); }
  }

  // ── lightbox ──
  const slides = [];
  let zoom = null;   // { z:HTMLElement, tx, ty, w, h } when the current slide is zoomed 2×
  function buildSlides() {
    track.innerHTML = '';
    slides.length = 0;
    zoom = null;
    for (let i = 0; i < items.length; i++) { const s = el('div', 'tr-lbs'); track.append(s); slides.push(s); }
  }
  function fillSlide(i) {
    const s = slides[i];
    if (!s || s.dataset.f) return;
    s.dataset.f = '1';
    const it = items[i], src = srcFor(it, tod);
    const z = el('div', 'tr-lbz');
    const th = new Image(); th.className = 'tr-th'; th.src = src.thumb || src.file; th.alt = ''; th.draggable = false;
    const full = new Image(); full.className = 'tr-full'; full.decoding = 'async'; full.alt = caption(it); full.draggable = false;
    full.onload = () => { full.classList.add('tr-ld'); setTimeout(() => { th.style.opacity = '0'; }, 400); };
    full.src = src.file;
    z.append(th, full);
    s.append(z);
  }
  function place(animate, extra = 0) {
    const w = lb.clientWidth || innerWidth;
    track.style.transition = animate ? 'transform .38s cubic-bezier(.2,.7,.2,1)' : 'none';
    track.style.transform = `translate3d(${-idx * w + extra}px,0,0)`;
  }
  function resetZoom(animate) {
    if (!zoom) return;
    zoom.z.style.transition = animate ? 'transform .3s cubic-bezier(.2,.7,.2,1)' : 'none';
    zoom.z.style.transform = '';
    zoom = null;
    lb.style.cursor = '';
  }
  function applyZoom(animate) {
    zoom.tx = clamp(zoom.tx, -zoom.w, 0); zoom.ty = clamp(zoom.ty, -zoom.h, 0);
    zoom.z.style.transition = animate ? 'transform .3s cubic-bezier(.2,.7,.2,1)' : 'none';
    zoom.z.style.transform = `translate3d(${zoom.tx}px,${zoom.ty}px,0) scale(2)`;
  }
  function toggleZoom(cx, cy) {
    if (zoom) { resetZoom(true); return; }
    const s = slides[idx], z = s && s.querySelector('.tr-lbz');
    if (!z) return;
    const r = z.getBoundingClientRect();
    const px = clamp(cx - r.left, 0, r.width), py = clamp(cy - r.top, 0, r.height);
    zoom = { z, tx: -px, ty: -py, w: r.width, h: r.height };   // scale 2 about the tapped point
    lb.style.cursor = 'grab';
    applyZoom(true);
  }
  function show(i, animate = true) {
    if (!items.length) return;
    resetZoom(false);
    idx = (i + items.length) % items.length;
    fillSlide(idx); fillSlide((idx + 1) % items.length); fillSlide((idx - 1 + items.length) % items.length);
    place(animate);
    counter.textContent = `${idx + 1} ${tr('of')} ${items.length}`;
    const it = items[idx];
    lb360.hidden = !it.match;
    const eff = srcFor(it, tod).tod;   // highlight the state actually shown for this still
    for (const b of lbTod.children) b.setAttribute('aria-pressed', String(b.dataset.tod === eff));
    lbCap.innerHTML = '';
    const c = el('span', 'tr-cap'); c.textContent = it.group === 'exterior' ? tr('exterior') : (it.unitId ? tr('apartment') + ' ' + it.unitId : tr('interior'));
    const t = el('span'); t.textContent = caption(it, true); t.dir = 'auto';
    lbCap.append(c, t);
  }
  function openAt(i) {
    if (!items.length) return;
    openFlag = true;
    lb.dir = L === 'he' ? 'rtl' : 'ltr';
    lbClose.setAttribute('aria-label', tr('close')); lbPrev.setAttribute('aria-label', tr('prev')); lbNext.setAttribute('aria-label', tr('next'));
    lb360.setAttribute('aria-label', tr('open360')); lb360.title = tr('open360');
    syncTod();
    lb.classList.add('tr-on');
    buildSlides();
    show(i, false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
  }
  function closeLb() {
    if (!openFlag) return;
    openFlag = false;
    lb.classList.remove('tr-on');
    track.innerHTML = '';
    zoom = null;
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
  }
  function openPano() {
    const it = items[idx];
    if (!it || !it.match || !canPano) return false;
    const m = { unitId: it.match.unitId, packageId: it.match.packageId, roomId: it.match.roomId, panoId: it.match.panoId, timeOfDay: tod };
    closeLb();
    try { onOpenPano(m); } catch (e) { /* */ }
    return true;
  }
  const rtl = () => L === 'he';
  function onKey(e) {
    if (e.key === 'Escape') closeLb();
    else if (e.key === 'ArrowRight') show(idx + 1);
    else if (e.key === 'ArrowLeft') show(idx - 1);
  }
  const onResize = () => { resetZoom(false); place(false); };
  lbClose.addEventListener('click', closeLb);
  lb360.addEventListener('click', openPano);
  lbPrev.addEventListener('click', () => show(rtl() ? idx + 1 : idx - 1));
  lbNext.addEventListener('click', () => show(rtl() ? idx - 1 : idx + 1));
  // gestures: swipe = previous/next · double-tap (hand-rolled: 2 taps < 350 ms, < 30 px) = open the matching 360° pano, else zoom 2× at the point
  let g = null, lastTap = null;
  const pts = new Set();
  function down(e) {
    if (e.target.closest && e.target.closest('.tr-btn,.tr-tod')) return;
    pts.add(e.pointerId);
    if (pts.size > 1) { g = null; return; }
    g = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, id: e.pointerId, dx: 0, t: performance.now() };
    try { lb.setPointerCapture(e.pointerId); } catch (er) { /* */ }
  }
  function move(e) {
    if (!g || g.id !== e.pointerId) return;
    if (zoom) {
      zoom.tx += e.clientX - g.lx; zoom.ty += e.clientY - g.ly;
      applyZoom(false);
    } else {
      g.dx = e.clientX - g.x;
      if (Math.abs(g.dx) > 6) place(false, g.dx);
    }
    g.lx = e.clientX; g.ly = e.clientY;
  }
  function up(e) {
    pts.delete(e.pointerId);
    if (!g || g.id !== e.pointerId) return;
    const d = g; g = null;
    const now = performance.now();
    const dist = Math.hypot(e.clientX - d.x, e.clientY - d.y);
    if (dist < 12 && now - d.t < DTAP_MS) {
      if (!zoom) place(true);
      if (lastTap && now - lastTap.t < DTAP_MS && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < DTAP_PX) {
        lastTap = null;
        if (!openPano()) toggleZoom(e.clientX, e.clientY);
      } else lastTap = { t: now, x: e.clientX, y: e.clientY };
      return;
    }
    if (zoom) return;
    const w = lb.clientWidth || innerWidth;
    const fast = Math.abs(d.dx) > 30 && now - d.t < 300;
    if (Math.abs(d.dx) > w * 0.18 || fast) show(d.dx < 0 ? idx + 1 : idx - 1);
    else place(true);
  }
  if (typeof window !== 'undefined' && window.PointerEvent) {
    lb.addEventListener('pointerdown', down);
    lb.addEventListener('pointermove', move);
    lb.addEventListener('pointerup', up);
    lb.addEventListener('pointercancel', up);
  } else {
    const each = (fn) => (e) => { for (const t of e.changedTouches) fn({ pointerId: t.identifier, clientX: t.clientX, clientY: t.clientY, target: e.target }); };
    lb.addEventListener('touchstart', each(down), { passive: true });
    lb.addEventListener('touchmove', each(move), { passive: true });
    lb.addEventListener('touchend', each(up));
    lb.addEventListener('touchcancel', each(up));
  }
  lb.addEventListener('dblclick', (e) => e.preventDefault());
  lb.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });

  manifest = await loadManifest(manifestUrl);
  if (!disposed) render();
  return {
    setLang(l) { L = normLang(l); render(); if (openFlag) show(idx, false); },
    setFilter(f = {}) { Object.assign(filter, f); render(); },
    setTimeOfDay: (id) => setTod(id),
    getTimeOfDay: () => tod,
    async refresh() { manifest = await loadManifest(manifestUrl, true); render(); },
    open: (i = 0) => openAt(i),
    close: closeLb,
    count: () => items.length,
    dispose() { disposed = true; closeLb(); lb.remove(); root.remove(); },
    _debug: () => ({ idx, tod, zoomed: !!zoom, open: openFlag, match: items[idx] && items[idx].match })
  };
}
