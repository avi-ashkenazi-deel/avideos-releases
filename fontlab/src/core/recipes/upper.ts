/**
 * Uppercase A-Z skeletons. Local frame: x = 0 is the leftmost centreline,
 * baseline y = 0, cap height from stats. `finish()` adds sidebearings.
 */
import type { Recipe, RecipeCtx } from './common';
import { frame, rec } from './common';
import {
  arc, arcPts, bar, bowl, cup, diagonal, joinPts, linePts, path, poly, stem,
} from '../../generate/primitives';

function sizes(ctx: RecipeCtx) {
  const f = frame(ctx);
  return {
    f,
    W: f.cap * 0.6 * f.k,    // H N U T X Y A V
    Wn: f.cap * 0.5 * f.k,   // E F L B P R K S Z
    R: f.cap * 0.33 * f.k,   // round rx (O C G Q)
    Wd: f.cap * 0.56 * f.k,  // D
    Wm: f.cap * 0.72 * f.k,
    Ww: f.cap * 0.95 * f.k,
  };
}

export const upper: Record<string, Recipe> = {
  A: rec('A', (c) => {
    const { f, W } = sizes(c);
    const yb = f.cap * 0.36;
    const t = yb / f.cap;
    return [
      poly(c, [[0, 0], [W / 2, f.cap], [W, 0]]),
      bar(c, (W / 2) * t, W - (W / 2) * t, yb),
    ];
  }),

  B: rec('B', (c) => {
    const { f, Wn } = sizes(c);
    const mid = f.cap * 0.54;
    const r1 = (f.cap - mid) / 2, r2 = mid / 2;
    const bx1 = Wn * 0.92 - r1, bx2 = Wn - r2;
    return [
      stem(c, 0, 0, f.cap),
      path(c, joinPts(linePts(0, f.cap, bx1, f.cap), arcPts(bx1, f.cap - r1, r1, r1, 90, -90), linePts(bx1, mid, 0, mid))),
      path(c, joinPts(linePts(0, mid, bx2, mid), arcPts(bx2, r2, r2 * 1.02, r2, 90, -90), linePts(bx2, 0, 0, 0))),
    ];
  }),

  C: rec('C', (c) => {
    const { f, R } = sizes(c);
    return [arc(c, R, f.cap / 2, R, f.cap / 2 + f.o, 42, 318)];
  }),

  D: rec('D', (c) => {
    const { f, Wd } = sizes(c);
    const rx = Wd * 0.62, dx = Wd - rx;
    return [
      stem(c, 0, 0, f.cap),
      path(c, joinPts(linePts(0, f.cap, dx, f.cap), arcPts(dx, f.cap / 2, rx, f.cap / 2, 90, -90), linePts(dx, 0, 0, 0))),
    ];
  }),

  E: rec('E', (c) => {
    const { f, Wn } = sizes(c);
    return [
      stem(c, 0, 0, f.cap),
      bar(c, 0, Wn, f.cap),
      bar(c, 0, Wn * 0.84, f.cap * 0.52),
      bar(c, 0, Wn, 0),
    ];
  }),

  F: rec('F', (c) => {
    const { f, Wn } = sizes(c);
    return [
      stem(c, 0, 0, f.cap),
      bar(c, 0, Wn, f.cap),
      bar(c, 0, Wn * 0.8, f.cap * 0.5),
    ];
  }),

  G: rec('G', (c) => {
    const { f, R } = sizes(c);
    const cy = f.cap / 2;
    return [
      arc(c, R, cy, R, cy + f.o, 42, 360),
      bar(c, R * 1.05, 2 * R, cy),
    ];
  }),

  H: rec('H', (c) => {
    const { f, W } = sizes(c);
    return [stem(c, 0, 0, f.cap), stem(c, W, 0, f.cap), bar(c, 0, W, f.cap * 0.5)];
  }),

  I: rec('I', (c) => {
    const { f } = sizes(c);
    return [stem(c, 0, 0, f.cap)];
  }),

  J: rec('J', (c) => {
    const { f } = sizes(c);
    const r = f.cap * 0.22 * f.k;
    return [
      path(c, joinPts(linePts(2 * r, f.cap, 2 * r, r), arcPts(r, r, r, r + f.o, 0, -180))),
    ];
  }),

  K: rec('K', (c) => {
    const { f, Wn } = sizes(c);
    const yj = f.cap * 0.42;
    const ax = Wn * 0.95, ay = f.cap;
    const t = 0.3;
    const jx = ax * t, jy = yj + (ay - yj) * t;
    return [
      stem(c, 0, 0, f.cap),
      diagonal(c, 0, yj, ax, ay),
      diagonal(c, jx, jy, Wn, 0),
    ];
  }),

  L: rec('L', (c) => {
    const { f, Wn } = sizes(c);
    return [stem(c, 0, 0, f.cap), bar(c, 0, Wn * 0.9, 0)];
  }),

  M: rec('M', (c) => {
    const { f, Wm } = sizes(c);
    return [
      stem(c, 0, 0, f.cap),
      poly(c, [[0, f.cap], [Wm / 2, f.cap * 0.1], [Wm, f.cap]]),
      stem(c, Wm, 0, f.cap),
    ];
  }),

  N: rec('N', (c) => {
    const { f, W } = sizes(c);
    return [stem(c, 0, 0, f.cap), diagonal(c, 0, f.cap, W, 0), stem(c, W, 0, f.cap)];
  }),

  O: rec('O', (c) => {
    const { f, R } = sizes(c);
    return [bowl(c, R, f.cap / 2, R, f.cap / 2 + f.o)];
  }),

  P: rec('P', (c) => {
    const { f, Wn } = sizes(c);
    const mid = f.cap * 0.44;
    const r = (f.cap - mid) / 2;
    const bx = Wn - r;
    return [
      stem(c, 0, 0, f.cap),
      path(c, joinPts(linePts(0, f.cap, bx, f.cap), arcPts(bx, f.cap - r, r, r, 90, -90), linePts(bx, mid, 0, mid))),
    ];
  }),

  Q: rec('Q', (c) => {
    const { f, R } = sizes(c);
    const ry = f.cap / 2 + f.o;
    return [
      bowl(c, R, f.cap / 2, R, ry),
      diagonal(c, R * 1.15, f.cap * 0.2, R * 2.05, -f.cap * 0.1),
    ];
  }),

  R: rec('R', (c) => {
    const { f, Wn } = sizes(c);
    const mid = f.cap * 0.46;
    const r = (f.cap - mid) / 2;
    const bx = Wn - r;
    return [
      stem(c, 0, 0, f.cap),
      path(c, joinPts(linePts(0, f.cap, bx, f.cap), arcPts(bx, f.cap - r, r, r, 90, -90), linePts(bx, mid, 0, mid))),
      diagonal(c, bx * 0.9, mid, Wn * 1.02, 0),
    ];
  }),

  S: rec('S', (c) => {
    const { f } = sizes(c);
    const Ws = f.cap * 0.52 * f.k;
    const r1 = f.cap * 0.235, r2 = f.cap * 0.265;
    const cxv = Ws / 2;
    return [
      arc(c, cxv, f.cap - r1 + f.o / 2, Ws * 0.46, r1 + f.o / 2, 40, 270),
      arc(c, cxv, r2 - f.o / 2, Ws * 0.5, r2 + f.o / 2, 90, -140),
    ];
  }),

  T: rec('T', (c) => {
    const { f, W } = sizes(c);
    return [bar(c, 0, W, f.cap), stem(c, W / 2, 0, f.cap)];
  }),

  U: rec('U', (c) => {
    const { f, W } = sizes(c);
    return [cup(c, 0, W, f.cap, -f.o, W * 0.46)];
  }),

  V: rec('V', (c) => {
    const { f, W } = sizes(c);
    return [poly(c, [[0, f.cap], [W / 2, 0], [W, f.cap]])];
  }),

  W: rec('W', (c) => {
    const { f, Ww } = sizes(c);
    return [poly(c, [[0, f.cap], [Ww * 0.25, 0], [Ww * 0.5, f.cap * 0.72], [Ww * 0.75, 0], [Ww, f.cap]])];
  }),

  X: rec('X', (c) => {
    const { f } = sizes(c);
    const Wx = f.cap * 0.56 * f.k;
    return [diagonal(c, 0, 0, Wx, f.cap), diagonal(c, 0, f.cap, Wx, 0)];
  }),

  Y: rec('Y', (c) => {
    const { f } = sizes(c);
    const Wy = f.cap * 0.58 * f.k;
    const yj = f.cap * 0.45;
    return [
      diagonal(c, 0, f.cap, Wy / 2, yj),
      diagonal(c, Wy, f.cap, Wy / 2, yj),
      stem(c, Wy / 2, yj, 0),
    ];
  }),

  Z: rec('Z', (c) => {
    const { f } = sizes(c);
    const Wz = f.cap * 0.53 * f.k;
    return [poly(c, [[0, f.cap], [Wz, f.cap], [0, 0], [Wz, 0]])];
  }),
};
