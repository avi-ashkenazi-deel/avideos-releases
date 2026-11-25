#!/usr/bin/env python3
"""The Design Vault local app.

Run from a clone of the repo:
    python3 design-vault/app/serve.py          # opens on http://localhost:5177

Serves the library UI over the local files — search (tags, colors, sharer,
collection, year), Add-from-link (runs the right hunter and stages to the
Inbox), in-app Inbox review (keep / drop), boards (boards.json, shared through
git), and a Sync button that runs git pull + push so this machine and the repo
stay level.
"""
import json
import re
import sqlite3
import subprocess
import sys
import uuid
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VAULT = Path(__file__).resolve().parent.parent
SCRIPTS = VAULT / "scripts"
BOARDS = VAULT / "boards.json"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5177

URL_HUNTER_HOSTS = ("x.com", "twitter.com", "pinterest.", "flickr.com", "vsco.co", "are.na",
                    "ffffound.com", "web.archive.org", "instagram.com", "tiktok.com",
                    "youtube.com", "youtu.be", "vimeo.com", "threads.net")


def load_boards():
    return json.loads(BOARDS.read_text()) if BOARDS.exists() else {"boards": []}


def save_boards(data):
    BOARDS.write_text(json.dumps(data, indent=2, ensure_ascii=False))


def library():
    con = sqlite3.connect(VAULT / "vault.db")
    con.row_factory = sqlite3.Row
    rows = [dict(r) for r in con.execute(
        "SELECT collection, file, title, year, tags, license, artist, page_url, batch, notes, rating, dhash "
        "FROM items")]
    con.close()
    for r in rows:
        r["domain"] = urllib.parse.urlparse(r.get("page_url") or "").netloc.removeprefix("www.")
    return rows


def duplicates():
    p = VAULT / "dupes.json"
    return json.loads(p.read_text()) if p.exists() else {"groups": []}


def similar(file: str, limit: int = 12):
    """Look-alikes: nearest by perceptual hash, topped up with tag overlap (Eagle's 'Look-Alikes')."""
    rows = library()
    me = next((r for r in rows if r["file"] == file), None)
    if not me:
        return []
    out = []
    if me.get("dhash"):
        h = int(me["dhash"], 16)
        for r in rows:
            if r["file"] != file and r.get("dhash"):
                d = (h ^ int(r["dhash"], 16)).bit_count()
                if d <= 14:
                    out.append((d, r))
        out.sort(key=lambda x: x[0])
    picked = {r["file"] for _, r in out[:limit]}
    if len(picked) < limit:
        mine = set((me.get("tags") or "").split(",")) - {""}
        scored = sorted(((len(mine & set((r.get("tags") or "").split(","))), r) for r in rows
                         if r["file"] != file and r["file"] not in picked), key=lambda x: -x[0])
        out += [(99, r) for s, r in scored[: limit - len(picked)] if s > 1]
    return [{**r, "distance": d} for d, r in out[:limit]]


def inbox():
    out = []
    for manifest in sorted((VAULT / "_inbox").glob("*/*/items.json")):
        m = json.loads(manifest.read_text())
        rel = manifest.parent.relative_to(VAULT)
        for it in m["items"]:
            if it["status"] != "pending":
                continue
            out.append({"batch": f"{m['collection']}/{m['batch']}", "collection": m["collection"],
                        "id": it["id"], "file": f"{rel}/{it['file']}", "title": it["title"],
                        "tags": ",".join(it.get("tags", [])), "page_url": it.get("page_url"),
                        "year": it.get("year"), "artist": it.get("artist", "")})
    return out


def collections():
    return sorted(p.name for p in (VAULT / "collections").iterdir() if p.is_dir())


def run(cmd, timeout=600):
    p = subprocess.run(cmd, cwd=VAULT, capture_output=True, text=True, timeout=timeout)
    return p.returncode, (p.stdout + p.stderr).strip()


def hunt_cmd(url, coll, tags):
    host = urllib.parse.urlparse(url if "//" in url else f"https://{url}").netloc.lower()
    if any(h in host for h in URL_HUNTER_HOSTS):
        return [sys.executable, str(SCRIPTS / "hunt_url.py"), url, "--collection", coll,
                "--tags", tags, "--count", "30"]
    return [sys.executable, str(SCRIPTS / "hunt_screenshot.py"), url, "--collection", coll,
            "--tags", tags, "--whole"]


def save_from_browser(body):
    """Browser-extension intake (Eagle-style 'save image' / 'save page').

    kind=image: the image URL is downloaded straight into today's browser-saves
    batch in the Inbox, remembering the page it came from. kind=page/link: the
    URL goes through the same hunters as ＋ Add link."""
    import datetime
    import urllib.request
    kind = body.get("kind", "image")
    url = (body.get("url") or "").strip()
    page = (body.get("page_url") or "").strip()
    coll = re.sub(r"[^a-z0-9-]", "", (body.get("collection") or "inspiration").lower()) or "inspiration"
    tags = [t.strip().lower() for t in (body.get("tags") or "").split(",") if t.strip()]
    data_url = body.get("data_url") or ""
    if data_url and not data_url.startswith(("data:image/png;base64,", "data:image/jpeg;base64,")):
        return {"ok": False, "log": "screenshots must be PNG or JPEG data"}
    if not data_url and not url.startswith(("http://", "https://")):
        return {"ok": False, "log": "only http(s) URLs can be saved"}
    (VAULT / "collections" / coll).mkdir(parents=True, exist_ok=True)
    if kind != "image":
        code, log = run(hunt_cmd(url, coll, ",".join(tags + ["browser"])))
        return {"ok": code == 0, "log": log[-600:]}

    batch = f"{datetime.date.today().isoformat()}-browser-saves"
    bdir = VAULT / "_inbox" / coll / batch
    bdir.mkdir(parents=True, exist_ok=True)
    mp = bdir / "items.json"
    manifest = json.loads(mp.read_text()) if mp.exists() else {"collection": coll, "batch": batch,
                                                                  "source": "browser", "items": []}
    if data_url:  # a screenshot captured by the extension (visible area of the tab)
        import base64
        head, _, b64 = data_url.partition(",")
        blob, ctype = base64.b64decode(b64), head[5:].split(";")[0]
        url = page or "screenshot"
    else:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Referer": page or url})
            with urllib.request.urlopen(req, timeout=60) as resp:
                blob, ctype = resp.read(), resp.headers.get("Content-Type", "")
        except Exception as e:
            return {"ok": False, "log": f"could not download: {e}"}
    ext = {"image/png": ".png", "image/gif": ".gif", "image/webp": ".webp", "image/svg+xml": ".svg",
           "video/mp4": ".mp4"}.get(ctype.split(";")[0], Path(urllib.parse.urlparse(url).path).suffix or ".jpg")
    n = len(manifest["items"]) + 1
    title = (body.get("title") or Path(urllib.parse.urlparse(url).path).stem or "saved image")[:120]
    fname = f"{n:03d}-{re.sub(r'[^a-z0-9]+', '-', title.lower()).strip('-')[:40] or 'image'}{ext}"
    (bdir / fname).write_bytes(blob)
    manifest["items"].append({
        "id": n, "file": fname, "title": title, "year": datetime.date.today().year,
        "tags": tags + ["browser"], "page_url": page or url, "source_url": url,
        "license": "unknown (personal reference)",
        "artist": urllib.parse.urlparse(page or url).netloc.removeprefix("www."),
        "query": "browser extension", "status": "pending"})
    mp.write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
    return {"ok": True, "log": f"Saved to Inbox → {coll}/{batch}", "file": fname}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(VAULT), **kwargs)

    def log_message(self, fmt, *args):  # keep the terminal quiet
        pass

    def send_json(self, obj, code=200):
        blob = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(blob)))
        self.end_headers()
        self.wfile.write(blob)

    def origin_ok(self) -> bool:
        """Only this app and the Design Vault browser extension may call write endpoints.

        Without this, any web page open in the browser could POST to localhost and
        trigger downloads, edits or a git push (CSRF)."""
        origin = self.headers.get("Origin")
        if origin is None:  # curl, scripts, same-origin GETs
            return True
        return origin in (f"http://localhost:{PORT}", f"http://127.0.0.1:{PORT}") or \
            origin.startswith(("chrome-extension://", "moz-extension://"))

    def do_OPTIONS(self):  # CORS preflight from the browser extension
        self.send_response(204 if self.origin_ok() else 403)
        if self.origin_ok():
            self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin", "*"))
            self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def end_headers(self):
        origin = self.headers.get("Origin") if hasattr(self, "headers") and self.headers else None
        if origin and origin.startswith(("chrome-extension://", "moz-extension://")):
            self.send_header("Access-Control-Allow-Origin", origin)
        super().end_headers()

    def do_GET(self):
        path, _, query = self.path.partition("?")
        params = urllib.parse.parse_qs(query)
        if path == "/api/similar":
            return self.send_json(similar(params.get("file", [""])[0]))
        route = {
            "/api/library": library, "/api/boards": load_boards,
            "/api/inbox": inbox, "/api/collections": collections, "/api/duplicates": duplicates,
            "/api/ping": lambda: {"ok": True, "app": "design-vault"},
        }.get(path)
        if route:
            return self.send_json(route())
        if self.path.startswith("/thumb/"):
            return self.send_thumb(urllib.parse.unquote(self.path[len("/thumb/"):]))
        if self.path in ("/", "/app", "/app/"):
            self.path = "/app/index.html"
        return super().do_GET()

    def send_thumb(self, rel: str):
        """First-frame poster for a video, generated once and cached in .thumbs/."""
        import hashlib
        src = (VAULT / rel).resolve()
        if not str(src).startswith(str(VAULT)) or not src.exists():
            return self.send_json({"error": "not found"}, 404)
        cache = VAULT / ".thumbs" / (hashlib.sha1(rel.encode()).hexdigest() + ".jpg")
        cache.parent.mkdir(exist_ok=True)
        if not cache.exists():
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", "0.5", "-i", str(src),
                            "-frames:v", "1", "-vf", "scale=480:-2", str(cache)], timeout=60)
            if not cache.exists():  # very short clip — take the first frame instead
                subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
                                "-frames:v", "1", "-vf", "scale=480:-2", str(cache)], timeout=60)
        if not cache.exists():
            return self.send_json({"error": "no thumb"}, 404)
        blob = cache.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(len(blob)))
        self.send_header("Cache-Control", "max-age=86400")
        self.end_headers()
        self.wfile.write(blob)

    def do_POST(self):
        if not self.origin_ok():
            return self.send_json({"ok": False, "log": "forbidden origin"}, 403)
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}") if length else {}

        if self.path == "/api/save":
            # From the browser extension: an image (saved directly) or a whole page/link.
            return self.send_json(save_from_browser(body))

        if self.path == "/api/add":
            url = body.get("url", "").strip()
            coll = re.sub(r"[^a-z0-9-]", "", body.get("collection", "inspiration").lower()) or "inspiration"
            tags = body.get("tags", "")
            if not url:
                return self.send_json({"ok": False, "log": "no url"}, 400)
            (VAULT / "collections" / coll).mkdir(parents=True, exist_ok=True)
            code, log = run(hunt_cmd(url, coll, tags))
            return self.send_json({"ok": code == 0, "log": log[-2000:]})

        if self.path == "/api/resolve":
            keep = ",".join(str(i) for i in body.get("keep", [])) or ""
            cmd = [sys.executable, str(SCRIPTS / "vault.py"), "resolve", body["batch"],
                   "--rest", body.get("rest", "pending")]
            if keep:
                cmd += ["--keep", keep]
            code, log = run(cmd)
            if code == 0 and keep:
                run([sys.executable, str(SCRIPTS / "vault.py"), "colors"])
            return self.send_json({"ok": code == 0, "log": log[-2000:]})

        if self.path == "/api/item/update":
            # Edit tags / year / notes / title on one library item, persist to its catalog, rebuild db
            file = body.get("file", "")
            m = re.match(r"collections/([a-z0-9-]+)/(.+)$", file)
            if not m:
                return self.send_json({"ok": False, "log": "bad file path"}, 400)
            coll, base = m.group(1), m.group(2)
            catalog_path = VAULT / "collections" / coll / "items.json"
            catalog = json.loads(catalog_path.read_text())
            hit = next((e for e in catalog if e["file"] == base), None)
            if not hit:
                return self.send_json({"ok": False, "log": "item not in catalog"}, 404)
            if "tags" in body:
                hit["tags"] = [t.strip() for t in body["tags"] if t.strip()]
            if "year" in body:
                hit["year"] = int(body["year"]) if str(body["year"]).strip().isdigit() else None
            if "notes" in body:
                hit["notes"] = body["notes"].strip()
            if "title" in body and body["title"].strip():
                hit["title"] = body["title"].strip()
            if "rating" in body:
                r = int(body["rating"] or 0)
                hit["rating"] = r if 1 <= r <= 5 else None
            catalog_path.write_text(json.dumps(catalog, indent=2, ensure_ascii=False))
            run([sys.executable, str(SCRIPTS / "vault.py"), "db"], timeout=120)
            return self.send_json({"ok": True, "item": hit})

        if self.path == "/api/item/delete":
            # Remove one library item (e.g. a duplicate copy). Git history keeps the file recoverable.
            file = body.get("file", "")
            m = re.match(r"collections/([a-z0-9-]+)/([^/]+)$", file)
            if not m:
                return self.send_json({"ok": False, "log": "bad file path"}, 400)
            catalog_path = VAULT / "collections" / m.group(1) / "items.json"
            catalog = json.loads(catalog_path.read_text())
            kept = [e for e in catalog if e["file"] != m.group(2)]
            if len(kept) == len(catalog):
                return self.send_json({"ok": False, "log": "item not in catalog"}, 404)
            catalog_path.write_text(json.dumps(kept, indent=2, ensure_ascii=False))
            (VAULT / file).unlink(missing_ok=True)
            data = load_boards()   # drop it from any board
            for b in data["boards"]:
                b["items"] = [r for r in b.get("items", []) if r.get("file") != file]
            save_boards(data)
            dp = VAULT / "dupes.json"
            if dp.exists():
                d = json.loads(dp.read_text())
                d["groups"] = [g for g in ([f for f in g if f != file] for g in d["groups"]) if len(g) > 1]
                dp.write_text(json.dumps(d, indent=1))
            run([sys.executable, str(SCRIPTS / "vault.py"), "db"], timeout=120)
            return self.send_json({"ok": True, "log": f"Removed {m.group(2)}"})

        data = load_boards()
        if self.path == "/api/boards/create":
            board = {"id": uuid.uuid4().hex[:8], "name": body.get("name", "untitled"), "items": []}
            if body.get("query"):  # a smart folder: a saved, live search instead of a hand-picked list
                board["type"] = "smart"
                board["query"] = {k: body["query"].get(k) for k in ("q", "color", "collection", "minRating")
                                  if body["query"].get(k)}
            data["boards"].append(board)
            save_boards(data)
            return self.send_json(board)

        if self.path == "/api/boards/toggle":
            ref = {"collection": body["collection"], "file": body["file"]}
            for board in data["boards"]:
                if board["id"] == body["board"]:
                    board["items"].remove(ref) if ref in board["items"] else board["items"].append(ref)
                    save_boards(data)
                    return self.send_json(board)
            return self.send_json({"error": "no such board"}, 404)

        if self.path == "/api/boards/delete":
            data["boards"] = [b for b in data["boards"] if b["id"] != body.get("board")]
            save_boards(data)
            return self.send_json(data)

        if self.path == "/api/sync":
            out = []
            for cmd in (["git", "add", "-A", str(VAULT)], ["git", "commit", "-q", "-m", "vault: sync from app"],
                        ["git", "pull", "--no-rebase"], ["git", "push"]):
                code, log = run(cmd, timeout=300)
                out.append(f"$ {' '.join(cmd[:3])}\n{log}".strip())
            return self.send_json({"log": "\n\n".join(out)})

        return self.send_json({"error": "unknown endpoint"}, 404)


if __name__ == "__main__":
    print(f"Design Vault → http://localhost:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
