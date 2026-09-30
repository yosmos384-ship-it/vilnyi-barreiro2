# VILNYI · Barreiro 2 — build contract for all agents

We are building an international-grade sales website for an 8-apartment building
("Barreiro 2", Rua Eduardo Couto, Lavradio, Barreiro, Portugal — developer VILNYI).
It is a static site (no build step) published as a claude.ai Artifact, and also
deployable as-is to any static host (Netlify / Cloudflare Pages / GitHub Pages).

Project root: `/home/claude/vilnyi/`
```
index.html            app shell (agent: APP)
css/site.css          (agent: APP)
js/data.js            SHARED DATA — read it fully. Do NOT edit it. Ask the lead (report in your final message) if you need a change.
js/building.js        (agent: BUILDING)
js/environment.js     (agent: ENVIRONMENT)
js/interiors.js       (agent: INTERIORS)
js/walk.js            (agent: WALK)
js/aerial.js          (agent: AERIAL)
js/viewer.js          (agent: APP) — owns the renderer and composes the modules
js/app.js, js/i18n.js, js/floorplan.js (agent: APP)
assets/               renders, floor plans and site photos (jpg). Look at them with the Read tool.
```
Reference photos in `assets/`: `facade-day.jpg`, `street-dusk.jpg`, `sketch.jpg` (the design),
`site-street.jpg`, `site-plot.jpg`, `site-rear.jpg`, `site-tejo.jpg` (the real plot today and its neighbours),
`plan-b.jpg`, `plan-0.jpg`, `plan-1.jpg`, `plan-2.jpg`, `plan-roof.jpg` (architect's drawings).

## Hard technical rules
- three.js **r160** only. Import exactly like this (an importmap in index.html maps them):
  `import * as THREE from 'three';` and addons as `import { X } from 'three/addons/…/X.js';`
  Production importmap → `https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js` and
  `https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/`. For local tests use
  `/home/claude/scratch/node_modules/three/` (installed) — see "Testing".
- No other network resources at runtime: **no texture URLs, no GLTF/HDR downloads, no fonts from anywhere except Google Fonts CSS**.
  All textures are generated procedurally (CanvasTexture / DataTexture) in code. Images in `assets/` may be loaded
  with relative URLs (they ship with the site) but only the APP uses them.
- ES modules, no bundler, no TypeScript. Plain modern JS. Each module exports functions only, no side effects on import.
- Must run on a mid-range phone: keep draw calls sane (merge static geometry with `BufferGeometryUtils.mergeGeometries`
  per material, or InstancedMesh for repeats), share materials, cap canvas textures at 1024px (512 for small things),
  at most ONE shadow-casting directional light (owned by ENVIRONMENT), no per-object point lights except a few
  (≤4) where it really matters. Use `MeshStandardMaterial`/`MeshPhysicalMaterial` (glass: transmission is expensive —
  prefer transparent + low opacity + envMap reflections).
- Everything in **metres** in the world coordinates defined at the top of `js/data.js`:
  x = east, z = south (0 = rear/garden façade, 14.70 = street façade), y = up (0 = ground floor finished level).
- Name meshes/groups meaningfully (`obj.name`) and set `userData` as specified below — other modules rely on it.
- No `console.log` spam. Throwing on load breaks the whole site: guard everything.

## Look & feel
Luxury, calm, architectural-photography realism: warm Lisbon light, white render façade, anthracite standing-seam zinc mansard,
terracotta brick tower (left of the entrance), glass balustrades, timber slats, lush planters (olive tree, grasses),
dark-grey garage door, white boundary walls. Match `assets/facade-day.jpg` and `assets/street-dusk.jpg` closely.
Renderer (owned by APP/viewer.js): `ACESFilmicToneMapping`, `SRGBColorSpace`, `PMREMGenerator(RoomEnvironment)` as `scene.environment`,
PCFSoftShadowMap, physically-correct lights (r160 default). Design your materials for that.

## Module APIs (implement exactly; extra helpers are welcome)

### BUILDING — `js/building.js`
```js
export function buildBuilding(THREE, { scene, renderer }) => {
  group,                      // THREE.Group added to scene, name 'building'
  floorPickers: [{ floorId, mesh }],   // invisible (visible=true but material.opacity 0 / colorWrite false) boxes around each floor's exterior volume, for raycast selection from outside. floorId ∈ 'ground'|'first'|'second'
  highlightFloor(floorId|null),        // show a tasteful glowing band/overlay on that floor's façade (both street & rear), null clears
  setCutaway(floorId|null),            // optional "doll-house": hide everything above floorId's ceiling so the floor is visible from above (null = full building)
  doors: [{ id, floorId, kind:'door'|'entry'|'elevator'|'main'|'garage', center:Vector3, pivot:Object3D, setOpen(t0to1) }],
  lift: {
    cab: Object3D,            // lift car incl. floor, walls, mirror, handrail, ceiling light, button panel; origin at cab floor centre
    shaft: { x, z },          // centre of the shaft in plan
    levels: { basement:-2.7, ground:0, first:3, second:6 },
    setCabY(y),               // moves cab (and its doors) to world floor height y
    setCabDoors(t0to1),
    setLandingDoors(floorId, t0to1),
    panel: Object3D           // button panel inside the cab (for WALK to raycast buttons): children with userData.liftButton = floorId and userData.setLit(bool)
  },
  update(dt)                  // per-frame (animations)
}
```
Scope: from `FLOORS`, `FOOTPRINT`, `BALCONIES`, `ROOF`, `CORE`, `PARKING`, `RAMP`, `LEVELS` in data.js build:
exterior shell with window/door openings cut properly (build walls as segment pieces around openings — no CSG libs),
real window frames + glazing + sills, sliding glass doors, the **mansard** (72° zinc planes starting at CORNICE_Y, with dormers
at openings on walls flagged `mansard:true`, see photos), flat roof with 18 PV panels + skylight + parapet/cornice,
balconies with glass balustrades + timber soffits + downlights, brick stair tower on the street side (x≈0..2.9) with the slit window,
entrance canopy, house number "VILNYI · Nº 6" plate, letterboxes, planters with olive tree & grasses (use simple stylised but elegant
geometry, instanced), front boundary low wall and gates, the garage door and the 15% **ramp** down to the basement,
**basement** car park (8 numbered bays with painted lines/numbers via canvas texture, columns, 8 parked cars of varied colours —
tasteful low-poly but proportioned, ceiling lights), technical room door, **lobby** (large-format stone floor, feature wall with
timber slats and backlit VILNYI logo, pendant light, mailboxes, bench, plant), landings/corridors on every floor
(floor, skirting, walls, ceiling with recessed lights, apartment entry doors in walnut with brass handle and unit number plate),
**stairs** (two flights per storey, handrails, 17 risers per 3.00 m — also used by WALK), **lift** (shaft, landing doors with stainless
frames + floor indicator, cab as specified). Interior partitions of apartments with interior doors (white lacquer, open by default
at ~80° except entry doors which start closed), floor slabs & ceilings for every level (apartment floors get a neutral base floor —
INTERIORS overlays the finish), skirting. Rear garden decks and lawns for 0.A/0.B with a timber fence between them.
Walls interior faces: neutral warm white. Keep one merged mesh per material per floor where possible.

### ENVIRONMENT — `js/environment.js`
```js
export function buildEnvironment(THREE, { scene, renderer, quality:'high'|'low' }) => {
  group, sun: DirectionalLight (the only shadow light; shadow camera fits the building ±25 m),
  setTimeOfDay(name),   // 'day' | 'golden' | 'dusk' — sky colours, sun position/colour/intensity, hemisphere light, fog, street lamps on at dusk
  geo(lat, lon) => Vector3 // converts WGS84 to world metres (origin = PROJECT.lat/lon at x=7,z=7 of the building; north = -z)
  update(dt, camera)
}
```
Scope: physically-plausible sky (three/addons Sky or a gradient dome), sun from the correct azimuth for Lisbon (38.67°N) in late
afternoon; ground plane; **Rua Eduardo Couto** (asphalt, kerbs, Portuguese calçada pavements in white limestone pattern via canvas,
overhead cables and poles, street lamps, a few parked cars) running east–west in front (z from 17.4 to ~26); the real neighbours
from `CONTEXT` and the site photos: west = pink 2-storey house with wrought-iron balcony (attached to x=0 party wall),
east = white 2-storey house with terracotta tile roof and round window; white boundary walls around the plot rear; behind and around:
2-storey houses with red tile roofs and 4-storey 1970s apartment blocks (cream/pink with yellow balconies, red tile hipped roofs) —
procedurally fill a believable Lavradio neighbourhood out to ~700 m (instanced, LOD-friendly, deterministic random seed), trees.
To the **north** the Tagus estuary: water surface starting ≈ 800–900 m north (use geo() with lat 38.676) with gentle animated
reflections, and on the far shore (≈ 8–12 km) the **Lisbon skyline** as layered silhouettes/low-poly blocks with lights at dusk,
the **25 de Abril bridge** (red suspension bridge) to the WNW and **Vasco da Gama bridge** (long low bridge) to the NNE, Cristo Rei
on the south bank west. Use `LANDMARKS` for positions via geo(). The view from each floor's balcony must feel real: from ground
you see garden walls and neighbours; from the 2nd floor you glimpse the river and Lisbon over the roofs.

### INTERIORS — `js/interiors.js`
```js
export const STYLE_IDS = ['atlantic','lisboa','noir'];
export function buildInteriors(THREE, { scene }) => {
  group,
  furnish(unitId, styleId) => Promise<void>, // (re)builds furniture + finishes for that unit only; removes previous furnishing of that unit
  clear(unitId|null),
  getHotspots(unitId) => [{ roomId, name:{en,pt,he}, position:Vector3 (eye point 1.6 m high), lookAt:Vector3 }], // one or two per room + balcony
  update(dt)
}
```
Scope: For every room of the unit (`roomsOfUnit(unitId)` in data.js; rooms have `use`), using the chosen STYLE palette
(and the style's material character — Atlantic: bleached oak, linen, white marble; Lisboa: walnut herringbone, azulejo tiles,
brass, terracotta; Noir: smoked oak, charcoal microcement, Nero Marquina, bronze): floor finish (procedural textures: wood planks,
herringbone, marble, microcement, bathroom tiles), wall paint/tiles, ceiling with recessed downlights, curtains/sheers at glazing.
Furniture detailed **down to the fork**: kitchen (base + wall cabinets, island or peninsula where room allows, worktop, sink + tap,
induction hob, built-in oven, microwave, integrated fridge-freezer, dishwasher, extractor hood, washing machine where logical,
kettle, coffee machine, fruit bowl, knife block), dining table with chairs set for 2–4: plates, forks, knives, spoons, glasses,
napkins, candles; living: sofa with cushions and throw, armchair, coffee table with books & vase, sideboard, TV on wall/console,
rug, floor lamp, artwork frames, indoor plants; bedrooms: bed with duvet/pillows/headboard, bedside tables and lamps, wardrobe,
desk in bedroom 2, rug, curtains; bathrooms: walk-in shower with glass screen, wall-hung WC, vanity with basin and mirror, towels,
towel rail; hall: console, mirror, coat hooks; balconies/decks: outdoor table & chairs, planters; gardens (0.A/0.B): lawn, deck,
lounger, olive tree, lighting. Place furniture so it respects walls/doors/windows from data.js (door swing zones and a 0.8 m
walk path through each room must stay clear — WALK collides only with walls, not furniture, but it must look right).
Use InstancedMesh for cutlery/plates/chairs; share geometry; 1–2 small point lights max per unit (warm pendant over the table),
the rest emissive. Style switch must be instant-ish (<300 ms per unit).

### WALK — `js/walk.js`
```js
export function createWalker(THREE, { camera, dom, scene, building, overlay /* HTMLElement for HUD */ }) => {
  enable(), disable(), isEnabled(),
  teleport(position:Vector3, lookAt:Vector3), // snaps to floor height
  goToUnit(unitId, roomId?),                  // starts at the unit's startRoom (hall) looking into the apartment
  goToLift(floorId), ride(floorId) => Promise,
  onChange(cb({ floorId, roomId, unitId, inLift })),
  update(dt)
}
```
Scope: first-person walkthrough with eye height 1.62 m. **Mouse/touch drag = look around** (yaw/pitch, pitch clamped, inertia).
**Double-click / double-tap = walk forward** smoothly to the tapped point on the floor (raycast; if tapped a wall, walk towards it and
stop 0.4 m before). Also keyboard WASD/arrows, and an on-screen HUD (inside `overlay`) with ▲ forward / ▼ back / ◀ ▶ turn
buttons (press & hold), a floor/room label, and a mini-map toggle. **Collision** against all wall segments of the current floor
from `FLOORS[].walls` (subtract openings where type is door/entry/opening/glassdoor/main/elevator; windows/slit/garage are solid),
radius 0.25 m; **doors auto-open** when you approach within 1.4 m (use `building.doors[].setOpen`) and close behind you.
**Stairs**: inside `CORE.stairs` interpolate y along the flights so walking on stairs climbs between levels (two flights per storey,
switch-back). Floor height elsewhere = the current level y; stepping onto balconies/decks (`BALCONIES`) must work through glassdoors;
don't allow walking off balconies (treat balcony outline edges as walls except at the building side).
**Lift**: walking into the cab shows a DOM **lift panel** in the HUD with buttons −1, 0, 1, 2 (and ⇅ indicator); pressing a button
closes doors (animated), plays a soft chime (WebAudio, only after user gesture), moves cab + camera with ease-in-out at ~1 m/s
and a subtle vertical camera sway, shows a floor indicator counting, opens doors at the target. Up/down arrows in the panel
also work. Also clicking the 3D button meshes (`building.lift.panel` children) works.
Respect `prefers-reduced-motion` (no sway). Must feel smooth on touch devices (pointer events, passive where possible, no page scroll).

### AERIAL — `js/aerial.js`
```js
export function createAerial(THREE, { camera, dom, scene, environment, labelsEl /* absolutely positioned div over the canvas */, lang }) => {
  enable(), disable(), setLang(lang), update(dt)
}
```
Scope: the "bird's-eye 360°" panorama: camera at ~120 m altitude above the site (orbit target = building), drag to spin a full
360°, pinch/wheel to zoom 60–400 m, slow auto-rotate when idle, compass ring (N/E/S/W) drawn in the HUD, and **labels for LANDMARKS**
(from data.js, positioned with `environment.geo()`): each label shows name, distance (km, straight line from the site) and an icon by
kind (train, ferry, city, bridge, monument, health, shopping, road, airport, water) — hide labels behind the camera, fade by distance,
avoid overlaps (simple greedy collision). A pulsing marker + label "Barreiro 2 · VILNYI" on the building. Labels use `lang` (en/pt/he,
RTL safe). Also show a subtle dashed line on the ground from the site to each landmark on hover of its label.

### APP — `index.html`, `css/site.css`, `js/app.js`, `js/i18n.js`, `js/floorplan.js`, `js/viewer.js`
viewer.js owns: WebGLRenderer (antialias, pixelRatio min(devicePixelRatio, 2), low quality on small screens), camera, scene,
PMREM RoomEnvironment, render loop, resize; creates environment, building, interiors, walker, aerial; modes:
- `exterior` — OrbitControls around the building (damping, limits so you can't go under ground), hover a floor → `highlightFloor`,
  click → emits `floor-select` event (app opens that floor's interactive plan);
- `aerial` — hands camera to aerial;
- `walk` — hands camera to walker (from lobby, a unit, or the lift);
- time-of-day switch (day/golden/dusk).
app.js: sales flow and UI (see APP brief in its own prompt).

## Testing (every agent)
Local test harness: `/home/claude/scratch/serve.py` serves `/home/claude/vilnyi` on http://127.0.0.1:8765 and maps
`/three/` to `/home/claude/scratch/node_modules/three/`. Test pages use an importmap
`{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}`.
Write your own small test page under `/home/claude/scratch/test-<module>.html` that imports only your module + data.js + the
minimal renderer setup, and screenshot it with Playwright (python, chromium headless with `--use-gl=swiftshader` or
`--enable-unsafe-swiftshader`, viewport 1280x800). Look at the screenshots with the Read tool and iterate until it looks
genuinely good. Check the browser console for errors. Do not edit files owned by other agents.
Final message to the lead: what you built, the exported API exactly as implemented, known limitations, and 1–3 screenshot paths.
