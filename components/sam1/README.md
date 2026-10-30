# SAM1 point annotation

The left toolbar's **SAM1** button starts interactive segmentation on the current
frame. Hover over it to choose a label or enable **Convert masks to polygons**;
mask is the default. Left-click adds a positive (foreground) point; right-click
adds a negative (background) point. Each change updates the preview. Click an
existing point to remove it. Wait for the preview, then click **SAM1** again to
create the annotation. Escape cancels. Save annotations using the normal CVAT
Save action. Polygon conversion follows CVAT's existing contour approximation;
use masks to preserve holes and disconnected regions.

The private service uses Meta's SAM1 ViT-B. It caches the most recent image
embedding and serializes inference to prevent prompts from mixing across users.
The CVAT endpoint checks job annotation-write and image-read access, frame bounds,
deleted frames, finite coordinates, and the 256-point / 4K limits.

## Build and start

Both SAM1 and SAM2 model downloads are in their Dockerfiles. SAM1 weights live in
`/opt/sam1`; SAM2 weights live in `/opt/sam2/huggingface`, outside the existing
`/models` volume. SAM2 runs with Hugging Face offline mode enabled. Changing
`SAM2_MODEL` requires rebuilding; Compose passes the same value to build and run.

For the existing installation, retain its project name and overrides:

```bash
docker compose -p sst_cvat --profile sam2 \
  -f docker-compose.yml -f docker-compose.dev.yml \
  -f components/serverless/docker-compose.serverless.yml \
  up -d --build sam1 sam2 cvat_server cvat_ui
```

Compose reserves an NVIDIA GPU for both inference services, as with the existing
SAM2 deployment. Model weights are downloaded during the build, so that build
requires network access and enough disk space. No inference service port is
exposed on the host.

## Checks

```bash
node --test tests/node/sam1-control.cjs
python -m unittest discover -s tests/python -p test_sam1_proxy_unit.py
```

The proxy unit tests need Django, Django REST Framework, requests, and Pillow;
they mock media storage and model inference and do not need a database or GPU.
