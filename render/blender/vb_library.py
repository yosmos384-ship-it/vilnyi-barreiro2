"""VILNYI Barreiro 2 - Cycles material library (pure data, no bpy).

Maps the CONTRACT3 material vocabulary (`material.name` = '<key>' or '<key>:<variant>') to physically based
shader recipes built by vb_materials.py. Package-dependent keys (floor-main, wall-paint, ...) resolve per STYLES id.

Texture sets are CC0 (Poly Haven, https://polyhaven.com/license). `tex` is a Poly Haven texture id; the real-world
size of one texture repeat (metres) comes from `size` (defaults to the Poly Haven `dimensions`).
If render/assets/blender_manifest.json (ASSETS agent) provides a set for a key, that set wins over `tex` here.

Recipe fields (all optional):
  shader   principled (default) | glass_thin | glass_solid | mirror | sheer | emit | foliage | water | lampshade
  tex      Poly Haven id;  size  metres per repeat;  rot  texture rotation in degrees (planks direction)
  color    sRGB hex base colour (used when no texture, or multiplied in when tint=True)
  tint     sRGB hex multiplied onto the texture colour;  hsv  (hue, sat, val) adjustment of the texture colour
  invert   True -> invert texture colour (white marble -> Nero Marquina)
  rough    float, or (lo, hi) remap of the roughness map;  metal  0..1;  spec  specular IOR level (0..1, 0.5 = default)
  coat     clearcoat weight; coat_rough;  sheen  weight; sheen_rough;  sss  subsurface weight;  trans  translucency mix
  bump     bump strength (height from displacement or roughness map);  normal  normal-map strength (default 1)
  var      large-scale colour variation amount (0..0.2);  bevel  bevel radius in metres (rounded edges)
  proc     procedural overlay: tiles | seam | fluted | quartz | azulejo | speckle | microcement | stripes
  tiles    dict for proc=tiles: w, h (m), grout (m), grout_color, offset (0..1 running bond), jitter (colour var)
  keep_map True -> keep the GLB's own base-colour texture (art, books, window atlases)
  emit     (strength, kelvin) for emissive keys;  light  'spot' | 'area' | 'point' | 'strip' -> real lights
"""

# ------------------------------------------------------------------ shared / exterior
BASE = {
    # --- façades
    'render-white':      dict(tex='white_plaster_02', size=1.2, tint='#ece8df', detail=0.6, rough=(0.80, 0.95), bump=0.12, var=0.04),
    'render-pink':       dict(tex='white_plaster_02', size=1.2, tint='#e3a08c', detail=0.7, rough=(0.8, 0.95), bump=0.15, var=0.07),
    'render-cream':      dict(tex='white_plaster_02', size=1.2, tint='#e6d9bf', detail=0.7, rough=(0.8, 0.95), bump=0.15, var=0.08),
    'brick-facade':      dict(tex='red_brick', size=1.4, hsv=(0.5, 0.95, 0.85), rough=(0.75, 0.95), bump=0.5, var=0.06),
    'zinc-standing-seam': dict(color='#34373a', rough=0.5, metal=0.3, proc='seam', seam=0.43, var=0.05, spec=0.5),
    'stone-coping':      dict(tex='concrete_floor_02', size=2.0, tint='#e6e2da', hsv=(0.5, 0.2, 1.15), rough=(0.6, 0.85), bump=0.1),
    'concrete':          dict(tex='concrete_wall_008', size=2.7, hsv=(0.5, 0.5, 1.0), rough=(0.7, 0.95), bump=0.2, var=0.05),
    'glass-window':      dict(shader='glass_thin', color='#eef3f2', ior=1.52),
    'glass-railing':     dict(shader='glass_thin', color='#dcebe6', ior=1.52, edge_green=True),
    'aluminium-frame':   dict(color='#2b2d30', rough=0.38, metal=0.0, coat=0.0, spec=0.5, var=0.0),
    'steel-dark':        dict(color='#2a2b2d', rough=0.45, metal=0.6),
    'timber-soffit':     dict(tex='teak_veneer', size=1.0, rot=90, hsv=(0.5, 0.9, 0.95), rough=(0.45, 0.7), bump=0.1),
    'timber-slats':      dict(tex='teak_veneer', size=1.0, rot=90, hsv=(0.5, 1.0, 1.0), rough=(0.45, 0.7), bump=0.15, bevel=0.003),
    'garage-door':       dict(color='#25272a', rough=0.35, metal=0.3, proc='stripes', stripe=0.5, var=0.02),
    'paving-calcada':    dict(tex='cobblestone_floor_04', size=2.0, tint='#bdb8ae', detail=1.0, rough=(0.6, 0.9), bump=0.6, var=0.06),
    'asphalt':           dict(tex='asphalt_02', size=3.0, hsv=(0.5, 0.7, 0.95), rough=(0.75, 0.95), bump=0.4, var=0.08),
    'kerb-stone':        dict(tex='concrete_floor_02', size=2.0, tint='#cfcac2', rough=(0.6, 0.9), bump=0.25, bevel=0.01),
    'gravel':            dict(tex='gravel', size=2.0, hsv=(0.5, 0.6, 1.1), rough=(0.7, 0.95), bump=0.6),
    'lawn':              dict(tex='sparse_grass', size=2.0, hsv=(0.5, 1.05, 0.9), rough=(0.8, 1.0), bump=0.5, var=0.12, trans=0.15),
    'soil':              dict(tex='dirt', size=2.0, rough=(0.8, 1.0), bump=0.4),
    'planter-concrete':  dict(tex='white_plaster_02', size=1.2, tint='#ece9e3', hsv=(0.5, 0.2, 1.0), rough=(0.75, 0.9), bump=0.12, bevel=0.01),
    'roof-tile-terracotta': dict(tex='clay_roof_tiles_02', size=2.5, hsv=(0.5, 0.9, 0.95), rough=(0.6, 0.9), bump=0.6, var=0.1),
    'deck-teak':         dict(tex='wood_floor_deck', size=1.8, hsv=(0.5, 0.9, 1.0), rough=(0.5, 0.8), bump=0.3, var=0.06),
    'foliage':           dict(shader='foliage', color='#4b6b33', rough=0.55, trans=0.35, var=0.15),
    'bark':              dict(tex='bark_brown_02', size=1.0, rough=(0.8, 1.0), bump=0.8),
    'water':             dict(shader='water', color='#3d5a66'),
    # --- common parts
    'lobby-floor-stone': dict(tex='marble_01', size=1.5, tint='#ece6dc', hsv=(0.5, 0.4, 1.0), rough=(0.12, 0.25), proc='tiles',
                              tiles=dict(w=1.2, h=0.6, grout=0.002, grout_color='#bdb6aa', offset=0.0, jitter=0.04), coat=0.0),
    'lobby-wall-walnut-slats': dict(tex='american_walnut_veneer', size=1.0, rot=90, rough=(0.35, 0.6), bump=0.1, bevel=0.002),
    'landing-floor-stone': dict(tex='marble_01', size=1.5, tint='#e4ddd1', hsv=(0.5, 0.4, 1.0), rough=(0.15, 0.3), proc='tiles',
                                tiles=dict(w=0.6, h=0.6, grout=0.002, grout_color='#b7afa3', offset=0.0, jitter=0.04)),
    'stair-stone':       dict(tex='marble_01', size=1.5, tint='#e8e2d8', hsv=(0.5, 0.4, 1.0), rough=(0.2, 0.35), bevel=0.004),
    'handrail-steel':    dict(color='#c8c8c6', rough=0.22, metal=1.0, aniso=0.5),
    'lift-steel':        dict(color='#c4c4c2', rough=0.25, metal=1.0, aniso=0.6),
    'lift-walnut':       dict(tex='american_walnut_veneer', size=1.0, rough=(0.3, 0.5)),
    'mirror':            dict(shader='mirror', color='#e9ece9'),
    'plaster-white':     dict(tex='white_plaster_02', size=1.5, tint='#eeebe5', detail=0.2, rough=(0.85, 0.95), bump=0.03, var=0.02),
    'ceiling-white':     dict(color='#f4f2ee', rough=0.9, var=0.01),
    'skirting':          dict(color='#f1eee8', rough=0.4, bevel=0.002),
    'door-walnut':       dict(tex='american_walnut_veneer', size=1.0, rot=90, rough=(0.3, 0.5), coat=0.2, bevel=0.002),
    'brass':             dict(color='#c9a35c', rough=0.28, metal=1.0),
    # --- furniture & decor
    'fabric-sofa':       dict(tex='rough_linen', size=0.27, rough=(0.85, 1.0), sheen=0.6, sheen_rough=0.4, bump=0.25, var=0.03, keep_color=True),
    'fabric-linen':      dict(tex='rough_linen', size=0.27, rough=(0.85, 1.0), sheen=0.5, sheen_rough=0.35, bump=0.2, keep_color=True),
    'fabric-boucle':     dict(tex='wool_boucle', size=0.32, rough=(0.85, 1.0), sheen=0.8, sheen_rough=0.5, bump=0.6, keep_color=True),
    'leather':           dict(tex='brown_leather', size=0.4, rough=(0.35, 0.6), bump=0.3, keep_color=True, coat=0.1),
    'wood-furniture':    dict(tex='oak_veneer_01', size=1.83, rot=90, rough=(0.35, 0.6), bump=0.05, keep_color=True, bevel=0.003),
    'metal-furniture':   dict(color='#2c2b2a', rough=0.35, metal=1.0, keep_color=True),
    'marble-table':      dict(tex='marble_01', size=1.5, rough=(0.08, 0.2), bevel=0.003, coat=0.3),
    'ceramic-plate':     dict(color='#f4f2ee', rough=0.08, coat=0.6, keep_color=True, bevel=0.001),
    'glass-drinking':    dict(shader='glass_solid', color='#f6faf8', ior=1.5),
    'cutlery-steel':     dict(color='#d0d0cf', rough=0.12, metal=1.0),
    'candle-wax':        dict(color='#f1ebdd', rough=0.4, sss=0.6, keep_color=True),
    'plant-leaf':        dict(shader='foliage', color='#3f6a35', rough=0.45, trans=0.3, var=0.12, keep_color=True),
    'pot-terracotta':    dict(tex='terracotta_floor_tiles', size=1.0, color='#b5653f', rough=(0.75, 0.95), keep_color=True, proc=None),
    'rug':               dict(tex='hessian_230', size=0.27, rough=(0.9, 1.0), sheen=0.6, bump=0.4, keep_color=True),
    'book':              dict(rough=0.6, keep_map=True, keep_color=True),
    'art-canvas':        dict(rough=0.7, keep_map=True, keep_color=True, bump=0.05),
    'lamp-shade':        dict(shader='lampshade', color='#efe6d6', keep_color=True),
    'bulb-emissive':     dict(shader='emit', emit=(8.0, 2700), light='point', lumens=450),
    'downlight-emissive': dict(shader='emit', emit=(12.0, 3000), light='spot', lumens=600),
    'led-strip-emissive': dict(shader='emit', emit=(5.0, 2700), light='strip', lumens_per_m=900),
    'far-ground':        dict(tex='aerial_grass_rock', size=40.0, tint='#8d8a74', detail=0.8, rough=0.95, var=0.15),
    # exporter extras (index.json): cars, PV, basement
    'car-paint':         dict(keep_color=True, rough=0.25, coat=1.0, coat_rough=0.03, metal=0.3, var=0.0),
    'car-glass':         dict(color='#0d1012', rough=0.03, coat=1.0, spec=0.7, var=0.0),
    'car-light':         dict(keep_color=True, rough=0.1, coat=1.0, var=0.0),
    'rubber':            dict(color='#151515', rough=0.8, var=0.03),
    'pv-panel':          dict(color='#10141c', rough=0.08, coat=1.0, spec=0.6, proc='tiles', tiles=dict(w=0.16, h=0.16, grout=0.004, grout_color='#c9ccd0', offset=0.0, jitter=0.02)),
    'epoxy-floor':       dict(color='#8d8f8f', rough=0.3, coat=0.4, var=0.06),
    'paint-marking':     dict(keep_color=True, keep_map=True, rough=0.6, var=0.02),
    'fruit':             dict(keep_color=True, rough=0.35, sss=0.3, var=0.05),
    'wine':              dict(keep_color=True, rough=0.05, coat=1.0),
}

# ------------------------------------------------------------------ packages (apartment keys)
TILE60x120 = dict(w=1.2, h=0.6, grout=0.002, offset=0.0, jitter=0.035)

PACKAGES = {
    # Essencial · Atlantic Light — natural oak 190 mm, warm white plaster, stone-look porcelain 60x120, white lacquer + quartz, chrome
    'atlantic': {
        'floor-main':       dict(tex='plank_flooring_04', size=2.0, hsv=(0.5, 0.75, 1.15), rough=(0.45, 0.65), bump=0.08, var=0.05, coat=0.0),
        'wall-paint':       dict(color='#f1ece3', rough=0.9, var=0.012, tex='white_plaster_02', size=1.5, tint='#efebe4', detail=0.15, bump=0.02),
        'wall-feature':     dict(color='#e7e0d4', rough=0.85, tex='white_plaster_02', size=1.5, tint='#e6dfd3', detail=0.3, bump=0.04),
        'ceiling':          dict(color='#f8f6f2', rough=0.92),
        'skirting':         dict(color='#f2efe9', rough=0.35, bevel=0.002),
        'door-interior':    dict(color='#f3f1ec', rough=0.3, coat=0.15, bevel=0.002),
        'door-handle':      dict(color='#c9c8c4', rough=0.3, metal=1.0, aniso=0.5),
        'bath-floor':       dict(tex='concrete_floor_02', size=2.0, tint='#d9d4cb', hsv=(0.5, 0.3, 1.1), rough=(0.35, 0.55), proc='tiles',
                                 tiles=dict(TILE60x120, grout_color='#c3bdb2'), bump=0.05),
        'bath-wall':        dict(tex='concrete_floor_02', size=2.0, tint='#e6e2da', hsv=(0.5, 0.3, 1.15), rough=(0.25, 0.45), proc='tiles',
                                 tiles=dict(TILE60x120, w=0.6, h=1.2, grout_color='#cdc7bc')),
        'shower-wall':      dict(tex='concrete_floor_02', size=2.0, tint='#e6e2da', hsv=(0.5, 0.3, 1.15), rough=(0.25, 0.45), proc='tiles',
                                 tiles=dict(TILE60x120, w=0.6, h=1.2, grout_color='#cdc7bc')),
        'shower-glass':     dict(shader='glass_thin', color='#f2f6f5', ior=1.52),
        'sanitary-ceramic': dict(color='#f6f5f2', rough=0.06, coat=0.5, sss=0.05, bevel=0.002),
        'tap-metal':        dict(color='#dcdcdc', rough=0.06, metal=1.0),
        'kitchen-front':    dict(color='#efede8', rough=0.55, bevel=0.0015, var=0.0),
        'kitchen-worktop':  dict(color='#eeebe6', rough=0.18, proc='quartz', coat=0.2, bevel=0.002),
        'kitchen-splashback': dict(color='#eeebe6', rough=0.18, proc='quartz', coat=0.2),
        'appliance-steel':  dict(color='#bdbdbb', rough=0.28, metal=1.0, aniso=0.6),
        'appliance-glass-black': dict(color='#0b0b0c', rough=0.04, coat=0.8, spec=0.6),
        'joinery-wardrobe': dict(color='#ece7df', rough=0.5, bevel=0.0015),
        'window-sheer':     dict(shader='sheer', color='#f6f3ee', alpha=0.45),
        'curtain-fabric':   dict(tex='rough_linen', size=0.27, color='#e3dbcf', rough=(0.85, 1.0), sheen=0.6, trans=0.25, keep_color=True),
    },
    # Premium · Lisboa Heritage — walnut herringbone, lime plaster, Estremoz marble + azulejo, navy lacquer + brass + Calacatta
    'lisboa': {
        'floor-main':       dict(tex='herringbone_parquet', size=3.4, tint='#8a6446', detail=1.0, rough=(0.35, 0.55), bump=0.08, var=0.05, coat=0.1),
        'wall-paint':       dict(tex='white_plaster_02', size=1.5, tint='#ece4d6', detail=0.25, rough=(0.85, 0.95), bump=0.05, var=0.02),
        'wall-feature':     dict(proc='azulejo', keep_map=True, color='#f3efe6', rough=0.12, coat=0.6, tiles=dict(w=0.14, h=0.14, grout=0.0025, grout_color='#d9d3c6', offset=0.0, jitter=0.03)),
        'ceiling':          dict(color='#f7f1e6', rough=0.92),
        'skirting':         dict(color='#efe7da', rough=0.35, bevel=0.002),
        'door-interior':    dict(tex='american_walnut_veneer', size=1.0, rot=90, rough=(0.3, 0.5), coat=0.25, bevel=0.002),
        'door-handle':      dict(color='#c49a52', rough=0.3, metal=1.0, aniso=0.4),
        'bath-floor':       dict(tex='marble_01', size=1.5, tint='#f1e8da', hsv=(0.5, 0.6, 1.0), rough=(0.2, 0.35), proc='tiles',
                                 tiles=dict(w=0.6, h=0.6, grout=0.0015, grout_color='#d8cfbf', offset=0.0, jitter=0.03)),
        'bath-wall':        dict(tex='marble_01', size=1.5, tint='#f3ebdf', hsv=(0.5, 0.6, 1.0), rough=(0.15, 0.3), proc='tiles',
                                 tiles=dict(w=0.6, h=1.2, grout=0.0015, grout_color='#d8cfbf', offset=0.0, jitter=0.03)),
        'shower-wall':      dict(proc='azulejo', keep_map=True, color='#f3efe6', rough=0.12, coat=0.6, tiles=dict(w=0.14, h=0.14, grout=0.0025, grout_color='#d9d3c6', offset=0.0, jitter=0.03)),
        'shower-glass':     dict(shader='glass_thin', color='#f2f6f5', ior=1.52),
        'sanitary-ceramic': dict(color='#f6f4ef', rough=0.06, coat=0.5, bevel=0.002),
        'tap-metal':        dict(color='#c79e57', rough=0.25, metal=1.0, aniso=0.4),
        'kitchen-front':    dict(color='#22334a', rough=0.35, coat=0.25, bevel=0.0015),
        'kitchen-worktop':  dict(tex='marble_01', size=1.5, tint='#f7f4ef', hsv=(0.5, 0.2, 1.1), rough=(0.1, 0.2), coat=0.3, bevel=0.002),
        'kitchen-splashback': dict(tex='marble_01', size=1.5, tint='#f7f4ef', hsv=(0.5, 0.2, 1.1), rough=(0.1, 0.2), coat=0.3),
        'appliance-steel':  dict(color='#bdbdbb', rough=0.28, metal=1.0, aniso=0.6),
        'appliance-glass-black': dict(color='#0b0b0c', rough=0.04, coat=0.8, spec=0.6),
        'joinery-wardrobe': dict(tex='american_walnut_veneer', size=1.0, rot=90, rough=(0.3, 0.5), bevel=0.0015),
        'window-sheer':     dict(shader='sheer', color='#f1ebe0', alpha=0.5),
        'curtain-fabric':   dict(tex='rough_linen', size=0.27, color='#c9a47a', rough=(0.85, 1.0), sheen=0.6, trans=0.2, keep_color=True),
    },
    # Signature · Noir Riverside — smoked oak 240 mm, charcoal microcement, Nero Marquina, fluted smoked oak + sintered stone, bronze
    'noir': {
        'floor-main':       dict(tex='plank_flooring_04', size=2.0, hsv=(0.5, 0.8, 0.42), rough=(0.4, 0.6), bump=0.12, var=0.05),
        'wall-paint':       dict(tex='white_plaster_02', size=1.5, tint='#8d8780', detail=0.25, rough=(0.85, 0.95), bump=0.04, var=0.02),
        'wall-feature':     dict(tex='concrete_floor_02', size=2.0, tint='#4a4846', hsv=(0.5, 0.15, 1.0), proc='microcement', rough=(0.5, 0.75), bump=0.06, var=0.06),
        'ceiling':          dict(color='#e9e6e1', rough=0.92),
        'skirting':         dict(color='#2b2a29', rough=0.4, bevel=0.002),
        'door-interior':    dict(tex='plank_flooring_04', size=2.0, rot=90, hsv=(0.5, 0.6, 0.38), rough=(0.4, 0.6), bevel=0.002),
        'door-handle':      dict(color='#7b5b3a', rough=0.35, metal=1.0),
        'bath-floor':       dict(tex='marble_01', size=1.5, invert=True, tint='#2a2a2a', rough=(0.05, 0.15), coat=0.4, proc='tiles',
                                 tiles=dict(w=0.6, h=1.2, grout=0.0015, grout_color='#151515', offset=0.0, jitter=0.03)),
        'bath-wall':        dict(tex='marble_01', size=1.5, invert=True, tint='#2a2a2a', rough=(0.05, 0.15), coat=0.4, proc='tiles',
                                 tiles=dict(w=0.6, h=1.2, grout=0.0015, grout_color='#151515', offset=0.0, jitter=0.03)),
        'shower-wall':      dict(tex='concrete_floor_02', size=2.0, tint='#5a5754', hsv=(0.5, 0.15, 1.0), proc='microcement', rough=(0.45, 0.7), bump=0.05, var=0.05),
        'shower-glass':     dict(shader='glass_thin', color='#c9ccc9', ior=1.52),
        'sanitary-ceramic': dict(color='#2e2d2c', rough=0.35, bevel=0.002),
        'tap-metal':        dict(color='#6e5238', rough=0.35, metal=1.0),
        'kitchen-front':    dict(tex='plank_flooring_04', size=2.0, rot=90, hsv=(0.5, 0.6, 0.35), rough=(0.4, 0.6), proc='fluted', flute=0.025, bevel=0.0015),
        'kitchen-worktop':  dict(color='#1c1c1d', rough=0.25, proc='speckle', coat=0.15, bevel=0.0015),
        'kitchen-splashback': dict(color='#1c1c1d', rough=0.25, proc='speckle', coat=0.15),
        'appliance-steel':  dict(color='#3a3a3b', rough=0.3, metal=1.0, aniso=0.5),
        'appliance-glass-black': dict(color='#0a0a0b', rough=0.04, coat=0.8, spec=0.6),
        'joinery-wardrobe': dict(tex='plank_flooring_04', size=2.0, rot=90, hsv=(0.5, 0.6, 0.35), rough=(0.4, 0.6), bevel=0.0015),
        'window-sheer':     dict(shader='sheer', color='#d8d3cc', alpha=0.5),
        'curtain-fabric':   dict(tex='velour_velvet', size=0.28, color='#57524c', rough=(0.7, 0.9), sheen=0.9, trans=0.1, keep_color=True),
    },
}

# common keys which also vary by package (lobby etc. stay the same)
PACKAGE_FURNITURE_METAL = {'atlantic': '#c9c8c4', 'lisboa': '#c49a52', 'noir': '#7b5b3a'}

# ------------------------------------------------------------------ HDRI skies (Poly Haven ids)
# name: (hdri id, target sun illuminance lux (None = no sun / sky-only), target horizontal sky illuminance lux)
SKIES = {
    'day':    dict(hdri='kloofendal_43d_clear_puresky', sun_lux=95000, sky_lux=18000, sun_az=200.0),
    # golden: raking warm light across the street facade (facade normal bearing 151 deg) like assets/facade-day.jpg
    'golden': dict(hdri='syferfontein_18d_clear_puresky', sun_lux=45000, sky_lux=9000, sun_az=222.0),
    # dusk (assets/street-dusk.jpg): sun about to set in the WSW, long shadows, all lamps on
    'dusk':   dict(hdri='syferfontein_6d_clear_puresky', sun_lux=14000, sky_lux=2500, sun_az=246.0),
    'night':  dict(hdri='qwantani_dusk_2_puresky', sun_lux=None, sky_lux=900, sun_az=250.0),
}

# Every texture id referenced above (for the downloader)
def all_texture_ids():
    ids = set()
    for d in [BASE] + list(PACKAGES.values()):
        for r in d.values():
            if r.get('tex'):
                ids.add(r['tex'])
    return sorted(ids)


def recipe(key, pkg):
    """Resolve a material key for a package -> recipe dict (or None)."""
    if pkg and pkg in PACKAGES and key in PACKAGES[pkg]:
        return dict(PACKAGES[pkg][key])
    if key in BASE:
        r = dict(BASE[key])
        if key in ('metal-furniture',) and pkg in PACKAGE_FURNITURE_METAL:
            pass
        return r
    # apartment key requested without a package -> atlantic
    if key in PACKAGES['atlantic']:
        return dict(PACKAGES['atlantic'][key])
    return None
