/**
 * Raster helpers that work on plain pixel buffers so they can run in Node
 * (vitest) as well as the browser. No DOM types are required.
 */

/** Minimal ImageData-compatible buffer. `data` is gray (w*h), RGB (w*h*3) or RGBA (w*h*4). */
export interface ImageLike {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

export interface PixelBox {
  /** inclusive */
  x0: number;
  y0: number;
  /** inclusive */
  x1: number;
  y1: number;
}

export interface Component {
  id: number;
  bbox: PixelBox;
  /** number of ink pixels */
  pixels: number;
  /** cropped binary mask of size (x1-x0+1) * (y1-y0+1), 1 = ink */
  mask: Uint8Array;
}

export const boxW = (b: PixelBox) => b.x1 - b.x0 + 1;
export const boxH = (b: PixelBox) => b.y1 - b.y0 + 1;

/** Luma (0..255) per pixel. Transparent pixels are composited over white. */
export function toGray(img: ImageLike): Float32Array {
  const { width, height, data } = img;
  const n = width * height;
  const out = new Float32Array(n);
  const ch = n === 0 ? 4 : data.length / n;
  if (ch === 1) {
    for (let i = 0; i < n; i++) out[i] = data[i];
  } else if (ch === 3) {
    for (let i = 0, j = 0; i < n; i++, j += 3) out[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
  } else if (ch === 4) {
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const a = data[j + 3] / 255;
      const l = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
      out[i] = l * a + 255 * (1 - a);
    }
  } else if (ch === 2) {
    for (let i = 0, j = 0; i < n; i++, j += 2) {
      const a = data[j + 1] / 255;
      out[i] = data[j] * a + 255 * (1 - a);
    }
  } else {
    throw new Error(`toGray: unsupported channel count ${ch}`);
  }
  return out;
}

/** Otsu's method on a 256-bin histogram. Returns a threshold in 0..255 (pixels < thr are "dark"). */
export function otsuThreshold(gray: Float32Array): number {
  const hist = new Float64Array(256);
  const n = gray.length;
  if (n === 0) return 128;
  for (let i = 0; i < n; i++) {
    const v = gray[i];
    const b = v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
    hist[b]++;
  }
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 0, bestLo = 128, bestHi = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = n - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best * (1 + 1e-9)) { best = between; bestLo = bestHi = t; }
    else if (between >= best * (1 - 1e-9)) bestHi = t; // flat plateau between the modes
  }
  // middle of the plateau, just above the chosen bin so `gray < thr` includes it
  return (bestLo + bestHi) / 2 + 0.5;
}

/** 1 = ink. By default ink is dark (gray < thr); `invert` for light-on-dark. */
export function binarize(gray: Float32Array, thr: number, invert = false): Uint8Array {
  const out = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    const dark = gray[i] < thr;
    out[i] = (dark !== invert) ? 1 : 0;
  }
  return out;
}

/**
 * 8-connected components via BFS. Each component gets its own tight-cropped mask.
 */
export function connectedComponents(bin: Uint8Array, w: number, h: number): Component[] {
  const labels = new Int32Array(w * h); // 0 = unlabelled
  const comps: Component[] = [];
  const queue = new Int32Array(w * h);
  let nextId = 1;
  for (let start = 0; start < w * h; start++) {
    if (!bin[start] || labels[start]) continue;
    const id = nextId++;
    let qh = 0, qt = 0;
    queue[qt++] = start;
    labels[start] = id;
    let x0 = w, y0 = h, x1 = -1, y1 = -1, count = 0;
    const members: number[] = [];
    while (qh < qt) {
      const idx = queue[qh++];
      const x = idx % w, y = (idx - x) / w;
      members.push(idx);
      count++;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const ni = ny * w + nx;
          if (bin[ni] && !labels[ni]) { labels[ni] = id; queue[qt++] = ni; }
        }
      }
    }
    const cw = x1 - x0 + 1, chh = y1 - y0 + 1;
    const mask = new Uint8Array(cw * chh);
    for (const idx of members) {
      const x = idx % w, y = (idx - x) / w;
      mask[(y - y0) * cw + (x - x0)] = 1;
    }
    comps.push({ id, bbox: { x0, y0, x1, y1 }, pixels: count, mask });
  }
  return comps;
}

/** Remove components with fewer than `minPixels` ink pixels. Returns a new buffer. */
export function despeckle(bin: Uint8Array, w: number, h: number, minPixels: number): Uint8Array {
  const out = new Uint8Array(bin);
  if (minPixels <= 1) return out;
  for (const c of connectedComponents(bin, w, h)) {
    if (c.pixels >= minPixels) continue;
    const cw = boxW(c.bbox);
    for (let y = c.bbox.y0; y <= c.bbox.y1; y++) {
      for (let x = c.bbox.x0; x <= c.bbox.x1; x++) {
        if (c.mask[(y - c.bbox.y0) * cw + (x - c.bbox.x0)]) out[y * w + x] = 0;
      }
    }
  }
  return out;
}

/** Paint several components into one mask covering `box` (plus `pad` pixels of margin on each side). */
export function compositeMask(components: Component[], box: PixelBox, pad = 0): { width: number; height: number; mask: Uint8Array; originX: number; originY: number } {
  const width = boxW(box) + 2 * pad, height = boxH(box) + 2 * pad;
  const mask = new Uint8Array(width * height);
  const originX = box.x0 - pad, originY = box.y0 - pad;
  for (const c of components) {
    const cw = boxW(c.bbox), ch = boxH(c.bbox);
    for (let y = 0; y < ch; y++) {
      const ty = c.bbox.y0 + y - originY;
      if (ty < 0 || ty >= height) continue;
      for (let x = 0; x < cw; x++) {
        if (!c.mask[y * cw + x]) continue;
        const tx = c.bbox.x0 + x - originX;
        if (tx >= 0 && tx < width) mask[ty * width + tx] = 1;
      }
    }
  }
  return { width, height, mask, originX, originY };
}

/** Binary mask -> opaque RGBA (ink black on white), e.g. to feed potrace. */
export function maskToRgba(mask: Uint8Array, w: number, h: number): { width: number; height: number; data: Uint8ClampedArray } {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    const v = mask[i] ? 0 : 255;
    data[j] = v; data[j + 1] = v; data[j + 2] = v; data[j + 3] = 255;
  }
  return { width: w, height: h, data };
}
