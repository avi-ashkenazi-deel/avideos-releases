import type { Glyph, Contour, StrokePoint } from '../core/glyph';
import { resampleStroke } from '../core/geometry';
import type { OpCtx } from './types';
import { densifyClosed, ringNormals } from './util';
import { normalizeContours } from './clip';

export const WOBBLE_FREQ = 0.012;
export const WOBBLE_AMP = 28;

/** Stage A (stroke glyphs): noise displacement along the stroke normal + width modulation. */
export function wobbleSkeleton(glyph: Glyph, amount: number, ctx: OpCtx): Glyph {
  if (glyph.kind !== 'stroke' || !glyph.strokes) return glyph;
  const { noise2 } = ctx.rng;
  return {
    ...glyph,
    strokes: glyph.strokes.map((s) => {
      const pts = resampleStroke(s.points, 12);
      const n = pts.length;
      const out: StrokePoint[] = new Array(n);
      for (let i = 0; i < n; i++) {
        const p = pts[i];
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
        const tx = b.x - a.x, ty = b.y - a.y;
        const l = Math.hypot(tx, ty) || 1;
        const nx = -ty / l, ny = tx / l;
        const nz = noise2(p.x * WOBBLE_FREQ, p.y * WOBBLE_FREQ);
        const wz = noise2(p.x * WOBBLE_FREQ + 37.1, p.y * WOBBLE_FREQ - 19.3);
        const d = nz * amount * WOBBLE_AMP;
        out[i] = { ...p, x: p.x + nx * d, y: p.y + ny * d, w: Math.max(1, p.w * (1 + wz * amount * 0.5)) };
      }
      return { ...s, points: out };
    }),
  };
}

/** Stage B (outline glyphs): densify each contour and push vertices along the normal with noise. */
export function wobbleOutline(contours: Contour[], amount: number, ctx: OpCtx): Contour[] {
  const { noise2 } = ctx.rng;
  const out = contours.map((c) => {
    const pts = densifyClosed(c.points, 10);
    const nrm = ringNormals(pts);
    return {
      points: pts.map((p, i) => {
        const d = noise2(p[0] * WOBBLE_FREQ, p[1] * WOBBLE_FREQ) * amount * WOBBLE_AMP;
        return [p[0] + nrm[i][0] * d, p[1] + nrm[i][1] * d] as [number, number];
      }),
    };
  });
  return normalizeContours(out);
}
