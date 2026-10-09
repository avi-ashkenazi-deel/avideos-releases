# Headshot Studio (prototype)

A web-only, webcam-based profile photo tool. A person sits in front of their
webcam, gets live coaching on distance, light and angle, and the photo is
styled to the company's photo policy. They then fine-tune it with sliders and
get a finished avatar. Admins set the policy and review submissions.

Inspired by remote-headshots.com (live-directed shoots, one company standard)
and clos.vc (remote capture, browser-only), but with no photographer: the
coaching and retouching are automated.

## Run it

```bash
# With AI studio photos (recommended). The key stays on the server.
GEMINI_API_KEY=...  node headshot-studio/server.mjs     # Google Gemini image model
OPENAI_API_KEY=...  node headshot-studio/server.mjs     # or OpenAI GPT Image
HEADSHOT_PROVIDER=mock node headshot-studio/server.mjs  # test mode: photos come back unchanged

# open http://localhost:8080/#capture  (person)
#      http://localhost:8080/#admin    (admin)
```

Optional: `GEMINI_IMAGE_MODEL` (default `gemini-nano-banana-2.1`),
`OPENAI_IMAGE_MODEL` (default `gpt-image-2`), `PORT`.

Without the server (any static host, e.g. `npx serve headshot-studio`) the app
still works but only retouches the real photo. Browsers only allow the camera
on `localhost` or HTTPS. The face models (Google MediaPipe, ~20 MB) load from a
CDN on first use.

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
3. **AI studio photo**: the person is cut out on the device (the room and
   anyone else in the shot are never uploaded), then an image model rebuilds
   them as a professional headshot: the outfit the admin chose, studio light,
   a plain backdrop, and no drinks, props or other people's hands. The prompt
   is built from the policy (`js/prompt.js`); the server never accepts free
   text from the browser.
4. **Choose**: the person picks the option that looks most like them, or keeps
   their own photo (retouch only).
5. **Style**: crop to the company framing, swap in the exact brand
   background, apply the color treatment, and list what changed.
6. **Retouch**: sliders for light and color, skin (smoothing, tone, brightness),
   eyes (brighten, clarity), lips (color) and avatar framing. Hold to compare
   with the real photo. Live avatar previews at 96, 48 and 32 px.
7. **Done**: final avatar shown in mock Deel contexts, download PNG/JPG,
   submit for approval.

**Admin (`#admin`)**

- AI studio photo: on or off, outfit (their own top cleaned up, business
  casual, business formal), expression (keep, relaxed smile), how many options
  to generate, model connection status, and the exact prompt the model gets.
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
| `js/prompt.js` | Builds the image-model prompt from the policy |
| `js/ai-provider.js` | Calls the server to regenerate; picks starting sliders |
| `server.mjs` | Static files + `/api/generate` (Gemini, OpenAI, or test mode) |
| `js/capture.js` | Person flow UI |
| `js/admin.js` | Admin UI |
| `js/sample.js` | Drawn sample person for the admin preview |
| `tests/e2e.cjs` | Playwright run with a fake webcam |

Capture, coaching, cut-out and retouching run in the browser. Only the cut-out
person goes to the image model, and only when AI studio photo is on.

Auto exposure stretches the person's own histogram instead of pushing skin
toward a target brightness, so it does not lighten or darken anyone's skin
tone. The prompt tells the model the same: keep skin tone, features, age and
hair exactly.

## What is real and what is stubbed

- **Real**: webcam capture, live coaching, the cut-out, AI regeneration through
  the server (once a key is set), the style rules, retouching, avatar output.
- **Stubbed**: storage is `localStorage` (one browser, no accounts). There is
  no automatic likeness check yet; the person chooses and the admin approves.

## Path into Deel

1. **Storage and identity**: move the policy to an org setting and
   submissions to a per-worker record; read the person's name from the session.
2. **Generative step**: move `server.mjs`'s `/api/generate` into a Deel
   service, read the policy from the org instead of the request, and add a
   likeness check (face-embedding similarity between the original and each
   option) before showing options.
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
