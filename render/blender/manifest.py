"""Merge every renders/**/shots-*.json into renders/manifest.json and compute panorama links.

Manifest:
{
  "version": 1, "generated": iso,
  "conventions": {...},
  "units": { "<unit>": { "<pkg>": { "panos": [ {id, roomId, name, file, thumb, position, yawOffset, links:[i...], variants?} ],
                                    "stills": [ {id, kind, roomId, name, file, thumb, lens, variants?} ] } } },
  "exterior": [ {id, name, file, thumb, tod, variants?, variantOf?} ], "common": [ ... ],
  "packages": [...], "timesOfDay": ["day", "dusk", "night"]
}
Time of day: `file` / `thumb` are the DAY image; `variants` = { dusk: {file, thumb}, night: {file, thumb} } holds the same
camera (identical yawOffset) at blue hour / at night. Unit variants are the files <name>.dusk.jpg / <name>.night.jpg next to the
day file (thumbs likewise). Exterior / common night shots are separate entries (id, name, tod, variantOf = id of the day
shot with the same framing) AND are attached to that base entry as variants.<tod>.
Links: two panos are linked when they are in the same room/balcony, or their rooms connect through a door/opening/glass
door/entry in FLOORS[].walls (js/data.js), and they are < 9 m apart.
"""
import glob, json, math, os, re, subprocess, sys, time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
PASS = {'door', 'entry', 'opening', 'glassdoor', 'main'}


def load_data():
    js = os.path.join(ROOT, 'js', 'data.js')
    if not os.path.exists(js):
        return None
    code = ("import * as D from '" + js.replace('\\', '/') + "';"
            "console.log(JSON.stringify({FLOORS: D.FLOORS.map(f => ({id: f.id, walls: f.walls, rooms: f.rooms.map(r => ({id: r.id, poly: r.poly}))})),"
            "BALCONIES: D.BALCONIES, UNITS: D.UNITS.map(u => ({id: u.id, floor: u.floor}))}))")
    try:
        out = subprocess.run(['node', '--input-type=module', '-e', code], capture_output=True, text=True, timeout=60)
        return json.loads(out.stdout)
    except Exception as e:
        print('data.js load failed', e)
        return None


def inside(poly, x, z):
    c = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, zi = poly[i]; xj, zj = poly[j]
        if (zi > z) != (zj > z) and x < (xj - xi) * (z - zi) / ((zj - zi) or 1e-12) + xi:
            c = not c
        j = i
    return c


LEVEL_OF = {'basement': 'basement', 'ground': 'ground', 'first': 'first', 'second': 'second'}


def regions(D, floor_id):
    f = next((f for f in D['FLOORS'] if f['id'] == floor_id), None)
    if not f:
        return [], []
    regs = [(r['id'], r['poly']) for r in f['rooms']]
    regs += [(b['id'], b['poly']) for b in D['BALCONIES'] if b['level'] == floor_id]
    return f, regs


def region_at(regs, x, z):
    for rid, poly in regs:
        if inside(poly, x, z):
            return rid
    return None


def connectivity(D, floor_id):
    f, regs = regions(D, floor_id)
    edges = set()
    if not f:
        return edges, regs
    for w in f['walls']:
        (ax, az), (bx, bz) = w['a'], w['b']
        L = math.hypot(bx - ax, bz - az) or 1
        ux, uz = (bx - ax) / L, (bz - az) / L
        nx, nz = -uz, ux
        for o in w.get('openings', []):
            if o['type'] not in PASS:
                continue
            s = (o['from'] + o['to']) / 2
            mx, mz = ax + ux * s, az + uz * s
            ra = region_at(regs, mx + nx * 0.35, mz + nz * 0.35)
            rb = region_at(regs, mx - nx * 0.35, mz - nz * 0.35)
            if ra and rb and ra != rb:
                edges.add((ra, rb)); edges.add((rb, ra))
    # open-plan boundaries without any wall (e.g. 1.C hall <-> living): probe across every region edge
    def blocked(px, pz, qx, qz):
        for w in f['walls']:
            (ax, az), (bx, bz) = w['a'], w['b']
            d1x, d1z, d2x, d2z = qx - px, qz - pz, bx - ax, bz - az
            den = d1x * d2z - d1z * d2x
            if abs(den) < 1e-12:
                continue
            t = ((ax - px) * d2z - (az - pz) * d2x) / den
            u = ((ax - px) * d1z - (az - pz) * d1x) / den
            if 0 <= t <= 1 and -0.02 <= u <= 1.02:
                L = math.hypot(d2x, d2z); s = u * L
                if not any(o['type'] in PASS and o['from'] - 0.02 <= s <= o['to'] + 0.02 for o in w.get('openings', [])):
                    return True
        return False
    hits = {}
    for rid, poly in regs:
        n = len(poly)
        for i in range(n):
            (x0, z0), (x1, z1) = poly[i], poly[(i + 1) % n]
            L = math.hypot(x1 - x0, z1 - z0)
            if L < 1e-6:
                continue
            ux, uz = (x1 - x0) / L, (z1 - z0) / L
            k = 1
            while k * 0.2 < L:
                sx, sz = x0 + ux * k * 0.2, z0 + uz * k * 0.2
                for sgn in (1, -1):
                    qx, qz = sx - uz * 0.3 * sgn, sz + ux * 0.3 * sgn
                    if inside(poly, qx, qz):
                        continue
                    other = region_at(regs, qx, qz)
                    if other and other != rid and not blocked(sx + uz * 0.05 * sgn, sz - ux * 0.05 * sgn, qx, qz):
                        hits[(rid, other)] = hits.get((rid, other), 0) + 1
                k += 1
    for (ra, rb), c in hits.items():
        if c >= 3:
            edges.add((ra, rb)); edges.add((rb, ra))
    # balconies/decks that touch a room through glass doors are covered above; garden <-> deck: same outdoor space
    for b in D['BALCONIES']:
        if b['level'] != floor_id:
            continue
        for rid, poly in regs:
            if rid.endswith('garden') and any(inside(poly, x, z) for x, z in b['poly']):
                edges.add((rid, b['id'])); edges.add((b['id'], rid))
    return edges, regs


def link_panos(panos, D, floor_id):
    edges, regs = connectivity(D, floor_id) if D else (set(), [])
    for i, p in enumerate(panos):
        x, z = p['position'][0], p['position'][2]
        reg = region_at(regs, x, z) if regs else None
        p['_reg'] = reg or p.get('roomId')
    for i, p in enumerate(panos):
        links = []
        for j, q in enumerate(panos):
            if i == j:
                continue
            d = math.hypot(p['position'][0] - q['position'][0], p['position'][2] - q['position'][2])
            same = p['_reg'] == q['_reg'] or p.get('roomId') == q.get('roomId')
            adj = (p['_reg'], q['_reg']) in edges
            if (same or adj) and d < 9.0:
                links.append((d, j))
        p['links'] = [j for d, j in sorted(links)]
    for p in panos:
        p.pop('_reg', None)
    # never leave a pano isolated: link to the nearest one
    for i, p in enumerate(panos):
        if not p['links'] and len(panos) > 1:
            j = min((j for j in range(len(panos)) if j != i), key=lambda j: math.dist(p['position'], panos[j]['position']))
            p['links'] = [j]
            if i not in panos[j]['links']:
                panos[j]['links'].append(i)


def jpeg_size(p):
    with open(p, 'rb') as f:
        d = f.read(200000)
    i = 2
    while i < len(d) - 9:
        if d[i] != 0xFF:
            i += 1; continue
        m = d[i + 1]
        if m in (0xC0, 0xC1, 0xC2):
            return int.from_bytes(d[i + 7:i + 9], 'big'), int.from_bytes(d[i + 5:i + 7], 'big')
        i += 2 + int.from_bytes(d[i + 2:i + 4], 'big')
    return None, None


VARIANT_RE = re.compile(r'\.(dusk|night)\.jpg$')
TODS = ('dusk', 'night')


def variants_for(entry):
    """<name>.dusk.jpg / <name>.night.jpg next to the day file -> {dusk: {file, thumb}, night: {...}}."""
    out = {}
    f = entry.get('file') or ''
    if not f.endswith('.jpg'):
        return out
    d, b = os.path.split(f)
    for tod in TODS:
        vf = f'{d}/{b[:-4]}.{tod}.jpg'
        if os.path.exists(os.path.join(ROOT, vf)):
            vt = f'{d}/thumbs/{b[:-4]}.{tod}.jpg'
            out[tod] = {'file': vf, 'thumb': vt if os.path.exists(os.path.join(ROOT, vt)) else vf}
    return out


def extra_shots():
    """id -> definition of the extra exterior / common shots (names, variant_of / variant_tod)."""
    out = {}
    try:
        ovr = json.load(open(os.path.join(ROOT, 'render', 'blender', 'cameras_override.json')))
        for c in ovr.get('extra_exterior', []) + ovr.get('extra_common', []):
            out[c['id']] = c
        cams = json.load(open(os.path.join(ROOT, 'render', 'scenes', 'cameras.json')))
        for c in cams.get('exterior', []) + cams.get('common', []):
            out.setdefault(c['id'], c)
    except Exception as e:
        print('extra shots not loaded', e)
    return out


def main():
    D = load_data()
    floor_of = {u['id']: u['floor'] for u in (D or {}).get('UNITS', [])}
    shots = {}
    for f in sorted(glob.glob(os.path.join(ROOT, 'renders', '**', 'shots-*.json'), recursive=True)):
        if '/preview/' in f.replace('\\', '/'):
            continue
        try:
            d = json.load(open(f))
        except Exception:
            continue
        for s in d.get('shots', []):
            if not os.path.exists(os.path.join(ROOT, s['file'])):
                continue
            j = d['job']
            if j['scope'] == 'unit' and (s.get('variant') or s.get('tod') in ('dusk', 'night') or VARIANT_RE.search(s['file'])):
                continue        # dusk / night variants are attached to the day entry below (by file name)
            k = (j['scope'], j.get('unit'), j.get('pkg'), s['id'])
            shots[k] = s
    # recover renders whose shots-*.json was overwritten by a later shard (synthesised from cameras.json + the JPEG)
    try:
        cams = json.load(open(os.path.join(ROOT, 'render', 'scenes', 'cameras.json')))
        for unit, ud in cams.get('unitsData', {}).items():
            for pkg, pd in ud.get('packages', {}).items():
                for i, h in enumerate(pd.get('hotspots', [])):
                    k = ('unit', unit, pkg, h['id'])
                    rel = f'renders/units/{unit}/{pkg}/{h["id"]}.jpg'
                    if k in shots or not os.path.exists(os.path.join(ROOT, rel)):
                        continue
                    W, H = jpeg_size(os.path.join(ROOT, rel))
                    dx, dz = h['lookAt'][0] - h['position'][0], h['lookAt'][2] - h['position'][2]
                    shots[k] = dict(id=h['id'], type='pano', file=rel, thumb=f'renders/units/{unit}/{pkg}/thumbs/{h["id"]}.jpg',
                                    W=W, H=H, position=h['position'], lookAt=h['lookAt'], roomId=h.get('roomId'), name=h.get('name'),
                                    yawOffset=round(math.atan2(-dx, -dz), 5), index=i)
                for c in ud.get('hero', []):
                    k = ('unit', unit, pkg, c['id'])
                    rel = f'renders/units/{unit}/{pkg}/{c["id"]}.jpg'
                    if k in shots or not os.path.exists(os.path.join(ROOT, rel)):
                        continue
                    W, H = jpeg_size(os.path.join(ROOT, rel))
                    shots[k] = dict(id=c['id'], type='still', file=rel, thumb=f'renders/units/{unit}/{pkg}/thumbs/{c["id"]}.jpg', W=W, H=H,
                                    position=c['position'], lookAt=c['lookAt'], roomId=c.get('roomId'), name=c.get('roomName'), kind=c.get('kind'), lens=c.get('lens_mm'))
    except Exception as e:
        print('recovery failed', e)
    try:
        packages = json.load(open(os.path.join(ROOT, 'render', 'scenes', 'cameras.json'))).get('packages', [])
    except Exception:
        packages = []
    extras = extra_shots()
    man = {'version': 1, 'generated': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
           'packages': packages, 'timesOfDay': ['day', 'dusk', 'night'],
           'conventions': {
               'position': 'three.js world metres (Y-up), eye point of the panorama',
               'yawOffset': 'radians; three.js camera yaw (rotation.y, YXZ order; 0 looks along -Z, +pi/2 looks along -X) of the '
                            'panorama CENTRE column (u = 0.5). u grows to the right (clockwise seen from above). Seam at u = 0/1 faces away.',
               'links': 'indices into the same panos array (same room, or rooms connected by a door/opening/glass door, < 9 m)',
               'variants': 'file / thumb = DAY; variants.dusk / variants.night = {file, thumb} of the same camera (same yawOffset) at blue '
                           'hour / at night (<name>.dusk.jpg / <name>.night.jpg). Exterior / common: variantOf = id of the day shot '
                           'with the same framing (the entry is also attached there as variants.<tod>).',
               'files': 'repo-relative paths (the Pages site serves them at the same relative path)'},
           'units': {}, 'exterior': [], 'common': []}
    for (scope, unit, pkg, sid), s in sorted(shots.items(), key=lambda kv: (kv[0][0], kv[0][1] or '', kv[0][2] or '', kv[1].get('index') if kv[1].get('index') is not None else 999, kv[0][3])):
        base = {k: s.get(k) for k in ('id', 'roomId', 'name', 'file', 'thumb')}
        if scope == 'unit':
            e = man['units'].setdefault(unit, {}).setdefault(pkg, {'panos': [], 'stills': []})
            if s['type'] == 'pano':
                e['panos'].append(dict(base, position=s['position'], lookAt=s.get('lookAt'), yawOffset=s.get('yawOffset'), W=s['W'], H=s['H']))
            else:
                e['stills'].append(dict(base, kind=s.get('kind'), lens=s.get('lens'), position=s['position'], lookAt=s.get('lookAt'), W=s['W'], H=s['H']))
        else:
            x = extras.get(sid, {})
            e = dict(base, tod=s.get('tod'), lens=s.get('lens'), W=s['W'], H=s['H'])
            if not e.get('name') and x.get('name'):
                e['name'] = x['name']
            if x.get('variant_of'):
                e['variantOf'] = x['variant_of']; e['variantTod'] = x.get('variant_tod') or s.get('tod')
            man[scope if scope in ('exterior', 'common') else 'exterior'].append(e)
    n_var = 0
    for sect in ('exterior', 'common'):
        by_id = {e['id']: e for e in man[sect]}
        for e in man[sect]:
            b = by_id.get(e.get('variantOf'))
            if b is not None and e.get('variantTod') in TODS:
                b.setdefault('variants', {})[e['variantTod']] = {'file': e['file'], 'thumb': e['thumb']}
                n_var += 1
    for pk in man['units'].values():
        for e in pk.values():
            for it in e['panos'] + e['stills']:
                v = variants_for(it)
                if v:
                    it['variants'] = v; n_var += len(v)
    for unit, pk in man['units'].items():
        for pkg, e in pk.items():
            link_panos(e['panos'], D, floor_of.get(unit))
    out = os.path.join(ROOT, 'renders', 'manifest.json')
    with open(out, 'w') as f:
        json.dump(man, f, indent=1, ensure_ascii=False)
    n_p = sum(len(e['panos']) for pk in man['units'].values() for e in pk.values())
    n_s = sum(len(e['stills']) for pk in man['units'].values() for e in pk.values())
    print(f'manifest: units={len(man["units"])} panos={n_p} stills={n_s} exterior={len(man["exterior"])} common={len(man["common"])} variants={n_var}')


if __name__ == '__main__':
    main()
