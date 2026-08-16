# The Deel Quick workflow

## Capture

1. Navigate the real Deel app to the screen you want to improve. Set up the
   state you care about (filters applied, the right tab open).
2. Click ⚡ **Deel Quick**.
3. Type what you want to improve (optional but recommended — it rides along
   into the Claude prompt).
4. Options:
   - **3s delay** — for state that dies when the popup opens (dropdowns,
     hover menus): check it, click Capture, then open the menu on the page.
   - **Downscale images** — check when the screen is image-heavy.
5. **Capture this screen.** You get:
   - `deel-<screen>--<date>-capture.html` in Downloads (fully self-contained), and
   - a ready-to-paste prompt on your clipboard.
6. The result panel shows a size ledger (dom / css / fonts / images / canvas).
   Under 10MB: good. Over 14MB: re-capture with downscaling, or let the skill
   trim it.

## Publish

1. New Claude chat (claude.ai, Cowork, or Claude Code — wherever you have the
   quick-iterate skill).
2. Attach the capture file, paste the clipboard prompt, send.
3. Claude will surface any capture warnings, **ask whether to anonymize real
   data** (answer honestly — these are real screens), and publish.
4. You get a private artifact URL: `Deel Quick — {Area}: {Screen}`, v1.

## Iterate

Just talk:

> make the table rows denser and move the status pill to the first column

Each request is a surgical edit and a republish to the **same URL** with a
bumped version label (v2, v3…). The artifact's version picker lets viewers
flip between iterations. Interactivity ("make the tabs actually switch") gets
added as inline JS — approximate logic, which is the point of a prototype.

## Share

Send the artifact URL in Slack. Viewers need a claude.ai login under the Deel
org; the artifact stays private to whoever has the link workflow on claude.ai.
Add it to the team gallery (`Deel Quick — Gallery`) when it's worth showing:
ask Claude to "add this to the gallery".

## Multi-screen flows

One screen per prototype, by design:

1. Capture screen A, publish → URL-A.
2. Capture screen B, publish → URL-B.
3. In the screen-A chat: "link the sidebar's Payroll item to URL-B".
   (Captures keep every original link target in `data-orig-href`, so Claude
   knows which element you mean.)

## Picking up someone else's prototype (or yours, later)

New chat → paste the artifact URL → "continue iterating on this". The skill
recovers the latest HTML from the artifact, reads its changelog, and keeps
republishing to the same URL.

## Ground rules

- Prefer demo/staging accounts for captures when possible.
- Anonymize before sharing beyond the design org. When in doubt, anonymize.
- Prototypes are throwaway by default; the gallery is for the ones that aren't.
