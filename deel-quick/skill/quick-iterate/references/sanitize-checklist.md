# Sanitize checklist

Run every item against the capture before the first publish. The artifact CSP
blocks all external requests, so anything missed here renders as a hole.

## Must be absent

- [ ] `<script>` / `<noscript>` elements (any — the extension strips them,
      but verify; CSS-in-JS apps sometimes re-inject during capture)
- [ ] `on*` event-handler attributes (`onclick`, `onload`, …)
- [ ] `javascript:` URLs
- [ ] `<meta http-equiv="Content-Security-Policy">` and `<meta http-equiv="refresh">`
- [ ] `<base>` elements
- [ ] `<link rel="preload|prefetch|modulepreload|manifest|dns-prefetch|preconnect">`
- [ ] `<iframe>` with a live `src` (should already be placeholders)

## Must not reference the network

Grep for `http://` and `https://` across the file. Legitimate hits are only:

- inside the `deel-quick` metadata comment (source URL)
- `data-orig-href` attributes (inert — preserved link destinations)
- claude.ai artifact URLs in `<a href>` (multi-screen links)
- inside visible text content

Everything else — `src`, `href` on link/img/source, `srcset`, CSS `url(...)`,
`@import` — must be `data:` or `#local`. Fix by inlining (fetch is not
possible from the artifact; if an asset is missing, replace with a sized
placeholder and tell the designer).

## Structural sanity

- [ ] Exactly one `<!doctype html>` and one metadata comment at the top
- [ ] A `changelog:` line exists in the metadata comment
- [ ] File parses as HTML (no truncation — captures are large; check the
      closing `</html>`)

## PII pass (mandatory question)

Ask: **"Keep the real data, or anonymize it?"** If anonymizing, replace
consistently (same fake name for the same person everywhere): person names,
emails, phone numbers, addresses, salary/payment amounts, company/client
names, national IDs, and avatar images (use an initials block with a neutral
background). Keep realistic formatting so the design still reads true.
