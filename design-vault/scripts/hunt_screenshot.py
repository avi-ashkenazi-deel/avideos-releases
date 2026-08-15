#!/usr/bin/env python3
"""Capture a live website as design reference — for sites whose designs are
rendered HTML/CSS rather than images (component galleries, landing pages,
dashboards, TV interfaces).

Renders the page in headless Chromium, takes a tall screenshot, trims the
blank tail, and slices it into review-sized sections staged in the inbox.
Pass --whole to keep one full-page image instead of slices.

Examples:
    python3 hunt_screenshot.py "https://beautiful-ui-five.vercel.app/" \
        --collection interface-design --tags "components,ai-ui"
    python3 hunt_screenshot.py "https://example.com" --paths /,/pricing,/docs --whole
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
from datetime import date
from pathlib import Path

from hunt_commons import slugify

VAULT = Path(__file__).resolve().parent.parent
CHROMIUM = shutil.which("chromium") or "/opt/pw-browsers/chromium"
# The PQ-disable + TLS1.2 cap keep Chromium's handshake compatible with MITM
# egress proxies (certs still verified); harmless on a normal network.
CHROME_FLAGS = ["--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
                "--disable-features=PostQuantumKyber,UseMLKEM",
                "--ssl-version-max=tls1.2",
                "--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"]


def capture(url: str, out: Path, width: int, height: int, budget_ms: int) -> bool:
    import os
    flags = list(CHROME_FLAGS)
    if os.environ.get("HTTPS_PROXY"):
        flags.append(f"--proxy-server={os.environ['HTTPS_PROXY']}")
    cmd = [CHROMIUM, *flags, f"--window-size={width},{height}",
           f"--virtual-time-budget={budget_ms}", f"--screenshot={out}", url]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    return out.exists() and out.stat().st_size > 0 or (print(p.stderr[-400:], file=sys.stderr) and False)


def trim_and_slice(png: Path, slice_h: int, whole: bool) -> list:
    """Trim the uniform bottom tail; return the whole image or content-bearing slices."""
    from PIL import Image, ImageStat
    img = Image.open(png).convert("RGB")
    w, h = img.size

    def is_blank(box) -> bool:
        return sum(ImageStat.Stat(img.crop(box)).stddev) < 6  # near-uniform region

    bottom = h
    while bottom > slice_h and is_blank((0, bottom - 200, w, bottom)):
        bottom -= 200
    img = img.crop((0, 0, w, bottom))
    if whole:
        return [img]
    slices, y = [], 0
    while y < bottom:
        part = img.crop((0, y, w, min(y + slice_h, bottom)))
        if part.height > 120 and sum(ImageStat.Stat(part).stddev) >= 6:
            slices.append(part)
        y += slice_h
    return slices


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("url")
    ap.add_argument("--collection", default="interface-design")
    ap.add_argument("--paths", default="", help="comma-separated paths to capture (default: the URL itself)")
    ap.add_argument("--batch", help="batch name (default: <date>-<host>)")
    ap.add_argument("--tags", default="")
    ap.add_argument("--width", type=int, default=1440)
    ap.add_argument("--capture-height", type=int, default=9000,
                    help="max page height captured before blank-trim")
    ap.add_argument("--slice-height", type=int, default=1000)
    ap.add_argument("--whole", action="store_true", help="one full-page image, no slicing")
    ap.add_argument("--budget", type=int, default=12000, help="JS settle time (virtual ms)")
    args = ap.parse_args()
    tags = [t.strip() for t in args.tags.split(",") if t.strip()]

    base = urllib.parse.urlparse(args.url)
    host = base.netloc
    paths = [p.strip() for p in args.paths.split(",") if p.strip()] or [base.path or "/"]
    batch = args.batch or f"{date.today().isoformat()}-{slugify(host, 32)}"
    batch_dir = VAULT / "_inbox" / args.collection / batch
    batch_dir.mkdir(parents=True, exist_ok=True)

    # Re-running into the same batch appends (lets a loop pool many sites into one batch)
    manifest_path = batch_dir / "items.json"
    items = json.loads(manifest_path.read_text())["items"] if manifest_path.exists() else []
    n = len(items)
    year = int(date.today().strftime("%Y"))
    with tempfile.TemporaryDirectory() as td:
        for path in paths:
            page_url = urllib.parse.urlunparse((base.scheme, host, path, "", base.query, ""))
            raw = Path(td) / f"{slugify(path) or 'root'}.png"
            print(f"capturing {page_url} …")
            if not capture(page_url, raw, args.width, args.capture_height, args.budget):
                print(f"  capture failed for {page_url}", file=sys.stderr)
                continue
            pieces = trim_and_slice(raw, args.slice_height, args.whole)
            page_slug = slugify(f"{host}{path}", 40)
            for i, piece in enumerate(pieces, 1):
                n += 1
                suffix = "" if args.whole else f"-s{i:02d}"
                fname = f"{n:02d}-{page_slug}{suffix}.png"
                piece.save(batch_dir / fname, "PNG", optimize=True)
                items.append({
                    "id": n, "file": fname,
                    "title": f"{host}{path}" + ("" if args.whole else f" — section {i}"),
                    "year": year, "tags": tags,
                    "page_url": page_url, "source_url": page_url,
                    "license": "unknown (personal reference)", "artist": host,
                    "query": f"screenshot {args.width}px", "status": "pending",
                })
                print(f"  {fname} ({piece.width}x{piece.height})")

    if not items:
        sys.exit("Nothing captured.")
    manifest_path.write_text(
        json.dumps({"collection": args.collection, "batch": batch,
                    "source": "screenshot", "items": items}, indent=2, ensure_ascii=False))
    print(f"\nStaged {len(items)} captures in _inbox/{args.collection}/{batch}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
