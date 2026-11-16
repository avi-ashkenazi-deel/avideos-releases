/**
 * Interface symbols (arrows, keyboard keys, ticks, geometric shapes). Same
 * conventions as the other recipes: local frame, baseline y = 0, y up, sizes
 * relative to cap height so they follow the user's metrics and stroke.
 * "Filled" shapes are an outline plus a hatch of thick bars kept inside it.
 */
import type { Stroke, Vec } from '../glyph';
import type { Recipe, RecipeCtx } from './common';
import { frame, param, rec } from './common';
import { arcPts, bar, diagonal, dot, joinPts, linePts, path, poly, polyPts, stem } from '../../generate/primitives';
import { clamp } from '../geometry';
import type { StrokeOpts } from '../../generate/primitives';

/** width factor for geometric shapes: the compose-time width param only, so circles stay round at heavy weights */
const shapeK = (c: RecipeCtx) => clamp(param(c, 'width', 1), 0.7, 1.4);

const lerp = (a: Vec, b: Vec, t: number): Vec => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/** closed outline through the given corners; the seam sits mid-edge with a short overlap */
function closed(c: RecipeCtx, pts: Vec[], opts?: StrokeOpts): Stroke {
  const m = lerp(pts[0], pts[1], 0.5);
  return path(c, joinPts(polyPts([m, ...pts.slice(1), pts[0], m]), linePts(m[0], m[1], ...lerp(m, pts[1], 0.3))), opts);
}

/** open chevron head with its tip at (x, y) pointing along (dx, dy), arms of length h */
function head(c: RecipeCtx, x: number, y: number, dx: number, dy: number, h: number, k: number): Stroke {
  const l = Math.hypot(dx, dy) || 1, ux = dx / l, uy = dy / l;
  const a = h * Math.SQRT1_2;
  const wing = (s: number): Vec => [x - (ux * a - s * uy * a) * k, y - (uy * a + s * ux * a)];
  return poly(c, [wing(1), [x, y], wing(-1)]);
}

/** shaft from (x0, y0) to the tip (x1, y1) plus a chevron head at the tip */
function arrow(c: RecipeCtx, x0: number, y0: number, x1: number, y1: number, h: number, k: number): Stroke[] {
  return [diagonal(c, x0, y0, x1, y1), head(c, x1, y1, x1 - x0, y1 - y0, h, k)];
}

/**
 * Solid convex shape: centreline polygon `pts` (with an incircle centred at
 * `ic`, radius `rIn`) as an outline, filled with thick round-capped strokes
 * whose centrelines stay on/inside the polygon inset by (bar half width - hw),
 * so nothing pokes past the silhouette: horizontal bars, plus a ring along the
 * inset edge that closes the scalloped gaps the bar ends leave near the edge.
 */
function filled(c: RecipeCtx, pts: Vec[], ic: Vec, rIn: number): Stroke[] {
  const f = frame(c);
  const ys = pts.map((p) => p[1]);
  const H = Math.max(...ys) - Math.min(...ys);
  const s = Math.min(Math.max(f.sw, H / 12), 2.4 * f.sw);
  const hb = Math.max(f.hw, s * 0.65);
  const sc = (rIn - (hb - f.hw)) / rIn;
  const out: Stroke[] = [closed(c, pts)];
  if (sc <= 0.02) return [...out, dot(c, ic[0], ic[1], rIn + f.hw)];
  const q = pts.map((p) => lerp(ic, p, sc));
  const qy = q.map((p) => p[1]);
  const y0 = Math.min(...qy) + 1e-3, y1 = Math.max(...qy) - 1e-3;
  const n = Math.max(1, Math.ceil((y1 - y0) / s));
  const thick = { widthMul: hb / f.hw, cap: 'round' as const };
  if (hb > f.hw) out.push(closed(c, q, thick));
  for (let i = 0; i <= n; i++) {
    const y = y0 + ((y1 - y0) * i) / n;
    const xs: number[] = [];
    q.forEach((a, j) => {
      const b = q[(j + 1) % q.length];
      if ((a[1] - y) * (b[1] - y) <= 0 && a[1] !== b[1]) xs.push(a[0] + ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]));
    });
    if (xs.length >= 2) out.push(bar(c, Math.min(...xs), Math.max(...xs), y, thick));
  }
  return out;
}

/** equilateral-ish triangle on the baseline, apex up or down */
function triangle(c: RecipeCtx, up: boolean): { pts: Vec[]; ic: Vec; rIn: number } {
  const f = frame(c);
  const W = f.cap * 0.82 * shapeK(c), H = f.cap * 0.72;
  const pts: Vec[] = up ? [[0, 0], [W, 0], [W / 2, H]] : [[0, H], [W / 2, 0], [W, H]];
  const side = Math.hypot(W / 2, H);
  const rIn = (W * H) / (W + 2 * side);
  return { pts, ic: [W / 2, up ? rIn : H - rIn], rIn };
}

function square(c: RecipeCtx): Vec[] {
  const f = frame(c);
  const S = f.cap * 0.7, Sx = S * shapeK(c);
  return [[0, 0], [Sx, 0], [Sx, S], [0, S]];
}

function ellipse(cx: number, cy: number, rx: number, ry: number): Vec[] {
  return arcPts(cx, cy, rx, ry, 90, 450).slice(0, -1);
}

export const ui: Record<string, Recipe> = {
  '←': rec('←', (c) => {
    const f = frame(c);
    const L = f.cap * 0.95 * f.k;
    return arrow(c, L, f.cap / 2, 0, f.cap / 2, f.cap * 0.42, f.k);
  }),

  '→': rec('→', (c) => {
    const f = frame(c);
    const L = f.cap * 0.95 * f.k;
    return arrow(c, 0, f.cap / 2, L, f.cap / 2, f.cap * 0.42, f.k);
  }),

  '↑': rec('↑', (c) => {
    const f = frame(c);
    return arrow(c, 0, 0, 0, f.cap, f.cap * 0.42, f.k);
  }),

  '↓': rec('↓', (c) => {
    const f = frame(c);
    return arrow(c, 0, f.cap, 0, 0, f.cap * 0.42, f.k);
  }),

  '↔': rec('↔', (c) => {
    const f = frame(c);
    const L = f.cap * 1.15 * f.k, y = f.cap / 2, h = f.cap * 0.4;
    return [bar(c, 0, L, y), head(c, 0, y, -1, 0, h, f.k), head(c, L, y, 1, 0, h, f.k)];
  }),

  '⇒': rec('⇒', (c) => {
    const f = frame(c);
    const L = f.cap * 0.95 * f.k, y = f.cap / 2;
    const g = Math.max(f.cap * 0.12, f.sw * 0.85);
    const h = (f.cap * 0.3 + g) * Math.SQRT2;
    const xe = L - g * f.k;
    return [bar(c, 0, xe, y + g), bar(c, 0, xe, y - g), head(c, L, y, 1, 0, h, f.k)];
  }),

  '✓': rec('✓', (c) => {
    const f = frame(c);
    const W = f.cap * 0.78 * f.k;
    return [poly(c, [[0, f.cap * 0.42], [W * 0.36, f.cap * 0.06], [W, f.cap * 0.86]])];
  }),

  '✗': rec('✗', (c) => {
    const f = frame(c);
    const W = f.cap * 0.68 * f.k, y0 = f.cap * 0.1, y1 = f.cap * 0.84;
    return [diagonal(c, 0, y1, W, y0), diagonal(c, W * 0.06, y0 + f.cap * 0.02, W * 0.94, y1 + f.cap * 0.04)];
  }),

  '★': rec('★', (c) => {
    const f = frame(c);
    const R = f.cap / (1 + Math.sin(54 * Math.PI / 180)), r = R * 0.45;
    const cy = f.cap - R, k = shapeK(c);
    const pts: Vec[] = [];
    for (let i = 0; i < 10; i++) {
      const a = (90 + i * 36) * Math.PI / 180, rr = i % 2 ? r : R;
      pts.push([rr * Math.cos(a) * k, cy + rr * Math.sin(a)]);
    }
    return [closed(c, pts)];
  }),

  '♥': rec('♥', (c) => {
    const f = frame(c);
    const s = (f.cap * 0.86) / 30, k = shapeK(c);
    const pts: Vec[] = [];
    for (let i = 0; i <= 96; i++) {
      const t = (i / 96) * Math.PI * 2;
      const x = 16 * Math.sin(t) ** 3;
      const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
      pts.push([x * s * k, (y + 17) * s]);
    }
    return [path(c, joinPts(polyPts(pts), polyPts(pts.slice(0, 3))))];
  }),

  '⚠': rec('⚠', (c) => {
    const f = frame(c);
    const W = f.cap * 1.0 * f.k, H = f.cap * 0.92;
    // the "!" thins and stacks from the inner edge of the base so it stays clear at heavy weights
    const m = clamp((f.cap * 0.075) / f.hw, 0.5, 0.9);
    const dr = f.hw * m * 1.05, gap = Math.max(f.cap * 0.05, dr * 0.6);
    const yd = f.hw + gap + dr, ys0 = yd + dr + gap + f.hw * m;
    return [
      closed(c, [[0, 0], [W, 0], [W / 2, H]]),
      stem(c, W / 2, ys0, Math.max(ys0 + f.cap * 0.1, H * 0.6), { widthMul: m }),
      dot(c, W / 2, yd, dr),
    ];
  }),

  '●': rec('●', (c) => {
    const f = frame(c);
    const R = f.cap * 0.4, k = shapeK(c);
    return filled(c, ellipse(R * k, R, R * k, R), [R * k, R], R * Math.min(1, k));
  }),

  '○': rec('○', (c) => {
    const f = frame(c);
    const R = f.cap * 0.4, k = shapeK(c);
    return [closed(c, ellipse(R * k, R, R * k, R))];
  }),

  '■': rec('■', (c) => {
    const p = square(c);
    const S = p[2][1], Sx = p[2][0];
    return filled(c, p, [Sx / 2, S / 2], Math.min(S, Sx) / 2);
  }),

  '□': rec('□', (c) => [closed(c, square(c))]),

  '▲': rec('▲', (c) => {
    const t = triangle(c, true);
    return filled(c, t.pts, t.ic, t.rIn);
  }),

  '▼': rec('▼', (c) => {
    const t = triangle(c, false);
    return filled(c, t.pts, t.ic, t.rIn);
  }),

  '⌘': rec('⌘', (c) => {
    const f = frame(c);
    const a = f.cap * 0.18, r = f.cap * 0.16, e = a + r, cy = f.cap / 2;
    const o = { widthMul: 0.85 };
    const out: Stroke[] = [
      bar(c, -e * f.k, e * f.k, cy + a, o), bar(c, -e * f.k, e * f.k, cy - a, o),
      stem(c, -a * f.k, cy - e, cy + e, o), stem(c, a * f.k, cy - e, cy + e, o),
    ];
    for (const [sx, sy] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
      // 270° loop joining the two extended sides past this corner
      const a0 = sx > 0 ? (sy > 0 ? 180 : 90) : (sy > 0 ? 270 : 0);
      out.push(path(c, arcPts(sx * e * f.k, cy + sy * e, r * f.k, r, a0, a0 - 270), o));
    }
    return out;
  }),

  '⌥': rec('⌥', (c) => {
    const f = frame(c);
    const W = f.cap * 0.95 * f.k, top = f.cap * 0.8, bot = f.cap * 0.2;
    return [
      poly(c, [[0, top], [W * 0.3, top], [W * 0.7, bot], [W, bot]]),
      bar(c, W * 0.62, W, top),
    ];
  }),

  '⇧': rec('⇧', (c) => {
    const f = frame(c);
    const W = f.cap * 0.86 * f.k, yb = f.cap * 0.46;
    const x1 = W * 0.29, x2 = W * 0.71;
    return [closed(c, [[x1, 0], [x2, 0], [x2, yb], [W, yb], [W / 2, f.cap], [0, yb], [x1, yb]])];
  }),

  '⏎': rec('⏎', (c) => {
    const f = frame(c);
    const W = f.cap * 0.9 * f.k, y = f.cap * 0.32;
    return [
      poly(c, [[W, f.cap * 0.88], [W, y], [0, y]]),
      head(c, 0, y, -1, 0, f.cap * 0.36, f.k),
    ];
  }),

  '⌫': rec('⌫', (c) => {
    const f = frame(c);
    const bot = f.cap * 0.1, top = f.cap * 0.9, cy = (top + bot) / 2;
    const x1 = (top - bot) * 0.45 * f.k, W = f.cap * 1.12 * f.k;
    const xc = (x1 + W) / 2 + f.cap * 0.03 * f.k, s = f.cap * 0.14, o = { widthMul: 0.85 };
    return [
      closed(c, [[0, cy], [x1, top], [W, top], [W, bot], [x1, bot]]),
      diagonal(c, xc - s * f.k, cy - s, xc + s * f.k, cy + s, o),
      diagonal(c, xc - s * f.k, cy + s, xc + s * f.k, cy - s, o),
    ];
  }),
};
