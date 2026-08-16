---
name: quick-iterate
description: >
  Deel Quick prototype workflow. Use when the user attaches a *-capture.html
  file, mentions "Deel Quick", pastes a Deel Quick artifact URL, or asks to
  publish or iterate on a captured Deel screen as an artifact. Sanitizes the
  capture, publishes it as a Claude artifact, then iterates with surgical
  edits and version labels on the same URL.
---

# quick-iterate — Deel Quick prototype workflow

You are the iteration half of Deel Quick: a designer captured a real, rendered
Deel screen as one self-contained HTML file (via the Deel Quick Chrome
extension) and wants to publish it at an instant shareable URL and iterate on
it fast, with versions. Speed matters — this exists because the alternative
(Nexus) needs deployments.

The capture file starts with a `<!-- deel-quick capture ... -->` metadata
comment: source URL, title, timestamp, viewport, per-category size ledger,
warnings, the designer's improvement intent, and a `changelog:` section you
maintain.

## Phase A — Ingest & sanitize (before any publish)

1. Read the file and the metadata comment. Surface any warnings it lists
   (skipped stylesheets, placeholdered iframes/canvas) so the designer knows
   what's missing before they share.
2. Verify self-containment (see `references/sanitize-checklist.md`). The
   artifact CSP blocks every external request, so any leftover `http(s)://`
   reference in `src`, `href`, `srcset`, or CSS `url(...)` will 404-hole the
   page. Only `#...`, `data:`, and claude.ai artifact URLs are allowed.
   Strip anything the extension missed: `<script>` tags, `on*` attributes,
   CSP/refresh metas.
3. **PII check — mandatory, every capture.** Captured screens usually show
   real employee, contractor, or payment data. Ask the designer once:
   "Keep the real data, or anonymize it?" If anonymize: systematically replace
   names, emails, amounts, company names, and avatar images (swap avatar
   data-URIs for neutral initials blocks). Do not skip this question.
4. Size check: if the total is over 14MB, run `references/size-playbook.md`
   before publishing (the rendered artifact ceiling is 16MB).

## Phase B — Publish v1

- Load the harness's artifact design guidance first if it's available as a
  skill; then publish with the Artifact tool.
- Title: `Deel Quick — {Area}: {Screen}` (e.g. `Deel Quick — Contracts: List`).
- Keep the metadata comment at the top of the file and append the first
  changelog line: `v1 {date} initial capture`.
- Favicon: ⚡ (keep it stable across republishes).
- Description: one sentence — what screen, captured from where.
- Report the share URL. Remind the designer that viewers need a claude.ai
  login (Deel has org access) and that the link is private until they share it.

## Phase C — Iteration loop

- Each request → **surgical, targeted edits only.** The file is large
  (inlined fonts/images) and pixel fidelity is the whole point. Locate the
  relevant markup or CSS block (the capture preserves the app's real class
  names and `data-*` attributes — use them as landmarks) and change only
  that. Never regenerate the file wholesale.
- Requested interactivity ("make the sidebar collapsible", "make tabs work")
  is added as small inline `<script>` blocks — inline JS is allowed under the
  artifact CSP; loading anything external is not.
- Republish to the **same artifact** (same file path → same URL; never a new
  file path unless the designer asks for a separate prototype). Bump the
  version label: v2, v3… and append a one-line changelog entry to the head
  comment: `v3 {date} collapsible sidebar`.
- After each republish, confirm the version and restate the URL.

## Session recovery

If a designer starts a new session with only an artifact URL: WebFetch the
URL to recover the latest HTML into a working file, read the changelog
comment to confirm the version you're building on, then continue the loop —
republishing with the `url` parameter so the existing artifact updates
instead of a new one being created.

## Multi-screen prototypes

One artifact per screen. The capture rewrote every link to `href="#"` and
kept the original destination in `data-orig-href`. When the designer says
"link this to the payroll screen", find the nav element whose
`data-orig-href` matches, and set its `href` to the other prototype's
artifact URL (plain navigation to another artifact works; loading its
resources would not).

## Team gallery

The team keeps one hand-maintained artifact, `Deel Quick — Gallery`: a plain
list of prototypes (screen, owner, latest version, link). When asked to "add
this to the gallery", recover the gallery with WebFetch, append a row, and
republish it to its existing URL. Conventions: `references/conventions.md`.
