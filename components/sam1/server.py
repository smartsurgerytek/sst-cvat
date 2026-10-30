"""Private SAM1 point-prompt service; CVAT handles authentication and job access."""
import hashlib
import io
import json
import os
import threading

import numpy as np
import torch
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from PIL import Image
from segment_anything import SamPredictor, sam_model_registry

app = FastAPI()
lock = threading.Lock()
predictor = None
image_digest = None
torch.set_num_threads(int(os.getenv("SAM1_CPU_THREADS", "8")))


@app.get("/health")
def health():
    return {"model": "sam1-vit-b", "busy": lock.locked()}


@app.post("/infer")
def infer(image: UploadFile = File(...), prompts: str = Form(...)):
    global predictor, image_digest
    if not lock.acquire(blocking=False):
        raise HTTPException(503, "SAM1 is busy; try again shortly")
    try:
        raw = image.file.read(32 * 1024 * 1024 + 1)
        if len(raw) > 32 * 1024 * 1024:
            raise HTTPException(400, "Image exceeds 32 MiB")
        with Image.open(io.BytesIO(raw)) as source:
            if source.width * source.height > 3840 * 2160:
                raise HTTPException(400, "Maximum image size is 4K")
            rgb = np.array(source.convert("RGB"))
        data = json.loads(prompts)
        positive, negative = data["pos_points"], data["neg_points"]
        coords = np.asarray(positive + negative, dtype=np.float32)
        if (not positive or len(coords) > 256 or coords.shape != (len(coords), 2)
                or not np.isfinite(coords).all() or (coords < 0).any()
                or (coords[:, 0] >= rgb.shape[1]).any() or (coords[:, 1] >= rgb.shape[0]).any()):
            raise HTTPException(400, "Invalid point prompts")
        with torch.inference_mode():
            if predictor is None:
                device = os.getenv("SAM1_DEVICE", "auto")
                if device == "auto":
                    device = "cuda" if torch.cuda.is_available() else "cpu"
                model = sam_model_registry["vit_b"](checkpoint=os.environ["SAM1_CHECKPOINT"])
                model.to(device=device)
                predictor = SamPredictor(model)
            digest = hashlib.sha256(raw).digest()
            if image_digest != digest:
                image_digest = None
                predictor.set_image(rgb)
                image_digest = digest
            masks, scores, _ = predictor.predict(
                point_coords=coords,
                point_labels=np.asarray([1] * len(positive) + [0] * len(negative)),
                multimask_output=True,
            )
        mask = masks[int(np.argmax(scores))]
        ys, xs = np.nonzero(mask)
        if not len(xs):
            raise HTTPException(422, "No mask found; adjust the foreground points")
        left, top, right, bottom = int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())
        return {"mask": mask[top:bottom + 1, left:right + 1].astype(np.uint8).tolist(),
                "bounds": [left, top, right, bottom]}
    finally:
        image.file.close()
        lock.release()
