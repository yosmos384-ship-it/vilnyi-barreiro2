"""Ray-cast helpers: per-pixel interior/exterior/sky classification for exposure metering, and automatic framing of the
apartment hero stills (clear foreground, long view, window in frame)."""
import json, math, os
import bpy
import numpy as np
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
FOOT = [(0, 0), (12.2, 0), (13.88, 4.9), (13.88, 14.7), (0, 14.7)]      # three.js (x, z)
SEE_THROUGH_KEYS = {'glass-window', 'glass-railing', 'shower-glass', 'window-sheer', 'glass-drinking'}


def inside(poly, x, z):
    c = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, zi = poly[i]; xj, zj = poly[j]
        if (zi > z) != (zj > z) and x < (xj - xi) * (z - zi) / ((zj - zi) or 1e-12) + xi:
            c = not c
        j = i
    return c


def in_building(p, cam_z):
    """p = Blender location. Inside the building footprint on the camera's storey?"""
    if cam_z < -1.0:
        return abs(p.z - cam_z) < 3.2
    return inside(FOOT, p.x, -p.y) and abs(p.z - cam_z) < 3.0


_bvh = {'key': None, 'tree': None, 'through': None}


def build_bvh():
    """Own BVH over all render-visible meshes (scene.ray_cast is O(instances) per ray: unusable with millions of leaves)."""
    from mathutils.bvhtree import BVHTree
    objs = [o for o in bpy.data.objects if o.type == 'MESH' and not o.hide_render and not o.name.startswith('vb')]
    key = tuple(sorted(o.name for o in objs))
    if _bvh['key'] == key:
        return
    verts = []; polys = []; through = []
    base = 0
    for ob in objs:
        me = ob.data
        nv = len(me.vertices)
        if nv == 0 or len(me.polygons) == 0:
            continue
        co = np.empty(nv * 3, dtype=np.float64); me.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
        mw = np.array(ob.matrix_world, dtype=np.float64)
        co = co @ mw[:3, :3].T + mw[:3, 3]
        verts.extend(map(tuple, co))
        st = [bool(s.material is not None and s.material.get('vb_key') in SEE_THROUGH_KEYS) for s in ob.material_slots] or [False]
        for p in me.polygons:
            polys.append([base + v for v in p.vertices])
            through.append(st[p.material_index] if p.material_index < len(st) else False)
        base += nv
    _bvh.update(key=key, tree=BVHTree.FromPolygons(verts, polys, all_triangles=False), through=through)


def cast(dg, origin, direction, far=200.0):
    """First opaque hit along a ray (passes glass / sheers). Returns (distance, location, through_glass) or (None, None, flag)."""
    if _bvh['tree'] is None:
        build_bvh()
    tree, thr = _bvh['tree'], _bvh['through']
    o = Vector(origin); d = Vector(direction).normalized()
    total = 0.0; through = False
    for _ in range(8):
        loc, nrm, idx, dist = tree.ray_cast(o, d, far - total)
        if loc is None:
            return None, None, through
        total += dist
        if thr[idx]:
            through = True
            o = loc + d * 0.004; total += 0.004
            continue
        return total, loc, through
    return total, o, through


def camera_rays(cam, W, H, pano):
    """Unit ray directions (world) for a W x H grid; row 0 = bottom (Blender image order)."""
    mw = cam.matrix_world
    rot = np.array(mw.to_3x3())
    u = (np.arange(W) + 0.5) / W
    v = (np.arange(H) + 0.5) / H
    uu, vv = np.meshgrid(u, v)
    if pano:
        lon = (uu - 0.5) * 2 * math.pi; lat = (vv - 0.5) * math.pi
        dc = np.stack([np.sin(lon) * np.cos(lat), np.sin(lat), -np.cos(lon) * np.cos(lat)], axis=-1)
    else:
        cd = cam.data
        f = cd.lens
        if cd.sensor_fit == 'VERTICAL':
            sh = cd.sensor_height; sw = sh * W / H
        else:
            sw = cd.sensor_width; sh = sw * H / W
        big = max(sw, sh)
        x = (uu - 0.5) * sw / f + cd.shift_x * big / f
        y = (vv - 0.5) * sh / f + cd.shift_y * big / f
        dc = np.stack([x, y, -np.ones_like(x)], axis=-1)
        dc /= np.linalg.norm(dc, axis=-1, keepdims=True)
    return dc @ rot.T


def classify(cam, W, H, pano):
    """Per pixel: 0 = sky, 1 = exterior geometry, 2 = interior (inside our building on the camera's storey)."""
    dg = None
    build_bvh()
    rays = camera_rays(cam, W, H, pano)
    o = cam.matrix_world.translation
    cls = np.zeros((H, W), dtype=np.uint8)
    for j in range(H):
        for i in range(W):
            dist, loc, _ = cast(dg, o, rays[j, i])
            if dist is None:
                continue
            cls[j, i] = 2 if in_building(loc, o.z) else 1
    return cls


# ------------------------------------------------------------------ hero framing
_rooms = None


def rooms():
    global _rooms
    if _rooms is None:
        with open(os.path.join(HERE, 'rooms.json')) as f:
            _rooms = json.load(f)
    return _rooms


def room_info(room_id):
    for fl in rooms()['floors']:
        for r in fl['rooms']:
            if r['id'] == room_id:
                return fl, r
    return None, None


def door_points(fl, room, inset):
    pts = []
    poly = room['poly']
    for w in fl['walls']:
        (ax, az), (bx, bz) = w['a'], w['b']
        L = math.hypot(bx - ax, bz - az) or 1
        ux, uz = (bx - ax) / L, (bz - az) / L
        for op in w.get('openings', []):
            if op['type'] not in ('door', 'entry', 'opening'):
                continue
            s = (op['from'] + op['to']) / 2
            mx, mz = ax + ux * s, az + uz * s
            for sgn in (1, -1):
                px, pz = mx - uz * inset * sgn, mz + ux * inset * sgn
                if inside(poly, px, pz):
                    pts.append((px, pz))
    return pts


def glazing_points(fl, room):
    pts = []
    poly = room['poly']
    for w in fl['walls']:
        (ax, az), (bx, bz) = w['a'], w['b']
        L = math.hypot(bx - ax, bz - az) or 1
        ux, uz = (bx - ax) / L, (bz - az) / L
        for op in w.get('openings', []):
            if op['type'] not in ('window', 'glassdoor'):
                continue
            s = (op['from'] + op['to']) / 2
            mx, mz = ax + ux * s, az + uz * s
            if any(inside(poly, mx - uz * 0.4 * sg, mz + ux * 0.4 * sg) for sg in (1, -1)):
                pts.append((mx, mz))
    return pts


def hide_door_leaves(room, margin=0.7):
    """Hide door leaves standing in/next to this room (they block doorway views). Returns hidden objects."""
    poly = room['poly']
    xs = [p[0] for p in poly]; zs = [p[1] for p in poly]
    hidden = []
    for ob in bpy.data.objects:
        if ob.type != 'MESH' or not ob.name.startswith('door-leaf-') or 'entry' in ob.name or 'main' in ob.name:
            continue
        c = sum((ob.matrix_world @ Vector(b) for b in ob.bound_box), Vector()) / 8
        x, z = c.x, -c.y
        if min(xs) - margin <= x <= max(xs) + margin and min(zs) - margin <= z <= max(zs) + margin:
            ob.hide_render = True; ob.hide_viewport = True
            try:
                ob.hide_set(True)
            except Exception:
                pass
            hidden.append(ob)
    return hidden


def unhide(objs):
    for ob in objs:
        ob.hide_render = False; ob.hide_viewport = False
        try:
            ob.hide_set(False)
        except Exception:
            pass


def frame_hero(shot, log):
    """Choose position / lookAt / lens for a hero still by ray-casting the furnished room. Returns dict or None."""
    kind = shot.get('kind')
    cfg = {'living': dict(eye=1.30, lens=20, near=0.95, insets=(0.55, 0.9), centre=2.4, door_bonus=0.0, win=2.0),
           'bedroom': dict(eye=1.25, lens=19, near=0.85, insets=(0.5, 0.8), centre=1.8, door_bonus=1.0, win=2.0),
           'bathroom': dict(eye=1.40, lens=16, near=0.5, insets=(0.33, 0.48), centre=1.0, door_bonus=0.8, win=0.0)}.get(kind)
    if cfg is None:
        return None
    fl, room = room_info(shot.get('roomId'))
    if room is None:
        return None
    poly = room['poly']
    y = fl['y'] + cfg['eye']
    n = len(poly)
    cx = sum(p[0] for p in poly) / n; cz = sum(p[1] for p in poly) / n
    cands = []
    for i in range(n):
        x0, z0 = poly[i]
        dx, dz = cx - x0, cz - z0
        Ld = math.hypot(dx, dz) or 1
        for ins in cfg['insets']:
            px, pz = x0 + dx / Ld * ins * 1.4, z0 + dz / Ld * ins * 1.4
            if inside(poly, px, pz):
                cands.append((px, pz, False))
    for ins in (0.3, 0.55):
        cands += [(px, pz, True) for px, pz in door_points(fl, room, ins)]
    glaz = glazing_points(fl, room)
    targets = [tuple(p) for p in poly] + [(cx, cz)] + glaz
    dg = None
    build_bvh()
    hfov = 2 * math.atan(18.0 / cfg['lens']); vfov = 2 * math.atan(18.0 * 9 / 16 / cfg['lens'])
    gx = [math.tan(a) for a in np.linspace(-hfov / 2 * 0.96, hfov / 2 * 0.96, 9)]
    gy = [math.tan(a) for a in np.linspace(-vfov / 2 * 0.96, vfov / 2 * 0.96, 5)]
    best = None
    for relax in (1.0, 0.75, 0.55):
        for (px, pz, is_door) in cands:
            o = Vector((px, -pz, y))
            # do not stand inside furniture: free space around the tripod
            if any((cast(dg, o, Vector((math.cos(a), math.sin(a), 0)))[0] or 9) < 0.25 for a in np.linspace(0, 2 * math.pi, 8, endpoint=False)):
                continue
            for (tx, tz) in targets:
                d = Vector((tx - px, -(tz - pz), 0))
                if d.length < 1.2:
                    continue
                d.normalize()
                right = Vector((d.y, -d.x, 0)); up = Vector((0, 0, 1))
                dists = []; thr = 0
                for b in gy:
                    for a in gx:
                        dist, loc, through = cast(dg, o, d + right * a + up * b, far=60)
                        dd = 60.0 if dist is None else dist
                        out = dist is None or not in_building(loc, y)
                        if out and through:
                            thr += 1
                        dists.append(min(dd, 7.0))
                mn = min(dists)
                cen = dists[len(dists) // 2]
                if mn < cfg['near'] * relax or cen < cfg['centre'] * relax:
                    continue
                wf = thr / len(dists)
                score = float(np.mean(dists)) + cfg['win'] * min(wf, 0.3) / 0.3 + (cfg['door_bonus'] if is_door else 0.0)
                # avoid looking straight into a huge window wall (silhouette shots)
                if wf > 0.55:
                    score -= 1.5
                if best is None or score > best[0]:
                    best = (score, px, pz, tx, tz, mn, wf, is_door)
        if best:
            break
    if not best:
        log(f'[frame] {shot["id"]}: no clear view found, keeping the exported camera')
        return None
    score, px, pz, tx, tz, mn, wf, is_door = best
    log(f'[frame] {shot["id"]}: pos=({px:.2f},{pz:.2f}) -> ({tx:.2f},{tz:.2f}) lens={cfg["lens"]} nearest={mn:.2f} m window={wf:.2f} door={is_door} score={score:.2f}')
    return dict(position=[round(px, 3), round(y, 3), round(pz, 3)], lookAt=[round(tx, 3), round(y, 3), round(tz, 3)],
                lens_mm=cfg['lens'], clip_start=max(0.1, min(0.5, mn * 0.6)))
