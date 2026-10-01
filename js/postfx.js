// VILNYI · Barreiro 2 — POSTFX: real-time quality pass for the raster views (exterior / interior / aerial).
//
// API (CONTRACT2.md):
//   createPostFX(THREE, { renderer, scene, camera, quality:'high'|'low', mode? }) => {
//     render(dt), setSize(w, h), setEnabled(bool), setQuality(q), setMode('exterior'|'interior'|'aerial'), dispose(),
//     // extras: isActive(), setTimeOfDay('day'|'golden'|'dusk'), setGrade(bool), setCamera(cam), setScene(scene),
//     //         setAOIntensity(k), stats() => { ms, passes, active }, composer (or null)
//   }
//   improveShadows(renderer, sun, { quality, mode }) — optional helper (ENV owns the sun; the viewer may call it).
//
// Pipeline (quality 'high'):
//   RenderPass (linear HDR, half-float) → AOPass (GTAO, own normal/depth pre-pass that skips glass, decals, sky dome,
//   pickers, alpha-cut foliage, points/lines/sprites) → UnrealBloomPass (high threshold: emissives & sun glints only)
//   → OutGradePass (renderer.toneMapping + exposure + sRGB, i.e. the ONLY tone mapping, + warm split-tone, gentle
//   contrast, vignette, dither) → SMAAPass (to screen).
// The renderer's own toneMapping is never applied twice: RenderPass draws into a render target (three r153+ only tone-maps
// when drawing to the canvas) and OutGradePass reads renderer.toneMapping/exposure/outputColorSpace each frame.
// quality 'low', setEnabled(false), or any runtime error → plain renderer.render(scene, camera).

import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// ---------------------------------------------------------------------------------------------------------------
// Per-mode tuning. AO radius/thickness in metres (world space). fade = view-distance band where AO fades out
// (depth precision with near 0.3 / far 30 km makes far AO noisy, and far AO is invisible anyway).
const PRESETS = {
  exterior: {
    ao: { on: true, radius: 1.2, distanceExponent: 1.6, thickness: 1.5, scale: 1.1, samples: 12, distanceFallOff: 1.0, blend: 1.0, res: 1.0, fade: [60, 160] },
    bloom: { on: true, strength: 0.16, radius: 0.35, threshold: 1.55 },
    grade: { warmth: 0.9, contrast: 1.04, saturation: 1.04, vignette: 0.26, lift: 0.006 }
  },
  interior: {
    ao: { on: true, radius: 0.45, distanceExponent: 1.6, thickness: 0.45, scale: 0.8, samples: 16, distanceFallOff: 1.0, blend: 0.85, res: 1.0, fade: [14, 40] },
    bloom: { on: true, strength: 0.24, radius: 0.5, threshold: 1.25 },
    grade: { warmth: 1.0, contrast: 1.03, saturation: 1.03, vignette: 0.3, lift: 0.008 }
  },
  aerial: {
    ao: { on: false },
    bloom: { on: true, strength: 0.12, radius: 0.3, threshold: 1.8 },
    grade: { warmth: 0.6, contrast: 1.03, saturation: 1.05, vignette: 0.2, lift: 0.004 }
  }
};
// time of day multipliers (street lamps / window glow read better with more bloom at dusk)
const TOD = {
  day: { bloomK: 1.0, thrK: 1.0, warmK: 1.0 },
  golden: { bloomK: 1.15, thrK: 0.95, warmK: 0.8 }, // light is already warm: don't double it
  dusk: { bloomK: 2.2, thrK: 0.6, warmK: 0.5 }
};

// ---------------------------------------------------------------------------------------------------------------
// GTAO with a filtered G-buffer pre-pass and no shadow-map re-render.
function makeAOPass(THREE, scene, camera, w, h) {
  class AOPass extends GTAOPass {
    constructor() {
      super(scene, camera, w, h);
      this.resScale = 1;
      this._hidden = [];
    }
    setSize(width, height) {
      super.setSize(Math.max(1, Math.round(width * this.resScale)), Math.max(1, Math.round(height * this.resScale)));
    }
    // hide everything that must not occlude or receive AO in the normal/depth pre-pass
    overrideVisibility() {
      const hid = this._hidden; hid.length = 0;
      this.scene.traverseVisible((o) => { if (skipAO(o)) { o.visible = false; hid.push(o); } });
    }
    restoreVisibility() {
      const hid = this._hidden;
      for (let i = 0; i < hid.length; i++) hid[i].visible = true;
      hid.length = 0;
    }
    renderOverride(renderer, overrideMaterial, renderTarget, clearColor, clearAlpha) {
      // the pre-pass must not re-render shadow maps nor draw the background (sky box / cube / colour)
      const sm = renderer.shadowMap, au = sm.autoUpdate, nu = sm.needsUpdate;
      const bg = this.scene.background;
      sm.autoUpdate = false; sm.needsUpdate = false; this.scene.background = null;
      try { super.renderOverride(renderer, overrideMaterial, renderTarget, clearColor, clearAlpha); }
      finally { sm.autoUpdate = au; sm.needsUpdate = nu; this.scene.background = bg; }
    }
  }
  return new AOPass();
}

function matSkipsAO(m) {
  if (!m) return true;
  if (m.visible === false || m.colorWrite === false || m.depthWrite === false || m.depthTest === false) return true;
  if (m.transparent && !(m.userData && m.userData.aoOpaque)) return true; // glass, sheers, decals, glow cards, fades
  if (m.transmission > 0 || m.alphaTest > 0 || m.alphaHash) return true;   // foliage cards would become solid quads
  if (m.isShaderMaterial && !(m.userData && m.userData.aoOpaque)) return true; // sky / water shaders
  return false;
}
function skipAO(o) {
  if (o.isPoints || o.isLine || o.isSprite) return true;
  if (o.userData && (o.userData.noAO || o.userData.ao === false)) return true;
  if (!o.isMesh) return false;
  const m = o.material;
  if (Array.isArray(m)) { for (let i = 0; i < m.length; i++) if (!matSkipsAO(m[i])) return false; return true; }
  return matSkipsAO(m);
}

// ---------------------------------------------------------------------------------------------------------------
// Output (tone mapping + colour space) + photographic grade in ONE full-screen pass.
function makeOutGradePass(THREE) {
  const shader = {
    uniforms: {
      tDiffuse: { value: null }, toneMappingExposure: { value: 1 },
      uGrade: { value: 1 }, uWarmth: { value: 1 }, uContrast: { value: 1 }, uSaturation: { value: 1 },
      uVignette: { value: 0.25 }, uLift: { value: 0 }, uAspect: { value: 1 }, uFrame: { value: 0 }
    },
    vertexShader: /* glsl */`
      precision highp float;
      uniform mat4 modelViewMatrix; uniform mat4 projectionMatrix;
      attribute vec3 position; attribute vec2 uv; varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform sampler2D tDiffuse;
      uniform float uGrade, uWarmth, uContrast, uSaturation, uVignette, uLift, uAspect, uFrame;
      #include <tonemapping_pars_fragment>
      #include <colorspace_pars_fragment>
      varying vec2 vUv;
      float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
      void main() {
        gl_FragColor = texture2D(tDiffuse, vUv);
        #ifdef LINEAR_TONE_MAPPING
          gl_FragColor.rgb = LinearToneMapping(gl_FragColor.rgb);
        #elif defined( REINHARD_TONE_MAPPING )
          gl_FragColor.rgb = ReinhardToneMapping(gl_FragColor.rgb);
        #elif defined( CINEON_TONE_MAPPING )
          gl_FragColor.rgb = OptimizedCineonToneMapping(gl_FragColor.rgb);
        #elif defined( ACES_FILMIC_TONE_MAPPING )
          gl_FragColor.rgb = ACESFilmicToneMapping(gl_FragColor.rgb);
        #elif defined( AGX_TONE_MAPPING )
          gl_FragColor.rgb = AgXToneMapping(gl_FragColor.rgb);
        #endif
        #ifdef SRGB_TRANSFER
          gl_FragColor = sRGBTransferOETF(gl_FragColor);
        #endif
        if (uGrade > 0.5) {
          vec3 c = clamp(gl_FragColor.rgb, 0.0, 1.0);
          float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
          // split tone: faintly cool shadows, warm highlights (architectural-photography look)
          float hi = smoothstep(0.25, 0.9, l);
          c += uWarmth * mix(vec3(-0.006, 0.0, 0.012) * (1.0 - l), vec3(0.022, 0.008, -0.018), hi);
          // gentle S-curve around mid grey + tiny black lift (no crushed blacks)
          c = mix(c, c * c * (3.0 - 2.0 * c), (uContrast - 1.0) * 4.0);
          c = uLift + c * (1.0 - uLift);
          l = dot(c, vec3(0.2126, 0.7152, 0.0722));
          c = mix(vec3(l), c, uSaturation);
          // optical vignette (cos^4-like), stronger in the corners than on the edges
          vec2 d = (vUv - 0.5) * vec2(uAspect, 1.0);
          float r2 = dot(d, d) / (0.25 * (uAspect * uAspect + 1.0));
          c *= 1.0 - uVignette * smoothstep(0.18, 1.0, r2);
          // dither (kills 8-bit banding in skies and render walls)
          c += (hash12(gl_FragCoord.xy + fract(uFrame * 0.618) * 97.0) - 0.5) / 255.0;
          gl_FragColor.rgb = c;
        }
      }`
  };
  class OutGradePass extends Pass {
    constructor() {
      super();
      this.uniforms = THREE.UniformsUtils.clone(shader.uniforms);
      this.material = new THREE.RawShaderMaterial({ uniforms: this.uniforms, vertexShader: shader.vertexShader, fragmentShader: shader.fragmentShader });
      this.fsQuad = new FullScreenQuad(this.material);
      this._cs = null; this._tm = null;
    }
    render(renderer, writeBuffer, readBuffer) {
      this.uniforms.tDiffuse.value = readBuffer.texture;
      this.uniforms.toneMappingExposure.value = renderer.toneMappingExposure;
      if (this._cs !== renderer.outputColorSpace || this._tm !== renderer.toneMapping) {
        this._cs = renderer.outputColorSpace; this._tm = renderer.toneMapping;
        const d = this.material.defines = {};
        if (THREE.ColorManagement.getTransfer(this._cs) === THREE.SRGBTransfer) d.SRGB_TRANSFER = '';
        const tm = this._tm;
        if (tm === THREE.LinearToneMapping) d.LINEAR_TONE_MAPPING = '';
        else if (tm === THREE.ReinhardToneMapping) d.REINHARD_TONE_MAPPING = '';
        else if (tm === THREE.CineonToneMapping) d.CINEON_TONE_MAPPING = '';
        else if (tm === THREE.ACESFilmicToneMapping) d.ACES_FILMIC_TONE_MAPPING = '';
        else if (tm === THREE.AgXToneMapping) d.AGX_TONE_MAPPING = '';
        this.material.needsUpdate = true;
      }
      renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
      if (this.clear) renderer.clear(renderer.autoClearColor, renderer.autoClearDepth, renderer.autoClearStencil);
      this.fsQuad.render(renderer);
    }
    dispose() { this.material.dispose(); this.fsQuad.dispose(); }
  }
  return new OutGradePass();
}

// ---------------------------------------------------------------------------------------------------------------
export function createPostFX(THREE, { renderer, scene, camera, quality = 'high', mode = 'exterior' } = {}) {
  let enabled = true, failed = false, q = quality === 'low' ? 'low' : 'high';
  let curMode = PRESETS[mode] ? mode : 'exterior', tod = 'day', gradeOn = true, aoK = 1;
  let composer = null, renderPass = null, aoPass = null, bloomPass = null, outPass = null, smaaPass = null;
  let W = 0, H = 0, PR = 1, frame = 0, lastMs = 0;
  const tmpV = new THREE.Vector2();

  function composerPR() { return Math.min(renderer.getPixelRatio() || 1, 1.5); }
  function curSize() { renderer.getSize(tmpV); return [Math.max(1, tmpV.x | 0), Math.max(1, tmpV.y | 0)]; }

  function build() {
    if (composer || failed) return;
    try {
      if (!renderer.capabilities.isWebGL2) throw new Error('WebGL2 required');
      [W, H] = curSize(); PR = composerPR();
      const rt = new THREE.WebGLRenderTarget(W * PR, H * PR, { type: THREE.HalfFloatType, colorSpace: THREE.LinearSRGBColorSpace });
      composer = new EffectComposer(renderer, rt);
      composer.setPixelRatio(PR);
      composer.setSize(W, H);
      renderPass = new RenderPass(scene, camera);
      aoPass = makeAOPass(THREE, scene, camera, W * PR, H * PR);
      bloomPass = new UnrealBloomPass(new THREE.Vector2(W * PR, H * PR), 0.16, 0.35, 1.55);
      outPass = makeOutGradePass(THREE);
      smaaPass = new SMAAPass(W * PR, H * PR);
      composer.addPass(renderPass); composer.addPass(aoPass); composer.addPass(bloomPass);
      composer.addPass(outPass); composer.addPass(smaaPass);
      applyMode();
      composer.setSize(W, H);
    } catch (e) {
      fail(e);
    }
  }

  function fail(e) {
    failed = true;
    try { console.warn('[postfx] falling back to plain rendering:', e && e.message || e); } catch (_) { /* */ }
    try { if (composer) teardown(); } catch (_) { /* */ }
  }

  function applyMode() {
    if (!composer) return;
    const P = PRESETS[curMode], T = TOD[tod] || TOD.day;
    // AO
    const ao = P.ao;
    aoPass.enabled = !!ao.on && aoK > 0;
    if (ao.on) {
      aoPass.updateGtaoMaterial({ radius: ao.radius, distanceExponent: ao.distanceExponent, thickness: ao.thickness, scale: ao.scale, samples: ao.samples, distanceFallOff: ao.distanceFallOff, screenSpaceRadius: false });
      aoPass.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: ao.res < 1 ? 6 : 5, rings: 2, samples: 12 });
      aoPass.blendIntensity = ao.blend * aoK;
      const f = `vec4(vec3(mix(ao, 1.0, smoothstep(${ao.fade[0].toFixed(1)}, ${ao.fade[1].toFixed(1)}, -viewPos.z))), 1.0)`;
      if (aoPass.gtaoMaterial.defines.FRAGMENT_OUTPUT !== f) { aoPass.gtaoMaterial.defines.FRAGMENT_OUTPUT = f; aoPass.gtaoMaterial.needsUpdate = true; }
      if (aoPass.resScale !== ao.res) { aoPass.resScale = ao.res; aoPass.setSize(W * PR, H * PR); }
    }
    // bloom
    const b = P.bloom;
    bloomPass.enabled = !!b.on;
    bloomPass.strength = b.strength * T.bloomK;
    bloomPass.radius = b.radius;
    bloomPass.threshold = b.threshold * T.thrK;
    // grade
    const g = P.grade, u = outPass.uniforms;
    u.uGrade.value = gradeOn ? 1 : 0;
    u.uWarmth.value = g.warmth * T.warmK; u.uContrast.value = g.contrast; u.uSaturation.value = g.saturation;
    u.uVignette.value = g.vignette; u.uLift.value = g.lift;
  }

  function resizeIfNeeded() {
    const [w, h] = curSize(), pr = composerPR();
    if (w !== W || h !== H || pr !== PR) { W = w; H = h; PR = pr; composer.setPixelRatio(PR); composer.setSize(W, H); }
  }

  function teardown() {
    for (const p of [renderPass, aoPass, bloomPass, outPass, smaaPass]) { try { p && p.dispose && p.dispose(); } catch (_) { /* */ } }
    try { composer && composer.dispose(); } catch (_) { /* */ }
    composer = renderPass = aoPass = bloomPass = outPass = smaaPass = null;
  }

  function isActive() { return enabled && q === 'high' && !failed; }

  function render(dt) {
    const t0 = performance.now();
    if (isActive()) {
      if (!composer) build();
      if (composer) {
        try {
          resizeIfNeeded();
          outPass.uniforms.uAspect.value = W / H;
          outPass.uniforms.uFrame.value = frame++;
          composer.render(dt);
          lastMs = performance.now() - t0;
          return;
        } catch (e) { fail(e); try { renderer.setRenderTarget(null); } catch (_) { /* */ } }
      }
    }
    renderer.render(scene, camera);
    lastMs = performance.now() - t0;
  }

  return {
    render,
    setSize(w, h) {
      if (!composer) return;
      try { W = Math.max(1, w | 0); H = Math.max(1, h | 0); PR = composerPR(); composer.setPixelRatio(PR); composer.setSize(W, H); } catch (e) { fail(e); }
    },
    setEnabled(b) { enabled = !!b; },
    setQuality(v) { q = v === 'low' ? 'low' : 'high'; if (q === 'low' && composer) teardown(); },
    setMode(m) { if (PRESETS[m]) { curMode = m; applyMode(); } },
    dispose() { teardown(); failed = true; },
    // extras
    isActive,
    setTimeOfDay(name) { if (TOD[name]) { tod = name; applyMode(); } },
    setGrade(b) { gradeOn = !!b; applyMode(); },
    setAOIntensity(k) { aoK = Math.max(0, +k || 0); applyMode(); },
    setCamera(cam) { camera = cam; if (renderPass) renderPass.camera = cam; if (aoPass) aoPass.camera = cam; },
    setScene(s) { scene = s; if (renderPass) renderPass.scene = s; if (aoPass) aoPass.scene = s; },
    stats() { return { ms: lastMs, active: isActive() && !!composer, passes: composer ? composer.passes.filter(p => p.enabled).length : 0, mode: curMode }; },
    get composer() { return composer; }
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Suggested sun-shadow tuning (ENV owns the light — call only if the viewer/ENV agree).
// PCFSoftShadowMap ignores shadow.radius; VSM honours radius/blurSamples but light-leaks on thin geometry, so default PCFSoft.
export function improveShadows(renderer, sun, { quality = 'high', mode = 'exterior' } = {}) {
  try {
    if (!sun || !sun.shadow) return;
    const high = quality !== 'low';
    const s = sun.shadow, size = high ? 2048 : 1024;
    if (s.mapSize.x !== size) { s.mapSize.set(size, size); if (s.map) { s.map.dispose(); s.map = null; } }
    const cam = s.camera;
    const texel = (cam.right - cam.left) / size;              // world metres per shadow texel (≈ 0.024 m for ±25 m @ 2048)
    s.normalBias = Math.max(0.02, texel * 1.5);                // push along the normal ≈ 1.5 texels: kills acne on grazing render walls
    s.bias = -0.0002;                                          // small constant; larger values detach contact shadows (peter-panning)
    // VSM only (switching the map type is the viewer's call — it recompiles every material)
    if (renderer.shadowMap.type === 3 /* THREE.VSMShadowMap */) { s.radius = mode === 'interior' ? 6 : 4; s.blurSamples = 12; s.bias = -0.0001; s.normalBias = texel; }
    s.needsUpdate = true;
  } catch (_) { /* never throw */ }
}
