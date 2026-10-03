"""Signage: the realtime scene draws every sign as a canvas-textured plane; the exporter strips those textures, so the planes
arrive as flat (often emissive) rectangles. Here each known sign plane gets real text (Blender font curves) and a proper plate:
  bg None  -> the plane is hidden (free-standing lettering, e.g. the illuminated house number "6 VILNYI Rua Eduardo Couto")
  bg '#..' -> the plane becomes the plate (painted / bronze / brass), lettering in front of it
Run after the materials are built and BEFORE emissive meshes are turned into lights."""
import math, os
import bpy
from mathutils import Vector, Matrix

import vb_materials as M

# object name -> spec.  glow = emission strength of the lettering (0 = painted)
SIGNS = {
    'house-number':             dict(text='6', bg=None, fg='#fff0d6', glow=5.0, h=0.80, serif=True),
    'sign-VILNYI':              dict(text='VILNYI', bg=None, fg='#fff0d6', glow=4.0, h=0.66, serif=True, spacing=1.25),
    'sign-Rua-Eduardo-Couto':   dict(text='Rua Eduardo Couto', bg=None, fg='#e8d9b8', glow=2.5, h=0.62),
    'lobby-logo':               dict(text='VILNYI', bg='#2b2118', fg='#ffe2b0', glow=4.0, h=0.42, serif=True, spacing=1.3, metal=0.5),
    'mailbox-labels':           dict(text=None, bg=None),
    'sign-CORREIO':             dict(text='CORREIO', bg=None, fg='#6b5a44', glow=0.0, h=0.7),
    'sign-ESCADAS-GARAGEM--1':  dict(text='ESCADAS  ·  GARAGEM -1', bg='#4a3a2a', fg='#ffe7c2', glow=2.0, h=0.5),
    'sign-ELEVADOR-GARAGEM--1': dict(text='ELEVADOR  ·  GARAGEM -1', bg='#4a3a2a', fg='#ffe7c2', glow=2.0, h=0.5),
    'sign-ELEVADOR-SA-DA':      dict(text='ELEVADOR · SAÍDA', bg='#1c7a45', fg='#ffffff', glow=2.5, h=0.52),
    'sign-SA-DA':               dict(text='SAÍDA', bg='#1c7a45', fg='#ffffff', glow=2.5, h=0.52),
    'sign-INC-NDIO':            dict(text='INCÊNDIO', bg='#b3261e', fg='#ffffff', glow=0.0, h=0.52),
    'sign--REA-T-CNICA':        dict(text='ÁREA TÉCNICA', bg='#2a2c2f', fg='#f2efe8', glow=0.0, h=0.52),
    'sign-PISO--1':             dict(text='PISO -1', bg='#22262b', fg='#e8d9b8', glow=0.0, h=0.52),
    'sign-ALTURA-M-X.-2-10-m':  dict(text='ALTURA MÁX. 2,10 m', bg='#e6b520', fg='#17181a', glow=0.0, h=0.5),
    'sign-P':                   dict(text='P', bg='#1d4f9c', fg='#ffffff', glow=0.0, h=0.7),
}
LIFT = {'basement': '-1', 'ground': '0', 'first': '1', 'second': '2'}


def spec_for(name):
    base = name[:-4] if name[-4:-3] == '.' and name[-3:].isdigit() else name     # Blender duplicate suffix .001
    if base in SIGNS:
        return SIGNS[base]
    if base.startswith('unit-plate-'):
        return dict(text=base[len('unit-plate-'):], bg='#b89556', fg='#2b2219', glow=0.0, h=0.6, metal=0.8, serif=True)
    if base.startswith('lift-indicator-'):
        return dict(text=LIFT.get(base[len('lift-indicator-'):], ''), bg='#0d0d0f', fg='#ffcf8a', glow=3.0, h=0.62)
    if base.startswith('sign-P') and len(base) > 7 and base[6].isdigit():
        p = base[5:].split('-', 1)              # sign-P1-0.A -> P1 · 0.A
        return dict(text=' · '.join(p), bg='#2a2c2f', fg='#f2efe8', glow=0.0, h=0.52)
    return None


_fonts = {}


def font(serif):
    key = 'serif' if serif else 'sans'
    if key not in _fonts:
        f = None
        for p in (['/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf', '/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf'] if serif
                  else ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf']):
            if os.path.exists(p):
                try:
                    f = bpy.data.fonts.load(p)
                    break
                except Exception:
                    f = None
        _fonts[key] = f
    return _fonts[key]


def _mat(name, color, glow=0.0, metal=0.0, rough=0.5):
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree; nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    c = M.hex_lin(color)
    if glow > 0:
        e = nt.nodes.new('ShaderNodeEmission'); e.inputs['Color'].default_value = c; e.inputs['Strength'].default_value = glow
        nt.links.new(e.outputs[0], out.inputs['Surface'])
        try:
            m.cycles.emission_sampling = 'NONE'
        except Exception:
            pass
    else:
        b = nt.nodes.new('ShaderNodeBsdfPrincipled')
        b.inputs['Base Color'].default_value = c; b.inputs['Roughness'].default_value = rough; b.inputs['Metallic'].default_value = metal
        nt.links.new(b.outputs[0], out.inputs['Surface'])
    m['vb_sign'] = 1
    return m


def apply(log=print):
    made = hidden = 0
    for ob in [o for o in bpy.data.objects if o.type == 'MESH' and o.get('vb_src') == 'building']:
        sp = spec_for(ob.name)
        if sp is None or not ob.data.polygons:
            continue
        mw = ob.matrix_world
        pts = [mw @ v.co for v in ob.data.vertices]
        c = sum(pts, Vector()) / len(pts)
        n = (mw.to_3x3() @ ob.data.polygons[0].normal).normalized()
        if abs(n.z) > 0.7:
            continue                                      # floor graphics keep their own (exported) texture
        n = Vector((n.x, n.y, 0)).normalized()
        up = Vector((0, 0, 1)); right = up.cross(n).normalized()
        w = max((p - c).dot(right) for p in pts) - min((p - c).dot(right) for p in pts)
        h = max(p.z for p in pts) - min(p.z for p in pts)
        if sp.get('bg') is None:
            ob.hide_render = True; ob.hide_viewport = True; hidden += 1
        else:
            bm = _mat('vbSignBg-' + ob.name, sp['bg'], 0.0, sp.get('metal', 0.0), 0.35 if sp.get('metal') else 0.5)
            for sl in ob.material_slots:
                sl.material = bm
        if not sp.get('text'):
            continue
        cu = bpy.data.curves.new('vbSignText-' + ob.name, 'FONT')
        cu.body = sp['text']; cu.align_x = 'CENTER'; cu.align_y = 'CENTER'
        cu.size = max(0.01, h * sp.get('h', 0.6)); cu.extrude = 0.0008
        try:
            cu.space_character = sp.get('spacing', 1.0)
        except Exception:
            pass
        f = font(sp.get('serif', False))
        if f is not None:
            cu.font = f
        tob = bpy.data.objects.new('vbSign-' + ob.name, cu)
        bpy.context.scene.collection.objects.link(tob)
        tob['vb_src'] = 'sign'
        rot = Matrix((right, up, n)).transposed().to_4x4()
        tob.matrix_world = Matrix.Translation(c + n * 0.004) @ rot
        cu.materials.append(_mat('vbSignFg-' + ob.name, sp['fg'], sp.get('glow', 0.0)))
        bpy.context.view_layer.update()
        dx = tob.dimensions.x
        if dx > w * 0.9 > 0:
            s = w * 0.9 / dx
            tob.scale = (s, s, s)
        made += 1
    log(f'[signs] lettering on {made} signs, {hidden} texture planes hidden')
    return made
