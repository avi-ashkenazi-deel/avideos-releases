/**
 * Gray–Scott reaction–diffusion driven by the glyph.
 *
 * Instead of merely seeding the reaction with the letter, the letter chooses
 * the regime: each simulation cell gets feed/kill rates linearly interpolated
 * between the "ink" and "paper" values by its ink fraction. The pattern that
 * grows is therefore different inside and around the glyph and follows its
 * shape (LivingPath's trick).
 *
 * Output: the pattern (V-rich / U-depleted cells) is rendered as ink and the
 * undisturbed field (U≈1, V≈0) as paper, i.e. value = (1 − (U − V))·255,
 * upsampled bilinearly to the input size, thresholded and optionally inverted.
 *
 * Grid: the simulation runs on a (sw+2)×(sh+2) array with a one-cell ghost
 * border that is refreshed from its neighbour after each step (zero-flux,
 * wrap-free edges), so the inner loop needs no index clamping.
 */
import type { RasterOp } from '../types';
import { cloneBitmap, makeBitmap } from './bitmap';
import { downsample, num, upsampleBilinear } from './ops';

const DU = 1.0, DV = 0.5, DT = 1;
/**
 * Cap on simulation cells so a glyph stays well under the frame budget. At
 * 160 px/em this caps the effective `resolution` around 100 cells across a
 * typical glyph; higher values only matter for small glyphs.
 */
const MAX_CELLS = 16000;

export const reactionDiffusion: RasterOp = (bmp, params, ctx) => {
  const resolution = num(params, 'resolution', 96, 48, 200);
  const steps = Math.round(num(params, 'steps', 300, 50, 1200));
  // defaults: worms/stripes inside the glyph, slow coral growth around it
  const feedInk = num(params, 'feedInk', 0.03, 0.02, 0.08);
  const feedPaper = num(params, 'feedPaper', 0.055, 0.02, 0.08);
  const killInk = num(params, 'killInk', 0.06, 0.02, 0.08);
  const killPaper = num(params, 'killPaper', 0.062, 0.02, 0.08);
  const thresholdV = num(params, 'threshold', 90, 0, 255);
  const invert = num(params, 'invert', 0, 0, 1) >= 0.5;
  const time = Number.isFinite(ctx.time) ? ctx.time : 0;

  const w = bmp.width, h = bmp.height;
  // ink bbox → cell size so that `resolution` cells span the glyph
  let minX = w, maxX = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) if (bmp.data[row + x] >= 128) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
  }
  if (maxX < 0 || w < 3 || h < 3) return cloneBitmap(bmp);
  let cell = Math.max(0.5, (maxX - minX + 1) / resolution);
  if ((w / cell) * (h / cell) > MAX_CELLS) cell = Math.sqrt((w * h) / MAX_CELLS);

  const [inkField, sw, sh] = downsample(bmp.data, w, h, cell);
  const n = sw * sh;
  for (let i = 0; i < n; i++) inkField[i] /= 255;

  // ghost-bordered grid
  const GW = sw + 2, GH = sh + 2, gn = GW * GH;
  const F = new Float64Array(gn), FK = new Float64Array(gn);
  let U = new Float64Array(gn), V = new Float64Array(gn);
  let U2 = new Float64Array(gn), V2 = new Float64Array(gn);
  const rng = ctx.rng;
  const phase = time * 0.37;
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const i = y * sw + x, g = (y + 1) * GW + x + 1;
    const t = inkField[i];
    const f = feedPaper + (feedInk - feedPaper) * t;
    const k = killPaper + (killInk - killPaper) * t;
    F[g] = f; FK[g] = f + k;
    // U ≈ 1 with noise, V = small noise whose phase drifts with time
    const nz = rng.noise3(x / 5, y / 5, phase);
    U[g] = 1 - 0.03 * rng() - 0.02 * (nz + 1);
    V[g] = 0.015 * (nz + 1) * rng();
  }
  // a few V seeds inside the ink
  const inkCells: number[] = [];
  for (let i = 0; i < n; i++) if (inkField[i] > 0.5) inkCells.push(i);
  if (inkCells.length) {
    const seeds = Math.min(60, Math.max(3, Math.round(inkCells.length / 90)));
    for (let s = 0; s < seeds; s++) {
      const i = inkCells[Math.floor(rng() * inkCells.length)];
      const cx = i % sw, cy = (i - cx) / sw;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        if (dx * dx + dy * dy > 5) continue;
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= sw || y >= sh) continue;
        const g = (y + 1) * GW + x + 1;
        U[g] = 0.5; V[g] = 0.75;
      }
    }
  }
  const refreshGhosts = (A: Float64Array) => {
    for (let x = 1; x <= sw; x++) { A[x] = A[GW + x]; A[(GH - 1) * GW + x] = A[(GH - 2) * GW + x]; }
    for (let y = 0; y < GH; y++) { const r = y * GW; A[r] = A[r + 1]; A[r + GW - 1] = A[r + GW - 2]; }
  };
  refreshGhosts(U); refreshGhosts(V);

  for (let s = 0; s < steps; s++) {
    const A = U, B = V, A2 = U2, B2 = V2;
    for (let y = 1; y <= sh; y++) {
      const row = y * GW, end = row + sw;
      for (let i = row + 1; i <= end; i++) {
        const u = A[i], v = B[i];
        const lapU = 0.2 * (A[i - 1] + A[i + 1] + A[i - GW] + A[i + GW])
          + 0.05 * (A[i - GW - 1] + A[i - GW + 1] + A[i + GW - 1] + A[i + GW + 1]) - u;
        const lapV = 0.2 * (B[i - 1] + B[i + 1] + B[i - GW] + B[i + GW])
          + 0.05 * (B[i - GW - 1] + B[i - GW + 1] + B[i + GW - 1] + B[i + GW + 1]) - v;
        const uvv = u * v * v;
        let nu = u + (DU * lapU - uvv + F[i] * (1 - u)) * DT;
        let nv = v + (DV * lapV + uvv - FK[i] * v) * DT;
        if (nu < 0) nu = 0; else if (nu > 1) nu = 1;
        if (nv < 0) nv = 0; else if (nv > 1) nv = 1;
        A2[i] = nu; B2[i] = nv;
      }
    }
    let t = U; U = U2; U2 = t;
    t = V; V = V2; V2 = t;
    refreshGhosts(U); refreshGhosts(V);
  }

  // render: pattern → ink
  const field = new Float32Array(n);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const g = (y + 1) * GW + x + 1;
    let v = 1 - (U[g] - V[g]);
    if (v < 0) v = 0; else if (v > 1) v = 1;
    field[y * sw + x] = v * 255;
  }
  const up = upsampleBilinear(field, sw, sh, cell, w, h);
  const out = makeBitmap(w, h, bmp.origin, bmp.scale);
  for (let i = 0; i < up.length; i++) {
    const ink = up[i] >= thresholdV;
    out.data[i] = ink !== invert ? 255 : 0;
  }
  return out;
};
