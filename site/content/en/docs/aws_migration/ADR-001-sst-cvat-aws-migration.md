# ADR-001: CVAT Infrastructure Migration from GCP to AWS

| Field | Detail |
| --- | --- |
| **ADR Number** | ADR-001 |
| **Title** | CVAT Infrastructure Migration from GCP to AWS |
| **Project** | sst-cvat |
| **Status** | Accepted |
| **Date** | 2026-03-09 |
| **Author** | Krishtopher Rathod |
| **Reviewed By** | Manchi (梁文智), Winnie 郭惠妮, Bo-An |

---

## Context

The SmartSurgeryTek CVAT annotation platform was previously hosted on Google Cloud Platform
(GCP). As part of infrastructure standardization and cost optimization, the decision was made
to migrate all three CVAT environments (INT, STG, PROD) to Amazon Web Services (AWS).

The migration required rebuilding all environments from scratch due to:
- GCP Marketplace AMI restrictions preventing instance type changes
- GPU capacity issues in the ap-northeast-1 (Tokyo) region
- Need to standardize all environments on a consistent GPU instance type

---

## Decision

Migrate all three CVAT environments to AWS `us-east-1` (Virginia) region using GPU-enabled
EC2 instances with the `Deep Learning OSS Nvidia Driver AMI GPU PyTorch 2.9 (Ubuntu 24.04)`
base image.

---

## Environments

| Environment | Instance ID | Instance Type | Region | Elastic IP | Domain |
| --- | --- | --- | --- | --- | --- |
| INT | i-051eeed5792b570a5 | g6.xlarge | us-east-1 | 54.209.14.130 | cvat-int.getsmartsurgery.net |
| STG | i-0a88f11eb5a1008f7 | g6.xlarge | us-east-1 | 184.72.100.245 | cvat-stg.getsmartsurgery.net |
| PROD | i-0375d00a684ba7327 | g6.4xlarge | us-east-1 | 3.224.187.219 | cvat.getsmartsurgery.net |

**AMI:** `Deep Learning OSS Nvidia Driver AMI GPU PyTorch 2.9 (Ubuntu 24.04) 20260214`
**AMI ID:** `ami-0f3d7b789119ccbfa`
**GPU:** NVIDIA L4, Driver 580.126.09, CUDA 13.0, 23GB VRAM

---

## Implementation Steps

### 1. EC2 Instance Setup (all environments)

```bash
# Verify GPU
nvidia-smi

# Install Docker
sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli docker-compose-plugin

# Configure NVIDIA container runtime
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker

# Add ubuntu user to docker group
sudo usermod -aG docker ubuntu && newgrp docker

# Clone CVAT repo
git clone -b feature/aws-migration https://github.com/smartsurgerytek/sst-cvat.git
```

### 2. Environment Configuration

Create `.env` file before first startup:

```bash
# For STG
cat > ~/sst-cvat/.env << EOF
CVAT_HOST=cvat-stg.getsmartsurgery.net
ACME_EMAIL=krishtopher.rathod@faciletechnolab.com
EOF

# For INT
cat > ~/sst-cvat/.env << EOF
CVAT_HOST=cvat-int.getsmartsurgery.net
ACME_EMAIL=krishtopher.rathod@faciletechnolab.com
EOF
```

### 3. Manual CVAT Startup

```bash
# STG
docker compose -f docker-compose.yml -f docker-compose.stg.yml -f docker-compose.https.yml up -d

# INT
docker compose -f docker-compose.yml -f docker-compose.int.yml -f docker-compose.https.yml up -d
```

### 4. CI/CD Workflow Updates

Updated the following files in the `feature/aws-migration` branch:

| File | Change |
| --- | --- |
| `.github/workflows/deploy-stg.yml` | `AWS_REGION` → `us-east-1`, `DEPLOY_PATH` → `/home/ubuntu/sst-cvat` |
| `.github/workflows/deploy-int.yml` | Same as above |
| `.github/workflows/build-images-aws.yml` | `AWS_REGION` → `us-east-1` |

**GitHub Secret updated:**
- `AWS_REGION` → `us-east-1`

**ECR Repositories (us-east-1):**
- `587128718062.dkr.ecr.us-east-1.amazonaws.com/cvat-server`
- `587128718062.dkr.ecr.us-east-1.amazonaws.com/cvat-ui`

### 5. Database Fix

Applied on all three environments to resolve "Finish Job" schema mismatch error:

```bash
docker exec -it cvat_db psql -U root -d cvat -c \
  "ALTER TABLE engine_labeledshape DROP COLUMN IF EXISTS score;"
```

**Root cause:** Old GCP data exports contained a `score` column that does not exist in the
new CVAT schema, causing `IntegrityError` on data import.

### 6. Nuclio FDI Segmentation Functions

Deployed on all three environments using `dentistry-inference-core` repo (`develop` branch):

```bash
# Install nuctl (if not present)
curl -s https://api.github.com/repos/nuclio/nuclio/releases/latest \
  | grep -i "browser_download_url.*nuctl.*$(uname)" \
  | cut -d : -f 2,3 \
  | tr -d \" \
  | wget -O nuctl -qi - && chmod +x nuctl && sudo mv nuctl /usr/local/bin/

# Create Nuclio project
nuctl create project cvat

# Deploy using script
bash ~/deploy-fdi-functions.sh <HUGGINGFACE_TOKEN>
```

**Functions deployed:**

| Function | Port | Description |
| --- | --- | --- |
| `pth-facebookresearch-sam-vit-h` | 32768 | SAM segmentation model |
| `dentistry-pano-fdi-segmentation-2512` | 32793 | FDI panoramic segmentation |
| `dentistry-pano-fdi-segmentation-2512_flip` | 32794 | FDI panoramic segmentation (flipped) |

**Key fix:** HuggingFace token must be passed as `--env HUGGINGFACE_TOKEN` directly in the
`nuctl deploy` command. The `credential.yaml` approach does not work because the container
reads from a relative path (`./conf/`) inside `/opt/nuclio`, not from the host filesystem.

**Port fix (Bo-An, 11 Mar 2026):** Added `"publishMode": "hostPort"` to platform config for consistent port mapping:
```bash
--platform-config '{"attributes": {"network": "cvat_cvat", "publishMode": "hostPort"}}'
```

---

## Deployment Script

A single-command deployment script was created for Nuclio FDI functions to avoid CI/CD
complexity due to the `dentistry-inference-core` repo branch strategy:

```bash
# Location on each VM
~/deploy-fdi-functions.sh

# Usage
bash ~/deploy-fdi-functions.sh <HUGGINGFACE_TOKEN>
```

Script performs: repo clone/pull → nuctl verify → directory setup → deploy FDI → deploy FDI flip → health check.

---

## SSH Access

Key files location: `D:\Krishtopher\connect\`

| Environment | Key File | Host |
| --- | --- | --- |
| INT | `sst-int-cvat-virginia-key.pem` | 54.209.14.130 |
| STG | `sst-stg-cvat-virginia-key.pem` | 184.72.100.245 |
| PROD | `sst-cvat-key.pem` | 3.224.187.219 |

---

## Consequences

### Positive
- All environments now on consistent GPU hardware (NVIDIA L4)
- Standardized on AWS us-east-1 reducing cross-region latency
- CI/CD pipelines updated and working for all environments
- FDI segmentation functions deployed and healthy on all 3 environments

### Negative / Risks
- Old GCP Tokyo VMs (INT: `i-09b5a822642593e63`, STG: `i-0ce97e75b0ed3c575`) still running — need to be terminated
- nuctl version differs between environments: PROD uses `1.13.0`, INT/STG use `1.15.20`
- GitHub credentials required during `git pull` in deploy script (HTTPS cloning) — should be switched to SSH
