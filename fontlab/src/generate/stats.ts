/**
 * Estimate StyleStats from user-provided seed glyphs (stroke or outline kind).
 * Every measurement falls back to `base` when there is no usable evidence, so
 * the result is always a complete, finite StyleStats.
 */
import type { CapStyle, Glyph, StrokePoint, StyleStats, Vec } from '../core/glyph';
import { bboxContours, bboxStrokes, clamp, resampleLinear, signedArea, simplifyRDP, type BBox } from '../core/geometry';

const LOWER_X = new Set('acemnorsuvwxz');
const LOWER_X_FLAT = new Set('mnruvwxz');
const LOWER_X_ROUND = new Set('aceos');
const CAP_FLAT = new Set('BDEFHIJKLMNPRTUVWXYZ1247');
const CAP_ROUND = new Set('CGOQS03689');
const ASC = new Set('bdfhkl');
const DESC = new Set('gjpqy');

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function median(xs: number[]): number | undefined {
  const a = xs.filter(fin).sort((p, q) => p - q);
  if (!a.length) return undefined;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function mean(xs: number[]): number | undefined {
  const a = xs.filter(fin);
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : undefined;
}

interface Measured {
  char: string;
  bbox: BBox;
  advance: number;
  strokes: StrokePoint[][];   // sanitised stroke point runs (stroke glyphs only)
  outlineRings: Vec[][];      // outline contours (outline glyphs only)
  caps: CapStyle[];
}

function measureGlyph(g: Glyph): Measured | null {
  if (!g || typeof g !== 'object' || typeof g.char !== 'string') return null;
  const advance = fin(g.advance) ? g.advance : 0;
  if (g.kind === 'stroke' && Array.isArray(g.strokes)) {
    const strokes: StrokePoint[][] = [];
    const caps: CapStyle[] = [];
    for (const s of g.strokes) {
      if (!s || !Array.isArray(s.points)) continue;
      const pts = s.points.filter((p) => p && fin(p.x) && fin(p.y) && fin(p.w) && p.w >= 0);
      if (pts.length === 0) continue;
      strokes.push(pts);
      if (s.cap === 'round' || s.cap === 'flat' || s.cap === 'taper') caps.push(s.cap);
    }
    if (!strokes.length) return null;
    const bbox = bboxStrokes(strokes.map((points) => ({ id: '', cap: 'round', points })));
    return { char: g.char, bbox, advance, strokes, outlineRings: [], caps };
  }
  if (g.kind === 'outline' && Array.isArray(g.contours)) {
    const rings: Vec[][] = [];
    for (const c of g.contours) {
      if (!c || !Array.isArray(c.points)) continue;
      const pts = c.points.filter((p): p is Vec => Array.isArray(p) && fin(p[0]) && fin(p[1]));
      if (pts.length >= 3) rings.push(pts);
    }
    // strokes drawn on top of an outline letter
    const strokes: StrokePoint[][] = [];
    for (const s of g.strokes ?? []) {
      if (!s || !Array.isArray(s.points)) continue;
      const pts = s.points.filter((p) => p && fin(p.x) && fin(p.y) && fin(p.w) && p.w >= 0);
      if (pts.length) strokes.push(pts);
    }
    if (!rings.length && !strokes.length) return null;
    const bc = bboxContours(rings.map((points) => ({ points })));
    const bbox = strokes.length ? (() => { const bs = bboxStrokes(strokes.map((points) => ({ id: '', cap: 'round' as const, points }))); return rings.length ? { minX: Math.min(bc.minX, bs.minX), minY: Math.min(bc.minY, bs.minY), maxX: Math.max(bc.maxX, bs.maxX), maxY: Math.max(bc.maxY, bs.maxY) } : bs; })() : bc;
    return { char: g.char, bbox, advance, strokes, outlineRings: rings, caps: [] };
  }
  return null;
}

/** ribbon width estimate for an outline glyph: 2 * area / perimeter */
function outlineWidth(rings: Vec[][]): number | undefined {
  let area = 0, perim = 0;
  for (const r of rings) {
    area += signedArea(r); // holes are negative => subtracts counters
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      perim += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
  }
  area = Math.abs(area);
  if (perim <= 0 || area <= 0) return undefined;
  return (2 * area) / perim;
}

function pointDist2(p: Vec, a: Vec, b: Vec): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = clamp(t, 0, 1);
  const px = a[0] + t * dx - p[0], py = a[1] + t * dy - p[1];
  return px * px + py * py;
}

/**
 * Mean deviation of a polyline from a smoothed version of itself: the points
 * are resampled evenly, then compared with a moving average (±`win` samples).
 * Hand wobble shows up as a few units; smooth curves and straight runs stay
 * near zero. (A plain RDP comparison saturates at ~tolerance/2 for per-point
 * jitter because RDP keeps the outliers as vertices, so a smoother is used as
 * the "fitted path" instead.)
 */
function wobbleOf(pts: Vec[], spacing = 8, win = 4): number | undefined {
  const rs = resampleLinear(pts, spacing);
  if (rs.length < 2 * win + 3) {
    // short stroke: fall back to deviation from its RDP simplification
    if (pts.length < 4) return undefined;
    const simp = simplifyRDP(pts, spacing);
    let sum = 0, n = 0;
    for (const p of pts) {
      let best = Infinity;
      for (let i = 0; i < simp.length - 1; i++) best = Math.min(best, pointDist2(p, simp[i], simp[i + 1]));
      if (Number.isFinite(best)) { sum += Math.sqrt(best); n++; }
    }
    return n ? sum / n : undefined;
  }
  let sum = 0, n = 0;
  const k = 2 * win + 1;
  for (let i = win; i < rs.length - win; i++) {
    let mx = 0, my = 0;
    for (let j = -win; j <= win; j++) { mx += rs[i + j][0]; my += rs[i + j][1]; }
    sum += Math.hypot(rs[i][0] - mx / k, rs[i][1] - my / k);
    n++;
  }
  return n ? sum / n : undefined;
}

/** length-weighted median lean (deg, +ve = top leans right) of near-vertical segments */
function slantOf(polylines: Vec[][]): number | undefined {
  const runs: { ang: number; l: number }[] = [];
  for (const pts of polylines) {
    for (let i = 0; i < pts.length - 1; i++) {
      const dx = pts[i + 1][0] - pts[i][0], dy = pts[i + 1][1] - pts[i][1];
      const l = Math.hypot(dx, dy);
      if (l < 2) continue;
      // angle from the +y axis, signed (positive = leaning right)
      let ang = Math.atan2(dx, dy) * (180 / Math.PI);
      if (ang > 90) ang -= 180;
      if (ang < -90) ang += 180;
      if (Math.abs(ang) > 22) continue;
      runs.push({ ang, l });
    }
  }
  if (!runs.length) return undefined;
  runs.sort((a, b) => a.ang - b.ang);
  const total = runs.reduce((s, r) => s + r.l, 0);
  let acc = 0;
  for (const r of runs) {
    acc += r.l;
    if (acc >= total / 2) return r.ang;
  }
  return runs[runs.length - 1].ang;
}

/** fraction of simplified vertices that are sharp corners -> corner radius guess */
function cornerSharpness(polylines: Vec[][], tol: number): number | undefined {
  let sharp = 0, total = 0;
  for (const pts of polylines) {
    const s = simplifyRDP(pts, tol);
    for (let i = 1; i < s.length - 1; i++) {
      const ax = s[i][0] - s[i - 1][0], ay = s[i][1] - s[i - 1][1];
      const bx = s[i + 1][0] - s[i][0], by = s[i + 1][1] - s[i][1];
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      if (la < tol || lb < tol) continue;
      const cosT = (ax * bx + ay * by) / (la * lb);
      const turn = Math.acos(clamp(cosT, -1, 1)) * (180 / Math.PI);
      total++;
      if (turn > 55) sharp++;
    }
  }
  return total ? sharp / total : undefined;
}

export function measureStats(seeds: Glyph[], base: StyleStats): StyleStats {
  const out: StyleStats = { ...base };
  const ms = (Array.isArray(seeds) ? seeds : []).map(measureGlyph).filter((m): m is Measured => !!m);
  if (!ms.length) return out;

  // ---- stroke width ------------------------------------------------------
  const ws: number[] = [];
  for (const m of ms) for (const s of m.strokes) for (const p of s) ws.push(p.w * 2);
  let sw = median(ws);
  if (sw === undefined) {
    const est = ms.map((m) => (m.outlineRings.length ? outlineWidth(m.outlineRings) : undefined)).filter(fin);
    sw = median(est);
  }
  if (fin(sw) && sw > 0) out.strokeWidth = clamp(sw, 2, 500);

  // ---- width variance ----------------------------------------------------
  if (ws.length > 4) {
    const mu = mean(ws)!;
    const sd = Math.sqrt(ws.reduce((s, v) => s + (v - mu) ** 2, 0) / ws.length);
    if (mu > 0) out.widthVariance = clamp(sd / mu, 0, 1);
  }

  // ---- vertical metrics --------------------------------------------------
  const tops = (set: Set<string>) => ms.filter((m) => set.has(m.char)).map((m) => m.bbox.maxY);
  const bottoms = (set: Set<string>) => ms.filter((m) => set.has(m.char)).map((m) => m.bbox.minY);
  const hw = out.strokeWidth / 2;

  const xFlat = median(tops(LOWER_X_FLAT));
  const xRound = median(tops(LOWER_X_ROUND));
  const xAll = median(tops(LOWER_X));
  const capFlat = median(tops(CAP_FLAT));
  const capRound = median(tops(CAP_ROUND));
  const capAll = median(tops(new Set([...CAP_FLAT, ...CAP_ROUND])));
  const ascTop = median(tops(ASC));
  const descBot = median(bottoms(DESC));

  // tops are ink extents; centreline metrics are a half width lower
  if (fin(xAll) && xAll > 50) out.xHeight = clamp((xFlat ?? xAll) - hw, 100, 950);
  if (fin(capAll) && capAll > 50) out.capHeight = clamp((capFlat ?? capAll) - hw, out.xHeight + 20, 1100);
  if (fin(ascTop) && ascTop > 50) out.ascender = clamp(ascTop - hw, out.xHeight + 20, 1200);
  if (fin(descBot) && descBot < 0) out.descender = clamp(descBot + hw, -600, -10);

  // ---- overshoot ---------------------------------------------------------
  const overs: number[] = [];
  if (fin(xFlat) && fin(xRound)) overs.push(xRound - xFlat);
  if (fin(capFlat) && fin(capRound)) overs.push(capRound - capFlat);
  const flatBottom = median(ms.filter((m) => !DESC.has(m.char) && (LOWER_X_FLAT.has(m.char) || CAP_FLAT.has(m.char))).map((m) => m.bbox.minY));
  const roundBottom = median(ms.filter((m) => LOWER_X_ROUND.has(m.char) || CAP_ROUND.has(m.char)).map((m) => m.bbox.minY));
  if (fin(flatBottom) && fin(roundBottom)) overs.push(flatBottom - roundBottom);
  const ov = mean(overs);
  if (fin(ov)) out.overshoot = clamp(ov, 0, 40);

  // ---- centreline polylines (stroke seeds) ------------------------------
  const polylines: Vec[][] = [];
  for (const m of ms) for (const s of m.strokes) polylines.push(s.map((p): Vec => [p.x, p.y]));
  if (!polylines.length) for (const m of ms) polylines.push(...m.outlineRings);

  // ---- slant -------------------------------------------------------------
  const sl = slantOf(polylines);
  if (fin(sl)) out.slantDeg = clamp(sl, -30, 30);

  // ---- corner radius guess -----------------------------------------------
  const sharp = cornerSharpness(polylines, Math.max(4, hw * 0.5));
  if (fin(sharp)) out.cornerRadius = clamp(1 - sharp, 0, 1);

  // ---- terminals ---------------------------------------------------------
  const capCount = new Map<CapStyle, number>();
  for (const m of ms) for (const c of m.caps) capCount.set(c, (capCount.get(c) ?? 0) + 1);
  let bestCap: CapStyle | undefined, bestN = 0;
  for (const [c, n] of capCount) if (n > bestN) { bestCap = c; bestN = n; }
  if (bestCap) out.terminal = bestCap;

  // ---- wobble ------------------------------------------------------------
  if (ms.some((m) => m.strokes.length)) {
    const wob: number[] = [];
    for (const m of ms) for (const s of m.strokes) {
      const w = wobbleOf(s.map((p): Vec => [p.x, p.y]));
      if (fin(w)) wob.push(w);
    }
    const wm = mean(wob);
    if (fin(wm)) out.wobbleAmp = clamp(wm, 0, 60);
  }

  // ---- spacing -----------------------------------------------------------
  const sbs: number[] = [];
  for (const m of ms) {
    const ink = m.bbox.maxX - m.bbox.minX;
    if (m.advance > 0 && ink > 0 && m.advance >= ink) sbs.push((m.advance - ink) / 2);
  }
  const sb = mean(sbs);
  if (fin(sb)) out.spacing = clamp(sb, 0, 300);

  // final sanity: every field finite
  for (const k of Object.keys(out) as (keyof StyleStats)[]) {
    const v = out[k];
    if (typeof v === 'number' && !Number.isFinite(v)) (out as any)[k] = base[k];
  }
  return out;
}
