# Motion guidelines

How things move in this video. The agent must follow these on every edit; replace with your own
(for example your design system's motion principles) and keep the headings.

## Principles
- Calm camera. The frame stays still; the content moves. No zoom bursts, no shake, no whip pans.
- One idea per moment. Only one element enters or exits at a time unless they are a group.
- Motion explains. Movement shows where something came from or where it goes; nothing moves for decoration.

## Timing
- Enter: 400–600 ms. Exit: 250–350 ms. Micro (hover, highlight): 150–200 ms.
- Hold a new piece of UI on screen for at least 1.2 s before anything else changes.
- Cuts land on the beat (or every 2nd/4th beat). A cut can lead the beat by up to 60 ms, never trail it.

## Easing
- Enter: cubic-bezier(.2,.7,.2,1) (fast start, soft landing). Exit: cubic-bezier(.4,0,1,1).
- Never linear for movement; linear only for continuous drifts (slow pans over 10 s or more).

## Scale and zoom
- Zoom (scale) moves are rare and small: 1.00 → 1.04 at most, over 4 s or more. One per scene at most.
- UI footage is shown at 100% or a single fixed crop per shot; no Ken Burns on screenshots.

## Transitions
- Default cut is a hard cut. Crossfades 200–300 ms only between footage of the same scene.
- No wipes, spins, flips, 3D.

## Type
- Titles rise 24–40 px and fade in; they never scale in. Max two text sizes per scene.
