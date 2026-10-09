// Live coaching: turns face landmarks + frame brightness into plain-language
// directions ("Move a little closer", "Turn toward your light").

import { STRICTNESS } from './policy.js';

const L = {
  forehead: 10, chin: 152, noseTip: 1, cheekR: 234, cheekL: 454,
  eyeOuterR: 33, eyeOuterL: 263, eyeTopR: 159, eyeTopL: 386, mouthL: 291, mouthR: 61,
};

// Where the face should sit in the frame (normalized, in the mirrored preview).
export const TARGET = { x: 0.5, y: 0.45 };

function blend(blendshapes, name) {
  const cats = blendshapes?.categories || [];
  const c = cats.find((k) => k.categoryName === name);
  return c ? c.score : 0;
}

export class Guide {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 160;
    this.canvas.height = 90;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.history = [];
  }

  // video: HTMLVideoElement; result: FaceLandmarkerResult; policy: company policy
  analyze(video, result, policy) {
    const W = video.videoWidth || 1280;
    const H = video.videoHeight || 720;
    const s = STRICTNESS[policy.capture.strictness] || STRICTNESS.standard;
    const closeup = policy.framing === 'closeup';
    const minFace = closeup ? s.minFace * 1.2 : s.minFace;
    const maxFace = closeup ? s.maxFace * 1.15 : s.maxFace;
    const faces = result?.faceLandmarks || [];
    const checks = [];
    const add = (id, label, status, hint) => checks.push({ id, label, status, hint });

    if (faces.length === 0) {
      // Most "no face" cases at a desk are a dark room, so check that first.
      const dark = this.frameLuma(video) < 55;
      add('face', 'Face in view', 'bad', dark
        ? 'Too dark to see your face. Turn on a light or face a window'
        : 'Look at the screen so we can see your face');
      ['distance', 'position', 'head', 'light', 'eyes'].forEach((id) =>
        add(id, LABELS[id], 'idle', ''));
      this.history = [];
      return finish(checks, null, {});
    }
    if (faces.length > 1) {
      add('face', 'Face in view', 'bad', 'Only one person in the frame, please');
    } else {
      add('face', 'Face in view', 'ok', '');
    }

    const lm = faces[0];
    const px = (i) => ({ x: lm[i].x * W, y: lm[i].y * H });
    const top = px(L.forehead), chin = px(L.chin), nose = px(L.noseTip);
    const cR = px(L.cheekR), cL = px(L.cheekL), eR = px(L.eyeOuterR), eL = px(L.eyeOuterL);

    // Distance: face height relative to frame height.
    const faceH = Math.hypot(chin.x - top.x, chin.y - top.y) / H;
    if (faceH < minFace) add('distance', LABELS.distance, 'bad', faceH < minFace * 0.75 ? 'Come closer to the camera' : 'Move a little closer');
    else if (faceH > maxFace) add('distance', LABELS.distance, 'bad', 'Move back a little');
    else add('distance', LABELS.distance, 'ok', '');

    // Position: center of the face in the mirrored preview.
    const cx = 1 - (top.x + chin.x) / 2 / W;
    const cy = (top.y + chin.y) / 2 / H;
    const dx = cx - TARGET.x;
    const dy = cy - TARGET.y;
    if (Math.abs(dx) > s.center) add('position', LABELS.position, 'bad', dx > 0 ? 'Move a little to the left' : 'Move a little to the right');
    else if (dy > s.center + 0.04) add('position', LABELS.position, 'bad', 'Tilt your screen forward a little, or sit taller');
    else if (dy < -(s.center + 0.04)) add('position', LABELS.position, 'bad', 'Tilt your screen back a little');
    else add('position', LABELS.position, 'ok', '');

    // Head: level (roll), facing the camera (yaw), chin height (pitch).
    const rollRad = Math.atan2(eL.y - eR.y, eL.x - eR.x);
    const roll = (rollRad * 180) / Math.PI;
    // Undo the tilt before measuring turn and chin height, so a tilted head
    // is not mistaken for a turned one.
    const cos = Math.cos(-rollRad), sin = Math.sin(-rollRad);
    const level = (p) => ({ x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos });
    const [n, r, l, er, el2, ch] = [nose, cR, cL, eR, eL, chin].map(level);
    const yaw = (n.x - r.x) / Math.max(1, l.x - r.x) - 0.5;
    const eyeMidY = (er.y + el2.y) / 2;
    const pitch = (n.y - eyeMidY) / Math.max(1, ch.y - eyeMidY);
    if (Math.abs(yaw) > s.yaw) add('head', LABELS.head, 'bad', 'Turn your face toward the camera');
    else if (Math.abs(roll) > s.roll) add('head', LABELS.head, 'bad', 'Keep your head level');
    else if (pitch < 0.24) add('head', LABELS.head, 'warn', 'Lower your chin slightly');
    else if (pitch > 0.52) add('head', LABELS.head, 'warn', 'Lift your chin slightly');
    else add('head', LABELS.head, 'ok', '');

    // Light: sample a small copy of the frame.
    const light = this.measureLight(video, lm);
    if (light.face < s.minLight) add('light', LABELS.light, 'bad', 'Add more light. Face a window or a lamp');
    else if (light.face > 228) add('light', LABELS.light, 'bad', 'Too bright. Step back from the direct light');
    else if (light.back - light.face > 70) add('light', LABELS.light, 'warn', 'Bright light behind you. Turn to face it');
    else if (Math.abs(light.left - light.right) > 42) add('light', LABELS.light, 'warn', 'Light is coming from one side. Turn toward it');
    else add('light', LABELS.light, 'ok', '');

    // Eyes and expression from blendshapes.
    const bs = result.faceBlendshapes?.[0];
    const blink = Math.max(blend(bs, 'eyeBlinkLeft'), blend(bs, 'eyeBlinkRight'));
    const smile = (blend(bs, 'mouthSmileLeft') + blend(bs, 'mouthSmileRight')) / 2;
    if (policy.capture.eyesOpen && blink > 0.5) add('eyes', LABELS.eyes, 'bad', 'Keep your eyes open');
    else add('eyes', LABELS.eyes, 'ok', '');

    // Stillness, used for the auto-capture countdown.
    this.history.push({ x: cx, y: cy, t: performance.now() });
    if (this.history.length > 12) this.history.shift();
    const still = this.isStill();

    const box = {
      x: 1 - cL.x / W, y: top.y / H, w: (cL.x - cR.x) / W, h: (chin.y - top.y) / H, cx, cy, faceH,
    };
    return finish(checks, box, { still, smile, blink, light, metrics: { faceH, dx, dy, roll, yaw, pitch } });
  }

  isStill() {
    if (this.history.length < 6) return false;
    const xs = this.history.map((p) => p.x);
    const ys = this.history.map((p) => p.y);
    const spread = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    return spread < 0.025;
  }

  frameLuma(video) {
    const { ctx, canvas } = this;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    return sum / (d.length / 4);
  }

  measureLight(video, lm) {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    ctx.drawImage(video, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const mean = (x0, y0, x1, y1) => {
      x0 = Math.max(0, Math.floor(x0 * w)); x1 = Math.min(w, Math.ceil(x1 * w));
      y0 = Math.max(0, Math.floor(y0 * h)); y1 = Math.min(h, Math.ceil(y1 * h));
      let sum = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * w + x) * 4;
          sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          n++;
        }
      }
      return n ? sum / n : 0;
    };
    // Inner face: between the cheeks, from the eyes to the mouth.
    const x0 = lm[L.cheekR].x, x1 = lm[L.cheekL].x;
    const padX = (x1 - x0) * 0.15;
    const y0 = lm[L.eyeTopR].y, y1 = lm[L.mouthL].y;
    const mid = (x0 + x1) / 2;
    const left = mean(x0 + padX, y0, mid, y1);
    const right = mean(mid, y0, x1 - padX, y1);
    const face = (left + right) / 2;
    // Background: the band above the head.
    const headTop = lm[L.forehead].y - (lm[L.chin].y - lm[L.forehead].y) * 0.45;
    const back = headTop > 0.08 ? mean(0.1, 0, 0.9, Math.max(0.05, headTop)) : mean(0, 0, 0.12, 0.6);
    return { face, left, right, back };
  }
}

const LABELS = {
  face: 'Face in view', distance: 'Distance', position: 'Centered', head: 'Head straight', light: 'Lighting', eyes: 'Eyes open',
};

const PRIORITY = ['face', 'distance', 'position', 'head', 'light', 'eyes'];

function finish(checks, box, extra) {
  const bad = PRIORITY.map((id) => checks.find((c) => c.id === id && c.status === 'bad')).find(Boolean);
  const warn = PRIORITY.map((id) => checks.find((c) => c.id === id && c.status === 'warn')).find(Boolean);
  const ready = !bad && !!box;
  let hint = bad?.hint || warn?.hint || '';
  let tone = bad ? 'bad' : warn ? 'warn' : 'ok';
  if (ready && !warn) {
    hint = extra.still ? 'Perfect. Hold still' : 'Looking good. Hold still';
    if (extra.smile !== undefined && extra.smile < 0.12) hint += ' · a small smile works well';
  }
  return { checks, box, ready, hint, tone, ...extra };
}
