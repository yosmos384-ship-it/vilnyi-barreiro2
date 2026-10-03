// VILNYI · Barreiro 2 — 3D viewer (APP agent).
// Owns the single WebGLRenderer, camera, scene and render loop, and composes the
// environment / building / interiors / walk / aerial modules. Every module is loaded
// with a guarded dynamic import so a failing module never breaks the site.
//
// API:
//   createViewer(container, { quality, floorLabel(floorId) => string, lang }) => {
//     ready: Promise<{ modules }>, setMode(mode, opts) => Promise<boolean>, getMode(),
//     selectUnit(unitId, styleId) => Promise, setTimeOfDay('day'|'dusk'|'night'|'golden'), getTimeOfDay(), setLang(lang),
//     hotspots(unitId) => [...], lookFrom(hotspot), balconyView(unitId), goToLift(floorId), goToLobby(), goToParking(),
//     walkUnit(unitId, roomId?), takeLift(from, to), goToStreet(), getPose() / setPose({x,y,z,yaw}), getPerf(), resize(), has(moduleName), on(event, cb) => off, dispose(),
//     setPhotoreal(on) => Promise<boolean>, isPhotoreal(), setPhotorealLabels({...}), setHeading(bearing),
//     attribution() => string
//   }
//   events: 'floor-select' {floorId} · 'unit-select' {unitId, styleId?, source} · 'mode' {mode, prev}
//           'progress' {p, label} · 'place' {floorId, roomId, unitId, inLift} · 'error' {error}
//           'photoreal' {state:'loading'|'on'|'off'|'error', phase?, p?, samples?, error?}
//
// Phase 2: postfx.js renders the raster views (exterior/interior/aerial presets), pathtrace.js is imported lazily
// on the first setPhotoreal(true), google3d.js only when PROJECT.googleMapsKey is set, interiors.prewarm runs at idle.

import { UNITS, BALCONIES, LEVELS, PROJECT, PARKING, RAMP, roomsOfUnit, unitById } from './data.js';

const EXTERIOR_TARGET = [7, 4.2, 7.2];
const EXTERIOR_CAMERA = [-1.5, 4.2, 25.2];

function el(tag, cls, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}

function centroid(poly) {
  let x = 0, z = 0;
  for (const [px, pz] of poly) { x += px; z += pz; }
  return [x / poly.length, z / poly.length];
}

export function createViewer(container, options = {}) {
  const listeners = {};
  const emit = (ev, detail) => {
    for (const cb of (listeners[ev] || []).slice()) {
      try { cb(detail); } catch (e) { console.error(e); }
    }
  };
  const on = (ev, cb) => {
    (listeners[ev] ||= []).push(cb);
    return () => { listeners[ev] = (listeners[ev] || []).filter(f => f !== cb); };
  };

  // Device tier (the ceiling the governor never exceeds): a phone = touch + small screen, or little memory → 'low'.
  const small = Math.min(window.innerWidth, window.innerHeight, window.screen?.width || 9999, window.screen?.height || 9999) < 700;
  const touch = !!window.matchMedia?.('(pointer: coarse)').matches || (navigator.maxTouchPoints || 0) > 0;
  const phone = (touch && small) || (navigator.deviceMemory || 8) <= 4;
  const quality = options.quality || (phone ? 'low' : 'high');
  const PR_CAP = phone ? 1.25 : quality === 'high' ? 2 : 1.5;
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let floorLabel = options.floorLabel || (f => f);
  let lang = options.lang || 'en';

  // DOM layers inside the container
  container.classList.add('v-root');
  const canvasHost = el('div', 'v-canvas', container);
  const labelsEl = el('div', 'v-labels', container);
  const hudEl = el('div', 'v-hud', container);
  const floorTip = el('div', 'v-floortip', container);
  floorTip.hidden = true;
  const attribEl = el('div', 'v-attrib', container);
  attribEl.hidden = true;

  let THREE, renderer, scene, camera, controls, pmrem, envTex;
  let env = null, building = null, interiors = null, walker = null, aerial = null;
  let fallbackLights = null;
  let postfx = null, pt = null, ptOn = false, ptLoading = null, ptLabels = null, g3d = null, g3dHidden = null;
  let shadowTick = 0;
  const lastCam = new Float32Array(16);
  const modules = { environment: false, building: false, interiors: false, walk: false, aerial: false, postfx: false, pathtrace: false, google3d: false };
  let mode = null;
  let disposed = false;
  let raf = 0;
  let last = 0;
  let inView = true;
  let hoveredFloor = null;
  let currentUnit = null;
  let currentStyle = null;
  const unitStyles = {};
  let dolly = null;     // exterior double-tap: { t0, ms, c0, c1, g0, g1 }
  let lastIdle = performance.now();
  let tod = 'golden';
  let lookState = null; // fallback static view when no walker
  const cleanups = [];

  const listen = (target, ev, fn, opts) => {
    target.addEventListener(ev, fn, opts);
    cleanups.push(() => target.removeEventListener(ev, fn, opts));
  };

  async function loadModule(name, path, build) {
    try {
      const m = await import(path);
      const r = await build(m);
      modules[name] = !!r;
      return r || null;
    } catch (e) {
      console.warn(`[viewer] ${name} unavailable:`, e);
      modules[name] = false;
      return null;
    }
  }
  const tick = () => new Promise(r => setTimeout(r, 0));
  const progress = (p, label) => emit('progress', { p, label });

  const ready = (async () => {
    progress(0.04, 'three');
    THREE = await import('three');
    const [{ OrbitControls }, { RoomEnvironment }] = await Promise.all([
      import('three/addons/controls/OrbitControls.js'),
      import('three/addons/environments/RoomEnvironment.js')
    ]);
    if (disposed) throw new Error('disposed');
    progress(0.18, 'renderer');

    renderer = new THREE.WebGLRenderer({ antialias: quality === 'high', powerPreference: 'high-performance', preserveDrawingBuffer: false });
    renderer.setPixelRatio(basePR());
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = quality === 'high' ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    canvasHost.appendChild(renderer.domElement);
    renderer.domElement.style.touchAction = 'none';
    renderer.domElement.setAttribute('aria-label', 'Barreiro 2 3D model');

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xd9dde0);
    camera = new THREE.PerspectiveCamera(50, 1, 0.3, 30000);
    camera.position.set(...EXTERIOR_CAMERA);
    scene.add(camera);

    pmrem = new THREE.PMREMGenerator(renderer);
    envTex = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;
    scene.environment = envTex;

    controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(...EXTERIOR_TARGET);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false;
    controls.minDistance = 9;
    controls.maxDistance = 95;
    controls.maxPolarAngle = Math.PI * 0.485;
    controls.minPolarAngle = Math.PI * 0.12;
    controls.autoRotateSpeed = 0.35;
    controls.update();
    controls.addEventListener('start', () => { lastIdle = performance.now(); controls.autoRotate = false; });
    controls.addEventListener('end', () => { lastIdle = performance.now(); });

    resize();
    await tick();

    progress(0.3, 'environment');
    env = await loadModule('environment', './environment.js', m => m.buildEnvironment(THREE, { scene, renderer, quality }));
    if (!env) addFallbackEnvironment();
    else {
      try { env.setTimeOfDay(tod); } catch (e) { console.warn(e); }
      applyExposure();
      tuneShadows();
      if (env.attribution) { attribEl.textContent = env.attribution; attribEl.hidden = false; }
      Promise.resolve(env.ready).then(() => { invalidateShadows(); schedule(); }, () => { /* OSM context missing: env keeps its base */ });
    }
    renderer.shadowMap.autoUpdate = false;
    invalidateShadows();
    // post-processing never loads on phones (and is bypassed in walk mode unless the tier is 'high')
    if (!phone) postfx = await loadModule('postfx', './postfx.js', m => m.createPostFX(THREE, { renderer, scene, camera, quality, mode: 'exterior' }));
    if (postfx) { try { postfx.setTimeOfDay?.(tod); } catch (e) { /* optional */ } }
    await tick();

    progress(0.5, 'building');
    building = await loadModule('building', './building.js', m => m.buildBuilding(THREE, { scene, renderer }));
    if (!building) throw Object.assign(new Error('The building model failed to load'), { code: 'building' });
    if (quality === 'low') { try { building.setQuality?.('low'); } catch (e) { /* optional */ } }
    await tick();

    progress(0.68, 'interiors');
    interiors = await loadModule('interiors', './interiors.js', m => m.buildInteriors(THREE, { scene, building, renderer }));
    if (quality === 'low') { try { interiors?.setQuality?.('low'); } catch (e) { /* optional */ } }
    try { interiors?.setTimeOfDay?.(interiorTod(tod)); } catch (e) { /* optional */ }
    await tick();

    progress(0.8, 'walk');
    walker = await loadModule('walk', './walk.js', m => m.createWalker(THREE, { camera, dom: renderer.domElement, scene, building, overlay: hudEl }));
    if (walker) {
      try { walker.disable(); } catch (e) { /* not enabled yet */ }
      try {
        let lastUnit = null;
        walker.setLang?.(lang);
        walker.onChange(info => {
          applyPlace(info);
          emit('place', info);
          if (info && info.unitId && info.unitId !== lastUnit) emit('unit-select', { unitId: info.unitId, source: 'walk' });
          lastUnit = info ? info.unitId : null;
        });
      } catch (e) { console.warn(e); }
    }
    await tick();

    progress(0.9, 'aerial');
    if (env) {
      aerial = await loadModule('aerial', './aerial.js', m => m.createAerial(THREE, { camera, dom: renderer.domElement, scene, environment: env, labelsEl, lang, onEnterSite: () => { setMode('exterior'); } }));
      if (aerial) { try { aerial.disable(); } catch (e) { /* ignore */ } }
    }
    if (controls) controls.addEventListener('change', () => { if (ptOn) pt?.reset(); });

    bindPointer();
    for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'touchstart']) listen(container, ev, () => poke(), { passive: true, capture: true });
    listen(window, 'keydown', () => { if (inView && container.offsetParent !== null) poke(); }, { passive: true });
    listen(document, 'visibilitychange', schedule);
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver(entries => { inView = entries[0].isIntersecting; schedule(); });
      io.observe(container);
      cleanups.push(() => io.disconnect());
    }
    if ('ResizeObserver' in window) {
      const ro = new ResizeObserver(() => resize());
      ro.observe(container);
      cleanups.push(() => ro.disconnect());
    } else listen(window, 'resize', resize);
    listen(renderer.domElement, 'webglcontextlost', e => { e.preventDefault(); emit('error', { error: new Error('WebGL context lost') }); });

    // nothing interactive before the textures are on the GPU and the shaders are compiled: the first moves must not hitch
    progress(0.93, 'textures');
    await waitFor(Promise.all([building.ready, env?.ready].map(p => Promise.resolve(p).catch(() => null))), 20000);
    if (disposed) throw new Error('disposed');
    await applyMode(options.initialMode || 'exterior', options.initialOpts || {});
    progress(0.97, 'shaders');
    await warmUp();
    renderer.render(scene, camera);
    progress(1, 'done');
    schedule();
    afterLoad();
    return { modules: { ...modules }, quality };
  })();

  const waitFor = (p, ms) => Promise.race([p, new Promise(r => setTimeout(r, ms))]);
  async function warmUp() {
    if (!renderer || disposed) return;
    try {
      if (typeof renderer.compileAsync === 'function') await waitFor(renderer.compileAsync(scene, camera), 12000);
      else renderer.compile(scene, camera);
    } catch (e) { try { renderer.compile(scene, camera); } catch (e2) { /* first frame compiles instead */ } }
  }

  // ───────── performance governor ─────────
  // level 0 = the device tier's full quality · 1 = lower pixel ratio · 2 = + low textures (setQuality('low') on the modules)
  // · 3 = + no post-processing and a still lower pixel ratio. Steps down when the rolling 60-frame average is over 40 ms,
  // back up one level after 5 s under 20 ms. Never above the device tier.
  const gov = { level: 0, max: 3, n: 0, sum: 0, ring: new Float32Array(60), i: 0, goodSince: 0, lastStep: 0, moving: false, lastMove: 0, activeUntil: 0, lastRender: 0, pr: 0, log: [], shadows: true, detail: null, floor: undefined, unit: undefined, inside: false, fogD: null };
  const PR_SCALE = [1, 0.8, 0.8, 0.65];
  function basePR() { return Math.min(window.devicePixelRatio || 1, PR_CAP); }
  function targetPR() {
    let pr = Math.max(0.6, basePR() * PR_SCALE[gov.level]);
    if (phone && gov.moving) pr = Math.min(pr, 1.0);       // phones: 1.0 while moving, back up when still for 400 ms
    return Math.round(pr * 100) / 100;
  }
  function applyPR() {
    const pr = targetPR();
    if (!renderer || pr === gov.pr) return;
    gov.pr = pr;
    renderer.setPixelRatio(pr);
    const w = Math.max(1, container.clientWidth), h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h, false);
    try { postfx?.setSize(w, h); } catch (e) { /* ignore */ }
  }
  function govNote(what) {
    gov.log.push({ t: Math.round(performance.now()), what, level: gov.level, pr: gov.pr, mode, avg: gov.n ? +(gov.sum / gov.n).toFixed(1) : 0 });
    if (gov.log.length > 60) gov.log.shift();
  }
  function setLevel(l, why) {
    l = Math.max(0, Math.min(gov.max, l));
    if (l === gov.level) return;
    const was = gov.level;
    gov.level = l;
    const wantLow = quality === 'low' || l >= 2, hadLow = quality === 'low' || was >= 2;
    if (wantLow !== hadLow) {
      const q = wantLow ? 'low' : 'high';
      for (const m of [building, interiors, env]) { try { m?.setQuality?.(q); } catch (e) { /* optional */ } }
    }
    applyPR();
    gov.n = 0; gov.sum = 0; gov.i = 0; gov.goodSince = 0; gov.lastStep = performance.now();
    govNote(`${why}: level ${was} → ${l}`);
    emit('perf', { level: l, why });
  }
  function govSample(ms, now) {
    if (ms > 3000) return;                                  // tab switch / long upload: not a frame-rate sample
    if (ms > 400) ms = 400;
    if (gov.n < 60) gov.n++; else gov.sum -= gov.ring[gov.i];
    gov.ring[gov.i] = ms; gov.sum += ms; gov.i = (gov.i + 1) % 60;
    const avg = gov.sum / gov.n;
    // badly overloaded (under 10 fps): do not wait for the full 60-frame window
    if (gov.n >= 10 && avg > 100 && now - gov.lastStep > 1500) { setLevel(gov.level + 1, `avg ${avg.toFixed(0)} ms`); return; }
    if (gov.n < 60 || now - gov.lastStep < 2000) return;
    if (avg > 40) { setLevel(gov.level + 1, `avg ${avg.toFixed(0)} ms`); return; }
    if (avg < 20 && gov.level > 0) {
      if (!gov.goodSince) gov.goodSince = now;
      else if (now - gov.goodSince > 5000) setLevel(gov.level - 1, `avg ${avg.toFixed(0)} ms for 5 s`);
    } else gov.goodSince = 0;
  }
  const usePostfx = () => !!postfx && !phone && gov.level < 3 && (mode !== 'walk' || quality === 'high');
  const poke = (ms = 1500) => { const t = performance.now() + ms; if (t > gov.activeUntil) gov.activeUntil = t; };

  // What is drawn per mode / place: far context, other floors and other apartments are hidden when they cannot be seen.
  function setShadows(on) {
    const sun = env?.sun;
    if (!sun || gov.shadows === on) return;
    gov.shadows = on; sun.castShadow = on;
    invalidateShadows();
  }
  function setDetail(name) {
    if (gov.detail === name) return;
    gov.detail = name;
    if (g3d && !ptOn) return;                              // Google tiles replace the OSM context
    try { env?.setDetail?.(name); } catch (e) { /* optional */ }
  }
  function setFloor(f) { if (gov.floor === f) return; gov.floor = f; try { building?.setActiveFloor?.(f); } catch (e) { /* optional */ } invalidateShadows(); }
  function setUnit(u) { if (gov.unit === u) return; gov.unit = u; try { interiors?.setActiveUnit?.(u); } catch (e) { /* optional */ } }
  function setInside(inside) {
    if (gov.inside === inside) return;
    gov.inside = inside;
    const f = scene.fog;                                    // no fog indoors
    if (f && 'density' in f) { if (inside) { gov.fogD = f.density; f.density = 0; } else if (gov.fogD != null) { f.density = gov.fogD; gov.fogD = null; } }
  }
  const furnished = new Set();
  function applyPlace(info) {
    if (mode !== 'walk' || !info) return;
    let st = null;
    try { st = walker.getState(); } catch (e) { st = null; }
    const outside = st ? !!st.outside && !info.unitId && !info.inLift : !info.floorId;
    setInside(!outside);
    if (outside) { setDetail('near'); setFloor('ground'); setUnit(currentUnit || null); }
    else {
      setDetail('minimal');
      setFloor(info.floorId || st?.floorId || 'ground');
      if (info.unitId) {
        setUnit(info.unitId);
        if (interiors && !furnished.has(info.unitId)) {
          furnished.add(info.unitId);
          Promise.resolve(interiors.furnish(info.unitId, (info.unitId === currentUnit && currentStyle) || unitStyles[info.unitId] || 'atlantic')).then(() => { invalidateShadows(); poke(); }, () => { furnished.delete(info.unitId); });
        }
      } else setUnit(null);
    }
    poke();
  }
  function applyModeDetail(next) {
    if (next === 'exterior') { setInside(false); setDetail(phone ? 'near' : 'full'); setFloor('exterior'); setUnit(currentUnit || null); setShadows(true); }
    else if (next === 'aerial') { setInside(false); setDetail('full'); setFloor('exterior'); setUnit(currentUnit || null); setShadows(true); }
    else if (next === 'walk') {
      setShadows(quality === 'high');                      // low tier: no shadow pass while walking
      let info = null;
      try { const st = walker?.getState?.(); if (st) info = { floorId: st.floorId, roomId: st.roomId, unitId: st.unitId, inLift: st.inLift }; } catch (e) { info = null; }
      if (info) applyPlace(info); else { setDetail('near'); setFloor('ground'); }
    }
  }

  // Idle work after the first frame: interior texture prewarm, optional Google 3D tiles.
  function afterLoad() {
    const idle = (cb, ms) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(cb, { timeout: ms }) : setTimeout(cb, 400));
    idle(() => {
      if (disposed || !interiors) return;
      try {
        const p = (interiors.prewarm || null)?.(currentStyle || 'atlantic', { renderer });   // lazy: this package and its neighbours
        if (p && p.catch) p.catch(() => { /* optional */ });
      } catch (e) { /* optional */ }
    }, 3000);
    const key = PROJECT.googleMapsKey;
    if (env && typeof key === 'string' && key.trim().length >= 20) {
      Promise.resolve(env.fullReady || env.ready).catch(() => null).then(async () => {
        if (disposed) return;
        try {
          const m = await import('./google3d.js');
          if (!m.GOOGLE3D_AVAILABLE?.(key)) return;
          g3d = await m.createGoogle3D(THREE, { renderer, scene, camera, apiKey: key });
          if (!g3d || disposed) { g3d = null; return; }
          modules.google3d = true;
          applyGoogleVisibility();
          invalidateShadows();
          schedule();
        } catch (e) { console.warn('[viewer] google3d unavailable', e); g3d = null; }
      });
    }
  }

  // While the Google tiles show, hide the OSM context meshes (lights and the sky stay).
  // The context lives in env.bands (min / near / far groups); the far band exists only after env.fullReady.
  function setEnvContext(visible) {
    const b = env?.bands;
    if (!b) return;
    if (!visible) { for (const k of ['min', 'near', 'far']) if (b[k]) b[k].visible = false; g3dHidden = true; }
    else if (g3dHidden) {
      g3dHidden = null;
      const d = gov.detail || 'full';
      try { env.setDetail?.(d); } catch (e) { for (const k of ['min', 'near', 'far']) if (b[k]) b[k].visible = true; }
    }
  }
  function applyGoogleVisibility() {
    if (!g3d) return;
    const show = !ptOn; // the path tracer cannot trace the streamed tiles: photoreal shows the OSM context instead
    try { g3d.setVisible(show); } catch (e) { /* ignore */ }
    setEnvContext(!show);
    attribEl.hidden = !env?.attribution || show;
  }

  // Shadow tuning the viewer can apply on ENV's sun (ENV keeps ownership of colour/intensity/direction).
  function tuneShadows() {
    const sun = env?.sun;
    if (!sun || !sun.shadow) return;
    try {
      const tgt = sun.target.position;
      const dir = sun.position.clone().sub(tgt);
      const len = dir.length();
      if (len > 1e-3) sun.position.copy(tgt).addScaledVector(dir.multiplyScalar(1 / len), 60);
      sun.shadow.camera.far = 125;
      sun.shadow.camera.near = 1;
      sun.shadow.camera.updateProjectionMatrix();
      sun.shadow.bias = -0.00015;
      sun.shadow.normalBias = 0.035;
    } catch (e) { /* ignore */ }
    invalidateShadows();
  }
  function invalidateShadows() { if (renderer) renderer.shadowMap.needsUpdate = true; }
  ready.catch(err => { if (!disposed) emit('error', { error: err }); });

  function addFallbackEnvironment() {
    scene.background = new THREE.Color(0xc9d6df);
    scene.fog = new THREE.Fog(0xc9d6df, 120, 900);
    const hemi = new THREE.HemisphereLight(0xeef3f7, 0x8a7a66, 1.2);
    const sun = new THREE.DirectionalLight(0xfff0dc, 2.6);
    sun.position.set(-30, 40, 45);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { left: -25, right: 25, top: 25, bottom: -25, near: 1, far: 150 });
    sun.target.position.set(7, 0, 7);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshStandardMaterial({ color: 0xb9b2a6, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.86;
    ground.receiveShadow = true;
    ground.name = 'fallback-ground';
    fallbackLights = new THREE.Group();
    fallbackLights.name = 'fallback-environment';
    fallbackLights.add(hemi, sun, sun.target, ground);
    scene.add(fallbackLights);
  }

  // ---------- pointer (exterior floor picking) ----------
  function bindPointer() {
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const dom = renderer.domElement;
    let down = null;
    const pickers = () => (building?.floorPickers || []).map(p => p.mesh).filter(Boolean);
    const pick = (ev) => {
      const r = dom.getBoundingClientRect();
      ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const hit = ray.intersectObjects(pickers(), false)[0];
      if (!hit) return null;
      const p = building.floorPickers.find(fp => fp.mesh === hit.object);
      return p ? p.floorId : null;
    };
    const setHover = (floorId, ev) => {
      if (floorId !== hoveredFloor) {
        hoveredFloor = floorId;
        try { building.highlightFloor(floorId); } catch (e) { /* optional */ }
      }
      if (floorId && ev) {
        const r = container.getBoundingClientRect();
        floorTip.textContent = floorLabel(floorId);
        floorTip.hidden = false;
        floorTip.style.left = `${Math.min(ev.clientX - r.left + 14, r.width - 180)}px`;
        floorTip.style.top = `${Math.max(ev.clientY - r.top - 34, 8)}px`;
        dom.style.cursor = 'pointer';
      } else {
        floorTip.hidden = true;
        dom.style.cursor = '';
      }
    };
    listen(dom, 'pointermove', ev => {
      if (mode !== 'exterior') return;
      if (ev.pointerType === 'mouse' && ev.buttons) return;
      setHover(pick(ev), ev);
    });
    listen(dom, 'pointerleave', () => { if (mode === 'exterior') setHover(null); });
    // Double-tap / double-click = go forward. Detected by hand (two taps < 350 ms, < 30 px apart), never via 'dblclick':
    //   on a window or door → step inside through it; on the building from close by (< 12 m) → in through the nearest opening;
    //   anywhere else → the camera glides 35 % closer to the tapped point. A single tap on a floor still opens its plan,
    //   once the double-tap window has passed.
    const DTAP_MS = 350, DTAP_PX = 30, NEAR_M = 12;
    let lastTap = null, tapTimer = 0;
    listen(dom, 'pointerdown', ev => { down = { x: ev.clientX, y: ev.clientY, t: performance.now() }; lastIdle = performance.now(); controls.autoRotate = false; dolly = null; });
    listen(dom, 'pointerup', ev => {
      if (mode !== 'exterior' || !down) return;
      const moved = Math.hypot(ev.clientX - down.x, ev.clientY - down.y);
      const quick = performance.now() - down.t < 500;
      down = null;
      if (moved > 7 || !quick) { lastTap = null; return; }
      const f = pick(ev);
      setHover(f, ev);
      const now = performance.now();
      if (lastTap && now - lastTap.t < DTAP_MS && Math.hypot(ev.clientX - lastTap.x, ev.clientY - lastTap.y) < DTAP_PX) {
        clearTimeout(tapTimer); lastTap = null;
        if (ev.cancelable) ev.preventDefault();
        forward(ev);
        return;
      }
      lastTap = { x: ev.clientX, y: ev.clientY, t: now };
      clearTimeout(tapTimer);
      tapTimer = setTimeout(() => { lastTap = null; if (f && mode === 'exterior') emit('floor-select', { floorId: f }); }, DTAP_MS + 30);
    });
    listen(dom, 'dblclick', ev => { ev.preventDefault(); });
    // iOS: a second touch must not zoom the page
    let lastTouchEnd = 0;
    listen(dom, 'touchend', ev => { const n = performance.now(); if (n - lastTouchEnd < DTAP_MS + 50 && ev.cancelable) ev.preventDefault(); lastTouchEnd = n; }, { passive: false });
    const enterRay = new THREE.Raycaster();
    const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0.85);
    function forward(ev) {
      const r = dom.getBoundingClientRect();
      const p2 = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
      enterRay.setFromCamera(p2, camera);
      let target = null;
      if (building) {
        for (const h of enterRay.intersectObject(building.group, true)) {
          if (!h.object.visible || h.object.userData?.ui || h.object.material?.colorWrite === false) continue;
          let o = h.object, op = null;
          while (o && !op) { op = o.userData?.opening || null; o = o.parent; }
          target = { opening: op, point: h.point.clone(), distance: h.distance };
          break;
        }
      }
      // "on the building" = on its envelope (walls, glazing, roof), not the paving, planters or garden walls of the same group
      const onEnvelope = target && target.point.y > -0.4 && target.point.x > -0.6 && target.point.x < 14.5 && target.point.z > -0.6 && target.point.z < 15.6;
      if (target && walker && target.opening && target.opening.type === 'main') { setHover(null); setMode('walk', { street: true }); return; }   // the entrance: arrive at the front door
      if (target && walker && (target.opening || (onEnvelope && target.distance < NEAR_M))) { enterThrough(target); return; }
      let point = target ? target.point : null;
      if (!point) {
        const g = new THREE.Vector3();
        if (enterRay.ray.intersectPlane(ground, g) && g.distanceTo(camera.position) < 400) point = g;
        else point = enterRay.ray.at(camera.position.distanceTo(controls.target), new THREE.Vector3());
      }
      dollyTowards(point);
    }
    function dollyTowards(point) {
      const c0 = camera.position.clone(), g0 = controls.target.clone();
      const dist = c0.distanceTo(g0);
      // camera and orbit target both move towards the point, so the orbit distance shrinks by the same factor
      const k = Math.max(0, Math.min(0.35, 1 - controls.minDistance / Math.max(dist, 1e-3)));
      const c1 = c0.clone().lerp(point, 0.35), g1 = g0.clone().lerp(point, 0.35);
      if (k < 0.35) c1.copy(g1).add(c0.clone().sub(g0).setLength(Math.max(controls.minDistance, dist * (1 - k))));   // clamp: never closer than minDistance
      c1.y = Math.max(c1.y, 0.4);
      g1.y = Math.max(g1.y, 0);
      dolly = { t0: performance.now(), ms: reducedMotion ? 1 : 600, c0, c1, g0, g1 };
      lastIdle = performance.now();
      schedule();
    }
    async function enterThrough(target) {
      if (!walker || !building) return;
      setHover(null);
      const ok = await setMode('walk', { keep: true });
      if (ok === false) return;
      let res = false;
      try { if (typeof walker.enterAt === 'function') res = (target.opening && walker.enterAt(target.opening)) || walker.enterAt(target.point); } catch (e) { res = false; }
      if (!res) { try { walker.goToLift('ground'); } catch (e) { /* stay */ } }
      emit('enter', { via: target.opening || null });
    }
    cleanups.push(() => { floorTip.hidden = true; });
  }

  // ---------- loop ----------
  let paused = false;
  function shouldRun() {
    return !disposed && !paused && renderer && inView && !document.hidden && container.isConnected && container.offsetParent !== null;
  }
  function schedule() {
    if (shouldRun()) {
      if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
    } else if (raf) { cancelAnimationFrame(raf); raf = 0; }
  }
  function frame(now) {
    raf = 0;
    if (!shouldRun()) return;
    // Render on demand: with nothing happening (camera still, no input, no transition) the loop idles at ≤ 10 fps — slow
    // animations (water, a door closing) still play, and the phone stays cool. Any input or camera move restores full rate.
    const idle = now > gov.activeUntil && !ptOn && !dolly && !(mode === 'exterior' && controls.autoRotate) && mode !== 'aerial';
    if (idle && now - gov.lastRender < 100) { gov.consec = 0; raf = requestAnimationFrame(frame); return; }
    const dt = Math.min((now - last) / 1000, 0.1);
    if (!idle && gov.consec > 2) govSample(now - last, now);
    gov.consec = idle ? 0 : (gov.consec || 0) + 1;
    last = now;
    gov.lastRender = now;
    try {
      if (mode === 'exterior') {
        if (dolly) {
          const u = Math.min(1, (now - dolly.t0) / dolly.ms), e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
          camera.position.lerpVectors(dolly.c0, dolly.c1, e);
          controls.target.lerpVectors(dolly.g0, dolly.g1, e);
          if (u >= 1) dolly = null;
          lastIdle = now;
        }
        if (!reducedMotion && !controls.autoRotate && now - lastIdle > 9000) controls.autoRotate = true;
        controls.update();
      }
      env?.update?.(dt, camera);
      building?.update?.(dt);
      interiors?.update?.(dt);
      if (mode === 'walk' && walker) walker.update(dt);
      if (mode === 'aerial' && aerial) aerial.update(dt);
      if (g3d) { try { g3d.update(dt); } catch (e) { /* google3d switches itself off */ } }
      // static shadow map: redrawn on light / mode / floor changes; on the high tier also twice a second while walking (doors, lift)
      if (mode === 'walk' && gov.shadows && !idle && ++shadowTick % 30 === 0) invalidateShadows();
      camera.updateMatrixWorld();
      const m = camera.matrixWorld.elements;
      let moved = false;
      for (let i = 0; i < 16; i++) if (Math.abs(m[i] - lastCam[i]) > 1e-5) { moved = true; lastCam[i] = m[i]; }
      if (moved) { gov.lastMove = now; if (!gov.moving) { gov.moving = true; if (phone) applyPR(); } }
      else if (gov.moving && now - gov.lastMove > 400) { gov.moving = false; if (phone) applyPR(); }
      if (ptOn && pt) {
        if (moved) pt.reset();
        pt.render();
      } else if (usePostfx()) postfx.render(dt);
      else renderer.render(scene, camera);
      if (moved) poke(700);                                 // counted from the END of the frame, so slow frames stay "active"
    } catch (e) {
      console.error('[viewer] frame', e);
    }
    raf = requestAnimationFrame(frame);
  }

  function resize() {
    if (!renderer) return;
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    gov.pr = targetPR();
    renderer.setPixelRatio(gov.pr);
    renderer.setSize(w, h, false);
    poke();
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    try { postfx?.setSize(w, h); } catch (e) { /* ignore */ }
    if (ptOn) pt?.reset();
    schedule();
  }

  // ---------- modes ----------
  function exitCurrent() {
    if (mode === 'walk' && walker) { try { walker.disable(); } catch (e) { /* ignore */ } }
    if (mode === 'aerial' && aerial) { try { aerial.disable(); } catch (e) { /* ignore */ } }
    if (mode === 'exterior') {
      try { building?.highlightFloor(null); } catch (e) { /* ignore */ }
      hoveredFloor = null;
      floorTip.hidden = true;
    }
    lookState = null;
    dolly = null;
    controls.enabled = false;
    controls.autoRotate = false;
    hudEl.classList.remove('is-active');
    labelsEl.classList.remove('is-active');
  }

  function setClip(near, far) {
    camera.near = near; camera.far = far; camera.updateProjectionMatrix();
  }

  async function setMode(next, opts = {}) {
    try { await ready; } catch (e) { return false; }
    return applyMode(next, opts);
  }

  async function applyMode(next, opts = {}) {
    if (disposed || !renderer) return false;
    if (next === 'walk' && !walker && !(opts.position && opts.lookAt)) return false;
    if (next === 'aerial' && !aerial) return false;
    if (next === 'aerial' && ptOn) await setPhotoreal(false);
    if (next !== mode || next === 'walk') {
      if (!(mode === 'walk' && next === 'walk')) exitCurrent();
    }
    const prev = mode;
    mode = next;
    try {
      if (next === 'exterior') {
        setClip(0.3, 30000);
        try { building?.setCutaway?.(null); } catch (e) { /* ignore */ }
        if (prev !== 'exterior') {
          camera.position.set(...(opts.cameraPosition || EXTERIOR_CAMERA));
          controls.target.set(...EXTERIOR_TARGET);
        }
        controls.enabled = true;
        controls.update();
        lastIdle = performance.now();
      } else if (next === 'aerial') {
        setClip(1, 60000);
        labelsEl.classList.add('is-active');
        aerial.setLang?.(lang);
        aerial.enable();
      } else if (next === 'walk') {
        setClip(0.1, 30000);
        if (walker) {
          hudEl.classList.add('is-active');
          if (!walker.isEnabled?.()) walker.enable();
          if (opts.unitId) walker.goToUnit(opts.unitId, opts.roomId);
          else if (opts.liftFloor) walker.goToLift(opts.liftFloor);
          else if (opts.position && opts.lookAt) walker.teleport(opts.position, opts.lookAt);
          else if (opts.street || prev !== 'walk') {
            // default: arrive on the street, facing the front door (tap it to open, walk into the lobby)
            let ok = false;
            try { ok = !!walker.goToStreet?.(); } catch (e) { ok = false; }
            if (!ok) walker.teleport(new THREE.Vector3(...LOBBY_VIEW.position), new THREE.Vector3(...LOBBY_VIEW.lookAt));
          }
        } else {
          // static look without a walker module
          camera.position.copy(opts.position);
          camera.lookAt(opts.lookAt);
          lookState = true;
        }
      }
    } catch (e) {
      console.error('[viewer] setMode', next, e);
    }
    try { postfx?.setMode(next === 'walk' ? 'interior' : next); } catch (e) { /* ignore */ }
    if (ptOn && pt) { try { pt.setScope(next === 'walk' ? 'interior' : 'exterior'); pt.reset(); } catch (e) { /* ignore */ } }
    if (next === 'exterior' && ptOn) controls.autoRotate = false;
    applyModeDetail(next);
    applyGoogleVisibility();
    invalidateShadows();
    poke(2500);
    emit('mode', { mode: next, prev });
    schedule();
    return true;
  }

  // Ceilings etc. flagged material.userData.rasterEmissive glow only to fake bounce light in the rasteriser:
  // the path tracer computes the real thing, so they are switched off while it runs.
  const mutedEm = new Map();
  function muteRasterEmissive(on) {
    if (on) {
      scene.traverse(o => {
        const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
        for (const m of ms) if (m.userData?.rasterEmissive && !mutedEm.has(m)) { mutedEm.set(m, m.emissiveIntensity); m.emissiveIntensity = 0; }
      });
    } else { for (const [m, v] of mutedEm) m.emissiveIntensity = v; mutedEm.clear(); }
  }

  // ---------- photoreal (progressive path tracing) ----------
  async function setPhotoreal(on) {
    on = !!on;
    if (on === ptOn && !ptLoading) return ptOn;
    if (!on) {
      ptOn = false;
      try { pt?.stop(); } catch (e) { /* ignore */ }
      muteRasterEmissive(false);
      applyGoogleVisibility();
      lastIdle = performance.now();
      emit('photoreal', { state: 'off' });
      schedule();
      return false;
    }
    try { await ready; } catch (e) { return false; }
    if (mode === 'aerial') return false;
    if (ptLoading) return ptLoading;
    ptLoading = (async () => {
      emit('photoreal', { state: 'loading', phase: 'load', p: 0 });
      try {
        if (!pt) {
          const m = await import('./pathtrace.js');
          pt = await m.createPathTracer(THREE, {
            renderer, scene, camera,
            onProgress: o => {
              if (!o) return;
              if (o.phase === 'error') {
                if (ptOn) { ptOn = false; applyGoogleVisibility(); }
                emit('photoreal', { state: 'error', error: o.error });
                schedule();
              } else emit('photoreal', { state: ptOn ? 'on' : 'loading', ...o });
            }
          });
          if (!pt) throw new Error('path tracer unavailable');
          modules.pathtrace = true;
          if (ptLabels) { try { pt.setLabels?.(ptLabels); } catch (e) { /* optional */ } }
        }
        pt.setScope(mode === 'walk' ? 'interior' : 'exterior');
        muteRasterEmissive(true);
        ptOn = true;
        if (controls) controls.autoRotate = false;
        applyGoogleVisibility();
        const ok = await pt.start();
        if (ok === false || !pt.isActive?.()) {
          ptOn = false; applyGoogleVisibility();
          emit('photoreal', { state: 'error', error: new Error('path tracer did not start') });
          return false;
        }
        emit('photoreal', { state: 'on', samples: 0 });
        schedule();
        return true;
      } catch (e) {
        console.warn('[viewer] photoreal unavailable', e);
        ptOn = false; applyGoogleVisibility();
        emit('photoreal', { state: 'error', error: e });
        return false;
      } finally {
        ptLoading = null;
      }
    })();
    return ptLoading;
  }

  // ---------- unit helpers ----------
  async function selectUnit(unitId, styleId) {
    currentUnit = unitId;
    currentStyle = styleId || currentStyle;
    if (unitId && styleId) unitStyles[unitId] = styleId;
    try { await ready; } catch (e) { return; }
    if (interiors && unitId) {
      furnished.add(unitId);
      try { await interiors.furnish(unitId, styleId || 'atlantic'); } catch (e) { console.warn('[viewer] furnish', e); }
      if (mode !== 'walk') { gov.unit = undefined; setUnit(unitId); }
      poke(3000);
      invalidateShadows();
      if (ptOn) pt?.reset();
    }
    emit('unit-select', { unitId, styleId, source: 'app' });
  }

  function hotspots(unitId) {
    if (!THREE) return [];
    if (interiors?.getHotspots) {
      try {
        const hs = interiors.getHotspots(unitId);
        if (Array.isArray(hs) && hs.length) return hs;
      } catch (e) { console.warn(e); }
    }
    // Fallback: one eye point per room at its centroid, looking along the long axis.
    return roomsOfUnit(unitId).filter(r => r.use !== 'wc').map(r => {
      const [cx, cz] = centroid(r.poly);
      const xs = r.poly.map(p => p[0]), zs = r.poly.map(p => p[1]);
      const wide = (Math.max(...xs) - Math.min(...xs)) > (Math.max(...zs) - Math.min(...zs));
      const eye = new THREE.Vector3(cx, r.y + 1.6, cz);
      const look = wide ? new THREE.Vector3(cx + 3, r.y + 1.4, cz) : new THREE.Vector3(cx, r.y + 1.4, cz - 3);
      return { roomId: r.id, name: r.name, position: eye, lookAt: look };
    });
  }

  async function lookFrom(h) {
    if (!h) return false;
    try { await ready; } catch (e) { return false; }
    return setMode('walk', { position: h.position.clone ? h.position.clone() : h.position, lookAt: h.lookAt });
  }

  function balconyTarget(unitId) {
    const hs = hotspots(unitId);
    const out = hs.find(h => /balcony|garden|deck|terrace/i.test(`${h.roomId} ${h.name?.en || ''}`));
    if (out) return out;
    const u = unitById(unitId);
    const b = BALCONIES.find(x => x.unit.includes(unitId));
    if (!u || !b) return hs[0];
    let poly = b.poly;
    if (b.split != null) {
      const left = b.unit.indexOf(unitId) === 0;
      poly = poly.map(([x, z]) => [left ? Math.min(x, b.split - 0.1) : Math.max(x, b.split + 0.1), z]);
    }
    const [cx, cz] = centroid(poly);
    const y = LEVELS[u.floor].y;
    const outward = cz < 7 ? -1 : 1;
    return {
      roomId: b.id, name: { en: 'Balcony' },
      position: new THREE.Vector3(cx, y + 1.62, cz - outward * 0.2),
      lookAt: new THREE.Vector3(cx + (u.floor === 'second' ? 6 : 2), y + (u.floor === 'second' ? 0.4 : 1.2), cz + outward * 60)
    };
  }

  async function balconyView(unitId) {
    try { await ready; } catch (e) { return false; }
    const h = balconyTarget(unitId);
    return h ? lookFrom(h) : false;
  }

  async function walkUnit(unitId, roomId) {
    try { await ready; } catch (e) { return false; }
    if (!walker) { const h = hotspots(unitId)[0]; return h ? lookFrom(h) : false; }
    return setMode('walk', { unitId, roomId });
  }

  async function goToLift(floorId) {
    try { await ready; } catch (e) { return false; }
    if (!walker) return false;
    return setMode('walk', { liftFloor: floorId || 'ground' });
  }

  // Pose for the 3D ⇄ photoreal switch. Yaw convention (same as tour.js): direction = (−sin ψ, 0, −cos ψ).
  function getPose() {
    if (mode !== 'walk' || !walker) return null;
    try {
      const st = walker.getState();
      return { x: st.x, y: st.eyeY, z: st.z, yaw: st.yaw, pitch: st.pitch, floorId: st.floorId, roomId: st.roomId, unitId: st.unitId, inLift: !!st.inLift, riding: !!st.riding, outside: !!st.outside };
    } catch (e) { return null; }
  }
  async function setPose({ x, y, z, yaw = 0 }) {
    try { await ready; } catch (e) { return false; }
    if (!walker) return false;
    const pos = new THREE.Vector3(x, y, z);
    return setMode('walk', { position: pos, lookAt: new THREE.Vector3(x - Math.sin(yaw) * 4, y, z - Math.cos(yaw) * 4) });
  }
  async function goToStreet() {
    try { await ready; } catch (e) { return false; }
    if (!walker) return false;
    return setMode('walk', { street: true });
  }
  function getPerf() {
    const i = renderer?.info;
    let w = null;
    try { w = walker?.getPerf?.() || null; } catch (e) { w = null; }
    return {
      tier: quality, phone, level: gov.level, pixelRatio: gov.pr, postfx: usePostfx(), shadows: gov.shadows, detail: gov.detail, floor: gov.floor, unit: gov.unit, inside: gov.inside,
      avgMs: gov.n ? +(gov.sum / gov.n).toFixed(1) : null, calls: i?.render.calls ?? null, triangles: i?.render.triangles ?? null,
      geometries: i?.memory.geometries ?? null, textures: i?.memory.textures ?? null, programs: i?.programs?.length ?? null, walker: w, log: gov.log.slice()
    };
  }

  // Entry points for the 3D bar. Lobby: just inside the street door, looking down the hall to the lift.
  const LOBBY_VIEW = { position: [9.4, 1.62, 13.6], lookAt: [5, 1.5, 9.6] };
  async function goToLobby() {
    try { await ready; } catch (e) { return false; }
    if (!walker) return false;
    return setMode('walk', { position: new THREE.Vector3(...LOBBY_VIEW.position), lookAt: new THREE.Vector3(...LOBBY_VIEW.lookAt) });
  }

  // Car park: stand in the aisle at the foot of the ramp and look across the row of bays (positions from data.js PARKING / RAMP).
  function parkingView() {
    const y = LEVELS.basement.y;
    const row = PARKING.filter(p => !p.rotated);                       // the bays along the west wall
    const aisleX0 = Math.max(...row.map(p => p.x1));
    const near = row.filter(p => p.z1 > RAMP.zBottom - 6);              // the bays closest to the ramp foot
    const cz = near.reduce((a, p) => a + (p.z0 + p.z1) / 2, 0) / Math.max(1, near.length);
    const x = Math.min(RAMP.x0 - 1.2, aisleX0 + (RAMP.x0 - aisleX0) * 0.62);
    const z = RAMP.zBottom + 1.6;
    return {
      position: new THREE.Vector3(x, y + 1.62, z),
      lookAt: new THREE.Vector3((Math.min(...row.map(p => p.x0)) + aisleX0) / 2, y + 0.95, cz)
    };
  }
  async function goToParking() {
    try { await ready; } catch (e) { return false; }
    if (!walker) return false;
    return setMode('walk', parkingView());
  }

  // Start in the lift at `from` and ride to `to` (walker.ride animates doors, cab and camera).
  async function takeLift(from = 'basement', to = 'ground') {
    try { await ready; } catch (e) { return false; }
    if (!walker) return false;
    await setMode('walk', { liftFloor: from });
    if (from !== to) {
      try { await new Promise(r => setTimeout(r, 450)); await walker.ride(to); } catch (e) { console.warn('[viewer] ride', e); }
    }
    return true;
  }

  // Light: 'day' | 'dusk' | 'night' (the buttons) plus 'golden', the default exterior look until a button is used.
  const TODS = ['day', 'golden', 'dusk', 'night'];
  const interiorTod = name => (name === 'golden' ? 'day' : name);
  function applyExposure() {
    if (!renderer) return;
    let ex = 1;
    try { if (env && typeof env.exposureFor === 'function') ex = env.exposureFor(tod); } catch (e) { ex = 1; }
    renderer.toneMappingExposure = Number.isFinite(ex) && ex > 0 ? ex : 1;
  }
  function setTimeOfDay(name) {
    if (!TODS.includes(name)) return false;
    if (env && Array.isArray(env.timesOfDay) && !env.timesOfDay.includes(name)) name = name === 'night' ? 'dusk' : 'day';
    tod = name;
    if (env) { try { env.setTimeOfDay(name); } catch (e) { console.warn(e); } tuneShadows(); }
    applyExposure();
    try { interiors?.setTimeOfDay?.(interiorTod(name)); } catch (e) { console.warn('[viewer] interiors light', e); }
    try { postfx?.setTimeOfDay?.(name === 'night' ? 'dusk' : name); } catch (e) { /* ignore */ }
    invalidateShadows();
    if (ptOn) { try { pt.stop(); pt.start(); } catch (e) { /* sky changed: rebuild the captured environment */ } }
    else if (fallbackLights && THREE) {
      const bg = { day: 0xc9d6df, golden: 0xe8c9a4, dusk: 0x3b4660, night: 0x0d1220 }[name] || 0xc9d6df;
      scene.background = new THREE.Color(bg);
      scene.fog.color.set(bg);
    }
    poke(2000);
    emit('time', { timeOfDay: name });
    schedule();
    return true;
  }

  function setLang(l) {
    lang = l;
    try { aerial?.setLang?.(l); } catch (e) { /* ignore */ }
    try { walker?.setLang?.(l); } catch (e) { /* ignore */ }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    try { exitCurrent(); } catch (e) { /* ignore */ }
    try { pt?.dispose(); } catch (e) { /* ignore */ }
    try { g3d?.dispose(); } catch (e) { /* ignore */ }
    try { postfx?.dispose(); } catch (e) { /* ignore */ }
    for (const c of cleanups.splice(0)) { try { c(); } catch (e) { /* ignore */ } }
    try { controls?.dispose(); } catch (e) { /* ignore */ }
    try {
      scene?.traverse(o => {
        o.geometry?.dispose?.();
        const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
        for (const m of mats) {
          for (const k in m) { const v = m[k]; if (v && v.isTexture) v.dispose(); }
          m.dispose?.();
        }
      });
    } catch (e) { /* ignore */ }
    try { envTex?.dispose(); pmrem?.dispose(); } catch (e) { /* ignore */ }
    try { renderer?.dispose(); renderer?.forceContextLoss?.(); } catch (e) { /* ignore */ }
    renderer?.domElement?.remove();
    container.classList.remove('v-root');
    canvasHost.remove(); labelsEl.remove(); hudEl.remove(); floorTip.remove(); attribEl.remove();
    for (const k of Object.keys(listeners)) delete listeners[k];
  }

  return {
    ready,
    setMode,
    getMode: () => mode,
    selectUnit,
    currentUnit: () => currentUnit,
    setTimeOfDay,
    getTimeOfDay: () => tod,
    setLang,
    setFloorLabel: fn => { floorLabel = fn; },
    hotspots,
    lookFrom,
    balconyView,
    walkUnit,
    goToLift,
    goToLobby,
    goToParking,
    goToStreet,
    getPose,
    setPose,
    getPerf,
    setLevel: (l) => setLevel(l, 'manual'),
    _modules: () => ({ building, interiors, walker, env, renderer }),   // tests only
    takeLift,
    resize,
    setPaused: b => { paused = !!b; schedule(); },   // freeze the loop (tests, screenshots); the last frame stays
    setPhotoreal,
    isPhotoreal: () => ptOn,
    setPhotorealLabels: l => { ptLabels = l; try { pt?.setLabels?.(l); } catch (e) { /* optional */ } },
    setHeading: b => { try { aerial?.setHeading?.(b); } catch (e) { /* ignore */ } },
    attribution: () => env?.attribution || '',
    has: name => !!modules[name],
    modules: () => ({ ...modules }),
    on,
    dispose,
    quality
  };
}

export const UNIT_IDS = UNITS.map(u => u.id);
