"""Build the GitHub Actions render matrix from render/scenes/cameras.json.

python3 plan.py --set preview|exterior|common|units|all --quality q [--units 1.C,2.A] [--packages lisboa] [--shots ids]
                [--tod day|dusk|night|dusk,night] [--opts JSON]
python3 plan.py --request render/requests/<name>.json
    The request file holds the same inputs: {set, quality, units, packages, shots, tod, opts} - or a LIST of such objects
    (their jobs are concatenated into one run). Extra request keys: "preview": true (outputs go to renders/preview/...,
    which the manifest ignores), "per_shard": n (panoramas per job), "tag": job-name tag for re-runs (use one that sorts after
    's', e.g. "z": the manifest takes the last shots-*.json in name order), "q": overrides of the quality table.

shots: comma list of shot ids, or the tokens  panos | stills | living  (living = the living-room panoramas + the living hero
still of each unit - the set rendered for the dusk / night variants).
tod: time of day of the apartment renders; dusk / night images are written next to the day image as <id>.dusk.jpg /
<id>.night.jpg (same camera) and become `variants` in renders/manifest.json.

Prints `count=<n>` and `matrix=<json>` (for $GITHUB_OUTPUT). Each entry: {name, job: <json string for render_job.py>}.
Shards keep every job well under 5 h on a 4-vCPU runner (see PER_SHARD).
"""
import argparse, json, os, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
# panoramas per shard by quality (a 3072x1536 interior pano at 64 spp ~ 15-25 min on 4 vCPU)
PER_SHARD = {'preview': 20, 'standard': 5, 'high': 2}
MAX_JOBS = 256      # GitHub matrix limit


def load_cams():
    cams = json.load(open(os.path.join(ROOT, 'render', 'scenes', 'cameras.json')))
    try:
        ovr = json.load(open(os.path.join(ROOT, 'render', 'blender', 'cameras_override.json')))
        for sect, key in (('exterior', 'extra_exterior'), ('common', 'extra_common')):
            have = {c['id'] for c in cams.get(sect, [])}
            cams.setdefault(sect, []).extend(c for c in ovr.get(key, []) if c['id'] not in have)
    except Exception:
        pass
    return cams


def csv(v):
    if isinstance(v, (list, tuple)):
        return [str(x) for x in v if str(x)]
    return [x.strip() for x in str(v or '').split(',') if x.strip()]


def jobs_for(req, cams):
    st = req.get('set') or 'preview'
    opts = req.get('opts') or {}
    if isinstance(opts, str):
        opts = json.loads(opts) if opts.strip() else {}
    pkgs = csv(req.get('packages')) or list(cams.get('packages', ['atlantic', 'lisboa', 'noir']))
    units = csv(req.get('units')) or list(cams['unitsData'].keys())
    want = csv(req.get('shots')) or ['all']
    tods = csv(req.get('tod')) or ['day']
    preview = bool(req.get('preview'))
    tag = str(req.get('tag') or '')     # job-name tag: keeps re-runs from overwriting the shots-<name>.json / logs of the first run
    jobs = []
    qov = req.get('q') or None      # per-request overrides of the quality table, e.g. {"still": [800, 450], "still_spp": 32}

    def J(**kw):
        if qov:
            kw['q'] = qov
        return kw
    if st == 'preview':
        q = req.get('quality') or 'preview'
        u, p = (units[0] if csv(req.get('units')) else '1.C'), (pkgs[0] if csv(req.get('packages')) else 'lisboa')
        tod = tods[0]
        sfx = '' if tod == 'day' else f'-{tod}'
        jobs.append(dict(scope='unit', unit=u, pkg=p, quality=q, tod=tod, shots=[f'{u}-living', f'{u}-bedroom', f'{u}-bathroom', f'{u}-{p}-h3'] if want == ['all'] else want,
                         out=f'renders/preview/{u}/{p}', name=f'preview-{u}-{p}{sfx}', opts=opts))
        jobs.append(dict(scope='exterior', quality=q, shots=['aerial-dusk-34', 'rear-garden-golden'] if want == ['all'] else want,
                         out='renders/preview/exterior', name='preview-exterior', opts=opts))
        jobs.append(dict(scope='common', quality=q, shots=['lobby'] if want == ['all'] else want, out='renders/preview/common', name='preview-common', opts=opts))
        return jobs
    q = req.get('quality') or 'standard'
    pre = 'preview-' if preview else ''
    if st in ('exterior', 'all'):
        for c in cams.get('exterior', []):
            if want not in (['all'], ['stills']) and c['id'] not in want:
                continue
            jobs.append(J(scope='exterior', quality=q, shots=[c['id']], out='renders/preview/exterior' if preview else 'renders/exterior',
                             name=f'{pre}ext-{c["id"]}', opts=opts))
    if st in ('common', 'all'):
        for c in cams.get('common', []):     # one job per shot (lamp-lit common areas are slow)
            if want not in (['all'], ['stills']) and c['id'] not in want:
                continue
            jobs.append(J(scope='common', quality=q, shots=[c['id']], out='renders/preview/common' if preview else 'renders/common',
                             name=f'{pre}common-{c["id"]}', opts=opts))
    if st in ('units', 'all'):
        n = int(req.get('per_shard') or PER_SHARD.get(q, 4))
        for u in units:
            ud = cams['unitsData'].get(u)
            if not ud:
                continue
            for p in pkgs:
                if p not in ud['packages']:
                    continue
                hs_all = ud['packages'][p]['hotspots']
                st_all = ud.get('hero', [])
                hs = [h['id'] for h in hs_all if want == ['all'] or h['id'] in want or 'panos' in want
                      or ('living' in want and str(h.get('roomId', '')).endswith('-living'))]
                stills = [h['id'] for h in st_all if want == ['all'] or h['id'] in want or 'stills' in want
                          or ('living' in want and h.get('kind') == 'living')]
                for tod in tods:
                    tsfx = '' if tod == 'day' else f'-{tod}'
                    if len(hs) + len(stills) <= 3 and q != 'high':
                        chunks = [('0', hs + stills)]          # small sets (the living-room evening variants): one job
                    else:
                        chunks = [(str(k), hs[i:i + n]) for k, i in enumerate(range(0, len(hs), n))]
                        if stills:
                            chunks.append(('s', stills))        # stills in their own shard (~1.5 h)
                    for kname, shots in chunks:
                        if not shots:
                            continue
                        jobs.append(J(scope='unit', unit=u, pkg=p, quality=q, tod=tod, shots=list(shots),
                                         out=f'renders/preview/{u}/{p}' if preview else f'renders/units/{u}/{p}',
                                         name=f'{pre}u{u}-{p}{tsfx}-{tag}{kname}', opts=opts))
    return jobs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--set', default='preview')
    ap.add_argument('--quality', default='')
    ap.add_argument('--units', default='')
    ap.add_argument('--packages', default='')
    ap.add_argument('--shots', default='')
    ap.add_argument('--opts', default='')
    ap.add_argument('--tod', default='day')
    ap.add_argument('--request', default='', help='render/requests/<name>.json (object or list of objects with the inputs above)')
    a = ap.parse_args()
    cams = load_cams()
    if a.request:
        path = a.request if os.path.isabs(a.request) else os.path.join(ROOT, a.request)
        reqs = json.load(open(path))
        if isinstance(reqs, dict):
            reqs = reqs.get('requests') if isinstance(reqs.get('requests'), list) else [reqs]
    else:
        reqs = [dict(set=a.set, quality=a.quality, units=a.units, packages=a.packages, shots=a.shots, tod=a.tod, opts=a.opts)]
    jobs, seen = [], set()
    for r in reqs:
        for j in jobs_for(r, cams):
            if j['name'] in seen:       # job names must be unique (log + shots-<name>.json files)
                k = 2
                while f"{j['name']}-{k}" in seen:
                    k += 1
                j['name'] = f"{j['name']}-{k}"
            seen.add(j['name'])
            jobs.append(j)
    if len(jobs) > MAX_JOBS:
        print(f'too many jobs ({len(jobs)} > {MAX_JOBS}): split the request', file=sys.stderr)
        jobs = jobs[:MAX_JOBS]
    mat = {'include': [{'name': j['name'], 'job': json.dumps(j, separators=(',', ':'))} for j in jobs]}
    print(f'count={len(jobs)}')
    print('matrix=' + json.dumps(mat, separators=(',', ':')))


if __name__ == '__main__':
    main()
