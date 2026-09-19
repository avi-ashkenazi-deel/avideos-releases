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
        "SELECT collection, file, title, year, tags, license, artist, page_url, batch, notes FROM items")]
    con.close()
    return rows


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

    def do_GET(self):
        route = {
            "/api/library": library, "/api/boards": load_boards,
            "/api/inbox": inbox, "/api/collections": collections,
        }.get(self.path)
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
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}") if length else {}

        if self.path == "/api/add":
            url = body.get("url", "").strip()
            coll = re.sub(r"[^a-z0-9-]", "", body.get("collection", "inspiration").lower()) or "inspiration"
            tags = body.get("tags", "")
            host = urllib.parse.urlparse(url if "//" in url else f"https://{url}").netloc.lower()
            if not url:
                return self.send_json({"ok": False, "log": "no url"}, 400)
            (VAULT / "collections" / coll).mkdir(parents=True, exist_ok=True)
            if any(h in host for h in URL_HUNTER_HOSTS):
                cmd = [sys.executable, str(SCRIPTS / "hunt_url.py"), url, "--collection", coll,
                       "--tags", tags, "--count", str(body.get("count", 30))]
            else:
                cmd = [sys.executable, str(SCRIPTS / "hunt_screenshot.py"), url, "--collection",
                       coll, "--tags", tags, "--whole"]
            code, log = run(cmd)
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
            catalog_path.write_text(json.dumps(catalog, indent=2, ensure_ascii=False))
            run([sys.executable, str(SCRIPTS / "vault.py"), "db"], timeout=120)
            return self.send_json({"ok": True, "item": hit})

        data = load_boards()
        if self.path == "/api/boards/create":
            board = {"id": uuid.uuid4().hex[:8], "name": body.get("name", "untitled"), "items": []}
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
