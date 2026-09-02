#!/usr/bin/env python3
"""The Design Vault local app.

Run from a clone of the repo:
    python3 design-vault/app/serve.py          # opens on http://localhost:5177

Serves the library UI over the local files — search (tags, colors, sharer,
collection, year), boards (stored in boards.json, shared through git), and a
Sync button that runs git pull + push so this machine and the repo stay level.
"""
import json
import sqlite3
import subprocess
import sys
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VAULT = Path(__file__).resolve().parent.parent
BOARDS = VAULT / "boards.json"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5177


def load_boards():
    if not BOARDS.exists():
        return {"boards": []}
    return json.loads(BOARDS.read_text())


def save_boards(data):
    BOARDS.write_text(json.dumps(data, indent=2, ensure_ascii=False))


def library():
    con = sqlite3.connect(VAULT / "vault.db")
    con.row_factory = sqlite3.Row
    rows = [dict(r) for r in con.execute(
        "SELECT collection, file, title, year, tags, license, artist, page_url FROM items")]
    con.close()
    return rows


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
        if self.path in ("/", "/app", "/app/"):
            self.path = "/app/index.html"
        elif self.path == "/api/library":
            return self.send_json(library())
        elif self.path == "/api/boards":
            return self.send_json(load_boards())
        return super().do_GET()

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}") if length else {}
        data = load_boards()

        if self.path == "/api/boards/create":
            board = {"id": uuid.uuid4().hex[:8], "name": body.get("name", "untitled"),
                     "items": []}
            data["boards"].append(board)
            save_boards(data)
            return self.send_json(board)

        if self.path == "/api/boards/toggle":
            ref = {"collection": body["collection"], "file": body["file"]}
            for board in data["boards"]:
                if board["id"] == body["board"]:
                    if ref in board["items"]:
                        board["items"].remove(ref)
                    else:
                        board["items"].append(ref)
                    save_boards(data)
                    return self.send_json(board)
            return self.send_json({"error": "no such board"}, 404)

        if self.path == "/api/boards/delete":
            data["boards"] = [b for b in data["boards"] if b["id"] != body.get("board")]
            save_boards(data)
            return self.send_json(data)

        if self.path == "/api/sync":
            out = []
            for cmd in (["git", "pull", "--no-rebase"], ["git", "push"]):
                p = subprocess.run(cmd, cwd=VAULT, capture_output=True, text=True, timeout=300)
                out.append(f"$ {' '.join(cmd)}\n{p.stdout}{p.stderr}".strip())
            return self.send_json({"log": "\n\n".join(out)})

        return self.send_json({"error": "unknown endpoint"}, 404)


if __name__ == "__main__":
    print(f"Design Vault → http://localhost:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
