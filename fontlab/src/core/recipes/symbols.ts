/**
 * Currency, legal and maths symbol skeletons. Same conventions as the letter
 * recipes (local frame x = 0 leftmost centreline, baseline y = 0, y up); all
 * sizes are relative to cap / x-height so they follow the user's metrics.
 */
import type { Stroke } from '../glyph';
import type { Recipe, RecipeCtx } from './common';
import { frame, rec } from './common';
import {
  arc, arcPts, bar, bowl, cup, diagonal, dot, joinPts, linePts, path, poly, stem,
} from '../../generate/primitives';

/** the two S arcs of upper.S for a given height h and width Ws, raised by y0 */
function sArcs(c: RecipeCtx, Ws: number, h: number, y0: number, o: number): Stroke[] {
  const r1 = h * 0.235, r2 = h * 0.265;
  const cx = Ws / 2;
  return [
    arc(c, cx, y0 + h - r1 + o / 2, Ws * 0.46, r1 + o / 2, 40, 270),
    arc(c, cx, y0 + r2 - o / 2, Ws * 0.5, r2 + o / 2, 90, -140),
  ];
}

/** uppercase R skeleton of height h with its stem at (x0, y0), optional width multiplier */
function rLetter(c: RecipeCtx, x0: number, y0: number, h: number, k: number, widthMul: number): Stroke[] {
  const Wn = h * 0.5 * k;
  const mid = h * 0.46;
  const r = (h - mid) / 2;
  const bx = Wn - r;
  const opts = { widthMul };
  return [
    stem(c, x0, y0, y0 + h, opts),
    path(c, joinPts(
      linePts(x0, y0 + h, x0 + bx, y0 + h),
      arcPts(x0 + bx, y0 + h - r, r, r, 90, -90),
      linePts(x0 + bx, y0 + mid, x0, y0 + mid),
    ), opts),
    diagonal(c, x0 + bx * 0.9, y0 + mid, x0 + Wn * 1.02, y0, opts),
  ];
}

function plus(c: RecipeCtx, cx: number, cy: number, a: number, k: number): Stroke[] {
  return [bar(c, cx - a * k, cx + a * k, cy), stem(c, cx, cy - a, cy + a)];
}

export const symbols: Record<string, Recipe> = {
  $: rec('$', (c) => {
    const f = frame(c);
    const Ws = f.cap * 0.52 * f.k;
    return [...sArcs(c, Ws, f.cap, 0, f.o), stem(c, Ws / 2, -f.cap * 0.1, f.cap * 1.1)];
  }),

  '€': rec('€', (c) => {
    const f = frame(c);
    const R = f.cap * 0.33 * f.k;
    const x0 = -f.cap * 0.1 * f.k;
    return [
      arc(c, R, f.cap / 2, R, f.cap / 2 + f.o, 42, 318),
      bar(c, x0, R * 0.95, f.cap * 0.42),
      bar(c, x0, R * 0.95, f.cap * 0.58),
    ];
  }),

  '£': rec('£', (c) => {
    const f = frame(c);
    const W = f.cap * 0.5 * f.k;
    const xs = W * 0.3;
    const rf = f.cap * 0.19 * f.k, rfy = f.cap * 0.19;
    return [
      path(c, joinPts(
        linePts(xs, 0, xs, f.cap - rfy),
        arcPts(xs + rf, f.cap - rfy, rf, rfy + f.o / 2, 180, 50),
      )),
      bar(c, 0, xs + W * 0.38, f.cap * 0.45),
      bar(c, 0, W, 0),
    ];
  }),

  '¥': rec('¥', (c) => {
    const f = frame(c);
    const Wy = f.cap * 0.58 * f.k;
    const yj = f.cap * 0.45;
    return [
      diagonal(c, 0, f.cap, Wy / 2, yj),
      diagonal(c, Wy, f.cap, Wy / 2, yj),
      stem(c, Wy / 2, yj, 0),
      bar(c, Wy * 0.12, Wy * 0.88, f.cap * 0.38),
      bar(c, Wy * 0.12, Wy * 0.88, f.cap * 0.2),
    ];
  }),

  '¢': rec('¢', (c) => {
    const f = frame(c);
    const r = f.xh * 0.3 * f.k, ry = f.xh / 2 + f.o;
    return [
      arc(c, r, f.xh / 2, r, ry, 45, 315),
      stem(c, r, f.xh * 1.15, -f.xh * 0.15),
    ];
  }),

  '©': rec('©', (c) => {
    const f = frame(c);
    const R = f.cap * 0.5, Rx = R * f.k;
    return [
      bowl(c, Rx, f.cap / 2, Rx, R, { widthMul: 0.9 }),
      arc(c, Rx, f.cap / 2, Rx * 0.5, R * 0.5, 45, 315, { widthMul: 0.8 }),
    ];
  }),

  '®': rec('®', (c) => {
    const f = frame(c);
    const R = f.cap * 0.5, Rx = R * f.k;
    const h = f.cap * 0.5;
    const Wn = h * 0.5 * f.k;
    return [
      bowl(c, Rx, f.cap / 2, Rx, R, { widthMul: 0.9 }),
      ...rLetter(c, Rx - Wn * 0.51, f.cap / 2 - h / 2, h, f.k, 0.8),
    ];
  }),

  '™': rec('™', (c) => {
    const f = frame(c);
    const h = f.cap * 0.4, y0 = f.cap - h;
    const opts = { widthMul: 0.65 };
    const Wt = h * 0.6 * f.k;
    const xm = Wt + h * 0.25 * f.k;
    const Wm = h * 0.8 * f.k;
    return [
      bar(c, 0, Wt, f.cap, opts),
      stem(c, Wt / 2, y0, f.cap, opts),
      stem(c, xm, y0, f.cap, opts),
      poly(c, [[xm, f.cap], [xm + Wm / 2, y0 + h * 0.1], [xm + Wm, f.cap]], opts),
      stem(c, xm + Wm, y0, f.cap, opts),
    ];
  }),

  '°': rec('°', (c) => {
    const f = frame(c);
    const r = f.cap * 0.12;
    return [bowl(c, r * f.k, f.cap - r, r * f.k, r, { widthMul: 0.8 })];
  }),

  '±': rec('±', (c) => {
    const f = frame(c);
    const a = f.cap * 0.24;
    return [...plus(c, 0, f.cap * 0.48, a, f.k), bar(c, -a * f.k, a * f.k, f.cap * 0.05)];
  }),

  '×': rec('×', (c) => {
    const f = frame(c);
    const s = f.cap * 0.2, sx = s * f.k, mid = f.xh * 0.5;
    return [diagonal(c, -sx, mid - s, sx, mid + s), diagonal(c, -sx, mid + s, sx, mid - s)];
  }),

  '÷': rec('÷', (c) => {
    const f = frame(c);
    const a = f.cap * 0.28 * f.k, mid = f.xh * 0.5, d = f.cap * 0.2;
    return [bar(c, -a, a, mid), dot(c, 0, mid + d, f.hw), dot(c, 0, mid - d, f.hw)];
  }),

  '•': rec('•', (c) => {
    const f = frame(c);
    return [dot(c, 0, f.xh * 0.5, f.cap * 0.16)];
  }),

  '…': rec('…', (c) => {
    const f = frame(c);
    const d = f.cap * 0.27 * f.k;
    return [dot(c, 0, f.hw, f.hw), dot(c, d, f.hw, f.hw), dot(c, 2 * d, f.hw, f.hw)];
  }),

  '§': rec('§', (c) => {
    const f = frame(c);
    // two stacked S-curves: top hook + bottom hook, joined by a central loop
    const Ws = f.cap * 0.5 * f.k;
    const r = f.cap * 0.17;
    const cx = Ws / 2;
    return [
      arc(c, cx, f.cap - r + f.o / 2, Ws * 0.44, r + f.o / 2, 40, 275),
      bowl(c, cx, f.cap / 2, Ws * 0.42, f.cap * 0.19),
      arc(c, cx, r - f.o / 2, Ws * 0.44, r + f.o / 2, 95, -140),
    ];
  }),

  '¶': rec('¶', (c) => {
    const f = frame(c);
    const rx = f.cap * 0.18 * f.k, ry = f.cap * 0.24;
    const x1 = 2 * rx, x2 = x1 + f.cap * 0.2 * f.k;
    return [
      bowl(c, rx, f.cap - ry, rx, ry),
      stem(c, x1, 0, f.cap),
      stem(c, x2, 0, f.cap),
      bar(c, rx, x2, f.cap),
    ];
  }),

  '†': rec('†', (c) => {
    const f = frame(c);
    const a = f.cap * 0.2 * f.k;
    return [stem(c, 0, 0, f.cap), bar(c, -a, a, f.cap * 0.72)];
  }),

  '‡': rec('‡', (c) => {
    const f = frame(c);
    const a = f.cap * 0.2 * f.k;
    return [stem(c, 0, 0, f.cap), bar(c, -a, a, f.cap * 0.72), bar(c, -a, a, f.cap * 0.28)];
  }),

  'µ': rec('µ', (c) => {
    const f = frame(c);
    const n = f.xh * 0.56 * f.k;
    return [cup(c, 0, n, f.xh, -f.o, f.xh * 0.34), stem(c, n, f.xh, 0), stem(c, 0, f.xh, f.desc)];
  }),

  '¬': rec('¬', (c) => {
    const f = frame(c);
    const W = f.cap * 0.55 * f.k, y = f.xh * 0.6;
    return [bar(c, 0, W, y), stem(c, W, y, y - f.cap * 0.22)];
  }),
};
