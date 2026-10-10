# Headshot Studio: handoff

Notes for whoever continues this (a person or another AI assistant). Read
this first, then `README.md`.

## What it is

A web-only profile photo tool, meant to fold into the Deel platform later.

- **Person**: webcam with live coaching (distance, centering, tilt, turn,
  light, eyes open), auto capture, then an AI studio photo, a choice between
  options, retouch sliders, and a finished avatar.
- **Admin**: one company photo policy (background, color treatment, framing,
  avatar shape, brand ring, retouch limits, capture strictness, approval) with
  a live preview and a submissions list.

## Product rules the owner set (keep these)

1. Keep the person's own clothes. Never swap or add an outfit. Where a drink
   or someone's hand covers the clothes, continue the same garment.
2. Never change face shape. No slimming, reshaping, de-aging or beautifying.
3. Make it flattering: lift face shadows, brighten under-eyes, even skin,
   remove color casts, but keep real skin texture.
4. Remove what doesn't belong: drinks, food, phones, other people, their hands.
5. Brand backgrounds stay exact; the app composites them after generation.

## How it works

1. Capture in the browser (MediaPipe face landmarks + selfie segmentation).
2. The person is cut out on the device; bystanders and the room are never
   uploaded.
3. `server.mjs` sends the cut-out plus a prompt built from the policy
   (`js/prompt.js`) to an image model and returns the options.
4. The chosen option goes back through the on-device pipeline
   (`js/pipeline.js`): exact brand background, color treatment, flattering
   light, sliders, avatar.

## Image models

| Provider | How to enable | Status |
| --- | --- | --- |
| Gemini `gemini-nano-banana-2.1` | `GEMINI_API_KEY` | Wired, not yet run with a real key |
| OpenAI `gpt-image-2` | `OPENAI_API_KEY` | Wired, not yet run with a real key |
| Both | both keys | Compare mode: labeled options from each |
| Self-hosted Stable Diffusion inpainting | `HEADSHOT_PROVIDER=local` | Tested on a real photo; CPU is ~4 min per image |
| Test mode | `HEADSHOT_PROVIDER=mock` | Returns the photo unchanged |

Recommendation so far: Gemini through Vertex AI on Deel's Google Cloud,
compared against OpenAI on ~20 real staff photos before committing.

## Run

```bash
GEMINI_API_KEY=... OPENAI_API_KEY=... node headshot-studio/server.mjs
# open http://localhost:8080/#capture and http://localhost:8080/#admin
```

Node 18+. No build step, no npm install.

## Test

`tests/e2e.cjs` drives the whole flow in Playwright with a fake webcam clip.
It passes in test mode (`HEADSHOT_PROVIDER=mock`) and with no server.

## Known gaps / next steps

1. Run Gemini and OpenAI with real keys; tune `js/prompt.js` on the results.
2. Hair edges can show a faint light rim on strong brand colors.
3. Storage is `localStorage`; move policy and submissions to Deel's backend
   and read the person's identity from the session.
4. Add a likeness check (face-embedding similarity) before showing options.
5. Privacy review: face images may count as biometric data in some places.

## Branch

`claude/headshot-studio` in `avi-ashkenazi-deel/avideos-releases`, folder
`headshot-studio/`. (The rest of that repo is an unrelated iOS app.)
