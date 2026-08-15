#!/usr/bin/env python3
"""Hunt any URL for design reference: Pinterest boards, Are.na channels, or generic pages.

Saw an interesting collection somewhere? Point this at it and the images land in
design-vault/_inbox/<collection>/<batch>/ with items.json metadata — same review
loop as the Commons hunter.

Sources:
  pinterest.com/<user>/<board>/   public boards via Pinterest's widget endpoint (up to 50 pins)
  are.na/<user>/<channel>         needs ARENA_TOKEN env var (personal access token)
  flickr.com/...tags/<tag>        keyless public feed (recent photos for a tag)
  vsco.co/<user>/gallery          VSCO profile galleries (Cloudflare blocks datacenter
                                  IPs — run from local Claude Code)
  ffffound.com / any dead site    relics via the Wayback Machine CDX API
                                  (archive.org is blocked in some cloud environments —
                                  run from local Claude Code if it 403s)
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


def pins_from_x(url: str, count: int) -> list:
    """Media from a single X/Twitter post via the fxtwitter API (no login)."""
    m = re.search(r"(?:x|twitter)\.com/[^/]+/status/(\d+)", url)
    if not m:
        sys.exit("Give an X post URL, e.g. x.com/<user>/status/<id>")
    data = json.loads(fetch(f"https://api.fxtwitter.com/status/{m.group(1)}"))
    tweet = data.get("tweet") or {}
    if not tweet:
        sys.exit(f"fxtwitter returned no tweet: {data.get('message')}")
    author = tweet.get("author", {}).get("name", "")
    text = strip_tags(tweet.get("text", "")).replace("\n", " ")[:90]
    ts = tweet.get("created_timestamp")
    from datetime import datetime, timezone
    year = datetime.fromtimestamp(ts, tz=timezone.utc).year if ts else None
    out = []
    for media in tweet.get("media", {}).get("all", [])[:count]:
        out.append({
            "title": f"{author} — {text}" if text else author,
            "page_url": tweet.get("url") or url,
            "image_url": media.get("url"),
            "fallback_url": media.get("thumbnail_url"),
            "artist": author,
            "year": year,
        })
    return out


def pins_from_flickr(url: str, count: int) -> list:
    m = re.search(r"tags/([^/?]+)", url) or re.search(r"[?&]tags=([^&]+)", url)
    if not m:
        sys.exit("Give a Flickr tag URL, e.g. flickr.com/photos/tags/brutalism")
    tag = m.group(1)
    api = ("https://api.flickr.com/services/feeds/photos_public.gne"
           f"?tags={urllib.parse.quote(tag)}&format=json&nojsoncallback=1")
    data = json.loads(fetch(api))
    out = []
    for item in data.get("items", [])[:count]:
        img = item["media"]["m"].replace("_m.", "_b.")  # medium -> large
        year = re.match(r"(\d{4})", item.get("date_taken", "") or "")
        out.append({
            "title": strip_tags(item.get("title", ""))[:120] or "untitled",
            "page_url": item.get("link"),
            "image_url": img,
            "fallback_url": item["media"]["m"],
            "artist": (item.get("author", "").split('"')[1]
                       if '"' in item.get("author", "") else ""),
            "year": int(year.group(1)) if year else None,
        })
    return out


def pins_from_vsco(url: str, count: int) -> list:
    """VSCO profile gallery via the site's own web API.

    Cloudflare blocks datacenter IPs, so this only works from a residential
    connection (local Claude Code). Flow: the profile page sets a `vs` session
    token cookie, which authorizes the sites + medias API calls.
    """
    m = re.search(r"vsco\.co/([^/?]+)", url)
    if not m:
        sys.exit("Give a VSCO profile URL, e.g. vsco.co/<username>/gallery")
    user = m.group(1)
    import http.cookiejar
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    opener.addheaders = [("User-Agent", BROWSER_UA), ("Accept", "*/*")]
    try:
        opener.open(f"https://vsco.co/{user}/gallery", timeout=60).read()
    except Exception as e:
        sys.exit(f"VSCO refused the connection ({e}) — Cloudflare blocks datacenter "
                 "IPs; run this hunt from local Claude Code on your own network.")
    token = next((c.value for c in jar if c.name == "vs"), None)
    if not token:
        sys.exit("VSCO session token not found — the web flow may have changed.")

    def api(path):
        req = urllib.request.Request(f"https://vsco.co/api/2.0/{path}", headers={
            "User-Agent": BROWSER_UA, "Authorization": f"Bearer {token}"})
        return json.loads(opener.open(req, timeout=60).read())

    sites = api(f"sites?subdomain={user}").get("sites", [])
    if not sites:
        sys.exit(f"No VSCO site found for user {user}")
    medias = api(f"medias?site_id={sites[0]['id']}&size={min(count, 100)}&page=1")
    from datetime import datetime, timezone
    out = []
    for media in medias.get("media", [])[:count]:
        img = media.get("responsive_url", "")
        cap = media.get("capture_date") or media.get("upload_date")
        year = None
        if isinstance(cap, (int, float)):  # epoch millis
            year = datetime.fromtimestamp(cap / 1000, tz=timezone.utc).year
        elif isinstance(cap, str) and cap[:4].isdigit():
            year = int(cap[:4])
        out.append({
            "title": strip_tags(media.get("description", ""))[:120] or f"vsco {media.get('_id', '')[:8]}",
            "page_url": f"https://vsco.co/{user}/media/{media.get('_id', '')}",
            "image_url": f"https://{img}" if img and not img.startswith("http") else img,
            "fallback_url": None,
            "artist": user,
            "year": year,
        })
    return out


def pins_from_wayback(url: str, count: int) -> list:
    """Relics of dead sites (FFFFOUND! et al.) via the Wayback Machine CDX API."""
    parsed = urllib.parse.urlparse(url if "//" in url else f"https://{url}")
    target = parsed.netloc + (parsed.path if len(parsed.path) > 1 else "")
    if "ffffound.com" in target and "/" not in target.rstrip("/").replace("ffffound.com", ""):
        target = "ffffound.com/static/images/uploaded/"  # where the images lived
    cdx = ("https://web.archive.org/cdx/search/cdx"
           f"?url={urllib.parse.quote(target + '*')}&output=json"
           "&filter=mimetype:image/jpeg&filter=statuscode:200"
           f"&collapse=digest&limit={count * 2}")
    try:
        rows = json.loads(fetch(cdx))
    except Exception as e:
        sys.exit("Wayback Machine unreachable — this cloud environment's egress policy "
                 f"blocks archive.org. Run this hunt from local Claude Code instead. ({e})")
    out = []
    for row in rows[1:]:  # first row is the header
        ts, original = row[1], row[2]
        out.append({
            "title": Path(urllib.parse.urlparse(original).path).stem[:120],
            "page_url": f"https://web.archive.org/web/{ts}/{original}",
            "image_url": f"https://web.archive.org/web/{ts}if_/{original}",
            "fallback_url": None,
            "artist": "",
            "year": int(ts[:4]),
        })
        if len(out) >= count:
            break
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
    ap.add_argument("--wayback", action="store_true",
                    help="treat the URL as a dead site and hunt the Wayback Machine")
    args = ap.parse_args()
    tags = [t.strip() for t in args.tags.split(",") if t.strip()]

    host = urllib.parse.urlparse(args.url if "//" in args.url
                                 else f"https://{args.url}").netloc.lower()
    if re.search(r"(^|\.)(x|twitter)\.com$", host):
        candidates, source = pins_from_x(args.url, args.count), "x"
    elif "pinterest." in host:
        candidates, source = pins_from_pinterest(args.url, args.count), "pinterest"
    elif "are.na" in host:
        candidates, source = pins_from_arena(args.url, args.count), "arena"
    elif "flickr.com" in host:
        candidates, source = pins_from_flickr(args.url, args.count), "flickr"
    elif "vsco.co" in host:
        candidates, source = pins_from_vsco(args.url, args.count), "vsco"
    elif args.wayback or "ffffound.com" in host or "web.archive.org" in host:
        candidates, source = pins_from_wayback(args.url, args.count), "wayback"
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

    # Re-running into the same batch appends (lets a loop pool many URLs into one batch)
    manifest_path = batch_dir / "items.json"
    items = json.loads(manifest_path.read_text())["items"] if manifest_path.exists() else []
    n = len(items)
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
        if cand.get("year"):
            year = cand["year"]
        else:
            m = re.search(r"\b(1[5-9]\d\d|20\d\d)\b", cand["title"])
            year = int(m.group(1)) if m else None
        items.append({
            "id": n, "file": fname, "title": cand["title"],
            "year": year, "tags": tags,
            "page_url": cand["page_url"], "source_url": cand["image_url"],
            "license": "unknown (personal reference)", "artist": cand["artist"],
            "query": args.url, "status": "pending",
        })
        print(f"  {fname}")

    if not items:
        print("Nothing survived the size filter.", file=sys.stderr)
        return 1
    manifest_path.write_text(
        json.dumps({"collection": args.collection, "batch": batch, "source": source,
                    "items": items}, indent=2, ensure_ascii=False))
    print(f"\nStaged {len(items)} candidates in _inbox/{args.collection}/{batch}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
