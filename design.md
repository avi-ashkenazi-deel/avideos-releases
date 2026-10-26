# Streamit motion design

## Scope and source of truth

This guide defines the broadcast graphics and motion package, not the studio application's interface. Apply it to future lower thirds, comments, call alerts, title cards, bumpers and transitions.

The user's preferred first iteration is the visual foundation: oversized heavy typography, violet echoes, glossy acid liquid, and the original liquid transition. Preserve that motion where possible. Revision three's lower thirds and phone are proposals, not approved final designs.

Reference assets: `outputs/motion-v3/media/type-draft.mp4`, `transition-draft.mp4`, and `liquid-transparent.webm`. Keep these originals unchanged. The supplied yellow/purple typography references and Mux film inform scale, tightly packed composition, playful contrast and emphatic motion. Kick and Trovo are directional brand references, not logos or templates to reproduce. Trovo's site was unavailable during this pass.

## Character

Bold, playful, direct, energetic. Type should feel like the main graphic object, not a label placed on a decorative panel. Give each composition one strong idea. Use large shapes, tight typography and deliberate contrast. Keep the viewing area readable.

Two complementary elements define the system:

1. **Typography:** heavy uppercase, tightly packed words, oversized scale, strong flat color, occasional repeated or distorted echoes as seen in the original NEXT UP film.
2. **Liquid:** dimensional, glossy, stretchy violet and acid forms. A standalone accent or transition, not a required underline beneath every component.

Do not replace the original liquid with generic sine waves, flat blobs, or soft gradients. Avoid generic rounded notification cards, small timid titles, arbitrary decorative squiggles and continuous distracting movement beneath readable text.

## Palette

| Token | Value | Use |
| --- | --- | --- |
| Violet | `#6500D9` | Dominant graphic field, type echoes, name plates |
| Acid | `#CBFF28` | Sharp accent, reverse plate, liquid highlights |
| White | `#FFFFFF` | Main type on violet or dark footage |
| Ink | `#26004C` | Type on acid or white |

These are the revision-three working tokens, chosen to relate to the original footage. Existing video colors are preserved rather than recolored to match exact hex values. Yellow in the supplied reference establishes contrast and energy, not a mandatory palette replacement. Limit each overlay to two primary colors plus necessary contrast. Keep glossy shading within the liquid component.

## Typography and composition

Use very heavy geometric/grotesque uppercase display type with broad, solid shapes. Arial Black is the current local prototype fallback, not an identified match to the reference and not a final licensed brand font. Do not silently substitute a light or condensed face.

- Display line height: approximately 0.85–0.95 em, adjusted to prevent clipping.
- Tracking: tight, around -0.04 to -0.06 em for large display text. Check actual glyph collisions.
- Secondary labels: smaller bold sans serif; restrained tracking, clear hierarchy.
- Let short headlines occupy much of the canvas. Use deliberate line breaks and a compact silhouette.
- Lower thirds must remain subordinate to the person on camera. Default safe inset: 100 px on a 1920×1080 canvas.
- Names and attribution must remain editable. Support long names and multilingual text without truncating identity; wrap or reduce size within the safe area.
- Check apostrophes, accents, descenders and tight tracking for clipping. Never infer a font match from a reference alone.

## Component rules

### Lower thirds

Typography leads. Use a solid violet or acid field with a compact contrasting role label. Use crisp rectangular edges and strong scale, with a clear masked entrance. Avoid the previous liquid-underlining treatment. The two current preview directions remain review candidates. Test over real footage as well as a transparency grid.

### Audience comments

Use the same type, palette and entrance grammar. Keep attribution distinct and reduce display size for longer comments. Limit covered picture area; do not solve long copy by allowing it to run off canvas.

### Incoming call

A recognizable compact smartphone may tilt or ring briefly on entry. Caller name remains editable and stationary during the hold. No wave beneath the phone. No endless rocking while the person is reading. Current flat phone is a prototype, not a replacement approval for all prior artwork.

### Titles and bumpers

Keep the original NEXT UP style and motion. Large type, tightly composed words, violet repetition/distortion and selective liquid accents define the reference. New title studies should inherit these characteristics; a plain text card is only an initial layout study.

### Liquid and scene transition

Treat liquid as an independent reusable component. Preserve the original shapes, material and timing. The original transition is the preferred creative direction. Validate complete frame coverage before declaring any frame a usable scene cut point.

## Motion contract

Every delivered overlay/video starts on a **fully transparent frame** and ends on a **fully transparent frame**. Fading to black is not an exit. Alpha must be in the exported file, not merely simulated by the preview page.

Preserve the source performance between entry and exit. For the current restored videos, add a 12-frame entrance and 13-frame trailing handle at 24 fps using cloned endpoint frames and alpha fades. This retains every original frame and adds about one second overall. First and last frames must have zero alpha. The typography retains its intentional black background during the middle. The transition must isolate liquid throughout: no white backdrop may fade in, hold, or fade out. The liquid-only transition uses a light-background key; inspect glossy edges for matte artifacts.

New editable components use a quick masked reveal and upward text arrival (roughly 350–550 ms), a readable stationary hold, and a shorter exit (roughly 250–400 ms). A short settling motion can add personality. Do not apply arbitrary bounces to everything.

Provide explicit replay and exit controls. One-shot clips must not loop automatically. For future indefinite holds, separate entry/hold/exit behavior explicitly. Respect reduced-motion preferences in browser previews.

## Delivery and acceptance

- Author layouts in 1920×1080 coordinates; preserve existing 1280×720/24fps source quality honestly.
- Deliver alpha-capable ProRes 4444 MOV for native testing and VP9-alpha WebM for compatible browser previews.
- Decode WebM with an alpha-capable decoder when checking transparency.
- Verify first and final decoded alpha planes are entirely zero, and that middle frames contain visible pixels.
- Check existing liquid transparency survives conversion; do not replace its alpha with a full-frame rectangle.
- Review on a checkerboard and light/dark footage. Watch for fringes and premultiplication artifacts.
- Keep source media unchanged and label prototypes versus approved designs.
- Do not call a video a production stinger without verifying its full-cover cut frame.
- Browser preview success does not certify streamit playback. App integration, alpha decoding and one-shot triggering require separate verification.

## Current preview

`outputs/motion-v3/index.html` contains editable studies and restored original videos. `*-entry-exit.mov` and `*-entry-exit.webm` contain transparent entrance/exit handles. No new paid generation is required for this processing pass.

Reference film: https://stream.mux.com/1WunyE8i92nZ6U4zildqSRliXTh5mnq00/high.mp4
Brand references: https://kick.com/ and https://trovo.live/

## Review decisions — repeatable templates

- **Approved foundation:** original retained liquid transition and independent liquid. Keep their creative treatment stable.
- **Rejected:** the basic incoming-call study with its generic purple name box, and the locally rendered show-title study. These are not brand references or approved templates.
- Incoming calls and audience comments must be reusable templates with text typed inside streamit, using the same text treatment and layout rules as the lower-third family. Do not deliver baked-in caller names or comment text as the functional asset.
- Separate reusable animation/artwork from live text. A sample movie may demonstrate motion but cannot substitute for a native editable template.
- The current browser editor is not native streamit integration. Streamit has native editable text elements; grouped template fields, shared styling, sizing and synchronized entry/exit still need implementation.
- Show titles must follow the supplied heavy geometric typography references and the original NEXT UP composition/material/motion. Three generic Arial Black lines are not an acceptable equivalent. Establish the type design before producing more video variants.
- Future revisions must not describe rejected studies as preserving the approved style merely because they use violet and acid.

## Portable show templates

See `docs/OVERLAY_TEMPLATES.md` for the native template specification. Treat content, design and reusable artwork as separate layers. Text edits must never change artwork. Export/import preserves the source design by default; adopting a destination show's typography is an explicit previewed choice. A first native vector/text implementation now builds and passes model tests. Full media packaging and theme mapping remain unimplemented; native UI validation is pending.


## Alternate pink / lime colorway

Requested as an additional version, preserving existing violet assets. Exact flat colors: pink `#FB93EB`, lime `#D3FF29`, black `#000000`. LET’S REVIEW and BE RIGHT BACK retain their respective compositions and timings. Main lettering is pink; echoes and accents are lime. Glossy liquid is recolored into the same family while retaining shading and transparency. Files use the `-pink-lime` suffix; they do not replace the original colorway.

## Confirmed show name

The show is **Wait. Look!** Preserve both punctuation marks. Display typography may use **WAIT.** / **LOOK!** on two lines. This replaces the Off Script placeholder in both colorways.


## Wait Look Display — lettering prototype

The title preview uses an original geometric display font inspired by the weight and condensed proportions of the Almeida & Dale reference, without copying Diakritik AD outlines. Features: tall dense capitals, smooth rounded O bowls and narrow rounded counters, optically tightened W–A spacing, deep W notches, compact spacing and substantial punctuation. Keep the exact show punctuation: WAIT. / LOOK!

This is a title-lettering prototype, not a finished general-purpose font. Included characters: W A I T L O K, period, exclamation and space. Unsupported letters fall back to the existing display font. Do not deploy it for arbitrary comments/caller names until the alphabet, numerals, accents and spacing have been designed and reviewed. Source: `outputs/motion-v3/source/build-wait-look-font.py`; font: `outputs/motion-v3/fonts/wait-look-display.ttf`. Both title colorways use it; other approved motion assets remain as supplied.


### Title motion: trade the emphasis
WAIT. arrives large and heavy, holds for a deliberate beat, then contracts as LOOK! expands. The reciprocal size change is synchronized, with a small overshoot and shared settle. Total arrival is 2.8 seconds followed by a stationary hold; exit returns to transparency. Keep punctuation attached to its word, preserve rounded O forms and W–A kerning. Reduced-motion mode shows the final composition immediately.
