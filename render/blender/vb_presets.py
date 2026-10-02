"""Lighting presets shared with the realtime site (js/environment.js `TOD` / `lightingPresets`).

The Blender pipeline reads sun / moon bearing + altitude, light colour, sky gradient colours, star amount and the fraction of
lit context windows from the SAME table the browser uses.  Order of preference:
  1. js/environment.js in the repo (parsed here: `const TOD = {...}`), when it has the day/dusk/night presets;
  2. render/blender/lighting_presets.json (snapshot written by `python3 vb_presets.py snapshot <environment.js>`).
Pure python (no bpy)."""
import json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
SNAPSHOT = os.path.join(HERE, 'lighting_presets.json')


def parse_tod(js_text):
    """`const TOD = { day: {...}, ... };` (a plain JS object literal) -> dict."""
    i = js_text.index('const TOD = {')
    j = js_text.index('\n};', i)
    body = js_text[i + len('const TOD = '):j + 2]
    body = re.sub(r'//[^\n]*', '', body)                              # line comments
    body = re.sub(r"'([^']*)'", r'"\1"', body)                         # single -> double quotes
    body = re.sub(r'([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:', r'\1"\2":', body)   # quote keys
    body = re.sub(r',\s*([}\]])', r'\1', body)                         # trailing commas
    return json.loads(body)


def presets_from_tod(tod):
    out = {}
    for name, P in tod.items():
        out[name] = dict(
            name=name, light='moon' if P.get('moon') else 'sun', azimuth=P['az'], altitude=P['alt'], color=P['sun'], intensity=P['sunI'],
            shadowSoftness=P.get('shadowRadius', 3), hdri=P.get('hdri', name), hdriStrength=P.get('envE'), hdriTint=P.get('envTint', '#ffffff'),
            sky=dict(zenith=P['zenith'], mid=P['mid'], horizon=P['horizon'], horizonAway=P['away'], haze=P['fogCol'], ground=P.get('ground'), glow=P.get('glow')),
            hemisphere=dict(sky=P['hemiSky'], ground=P['hemiGround'], intensity=P['hemiI']),
            streetLamps=P.get('lamps', 0), lampColor='#ffb46b',
            windowsLit=0.45 if P.get('win') == 'night' else 0.25 if P.get('win') == 'dusk' else 0, cityLights=P.get('city', 0),
            stars=P.get('stars', 0), exposure=P.get('exposure', 1.0))
    return out


def load(log=print):
    for p in (os.path.join(ROOT, 'js', 'environment.js'),):
        try:
            with open(p, encoding='utf-8') as f:
                pr = presets_from_tod(parse_tod(f.read()))
            if all(k in pr for k in ('day', 'dusk', 'night')) and pr['night']['light'] == 'moon':
                log(f'[presets] from {os.path.relpath(p, ROOT)}')
                return pr
        except Exception as e:  # noqa
            log(f'[presets] {os.path.relpath(p, ROOT)} not usable ({e!r})')
    with open(SNAPSHOT, encoding='utf-8') as f:
        pr = json.load(f)['presets']
    log('[presets] from lighting_presets.json (snapshot of js/environment.js)')
    return pr


if __name__ == '__main__':
    if len(sys.argv) > 2 and sys.argv[1] == 'snapshot':
        with open(sys.argv[2], encoding='utf-8') as f:
            pr = presets_from_tod(parse_tod(f.read()))
        with open(SNAPSHOT, 'w', encoding='utf-8') as f:
            json.dump({'_doc': 'snapshot of js/environment.js TOD / lightingPresets (python3 vb_presets.py snapshot <environment.js>)',
                       'source': os.path.basename(sys.argv[2]), 'presets': pr}, f, indent=1)
        print('wrote', SNAPSHOT, list(pr))
    else:
        print(json.dumps(load(), indent=1))
