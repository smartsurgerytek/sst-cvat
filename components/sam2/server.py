"""Private, single-GPU SAM2 service. CVAT owns authentication and durable runs."""

import base64
import json
import os
import tempfile
import threading
import zipfile
from pathlib import Path

import torch
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from PIL import Image
from mask_utils import encode_mask, prompt_mask
from sam2.sam2_video_predictor import SAM2VideoPredictor

MODEL = os.getenv("SAM2_MODEL", "facebook/sam2.1-hiera-tiny")
DEVICE = os.getenv("SAM2_DEVICE", "auto")
torch.set_num_threads(int(os.getenv("SAM2_CPU_THREADS", "8")))
MAX_FRAMES = int(os.getenv("SAM2_MAX_FRAMES", "300"))
MAX_UPLOAD = 512 * 1024 * 1024
app = FastAPI()
lock = threading.Lock()
predictor = None
predictor_device = None


def execution_device():
    if DEVICE != "auto":
        return DEVICE
    if torch.cuda.is_available() and torch.cuda.mem_get_info()[0] >= 3 * 1024 ** 3:
        return "cuda"
    return "cpu"


@app.get("/health")
def health():
    if DEVICE == "cuda" and not torch.cuda.is_available():
        raise HTTPException(503, "CUDA is unavailable")
    return {"model": MODEL, "device": execution_device(), "preferred_device": DEVICE,
            "busy": lock.locked()}


@app.post("/infer")
def infer(frames: UploadFile = File(...), prompts: str = Form(...), model: str = Form(...)):
    if model != MODEL:
        raise HTTPException(400, "Unsupported model")
    seeds = json.loads(prompts)
    if not 1 <= len(seeds) <= 10:
        raise HTTPException(400, "Select 1–10 objects")
    if not lock.acquire(blocking=False):
        raise HTTPException(503, "Inference service is busy; retry when the current run completes")
    tmp = tempfile.TemporaryDirectory()
    try:
        frames.file.seek(0, 2)
        if frames.file.tell() > MAX_UPLOAD:
            raise ValueError("Frame upload exceeds 512 MiB")
        frames.file.seek(0)
        with zipfile.ZipFile(frames.file) as archive:
            entries = archive.infolist()
            if (
                not 2 <= len(entries) <= MAX_FRAMES
                or sum(x.file_size for x in entries) > MAX_UPLOAD
            ):
                raise ValueError("Frame count or size limit exceeded")
            for i, item in enumerate(entries):
                if item.filename != f"{i:06d}.jpg":
                    raise ValueError("Expected contiguous numbered JPEG frames")
                # Explicit file paths; never extract user-controlled archive paths.
                with archive.open(item) as source, Image.open(source) as image:
                    if image.width * image.height > 3840 * 2160:
                        raise ValueError("Maximum frame size is 4K")
                    image.convert("RGB").save(Path(tmp.name) / item.filename)
    except Exception:
        tmp.cleanup()
        lock.release()
        raise
    finally:
        frames.file.close()

    def generate():
        global predictor, predictor_device
        state = None
        try:
            with torch.inference_mode():
                device = execution_device()
                if predictor is None or predictor_device != device:
                    predictor = None
                    if torch.cuda.is_available():
                        torch.cuda.empty_cache()
                    predictor = SAM2VideoPredictor.from_pretrained(
                        MODEL, device=device,
                        # SAM2 otherwise warms a CUDA cache even for a CPU model.
                        hydra_overrides_extra=["++model.image_encoder.neck.position_encoding.warmup_cache=false"],
                    )
                    predictor_device = device
                state = predictor.init_state(
                    video_path=tmp.name, offload_video_to_cpu=True, offload_state_to_cpu=True
                )
                for i, prompt in enumerate(seeds):
                    predictor.add_new_mask(
                        state,
                        frame_idx=0,
                        obj_id=i,
                        mask=prompt_mask(prompt, state["video_width"], state["video_height"]),
                    )
                for index, object_ids, logits in predictor.propagate_in_video(state):
                    masks = {
                        int(oid): encode_mask((logits[i, 0] > 0).cpu().numpy())
                        for i, oid in enumerate(object_ids)
                    }
                    scores = {
                        int(oid): base64.b64encode(
                            logits[i, 0].detach().cpu().numpy().astype("<f4").tobytes()
                        ).decode("ascii")
                        for i, oid in enumerate(object_ids)
                    }
                    yield json.dumps(
                        {
                            "frame": index,
                            "objects": [
                                {"object_id": p["object_id"], "points": masks.get(i),
                                 "logits": scores.get(i)}
                                for i, p in enumerate(seeds)
                            ],
                        }
                    ) + "\n"
        except Exception as exc:
            import logging

            logging.exception("SAM2 inference failed")
            yield json.dumps({"error": type(exc).__name__ + ": inference failed"}) + "\n"
        finally:
            if state is not None:
                predictor.reset_state(state)
            tmp.cleanup()
            lock.release()

    return StreamingResponse(generate(), media_type="application/x-ndjson")
