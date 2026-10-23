/**
 * Latin letters that neither decompose nor derive from a base: Æ Œ æ œ ß Þ þ ð.
 */
import type { Recipe, RecipeCtx } from './common';
import { frame, rec } from './common';
import { arc, arcPts, bar, bowl, joinPts, linePts, path, poly, stem } from '../../generate/primitives';

function sizes(ctx: RecipeCtx) {
  const f = frame(ctx);
  return { f, W: f.cap * 0.6 * f.k, R: f.cap * 0.33 * f.k, r: f.xh * 0.3 * f.k };
}

export const latinExtra: Record<string, Recipe> = {
  'Æ': rec('Æ', (c) => {
    const { f, W } = sizes(c);
    const Wn = f.cap * 0.42 * f.k;
    const x0 = W * 0.55; // E stem
    return [
      poly(c, [[0, 0], [x0, f.cap]]),
      stem(c, x0, 0, f.cap),
      bar(c, x0, x0 + Wn, f.cap),
      bar(c, x0 * 0.45, x0 + Wn * 0.85, f.cap * 0.5),
      bar(c, x0, x0 + Wn, 0),
    ];
  }),
  'æ': rec('æ', (c) => {
    const { f, r } = sizes(c);
    const rx = r * 0.95;
    return [
      bowl(c, rx, f.xh / 2, rx, f.xh / 2 + f.o),
      path(c, joinPts(linePts(rx * 2, f.xh / 2, rx * 2 + rx * 1.9, f.xh / 2), arcPts(rx * 2 + rx * 0.95, f.xh / 2, rx * 0.95, f.xh / 2 + f.o, 0, 300))),
      stem(c, rx * 2, 0, f.xh * 0.75),
    ];
  }),
  'Œ': rec('Œ', (c) => {
    const { f, R } = sizes(c);
    const Wn = f.cap * 0.42 * f.k;
    const x0 = R * 1.9;
    return [
      path(c, joinPts(linePts(x0, f.cap, R, f.cap), arcPts(R, f.cap / 2, R, f.cap / 2 + f.o, 90, 270), linePts(R, 0, x0, 0))),
      stem(c, x0, 0, f.cap),
      bar(c, x0, x0 + Wn, f.cap),
      bar(c, x0, x0 + Wn * 0.85, f.cap * 0.5),
      bar(c, x0, x0 + Wn, 0),
    ];
  }),
  'œ': rec('œ', (c) => {
    const { f, r } = sizes(c);
    const rx = r * 0.95;
    return [
      bowl(c, rx, f.xh / 2, rx, f.xh / 2 + f.o),
      path(c, joinPts(linePts(rx * 2.05, f.xh / 2, rx * 2.05 + rx * 1.9, f.xh / 2), arcPts(rx * 2.05 + rx * 0.95, f.xh / 2, rx * 0.95, f.xh / 2 + f.o, 0, 300))),
    ];
  }),
  'ß': rec('ß', (c) => {
    const { f } = sizes(c);
    const r = f.xh * 0.26 * f.k;
    return [
      path(c, joinPts(linePts(0, 0, 0, f.asc - r), arcPts(r, f.asc - r, r, r, 180, 0), linePts(r * 2, f.asc - r, r * 2, f.xh * 0.95))),
      path(c, joinPts(arcPts(r * 1.9, f.xh * 0.72, r * 0.9, f.xh * 0.26, 90, -90), arcPts(r * 1.9, f.xh * 0.26, r * 1.05, f.xh * 0.26, 90, -90), linePts(r * 1.9, 0, r * 1.2, 0))),
    ];
  }),
  'Þ': rec('Þ', (c) => {
    const { f } = sizes(c);
    const Wn = f.cap * 0.5 * f.k;
    const top = f.cap * 0.8, bot = f.cap * 0.2;
    const rr = (top - bot) / 2;
    const bx = Wn * 0.92 - rr;
    return [
      stem(c, 0, 0, f.cap),
      path(c, joinPts(linePts(0, top, bx, top), arcPts(bx, top - rr, rr, rr, 90, -90), linePts(bx, bot, 0, bot))),
    ];
  }),
  'þ': rec('þ', (c) => {
    const { f, r } = sizes(c);
    return [
      stem(c, 0, f.desc, f.asc),
      path(c, joinPts(linePts(0, f.xh, r, f.xh), arcPts(r, f.xh / 2, r, f.xh / 2 + f.o, 90, -90), linePts(r, 0, 0, 0))),
    ];
  }),
  'ð': rec('ð', (c) => {
    const { f, r } = sizes(c);
    const cy = f.xh * 0.5;
    return [
      arc(c, r, cy, r, cy + f.o, -90, 230),
      path(c, joinPts(arcPts(r, cy, r, cy + f.o, 50, 80), linePts(r * 1.6, f.xh * 0.95, r * 1.5, f.asc * 0.98))),
      bar(c, r * 0.9, r * 2.2, f.xh * 1.05),
    ];
  }),
};
