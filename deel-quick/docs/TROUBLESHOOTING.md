# Troubleshooting

## The capture looks wrong

**Fonts are wrong / fallback fonts showing.**
The used-font filter may have dropped a face it shouldn't have (e.g. a weight
that loads after capture). Open the capture file and search `@font-face` — if
the family/weight is missing, re-capture after the page has fully settled, or
ask Claude to note it; worst case the skill re-adds a weight from a fresh
capture.

**A chart is a gray placeholder.**
The chart's canvas was tainted (drew a cross-origin image without CORS), so
`toDataURL` was blocked. The capture report lists it. Options: screenshot the
chart manually and ask Claude to place the image, or iterate on the layout
with the placeholder.

**Blank rectangles where embedded content was.**
Iframes are placeholdered by design (their content can't be captured).
The hostname is labeled on the placeholder.

**Styles missing entirely for some component.**
Check the metadata comment's `warnings:` line for
`stylesheet unreadable, skipped: <url>` — a CDN stylesheet that neither the
page nor the background relay could read. Copy the URL from the warning, open
it in a tab, save the CSS, and give it to Claude to inline.

**A dropdown/menu I wanted isn't in the capture.**
It closed when the popup took focus. Use the **3s delay** option and re-open
it during the countdown.

## Size problems

**The popup says the capture is over the 14MB budget.**
Re-capture with **Downscale large images** checked. Still too big? The
size ledger says which category dominates; the skill's
`references/size-playbook.md` has the trim recipes (Claude applies them —
just say "get this under budget").

**Artifact publish fails or the page won't load fully.**
Rendered size may exceed 16MB. Same playbook.

## Extension problems

**"Could not inject into this tab."**
You're on a page Chrome forbids (chrome://, Web Store) or the tab needs a
reload after the extension was installed/updated. Reload the tab and retry.

**Nothing downloads.**
Check the page's DevTools console for `[deel-quick]` errors. Chrome's
"Ask where to save each file" setting will show a save dialog — that's fine,
save anywhere.

**The clipboard prompt is missing.**
Clipboard access needs the popup focused; if it was denied, the improvement
intent is still embedded in the capture file's metadata comment — just tell
Claude "use the quick-iterate skill" with the file attached.

## Claude/artifact problems

**Claude didn't pick up the skill.**
Say "use the quick-iterate skill" explicitly. Check it's installed
(docs/INSTALL.md → verify step).

**A new URL was created instead of updating the old one.**
Tell Claude: "update the existing artifact at <url>, don't create a new one".
The skill republishes to the same URL by keeping the same file path / passing
the URL through — this is recoverable, just point at the right URL.

**A teammate can't open my link.**
They need to be logged into claude.ai under the Deel org. Artifacts are
private-by-default; make sure you shared it.
