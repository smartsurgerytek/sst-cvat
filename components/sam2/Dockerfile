ARG SAM_RUNTIME_IMAGE=pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime
FROM ${SAM_RUNTIME_IMAGE}
USER root
RUN command -v git >/dev/null || (apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*)
ENV SAM2_BUILD_CUDA=0 PYTHONUNBUFFERED=1 HF_HOME=/opt/sam2/huggingface HF_HUB_OFFLINE=0
RUN pip install --no-cache-dir --no-build-isolation \
    'git+https://github.com/facebookresearch/sam2.git@2b90b9f5ceec907a1c18123530e92e794ad901a4' \
    'fastapi==0.115.6' 'uvicorn==0.34.0' 'python-multipart==0.0.22' 'huggingface-hub==0.27.1'
ARG SAM2_MODEL=facebook/sam2.1-hiera-tiny
ENV SAM2_MODEL=${SAM2_MODEL}
RUN python -c "import os; from huggingface_hub import snapshot_download; snapshot_download(repo_id=os.environ['SAM2_MODEL'], allow_patterns=['*.pt'])"
ENV HF_HUB_OFFLINE=1
WORKDIR /app
COPY components/sam2/server.py /app/server.py
COPY cvat/apps/video_annotation/utils.py /app/mask_utils.py
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
