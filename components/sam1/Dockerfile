ARG SAM_RUNTIME_IMAGE=pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime
FROM ${SAM_RUNTIME_IMAGE}
USER root
RUN command -v git >/dev/null || (apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*)
RUN pip install --no-cache-dir \
    'git+https://github.com/facebookresearch/segment-anything.git@6fdee8f2727f4506cfbbe553e23b895e27956588' \
    'fastapi==0.115.6' 'uvicorn==0.34.0' 'python-multipart==0.0.22' 'numpy<2'
# Download during build, outside any runtime cache volume.
RUN mkdir -p /opt/sam1 && python -c "from urllib.request import urlretrieve; urlretrieve('https://dl.fbaipublicfiles.com/segment_anything/sam_vit_b_01ec64.pth', '/opt/sam1/sam_vit_b_01ec64.pth')"
ENV PYTHONUNBUFFERED=1 SAM1_CHECKPOINT=/opt/sam1/sam_vit_b_01ec64.pth
WORKDIR /app
COPY components/sam1/server.py /app/server.py
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
