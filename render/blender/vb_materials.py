"""Material system: glTF material names (CONTRACT3 vocabulary) -> Cycles Principled node trees with CC0 PBR maps.

Texture coordinates: every mesh gets a world-space box-projected UV layer 'vbUV' in METRES (vb_scene.box_uv), so the
Mapping node scale is simply 1/size and plank/tile scale is physically correct regardless of the glTF UVs.
"""
import math, os
import bpy
import numpy as np

import vb_library as L
import vb_assets as A

UV = 'vbUV'
_img_cache = {}
_mean_cache = {}
STATS = {'materials': 0, 'textured': 0, 'missing_tex': set(), 'unknown_keys': {}, 'by_key': {}}


# ------------------------------------------------------------------ colour helpers
def srgb_to_lin(c):
    c = max(0.0, min(1.0, c))
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_lin(h, a=1.0):
    h = h.lstrip('#')
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    return (srgb_to_lin(r), srgb_to_lin(g), srgb_to_lin(b), a)


def kelvin_rgb(k):
    """Approximate blackbody colour (linear RGB, normalised to max 1)."""
    t = k / 100.0
    if t <= 66:
        r = 255; g = 99.4708025861 * math.log(t) - 161.1195681661
        b = 0 if t <= 19 else 138.5177312231 * math.log(t - 10) - 305.0447927307
    else:
        r = 329.698727446 * ((t - 60) ** -0.1332047592); g = 288.1221695283 * ((t - 60) ** -0.0755148492); b = 255
    rgb = [srgb_to_lin(max(0, min(255, x)) / 255) for x in (r, g, b)]
    m = max(rgb)
    return tuple(x / m for x in rgb)


# ------------------------------------------------------------------ images
def load_img(path, colorspace):
    key = (path, colorspace)
    if key in _img_cache:
        return _img_cache[key]
    try:
        img = bpy.data.images.load(path, check_existing=True)
        img.colorspace_settings.name = colorspace
        _img_cache[key] = img
        return img
    except Exception as e:
        print('[mat] image load failed', path, e)
        return None


def reset_caches():
    _img_cache.clear(); _mean_cache.clear()
    STATS.update({'materials': 0, 'textured': 0, 'missing_tex': set(), 'unknown_keys': {}, 'by_key': {}})


def img_mean_rgb(img):
    """Mean linear RGB of an image (sRGB-decoded by Blender when colorspace is sRGB)."""
    if img is None:
        return (0.5, 0.5, 0.5)
    if img.name in _mean_cache:
        return _mean_cache[img.name]
    try:
        w, h = img.size
        px = np.empty(w * h * 4, dtype=np.float32)
        img.pixels.foreach_get(px)
        px = px.reshape(-1, 4)[::31, :3]
        m = tuple(max(0.01, float(x)) for x in px.mean(axis=0))
    except Exception:
        m = (0.5, 0.5, 0.5)
    _mean_cache[img.name] = m
    return m


def img_mean(img):
    r, g, b = img_mean_rgb(img)
    return max(0.02, 0.2126 * r + 0.7152 * g + 0.0722 * b)


# ------------------------------------------------------------------ node helpers
class NB:
    def __init__(self, mat):
        self.mat = mat
        self.nt = mat.node_tree
        self.n = self.nt.nodes
        self.l = self.nt.links
        self.x = -1600

    def node(self, t, **props):
        nd = self.n.new(t)
        nd.location = (self.x, 0)
        self.x += 40
        for k, v in props.items():
            try:
                setattr(nd, k, v)
            except Exception:
                pass
        return nd

    def link(self, a, b):
        if a is None or b is None:
            return
        self.l.new(a, b)

    def val(self, v):
        nd = self.node('ShaderNodeValue'); nd.outputs[0].default_value = v
        return nd.outputs[0]

    def rgb(self, c):
        nd = self.node('ShaderNodeRGB'); nd.outputs[0].default_value = c
        return nd.outputs[0]

    def math(self, op, a, b=None, clamp=False):
        nd = self.node('ShaderNodeMath', operation=op, use_clamp=clamp)
        for i, v in enumerate((a, b)):
            if v is None:
                continue
            if isinstance(v, (int, float)):
                nd.inputs[i].default_value = v
            else:
                self.link(v, nd.inputs[i])
        return nd.outputs[0]

    def mix(self, blend, a, b, fac, clamp=False):
        nd = self.node('ShaderNodeMix', data_type='RGBA', blend_type=blend, clamp_result=clamp)
        if isinstance(fac, (int, float)) and (fac > 1 or fac < 0):
            nd.clamp_factor = False
            nd.clamp_result = True     # extrapolated detail must never go negative (negative albedo!)
        ins = [s for s in nd.inputs if s.type == 'RGBA']
        fi = nd.inputs['Factor'] if 'Factor' in nd.inputs else nd.inputs[0]
        for s, v in ((fi, fac), (ins[0], a), (ins[1], b)):
            if isinstance(v, (int, float)):
                s.default_value = v
            elif isinstance(v, tuple):
                s.default_value = v
            else:
                self.link(v, s)
        out = [o for o in nd.outputs if o.type == 'RGBA'][0]
        return out

    def maprange(self, v, a, b, c, d, clamp=True, interp='LINEAR'):
        nd = self.node('ShaderNodeMapRange', clamp=clamp, interpolation_type=interp)
        self.link(v, nd.inputs['Value']) if not isinstance(v, (int, float)) else None
        nd.inputs['From Min'].default_value = a; nd.inputs['From Max'].default_value = b
        nd.inputs['To Min'].default_value = c; nd.inputs['To Max'].default_value = d
        return nd.outputs['Result']


def set_in(bsdf, names, v, nb=None):
    if isinstance(names, str):
        names = [names]
    for n in names:
        if n in bsdf.inputs:
            s = bsdf.inputs[n]
            if isinstance(v, (int, float, tuple)):
                try:
                    s.default_value = v
                except Exception:
                    pass
            elif v is not None and nb is not None:
                nb.link(v, s)
            return True
    return False


# ------------------------------------------------------------------ original glTF material info
def gltf_info(mat):
    info = {'color': (0.8, 0.8, 0.8, 1.0), 'alpha': 1.0, 'image': None, 'image_uv': None, 'alpha_img': False,
            'vcol': None, 'rough': 0.6, 'metal': 0.0, 'emis': (0, 0, 0, 1), 'emis_str': 0.0, 'trans': 0.0}
    if not mat or not mat.use_nodes:
        return info
    bsdf = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if not bsdf:
        return info
    try:
        info['color'] = tuple(bsdf.inputs['Base Color'].default_value)
        info['alpha'] = bsdf.inputs['Alpha'].default_value
        info['rough'] = bsdf.inputs['Roughness'].default_value
        info['metal'] = bsdf.inputs['Metallic'].default_value
        ec = 'Emission Color' if 'Emission Color' in bsdf.inputs else 'Emission'
        info['emis'] = tuple(bsdf.inputs[ec].default_value)
        info['emis_str'] = bsdf.inputs['Emission Strength'].default_value if 'Emission Strength' in bsdf.inputs else 1.0
        if 'Transmission Weight' in bsdf.inputs:
            info['trans'] = bsdf.inputs['Transmission Weight'].default_value
    except Exception:
        pass

    def walk(sock, depth=0):
        if depth > 6 or not sock.is_linked:
            return
        nd = sock.links[0].from_node
        if nd.type == 'TEX_IMAGE' and nd.image:
            info['image'] = nd.image
            if nd.inputs['Vector'].is_linked:
                up = nd.inputs['Vector'].links[0].from_node
                if up.type == 'UVMAP':
                    info['image_uv'] = up.uv_map
            return
        if nd.type in ('VERTEX_COLOR', 'ATTRIBUTE'):
            info['vcol'] = getattr(nd, 'layer_name', None) or getattr(nd, 'attribute_name', None) or 'Col'
        if nd.type == 'RGB':
            factors.append(tuple(nd.outputs[0].default_value))
        if nd.type in ('MIX', 'MIX_RGB'):
            # importer: Mix(MULTIPLY, <tex or vcol>, <baseColorFactor constant>)
            for i in nd.inputs:
                if getattr(i, 'type', '') == 'RGBA' and not i.is_linked:
                    factors.append(tuple(i.default_value))
        for i in nd.inputs:
            walk(i, depth + 1)
    factors = []
    if bsdf.inputs['Base Color'].is_linked:
        info['color'] = (1.0, 1.0, 1.0, 1.0)
    walk(bsdf.inputs['Base Color'])
    if factors:
        info['color'] = factors[0]
    if bsdf.inputs['Alpha'].is_linked:
        info['alpha_img'] = True
    # glTF importer packs emissive in Emission Color; when a lot of colour factor comes through 'Emission'
    return info


def parse_name(name, mat=None):
    base = name.split('.')[0] if name else ''
    # strip Blender duplicate suffixes like 'floor-main.001' (keys never contain dots) and our '~pkg' copies
    base = base.split('~')[0]
    key, _, variant = base.partition(':')
    key, variant = key.strip(), variant.strip()
    if key == 'unnamed' and variant:
        key, variant = variant, ''
    if L.recipe(key, 'atlantic') is None and mat is not None:
        sem = mat.get('semantic')
        if isinstance(sem, str) and L.recipe(sem, 'atlantic') is not None:
            key = sem
    return key, variant


# ------------------------------------------------------------------ texture block
def tex_block(nb, r, key, pkg, res):
    """Returns dict of sockets: color, rough, height, normal(color sock of normal map), has_tex"""
    ts = None
    if r.get('tex') or A.manifest_set(key, pkg):
        ts = A.texture_set(key, pkg, r.get('tex'), res)
        if not ts:
            STATS['missing_tex'].add(f"{key}:{r.get('tex')}")
    out = {'has_tex': False}
    size = r.get('size') or (ts.get('size') if ts else None) or 2.0
    if ts and ts.get('src') == 'manifest' and ts.get('size'):
        size = ts['size']
    uvn = nb.node('ShaderNodeUVMap', uv_map=UV)
    mp = nb.node('ShaderNodeMapping')
    s = 1.0 / max(size, 1e-3)
    mp.inputs['Scale'].default_value = (s, s, s)
    mp.inputs['Rotation'].default_value = (0, 0, math.radians(r.get('rot', 0)))
    # random offset per material so neighbouring surfaces do not repeat in sync
    h = (abs(hash(key)) % 997) / 997.0
    mp.inputs['Location'].default_value = (h * 3.1, h * 1.7, 0)
    nb.link(uvn.outputs['UV'], mp.inputs['Vector'])
    out['uv_m'] = uvn.outputs['UV']   # metres
    out['vec'] = mp.outputs['Vector']
    if not ts:
        return out
    maps = ts['maps']
    if maps.get('diff'):
        img = load_img(maps['diff'], 'sRGB')
        if img:
            t = nb.node('ShaderNodeTexImage', image=img, interpolation='Cubic')
            nb.link(mp.outputs['Vector'], t.inputs['Vector'])
            out['color'] = t.outputs['Color']; out['has_tex'] = True; out['img'] = img
    if maps.get('rough'):
        img = load_img(maps['rough'], 'Non-Color')
        if img:
            t = nb.node('ShaderNodeTexImage', image=img)
            nb.link(mp.outputs['Vector'], t.inputs['Vector'])
            out['rough'] = t.outputs['Color']
    if maps.get('nor'):
        img = load_img(maps['nor'], 'Non-Color')
        if img:
            t = nb.node('ShaderNodeTexImage', image=img)
            nb.link(mp.outputs['Vector'], t.inputs['Vector'])
            out['normal'] = t.outputs['Color']
    if maps.get('disp'):
        img = load_img(maps['disp'], 'Non-Color')
        if img:
            t = nb.node('ShaderNodeTexImage', image=img)
            nb.link(mp.outputs['Vector'], t.inputs['Vector'])
            out['height'] = t.outputs['Color']
    STATS['textured'] += 1
    return out


# ------------------------------------------------------------------ procedural overlays
def proc_tiles(nb, uv_m, color, td, rough):
    """Large-format tiles / grout lines on a base colour. Returns (color, rough, height)."""
    sep = nb.node('ShaderNodeSeparateXYZ'); nb.link(uv_m, sep.inputs[0])
    w, h, g = td.get('w', 0.6), td.get('h', 0.6), td.get('grout', 0.002)
    br = nb.node('ShaderNodeTexBrick', offset=td.get('offset', 0.0), offset_frequency=2, squash=1.0, squash_frequency=2)
    nb.link(uv_m, br.inputs['Vector'])
    br.inputs['Scale'].default_value = 1.0
    br.inputs['Mortar Size'].default_value = g
    br.inputs['Mortar Smooth'].default_value = 0.15
    br.inputs['Brick Width'].default_value = w
    br.inputs['Row Height'].default_value = h
    j = td.get('jitter', 0.03)
    br.inputs['Color1'].default_value = (1 - j, 1 - j, 1 - j, 1)
    br.inputs['Color2'].default_value = (1 + j, 1 + j * 0.9, 1 + j * 0.8, 1)
    br.inputs['Mortar'].default_value = (0, 0, 0, 1)
    tilecol = nb.mix('MULTIPLY', color, br.outputs['Color'], 1.0)
    grout = hex_lin(td.get('grout_color', '#bbbbbb'))
    col = nb.mix('MIX', tilecol, grout, br.outputs['Fac'])
    r2 = nb.math('MAXIMUM', rough if rough is not None else 0.3, nb.math('MULTIPLY', br.outputs['Fac'], 0.85))
    height = nb.math('SUBTRACT', 1.0, br.outputs['Fac'])
    return col, r2, height


def stripe_mask(nb, coord, period, width, axis=0):
    """1 on lines every `period` metres along axis (0=u, 1=v), smooth width `width` metres."""
    sep = nb.node('ShaderNodeSeparateXYZ'); nb.link(coord, sep.inputs[0])
    c = sep.outputs[axis]
    t = nb.math('DIVIDE', c, period)
    t = nb.math('ADD', t, 0.5)
    t = nb.math('FRACT', t)
    t = nb.math('SUBTRACT', t, 0.5)
    t = nb.math('ABSOLUTE', t)
    d = nb.math('MULTIPLY', t, period)            # metres to nearest line
    return nb.maprange(d, 0.0, width, 1.0, 0.0, interp='SMOOTHSTEP'), sep, c


def proc_azulejo(nb, uv_m, td):
    """Hand-painted cobalt-on-white Lisbon tile, 14 cm, with glaze variation. Returns (color, rough, height)."""
    size = td.get('w', 0.14)
    sep = nb.node('ShaderNodeSeparateXYZ'); nb.link(uv_m, sep.inputs[0])
    def local(c):
        t = nb.math('DIVIDE', c, size)
        f = nb.math('FRACT', t)
        return nb.math('SUBTRACT', f, 0.5), nb.math('FLOOR', t)
    lx, ix = local(sep.outputs[0]); ly, iy = local(sep.outputs[1])
    # radial
    r = nb.math('SQRT', nb.math('ADD', nb.math('MULTIPLY', lx, lx), nb.math('MULTIPLY', ly, ly)))
    th = nb.math('ARCTAN2', ly, lx)
    def band(v, c, w):
        return nb.maprange(nb.math('ABSOLUTE', nb.math('SUBTRACT', v, c)), w * 0.6, w, 1.0, 0.0)
    ring = band(r, 0.30, 0.035)
    petals = nb.math('ADD', 0.12, nb.math('MULTIPLY', nb.math('COSINE', nb.math('MULTIPLY', th, 8.0)), 0.06))
    flower = nb.maprange(nb.math('SUBTRACT', r, petals), -0.01, 0.01, 1.0, 0.0)
    dia = band(nb.math('ADD', nb.math('ABSOLUTE', lx), nb.math('ABSOLUTE', ly)), 0.47, 0.03)
    # quarter circles at the corners -> full circles across 4 tiles
    cx = nb.math('SUBTRACT', 0.5, nb.math('ABSOLUTE', lx)); cy = nb.math('SUBTRACT', 0.5, nb.math('ABSOLUTE', ly))
    rc = nb.math('SQRT', nb.math('ADD', nb.math('MULTIPLY', cx, cx), nb.math('MULTIPLY', cy, cy)))
    corner = nb.maprange(rc, 0.16, 0.18, 1.0, 0.0)
    corner_ring = band(rc, 0.24, 0.025)
    ink = nb.math('MAXIMUM', nb.math('MAXIMUM', ring, flower), nb.math('MAXIMUM', nb.math('MULTIPLY', dia, 0.0), nb.math('MAXIMUM', corner, corner_ring)))
    # brush irregularity
    nz = nb.node('ShaderNodeTexNoise'); nz.inputs['Scale'].default_value = 90.0; nz.inputs['Detail'].default_value = 4.0
    nb.link(uv_m, nz.inputs['Vector'])
    inkn = nb.math('MULTIPLY', ink, nb.maprange(nz.outputs['Fac'], 0.3, 0.7, 0.75, 1.0))
    white = hex_lin('#f1ece1'); cobalt = hex_lin('#1d4a8f')
    col = nb.mix('MIX', white, cobalt, inkn)
    # per tile glaze variation
    comb = nb.node('ShaderNodeCombineXYZ'); nb.link(ix, comb.inputs[0]); nb.link(iy, comb.inputs[1])
    wn = nb.node('ShaderNodeTexWhiteNoise', noise_dimensions='3D'); nb.link(comb.outputs[0], wn.inputs['Vector'])
    jit = nb.maprange(wn.outputs['Value'], 0, 1, 0.92, 1.06)
    jitc = nb.node('ShaderNodeCombineColor'); [nb.link(jit, jitc.inputs[i]) for i in range(3)]
    col = nb.mix('MULTIPLY', col, jitc.outputs[0], 1.0)
    # grout
    edge = nb.math('MAXIMUM', nb.math('ABSOLUTE', lx), nb.math('ABSOLUTE', ly))
    gw = td.get('grout', 0.0025) / size
    grout = nb.maprange(edge, 0.5 - gw * 1.6, 0.5 - gw * 0.2, 0.0, 1.0)
    col = nb.mix('MIX', col, hex_lin(td.get('grout_color', '#d9d3c6')), grout)
    # pillowed tile edges for the bump
    height = nb.maprange(edge, 0.40, 0.5, 1.0, 0.0, interp='SMOOTHSTEP')
    rough = nb.math('ADD', 0.08, nb.math('MULTIPLY', grout, 0.8))
    return col, rough, height


def quartz(nb, uv_m, base, speck='#a9a49c', dark=False):
    vo = nb.node('ShaderNodeTexVoronoi'); vo.inputs['Scale'].default_value = 260.0
    nb.link(uv_m, vo.inputs['Vector'])
    m = nb.maprange(vo.outputs['Distance'], 0.0, 0.18, 1.0, 0.0)
    nz = nb.node('ShaderNodeTexNoise'); nz.inputs['Scale'].default_value = 3.0; nz.inputs['Detail'].default_value = 6.0
    nb.link(uv_m, nz.inputs['Vector'])
    cloud = nb.maprange(nz.outputs['Fac'], 0.35, 0.65, 0.96, 1.04)
    cc = nb.node('ShaderNodeCombineColor'); [nb.link(cloud, cc.inputs[i]) for i in range(3)]
    col = nb.mix('MULTIPLY', base, cc.outputs[0], 1.0)
    col = nb.mix('MIX', col, hex_lin('#3a3836' if dark else speck), nb.math('MULTIPLY', m, 0.35))
    if dark:
        vo2 = nb.node('ShaderNodeTexVoronoi'); vo2.inputs['Scale'].default_value = 520.0
        nb.link(uv_m, vo2.inputs['Vector'])
        m2 = nb.maprange(vo2.outputs['Distance'], 0.0, 0.08, 1.0, 0.0)
        col = nb.mix('MIX', col, hex_lin('#77726c'), nb.math('MULTIPLY', m2, 0.5))
    return col


def vcol_node(nb, name):
    """Colour attribute reader (Attribute node works for any domain / data type)."""
    nd = nb.node('ShaderNodeAttribute'); nd.attribute_type = 'GEOMETRY'; nd.attribute_name = name
    class _W:  # mimic .outputs['Color']
        outputs = {'Color': nd.outputs['Color']}
    return _W


# ------------------------------------------------------------------ lit context windows (dusk / night)
def window_glow(nb, mat, cell_vec, mask, lw, cells=(3.1, 3.1, 2.9)):
    """Emission strength socket: `mask` (1 on glass) x a per-window on/off lottery (fraction lw['frac'] lit) x brightness variety.
    cell_vec: optional extra vector that identifies the window (atlas cell); the world position cell is always added."""
    geo = nb.node('ShaderNodeNewGeometry')
    dv = nb.node('ShaderNodeVectorMath', operation='DIVIDE'); dv.inputs[1].default_value = cells
    nb.link(geo.outputs['Position'], dv.inputs[0])
    fl = nb.node('ShaderNodeVectorMath', operation='FLOOR'); nb.link(dv.outputs['Vector'], fl.inputs[0])
    vec = fl.outputs['Vector']
    if cell_vec is not None:
        ad = nb.node('ShaderNodeVectorMath', operation='ADD'); nb.link(vec, ad.inputs[0]); nb.link(cell_vec, ad.inputs[1])
        vec = ad.outputs['Vector']
    wn = nb.node('ShaderNodeTexWhiteNoise', noise_dimensions='3D'); nb.link(vec, wn.inputs['Vector'])
    frac = max(0.01, min(1.0, float(lw.get('frac', 0.3))))
    lit = nb.math('LESS_THAN', wn.outputs['Value'], frac)
    vary = nb.maprange(wn.outputs['Value'], 0.0, frac, 0.35, 1.0)
    e = nb.math('MULTIPLY', nb.math('MULTIPLY', lit, vary), float(lw.get('strength', 0.03)))
    if mask is not None:
        e = nb.math('MULTIPLY', e, mask)
    try:
        mat.cycles.emission_sampling = 'NONE'      # seen by the camera and by bounces, never sampled as a lamp
    except Exception:
        pass
    return e


def atlas_window_mask(nb, atlas_color):
    """1 where the facade atlas shows glass (dark and bluish), 0 on render / blinds / sills."""
    sep = nb.node('ShaderNodeSeparateColor'); nb.link(atlas_color, sep.inputs[0])
    bw = nb.node('ShaderNodeRGBToBW'); nb.link(atlas_color, bw.inputs[0])
    blue = nb.math('GREATER_THAN', sep.outputs[2], nb.math('MULTIPLY', sep.outputs[0], 1.12))
    dark = nb.math('LESS_THAN', bw.outputs[0], 0.3)
    return nb.math('MULTIPLY', blue, dark)


# ------------------------------------------------------------------ main builder
def build(mat, key, variant, pkg, opts):
    """Rebuild `mat` in place according to the recipe for key/pkg. Returns recipe used (or None)."""
    r = L.recipe(key, pkg, variant.split(':')[0] if variant else '')
    info = gltf_info(mat)
    if mat.get('vb_vcol'):
        # the real attribute name on the meshes (the importer's node may say 'Col' while the attribute is 'Color')
        if info['vcol'] or key in ('render-white', 'render-cream', 'render-pink', 'roof-tile-terracotta', 'foliage'):
            info['vcol'] = mat['vb_vcol']
    if opts.get('debug_mats') is not None:
        opts['debug_mats'].append(f"{mat.name}: key={key} col={tuple(round(c, 3) for c in info['color'][:3])} vcol={info['vcol']} img={info['image'].name if info['image'] else None} uv={info['image_uv']}")
    if r is None:
        STATS['unknown_keys'][key] = STATS['unknown_keys'].get(key, 0) + 1
        return generic_upgrade(mat, info, key)
    STATS['by_key'][key] = STATS['by_key'].get(key, 0) + 1
    res = opts.get('tex_res', '2k')
    nt = mat.node_tree
    nt.nodes.clear()
    nb = NB(mat)
    outn = nb.node('ShaderNodeOutputMaterial'); outn.location = (600, 0)
    shader = r.get('shader', 'principled')
    mat['vb_key'] = key
    mat['vb_variant'] = variant.split(':')[0] if variant else ''
    mat['vb_shader'] = shader
    STATS['materials'] += 1

    lw = opts.get('lit_windows')
    base_name = mat.name.split('.')[0].split('~')[0]
    if lw and key == 'glass-window' and mat['vb_variant'] == 'context':
        # neighbours' windows after dark: dark reflective panes, a share of them lit warm from inside
        b = nb.node('ShaderNodeBsdfPrincipled')
        set_in(b, 'Base Color', hex_lin('#141a20')); set_in(b, 'Roughness', 0.06); set_in(b, ['Specular IOR Level', 'Specular'], 0.6)
        e = window_glow(nb, mat, None, None, lw, cells=(1.7, 1.7, 1.5))
        set_in(b, ['Emission Color', 'Emission'], (*kelvin_rgb(lw.get('kelvin', 2900)), 1.0))
        set_in(b, 'Emission Strength', e, nb)
        nb.link(b.outputs[0], outn.inputs['Surface'])
        mat['vb_shader'] = 'principled'
        return r

    # ----- simple special shaders
    if shader == 'glass_thin':
        col = hex_lin(r.get('color', '#f0f4f3'))
        # window 'ND film' for camera rays only (set per shot by the exposure metering; 1 = clear glass)
        nd = nb.node('ShaderNodeValue'); nd.name = 'vbND'; nd.outputs[0].default_value = 1.0
        lp = nb.node('ShaderNodeLightPath')
        f = nb.math('ADD', nb.math('MULTIPLY', lp.outputs['Is Camera Ray'], nb.math('SUBTRACT', nd.outputs[0], 1.0)), 1.0)
        fc = nb.node('ShaderNodeCombineColor'); [nb.link(f, fc.inputs[i]) for i in range(3)]
        tcol = nb.mix('MULTIPLY', col, fc.outputs[0], 1.0)
        tr = nb.node('ShaderNodeBsdfTransparent'); nb.link(tcol, tr.inputs[0])
        gl = nb.node('ShaderNodeBsdfGlossy', distribution='GGX'); gl.inputs['Roughness'].default_value = 0.0
        fr = nb.node('ShaderNodeFresnel'); fr.inputs['IOR'].default_value = r.get('ior', 1.52)
        fac = nb.math('MULTIPLY', fr.outputs[0], r.get('refl', 1.0))
        mx = nb.node('ShaderNodeMixShader')
        nb.link(fac, mx.inputs[0]); nb.link(tr.outputs[0], mx.inputs[1]); nb.link(gl.outputs[0], mx.inputs[2])
        surf = mx.outputs[0]
        if r.get('body'):
            df = nb.node('ShaderNodeBsdfDiffuse'); df.inputs['Color'].default_value = hex_lin('#d5e6df')
            m2 = nb.node('ShaderNodeMixShader'); m2.inputs[0].default_value = r['body']
            nb.link(surf, m2.inputs[1]); nb.link(df.outputs[0], m2.inputs[2]); surf = m2.outputs[0]
        nb.link(surf, outn.inputs['Surface'])
        return r
    if shader == 'glass_solid':
        g = nb.node('ShaderNodeBsdfGlass', distribution='MULTI_GGX')
        g.inputs['Color'].default_value = hex_lin(r.get('color', '#f6faf8')); g.inputs['IOR'].default_value = r.get('ior', 1.5)
        g.inputs['Roughness'].default_value = 0.0
        nb.link(g.outputs[0], outn.inputs['Surface'])
        return r
    if shader == 'mirror':
        b = nb.node('ShaderNodeBsdfPrincipled')
        set_in(b, 'Base Color', hex_lin(r.get('color', '#e9ece9'))); set_in(b, 'Metallic', 1.0); set_in(b, 'Roughness', 0.015)
        nb.link(b.outputs[0], outn.inputs['Surface'])
        return r
    if shader == 'emit':
        strength, kelvin = r.get('emit', (10.0, 2700))
        c = kelvin_rgb(kelvin)
        em = nb.node('ShaderNodeEmission'); em.inputs['Color'].default_value = (*c, 1); em.inputs['Strength'].default_value = strength * opts.get('emit_scale', 1.0)
        # visible to camera / reflections; the real lights (vb_lighting) do the illumination -> no double counting, less noise
        lp = nb.node('ShaderNodeLightPath')
        vis = nb.math('MAXIMUM', lp.outputs['Is Camera Ray'], lp.outputs['Is Glossy Ray'])
        dif = nb.node('ShaderNodeBsdfDiffuse'); dif.inputs['Color'].default_value = (*c, 1)
        mx = nb.node('ShaderNodeMixShader')
        nb.link(vis, mx.inputs[0]); nb.link(dif.outputs[0], mx.inputs[1]); nb.link(em.outputs[0], mx.inputs[2])
        nb.link(mx.outputs[0], outn.inputs['Surface'])
        # not a light source for NEE: the real lamps created in vb_scene do the lighting (huge speed-up)
        try:
            mat.cycles.emission_sampling = 'NONE'
        except Exception:
            pass
        return r
    if shader == 'water':
        b = nb.node('ShaderNodeBsdfPrincipled')
        set_in(b, 'Base Color', hex_lin(r.get('color', '#3d5a66'))); set_in(b, 'Roughness', 0.04); set_in(b, 'Specular IOR Level', 0.5)
        nz = nb.node('ShaderNodeTexNoise'); nz.inputs['Scale'].default_value = 0.6; nz.inputs['Detail'].default_value = 8
        geo = nb.node('ShaderNodeNewGeometry'); nb.link(geo.outputs['Position'], nz.inputs['Vector'])
        bp = nb.node('ShaderNodeBump'); bp.inputs['Strength'].default_value = 0.3; bp.inputs['Distance'].default_value = 0.05
        nb.link(nz.outputs['Fac'], bp.inputs['Height']); nb.link(bp.outputs[0], b.inputs['Normal'])
        nb.link(b.outputs[0], outn.inputs['Surface'])
        return r

    # ----- principled-based shaders
    tb = tex_block(nb, r, key, pkg, res)
    uv_m = tb['uv_m']
    geo = nb.node('ShaderNodeNewGeometry')

    # base colour.  Images that survived the exporter (window atlases, cut-outs, bay numbers) are always kept;
    # per-vertex colours (OSM building colours in context.glb) always drive the colour.
    if info['image'] is not None:
        r['keep_map'] = True
    if info['vcol'] and not r.get('keep_map'):
        r['keep_color'] = True
    color = None
    if r.get('keep_map') and info['image'] is not None:
        t = nb.node('ShaderNodeTexImage', image=info['image'])
        if info['image_uv']:
            u2 = nb.node('ShaderNodeUVMap', uv_map=info['image_uv']); nb.link(u2.outputs['UV'], t.inputs['Vector'])
        color = nb.mix('MULTIPLY', t.outputs['Color'], info['color'], 1.0)
        tb['atlas'] = t.outputs['Color']
        tb['atlas_uv'] = u2.outputs['UV'] if info['image_uv'] else nb.node('ShaderNodeTexCoord').outputs['UV']
        if info['vcol']:
            va = vcol_node(nb, info['vcol'])
            color = nb.mix('MULTIPLY', color, va.outputs['Color'], 1.0)
        if info['alpha_img']:
            tb['alpha'] = t.outputs['Alpha']
    elif r.get('proc') == 'azulejo':
        color, aro, aheight = proc_azulejo(nb, uv_m, r.get('tiles', {}))
        tb['rough_proc'] = aro; tb['height_proc'] = aheight
    elif tb.get('color') is not None:
        color = tb['color']
        if r.get('invert'):
            inv = nb.node('ShaderNodeInvert'); nb.link(color, inv.inputs['Color']); color = inv.outputs['Color']
        if r.get('hsv') and not r.get('tint'):
            hs = nb.node('ShaderNodeHueSaturation')
            hs.inputs['Hue'].default_value, hs.inputs['Saturation'].default_value, hs.inputs['Value'].default_value = r['hsv']
            nb.link(color, hs.inputs['Color']); color = hs.outputs['Color']
        if r.get('keep_color'):
            # GLB colour (chosen by the realtime module per item) x texture detail normalised to mean 1
            m = img_mean(tb.get('img'))
            bw = nb.node('ShaderNodeRGBToBW'); nb.link(color, bw.inputs[0])
            det = nb.math('DIVIDE', bw.outputs[0], m)
            det = nb.maprange(det, 0.0, 2.0, 0.35, 1.65, clamp=False)
            dc = nb.node('ShaderNodeCombineColor'); [nb.link(det, dc.inputs[i]) for i in range(3)]
            base = info['color'] if info['color'][:3] != (0.8, 0.8, 0.8) else hex_lin(r.get('color', '#cccccc'))
            if info['vcol']:
                va = vcol_node(nb, info['vcol'])
                bcol = nb.mix('MULTIPLY', va.outputs['Color'], base, 1.0)
            else:
                bcol = base
            color = nb.mix('MULTIPLY', bcol, dc.outputs[0], 1.0)
        elif r.get('tint'):
            # tint = the target MEAN albedo (sRGB hex); the texture only contributes detail around it
            m = img_mean_rgb(tb.get('img'))
            if r.get('hsv') and tb.get('img') is not None:
                m = img_mean_rgb(tb.get('img'))  # hsv shifts are small; mean of the raw map is good enough
            tgt = hex_lin(r['tint'])
            k = r.get('detail', 1.0)
            sc = tuple(tgt[i] / m[i] for i in range(3))
            det = nb.mix('MULTIPLY', color, (*sc, 1.0), 1.0)
            if k != 1.0:
                det = nb.mix('MIX', (*tgt[:3], 1.0), det, k)
            color = det
    else:
        if r.get('keep_color'):
            base = info['color']
            if info['image'] is not None:
                t = nb.node('ShaderNodeTexImage', image=info['image'])
                if info['image_uv']:
                    u2 = nb.node('ShaderNodeUVMap', uv_map=info['image_uv']); nb.link(u2.outputs['UV'], t.inputs['Vector'])
                color = nb.mix('MULTIPLY', t.outputs['Color'], base, 1.0)
                if info['alpha_img']:
                    tb['alpha'] = t.outputs['Alpha']
            elif info['vcol']:
                va = vcol_node(nb, info['vcol'])
                color = nb.mix('MULTIPLY', va.outputs['Color'], base, 1.0)
            else:
                color = nb.rgb(base)
        else:
            color = nb.rgb(hex_lin(r.get('color', '#cccccc')))

    if r.get('proc') == 'quartz':
        color = quartz(nb, uv_m, color)
    elif r.get('proc') == 'speckle':
        color = quartz(nb, uv_m, color, dark=True)

    # large-scale variation (breaks up CG uniformity)
    var = r.get('var', 0.03)
    if shader == 'foliage':
        # per-leaf / per-instance tone variation (yellowing, sun-bleached, dark)
        oi = nb.node('ShaderNodeObjectInfo')
        f0 = nb.maprange(oi.outputs['Random'], 0, 1, 0.7, 1.2)
        c0 = nb.node('ShaderNodeCombineColor'); nb.link(f0, c0.inputs[0]); nb.link(f0, c0.inputs[1]); nb.link(nb.math('MULTIPLY', f0, 0.9), c0.inputs[2])
        color = nb.mix('MULTIPLY', color, c0.outputs[0], 1.0)
    if var > 0:
        nz = nb.node('ShaderNodeTexNoise'); nz.inputs['Scale'].default_value = 0.45; nz.inputs['Detail'].default_value = 3.0
        nz.inputs['Roughness'].default_value = 0.55
        nb.link(geo.outputs['Position'], nz.inputs['Vector'])
        f = nb.maprange(nz.outputs['Fac'], 0.3, 0.7, 1.0 - var, 1.0 + var)
        fc = nb.node('ShaderNodeCombineColor'); [nb.link(f, fc.inputs[i]) for i in range(3)]
        color = nb.mix('MULTIPLY', color, fc.outputs[0], 1.0)
        tb['var_fac'] = nz.outputs['Fac']

    # roughness
    rr = r.get('rough', 0.5)
    if tb.get('rough') is not None and isinstance(rr, (tuple, list)):
        bw = nb.node('ShaderNodeRGBToBW'); nb.link(tb['rough'], bw.inputs[0])
        rough = nb.maprange(bw.outputs[0], 0.0, 1.0, rr[0], rr[1])
    else:
        rv = rr if isinstance(rr, (int, float)) else (rr[0] + rr[1]) / 2
        if var > 0 and tb.get('var_fac') is not None:
            rough = nb.maprange(tb['var_fac'], 0.3, 0.7, max(0.0, rv - 0.06), min(1.0, rv + 0.06))
        else:
            rough = nb.val(rv)
    if tb.get('rough_proc') is not None:
        rough = tb['rough_proc']

    height = tb.get('height_proc')
    if r.get('proc') == 'tiles':
        color, rough, height = proc_tiles(nb, uv_m, color, r.get('tiles', {}), rough)
    elif r.get('proc') == 'seam':
        m, sep, u = stripe_mask(nb, uv_m, r.get('seam', 0.43), 0.012, axis=0)
        height = m
        # per-panel tone variation (pre-weathered zinc is never uniform)
        pid = nb.math('FLOOR', nb.math('DIVIDE', u, r.get('seam', 0.43)))
        cmb = nb.node('ShaderNodeCombineXYZ'); nb.link(pid, cmb.inputs[0])
        wn = nb.node('ShaderNodeTexWhiteNoise', noise_dimensions='3D'); nb.link(cmb.outputs[0], wn.inputs['Vector'])
        pv = nb.maprange(wn.outputs['Value'], 0, 1, 0.9, 1.1)
        pc = nb.node('ShaderNodeCombineColor'); [nb.link(pv, pc.inputs[i]) for i in range(3)]
        color = nb.mix('MULTIPLY', color, pc.outputs[0], 1.0)
        nz2 = nb.node('ShaderNodeTexNoise'); nz2.inputs['Scale'].default_value = 3.0; nz2.inputs['Detail'].default_value = 8.0
        nb.link(geo.outputs['Position'], nz2.inputs['Vector'])
        rough = nb.maprange(nz2.outputs['Fac'], 0.3, 0.7, 0.32, 0.52)
    elif r.get('proc') == 'fluted':
        p = r.get('flute', 0.025)
        sep = nb.node('ShaderNodeSeparateXYZ'); nb.link(uv_m, sep.inputs[0])
        # vertical flutes: fronts are vertical faces, u = horizontal
        s = nb.math('SINE', nb.math('MULTIPLY', sep.outputs[0], math.pi / p))
        height = nb.math('ABSOLUTE', s)
    elif r.get('proc') == 'stripes':
        m, _, _ = stripe_mask(nb, uv_m, r.get('stripe', 0.5), 0.006, axis=1)
        height = nb.math('SUBTRACT', 1.0, m)
    elif r.get('proc') == 'microcement':
        nz = nb.node('ShaderNodeTexNoise'); nz.inputs['Scale'].default_value = 1.6; nz.inputs['Detail'].default_value = 9.0
        nz.inputs['Roughness'].default_value = 0.65
        nb.link(uv_m, nz.inputs['Vector'])
        f = nb.maprange(nz.outputs['Fac'], 0.25, 0.75, 0.82, 1.14)
        fc = nb.node('ShaderNodeCombineColor'); [nb.link(f, fc.inputs[i]) for i in range(3)]
        color = nb.mix('MULTIPLY', color, fc.outputs[0], 1.0)
        rough = nb.maprange(nz.outputs['Fac'], 0.25, 0.75, 0.42, 0.68)

    # ----- BSDF
    b = nb.node('ShaderNodeBsdfPrincipled')
    b.location = (300, 0)
    nb.link(color, b.inputs['Base Color'])
    nb.link(rough, b.inputs['Roughness'])
    set_in(b, 'Metallic', float(r.get('metal', 0.0)))
    set_in(b, ['Specular IOR Level', 'Specular'], float(r.get('spec', 0.5)))
    if r.get('coat'):
        set_in(b, ['Coat Weight', 'Clearcoat'], float(r['coat'])); set_in(b, ['Coat Roughness', 'Clearcoat Roughness'], float(r.get('coat_rough', 0.05)))
    if r.get('sheen'):
        set_in(b, ['Sheen Weight', 'Sheen'], float(r['sheen'])); set_in(b, 'Sheen Roughness', float(r.get('sheen_rough', 0.4)))
        set_in(b, 'Sheen Tint', (1, 1, 1, 1))
    if r.get('sss'):
        set_in(b, ['Subsurface Weight', 'Subsurface'], float(r['sss'])); set_in(b, 'Subsurface Scale', 0.01)
    if r.get('aniso'):
        set_in(b, ['Anisotropic'], float(r['aniso']))
        tg = nb.node('ShaderNodeTangent', direction_type='UV_MAP', uv_map=UV)
        nb.link(tg.outputs[0], b.inputs['Tangent'])

    if lw and tb.get('atlas') is not None and base_name in ('env-facade', 'env-city'):
        # window atlas of the neighbouring facades: light a share of the glass panes
        sc4 = nb.node('ShaderNodeVectorMath', operation='SCALE'); sc4.inputs['Scale'].default_value = 4.0
        nb.link(tb['atlas_uv'], sc4.inputs[0])
        fl4 = nb.node('ShaderNodeVectorMath', operation='FLOOR'); nb.link(sc4.outputs['Vector'], fl4.inputs[0])
        sc7 = nb.node('ShaderNodeVectorMath', operation='SCALE'); sc7.inputs['Scale'].default_value = 7.31
        nb.link(fl4.outputs['Vector'], sc7.inputs[0])
        e = window_glow(nb, mat, sc7.outputs['Vector'], atlas_window_mask(nb, tb['atlas']), lw)
        set_in(b, ['Emission Color', 'Emission'], (*kelvin_rgb(lw.get('kelvin', 2900)), 1.0))
        set_in(b, 'Emission Strength', e, nb)

    # ----- normals: normal map -> bump (tiles/seams/height) -> bevel
    nrm = None
    if tb.get('normal') is not None and not r.get('keep_map'):
        nm = nb.node('ShaderNodeNormalMap', space='TANGENT', uv_map=UV)
        nm.inputs['Strength'].default_value = r.get('normal', 1.0)
        nb.link(tb['normal'], nm.inputs['Color']); nrm = nm.outputs['Normal']
    hsrc = height
    hdist = 0.002
    if hsrc is None and r.get('bump') and tb.get('height') is not None and tb.get('normal') is None:
        hsrc = tb['height']
    if r.get('proc') == 'seam':
        hdist = 0.02
    elif r.get('proc') in ('fluted',):
        hdist = 0.004
    elif r.get('proc') in ('tiles', 'azulejo', 'stripes'):
        hdist = 0.0015
    if hsrc is not None:
        bp = nb.node('ShaderNodeBump'); bp.inputs['Strength'].default_value = 1.0 if r.get('proc') else r.get('bump', 0.3)
        bp.inputs['Distance'].default_value = hdist
        nb.link(hsrc, bp.inputs['Height'])
        if nrm is not None:
            nb.link(nrm, bp.inputs['Normal'])
        nrm = bp.outputs['Normal']
    if r.get('bevel') and opts.get('bevel', True):
        bv = nb.node('ShaderNodeBevel', samples=6); bv.inputs['Radius'].default_value = r['bevel']
        if nrm is not None:
            nb.link(nrm, bv.inputs['Normal'])
        nrm = bv.outputs['Normal']
    if nrm is not None:
        nb.link(nrm, b.inputs['Normal'])

    surf = b.outputs[0]
    if r.get('trans_weight'):
        set_in(b, ['Transmission Weight', 'Transmission'], float(r['trans_weight']))
    if r.get('backface'):
        bf = nb.node('ShaderNodeBsdfDiffuse'); bf.inputs['Color'].default_value = hex_lin(r['backface'])
        mxb = nb.node('ShaderNodeMixShader')
        nb.link(geo.outputs['Backfacing'], mxb.inputs[0]); nb.link(surf, mxb.inputs[1]); nb.link(bf.outputs[0], mxb.inputs[2])
        surf = mxb.outputs[0]
    # translucency (foliage, curtains, lampshades, grass)
    if shader in ('foliage', 'lampshade', 'sheer') or r.get('trans'):
        tl = nb.node('ShaderNodeBsdfTranslucent'); nb.link(color, tl.inputs['Color'])
        if nrm is not None:
            nb.link(nrm, tl.inputs['Normal'])
        mx = nb.node('ShaderNodeMixShader')
        mx.inputs[0].default_value = 0.55 if shader == 'lampshade' else (0.5 if shader == 'sheer' else r.get('trans', 0.3))
        nb.link(surf, mx.inputs[1]); nb.link(tl.outputs[0], mx.inputs[2]); surf = mx.outputs[0]
        if shader in ('lampshade', 'sheer'):
            set_in(b, 'Roughness', 1.0)
    # alpha: sheer curtains / alpha-tested leaves / transparent glTF materials
    alpha = None
    if shader == 'sheer':
        alpha = r.get('alpha', 0.45)
    elif tb.get('alpha') is not None:
        alpha = tb['alpha']
    elif info['alpha_img'] and info['image'] is not None:
        t = nb.node('ShaderNodeTexImage', image=info['image'])
        if info['image_uv']:
            u2 = nb.node('ShaderNodeUVMap', uv_map=info['image_uv']); nb.link(u2.outputs['UV'], t.inputs['Vector'])
        alpha = t.outputs['Alpha']
    if alpha is not None:
        tr = nb.node('ShaderNodeBsdfTransparent')
        mx = nb.node('ShaderNodeMixShader')
        if isinstance(alpha, float):
            mx.inputs[0].default_value = alpha
        else:
            # alpha-tested cut-outs: hard threshold avoids grey fringes
            a2 = nb.math('GREATER_THAN', alpha, 0.45)
            nb.link(a2, mx.inputs[0])
        nb.link(tr.outputs[0], mx.inputs[1]); nb.link(surf, mx.inputs[2]); surf = mx.outputs[0]
    nb.link(surf, outn.inputs['Surface'])
    return r


def generic_upgrade(mat, info, key):
    """Unknown/unnamed material: keep glTF colour, add realism (micro roughness variation, no pure black/white)."""
    if not mat.use_nodes:
        return None
    bsdf = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if not bsdf:
        return None
    try:
        c = bsdf.inputs['Base Color'].default_value
        if not bsdf.inputs['Base Color'].is_linked:
            bsdf.inputs['Base Color'].default_value = tuple(min(0.85, max(0.015, v)) for v in c[:3]) + (1.0,)
        if not bsdf.inputs['Roughness'].is_linked:
            bsdf.inputs['Roughness'].default_value = max(0.25, bsdf.inputs['Roughness'].default_value)
        # glTF transmission -> thin glass
        if info['trans'] > 0.3 or (info['alpha'] < 0.6 and not info['alpha_img']):
            nb = NB(mat)
            out = next(n for n in mat.node_tree.nodes if n.type == 'OUTPUT_MATERIAL')
            tr = nb.node('ShaderNodeBsdfTransparent'); tr.inputs[0].default_value = (0.95, 0.97, 0.96, 1)
            gl = nb.node('ShaderNodeBsdfGlossy'); gl.inputs['Roughness'].default_value = 0.0
            fr = nb.node('ShaderNodeFresnel'); fr.inputs['IOR'].default_value = 1.5
            mx = nb.node('ShaderNodeMixShader')
            nb.link(fr.outputs[0], mx.inputs[0]); nb.link(tr.outputs[0], mx.inputs[1]); nb.link(gl.outputs[0], mx.inputs[2])
            nb.link(mx.outputs[0], out.inputs['Surface'])
        # glTF emissive kept for the camera (lit windows, signage) but never sampled as a light
        try:
            if info['emis_str'] > 0 and max(info['emis'][:3]) > 0:
                mat.cycles.emission_sampling = 'NONE'
        except Exception:
            pass
    except Exception as e:
        print('[mat] generic upgrade failed', mat.name, e)
    return None


def apply_all(pkg_for_object, opts, only_new=False):
    """Rebuild every material used in the scene. pkg_for_object(obj) -> package id for that object's materials."""
    done = {}
    for ob in bpy.data.objects:
        if ob.type == 'MESH' and len(ob.data.color_attributes):
            ca = ob.data.color_attributes[0].name
            for slot in ob.material_slots:
                if slot.material is not None and 'vb_vcol' not in slot.material:
                    slot.material['vb_vcol'] = ca
    for ob in bpy.data.objects:
        if ob.type != 'MESH':
            continue
        pkg = pkg_for_object(ob)
        for slot in ob.material_slots:
            m = slot.material
            if m is None:
                continue
            key, variant = parse_name(m.name, m)
            k = (m.name, pkg)
            if k in done:
                if done[k] is not m:
                    slot.material = done[k]
                continue
            if only_new and m.get('vb_done'):
                continue
            # a material shared between packages must be duplicated
            owner = m.get('vb_pkg')
            if owner is not None and owner != (pkg or ''):
                m2 = m.copy(); m2.name = m.name.split('.')[0] + '~' + (pkg or 'x')
                slot.material = m2; m = m2
            m['vb_pkg'] = pkg or ''
            m['vb_done'] = 1
            try:
                build(m, key, variant, pkg, opts)
            except Exception as e:
                import traceback; traceback.print_exc()
                print('[mat] build failed', m.name, e)
            done[k] = m
    return STATS
