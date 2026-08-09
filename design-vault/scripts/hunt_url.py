#!/usr/bin/env python3
"""Hunt any URL for design reference: Pinterest boards, Are.na channels, or generic pages.

Saw an interesting collection somewhere? Point this at it and the images land in
design-vault/_inbox/<collection>/<batch>/ with items.json metadata — same review
loop as the Commons hunter.

Sources:
  pinterest.com/<user>/<board>/   public boards via Pinterest's widget endpoint (up to 50 pins)
  are.na/<user>/<channel>         needs ARENA_TOKEN env var (personal access token)
  any other URL                   scrapes og:image + large <img> tags from the page

Licensing: unlike Commons, these sources carry no license metadata — items are
recorded as "unknown (personal reference)". Fine for a private swipe file; not
for reuse in published work without checking the original.

Example:
    python3 hunt_url.py "https://www.pinterest.com/someuser/brutalist-posters/" \
        --collection posters --tags "brutalism" --count 30
"""
import argparse
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

from hunt_commons import UA, http_get, slugify, strip_tags

VAULT = Path(__file__).resolve().parent.parent
BROWSER_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
              "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36")


def fetch(url: str, ua: str = BROWSER_UA) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": ua, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def pins_from_pinterest(url: str, count: int) -> list:
    m = re.search(r"pinterest\.[a-z.]+/([^/]+)/([^/]+)", url)
    if not m:
        sys.exit("Could not parse pinterest board URL (expected pinterest.com/<user>/<board>/)")
    user, board = m.group(1), m.group(2)
    api = f"https://widgets.pinterest.com/v3/pidgets/boards/{user}/{board}/pins/"
    data = json.loads(fetch(api))
    if data.get("status") != "success":
        sys.exit(f"Pinterest widget endpoint refused: {data.get('message')}")
    out = []
    for pin in data["data"]["pins"][:count]:
        img = pin.get("images", {}).get("564x", {}).get("url")
        if not img:
            continue
        # Pinterest serves originals on the same path; fall back to 564x if not.
        out.append({
            "title": strip_tags(pin.get("description", "")).strip()[:120] or f"pin {pin['id']}",
            "page_url": f"https://www.pinterest.com/pin/{pin['id']}/",
            "image_url": img.replace("/564x/", "/originals/"),
            "fallback_url": img,
            "artist": data["data"].get("user", {}).get("full_name", ""),
        })
    return out


def pins_from_arena(url: str, count: int) -> list:
    slug = urllib.parse.urlparse(url).path.rstrip("/").split("/")[-1]
    token = os.environ.get("ARENA_TOKEN")
    if not token:
        sys.exit("Are.na now requires auth: set ARENA_TOKEN (dev.are.na personal access token)")
    api = f"https://api.are.na/v2/channels/{slug}/contents?per={count}"
    req = urllib.request.Request(api, headers={"User-Agent": UA,
                                               "Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read())
    out = []
    for block in data.get("contents", []):
        if block.get("class") != "Image" or not block.get("image"):
            continue
        out.append({
            "title": strip_tags(block.get("title") or "")[:120] or f"arena block {block['id']}",
            "page_url": f"https://www.are.na/block/{block['id']}",
            "image_url": block["image"]["original"]["url"],
            "fallback_url": block["image"].get("large", {}).get("url"),
            "artist": (block.get("user") or {}).get("full_name", ""),
        })
    return out


def pins_from_page(url: str, count: int) -> list:
    page = fetch(url).decode("utf-8", "replace")
    found, seen = [], set()
    for m in re.finditer(r'<meta[^>]+property="og:image"[^>]+content="([^"]+)"', page):
        found.append(m.group(1))
    for m in re.finditer(r'<img[^>]+src="([^"]+)"', page):
        found.append(m.group(1))
    out = []
    for src in found:
        absolute = urllib.parse.urljoin(url, src.replace("&amp;", "&"))
        if absolute in seen or absolute.startswith("data:"):
            continue
        seen.add(absolute)
        out.append({"title": Path(urllib.parse.urlparse(absolute).path).stem[:120],
                    "page_url": url, "image_url": absolute, "fallback_url": None, "artist": ""})
        if len(out) >= count:
            break
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("url")
    ap.add_argument("--collection", required=True)
    ap.add_argument("--count", type=int, default=30)
    ap.add_argument("--batch", help="batch name (default: <date>-<host-or-board>)")
    ap.add_argument("--tags", default="", help="comma-separated tags applied to every item")
    ap.add_argument("--min-bytes", type=int, default=25_000,
                    help="skip images smaller than this (filters icons/trackers on generic pages)")
    args = ap.parse_args()
    tags = [t.strip() for t in args.tags.split(",") if t.strip()]

    host = urllib.parse.urlparse(args.url).netloc.lower()
    if "pinterest." in host:
        candidates, source = pins_from_pinterest(args.url, args.count), "pinterest"
    elif "are.na" in host:
        candidates, source = pins_from_arena(args.url, args.count), "arena"
    else:
        candidates, source = pins_from_page(args.url, args.count), "page"
    if not candidates:
        print("No images found.", file=sys.stderr)
        return 1

    default_batch = slugify(urllib.parse.urlparse(args.url).path.rstrip("/").split("/")[-1]
                            or host, 32)
    batch = args.batch or f"{date.today().isoformat()}-{default_batch}"
    batch_dir = VAULT / "_inbox" / args.collection / batch
    batch_dir.mkdir(parents=True, exist_ok=True)

    items, n = [], 0
    for cand in candidates:
        blob = None
        for attempt in filter(None, (cand["image_url"], cand["fallback_url"])):
            try:
                blob = fetch(attempt)
                cand["image_url"] = attempt
                break
            except Exception:
                continue
        if blob is None or len(blob) < args.min_bytes:
            continue
        n += 1
        ext = Path(urllib.parse.urlparse(cand["image_url"]).path).suffix or ".jpg"
        fname = f"{n:02d}-{slugify(cand['title'])}{ext}"
        (batch_dir / fname).write_bytes(blob)
        year = re.search(r"\b(1[5-9]\d\d|20\d\d)\b", cand["title"])
        items.append({
            "id": n, "file": fname, "title": cand["title"],
            "year": int(year.group(1)) if year else None, "tags": tags,
            "page_url": cand["page_url"], "source_url": cand["image_url"],
            "license": "unknown (personal reference)", "artist": cand["artist"],
            "query": args.url, "status": "pending",
        })
        print(f"  {fname}")

    if not items:
        print("Nothing survived the size filter.", file=sys.stderr)
        return 1
    (batch_dir / "items.json").write_text(
        json.dumps({"collection": args.collection, "batch": batch, "source": source,
                    "items": items}, indent=2, ensure_ascii=False))
    print(f"\nStaged {len(items)} candidates in _inbox/{args.collection}/{batch}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
