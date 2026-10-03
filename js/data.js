// VILNYI · Barreiro 2 — single source of truth for every module.
// Units: metres. Coordinates (three.js world):
//   x  = east  (0 = west/left party wall as seen from the street, grows to the right/east)
//   z  = south (0 = REAR façade facing the garden/north, 14.70 = STREET façade on Rua Eduardo Couto)
//   y  = up    (0 = ground-floor finished level, +12.70 on the drawings)
// Looking from the street you face north (-z). The Tejo estuary and Lisbon are to the north.

export const PROJECT = {
  name: 'Barreiro 2',
  brand: 'VILNYI',
  developer: 'VILNYI, Unipessoal Lda',
  address: 'Rua Eduardo Couto, Lavradio',
  postcode: '2835-432 Lavradio, Barreiro',
  region: 'Setúbal · Lisbon Metropolitan Area',
  // Exact plot centre, located from OpenStreetMap: the 13.8 m gap on Rua Eduardo Couto
  // between the houses at local x -12..0 (west, pink) and x 16.7..27.7 (east, white).
  lat: 38.668462,
  lon: -9.047975,
  googleMaps: 'https://www.google.com/maps/search/?api=1&query=38.668462,-9.047975',
  googleEarth: 'https://earth.google.com/web/@38.668462,-9.047975,15a,250d,35y,331h,60t,0r',
  googleMapsKey: '',   // optional: Google Maps Platform key (Map Tiles API) for real Google 3D tiles on a self-hosted copy — see GOOGLE3D.md
  streetView: 'https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=38.668340,-9.047900&heading=331&pitch=5&fov=80',
  stage: 'Preliminary study · September 2026',
  // Indicative programme — edit when licensing dates are known
  timeline: [
    { key: 'pip',     date: 'Q4 2027', label: { en: 'Planning information request (PIP)', pt: 'Pedido de informação prévia (PIP)', he: 'בקשת מידע תכנוני (PIP)' } },
    { key: 'licence', date: 'Q2 2028', label: { en: 'Building licence', pt: 'Licença de construção', he: 'היתר בנייה' } },
    { key: 'start',   date: 'Q3 2028', label: { en: 'Construction starts', pt: 'Início da obra', he: 'תחילת בנייה' } },
    { key: 'topout',  date: 'Q2 2029', label: { en: 'Structure complete', pt: 'Estrutura concluída', he: 'סיום שלד' } },
    { key: 'keys',    date: 'Q4 2029', label: { en: 'Keys handed over', pt: 'Entrega de chaves', he: 'מסירת מפתחות' } }
  ],
  contact: {
    company: 'G-International',
    email: '',                       // G-International's sales email — not published on their website; fill in
    phone: '+972 50 599 9983',
    whatsapp: '972505999983',
    website: 'https://g-international.co.il/en/',
    facebook: 'https://www.facebook.com/g.international.il',
    instagram: 'https://www.instagram.com/g_international__/'
  }
};

// Bank details for the reservation deposit. Left blank on purpose: the site shows
// "sent with your reservation confirmation" until these are filled in.
export const BANK = {
  beneficiary: 'VILNYI, Unipessoal Lda',
  bank: '',       // e.g. 'Millennium bcp'
  iban: '',       // e.g. 'PT50 …'
  bic: '',
  nif: ''         // company tax number
};

// Payment plan (typical Portuguese off-plan sale). Percentages of the price.
export const PAYMENT_PLAN = {
  reservationFee: 5000, // € on reservation, deducted from the 1st instalment
  steps: [
    { pct: 20, key: 'cpcv',   label: { en: 'Promissory contract (CPCV) — within 30 days', pt: 'Contrato-promessa (CPCV) — até 30 dias', he: 'חוזה התחייבות (CPCV) — תוך 30 יום' } },
    { pct: 10, key: 'struct', label: { en: 'Structure complete', pt: 'Conclusão da estrutura', he: 'סיום שלד' } },
    { pct: 70, key: 'deed',   label: { en: 'Deed (escritura) at completion', pt: 'Escritura na conclusão', he: 'חתימת שטר (אסקריטורה) במסירה' } }
  ]
};

// Vertical datums
export const LEVELS = {
  basement: { y: -2.70, ceiling: 2.40, label: '-1', drawing: '+10.00' },
  ground:   { y: 0.00,  ceiling: 2.70, label: '0',  drawing: '+12.70' },
  first:    { y: 3.00,  ceiling: 2.70, label: '1',  drawing: '+15.70' },
  second:   { y: 6.00,  ceiling: 2.70, label: '2',  drawing: '+18.70', mansard: true },
  roof:     { y: 9.30,  label: 'R', drawing: '+22.00' }
};
export const SLAB = 0.30;             // structural slab thickness
export const STREET_Y = -0.85;        // pavement level (+11.85)
export const CORNICE_Y = 6.40;        // mansard starts (+19.10)
export const MANSARD_PITCH = 72;      // degrees
export const LOT = { x0: -0.2, x1: 14.2, zRear: -7.9, zFront: 17.4 }; // plot boundary
export const STREET = { zKerb: 17.4, zFar: 26.0, width: 7.0 };      // road runs east-west

// Building outline (clockwise, plan view). Right side angles out towards the street.
export const FOOTPRINT = [[0, 0], [12.2, 0], [13.88, 4.9], [13.88, 14.7], [0, 14.7]];

// Circulation core — stacked on every level
export const CORE = {
  lift:   { x0: 0.25, x1: 1.55, z0: 7.15, z1: 8.85, cab: { w: 1.1, d: 1.4 }, doorOnX: 1.55, doorZ: [7.55, 8.45] },
  stairs: { x0: 0.25, x1: 2.75, z0: 8.95, z1: 13.55, flights: 2, riser: 0.1765 }, // 17 risers per 3.00 m
  landing:{ x0: 1.55, x1: 7.40, z0: 7.15, z1: 8.70 }
};

// Wall segments. a,b = [x,z]; t = thickness; kind: 'ext' | 'party' | 'core' | 'part' (partition)
// openings: along = distance from a in metres; type:
//   'door' (0.9 x 2.1 swing) | 'entry' (apartment front door, 1.0 x 2.2) | 'elevator' (1.0 x 2.1 sliding)
//   'window' (sill 0.9, head 2.3) | 'glassdoor' (floor to 2.5, sliding) | 'opening' (no leaf, to 2.3) | 'slit' (0.35 wide, 0.2..2.6)
//   'garage' (sectional door) | 'main' (building entrance, glazed, 1.5 x 2.4)
const W = (a, b, t, kind, openings = []) => ({ a, b, t, kind, openings });
const O = (from, to, type) => ({ from, to, type });

function upperWalls(level) {
  const m = level === 'second';
  const ext = (a, b, openings) => ({ ...W(a, b, 0.30, 'ext', openings), mansard: m && (a[1] === 0 && b[1] === 0 || a[1] === 14.7 && b[1] === 14.7) });
  return [
    // exterior
    ext([0, 0], [12.2, 0], [O(1.95, 2.75, 'window'), O(3.10, 5.90, 'glassdoor'), O(6.30, 9.60, 'glassdoor'), O(10.10, 11.20, 'window')]),
    W([12.2, 0], [13.88, 4.9], 0.30, 'ext', [O(2.0, 3.2, 'window')]),
    W([13.88, 4.9], [13.88, 14.7], 0.30, 'ext', [O(2.2, 3.4, 'window'), O(5.4, 6.6, 'window')]),
    ext([13.88, 14.7], [0, 14.7], [O(0.70, 3.70, 'glassdoor'), O(4.70, 7.10, 'glassdoor'), O(7.70, 10.60, 'glassdoor'), O(12.30, 12.65, 'slit')]),
    W([0, 14.7], [0, 0], 0.30, 'party'),
    // rear apartments A | B
    W([2.9, 0], [2.9, 5.4], 0.12, 'part', [O(4.3, 5.1, 'door')]),
    W([6.1, 0], [6.1, 7.15], 0.20, 'party'),
    W([9.8, 0], [9.8, 5.4], 0.12, 'part', [O(3.9, 4.7, 'door')]),
    W([0, 5.4], [6.1, 5.4], 0.12, 'part', [O(1.0, 1.75, 'door'), O(4.15, 4.9, 'door'), O(5.1, 6.0, 'opening')]),
    W([6.1, 5.4], [13.88, 5.4], 0.12, 'part', [O(0.15, 1.25, 'opening'), O(1.9, 2.6, 'door')]),
    W([2.2, 5.4], [2.2, 7.15], 0.12, 'part'),
    W([5.0, 5.4], [5.0, 7.15], 0.12, 'part'),
    W([7.4, 5.4], [7.4, 8.7], 0.12, 'part'),
    // corridor / core
    W([1.55, 7.15], [9.5, 7.15], 0.20, 'core', [O(3.65, 4.45, 'entry'), O(4.75, 5.65, 'entry')]),
    W([1.55, 7.15], [1.55, 8.85], 0.20, 'core', [O(0.40, 1.30, 'elevator')]),
    W([0, 8.9], [1.55, 8.9], 0.20, 'core'),
    W([2.75, 8.7], [7.4, 8.7], 0.20, 'core', [O(2.05, 2.95, 'entry')]),
    W([2.75, 8.7], [2.75, 14.7], 0.20, 'core'),
    // apartment C (T2, street side)
    W([7.4, 9.2], [9.5, 9.2], 0.12, 'part', [O(0.4, 1.1, 'door')]),
    W([9.5, 7.15], [9.5, 9.2], 0.12, 'part'),
    W([9.8, 5.4], [9.8, 7.15], 0.12, 'part'),
    W([2.75, 11.2], [9.5, 11.2], 0.12, 'part', [O(2.35, 3.05, 'door'), O(4.05, 4.75, 'door')]),
    W([6.5, 11.2], [6.5, 14.7], 0.12, 'part'),
    W([9.5, 11.2], [9.5, 14.7], 0.12, 'part')
  ];
}

function groundWalls() {
  return [
    W([0, 0], [12.2, 0], 0.30, 'ext', [O(1.95, 2.75, 'window'), O(3.10, 5.90, 'glassdoor'), O(6.30, 9.60, 'glassdoor'), O(10.10, 11.20, 'window')]),
    W([12.2, 0], [13.88, 4.9], 0.30, 'ext', [O(2.0, 3.2, 'window')]),
    W([13.88, 4.9], [13.88, 14.7], 0.30, 'ext', [O(1.0, 2.2, 'window')]),
    // street front: garage (ramp void) · lobby entrance · stair slit
    W([13.88, 14.7], [0, 14.7], 0.30, 'ext', [O(0.45, 3.45, 'garage'), O(5.2, 6.4, 'window'), O(8.7, 10.2, 'main'), O(12.30, 12.65, 'slit')]),
    W([0, 14.7], [0, 0], 0.30, 'party'),
    // 0.A (same as upper A)
    W([2.9, 0], [2.9, 5.4], 0.12, 'part', [O(4.3, 5.1, 'door')]),
    W([6.1, 0], [6.1, 7.15], 0.20, 'party'),
    W([0, 5.4], [6.1, 5.4], 0.12, 'part', [O(1.0, 1.75, 'door'), O(4.15, 4.9, 'door'), O(5.1, 6.0, 'opening')]),
    W([2.2, 5.4], [2.2, 7.15], 0.12, 'part'),
    W([5.0, 5.4], [5.0, 7.15], 0.12, 'part'),
    // 0.B (T2): sala + bedroom rear, passage, suite over the ramp side
    W([9.8, 0], [9.8, 5.4], 0.12, 'part', [O(3.9, 4.7, 'door')]),
    W([6.1, 5.4], [13.88, 5.4], 0.12, 'part', [O(0.15, 1.9, 'opening'), O(2.6, 3.3, 'door')]),
    W([8.2, 5.4], [8.2, 7.15], 0.12, 'part'),
    W([7.4, 7.15], [7.4, 9.2], 0.20, 'core'),
    W([9.5, 5.4], [9.5, 9.2], 0.12, 'part', [O(2.1, 2.9, 'door')]),
    W([7.4, 9.2], [13.88, 9.2], 0.20, 'core'),
    // core / lobby
    W([1.55, 7.15], [8.2, 7.15], 0.20, 'core', [O(3.65, 4.45, 'entry'), O(4.75, 5.65, 'entry'), O(5.95, 6.55, 'opening')]),
    W([8.2, 7.15], [9.5, 7.15], 0.12, 'part'),
    W([1.55, 7.15], [1.55, 8.85], 0.20, 'core', [O(0.40, 1.30, 'elevator')]),
    W([0, 8.9], [1.55, 8.9], 0.20, 'core'),
    W([2.75, 9.2], [2.75, 14.7], 0.20, 'core', [O(0.3, 1.9, 'opening')]),
    W([9.5, 9.2], [9.5, 14.7], 0.20, 'core') // lobby | ramp void (glazed screen optional)
  ];
}

function basementWalls() {
  return [
    W([0, -7.9], [8.2, -7.9], 0.35, 'ext'),
    W([8.2, -7.9], [10.9, 1.9], 0.35, 'ext'),
    W([10.9, 1.9], [13.88, 1.9], 0.35, 'ext'),
    W([13.88, 1.9], [13.88, 14.7], 0.35, 'ext'),
    W([0, 14.7], [0, -7.9], 0.35, 'ext'),
    W([2.75, 14.7], [13.88, 14.7], 0.35, 'ext', [O(7.65, 10.65, 'garage')]), // measured from a → x 10.4–13.4, under the ramp
    W([0, 14.7], [2.75, 14.7], 0.35, 'ext'),
    W([1.55, 7.15], [1.55, 8.85], 0.20, 'core', [O(0.40, 1.30, 'elevator')]),
    W([0, 7.15], [1.55, 7.15], 0.20, 'core'),
    W([0, 8.9], [1.55, 8.9], 0.20, 'core'),
    W([2.75, 8.95], [2.75, 13.55], 0.20, 'core', [O(0.2, 1.1, 'door')]),
    W([2.9, 9.0], [5.4, 9.0], 0.20, 'core', [O(0.9, 1.7, 'door')]),   // technical room
    W([5.4, 9.0], [5.4, 12.0], 0.20, 'core'),
    W([2.75, 12.0], [5.4, 12.0], 0.20, 'core')
  ];
}

// Rooms: polygon in plan (x,z). use: living | kitchen-living | bedroom | suite | bath | wc | hall | landing | lobby | stairs | lift | balcony | garden | parking | technical | ramp
const R = (id, unit, use, poly, name) => ({ id, unit, use, poly, name });
const rect = (x0, z0, x1, z1) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];

function upperRooms(f) {
  const p = (s) => `${f}.${s}`;
  return [
    R(p('A-suite'), p('A'), 'suite', rect(0.15, 0.15, 2.84, 5.34), { en: 'Master suite', pt: 'Suite', he: 'סוויטת הורים' }),
    R(p('A-living'), p('A'), 'kitchen-living', rect(2.96, 0.15, 6.0, 5.34), { en: 'Living & kitchen', pt: 'Sala / cozinha', he: 'סלון ומטבח' }),
    R(p('A-ensuite'), p('A'), 'bath', rect(0.15, 5.46, 2.14, 7.05), { en: 'En-suite bathroom', pt: 'I.S. suite', he: 'חדר רחצה צמוד' }),
    R(p('A-wc'), p('A'), 'wc', rect(2.26, 5.46, 4.94, 7.05), { en: 'Guest bathroom', pt: 'I.S. serviço', he: 'חדר רחצה אורחים' }),
    R(p('A-hall'), p('A'), 'hall', rect(5.06, 5.46, 6.0, 7.05), { en: 'Entrance hall', pt: 'Hall', he: 'מבואה' }),
    R(p('B-living'), p('B'), 'kitchen-living', rect(6.2, 0.15, 9.74, 5.34), { en: 'Living & kitchen', pt: 'Sala / cozinha', he: 'סלון ומטבח' }),
    R(p('B-bed'), p('B'), 'bedroom', [[9.86, 0.15], [12.1, 0.15], [13.72, 4.9], [13.72, 5.34], [9.86, 5.34]], { en: 'Bedroom', pt: 'Quarto', he: 'חדר שינה' }),
    R(p('B-hall'), p('B'), 'hall', rect(6.2, 5.46, 7.34, 7.05), { en: 'Entrance hall', pt: 'Hall', he: 'מבואה' }),
    R(p('B-wc'), p('B'), 'bath', rect(7.46, 5.46, 9.74, 7.05), { en: 'Bathroom', pt: 'I.S.', he: 'חדר רחצה' }),
    R(p('C-hall'), p('C'), 'hall', [[2.85, 8.8], [7.4, 8.8], [7.4, 9.26], [9.44, 9.26], [9.44, 11.14], [2.85, 11.14]], { en: 'Hall', pt: 'Hall', he: 'מסדרון' }),
    R(p('C-wc'), p('C'), 'bath', rect(7.46, 7.25, 9.44, 9.14), { en: 'Bathroom', pt: 'I.S.', he: 'חדר רחצה' }),
    R(p('C-living'), p('C'), 'kitchen-living', rect(9.56, 5.46, 13.72, 14.55), { en: 'Living & kitchen', pt: 'Sala / cozinha', he: 'סלון ומטבח' }),
    R(p('C-bed1'), p('C'), 'suite', rect(2.85, 11.26, 6.44, 14.55), { en: 'Main bedroom', pt: 'Quarto', he: 'חדר שינה ראשי' }),
    R(p('C-bed2'), p('C'), 'bedroom', rect(6.56, 11.26, 9.44, 14.55), { en: 'Bedroom 2', pt: 'Quarto 2', he: 'חדר שינה 2' }),
    R(p('landing'), null, 'landing', rect(1.65, 7.25, 7.34, 8.6), { en: 'Landing', pt: 'Patamar', he: 'מבואת קומה' }),
    R(p('stairs'), null, 'stairs', rect(0.25, 8.95, 2.75, 13.55), { en: 'Stairs', pt: 'Escadas', he: 'חדר מדרגות' }),
    R(p('lift'), null, 'lift', rect(0.25, 7.15, 1.55, 8.85), { en: 'Lift', pt: 'Elevador', he: 'מעלית' })
  ];
}

function groundRooms() {
  return [
    R('0.A-suite', '0.A', 'suite', rect(0.15, 0.15, 2.84, 5.34), { en: 'Master suite', pt: 'Suite', he: 'סוויטת הורים' }),
    R('0.A-living', '0.A', 'kitchen-living', rect(2.96, 0.15, 6.0, 5.34), { en: 'Living & kitchen', pt: 'Sala / cozinha', he: 'סלון ומטבח' }),
    R('0.A-ensuite', '0.A', 'bath', rect(0.15, 5.46, 2.14, 7.05), { en: 'En-suite bathroom', pt: 'I.S. suite', he: 'חדר רחצה צמוד' }),
    R('0.A-wc', '0.A', 'wc', rect(2.26, 5.46, 4.94, 7.05), { en: 'Guest bathroom', pt: 'I.S. serviço', he: 'חדר רחצה אורחים' }),
    R('0.A-hall', '0.A', 'hall', rect(5.06, 5.46, 6.0, 7.05), { en: 'Entrance hall', pt: 'Hall', he: 'מבואה' }),
    R('0.A-garden', '0.A', 'garden', rect(0.15, -7.75, 6.0, -0.15), { en: 'Private garden & deck', pt: 'Jardim privado', he: 'גינה פרטית ודק' }),
    R('0.B-living', '0.B', 'kitchen-living', rect(6.2, 0.15, 9.74, 5.34), { en: 'Living & kitchen', pt: 'Sala / cozinha', he: 'סלון ומטבח' }),
    R('0.B-bed', '0.B', 'bedroom', [[9.86, 0.15], [12.1, 0.15], [13.72, 4.9], [13.72, 5.34], [9.86, 5.34]], { en: 'Bedroom', pt: 'Quarto', he: 'חדר שינה' }),
    R('0.B-hall', '0.B', 'hall', [[6.2, 5.46], [8.14, 5.46], [8.14, 7.25], [9.44, 7.25], [9.44, 9.1], [7.5, 9.1], [7.5, 7.05], [6.2, 7.05]], { en: 'Hall', pt: 'Hall', he: 'מבואה' }),
    R('0.B-wc', '0.B', 'bath', rect(8.26, 5.46, 9.44, 7.05), { en: 'Bathroom', pt: 'I.S.', he: 'חדר רחצה' }),
    R('0.B-suite', '0.B', 'suite', rect(9.56, 5.46, 13.72, 9.1), { en: 'Suite', pt: 'Suite', he: 'סוויטה' }),
    R('0.B-garden', '0.B', 'garden', [[6.2, -7.75], [8.1, -7.75], [10.8, 1.9], [12.1, -0.15], [6.2, -0.15]], { en: 'Private garden & deck', pt: 'Jardim privado', he: 'גינה פרטית ודק' }),
    R('0.lobby', null, 'lobby', rect(2.85, 9.3, 9.4, 14.55), { en: 'Entrance lobby', pt: 'Átrio', he: 'לובי כניסה' }),
    R('0.landing', null, 'landing', rect(1.65, 7.25, 7.3, 9.2), { en: 'Lift lobby', pt: 'Patamar', he: 'מבואת מעלית' }),
    R('0.stairs', null, 'stairs', rect(0.25, 8.95, 2.75, 13.55), { en: 'Stairs', pt: 'Escadas', he: 'חדר מדרגות' }),
    R('0.lift', null, 'lift', rect(0.25, 7.15, 1.55, 8.85), { en: 'Lift', pt: 'Elevador', he: 'מעלית' }),
    R('0.ramp', null, 'ramp', rect(9.6, 9.3, 13.8, 17.4), { en: 'Car ramp (15%)', pt: 'Rampa (15%)', he: 'רמפת חניון' })
  ];
}

function basementRooms() {
  return [
    R('B.parking', null, 'parking', [[0.2, -7.7], [8.0, -7.7], [10.7, 2.1], [13.7, 2.1], [13.7, 14.5], [2.9, 14.5], [2.9, 9.0], [1.6, 9.0], [1.6, 7.0], [0.2, 7.0]], { en: 'Car park · 8 spaces', pt: 'Estacionamento · 8 lugares', he: 'חניון · 8 מקומות' }),
    R('B.tech', null, 'technical', rect(2.95, 9.1, 5.3, 11.9), { en: 'Technical room', pt: 'Área técnica', he: 'חדר טכני' }),
    R('B.lobby', null, 'landing', rect(1.65, 7.0, 2.75, 9.0), { en: 'Lift lobby', pt: 'Átrio', he: 'מבואת מעלית' }),
    R('B.stairs', null, 'stairs', rect(0.25, 8.95, 2.75, 13.55), { en: 'Stairs', pt: 'Escadas', he: 'חדר מדרגות' }),
    R('B.lift', null, 'lift', rect(0.25, 7.15, 1.55, 8.85), { en: 'Lift', pt: 'Elevador', he: 'מעלית' })
  ];
}

// Parking bays (basement). Bay = 2.35 x 5.00. Each apartment gets one.
export const PARKING = [
  { id: 'P1', x0: 0.35, z0: 1.55, x1: 5.35, z1: 3.9, unit: '0.A' },
  { id: 'P2', x0: 0.35, z0: -0.8, x1: 5.35, z1: 1.55, unit: '0.B' },
  { id: 'P3', x0: 0.35, z0: -3.15, x1: 5.35, z1: -0.8, unit: '1.A' },
  { id: 'P4', x0: 0.35, z0: -5.5, x1: 5.35, z1: -3.15, unit: '1.B' },
  { id: 'P5', x0: 3.2, z0: 3.9, x1: 5.55, z1: 8.9, unit: '1.C', rotated: true },
  { id: 'P6', x0: 0.35, z0: -7.75, x1: 5.35, z1: -5.5, unit: '2.A' },
  { id: 'P7', x0: 5.8, z0: 9.5, x1: 8.15, z1: 14.5, unit: '2.B', rotated: true },
  { id: 'P8', x0: 8.15, z0: 9.5, x1: 10.5, z1: 14.5, unit: '2.C', rotated: true }
];
export const RAMP = { x0: 10.9, x1: 13.7, zTop: 17.4, zBottom: 2.3, slope: 0.15, yTop: STREET_Y, yBottom: -2.70 };

// Balconies & terraces (slab outline, level id, owner unit)
export const BALCONIES = [
  { id: '1.rear', level: 'first', unit: ['1.A', '1.B'], poly: rect(3.1, -1.3, 9.9, 0), split: 6.1, rail: 'glass' },
  { id: '1.front', level: 'first', unit: ['1.C'], poly: rect(2.9, 14.7, 13.4, 16.0), rail: 'glass', planters: true },
  { id: '2.rear.A', level: 'second', unit: ['2.A'], poly: rect(3.1, -1.3, 5.9, 0), rail: 'glass', dormer: true },
  { id: '2.rear.B', level: 'second', unit: ['2.B'], poly: rect(6.3, -1.3, 9.6, 0), rail: 'glass', dormer: true },
  { id: '2.front.1', level: 'second', unit: ['2.C'], poly: rect(6.5, 14.7, 9.3, 15.9), rail: 'glass', dormer: true },
  { id: '2.front.2', level: 'second', unit: ['2.C'], poly: rect(10.2, 14.7, 13.3, 15.9), rail: 'glass', dormer: true },
  { id: '0.deck.A', level: 'ground', unit: ['0.A'], poly: rect(0.2, -2.5, 6.0, 0), deck: true },
  { id: '0.deck.B', level: 'ground', unit: ['0.B'], poly: rect(6.2, -2.5, 11.5, 0), deck: true }
];

export const ROOF = { y: 9.30, pv: { rows: 3, cols: 6, w: 1.13, d: 1.72, tilt: 10 }, skylight: rect(0.4, 9.2, 2.6, 11.4), fall: 0.02 };

export const FLOORS = [
  { id: 'basement', label: { en: 'Basement', pt: 'Cave', he: 'מרתף' }, level: LEVELS.basement, walls: basementWalls(), rooms: basementRooms(), plan: 'assets/plan-b.jpg' },
  { id: 'ground', label: { en: 'Ground floor', pt: 'Rés-do-chão', he: 'קומת קרקע' }, level: LEVELS.ground, walls: groundWalls(), rooms: groundRooms(), plan: 'assets/plan-0.jpg' },
  { id: 'first', label: { en: 'First floor', pt: '1.º andar', he: 'קומה 1' }, level: LEVELS.first, walls: upperWalls('first'), rooms: upperRooms('1'), plan: 'assets/plan-1.jpg' },
  { id: 'second', label: { en: 'Second floor · mansard', pt: '2.º andar · mansarda', he: 'קומה 2 · מנסרדה' }, level: LEVELS.second, walls: upperWalls('second'), rooms: upperRooms('2'), plan: 'assets/plan-2.jpg' }
];

export const PRICE_PER_M2 = 6500; // EUR per m² of interior area — unit prices below = area × this, rounded to €100

// Sales schedule — areas from the preliminary study. Prices are indicative.
export const UNITS = [
  { id: '0.A', floor: 'ground', type: 'T1', beds: 1, baths: 2, area: 42.28, outdoor: 34.5, outdoorKind: 'garden', aspect: ['N'], price: 274800, parking: 'P1', status: 'available', startRoom: '0.A-hall', viewRoom: '0.A-living' },
  { id: '0.B', floor: 'ground', type: 'T2', beds: 2, baths: 1, area: 60.86, outdoor: 41.0, outdoorKind: 'garden', aspect: ['N', 'E'], price: 395600, parking: 'P2', status: 'available', startRoom: '0.B-hall', viewRoom: '0.B-living' },
  { id: '1.A', floor: 'first', type: 'T1', beds: 1, baths: 2, area: 42.28, outdoor: 3.81, outdoorKind: 'balcony', aspect: ['N'], price: 274800, parking: 'P3', status: 'available', startRoom: '1.A-hall', viewRoom: '1.A-living' },
  { id: '1.B', floor: 'first', type: 'T1', beds: 1, baths: 1, area: 43.76, outdoor: 4.65, outdoorKind: 'balcony', aspect: ['N', 'E'], price: 284400, parking: 'P4', status: 'available', startRoom: '1.B-hall', viewRoom: '1.B-living' },
  { id: '1.C', floor: 'first', type: 'T2', beds: 2, baths: 1, area: 57.22, outdoor: 13.6, outdoorKind: 'balcony', aspect: ['S', 'E'], price: 371900, parking: 'P5', status: 'available', startRoom: '1.C-hall', viewRoom: '1.C-living' },
  { id: '2.A', floor: 'second', type: 'T1', beds: 1, baths: 2, area: 41.53, outdoor: 3.6, outdoorKind: 'balcony', aspect: ['N'], price: 269900, parking: 'P6', status: 'available', startRoom: '2.A-hall', viewRoom: '2.A-living' },
  { id: '2.B', floor: 'second', type: 'T1', beds: 1, baths: 1, area: 43.20, outdoor: 4.3, outdoorKind: 'balcony', aspect: ['N', 'E'], price: 280800, parking: 'P7', status: 'available', startRoom: '2.B-hall', viewRoom: '2.B-living' },
  { id: '2.C', floor: 'second', type: 'T2', beds: 2, baths: 1, area: 54.50, outdoor: 7.1, outdoorKind: 'balcony', aspect: ['S', 'E'], price: 354200, parking: 'P8', status: 'available', startRoom: '2.C-hall', viewRoom: '2.C-living' }
];

// Three interior finishes offered for every apartment.
// The three finish options for every apartment. Each option is a complete building-material package
// (floors, walls, bathrooms, kitchen, joinery, ironmongery) with a matching furniture/decor scheme.
// Ids are kept stable (atlantic | lisboa | noir) because every module keys on them.
// `spec` = the materials board shown to buyers; `pbr` = CC0 texture ids per surface (filled by the asset pipeline).
export const STYLES = [
  {
    id: 'atlantic', tier: 'essencial',
    name: { en: 'Essencial · Atlantic Light', pt: 'Essencial · Atlântico', he: 'אסנסיאל · אטלנטי בהיר', ru: 'Essencial · Атлантик' },
    blurb: { en: 'Light engineered oak, stone-look porcelain, white lacquer kitchen with quartz, chrome fittings.', pt: 'Carvalho natural, porcelânico efeito pedra, cozinha lacada branca com quartzo, torneiras cromadas.', he: 'פרקט אלון טבעי, פורצלן במראה אבן, מטבח לכה לבנה עם קוורץ, ברזים בכרום.', ru: 'Светлый дуб, керамогранит под камень, белая кухня с кварцем, хром.' },
    palette: { floor: '#d9c7a8', wall: '#f3efe8', ceiling: '#fbfaf7', joinery: '#e9e2d6', worktop: '#f1eeea', accent: '#7c93a3', fabric: '#e6ded1', metal: '#c9c4bb', bathTile: '#eeeae3', rug: '#cfc4b2', wood: '#c9a978' },
    extra: 0,
    spec: [
      { k: 'floor',   en: 'Engineered natural oak, 190 mm boards, matt oil',             pt: 'Soalho de carvalho natural, réguas 190 mm, óleo mate',        he: 'פרקט אלון טבעי מהונדס, לוחות 190 מ״מ, שמן מט' },
      { k: 'walls',   en: 'Smooth plaster, warm white mineral paint',                    pt: 'Estuque liso, tinta mineral branco quente',                   he: 'טיח חלק, צבע מינרלי לבן חם' },
      { k: 'bath',    en: 'Stone-look porcelain 60×120, floor to ceiling in the shower', pt: 'Porcelânico efeito pedra 60×120, até ao teto no duche',       he: 'פורצלן במראה אבן 60×120, עד התקרה במקלחת' },
      { k: 'sanitary',en: 'Wall-hung white ceramic WC and basin, chrome thermostatic set', pt: 'Louça suspensa branca, misturadora termostática cromada',   he: 'אסלה וכיור תלויים לבנים, ערכה תרמוסטטית בכרום' },
      { k: 'kitchen', en: 'White matt lacquer fronts, 20 mm white quartz worktop',       pt: 'Frentes lacadas branco mate, bancada quartzo branco 20 mm',  he: 'חזיתות לכה לבנה מט, משטח קוורץ לבן 20 מ״מ' },
      { k: 'appliances', en: 'A-rated integrated oven, induction, fridge, dishwasher',  pt: 'Forno, indução, frigorífico e máquina de loiça integrados, classe A', he: 'תנור, כיריים אינדוקציה, מקרר ומדיח אינטגרליים בדירוג A' },
      { k: 'doors',   en: 'White lacquered interior doors, satin steel handles',         pt: 'Portas interiores lacadas brancas, puxadores aço acetinado',  he: 'דלתות פנים בלכה לבנה, ידיות פלדה מוברשת' },
      { k: 'windows', en: 'Thermal-break aluminium, double glazing, motorised blinds',   pt: 'Alumínio com corte térmico, vidro duplo, estores motorizados', he: 'אלומיניום עם גשר תרמי, זיגוג כפול, תריסים חשמליים' }
    ]
  },
  {
    id: 'lisboa', tier: 'premium',
    name: { en: 'Premium · Lisboa Heritage', pt: 'Premium · Lisboa Clássico', he: 'פרימיום · ליסבון קלאסי', ru: 'Premium · Лиссабон' },
    blurb: { en: 'Walnut herringbone, Estremoz-marble bathrooms with azulejo accents, navy kitchen with brass.', pt: 'Espinha de nogueira, casas de banho em mármore de Estremoz com azulejo, cozinha azul com latão.', he: 'פרקט אגוז בדוגמת אדרה, חדרי רחצה משיש אסטרמוש עם אזולז׳ו, מטבח כחול עם פליז.', ru: 'Ёлочка из ореха, мрамор Эштремош и азулежу, синяя кухня с латунью.' },
    palette: { floor: '#8a5a3b', wall: '#efe6d8', ceiling: '#f7f1e6', joinery: '#2f4a6b', worktop: '#e8e2d8', accent: '#b5652e', fabric: '#c9a47a', metal: '#b8913f', bathTile: '#dbe6ef', rug: '#7b3b2a', wood: '#6e452b' },
    extra: 9500,
    spec: [
      { k: 'floor',   en: 'Solid walnut herringbone parquet, hand-oiled',                 pt: 'Parquet de nogueira maciça em espinha, oleado à mão',        he: 'פרקט אגוז מלא בדוגמת אדרה, שמן ביד' },
      { k: 'walls',   en: 'Lime plaster finish, ceiling cornices',                        pt: 'Acabamento a estuque de cal, sancas',                        he: 'טיח סיד, כרכובים בתקרה' },
      { k: 'bath',    en: 'Honed Estremoz marble, hand-made azulejo accent wall',          pt: 'Mármore de Estremoz amaciado, parede de azulejo artesanal',  he: 'שיש אסטרמוש מוברש, קיר אזולז׳ו בעבודת יד' },
      { k: 'sanitary',en: 'Wall-hung sanitaryware, brushed brass mixers and rain shower', pt: 'Louça suspensa, misturadoras e chuveiro em latão escovado',  he: 'כלים סניטריים תלויים, ברזים ומקלחת גשם בפליז מוברש' },
      { k: 'kitchen', en: 'Navy lacquer fronts, brass handles, Calacatta quartz worktop', pt: 'Frentes lacadas azul-marinho, puxadores latão, quartzo Calacatta', he: 'חזיתות לכה כחול כהה, ידיות פליז, משטח קוורץ קלקטה' },
      { k: 'appliances', en: 'Premium integrated appliances, wine cooler',               pt: 'Eletrodomésticos integrados premium, garrafeira',           he: 'מכשירים אינטגרליים פרימיום, מקרר יין' },
      { k: 'doors',   en: 'Walnut veneer interior doors, brass ironmongery',              pt: 'Portas interiores em folha de nogueira, ferragens latão',   he: 'דלתות פנים בפורניר אגוז, פרזול פליז' },
      { k: 'windows', en: 'Thermal-break aluminium, acoustic double glazing, linen sheers', pt: 'Alumínio com corte térmico, vidro acústico, cortinados de linho', he: 'אלומיניום עם גשר תרמי, זיגוג אקוסטי, וילונות פשתן' }
    ]
  },
  {
    id: 'noir', tier: 'signature',
    name: { en: 'Signature · Noir Riverside', pt: 'Signature · Noir Ribeirinho', he: 'סיגנצ׳ר · נואר על הנהר', ru: 'Signature · Нуар' },
    blurb: { en: 'Wide smoked-oak planks, Nero Marquina marble, microcement, fluted oak kitchen with sintered stone, bronze.', pt: 'Carvalho fumado em réguas largas, mármore Nero Marquina, microcimento, cozinha ripada com pedra sinterizada, bronze.', he: 'לוחות אלון מעושן רחבים, שיש נרו מרקינה, מיקרוטופינג, מטבח אלון מחורץ עם אבן סינטר, ברונזה.', ru: 'Широкий копчёный дуб, мрамор Неро Маркина, микроцемент, кухня с керамикой, бронза.' },
    palette: { floor: '#4a3a2e', wall: '#3b3b3d', ceiling: '#2d2d2f', joinery: '#1f1f21', worktop: '#1a1a1a', accent: '#a07b4f', fabric: '#57524c', metal: '#8c6a43', bathTile: '#2a2a2c', rug: '#6b625a', wood: '#3a2c22' },
    extra: 14500,
    spec: [
      { k: 'floor',   en: 'Smoked oak wide planks 240 mm, brushed and oiled',             pt: 'Carvalho fumado em réguas de 240 mm, escovado e oleado',     he: 'אלון מעושן בלוחות 240 מ״מ, מוברש ומשומן' },
      { k: 'walls',   en: 'Charcoal microcement feature walls, warm grey paint',          pt: 'Paredes em microcimento antracite, tinta cinza quente',      he: 'קירות מיקרוטופינג פחם, צבע אפור חם' },
      { k: 'bath',    en: 'Polished Nero Marquina marble, microcement walk-in shower',     pt: 'Mármore Nero Marquina polido, duche em microcimento',       he: 'שיש נרו מרקינה מלוטש, מקלחת מיקרוטופינג' },
      { k: 'sanitary',en: 'Stone basins, gunmetal/bronze fittings, concealed cisterns',   pt: 'Lavatórios em pedra, torneiras bronze/gunmetal, autoclismos embutidos', he: 'כיורי אבן, ברזים בברונזה/גאנמטל, מיכלים סמויים' },
      { k: 'kitchen', en: 'Fluted smoked-oak fronts, 12 mm dark sintered-stone worktop',  pt: 'Frentes ripadas em carvalho fumado, bancada pedra sinterizada escura 12 mm', he: 'חזיתות אלון מעושן מחורצות, משטח אבן סינטר כהה 12 מ״מ' },
      { k: 'appliances', en: 'Top-tier integrated appliances, steam oven, venting hob',   pt: 'Eletrodomésticos topo de gama, forno a vapor, placa com extração', he: 'מכשירים מהשורה הראשונה, תנור קיטור, כיריים עם יניקה' },
      { k: 'doors',   en: 'Full-height flush doors in dark oak, concealed hinges',        pt: 'Portas de piso a teto em carvalho escuro, dobradiças ocultas', he: 'דלתות מרצפה לתקרה באלון כהה, צירים נסתרים' },
      { k: 'windows', en: 'Slim-profile thermal-break aluminium, solar-control glazing',  pt: 'Alumínio de perfil fino, vidro de controlo solar',           he: 'אלומיניום בפרופיל דק, זיגוג בקרת שמש' }
    ]
  }
  ,{
    id: 'natura', tier: 'natura',
    name: { en: 'Natura · Japandi Calm', pt: 'Natura · Japandi', he: 'נטורה · יפנדי רגוע', ru: 'Natura · Джапанди' },
    blurb: { en: 'Pale ash floors, limewash walls, travertine, linen and black steel details.', pt: 'Soalho de freixo claro, paredes a cal, travertino, linho e detalhes em aço preto.', he: 'פרקט מילה בהיר, קירות סיד, טרוורטין, פשתן ופרטי פלדה שחורה.', ru: 'Светлый ясень, известковые стены, травертин, лён и чёрная сталь.' },
    palette: { floor: '#dfd2b8', wall: '#ece6da', ceiling: '#f6f2ea', joinery: '#cdbb9b', worktop: '#d9cdb8', accent: '#2b2b28', fabric: '#d8cfbf', metal: '#2d2c2a', bathTile: '#d8ccb6', rug: '#bfb39d', wood: '#c6ae86' },
    extra: 6500,
    spec: [
      { k: 'floor',   en: 'Pale ash engineered boards, 220 mm, white-oiled',               pt: 'Soalho de freixo claro, réguas 220 mm, óleo branco',          he: 'פרקט מילה בהיר, לוחות 220 מ״מ, שמן לבן' },
      { k: 'walls',   en: 'Mineral limewash in warm sand, timber slat feature wall',       pt: 'Pintura a cal em tom areia, parede ripada em madeira',         he: 'צבע סיד מינרלי בגוון חול, קיר לוחות עץ' },
      { k: 'bath',    en: 'Honed travertine floor to ceiling, niche shelves',              pt: 'Travertino amaciado do chão ao teto, nichos',                  he: 'טרוורטין מוברש מהרצפה עד התקרה, נישות' },
      { k: 'sanitary',en: 'Matt-black mixers, stone-resin basin, wall-hung WC',            pt: 'Misturadoras preto mate, lavatório em resina mineral, sanita suspensa', he: 'ברזים שחור מט, כיור אבן יצוקה, אסלה תלויה' },
      { k: 'kitchen', en: 'Ash veneer fronts, travertine-look sintered worktop',           pt: 'Frentes em folha de freixo, bancada sinterizada efeito travertino', he: 'חזיתות פורניר מילה, משטח סינטר במראה טרוורטין' },
      { k: 'appliances', en: 'Integrated A-rated appliances, flush induction',             pt: 'Eletrodomésticos integrados classe A, indução à face',        he: 'מכשירים אינטגרליים בדירוג A, אינדוקציה שקועה' },
      { k: 'doors',   en: 'Ash veneer doors with black handles',                           pt: 'Portas em folha de freixo com puxadores pretos',              he: 'דלתות פורניר מילה עם ידיות שחורות' },
      { k: 'windows', en: 'Thermal-break aluminium, linen sheers on recessed tracks',      pt: 'Alumínio com corte térmico, cortinados de linho em calha embutida', he: 'אלומיניום עם גשר תרמי, וילונות פשתן במסילה שקועה' }
    ]
  },
  {
    id: 'riviera', tier: 'riviera',
    name: { en: 'Riviera · Mediterranean', pt: 'Riviera · Mediterrâneo', he: 'ריביירה · ים־תיכוני', ru: 'Riviera · Средиземноморье' },
    blurb: { en: 'Limestone floors, white plaster, glazed green zellige, rattan and terracotta.', pt: 'Pavimento em calcário, estuque branco, zellige verde vidrado, vime e terracota.', he: 'רצפת אבן גיר, טיח לבן, אריחי זליג׳ ירוקים מזוגגים, ראטן וטרקוטה.', ru: 'Известняк, белая штукатурка, зелёный зеллидж, ротанг и терракота.' },
    palette: { floor: '#e3d9c6', wall: '#f6f2ea', ceiling: '#fbf8f2', joinery: '#6f8f7d', worktop: '#efe9df', accent: '#c26a3d', fabric: '#efe6d6', metal: '#b89a5e', bathTile: '#4f7f6a', rug: '#d9b991', wood: '#b98b5a' },
    extra: 11000,
    spec: [
      { k: 'floor',   en: 'Portuguese limestone (Moleanos) 60×90, honed',                  pt: 'Calcário português (Moleanos) 60×90, amaciado',               he: 'אבן גיר פורטוגזית (מולאנוס) 60×90, מוברשת' },
      { k: 'walls',   en: 'Hand-trowelled white plaster, arched niches',                   pt: 'Estuque branco à talocha, nichos em arco',                    he: 'טיח לבן בעבודת יד, נישות מקושתות' },
      { k: 'bath',    en: 'Glazed green zellige tiles, limestone floor',                   pt: 'Azulejo zellige verde vidrado, pavimento em calcário',        he: 'אריחי זליג׳ ירוקים מזוגגים, רצפת אבן גיר' },
      { k: 'sanitary',en: 'Aged-brass mixers, ceramic vessel basin on a stone shelf',      pt: 'Misturadoras latão envelhecido, lavatório de pousar em prateleira de pedra', he: 'ברזים בפליז מיושן, כיור קרמי מונח על מדף אבן' },
      { k: 'kitchen', en: 'Sage-green shaker fronts, white marble-look worktop, terracotta splashback', pt: 'Frentes shaker verde-sálvia, bancada efeito mármore branco, salpico em terracota', he: 'חזיתות שייקר ירוק מרווה, משטח במראה שיש לבן, חיפוי טרקוטה' },
      { k: 'appliances', en: 'Integrated appliances, range-style oven, wine cooler',       pt: 'Eletrodomésticos integrados, forno tipo fogão, garrafeira',   he: 'מכשירים אינטגרליים, תנור רחב, מקרר יין' },
      { k: 'doors',   en: 'Painted panel doors in off-white, brass handles',               pt: 'Portas almofadadas lacadas, puxadores latão',                 he: 'דלתות פאנל צבועות, ידיות פליז' },
      { k: 'windows', en: 'Thermal-break aluminium, timber shutters to bedrooms',          pt: 'Alumínio com corte térmico, portadas de madeira nos quartos', he: 'אלומיניום עם גשר תרמי, תריסי עץ בחדרי השינה' }
    ]
  },
  {
    id: 'urban', tier: 'urban',
    name: { en: 'Urban · Industrial Loft', pt: 'Urban · Loft Industrial', he: 'אורבן · לופט תעשייתי', ru: 'Urban · Индустриальный лофт' },
    blurb: { en: 'Polished concrete, exposed brick, black steel, terrazzo and cognac leather.', pt: 'Betão polido, tijolo à vista, aço preto, terrazzo e pele conhaque.', he: 'בטון מוחלק, לבנים חשופות, פלדה שחורה, טראצו ועור בגוון קוניאק.', ru: 'Полированный бетон, кирпич, чёрная сталь, терраццо и кожа коньячного цвета.' },
    palette: { floor: '#9a9790', wall: '#e4e1db', ceiling: '#eeece7', joinery: '#2a2b2d', worktop: '#7d7a74', accent: '#a65a2e', fabric: '#8a6a4c', metal: '#1f2022', bathTile: '#cfc8bd', rug: '#6d6a66', wood: '#7a5a3c' },
    extra: 8000,
    spec: [
      { k: 'floor',   en: 'Polished concrete screed with underfloor heating',              pt: 'Betonilha polida com piso radiante',                          he: 'בטון מוחלק עם חימום תת־רצפתי' },
      { k: 'walls',   en: 'Exposed reclaimed-brick feature wall, soft grey paint',         pt: 'Parede em tijolo recuperado à vista, tinta cinza suave',      he: 'קיר לבנים חשופות ממוחזרות, צבע אפור רך' },
      { k: 'bath',    en: 'Terrazzo floor and walls, black-framed shower screen',          pt: 'Terrazzo em pavimento e paredes, resguardo de duche com perfil preto', he: 'טראצו ברצפה ובקירות, מקלחון עם פרופיל שחור' },
      { k: 'sanitary',en: 'Matt-black fittings, concrete basin, exposed shower column',    pt: 'Torneiras preto mate, lavatório em betão, coluna de duche à vista', he: 'ברזים שחור מט, כיור בטון, עמוד מקלחת גלוי' },
      { k: 'kitchen', en: 'Matt-black fronts, stainless-steel worktop and open oak shelves', pt: 'Frentes preto mate, bancada em aço inox e prateleiras de carvalho', he: 'חזיתות שחור מט, משטח נירוסטה ומדפי אלון פתוחים' },
      { k: 'appliances', en: 'Stainless professional-style appliances',                    pt: 'Eletrodomésticos em inox de estilo profissional',             he: 'מכשירי נירוסטה בסגנון מקצועי' },
      { k: 'doors',   en: 'Black steel-framed glazed doors to the living room, oak doors elsewhere', pt: 'Portas envidraçadas em aço preto na sala, carvalho nos restantes', he: 'דלתות זכוכית במסגרת פלדה שחורה לסלון, דלתות אלון בשאר' },
      { k: 'windows', en: 'Slim black thermal-break aluminium, roller blinds',             pt: 'Alumínio preto de perfil fino, estores de rolo',              he: 'אלומיניום שחור בפרופיל דק, וילונות גלילה' }
    ]
  }
];

// Nearby places for the aerial panorama. Coordinates are approximate.
export const LANDMARKS = [
  { id: 'tejo', kind: 'water', lat: 38.6760, lon: -9.0470, name: { en: 'Tagus estuary waterfront', pt: 'Frente ribeirinha do Tejo', he: 'חוף שפך הטז׳ו' } },
  { id: 'lavradio-station', kind: 'train', lat: 38.66185, lon: -9.05847, name: { en: 'Lavradio station', pt: 'Estação do Lavradio', he: 'תחנת רכבת לברדיו' } },
  { id: 'barreiro-ferry', kind: 'ferry', lat: 38.6570, lon: -9.0790, name: { en: 'Barreiro ferry to Lisbon (Soflusa)', pt: 'Terminal fluvial do Barreiro', he: 'מעבורת בריירו–ליסבון' } },
  { id: 'baixa-chiado', kind: 'city', lat: 38.7075, lon: -9.1365, name: { en: 'Lisbon · Baixa / Terreiro do Paço', pt: 'Lisboa · Terreiro do Paço', he: 'ליסבון · טראיירו דו פאסו' } },
  { id: 'parque-nacoes', kind: 'city', lat: 38.7680, lon: -9.0940, name: { en: 'Lisbon · Parque das Nações', pt: 'Lisboa · Parque das Nações', he: 'ליסבון · פארק האומות' } },
  { id: 'ponte-25', kind: 'bridge', lat: 38.6916, lon: -9.1775, name: { en: '25 de Abril Bridge', pt: 'Ponte 25 de Abril', he: 'גשר 25 באפריל' } },
  { id: 'vasco-gama', kind: 'bridge', lat: 38.7600, lon: -9.0370, name: { en: 'Vasco da Gama Bridge', pt: 'Ponte Vasco da Gama', he: 'גשר ואסקו דה גאמה' } },
  { id: 'cristo-rei', kind: 'monument', lat: 38.6786, lon: -9.1711, name: { en: 'Cristo Rei', pt: 'Cristo Rei', he: 'כריסטו ריי' } },
  { id: 'hospital', kind: 'health', lat: 38.6560, lon: -9.0580, name: { en: 'Hospital Nossa Senhora do Rosário', pt: 'Hospital N.ª Sr.ª do Rosário', he: 'בית חולים נוסה סניורה דו רוזריו' } },
  { id: 'fórum-barreiro', kind: 'shopping', lat: 38.6570, lon: -9.0630, name: { en: 'Fórum Barreiro shopping', pt: 'Fórum Barreiro', he: 'קניון פורום בריירו' } },
  { id: 'a2-a39', kind: 'road', lat: 38.6550, lon: -9.0290, name: { en: 'A39 → A2 motorway access', pt: 'Acesso A39 / A2', he: 'גישה לכביש A39 / A2' } },
  { id: 'airport', kind: 'airport', lat: 38.7742, lon: -9.1342, name: { en: 'Lisbon Airport', pt: 'Aeroporto de Lisboa', he: 'נמל התעופה ליסבון' } }
];

// Local context captured on site (see assets/site-*.jpg)
export const CONTEXT = {
  west:  { kind: 'house', storeys: 2, colour: '#e6a58f', roof: 'tile', note: 'Pink two-storey house (no. 4) with wrought-iron balcony, attached to the west party wall' },
  east:  { kind: 'house', storeys: 2, colour: '#f2f0ea', roof: 'tile', note: 'White two-storey house with terracotta tile roof and round window, garden wall with green fence' },
  rear:  { note: 'White boundary walls; beyond: grey/white modern semi-detached houses and 4-storey 1970s blocks with yellow balconies and red tile roofs' },
  street:{ note: 'Portuguese calçada pavement, asphalt road, overhead cables; 2-storey houses opposite; street descends north towards the river' }
};

export const fmtEUR = (n, lang = 'en') => new Intl.NumberFormat(lang === 'pt' ? 'pt-PT' : lang === 'he' ? 'he-IL' : 'en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n);
export const unitById = (id) => UNITS.find(u => u.id === id);
export const floorById = (id) => FLOORS.find(f => f.id === id);
export const roomsOfUnit = (id) => FLOORS.flatMap(f => f.rooms.filter(r => r.unit === id).map(r => ({ ...r, floor: f.id, y: f.level.y })));


// ---- Real-world frame -------------------------------------------------------------
// The model's local frame is aligned with the street, not with north.
// Local +x runs along Rua Eduardo Couto towards ENE (compass bearing 61.4°);
// local -z points away from the street towards NNW (bearing 331.4°), towards the Tagus.
// True north expressed in local (x, z): (0.4791, -0.8778). Street centreline at z = 23.8.
export const SITE_FRAME = {
  bearingX: 61.38,              // compass bearing of local +x
  bearingRear: 331.38,          // compass bearing of local -z
  north: { x: 0.4790567791785995, z: -0.8777839155071291 },
  streetCentreZ: 23.8,
  osmData: 'data/osm.json?v=202610031619',     // real OSM context, already in this local frame (© OpenStreetMap contributors, ODbL)
  _lat0: 38.668162, _lon0: -9.048337,
  _A: [4.9, 0.5], _u: [0.8777839155071291, -0.4790567791785995], _n: [-0.4790567791785995, -0.8777839155071291]
};
// WGS84 -> local model metres {x, z}. Exact inverse of the transform used to build data/osm.json.
export function geoToLocal(lat, lon) {
  const F = SITE_FRAME;
  const kx = 111320 * Math.cos(F._lat0 * Math.PI / 180), kz = 110540;
  const px = (lon - F._lon0) * kx, pz = -(lat - F._lat0) * kz;
  const dx = px - F._A[0], dz = pz - F._A[1];
  const s = dx * F._u[0] + dz * F._u[1] + 80.9;
  const n = dx * F._n[0] + dz * F._n[1];
  return { x: s - 113.36, z: 23.8 - n };
}
// local model metres -> WGS84
export function localToGeo(x, z) {
  const F = SITE_FRAME;
  const kx = 111320 * Math.cos(F._lat0 * Math.PI / 180), kz = 110540;
  const s = 113.36 + x, n = 23.8 - z;
  const px = F._A[0] + (s - 80.9) * F._u[0] + n * F._n[0];
  const pz = F._A[1] + (s - 80.9) * F._u[1] + n * F._n[1];
  return { lat: F._lat0 - pz / kz, lon: F._lon0 + px / kx };
}

// Lighting moods available in every 3D view and in the photoreal tour.
export const TIMES_OF_DAY = [
  { id: 'day',   name: { en: 'Day',   pt: 'Dia',        he: 'יום',     ru: 'День' } },
  { id: 'dusk',  name: { en: 'Dusk',  pt: 'Crepúsculo', he: 'דמדומים', ru: 'Сумерки' } },
  { id: 'night', name: { en: 'Night', pt: 'Noite',      he: 'לילה',    ru: 'Ночь' } }
];
