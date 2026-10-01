#!/usr/bin/env python3
"""VILNYI Barreiro 2 - CC0 asset fetcher (Poly Haven + ambientCG).

Modes (read from render/assets/request.json -> "mode", or argv[1]):
  catalog  dump compact catalogs of Poly Haven textures/hdris/models and ambientCG materials
           into render/assets/catalog/*.json (used to choose assets by metadata)
  thumbs   download preview thumbnails of request["thumbs"] ids into labelled contact sheets
           render/logs/contact-<n>.jpg (for visual checking of candidates)
  build    download everything in render/assets/selection.json:
             2K masters -> CACHE (not committed)
             web 1K JPEG maps -> assets/pbr/<slot>/, 1K .hdr -> assets/hdri/, 1K GLB -> assets/models/
             assets/manifest.json, render/assets/blender_manifest.json, render/logs/assets.txt
All assets are CC0 (Poly Haven: https://polyhaven.com/license, ambientCG: https://docs.ambientcg.com/license/).
"""
import io, json, os, re, shutil, subprocess, sys, time, zipfile, hashlib
import urllib.request, urllib.error

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
CACHE = os.environ.get('ASSET_CACHE', os.path.expanduser('~/.cache/vilnyi-assets'))
UA = 'VILNYI-Barreiro2-assets/1.0 (+https://github.com/yosmos384-ship-it/vilnyi-barreiro2)'
PH_API = 'https://api.polyhaven.com'
ACG_API = 'https://ambientcg.com/api/v2/full_json'
LOG = []
FAIL = []


def log(*a):
    s = ' '.join(str(x) for x in a)
    print(s, flush=True)
    LOG.append(s)


def get(url, binary=False, tries=4):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=120) as r:
                data = r.read()
            return data if binary else json.loads(data.decode('utf-8'))
        except Exception as e:  # noqa
            last = e
            time.sleep(1.5 * (i + 1))
    raise RuntimeError(f'GET failed {url}: {last}')


def download(url, path):
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    data = get(url, binary=True)
    tmp = path + '.part'
    with open(tmp, 'wb') as f:
        f.write(data)
    os.replace(tmp, path)
    return path


def wjson(path, obj, compact=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        if compact:
            json.dump(obj, f, separators=(',', ':'), ensure_ascii=False)
        else:
            json.dump(obj, f, indent=1, ensure_ascii=False)


# ------------------------------------------------------------------ catalog
def acg_all(atype='Material', extra='tagData,displayData,dimensionsData'):
    out, offset = [], 0
    while True:
        url = f'{ACG_API}?type={atype}&limit=250&offset={offset}&include={extra}&sort=Popular'
        d = get(url)
        fa = d.get('foundAssets', [])
        out += fa
        log(f'  ambientCG {atype} offset {offset}: {len(fa)} (total {d.get("numberOfResults")})')
        if len(fa) < 250:
            break
        offset += 250
    return out


def mode_catalog(req):
    cat = os.path.join(ROOT, 'render/assets/catalog')
    for t in ('textures', 'hdris', 'models'):
        d = get(f'{PH_API}/assets?t={t}')
        comp = {}
        for k, v in d.items():
            comp[k] = {'n': v.get('name'), 'c': v.get('categories'), 't': v.get('tags'),
                       'd': v.get('dimensions'), 'dl': v.get('download_count'),
                       'p': v.get('polycount'), 'ev': v.get('evs_cap') or v.get('evs')}
        wjson(f'{cat}/polyhaven_{t}.json', comp, compact=True)
        log(f'polyhaven {t}: {len(comp)}')
        if t == 'models':
            first = next(iter(d.values()))
            log('  sample keys:', sorted(first.keys()))
    try:
        acg = acg_all()
        if acg:
            log('  ambientCG sample keys:', sorted(acg[0].keys()))
        comp = {}
        for a in acg:
            comp[a.get('assetId')] = {'n': a.get('displayName'), 'c': a.get('displayCategory'), 't': a.get('tags'),
                                      'dx': a.get('dimensionX'), 'dy': a.get('dimensionY'), 'dz': a.get('dimensionZ'),
                                      'dl': a.get('downloadCount')}
        wjson(f'{cat}/ambientcg_materials.json', comp, compact=True)
        log(f'ambientCG materials: {len(comp)}')
    except Exception as e:
        log('ambientCG catalog FAILED', e)
        FAIL.append(f'ambientCG catalog: {e}')
    # one sample of each files-structure for reference
    for t, sid in (('textures', 'brown_planks_03'), ('hdris', 'kloofendal_48d_partly_cloudy_puresky'), ('models', 'ArmChair_01')):
        try:
            f = get(f'{PH_API}/files/{sid}')
            def shape(o, depth=0):
                if isinstance(o, dict):
                    if 'url' in o:
                        return o['url']
                    if depth > 4:
                        return '...'
                    return {k: shape(v, depth + 1) for k, v in list(o.items())[:12]}
                return o
            wjson(f'{cat}/sample_files_{t}.json', shape(f))
        except Exception as e:
            log('sample files failed', sid, e)


# ------------------------------------------------------------------ thumbs
def mode_thumbs(req):
    from PIL import Image, ImageDraw
    ids = req.get('thumbs', [])
    cat = os.path.join(ROOT, 'render/assets/catalog')
    acg_prev = {}
    if any(i.startswith('acg:') for i in ids):
        for a in acg_all(extra='displayData'):
            pi = a.get('previewImage') or {}
            acg_prev[a['assetId']] = pi.get('256-JPG-FFFFFF') or pi.get('256-PNG') or next(iter(pi.values()), None)
    cells = []
    for i in ids:
        try:
            if i.startswith('acg:'):
                url = acg_prev.get(i[4:])
            elif i.startswith('hdri:'):
                url = f'https://cdn.polyhaven.com/asset_img/thumbs/{i[5:]}.png?width=384&height=192'
            else:
                url = f'https://cdn.polyhaven.com/asset_img/thumbs/{i}.png?width=256&height=256'
            im = Image.open(io.BytesIO(get(url, binary=True))).convert('RGB')
            cells.append((i, im))
        except Exception as e:
            log('thumb failed', i, e)
            cells.append((i, Image.new('RGB', (256, 256), (255, 0, 255))))
    W, H, cols = 256, 276, 6
    per = 36
    for n in range(0, len(cells), per):
        chunk = cells[n:n + per]
        rows = (len(chunk) + cols - 1) // cols
        sheet = Image.new('RGB', (cols * W, rows * H), (40, 40, 40))
        dr = ImageDraw.Draw(sheet)
        for j, (i, im) in enumerate(chunk):
            im = im.copy(); im.thumbnail((W - 4, H - 24))
            x, y = (j % cols) * W, (j // cols) * H
            sheet.paste(im, (x + 2, y + 2))
            dr.text((x + 3, y + H - 20), i[:40], fill=(255, 255, 0))
        os.makedirs(os.path.join(ROOT, 'render/logs'), exist_ok=True)
        sheet.save(os.path.join(ROOT, f'render/logs/contact-{n // per}.jpg'), quality=80)
        log('contact sheet', n // per, len(chunk))


# ------------------------------------------------------------------ swatch (flat 1K albedo crops)
def mode_swatch(req):
    from PIL import Image, ImageDraw
    cells = []
    for i in req.get('swatch', []):
        try:
            if i.startswith('acg:'):
                a = acg_asset(i[4:])
                z = get(acg_zip_url(a, '1K-JPG'), binary=True)
                with zipfile.ZipFile(io.BytesIO(z)) as zf:
                    n = [x for x in zf.namelist() if re.search(r'_Color\.(jpg|png)$', x)][0]
                    im = Image.open(io.BytesIO(zf.read(n))).convert('RGB')
            else:
                f = get(f'{PH_API}/files/{i}')
                u = ph_pick(f, ['diffuse', 'diff', 'albedo', 'col_1', 'col_01'], '1k') or ph_pick(f, [k.lower() for k in f if k.lower().startswith(('col', 'diff'))], '1k')
                im = Image.open(io.BytesIO(get(u, binary=True))).convert('RGB')
            cells.append((i, im))
        except Exception as e:
            log('swatch failed', i, e)
    W, cols, per = 384, 5, 20
    for n in range(0, len(cells), per):
        ch = cells[n:n + per]; rows = (len(ch) + cols - 1) // cols
        sh = Image.new('RGB', (cols * W, rows * (W + 18)), (30, 30, 30)); d = ImageDraw.Draw(sh)
        for j, (i, im) in enumerate(ch):
            x, y = (j % cols) * W, (j // cols) * (W + 18)
            sh.paste(im.resize((W - 4, W - 4)), (x + 2, y + 2)); d.text((x + 3, y + W), i, fill=(255, 255, 0))
        sh.save(os.path.join(ROOT, f'render/logs/contact-{n // per}.jpg'), quality=82)
        log('swatch sheet', n // per, len(ch))


# ------------------------------------------------------------------ build helpers
from PIL import Image  # noqa: E402

Image.MAX_IMAGE_PIXELS = None
MAPKEYS = {  # web map name -> poly haven file keys (lowercase match), ambientCG suffixes
    'albedo': (['diffuse', 'diff', 'col', 'albedo'], ['_Color']),
    'normal': (['nor_gl'], ['_NormalGL']),
    'roughness': (['rough', 'roughness'], ['_Roughness']),
    'ao': (['ao'], ['_AmbientOcclusion']),
    'metal': (['metal', 'metalness'], ['_Metalness']),
    'disp': (['displacement', 'disp'], ['_Displacement']),
    'opacity': (['alpha', 'opacity', 'mask'], ['_Opacity']),
}


def ph_pick(files, keys, res='2k'):
    low = {k.lower(): k for k in files}
    for k in keys:
        if k in low:
            node = files[low[k]]
            for r in (res, '2k', '1k', '4k'):
                if r in node:
                    for fmt in ('jpg', 'png', 'exr'):
                        if fmt in node[r]:
                            return node[r][fmt]['url']
    return None


def ph_urls(files, res):
    out = {}
    for m, (pk, _) in MAPKEYS.items():
        u = ph_pick(files, pk, res)
        if u:
            out[m] = u
    if 'albedo' not in out:
        cand = sorted(k for k in files if k.lower().startswith(('col', 'diff', 'base')))
        if cand:
            out['albedo'] = ph_pick(files, [cand[0].lower()], res)
    if 'arm' in {k.lower() for k in files}:
        out['_arm'] = ph_pick(files, ['arm'], res)
    return out


def apply_bake(im, bake):
    """Colour adjustments baked into the web albedo (also recorded in blender_manifest 'bake' for Cycles):
    saturation (0..1 mix to grey), brightness (gain, sRGB), multiply (#hex, sRGB multiply)."""
    from PIL import ImageEnhance, ImageChops
    im = im.convert('RGB')
    if 'saturation' in bake:
        im = ImageEnhance.Color(im).enhance(bake['saturation'])
    if 'brightness' in bake:
        im = ImageEnhance.Brightness(im).enhance(bake['brightness'])
    if 'multiply' in bake:
        im = ImageChops.multiply(im, Image.new('RGB', im.size, bake['multiply']))
    return im


def save_web(src, dst, size=1024, q=85, mode='RGB', bake=None):
    im = Image.open(src)
    if bake:
        im = apply_bake(im, bake)
    if im.mode in ('I;16', 'I;16B', 'I', 'F'):
        import numpy as np
        a = np.asarray(im, dtype='float32')
        a = a / max(1.0, a.max())
        im = Image.fromarray((a * 255).clip(0, 255).astype('uint8'))
    im = im.convert(mode)
    if im.size != (size, size):
        im = im.resize((size, size), Image.LANCZOS)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    im.save(dst, 'JPEG', quality=q, optimize=True, progressive=True)
    return os.path.getsize(dst)


def channel(src, idx, dst_tmp):
    im = Image.open(src).convert('RGB')
    im.split()[idx].save(dst_tmp)
    return dst_tmp


PH_INFO = {}


def ph_info(aid):
    if aid not in PH_INFO:
        PH_INFO[aid] = get(f'{PH_API}/info/{aid}')
    return PH_INFO[aid]


ACG_INDEX = None


def acg_asset(aid):
    global ACG_INDEX
    if ACG_INDEX is None:
        ACG_INDEX = {}
    if aid not in ACG_INDEX:
        d = get(f'{ACG_API}?id={aid}&include=downloadData,dimensionsData,tagData,displayData')
        fa = d.get('foundAssets', [])
        if not fa:
            raise RuntimeError(f'ambientCG asset {aid} not found')
        ACG_INDEX[aid] = fa[0]
    return ACG_INDEX[aid]


def acg_zip_url(a, attr='2K-JPG'):
    for fold in (a.get('downloadFolders') or {}).values():
        for cat in (fold.get('downloadFiletypeCategories') or {}).values():
            for dl in cat.get('downloads', []):
                if dl.get('attribute') == attr:
                    return dl.get('downloadLink') or dl.get('fullDownloadPath')
    return None


def tex_set(spec, slot):
    """Download a texture set (2K masters into cache), write web maps. Returns manifest entry + blender entry."""
    src, aid = spec['source'], spec['id']
    outdir = os.path.join(ROOT, 'assets/pbr', slot)
    rel = f'assets/pbr/{slot}'
    cdir = os.path.join(CACHE, src, aid)
    maps, bl, size_m = {}, {}, None
    if src == 'polyhaven':
        files = get(f'{PH_API}/files/{aid}')
        info = ph_info(aid)
        dims = info.get('dimensions')
        if dims and len(dims) >= 2 and dims[0]:
            size_m = [round(dims[0] / 1000.0, 3), round(dims[1] / 1000.0, 3)]
        u2 = ph_urls(files, '2k')
        u4 = ph_urls(files, '4k')
        bl = {'source': 'polyhaven', 'id': aid, 'maps2k': u2, 'maps4k': u4,
              'page': f'https://polyhaven.com/a/{aid}'}
        local = {}
        for m, u in u2.items():
            local[m] = download(u, os.path.join(cdir, os.path.basename(u.split('?')[0])))
        if 'roughness' not in local and '_arm' in local:
            local['roughness'] = channel(local['_arm'], 1, os.path.join(cdir, 'rough_from_arm.png'))
        if 'ao' not in local and '_arm' in local:
            local['ao'] = channel(local['_arm'], 0, os.path.join(cdir, 'ao_from_arm.png'))
        if 'metal' not in local and '_arm' in local and spec.get('metal'):
            local['metal'] = channel(local['_arm'], 2, os.path.join(cdir, 'metal_from_arm.png'))
        page = f'https://polyhaven.com/a/{aid}'
        name = info.get('name', aid)
        author = ', '.join((info.get('authors') or {}).keys())
    else:
        a = acg_asset(aid)
        zurl = acg_zip_url(a, '2K-JPG') or acg_zip_url(a, '1K-JPG')
        if not zurl:
            raise RuntimeError('no 2K-JPG zip')
        zpath = download(zurl, os.path.join(cdir, f'{aid}_2K-JPG.zip'))
        zdir = os.path.join(cdir, 'x')
        if not os.path.isdir(zdir):
            with zipfile.ZipFile(zpath) as z:
                z.extractall(zdir)
        local = {}
        for fn in sorted(os.listdir(zdir)):
            for m, (_, suf) in MAPKEYS.items():
                for s in suf:
                    if re.search(re.escape(s) + r'\.(jpg|png)$', fn):
                        local[m] = os.path.join(zdir, fn)
        dx = a.get('dimensionX'); dy = a.get('dimensionY')
        if dx:
            size_m = [round(float(dx) / 100.0, 3), round(float(dy or dx) / 100.0, 3)]
        bl = {'source': 'ambientcg', 'id': aid, 'zip2k': zurl, 'zip4k': acg_zip_url(a, '4K-JPG'),
              'files': {m: os.path.basename(p) for m, p in local.items()},
              'page': f'https://ambientcg.com/view?id={aid}'}
        page = f'https://ambientcg.com/view?id={aid}'
        name = a.get('displayName', aid)
        author = 'ambientCG (Lennart Demes)'
    if spec.get('sizeMeters'):
        size_m = spec['sizeMeters']
    if not size_m:
        size_m = [1.0, 1.0]
    total = 0
    for m in ('albedo', 'normal', 'roughness', 'ao', 'metal', 'opacity'):
        if m in local:
            q = 90 if m == 'normal' else 85
            mode = 'RGB' if m in ('albedo', 'normal') else 'L'
            fn = f'{m}.jpg'
            total += save_web(local[m], os.path.join(outdir, fn), 1024, q, mode, spec.get('bake') if m == 'albedo' else None)
            maps[m] = f'{rel}/{fn}'
    if 'albedo' not in maps or 'normal' not in maps:
        raise RuntimeError(f'incomplete set {aid}: {sorted(local)}')
    entry = {'id': aid, 'source': src, 'name': name, 'url': page, 'maps': maps, 'sizeMeters': size_m}
    for k in ('tint', 'note', 'rotate', 'alt', 'roughnessScale'):
        if k in spec:
            entry[k] = spec[k]
    bl['sizeMeters'] = size_m
    if spec.get('bake'):
        entry['baked'] = spec['bake']
        bl['bake'] = spec['bake']
    return entry, bl, total, (name, author, page, src)


def hdri(spec, slot):
    aid = spec['id']
    files = get(f'{PH_API}/files/{aid}')
    info = ph_info(aid)
    h = files['hdri']
    url1k = h['1k']['hdr']['url']
    dst = os.path.join(ROOT, 'assets/hdri', f'{slot}_{aid}_1k.hdr')
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    for f in os.listdir(os.path.dirname(dst)):
        if f.startswith(slot + '_') and f != os.path.basename(dst):
            os.remove(os.path.join(os.path.dirname(dst), f))
    shutil.copy(download(url1k, os.path.join(CACHE, 'hdri', os.path.basename(url1k))), dst)
    # 2K/4K masters warmed into the CI cache for Blender
    for r in ('2k', '4k'):
        if r in h and 'hdr' in h[r]:
            u = h[r]['hdr']['url']
            try:
                download(u, os.path.join(CACHE, 'hdri', os.path.basename(u)))
            except Exception as e:
                log('  cache warm failed', u, e)
    entry = {'id': aid, 'name': info.get('name'), 'web': f'assets/hdri/{os.path.basename(dst)}',
             'intensityHint': spec.get('intensityHint', 1.0), 'url': f'https://polyhaven.com/a/{aid}'}
    for k in ('sunAzimuthHint', 'note'):
        if k in spec:
            entry[k] = spec[k]
    bl = {'id': aid, 'hdr2k': h.get('2k', {}).get('hdr', {}).get('url'), 'hdr4k': h.get('4k', {}).get('hdr', {}).get('url'),
          'exr4k': h.get('4k', {}).get('exr', {}).get('url'), 'intensityHint': entry['intensityHint']}
    author = ', '.join((info.get('authors') or {}).keys())
    return entry, bl, os.path.getsize(dst), (info.get('name', aid), author, entry['url'], 'polyhaven')


def model(spec):
    aid = spec['id']
    files = get(f'{PH_API}/files/{aid}')
    info = ph_info(aid)
    g = files['gltf']
    node = g.get('1k') or g.get('2k')
    gl = node['gltf']
    mdir = os.path.join(CACHE, 'models', aid, '1k')
    gpath = download(gl['url'], os.path.join(mdir, os.path.basename(gl['url'])))
    for relp, inc in (gl.get('include') or {}).items():
        download(inc['url'], os.path.join(mdir, relp))
    out = os.path.join(ROOT, 'assets/models', f'{aid}.glb')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    tmp = os.path.join(CACHE, 'models', aid, 'tmp.glb')
    tmp2 = os.path.join(CACHE, 'models', aid, 'tmp2.glb')
    run(['gltf-transform', 'copy', gpath, tmp])
    try:
        run(['gltf-transform', 'resize', tmp, tmp2, '--width', '1024', '--height', '1024'])
    except Exception as e:
        log('  resize failed (keeping 1k source textures):', str(e)[:200])
        shutil.copy(tmp, tmp2)
    run(['gltf-transform', 'meshopt', tmp2, out])
    dims = info.get('dimensions')
    entry = {'file': f'assets/models/{aid}.glb', 'name': info.get('name'), 'category': spec.get('category'),
             'tags': info.get('tags'), 'compression': 'meshopt', 'url': f'https://polyhaven.com/a/{aid}'}
    if dims:
        entry['dimensions'] = [round(x / 1000.0, 3) for x in dims]  # metres (as reported by Poly Haven)
    if spec.get('use'):
        entry['use'] = spec['use']
    g2 = g.get('2k', {}).get('gltf', {})
    bl = {'id': aid, 'gltf2k': g2.get('url'), 'include2k': {k: v['url'] for k, v in (g2.get('include') or {}).items()},
          'blend2k': files.get('blend', {}).get('2k', {}).get('blend', {}).get('url'),
          'blendInclude2k': {k: v['url'] for k, v in (files.get('blend', {}).get('2k', {}).get('blend', {}).get('include') or {}).items()}}
    author = ', '.join((info.get('authors') or {}).keys())
    return entry, bl, os.path.getsize(out), (info.get('name', aid), author, entry['url'], 'polyhaven')


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f'{" ".join(cmd)}\n{r.stdout[-800:]}\n{r.stderr[-800:]}')
    return r.stdout


HINTS = {  # physically-plausible parameters for keys that need no bitmap
    'glass-window': {'color': '#dfe9ee', 'roughness': 0.02, 'metalness': 0, 'transmission': 1, 'ior': 1.52, 'thickness': 0.024, 'note': 'double glazing, slight green-blue tint'},
    'glass-railing': {'color': '#e6efef', 'roughness': 0.03, 'metalness': 0, 'transmission': 1, 'ior': 1.52, 'thickness': 0.02},
    'shower-glass': {'color': '#f2f6f6', 'roughness': 0.02, 'metalness': 0, 'transmission': 1, 'ior': 1.52, 'thickness': 0.01},
    'glass-drinking': {'color': '#ffffff', 'roughness': 0.0, 'metalness': 0, 'transmission': 1, 'ior': 1.5, 'thickness': 0.003},
    'mirror': {'color': '#f4f4f4', 'roughness': 0.0, 'metalness': 1},
    'water': {'color': '#2f4f5a', 'roughness': 0.05, 'metalness': 0, 'transmission': 0.0, 'ior': 1.33, 'note': 'use animated normal (three Water/Water2) or Blender ocean/noise bump'},
    'foliage': {'color': '#4d6b35', 'roughness': 0.6, 'metalness': 0, 'sheen': 0.3, 'translucency': 0.3, 'note': 'olive: #6f7f5a top / #9aa58a underside'},
    'plant-leaf': {'color': '#3f6a2c', 'roughness': 0.5, 'metalness': 0, 'translucency': 0.3},
    'candle-wax': {'color': '#f3ece0', 'roughness': 0.45, 'metalness': 0, 'subsurface': 0.5},
    'bulb-emissive': {'color': '#ffffff', 'emissive': '#ffd7a8', 'kelvin': 2700, 'watts': 6},
    'downlight-emissive': {'color': '#ffffff', 'emissive': '#ffe2bd', 'kelvin': 3000, 'watts': 8, 'lumens': 700},
    'led-strip-emissive': {'color': '#ffffff', 'emissive': '#ffd9a8', 'kelvin': 2700, 'wattsPerMetre': 10},
}


def mode_build(req):
    sel = json.load(open(os.path.join(ROOT, 'render/assets/selection.json')))
    only = set(req.get('only', []))
    manifest = {'version': 1, 'generated': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                'license': 'All assets CC0 1.0 (Poly Haven, ambientCG). Credits below.',
                'notes': {'normal': 'OpenGL convention (+Y up), linear', 'colorSpace': 'albedo = sRGB; normal/roughness/ao/metal = linear (NoColorSpace)',
                          'sizeMeters': 'real-world size of one texture tile [u,v] in metres -> repeat = surfaceSize / sizeMeters',
                          'models': 'GLB, 1K textures, EXT_meshopt_compression + KHR_mesh_quantization: GLTFLoader.setMeshoptDecoder(MeshoptDecoder) from three/addons/libs/meshopt_decoder.module.js',
                          'packages': 'textures[key][styleId] for package-dependent keys, else textures[key].default'},
                'textures': {}, 'hdris': {}, 'models': {}, 'credits': []}
    blend = {'version': 1, 'textures': {}, 'hdris': {}, 'models': {}}
    old_path = os.path.join(ROOT, 'assets/manifest.json')
    old = json.load(open(old_path)) if os.path.exists(old_path) else None
    oldbl_path = os.path.join(ROOT, 'render/assets/blender_manifest.json')
    oldbl = json.load(open(oldbl_path)) if os.path.exists(oldbl_path) else None
    credits = {}
    sizes = {'pbr': 0, 'hdri': 0, 'models': 0}
    done_slots = {}
    log('== TEXTURES')
    keep_slots = set()
    for key, per in sel['textures'].items():
        manifest['textures'][key] = {}
        blend['textures'][key] = {}
        for pkg, spec in per.items():
            if spec is None:  # no texture: procedural material, see hint
                manifest['textures'][key][pkg] = {'procedural': True, 'hint': HINTS.get(key, {})}
                blend['textures'][key][pkg] = {'procedural': True, 'hint': HINTS.get(key, {})}
                continue
            if isinstance(spec, str):  # alias "same as <pkg>" or "=key/pkg"
                ref = spec[1:] if spec.startswith('=') else spec
                rk, rp = (ref.split('/') + [None])[:2] if '/' in ref else (key, ref)
                manifest['textures'][key][pkg] = {'ref': f'{rk}/{rp}'}
                blend['textures'][key][pkg] = {'ref': f'{rk}/{rp}'}
                continue
            slot = spec.get('slot') or spec['id'].lower()
            slot_id = slot
            keep_slots.add(slot)
            if only and key not in only and old and key in old['textures'] and pkg in old['textures'][key]:
                manifest['textures'][key][pkg] = old['textures'][key][pkg]
                blend['textures'][key][pkg] = (oldbl or {}).get('textures', {}).get(key, {}).get(pkg)
                continue
            try:
                if slot_id in done_slots:
                    e, b, sz, cr = done_slots[slot_id]
                    e = dict(e); e.update({k: spec[k] for k in ('tint', 'note', 'rotate', 'alt', 'roughnessScale') if k in spec})
                    for k in ('tint', 'note', 'rotate', 'roughnessScale'):
                        if k not in spec:
                            e.pop(k, None)
                    if 'sizeMeters' in spec:
                        e['sizeMeters'] = spec['sizeMeters']
                    sz = 0
                else:
                    e, b, sz, cr = tex_set(spec, slot)
                    done_slots[slot_id] = (e, b, sz, cr)
                    credits[cr[2]] = cr
                    sizes['pbr'] += sz
                manifest['textures'][key][pkg] = e
                blend['textures'][key][pkg] = b
                log(f'  {key:24s} {pkg:9s} {spec["source"]:10s} {spec["id"]:40s} {sz/1024:7.0f} KB  {e["sizeMeters"]}')
            except Exception as ex:
                log(f'  FAIL {key} {pkg} {spec["id"]}: {ex}')
                FAIL.append(f'texture {key}/{pkg} {spec["id"]}: {ex}')
    # prune stale slots
    pdir = os.path.join(ROOT, 'assets/pbr')
    if os.path.isdir(pdir):
        for d in os.listdir(pdir):
            if d not in keep_slots:
                shutil.rmtree(os.path.join(pdir, d))
    log('== HDRIS')
    for slot, spec in sel['hdris'].items():
        try:
            e, b, sz, cr = hdri(spec, slot)
            manifest['hdris'][slot] = e; blend['hdris'][slot] = b
            credits[cr[2]] = cr; sizes['hdri'] += sz
            log(f'  {slot:8s} {spec["id"]:40s} {sz/1024:7.0f} KB')
        except Exception as ex:
            log(f'  FAIL hdri {slot} {spec["id"]}: {ex}'); FAIL.append(f'hdri {slot}: {ex}')
    log('== MODELS')
    keep_models = set()
    for spec in sel['models']:
        aid = spec['id']
        if spec.get('blenderOnly'):
            try:
                files = get(f'{PH_API}/files/{aid}')
                g2 = files.get('gltf', {}).get('2k', {}).get('gltf', {})
                bb = files.get('blend', {}).get('2k', {}).get('blend', {})
                blend['models'][aid] = {'id': aid, 'category': spec.get('category'), 'blenderOnly': True, 'gltf2k': g2.get('url'),
                                        'include2k': {k: v['url'] for k, v in (g2.get('include') or {}).items()},
                                        'blend2k': bb.get('url'), 'blendInclude2k': {k: v['url'] for k, v in (bb.get('include') or {}).items()},
                                        'dimensions': [round(x / 1000.0, 3) for x in (ph_info(aid).get('dimensions') or [])]}
                info = ph_info(aid)
                credits[f'https://polyhaven.com/a/{aid}'] = (info.get('name', aid), ', '.join((info.get('authors') or {}).keys()), f'https://polyhaven.com/a/{aid}', 'polyhaven')
                log(f'  {aid:40s} blender-only')
            except Exception as ex:
                log(f'  FAIL blender-only model {aid}: {ex}'); FAIL.append(f'model {aid}: {ex}')
            continue
        keep_models.add(f'{aid}.glb')
        try:
            e, b, sz, cr = model(spec)
            manifest['models'][aid] = e; blend['models'][aid] = b
            credits[cr[2]] = cr; sizes['models'] += sz
            log(f'  {aid:40s} {spec.get("category",""):12s} {sz/1024:7.0f} KB  dims={e.get("dimensions")}')
        except Exception as ex:
            log(f'  FAIL model {aid}: {ex}'); FAIL.append(f'model {aid}: {ex}')
    mdir = os.path.join(ROOT, 'assets/models')
    if os.path.isdir(mdir):
        for f in os.listdir(mdir):
            if f not in keep_models:
                os.remove(os.path.join(mdir, f))
    manifest['credits'] = [{'name': n, 'author': a, 'url': u, 'source': s,
                            'license': 'CC0 1.0'} for (n, a, u, s) in sorted(credits.values(), key=lambda c: c[2])]
    manifest['creditLine'] = 'Textures, HDRIs and 3D models: Poly Haven (polyhaven.com) and ambientCG (ambientcg.com), CC0.'
    wjson(os.path.join(ROOT, 'assets/manifest.json'), manifest)
    wjson(os.path.join(ROOT, 'render/assets/blender_manifest.json'), blend)
    log('== SIZES (KB)', {k: round(v / 1024) for k, v in sizes.items()}, 'total MB', round(sum(sizes.values()) / 1e6, 1))
    # HDRI previews for verification (tonemapped jpg via CDN)
    try:
        from PIL import Image as I
        for slot, e in manifest['hdris'].items():
            im = I.open(io.BytesIO(get(f'https://cdn.polyhaven.com/asset_img/primary/{e["id"]}.png?height=256', binary=True))).convert('RGB')
            im.save(os.path.join(ROOT, f'render/logs/hdri-{slot}.jpg'), quality=80)
    except Exception as ex:
        log('hdri previews failed', ex)


def main():
    reqp = os.path.join(ROOT, 'render/assets/request.json')
    req = json.load(open(reqp)) if os.path.exists(reqp) else {}
    mode = sys.argv[1] if len(sys.argv) > 1 else req.get('mode', 'build')
    log(f'mode={mode} cache={CACHE} time={time.strftime("%Y-%m-%d %H:%M:%S")}')
    try:
        {'catalog': mode_catalog, 'thumbs': mode_thumbs, 'swatch': mode_swatch, 'build': mode_build}[mode](req)
    except Exception as e:
        import traceback
        log('FATAL', e, traceback.format_exc())
        FAIL.append(f'FATAL {e}')
    log(f'== FAILURES ({len(FAIL)})')
    for f in FAIL:
        log('  ', f)
    os.makedirs(os.path.join(ROOT, 'render/logs'), exist_ok=True)
    with open(os.path.join(ROOT, 'render/logs/assets.txt'), 'w') as f:
        f.write('\n'.join(LOG) + '\n')


if __name__ == '__main__':
    main()
