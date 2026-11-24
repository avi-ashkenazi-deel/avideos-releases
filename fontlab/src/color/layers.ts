/**
 * Colour-font layers. Splits one finished letter (the BUILT contours, i.e. after
 * the effect stack) into flat-coloured layers for a COLR v0 / CPAL font.
 *
 * Layers are painted in array order (first = bottom) and deliberately run a
 * little way UNDER the layers painted above them: two antialiased edges that
 * merely abut let the background shine through as a hairline, and the curve
 * fitter in the OTF writer moves each layer's edge by up to its tolerance.
 * What you see is still an exact partition of the built silhouette.
 *
 * Pure geometry (no DOM): runs in the pipeline worker and in Node tests.
 */
import polygonClipping from 'polygon-clipping';
import type { ColorSettings, Contour, FontMetrics, Glyph, Stroke, Vec } from '../core/glyph';
import { signedArea, simplifyRDP } from '../core/geometry';
import { expandStroke } from '../outline/strokeExpand';
import { toPolygons } from '../outline/union';
import { fromMulti, intersectRect, unionSets } from '../dna/clip';
import { offsetContours } from '../dna/offset';

type PC = typeof polygonClipping;
const pc: PC = (polygonClipping as any).default ?? polygonClipping;

type P = [number, number];
type Poly = P[][];
type Multi = Poly[];

export interface ColorLayer {
  contours: Contour[];
  /** palette index */
  color: number;
}

export interface ColorGlyph {
  /** painted in order: first = bottom */
  layers: ColorLayer[];
  /** shape for renderers without colour support = union of all layers (also the base glyph's outline / bounding box) */
  fallback: Contour[];
  advance: number;
}

/** most layers one letter may get in `strokes` mode (longer drawings share colours between consecutive strokes) */
export const MAX_STROKE_LAYERS = 12;
/** how far (font units) a layer reaches under its neighbour where the two would only abut */
const UNDERLAP = 3;

const clamp01 = (v: number, fallback = 0.5) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback);

/**
 * Colour layers for one letter, or null when colour is off, the letter has no
 * ink or the palette has fewer than two colours.
 *
 * @param source  the editable glyph (its strokes drive `strokes` mode); may be undefined
 * @param built   the finished shape; every layer is cut from / derived from it
 * @param index   position of the letter in the charset (cycles the palette for one-part letters)
 */
export function colorLayers(
  source: Glyph | undefined,
  built: { advance: number; contours: Contour[] },
  settings: ColorSettings,
  metrics: FontMetrics,
  index: number,
): ColorGlyph | null {
  if (!settings || !settings.enabled) return null;
  const n = Array.isArray(settings.palette) ? settings.palette.length : 0;
  if (n < 2 || !built || !built.contours?.length) return null;
  const polys = toPolygons(built.contours).map(orient);
  const ink = polysToContours(polys);
  if (!ink.length || inkArea(polys) < 1) return null;
  const idx = Number.isFinite(index) ? Math.max(0, Math.floor(index)) : 0;
  const amount = clamp01(settings.amount);

  let glyph: ColorGlyph;
  switch (settings.mode) {
    case 'stripes': glyph = stripes(polys, ink, built.advance, n, amount, metrics); break;
    case 'shadow': glyph = shadow(ink, built.advance, amount); break;
    case 'outline': glyph = outline(polys, ink, built.advance, amount); break;
    default: {
      let layers: ColorLayer[] | null = null;
      const strokes = (source?.kind === 'stroke' ? source.strokes ?? [] : []).filter((s) => s.points?.some((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
      if (strokes.length >= 2) {
        // everything is clipped on a 1/8-unit grid; polygon-clipping can still throw on degenerate
        // input: retry on a coarser grid, then fall back to parts
        try { layers = byStroke(strokes, roundMulti(polys, 8), n); } catch {
          try { layers = byStroke(strokes, roundMulti(polys, 2), n); } catch { layers = null; }
        }
      }
      glyph = { layers: layers ?? byPart(polys, n, idx), fallback: ink, advance: built.advance };
    }
  }
  glyph.layers = glyph.layers.filter((l) => l.contours.length > 0);
  return glyph.layers.length ? glyph : null;
}

/**
 * A colour glyph moved by (dx, dy), optionally with another advance: for copies
 * of a letter that sit elsewhere in their box (tabular figures, centred alternates).
 */
export function moveColorGlyph(glyph: ColorGlyph, dx: number, dy = 0, advance = glyph.advance): ColorGlyph {
  return {
    layers: glyph.layers.map((l) => ({ color: l.color, contours: translate(l.contours, dx, dy) })),
    fallback: translate(glyph.fallback, dx, dy),
    advance,
  };
}

// ---------------------------------------------------------------- strokes

/** how much (font units) a stroke's own ribbon is grown: keeps its edge clear of the built outline it is cut against */
const OWN_GROW = 2;

/**
 * One layer per drawn stroke, later strokes on top. A stroke owns the built
 * ink inside its ribbon; when effects have moved the ink, what lies outside
 * every ribbon goes to the stroke whose fattened ribbon (half-width × 1.5 + 10)
 * reaches it, and anything still unclaimed to the nearest stroke. Parts of the
 * letter smaller than a stroke is wide (dots, crumbs, stipple) are never split.
 */
function byStroke(source: Stroke[], polys: Multi, n: number): ColorLayer[] | null {
  const groups = Math.min(source.length, MAX_STROKE_LAYERS);
  const groupOf = (i: number) => (source.length <= MAX_STROKE_LAYERS ? i : Math.floor((i * groups) / source.length));

  // 1. follow what the effects did to the letter as a whole (shift / stretch / slant / weight)
  const strokes = alignStrokes(source, polys);
  const asDrawn = strokes === source;
  const own = strokes.map((s) => ribbon(s, 1, OWN_GROW, 0.5));
  const ownBox = own.map(boxOf);

  // 2. small parts go whole to the stroke they sit on (the last one drawn there), else the nearest
  let meanW = 0, count = 0;
  for (const s of strokes) for (const p of s.points) { meanW += Math.abs(p.w); count++; }
  const small = 2.2 * (count ? meanW / count : 0);
  const whole: Multi[] = strokes.map(() => []);
  const big: Multi = [];
  for (const poly of polys) {
    const b = boxOf([poly]);
    if (b[2] - b[0] < small && b[3] - b[1] < small) whole[nearestStroke([[(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]], strokes)].push(poly);
    else big.push(poly);
  }

  const parts: Multi[] = strokes.map(() => []);
  if (big.length) {
    const bigBox = boxOf(big);
    let claimed: Multi[];
    if (asDrawn) {
      // 3a. the ink is where it was drawn: layer i = built ∩ ribbon i. Layers overlap where strokes cross.
      claimed = own;
      for (let i = 0; i < strokes.length; i++) if (boxesTouch(ownBox[i], bigBox)) parts[i] = pc.intersection(big, own[i]);
    } else {
      // 3b. effects moved the ink: layer i = built ∩ (ribbon i ∪ (fat ribbon i − ribbons painted before it)),
      //     minus the core of the ribbons painted after it. It runs a few units under later layers and
      //     never over ink an earlier stroke owns.
      const fat = strokes.map((s) => ribbon(s, 1.5, 10, 1.5));
      const core = strokes.map((s) => ribbon(s, 1, -UNDERLAP - 1, 0.5));
      const fatBox = fat.map(boxOf);
      claimed = fat;
      for (let i = 0; i < strokes.length; i++) {
        if (!boxesTouch(fatBox[i], bigBox)) continue;
        const below: Multi[] = [], above: Multi[] = [];
        for (let j = 0; j < i; j++) if (groupOf(j) !== groupOf(i) && boxesTouch(fatBox[i], ownBox[j])) below.push(own[j]);
        for (let j = i + 1; j < strokes.length; j++) if (groupOf(j) !== groupOf(i) && core[j].length && boxesTouch(fatBox[i], ownBox[j])) above.push(core[j]);
        let region = below.length ? pc.union(own[i], pc.difference(fat[i], ...below)) : fat[i];
        if (above.length) region = pc.difference(region, ...above);
        parts[i] = region.length ? pc.intersection(big, region) : [];
      }
    }
    // 4. ink no ribbon claimed: each connected piece joins the nearest stroke, grown a touch so no seam shows
    const rest = pc.difference(big, ...claimed);
    const extra = new Map<number, Multi>();
    for (const piece of rest) {
      if (Math.abs(ringArea(piece[0])) < 1) continue;
      const k = nearestStroke(piece[0], strokes);
      if (!extra.has(k)) extra.set(k, []);
      extra.get(k)!.push(piece);
    }
    for (const [k, pieces] of extra) {
      const grown = toPolygons(offsetContours(polysToContours(pieces.map(orient)), UNDERLAP)) as Multi;
      const inside = grown.length ? pc.intersection(big, grown) : pieces;
      const add = inside.length ? inside : pieces;
      parts[k] = parts[k].length ? pc.union(parts[k], add) : add;
    }
  }

  // 5. strokes sharing a group (very long drawings) merge into one layer
  const layers: ColorLayer[] = [];
  for (let g = 0; g < groups; g++) {
    const mine = parts.filter((m, i) => groupOf(i) === g && m.length);
    const merged = mine.length <= 1 ? mine[0] ?? [] : pc.union(mine[0], ...mine.slice(1));
    const contours = dropSlivers(fromMulti(merged));
    whole.forEach((m, i) => { if (groupOf(i) === g) contours.push(...polysToContours(m)); });
    if (contours.length) layers.push({ contours, color: g % n });
  }
  return layers.length ? layers : null;
}

/**
 * Stroke ribbon as clipping geometry: half-widths × k + add, simplified to `tol`, on a 1/8-unit grid.
 * Empty when a negative `add` leaves nothing of the stroke.
 */
function ribbon(s: Stroke, k: number, add: number, tol: number): Multi {
  let pts = s.points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!pts.length) return [];
  const minW = Math.max(1, Math.min(...pts.map((p) => Math.abs(p.w) || 0.5)));
  if (add < 0 && k === 1 && minW + add < 1.5) return [];
  const spacing = Math.max(5, Math.min(16, minW * 1.1)) * (k > 1 ? 1.5 : 1);
  if (s.cap === 'flat' && k === 1 && add !== 0 && pts.length >= 2) {
    // a flat end does not move with the width: shift the end points along the stroke instead
    const a = pts[0], b = pts[1], y = pts[pts.length - 2], z = pts[pts.length - 1];
    const l0 = Math.hypot(a.x - b.x, a.y - b.y) || 1, l1 = Math.hypot(z.x - y.x, z.y - y.y) || 1;
    if (add > 0 || (l0 > -2 * add && l1 > -2 * add)) {
      pts = pts.slice();
      pts[0] = { ...a, x: a.x + ((a.x - b.x) / l0) * add, y: a.y + ((a.y - b.y) / l0) * add };
      pts[pts.length - 1] = { ...z, x: z.x + ((z.x - y.x) / l1) * add, y: z.y + ((z.y - y.y) / l1) * add };
    }
  }
  const stroke: Stroke = { ...s, cap: k > 1 ? 'round' : s.cap, points: pts.map((p) => ({ ...p, w: Math.max(1, Math.abs(p.w) * k + add) })) };
  const out: Multi = [];
  for (const ring of expandStroke(stroke, { spacing })) {
    if (ring.length < 3) continue;
    const simple = simplifyRDP(ring.concat([ring[0]]), tol);
    simple.pop();
    if (simple.length >= 3) out.push([simple.map((p) => [Math.round(p[0] * 8) / 8, Math.round(p[1] * 8) / 8] as P)]);
  }
  return out;
}

/** The last stroke drawn whose ribbon holds one of `pts`, else the stroke nearest to them. */
function nearestStroke(pts: P[], strokes: Stroke[]): number {
  const step = Math.max(1, Math.floor(pts.length / 24));
  let best = strokes.length - 1, bestD = Infinity;
  for (let s = strokes.length - 1; s >= 0; s--) {
    let d = Infinity;
    for (let i = 0; i < pts.length; i += step) d = Math.min(d, strokeDistance(pts[i][0], pts[i][1], strokes[s]));
    if (d <= 0) return s;
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

/**
 * Carry the drawn strokes onto the built letter. When the built ink still has
 * the drawing's bounding box nothing moved; otherwise fit shift + scale + slant
 * from the area moments of drawn vs built ink (kept only if it really matches
 * the built outline better) and read the change of weight off the outline.
 */
function alignStrokes(source: Stroke[], polys: Multi): Stroke[] {
  const b = boxOf(polys);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of source) for (const p of s.points) {
    const w = Math.abs(p.w);
    if (p.x - w < x0) x0 = p.x - w; if (p.x + w > x1) x1 = p.x + w;
    if (p.y - w < y0) y0 = p.y - w; if (p.y + w > y1) y1 = p.y + w;
  }
  const near = (u: number, v: number) => Math.abs(u - v) < 1.5;
  if (near(b[0], x0) && near(b[1], y0) && near(b[2], x1) && near(b[3], y1)) return source; // (flat / tapered ends fall short of this box and take the fit below)
  const target = moments(polys);
  const carry = (grow: number): Stroke[] | null => {
    const drawn = source.map((s) => ribbon(s, 1, grow, 0.5)).filter((m) => m.length);
    const fit = drawn.length ? fitAffine(moments(drawn.length === 1 ? pc.union(drawn[0]) : pc.union(drawn[0], ...drawn.slice(1))), target) : null;
    if (!fit || fit.identity) return null;
    return source.map((s) => ({ ...s, points: s.points.map((p) => ({ ...p, x: fit.x(p.x, p.y), y: fit.y(p.y), w: Math.abs(p.w) * fit.scale })) }));
  };
  // a candidate placement is better when the built outline runs at a steadier distance from its ribbons
  let best = source, stat = outlineGap(polys, source);
  const consider = (cand: Stroke[] | null) => {
    if (!cand) return;
    const st = outlineGap(polys, cand);
    if (st.spread < stat.spread - 0.5) { best = cand; stat = st; }
  };
  consider(carry(0));
  // bolder ink also reads as "stretched" to the moment fit: fit once more with the weight taken out
  if (Math.abs(stat.gap) >= 1.5) consider(carry(stat.gap));
  const g = stat.gap;
  if (Math.abs(g) < 1.5) return best;
  return best.map((s) => ({ ...s, points: s.points.map((p) => ({ ...p, w: Math.max(2, 0.25 * Math.abs(p.w), Math.abs(p.w) + g) })) }));
}

/**
 * Where the built outline sits relative to the stroke ribbons: `gap` is the
 * upper-quartile signed distance (+ outside: bolder, − inside: thinner; holes
 * punched by effects sit below it), `spread` the mean deviation from it.
 */
function outlineGap(polys: Multi, strokes: Stroke[]): { gap: number; spread: number } {
  let total = 0;
  for (const poly of polys) for (const ring of poly) for (let i = 0; i < ring.length; i++) { const q = ring[(i + 1) % ring.length]; total += Math.hypot(q[0] - ring[i][0], q[1] - ring[i][1]); }
  if (!(total > 0)) return { gap: 0, spread: 0 };
  const step = total / 72;
  const gaps: number[] = [];
  let next = step / 2, walked = 0;
  for (const poly of polys) for (const ring of poly) for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
    while (next <= walked + l && l > 0) {
      const t = (next - walked) / l;
      gaps.push(ribbonDistance(p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, strokes));
      next += step;
    }
    walked += l;
  }
  if (!gaps.length) return { gap: 0, spread: 0 };
  gaps.sort((u, v) => u - v);
  const gap = gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * 0.75))];
  let spread = 0;
  for (const v of gaps) spread += Math.min(80, Math.abs(v - gap));
  return { gap, spread: spread / gaps.length };
}

/** signed distance from a point to the nearest stroke ribbon (negative inside) */
function ribbonDistance(x: number, y: number, strokes: Stroke[]): number {
  let d = Infinity;
  for (const s of strokes) { const e = strokeDistance(x, y, s); if (e < d) d = e; }
  return d;
}

function strokeDistance(x: number, y: number, s: Stroke): number {
  const sp = s.points;
  let d = Infinity;
  for (let k = 0; k < sp.length; k++) {
    const a = sp[k], b = sp[Math.min(k + 1, sp.length - 1)];
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 ? Math.min(1, Math.max(0, ((x - a.x) * dx + (y - a.y) * dy) / l2)) : 0;
    const e = Math.hypot(a.x + dx * t - x, a.y + dy * t - y) - (a.w + (b.w - a.w) * t);
    if (e < d) d = e;
  }
  return d;
}

interface Moments { area: number; cx: number; cy: number; xx: number; xy: number; yy: number }

/** area, centroid and covariance of a (hole-consistent) polygon set */
function moments(m: Multi): Moments | null {
  let a = 0, sx = 0, sy = 0, ixx = 0, ixy = 0, iyy = 0;
  for (const poly of m) for (const ring of poly) {
    for (let i = 0, k = ring.length; i < k; i++) {
      const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % k];
      const c = x0 * y1 - x1 * y0;
      a += c / 2;
      sx += (x0 + x1) * c / 6; sy += (y0 + y1) * c / 6;
      ixx += (x0 * x0 + x0 * x1 + x1 * x1) * c / 12;
      iyy += (y0 * y0 + y0 * y1 + y1 * y1) * c / 12;
      ixy += (x0 * y1 + 2 * x0 * y0 + 2 * x1 * y1 + x1 * y0) * c / 24;
    }
  }
  if (!(a > 1)) return null;
  const cx = sx / a, cy = sy / a;
  return { area: a, cx, cy, xx: ixx / a - cx * cx, xy: ixy / a - cx * cy, yy: iyy / a - cy * cy };
}

/**
 * The shift + scale + slant (x' = a·x + b·y, y' = d·y) that carries the drawn
 * ink's area moments onto the built ink's, so the stroke ribbons follow slant /
 * bounce / stretch effects.
 */
function fitAffine(src: Moments | null, dst: Moments | null): { identity: boolean; scale: number; x: (x: number, y: number) => number; y: (y: number) => number } | null {
  if (!src || !dst) return null;
  const tri = (m: Moments) => {
    const u22 = Math.sqrt(m.yy), u12 = m.xy / u22, u11 = Math.sqrt(m.xx - u12 * u12);
    return { u11, u12, u22 };
  };
  const s = tri(src), t = tri(dst);
  let a = t.u11 / s.u11, d = t.u22 / s.u22, b = (t.u12 - a * s.u12) / s.u22;
  let dx = dst.cx - src.cx, dy = dst.cy - src.cy;
  const sane = [a, b, d].every(Number.isFinite) && a > 0.55 && a < 1.8 && d > 0.55 && d < 1.8 && Math.abs(b) < 1.2;
  if (!sane) { a = 1; b = 0; d = 1; }
  const identity = Math.abs(a - 1) < 0.015 && Math.abs(d - 1) < 0.015 && Math.abs(b) < 0.015 && Math.hypot(dx, dy) < 2;
  if (identity) { a = 1; b = 0; d = 1; dx = 0; dy = 0; }
  return {
    identity,
    scale: Math.sqrt(a * d),
    x: (x, y) => a * (x - src.cx) + b * (y - src.cy) + src.cx + dx,
    y: (y) => d * (y - src.cy) + src.cy + dy,
  };
}

// ---------------------------------------------------------------- parts

/** Connected parts (an outer contour with its holes) cycle the palette, starting at the letter's own colour. */
function byPart(polys: Multi, n: number, index: number): ColorLayer[] {
  const keyed = polys.map((poly) => { const b = boxOf([poly]); return { poly, col: Math.round(b[0] / 20), top: b[3] }; });
  keyed.sort((p, q) => p.col - q.col || q.top - p.top);
  const byColor = new Map<number, Multi>();
  keyed.forEach(({ poly }, k) => {
    const c = (index + k) % n;
    if (!byColor.has(c)) byColor.set(c, []);
    byColor.get(c)!.push(poly);
  });
  return [...byColor].map(([color, m]) => ({ color, contours: polysToContours(m) }));
}

// ---------------------------------------------------------------- stripes

/** number of bands between descender and ascender */
export function stripeCount(amount: number): number {
  return 2 + Math.round(clamp01(amount) * 10);
}

/**
 * Horizontal bands on a grid shared by every letter: band 0 hangs from the
 * ascender, the last one sits on the descender, and the grid simply continues
 * for ink beyond either line. One layer per colour.
 */
function stripes(polys: Multi, ink: Contour[], advance: number, n: number, amount: number, metrics: FontMetrics): ColorGlyph {
  const top = metrics.ascender, bottom = Math.min(metrics.descender, top - 1);
  const h = (top - bottom) / stripeCount(amount);
  const colorOf = (k: number) => ((k % n) + n) % n;
  const rows = (b: Box): [number, number] => [Math.floor((top - b[3]) / h), Math.ceil((top - b[1]) / h) - 1];
  // parts that sit inside one band keep their shape; only the ones crossing a band edge are cut
  const whole: Multi[] = Array.from({ length: n }, () => []);
  const cross: Multi = [];
  for (const poly of polys) {
    const [k0, k1] = rows(boxOf([poly]));
    if (k0 >= k1) whole[colorOf(k0)].push(poly); else cross.push(poly);
  }
  const bands: [number, number][][] = Array.from({ length: n }, () => []);
  let x0 = 0, x1 = 0;
  if (cross.length) {
    const b = boxOf(cross);
    x0 = b[0] - 10; x1 = b[2] + 10;
    const [first, last] = rows(b);
    for (let k = first; k <= last; k++) {
      const c = colorOf(k);
      // a band reaches under the neighbours painted after it (higher colour index), so no seam shows
      bands[c].push([top - (k + 1) * h - (c < n - 1 ? UNDERLAP : 0), top - k * h + (c === 0 ? UNDERLAP : 0)]);
    }
  }
  const layers = bands.map((list, color) => {
    let contours: Contour[] = [];
    if (list.length) {
      try {
        // one cut per colour: its bands never touch each other
        contours = fromMulti(pc.intersection(cross, list.map(([y0, y1]) => [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as P[]])));
      } catch {
        const crossing = polysToContours(cross);
        contours = list.flatMap(([y0, y1]) => intersectRect(crossing, y0, y1, x0, x1));
      }
    }
    return { contours: [...dropSlivers(contours), ...polysToContours(whole[color])], color };
  });
  return { layers, fallback: ink, advance };
}

// ---------------------------------------------------------------- shadow / outline

/** drop-shadow offset in font units (right and down) */
export function shadowOffset(amount: number): number {
  return 10 + clamp01(amount) * 70;
}
/** rim thickness in font units */
export function outlineThickness(amount: number): number {
  return 8 + clamp01(amount) * 40;
}

function shadow(ink: Contour[], advance: number, amount: number): ColorGlyph {
  const d = shadowOffset(amount);
  const cast = translate(ink, d, -d);
  return {
    layers: [{ contours: cast, color: 1 }, { contours: ink, color: 0 }],
    fallback: unionSets([ink, cast]),
    advance: advance + d,
  };
}

function outline(polys: Multi, ink: Contour[], advance: number, amount: number): ColorGlyph {
  const t = outlineThickness(amount);
  // Parts no bigger than the rim is thick (dots, crumbs, stipple) swell into their convex hull grown
  // by t, which needs no clipping; everything else takes the general round offset.
  const large: Multi = [], swollen: Multi = [];
  for (const poly of polys) {
    const b = boxOf([poly]);
    if (b[2] - b[0] <= 2 * t && b[3] - b[1] <= 2 * t) swollen.push([grownHull(poly[0], t)]); else large.push(poly);
  }
  let rim: Contour[] | null = null;
  if (swollen.length || large.length > 3) {
    try {
      // offsetting many parts in one go is far slower than one at a time plus a single union
      const grow = (m: Multi) => toPolygons(offsetContours(polysToContours(m), t)) as Multi;
      const pieces: Multi[] = large.length > 3 ? large.map((poly) => grow([poly])) : large.length ? [grow(large)] : [];
      if (swollen.length) pieces.push(swollen);
      rim = fromMulti(pieces.length === 1 && pieces[0].length === 1 ? pieces[0] : pc.union(pieces[0], ...pieces.slice(1)));
    } catch { rim = null; }
  }
  rim ??= offsetContours(ink, t);
  // everything moves right by t so the rim stays clear of the left sidebearing
  rim = translate(dropSlivers(rim), t, 0);
  return {
    layers: [{ contours: rim, color: 1 }, { contours: translate(ink, t, 0), color: 0 }],
    fallback: rim,
    advance: advance + 2 * t,
  };
}

/** Convex hull of a ring grown by r with round corners (counter-clockwise). */
function grownHull(ring: P[], r: number): P[] {
  const pts = ring.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: P, a: P, b: P) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const hull: P[] = [];
  for (const p of pts) { while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], p) <= 0) hull.pop(); hull.push(p); }
  const lower = hull.length + 1;
  for (let i = pts.length - 2; i >= 0; i--) { const p = pts[i]; while (hull.length >= lower && cross(hull[hull.length - 2], hull[hull.length - 1], p) <= 0) hull.pop(); hull.push(p); }
  hull.pop();
  const n = hull.length;
  const step = Math.PI / 6;
  const out: P[] = [];
  if (n < 2) {
    const c = hull[0] ?? ring[0];
    for (let a = 0; a < 2 * Math.PI - 1e-9; a += step) out.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]);
    return out;
  }
  // outward normal of the edge leaving vertex i (the hull runs counter-clockwise)
  const angle = (i: number) => { const a = hull[i], b = hull[(i + 1) % n]; return Math.atan2(b[1] - a[1], b[0] - a[0]) - Math.PI / 2; };
  for (let i = 0; i < n; i++) {
    const a0 = angle((i + n - 1) % n);
    let turn = angle(i) - a0;
    while (turn < 0) turn += 2 * Math.PI;
    const steps = Math.max(1, Math.ceil(turn / step - 1e-9));
    // (the arc's first point is the end of the previous edge's offset; coincident points are fine)
    for (let k = 0; k <= steps; k++) { const a = a0 + (turn * k) / steps; out.push([hull[i][0] + Math.cos(a) * r, hull[i][1] + Math.sin(a) * r]); }
  }
  const simple = simplifyRDP(out.concat([out[0]]) as Vec[], 0.4) as P[];
  simple.pop();
  return simple.length >= 3 ? simple : out;
}

// ---------------------------------------------------------------- helpers

const translate = (cs: Contour[], dx: number, dy: number): Contour[] =>
  cs.map((c) => ({ points: c.points.map(([x, y]) => [x + dx, y + dy] as Vec) }));

const ringArea = (r: P[]) => signedArea(r as Vec[]);

/** outer ring counter-clockwise, holes clockwise */
function orient(poly: Poly): Poly {
  return poly.map((ring, i) => ((ringArea(ring) > 0) === (i === 0) ? ring : ring.slice().reverse()));
}

function polysToContours(m: Multi): Contour[] {
  const out: Contour[] = [];
  for (const poly of m) for (const ring of poly) if (ring.length >= 3) out.push({ points: ring.map((p) => [p[0], p[1]] as Vec) });
  return out;
}

function inkArea(m: Multi): number {
  let a = 0;
  for (const poly of m) for (const ring of poly) a += ringArea(ring);
  return a;
}

/** crumbs a renderer would not show anyway (kept tiny so no visible ink goes missing) */
function dropSlivers(cs: Contour[], minArea = 2): Contour[] {
  return cs.filter((c) => c.points.length >= 3 && Math.abs(signedArea(c.points)) >= minArea);
}

type Box = [number, number, number, number];
function boxOf(m: Multi): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const poly of m) for (const [x, y] of poly[0] ?? []) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}
const boxesTouch = (a: Box, b: Box) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

const roundMulti = (m: Multi, grid: number): Multi => m.map((poly) => poly.map((r) => r.map(([x, y]) => [Math.round(x * grid) / grid, Math.round(y * grid) / grid] as P)));

