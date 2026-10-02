# Render requests

Pushing a new or changed `render/requests/<name>.json` to `main` starts the `render` workflow with the inputs in that file
(same as the `workflow_dispatch` inputs). The file is an object, or a list of objects whose jobs are merged into one run:

```json
[{ "set": "units", "quality": "standard", "units": "1.C,2.C", "packages": "natura", "shots": "living", "tod": "dusk,night",
   "opts": { "ev_bias": 0.35 }, "preview": false, "per_shard": 5 }]
```

- `set`: `preview | exterior | common | units | all` · `quality`: `preview | standard | high`
- `units` / `packages`: comma lists (empty = all) · `shots`: shot ids, or `panos` / `stills` / `living` (living-room panoramas + living hero still)
- `tod`: `day | dusk | night` (comma list). Dusk / night apartment renders are written next to the day image as
  `<name>.dusk.jpg` / `<name>.night.jpg` and become `variants` in `renders/manifest.json`.
- `opts`: options for `render/blender/render_job.py` (`ev_bias` = day exposure bias, 0.35 for the published set).
- `preview: true` writes to `renders/preview/**` (ignored by the manifest).

Name files `NNN-what.json`; when one push touches several, the last in name order runs. At most 256 jobs per run, 20 in parallel.
