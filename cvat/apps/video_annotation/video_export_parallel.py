"""Bounded process parallelism for a single video, followed by lossless MP4 remuxing."""
import json
import math
import multiprocessing
import os
import shutil
import time
from contextlib import contextmanager
from concurrent.futures import ProcessPoolExecutor, as_completed
from fractions import Fraction
from functools import lru_cache
from pathlib import Path


from .export_hardware import cpu_budget, detect_hardware, render_budget


def process_count(frame_count, width=1920, height=1080):
    import logging
    import django_rq
    from rq.registry import StartedJobRegistry
    hardware = detect_hardware()
    active = max(1, len(StartedJobRegistry(queue=django_rq.get_queue("export")).get_job_ids()))
    processes = max(1, min(render_budget(hardware, width, height) // active, frame_count // 60))
    logging.getLogger(__name__).info("Video export hardware=%s active_exports=%s render_processes=%s resolution=%sx%s",
                                     hardware, active, processes, width, height)
    return processes


@contextmanager
def cpu_slot(directory, budget):
    """Enforce the shared budget even when another export starts after this one."""
    import fcntl
    root = Path(directory)
    root.mkdir(parents=True, exist_ok=True)
    while True:
        for offset in range(budget):
            handle = (root / f"slot-{(os.getpid() + offset) % budget}.lock").open("a")
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                handle.close()
                continue
            try:
                yield
            finally:
                handle.close()
            return
        time.sleep(.05)


def initialize_process():
    # Each process already owns its own codec threads. Do not start a BLAS pool as well.
    for name in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS"):
        os.environ[name] = "1"


@lru_cache(maxsize=1)
def read_snapshot(path):
    return json.loads(Path(path).read_text())


def render_piece(snapshot_path, source_spec, frames, durations, output_path, rate):
    with cpu_slot(source_spec["slots_root"], source_spec["cpu_budget"]):
        return _render_piece(snapshot_path, source_spec, frames, durations, output_path, rate)


def _render_piece(snapshot_path, source_spec, frames, durations, output_path, rate):
    from collections import defaultdict
    from .video_export_render import encode_video, render_comparison
    from .video_export_source import source_frames

    snapshot = read_snapshot(snapshot_path)
    current, options = snapshot["annotations"], snapshot["options"]
    labels = {int(key): value for key, value in snapshot["labels"].items()}
    shapes = defaultdict(list)
    for shape in current["shapes"]:
        shapes[shape["frame"]].append(shape)
    tags = defaultdict(list)
    for tag in current["tags"]:
        tags[tag["frame"]].append(tag)
    images = source_frames(source_spec["path"], source_spec["timestamps"],
                           [source_spec["start"] + frame * source_spec["step"] for frame in frames],
                           apply_rotation=source_spec["rotate"], threads=1)

    def image_at(number):
        return render_comparison(next(images), shapes[number], tags[number], labels, options,
                                 number, snapshot["identities"])

    try:
        encode_video(output_path, frames, durations, image_at, rate=rate, threads=2)
    finally:
        images.close()
    return len(frames)


def concatenate(parts, path, durations, progress=lambda value: None):
    """Copy encoded packets without another encode; preserve per-frame VFR durations."""
    import av
    clock = Fraction(1, 90000)
    offset = 0
    with av.open(str(path), "w", format="mp4", options={"movflags": "+faststart"}) as output:
        stream = None
        for index, part in enumerate(parts):
            with av.open(str(part)) as source:
                original = source.streams.video[0]
                if stream is None:
                    stream = output.add_stream_from_template(original)
                    stream.time_base = clock
                for packet in source.demux(original):
                    if packet.pts is None:
                        continue
                    shift = round(offset * clock / packet.time_base)
                    packet.pts += shift
                    if packet.dts is not None:
                        packet.dts += shift
                    packet.stream = stream
                    output.mux(packet)
            offset += sum(max(1, round(duration / clock)) for duration in durations[index])
            progress(95 + int(4 * (index + 1) / len(parts)))


def parallel_export(snapshot_path, source_spec, output_path, progress, workers):
    from django.conf import settings
    source_spec = {**source_spec, "slots_root": str(Path(settings.DATA_ROOT) / "overlay-export-slots"),
                   "cpu_budget": cpu_budget()}
    from .video_export_render import frame_durations
    snapshot = read_snapshot(str(snapshot_path))
    frames = snapshot["frames"]
    durations = frame_durations(frames, snapshot["timing"]["timestamps"], snapshot["timing"]["duration"])
    rate = Fraction(min(120, max(1, len(frames) / sum(durations)))).limit_denominator(1000)
    chunk_size = max(60, min(600, math.ceil(len(frames) / (workers * 2))))
    pieces = [frames[start:start + chunk_size] for start in range(0, len(frames), chunk_size)]
    piece_durations = [durations[start:start + chunk_size] for start in range(0, len(frames), chunk_size)]
    directory = Path(output_path).parent / "parts"
    directory.mkdir()
    paths = [directory / f"part-{index:05d}.mp4" for index in range(len(pieces))]
    # Resolve tracks once in the parent. Rendering children need no database/Django startup,
    # and each reads only its own small immutable annotation slice.
    from collections import defaultdict
    from cvat.apps.dataset_manager.annotation import AnnotationIR, AnnotationManager
    from cvat.apps.engine import models
    manager = AnnotationManager(AnnotationIR(models.DimensionType.DIM_2D, snapshot["annotations"]),
                                dimension=models.DimensionType.DIM_2D)
    shapes = iter(manager.to_shapes(frames[-1] + 1, included_frames=set(frames),
                                   deleted_frames=snapshot["deleted_frames"], use_server_track_ids=True))
    next_shape = next(shapes, None)
    tags = defaultdict(list)
    for tag in snapshot["annotations"]["tags"]:
        tags[tag["frame"]].append(tag)
    piece_snapshots = []
    try:
        for index, piece in enumerate(pieces):
            visible = []
            while next_shape is not None and next_shape["frame"] <= piece[-1]:
                visible.append(next_shape)
                next_shape = next(shapes, None)
            payload = {key: snapshot[key] for key in ("labels", "options", "identities")}
            payload["annotations"] = {"shapes": visible, "tags": [tag for frame in piece for tag in tags[frame]]}
            piece_path = directory / f"snapshot-{index:05d}.json"
            piece_path.write_text(json.dumps(payload))
            piece_snapshots.append(piece_path)
        with ProcessPoolExecutor(max_workers=min(workers, len(pieces)),
                                 mp_context=multiprocessing.get_context("spawn"),
                                 initializer=initialize_process) as executor:
            futures = [executor.submit(render_piece, str(piece_snapshot), source_spec, piece, duration, str(path), rate)
                       for piece_snapshot, piece, duration, path in zip(piece_snapshots, pieces, piece_durations, paths)]
            completed = 0
            try:
                for future in as_completed(futures):
                    completed += future.result()
                    progress(int(completed * 95 / len(frames)))
            except BaseException:
                for future in futures:
                    future.cancel()
                raise
        concatenate(paths, output_path, piece_durations, progress)
    finally:
        shutil.rmtree(directory)
        read_snapshot.cache_clear()
