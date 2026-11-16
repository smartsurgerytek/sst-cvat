import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from cvat.apps.video_annotation.video_segments import encode_segment, cached_segment

folder = Path(sys.argv[1])
video = SimpleNamespace(path=folder / "video.mp4", directory=folder, width=1920, height=1080,
                        duration=12, timestamps=[index / 25 for index in range(300)])
metadata = []
for index in range(3):
    path = folder / f"segment-{index}.mp4"
    start, end = encode_segment(video, index, path, codec=os.getenv("SAM2_TEST_CODEC", "libopenh264"))
    content = path.read_bytes()
    config = content.index(b"avcC")
    metadata.append({"start": start, "end": end, "codec": "avc1." + content[config + 5:config + 8].hex(),
                     "bytes": len(content)})
(folder / "segments.json").write_text(json.dumps(metadata))
print(json.dumps(metadata))

original_metadata = []
for index in range(3):
    path, start, end, codec = cached_segment(video, index, original=True)
    (folder / f"original-{index}.mp4").write_bytes(path.read_bytes())
    original_metadata.append({"start": start, "end": end, "codec": codec})
(folder / "original-segments.json").write_text(json.dumps(original_metadata))
