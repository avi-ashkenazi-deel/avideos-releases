# M0 — the first real-screen validation run

Goal: prove the whole pipeline on one real Deel screen — capture fidelity,
the 16MB artifact budget, artifact CSP behavior, and the iterate loop —
before the team touches anything. Your part takes ~10 minutes; Claude does
the rest.

## Exit criteria

- [ ] Artifact renders pixel-faithfully on claude.ai (fonts, icons, spacing, chart snapshot)
- [ ] Total size under 16MB (target: under 14MB)
- [ ] Zero CSP/console errors on the artifact page
- [ ] v2/v3 republished to the **same URL** with version labels
- [ ] Recovery drill: artifact HTML recovered via URL alone, v4 edit applied

## Your part (~10 minutes, logged-in browser)

**1. Pick the screen.** Ideally a chart-heavy dashboard, on a demo account if
you have one. Set up the state you want kept (filters, tabs).

**2. Load the capture snippet.** DevTools (⌥⌘I) → **Sources → Snippets** →
New snippet → paste the contents of
[`snippet/deel-quick-snippet.js`](../snippet/deel-quick-snippet.js) (copy the
raw file from the branch) → run it (⌘Enter). The console prints
`[deel-quick] loaded`.

> Chrome may ask you to type `allow pasting` in the console first — that's a
> standard DevTools guard, type it and paste again.

**3. Capture.**

```js
__deelQuick.run({ intent: 'M0 validation run' })
```

Watch the `[deel-quick]` phase logs (snapshot → styles → fonts → assets →
assemble → done). A `deel-<screen>--<date>-capture.html` file lands in
Downloads.

**4. Collect evidence.**
- Right-click the `capture report` object in the console → *Copy object*.
- Take one screenshot of the live screen (for the side-by-side).

**5. Local eyeball.** Open the downloaded file in a new tab. It should look
like the screenshot. Links are dead and nothing is interactive — that's
correct; it's a static snapshot.

**6. Hand off.** In a Claude session with the quick-iterate skill: attach the
capture file, paste the report, attach the screenshot, and say "run the M0
verification".

## Claude's part (scripted)

1. `node deel-quick/tools/verify-capture.js <file>` — must PASS (self-containment,
   sanitization, structure, size). Failures here are pipeline bugs: fix
   `extension/capture/*.js`, regenerate the snippet (`tools/make-snippet.sh`),
   and only re-run the human step if the capture itself was defective.
2. PII question (keep or anonymize), then publish as artifact:
   `Deel Quick — M0: {Screen}`, favicon ⚡, changelog `v1 <date> initial capture`.
3. Side-by-side against the screenshot; you check the artifact tab's DevTools
   console for CSP errors (there must be none).
4. Two live iterations to prove the loop: a CSS-only edit ("denser rows") →
   v2, then an inline-JS edit ("collapsible sidebar") → v3 — same URL both times.
5. Recovery drill: recover the artifact's HTML from its URL alone, apply a
   trivial v4 edit, republish to the same URL.

## If it looks wrong — symptom → suspect stage

| Symptom | Suspect | What to bring back |
|---|---|---|
| A component fully unstyled | Cross-origin stylesheet skipped (fetch failed in snippet mode — no background relay) | The `warnings:` line from the report (`stylesheet unreadable, skipped: <url>`) |
| Fallback font showing | Used-font filter dropped a needed face | Which text element; the report's `notes:` line |
| Chart is a gray box | Tainted canvas (`toDataURL` blocked) | The report warning; expected on snippet path for cross-origin chart images |
| Empty gaps in layout | Iframe placeholders (by design) or blob: image failed | The placeholder's label |
| File huge (>14MB) | Images/fonts dominate — see the `size:` ledger | Re-run with `__deelQuick.run({ intent: 'M0', downscaleImages: true })` |
| Nothing downloads | Page CSP blocked the blob anchor, or an exception aborted the run | The full console output |

Note: the DevTools snippet has no extension background relay, so cross-origin
CSS/font fetches that CORS blocks will be *skipped with a warning* here but
would succeed in the extension. If that's the only failure class, M0 still
passes for the pipeline — note it and validate the relay in M1.

## Findings log

_Filled in after each run._

| Date | Screen | Size | Result | Issues found → fixes |
|---|---|---|---|---|
| — | — | — | — | — |
