"""World lighting (HDRI with extracted sun -> matched sun lamp, physically normalised), render settings,
colour management (AgX), auto exposure and a light photographic compositor pass."""
import math, os
import bpy
import numpy as np
from mathutils import Vector

import vb_library as L
import vb_assets as A

LUMEN_W = 1.0 / 683.0
# site frame (CONTRACT2): Blender +x has compass bearing 61.38 deg, Blender +y (= three -z) bearing 331.38 deg
BEARING_X = 61.38


def bearing_vec(bearing_deg, alt_deg=0.0):
    """Unit vector (Blender coords) pointing TO compass bearing at altitude."""
    a = math.radians(bearing_deg - BEARING_X)
    h = math.cos(math.radians(alt_deg))
    return Vector((math.cos(a) * h, -math.sin(a) * h, math.sin(math.radians(alt_deg))))


def vec_bearing(v):
    a = math.degrees(math.atan2(-v.y, v.x))
    return (a + BEARING_X) % 360.0, math.degrees(math.asin(max(-1, min(1, v.z / max(v.length, 1e-9)))))


# ------------------------------------------------------------------ HDRI analysis
def analyse_hdri(img):
    """Find the sun in an equirect HDRI, measure sun irradiance + sky horizontal irradiance (in HDRI units),
    and return a sun-free copy (sun pixels replaced by the surrounding sky)."""
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(h, w, 4)  # row 0 = bottom
    lum = 0.2126 * px[..., 0] + 0.7152 * px[..., 1] + 0.0722 * px[..., 2]
    # pixel directions (Blender world equirect: u=0.5 -> -Y? we use the env-texture convention:
    # direction = (cos(phi)cos(theta)... ) computed via Blender's mapping: u = atan2(dir.y, -dir.x)/(2pi) + 0.5, v = atan2(dir.z, hypot(x,y))/pi + 0.5
    vv = (np.arange(h) + 0.5) / h
    uu = (np.arange(w) + 0.5) / w
    lat = (vv - 0.5) * math.pi              # -pi/2 .. pi/2 (row 0 bottom)
    lon = (uu - 0.5) * 2 * math.pi
    dA = (2 * math.pi / w) * (math.pi / h) * np.cos(lat)[:, None] * np.ones((1, w))
    # sun = brightest blob
    j, i = np.unravel_index(np.argmax(lum), lum.shape)
    peak = float(lum[j, i])
    sky_med = float(np.median(lum[h // 2:, :]))
    res = {'w': w, 'h': h, 'peak': peak, 'sky_median': sky_med}
    has_sun = peak > 50 * max(sky_med, 1e-6)
    sun_mask = np.zeros_like(lum, dtype=bool)
    if has_sun:
        # threshold relative to peak; grow a small window around the peak
        r = max(3, int(w / 360 * 4))
        j0, j1, i0, i1 = max(0, j - r), min(h, j + r + 1), max(0, i - r), min(w, i + r + 1)
        win = lum[j0:j1, i0:i1]
        thr = max(sky_med * 30, peak * 0.002)
        m = win > thr
        sun_mask[j0:j1, i0:i1] = m
        e = (px[..., :3][sun_mask] * dA[sun_mask][:, None]).sum(axis=0)   # RGB irradiance of the sun (normal incidence)
        sun_E = float(0.2126 * e[0] + 0.7152 * e[1] + 0.0722 * e[2])
        sun_rgb = e / max(e.max(), 1e-9)
        # direction (Blender env texture convention): u -> azimuth, v -> elevation
        u, v = (i + 0.5) / w, (j + 0.5) / h
        phi = (u - 0.5) * 2 * math.pi
        theta = (v - 0.5) * math.pi
        # Cycles equirect: u = 0.5 - atan2(y, x) / 2pi  ->  u = 0.5 is +X, u grows clockwise seen from above
        d = Vector((math.cos(theta) * math.cos(phi), -math.cos(theta) * math.sin(phi), math.sin(theta)))
        res.update(sun=True, sun_E=sun_E, sun_rgb=tuple(float(x) for x in sun_rgb), sun_dir=tuple(d), sun_px=int(m.sum()))
        # remove the sun: replace with the ring median
        ring = lum[j0:j1, i0:i1][~m]
        fill = px[j0:j1, i0:i1][~m][:, :3].mean(axis=0) if ring.size else np.array([sky_med] * 3)
        px[..., :3][sun_mask] = fill
    else:
        res['sun'] = False
    # horizontal sky irradiance of the (sun-free) sky
    up = lat > 0
    lum2 = 0.2126 * px[..., 0] + 0.7152 * px[..., 1] + 0.0722 * px[..., 2]
    sky_E = float((lum2[up, :] * dA[up, :] * np.sin(lat[up])[:, None]).sum())
    res['sky_E'] = sky_E
    return res, px


def setup_world(tod, opts, log):
    """HDRI sky + matched sun lamp. Returns dict with sun info."""
    sc = bpy.context.scene
    sk = dict(L.SKIES[tod])
    sk.update(opts.get('sky_override', {}) or {})
    world = bpy.data.worlds.new('vbWorld'); sc.world = world; world.use_nodes = True
    nt = world.node_tree; nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputWorld')
    path = A.hdri_path(tod, sk['hdri'], opts.get('hdri_res', '4k'))
    info = {'tod': tod, 'hdri': sk['hdri'], 'path': path}
    if not path:
        # fallback: Nishita sky
        log(f'[world] HDRI {sk["hdri"]} unavailable -> Nishita')
        skyn = nt.nodes.new('ShaderNodeTexSky'); skyn.sky_type = 'NISHITA'
        alt = {'day': 45, 'golden': 22, 'dusk': -2}[tod]
        b = bearing_vec(sk['sun_az'], alt)
        skyn.sun_elevation = math.radians(alt); skyn.sun_rotation = math.atan2(b.x, b.y)
        skyn.sun_disc = False
        bg = nt.nodes.new('ShaderNodeBackground'); bg.inputs['Strength'].default_value = 0.3
        nt.links.new(skyn.outputs[0], bg.inputs[0]); nt.links.new(bg.outputs[0], out.inputs[0])
        if alt > 0:
            make_sun(b, sk.get('sun_lux', 50000) * LUMEN_W, (1, 0.85, 0.7), 0.53)
        return info
    img = bpy.data.images.load(path, check_existing=True)
    res, px = analyse_hdri(img)
    log(f'[world] {sk["hdri"]} {res["w"]}x{res["h"]} sun={res.get("sun")} sun_E={res.get("sun_E", 0):.3f} sky_E={res["sky_E"]:.3f}')
    # write the sun-free sky to disk and load it back (generated float images are not reliably seen by Cycles in -b)
    tmp = bpy.data.images.new('vbSkyTmp', res['w'], res['h'], alpha=True, float_buffer=True)
    tmp.pixels.foreach_set(px.ravel())
    sky_path = os.path.join(opts.get('tmpdir', '/tmp'), f'vbsky-{tod}.exr')
    tmp.filepath_raw = sky_path; tmp.file_format = 'OPEN_EXR'
    tmp.save()
    bpy.data.images.remove(tmp)
    clean = bpy.data.images.load(sky_path)
    # normalisation: sky horizontal irradiance -> target lux/683
    scale = (sk['sky_lux'] * LUMEN_W) / max(res['sky_E'], 1e-9)
    rot_z = 0.0
    sun_dir = None
    if res.get('sun'):
        d = Vector(res['sun_dir'])
        b0, alt = vec_bearing(d)
        target_b = sk.get('sun_az', b0)
        # rotate the world about Z so the HDRI sun sits at the wanted site bearing
        rot_z = math.radians(target_b - b0)   # Mapping rotates the LOOKUP vector: world sun = Rz(-rot) * hdri sun
        sun_dir = bearing_vec(target_b, alt)
        sunE_target = sk['sun_lux'] * LUMEN_W if sk.get('sun_lux') else res['sun_E'] * scale
        # keep the sky/sun ratio of the photograph (physically consistent), pin the sun to the target illuminance
        scale = sunE_target / max(res['sun_E'], 1e-9)
        sun_E = res['sun_E'] * scale
        info.update(sun_bearing=target_b, sun_alt=alt, sun_E=sun_E, sun_rgb=res['sun_rgb'])
        log(f'[world] sun at bearing {target_b:.1f} alt {alt:.1f}  E={sun_E:.1f} W/m2(phot) = {sun_E / LUMEN_W:.0f} lux  sky x{scale:.4g}')
    info['scale'] = scale
    tc = nt.nodes.new('ShaderNodeTexCoord'); mp = nt.nodes.new('ShaderNodeMapping')
    mp.inputs['Rotation'].default_value = (0, 0, rot_z)
    env = nt.nodes.new('ShaderNodeTexEnvironment'); env.image = clean; env.interpolation = 'Cubic'
    bg = nt.nodes.new('ShaderNodeBackground'); bg.inputs['Strength'].default_value = scale * opts.get('sky_gain', 1.0)
    nt.links.new(tc.outputs['Generated'], mp.inputs['Vector']); nt.links.new(mp.outputs['Vector'], env.inputs['Vector'])
    nt.links.new(env.outputs['Color'], bg.inputs['Color'])
    # camera sees a slightly brighter sky (photographic), lighting uses the calibrated one
    lp = nt.nodes.new('ShaderNodeLightPath')
    bg2 = nt.nodes.new('ShaderNodeBackground'); bg2.name = 'vbSkyCam'
    bg2.inputs['Strength'].default_value = scale * opts.get('sky_gain', 1.0) * opts.get('sky_visible_gain', 1.0)
    bg2['base'] = scale * opts.get('sky_gain', 1.0)
    hs = nt.nodes.new('ShaderNodeHueSaturation'); hs.inputs['Saturation'].default_value = opts.get('sky_saturation', 1.35)
    nt.links.new(env.outputs['Color'], hs.inputs['Color'])
    # photographic sky grade (polariser-like): deeper blue towards the zenith, untouched at the horizon
    sep = nt.nodes.new('ShaderNodeSeparateXYZ'); nt.links.new(tc.outputs['Generated'], sep.inputs[0])
    mr = nt.nodes.new('ShaderNodeMapRange'); mr.interpolation_type = 'SMOOTHSTEP'
    mr.inputs['From Min'].default_value = 0.02; mr.inputs['From Max'].default_value = 0.75
    nt.links.new(sep.outputs['Z'], mr.inputs['Value'])
    mx2 = nt.nodes.new('ShaderNodeMix'); mx2.data_type = 'RGBA'; mx2.blend_type = 'MIX'
    nt.links.new(mr.outputs['Result'], mx2.inputs['Factor'])
    a_in = [i for i in mx2.inputs if i.type == 'RGBA']
    a_in[0].default_value = (1, 1, 1, 1); a_in[1].default_value = opts.get('sky_zenith_tint', (0.45, 0.68, 1.3, 1))
    mul = nt.nodes.new('ShaderNodeMix'); mul.data_type = 'RGBA'; mul.blend_type = 'MULTIPLY'; mul.inputs['Factor'].default_value = 1.0
    m_in = [i for i in mul.inputs if i.type == 'RGBA']
    nt.links.new(hs.outputs['Color'], m_in[0]); nt.links.new([o for o in mx2.outputs if o.type == 'RGBA'][0], m_in[1])
    nt.links.new([o for o in mul.outputs if o.type == 'RGBA'][0], bg2.inputs['Color'])
    mx = nt.nodes.new('ShaderNodeMixShader')
    nt.links.new(lp.outputs['Is Camera Ray'], mx.inputs[0]); nt.links.new(bg.outputs[0], mx.inputs[1]); nt.links.new(bg2.outputs[0], mx.inputs[2])
    nt.links.new(mx.outputs[0], out.inputs[0])
    try:
        world.cycles.sampling_method = 'MANUAL'; world.cycles.sample_map_resolution = 2048
    except Exception:
        pass
    if sun_dir is not None:
        rgb = info['sun_rgb']
        make_sun(sun_dir, info['sun_E'], rgb, 0.53)
    return info


def make_sun(direction, strength, rgb, angle_deg):
    ld = bpy.data.lights.new('vbSun', type='SUN')
    ld.energy = strength
    ld.color = rgb[:3]
    ld.angle = math.radians(angle_deg)
    ob = bpy.data.objects.new('vbSun', ld)
    bpy.context.scene.collection.objects.link(ob)
    ob.rotation_euler = (-Vector(direction)).to_track_quat('-Z', 'Y').to_euler()
    return ob


# ------------------------------------------------------------------ render settings
def setup_render(opts):
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    cy = sc.cycles
    cy.device = 'CPU'
    cy.samples = opts.get('samples', 128)
    cy.use_adaptive_sampling = True
    cy.adaptive_threshold = opts.get('adaptive_threshold', 0.02)
    cy.adaptive_min_samples = min(64, max(16, cy.samples // 8))
    cy.use_denoising = True
    try:
        cy.denoiser = 'OPENIMAGEDENOISE'
        cy.denoising_input_passes = 'RGB_ALBEDO_NORMAL'
        cy.denoising_prefilter = 'ACCURATE'
        cy.denoising_quality = 'HIGH'
    except Exception:
        pass
    try:
        cy.use_light_tree = True
    except Exception:
        pass
    cy.max_bounces = 8; cy.diffuse_bounces = opts.get('diffuse_bounces', 3); cy.glossy_bounces = 3
    cy.transmission_bounces = 8; cy.transparent_max_bounces = 12; cy.volume_bounces = 0
    cy.sample_clamp_direct = 0.0; cy.sample_clamp_indirect = opts.get('clamp_indirect', 10.0)
    cy.blur_glossy = 1.0; cy.caustics_reflective = False; cy.caustics_refractive = False
    cy.filter_width = 1.5
    cy.seed = 7
    try:
        cy.texture_limit_render = opts.get('texture_limit', 'OFF')
    except Exception:
        pass
    sc.render.use_persistent_data = True
    sc.render.film_transparent = False
    sc.render.threads_mode = 'AUTO'
    try:
        sc.cycles.use_auto_tile = True; sc.cycles.tile_size = 4096
    except Exception:
        pass
    # colour management
    vs = sc.view_settings
    try:
        vs.view_transform = 'AgX'
    except Exception:
        vs.view_transform = 'Filmic'
    look = opts.get('look', 'AgX - Medium High Contrast')
    for lk in (look, 'AgX - Base Contrast', 'Medium High Contrast', 'None'):
        try:
            vs.look = lk
            break
        except Exception:
            continue
    vs.exposure = 0.0; vs.gamma = 1.0
    sc.display_settings.display_device = 'sRGB'
    sc.sequencer_colorspace_settings.name = 'sRGB'


def compositor(opts, pano=False):
    """Subtle photographic finish: bloom on highlights + gentle vignette (not on panoramas)."""
    sc = bpy.context.scene
    sc.use_nodes = True
    nt = sc.node_tree
    nt.nodes.clear()
    rl = nt.nodes.new('CompositorNodeRLayers')
    comp = nt.nodes.new('CompositorNodeComposite')
    cur = rl.outputs['Image']
    wb = opts.get('wb')
    if wb and any(abs(x - 1) > 0.01 for x in wb):
        mul0 = nt.nodes.new('CompositorNodeMixRGB'); mul0.blend_type = 'MULTIPLY'; mul0.inputs[0].default_value = 1.0
        mul0.inputs[2].default_value = (wb[0], wb[1], wb[2], 1.0)
        nt.links.new(cur, mul0.inputs[1]); cur = mul0.outputs['Image']
    if opts.get('glare', True):
        g = nt.nodes.new('CompositorNodeGlare'); g.glare_type = 'FOG_GLOW'; g.quality = 'HIGH'
        g.threshold = opts.get('glare_threshold', 1.2); g.size = 8; g.mix = opts.get('glare_mix', -0.92)
        nt.links.new(cur, g.inputs['Image']); cur = g.outputs['Image']
    if not pano and opts.get('vignette', 0.12) > 0:
        el = nt.nodes.new('CompositorNodeEllipseMask'); el.width = 1.25; el.height = 1.25
        bl = nt.nodes.new('CompositorNodeBlur'); bl.filter_type = 'GAUSS'; bl.use_relative = True
        bl.factor_x = 0.35; bl.factor_y = 0.35; bl.size_x = 400; bl.size_y = 400
        nt.links.new(el.outputs['Mask'], bl.inputs['Image'])
        mr = nt.nodes.new('CompositorNodeMapRange')
        nt.links.new(bl.outputs['Image'], mr.inputs['Value'])
        mr.inputs['From Min'].default_value = 0.0; mr.inputs['From Max'].default_value = 1.0
        mr.inputs['To Min'].default_value = 1.0 - opts.get('vignette', 0.12); mr.inputs['To Max'].default_value = 1.0
        mul = nt.nodes.new('CompositorNodeMixRGB'); mul.blend_type = 'MULTIPLY'; mul.inputs[0].default_value = 1.0
        nt.links.new(cur, mul.inputs[1]); nt.links.new(mr.outputs[0], mul.inputs[2]); cur = mul.outputs['Image']
    nt.links.new(cur, comp.inputs['Image'])


# ------------------------------------------------------------------ auto exposure
WB = [None]


def wb_gains(strength=0.6, max_gain=1.6):
    """RGB multipliers that remove `strength` of the grey-world cast (keeps some warmth)."""
    m = WB[0]
    if not m:
        return (1.0, 1.0, 1.0)
    g = m[1]
    out = []
    for c in m:
        full = g / max(c, 1e-6)
        out.append(max(1 / max_gain, min(max_gain, full ** strength)))
    return tuple(out)


def measure_exposure(tmpdir, key, opts, log, w=None, h=None):
    """Render a tiny linear preview (same camera), return EV so that the log-average luminance maps to `key`."""
    sc = bpy.context.scene
    r = sc.render
    saved = (r.resolution_x, r.resolution_y, r.resolution_percentage, sc.cycles.samples, sc.cycles.use_denoising,
             r.image_settings.file_format, r.image_settings.color_depth, sc.use_nodes, sc.cycles.use_adaptive_sampling, r.film_transparent)
    r.film_transparent = True   # alpha = 0 where the camera sees the sky -> meter on the architecture only
    W, H = r.resolution_x, r.resolution_y
    s = 200.0 / max(W, H)
    r.resolution_x, r.resolution_y, r.resolution_percentage = max(16, int(W * s)), max(8, int(H * s)), 100
    sc.cycles.samples = opts.get('expo_samples', 24); sc.cycles.use_denoising = False; sc.use_nodes = False
    sc.cycles.use_adaptive_sampling = False
    r.image_settings.file_format = 'OPEN_EXR'; r.image_settings.color_depth = '32'
    p = os.path.join(tmpdir, 'expo.exr')
    r.filepath = p
    bpy.ops.render.render(write_still=True)
    # second pass with the sky visible (persistent data -> cheap) to measure the camera-visible sky
    r.film_transparent = False
    p2 = os.path.join(tmpdir, 'expo-sky.exr')
    r.filepath = p2
    bpy.ops.render.render(write_still=True)
    (r.resolution_x, r.resolution_y, r.resolution_percentage, sc.cycles.samples, sc.cycles.use_denoising,
     r.image_settings.file_format, r.image_settings.color_depth, sc.use_nodes, sc.cycles.use_adaptive_sampling, r.film_transparent) = saved
    img = bpy.data.images.load(p)
    px = np.empty(img.size[0] * img.size[1] * 4, dtype=np.float32); img.pixels.foreach_get(px)
    bpy.data.images.remove(img)
    px = px.reshape(-1, 4)
    img2 = bpy.data.images.load(p2)
    px2 = np.empty(img2.size[0] * img2.size[1] * 4, dtype=np.float32); img2.pixels.foreach_get(px2)
    bpy.data.images.remove(img2)
    px2 = px2.reshape(-1, 4)
    skyp = px2[px[:, 3] < 0.5]
    sky_lum = float(np.median(0.2126 * skyp[:, 0] + 0.7152 * skyp[:, 1] + 0.0722 * skyp[:, 2])) if len(skyp) > 20 else None
    geo = px[:, 3] > 0.5
    if geo.sum() > 0.05 * len(px):
        px = px[geo]
        # un-premultiply is not needed for opaque pixels
    lum = 0.2126 * px[:, 0] + 0.7152 * px[:, 1] + 0.0722 * px[:, 2]
    lum = lum[np.isfinite(lum)]
    def logavg(hp):
        lo, hi = np.percentile(lum, [2, hp])
        sel = lum[(lum >= lo) & (lum <= hi)]
        if sel.size == 0:
            return None
        floor = max(1e-6, float(np.median(sel)) * 0.02)     # under-sampled black pixels must not dominate
        return float(np.exp(np.mean(np.log(np.maximum(sel, floor)))))
    lavg97 = logavg(97)
    if lavg97 is None:
        return 0.0, sky_lum
    lavg = logavg(opts.get('meter_hi_pct', 97)) or lavg97
    # room-exposure may lift by at most +1 EV over full-frame metering
    lavg = max(lavg, lavg97 / 2.0)
    # grey-world estimate on mid-tones (for a partial, photographer-style white balance)
    mid = px[(lum > np.percentile(lum, 20)) & (lum < np.percentile(lum, 95))][:, :3]
    WB[0] = tuple(float(x) for x in mid.mean(axis=0)) if len(mid) > 20 else None
    ev = math.log2(key / max(lavg, 1e-6))
    # protect highlights: the 90th percentile (sunlit white render, sky) should stay below ~2.5 scene-linear
    p99 = float(np.percentile(lum, opts.get('hi_pct', 95.0)))
    ev_hi = math.log2(opts.get('hi_white', 2.5) / max(p99, 1e-6))
    evf = min(ev, ev_hi)
    evf = max(-12.0, min(12.0, evf))
    log(f'[expo] Lavg={lavg:.4g} p95={p99:.4g} ev={ev:.2f} ev_hi={ev_hi:.2f} -> {evf:.2f} sky={sky_lum}')
    return evf, sky_lum


def set_sky_visible(ev, sky_lum, target, log):
    """Graduated-filter: scale the camera-visible sky so it lands at `target` (scene-linear after exposure)."""
    w = bpy.context.scene.world
    nd = w.node_tree.nodes.get('vbSkyCam') if w and w.node_tree else None
    if nd is None or not sky_lum:
        return
    # sky_lum was measured with the current camera-sky strength
    cur = nd.inputs['Strength'].default_value
    base = nd.get('base', cur)
    g = target / max(sky_lum * (2 ** ev), 1e-6)
    newv = max(base * 0.05, min(base * 1.0, cur * g))
    nd.inputs['Strength'].default_value = newv
    log(f'[sky] visible sky x{newv / base:.2f} (measured {sky_lum:.3g}, ev {ev:.2f})')
