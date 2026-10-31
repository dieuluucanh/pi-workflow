# @dieulc/checkpoints

Folder checkpoints for Pi, plus a `/rewind` command.

A checkpoint is a snapshot of a whole folder — an Office document, a pile of
images, a code checkout — taken into a **shadow git repository** under your Pi
profile. The project's own `.git` is never read or written, so this works in a
folder that has no repository at all.

Pi Desktop already bundles this extension. Terminal Pi users can install the
published package:

```bash
pi install npm:@dieulc/checkpoints
```

Update with `pi update --extensions`; remove with `pi remove npm:@dieulc/checkpoints`.

Requires `git` on your `PATH`. Without git the extension stays silent and Pi
Desktop's rail shows an explicit "checkpoints need git" state.

## What it does

- One snapshot per user prompt, taken before the prompt is processed (steer and
  follow-up prompts included).
- `/rewind` lists this session's checkpoints and can restore **files**, the
  **conversation**, or both. A safety snapshot is taken first, so a rewind is
  itself undoable.
- A prompt that never gets a turn is kept as an unlinked, files-only checkpoint
  rather than being dropped.

## Where the bytes live

`<profile>/checkpoints/<folder-name>-<hash>/` — one bare repository per folder,
shared with Pi Desktop. Retention defaults: 100 checkpoints, 30 days, 2 GB per
folder. `/rewind` prunes nothing itself; Pi Desktop's Checkpoints section and
Settings do.

Generated from the Pi Desktop repository's `src/extensions/pi-checkpoints.ts`.
The package is synced with `npm run build:extension && npm run sync:extension`
in that repository; do not hand-edit `index.mjs`.
