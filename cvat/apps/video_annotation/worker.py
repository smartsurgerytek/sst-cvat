import base64
import gzip
import io
import json
import logging
import shutil
import tempfile
import zipfile
from pathlib import Path

import av
import numpy as np
import requests
from django.conf import settings
from PIL import Image, ImageDraw

from cvat.apps.engine.frame_provider import FrameOutputType, JobFrameProvider
from .models import InferenceRun
from .utils import decode_mask, iter_ndjson_lines

logger = logging.getLogger(__name__)


def run_directory(run):
    return Path(settings.DATA_ROOT) / "video_inference" / str(run.job_id) / str(run.id)


def active(run):
    return InferenceRun.objects.filter(pk=run.pk, status="running").exists()


def execute(run_id):
    if not InferenceRun.objects.filter(pk=run_id, status="queued").update(status="running"):
        return
    run = InferenceRun.objects.select_related("job__segment__task__data").get(pk=run_id)
    provider = JobFrameProvider(run.job)
    directory = run_directory(run)
    directory.mkdir(parents=True, exist_ok=True)
    try:
        with tempfile.TemporaryDirectory(dir=directory) as tmp:
            archive_path = Path(tmp) / "frames.zip"
            with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_STORED) as archive:
                for index, frame in enumerate(range(run.start_frame, run.stop_frame + 1)):
                    if not active(run):
                        return
                    image = provider.get_frame(frame, out_type=FrameOutputType.PIL).data.convert(
                        "RGB"
                    )
                    width, height = image.size
                    stream = io.BytesIO()
                    image.save(stream, format="JPEG", quality=95)
                    archive.writestr(f"{index:06d}.jpg", stream.getvalue())
                    InferenceRun.objects.filter(pk=run.pk, status="running").update(
                        progress=int((index + 1) / (run.stop_frame - run.start_frame + 1) * 20),
                    )
            results = []
            expected_frame = 0
            with (
                archive_path.open("rb") as source,
                requests.post(
                    settings.SAM2_URL + "/infer",
                    files={"frames": ("frames.zip", source, "application/zip")},
                    data={"prompts": json.dumps(run.prompts), "model": run.model},
                    stream=True,
                    timeout=(10, 600),
                ) as response,
            ):
                response.raise_for_status()
                for line in iter_ndjson_lines(response.iter_content(chunk_size=65536)):
                    if not active(run):
                        return
                    if not line:
                        continue
                    entry = json.loads(line)
                    if "error" in entry:
                        raise RuntimeError(entry["error"])
                    if entry["frame"] != expected_frame or len(entry["objects"]) != len(
                        run.prompts
                    ):
                        raise RuntimeError("Incomplete or out-of-order inference output")
                    scores = {}
                    for obj, prompt in zip(entry["objects"], run.prompts):
                        if obj["object_id"] != prompt["object_id"]:
                            raise RuntimeError("Inference object identity mismatch")
                        encoded = obj.pop("logits", None)
                        if encoded is not None:
                            raw = base64.b64decode(encoded, validate=True)
                            if len(raw) != width * height * 4 or not np.isfinite(np.frombuffer(raw, dtype="<f4")).all():
                                raise RuntimeError("Invalid inference logits")
                            scores[obj["object_id"]] = encoded
                        if obj["points"] is not None:
                            decode_mask(obj["points"], width, height)
                    entry["frame"] += run.start_frame
                    if scores:
                        # Level 1 preserves every score while avoiding level 9's CPU bottleneck.
                        with gzip.open(directory / f"logits-{entry['frame']}.json.gz", "wt", compresslevel=1) as output:
                            json.dump(scores, output)
                    results.append(entry)
                    expected_frame += 1
                    InferenceRun.objects.filter(pk=run.pk, status="running").update(
                        progress=min(
                            90, 20 + int(expected_frame / (run.stop_frame - run.start_frame + 1) * 70)
                        ),
                    )
            if expected_frame != run.stop_frame - run.start_frame + 1:
                raise RuntimeError("Inference ended before all frames were processed")
            result = {"width": width, "height": height, "frames": results}
            if not active(run):
                return
            InferenceRun.objects.filter(pk=run.pk, status="running").update(
                result=result,
                progress=100,
                status="ready",
            )
    except Exception:
        logger.exception("Video inference %s failed", run_id)
        InferenceRun.objects.filter(pk=run.pk, status="running").update(
            status="failed",
            error="Inference failed. Check the SAM2 and annotation worker logs; retry with a shorter range.",
        )
    finally:
        provider.unload()
        if (
            not active(run)
            and not InferenceRun.objects.filter(
                pk=run.pk, status__in=["ready", "accepted"]
            ).exists()
        ):
            shutil.rmtree(directory, ignore_errors=True)


def render_preview(run, provider, result, output):
    # This review clip deliberately uses 10 sampled frames/s, not source-video time.
    # The visible CVAT frame number is the authoritative navigation reference.
    width, height = result["width"], result["height"]
    with av.open(str(output), mode="w", options={"movflags": "+faststart"}) as container:
        stream = container.add_stream("libopenh264", rate=10)
        stream.width = width + width % 2
        stream.height = height + height % 2
        stream.pix_fmt = "yuv420p"
        for preview_index, entry in enumerate(result["frames"]):
            if not active(run):
                raise RuntimeError("Cancelled")
            image = provider.get_frame(entry["frame"], out_type=FrameOutputType.PIL).data.convert(
                "RGB"
            )
            pixels = np.asarray(image).copy()
            for index, obj in enumerate(entry["objects"]):
                if obj["points"] is None:
                    continue
                mask = decode_mask(obj["points"], width, height)
                color = np.array(
                    [(index * 73 + 45) % 256, (index * 137 + 190) % 256, (index * 53 + 85) % 256]
                )
                pixels[mask] = (pixels[mask] * 0.55 + color * 0.45).astype(np.uint8)
            image = Image.fromarray(pixels)
            draw = ImageDraw.Draw(image)
            draw.rectangle((0, 0, min(width, 400), 20), fill="black")
            draw.text(
                (4, 3), f"CVAT frame {entry['frame']} | review playback: 10 frames/s", fill="white"
            )
            padded = Image.new("RGB", (stream.width, stream.height))
            padded.paste(image)
            for packet in stream.encode(av.VideoFrame.from_image(padded)):
                container.mux(packet)
            InferenceRun.objects.filter(pk=run.pk, status="running").update(
                progress=90 + int((preview_index + 1) / len(result["frames"]) * 9),
            )
        for packet in stream.encode():
            container.mux(packet)
