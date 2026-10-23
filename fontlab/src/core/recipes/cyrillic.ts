/**
 * Cyrillic skeletons for the letters that are neither Latin look-alikes
 * (А В Е К М Н О Р С Т Х а е о р с у х І і Ј ј are aliased to the Latin
 * recipes elsewhere) nor plain small-caps of these uppercase forms (в г ж з
 * и к л м н п т ц ч ш щ ъ ы ь э ю я are derived elsewhere).
 *
 * Local frame as in upper.ts / lower.ts: x = 0 is the leftmost centreline,
 * baseline y = 0, y up, cap / x-height / ascender / descender from stats.
 * `finish()` adds sidebearings and the advance.
 */
import type { Vec } from '../glyph';
import type { Recipe, RecipeCtx } from './common';
import { frame, rec } from './common';
import {
  arc, arcPts, bar, bowl, diagonal, joinPts, linePts, path, poly, stem,
} from '../../generate/primitives';

const DEG = Math.PI / 180;

function sizes(ctx: RecipeCtx) {
  const f = frame(ctx);
  return {
    f,
    W: f.cap * 0.6 * f.k,     // И П Ц (H-like stem distance)
    Wn: f.cap * 0.5 * f.k,    // Б Г Ь Ъ Ы Я Ґ (B-like width)
    R: f.cap * 0.33 * f.k,    // round rx (Э Є)
    Wd: f.cap * 0.64 * f.k,   // Д (outer width incl. feet)
    Wsh: f.cap * 0.88 * f.k,  // Ш Щ (outer stem distance)
  };
}

/* ------------------------------------------------------------------ */
/* shared pieces                                                        */
/* ------------------------------------------------------------------ */

/**
 * Straight leg from (x0, y0) running down-left at `alphaDeg` above the
 * horizontal, blending tangentially into a circular foot of radius r whose
 * lowest point sits on the baseline; the arc may continue `extraDeg` past
 * the bottom to form a small upturned tail. Used by Л and У.
 */
function footLeg(x0: number, y0: number, alphaDeg: number, r: number, extraDeg = 0): Vec[] {
  const a = alphaDeg * DEG;
  const ty = r * (1 - Math.cos(a));
  const tx = x0 - (y0 - ty) / Math.tan(a);
  const cx = tx - r * Math.sin(a);
  return joinPts(linePts(x0, y0, tx, ty), arcPts(cx, r, r, r, alphaDeg - 90, -90 - extraDeg));
}

/** Half-height B bowl hanging from a stem at x0: used by Б Ь Ъ Ы. */
function lowerBowl(c: RecipeCtx, x0: number, w: number, mid: number) {
  const r = mid / 2;
  const bx = x0 + w - r;
  return path(c, joinPts(
    linePts(x0, mid, bx, mid),
    arcPts(bx, r, r * 1.02, r, 90, -90),
    linePts(bx, 0, x0, 0),
  ));
}

/** Д / д body: diagonal left leg, vertical right leg, baseline bar with feet. */
function deShape(c: RecipeCtx, h: number, w: number, foot: number) {
  const xr = w * 0.84;
  return [
    poly(c, [[w * 0.14, 0], [w * 0.34, h], [xr, h], [xr, 0]]),
    poly(c, [[0, -foot], [0, 0], [w, 0], [w, -foot]]),
  ];
}

/** Baseline bar from 0 to w with the short Ц / Щ descender tail at the right. */
function tailBar(c: RecipeCtx, w: number, cap: number, k: number) {
  const tx = cap * 0.1 * k, dy = cap * 0.15;
  return poly(c, [[0, 0], [w + tx, 0], [w + tx, -dy]]);
}

/* ------------------------------------------------------------------ */
/* recipes                                                              */
/* ------------------------------------------------------------------ */

export const cyrillic: Record<string, Recipe> = {
  /* ---------------------------- uppercase ---------------------------- */

  'Б': rec('Б', (c) => {
    const { f, Wn } = sizes(c);
    return [
      stem(c, 0, 0, f.cap),
      bar(c, 0, Wn * 0.96, f.cap),
      lowerBowl(c, 0, Wn, f.cap * 0.54),
    ];
  }),

  'Г': rec('Г', (c) => {
    const { f, Wn } = sizes(c);
    return [stem(c, 0, 0, f.cap), bar(c, 0, Wn * 0.96, f.cap)];
  }),

  'Д': rec('Д', (c) => {
    const { f, Wd } = sizes(c);
    return deShape(c, f.cap, Wd, f.cap * 0.12);
  }),

  'Ж': rec('Ж', (c) => {
    const { f } = sizes(c);
    const arm = f.cap * 0.38 * f.k;
    const cx = arm;
    const yj = f.cap * 0.42;
    const ax = arm * 0.95, t = 0.3;
    const jy = yj + (f.cap - yj) * t;
    return [
      stem(c, cx, 0, f.cap),
      diagonal(c, cx, yj, cx - ax, f.cap),
      diagonal(c, cx - ax * t, jy, 0, 0),
      diagonal(c, cx, yj, cx + ax, f.cap),
      diagonal(c, cx + ax * t, jy, 2 * arm, 0),
    ];
  }),

  'З': rec('З', (c) => {
    const { f } = sizes(c);
    const Wz = f.cap * 0.5 * f.k;
    const ra = f.cap * 0.24, rb = (f.cap - 2 * ra) / 2;
    const cx = Wz / 2;
    return [
      arc(c, cx, f.cap - ra + f.o / 2, Wz * 0.46, ra + f.o / 2, 150, -90),
      arc(c, cx, rb - f.o / 2, Wz * 0.5, rb + f.o / 2, 90, -150),
    ];
  }),

  'И': rec('И', (c) => {
    const { f, W } = sizes(c);
    return [stem(c, 0, 0, f.cap), diagonal(c, 0, 0, W, f.cap), stem(c, W, 0, f.cap)];
  }),

  'Л': rec('Л', (c) => {
    const { f } = sizes(c);
    const Wl = f.cap * 0.6 * f.k;
    const xt = Wl * 0.3;
    return [
      path(c, joinPts(linePts(Wl, f.cap, xt, f.cap), footLeg(xt, f.cap, 84, f.cap * 0.1))),
      stem(c, Wl, 0, f.cap),
    ];
  }),

  'П': rec('П', (c) => {
    const { f, W } = sizes(c);
    return [stem(c, 0, 0, f.cap), stem(c, W, 0, f.cap), bar(c, 0, W, f.cap)];
  }),

  'У': rec('У', (c) => {
    const { f } = sizes(c);
    const Wy = f.cap * 0.58 * f.k;
    const yj = f.cap * 0.4;
    const xj = Wy * 0.5;
    const alpha = Math.atan2(f.cap - yj, Wy - xj) / DEG;
    return [
      path(c, footLeg(Wy, f.cap, alpha, f.cap * 0.13, 30)),
      diagonal(c, 0, f.cap, xj, yj),
    ];
  }),

  'Ф': rec('Ф', (c) => {
    const { f } = sizes(c);
    const Rf = f.cap * 0.4 * f.k;
    const ry = f.cap * 0.32 + f.o;
    return [
      stem(c, Rf, -f.cap * 0.03, f.cap * 1.03),
      bowl(c, Rf, f.cap / 2, Rf, ry),
    ];
  }),

  'Ц': rec('Ц', (c) => {
    const { f, W } = sizes(c);
    return [stem(c, 0, 0, f.cap), stem(c, W, 0, f.cap), tailBar(c, W, f.cap, f.k)];
  }),

  'Ч': rec('Ч', (c) => {
    const { f } = sizes(c);
    const Wc = f.cap * 0.56 * f.k;
    const yk = f.cap * 0.36, ry = f.cap * 0.24, rx = Wc * 0.5;
    return [
      stem(c, Wc, 0, f.cap),
      path(c, joinPts(
        linePts(0, f.cap, 0, yk + ry),
        arcPts(rx, yk + ry, rx, ry, 180, 270),
        linePts(rx, yk, Wc, yk),
      )),
    ];
  }),

  'Ш': rec('Ш', (c) => {
    const { f, Wsh } = sizes(c);
    return [
      stem(c, 0, 0, f.cap), stem(c, Wsh / 2, 0, f.cap), stem(c, Wsh, 0, f.cap),
      bar(c, 0, Wsh, 0),
    ];
  }),

  'Щ': rec('Щ', (c) => {
    const { f, Wsh } = sizes(c);
    return [
      stem(c, 0, 0, f.cap), stem(c, Wsh / 2, 0, f.cap), stem(c, Wsh, 0, f.cap),
      tailBar(c, Wsh, f.cap, f.k),
    ];
  }),

  'Ъ': rec('Ъ', (c) => {
    const { f, Wn } = sizes(c);
    const sx = f.cap * 0.18 * f.k;
    return [
      poly(c, [[0, f.cap], [sx, f.cap], [sx, 0]]),
      lowerBowl(c, sx, Wn * 0.94, f.cap * 0.52),
    ];
  }),

  'Ы': rec('Ы', (c) => {
    const { f, Wn } = sizes(c);
    const wb = Wn * 0.9;
    const xr = wb + f.cap * 0.2 * f.k;
    return [
      stem(c, 0, 0, f.cap),
      lowerBowl(c, 0, wb, f.cap * 0.52),
      stem(c, xr, 0, f.cap),
    ];
  }),

  'Ь': rec('Ь', (c) => {
    const { f, Wn } = sizes(c);
    return [stem(c, 0, 0, f.cap), lowerBowl(c, 0, Wn, f.cap * 0.52)];
  }),

  'Э': rec('Э', (c) => {
    const { f, R } = sizes(c);
    const cy = f.cap / 2;
    return [
      arc(c, R, cy, R, cy + f.o, 138, -138),
      bar(c, R * 0.42, 2 * R, cy),
    ];
  }),

  'Ю': rec('Ю', (c) => {
    const { f } = sizes(c);
    const gx = f.cap * 0.2 * f.k;
    const Ro = f.cap * 0.3 * f.k;
    return [
      stem(c, 0, 0, f.cap),
      bar(c, 0, gx, f.cap * 0.5),
      bowl(c, gx + Ro, f.cap / 2, Ro, f.cap / 2 + f.o),
    ];
  }),

  'Я': rec('Я', (c) => {
    const { f, Wn } = sizes(c);
    const mid = f.cap * 0.46;
    const r = (f.cap - mid) / 2;
    const bx = Wn - r;
    return [
      stem(c, Wn, 0, f.cap),
      path(c, joinPts(
        linePts(Wn, f.cap, r, f.cap),
        arcPts(r, f.cap - r, r, r, 90, 270),
        linePts(r, mid, Wn, mid),
      )),
      diagonal(c, Wn - bx * 0.9, mid, -Wn * 0.02, 0),
    ];
  }),

  'Є': rec('Є', (c) => {
    const { f, R } = sizes(c);
    const cy = f.cap / 2;
    return [
      arc(c, R, cy, R, cy + f.o, 42, 318),
      bar(c, R * 0.9, R * 1.78, cy),
    ];
  }),

  'Ґ': rec('Ґ', (c) => {
    const { f, Wn } = sizes(c);
    const xe = Wn * 0.94;
    return [
      stem(c, 0, 0, f.cap),
      poly(c, [[0, f.cap], [xe, f.cap], [xe, f.cap * 1.1]]),
    ];
  }),

  /* ------------------- lowercase with their own forms ------------------- */

  'б': rec('б', (c) => {
    const { f } = sizes(c);
    const r = f.xh * 0.3 * f.k;
    const ry = f.xh / 2 + f.o;
    const rt = f.xh * 0.28 * f.k;
    const lean = f.xh * 0.06;
    return [
      bowl(c, r, f.xh / 2, r, ry),
      path(c, joinPts(
        linePts(0, f.xh / 2, lean, f.asc - rt),
        arcPts(lean + rt, f.asc - rt, rt, rt, 180, 35),
      )),
    ];
  }),

  'д': rec('д', (c) => {
    const { f } = sizes(c);
    return deShape(c, f.xh, f.xh * 0.66 * f.k, -f.desc * 0.5);
  }),

  'ф': rec('ф', (c) => {
    const { f } = sizes(c);
    const Rf = f.xh * 0.5 * f.k;
    return [
      stem(c, Rf, f.asc, f.desc),
      bowl(c, Rf, f.xh / 2, Rf, f.xh / 2 + f.o),
    ];
  }),
};
