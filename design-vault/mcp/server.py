#!/usr/bin/env python3
"""Design Vault as an MCP server — lend your coding agent the hive's taste.

Modeled on inspomcp.dev: the library becomes tools an agent can call before it
writes UI. Read-only except `annotate`, which lets an agent (or you) attach a
DESIGN.md-style note to an item.

Install (Claude Code):
    claude mcp add design-vault -- python3 /path/to/design-vault/mcp/server.py

Claude Desktop / Cursor (mcp.json):
    { "mcpServers": { "design-vault": { "command": "python3",
        "args": ["/path/to/design-vault/mcp/server.py"] } } }
"""
import json
import re
import sqlite3
from pathlib import Path

from mcp.server.mcpserver import Image, MCPServer

VAULT = Path(__file__).resolve().parent.parent
DB = VAULT / "vault.db"
COLORS = ["red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink",
          "black", "white", "gray"]

GUIDANCE = (
    "Design Vault is a curated human-picked reference library (logos, posters, currency, "
    "passports, interface design, motion clips, album covers, design candy shared by a "
    "design team). Every item has provenance (source URL, sharer, year) and dominant-color "
    "tags. Start with search() or recommend(brief); get_item() returns the actual image so "
    "you can look at it. Use references for composition, type, color and motion decisions — "
    "never copy a reference verbatim; these are other people's work."
)

server = MCPServer("design-vault", instructions=GUIDANCE)


def rows(sql, params=()):
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    out = [dict(r) for r in con.execute(sql, params)]
    con.close()
    return out


def slim(r):
    return {k: r.get(k) for k in ("collection", "file", "title", "year", "tags", "artist",
                                  "page_url", "notes") if r.get(k) not in (None, "")}


def is_video(f):
    return Path(f).suffix.lower() in (".mp4", ".mov", ".webm", ".m4v")


@server.tool()
def get_filters() -> dict:
    """Every accepted filter value: collections, color names, top tags, sharers — call first to pick valid arguments."""
    tags = {}
    for r in rows("SELECT tags FROM items"):
        for t in (r["tags"] or "").split(","):
            if t and t not in COLORS and not re.fullmatch(r"[0-9a-fA-F]{6}", t):
                tags[t] = tags.get(t, 0) + 1
    return {
        "collections": [r["collection"] for r in rows("SELECT DISTINCT collection FROM items ORDER BY 1")],
        "colors": COLORS,
        "tags": sorted(tags, key=lambda t: -tags[t])[:80],
        "sharers": sorted({t for t in tags if t in ("avi", "virginia", "sasha", "kayoung", "fabrizia",
                                                     "jamie", "sayalee", "byron", "z", "belen", "matteo",
                                                     "carlos", "james", "victor", "erica")}),
        "total_items": rows("SELECT COUNT(*) AS n FROM items")[0]["n"],
    }


@server.tool()
def search(query: str = "", collection: str = "", color: str = "", tag: str = "",
           videos_only: bool = False, limit: int = 20) -> list[dict]:
    """Search the library. `query` matches title/tags/sharer/collection/year (all words must match);
    `collection`, `color` (a color name from get_filters) and `tag` narrow it. Returns item records —
    pass an item's `file` to get_item() to see it."""
    where, params = [], []
    for w in query.lower().split():
        where.append("LOWER(title||' '||tags||' '||IFNULL(artist,'')||' '||collection||' '||IFNULL(year,'')) LIKE ?")
        params.append(f"%{w}%")
    if collection:
        where.append("collection = ?"); params.append(collection)
    for t in (color, tag):
        if t:
            where.append("(','||tags||',') LIKE ?"); params.append(f"%,{t.lower()},%")
    if videos_only:
        where.append("(file LIKE '%.mp4' OR file LIKE '%.mov' OR file LIKE '%.webm')")
    sql = "SELECT * FROM items" + (" WHERE " + " AND ".join(where) if where else "") + \
          " ORDER BY year DESC NULLS LAST LIMIT ?"
    return [slim(r) for r in rows(sql, [*params, max(1, min(limit, 100))])]


@server.tool()
def get_item(file: str, image: bool = True) -> list:
    """Full record for one item plus the image itself (videos return a poster frame).
    `file` is the path returned by search(), e.g. collections/posters/….jpg."""
    r = rows("SELECT * FROM items WHERE file = ?", (file,))
    if not r:
        return [f"No item at {file}"]
    rec = r[0]
    out = [json.dumps(rec, ensure_ascii=False)]
    path = VAULT / file
    if image and path.exists():
        if is_video(file):
            import subprocess, tempfile
            with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
                subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", "0.5", "-i", str(path),
                                "-frames:v", "1", "-vf", "scale=960:-2", tmp.name], timeout=60)
                out.append(Image(path=tmp.name))
        else:
            from PIL import Image as PILImage
            import io
            im = PILImage.open(path).convert("RGB")
            im.thumbnail((1200, 1200))
            buf = io.BytesIO(); im.save(buf, "JPEG", quality=85)
            out.append(Image(data=buf.getvalue(), format="jpeg"))
    return out


@server.tool()
def recommend(brief: str, limit: int = 8) -> dict:
    """One-call moodboard for a brief ("playful fintech onboarding", "brutalist poster typography"):
    matching references across collections, the colors they lean on, and composition guidance.
    Start here when building UI."""
    words = [w for w in re.findall(r"[a-z0-9-]+", brief.lower()) if len(w) > 2]
    scored = {}
    for w in words:
        for r in search(query=w, limit=60):
            key = r["file"]
            scored.setdefault(key, [r, 0])[1] += 1
    ranked = sorted(scored.values(), key=lambda x: (-x[1], -(x[0].get("year") or 0)))
    picks = [r for r, _ in ranked[:limit]]
    palette = {}
    for r in picks:
        for t in (r.get("tags") or "").split(","):
            if t in COLORS:
                palette[t] = palette.get(t, 0) + 1
    return {
        "brief": brief,
        "exemplars": picks,
        "palette_lean": sorted(palette, key=lambda c: -palette[c])[:4],
        "collections_hit": sorted({r["collection"] for r in picks}),
        "guidance": [
            "Compose the first viewport to fit ~1440x900; never let a hero overflow it.",
            "Separate sections with real block space (80–160px) and keep copy in a centered, padded column.",
            "Borrow the *system* from a reference (grid, type scale, palette roles), not its pixels.",
            "Call get_item() on 2–3 exemplars to actually look at them before deciding.",
        ],
    }


@server.tool()
def find_similar(file: str, limit: int = 10) -> list[dict]:
    """Items sharing the most tags (colors, topics, sharer) with a given item — cheap visual/semantic neighbours."""
    r = rows("SELECT * FROM items WHERE file = ?", (file,))
    if not r:
        return []
    mine = set((r[0]["tags"] or "").split(",")) - {""}
    scored = []
    for o in rows("SELECT * FROM items WHERE file != ?", (file,)):
        shared = mine & set((o["tags"] or "").split(","))
        if shared:
            scored.append((len(shared) + (0.5 if o["collection"] == r[0]["collection"] else 0), slim(o)))
    return [s for _, s in sorted(scored, key=lambda x: -x[0])[:limit]]


@server.tool()
def list_boards() -> list[dict]:
    """Curated boards (Pinterest-style sets) with their item counts."""
    b = VAULT / "boards.json"
    data = json.loads(b.read_text()) if b.exists() else {"boards": []}
    return [{"id": x["id"], "name": x["name"], "items": len(x["items"])} for x in data["boards"]]


@server.tool()
def get_board(name: str) -> list[dict]:
    """Items on a board, by board name or id."""
    b = VAULT / "boards.json"
    data = json.loads(b.read_text()) if b.exists() else {"boards": []}
    for board in data["boards"]:
        if board["id"] == name or board["name"].lower() == name.lower():
            return [slim(r) for ref in board["items"]
                    for r in rows("SELECT * FROM items WHERE file = ?", (ref["file"],))]
    return []


@server.tool()
def annotate(file: str, notes: str, add_tags: str = "") -> str:
    """Attach a DESIGN.md-style note to an item (type, palette roles, layout system, motion) and
    optionally add tags. This is how the hive gets smarter: an agent with vision looks at get_item()
    and writes down what makes it work. Persists to the catalog and rebuilds vault.db."""
    r = rows("SELECT * FROM items WHERE file = ?", (file,))
    if not r:
        return f"No item at {file}"
    collection = r[0]["collection"]
    catalog_path = VAULT / "collections" / collection / "items.json"
    catalog = json.loads(catalog_path.read_text())
    base = Path(file).name
    for e in catalog:
        if e["file"] == base:
            e["notes"] = notes.strip()
            if add_tags:
                e["tags"] = sorted(set(e.get("tags", [])) | {t.strip() for t in add_tags.split(",") if t.strip()})
            break
    catalog_path.write_text(json.dumps(catalog, indent=2, ensure_ascii=False))
    import subprocess, sys
    subprocess.run([sys.executable, str(VAULT / "scripts" / "vault.py"), "db"], capture_output=True)
    return f"Annotated {file}"


if __name__ == "__main__":
    server.run("stdio")
