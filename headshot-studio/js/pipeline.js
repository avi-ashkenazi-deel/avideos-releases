// Photo pipeline: crop to the company framing, cut out the person, build
// feature masks (skin, eyes, lips), then render with the policy + slider values.

import { detectStill, segment, SEG } from './vision.js';

export const OUT_W = 800;
export const OUT_H = 1000;

const IDX = {
  eyeR: [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246],
  eyeL: [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466],
  browR: [70, 63, 105, 66, 107, 55, 65, 52, 53, 46],
  browL: [300, 293, 334, 296, 336, 285, 295, 282, 283, 276],
  lipsOuter: [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185],
  lipsInner: [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191],
};

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ---------- small numeric helpers ----------

// Separable box blur, run 3 times to approximate a gaussian. Works on one channel.
export function blurChannel(src, w, h, radius, passes = 3) {
  const r = Math.max(1, Math.round(radius));
  let a = Float32Array.from(src);
  let b = new Float32Array(a.length);
  const norm = 1 / (2 * r + 1);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += a[row + Math.min(w - 1, Math.max(0, k))];
      for (let x = 0; x < w; x++) {
        b[row + x] = sum * norm;
        sum += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += b[Math.min(h - 1, Math.max(0, k)) * w + x];
      for (let y = 0; y < h; y++) {
        a[y * w + x] = sum * norm;
        sum += b[Math.min(h - 1, y + r + 1) * w + x] - b[Math.max(0, y - r) * w + x];
      }
    }
  }
  return a;
}

function splitRGB(data) {
  const n = data.length / 4;
  const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    r[i] = data[i * 4]; g[i] = data[i * 4 + 1]; b[i] = data[i * 4 + 2];
  }
  return [r, g, b];
}

function blurRGB(data, w, h, radius, weight = null) {
  let [r, g, b] = splitRGB(data);
  if (weight) {
    // Normalized convolution: blur only where weight > 0 so the person
    // does not bleed into a blurred background.
    for (let i = 0; i < r.length; i++) { r[i] *= weight[i]; g[i] *= weight[i]; b[i] *= weight[i]; }
    const wb = blurChannel(weight, w, h, radius);
    r = blurChannel(r, w, h, radius); g = blurChannel(g, w, h, radius); b = blurChannel(b, w, h, radius);
    for (let i = 0; i < r.length; i++) {
      const k = wb[i] > 0.02 ? 1 / wb[i] : 0;
      r[i] *= k; g[i] *= k; b[i] *= k;
    }
    return [r, g, b];
  }
  return [blurChannel(r, w, h, radius), blurChannel(g, w, h, radius), blurChannel(b, w, h, radius)];
}

function resizeFloat(src, sw, sh, dw, dh) {
  if (sw === dw && sh === dh) return Float32Array.from(src);
  const out = new Float32Array(dw * dh);
  const fx = sw / dw, fy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.max(0, (y + 0.5) * fy - 0.5));
    const y0 = Math.floor(sy), y1 = Math.min(sh - 1, y0 + 1), ty = sy - y0;
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.max(0, (x + 0.5) * fx - 0.5));
      const x0 = Math.floor(sx), x1 = Math.min(sw - 1, x0 + 1), tx = sx - x0;
      const top = src[y0 * sw + x0] * (1 - tx) + src[y0 * sw + x1] * tx;
      const bot = src[y1 * sw + x0] * (1 - tx) + src[y1 * sw + x1] * tx;
      out[y * dw + x] = top * (1 - ty) + bot * ty;
    }
  }
  return out;
}

function polygonMask(w, h, shapes) {
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  for (const { pts, scale = 1, cut = false } of shapes) {
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    ctx.globalCompositeOperation = cut ? 'destination-out' : 'source-over';
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = cx + (p.x - cx) * scale, y = cy + (p.y - cy) * scale;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.closePath();
    ctx.fill();
  }
  const d = ctx.getImageData(0, 0, w, h).data;
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4 + 3] / 255;
  return out;
}

// ---------- crop ----------

export function faceGeometry(lm, W, H) {
  const top = lm[10], chin = lm[152];
  const faceH = Math.hypot((chin.x - top.x) * W, (chin.y - top.y) * H);
  const cx = ((lm[234].x + lm[454].x) / 2) * W;
  const eyeY = ((lm[33].y + lm[263].y) / 2) * H;
  const faceW = Math.abs(lm[454].x - lm[234].x) * W;
  return { faceH, faceW, cx, eyeY, topY: top.y * H, chinY: chin.y * H };
}

function computeCrop(lm, W, H, framing) {
  const g = faceGeometry(lm, W, H);
  const closeup = framing === 'closeup';
  let ch = g.faceH * (closeup ? 2.15 : 2.9);
  let cw = ch * (OUT_W / OUT_H);
  const fit = Math.min(1, W / cw, H / ch);
  cw *= fit;
  ch *= fit;
  let x = g.cx - cw / 2;
  let y = g.eyeY - ch * (closeup ? 0.42 : 0.38);
  x = Math.max(0, Math.min(W - cw, x));
  y = Math.max(0, Math.min(H - ch, y));
  return { x, y, w: cw, h: ch };
}

// ---------- prepare ----------

// source: canvas with the full captured frame (not mirrored).
// Returns everything the renderer needs; heavy work happens once here.
export async function prepare(source, framing, onStep = () => {}) {
  await onStep('face');
  const first = await detectStill(source);
  const lm0 = first.faceLandmarks?.[0];
  if (!lm0) throw new Error('no-face');
  const blendshapes = first.faceBlendshapes?.[0];

  const crop = computeCrop(lm0, source.width, source.height, framing);
  const work = makeCanvas(OUT_W, OUT_H);
  const wctx = work.getContext('2d', { willReadFrequently: true });
  wctx.imageSmoothingQuality = 'high';
  wctx.drawImage(source, crop.x, crop.y, crop.w, crop.h, 0, 0, OUT_W, OUT_H);

  // Landmarks again on the crop, for precise feature masks.
  const second = await detectStill(work);
  const lm = second.faceLandmarks?.[0] || lm0.map((p) => ({
    x: (p.x * source.width - crop.x) / crop.w,
    y: (p.y * source.height - crop.y) / crop.h,
    z: p.z,
  }));

  await onStep('background');
  const seg = await segment(work);
  const W = OUT_W, H = OUT_H, N = W * H;
  const up = (k) => resizeFloat(seg.masks[k], seg.width, seg.height, W, H);
  const bgConf = up(SEG.background);

  // Person mask: tighten the soft model output, then feather the edge.
  let person = new Float32Array(N);
  for (let i = 0; i < N; i++) person[i] = Math.min(1, Math.max(0, (1 - bgConf[i] - 0.2) / 0.6));
  person = blurChannel(person, W, H, 1.5, 2);

  await onStep('features');
  const P = (idx) => idx.map((i) => ({ x: lm[i].x * W, y: lm[i].y * H }));
  const g = faceGeometry(lm, W, H);
  const feather = Math.max(2, g.faceW / 60);

  const featureCut = polygonMask(W, H, [
    { pts: P(IDX.eyeR), scale: 1.6 }, { pts: P(IDX.eyeL), scale: 1.6 },
    { pts: P(IDX.browR), scale: 1.25 }, { pts: P(IDX.browL), scale: 1.25 },
    { pts: P(IDX.lipsOuter), scale: 1.12 },
  ]);
  const faceSkin = up(SEG.faceSkin);
  const bodySkin = up(SEG.bodySkin);
  let skin = new Float32Array(N);
  const cut = blurChannel(featureCut, W, H, feather);
  for (let i = 0; i < N; i++) skin[i] = Math.max(faceSkin[i], bodySkin[i] * 0.8) * (1 - cut[i]);
  skin = blurChannel(skin, W, H, feather * 0.6, 2);

  const eyes = blurChannel(polygonMask(W, H, [{ pts: P(IDX.eyeR), scale: 1.05 }, { pts: P(IDX.eyeL), scale: 1.05 }]), W, H, feather * 0.35, 2);
  const lips = blurChannel(polygonMask(W, H, [{ pts: P(IDX.lipsOuter), scale: 1.0 }, { pts: P(IDX.lipsInner), scale: 1.0, cut: true }]), W, H, feather * 0.5, 2);

  await onStep('style');
  const base = wctx.getImageData(0, 0, W, H).data;
  const smooth = blurRGB(base, W, H, Math.max(3, g.faceW / 38));
  const detail = blurRGB(base, W, H, 1.5, null);
  const bgWeight = new Float32Array(N);
  for (let i = 0; i < N; i++) bgWeight[i] = 1 - person[i];
  const roomBlur = blurRGB(base, W, H, 14, bgWeight);

  return {
    W, H, base, smooth, detail, roomBlur, masks: { person, skin, eyes, lips }, lm, geometry: g, blendshapes,
    original: work,
  };
}

// ---------- background ----------

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

export async function drawBackground(ctx, bg, W, H) {
  if (bg.type === 'studio') {
    const grad = ctx.createRadialGradient(W * 0.5, H * 0.32, W * 0.05, W * 0.5, H * 0.45, Math.max(W, H) * 0.8);
    grad.addColorStop(0, bg.colors[0]);
    grad.addColorStop(1, bg.colors[1] || bg.colors[0]);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  } else if (bg.type === 'gradient') {
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, bg.colors[0]);
    grad.addColorStop(1, bg.colors[1] || bg.colors[0]);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  } else if (bg.type === 'image' && bg.image) {
    const img = await loadImage(bg.image);
    const s = Math.max(W / img.width, H / img.height);
    const w = img.width * s, h = img.height * s;
    ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
  } else {
    ctx.fillStyle = bg.colors?.[0] || '#e9ebee';
    ctx.fillRect(0, 0, W, H);
  }
}

// ---------- render ----------

export const NEUTRAL = {
  brightness: 0, contrast: 0, warmth: 0,
  smoothing: 0, skinTone: 0, skinLight: 0,
  eyeBright: 0, eyeClarity: 0,
  lipColor: 0,
  zoom: 0, offsetY: 0,
};

export class Renderer {
  constructor(prep) {
    this.prep = prep;
    this.canvas = makeCanvas(prep.W, prep.H);
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.out = this.ctx.createImageData(prep.W, prep.H);
    this.auto = { r: 1, g: 1, b: 1, black: 0 };
    this.policy = null;
    this.bgData = null;
  }

  async setPolicy(policy) {
    this.policy = policy;
    const { W, H } = this.prep;
    const t = policy.background.type;
    this.bgFromPhoto = t === 'blur' || t === 'original' || t === 'image';
    this.useMask = t !== 'original';
    if (t === 'blur' || t === 'original') {
      this.bgData = null;
    } else {
      const c = makeCanvas(W, H);
      const ctx = c.getContext('2d');
      await drawBackground(ctx, policy.background, W, H);
      this.bgData = ctx.getImageData(0, 0, W, H).data;
    }
    const brand = hexToRgb(policy.brandColor || '#2c71f0');
    this.duo = [hexToRgb('#011423'), brand, [244, 247, 255]];
  }

  // Returns the rendered portrait canvas (OUT_W x OUT_H).
  render(params) {
    const { W, H, base, smooth, detail, roomBlur, masks } = this.prep;
    const { person, skin, eyes, lips } = masks;
    const out = this.out.data;
    const p = { ...NEUTRAL, ...params };
    const a = this.auto;

    const smoothAmt = (p.smoothing / 100) * 0.85;
    const toneR = p.skinTone * 0.32 + p.skinLight * 0.5;
    const toneG = p.skinTone * 0.08 + p.skinLight * 0.5;
    const toneB = -p.skinTone * 0.3 + p.skinLight * 0.5;
    const eyeLift = (p.eyeBright / 100) * 0.45;
    const eyeSharp = (p.eyeClarity / 100) * 2.2;
    const lipSat = (p.lipColor / 100) * 0.9;
    const gain = Math.pow(2, p.brightness / 70);
    const gR = a.r * gain, gG = a.g * gain, gB = a.b * gain;
    const warm = p.warmth * 0.35;
    const con = 1 + p.contrast / 100;
    const black = a.black;
    const treatment = this.policy?.treatment || 'natural';
    const designedBg = !this.bgFromPhoto;
    const bgData = this.bgData;
    const useMask = this.useMask;
    const duo = this.duo;

    const adjust = (r, g, b, o) => {
      r = (r - black) * gR + warm; g = (g - black) * gG; b = (b - black) * gB - warm;
      r = (r - 128) * con + 128; g = (g - 128) * con + 128; b = (b - 128) * con + 128;
      o[0] = r; o[1] = g; o[2] = b;
    };
    const treat = (o) => {
      let [r, g, b] = o;
      if (treatment === 'bw') {
        let l = 0.3 * r + 0.59 * g + 0.11 * b;
        l = l + (l - 128) * 0.12;
        r = g = b = l;
      } else if (treatment === 'warm') {
        r = r * 1.05 + 4; g = g * 1.01; b = b * 0.9;
      } else if (treatment === 'cool') {
        r = r * 0.93; b = b * 1.06 + 4;
      } else if (treatment === 'duotone') {
        const l = Math.min(1, Math.max(0, (0.3 * r + 0.59 * g + 0.11 * b) / 255));
        const [c0, c1] = l < 0.5 ? [duo[0], duo[1]] : [duo[1], duo[2]];
        const t = l < 0.5 ? l * 2 : (l - 0.5) * 2;
        r = c0[0] + (c1[0] - c0[0]) * t; g = c0[1] + (c1[1] - c0[1]) * t; b = c0[2] + (c1[2] - c0[2]) * t;
      }
      o[0] = r; o[1] = g; o[2] = b;
    };

    const fg = [0, 0, 0];
    const bg = [0, 0, 0];
    for (let i = 0, j = 0; i < W * H; i++, j += 4) {
      let r = base[j], g = base[j + 1], b = base[j + 2];

      const sk = skin[i];
      if (sk > 0.004) {
        const k = sk * smoothAmt;
        r += (smooth[0][i] - r) * k; g += (smooth[1][i] - g) * k; b += (smooth[2][i] - b) * k;
        r += toneR * sk; g += toneG * sk; b += toneB * sk;
      }
      const e = eyes[i];
      if (e > 0.004) {
        const s = e * eyeSharp;
        r += (r - detail[0][i]) * s; g += (g - detail[1][i]) * s; b += (b - detail[2][i]) * s;
        const lift = e * eyeLift;
        r += (255 - r) * lift * 0.5 + r * lift * 0.25; g += (255 - g) * lift * 0.5 + g * lift * 0.25; b += (255 - b) * lift * 0.5 + b * lift * 0.25;
      }
      const lp = lips[i];
      if (lp > 0.004 && lipSat !== 0) {
        const l = 0.3 * r + 0.59 * g + 0.11 * b;
        const f = 1 + lp * lipSat;
        r = l + (r - l) * f; g = l + (g - l) * f; b = l + (b - l) * f;
      }

      adjust(r, g, b, fg);
      treat(fg);

      let m = useMask ? person[i] : 1;
      let R = fg[0], G = fg[1], B = fg[2];
      if (m < 0.999) {
        if (bgData) {
          bg[0] = bgData[j]; bg[1] = bgData[j + 1]; bg[2] = bgData[j + 2];
          // Brand colors stay exact; a company image follows the color treatment.
          if (!designedBg) treat(bg);
        } else {
          adjust(roomBlur[0][i], roomBlur[1][i], roomBlur[2][i], bg);
          treat(bg);
        }
        R = R * m + bg[0] * (1 - m); G = G * m + bg[1] * (1 - m); B = B * m + bg[2] * (1 - m);
      }
      out[j] = R; out[j + 1] = G; out[j + 2] = B; out[j + 3] = 255;
    }
    this.ctx.putImageData(this.out, 0, 0);
    return this.canvas;
  }
}

// ---------- avatar ----------

// Square avatar cut from the rendered portrait, shaped and ringed per policy.
export function composeAvatar(portrait, prep, policy, params = {}, size = 512) {
  const g = prep.geometry;
  const zoom = 1 + (params.zoom || 0) / 100;
  let side = (g.faceH * (policy.framing === 'closeup' ? 1.75 : 2.15)) / zoom;
  side = Math.min(side, portrait.width, portrait.height);
  let cx = g.cx;
  let cy = g.eyeY + g.faceH * 0.3 - (params.offsetY || 0) / 100 * g.faceH * 0.6;
  let x = Math.max(0, Math.min(portrait.width - side, cx - side / 2));
  let y = Math.max(0, Math.min(portrait.height - side, cy - side / 2));

  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  const ring = policy.ring?.enabled ? Math.round(size * 0.035) : 0;
  const gap = ring ? Math.round(size * 0.018) : 0;
  const inset = ring + gap;

  const path = (pad) => {
    const s = size - pad * 2;
    ctx.beginPath();
    if (policy.shape === 'circle') ctx.arc(size / 2, size / 2, s / 2, 0, Math.PI * 2);
    else if (policy.shape === 'rounded') ctx.roundRect(pad, pad, s, s, s * 0.22);
    else ctx.rect(pad, pad, s, s);
  };

  if (ring) {
    path(0);
    ctx.fillStyle = policy.brandColor;
    ctx.fill();
    path(ring);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }
  ctx.save();
  path(inset);
  ctx.clip();
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(portrait, x, y, side, side, inset, inset, size - inset * 2, size - inset * 2);
  ctx.restore();
  return c;
}
