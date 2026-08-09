#!/usr/bin/env python3
"""Hunt Wikimedia Commons for design reference and stage results in the inbox.

One run = one batch in design-vault/_inbox/<collection>/<batch>/, containing the
downloaded images plus items.json with title, source page, license, and artist
for every candidate. Nothing is approved here — review happens via vault.py.

Example:
    python3 hunt_commons.py --collection currency --query "Swiss franc banknote" --count 12
"""
import argparse
import json
import re
import sys
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

API = "https://commons.wikimedia.org/w/api.php"
UA = "avideos-design-vault/0.1 (design reference collector; avi.ashkenazi@deel.com)"
# Wikimedia only serves a fixed set of thumbnail widths now.
THUMB_WIDTH = 960

VAULT = Path(__file__).resolve().parent.parent


def http_get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def strip_tags(html: str) -> str:
    return re.sub(r"<[^>]+>", "", html or "").strip()


def extract_year(meta: dict, title: str):
    """Best-effort year for the design itself, from Commons date metadata or the title."""
    for field in ("DateTimeOriginal", "DateTime"):
        val = strip_tags(meta.get(field, {}).get("value", ""))
        m = re.search(r"\b(1[5-9]\d\d|20\d\d)\b", val)
        if m:
            return int(m.group(1))
    m = re.search(r"\b(1[5-9]\d\d|20\d\d)\b", title)
    return int(m.group(1)) if m else None


def slugify(text: str, max_len: int = 48) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug[:max_len].rstrip("-") or "item"


def search(query: str, count: int) -> list:
    params = {
        "action": "query",
        "format": "json",
        "generator": "search",
        "gsrsearch": f"filetype:bitmap|drawing {query}",
        "gsrnamespace": "6",  # File:
        "gsrlimit": str(count),
        "prop": "imageinfo",
        "iiprop": "url|extmetadata|size|mime",
        "iiurlwidth": str(THUMB_WIDTH),
    }
    url = API + "?" + urllib.parse.urlencode(params)
    data = json.loads(http_get(url))
    pages = data.get("query", {}).get("pages", {})
    results = sorted(pages.values(), key=lambda p: p.get("index", 0))
    return [p for p in results if p.get("imageinfo")]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--collection", required=True, help="target collection, e.g. currency")
    ap.add_argument("--query", required=True, help="Commons search query")
    ap.add_argument("--count", type=int, default=12)
    ap.add_argument("--batch", help="batch name (default: <date>-<query-slug>)")
    ap.add_argument("--tags", default="", help="comma-separated tags applied to every item in the batch")
    args = ap.parse_args()
    tags = [t.strip() for t in args.tags.split(",") if t.strip()]

    batch = args.batch or f"{date.today().isoformat()}-{slugify(args.query, 32)}"
    batch_dir = VAULT / "_inbox" / args.collection / batch
    batch_dir.mkdir(parents=True, exist_ok=True)

    pages = search(args.query, args.count)
    if not pages:
        print(f"No results for: {args.query}", file=sys.stderr)
        return 1

    items = []
    n = 0
    for page in pages:
        info = page["imageinfo"][0]
        meta = info.get("extmetadata", {})
        thumb_url = info.get("thumburl") or info.get("url")
        ext = Path(urllib.parse.urlparse(thumb_url).path).suffix or ".jpg"
        n += 1
        fname = f"{n:02d}-{slugify(page['title'].removeprefix('File:'))}{ext}"
        try:
            (batch_dir / fname).write_bytes(http_get(thumb_url))
        except Exception as e:  # keep hunting even if one file 404s
            print(f"  skip {page['title']}: {e}", file=sys.stderr)
            n -= 1
            continue
        title = (strip_tags(meta.get("ObjectName", {}).get("value", ""))
                 or page["title"].removeprefix("File:"))
        items.append({
            "id": n,
            "file": fname,
            "title": title,
            "year": extract_year(meta, page["title"]),
            "tags": tags,
            "page_url": info.get("descriptionurl"),
            "source_url": info.get("url"),
            "license": strip_tags(meta.get("LicenseShortName", {}).get("value", "")) or "unknown",
            "artist": strip_tags(meta.get("Artist", {}).get("value", "")),
            "query": args.query,
            "status": "pending",
        })
        print(f"  {fname}  [{items[-1]['license']}] ({items[-1]['year'] or 'year?'})")

    manifest = {"collection": args.collection, "batch": batch, "items": items}
    (batch_dir / "items.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
    print(f"\nStaged {len(items)} candidates in _inbox/{args.collection}/{batch}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
