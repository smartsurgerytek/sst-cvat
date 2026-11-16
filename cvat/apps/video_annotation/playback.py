"""Compact immutable playback snapshot; never include raw inference scores."""


def build_playback_snapshot(run, labels, current_shapes=None):
    frames = {frame: [] for frame in range(run.start_frame, run.stop_frame + 1)}

    def append(frame, object_id, label_id, points):
        if frame not in frames or points is None:
            return
        label = labels.get(label_id)
        frames[frame].append({"object_id": object_id, "points": points,
                              "label_color": label.color if label else "#808080"})

    if run.status == "accepted":
        shapes = {shape["id"]: shape for shape in current_shapes or []}
        for saved in run.accepted_shapes:
            shape = shapes.get(saved["id"])
            if shape is not None and shape["type"] == "mask":
                append(shape["frame"], saved["object_id"], shape["label_id"], shape["points"])
    else:
        prompts = {prompt["object_id"]: prompt for prompt in run.prompts}
        for entry in run.result["frames"]:
            for obj in entry["objects"]:
                append(entry["frame"], obj["object_id"], prompts[obj["object_id"]]["label_id"], obj["points"])
    return {"width": run.result["width"], "height": run.result["height"],
            "frames": [{"frame": frame, "objects": objects} for frame, objects in frames.items()]}


def preview_masks(payload):
    """Small playback-only score planes. Editing/apply keeps original-resolution masks."""
    import base64
    import numpy as np
    from .utils import decode_mask, encode_mask

    width, height = payload["width"], payload["height"]
    preview_height = min(180, height)
    preview_width = max(1, round(width * preview_height / height))
    rows = np.minimum(np.arange(preview_height) * height // preview_height, height - 1)
    cols = np.minimum(np.arange(preview_width) * width // preview_width, width - 1)
    objects = []
    for obj in payload["objects"]:
        mask = decode_mask(obj["points"], width, height)
        points = encode_mask(mask[np.ix_(rows, cols)])
        scores = obj.get("logits")
        if scores:
            values = np.frombuffer(base64.b64decode(scores), dtype="<f4").reshape(height, width)
            scores = base64.b64encode(values[np.ix_(rows, cols)].astype("<f4").tobytes()).decode("ascii")
        objects.append({**obj, "points": points, "logits": scores})
    return {**payload, "width": preview_width, "height": preview_height,
            "source_height": height, "objects": objects}
