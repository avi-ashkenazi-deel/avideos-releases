#!/usr/bin/env python3
"""Review and resolve staged design-vault candidates.

    vault.py review
        Build review.html — a numbered gallery of every pending inbox item.

    vault.py resolve <collection>/<batch> --keep 1,4,7 [--rest reject]
        Move kept items into collections/<collection>/ (appending their metadata
        to that collection's items.json) and delete the rejects. With --rest
        omitted, undecided items stay pending in the inbox.
"""
import argparse
import base64
import html
import io
import json
import shutil
import sys
from pathlib import Path

VAULT = Path(__file__).resolve().parent.parent
INBOX = VAULT / "_inbox"
COLLECTIONS = VAULT / "collections"


def load_batches():
    for manifest_path in sorted(INBOX.glob("*/*/items.json")):
        yield manifest_path, json.loads(manifest_path.read_text())


def embed_thumb(path: Path, max_px: int = 520) -> str:
    """Return a data: URI thumbnail so review.html is fully self-contained."""
    from PIL import Image  # only needed for --embed
    img = Image.open(path)
    img.thumbnail((max_px, max_px))
    buf = io.BytesIO()
    img.convert("RGB").save(buf, "JPEG", quality=72)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def cmd_review(args) -> int:
    sections = []
    total = 0
    for manifest_path, manifest in load_batches():
        pending = [i for i in manifest["items"] if i["status"] == "pending"]
        if not pending:
            continue
        total += len(pending)
        batch_rel = manifest_path.parent.relative_to(VAULT)
        batch_key = f"{manifest['collection']}/{manifest['batch']}"
        cards = []
        for item in pending:
            if args.embed:
                img = embed_thumb(manifest_path.parent / item["file"])
            else:
                img = html.escape(str(batch_rel / item["file"]))
            cards.append(f"""
      <figure data-id="{item['id']}" tabindex="0">
        <div class="num">{item['id']}</div>
        <img src="{img}" loading="lazy" alt="{html.escape(item['title'])}">
        <figcaption>
          <strong>{html.escape(item['title'])}</strong>
          <span class="meta"><span class="lic">{html.escape(item['license'])}</span>
          <a href="{html.escape(item['page_url'] or '')}" target="_blank" rel="noopener">source ↗</a></span>
        </figcaption>
      </figure>""")
        sections.append(f"""
    <section class="batch" data-batch="{html.escape(batch_key)}">
      <h2>{html.escape(manifest['collection'])} <span class="batchname">/ {html.escape(manifest['batch'])}</span>
          <span class="count">{len(pending)} candidates</span></h2>
      <div class="grid">{''.join(cards)}
      </div>
      <p class="verdict" data-for="{html.escape(batch_key)}">Click the images worth keeping.</p>
    </section>""")

    out = VAULT / "review.html"
    out.write_text(f"""<title>Design Vault — review ({total} pending)</title>
<style>
  /* Deliberately single-theme: a dark lightbox room for judging images. */
  body {{ font: 15px/1.55 "Avenir Next", "Segoe UI", system-ui, sans-serif;
         margin: 0; padding: 2.5rem clamp(1rem, 4vw, 3.5rem) 6rem;
         background: #16171a; color: #e9e7e2; }}
  h1 {{ font-size: 1.3rem; font-weight: 600; letter-spacing: .01em; margin: 0 0 .25rem; }}
  .sub {{ color: #9b978f; max-width: 60ch; margin: 0 0 2rem; }}
  h2 {{ margin: 3rem 0 1rem; font-size: 1rem; font-weight: 600; text-transform: uppercase;
       letter-spacing: .08em; color: #e9e7e2; }}
  .batchname {{ color: #9b978f; text-transform: none; letter-spacing: 0; font-weight: 400; }}
  .count {{ float: right; color: #9b978f; font-weight: 400; text-transform: none; letter-spacing: 0;
           font-variant-numeric: tabular-nums; }}
  .grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 14px; }}
  figure {{ margin: 0; background: #1f2024; border-radius: 6px; overflow: hidden; position: relative;
           cursor: pointer; outline: 2px solid transparent; outline-offset: 2px; transition: outline-color .12s; }}
  figure:focus-visible {{ outline-color: #7ab8ff; }}
  figure.keep {{ outline-color: #d8c96a; }}
  figure.keep .num {{ background: #d8c96a; }}
  figure.keep::after {{ content: "KEEP"; position: absolute; top: 8px; right: 8px; background: #d8c96a;
                       color: #16171a; font-size: .7rem; font-weight: 700; letter-spacing: .06em;
                       padding: 3px 8px; border-radius: 4px; }}
  figure img {{ width: 100%; height: 215px; object-fit: contain; background: #0c0d0f; display: block; }}
  .num {{ position: absolute; top: 8px; left: 8px; background: #55565c; color: #16171a;
         font-weight: 700; border-radius: 4px; padding: 1px 8px; font-variant-numeric: tabular-nums; }}
  figcaption {{ padding: .6rem .8rem .7rem; font-size: .78rem; display: grid; gap: 3px; }}
  figcaption strong {{ font-weight: 600; overflow-wrap: anywhere; }}
  .meta {{ display: flex; justify-content: space-between; gap: .5rem; }}
  .lic {{ color: #8fbfa4; }}
  a {{ color: #7ab8ff; text-decoration: none; }} a:hover {{ text-decoration: underline; }}
  .verdict {{ color: #9b978f; font-size: .85rem; min-height: 1.4em; }}
  .verdict.set {{ color: #d8c96a; }}
  #tally {{ position: fixed; inset: auto 0 0 0; background: #1f2024; border-top: 1px solid #2c2d33;
           padding: .8rem clamp(1rem, 4vw, 3.5rem); font-size: .88rem; color: #e9e7e2; }}
  #tally code {{ background: #16171a; padding: 2px 8px; border-radius: 4px; color: #d8c96a; user-select: all; }}
</style>
<h1>Design Vault — {total} candidates pending review</h1>
<p class="sub">Click (or focus + Enter) each image worth keeping, then paste the reply line at the
bottom back to Claude — or just answer in your own words.</p>
{''.join(sections) if sections else '<p>Inbox is empty. Nothing to review.</p>'}
<div id="tally">Reply: <code id="reply">nothing selected yet</code></div>
<script>
  const update = () => {{
    const parts = [];
    document.querySelectorAll('.batch').forEach(b => {{
      const ids = [...b.querySelectorAll('figure.keep')].map(f => f.dataset.id);
      const v = b.querySelector('.verdict');
      v.textContent = ids.length ? `keep ${{ids.join(', ')}}` : 'Click the images worth keeping.';
      v.classList.toggle('set', ids.length > 0);
      if (ids.length) parts.push(`${{b.dataset.batch}}: keep ${{ids.join(', ')}}, drop the rest`);
    }});
    document.getElementById('reply').textContent = parts.join(' — ') || 'nothing selected yet';
  }};
  document.querySelectorAll('figure').forEach(f => {{
    const toggle = e => {{ if (e.target.closest('a')) return; f.classList.toggle('keep'); update(); }};
    f.addEventListener('click', toggle);
    f.addEventListener('keydown', e => {{ if (e.key === 'Enter' || e.key === ' ') {{ e.preventDefault(); toggle(e); }} }});
  }});
</script>
""")
    print(f"Wrote {out} ({total} pending)")
    return 0


def cmd_resolve(args) -> int:
    batch_dir = INBOX / args.batch
    manifest_path = batch_dir / "items.json"
    if not manifest_path.exists():
        print(f"No such batch: {args.batch}", file=sys.stderr)
        return 1
    manifest = json.loads(manifest_path.read_text())
    keep = {int(x) for x in args.keep.split(",")} if args.keep else set()

    dest = COLLECTIONS / manifest["collection"]
    dest.mkdir(parents=True, exist_ok=True)
    catalog_path = dest / "items.json"
    catalog = json.loads(catalog_path.read_text()) if catalog_path.exists() else []
    existing = {e["file"] for e in catalog}

    kept = rejected = remaining = 0
    still_pending = []
    for item in manifest["items"]:
        if item["status"] != "pending":
            continue
        src = batch_dir / item["file"]
        if item["id"] in keep:
            fname = f"{manifest['batch']}-{item['file']}"
            if fname in existing:
                fname = f"{manifest['batch']}-{item['id']:02d}-dup-{item['file']}"
            shutil.move(src, dest / fname)
            entry = {k: v for k, v in item.items() if k not in ("id", "status")}
            entry["file"] = fname
            entry["batch"] = manifest["batch"]
            catalog.append(entry)
            kept += 1
        elif args.rest == "reject":
            src.unlink(missing_ok=True)
            rejected += 1
        else:
            still_pending.append(item)
            remaining += 1

    catalog_path.write_text(json.dumps(catalog, indent=2, ensure_ascii=False))
    if still_pending:
        manifest["items"] = still_pending
        manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
    else:
        shutil.rmtree(batch_dir)
        parent = batch_dir.parent
        if parent.exists() and not any(parent.iterdir()):
            parent.rmdir()

    print(f"{args.batch}: kept {kept} → collections/{manifest['collection']}/, "
          f"rejected {rejected}, still pending {remaining}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    rv = sub.add_parser("review")
    rv.add_argument("--embed", action="store_true",
                    help="inline images as data URIs (self-contained gallery)")
    rp = sub.add_parser("resolve")
    rp.add_argument("batch", help="<collection>/<batch-name>")
    rp.add_argument("--keep", default="", help="comma-separated ids to approve")
    rp.add_argument("--rest", choices=["reject", "pending"], default="pending",
                    help="what happens to undecided items (default: stay pending)")
    args = ap.parse_args()
    return cmd_review(args) if args.cmd == "review" else cmd_resolve(args)


if __name__ == "__main__":
    sys.exit(main())
