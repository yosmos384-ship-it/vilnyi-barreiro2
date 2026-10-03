// VILNYI · Barreiro 2 — optional Google Photorealistic 3D Tiles context (agent: GOOGLE3D).
//
//   export const GOOGLE3D_AVAILABLE = (key) => boolean
//   export async function createGoogle3D(THREE, { renderer, scene, camera, apiKey }) => { group, setVisible(b), update(dt), dispose() } | null
//
// Streams Google's real-world photogrammetry around the plot (self-hosted builds only: claude.ai's CSP blocks
// tile.googleapis.com) with NASA-AMMOS 3DTilesRendererJS 0.3.46 (`3d-tiles-renderer`, loaded with a dynamic import
// so a missing importmap entry just means "no Google tiles"). The tileset is placed in our local frame
// (see data.js SITE_FRAME / geoToLocal): PROJECT.lat/lon -> local (≈7, y, ≈7), local +x = bearing 61.38°,
// local -z = bearing 331.38°, y = 0 at the ground floor (+12.70 m orthometric ≈ 67.70 m WGS84-ellipsoidal).
// Tile fragments inside an oriented box around our plot are discarded in the shader, so the real empty lot
// never shows through our building. Every failure is silent: createGoogle3D resolves to null, or the instance
// switches itself off (setVisible becomes a no-op) and the site keeps the OSM context.
import { PROJECT, SITE_FRAME, geoToLocal } from './data.js?v=202610031619';

export const GOOGLE3D_LIB_VERSION = '0.3.46';

// EGM2008 / GeodPT08 geoid undulation at Barreiro is ≈ +55 m (Portugal mainland spans ≈ +49…+57 m; Lisbon area ≈ 54–56 m).
// Any residual error (geoid, Google's own vertical datum error) is removed at runtime by calibrate() below,
// which snaps the real street surface in front of the plot to our street level.
const GEOID_N = 55.0;
const GROUND_ORTHO = 12.70;                 // ±0.00 above mean sea level (drawings)
const STREET_TARGET_Y = -0.9;               // road/pavement surface in front of the plot (STREET_Y = -0.85 kerb top)
const CAL_MAX = 8;                          // ignore calibration corrections larger than this (bad data / coarse LOD)
// Oriented clip box in the local model frame (axis-aligned here): Google geometry inside it is discarded.
const CLIP_MIN = [-0.5, -3.0, -8.2];
const CLIP_MAX = [14.4, 30.0, 17.6];
const SITE = { x: 7, z: 7 };

const JSDELIVR_DRACO = 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/draco/gltf/';

function blockedHost() {
  try {
    const re = /(^|\.)(claude\.ai|claude\.site|claudeusercontent\.com|anthropic\.com)$/i;
    if (re.test(location.hostname || '')) return true;
    if (location.protocol !== 'https:' && location.protocol !== 'http:') return true;   // file:, blob:, about:srcdoc…
    const anc = location.ancestorOrigins;
    if (anc) for (let i = 0; i < anc.length; i++) {
      try { if (re.test(new URL(anc[i]).hostname)) return true; } catch (e) { /* ignore */ }
    }
    if (window.top !== window.self) {
      try { if (re.test(window.top.location.hostname)) return true; } catch (e) { /* cross-origin parent: unknown, allow */ }
    }
  } catch (e) { return true; }
  return false;
}

export const GOOGLE3D_AVAILABLE = (key) => {
  try {
    if (typeof key !== 'string' || key.trim().length < 20) return false;
    if (typeof window === 'undefined' || typeof fetch !== 'function') return false;
    return !blockedHost();
  } catch (e) { return false; }
};

// WGS84 geodetic -> ECEF (metres)
function ecef(latDeg, lonDeg, h) {
  const a = 6378137.0, f = 1 / 298.257223563, e2 = f * (2 - f);
  const la = latDeg * Math.PI / 180, lo = lonDeg * Math.PI / 180;
  const N = a / Math.sqrt(1 - e2 * Math.sin(la) ** 2);
  return [(N + h) * Math.cos(la) * Math.cos(lo), (N + h) * Math.cos(la) * Math.sin(lo), (N * (1 - e2) + h) * Math.sin(la)];
}

// Matrix taking ECEF (the TilesRenderer group's local space) into our local model frame.
function frameMatrix(THREE, target, yOffset) {
  const lat = PROJECT.lat, lon = PROJECT.lon;
  const la = lat * Math.PI / 180, lo = lon * Math.PI / 180;
  const E = [-Math.sin(lo), Math.cos(lo), 0];
  const N = [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)];
  const U = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
  // true north in local (x, z) = (cos bx, -sin bx), bx = compass bearing of local +x
  const nx = SITE_FRAME.north.x, nz = SITE_FRAME.north.z;
  const cb = nx, sb = -nz;
  const X = [0, 1, 2].map(i => sb * E[i] + cb * N[i]);      // local +x (bearing 61.38°)
  const Z = [0, 1, 2].map(i => cb * E[i] - sb * N[i]);      // local +z (bearing 151.38°)
  const Y = U;
  const P0 = ecef(lat, lon, GROUND_ORTHO + GEOID_N);
  const A = geoToLocal(lat, lon);                            // ≈ (7, 7): keeps Google consistent with the OSM context
  const dot = (r, p) => r[0] * p[0] + r[1] * p[1] + r[2] * p[2];
  target.set(
    X[0], X[1], X[2], A.x - dot(X, P0),
    Y[0], Y[1], Y[2], yOffset - dot(Y, P0),
    Z[0], Z[1], Z[2], A.z - dot(Z, P0),
    0, 0, 0, 1
  );
  return target;
}

function dracoDecoderPath() {
  try {
    if (typeof import.meta.resolve === 'function') {
      const base = import.meta.resolve('three/addons/');
      if (base && /^https?:/.test(base)) return new URL('libs/draco/gltf/', base).href;
    }
  } catch (e) { /* fall through */ }
  return JSDELIVR_DRACO;
}

function isSmallDevice() {
  try { return Math.min(screen.width, screen.height) < 700 || /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent); } catch (e) { return false; }
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

export async function createGoogle3D(THREE, opts = {}) {
  const { renderer, scene, camera, apiKey } = opts;
  // optional, undocumented (tests / calibration): rootURL, force, heightOffset, calibrate, timeout
  const rootURL = opts.rootURL || null;
  let tiles = null, outer = null, attribEl = null, draco = null;
  const cleanup = () => {
    try { if (tiles) tiles.dispose(); } catch (e) { /* ignore */ }
    try { if (outer && outer.parent) outer.parent.remove(outer); } catch (e) { /* ignore */ }
    try { if (attribEl && attribEl.parentNode) attribEl.parentNode.removeChild(attribEl); } catch (e) { /* ignore */ }
    try { if (draco) draco.dispose(); } catch (e) { /* ignore */ }
  };
  try {
    if (!THREE || !renderer || !scene || !camera) return null;
    if (!opts.force && !GOOGLE3D_AVAILABLE(apiKey)) return null;

    let lib, plug;
    try {
      [lib, plug] = await Promise.all([import('3d-tiles-renderer'), import('3d-tiles-renderer/plugins')]);
    } catch (e) { return null; }
    if (!lib || !lib.TilesRenderer || !plug || !plug.GoogleCloudAuthPlugin) return null;

    tiles = new lib.TilesRenderer(rootURL);
    tiles.registerPlugin(new plug.GoogleCloudAuthPlugin({ apiToken: String(apiKey || ''), autoRefreshToken: true }));
    try {
      const { DRACOLoader } = await import('three/addons/loaders/DRACOLoader.js');
      draco = new DRACOLoader();
      draco.setDecoderPath(dracoDecoderPath());
    } catch (e) { draco = null; }
    tiles.registerPlugin(new plug.GLTFExtensionsPlugin({ dracoLoader: draco, metadata: false }));
    if (plug.TileCompressionPlugin) tiles.registerPlugin(new plug.TileCompressionPlugin({ disableMipmaps: false }));
    if (plug.UnloadTilesPlugin) tiles.registerPlugin(new plug.UnloadTilesPlugin());

    // quality vs bandwidth (set after the auth plugin, which applies Google's "recommended" errorTarget 40)
    const small = isSmallDevice();
    tiles.errorTarget = small ? 24 : 14;
    tiles.lruCache.minBytesSize = (small ? 0.15 : 0.30) * 2 ** 30;
    tiles.lruCache.maxBytesSize = (small ? 0.22 : 0.45) * 2 ** 30;

    // ---- frame
    outer = new THREE.Group();
    outer.name = 'google3d';
    outer.userData.noPathTrace = true;
    const tg = tiles.group;
    tg.name = 'google3d-tiles';
    tg.matrixAutoUpdate = false;
    let yOffset = Number.isFinite(opts.heightOffset) ? opts.heightOffset : 0;
    const applyFrame = () => { frameMatrix(THREE, tg.matrix, yOffset); tg.matrixWorldNeedsUpdate = true; };
    applyFrame();
    outer.add(tg);
    scene.add(outer);

    // ---- clip box: shared uniforms for every patched tile material
    const clipU = {
      g3dClipM: { value: new THREE.Matrix4() },            // world -> model-local frame of the clip box
      g3dClipMin: { value: new THREE.Vector3(...CLIP_MIN) },
      g3dClipMax: { value: new THREE.Vector3(...CLIP_MAX) }
    };
    const patchMaterial = (m) => {
      if (!m || m.userData.g3dPatched) return;
      m.userData.g3dPatched = true;
      m.toneMapped = false;              // photogrammetry textures already carry real exposure/lighting
      const prevCompile = m.onBeforeCompile;
      m.onBeforeCompile = function (shader, r) {
        if (prevCompile) prevCompile.call(this, shader, r);
        shader.uniforms.g3dClipM = clipU.g3dClipM;
        shader.uniforms.g3dClipMin = clipU.g3dClipMin;
        shader.uniforms.g3dClipMax = clipU.g3dClipMax;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vG3DWorld;')
          .replace('#include <project_vertex>', '#include <project_vertex>\n\tvG3DWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vG3DWorld;\nuniform mat4 g3dClipM;\nuniform vec3 g3dClipMin;\nuniform vec3 g3dClipMax;')
          .replace('#include <clipping_planes_fragment>',
            '{ vec3 g3dP = ( g3dClipM * vec4( vG3DWorld, 1.0 ) ).xyz;\n' +
            '  if ( all( greaterThan( g3dP, g3dClipMin ) ) && all( lessThan( g3dP, g3dClipMax ) ) ) discard; }\n' +
            '#include <clipping_planes_fragment>');
      };
      const prevKey = m.customProgramCacheKey ? m.customProgramCacheKey.bind(m) : null;
      m.customProgramCacheKey = () => 'g3dclip1|' + (prevKey ? prevKey() : '');
      m.needsUpdate = true;
    };
    const onLoadModel = ({ scene: s }) => {
      try {
        s.traverse(o => {
          if (!o.material) return;
          o.castShadow = false; o.receiveShadow = false;
          o.userData.noPathTrace = true;
          if (Array.isArray(o.material)) o.material.forEach(patchMaterial); else patchMaterial(o.material);
        });
      } catch (e) { /* a tile without the clip would only show the old lot; keep going */ }
    };
    tiles.addEventListener('load-model', onLoadModel);
    const updateClip = () => {
      const p = outer.parent;
      if (p) { p.updateWorldMatrix(true, false); clipU.g3dClipM.value.copy(p.matrixWorld).invert(); }
      else clipU.g3dClipM.value.identity();
    };
    updateClip();

    // ---- load the root tileset (proves key, referrer restriction, CSP and network) before handing back an instance
    camera.updateMatrixWorld();
    tiles.setCamera(camera);
    tiles.setResolutionFromRenderer(camera, renderer);
    tiles.update();
    const timeout = Number.isFinite(opts.timeout) ? opts.timeout : 15000;
    const t0 = performance.now();
    while (performance.now() - t0 < timeout) {
      if (tiles.root) break;
      if (tiles.rootLoadingState === lib.FAILED || tiles.rootLoadingState === -1) break;
      await wait(100);
    }
    if (!tiles.root) { cleanup(); return null; }

    // ---- attribution overlay (Google logo text + data providers from the visible tiles)
    try {
      const host = renderer.domElement && renderer.domElement.parentElement;
      if (host) {
        if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
        attribEl = document.createElement('div');
        attribEl.className = 'g3d-attrib';
        attribEl.setAttribute('aria-label', 'Map data attribution');
        attribEl.style.cssText = 'position:absolute;left:8px;bottom:6px;z-index:4;max-width:calc(100% - 16px);' +
          'display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;pointer-events:none;' +
          'font:11px/1.35 Roboto,Arial,Helvetica,sans-serif;color:#fff;text-shadow:0 0 2px rgba(0,0,0,.9),0 0 1px #000;';
        const logo = document.createElement('span');
        logo.className = 'g3d-logo';
        logo.textContent = 'Google';
        logo.style.cssText = 'font:500 16px/1 Roboto,"Product Sans",Arial,sans-serif;letter-spacing:-.2px;';
        const data = document.createElement('span');
        data.className = 'g3d-data';
        attribEl.append(logo, data);
        host.appendChild(attribEl);
      }
    } catch (e) { attribEl = null; }
    let lastAttrib = null, attribT = 0;
    const updateAttrib = () => {
      if (!attribEl) return;
      const list = tiles.getAttributions ? tiles.getAttributions([]) : [];
      const txt = list.filter(a => a && a.type === 'string' && a.value).map(a => a.value).join('; ');
      if (txt !== lastAttrib) { attribEl.lastChild.textContent = txt; lastAttrib = txt; }
    };

    // ---- runtime height calibration: snap the real street in front of the plot to our street level
    const doCal = opts.calibrate !== false;
    const ray = new THREE.Raycaster();
    ray.firstHitOnly = true;
    const inv = new THREE.Matrix4(), v = new THREE.Vector3(), d = new THREE.Vector3();
    let calT = 0, calBestDist = Infinity, calStable = 0;
    const calState = { offset: yOffset, samples: 0, last: null };
    const calibrate = () => {
      const p = outer.parent;
      const toWorld = p ? p.matrixWorld : null;
      if (toWorld) inv.copy(toWorld).invert();
      // camera distance to the site in the model frame
      v.setFromMatrixPosition(camera.matrixWorld); if (toWorld) v.applyMatrix4(inv);
      const dist = Math.hypot(v.x - SITE.x, v.z - SITE.z, v.y);
      if (dist > 450) return;
      if (tiles.stats.downloading + tiles.stats.parsing > 0) return;         // wait until the view has settled
      if (calStable >= 2 && dist > calBestDist * 0.6) return;                // already calibrated at this LOD
      const hs = [];
      for (const z of [21.2, 23.8, 26.0]) for (const x of [-8, -2, 4, 10, 16, 22]) {
        v.set(x, 60, z); d.set(0, -1, 0);
        if (toWorld) { v.applyMatrix4(toWorld); d.transformDirection(toWorld); }
        ray.set(v, d); ray.far = 200;
        const hit = ray.intersectObject(tg, true)[0];
        if (!hit) continue;
        const q = hit.point.clone(); if (toWorld) q.applyMatrix4(inv);
        hs.push(q.y);
      }
      if (hs.length < 6) return;
      hs.sort((a, b) => a - b);
      const med = hs[hs.length >> 1];
      const delta = STREET_TARGET_Y - med;
      calState.samples = hs.length; calState.last = med;
      if (Math.abs(yOffset + delta) > CAL_MAX) return;                       // implausible: keep the geoid-based height
      if (Math.abs(delta) < 0.08) { calStable++; calBestDist = Math.min(calBestDist, dist); return; }
      calStable = 0;
      yOffset += delta;
      calState.offset = yOffset;
      applyFrame();
    };

    let alive = true, visible = true, errors = 0;
    const kill = () => {
      alive = false; visible = false;
      try { outer.visible = false; } catch (e) { /* ignore */ }
      try { if (attribEl) attribEl.style.display = 'none'; } catch (e) { /* ignore */ }
    };

    const api = {
      group: outer,
      setVisible(b) {
        try {
          if (!alive) { outer.visible = false; return; }
          visible = !!b;
          outer.visible = visible;
          if (attribEl) attribEl.style.display = visible ? 'flex' : 'none';
        } catch (e) { /* ignore */ }
      },
      update(dt = 0.016) {
        if (!alive || !visible) return;
        try {
          if (tiles.rootLoadingState === -1 && !tiles.root) { kill(); return; }
          camera.updateMatrixWorld();
          if (!tiles.hasCamera(camera)) tiles.setCamera(camera);
          tiles.setResolutionFromRenderer(camera, renderer);
          updateClip();
          outer.updateMatrixWorld();
          tiles.update();
          attribT += dt; calT += dt;
          if (attribT > 0.5) { attribT = 0; updateAttrib(); }
          if (doCal && calT > 1.5) { calT = 0; calibrate(); }
          errors = 0;
        } catch (e) {
          if (++errors > 5) kill();
        }
      },
      dispose() {
        alive = false;
        try { tiles.removeEventListener('load-model', onLoadModel); } catch (e) { /* ignore */ }
        cleanup();
      }
    };
    // introspection for tests/diagnostics (not part of the contract API)
    outer.userData.google3d = { tiles, calibration: calState, clipMin: CLIP_MIN, clipMax: CLIP_MAX, version: GOOGLE3D_LIB_VERSION,
      get offset() { return yOffset; }, get alive() { return alive; } };
    return api;
  } catch (e) {
    cleanup();
    return null;
  }
}
