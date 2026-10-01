// VILNYI · Barreiro 2 — "Real render": progressive GPU path tracing of the current view.
// three.js r160 + three-gpu-pathtracer 0.0.20 + three-mesh-bvh 0.7.3 (bare specifiers via the importmap:
//   "three-gpu-pathtracer", "three-mesh-bvh" and "three/examples/jsm/" — the library imports
//   'three/examples/jsm/postprocessing/Pass.js' and 'three/examples/jsm/utils/BufferGeometryUtils.js').
//
// export async function createPathTracer(THREE, { renderer, scene, camera, onProgress }) => {
//   start(), stop(), isActive(), reset(), render(), samples(), setMaxSamples(n), setResolutionScale(s),
//   setScope('interior'|'exterior'|'auto'), dispose()
// }
//
// How it works
// - Scope: only what is near the camera goes into the BVH (interior: the current floor's building groups plus the
//   floors directly below/above, roof shell/roof on the upper floors, the site on the lower ones, the lift cab when
//   it is on this floor, that floor's furnished units and the environment triangles within 60 m of the site;
//   exterior: the whole building, the furnished units and the environment triangles within ~80 m). Everything else
//   is captured once from the raster scene into an equirect HDR map (CubeCamera → equirect, the building hidden and
//   the near plane pushed out) which the path tracer uses as sky / background / far world.
// - BVH: built synchronously (three-mesh-bvh MeshBVH, SAH) after a time-sliced bake with progress. The 0.7.3
//   GenerateMeshBVHWorker creates `new Worker(new URL('./generateMeshBVH.worker.js', import.meta.url))`, a
//   cross-origin module worker from jsDelivr that also imports bare 'three' (no importmap in workers) → not usable.
// - Status pill: a small DOM element (.pt-pill, CSS prefix pt-) inside renderer.domElement.parentElement;
//   setLabels({ name, preparing, moving, sample, samples, error }) localises it, setOverlay(false) hides it.
// - Sun: the environment's DirectionalLight is passed to the tracer as a real light (the sun disc in the
//   captured sky is clamped so it is not counted twice). Point lights in scope and emissive materials count.
// - Walking: while the camera moves a low-resolution preview (1 spp, 0.3 scale) is traced every frame; once it
//   has been still for 250 ms the full-resolution target accumulates (tiled). Door / lift transforms are
//   re-baked and the BVH refitted when the camera settles; a changed set of meshes (new furnishing, other floor)
//   rebuilds the scope. A light edge-aware blur hides the noise at low sample counts.
// - Any failure: stop() and onProgress({ phase: 'error', error }). render() never throws.

const LEVEL_IDS = ['basement', 'ground', 'first', 'second'];
const LEVEL_Y = { basement: -2.7, ground: 0, first: 3, second: 6 };
const UNIT_FLOOR = { '0.A': 'ground', '0.B': 'ground', '1.A': 'first', '1.B': 'first', '1.C': 'first', '2.A': 'second', '2.B': 'second', '2.C': 'second' };
const SITE_C = { x: 7, z: 7 };
const TEX_KEYS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'alphaMap', 'transmissionMap',
  'clearcoatMap', 'clearcoatRoughnessMap', 'clearcoatNormalMap', 'sheenColorMap', 'sheenRoughnessMap',
  'specularColorMap', 'specularIntensityMap', 'iridescenceMap', 'iridescenceThicknessMap'];

export async function createPathTracer(THREE, { renderer, scene, camera, onProgress } = {}) {
  const report = (o) => { try { pill.update(o); } catch (e) { /* */ } try { onProgress && onProgress(o); } catch (e) { /* ignore UI errors */ } };
  const pill = makePill(renderer);

  // ---------- libraries (dynamic so a missing importmap entry cannot break the site) ----------
  let PT, BVH, FullScreenQuad;
  let loadError = null;
  try {
    const [a, b, c] = await Promise.all([
      import('three-gpu-pathtracer'),
      import('three-mesh-bvh'),
      import('three/addons/postprocessing/Pass.js')
    ]);
    PT = a; BVH = b; FullScreenQuad = c.FullScreenQuad;
    if (!renderer || !scene || !camera) throw new Error('pathtrace: renderer, scene and camera are required');
    const caps = renderer.capabilities || {};
    if (caps.isWebGL2 === false) throw new Error('pathtrace: WebGL2 is required');
    if (!renderer.extensions.has('EXT_color_buffer_float')) throw new Error('pathtrace: float render targets not supported');
  } catch (e) { loadError = e; }
  if (loadError) {
    // stub with the same API: reports the error on start()
    let warned = false;
    return {
      start() { if (!warned) { warned = true; } report({ phase: 'error', error: loadError }); return Promise.resolve(false); },
      stop() {}, isActive: () => false, reset() {}, render() {}, samples: () => 0,
      setMaxSamples() {}, setResolutionScale() {}, setScope() {}, dispose() {},
      available: false, error: loadError
    };
  }

  // ---------- state ----------
  const opts = { denoise: true, denoiseUntil: 1024, emitterLights: false, emitterDim: 1, indirectClamp: 1.0, autoExposure: true, exposure: 1, interiorExposure: 1, maxSamples: 600, resScale: 1, previewScale: 0.3, scope: 'auto', exteriorRadius: 80, interiorEnvRadius: 60, triCap: 1500000, maxPixels: 2.1e6, stillMs: 250 };
  let active = false, ready = false, disposed = false;
  let buildToken = 0;
  let ptMat = null, full = null, preview = null, blit = null;
  let sceneData = null;          // { key, entries, geometry, bvh, materials, textures, lights, signature, envSig }
  let envTex = null, envCenter = new THREE.Vector3(), envSig = '';
  let lastMove = 0, moving = true, wasMoving = true;
  const lastCamMatrix = new THREE.Matrix4(), lastProj = new THREE.Matrix4();
  let rebuilding = false;
  const stats = { bvhMs: 0, bakeMs: 0, envMs: 0, triangles: 0, meshes: 0, textures: 0, texSize: 0, compileMs: 0 };

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const nextFrame = () => new Promise(r => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => r()) : setTimeout(r, 16)));
  const yieldTask = () => new Promise(r => setTimeout(r, 0));

  // ---------- scope ----------
  function findByName(name) { return scene.getObjectByName(name) || null; }
  function chainVisible(o) { for (let p = o; p; p = p.parent) { if (!p.visible) return false; } return true; }
  function floorOfY(y) {
    let f = 'basement';
    for (const id of LEVEL_IDS) if (y >= LEVEL_Y[id] - 0.35) f = id;
    return f;
  }
  function cameraInside(p) {
    return p.x > -0.2 && p.x < 14.2 && p.z > -1.4 && p.z < 16.1 && p.y > -3.0 && p.y < 9.1 &&
      !(p.z < -0.05 && p.y < 2.5) && !(p.z > 14.75 && p.y < 2.5); // ground-level gardens/street count as outside
  }
  function resolveScope() {
    const p = camera.getWorldPosition(new THREE.Vector3());
    let kind = opts.scope;
    if (kind === 'auto') kind = cameraInside(p) ? 'interior' : 'exterior';
    if (kind === 'interior') return { kind, floor: floorOfY(p.y), cam: p };
    return { kind, floor: null, cam: p };
  }
  function addEnvRoots(environment, roots, R) {
    for (const c of environment.children) {
      const n = c.name || '';
      if (n === 'env-sky' || n === 'env-far-scenery' || n === 'env-tagus' || n === 'env-far-city' || n === 'env-mid-towns') continue;
      if (c.isLight) continue;
      roots.push({ obj: c, cull: { x: SITE_C.x, z: SITE_C.z, R } });
    }
  }
  // returns { roots: [{ obj, cull? }], hide: [obj], lightsRoots: [obj], center, near, R }
  function scopeRoots(sc) {
    const building = findByName('building');
    const interiors = findByName('interiors');
    const environment = findByName('environment');
    const roots = [], hide = [];
    const add = (o, cull = null) => { if (o && chainVisible(o)) { roots.push({ obj: o, cull }); if (!cull) hide.push(o); } };
    if (sc.kind === 'interior') {
      const f = sc.floor, i = LEVEL_IDS.indexOf(f);
      if (building) {
        // current floor + the floors directly below and above (stairwell, balconies overhead, slabs)
        const ids = [];
        for (let k = Math.max(0, i - 1); k <= Math.min(LEVEL_IDS.length - 1, i + 1); k++) ids.push(LEVEL_IDS[k]);
        for (const id of ids) { add(building.getObjectByName('building-' + id)); add(building.getObjectByName('building-' + id + '-ceil')); }
        if (i >= LEVEL_IDS.length - 2) { add(building.getObjectByName('building-roofshell')); add(building.getObjectByName('building-roof')); }
        if (i <= 2) add(building.getObjectByName('building-site'));
        const cab = building.getObjectByName('lift-cab');
        if (cab) { const wp = cab.getWorldPosition(new THREE.Vector3()); if (Math.abs(wp.y - LEVEL_Y[f]) < 1.6) add(cab); }
      }
      if (interiors) for (const c of interiors.children) {
        const u = String(c.name || '').replace(/^interiors-/, '');
        if (UNIT_FLOOR[u] === f || !UNIT_FLOOR[u]) add(c);
      }
      // near neighbours (hand-modelled houses, nearby OSM blocks, street, terrain) as real geometry so they
      // cast sun shadows and show parallax through the windows; everything farther comes from the capture
      if (environment) addEnvRoots(environment, roots, opts.interiorEnvRadius);
      // the capture must show the surroundings only: hide the whole building and all interiors
      // (other floors would otherwise appear as a dark slab overhead in the sky map)
      const hideAll = [building, interiors].filter(Boolean);
      return { roots, hide: hideAll, center: sc.cam.clone(), near: 0.05, R: 0 };
    }
    // exterior
    const R = opts.exteriorRadius;
    if (building) add(building);
    if (interiors) add(interiors);
    if (environment) addEnvRoots(environment, roots, R);
    const d = Math.hypot(sc.cam.x - SITE_C.x, sc.cam.z - SITE_C.z);
    const near = Math.max(0.1, (R - d) / Math.sqrt(3));
    return { roots, hide, center: sc.cam.clone(), near, R };
  }

  // ---------- materials ----------
  const matCache = new Map(); // key -> converted (or null = skip)
  function isGlassLike(m) {
    const n = (m.name || '').toLowerCase();
    if (/glass|glaz|vidro|window|pane|screen-glass|shower/.test(n) && !/glassware|wine|edge/.test(n)) return m.transparent && m.opacity < 0.97 || (m.transmission > 0);
    return m.transparent && m.opacity < 0.9 && m.opacity >= 0.05 && (m.roughness !== undefined && m.roughness <= 0.15) && !m.map && (m.metalness || 0) < 0.3;
  }
  function convertMaterial(m, needVC, noNormalMap) {
    if (!m) return null;
    const key = m.uuid + (needVC ? '|vc' : '') + (noNormalMap ? '|nn' : '');
    if (matCache.has(key)) return matCache.get(key);
    let out = null;
    try { out = convertMaterialInner(m, needVC, noNormalMap); } catch (e) { out = null; }
    matCache.set(key, out);
    return out;
  }
  function convertMaterialInner(m, needVC, noNormalMap) {
    if (m.userData && (m.userData.pathTraceIgnore || m.userData.noPathTrace)) return null;
    if (m.isMeshBasicMaterial) return null; // glows, light pools, contact decals, pickers: raster-only fakes
    if (m.visible === false || m.colorWrite === false || m.opacity === 0) return null;
    if (m.blending === THREE.AdditiveBlending || m.blending === THREE.MultiplyBlending || m.blending === THREE.SubtractiveBlending) return null;
    if (m.isShaderMaterial || m.isRawShaderMaterial || m.isPointsMaterial || m.isLineBasicMaterial || m.isSpriteMaterial || m.isShadowMaterial) return null;
    if (m.isMeshStandardMaterial) {
      if (isGlassLike(m)) {
        const g = new THREE.MeshPhysicalMaterial({ name: (m.name || 'glass') + '-pt' });
        const c = m.color.clone(); const mx = Math.max(c.r, c.g, c.b, 1e-3); c.multiplyScalar(1 / mx);
        g.color.setRGB(1, 1, 1).lerp(c, 0.25);
        g.transmission = 1; g.metalness = 0; g.roughness = Math.min(m.roughness || 0, 0.04); g.ior = m.ior || 1.5;
        g.thickness = 0; g.side = THREE.DoubleSide; g.transparent = false; g.opacity = 1;
        return g;
      }
      if (m.transparent && m.opacity < 1) {
        const n = (m.name || '').toLowerCase();
        if (/sheer|voile/.test(n)) { // see-through fabric: glows with the daylight behind it (rough, non-refracting transmission)
          const g = new THREE.MeshPhysicalMaterial({ name: (m.name || 'sheer') + '-pt' });
          g.color.copy(m.color); g.map = m.map || null; g.alphaMap = m.alphaMap || null; g.alphaTest = m.alphaTest || 0;
          g.transmission = Math.min(0.9, Math.max(0.4, 1.15 - m.opacity)); g.roughness = 0.9; g.ior = 1.2; g.metalness = 0; // thickness 0 → thin-walled
          g.thickness = 0; g.side = THREE.DoubleSide; g.transparent = false; g.opacity = 1; g.vertexColors = needVC || !!m.vertexColors;
          return g;
        }
        if (/frost/.test(n) || (m.roughness > 0.3 && m.opacity >= 0.4 && !m.map)) {
          const g = new THREE.MeshPhysicalMaterial({ name: (m.name || 'frosted') + '-pt' });
          g.color.copy(m.color); g.map = m.map || null; g.transmission = Math.min(1, 1.1 - m.opacity); g.roughness = Math.max(0.35, m.roughness);
          g.metalness = 0; g.thickness = 0; g.side = THREE.DoubleSide; g.transparent = false; g.opacity = 1;
          return g;
        }
        if (m.opacity < 0.2 && !m.alphaMap) return null; // decals / glows / pools of light
      }
      if ((m.metalness || 0) > 0.9 && (m.roughness ?? 1) < 0.1 && m.emissiveMap) { // painted "fake mirror" → real mirror
        const c = m.clone(); c.emissive.setRGB(0, 0, 0); c.emissiveMap = null; c.emissiveIntensity = 0; c.name = (m.name || 'mirror') + '-pt';
        c.vertexColors = needVC || !!m.vertexColors; if (noNormalMap) c.normalMap = null;
        return c;
      }
      if (needVC !== !!m.vertexColors || (noNormalMap && m.normalMap) || m.side === THREE.BackSide) {
        const c = m.clone(); c.vertexColors = needVC || !!m.vertexColors; if (noNormalMap) c.normalMap = null;
        if (m.side === THREE.BackSide) c.side = THREE.DoubleSide;
        return c;
      }
      return m;
    }
    // Basic / Lambert / Phong / Toon / Matcap → standard approximation
    if (m.isMeshBasicMaterial || m.isMeshLambertMaterial || m.isMeshPhongMaterial || m.isMeshToonMaterial || m.isMeshMatcapMaterial) {
      if (m.transparent && m.opacity < 0.2 && !m.alphaMap) return null;
      const s = new THREE.MeshStandardMaterial({ name: (m.name || m.type) + '-pt' });
      if (m.color) s.color.copy(m.color);
      s.map = m.map || null; s.alphaMap = m.alphaMap || null; s.alphaTest = m.alphaTest || 0;
      s.transparent = !!m.transparent; s.opacity = m.opacity; s.side = m.side === THREE.BackSide ? THREE.DoubleSide : m.side;
      s.vertexColors = needVC || !!m.vertexColors;
      s.metalness = 0;
      s.roughness = m.isMeshPhongMaterial ? Math.max(0.1, 1 - Math.min(1, (m.shininess || 30) / 100)) : 0.85;
      if (m.isMeshBasicMaterial) { // unlit in raster → self-lit sign / screen
        s.emissive.copy(m.color || new THREE.Color(1, 1, 1)); s.emissiveMap = m.map || null; s.emissiveIntensity = m.toneMapped === false ? 1.2 : 0.6;
      } else if (m.emissive) { s.emissive.copy(m.emissive); s.emissiveMap = m.emissiveMap || null; s.emissiveIntensity = m.emissiveIntensity ?? 1; }
      if (!noNormalMap && m.normalMap) { s.normalMap = m.normalMap; if (m.normalScale) s.normalScale.copy(m.normalScale); }
      return s;
    }
    return null;
  }

  // ---------- geometry preparation (cached per source geometry) ----------
  const geoCache = new WeakMap();
  function prepGeometry(geo, wantTangent) {
    let e = geoCache.get(geo);
    const pv = geo.attributes.position ? geo.attributes.position.version : -1;
    if (e && e.pv === pv && (!wantTangent || e.tangent || e.noTangent)) return e;
    const pos = geo.attributes.position;
    if (!pos || pos.itemSize !== 3) return null;
    const count = pos.count;
    const idx = geo.index;
    let normal = geo.attributes.normal || null;
    if (!normal) { const c = geo.clone(); c.computeVertexNormals(); normal = c.attributes.normal; }
    const uv = geo.attributes.uv && geo.attributes.uv.itemSize === 2 ? geo.attributes.uv : null;
    const color = geo.attributes.color || null;
    let tangent = geo.attributes.tangent && geo.attributes.tangent.itemSize === 4 ? geo.attributes.tangent : (e && e.tangent) || null;
    let noTangent = false;
    if (wantTangent && !tangent) {
      if (uv && normal) {
        try {
          const c = new THREE.BufferGeometry();
          c.setAttribute('position', pos); c.setAttribute('normal', normal); c.setAttribute('uv', uv);
          if (idx) c.setIndex(idx); else { const a = new Uint32Array(count); for (let i = 0; i < count; i++) a[i] = i; c.setIndex(new THREE.BufferAttribute(a, 1)); }
          c.computeTangents();
          tangent = c.attributes.tangent;
        } catch (err) { noTangent = true; }
      } else noTangent = true;
    }
    e = { pv, count, idx, pos, normal, uv, color, tangent, noTangent };
    geoCache.set(geo, e);
    return e;
  }

  // ---------- collect scope → entries ----------
  // entry: { mesh, inst (-1 or index), prep, groups: [{ start, count, mat (converted) }], cull, tris }
  function collect(scope) {
    scene.updateMatrixWorld();
    const entries = [];
    const lights = [];
    const sigParts = [];
    let triCount = 0;
    const tmpS = new THREE.Sphere(), m4 = new THREE.Matrix4(), v = new THREE.Vector3();
    const visit = (o, cull) => {
      if (!o.visible) return;
      if (o.userData && (o.userData.pathTraceIgnore || o.userData.ui || o.userData.noPathTrace)) return;
      if (o.isLight) {
        if (o.intensity > 0 && (o.isPointLight || o.isSpotLight || o.isRectAreaLight) && !o.isDirectionalLight) {
          if (!cull || Math.hypot(o.matrixWorld.elements[12] - cull.x, o.matrixWorld.elements[14] - cull.z) < cull.R) lights.push(o);
        }
      } else if (o.isMesh && !o.isSkinnedMesh && !o.isBatchedMesh && o.geometry && o.material) {
        const name = (o.name || '');
        if (!/^floor-picker|^highlight-/.test(name)) addMesh(o, cull);
      }
      for (const c of o.children) visit(c, cull);
    };
    const addMesh = (mesh, cull) => {
      const geo = mesh.geometry;
      if (!geo.attributes.position) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const hasVC = !!geo.attributes.color;
      const needVC = !!(mesh.isInstancedMesh && mesh.instanceColor);
      const anyNormalMap = mats.some(m => m && m.normalMap);
      const prep = prepGeometry(geo, anyNormalMap);
      if (!prep) return;
      const noNM = anyNormalMap && (!prep.tangent || !prep.uv);
      const groupsSrc = (Array.isArray(mesh.material) && geo.groups.length) ? geo.groups : [{ start: 0, count: Infinity, materialIndex: 0 }];
      const total = prep.idx ? prep.idx.count : prep.count;
      const dr = geo.drawRange || { start: 0, count: Infinity };
      const groups = [];
      for (const g of groupsSrc) {
        const src = Array.isArray(mesh.material) ? mesh.material[g.materialIndex] : mesh.material;
        const cm = convertMaterial(src, needVC || (src && src.vertexColors && hasVC), noNM);
        if (!cm) continue;
        const s = Math.max(g.start, dr.start), e = Math.min(total, g.start + g.count, dr.start + dr.count);
        if (e - s < 3) continue;
        groups.push({ start: s - (s % 3), count: (e - s) - ((e - s) % 3), mat: cm });
      }
      if (!groups.length) return;
      const trisPer = groups.reduce((a, g) => a + g.count / 3, 0);
      if (!geo.boundingSphere) geo.computeBoundingSphere();
      if (mesh.isInstancedMesh) {
        const n = Math.min(mesh.count, mesh.instanceMatrix.count);
        for (let i = 0; i < n; i++) {
          mesh.getMatrixAt(i, m4); m4.premultiply(mesh.matrixWorld);
          if (Math.abs(m4.determinant()) < 1e-12) continue; // hidden instance (scaled to zero)
          if (cull) {
            tmpS.copy(geo.boundingSphere).applyMatrix4(m4);
            if (Math.hypot(tmpS.center.x - cull.x, tmpS.center.z - cull.z) > cull.R) continue;
          }
          entries.push({ mesh, inst: i, prep, groups, cull: null, tris: trisPer });
          triCount += trisPer;
        }
        sigParts.push(mesh.id + ':' + n + ':' + geo.id);
      } else {
        let c = null;
        if (cull) {
          tmpS.copy(geo.boundingSphere).applyMatrix4(mesh.matrixWorld);
          const d = Math.hypot(tmpS.center.x - cull.x, tmpS.center.z - cull.z);
          if (d - tmpS.radius > cull.R) return;
          if (d + tmpS.radius > cull.R) c = cull;
        }
        entries.push({ mesh, inst: -1, prep, groups, cull: c, tris: c ? trisPer * Math.min(1, (cull.R * cull.R) / (tmpS.radius * tmpS.radius + 1)) : trisPer });
        triCount += entries[entries.length - 1].tris;
        sigParts.push(mesh.id + ':' + geo.id);
      }
      for (const g of groups) sigParts.push(g.mat.uuid);
      v.set(0, 0, 0);
    };
    for (const r of scope.roots) visit(r.obj, r.cull);
    // the sun (and any other directional light) always counts
    scene.traverseVisible(o => { if (o.isDirectionalLight && o.intensity > 0) lights.push(o); });
    return { entries, lights, triCount, signature: sigParts.join('|') };
  }

  // ---------- bake entries into one world-space geometry ----------
  async function bake(col, token) {
    const t0 = now();
    const { entries } = col;
    const matList = [], matIndex = new Map();
    const tri = new THREE.Triangle(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    // pass 1: per entry+group, list local vertex ids (remapped) and local triangle indices
    const parts = [];
    let vTotal = 0, iTotal = 0;
    const m4 = new THREE.Matrix4();
    let lastYield = now();
    for (let ei = 0; ei < entries.length; ei++) {
      const e = entries[ei];
      const { prep } = e;
      const idx = prep.idx ? prep.idx.array : null;
      const pos = prep.pos;
      if (e.inst >= 0) { e.mesh.getMatrixAt(e.inst, m4); m4.premultiply(e.mesh.matrixWorld); } else m4.copy(e.mesh.matrixWorld);
      e.matrix = m4.clone();
      e.parts = [];
      for (const g of e.groups) {
        let mi = matIndex.get(g.mat);
        if (mi === undefined) { mi = matList.length; matList.push(g.mat); matIndex.set(g.mat, mi); }
        const map = new Int32Array(prep.count).fill(-1);
        const verts = [];
        const tris = [];
        for (let k = g.start; k < g.start + g.count; k += 3) {
          const i0 = idx ? idx[k] : k, i1 = idx ? idx[k + 1] : k + 1, i2 = idx ? idx[k + 2] : k + 2;
          if (e.cull) {
            a.fromBufferAttribute(pos, i0).applyMatrix4(m4); b.fromBufferAttribute(pos, i1).applyMatrix4(m4); c.fromBufferAttribute(pos, i2).applyMatrix4(m4);
            const cx = (a.x + b.x + c.x) / 3, cz = (a.z + b.z + c.z) / 3;
            if (Math.hypot(cx - e.cull.x, cz - e.cull.z) > e.cull.R) continue;
          }
          for (const vi of [i0, i1, i2]) { if (map[vi] < 0) { map[vi] = verts.length; verts.push(vi); } }
          tris.push(map[i0], map[i1], map[i2]);
        }
        if (!tris.length) continue;
        const p = { mi, verts: Uint32Array.from(verts), tris: Uint32Array.from(tris), vStart: vTotal };
        e.parts.push(p);
        vTotal += verts.length; iTotal += tris.length;
      }
      if (now() - lastYield > 40) { await yieldTask(); lastYield = now(); if (token !== buildToken) return null; report({ phase: 'bvh', p: 0.15 + 0.25 * ei / entries.length, samples: 0 }); }
    }
    if (!iTotal) throw new Error('pathtrace: nothing in scope');
    // pass 2: write attributes
    const P = new Float32Array(vTotal * 3), N = new Float32Array(vTotal * 3), TG = new Float32Array(vTotal * 4),
      UV = new Float32Array(vTotal * 2), CO = new Float32Array(vTotal * 4), MI = matList.length > 255 ? new Uint16Array(vTotal) : new Uint8Array(vTotal);
    const I = new Uint32Array(iTotal);
    let io = 0;
    for (let ei = 0; ei < entries.length; ei++) {
      const e = entries[ei];
      const det = e.matrix.determinant();
      for (const p of e.parts) {
        writeVerts(e, p, P, N, TG);
        const { prep } = e;
        const uv = prep.uv, col = prep.color;
        const ic = (e.inst >= 0 && e.mesh.instanceColor) ? new THREE.Color().fromArray(e.mesh.instanceColor.array, e.inst * 3) : null;
        for (let j = 0; j < p.verts.length; j++) {
          const vi = p.verts[j], o = p.vStart + j;
          if (uv) { UV[o * 2] = uv.getX(vi); UV[o * 2 + 1] = uv.getY(vi); }
          let r = 1, g = 1, bb = 1, aa = 1;
          if (col) { r = col.getX(vi); g = col.getY(vi); bb = col.getZ(vi); if (col.itemSize > 3) aa = col.getW(vi); }
          if (ic) { r *= ic.r; g *= ic.g; bb *= ic.b; }
          CO[o * 4] = r; CO[o * 4 + 1] = g; CO[o * 4 + 2] = bb; CO[o * 4 + 3] = aa;
          MI[o] = p.mi;
        }
        const t = p.tris, base = p.vStart;
        if (det < 0) { for (let k = 0; k < t.length; k += 3) { I[io++] = base + t[k]; I[io++] = base + t[k + 2]; I[io++] = base + t[k + 1]; } }
        else for (let k = 0; k < t.length; k++) I[io++] = base + t[k];
      }
      if (now() - lastYield > 40) { await yieldTask(); lastYield = now(); if (token !== buildToken) return null; report({ phase: 'bvh', p: 0.4 + 0.15 * ei / entries.length, samples: 0 }); }
    }
    const emitterLights = emittersToLights(entries, matList, P);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(P, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    geometry.setAttribute('tangent', new THREE.BufferAttribute(TG, 4));
    geometry.setAttribute('uv', new THREE.BufferAttribute(UV, 2));
    geometry.setAttribute('color', new THREE.BufferAttribute(CO, 4));
    geometry.setAttribute('materialIndex', new THREE.BufferAttribute(MI, 1, false));
    geometry.setIndex(new THREE.BufferAttribute(I, 1));
    stats.bakeMs = now() - t0;
    stats.triangles = iTotal / 3;
    stats.meshes = entries.length;
    stats.emitterLights = emitterLights.length;
    return { geometry, materials: matList, emitterLights };
  }

  // Small, strong emitters (downlights, bulbs, candle flames) are only found by BSDF sampling in this
  // version of the tracer → fireflies. They are dimmed (opts.emitterDim). Optionally (opts.emitterLights)
  // each fixture becomes a spot / point light — but 0.0.20 picks one light uniformly per bounce, so dozens of
  // weak lights starve the sun and sky of samples; measured worse, hence off by default.
  const _e = { a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), n: new THREE.Vector3(), ab: new THREE.Vector3(), ac: new THREE.Vector3() };
  function emittersToLights(entries, matList, P) {
    const out = [];
    const MAX_LIGHTS = 64;
    const byMat = new Map();
    for (const e of entries) for (const p of e.parts) {
      const m = matList[p.mi];
      if (!m || !m.emissive) continue;
      const L = (0.2126 * m.emissive.r + 0.7152 * m.emissive.g + 0.0722 * m.emissive.b) * (m.emissiveIntensity ?? 1);
      if (L < 6 || m.emissiveMap) continue;
      if (!byMat.has(p.mi)) byMat.set(p.mi, []);
      byMat.get(p.mi).push(p);
    }
    for (const [mi, parts] of byMat) {
      const m = matList[mi];
      const clusters = [];
      let ok = true;
      for (const p of parts) {
        const t = p.tris, base = p.vStart;
        for (let k = 0; k < t.length && ok; k += 3) {
          const ia = base + t[k], ib = base + t[k + 1], ic = base + t[k + 2];
          _e.a.fromArray(P, ia * 3); _e.b.fromArray(P, ib * 3); _e.c.fromArray(P, ic * 3);
          _e.ab.subVectors(_e.b, _e.a); _e.ac.subVectors(_e.c, _e.a); _e.n.crossVectors(_e.ab, _e.ac).multiplyScalar(0.5);
          const area = _e.n.length();
          const cx = (_e.a.x + _e.b.x + _e.c.x) / 3, cy = (_e.a.y + _e.b.y + _e.c.y) / 3, cz = (_e.a.z + _e.b.z + _e.c.z) / 3;
          let cl = null;
          for (const q of clusters) { if (Math.abs(q.x0 - cx) < 0.3 && Math.abs(q.y0 - cy) < 0.3 && Math.abs(q.z0 - cz) < 0.3) { cl = q; break; } }
          if (!cl) {
            if (clusters.length >= MAX_LIGHTS) { ok = false; break; }
            cl = { x0: cx, y0: cy, z0: cz, A: 0, c: new THREE.Vector3(), va: new THREE.Vector3(), min: new THREE.Vector3(cx, cy, cz), max: new THREE.Vector3(cx, cy, cz) };
            clusters.push(cl);
          }
          cl.A += area; cl.c.x += cx * area; cl.c.y += cy * area; cl.c.z += cz * area; cl.va.add(_e.n);
          cl.min.min(_e.a).min(_e.b).min(_e.c); cl.max.max(_e.a).max(_e.b).max(_e.c);
        }
      }
      if (!ok || !clusters.length || out.length + clusters.length > MAX_LIGHTS) continue;
      if (clusters.some(q => q.max.distanceTo(q.min) > 0.6 || q.A > 0.25)) continue; // strips / panels stay emissive
      const col = m.emissive.clone();
      const I = m.emissiveIntensity ?? 1;
      if (opts.emitterLights) for (const q of clusters) {
        if (q.A <= 0) continue;
        q.c.multiplyScalar(1 / q.A);
        const vaLen = q.va.length();
        let light;
        if (vaLen > 0.35 * q.A) { // flat emitter → spot along its normal (Lambertian lobe ≈ wide soft cone)
          const n = q.va.clone().normalize();
          light = new THREE.SpotLight(col, I * vaLen, 0, Math.PI * 0.47, 1, 2);
          light.position.copy(q.c).addScaledVector(n, 0.03);
          light.target.position.copy(light.position).add(n);
          light.radius = Math.min(0.05, Math.sqrt(vaLen / Math.PI));
        } else { // bulb / flame → point light, I = L·A/4 for a sphere
          light = new THREE.PointLight(col, I * q.A / 4, 0, 2);
          light.position.copy(q.c);
        }
        light.name = 'pt-emitter-' + (m.name || mi);
        light.updateMatrixWorld(true); if (light.target) light.target.updateMatrixWorld(true);
        out.push(light);
      }
      // dimmed surface for what the camera sees (keeps glow, avoids double counting most of the energy)
      const dim = m.clone(); dim.name = (m.name || 'emitter') + '-pt'; dim.emissiveIntensity = I * (opts.emitterLights ? 0.3 : opts.emitterDim);
      dim.userData.ptDimOf = m; dim.userData.ptDim = opts.emitterLights ? 0.3 : opts.emitterDim;
      matList[mi] = dim;
    }
    return out;
  }

  const _v = new THREE.Vector3(), _n = new THREE.Vector3(), _t = new THREE.Vector3(), _nm = new THREE.Matrix3(), _m3 = new THREE.Matrix3();
  function writeVerts(e, p, P, N, TG) {
    const { prep } = e;
    const m = e.matrix;
    _nm.getNormalMatrix(m);
    _m3.setFromMatrix4(m);
    const pos = prep.pos, nor = prep.normal, tan = prep.tangent;
    for (let j = 0; j < p.verts.length; j++) {
      const vi = p.verts[j], o = p.vStart + j;
      _v.fromBufferAttribute(pos, vi).applyMatrix4(m);
      P[o * 3] = _v.x; P[o * 3 + 1] = _v.y; P[o * 3 + 2] = _v.z;
      if (nor) { _n.fromBufferAttribute(nor, vi).applyMatrix3(_nm).normalize(); N[o * 3] = _n.x; N[o * 3 + 1] = _n.y; N[o * 3 + 2] = _n.z; }
      if (tan) {
        _t.set(tan.getX(vi), tan.getY(vi), tan.getZ(vi)).applyMatrix3(_m3).normalize();
        TG[o * 4] = _t.x; TG[o * 4 + 1] = _t.y; TG[o * 4 + 2] = _t.z; TG[o * 4 + 3] = tan.getW(vi);
      }
    }
  }

  // detect moved meshes (doors, lift) → re-bake their vertices and refit
  function refitIfMoved() {
    if (!sceneData) return false;
    const { entries, geometry, bvh } = sceneData;
    const P = geometry.attributes.position.array, N = geometry.attributes.normal.array, TG = geometry.attributes.tangent.array;
    const m4 = new THREE.Matrix4();
    let changed = false;
    for (const e of entries) {
      if (!e.parts.length) continue;
      if (e.inst >= 0) { e.mesh.getMatrixAt(e.inst, m4); m4.premultiply(e.mesh.matrixWorld); } else m4.copy(e.mesh.matrixWorld);
      if (m4.equals(e.matrix)) continue;
      e.matrix.copy(m4);
      for (const p of e.parts) writeVerts(e, p, P, N, TG);
      changed = true;
    }
    if (changed) {
      geometry.attributes.position.needsUpdate = true;
      bvh.refit();
      ptMat.bvh.updateFrom(bvh);
      ptMat.attributesArray.updateFrom(geometry.attributes.normal, geometry.attributes.tangent, geometry.attributes.uv, geometry.attributes.color);
    }
    return changed;
  }

  // ---------- environment capture (far world → equirect) ----------
  let cubeRT = null, eqRT = null, eqQuad = null;
  function envSignature() {
    const parts = [];
    scene.traverseVisible(o => { if (o.isDirectionalLight) parts.push(o.intensity.toFixed(2), o.color.getHexString(), o.position.x.toFixed(1), o.position.y.toFixed(1), o.position.z.toFixed(1)); });
    if (scene.background && scene.background.isColor) parts.push(scene.background.getHexString());
    if (scene.fog) parts.push(scene.fog.color.getHexString());
    return parts.join(',');
  }
  function captureEnv(center, near, hide) {
    const t0 = now();
    const size = 512, W = 1024, H = 512;
    if (!cubeRT) cubeRT = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    const cc = new THREE.CubeCamera(near, 30000, cubeRT);
    cc.position.copy(center);
    scene.add(cc); cc.updateMatrixWorld(true);
    const saved = hide.map(o => [o, o.visible]);
    for (const o of hide) o.visible = false;
    const sky = scene.getObjectByName('env-sky');
    const skyPos = sky ? sky.position.clone() : null;
    if (sky) { sky.position.copy(center); sky.updateMatrixWorld(true); }
    const ogTarget = renderer.getRenderTarget();
    const ogXR = renderer.xr && renderer.xr.enabled;
    try {
      if (renderer.xr) renderer.xr.enabled = false;
      cc.update(renderer, scene);
    } finally {
      if (renderer.xr) renderer.xr.enabled = ogXR;
      for (const [o, vis] of saved) o.visible = vis;
      if (sky) { sky.position.copy(skyPos); sky.updateMatrixWorld(true); }
      scene.remove(cc);
      renderer.setRenderTarget(ogTarget);
    }
    // cube → equirect in the library's convention (equirectUvToDirection)
    if (!eqRT) eqRT = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false, generateMipmaps: false });
    if (!eqQuad) eqQuad = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: { cube: { value: null } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `precision highp float; uniform samplerCube cube; varying vec2 vUv;
        #define PI 3.141592653589793
        void main(){
          vec2 uv = vUv; uv.x -= 0.5; uv.y = 1.0 - uv.y;
          float theta = uv.x * 2.0 * PI; float phi = uv.y * PI;
          float sinPhi = sin(phi);
          vec3 dir = vec3(sinPhi * cos(theta), cos(phi), sinPhi * sin(theta));
          gl_FragColor = vec4(textureCube(cube, dir).rgb, 1.0);
        }`,
      depthTest: false, depthWrite: false, toneMapped: false
    }));
    eqQuad.material.uniforms.cube.value = cubeRT.texture;
    renderer.setRenderTarget(eqRT);
    eqQuad.render(renderer);
    const data = new Float32Array(W * H * 4);
    renderer.readRenderTargetPixels(eqRT, 0, 0, W, H, data);
    renderer.setRenderTarget(ogTarget);
    // clamp the sun disc (the DirectionalLight carries the sun) and any NaNs
    const lum = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) {
      for (let k = 0; k < 3; k++) { const x = data[i * 4 + k]; if (!(x >= 0) || !isFinite(x)) data[i * 4 + k] = 0; }
      lum[i] = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
      data[i * 4 + 3] = 1;
    }
    const sorted = lum.slice().sort();
    const cap = Math.max(sorted[Math.floor(sorted.length * 0.997)] * 1.2, 1e-3);
    for (let i = 0; i < W * H; i++) if (lum[i] > cap) { const s = cap / lum[i]; data[i * 4] *= s; data[i * 4 + 1] *= s; data[i * 4 + 2] *= s; }
    const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = false;
    tex.flipY = false; tex.needsUpdate = true;
    if (envTex) envTex.dispose();
    envTex = tex;
    envCenter.copy(center);
    envSig = envSignature();
    ptMat.envMapInfo.updateFrom(tex);
    stats.envMs = now() - t0;
  }

  // ---------- path tracer objects ----------
  function ensurePT() {
    if (ptMat) return;
    ptMat = new PT.PhysicalPathTracingMaterial();
    ptMat.bounces = 6;
    ptMat.transmissiveBounces = 8;
    ptMat.filterGlossyFactor = 0.5;
    ptMat.environmentIntensity = 1;
    ptMat.backgroundBlur = 0;
    ptMat.setDefine('FEATURE_MIS', 1);
    // "clamp indirect" (like Cycles): every radiance contribution after the first diffuse/glossy bounce is capped
    // in luminance. Small bright fixtures (downlights 30×, bulbs 40×) can only be found by BSDF sampling in
    // 0.0.20 and would otherwise sparkle as fireflies for thousands of samples; what the camera sees directly
    // (incl. through glass) and the direct sun/sky on visible surfaces are untouched. Skipped silently if the
    // shader text differs in another build.
    try {
      let fs = ptMat.fragmentShader;
      const reps = [
        ['gl_FragColor.rgb += lightRec.emission * state.throughputColor * misWeight;', 'gl_FragColor.rgb += PT_CI( lightRec.emission * state.throughputColor * misWeight );'],
        ['gl_FragColor.rgb += lightRec.emission * state.throughputColor;', 'gl_FragColor.rgb += PT_CI( lightRec.emission * state.throughputColor );'],
        ['gl_FragColor.rgb += environmentIntensity * envColor * state.throughputColor * misWeight;', 'gl_FragColor.rgb += PT_CI( environmentIntensity * envColor * state.throughputColor * misWeight );'],
        ['gl_FragColor.rgb += directLightContribution( - ray.direction, surf, state, hitPoint );', 'gl_FragColor.rgb += PT_CI( directLightContribution( - ray.direction, surf, state, hitPoint ) );'],
        ['gl_FragColor.rgb += ( surf.emission * state.throughputColor );', 'gl_FragColor.rgb += PT_CI( surf.emission * state.throughputColor );']
      ];
      let n = 0;
      for (const [f, r] of reps) if (fs.includes(f)) { fs = fs.split(f).join(r); n++; }
      const mainAt = fs.indexOf('void main()');
      if (n >= 3 && mainAt > 0) {
        fs = fs.slice(0, mainAt) +
          'vec3 ptClampL( vec3 c ) { float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); return l > PT_INDIRECT_CLAMP ? c * ( PT_INDIRECT_CLAMP / l ) : c; }\n' +
          '#define PT_CI( x ) ( ( state.firstRay || state.transmissiveRay ) ? ( x ) : ptClampL( x ) )\n' + fs.slice(mainAt);
        ptMat.fragmentShader = fs;
        ptMat.defines.PT_INDIRECT_CLAMP = opts.indirectClamp.toFixed(3);
        ptMat.needsUpdate = true;
        stats.indirectClamp = n;
      }
    } catch (e) { /* keep the stock shader */ }
    full =new PT.PathTracingRenderer(renderer);
    full.material = ptMat; full.camera = camera; full.alpha = false;
    preview = new PT.PathTracingRenderer(renderer);
    preview.material = ptMat; preview.camera = camera; preview.alpha = false; preview.tiles.set(1, 1);
    blit = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: { map: { value: null }, texel: { value: new THREE.Vector2(1, 1) }, sigma: { value: 0 }, rangeSigma: { value: 0.12 }, exposure: { value: 1 }, tFilt: { value: null }, tAlb: { value: null }, guided: { value: 0 }, rawMix: { value: 0 }, gain: { value: new THREE.Vector3(1, 1, 1) } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `precision highp float;
        uniform sampler2D map; uniform vec2 texel; uniform float sigma; uniform float rangeSigma; uniform float exposure; varying vec2 vUv;
        uniform sampler2D tFilt; uniform sampler2D tAlb; uniform float guided; uniform float rawMix; uniform vec3 gain;
        vec3 comp(vec3 c){ return c / (1.0 + c); }
        void main(){
          vec3 c0 = texture2D(map, vUv).rgb;
          vec3 col = c0;
          if (guided > 0.5) {
            vec3 f = texture2D(tFilt, vUv).rgb * max(texture2D(tAlb, vUv).rgb, vec3(0.03));
            col = mix(f, c0, rawMix);
          } else if (sigma > 0.05) {
            vec3 k0 = comp(c0); vec3 acc = vec3(0.0); float wsum = 0.0;
            float is2 = 1.0 / (2.0 * sigma * sigma); float ir2 = 1.0 / (2.0 * rangeSigma * rangeSigma);
            for (int y = -3; y <= 3; y++) for (int x = -3; x <= 3; x++) {
              vec2 o = vec2(float(x), float(y));
              float ws = exp(-dot(o, o) * is2);
              if (ws < 0.02) continue;
              vec3 c = texture2D(map, vUv + o * texel).rgb;
              vec3 d = comp(c) - k0;
              float w = ws * exp(-dot(d, d) * ir2);
              acc += c * w; wsum += w;
            }
            col = acc / max(wsum, 1e-5);
          }
          gl_FragColor = vec4(max(col, vec3(0.0)) * gain * exposure, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: true
    }));
    // firefly suppression (display only; the accumulation buffer keeps all energy)
    clampPass = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: { map: { value: null }, texel: { value: new THREE.Vector2(1, 1) }, k: { value: 4 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `precision highp float; uniform sampler2D map; uniform vec2 texel; uniform float k; varying vec2 vUv;
        float lum(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
        void main(){
          vec3 c = texture2D(map, vUv).rgb;
          float mx = 0.0, sum = 0.0;
          for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
            if (x == 0 && y == 0) continue;
            float l = lum(texture2D(map, vUv + vec2(float(x), float(y)) * texel).rgb);
            mx = max(mx, l); sum += l;
          }
          float L = lum(c);
          float lim = min(mx, sum / 8.0 * k + 0.05);
          if (L > lim) c *= lim / max(L, 1e-6);
          gl_FragColor = vec4(c, 1.0);
        }`,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false
    }));
    clampRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  }
  let clampPass = null, clampRT = null;


  // ---------- guided denoiser: raster albedo + normal/depth guides, albedo demodulation, à-trous ----------
  // The raster pipeline renders two cheap guide buffers of the same view once per camera settle; the traced
  // radiance is divided by albedo (so textures are never blurred), filtered edge-aware (normal, depth,
  // luminance), re-multiplied and blended back to the raw estimate as samples accumulate.
  let G = null;
  const albedoMats = new Map();
  const VS_FS = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
  function makeGuides() {
    const rt = (type, depth) => new THREE.WebGLRenderTarget(1, 1, { type, format: THREE.RGBAFormat, depthBuffer: depth, generateMipmaps: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    const albedo = rt(THREE.HalfFloatType, true);
    const normal = rt(THREE.UnsignedByteType, true);
    normal.depthTexture = new THREE.DepthTexture(1, 1, THREE.FloatType);
    const a = rt(THREE.HalfFloatType, false), b = rt(THREE.HalfFloatType, false);
    const common = `
      uniform sampler2D tNormal; uniform sampler2D tDepth; uniform float cNear; uniform float cFar; uniform float ortho; uniform vec2 invP;
      #include <packing>
      float viewZ(vec2 uv){ float d = texture2D(tDepth, uv).x; return ortho > 0.5 ? orthographicDepthToViewZ(d, cNear, cFar) : perspectiveDepthToViewZ(d, cNear, cFar); }
      vec3 viewPos(vec2 uv, float z){ vec2 ndc = uv * 2.0 - 1.0; return vec3(ndc * invP * (ortho > 0.5 ? 1.0 : -z), z); }
      vec3 nrm(vec2 uv){ return normalize(texture2D(tNormal, uv).xyz * 2.0 - 1.0); }
      float lum(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }`;
    const guideUniforms = () => ({ tNormal: { value: normal.texture }, tDepth: { value: normal.depthTexture }, cNear: { value: 0.1 }, cFar: { value: 1000 }, ortho: { value: 0 }, invP: { value: new THREE.Vector2(1, 1) } });
    const demod = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: { tRad: { value: null }, tAlb: { value: albedo.texture }, texel: { value: new THREE.Vector2() }, k: { value: 4 } },
      vertexShader: VS_FS,
      fragmentShader: `precision highp float; uniform sampler2D tRad; uniform sampler2D tAlb; uniform vec2 texel; uniform float k; varying vec2 vUv;
        float lum(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
        vec3 irr(vec2 uv){ return texture2D(tRad, uv).rgb / max(texture2D(tAlb, uv).rgb, vec3(0.03)); }
        void main(){
          vec3 c = irr(vUv); float mx = 0.0, sum = 0.0;
          for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
            if (x == 0 && y == 0) continue;
            float l = lum(irr(vUv + vec2(float(x), float(y)) * texel)); mx = max(mx, l); sum += l;
          }
          float L = lum(c); float lim = min(mx, sum / 8.0 * k + 0.05);
          if (L > lim) c *= lim / max(L, 1e-6);
          gl_FragColor = vec4(c, 1.0);
        }`,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false
    }));
    const atrous = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: { tIn: { value: null }, texel: { value: new THREE.Vector2() }, stepPx: { value: 1 }, sigL: { value: 0.2 }, ...guideUniforms() },
      vertexShader: VS_FS,
      fragmentShader: `precision highp float; uniform sampler2D tIn; uniform vec2 texel; uniform float stepPx; uniform float sigL; varying vec2 vUv;
        ${common}
        void main(){
          vec3 c0 = texture2D(tIn, vUv).rgb; vec3 n0 = nrm(vUv); float z0 = viewZ(vUv); vec3 p0 = viewPos(vUv, z0);
          float sigP = 0.006 * abs(z0) + 0.004;
          float l0 = lum(c0 / (1.0 + c0));
          vec3 acc = vec3(0.0); float wsum = 0.0;
          float kern[3]; kern[0] = 0.375; kern[1] = 0.25; kern[2] = 0.0625;
          for (int y = -2; y <= 2; y++) for (int x = -2; x <= 2; x++) {
            vec2 uv = vUv + vec2(float(x), float(y)) * texel * stepPx;
            vec3 c = texture2D(tIn, uv).rgb;
            float h = kern[x < 0 ? -x : x] * kern[y < 0 ? -y : y];
            float wn = pow(max(dot(n0, nrm(uv)), 0.0), 48.0);
            float wz = exp(-abs(dot(n0, viewPos(uv, viewZ(uv)) - p0)) / sigP);
            float l = lum(c / (1.0 + c));
            float wl = exp(-abs(l - l0) / sigL);
            float w = h * wn * wz * wl;
            acc += c * w; wsum += w;
          }
          gl_FragColor = vec4(acc / max(wsum, 1e-6), 1.0);
        }`,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false
    }));
    G = { albedo, normal, a, b, demod, atrous, valid: false, w: 0, h: 0,
      normalMat: new THREE.MeshNormalMaterial() };
  }
  function albedoMaterialFor(o, m) {
    const conv = convertMaterial(m, !!(o.isInstancedMesh && o.instanceColor) || !!(m && m.vertexColors && o.geometry.attributes.color), false);
    if (!conv) return null;                                 // not traced → not in the guide either
    if (conv.transmission >= 0.9) return null;              // clear glass: the guide shows what is behind it
    let am = albedoMats.get(conv);
    if (!am) {
      am = new THREE.MeshBasicMaterial({ color: conv.color ? conv.color.clone() : new THREE.Color(1, 1, 1), map: conv.map || null,
        vertexColors: !!conv.vertexColors, side: conv.side, alphaTest: conv.alphaTest || 0, alphaMap: conv.alphaMap || null, fog: false, toneMapped: false });
      if (conv.emissive && (conv.emissiveIntensity || 0) * (conv.emissive.r + conv.emissive.g + conv.emissive.b) > 0.3) am.color.setRGB(1, 1, 1);
      albedoMats.set(conv, am);
    }
    return am;
  }
  function renderGuides(w, h) {
    if (!G) makeGuides();
    if (G.w !== w || G.h !== h) {
      G.albedo.setSize(w, h); G.normal.setSize(w, h); G.a.setSize(w, h); G.b.setSize(w, h);
      G.normal.depthTexture.image.width = w; G.normal.depthTexture.image.height = h; G.normal.depthTexture.needsUpdate = true;
      G.w = w; G.h = h;
    }
    const swaps = [], hidden = [];
    scene.traverseVisible(o => {
      if (!o.isMesh || !o.material) return;
      if ((o.userData && (o.userData.pathTraceIgnore || o.userData.ui || o.userData.noPathTrace)) || /^floor-picker|^highlight-/.test(o.name || '')) { hidden.push(o); return; }
      if (o.material.isShaderMaterial) return; // sky / water keep their own look
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      const am = albedoMaterialFor(o, m);
      if (!am) { hidden.push(o); return; }
      swaps.push([o, o.material]); o.material = am;
    });
    for (const o of hidden) o.visible = false;
    const og = renderer.getRenderTarget(), ogBg = scene.background, ogFog = scene.fog, ogSM = renderer.shadowMap.autoUpdate;
    try {
      renderer.shadowMap.autoUpdate = false;
      scene.fog = null;
      renderer.setRenderTarget(G.albedo); renderer.clear(); renderer.render(scene, camera);
      for (const [o, m] of swaps) o.material = m;
      swaps.length = 0;
      scene.overrideMaterial = G.normalMat; scene.background = null;
      renderer.setRenderTarget(G.normal); renderer.clear(); renderer.render(scene, camera);
    } finally {
      scene.overrideMaterial = null; scene.background = ogBg; scene.fog = ogFog; renderer.shadowMap.autoUpdate = ogSM;
      for (const [o, m] of swaps) o.material = m;
      for (const o of hidden) o.visible = true;
      renderer.setRenderTarget(og);
    }
    G.valid = true;
  }
  // returns the filtered radiance texture
  function denoise(target, spp) {
    const w = target.width, h = target.height;
    if (!G || !G.valid || G.w !== w || G.h !== h) return null;
    const D = G.demod.material.uniforms;
    D.tRad.value = target.texture; D.texel.value.set(1 / w, 1 / h); D.k.value = 3 + spp * 0.05;
    renderer.setRenderTarget(G.a); G.demod.render(renderer);
    const A = G.atrous.material.uniforms;
    A.texel.value.set(1 / w, 1 / h);
    A.cNear.value = camera.near; A.cFar.value = camera.far; A.ortho.value = camera.isOrthographicCamera ? 1 : 0;
    A.invP.value.set(1 / camera.projectionMatrix.elements[0], 1 / camera.projectionMatrix.elements[5]);
    A.sigL.value = 0.3 / Math.sqrt(Math.max(1, spp)) + 0.03;
    let src = G.a, dst = G.b;
    const iters = spp < 32 ? 4 : 3;
    for (let i = 0; i < iters; i++) {
      A.tIn.value = src.texture; A.stepPx.value = 1 << i;
      renderer.setRenderTarget(dst); G.atrous.render(renderer);
      [src, dst] = [dst, src];
    }
    return src.texture;
  }

  // ---------- metering: the traced image keeps the raster view's brightness and colour balance ----------
  // The raster view is lit by an IBL room environment and reads brighter than physically-lit interiors; a
  // photographer would open up the exposure and white-balance. We meter the raster frame (linear HDR, before
  // tone mapping) once per camera settle and the accumulating trace at 1, 2, 4, 8… spp, then set an exposure
  // and gentle channel gains so the photo lands where the raster view was (same ACES + renderer exposure after).
  let M = null;
  const MW = 24, MH = 14;
  const auto = { e: 1, g: new THREE.Vector3(1, 1, 1), ref: null, nextAt: 1, fresh: true };
  function makeMeter() {
    const mk = (w, h, type, depth) => new THREE.WebGLRenderTarget(w, h, { type, format: THREE.RGBAFormat, depthBuffer: depth, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    M = {
      raster: mk(192, 108, THREE.HalfFloatType, true), out: mk(MW, MH, THREE.FloatType, false), buf: new Float32Array(MW * MH * 4),
      quad: new FullScreenQuad(new THREE.ShaderMaterial({
        uniforms: { map: { value: null } },
        vertexShader: VS_FS,
        fragmentShader: `precision highp float; uniform sampler2D map; varying vec2 vUv;
          void main(){
            vec2 cell = vec2(1.0 / ${MW}.0, 1.0 / ${MH}.0);
            vec2 o = vUv - 0.5 * cell;
            vec3 acc = vec3(0.0); float lg = 0.0;
            for (int y = 0; y < 6; y++) for (int x = 0; x < 6; x++) {
              vec3 c = max(texture2D(map, o + (vec2(float(x), float(y)) + 0.5) / 6.0 * cell).rgb, vec3(0.0));
              if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
              float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
              lg += log(l + 1e-3);
              acc += min(c, vec3(4.0));
            }
            gl_FragColor = vec4(acc / 36.0, lg / 36.0);
          }`,
        depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false
      }))
    };
  }
  function meterTexture(tex) {
    M.quad.material.uniforms.map.value = tex;
    renderer.setRenderTarget(M.out); M.quad.render(renderer);
    renderer.readRenderTargetPixels(M.out, 0, 0, MW, MH, M.buf);
    let r = 0, g = 0, b = 0, lg = 0; const n = MW * MH;
    for (let i = 0; i < n; i++) { r += M.buf[i * 4]; g += M.buf[i * 4 + 1]; b += M.buf[i * 4 + 2]; lg += M.buf[i * 4 + 3]; }
    const res = { r: r / n, g: g / n, b: b / n, lg: lg / n };
    return [res.r, res.g, res.b, res.lg].every(Number.isFinite) ? res : null;
  }
  function meterRaster() {
    if (!opts.autoExposure) return;
    const og = renderer.getRenderTarget(), ogSM = renderer.shadowMap.autoUpdate;
    try {
      if (!M) makeMeter();
      renderer.shadowMap.autoUpdate = false;
      renderer.setRenderTarget(M.raster); renderer.clear(); renderer.render(scene, camera);
      auto.ref = meterTexture(M.raster.texture);
    } catch (e) { auto.ref = null; } finally { renderer.shadowMap.autoUpdate = ogSM; renderer.setRenderTarget(og); }
    auto.nextAt = 1;
  }
  function meterTrace(tex, spp, kind) {
    if (!opts.autoExposure || !auto.ref || spp < auto.nextAt) return;
    auto.nextAt = spp < 64 ? spp * 2 : spp + 64;
    const og = renderer.getRenderTarget();
    let m = null;
    try { m = meterTexture(tex); } catch (e) { m = null; } finally { renderer.setRenderTarget(og); }
    if (!m) return;
    const ref = auto.ref;
    const strength = kind === 'interior' ? 0.9 : 0.5;
    let e = Math.exp((ref.lg - m.lg) * strength);
    e = Math.min(kind === 'interior' ? 8 : 2.5, Math.max(kind === 'interior' ? 0.7 : 0.5, e));
    // colour: ratio of chromaticities, applied at 60 %, bounded, luminance-neutral
    const lum = (x, y, z) => 0.2126 * x + 0.7152 * y + 0.0722 * z;
    const lr = Math.max(lum(ref.r, ref.g, ref.b), 1e-5), lm = Math.max(lum(m.r, m.g, m.b), 1e-5);
    const gv = [ref.r / lr / Math.max(m.r / lm, 1e-4), ref.g / lr / Math.max(m.g / lm, 1e-4), ref.b / lr / Math.max(m.b / lm, 1e-4)]
      .map(x => Math.min(1.25, Math.max(0.8, Math.pow(x, 0.6))));
    const ln = lum(gv[0], gv[1], gv[2]);
    const k = auto.fresh ? 1 : 0.5;
    auto.e += (e - auto.e) * k;
    auto.g.x += (gv[0] / ln - auto.g.x) * k; auto.g.y += (gv[1] / ln - auto.g.y) * k; auto.g.z += (gv[2] / ln - auto.g.z) * k;
    auto.fresh = false;
    stats.autoExposure = +auto.e.toFixed(3); stats.gains = [auto.g.x, auto.g.y, auto.g.z].map(x => +x.toFixed(3));
  }

  const _size = new THREE.Vector2();
  let curW = 0, curH = 0;
  function ensureSize() {
    renderer.getDrawingBufferSize(_size);
    let w = Math.max(1, Math.round(_size.x * opts.resScale)), h = Math.max(1, Math.round(_size.y * opts.resScale));
    const px = w * h;
    if (px > opts.maxPixels) { const k = Math.sqrt(opts.maxPixels / px); w = Math.round(w * k); h = Math.round(h * k); }
    if (w === curW && h === curH) return;
    curW = w; curH = h;
    full.setSize(w, h);
    preview.setSize(Math.max(8, Math.round(w * opts.previewScale)), Math.max(8, Math.round(h * opts.previewScale)));
    const t = w * h > 1.2e6 ? 3 : w * h > 4.5e5 ? 2 : 1;
    full.tiles.set(t, t);
    full.reset(); preview.reset();
  }

  // ---------- build ----------
  function textureSetOf(materials) {
    const set = new Set();
    for (const m of materials) for (const k of TEX_KEYS) {
      const t = m[k];
      if (t && t.isTexture && !t.isCompressedTexture && !t.isCubeTexture && t.image && (t.image.width || t.image.data)) set.add(t);
    }
    return [...set];
  }
  function uploadMaterials() {
    const { materials, textures } = sceneData;
    for (const m of materials) { // dimmed emitter clones follow their source (time of day, lamps on/off)
      const o = m.userData && m.userData.ptDimOf;
      if (o) { m.emissive.copy(o.emissive); m.color.copy(o.color); m.emissiveIntensity = (o.emissiveIntensity ?? 1) * m.userData.ptDim; }
    }
    ptMat.materials.updateFrom(materials, textures);
    const lights = sceneData.lights.filter(l => l.intensity > 0);
    ptMat.lights.updateFrom(lights);
  }
  async function build() {
    const token = ++buildToken;
    ready = false; rebuilding = true;
    try {
      report({ phase: 'bvh', p: 0, samples: 0 });
      ensurePT();
      await nextFrame();
      if (token !== buildToken) return false;
      const sc = resolveScope();
      let scope = scopeRoots(sc);
      let col = collect(scope);
      // keep the BVH within the triangle budget by shrinking the exterior radius
      let guard = 0;
      while (col.triCount > opts.triCap && sc.kind === 'exterior' && guard++ < 4) {
        opts.exteriorRadius = Math.max(30, opts.exteriorRadius * 0.75);
        scope = scopeRoots(sc); col = collect(scope);
      }
      const key = sc.kind + ':' + (sc.floor || '') + ':' + opts.exteriorRadius;
      if (sceneData && sceneData.key === key && sceneData.signature === col.signature) {
        // same scope and meshes as last time (e.g. stop → start): keep the BVH, refit moved parts only
        sceneData.lights = col.lights.concat(sceneData.emitterLights || []);
        refitIfMoved();
        uploadMaterials();
        if (envSignature() !== envSig || sc.cam.distanceTo(envCenter) > (sc.kind === 'interior' ? 4 : 25)) captureEnv(scope.center, scope.near, scope.hide);
        curW = 0; ensureSize();
        full.reset(); preview.reset();
        lastMove = now(); moving = true; wasMoving = true;
        ready = true;
        report({ phase: 'bvh', p: 1, samples: 0, stats: { ...stats, reused: true } });
        return true;
      }
      report({ phase: 'bvh', p: 0.05, samples: 0 });
      await nextFrame();
      if (token !== buildToken) return false;
      captureEnv(scope.center, scope.near, scope.hide);
      report({ phase: 'bvh', p: 0.15, samples: 0 });
      await yieldTask();
      const baked = await bake(col, token);
      if (!baked || token !== buildToken) return false;
      report({ phase: 'bvh', p: 0.55, samples: 0 });
      await nextFrame();
      if (token !== buildToken) return false;
      const tb = now();
      const bvh = new BVH.MeshBVH(baked.geometry, { strategy: BVH.SAH, maxLeafTris: 1 });
      stats.bvhMs = now() - tb;
      if (token !== buildToken) return false;
      report({ phase: 'bvh', p: 0.85, samples: 0 });
      await nextFrame();
      if (token !== buildToken) return false;
      const geometry = baked.geometry;
      const textures = textureSetOf(baked.materials);
      const texSize = textures.length <= 32 ? 1024 : textures.length <= 96 ? 512 : 256;
      stats.textures = textures.length; stats.texSize = texSize;
      if (sceneData && sceneData.geometry) sceneData.geometry.dispose();
      sceneData = { key, entries: col.entries, geometry, bvh, materials: baked.materials, textures, lights: col.lights.concat(baked.emitterLights), emitterLights: baked.emitterLights, signature: col.signature, scope, sc };
      ptMat.bvh.updateFrom(bvh);
      ptMat.attributesArray.updateFrom(geometry.attributes.normal, geometry.attributes.tangent, geometry.attributes.uv, geometry.attributes.color);
      ptMat.materialIndexAttribute.updateFrom(geometry.attributes.materialIndex);
      ptMat.textures.setTextures(renderer, texSize, texSize, textures);
      uploadMaterials();
      ptMat.bounces = sc.kind === 'interior' ? 7 : 5;
      // compile ahead (non-blocking where KHR_parallel_shader_compile exists)
      const tc = now();
      ptMat.setDefine('FEATURE_DOF', 0);
      ptMat.setDefine('FEATURE_BACKGROUND_MAP', 0);
      ptMat.setDefine('FEATURE_FOG', ptMat.materials.features.isUsed('FOG') ? 1 : 0);
      ptMat.setDefine('CAMERA_TYPE', camera.isOrthographicCamera ? 1 : 0);
      ptMat.physicalCamera.updateFrom(camera);
      const dummy = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), ptMat);
      const ogCheck = renderer.debug.checkShaderErrors;
      renderer.debug.checkShaderErrors = true;
      try {
        if (renderer.compileAsync) await renderer.compileAsync(dummy, camera); else renderer.compile(dummy, camera);
      } finally { renderer.debug.checkShaderErrors = ogCheck; dummy.geometry.dispose(); }
      stats.compileMs = now() - tc;
      if (token !== buildToken) return false;
      const props = renderer.properties.get(ptMat);
      const prog = props && props.currentProgram;
      if (prog && prog.diagnostics && prog.diagnostics.runnable === false) throw new Error('pathtrace: shader failed to compile on this device');
      ensureSize();
      full.reset(); preview.reset();
      lastMove = now(); moving = true; wasMoving = true;
      auto.fresh = true; auto.e = 1; auto.g.set(1, 1, 1);
      ready = true;
      report({ phase: 'bvh', p: 1, samples: 0, stats: { ...stats } });
      return true;
    } catch (e) {
      if (token === buildToken) fail(e);
      return false;
    } finally {
      if (token === buildToken) rebuilding = false;
    }
  }

  function fail(error) {
    active = false; ready = false; buildToken++;
    report({ phase: 'error', error });
    try { renderer.setRenderTarget(null); } catch (e) { /* */ }
  }

  // when the camera settles: scope/topology/material/light/env changes
  function onSettle() {
    if (!sceneData || rebuilding) return;
    const sc = resolveScope();
    const key = sc.kind + ':' + (sc.floor || '') + ':' + opts.exteriorRadius;
    if (key !== sceneData.key) { build(); return; }
    const col = collect(scopeRoots(sc));
    if (col.signature !== sceneData.signature) { build(); return; }
    sceneData.lights = col.lights.concat(sceneData.emitterLights || []);
    refitIfMoved();
    uploadMaterials();
    const moved = sc.cam.distanceTo(envCenter);
    if (envSignature() !== envSig || moved > (sc.kind === 'interior' ? 4 : 25)) {
      const scope = scopeRoots(sc);
      captureEnv(scope.center, scope.near, scope.hide);
    }
  }

  // ---------- public API ----------
  function start() {
    if (disposed) return Promise.resolve(false);
    active = true;
    pill.show(true);
    return build();
  }
  function stop() {
    active = false; ready = false; buildToken++; rebuilding = false;
    pill.show(false);
    // free the big per-view GPU buffers; the BVH / textures stay cached for a quick restart (dispose() frees all)
    try { if (full) full.setSize(1, 1); if (preview) preview.setSize(1, 1); curW = 0; curH = 0; } catch (e) { /* */ }
  }
  function reset() {
    lastMove = now();
    if (full) full.reset();
    if (preview) preview.reset();
  }
  function render() {
    try {
      if (!active) return;
      if (!ready) { renderer.setRenderTarget(null); renderer.render(scene, camera); return; }
      ensureSize();
      camera.updateMatrixWorld();
      const t = now();
      if (!lastCamMatrix.equals(camera.matrixWorld) || !lastProj.equals(camera.projectionMatrix)) {
        lastCamMatrix.copy(camera.matrixWorld); lastProj.copy(camera.projectionMatrix);
        lastMove = t; full.reset(); preview.reset();
      }
      moving = t - lastMove < opts.stillMs;
      if (!moving && wasMoving) {
        onSettle();
        if (!ready) { renderer.setRenderTarget(null); renderer.render(scene, camera); wasMoving = moving; return; }
        full.reset();
        if (opts.denoise) { try { renderGuides(full.target.width, full.target.height); } catch (e) { if (G) G.valid = false; } }
        meterRaster();
      }
      if (moving && G) G.valid = false;
      wasMoving = moving;
      ptMat.physicalCamera.updateFrom(camera);
      let target, spp;
      if (moving) {
        if (preview.samples < 1) preview.update();
        target = preview.target; spp = preview.samples;
      } else {
        if (full.samples < opts.maxSamples) full.update();
        if (full.samples >= 1) { target = full.target; spp = full.samples; }
        else { if (preview.samples < 1) preview.update(); target = preview.target; spp = 0; }
      }
      const U = blit.material.uniforms;
      const og = renderer.getRenderTarget();
      let src = target.texture;
      let filt = null;
      if (!moving && spp >= 1 && spp < opts.denoiseUntil && opts.denoise) filt = denoise(target, spp);
      U.guided.value = filt ? 1 : 0;
      if (filt) {
        U.tFilt.value = filt; U.tAlb.value = G.albedo.texture;
        U.rawMix.value = Math.min(1, Math.max(0, (spp - 16) / (opts.denoiseUntil - 16))) ** 1.5;
      } else if (spp < 256) {
        if (clampRT.width !== target.width || clampRT.height !== target.height) clampRT.setSize(target.width, target.height);
        const C = clampPass.material.uniforms;
        C.map.value = target.texture; C.texel.value.set(1 / target.width, 1 / target.height); C.k.value = 3 + spp * 0.05;
        renderer.setRenderTarget(clampRT); clampPass.render(renderer);
        src = clampRT.texture;
      }
      const kind = sceneData ? sceneData.sc.kind : 'exterior';
      if (!moving && spp >= 1) meterTrace(target.texture, spp, kind);
      U.map.value = src;
      U.exposure.value = (kind === 'interior' ? opts.interiorExposure : opts.exposure) * (opts.autoExposure ? auto.e : 1);
      U.gain.value.copy(opts.autoExposure ? auto.g : _one);
      U.texel.value.set(1 / target.width, 1 / target.height);
      const s = Math.max(1, spp);
      U.sigma.value = spp >= 96 ? 0 : Math.min(2.2, 2.6 / Math.sqrt(s));
      U.rangeSigma.value = Math.min(0.3, 0.08 + 0.25 / Math.sqrt(s));
      renderer.setRenderTarget(null);
      blit.render(renderer);
      renderer.setRenderTarget(og);
      const n = moving ? 0 : Math.floor(full.samples);
      if (n !== lastReported || moving !== lastMoving) { lastReported = n; lastMoving = moving; report({ phase: 'render', p: Math.min(1, n / opts.maxSamples), samples: n, moving }); }
    } catch (e) {
      fail(e);
    }
  }
  let lastReported = -1, lastMoving = null;
  const _one = new THREE.Vector3(1, 1, 1);

  function dispose() {
    stop(); disposed = true;
    pill.remove();
    try {
      if (full) full.dispose(); if (preview) preview.dispose();
      if (ptMat) { ptMat.dispose(); try { ptMat.textures.dispose && ptMat.textures.dispose(); } catch (e) { /* */ } }
      if (blit) { blit.material.dispose(); blit.dispose(); }
      if (clampPass) { clampPass.material.dispose(); clampPass.dispose(); } if (clampRT) clampRT.dispose();
      if (M) { M.raster.dispose(); M.out.dispose(); M.quad.material.dispose(); M.quad.dispose(); }
      if (G) { for (const k of ['albedo', 'normal', 'a', 'b']) G[k].dispose(); G.demod.material.dispose(); G.atrous.material.dispose(); G.normalMat.dispose(); }
      for (const m of albedoMats.values()) m.dispose();
      if (eqQuad) { eqQuad.material.dispose(); eqQuad.dispose(); }
      if (cubeRT) cubeRT.dispose(); if (eqRT) eqRT.dispose(); if (envTex) envTex.dispose();
      if (sceneData && sceneData.geometry) sceneData.geometry.dispose();
      for (const m of matCache.values()) if (m && m.name && /-pt$/.test(m.name)) m.dispose();
    } catch (e) { /* ignore */ }
    sceneData = null; ptMat = null; full = null; preview = null; blit = null;
  }

  return {
    start, stop, isActive: () => active, reset, render,
    samples: () => (full && ready ? Math.floor(full.samples) : 0),
    setMaxSamples(n) { opts.maxSamples = Math.max(1, n | 0); },
    setResolutionScale(s) { opts.resScale = Math.min(2, Math.max(0.1, +s || 1)); if (ready) ensureSize(); },
    setScope(s) {
      if (!['interior', 'exterior', 'auto'].includes(s) || s === opts.scope) return;
      opts.scope = s; opts.exteriorRadius = 80;
      if (active) build();
    },
    dispose,
    // extras (diagnostics)
    available: true,
    get stats() { return { ...stats, scope: sceneData ? sceneData.key : null, resolution: [curW, curH] }; },
    setExposure(e, interior) { if (interior) opts.interiorExposure = +e || 1; else opts.exposure = +e || 1; },
    setDenoise(b) { opts.denoise = !!b; },
    setAutoExposure(b) { opts.autoExposure = !!b; },
    setLabels(l) { pill.labels = Object.assign(pill.labels, l || {}); },
    setOverlay(b) { pill.enabled = !!b; if (!b) pill.show(false); else if (active) pill.show(true); },
    setPreviewScale(s) { opts.previewScale = Math.min(1, Math.max(0.1, +s || 0.3)); curW = 0; },
    // diagnostics: what does the BVH see through normalised device coords (x,y in -1..1)?
    debugPick(x, y) {
      if (!sceneData) return null;
      const rc = new THREE.Raycaster(); rc.setFromCamera(new THREE.Vector2(x, y), camera);
      const hit = sceneData.bvh.raycastFirst(rc.ray, THREE.DoubleSide);
      if (!hit) return 'miss';
      const vi = sceneData.geometry.index.getX(hit.faceIndex * 3);
      const mi = sceneData.geometry.attributes.materialIndex.getX(vi);
      const e = sceneData.entries.find(en => en.parts.some(p => vi >= p.vStart && vi < p.vStart + p.verts.length));
      const m = sceneData.materials[mi];
      return { dist: +hit.distance.toFixed(2), mesh: e && e.mesh.name, inst: e && e.inst, mat: m && m.name, type: m && m.type,
        transparent: m && m.transparent, opacity: m && m.opacity, transmission: m && m.transmission, side: m && m.side, color: m && m.color && m.color.getHexString() };
    },
    debugEnv() {
      if (!envTex) return null;
      const { width: w, height: h, data } = envTex.image;
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d'); const img = g.createImageData(w, h);
      let mx = 0, sum = 0;
      for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
        const i = ((h - 1 - yy) * w + xx) * 4, o = (yy * w + xx) * 4;
        for (let k = 0; k < 3; k++) { const v = data[i + k]; mx = Math.max(mx, v); sum += v; img.data[o + k] = Math.min(255, Math.pow(v / (1 + v), 1 / 2.2) * 255); }
        img.data[o + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      return { url: c.toDataURL(), max: mx, mean: sum / (w * h * 3) };
    },
    debugMaterials() { return sceneData ? sceneData.materials.map(m => `${m.name}|${m.type}|op${m.opacity}|tr${m.transmission || 0}|e${(m.emissiveIntensity || 0)}`) : null; }
  };
}

// ---------- status pill (DOM, inside the canvas' parent; CSS prefix pt-) ----------
function makePill(renderer) {
  const P = {
    enabled: true, el: null, txt: null, bar: null, hideTimer: 0, max: 600,
    labels: { name: 'Photoreal', preparing: 'preparing', moving: 'moving', sample: 'sample', samples: 'samples', error: 'unavailable' },
    ensure() {
      if (P.el || typeof document === 'undefined') return P.el;
      const host = renderer && renderer.domElement && renderer.domElement.parentElement;
      if (!host) return null;
      if (!document.getElementById('pt-style')) {
        const st = document.createElement('style'); st.id = 'pt-style';
        st.textContent = `.pt-pill{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);z-index:5;pointer-events:none;
          display:flex;flex-direction:column;align-items:stretch;gap:5px;min-width:150px;padding:7px 14px 8px;border-radius:999px;
          background:rgba(18,18,20,.62);color:#f4efe6;font:500 12px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:.02em;
          -webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);box-shadow:0 4px 18px rgba(0,0,0,.25);opacity:0;transition:opacity .3s ease}
          .pt-pill.pt-on{opacity:1}
          .pt-pill.pt-sm{bottom:10px;min-width:0;padding:4px 10px 5px;gap:3px;font-size:10.5px}
          .pt-pill .pt-txt{text-align:center;white-space:nowrap;font-variant-numeric:tabular-nums}
          .pt-pill .pt-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#d9b27c;margin-inline-end:7px;vertical-align:1px}
          .pt-pill.pt-busy .pt-dot{animation:pt-pulse 1s ease-in-out infinite}
          .pt-pill.pt-err .pt-dot{background:#e0685a}
          .pt-pill .pt-bar{height:2px;border-radius:2px;background:rgba(255,255,255,.18);overflow:hidden}
          .pt-pill .pt-bar>i{display:block;height:100%;width:0;background:#d9b27c;transition:width .25s linear}
          @keyframes pt-pulse{50%{opacity:.3}}
          @media (prefers-reduced-motion: reduce){.pt-pill,.pt-pill .pt-bar>i{transition:none}.pt-pill.pt-busy .pt-dot{animation:none}}`;
        document.head.appendChild(st);
      }
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
      const el = document.createElement('div'); el.className = 'pt-pill'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
      el.innerHTML = '<div class="pt-txt"><span class="pt-dot"></span><span class="pt-label"></span></div><div class="pt-bar"><i></i></div>';
      host.appendChild(el);
      P.el = el; P.txt = el.querySelector('.pt-label'); P.bar = el.querySelector('.pt-bar>i');
      return el;
    },
    show(on) {
      clearTimeout(P.hideTimer);
      if (!P.enabled && on) return;
      const el = on ? P.ensure() : P.el;
      if (!el) return;
      if (on) { el.classList.remove('pt-err'); el.classList.toggle('pt-sm', (el.parentElement && el.parentElement.clientWidth || 1000) < 640); P.set(P.labels.name + ' · ' + P.labels.preparing, 0, true); }
      el.classList.toggle('pt-on', !!on);
    },
    set(text, frac, busy) {
      if (!P.el) return;
      if (P.txt.textContent !== text) P.txt.textContent = text;
      P.bar.parentElement.style.display = frac == null ? 'none' : '';
      if (frac != null) P.bar.style.width = (Math.max(0, Math.min(1, frac)) * 100).toFixed(1) + '%';
      P.el.classList.toggle('pt-busy', !!busy);
    },
    update(o) {
      if (!P.enabled || !o) return;
      const L = P.labels;
      if (o.phase === 'error') {
        if (!P.ensure()) return;
        P.el.classList.add('pt-on', 'pt-err'); P.set(L.name + ' · ' + L.error, null, false);
        clearTimeout(P.hideTimer); P.hideTimer = setTimeout(() => P.el && P.el.classList.remove('pt-on'), 3500);
        return;
      }
      if (!P.el || !P.el.classList.contains('pt-on')) return;
      if (o.phase === 'bvh') P.set(L.name + ' · ' + L.preparing + ' ' + Math.round((o.p || 0) * 100) + '%', o.p || 0, true);
      else if (o.phase === 'render') {
        if (o.moving) P.set(L.name + ' · ' + L.moving, null, true);
        else P.set(L.name + ' · ' + o.samples + ' ' + (o.samples === 1 ? L.sample : L.samples), o.p >= 1 ? null : o.p, o.p < 1);
      }
    },
    remove() { clearTimeout(P.hideTimer); if (P.el && P.el.parentNode) P.el.parentNode.removeChild(P.el); P.el = null; }
  };
  return P;
}
