/**
 * Seeded, deterministic mutation of stroke skeletons: per-stroke scale /
 * rotation / translation jitter plus smooth control-point wobble driven by
 * simplex noise. Pure; same rng sequence => same output.
 */
import type { Stroke, StrokePoint } from '../core/glyph';
import type { Rng } from '../core/prng';
import { clamp } from '../core/geometry';

export interface MutateOpts {
  /** extra wobble amplitude in font units (e.g. StyleStats.wobbleAmp), applied even when amount = 0 */
  wobbleAmp?: number;
  /** wobble frequency multiplier (1 = wavelength of roughly 80 units) */
  wobbleFreq?: number;
  /** sd of per-stroke scale jitter at amount = 1 (default 0.03) */
  scaleJitter?: number;
  /** sd of per-stroke rotation jitter in degrees at amount = 1 (default 1.5) */
  rotJitterDeg?: number;
  /** sd of per-stroke translation jitter in units at amount = 1 (default 3) */
  shiftJitter?: number;
}

const DEG = Math.PI / 180;

function copyStroke(s: Stroke): Stroke {
  return { id: s.id, cap: s.cap, points: s.points.map((p) => ({ ...p })) };
}

/**
 * Wobble + jitter every stroke. `amount` is 0..1 (project mutation). Always
 * consumes the same number of rng draws per stroke so results are stable.
 */
export function mutateStrokes(strokes: Stroke[], amount: number, rng: Rng, opts: MutateOpts = {}): Stroke[] {
  const amt = clamp(Number.isFinite(amount) ? amount : 0, 0, 1);
  const extraWobble = clamp(opts.wobbleAmp ?? 0, 0, 40);
  const out = strokes.map(copyStroke);
  if (amt <= 0 && extraWobble <= 0) return out;

  const scaleSd = (opts.scaleJitter ?? 0.03) * amt;
  const rotSd = (opts.rotJitterDeg ?? 1.5) * amt * DEG;
  const shiftSd = (opts.shiftJitter ?? 3) * amt;
  const amp = extraWobble + 5 * amt;
  const freq = 0.012 * clamp(opts.wobbleFreq ?? 1, 0.05, 20);

  for (const s of out) {
    // per-stroke draws (fixed count)
    const salt = rng.range(0, 1000);
    const sc = clamp(1 + rng.gauss(0, scaleSd), 0.9, 1.1);
    const rot = clamp(rng.gauss(0, rotSd), -5 * DEG, 5 * DEG);
    const dx = rng.gauss(0, shiftSd);
    const dy = rng.gauss(0, shiftSd);
    if (s.points.length === 0) continue;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of s.points) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const cos = Math.cos(rot), sin = Math.sin(rot);
    const single = s.points.length === 1;

    s.points = s.points.map((p): StrokePoint => {
      let x = p.x, y = p.y;
      if (!single) {
        const ox = (x - cx) * sc, oy = (y - cy) * sc;
        x = cx + ox * cos - oy * sin + dx;
        y = cy + ox * sin + oy * cos + dy;
        if (amp > 0) {
          x += rng.noise2(p.x * freq + salt, p.y * freq) * amp;
          y += rng.noise2(p.x * freq + salt + 77.7, p.y * freq + 33.3) * amp;
        }
      } else {
        x += dx; y += dy;
      }
      return { ...p, x, y, w: p.w * (single ? 1 : sc) };
    });
  }
  return out;
}
