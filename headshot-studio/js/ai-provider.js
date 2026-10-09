// The "generate" step. It picks a starting look for the photo and explains
// what it changed. The person then fine-tunes with sliders.
//
// This prototype ships an on-device provider (no server, no upload). To use a
// generative image model instead (relighting, clothing cleanup, studio
// re-render), implement the same `generate()` shape against a backend
// endpoint, for example:
//
//   export const remoteProvider = {
//     id: 'remote',
//     async generate(prep, policy) {
//       const blob = await new Promise((r) => prep.original.toBlob(r, 'image/jpeg', 0.92));
//       const res = await fetch('/api/headshots/generate', { method: 'POST', body: blob,
//         headers: { 'X-Policy': JSON.stringify(policy) } });
//       return res.json(); // { auto, params, notes, warnings, imageUrl }
//     },
//   };
//
// Keep the model behind your own backend so API keys never reach the browser.

import { RETOUCH_LIMITS, TREATMENTS, backgroundLabel } from './policy.js';

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

  async generate(prep, policy) {
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
    const params = {
      brightness: 0, contrast: 4, warmth: 0,
      smoothing: cap(30), skinTone: 0, skinLight: 0,
      eyeBright: cap(20), eyeClarity: cap(15),
      lipColor: 0,
      zoom: 0, offsetY: 0,
    };

    const notes = [];
    if (policy.background.type !== 'original') notes.push(`Background set to ${backgroundLabel(policy.background).toLowerCase()}`);
    if (policy.treatment !== 'natural') notes.push(`${TREATMENTS[policy.treatment]} applied`);
    if (gain > 1.1) notes.push('Brightened the photo');
    else notes.push('Balanced light and contrast');
    if (Math.max(...wb) - Math.min(...wb) > 0.03) notes.push('Corrected the color cast');
    notes.push('Softened skin and brightened eyes, lightly');

    const warnings = [];
    const score = (name) => blendshapes?.categories?.find((c) => c.categoryName === name)?.score ?? 0;
    if (Math.max(score('eyeBlinkLeft'), score('eyeBlinkRight')) > 0.5) warnings.push('Your eyes may be closed in this photo.');
    if (hi < 120) warnings.push('The photo was quite dark. A retake with more light will look sharper.');

    return { auto, params, notes, warnings };
  },
};
