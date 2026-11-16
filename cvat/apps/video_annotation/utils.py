"""Serialization shared by inference, review, and export (no model dependencies)."""

import hashlib
import json

import numpy as np
from PIL import Image, ImageDraw


def iter_ndjson_lines(chunks):
    """Join large records once, instead of rescanning the growing line per chunk."""
    parts = []
    for chunk in chunks:
        if not chunk:
            continue
        lines = chunk.split(b"\n")
        parts.append(lines[0])
        if len(lines) == 1:
            continue
        yield b"".join(parts)
        yield from lines[1:-1]
        parts = [lines[-1]] if lines[-1] else []
    if parts:
        yield b"".join(parts)


def fingerprint(annotations):
    return hashlib.sha256(
        json.dumps(annotations, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def decode_mask(points, width, height):
    if len(points) < 5 or any(not np.isfinite(v) or int(v) != v for v in points):
        raise ValueError("Invalid mask encoding")
    *counts, x1, y1, x2, y2 = map(int, points)
    if not (0 <= x1 <= x2 < width and 0 <= y1 <= y2 < height):
        raise ValueError("Mask bounds exceed the image")
    if any(c < 0 for c in counts) or sum(counts) != (x2 - x1 + 1) * (y2 - y1 + 1):
        raise ValueError("Mask run lengths do not match bounds")
    bitmap = np.zeros((height, width), dtype=bool)
    bitmap[y1 : y2 + 1, x1 : x2 + 1] = np.repeat(np.arange(len(counts)) % 2, counts).reshape(
        y2 - y1 + 1, x2 - x1 + 1
    )
    return bitmap


def coco_rle(mask):
    # COCO's uncompressed RLE is column-major and starts with background.
    flat = np.asarray(mask, dtype=bool).ravel(order="F")
    edges = np.flatnonzero(np.diff(flat, prepend=False, append=False))
    counts = np.diff(np.concatenate(([0], edges, [len(flat)]))).tolist()
    if len(counts) % 2 == 0:
        counts.pop()  # trailing zero after a foreground run
    return {"size": list(mask.shape), "counts": counts}


def shape_signature(shape):
    return fingerprint(
        {
            k: shape.get(k)
            for k in (
                "frame",
                "label_id",
                "type",
                "points",
                "attributes",
                "occluded",
                "rotation",
                "source",
            )
        }
    )


def encode_mask(bitmap):
    ys, xs = bitmap.nonzero()
    if not len(xs):
        return None
    x1, x2, y1, y2 = int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())
    flat = bitmap[y1 : y2 + 1, x1 : x2 + 1].ravel()
    indices = np.flatnonzero(np.diff(flat, prepend=not flat[0], append=not flat[-1]))
    counts = np.diff(indices, prepend=[0]) if flat[0] else np.diff(indices)
    return counts.tolist() + [x1, y1, x2, y2]


def prompt_mask(prompt, width, height):
    if prompt["type"] == "polygon":
        image = Image.new("1", (width, height))
        ImageDraw.Draw(image).polygon(
            list(zip(prompt["points"][::2], prompt["points"][1::2])), fill=1
        )
        return np.asarray(image, dtype=bool)
    *counts, x1, y1, x2, y2 = map(int, prompt["points"])
    if not (0 <= x1 <= x2 < width and 0 <= y1 <= y2 < height) or any(c < 0 for c in counts):
        raise ValueError("Invalid mask bounds")
    if sum(counts) != (x2 - x1 + 1) * (y2 - y1 + 1):
        raise ValueError("Invalid mask counts")
    mask = np.zeros((height, width), dtype=bool)
    mask[y1 : y2 + 1, x1 : x2 + 1] = np.repeat(np.arange(len(counts)) % 2, counts).reshape(
        y2 - y1 + 1, x2 - x1 + 1
    )
    return mask
