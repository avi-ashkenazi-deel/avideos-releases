/**
 * Warp effects: deterministic ("crisp") geometric deformers, all outline-stage.
 *
 * Every op works about the glyph's bbox centre so the glyph stays roughly in
 * place. Non-affine maps first densify each contour (original vertices are
 * kept, so corners survive), map the points, then re-resolve the result with
 * normalizeContours (fixes self-intersections). Pure affine maps (rotate, flip)
 * skip both steps. Identity parameters return the input untouched.
 */
import type { Contour, Vec } from '../../core/glyph';
import { bboxContours, clamp } from '../../core/geometry';
import { densifyClosed } from '../../dna/util';
import { normalizeContours } from '../../dna/clip';
import type { FxParamDef, OutlineOp } from '../types';

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : d);
const TAU = Math.PI * 2;
const rad = (deg: number) => (deg * Math.PI) / 180;

interface Frame { minX: number; minY: number; maxX: number; maxY: number; cx: number; cy: number; w: number; h: number }

/** bbox + centre + guarded size; null for empty input */
function frame(contours: Contour[]): Frame | null {
  if (!contours.some((c) => c.points.length > 0)) return null;
  const b = bboxContours(contours);
  return { ...b, cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, w: Math.max(1, b.maxX - b.minX), h: Math.max(1, b.maxY - b.minY) };
}

/** densify -> map -> normalize (falls back to the raw mapped rings if the clipper empties the result) */
function warp(contours: Contour[], f: (p: Vec) => Vec, spacing = 12): Contour[] {
  const mapped = contours.map((c) => ({ points: densifyClosed(c.points, spacing).map(f) }));
  const fixed = normalizeContours(mapped);
  return fixed.length ? fixed : mapped;
}

const rot = (x: number, y: number, cx: number, cy: number, a: number): Vec => {
  const c = Math.cos(a), s = Math.sin(a), dx = x - cx, dy = y - cy;
  return [cx + dx * c - dy * s, cy + dx * s + dy * c];
};

/** rotate about the bbox centre (affine: no densify / normalize needed) */
export const rotate: OutlineOp = (contours, p) => {
  const deg = num(p.degrees, -180, 180, 12);
  const fr = frame(contours);
  if (!fr || deg === 0) return contours;
  const a = rad(deg);
  return contours.map((c) => ({ points: c.points.map(([x, y]) => rot(x, y, fr.cx, fr.cy, a)) }));
};

/** mirror about the bbox centre; a single-axis mirror reverses winding, so rings are re-ordered to keep outers CCW */
export const flip: OutlineOp = (contours, p) => {
  const fh = num(p.horizontal, 0, 1, 1) >= 0.5, fv = num(p.vertical, 0, 1, 0) >= 0.5;
  const fr = frame(contours);
  if (!fr || (!fh && !fv)) return contours;
  const reverse = fh !== fv;
  return contours.map((c) => {
    const pts = c.points.map(([x, y]) => [fh ? 2 * fr.cx - x : x, fv ? 2 * fr.cy - y : y] as Vec);
    return { points: reverse ? pts.reverse() : pts };
  });
};

/** keystone: widen the top and narrow the bottom (or the reverse for k < 0) */
export const perspective: OutlineOp = (contours, p) => {
  const k = num(p.amount, -1, 1, 0.4);
  const fr = frame(contours);
  if (!fr || k === 0) return contours;
  return warp(contours, ([x, y]) => [fr.cx + (x - fr.cx) * (1 + (k * (y - fr.cy)) / fr.h), y]);
};

/** rotate each point about the centre by an angle proportional to its height */
export const twist: OutlineOp = (contours, p) => {
  const deg = num(p.degrees, -180, 180, 30);
  const fr = frame(contours);
  if (!fr || deg === 0) return contours;
  const a = rad(deg);
  return warp(contours, ([x, y]) => rot(x, y, fr.cx, fr.cy, (a * (y - fr.cy)) / fr.h));
};

/** squeeze the waist (k > 0) or bulge it (k < 0); top and bottom keep their width */
export const pinch: OutlineOp = (contours, p) => {
  const k = num(p.amount, -1, 1, 0.5);
  const fr = frame(contours);
  if (!fr || k === 0) return contours;
  const half = fr.h / 2;
  return warp(contours, ([x, y]) => [fr.cx + (x - fr.cx) * (1 - k * (1 - Math.abs(y - fr.cy) / half)), y]);
};

/** vertical shear: the right side is pulled up (k > 0) and the left side down */
export const pull: OutlineOp = (contours, p) => {
  const k = num(p.amount, -1, 1, 0.3);
  const fr = frame(contours);
  if (!fr || k === 0) return contours;
  return warp(contours, ([x, y]) => [x, y + (k * fr.h * (x - fr.cx)) / fr.w]);
};

/** horizontal sine displacement that runs up the glyph */
export const wave: OutlineOp = (contours, p) => {
  const A = num(p.amount, 0, 120, 30), waves = num(p.waves, 0.5, 4, 1.5);
  const fr = frame(contours);
  if (!fr || A === 0) return contours;
  return warp(contours, ([x, y]) => [x + A * Math.sin((TAU * waves * (y - fr.minY)) / fr.h), y]);
};

/** vertical sine displacement that runs across the glyph */
export const ripple: OutlineOp = (contours, p) => {
  const A = num(p.amount, 0, 120, 20), waves = num(p.waves, 0.5, 6, 2);
  const fr = frame(contours);
  if (!fr || A === 0) return contours;
  return warp(contours, ([x, y]) => [x, y + A * Math.sin((TAU * waves * (x - fr.minX)) / fr.w)]);
};

/** radial lens about the centre: k > 0 inflates the middle, k < 0 sucks it in; the bbox corners stay put */
export const bulge: OutlineOp = (contours, p) => {
  const k = num(p.amount, -1, 1, 0.4);
  const fr = frame(contours);
  if (!fr || k === 0) return contours;
  const R = Math.hypot(fr.w, fr.h) / 2;
  return warp(contours, ([x, y]) => {
    const dx = x - fr.cx, dy = y - fr.cy, r = Math.hypot(dx, dy);
    if (r >= R || r === 0) return [x, y];
    const f = 1 + k * (1 - r / R);
    return [fr.cx + dx * f, fr.cy + dy * f];
  });
};

/**
 * Glass bands: the height is cut into `bands` horizontal strips, alternately
 * shifted by +A / -A. Edges are split exactly at the band boundaries (each
 * crossing is emitted once per side), so the steps are true horizontal jogs;
 * normalizeContours then merges or separates the pieces.
 */
export const refraction: OutlineOp = (contours, p) => {
  const A = num(p.amount, 0, 120, 24), bands = Math.round(num(p.bands, 2, 12, 5));
  const fr = frame(contours);
  if (!fr || A === 0) return contours;
  const bandH = fr.h / bands;
  const bandOf = (y: number) => clamp(Math.floor((y - fr.minY) / bandH), 0, bands - 1);
  const shift = (b: number) => (b % 2 === 0 ? A : -A);
  const mapped = contours.map((c) => {
    const n = c.points.length;
    const pts: Vec[] = [];
    if (n < 3) return { points: c.points.slice() };
    for (let i = 0; i < n; i++) {
      const a = c.points[i], b = c.points[(i + 1) % n];
      const ends: Vec[] = [a];
      const ba = (a[1] - fr.minY) / bandH, bb = (b[1] - fr.minY) / bandH;
      const lo = Math.max(1, Math.floor(Math.min(ba, bb)) + 1), hi = Math.min(bands - 1, Math.ceil(Math.max(ba, bb)) - 1);
      if (hi >= lo) {
        const ks: number[] = [];
        for (let k = lo; k <= hi; k++) ks.push(k);
        if (bb < ba) ks.reverse();
        for (const k of ks) {
          const y = fr.minY + k * bandH;
          const t = (y - a[1]) / (b[1] - a[1]);
          ends.push([a[0] + (b[0] - a[0]) * t, y]);
        }
      }
      ends.push(b);
      for (let j = 0; j + 1 < ends.length; j++) {
        const s = shift(bandOf((ends[j][1] + ends[j + 1][1]) / 2));
        pts.push([ends[j][0] + s, ends[j][1]], [ends[j + 1][0] + s, ends[j + 1][1]]);
      }
    }
    return { points: pts };
  });
  const fixed = normalizeContours(mapped);
  return fixed.length ? fixed : mapped;
};

/**
 * Lean that grows quadratically with height, roughened by a deterministic gust.
 * The mean lean (k·w/3) is subtracted so the glyph stays centred: the base
 * drifts slightly against the wind while the top blows with it.
 */
export const wind: OutlineOp = (contours, p, ctx) => {
  const k = num(p.amount, -1, 1, 0.4), gust = num(p.gust, 0, 1, 0.3);
  const fr = frame(contours);
  if (!fr || k === 0) return contours;
  return warp(contours, ([x, y]) => {
    const t = (y - fr.minY) / fr.h;
    const n = gust ? ctx.rng.noise2(y / 80, 0) : 0;
    return [x + k * fr.w * (t * t - 1 / 3) * (1 + gust * n), y];
  });
};

/**
 * Progressive bend from left to right: the glyph's horizontal midline is bent
 * into a circular arc that turns `degrees` over the glyph width, anchored at
 * the left-middle point. Positive curls the right end up, negative down.
 * (A per-point rotation about the baseline folds anything taller than its
 * width at moderate angles; bending about the midline is fold-free until
 * |deg| > 2·w/h rad.)
 */
export const curl: OutlineOp = (contours, p) => {
  const deg = num(p.degrees, -180, 180, 40);
  const fr = frame(contours);
  if (!fr || deg === 0) return contours;
  const th = rad(deg), s = Math.sign(th), R = fr.w / Math.abs(th);
  return warp(contours, ([x, y]) => {
    const phi = (x - fr.minX) / R;
    const r = R - (y - fr.cy) * s;
    return [fr.minX + r * Math.sin(phi), fr.cy + s * (R - r * Math.cos(phi))];
  });
};

export const WARP_OPS: Record<string, OutlineOp> = { rotate, flip, perspective, twist, pinch, pull, wave, ripple, bulge, refraction, wind, curl };

export const WARP_DEFS: Record<string, { label: string; hint: string; params: FxParamDef[] }> = {
  rotate: { label: 'Rotate', hint: 'Turn the glyph about its centre.', params: [
    { key: 'degrees', label: 'Degrees', min: -180, max: 180, step: 1, default: 12 }] },
  flip: { label: 'Flip', hint: 'Mirror the glyph about its centre.', params: [
    { key: 'horizontal', label: 'Horizontal', min: 0, max: 1, step: 1, default: 1, hint: 'Mirror left/right' },
    { key: 'vertical', label: 'Vertical', min: 0, max: 1, step: 1, default: 0, hint: 'Mirror top/bottom' }] },
  perspective: { label: 'Perspective', hint: 'Keystone: wider at the top, narrower at the bottom (negative reverses).', params: [
    { key: 'amount', label: 'Amount', min: -1, max: 1, step: 0.01, default: 0.4 }] },
  twist: { label: 'Twist', hint: 'Rotate progressively with height: the top turns one way, the bottom the other.', params: [
    { key: 'degrees', label: 'Degrees', min: -180, max: 180, step: 1, default: 30 }] },
  pinch: { label: 'Pinch', hint: 'Squeeze the waist; negative bulges it.', params: [
    { key: 'amount', label: 'Amount', min: -1, max: 1, step: 0.01, default: 0.5 }] },
  pull: { label: 'Pull', hint: 'Vertical shear: lift the right side, drop the left.', params: [
    { key: 'amount', label: 'Amount', min: -1, max: 1, step: 0.01, default: 0.3 }] },
  wave: { label: 'Wave', hint: 'Sideways sine wave running up the glyph.', params: [
    { key: 'amount', label: 'Amount', min: 0, max: 120, step: 1, default: 30, hint: 'Displacement in font units' },
    { key: 'waves', label: 'Waves', min: 0.5, max: 4, step: 0.1, default: 1.5, hint: 'Cycles over the glyph height' }] },
  ripple: { label: 'Ripple', hint: 'Vertical sine wave running across the glyph.', params: [
    { key: 'amount', label: 'Amount', min: 0, max: 120, step: 1, default: 20, hint: 'Displacement in font units' },
    { key: 'waves', label: 'Waves', min: 0.5, max: 6, step: 0.1, default: 2, hint: 'Cycles over the glyph width' }] },
  bulge: { label: 'Bulge', hint: 'Radial lens: inflate the middle (negative sucks it in).', params: [
    { key: 'amount', label: 'Amount', min: -1, max: 1, step: 0.01, default: 0.4 }] },
  refraction: { label: 'Refraction', hint: 'Horizontal glass bands, alternately shifted left and right.', params: [
    { key: 'amount', label: 'Amount', min: 0, max: 120, step: 1, default: 24, hint: 'Shift per band in font units' },
    { key: 'bands', label: 'Bands', min: 2, max: 12, step: 1, default: 5 }] },
  wind: { label: 'Wind', hint: 'Lean that grows with height, roughened by a seeded gust.', params: [
    { key: 'amount', label: 'Amount', min: -1, max: 1, step: 0.01, default: 0.4, hint: 'Lean as a fraction of the glyph width' },
    { key: 'gust', label: 'Gust', min: 0, max: 1, step: 0.01, default: 0.3, hint: 'Noise on the lean' }] },
  curl: { label: 'Curl', hint: 'Bend the glyph progressively from left to right.', params: [
    { key: 'degrees', label: 'Degrees', min: -180, max: 180, step: 1, default: 40 }] },
};
