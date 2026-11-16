# Browser video annotation with SAM2

The annotation toolbar has a **SAM2 Video** button for 2D jobs. Existing CVAT
Project / Task upload, playback, frame navigation, drawing, and dataset export
remain the entry points. This addition provides persistent GPU inference runs,
independent mask layers, explicit acceptance, and inference snapshot exports.

## Start

Requires an NVIDIA GPU and NVIDIA Container Toolkit on the Docker host. From the
checkout that contains this feature:

```bash
docker compose --profile sam2 up -d
```

For the existing installation in this workspace, retain its project name and
serverless override so the same data volumes are used:

```bash
docker compose -p sst_cvat --profile sam2 \
  -f docker-compose.yml -f docker-compose.dev.yml \
  -f components/serverless/docker-compose.serverless.yml up -d
```

The server initializes the new `video_annotation` database table through its
normal migrations. The annotation worker must be rebuilt alongside the server.
The private `sam2` service has no host port. Its Dockerfile downloads model weights
during build into `/opt/sam2/huggingface`. Inference uses this bundled cache with
`HF_HUB_OFFLINE=1`; the existing `/models` volume cannot hide the bundled weights. The image pins the SAM2
source revision; the default checkpoint is `facebook/sam2.1-hiera-tiny`.
Set `SAM2_MODEL` consistently through Compose and rebuild the image to use another
compatible model. Compose passes it as both a build argument and runtime variable.

Forward remote port 8080 in Remote SSH and open `http://localhost:8080`.
Use `CVAT_HOST=localhost` when creating the containers for that hostname.

## Annotate and review

1. Create a Project with compatible labels and upload a video using either
   **Standard frame annotation** or **Original MP4 annotation**. Both open native
   Task/Job workspaces with SAM2.
2. Open the annotation Job, navigate to the starting frame, and draw one or more
   polygons or masks in **Shape** mode. Track-mode prompts are not yet supported.
3. Open **SAM2 Video**, select the objects, set the end frame, and click
   **Save and run SAM2**. The start frame is the current CVAT frame.
4. Close/reopen the panel to resume viewing the latest 20 runs. Execution runs in
   the annotation queue and continues independently of the browser.
5. Inspect **Live mask layers** over original source frames, then choose
   **Accept masks**. Masks become editable CVAT shapes; seeds remain unchanged.
   Mask shape menus also offer **SAM2: Track subsequent frames**.
6. Use **Manage SAM2 masks** to inspect or delete results grouped by run/label.
   The live inspector supports per-object visibility, opacity, current-frame
   mask deletion, and edge smoothing. Radius changes preview immediately;
   **Apply smoothing** saves only the selected mask on the current frame.
   Compare original / Reset preview do not modify stored annotations.
   Deletion uses recorded run provenance, never all annotations with source=auto.
7. Correct a predicted mask on a later frame and start another run there. Its
   original object identity is retained. Overlapping, unchanged predictions of
   that object are replaced; manually edited predictions are protected and
   return a conflict rather than being removed.
8. Use **Download inference ZIP** for a reproducible inference snapshot. Use
   **Menu → Export job dataset** for the current annotations, including later
   manual corrections (for example, COCO segmentation).

Pending edits or an annotation change since inference started prevent accepting
stale results. Save edits and run again. Cancellation is cooperative: it stops
when the next frame / inference output is processed, not immediately during a
GPU kernel or initial model download.

## First-version limits

- Forward tracking, 1–10 standalone mask/polygon prompts, 2–300 frames per run.
- One active run per Job, one inference at a time per GPU service. A busy GPU
  returns an error; retry after the other run completes.
- Maximum 4K frame area and 512 MiB frame archive. Use short ranges for long or
  high-resolution videos. Change `SAM2_MAX_FRAMES` in Compose on both services
  only after evaluating memory requirements.
- Main-canvas and SAM2 playback share original-quality five-second video segments,
  IndexedDB storage, and in-flight downloads. Seeking prioritizes the new position;
  completed segments remain reusable. SAM2 renders a separate overlay up to 10 Hz.
  Threshold previews load reduced-resolution score planes only when needed.
  Changing mask parameters does not restart video or rerun inference. Pause for
  exact-frame editing. Standard frame-based jobs retain the 5 fps inspector.
- Boundary curve fitting works without logits and preserves separate components
  and holes. Optional mask cleanup uses a local box filter and majority threshold.
  Inspect fine structures before applying. Empty results cannot be applied.
  Bulk / temporal post-processing is not included.
- The frame index is CVAT's task-relative index, including tasks imported with
  start offsets / frame steps. Original VFR timestamps are not reconstructed.
- A missing mask means the model did not return a visible region; this does not
  distinguish occlusion from leaving the scene or provide automatic re-ID.
- Inference artifacts are stored under `data/video_inference/<job>/<run>/`.
  The ZIP describes a run, not the entire project's final annotation state.
- Automatic point/box prompts, backward tracking, a combined project-upload
  wizard, original-timing preview, and a full-project versioned export are not
  included in this first version.

## Snapshot format

The ZIP contains `manifest.json`, `objects.json`, `prompts.json`,
`annotations.jsonl`, `cvat_masks.json`, and `preview.mp4` when available.
`annotations.jsonl` has one record per frame and object. `segmentation` is
uncompressed COCO RLE in column-major order, or null if no mask was produced.
`cvat_masks.json` contains cropped row-major CVAT RLE for lossless re-import by
an integration. These encodings are different and must not be interchanged.

`manifest.json` identifies schema version 1.0, job/task/run, model, annotation
fingerprint, range, dimensions, status, and preview FPS. It explicitly reports
unknown source timestamps as null. Object IDs persist across a run and reruns
seeded from its accepted predictions. Label IDs reference the CVAT installation.

## API

All endpoints inherit the job's organization and annotation permissions. Export
also requires annotation export permission; media access requires data access.

- `GET/POST /api/jobs/{id}/video-inference`
- `GET/DELETE /api/jobs/{id}/video-inference/{uuid}` (DELETE cancels)
- `POST /api/jobs/{id}/video-inference/{uuid}/accept`
- `GET /api/jobs/{id}/video-inference/{uuid}/preview` (supports byte ranges)
- `GET /api/jobs/{id}/video-inference/{uuid}/export`

A create request has `start_frame`, `stop_frame`, and `prompts`. Each prompt has
`kind: "shape"`, persisted `id`, `label_id`, `type`, and `points`. The backend
uses the saved shape geometry and attributes. Unsaved objects cannot be used.

## Validation

With the repository's Python test dependencies installed:

```bash
python manage.py test cvat.apps.video_annotation --settings=cvat.settings.testing
```

The suite covers mask encoding, permissions, invalid ranges, seekable preview,
annotation revision conflicts, idempotent acceptance, protected manual edits,
rerun replacement, cancellation, background processing, and export contents.
Set `SAM2_TEST_URL=http://sam2:8000` to additionally run the real GPU integration
test. Tests use generated media and a separate test database, not production
projects. Frontend validation uses `yarn build:cvat-ui` and ESLint on the changed
components.

## Interactive object post-processing

The SAM2 inspector lists objects separately with visibility and Solo controls.
Select an object to adjust the SAM2 logit threshold (-10 to 10, default 0), then
edge smoothing (0–10 source pixels). Each object keeps its own preview settings
while switching objects or frames in the open inspector. Sliders recompute masks
locally from cached inference scores without another model invocation. Compare
saved masks temporarily shows the currently stored masks; Reset preview resets
the selected object's settings. Opacity changes display only.

New runs retain full-resolution float32 logits in compressed per-frame artifacts,
separate from the database's binary mask results. This increases artifact storage
and per-frame network usage, especially for 4K and multi-object runs. Older runs
without scores still support smoothing; rerun inference to enable threshold.
The worker assembles streamed records without repeatedly rescanning accumulated
bytes and uses gzip level 1 for score files. Both changes preserve all float32
values while reducing CPU work that can otherwise leave the GPU waiting.
Threshold edits start from original inference scores, so they replace manual
corrections on the selected mask if explicitly applied. Smoothing alone starts
from the currently saved mask. Empty results cannot be applied.

Accept masks first, then **Apply to this object / frame** to save a preview to the
native annotation. Acceptance itself imports the original binary predictions;
it does not apply preview settings. Applying never changes other objects or
frames, and retains the existing revision-conflict checks. Preview parameters
are local to the inspector, not a saved video-wide processing recipe.

Run the standalone processing regression tests with:
`node --test tests/node/sam2-mask-processing.cjs`.

## Continuous playback regression

The native MP4 path follows Mnemosyne-OR's separation of video playback and
segmentation overlays. Video time drives the overlay; mask work never drives
video seeks. Playback displays local threshold, curve-fitting and cleanup previews,
including visibility, opacity and comparison with saved masks. Applying edits
refreshes the mask snapshot without restarting the video. Main-canvas and SAM2
viewers reuse the same original-quality fragments, including ongoing downloads.
The shared cache is bounded to 256 MiB with a seven-day retention window.

Run `python3 -m unittest cvat.apps.video_annotation.test_playback_snapshot -v`
and `node --test tests/node/sam2-*.cjs` for snapshot/timing/processing tests.

The browser regression generates a real twelve-second 1080p/25fps H.264 video,
uses the production segment encoder, builds the actual review component, and
simulates 64 Mbps original-video downloads and a delayed segment. It checks segment boundaries, disconnecting after
prefetch, IndexedDB reuse after reload, and uncached seeks loading only the
requested later segment. Its authenticated API is represented by fixtures;
it does not authenticate against a deployed CVAT instance.
Requires FFmpeg, Chrome, PyAV, repository Node dependencies and `playwright-core`:

```bash
CVAT_BROWSER_TEST_DEPS=/path/to/project-with-playwright-core \
  node tests/browser/sam2-native-playback.cjs
```

Set `CHROME_PATH` if Chrome is not at `/usr/bin/google-chrome`.

## On-demand segment playback for slow connections

Play loads 5-second, 360p/~400 kbps fragmented MP4 segments instead of the entire
original. The requested segment is downloaded first, followed by the next one;
playback begins after that initial preparation. MediaSource appends fragments to
one video decoder without replacing the video element at each boundary. Native
source timestamps are preserved and used to position original-resolution masks.
Pause/edit still uses original-resolution frames, not the 360p proxy.

The backend creates only requested segments, under the original video's
`playback/360p-400k-v1` directory, with a per-segment file lock and atomic writes.
Deleting the original video also removes this directory. Segment requests require
the same job-data permission as the original video endpoint.

IndexedDB retains downloaded segments across reloads. The cache is scoped by
video UUID and encoding profile, capped at 256 MiB using least-recently-used
removal, and expires entries after seven days. If IndexedDB is unavailable or
full, playback continues with network downloads. Seeks cancel the previous
playback's downloads and prioritize the target segment. Saved masks are fetched
fresh for each playback, so the video cache does not hide annotation changes.

Caching removes repeated transfers, not bandwidth limits: if sustained network
throughput is below the proxy bitrate, an uncached segment still needs buffering.
The initial current/next-segment download trades startup wait for continuity.

Run encoder tests with `python -m unittest
cvat.apps.video_annotation.test_video_segments -v`. The deployment encoder is
`libopenh264`; local PyAV builds without it can use `SAM2_TEST_CODEC=libx264` for
the tests. Set `PYAV_PYTHON` to that Python interpreter for the browser test.
