import type { Contour } from '../core/glyph';
import { bboxContours, mapContours } from '../core/geometry';
import type { OpCtx } from './types';
import { intersectRect, unionSets } from './clip';

/**
 * Horizontal slice shifting: the glyph is cut into 3..7 bands of random height,
 * most bands slide sideways by up to ±90·amount, and with probability 0.3·amount
 * a thin slice of a band is dropped entirely. Pieces are unioned back together.
 */
export function glitch(contours: Contour[], amount: number, ctx: OpCtx): Contour[] {
  if (contours.length === 0) return contours;
  const { rng } = ctx;
  const b = bboxContours(contours);
  const n = rng.int(3, 7);
  const weights: number[] = [];
  for (let i = 0; i < n; i++) weights.push(rng.range(0.35, 1));
  const total = weights.reduce((a, w) => a + w, 0);
  const y0 = b.minY - 1, span = b.maxY - b.minY + 2;
  const edges: number[] = [y0];
  let acc = 0;
  for (let i = 0; i < n; i++) { acc += weights[i] / total; edges.push(y0 + span * acc); }

  const shifts: number[] = [];
  for (let i = 0; i < n; i++) {
    const on = rng() < 0.65;
    const dx = rng.range(-1, 1) * amount * 90;
    shifts.push(on ? dx : 0);
  }
  if (shifts.every((s) => Math.abs(s) < 1e-9)) shifts[rng.int(0, n - 1)] = (rng() < 0.5 ? -1 : 1) * amount * 90;

  const cuts: Array<{ y: number; h: number } | null> = [];
  for (let i = 0; i < n; i++) {
    const drop = rng() < amount * 0.3;
    const h = rng.range(8, 22);
    const at = rng.range(0.2, 0.8);
    const bandH = edges[i + 1] - edges[i];
    cuts.push(drop && bandH > h * 2 ? { y: edges[i] + bandH * at, h } : null);
  }

  const pieces: Contour[][] = [];
  const x0 = b.minX - 200, x1 = b.maxX + 200;
  for (let i = 0; i < n; i++) {
    const ranges: [number, number][] = cuts[i]
      ? [[edges[i], cuts[i]!.y], [cuts[i]!.y + cuts[i]!.h, edges[i + 1]]]
      : [[edges[i], edges[i + 1]]];
    for (const [ya, yb] of ranges) {
      let piece = intersectRect(contours, ya, yb, x0, x1);
      if (piece.length === 0) continue;
      const dx = shifts[i];
      if (dx !== 0) piece = mapContours(piece, ([x, y]) => [x + dx, y]);
      pieces.push(piece);
    }
  }
  return unionSets(pieces);
}
