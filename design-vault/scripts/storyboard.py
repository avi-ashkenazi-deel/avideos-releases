#!/usr/bin/env python3
"""Break a video into key frames — a storyboard — staged for the vault review loop.

Uses ffmpeg scene detection to grab a frame at every hard cut; if the video has
few cuts (a continuous shot), falls back to sampling at even intervals. Each
frame lands in _inbox/<collection>/<batch>/ with its timecode in the metadata,
so an approved storyboard stays ordered and addressable.

Input is a local video file. For a YouTube/Instagram/X video, download it first
(e.g. with yt-dlp) or drop it in the Drive intake folder and let Claude fetch it.

Example:
    python3 storyboard.py title-sequence.mp4 --collection storyboards \
        --tags "saul-bass,titles" --threshold 0.3 --max-frames 36
"""
import argparse
import json
import re
import subprocess
import sys
from datetime import date
from pathlib import Path

from hunt_commons import slugify

VAULT = Path(__file__).resolve().parent.parent


def run(cmd: list) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True)


def duration_of(video: Path) -> float:
    p = run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", str(video)])
    try:
        return float(p.stdout.strip())
    except ValueError:
        sys.exit(f"ffprobe could not read {video}: {p.stderr.strip()}")


def timecode(seconds: float) -> str:
    m, s = divmod(seconds, 60)
    h, m = divmod(int(m), 60)
    return f"{h:02d}:{m:02d}:{s:05.2f}"


def extract_scene_frames(video: Path, out_dir: Path, threshold: float, cap: int) -> list:
    """Frames at scene cuts; returns [(pts_seconds, path)] parsed from showinfo."""
    pattern = str(out_dir / "cut-%04d.jpg")
    p = run(["ffmpeg", "-hide_banner", "-i", str(video),
             "-vf", f"select='eq(n,0)+gt(scene,{threshold})',showinfo",
             "-vsync", "vfr", "-frames:v", str(cap), "-q:v", "3", pattern])
    times = [float(m.group(1)) for m in
             re.finditer(r"pts_time:([0-9.]+)", p.stderr)]
    frames = sorted(out_dir.glob("cut-*.jpg"))
    return list(zip(times, frames))


def extract_interval_frames(video: Path, out_dir: Path, count: int, dur: float) -> list:
    step = dur / count
    result = []
    for i in range(count):
        t = round(i * step, 2)
        out = out_dir / f"grid-{i:04d}.jpg"
        run(["ffmpeg", "-hide_banner", "-ss", str(t), "-i", str(video),
             "-frames:v", "1", "-q:v", "3", str(out)])
        if out.exists():
            result.append((t, out))
    return result


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("video", type=Path)
    ap.add_argument("--collection", default="storyboards")
    ap.add_argument("--batch", help="batch name (default: <date>-<video-name>)")
    ap.add_argument("--tags", default="", help="comma-separated tags for every frame")
    ap.add_argument("--threshold", type=float, default=0.3,
                    help="scene-change sensitivity, 0..1 — lower catches subtler cuts (default 0.3)")
    ap.add_argument("--max-frames", type=int, default=40)
    args = ap.parse_args()
    if not args.video.exists():
        sys.exit(f"No such file: {args.video}")
    tags = [t.strip() for t in args.tags.split(",") if t.strip()]

    name = slugify(args.video.stem, 32)
    batch = args.batch or f"{date.today().isoformat()}-{name}"
    batch_dir = VAULT / "_inbox" / args.collection / batch
    batch_dir.mkdir(parents=True, exist_ok=True)

    dur = duration_of(args.video)
    frames = extract_scene_frames(args.video, batch_dir, args.threshold, args.max_frames)
    mode = "scene-cuts"
    if len(frames) < 4:  # continuous shot — sample an even grid instead
        for _, f in frames:
            f.unlink()
        mode = "interval"
        frames = extract_interval_frames(args.video, batch_dir,
                                         min(args.max_frames, 12), dur)
    if not frames:
        sys.exit("No frames extracted.")

    items = []
    for n, (t, frame) in enumerate(frames, 1):
        fname = f"{n:02d}-{name}-{timecode(t).replace(':', '')}.jpg"
        frame.rename(batch_dir / fname)
        items.append({
            "id": n, "file": fname,
            "title": f"{args.video.stem} @ {timecode(t)}",
            "timecode": timecode(t), "year": None, "tags": tags,
            "page_url": None, "source_url": str(args.video),
            "license": "unknown (personal reference)", "artist": "",
            "query": f"storyboard {mode} threshold={args.threshold}",
            "status": "pending",
        })
        print(f"  {fname}")

    (batch_dir / "items.json").write_text(
        json.dumps({"collection": args.collection, "batch": batch,
                    "source": "storyboard", "video": args.video.name,
                    "duration": timecode(dur), "mode": mode,
                    "items": items}, indent=2, ensure_ascii=False))
    print(f"\nStaged {len(items)} frames ({mode}, {timecode(dur)} video) "
          f"in _inbox/{args.collection}/{batch}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
