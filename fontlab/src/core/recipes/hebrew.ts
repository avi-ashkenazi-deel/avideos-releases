/**
 * Hebrew א-ת skeletons (22 letters + the five final forms). Hebrew runs
 * right-to-left but every glyph is just a shape, so each recipe is built in
 * the same local frame as Latin: x = 0 is the leftmost centreline, baseline
 * y = 0, y up. `finish()` adds sidebearings / advance.
 *
 * Square-style skeletons are top-heavy: the horizontal "roof" is the dominant
 * stroke and the verticals hang from it. Body height H = 0.78 * cap (Hebrew
 * has no case); ל rises to the ascender; the finals ך ן ף ץ and ק descend to
 * ~0.8 * desc.
 */
import type { Recipe, RecipeCtx } from './common';
import { frame, rec } from './common';
import type { Vec } from '../glyph';
import {
  arcPts, bar, curve, diagonal, joinPts, linePts, path, poly, stem,
} from '../../generate/primitives';

const DEG = Math.PI / 180;

function sizes(ctx: RecipeCtx) {
  const f = frame(ctx);
  const H = f.cap * 0.78;            // body height (top of the roofs)
  return {
    f,
    H,
    D: f.desc * 0.8,                 // descender of the finals / ק
    W: f.cap * 0.62 * f.k,           // typical body width
    Ww: f.cap * 0.75 * f.k,          // wide letters (ש ם מ ת)
    rs: H * 0.3,                     // round shoulder radius (כ ר ל)
    rc: H * 0.12,                    // slightly softened square corner (ה ח ם)
  };
}

/**
 * Angle (deg) of the tangent point from (ax, ay) onto the circle (cx, cy, r).
 * side = +1: the stroke continues counter-clockwise (increasing angle) from
 * the tangent point, -1: clockwise.
 */
function tangentAngle(ax: number, ay: number, cx: number, cy: number, r: number, side: 1 | -1): number {
  const d = Math.max(r, Math.hypot(ax - cx, ay - cy));
  const beta = Math.atan2(ay - cy, ax - cx) / DEG;
  const gamma = Math.acos(r / d) / DEG;
  return beta + side * gamma;
}

/** Straight run from (ax, ay) that bends tangentially round the circle (cx, cy, r) on to angle a1. */
function bend(ax: number, ay: number, cx: number, cy: number, r: number, a1: number, side: 1 | -1): { pts: Vec[]; tx: number; ty: number } {
  const a0 = tangentAngle(ax, ay, cx, cy, r, side);
  const tx = cx + r * Math.cos(a0 * DEG), ty = cy + r * Math.sin(a0 * DEG);
  return { pts: joinPts(linePts(ax, ay, tx, ty), arcPts(cx, cy, r, r, a0, a1)), tx, ty };
}

/** Roof from x0 to the right stem at xs with a rounded top-right shoulder, then down to yFoot. */
function roofStem(x0: number, xs: number, H: number, r: number, yFoot: number): Vec[] {
  return joinPts(
    linePts(x0, H, xs - r, H),
    arcPts(xs - r, H - r, r, r, 90, 0),
    linePts(xs, H - r, xs, yFoot),
  );
}

/** Rounded bottom-right corner: down the stem at xs to the base, base running left to x1. */
function stemBase(xs: number, yTop: number, r: number, x1: number, yBase = 0): Vec[] {
  return joinPts(
    linePts(xs, yTop, xs, yBase + r),
    arcPts(xs - r, yBase + r, r, r, 0, -90),
    linePts(xs - r, yBase, x1, yBase),
  );
}

export const hebrew: Record<string, Recipe> = {
  // alef: "\" diagonal, a short arm hanging from the top-right onto it and a
  // short leg dropping from it to the bottom-left (the two parallel strokes).
  'א': rec('א', (c) => {
    const { H, W } = sizes(c);
    const ax = W * 0.1, bx = W * 0.97;
    const at = (t: number): Vec => [ax + (bx - ax) * t, H * (1 - t)];
    const [jx, jy] = at(0.6);
    const [lx, ly] = at(0.4);
    return [
      diagonal(c, ax, H, bx, 0),
      curve(c, [[W, H], [W * 0.95, H * 0.74], [jx, jy]]),
      diagonal(c, lx, ly, 0, 0),
    ];
  }),

  // bet: roof + right stem, base bar extending left past the roof and right
  // past the stem (the heel is what separates it from כ).
  'ב': rec('ב', (c) => {
    const { H, W } = sizes(c);
    const xs = W * 0.86;
    const r = H * 0.2;
    return [
      path(c, roofStem(W * 0.14, xs, H, r, 0)),
      bar(c, 0, W, 0),
    ];
  }),

  // gimel: leaning stem with a small head, foot kicking down-left.
  'ג': rec('ג', (c) => {
    const { H, W } = sizes(c);
    const Wg = W * 0.66;
    const xt = Wg * 0.84, xb = Wg * 0.66;
    const yf = H * 0.36;
    const xf = xb + (xt - xb) * (yf / H);
    return [
      poly(c, [[Wg * 0.42, H], [xt, H], [xb, 0]]),
      diagonal(c, xf, yf, 0, 0),
    ];
  }),

  // dalet: long roof, stem hanging from it with the roof overhanging on the right.
  'ד': rec('ד', (c) => {
    const { H, W } = sizes(c);
    return [bar(c, 0, W, H), stem(c, W * 0.8, H, 0)];
  }),

  // he: roof + right stem, detached left stem with a gap under the roof.
  'ה': rec('ה', (c) => {
    const { H, W, rc } = sizes(c);
    return [
      path(c, roofStem(0, W, H, rc, 0)),
      stem(c, 0, 0, H * 0.66),
    ];
  }),

  // vav: stem with a small head nub to the left.
  'ו': rec('ו', (c) => {
    const { f, H } = sizes(c);
    const Wv = f.cap * 0.22 * f.k;
    return [path(c, roofStem(0, Wv, H, Wv * 0.6, 0))];
  }),

  // zayin: narrow roof centred over a slightly leaning stem.
  'ז': rec('ז', (c) => {
    const { f, H } = sizes(c);
    const Wz = f.cap * 0.3 * f.k;
    return [bar(c, 0, Wz, H), diagonal(c, Wz * 0.58, H, Wz * 0.46, 0)];
  }),

  // chet: roof + two stems (П).
  'ח': rec('ח', (c) => {
    const { H, W, rc } = sizes(c);
    return [path(c, joinPts(
      linePts(0, 0, 0, H - rc),
      arcPts(rc, H - rc, rc, rc, 180, 90),
      roofStem(rc, W, H, rc, 0),
    ))];
  }),

  // tet: left stem into a round cup, right side rising and curling inward at the top.
  'ט': rec('ט', (c) => {
    const { f, H, W } = sizes(c);
    const ry = H * 0.42;
    const r = W * 0.3;
    return [path(c, joinPts(
      linePts(0, H, 0, ry),
      arcPts(W / 2, ry, W / 2, ry + f.o, 180, 360),
      linePts(W, ry, W, H - r),
      arcPts(W - r, H - r, r, r, 0, 165),
    ))];
  }),

  // yod: a short vav hanging from the body height.
  'י': rec('י', (c) => {
    const { f, H } = sizes(c);
    const Wy = f.cap * 0.2 * f.k;
    return [path(c, roofStem(0, Wy, H, Wy * 0.6, H * 0.6))];
  }),

  // kaf: roof, rounded right side, base — a C open to the left.
  'כ': rec('כ', (c) => {
    const { H, W, rs } = sizes(c);
    return [path(c, joinPts(roofStem(0, W, H, rs, rs), stemBase(W, rs, rs, 0)))];
  }),

  // final kaf: roof + stem descending below the baseline.
  'ך': rec('ך', (c) => {
    const { f, H, D } = sizes(c);
    const Wk = f.cap * 0.35 * f.k;
    return [path(c, roofStem(0, Wk, H, Wk * 0.5, D))];
  }),

  // lamed: flag at the ascender, neck down onto the roof, body rounding down
  // into a base that runs left and turns up in a short tail.
  'ל': rec('ל', (c) => {
    const { f, H, W, rs } = sizes(c);
    const xn = W * 0.3;
    const rt = H * 0.12;
    const xe = W * 0.3;
    return [
      poly(c, [[0, f.asc], [xn * 0.7, f.asc], [xn, H]]),
      path(c, joinPts(
        roofStem(xn, W, H, rs, rs),
        stemBase(W, rs, rs, xe),
        arcPts(xe, rt, rt, rt, 270, 180),
      )),
    ];
  }),

  // final mem: closed square.
  'ם': rec('ם', (c) => {
    const { H, Ww, rc } = sizes(c);
    return [path(c, joinPts(
      linePts(0, 0, 0, H - rc),
      arcPts(rc, H - rc, rc, rc, 180, 90),
      roofStem(rc, Ww, H, rc, 0),
      linePts(Ww, 0, 0, 0),
      linePts(0, 0, 0, rc * 0.5),
    ))];
  }),

  // mem: roof + right stem + base stopping short of the left, a leaning left
  // stroke hanging from the roof's left end leaves the bottom-left open.
  'מ': rec('מ', (c) => {
    const { H, Ww, rc } = sizes(c);
    const xl = Ww * 0.22;
    return [
      path(c, joinPts(roofStem(Ww * 0.06, Ww, H, rc, 0), linePts(Ww, 0, Ww * 0.4, 0))),
      curve(c, [[xl, H], [xl * 0.98, H * 0.62], [xl * 0.55, H * 0.2], [0, 0]]),
    ];
  }),

  // final nun: long stem from the body height to below the baseline, small head.
  'ן': rec('ן', (c) => {
    const { f, H, D } = sizes(c);
    const Wv = f.cap * 0.22 * f.k;
    return [path(c, roofStem(0, Wv, H, Wv * 0.6, D))];
  }),

  // nun: a narrow kaf — small head, stem rounding into a short base to the left.
  'נ': rec('נ', (c) => {
    const { f, H } = sizes(c);
    const Wn = f.cap * 0.42 * f.k;
    const rh = Wn * 0.3;
    const rb = Math.min(Wn * 0.55, H * 0.3);
    return [path(c, joinPts(roofStem(Wn * 0.42, Wn, H, rh, rb), stemBase(Wn, rb, rb, 0)))];
  }),

  // samekh: closed, flat roof, round bottom.
  'ס': rec('ס', (c) => {
    const { f, H, W } = sizes(c);
    const rt = W * 0.22;
    const ry = H * 0.42;
    return [path(c, joinPts(
      roofStem(rt, W, H, rt, ry),
      arcPts(W / 2, ry, W / 2, ry + f.o, 0, -180),
      linePts(0, ry, 0, H - rt),
      arcPts(rt, H - rt, rt, rt, 180, 90),
      linePts(rt, H, rt + rt * 0.3, H),
    ))];
  }),

  // ayin: long right stroke sweeping down-left into a flat foot, shorter left
  // arm joining it near the bottom-left.
  'ע': rec('ע', (c) => {
    const { H, W } = sizes(c);
    const r = H * 0.22;
    const b = bend(W, H, r, r, r, 270, 1);
    const jy = H * 0.34;
    const t = (H - jy) / (H - b.ty);
    const jx = W + (b.tx - W) * t;
    return [
      path(c, joinPts(b.pts, linePts(r, 0, W * 0.58, 0))),
      curve(c, [[W * 0.03, H], [W * 0.08, H * 0.66], [jx, jy]]),
    ];
  }),

  // final pe: roof whose left end drops into an inward curl, stem descending.
  'ף': rec('ף', (c) => {
    const { H, W, D, rs } = sizes(c);
    const cx = W * 0.27, cy = H * 0.68, rx = W * 0.27, ry = H * 0.32;
    return [path(c, joinPts(
      arcPts(cx, cy, rx, ry, 345, 180),
      linePts(0, cy, 0, H),
      roofStem(0, W, H, rs, D),
    ))];
  }),

  // pe: like ף but closing with a base along the baseline.
  'פ': rec('פ', (c) => {
    const { H, W, rs } = sizes(c);
    const cx = W * 0.27, cy = H * 0.68, rx = W * 0.27, ry = H * 0.32;
    return [path(c, joinPts(
      arcPts(cx, cy, rx, ry, 345, 180),
      linePts(0, cy, 0, H),
      roofStem(0, W, H, rs, rs),
      stemBase(W, rs, rs, 0),
    ))];
  }),

  // final tsadi: leaning right stem from the roof line down past the baseline,
  // left arm curving in to join it at mid height.
  'ץ': rec('ץ', (c) => {
    const { H, D, W } = sizes(c);
    const Wt = W * 0.8;
    const xt = Wt, xb = Wt * 0.8;
    const jy = H * 0.44;
    const jx = xb + (xt - xb) * ((jy - D) / (H - D));
    return [
      diagonal(c, xt, H, xb, D),
      curve(c, [[0, H], [Wt * 0.07, H * 0.7], [Wt * 0.5, jy * 1.06], [jx, jy]]),
    ];
  }),

  // tsadi: leaning right stem bending into a base that runs left, left arm
  // curving in to join it at mid height.
  'צ': rec('צ', (c) => {
    const { H, W } = sizes(c);
    const r = H * 0.2;
    const b = bend(W, H, W * 0.62, r, r, -90, -1);
    const jy = H * 0.44;
    const t = (H - jy) / (H - b.ty);
    const jx = W + (b.tx - W) * t;
    return [
      path(c, joinPts(b.pts, linePts(W * 0.62, 0, 0, 0))),
      curve(c, [[W * 0.02, H], [W * 0.09, H * 0.7], [W * 0.55, jy * 1.06], [jx, jy]]),
    ];
  }),

  // qof: resh-like top whose right side hooks inward above the baseline, and a
  // detached left leg hanging from under the roof down past the baseline.
  'ק': rec('ק', (c) => {
    const { H, D, W, rs } = sizes(c);
    const yb = H * 0.3;
    const rb = W * 0.24;
    return [
      path(c, joinPts(roofStem(W * 0.2, W, H, rs, yb + rb), stemBase(W, yb + rb, rb, W * 0.55, yb))),
      stem(c, 0, H * 0.78, D),
    ];
  }),

  // resh: roof rounding into the right stem, nothing else.
  'ר': rec('ר', (c) => {
    const { H, W, rs } = sizes(c);
    return [path(c, roofStem(0, W * 0.88, H, rs, 0))];
  }),

  // shin: left arm leaning into a flat base that rounds up into the right arm,
  // middle arm leaning down into the base near the left.
  'ש': rec('ש', (c) => {
    const { H, Ww } = sizes(c);
    const rl = H * 0.22, rb = H * 0.3;
    const cxl = Ww * 0.36;
    const left = bend(0, H, cxl, rl, rl, 270, 1);
    return [
      path(c, joinPts(
        left.pts,
        linePts(cxl, 0, Ww - rb, 0),
        arcPts(Ww - rb, rb, rb, rb, 270, 360),
        linePts(Ww, rb, Ww, H),
      )),
      diagonal(c, Ww * 0.52, H, Ww * 0.3, 0),
    ];
  }),

  // tav: roof + two stems, the left one kicking out a foot to the left.
  'ת': rec('ת', (c) => {
    const { H, Ww } = sizes(c);
    const r = H * 0.25;
    const xl = Ww * 0.2;
    return [path(c, joinPts(
      linePts(0, 0, xl, 0),
      linePts(xl, 0, xl, H),
      roofStem(xl, Ww, H, r, 0),
    ))];
  }),
};
