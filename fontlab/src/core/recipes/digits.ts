/**
 * Digits 0-9: lining figures at cap height, roughly tabular width.
 */
import type { Stroke } from '../glyph';
import type { Recipe, RecipeCtx } from './common';
import { frame, rec } from './common';
import {
  arc, arcPts, bowl, joinPts, linePts, path, poly, stem,
} from '../../generate/primitives';

function sizes(ctx: RecipeCtx) {
  const f = frame(ctx);
  return { f, Wd: f.cap * 0.5 * f.k };
}

function rotate180(strokes: Stroke[], cx: number, cy: number): Stroke[] {
  return strokes.map((s) => ({ ...s, points: s.points.map((p) => ({ ...p, x: 2 * cx - p.x, y: 2 * cy - p.y })) }));
}

function six(c: RecipeCtx): Stroke[] {
  const { f, Wd } = sizes(c);
  const rb = f.cap * 0.27;
  const rx = Wd / 2;
  return [
    arc(c, rx, f.cap / 2, rx, f.cap / 2 + f.o, 62, 200),
    bowl(c, rx, rb - f.o / 2, rx, rb + f.o / 2),
  ];
}

export const digits: Record<string, Recipe> = {
  '0': rec('0', (c) => {
    const { f } = sizes(c);
    const rx = f.cap * 0.27 * f.k;
    return [bowl(c, rx, f.cap / 2, rx, f.cap / 2 + f.o)];
  }),

  '1': rec('1', (c) => {
    const { f } = sizes(c);
    const flag = f.cap * 0.22 * f.k;
    return [poly(c, [[0, f.cap - flag], [flag, f.cap], [flag, 0]])];
  }),

  '2': rec('2', (c) => {
    const { f, Wd } = sizes(c);
    const r = f.cap * 0.25;
    const rx = Wd / 2;
    const endA = -38;
    const ex = rx + rx * Math.cos((endA * Math.PI) / 180);
    const ey = f.cap - r + r * Math.sin((endA * Math.PI) / 180);
    return [
      path(c, joinPts(
        arcPts(rx, f.cap - r, rx, r + f.o / 2, 160, endA),
        linePts(ex, ey, 0, 0),
        linePts(0, 0, Wd, 0),
      )),
    ];
  }),

  '3': rec('3', (c) => {
    const { f, Wd } = sizes(c);
    const ra = f.cap * 0.24, rb = (f.cap - 2 * ra) / 2;
    const cx = Wd / 2;
    return [
      arc(c, cx, f.cap - ra + f.o / 2, Wd * 0.46, ra + f.o / 2, 150, -90),
      arc(c, cx, rb - f.o / 2, Wd * 0.5, rb + f.o / 2, 90, -150),
    ];
  }),

  '4': rec('4', (c) => {
    const { f, Wd } = sizes(c);
    const hb = f.cap * 0.3;
    const xd = Wd * 0.68;
    return [
      poly(c, [[xd, f.cap], [0, hb], [Wd, hb]]),
      stem(c, xd, f.cap, 0),
    ];
  }),

  '5': rec('5', (c) => {
    const { f, Wd } = sizes(c);
    const rb = f.cap * 0.29;
    const rx = Wd * 0.5;
    const a0 = 112;
    const sx = rx + rx * Math.cos((a0 * Math.PI) / 180);
    const sy = rb + rb * Math.sin((a0 * Math.PI) / 180);
    return [
      path(c, joinPts(
        linePts(Wd * 0.92, f.cap, Wd * 0.06, f.cap),
        linePts(Wd * 0.06, f.cap, 0, sy),
        linePts(0, sy, sx, sy),
        arcPts(rx, rb - f.o / 2, rx, rb + f.o / 2, a0, -140),
      )),
    ];
  }),

  '6': rec('6', (c) => six(c)),

  '7': rec('7', (c) => {
    const { f, Wd } = sizes(c);
    return [poly(c, [[0, f.cap], [Wd, f.cap], [Wd * 0.3, 0]])];
  }),

  '8': rec('8', (c) => {
    const { f, Wd } = sizes(c);
    const ra = f.cap * 0.235, rb = (f.cap - 2 * ra) / 2;
    const cx = Wd / 2;
    return [
      bowl(c, cx, f.cap - ra, Wd * 0.43, ra + f.o / 2),
      bowl(c, cx, rb, Wd * 0.5, rb + f.o / 2),
    ];
  }),

  '9': rec('9', (c) => {
    const { f, Wd } = sizes(c);
    return rotate180(six(c), Wd / 2, f.cap / 2);
  }),
};
