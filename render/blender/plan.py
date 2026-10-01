"""Build the GitHub Actions render matrix from render/scenes/cameras.json.

python3 plan.py --set preview|exterior|common|units|all --quality q [--units 1.C,2.A] [--packages lisboa] [--shots ids] [--opts JSON]
Prints `matrix=<json>` (for $GITHUB_OUTPUT). Each entry: {name, job: <json string for render_job.py>}.
Shards keep every job well under 5 h on a 4-vCPU runner (see PER_SHARD).
"""
import argparse, json, os, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
# panoramas per shard by quality (a 4096x2048 interior pano at 160 spp ~ 15-25 min on 4 vCPU)
PER_SHARD = {'preview': 20, 'standard': 5, 'high': 2}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--set', default='preview')
    ap.add_argument('--quality', default='')
    ap.add_argument('--units', default='')
    ap.add_argument('--packages', default='')
    ap.add_argument('--shots', default='')
    ap.add_argument('--opts', default='')
    ap.add_argument('--tod', default='day')
    a = ap.parse_args()
    cams = json.load(open(os.path.join(ROOT, 'render', 'scenes', 'cameras.json')))
    pkgs = [p for p in (a.packages or ','.join(cams.get('packages', ['atlantic', 'lisboa', 'noir']))).split(',') if p]
    units = [u for u in (a.units or ','.join(cams['unitsData'].keys())).split(',') if u]
    opts = json.loads(a.opts) if a.opts.strip() else {}
    want = [s for s in a.shots.split(',') if s] or ['all']
    jobs = []
    st = a.set
    if st == 'preview':
        q = a.quality or 'preview'
        u, p = (units[0] if a.units else '1.C'), (pkgs[0] if a.packages else 'lisboa')
        jobs.append(dict(scope='unit', unit=u, pkg=p, quality=q, tod=a.tod, shots=[f'{u}-living', f'{u}-{p}-h3'] if want == ['all'] else want,
                         out=f'renders/preview/{u}/{p}', name=f'preview-{u}-{p}', opts=dict(opts, **({'profile': True} if 'profile' not in opts else {}))))
        jobs.append(dict(scope='exterior', quality=q, shots=['street-dusk', 'street-golden-34'] if want == ['all'] else want,
                         out='renders/preview/exterior', name='preview-exterior', opts=opts))
    q = a.quality or 'standard'
    if st in ('exterior', 'all'):
        for c in cams.get('exterior', []):
            if want != ['all'] and c['id'] not in want:
                continue
            jobs.append(dict(scope='exterior', quality=q, shots=[c['id']], out='renders/exterior', name=f'ext-{c["id"]}', opts=opts))
    if st in ('common', 'all'):
        jobs.append(dict(scope='common', quality=q, shots=want, out='renders/common', name='common', opts=opts))
    if st in ('units', 'all'):
        n = PER_SHARD.get(q, 4)
        for u in units:
            ud = cams['unitsData'].get(u)
            if not ud:
                continue
            for p in pkgs:
                hs = [h['id'] for h in ud['packages'][p]['hotspots']]
                if want != ['all']:
                    hs = [h for h in hs if h in want or 'panos' in want]
                stills = [h['id'] for h in ud.get('hero', [])]
                if want != ['all']:
                    stills = [s for s in stills if s in want or 'stills' in want]
                chunks = [hs[i:i + n] for i in range(0, len(hs), n)]
                if stills:
                    chunks.append(stills)   # stills in their own shard (~1.5 h)
                for k, ch in enumerate(chunks):
                    shots = list(ch)
                    if not shots:
                        continue
                    jobs.append(dict(scope='unit', unit=u, pkg=p, quality=q, tod=a.tod, shots=shots, out=f'renders/units/{u}/{p}',
                                     name=f'u{u}-{p}-{k}', opts=opts))
    mat = {'include': [{'name': j['name'], 'job': json.dumps(j, separators=(',', ':'))} for j in jobs]}
    print(f'count={len(jobs)}')
    print('matrix=' + json.dumps(mat, separators=(',', ':')))


if __name__ == '__main__':
    main()
