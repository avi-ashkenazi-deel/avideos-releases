/**
 * Lowercase a-z skeletons (single-storey a and g, monoline sans / handwritten
 * hybrid). Local frame: x = 0 is the leftmost centreline, baseline y = 0,
 * x-height / ascender / descender from stats. `finish()` adds sidebearings.
 */
import type { Recipe, RecipeCtx } from './common';
import { frame, rec } from './common';
import {
  arc, arcPts, arch, bar, bowl, cup, curve, diagonal, dot, joinPts, linePts, path, poly, stem,
} from '../../generate/primitives';

function sizes(ctx: RecipeCtx) {
  const f = frame(ctx);
  const n = f.xh * 0.56 * f.k;       // stem-to-stem width of n / h / u
  const r = f.xh * 0.3 * f.k;        // rx of o-like bowls
  const ry = f.xh / 2 + f.o;         // ry of x-height bowls
  const ra = f.xh * 0.3;             // arch vertical radius
  const dotR = Math.max(f.hw * 1.05, 6);
  const dotY = Math.min(f.asc, f.xh * 1.5) - dotR;
  return { f, n, r, ry, ra, dotR, dotY };
}

export const lower: Record<string, Recipe> = {
  a: rec('a', (c) => {
    const { f, r } = sizes(c);
    const xs = 2 * r;
    const bry = f.xh * 0.37 + f.o / 2;
    const rh = f.xh * 0.22;
    return [
      bowl(c, r, bry - f.o, r, bry),
      path(c, joinPts(arcPts(xs - rh, f.xh - rh, rh, rh + f.o, 165, 0), linePts(xs, f.xh - rh, xs, 0))),
    ];
  }),

  b: rec('b', (c) => {
    const { f, r, ry } = sizes(c);
    return [stem(c, 0, f.asc, 0), bowl(c, r, f.xh / 2, r, ry)];
  }),

  c: rec('c', (c) => {
    const { f, r, ry } = sizes(c);
    return [arc(c, r, f.xh / 2, r, ry, 45, 315)];
  }),

  d: rec('d', (c) => {
    const { f, r, ry } = sizes(c);
    return [bowl(c, r, f.xh / 2, r, ry), stem(c, 2 * r, f.asc, 0)];
  }),

  e: rec('e', (c) => {
    const { f, r, ry } = sizes(c);
    const cy = f.xh / 2;
    const a = 12;
    const by = cy + ry * Math.sin((a * Math.PI) / 180);
    return [
      arc(c, r, cy, r, ry, a, 318),
      bar(c, r * 0.08, 2 * r, by),
    ];
  }),

  f: rec('f', (c) => {
    const { f } = sizes(c);
    const rf = f.xh * 0.24 * f.k;
    const xs = f.xh * 0.18;
    return [
      path(c, joinPts(linePts(xs, 0, xs, f.asc - rf), arcPts(xs + rf, f.asc - rf, rf, rf + f.o / 2, 180, 55))),
      bar(c, 0, xs + f.xh * 0.3, f.xh),
    ];
  }),

  g: rec('g', (c) => {
    const { f, r, ry } = sizes(c);
    const xs = 2 * r;
    const rg = f.xh * 0.26 * f.k;
    return [
      bowl(c, r, f.xh / 2, r, ry),
      path(c, joinPts(linePts(xs, f.xh, xs, f.desc + rg), arcPts(xs - rg, f.desc + rg, rg, rg + f.o, 0, -175))),
    ];
  }),

  h: rec('h', (c) => {
    const { f, n, ra } = sizes(c);
    return [stem(c, 0, f.asc, 0), arch(c, 0, n, f.xh + f.o * 0.5, 0, ra)];
  }),

  i: rec('i', (c) => {
    const { f, dotR, dotY } = sizes(c);
    return [stem(c, 0, 0, f.xh), dot(c, 0, dotY, dotR)];
  }),

  j: rec('j', (c) => {
    const { f, dotR, dotY } = sizes(c);
    const rj = f.xh * 0.26 * f.k;
    return [
      path(c, joinPts(linePts(rj, f.xh, rj, f.desc + rj), arcPts(0, f.desc + rj, rj, rj + f.o, 0, -170))),
      dot(c, rj, dotY, dotR),
    ];
  }),

  k: rec('k', (c) => {
    const { f } = sizes(c);
    const kw = f.xh * 0.52 * f.k;
    const yj = f.xh * 0.34;
    const t = 0.3;
    return [
      stem(c, 0, f.asc, 0),
      diagonal(c, 0, yj, kw, f.xh),
      diagonal(c, kw * t, yj + (f.xh - yj) * t, kw * 1.05, 0),
    ];
  }),

  l: rec('l', (c) => {
    const { f } = sizes(c);
    return [stem(c, 0, 0, f.asc)];
  }),

  m: rec('m', (c) => {
    const { f, n, ra } = sizes(c);
    const nm = n * 0.9;
    return [
      stem(c, 0, 0, f.xh),
      arch(c, 0, nm, f.xh + f.o * 0.5, 0, ra),
      arch(c, nm, 2 * nm, f.xh + f.o * 0.5, 0, ra),
    ];
  }),

  n: rec('n', (c) => {
    const { f, n, ra } = sizes(c);
    return [stem(c, 0, 0, f.xh), arch(c, 0, n, f.xh + f.o * 0.5, 0, ra)];
  }),

  o: rec('o', (c) => {
    const { f, r, ry } = sizes(c);
    return [bowl(c, r, f.xh / 2, r, ry)];
  }),

  p: rec('p', (c) => {
    const { f, r, ry } = sizes(c);
    return [stem(c, 0, f.xh, f.desc), bowl(c, r, f.xh / 2, r, ry)];
  }),

  q: rec('q', (c) => {
    const { f, r, ry } = sizes(c);
    return [bowl(c, r, f.xh / 2, r, ry), stem(c, 2 * r, f.xh, f.desc)];
  }),

  r: rec('r', (c) => {
    const { f } = sizes(c);
    const rr = f.xh * 0.27 * f.k;
    return [stem(c, 0, 0, f.xh), arc(c, rr, f.xh - rr, rr, rr + f.o, 180, 15)];
  }),

  s: rec('s', (c) => {
    const { f } = sizes(c);
    const Ws = f.xh * 0.54 * f.k;
    const r1 = f.xh * 0.235, r2 = f.xh * 0.265;
    return [
      arc(c, Ws / 2, f.xh - r1 + f.o / 2, Ws * 0.46, r1 + f.o / 2, 40, 270),
      arc(c, Ws / 2, r2 - f.o / 2, Ws * 0.5, r2 + f.o / 2, 90, -140),
    ];
  }),

  t: rec('t', (c) => {
    const { f } = sizes(c);
    const rt = f.xh * 0.22 * f.k;
    const xs = f.xh * 0.18;
    const top = f.xh + (f.asc - f.xh) * 0.55;
    return [
      path(c, joinPts(linePts(xs, top, xs, rt), arcPts(xs + rt, rt, rt, rt + f.o, 180, 300))),
      bar(c, 0, xs + f.xh * 0.28, f.xh),
    ];
  }),

  u: rec('u', (c) => {
    const { f, n } = sizes(c);
    return [cup(c, 0, n, f.xh, -f.o, f.xh * 0.34), stem(c, n, f.xh, 0)];
  }),

  v: rec('v', (c) => {
    const { f, n } = sizes(c);
    return [poly(c, [[0, f.xh], [n / 2, 0], [n, f.xh]])];
  }),

  w: rec('w', (c) => {
    const { f } = sizes(c);
    const ww = f.xh * 0.96 * f.k;
    return [poly(c, [[0, f.xh], [ww * 0.25, 0], [ww * 0.5, f.xh * 0.7], [ww * 0.75, 0], [ww, f.xh]])];
  }),

  x: rec('x', (c) => {
    const { f } = sizes(c);
    const xw = f.xh * 0.52 * f.k;
    return [diagonal(c, 0, 0, xw, f.xh), diagonal(c, 0, f.xh, xw, 0)];
  }),

  y: rec('y', (c) => {
    const { f, n } = sizes(c);
    const yw = n;
    // right stroke continues straight through the baseline into a small tail
    const slope = (yw / 2) / f.xh;
    const xe = yw / 2 + (f.desc + f.xh * 0.12) * slope;
    return [
      diagonal(c, 0, f.xh, yw / 2, 0),
      curve(c, [
        [yw, f.xh],
        [yw / 2, 0],
        [xe, f.desc + f.xh * 0.12],
        [xe - f.xh * 0.1, f.desc - f.o / 2],
        [xe - f.xh * 0.24, f.desc + f.xh * 0.05],
      ]),
    ];
  }),

  z: rec('z', (c) => {
    const { f } = sizes(c);
    const zw = f.xh * 0.5 * f.k;
    return [poly(c, [[0, f.xh], [zw, f.xh], [0, 0], [zw, 0]])];
  }),
};
