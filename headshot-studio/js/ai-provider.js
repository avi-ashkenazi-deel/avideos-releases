// The "generate" step, in two parts:
//
// 1. regenerate(): sends the person (cut out on the device, so bystanders and
//    the room are never uploaded) to server.mjs, which asks an image model to
//    rebuild it as a studio headshot following the company policy.
// 2. onDeviceProvider.generate(): picks starting slider values for whichever
//    photo the person chose and explains what changed.

import { RETOUCH_LIMITS, TREATMENTS, backgroundLabel } from './policy.js';

let statusPromise = null;

// { provider, model, mock } when server.mjs has an image model, else null.
export function regenStatus() {
  if (!statusPromise) {
    statusPromise = fetch('api/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => (j?.provider ? j : null))
      .catch(() => null);
  }
  return statusPromise;
}

// hidden: { image, keep } for the self-hosted model: the photo with hidden
// clothing filled in, and a mask of what to keep (white). clothing: measured
// color of their top. Hosted models get the plain cut-out; the prompt covers it.
export async function regenerate(canvas, policy, hidden = null, clothing = null) {
  // The company background image is not needed for the prompt; keep the request small.
  const slim = { ...policy, background: { ...policy.background, image: null } };
  const res = await fetch('api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image: canvas.toDataURL('image/jpeg', 0.92),
      filled: hidden ? hidden.image.toDataURL('image/png') : undefined,
      keep: hidden ? hidden.keep.toDataURL('image/png') : undefined,
      clothing: clothing || undefined,
      policy: slim,
      n: policy.ai.variations,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.images?.length) throw new Error(json.error || `The image model did not return a photo (${res.status}).`);
  return json;
}

function percentile(hist, total, p) {
  let acc = 0;
  const target = total * p;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= target) return v;
  }
  return 255;
}

export const onDeviceProvider = {
  id: 'on-device',
  label: 'On-device enhance',

  // regenerated: { model, mock } when the photo came from the image model.
  async generate(prep, policy, regenerated = null) {
    const { base, masks, W, H, blendshapes } = prep;
    const N = W * H;

    // Auto levels from the person's own histogram. It stretches contrast
    // without pushing anyone's skin tone lighter or darker.
    const hist = new Uint32Array(256);
    let count = 0, sr = 0, sg = 0, sb = 0;
    for (let i = 0, j = 0; i < N; i++, j += 4) {
      const r = base[j], g = base[j + 1], b = base[j + 2];
      sr += r; sg += g; sb += b;
      if (masks.person[i] > 0.5) {
        hist[Math.round(0.3 * r + 0.59 * g + 0.11 * b)]++;
        count++;
      }
    }
    const lo = percentile(hist, count, 0.005);
    const hi = percentile(hist, count, 0.995);
    const black = Math.min(18, Math.max(0, lo - 4));
    const gain = Math.min(1.45, Math.max(1, 248 / Math.max(1, hi - black)));

    // Gentle grey-world white balance.
    const avg = (sr + sg + sb) / (3 * N);
    const clamp = (v) => Math.min(1.07, Math.max(0.93, v));
    const wb = [avg / (sr / N), avg / (sg / N), avg / (sb / N)].map((k) => clamp(1 + (k - 1) * 0.35));

    const auto = { r: gain * wb[0], g: gain * wb[1], b: gain * wb[2], black };

    const limit = RETOUCH_LIMITS[policy.retouchLimit]?.max ?? 1;
    const cap = (v) => Math.round(Math.min(v, 100 * limit));
    // A regenerated photo is already studio-lit, so start from neutral sliders.
    // Flattering light (fill light, under-eyes) is on for every photo. A
    // regenerated photo is already studio-lit, so it gets less of the rest.
    const params = regenerated ? {
      brightness: 0, contrast: 0, warmth: 0, fillLight: 40,
      smoothing: cap(10), skinTone: 0, skinLight: 0,
      eyeBright: cap(10), eyeClarity: cap(10), underEye: cap(50),
      lipColor: 0,
      zoom: 0, offsetY: 0,
    } : {
      brightness: 0, contrast: 4, warmth: 0, fillLight: 45,
      smoothing: cap(30), skinTone: 0, skinLight: 0,
      eyeBright: cap(20), eyeClarity: cap(15), underEye: cap(50),
      lipColor: 0,
      zoom: 0, offsetY: 0,
    };

    const notes = [];
    if (regenerated) {
      notes.push(regenerated.mock
        ? 'Test mode: no image model connected, so the photo was not regenerated'
        : `Rebuilt as a studio headshot (${regenerated.model})`);
      if (!regenerated.mock) {
        notes.push('Props and other people removed; your own clothes kept');
      }
    }
    if (policy.background.type !== 'original') notes.push(`Background set to ${backgroundLabel(policy.background).toLowerCase()}`);
    if (policy.treatment !== 'natural') notes.push(`${TREATMENTS[policy.treatment]} applied`);
    if (gain > 1.1) notes.push('Brightened the photo');
    else notes.push('Balanced light and contrast');
    if (Math.max(...wb) - Math.min(...wb) > 0.03) notes.push('Corrected the color cast');
    notes.push('Lifted shadows on the face and brightened under the eyes');
    if (!regenerated) notes.push('Softened skin and brightened eyes, lightly');

    const warnings = [];
    const score = (name) => blendshapes?.categories?.find((c) => c.categoryName === name)?.score ?? 0;
    if (Math.max(score('eyeBlinkLeft'), score('eyeBlinkRight')) > 0.5) warnings.push('Your eyes may be closed in this photo.');
    if (hi < 120) warnings.push('The photo was quite dark. A retake with more light will look sharper.');

    return { auto, params, notes, warnings };
  },
};
