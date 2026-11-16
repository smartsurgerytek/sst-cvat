#!/usr/bin/env bash
# Run CVAT Compose with build cache and persistent volumes on D.
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
storage=/mnt/cvat-container-storage
if ! mountpoint -q "$storage" || [ "$(findmnt -n -o FSTYPE --target "$storage")" != ext4 ]; then
    echo 'CVAT storage on D is not mounted. Run: sudo mount /mnt/cvat-container-storage' >&2
    exit 1
fi
cd "$repo"
export BUILDX_BUILDER=sst-cvat-d
exec docker compose -p sst_cvat -f docker-compose.yml -f docker-compose.dev.yml \
    -f components/serverless/docker-compose.serverless.yml -f docker-compose.storage-d.yml "$@"
