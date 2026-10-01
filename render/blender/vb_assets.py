"""Texture / HDRI resolver + downloader (pure python; runs inside Blender and on the runner).

Order of preference for a texture set:
  1. render/assets/blender_manifest.json (written by the ASSETS agent / assets.yml) — local 2K masters in the CI cache
  2. Poly Haven API by id (https://api.polyhaven.com/files/<id>) -> ~/.cache/vilnyi-render/tex/<id>/<map>.jpg

CLI:  python3 vb_assets.py prefetch [--res 2k] [--hdri-res 4k]   (downloads everything vb_library references)
"""
import json, os, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
CACHE = os.environ.get('VB_CACHE', os.path.expanduser('~/.cache/vilnyi-render'))
UA = 'VILNYI-Barreiro2-render/1.0 (+https://github.com/yosmos384-ship-it/vilnyi-barreiro2)'
MANIFEST = os.path.join(ROOT, 'render', 'assets', 'blender_manifest.json')

# Poly Haven map names -> our slots
PH_MAPS = {'diff': ['Diffuse', 'diff', 'albedo'], 'nor': ['nor_gl', 'nor_dx'], 'rough': ['Rough', 'rough'],
           'disp': ['Displacement', 'disp'], 'ao': ['AO', 'ao'], 'metal': ['Metal', 'metal']}


def _get(url, binary=False, tries=4):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=120) as r:
                data = r.read()
            return data if binary else json.loads(data.decode('utf-8'))
        except Exception as e:  # noqa
            last = e
            time.sleep(2 * (i + 1))
    raise RuntimeError(f'GET failed {url}: {last}')


def _dl(url, path):
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    data = _get(url, binary=True)
    with open(path + '.part', 'wb') as f:
        f.write(data)
    os.replace(path + '.part', path)
    return path


_manifest = None


def manifest():
    global _manifest
    if _manifest is None:
        _manifest = {}
        try:
            with open(MANIFEST) as f:
                _manifest = json.load(f)
        except Exception:
            _manifest = {}
    return _manifest


def _abs(p):
    if not p:
        return None
    p = os.path.expanduser(os.path.expandvars(p))
    if not os.path.isabs(p):
        for base in (ROOT, os.environ.get('ASSET_CACHE', os.path.expanduser('~/.cache/vilnyi-assets'))):
            q = os.path.join(base, p)
            if os.path.exists(q):
                return q
    return p if os.path.exists(p) else None


def manifest_set(key, pkg=None):
    """Return {'maps': {slot: path}, 'size': m, 'id': ...} from the ASSETS manifest if it covers this key (tolerant)."""
    m = manifest()
    if not m:
        return None
    cands = []
    for sect in ('materials', 'textures', 'keys', 'pbr'):
        s = m.get(sect)
        if isinstance(s, dict):
            if pkg:
                cands += [s.get(f'{key}@{pkg}'), s.get(f'{pkg}/{key}'), (s.get(pkg) or {}).get(key) if isinstance(s.get(pkg), dict) else None]
            cands.append(s.get(key))
    pk = m.get('packages')
    if pkg and isinstance(pk, dict) and isinstance(pk.get(pkg), dict):
        cands.insert(0, pk[pkg].get(key))
    for c in cands:
        if not isinstance(c, dict):
            continue
        maps = c.get('maps') or c.get('files') or {}
        out = {}
        for slot, names in PH_MAPS.items():
            for n in [slot] + names + [slot + '_2k', slot.capitalize()]:
                if n in maps and _abs(maps[n] if isinstance(maps[n], str) else (maps[n].get('path') if isinstance(maps[n], dict) else None)):
                    v = maps[n] if isinstance(maps[n], str) else maps[n].get('path')
                    out[slot] = _abs(v)
                    break
        if out.get('diff') or out.get('rough') or out.get('nor'):
            size = c.get('size') or c.get('sizeMeters') or c.get('size_m') or c.get('meters')
            if isinstance(size, (list, tuple)):
                size = size[0]
            return {'maps': out, 'size': float(size) if size else None, 'id': c.get('id') or c.get('assetId'), 'src': 'manifest'}
    return None


def manifest_hdri(name):
    m = manifest()
    for sect in ('hdri', 'hdris', 'skies'):
        s = m.get(sect)
        if isinstance(s, dict) and isinstance(s.get(name), (dict, str)):
            v = s[name]
            p = v if isinstance(v, str) else (v.get('path') or v.get('master') or v.get('file'))
            p = _abs(p)
            if p and p.lower().endswith(('.hdr', '.exr')):
                return p
    return None


def _pick_file(entry, res, fmts=('jpg', 'png')):
    if not isinstance(entry, dict):
        return None
    order = [res, '2k', '1k', '4k', '8k']
    for r in order:
        e = entry.get(r)
        if isinstance(e, dict):
            for f in fmts:
                if f in e and isinstance(e[f], dict) and e[f].get('url'):
                    return e[f]['url'], f
    return None


def polyhaven_set(tid, res='2k'):
    """Download Poly Haven texture maps for id; returns {'maps': {slot: path}, 'id': tid} or None."""
    d = os.path.join(CACHE, 'tex', tid)
    idx = os.path.join(d, 'index.json')
    if os.path.exists(idx):
        try:
            with open(idx) as f:
                maps = json.load(f)
            if all(os.path.exists(p) for p in maps.values()):
                return {'maps': maps, 'id': tid, 'src': 'cache'}
        except Exception:
            pass
    try:
        files = _get(f'https://api.polyhaven.com/files/{tid}')
    except Exception as e:
        print('[assets] polyhaven files failed', tid, e)
        return None
    maps = {}
    for slot, names in PH_MAPS.items():
        for n in names:
            if n in files:
                pf = _pick_file(files[n], res, ('jpg', 'png') if slot != 'disp' else ('png', 'jpg'))
                if pf:
                    url, ext = pf
                    try:
                        maps[slot] = _dl(url, os.path.join(d, f'{slot}.{ext}'))
                    except Exception as e:
                        print('[assets] dl failed', tid, slot, e)
                    break
    if maps:
        os.makedirs(d, exist_ok=True)
        with open(idx, 'w') as f:
            json.dump(maps, f)
        return {'maps': maps, 'id': tid, 'src': 'polyhaven'}
    return None


def polyhaven_hdri(hid, res='4k'):
    d = os.path.join(CACHE, 'hdri')
    for r in (res, '2k', '8k', '1k'):
        p = os.path.join(d, f'{hid}_{r}.hdr')
        if os.path.exists(p) and os.path.getsize(p) > 0:
            return p
    try:
        files = _get(f'https://api.polyhaven.com/files/{hid}')
        h = files.get('hdri', {})
        for r in (res, '2k', '1k'):
            e = h.get(r, {})
            if 'hdr' in e:
                return _dl(e['hdr']['url'], os.path.join(d, f'{hid}_{r}.hdr'))
    except Exception as e:
        print('[assets] hdri failed', hid, e)
    return None


def texture_set(key, pkg, tid, res='2k'):
    s = manifest_set(key, pkg)
    if s:
        return s
    if tid:
        return polyhaven_set(tid, res)
    return None


def hdri_path(name, hid, res='4k'):
    return polyhaven_hdri(hid, res) or manifest_hdri(name)


def prefetch(res='2k', hdri_res='4k'):
    sys.path.insert(0, HERE)
    import vb_library as L
    ok, bad = [], []
    for tid in L.all_texture_ids():
        (ok if polyhaven_set(tid, res) else bad).append(tid)
    for name, s in L.SKIES.items():
        (ok if polyhaven_hdri(s['hdri'], hdri_res) else bad).append(s['hdri'])
    print(f'[assets] prefetch ok={len(ok)} failed={bad}')
    return bad


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'prefetch':
        res = sys.argv[sys.argv.index('--res') + 1] if '--res' in sys.argv else '2k'
        hres = sys.argv[sys.argv.index('--hdri-res') + 1] if '--hdri-res' in sys.argv else '4k'
        bad = prefetch(res, hres)
        sys.exit(0)
