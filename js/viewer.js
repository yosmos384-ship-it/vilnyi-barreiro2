// VILNYI · Barreiro 2 — 3D viewer (APP agent).
// Owns the single WebGLRenderer, camera, scene and render loop, and composes the
// environment / building / interiors / walk / aerial modules. Every module is loaded
// with a guarded dynamic import so a failing module never breaks the site.
//
// API:
//   createViewer(container, { quality, floorLabel(floorId) => string, lang }) => {
//     ready: Promise<{ modules }>, setMode(mode, opts) => Promise<boolean>, getMode(),
//     selectUnit(unitId, styleId) => Promise, setTimeOfDay(name), setLang(lang),
//     hotspots(unitId) => [...], lookFrom(hotspot), balconyView(unitId), goToLift(floorId),
//     walkUnit(unitId, roomId?), takeLift(from, to), resize(), has(moduleName), on(event, cb) => off, dispose()
//   }
//   events: 'floor-select' {floorId} · 'unit-select' {unitId, styleId?, source} · 'mode' {mode}
//           'progress' {p, label} · 'place' {floorId, roomId, unitId, inLift} · 'error' {error}

import { UNITS, BALCONIES, LEVELS, roomsOfUnit, unitById } from './data.js';

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

  const small = Math.min(window.innerWidth, window.innerHeight) < 700;
  const quality = options.quality || (small || (navigator.deviceMemory || 8) <= 4 ? 'low' : 'high');
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

  let THREE, renderer, scene, camera, controls, pmrem, envTex;
  let env = null, building = null, interiors = null, walker = null, aerial = null;
  let fallbackLights = null;
  const modules = { environment: false, building: false, interiors: false, walk: false, aerial: false };
  let mode = null;
  let disposed = false;
  let raf = 0;
  let last = 0;
  let inView = true;
  let hoveredFloor = null;
  let currentUnit = null;
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
      const r = build(m);
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
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality === 'high' ? 2 : 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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
    else { try { env.setTimeOfDay(tod); } catch (e) { console.warn(e); } }
    await tick();

    progress(0.5, 'building');
    building = await loadModule('building', './building.js', m => m.buildBuilding(THREE, { scene, renderer }));
    if (!building) throw Object.assign(new Error('The building model failed to load'), { code: 'building' });
    await tick();

    progress(0.68, 'interiors');
    interiors = await loadModule('interiors', './interiors.js', m => m.buildInteriors(THREE, { scene }));
    await tick();

    progress(0.8, 'walk');
    walker = await loadModule('walk', './walk.js', m => m.createWalker(THREE, { camera, dom: renderer.domElement, scene, building, overlay: hudEl }));
    if (walker) {
      try { walker.disable(); } catch (e) { /* not enabled yet */ }
      try {
        let lastUnit = null;
        walker.onChange(info => {
          emit('place', info);
          if (info && info.unitId && info.unitId !== lastUnit) emit('unit-select', { unitId: info.unitId, source: 'walk' });
          lastUnit = info ? info.unitId : null;
        });
      } catch (e) { console.warn(e); }
    }
    await tick();

    progress(0.9, 'aerial');
    if (env) {
      aerial = await loadModule('aerial', './aerial.js', m => m.createAerial(THREE, { camera, dom: renderer.domElement, scene, environment: env, labelsEl, lang }));
      if (aerial) { try { aerial.disable(); } catch (e) { /* ignore */ } }
    }

    bindPointer();
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

    await applyMode(options.initialMode || 'exterior', options.initialOpts || {});
    renderer.render(scene, camera);
    progress(1, 'done');
    schedule();
    return { modules: { ...modules }, quality };
  })();
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
    listen(dom, 'pointerdown', ev => { down = { x: ev.clientX, y: ev.clientY, t: performance.now() }; lastIdle = performance.now(); controls.autoRotate = false; });
    listen(dom, 'pointerup', ev => {
      if (mode !== 'exterior' || !down) return;
      const moved = Math.hypot(ev.clientX - down.x, ev.clientY - down.y);
      const quick = performance.now() - down.t < 500;
      down = null;
      if (moved > 7 || !quick) return;
      const f = pick(ev);
      setHover(f, ev);
      if (f) emit('floor-select', { floorId: f });
    });
    cleanups.push(() => { floorTip.hidden = true; });
  }

  // ---------- loop ----------
  function shouldRun() {
    return !disposed && renderer && inView && !document.hidden && container.isConnected && container.offsetParent !== null;
  }
  function schedule() {
    if (shouldRun()) {
      if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
    } else if (raf) { cancelAnimationFrame(raf); raf = 0; }
  }
  function frame(now) {
    raf = 0;
    if (!shouldRun()) return;
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    try {
      if (mode === 'exterior') {
        if (!reducedMotion && !controls.autoRotate && now - lastIdle > 9000) controls.autoRotate = true;
        controls.update();
      }
      env?.update?.(dt, camera);
      building?.update?.(dt);
      interiors?.update?.(dt);
      if (mode === 'walk' && walker) walker.update(dt);
      if (mode === 'aerial' && aerial) aerial.update(dt);
      renderer.render(scene, camera);
    } catch (e) {
      console.error('[viewer] frame', e);
    }
    raf = requestAnimationFrame(frame);
  }

  function resize() {
    if (!renderer) return;
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
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
        setClip(0.05, 30000);
        if (walker) {
          hudEl.classList.add('is-active');
          if (!walker.isEnabled?.()) walker.enable();
          if (opts.unitId) walker.goToUnit(opts.unitId, opts.roomId);
          else if (opts.liftFloor) walker.goToLift(opts.liftFloor);
          else if (opts.position && opts.lookAt) walker.teleport(opts.position, opts.lookAt);
          else if (prev !== 'walk') {
            // default: step into the lobby from the front door
            walker.teleport(new THREE.Vector3(9.4, 1.62, 13.6), new THREE.Vector3(5, 1.5, 9.6));
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
    emit('mode', { mode: next, prev });
    schedule();
    return true;
  }

  // ---------- unit helpers ----------
  async function selectUnit(unitId, styleId) {
    currentUnit = unitId;
    try { await ready; } catch (e) { return; }
    if (interiors && unitId) {
      try { await interiors.furnish(unitId, styleId || 'atlantic'); } catch (e) { console.warn('[viewer] furnish', e); }
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

  function setTimeOfDay(name) {
    tod = name;
    if (env) { try { env.setTimeOfDay(name); } catch (e) { console.warn(e); } }
    else if (fallbackLights && THREE) {
      const bg = { day: 0xc9d6df, golden: 0xe8c9a4, dusk: 0x3b4660 }[name] || 0xc9d6df;
      scene.background = new THREE.Color(bg);
      scene.fog.color.set(bg);
    }
    schedule();
  }

  function setLang(l) {
    lang = l;
    try { aerial?.setLang?.(l); } catch (e) { /* ignore */ }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    try { exitCurrent(); } catch (e) { /* ignore */ }
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
    canvasHost.remove(); labelsEl.remove(); hudEl.remove(); floorTip.remove();
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
    takeLift,
    resize,
    has: name => !!modules[name],
    modules: () => ({ ...modules }),
    on,
    dispose,
    quality
  };
}

export const UNIT_IDS = UNITS.map(u => u.id);
