"""VILNYI Barreiro 2 — Cycles render job (run inside Blender 4.2):

  blender -b -noaudio --python render/blender/render_job.py -- --job <json>

<json> (string or path) keys:
  scope    'exterior' | 'common' | 'unit'
  unit     '1.C'           (unit scope)          pkg   'lisboa'  (unit scope; package used for exterior windows otherwise)
  shots    list of shot ids ('panos' / 'stills' / 'all' allowed)   quality  'preview' | 'standard' | 'high'
  out      output dir (repo-relative), e.g. renders/units/1.C/lisboa
  name     job name (log file render/logs/<name>.txt)
  tod      optional time-of-day override for unit scope ('day' default)
Writes <out>/<shot>.jpg, <out>/thumbs/<shot>.jpg and <out>/shots-<name>.json (metadata for the manifest).
"""
import json, math, os, sys, time, traceback

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
SCENES = os.path.join(ROOT, 'render', 'scenes')

import bpy
from mathutils import Vector

import vb_library as L
import vb_materials as M
import vb_scene as S
import vb_lighting as LI

T0 = time.time()
LOG = []


LOGFILE = [None]


def log(*a):
    s = f'[{time.time() - T0:7.1f}s] ' + ' '.join(str(x) for x in a)
    print(s, flush=True)
    LOG.append(s)
    if LOGFILE[0]:
        try:
            with open(LOGFILE[0], 'a') as f:
                f.write(s + '\n')
        except Exception:
            pass


QUALITY = {
    #            still res      still spp  thr     pano res      pano spp  thr
    'preview':  dict(still=(960, 540), still_spp=64, still_thr=0.05, pano=(2048, 1024), pano_spp=32, pano_thr=0.06, expo_samples=16),
    'standard': dict(still=(2400, 1350), still_spp=320, still_thr=0.015, pano=(4096, 2048), pano_spp=160, pano_thr=0.03, expo_samples=24),
    'high':     dict(still=(2400, 1350), still_spp=512, still_thr=0.01, pano=(4096, 2048), pano_spp=320, pano_thr=0.02, expo_samples=32),
}
# camera tweaks after looking at the previews (three.js coords deltas)
CAM_OVERRIDES = {
    'street-golden-34': {'dpos': [-1.0, 0.0, -2.6]},   # step off the far pavement (a parked car filled the foreground)
}
EXT_SPP = {'preview': 64, 'standard': 192, 'high': 256}


def load_cameras():
    with open(os.path.join(SCENES, 'cameras.json')) as f:
        return json.load(f)


def shots_for(job, cams):
    """List of shot dicts: id, type ('still'|'pano'), position, lookAt, lens, aspect, tod, scenes, roomId, name."""
    scope = job['scope']
    out = []
    if scope == 'exterior':
        for c in cams.get('exterior', []):
            out.append(dict(c, type='still', tod=c.get('time_of_day', 'golden')))
    elif scope == 'common':
        for c in cams.get('common', []):
            out.append(dict(c, type='still', tod=c.get('time_of_day', 'day')))
    else:
        u = cams['unitsData'][job['unit']]
        pk = u['packages'][job['pkg']]
        tod = job.get('tod', 'day')
        for i, h in enumerate(pk.get('hotspots', [])):
            out.append(dict(h, type='pano', index=i, tod=tod, scenes=['building', 'context', f"unit-{job['unit']}-{job['pkg']}"]))
        for c in u.get('hero', []):
            out.append(dict(c, type='still', tod=tod, scenes=['building', 'context', f"unit-{job['unit']}-{job['pkg']}"]))
    want = job.get('shots', 'all')
    if isinstance(want, str):
        want = [want]
    sel = []
    for s in out:
        if 'all' in want or s['id'] in want or (s['type'] == 'pano' and 'panos' in want) or (s['type'] == 'still' and 'stills' in want) \
                or any(w.endswith('*') and s['id'].startswith(w[:-1]) for w in want):
            sel.append(s)
    return sel


# ------------------------------------------------------------------ cameras
def place_camera(shot, q, quality):
    sc = bpy.context.scene
    cam_d = bpy.data.cameras.get('vbCam') or bpy.data.cameras.new('vbCam')
    cam = bpy.data.objects.get('vbCam') or bpy.data.objects.new('vbCam', cam_d)
    if cam.name not in sc.collection.objects:
        sc.collection.objects.link(cam)
    sc.camera = cam
    p = S.t2b(shot['position']); t = S.t2b(shot['lookAt'])
    d = (t - p)
    cam.location = p
    cam_d.clip_start = 0.05; cam_d.clip_end = 5000
    cam_d.shift_x = cam_d.shift_y = 0.0
    if shot['type'] == 'pano':
        cam_d.type = 'PANO'
        for tgt in (cam_d, getattr(cam_d, 'cycles', None)):
            try:
                tgt.panorama_type = 'EQUIRECTANGULAR'
            except Exception:
                pass
        # Cycles: the panorama centre column looks along the camera's view direction -> centre = main view, seam behind
        dh = Vector((d.x, d.y, 0)).normalized() if Vector((d.x, d.y)).length > 1e-6 else Vector((0, 1, 0))
        cam.rotation_euler = dh.to_track_quat('-Z', 'Y').to_euler()
        W, H = q['pano']
        yaw = math.atan2(-dh.x, dh.y)      # three.js yaw (rotation.y) of the centre column
        return dict(W=W, H=H, yawOffset=yaw, lens=None, shift=0.0)
    cam_d.type = 'PERSP'
    cam_d.sensor_fit = 'HORIZONTAL'; cam_d.sensor_width = 36.0
    lens = float(shot.get('lens_mm') or (24 if shot.get('roomId') else 35))
    lens = max(16.0, min(85.0, lens))
    W, H = q['still']
    if shot.get('aspect') == '9:16':
        W, H = H, W
        cam_d.sensor_fit = 'VERTICAL'; cam_d.sensor_height = 36.0
    cam_d.lens = lens
    horiz = Vector((d.x, d.y, 0))
    pitch = math.atan2(d.z, max(horiz.length, 1e-6))
    shift = 0.0
    if abs(math.degrees(pitch)) < 30 and horiz.length > 1e-6:
        # 2-point perspective: level camera, recover the framing with a vertical lens shift
        cam.rotation_euler = horiz.normalized().to_track_quat('-Z', 'Y').to_euler()
        # shift unit = the larger sensor dimension, which is 36 mm for both fits used here
        shift = lens * math.tan(pitch) / 36.0
        shift = max(-0.45, min(0.45, shift))
        cam_d.shift_y = shift
    else:
        cam.rotation_euler = d.normalized().to_track_quat('-Z', 'Y').to_euler()
    return dict(W=W, H=H, lens=lens, shift=shift, yawOffset=None)


# ------------------------------------------------------------------ main
def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    js = argv[argv.index('--job') + 1]
    job = json.load(open(js)) if os.path.exists(js) else json.loads(js)
    quality = job.get('quality', 'preview')
    q = dict(QUALITY[quality])
    q.update(job.get('q', {}) or {})
    name = job.get('name', 'job')
    os.makedirs(os.path.join(ROOT, 'render', 'logs'), exist_ok=True)
    LOGFILE[0] = os.path.join(ROOT, 'render', 'logs', f'{name}.txt')
    open(LOGFILE[0], 'w').close()
    out_dir = os.path.join(ROOT, job['out'])
    os.makedirs(os.path.join(out_dir, 'thumbs'), exist_ok=True)
    tmp = os.path.join(os.environ.get('RUNNER_TEMP', '/tmp'), 'vb-' + name)
    os.makedirs(tmp, exist_ok=True)
    cams = load_cameras()
    shots = shots_for(job, cams)
    log(f'job {name}: scope={job["scope"]} unit={job.get("unit")} pkg={job.get("pkg")} quality={quality} shots={len(shots)}')
    if not shots:
        log('nothing to render'); return finish(job, [], name, out_dir)

    # group shots by (scene set, tod) so each group loads once
    groups = {}
    for s in shots:
        scn = list(s.get('scenes', ['building', 'context']))
        if job['scope'] == 'exterior' and (job.get('opts') or {}).get('with_units', True):
            scn = [x for x in scn if not x.startswith('unit-')] + [f'unit-{u}-*' for u in cams['unitsData'].keys()]
        # per-shot camera overrides (three.js metres)
        ov = CAM_OVERRIDES.get(s['id'])
        if ov:
            for k, v in ov.items():
                if k in ('dpos', 'dlook'):
                    key = 'position' if k == 'dpos' else 'lookAt'
                    s[key] = [a + b for a, b in zip(s[key], v)]
                else:
                    s[k] = v
        scn = tuple(sorted(scn))
        groups.setdefault((scn, s['tod']), []).append(s)
    results = []
    for (scn, tod), group in groups.items():
        try:
            results += render_group(job, q, quality, scn, tod, group, tmp, out_dir)
        except Exception as e:
            log('GROUP FAILED', scn, tod, repr(e)); log(traceback.format_exc())
    finish(job, results, name, out_dir)


def resolve_scene_files(scn, job):
    files = []
    for s in scn:
        if s.endswith('*'):
            pkg = job.get('pkg') or (job.get('opts') or {}).get('ext_pkg', 'atlantic')
            s = s[:-1] + pkg
        f = os.path.join(SCENES, s + ('' if s.endswith('.glb') else '.glb'))
        if os.path.exists(f):
            files.append((s, f))
        else:
            log('missing scene', f)
    return files


def render_group(job, q, quality, scn, tod, shots, tmp, out_dir):
    t_load = time.time()
    S.reset()
    opts = dict(job.get('opts', {}) or {})
    is_unit = job['scope'] == 'unit'
    pkg_default = job.get('pkg') or opts.get('ext_pkg', 'atlantic')
    objs_by = {}
    for tag, f in resolve_scene_files(scn, job):
        t1 = time.time()
        objs_by[tag] = S.import_glb(f, tag)
        log(f'import {tag}: {len(objs_by[tag])} objects in {time.time() - t1:.1f}s')
    all_objs = [o for v in objs_by.values() for o in v]
    # unit renders: drop far context (outside 120 m) to keep BVH small; keep everything for exteriors
    n_uv = S.prepare_meshes(all_objs)
    log(f'box UVs on {n_uv} meshes')

    def pkg_for(ob):
        src = ob.get('vb_src', '')
        if src.startswith('unit-'):
            return src.rsplit('-', 1)[-1]
        return pkg_default
    mopts = dict(tex_res=opts.get('tex_res', '2k'), bevel=opts.get('bevel', False), emit_scale=opts.get('emit_scale', 1.0))
    st = M.apply_all(pkg_for, mopts)
    log(f'materials: built={st["materials"]} textured={st["textured"]} by_key={dict(sorted(st["by_key"].items()))}')
    if st['unknown_keys']:
        log(f'materials: unknown keys kept as glTF: {st["unknown_keys"]}')
    if st['missing_tex']:
        log(f'materials: MISSING textures: {sorted(st["missing_tex"])}')

    lopts = dict(lamp_boost=opts.get('lamp_boost', 4.0 if is_unit else (6.0 if tod == 'dusk' else 3.0)))
    keep_imported = True
    n_imp = S.rescale_imported_lights(lopts, keep=keep_imported)
    region = None
    inside = None
    if is_unit:
        unit_objs = [o for k, v in objs_by.items() if k.startswith('unit-') for o in v]
        mn, mx = S.scene_bounds(unit_objs)
        region = (mn - Vector((0.3, 0.3, 0.2)), mx + Vector((0.3, 0.3, 0.3)))
        inside = (mn + mx) / 2
    # real lights from emissive meshes: interiors always; exteriors only at dusk and only for our building
    if is_unit:
        n_em = S.emissive_to_lights(lopts, region=region, sources=None)
    elif tod == 'dusk':
        n_em = S.emissive_to_lights(lopts, region=None, sources={'building'} | {k for k in objs_by if k.startswith('unit-')})
    else:
        n_em = 0
    n_portal = S.window_portals(region, inside) if is_unit and opts.get('portals', True) else 0
    ntri = sum(len(o.data.polygons) for o in bpy.data.objects if o.type == 'MESH')
    nl = sum(1 for o in bpy.data.objects if o.type == 'LIGHT')
    log(f'lights: imported={n_imp} emissive->lights={n_em} portals={n_portal} boost={lopts["lamp_boost"]} total_lights={nl} polys={ntri}')

    winfo = LI.setup_world(tod, dict(hdri_res=opts.get('hdri_res', '4k'), sky_override=opts.get('sky', {}).get(tod) if opts.get('sky') else None,
                                     sky_visible_gain=opts.get('sky_visible_gain', 1.0), sky_gain=opts.get('sky_gain', 1.4), tmpdir=tmp), log)
    LI.setup_render(dict(samples=q['still_spp'], adaptive_threshold=q['still_thr'], clamp_indirect=10.0,
                         look=opts.get('look', 'AgX - Medium High Contrast' if not is_unit else 'AgX - Base Contrast')))
    log(f'scene ready in {time.time() - t_load:.1f}s  (world {winfo.get("hdri")})')

    res = []
    if opts.get('profile'):
        profile(shots[0], q, quality, tmp, opts)
    for s in shots:
        t1 = time.time()
        try:
            r = render_shot(job, q, quality, s, tmp, out_dir, opts, is_unit, tod)
            r['seconds'] = round(time.time() - t1, 1)
            log(f'SHOT {s["id"]} {s["type"]} {r["W"]}x{r["H"]} spp<={r["spp"]} ev={r["ev"]:.2f} in {r["seconds"]}s -> {r["file"]}')
            res.append(r)
        except Exception as e:
            log('SHOT FAILED', s['id'], repr(e)); log(traceback.format_exc())
    return res


def profile(s, q, quality, tmp, opts):
    """Time small renders of the first shot with different Cycles settings (speed tuning)."""
    sc = bpy.context.scene
    cy = sc.cycles
    place_camera(s, q, quality)
    r = sc.render
    r.resolution_x, r.resolution_y, r.resolution_percentage = 512, 256 if s['type'] == 'pano' else 288, 100
    r.image_settings.file_format = 'JPEG'
    base = dict(samples=32, use_adaptive_sampling=False, max_bounces=12, diffuse_bounces=4, glossy_bounces=4, transmission_bounces=12,
                transparent_max_bounces=24, use_guiding=False, use_fast_gi=False)
    portals = [o for o in bpy.data.objects if o.type == 'LIGHT' and o.data.type == 'AREA' and getattr(o.data.cycles, 'is_portal', False)]
    tests = [('base', {}), ('bounces_lo', dict(max_bounces=6, diffuse_bounces=2, glossy_bounces=2, transmission_bounces=6, transparent_max_bounces=8)),
             ('guiding', dict(use_guiding=True)), ('fast_gi', dict(use_fast_gi=True)), ('no_portals', '__portals__'), ('no_denoise', '__nodenoise__')]
    for name, ch in tests:
        for k, v in base.items():
            try:
                setattr(cy, k, v)
            except Exception:
                pass
        cy.use_denoising = True
        for o in portals:
            o.hide_render = False
        if ch == '__portals__':
            for o in portals:
                o.hide_render = True
        elif ch == '__nodenoise__':
            cy.use_denoising = False
        else:
            for k, v in ch.items():
                try:
                    setattr(cy, k, v)
                except Exception as e:
                    log('profile setattr fail', k, e)
        r.filepath = os.path.join(tmp, f'prof-{name}.jpg')
        t = time.time()
        bpy.ops.render.render(write_still=True)
        log(f'PROFILE {name}: {time.time() - t:.1f}s  (512px, 32 spp)')
    for o in portals:
        o.hide_render = False
    LI.setup_render(dict(samples=q['still_spp'], adaptive_threshold=q['still_thr']))


def render_shot(job, q, quality, s, tmp, out_dir, opts, is_unit, tod):
    sc = bpy.context.scene
    cinfo = place_camera(s, q, quality)
    pano = s['type'] == 'pano'
    W, H = cinfo['W'], cinfo['H']
    r = sc.render
    r.resolution_x, r.resolution_y, r.resolution_percentage = W, H, 100
    if pano:
        spp, thr = q['pano_spp'], q['pano_thr']
    else:
        spp, thr = (q['still_spp'], q['still_thr']) if is_unit or job['scope'] == 'common' else (EXT_SPP.get(quality, 192), q['still_thr'])
    sc.cycles.samples = int(opts.get('spp', spp)); sc.cycles.adaptive_threshold = thr
    sc.cycles.adaptive_min_samples = max(16, min(64, sc.cycles.samples // 6))
    # exposure
    key = opts.get('key', 0.20 if (is_unit or job['scope'] == 'common') else 0.18)
    if tod == 'dusk':
        key = opts.get('key_dusk', 0.13)
    sc.view_settings.exposure = 0.0
    w = sc.world.node_tree.nodes.get('vbSkyCam') if sc.world else None
    if w is not None:
        w.inputs['Strength'].default_value = w.get('base', w.inputs['Strength'].default_value)
    ev, sky_lum = LI.measure_exposure(tmp, key, dict(expo_samples=q.get('expo_samples', 16), hi_white=opts.get('hi_white', 2.5)), log)
    if not is_unit and job['scope'] != 'common':
        LI.set_sky_visible(ev, sky_lum, opts.get('sky_target', 0.55 if tod != 'dusk' else 0.45), log)
    ev += float(opts.get('ev_bias', 0.0)) + float((opts.get('ev_shot') or {}).get(s['id'], 0.0))
    sc.view_settings.exposure = ev
    LI.compositor(dict(vignette=0.0 if pano else opts.get('vignette', 0.10), glare=True, glare_mix=opts.get('glare_mix', -0.93)), pano=pano)
    r.image_settings.file_format = 'JPEG'
    r.image_settings.quality = 82 if pano else 85
    r.image_settings.color_mode = 'RGB'
    fn = f"{s['id']}.jpg"
    path = os.path.join(out_dir, fn)
    r.filepath = path
    bpy.ops.render.render(write_still=True)
    # thumbnail 512 px wide
    try:
        im = bpy.data.images.load(path)
        tw = 512; th = max(1, round(im.size[1] * tw / im.size[0]))
        im.scale(tw, th)
        im.filepath_raw = os.path.join(out_dir, 'thumbs', fn); im.file_format = 'JPEG'
        im.save()
        bpy.data.images.remove(im)
    except Exception as e:
        log('thumb failed', e)
    rel = os.path.relpath(path, ROOT)
    meta = dict(id=s['id'], type=s['type'], file=rel, thumb=os.path.relpath(os.path.join(out_dir, 'thumbs', fn), ROOT),
                W=W, H=H, spp=sc.cycles.samples, ev=ev, tod=tod, position=s['position'], lookAt=s['lookAt'],
                roomId=s.get('roomId'), name=s.get('name') or s.get('roomName'), kind=s.get('kind'))
    if pano:
        meta['yawOffset'] = round(cinfo['yawOffset'], 5)
        meta['index'] = s.get('index')
    else:
        meta['lens'] = cinfo['lens']; meta['shift_y'] = round(cinfo['shift'], 4)
    return meta


def finish(job, results, name, out_dir):
    with open(os.path.join(out_dir, f'shots-{name}.json'), 'w') as f:
        json.dump(dict(job=job, shots=results, seconds=round(time.time() - T0, 1), blender=bpy.app.version_string), f, indent=1, ensure_ascii=False)
    logdir = os.path.join(ROOT, 'render', 'logs')
    os.makedirs(logdir, exist_ok=True)
    log(f'DONE {len(results)} images in {time.time() - T0:.1f}s')



if __name__ == '__main__':
    try:
        main()
    except Exception:
        LOG.append(traceback.format_exc())
        print(traceback.format_exc())
        try:
            os.makedirs(os.path.join(ROOT, 'render', 'logs'), exist_ok=True)
            with open(os.path.join(ROOT, 'render', 'logs', 'crash.txt'), 'w') as f:
                f.write('\n'.join(LOG[-400:]))
        except Exception:
            pass
        sys.exit(1)
