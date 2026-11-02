# Motion guidelines (Dugma)

Dugma's motion language, as used in the layout generator, applied to video. The agent follows this on
every edit. Effects are available as CSS classes in `dugma-motion.css` (link it in `index.html` and put
`fx-<effect>` on a clip); the keyframes there are the source of truth for timing and easing.

## Principles
- Nothing is baked in. Every part stays its own element; motion is applied to parts, never rendered into pixels.
- Parts move as units. A card moves with its words, a diagram node with its connector, a number with its caption.
- Motion explains order. Grounds first, then the headline, then supporting text, then items one by one, then
  the call to action, the logo last. The eye is led, never surprised.
- Calm camera. The frame itself never moves: no zoom-ins, no pans, no shake. UI footage is shown still, at
  100% or one fixed crop per shot. Only grounds may scale (the *reveal* effect, 1.08 → 1.00).

## Effects (one per part)
| Effect | Use for | Motion | Duration |
| --- | --- | --- | --- |
| `fx-fade` | background colors, logo, footer | opacity 0 → 1 | 650 ms |
| `fx-reveal` | background images / footage | opacity 0 → 1 with scale 1.08 → 1.00 | 1200 ms |
| `fx-rise` | body text, cards, sections, steps | rise 3% of frame height + fade | 750 ms |
| `fx-lines` | headlines, quotes | each line rises through a mask, 90 ms apart | 900 ms |
| `fx-pop` | shapes, buttons (CTA), diagram nodes, number visuals | scale 0.82 → 1.00 with bounce + fade | 700 ms |
| `fx-count` | big numbers | counts up from 0 (ease-out cubic), text rises | 1500 ms |
| `fx-draw` | lines, connectors, rings | stroke draws on (dasharray), fades in during first 15% | 1000 ms |
| `fx-out` | anything leaving | fade (and optional 2% drop) | 300 ms |

## Easing
- Enter: `cubic-bezier(0.22, 1, 0.36, 1)` (`--ease-enter`). Everything that enters uses it, except pop.
- Pop: `cubic-bezier(0.34, 1.32, 0.64, 1)` (`--ease-bounce`).
- Draw: `cubic-bezier(0.65, 0, 0.35, 1)` (`--ease-draw`).
- Exit: `cubic-bezier(0.4, 0, 1, 1)` (`--ease-exit`). Never linear, except continuous drifts longer than 10 s.

## Order and stagger (within one scene, measured from the scene start)
background 0 ms · eyebrow 120 · headline / quote 180 · shape 260 · number 360 · subhead 420 · body / visual 520 ·
caption 620 · items 640 (+110 ms each) · attribution 640 · call to action 820 · logo / footer 900.
Several parts of the same kind stagger 80 ms (items 110 ms). Only one *kind* of part enters at a time.

## Holds and cuts
- A new piece of UI or a headline holds at least 1.2 s before the next change; a number holds 2 s after it finishes counting.
- Cuts are hard cuts on the beat (or every 2nd/4th beat for calmer pacing). A cut may lead the beat by up to 60 ms, never trail it.
- Crossfade (200–300 ms) only between footage of the same scene. No wipes, spins, flips, 3D.
- End the video on a beat with a 1.5 s hold on the final frame.

## Type
- Headlines use `fx-lines`; they rise, they never scale in. Two text sizes per scene at most.
- Numbers count up; text that is not a number never "types" letter by letter.
