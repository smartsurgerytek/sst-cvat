"""Burn saved CVAT geometry, object badges, legend and phase tags into video frames."""
import math
from fractions import Fraction
from functools import lru_cache
from pathlib import Path

import av
import numpy as np
from PIL import Image, ImageColor, ImageDraw, ImageFont

from .utils import decode_mask


@lru_cache(maxsize=8)
def export_font(size):
    for path in (
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ):
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def color_of(label):
    try:
        return ImageColor.getrgb(label.get("color", "#808080"))[:3]
    except ValueError:
        return (128, 128, 128)


def rotated(points, angle, center):
    angle = math.radians(angle)
    cosine, sine = math.cos(angle), math.sin(angle)
    cx, cy = center
    return [(cx + (x - cx) * cosine - (y - cy) * sine,
             cy + (x - cx) * sine + (y - cy) * cosine) for x, y in points]


def geometry(layer, shape, color, opacity, stroke):
    """Draw visible geometry and return the label anchor."""
    if shape.get("outside"):
        return None
    draw = ImageDraw.Draw(layer)
    points = shape.get("points", [])
    kind = shape["type"]
    fill, outline = (*color, round(opacity * 255)), (*color, 255)
    if not points:
        return None
    if kind == "mask":
        mask = Image.fromarray(decode_mask(points, *layer.size).astype(np.uint8) * fill[3])
        colored = Image.new("RGBA", layer.size, (*color, 0))
        colored.putalpha(mask)
        layer.alpha_composite(colored)
        return tuple(points[-4:-2])
    pairs = list(zip(points[::2], points[1::2]))
    if kind == "rectangle":
        x1, y1, x2, y2 = points
        pairs = rotated([(x1, y1), (x2, y1), (x2, y2), (x1, y2)], shape.get("rotation", 0),
                        ((x1 + x2) / 2, (y1 + y2) / 2))
        draw.polygon(pairs, fill=fill)
        draw.line(pairs + pairs[:1], fill=outline, width=stroke, joint="curve")
    elif kind == "ellipse":
        cx, cy, right, top = points
        rx, ry = abs(right - cx), abs(top - cy)
        pairs = rotated([(cx + rx * math.cos(t * math.pi / 90), cy + ry * math.sin(t * math.pi / 90))
                         for t in range(180)], shape.get("rotation", 0), (cx, cy))
        draw.polygon(pairs, fill=fill)
        draw.line(pairs + pairs[:1], fill=outline, width=stroke)
    elif kind == "polygon":
        draw.polygon(pairs, fill=fill)
        draw.line(pairs + pairs[:1], fill=outline, width=stroke, joint="curve")
    elif kind == "polyline":
        draw.line(pairs, fill=outline, width=stroke, joint="curve")
    elif kind == "points":
        for x, y in pairs:
            draw.ellipse((x - stroke * 2, y - stroke * 2, x + stroke * 2, y + stroke * 2), fill=outline)
    else:
        raise ValueError(f"Video export does not support shape type: {kind}")
    return min(x for x, _ in pairs), min(y for _, y in pairs)


def fit_text(draw, text, font, width):
    if draw.textlength(text, font=font) <= width:
        return text
    while text and draw.textlength(text + "…", font=font) > width:
        text = text[:-1]
    return text + "…"


def render_frame(image, shapes, phases, labels, options, frame_number, identities=None):
    image = image.convert("RGBA")
    width, height = image.size
    size = max(14, min(32, round(height / 36)))
    font = export_font(size)
    stroke = max(2, round(height / 360))
    identities = identities or {}
    badges, active = [], set()
    for shape in sorted(shapes, key=lambda item: item.get("z_order", 0)):
        label = labels.get(shape["label_id"], {"name": str(shape["label_id"])})
        color = color_of(label)
        layer = Image.new("RGBA", image.size)
        anchor = geometry(layer, shape, color, options["opacity"], stroke)
        if anchor is None:
            continue
        image = Image.alpha_composite(image, layer)
        active.add(shape["label_id"])
        identity = shape.get("track_id") if "track_id" in shape else identities.get(
            str(shape.get("id")), shape.get("id", ""))
        badges.append((anchor, f'{label["name"]} #{identity}', color))
    draw = ImageDraw.Draw(image)
    if options["show_names"]:
        for (x, y), text, color in badges:
            text = fit_text(draw, text, font, max(1, width - 12))
            box = draw.textbbox((0, 0), text, font=font)
            badge_width, badge_height = box[2] + 10, size + 10
            x, y = max(0, min(x, width - badge_width)), max(0, min(y - badge_height, height - badge_height))
            draw.rectangle((x, y, x + badge_width, y + badge_height), fill=(20, 20, 20, 230))
            draw.rectangle((x, y, x + 4, y + badge_height), fill=color)
            draw.text((x + 7, y + 3), text, fill="white", font=font)

    # A side panel preserves the image and avoids covering small objects with the legend.
    if options["show_legend"] or options["show_phase"]:
        panel_width = max(240, size * 14)
        line_height = size + 12
        rows_per_column = max(1, (height - 24) // line_height)
        maximum_rows = 1 + (len(labels) + 1) * int(options["show_legend"]) + (len(labels) + 2) * int(options["show_phase"])
        columns = math.ceil(maximum_rows / rows_per_column)
        rows = [(f"Frame {frame_number}", None)]
        if options["show_phase"]:
            rows.append(("Phase", None))
            phase_ids = sorted({tag["label_id"] for tag in phases})
            rows.extend((labels.get(label_id, {"name": str(label_id)})["name"],
                         color_of(labels.get(label_id, {}))) for label_id in phase_ids)
            if not phase_ids:
                rows.append(("—", None))
        if options["show_legend"]:
            rows.append(("Objects", None))
            rows.extend((labels.get(label_id, {"name": str(label_id)})["name"],
                         color_of(labels.get(label_id, {}))) for label_id in sorted(active))
        canvas = Image.new("RGBA", (width + panel_width * columns, height), (24, 27, 33, 255))
        canvas.paste(image, (0, 0))
        draw = ImageDraw.Draw(canvas)
        for index, (text, color) in enumerate(rows):
            column = index // rows_per_column
            y = 12 + index % rows_per_column * line_height
            left = width + column * panel_width + 14
            if color:
                draw.rectangle((left, y + 5, left + size - 4, y + size + 1), fill=color)
                left += size + 6
            text = fit_text(draw, text, font, width + (column + 1) * panel_width - left - 12)
            draw.text((left, y), text, fill="white", font=font)
        image = canvas
    # H.264 yuv420p requires even dimensions; pad instead of stretching geometry.
    output = Image.new("RGB", (image.width + image.width % 2, image.height + image.height % 2))
    output.paste(image.convert("RGB"), (0, 0))
    return output


def frame_durations(frames, timestamps, duration):
    """Keep each included frame's source duration; deleted frames do not lengthen the export."""
    durations = []
    for frame in frames:
        end = timestamps[frame + 1] if frame + 1 < len(timestamps) else duration
        durations.append(max(1 / 90000, end - timestamps[frame]))
    return durations


def encode_video(path, frames, durations, image_at, progress=lambda value: None):
    clock = Fraction(1, 90000)
    first_image = image_at(frames[0])
    rate = Fraction(min(120, max(1, len(frames) / sum(durations)))).limit_denominator(1000)
    with av.open(str(path), "w", format="mp4", options={"movflags": "+faststart"}) as output:
        codec = "libx264" if "libx264" in av.codecs_available else "libopenh264"
        stream = output.add_stream(codec, rate=rate)
        stream.width, stream.height, stream.pix_fmt = first_image.width, first_image.height, "yuv420p"
        stream.bit_rate = max(2000000, stream.width * stream.height * 4)
        stream.codec_context.time_base = clock
        stream.codec_context.max_b_frames = 0
        stream.codec_context.thread_count = 2
        packet_durations = {}
        position = 0

        def mux(packet):
            packet.duration = packet_durations.pop(packet.pts, packet.duration)
            output.mux(packet)

        for index, (number, duration) in enumerate(zip(frames, durations)):
            image = first_image if index == 0 else image_at(number)
            frame = av.VideoFrame.from_image(image)
            frame.pts, frame.time_base = position, clock
            ticks = max(1, round(duration / clock))
            packet_durations[position] = ticks
            position += ticks
            for packet in stream.encode(frame):
                mux(packet)
            progress(int((index + 1) * 100 / len(frames)))
        for packet in stream.encode():
            mux(packet)
