/**
 * Raster texture ops. Every op is pure: it returns a NEW bitmap with the same
 * geometry (origin/scale/size) as its input and leaves the input untouched.
 * Parameters are read defensively: NaN / missing → default, then clamped.
 */
import type { RasterOp } from '../types';
import { distanceTransform } from '../../inputs/image/thin';
import { makeBitmap, type Bitmap } from './bitmap';

/* ------------------------------------------------------------------ helpers */

/** Read a numeric param with default + clamp (NaN / undefined → default). */
export function num(params: Record<string, number> | undefined, key: string, def: number, lo: number, hi: number): number {
  const v = params ? params[key] : undefined;
  const x = typeof v === 'number' && Number.isFinite(v) ? v : def;
  return Math.min(hi, Math.max(lo, x));
}

export function toFloat(b: Bitmap): Float32Array {
  const f = new Float32Array(b.width * b.height);
  for (let i = 0; i < f.length; i++) f[i] = b.data[i];
  return f;
}

/** New bitmap with the same geometry, data thresholded from a float field. */
export function fromFloat(b: Bitmap, f: Float32Array, t: number): Bitmap {
  const out = makeBitmap(b.width, b.height, b.origin, b.scale);
  const d = out.data;
  for (let i = 0; i < d.length; i++) d[i] = f[i] >= t ? 255 : 0;
  return out;
}

/** Same geometry, data binarised at 128. */
function binary(b: Bitmap): Bitmap {
  const out = makeBitmap(b.width, b.height, b.origin, b.scale);
  for (let i = 0; i < out.data.length; i++) out.data[i] = b.data[i] >= 128 ? 255 : 0;
  return out;
}

/** One horizontal box pass (window 2r+1, outside = 0). */
function boxH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const norm = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let i = 0; i <= r && i < w; i++) sum += src[row + i];
    for (let x = 0; x < w; x++) {
      dst[row + x] = sum * norm;
      const add = x + r + 1, rem = x - r;
      if (add < w) sum += src[row + add];
      if (rem >= 0) sum -= src[row + rem];
    }
  }
}
/** One vertical box pass. */
function boxV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const norm = 1 / (2 * r + 1);
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let i = 0; i <= r && i < h; i++) sum += src[i * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = sum * norm;
      const add = y + r + 1, rem = y - r;
      if (add < h) sum += src[add * w + x];
      if (rem >= 0) sum -= src[rem * w + x];
    }
  }
}

/** Box radii for n box passes approximating a Gaussian of the given sigma. */
function boxesForGauss(sigma: number, n: number): number[] {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(((i < m ? wl : wu) - 1) / 2);
  return out;
}

/**
 * Gaussian-ish blur (3 separable box passes) in place on a float field.
 * `sigma` is in pixels; sigma < 0.5 is a no-op.
 */
export function blur(f: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (!(sigma >= 0.5) || w < 2 || h < 2) return f;
  const tmp = new Float32Array(f.length);
  for (const r of boxesForGauss(sigma, 3)) {
    if (r < 1) continue;
    boxH(f, tmp, w, h, r);
    boxV(tmp, f, w, h, r);
  }
  return f;
}

/**
 * Area-average downsample of a float/byte field into cells of `cell` px
 * (cells at the right/bottom edge may be partial). Returns [field, sw, sh].
 */
export function downsample(data: ArrayLike<number>, w: number, h: number, cell: number): [Float32Array, number, number] {
  const sw = Math.max(1, Math.ceil(w / cell)), sh = Math.max(1, Math.ceil(h / cell));
  const sum = new Float32Array(sw * sh), cnt = new Float32Array(sw * sh);
  const colOf = new Int32Array(w);
  for (let x = 0; x < w; x++) colOf[x] = Math.min(sw - 1, Math.floor(x / cell));
  for (let y = 0; y < h; y++) {
    const sy = Math.min(sh - 1, Math.floor(y / cell)) * sw, row = y * w;
    for (let x = 0; x < w; x++) { const i = sy + colOf[x]; sum[i] += data[row + x]; cnt[i]++; }
  }
  for (let i = 0; i < sum.length; i++) sum[i] = cnt[i] ? sum[i] / cnt[i] : 0;
  return [sum, sw, sh];
}

/** Bilinear upsample of a cell field (cell size `cell` px) back to w×h. */
export function upsampleBilinear(small: Float32Array, sw: number, sh: number, cell: number, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  const xi0 = new Int32Array(w), xi1 = new Int32Array(w), xf = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let u = (x + 0.5) / cell - 0.5;
    if (u < 0) u = 0; if (u > sw - 1) u = sw - 1;
    const i0 = Math.floor(u);
    xi0[x] = i0; xi1[x] = Math.min(sw - 1, i0 + 1); xf[x] = u - i0;
  }
  for (let y = 0; y < h; y++) {
    let v = (y + 0.5) / cell - 0.5;
    if (v < 0) v = 0; if (v > sh - 1) v = sh - 1;
    const j0 = Math.floor(v), j1 = Math.min(sh - 1, j0 + 1), fy = v - j0;
    const r0 = j0 * sw, r1 = j1 * sw, row = y * w;
    for (let x = 0; x < w; x++) {
      const fx = xf[x];
      const a = small[r0 + xi0[x]], b = small[r0 + xi1[x]], c = small[r1 + xi0[x]], d = small[r1 + xi1[x]];
      out[row + x] = (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
    }
  }
  return out;
}

/* ---------------------------------------------------------------------- ops */

/** Gaussian-ish blur then threshold: softens and merges nearby shapes. */
export const blob: RasterOp = (bmp, params) => {
  const sigma = num(params, 'blur', 8, 0, 40);
  const t = num(params, 'threshold', 128, 0, 255);
  const f = blur(toFloat(bmp), bmp.width, bmp.height, sigma);
  return fromFloat(bmp, f, t);
};

/**
 * Binary median over a disc of `radius` px: straight edges stay put, corners
 * and spurs get rounded. O(w·h·r) using per-row prefix sums.
 */
export const round: RasterOp = (bmp, params) => {
  const r = Math.round(num(params, 'radius', 4, 1, 20));
  const w = bmp.width, h = bmp.height;
  if (w < 3 || h < 3) return binary(bmp);
  const pw = w + 1;
  const pre = new Int32Array(pw * h);
  for (let y = 0; y < h; y++) {
    let acc = 0;
    const row = y * w, prow = y * pw;
    for (let x = 0; x < w; x++) { if (bmp.data[row + x] >= 128) acc++; pre[prow + x + 1] = acc; }
  }
  const span = new Int32Array(2 * r + 1);
  let total = 0;
  for (let dy = -r; dy <= r; dy++) { span[dy + r] = Math.floor(Math.sqrt(r * r - dy * dy)); total += 2 * span[dy + r] + 1; }
  const out = makeBitmap(w, h, bmp.origin, bmp.scale);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      let count = 0;
      for (let yy = y0; yy <= y1; yy++) {
        const s = span[yy - y + r];
        const prow = yy * pw;
        count += pre[prow + Math.min(w, x + s + 1)] - pre[prow + Math.max(0, x - s)];
      }
      if (count * 2 > total) out.data[y * w + x] = 255;
    }
  }
  return out;
};

/** Majority-vote block pixelation on a grid shifted by offset×size. */
export const pixel: RasterOp = (bmp, params) => {
  const s = Math.round(num(params, 'size', 10, 2, 60));
  const ox = Math.round(num(params, 'offsetX', 0, 0, 1) * s) - s;
  const oy = Math.round(num(params, 'offsetY', 0, 0, 1) * s) - s;
  const w = bmp.width, h = bmp.height;
  const out = makeBitmap(w, h, bmp.origin, bmp.scale);
  for (let cy = oy; cy < h; cy += s) {
    const y0 = Math.max(0, cy), y1 = Math.min(h, cy + s);
    if (y1 <= y0) continue;
    for (let cx = ox; cx < w; cx += s) {
      const x0 = Math.max(0, cx), x1 = Math.min(w, cx + s);
      if (x1 <= x0) continue;
      let sum = 0;
      for (let y = y0; y < y1; y++) { const row = y * w; for (let x = x0; x < x1; x++) sum += bmp.data[row + x]; }
      if (sum / ((y1 - y0) * (x1 - x0)) >= 128) {
        for (let y = y0; y < y1; y++) out.data.fill(255, y * w + x0, y * w + x1);
      }
    }
  }
  return out;
};

/** Low-res area average, sharpened, bilinearly blown back up: chunky stencil. */
export const crunch: RasterOp = (bmp, params) => {
  const cell = Math.round(num(params, 'resolution', 8, 2, 40));
  const passes = Math.round(num(params, 'sharpen', 2, 0, 6));
  const t = num(params, 'threshold', 128, 0, 255);
  const w = bmp.width, h = bmp.height;
  const ds = downsample(bmp.data, w, h, cell);
  let small: Float32Array = ds[0];
  const sw = ds[1], sh = ds[2];
  if (sw >= 2 && sh >= 2) {
    let tmp: Float32Array = new Float32Array(small.length);
    for (let p = 0; p < passes; p++) {
      for (let y = 0; y < sh; y++) {
        const ym = Math.max(0, y - 1) * sw, yp = Math.min(sh - 1, y + 1) * sw, row = y * sw;
        for (let x = 0; x < sw; x++) {
          const xm = Math.max(0, x - 1), xp = Math.min(sw - 1, x + 1);
          const v = 5 * small[row + x] - small[row + xm] - small[row + xp] - small[ym + x] - small[yp + x];
          tmp[row + x] = v < 0 ? 0 : v > 255 ? 255 : v;
        }
      }
      const sw2 = small; small = tmp; tmp = sw2;
    }
  }
  const up = upsampleBilinear(small, sw, sh, cell, w, h);
  return fromFloat(bmp, up, t);
};

/**
 * Ragged ink-blot edges: soften, add low-frequency 3D noise (time is the
 * third axis so edges drift smoothly), soften a little more, threshold.
 */
export const inkNoise: RasterOp = (bmp, params, ctx) => {
  const soft = num(params, 'softness', 8, 0, 30);
  const size = num(params, 'noiseSize', 14, 2, 60);
  const amount = num(params, 'amount', 0.6, 0, 1);
  const t = num(params, 'threshold', 128, 0, 255);
  const w = bmp.width, h = bmp.height;
  const f = blur(toFloat(bmp), w, h, soft);
  if (amount > 0) {
    // sample the (smooth) noise on a coarse lattice and interpolate
    const step = Math.max(1, Math.floor(size / 4));
    const gw = Math.ceil(w / step) + 1, gh = Math.ceil(h / step) + 1;
    const grid = new Float32Array(gw * gh);
    const time = Number.isFinite(ctx.time) ? ctx.time : 0;
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      grid[gy * gw + gx] = ctx.rng.noise3((gx * step) / size, (gy * step) / size, time);
    }
    const scaleN = amount * 140;
    for (let y = 0; y < h; y++) {
      const v = y / step, j0 = Math.min(gh - 1, Math.floor(v)), j1 = Math.min(gh - 1, j0 + 1), fy = v - j0;
      for (let x = 0; x < w; x++) {
        const u = x / step, i0 = Math.min(gw - 1, Math.floor(u)), i1 = Math.min(gw - 1, i0 + 1), fx = u - i0;
        const a = grid[j0 * gw + i0], b = grid[j0 * gw + i1], c = grid[j1 * gw + i0], d = grid[j1 * gw + i1];
        f[y * w + x] += ((a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy) * scaleN;
      }
    }
  }
  blur(f, w, h, soft / 3);
  return fromFloat(bmp, f, t);
};

/**
 * Round dilate (amount > 0) / erode (amount < 0) via exact Euclidean distance.
 *
 * `distanceTransform(mask)` from inputs/image/thin gives, for every pixel in
 * the mask, the distance to the nearest pixel outside it, and it treats
 * everything beyond the bitmap border as "outside". For erosion that is
 * exactly right (mask = ink, border = paper). For dilation the mask is the
 * paper, so the border would wrongly act as ink; we run it on a copy padded
 * by `amount + 2` paper pixels so the border can never reach the real area.
 */
export const morph: RasterOp = (bmp, params) => {
  const amount = num(params, 'amount', 6, -30, 30);
  const w = bmp.width, h = bmp.height;
  const out = makeBitmap(w, h, bmp.origin, bmp.scale);
  if (Math.abs(amount) < 0.5) { for (let i = 0; i < out.data.length; i++) out.data[i] = bmp.data[i] >= 128 ? 255 : 0; return out; }
  if (amount < 0) {
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) mask[i] = bmp.data[i] >= 128 ? 1 : 0;
    const d = distanceTransform(mask, w, h);
    const r = -amount;
    for (let i = 0; i < mask.length; i++) if (d[i] > r) out.data[i] = 255;
    return out;
  }
  const m = Math.ceil(amount) + 2;
  const W = w + 2 * m, H = h + 2 * m;
  const mask = new Uint8Array(W * H).fill(1);
  for (let y = 0; y < h; y++) {
    const row = y * w, prow = (y + m) * W + m;
    for (let x = 0; x < w; x++) if (bmp.data[row + x] >= 128) mask[prow + x] = 0;
  }
  const d = distanceTransform(mask, W, H);
  for (let y = 0; y < h; y++) {
    const row = y * w, prow = (y + m) * W + m;
    for (let x = 0; x < w; x++) if (d[prow + x] <= amount) out.data[row + x] = 255;
  }
  return out;
};
