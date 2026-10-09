# Headshot Studio (prototype)

A web-only, webcam-based profile photo tool. A person sits in front of their
webcam, gets live coaching on distance, light and angle, and the photo is
styled to the company's photo policy. They then fine-tune it with sliders and
get a finished avatar. Admins set the policy and review submissions.

Inspired by remote-headshots.com (live-directed shoots, one company standard)
and clos.vc (remote capture, browser-only), but with no photographer: the
coaching and retouching are automated.

## Run it

No build step. Serve the folder over `localhost` or HTTPS (browsers only allow
the camera on secure origins):

```bash
npx serve headshot-studio        # or: npx http-server headshot-studio
# open http://localhost:3000/#capture  (person)
#      http://localhost:3000/#admin    (admin)
```

The face models (Google MediaPipe, ~20 MB) load from a CDN on first use and
are cached by the browser.

## The two sides

**Person (`#capture`)**

1. **Get ready**: tips, the company style shown as small rule chips, and a
   preview avatar in that style. Webcam or photo upload.
2. **Take photo**: live webcam with an oval guide and a checklist:
   face in view, distance, centered, head straight (tilt and turn), lighting
   (too dark, too bright, uneven, backlit) and eyes open. One plain hint at a
   time ("Move a little closer", "Turn toward your light"). With auto capture
   on, a 3-second countdown starts once everything is right and the person
   holds still. A short burst keeps the frame with the most open eyes.
3. **Processing**: crop to the company framing, remove the background, map
   skin, eyes and lips, apply the company style, then the "generate" step picks
   a starting look and lists what it changed.
4. **Retouch**: sliders for light and color, skin (smoothing, tone, brightness),
   eyes (brighten, clarity), lips (color) and avatar framing. Hold to compare
   with the original. Live avatar previews at 96, 48 and 32 px.
5. **Done**: final avatar shown in mock Deel contexts, download PNG/JPG,
   submit for approval.

**Admin (`#admin`)**

- Background: studio grey, Deel blue, ink, warm white, sky gradient, blur the
  person's room, keep the room, a custom color, or an uploaded company image.
- Look: natural, black & white, warm, cool, brand duotone. Brand colors stay
  exact; photo-based backgrounds follow the treatment.
- Framing (head & shoulders or close-up), avatar shape (circle, rounded,
  square), optional brand ring.
- Retouch limit (light / medium / full) caps every face slider, and admins
  choose which slider groups people see.
- Capture strictness, auto capture, open-eyes rule, approval on/off.
- Live preview on a sample person, or on the last photo taken.
- Submissions table with approve / ask for retake.

## How it's built

| File | What it does |
| --- | --- |
| `js/policy.js` | Policy model, defaults, rule-chip summary, storage |
| `js/vision.js` | Loads MediaPipe Face Landmarker + selfie multiclass segmenter |
| `js/guidance.js` | Turns landmarks and frame brightness into checks and hints |
| `js/pipeline.js` | Crop, masks (person, skin, eyes, lips), renderer, avatar |
| `js/ai-provider.js` | The "generate" step: auto levels, white balance, starting sliders |
| `js/capture.js` | Person flow UI |
| `js/admin.js` | Admin UI |
| `js/sample.js` | Drawn sample person for the admin preview |
| `tests/e2e.cjs` | Playwright run with a fake webcam |

Everything runs in the browser. The photo does not leave the device until the
person submits.

Auto exposure stretches the person's own histogram instead of pushing skin
toward a target brightness, so it does not lighten or darken anyone's skin
tone.

## What is real and what is stubbed

- **Real**: webcam capture, live coaching, background removal, the style
  rules, feature-aware retouching, avatar output, the admin policy.
- **Stubbed**: storage is `localStorage` (one browser, no accounts), and the
  "AI" step is on-device enhancement, not a generative model.

## Path into Deel

1. **Storage and identity**: move the policy to an org setting and
   submissions to a per-worker record; read the person's name from the session.
2. **Generative step**: implement `generate()` in `js/ai-provider.js` against
   a backend endpoint that calls an image model (relighting, cleaner hair
   edges, studio re-render). Keep API keys server-side. Keep the sliders as
   the final, person-controlled step.
3. **Profile photo**: on approval, write the avatar to the worker's profile
   picture.
4. **UI**: the CSS already uses Deel UI tokens; swap the markup for Deel
   React components when it moves into the platform.
5. **Consent and retention**: face data is biometric in some jurisdictions.
   Keep processing on-device where possible and get privacy review before any
   server-side model sees a photo.

## Test

```bash
npx http-server headshot-studio -p 8080 &
ffmpeg -loop 1 -i face.png -t 2 -r 10 -pix_fmt yuv420p face.y4m   # any frontal photo, 1280x720
FAKE_VIDEO=$PWD/face.y4m NODE_PATH=$(npm root -g) node headshot-studio/tests/e2e.cjs
```

It walks the full flow (intro, camera, auto capture, retouch, submit, admin)
and writes screenshots to `tests/out/`.
