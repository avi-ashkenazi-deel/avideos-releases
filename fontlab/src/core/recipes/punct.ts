/**
 * Punctuation skeletons. Same conventions as upper / lower / digits: local
 * frame with x = 0 at the leftmost centreline (finish() re-shifts anyway),
 * baseline y = 0, y up. Dots are single-point strokes with radius f.hw so a
 * period matches the stroke weight of the letters.
 */
import type { Stroke, Vec } from '../glyph';
import type { Recipe, RecipeCtx } from './common';
import { frame, rec } from './common';
import type { Frame } from './common';
import {
  STEP, arc, arcPts, bar, bowl, curve, curvePts, diagonal, dot, joinPts, line, linePts, path, poly, stem,
} from '../../generate/primitives';

const DEG = Math.PI / 180;

/* ------------------------------------------------------------------ */
/* stroke-array transforms (shared with symbols.ts)                     */
/* ------------------------------------------------------------------ */

export function rotate180(strokes: Stroke[], cx: number, cy: number): Stroke[] {
  return strokes.map((s) => ({ ...s, points: s.points.map((p) => ({ ...p, x: 2 * cx - p.x, y: 2 * cy - p.y })) }));
}

/** mirror horizontally about x = cx (finish() normalises the origin again) */
export function mirrorX(strokes: Stroke[], cx = 0): Stroke[] {
  return strokes.map((s) => ({ ...s, points: s.points.map((p) => ({ ...p, x: 2 * cx - p.x })) }));
}

export function translate(strokes: Stroke[], dx: number, dy: number): Stroke[] {
  return strokes.map((s) => ({ ...s, points: s.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })) }));
}

/* ------------------------------------------------------------------ */
/* shared pieces                                                        */
/* ------------------------------------------------------------------ */

/** comma tail length */
const tailLen = (f: Frame) => f.xh * 0.22;

/** comma: dot at (x, yDot) + short tail curling down-left */
function commaAt(c: RecipeCtx, x: number, yDot: number): Stroke[] {
  const f = frame(c);
  const L = tailLen(f);
  return [
    dot(c, x, yDot, f.hw),
    path(c, arcPts(x - L, yDot, L, L, 0, -60), { widthMul: 0.85 }),
  ];
}

/** opening curled quote (a comma rotated 180°) with its top at cap height */
function openQuoteAt(c: RecipeCtx, x: number): Stroke[] {
  const f = frame(c);
  const L = tailLen(f);
  return translate(rotate180(commaAt(c, 0, 0), 0, 0), x, f.cap - Math.sin(60 * DEG) * L);
}

/** closing curled quote: comma hanging from cap height */
function closeQuoteAt(c: RecipeCtx, x: number): Stroke[] {
  const f = frame(c);
  return commaAt(c, x, f.cap - f.hw);
}

/** quote gap for the doubles */
const quoteGap = (f: Frame) => f.xh * 0.28 * f.k;

function bang(c: RecipeCtx): Stroke[] {
  const f = frame(c);
  return [stem(c, 0, f.cap, f.cap * 0.3), dot(c, 0, f.hw, f.hw)];
}

/** ? geometry; returns strokes plus the x of the arc centre (rotation pivot for ¿) */
function question(c: RecipeCtx): { strokes: Stroke[]; cx: number } {
  const f = frame(c);
  const rx = f.cap * 0.2 * f.k, ry = f.cap * 0.2;
  const cx = rx, cy = f.cap - ry;
  const a1 = -50;
  const ex = cx + rx * Math.cos(a1 * DEG), ey = cy + ry * Math.sin(a1 * DEG);
  const yb = f.cap * 0.3;
  const strokes = [
    path(c, joinPts(
      arcPts(cx, cy, rx, ry + f.o / 2, 200, a1),
      curvePts([[ex, ey], [cx + rx * 0.35, cy - ry * 1.45], [cx, cy - ry * 1.9], [cx, yb]]),
    )),
    dot(c, cx, f.hw, f.hw),
  ];
  return { strokes, cx };
}

function paren(c: RecipeCtx): Stroke[] {
  const f = frame(c);
  const cy = (f.asc + f.desc) / 2;
  const a0 = 115;
  const ry = (f.asc - f.desc) / 2 / Math.sin(a0 * DEG);
  const rx = f.cap * 0.31 * f.k;
  return [arc(c, rx, cy, rx, ry, a0, 360 - a0)];
}

function bracket(c: RecipeCtx): Stroke[] {
  const f = frame(c);
  const w = f.cap * 0.2 * f.k;
  return [poly(c, [[w, f.asc], [0, f.asc], [0, f.desc], [w, f.desc]])];
}

function brace(c: RecipeCtx): Stroke[] {
  const f = frame(c);
  const r = f.cap * 0.12 * f.k, ry = f.cap * 0.12;
  const mid = (f.asc + f.desc) / 2;
  const w = 2 * r;
  return [path(c, joinPts(
    arcPts(w, f.asc - ry, r, ry, 90, 180),
    linePts(r, f.asc - ry, r, mid + ry),
    arcPts(0, mid + ry, r, ry, 0, -90),
    arcPts(0, mid - ry, r, ry, 90, 0),
    linePts(r, mid - ry, r, f.desc + ry),
    arcPts(w, f.desc + ry, r, ry, 180, 270),
  ))];
}

function chevronPair(c: RecipeCtx): Stroke[] {
  const f = frame(c);
  const a = f.xh * 0.2 * f.k, h = f.xh * 0.2;
  const mid = f.xh * 0.5;
  const d = f.xh * 0.26 * f.k;
  return [
    poly(c, [[a, mid + h], [0, mid], [a, mid - h]]),
    poly(c, [[a + d, mid + h], [d, mid], [a + d, mid - h]]),
  ];
}

function angleBracket(c: RecipeCtx): Stroke[] {
  const f = frame(c);
  const h = f.cap * 0.3, w = f.cap * 0.3 * f.k;
  const mid = f.xh * 0.5;
  return [poly(c, [[w, mid + h], [0, mid], [w, mid - h]])];
}

/** spiral of the @: angle a0 going clockwise `sweep` degrees, radius easing from r0 to r1 over the first `grow` degrees */
function spiralPts(cx: number, cy: number, r0x: number, r0y: number, r1x: number, r1y: number, a0: number, sweep: number, grow: number): Vec[] {
  const n = Math.max(8, Math.ceil((sweep * DEG * (r1x + r1y)) / 2 / STEP));
  const out: Vec[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = (a0 - sweep * t) * DEG;
    const g = Math.min(1, (sweep * t) / grow);
    const e = g * g * (3 - 2 * g);
    const rx = r0x + (r1x - r0x) * e, ry = r0y + (r1y - r0y) * e;
    out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return out;
}

function dash(c: RecipeCtx, len: number): Stroke[] {
  const f = frame(c);
  return [bar(c, 0, len, f.xh * 0.5)];
}

/* ------------------------------------------------------------------ */
/* recipes                                                              */
/* ------------------------------------------------------------------ */

export const punct: Record<string, Recipe> = {
  '.': rec('.', (c) => {
    const f = frame(c);
    return [dot(c, 0, f.hw, f.hw)];
  }),

  ',': rec(',', (c) => {
    const f = frame(c);
    return commaAt(c, 0, f.hw);
  }),

  ';': rec(';', (c) => {
    const f = frame(c);
    return [dot(c, 0, f.xh - f.hw, f.hw), ...commaAt(c, 0, f.hw)];
  }),

  ':': rec(':', (c) => {
    const f = frame(c);
    return [dot(c, 0, f.hw, f.hw), dot(c, 0, f.xh - f.hw, f.hw)];
  }),

  '!': rec('!', (c) => bang(c)),

  '?': rec('?', (c) => question(c).strokes),

  '¡': rec('¡', (c) => {
    const f = frame(c);
    return rotate180(bang(c), 0, f.xh / 2);
  }),

  '¿': rec('¿', (c) => {
    const f = frame(c);
    const q = question(c);
    return rotate180(q.strokes, q.cx, f.xh / 2);
  }),

  "'": rec("'", (c) => {
    const f = frame(c);
    return [stem(c, 0, f.cap, f.cap - f.xh * 0.28)];
  }),

  '"': rec('"', (c) => {
    const f = frame(c);
    const g = quoteGap(f);
    return [stem(c, 0, f.cap, f.cap - f.xh * 0.28), stem(c, g, f.cap, f.cap - f.xh * 0.28)];
  }),

  '‘': rec('‘', (c) => openQuoteAt(c, 0)),

  '’': rec('’', (c) => closeQuoteAt(c, 0)),

  '“': rec('“', (c) => {
    const f = frame(c);
    return [...openQuoteAt(c, 0), ...openQuoteAt(c, quoteGap(f))];
  }),

  '”': rec('”', (c) => {
    const f = frame(c);
    return [...closeQuoteAt(c, 0), ...closeQuoteAt(c, quoteGap(f))];
  }),

  '«': rec('«', (c) => chevronPair(c)),

  '»': rec('»', (c) => mirrorX(chevronPair(c))),

  '-': rec('-', (c) => dash(c, frame(c).cap * 0.33 * frame(c).k)),

  '–': rec('–', (c) => dash(c, frame(c).cap * 0.5 * frame(c).k)),

  '—': rec('—', (c) => dash(c, frame(c).cap * 1.0 * frame(c).k)),

  '_': rec('_', (c) => {
    const f = frame(c);
    return [bar(c, 0, f.cap * 0.5 * f.k, -f.hw * 2)];
  }),

  '(': rec('(', (c) => paren(c)),

  ')': rec(')', (c) => mirrorX(paren(c))),

  '[': rec('[', (c) => bracket(c)),

  ']': rec(']', (c) => mirrorX(bracket(c))),

  '{': rec('{', (c) => brace(c)),

  '}': rec('}', (c) => mirrorX(brace(c))),

  '/': rec('/', (c) => {
    const f = frame(c);
    return [diagonal(c, 0, f.desc, f.cap * 0.4 * f.k, f.asc)];
  }),

  '\\': rec('\\', (c) => {
    const f = frame(c);
    return [diagonal(c, 0, f.asc, f.cap * 0.4 * f.k, f.desc)];
  }),

  '|': rec('|', (c) => {
    const f = frame(c);
    return [stem(c, 0, f.desc, f.asc)];
  }),

  '@': rec('@', (c) => {
    const f = frame(c);
    const R = f.cap * 0.48, Rx = R * f.k;
    const cx = Rx, cy = f.cap * 0.5;
    const ri = f.cap * 0.19, rix = ri * 0.85 * f.k;
    const r0 = ri * 1.3;
    const a0 = -50;
    return [
      bowl(c, cx, cy, rix, ri, { widthMul: 0.85 }),
      path(c, joinPts(
        linePts(cx + rix, cy + ri * 0.95, cx + rix, cy - ri),
        spiralPts(cx, cy, r0 * f.k, r0, Rx, R + f.o, a0, 315, 110),
      )),
    ];
  }),

  '#': rec('#', (c) => {
    const f = frame(c);
    const W = f.cap * 0.55 * f.k;
    const sl = W * 0.1;
    const y0 = f.cap * 0.08, y1 = f.cap * 0.97;
    return [
      bar(c, 0, W, f.cap * 0.35),
      bar(c, 0, W, f.cap * 0.7),
      diagonal(c, W * 0.3 - sl, y0, W * 0.3 + sl, y1),
      diagonal(c, W * 0.62 - sl, y0, W * 0.62 + sl, y1),
    ];
  }),

  '&': rec('&', (c) => {
    const f = frame(c);
    // one continuous hand-drawn stroke: diagonal leg up into the small upper
    // loop, back down-left around the big lower loop, out into the tail
    const W = f.cap * 0.62 * f.k, H = f.cap;
    return [curve(c, [
      [W, 0],
      [W * 0.6, H * 0.43],
      [W * 0.24, H * 0.85],
      [W * 0.38, H],
      [W * 0.54, H * 0.86],
      [W * 0.48, H * 0.66],
      [W * 0.08, H * 0.36],
      [W * 0.1, H * 0.1],
      [W * 0.42, -f.o],
      [W * 0.78, H * 0.08],
      [W * 0.98, H * 0.3],
      [W * 1.02, H * 0.36],
    ])];
  }),

  '*': rec('*', (c) => {
    const f = frame(c);
    const cy = f.cap * 0.75, r = f.cap * 0.22;
    return [90, 30, 150].map((a) => {
      const dx = r * f.k * Math.cos(a * DEG), dy = r * Math.sin(a * DEG);
      return line(c, dx, cy + dy, -dx, cy - dy);
    });
  }),

  '+': rec('+', (c) => {
    const f = frame(c);
    const a = f.cap * 0.3, mid = f.xh * 0.5;
    return [bar(c, -a * f.k, a * f.k, mid), stem(c, 0, mid - a, mid + a)];
  }),

  '=': rec('=', (c) => {
    const f = frame(c);
    const W = f.cap * 0.5 * f.k;
    return [bar(c, 0, W, f.xh * 0.42), bar(c, 0, W, f.xh * 0.72)];
  }),

  '<': rec('<', (c) => angleBracket(c)),

  '>': rec('>', (c) => mirrorX(angleBracket(c))),

  '~': rec('~', (c) => {
    const f = frame(c);
    const W = f.cap * 0.5 * f.k, A = f.cap * 0.08, mid = f.xh * 0.5;
    const n = Math.max(8, Math.ceil(W / STEP));
    const pts: Vec[] = [];
    for (let i = 0; i <= n; i++) {
      const x = (W * i) / n;
      pts.push([x, mid + A * Math.sin((2 * Math.PI * x) / W)]);
    }
    return [path(c, pts)];
  }),

  '^': rec('^', (c) => {
    const f = frame(c);
    const w = f.cap * 0.34 * f.k, h = f.cap * 0.2;
    return [poly(c, [[0, f.cap - h], [w / 2, f.cap], [w, f.cap - h]])];
  }),

  '%': rec('%', (c) => {
    const f = frame(c);
    const W = f.cap * 0.62 * f.k;
    const rb = f.cap * 0.14, rbx = rb * f.k;
    return [
      bowl(c, rbx, f.cap - rb, rbx, rb + f.o / 2),
      diagonal(c, W * 0.2, 0, W * 0.8, f.cap),
      bowl(c, W - rbx, rb, rbx, rb + f.o / 2),
    ];
  }),
};
