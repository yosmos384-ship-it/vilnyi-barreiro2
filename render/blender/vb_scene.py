"""Scene assembly: GLB import (three Y-up -> Blender Z-up handled by the importer), world-space box UVs in metres,
emissive meshes -> real lights, window portals, cleanup."""
import math, os
import bpy
import bmesh
import numpy as np
from mathutils import Vector, Matrix

import vb_library as L
import vb_materials as M

LUMEN_W = 1.0 / 683.0   # photometric watt: Blender W = lm / 683 (sun strength in W/m2 = lux / 683)


def t2b(v):
    """three.js (x, y, z) Y-up -> Blender (x, -z, y) Z-up (same as the glTF importer)."""
    return Vector((v[0], -v[2], v[1]))


def b2t(v):
    return (v[0], v[2], -v[1])


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_glb(path, tag):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path, merge_vertices=False, import_shading='NORMALS', bone_heuristic='TEMPERANCE',
                              guess_original_bind_pose=False)
    new = [o for o in bpy.data.objects if o not in before]
    col = bpy.data.collections.new(tag)
    bpy.context.scene.collection.children.link(col)
    for o in new:
        for c in list(o.users_collection):
            c.objects.unlink(o)
        col.objects.link(o)
        o['vb_src'] = tag
    return new


def box_uv(ob):
    """World-space box projection in metres into UV layer 'vbUV' (right-handed per face so normal maps are correct)."""
    me = ob.data
    if not me.polygons:
        return
    nv = len(me.vertices)
    co = np.empty(nv * 3, dtype=np.float64); me.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
    mw = np.array(ob.matrix_world, dtype=np.float64)
    co = co @ mw[:3, :3].T + mw[:3, 3]
    npoly = len(me.polygons)
    nrm = np.empty(npoly * 3, dtype=np.float64); me.polygons.foreach_get('normal', nrm); nrm = nrm.reshape(-1, 3)
    nm = np.linalg.inv(mw[:3, :3]).T
    nrm = nrm @ nm.T
    ls = np.empty(npoly, dtype=np.int64); me.polygons.foreach_get('loop_start', ls)
    lt = np.empty(npoly, dtype=np.int64); me.polygons.foreach_get('loop_total', lt)
    nl = len(me.loops)
    lv = np.empty(nl, dtype=np.int64); me.loops.foreach_get('vertex_index', lv)
    pidx = np.repeat(np.arange(npoly), lt)
    n = nrm[pidx]
    p = co[lv]
    ax = np.argmax(np.abs(n), axis=1)
    sx, sy, sz = np.sign(n[:, 0]), np.sign(n[:, 1]), np.sign(n[:, 2])
    sx[sx == 0] = 1; sy[sy == 0] = 1; sz[sz == 0] = 1
    u = np.where(ax == 0, p[:, 1] * sx, np.where(ax == 1, -p[:, 0] * sy, p[:, 0]))
    v = np.where(ax == 2, p[:, 1] * sz, p[:, 2])
    uv = np.stack([u, v], axis=1).astype(np.float32).ravel()
    lay = me.uv_layers.get(M.UV) or me.uv_layers.new(name=M.UV)
    lay.data.foreach_set('uv', uv)


def prepare_meshes(objs):
    n = 0
    for ob in objs:
        if ob.type != 'MESH':
            continue
        try:
            box_uv(ob)
            n += 1
        except Exception as e:
            print('[scene] uv failed', ob.name, e)
        # flat shading artefacts: keep imported normals (glTF) ; nothing else
    return n


# ------------------------------------------------------------------ emissive meshes -> lights
def _islands(ob, mat_indices):
    """Connected face islands using given material indices -> list of (centroid, normal, bbox dims, area) in world space."""
    me = ob.data
    bm = bmesh.new(); bm.from_mesh(me)
    bm.faces.ensure_lookup_table()
    faces = [f for f in bm.faces if f.material_index in mat_indices]
    seen = set(); out = []
    mw = ob.matrix_world; nmw = mw.to_3x3().inverted().transposed()
    for f0 in faces:
        if f0.index in seen:
            continue
        stack = [f0]; isl = []
        seen.add(f0.index)
        while stack:
            f = stack.pop(); isl.append(f)
            for e in f.edges:
                for g in e.link_faces:
                    if g.index not in seen and g.material_index in mat_indices:
                        seen.add(g.index); stack.append(g)
        pts = [mw @ v.co for f in isl for v in f.verts]
        area = sum(f.calc_area() for f in isl)
        nsum = Vector((0, 0, 0))
        for f in isl:
            nsum += (nmw @ f.normal) * f.calc_area()
        c = sum(pts, Vector((0, 0, 0))) / len(pts)
        mn = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
        mx = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
        out.append((c, nsum.normalized() if nsum.length > 1e-9 else Vector((0, 0, -1)), mx - mn, area))
        if len(out) > 400:
            break
    bm.free()
    return out


def make_light(name, kind, loc, energy, color, size=0.05, direction=None, spot=110.0, area_size=(0.1, 0.1)):
    ld = bpy.data.lights.new(name, type=kind)
    ld.energy = energy
    ld.color = color[:3]
    if kind in ('POINT', 'SPOT'):
        ld.shadow_soft_size = size
    if kind == 'SPOT':
        ld.spot_size = math.radians(spot); ld.spot_blend = 0.6
    if kind == 'AREA':
        ld.shape = 'RECTANGLE'; ld.size, ld.size_y = area_size
    try:
        ld.cycles.max_bounces = 8
    except Exception:
        pass
    ob = bpy.data.objects.new(name, ld)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = loc
    if direction is not None:
        ob.rotation_euler = Vector(direction).to_track_quat('-Z', 'Y').to_euler()
    return ob


def emissive_to_lights(opts, region=None):
    """For every material with light='spot|point|strip' create real lights at each emissive island.
    region: optional (min Vector, max Vector) in Blender coords to limit lights (e.g. the unit's floor)."""
    boost = opts.get('lamp_boost', 3.0)
    existing = [o for o in bpy.data.objects if o.type == 'LIGHT']
    made = 0
    for ob in [o for o in bpy.data.objects if o.type == 'MESH']:
        idx = {}
        for i, s in enumerate(ob.material_slots):
            m = s.material
            if m is None or m.get('vb_shader') != 'emit':
                continue
            r = L.recipe(m.get('vb_key', ''), None) or {}
            if r.get('light'):
                idx[i] = r
        if not idx:
            continue
        for mi, r in idx.items():
            for c, n, dims, area in _islands(ob, {mi}):
                if region and not (region[0].x <= c.x <= region[1].x and region[0].y <= c.y <= region[1].y and region[0].z <= c.z <= region[1].z):
                    continue
                if any((l.location - c).length < 0.35 for l in existing):
                    continue
                kel = (r.get('emit') or (10, 2700))[1]
                col = M.kelvin_rgb(kel)
                kind = r['light']
                if kind == 'spot':
                    # P = I * 4pi / 683 with I = lm / solid angle of the cone (Blender spot power is defined like a point light)
                    cone = math.radians(110.0)
                    omega = 2 * math.pi * (1 - math.cos(cone / 2))
                    P = r.get('lumens', 600) / omega * 4 * math.pi * LUMEN_W * boost
                    d = n if n.z < -0.5 else Vector((0, 0, -1))
                    make_light('vbL-spot', 'SPOT', c + d * 0.02, P, col, size=max(0.02, min(0.06, max(dims) / 2)), direction=d)
                elif kind == 'point':
                    P = r.get('lumens', 450) * LUMEN_W * boost
                    make_light('vbL-bulb', 'POINT', c, P, col, size=max(0.015, min(0.05, max(dims) / 2)))
                elif kind == 'strip':
                    length = max(dims.x, dims.y, dims.z, 0.05)
                    P = r.get('lumens_per_m', 900) * length * LUMEN_W * boost * 2.0  # area light emits one hemisphere
                    d = n if n.length > 0.5 else Vector((0, 0, -1))
                    ws = sorted([dims.x, dims.y, dims.z], reverse=True)
                    make_light('vbL-strip', 'AREA', c + d * 0.01, P, col, direction=d, area_size=(max(ws[0], 0.02), max(ws[1], 0.01)))
                made += 1
    return made


def rescale_imported_lights(opts, keep=True):
    """glTF punctual lights (three r160 candela) are imported with W = cd*4pi/683 (importer 'Standard' mode) = our scale."""
    boost = opts.get('lamp_boost', 3.0)
    n = 0
    for o in [o for o in bpy.data.objects if o.type == 'LIGHT' and not o.name.startswith('vbL')]:
        if not keep or o.data.energy <= 1e-6:
            bpy.data.objects.remove(o, do_unlink=True)
            continue
        o.data.energy *= boost
        o.data.shadow_soft_size = max(o.data.shadow_soft_size, 0.04)
        n += 1
    return n


def window_portals(region, inside):
    """Cycles light portals at each glass-window island inside `region` facing `inside` (Blender coords)."""
    made = 0
    for ob in [o for o in bpy.data.objects if o.type == 'MESH']:
        idx = {i for i, s in enumerate(ob.material_slots) if s.material and s.material.get('vb_key') in ('glass-window',)}
        if not idx:
            continue
        for c, n, dims, area in _islands(ob, idx):
            if not (region[0].x - 0.5 <= c.x <= region[1].x + 0.5 and region[0].y - 0.5 <= c.y <= region[1].y + 0.5 and region[0].z <= c.z <= region[1].z):
                continue
            if area < 0.3 or abs(n.z) > 0.5:
                continue
            d = Vector((n.x, n.y, 0)).normalized()
            if (inside - c).dot(d) < 0:
                d = -d
            horiz = max(abs(dims.x), abs(dims.y))
            ob_l = make_light('vbPortal', 'AREA', c + d * 0.02, 1.0, (1, 1, 1), direction=d, area_size=(max(horiz, 0.3), max(dims.z, 0.3)))
            ob_l.data.cycles.is_portal = True
            made += 1
    return made


def scene_bounds(objs):
    mn = Vector((1e9, 1e9, 1e9)); mx = Vector((-1e9, -1e9, -1e9))
    for o in objs:
        if o.type != 'MESH':
            continue
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            mn = Vector((min(mn.x, w.x), min(mn.y, w.y), min(mn.z, w.z)))
            mx = Vector((max(mx.x, w.x), max(mx.y, w.y), max(mx.z, w.z)))
    return mn, mx
