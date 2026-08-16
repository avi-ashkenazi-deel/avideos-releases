# Deel Quick team conventions

## Naming

- Artifact title: `Deel Quick — {Area}: {Screen}`
  e.g. `Deel Quick — Contracts: List`, `Deel Quick — Payroll: Run review`
- Favicon: ⚡ for every prototype (stable across republishes; designers find
  tabs by icon). The gallery uses 🗂️.
- Version labels: `v1`, `v2`, … — matching the changelog lines in the head
  comment. Label every republish.

## Changelog format (inside the head metadata comment)

```
changelog:
  v1 2026-08-16 initial capture
  v2 2026-08-16 denser table rows
  v3 2026-08-17 collapsible sidebar (inline JS)
```

One line per version, imperative and short. The changelog is the recovery
mechanism when someone picks up a prototype in a fresh session — keep it true.

## Sharing

- Artifacts start private. Share the URL in the relevant Slack thread or in
  `#design` — viewers need a claude.ai login under the Deel org.
- Never share a prototype containing real customer/employee data outside the
  design org. When in doubt, anonymize (the skill offers this on ingest).

## Multi-screen flows

- One artifact per screen, each named for its screen.
- Link screens via nav elements: set `href` to the other artifact's URL
  (originals preserved in `data-orig-href`).
- Note the flow in the gallery as one row per screen, indented under the flow
  name.

## Gallery

One shared artifact: `Deel Quick — Gallery`. Plain HTML list, hand-maintained
(deliberately — no automation to break). Row format:

| Screen | Owner | Version | Updated | Link |

Add your prototype when you first share it beyond yourself; update the
version cell on meaningful milestones, not every iteration.
