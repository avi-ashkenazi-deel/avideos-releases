/**
 * Knife tool: drag a line across a letter to cut it apart.
 *
 * The cut runs along the dragged SEGMENT a → b, extended by 5 % at both ends
 * (so a drag that starts or stops right on an edge still counts). Nothing
 * outside that extent is touched.
 *
 * Strokes — every stroke whose centreline crosses the segment is split at the
 * crossing(s) into separate strokes (new ids, the cut point and its width are
 * interpolated). With a gap, each new end is pulled back along the stroke by
 * gap / 2, plus the stroke's half width when the cap is round, so the visible
 * gap between the two caps is `gap`.
 *
 * Outlines — contours are grouped into parts (an outer contour with its
 * holes, by nesting, like the build does). Along the cut line each part is
 * crossed in zero or more spans of ink; only spans the segment passes FULLY
 * through are cut (a knife that stops inside the ink leaves that span alone,
 * so a short cut through one stem never slices the rest of the letter).
 *
 *  - gap = 0: exact surgery on the curves, no boolean operation and no
 *    refitting. The crossed segments are split where the line meets them (de
 *    Casteljau) and the loops are re-linked along the chord: two cut points
 *    on the same loop split it in two; cut points on different loops (outer
 *    and counter, the side of an "o") join them into one loop with a
 *    zero-width seam. The pieces touch exactly, so the built letter looks the
 *    same (the union at build time closes the seam) but the pieces are now
 *    separate shapes in Edit points.
 *  - gap > 0: a slit `gap` wide is subtracted from the flattened part along
 *    the fully crossed spans (polygon-clipping; spans that follow one another
 *    share one slit, straight across the counter between them) and, when the
 *    letter has editable curves, new curves are fitted to the pieces.
 *    Untouched parts keep their curves as they are.
 *
 * When the letter has `curves`, `contours` is re-flattened from them
 * afterwards; a letter without curves stays a plain polygon outline.
 *
 * `knifeCut` / `knifeGlyph` / `knifeMarks` are pure (unit-tested); `KnifeTool`
 * adds the pointer handling and the overlay.
 */
import polygonClipping from 'polygon-clipping';
import type { Glyph, Stroke, StrokePoint, Vec, Contour, CurveContour } from '../../core/glyph';
import { cloneGlyph, uid } from '../../core/glyph';
import { dedupe, signedArea, pointInPolygon } from '../../core/geometry';
import { isLine, type Cubic } from '../../outline/fitCurves';
import { fromMulti } from '../../dna/clip';
import type { View } from '../../ui/render';
import { cubicAt, curvesFromContours, flattenCurves, lineSegment, normaliseContour, splitCubic } from './curves';
import { cssAccent, drawPill, toCanvas, toFont, withAlpha } from './shapes';

type PC = typeof polygonClipping;
const pc: PC = (polygonClipping as any).default ?? polygonClipping;

/** The cut reaches this fraction of the dragged length beyond both ends. */
export const KNIFE_EXTEND = 0.05;
/** Gap left by an Alt-cut, in font units. */
export const KNIFE_GAP = 24;
/** Drags shorter than this many canvas pixels are ignored. */
export const KNIFE_MIN_DRAG = 4;

/** flattening used for grouping, slits and the re-flattened `contours` (same as the pen tool) */
const STEPS = 16;
/** spans of ink (and stubs of stroke) shorter than this, in font units, are not worth a cut */
const MIN_SPAN = 0.5;

// ---------------------------------------------------------------- the cut line

/** The dragged segment: point(t) = a + d·t, t in 0..1 along the drag. */
interface Line { a: Vec; d: Vec; len: number }

function lineOf(a: Vec, b: Vec): Line | null {
  const d: Vec = [b[0] - a[0], b[1] - a[1]];
  const len = Math.hypot(d[0], d[1]);
  return len > 1e-6 ? { a: [a[0], a[1]], d, len } : null;
}
/** signed distance from the line, positive on its left */
const side = (L: Line, x: number, y: number) => (L.d[0] * (y - L.a[1]) - L.d[1] * (x - L.a[0])) / L.len;
const along = (L: Line, x: number, y: number) => ((x - L.a[0]) * L.d[0] + (y - L.a[1]) * L.d[1]) / (L.len * L.len);
const at = (L: Line, t: number): Vec => [L.a[0] + L.d[0] * t, L.a[1] + L.d[1] * t];
const reached = (t: number) => t >= -KNIFE_EXTEND - 1e-9 && t <= 1 + KNIFE_EXTEND + 1e-9;
const round1 = (v: number) => Math.round(v * 10) / 10;

// ---------------------------------------------------------------- strokes

interface StrokeHit { s: number; w: number; point: Vec }

function cumLengths(pts: StrokePoint[]): number[] {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  return cum;
}

/** Where the cut segment crosses the stroke's centreline: arc position, half width and point. */
function strokeHits(pts: StrokePoint[], cum: number[], L: Line): StrokeHit[] {
  const hits: StrokeHit[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const p = pts[i], q = pts[i + 1];
    const f0 = side(L, p.x, p.y), f1 = side(L, q.x, q.y);
    if ((f0 >= 0) === (f1 >= 0)) continue;
    const u = f0 / (f0 - f1);
    const x = p.x + (q.x - p.x) * u, y = p.y + (q.y - p.y) * u;
    if (!reached(along(L, x, y))) continue;
    hits.push({ s: cum[i] + (cum[i + 1] - cum[i]) * u, w: p.w + (q.w - p.w) * u, point: [x, y] });
  }
  hits.sort((m, n) => m.s - n.s);
  const total = cum[cum.length - 1];
  // a crossing at the very tip leaves nothing to split off; near-coincident crossings count once
  return hits.filter((hit, i) => hit.s > MIN_SPAN && hit.s < total - MIN_SPAN && (i === 0 || hit.s - hits[i - 1].s > 0.01));
}

function strokePointAt(pts: StrokePoint[], cum: number[], s: number): StrokePoint {
  const n = pts.length;
  if (s <= 0) return { ...pts[0] };
  if (s >= cum[n - 1]) return { ...pts[n - 1] };
  let i = 0;
  while (i + 2 < n && cum[i + 1] < s) i++;
  const a = pts[i], b = pts[i + 1];
  const u = (s - cum[i]) / ((cum[i + 1] - cum[i]) || 1);
  const out: StrokePoint = { x: round1(a.x + (b.x - a.x) * u), y: round1(a.y + (b.y - a.y) * u), w: round1(a.w + (b.w - a.w) * u) };
  if (a.p !== undefined) out.p = a.p;
  return out;
}

function sliceStroke(pts: StrokePoint[], cum: number[], s0: number, s1: number): StrokePoint[] {
  const out = [strokePointAt(pts, cum, s0)];
  for (let i = 0; i < pts.length; i++) if (cum[i] > s0 + 1e-6 && cum[i] < s1 - 1e-6) out.push({ ...pts[i] });
  out.push(strokePointAt(pts, cum, s1));
  return out;
}

/** The pieces of a stroke cut by the line (null when the line does not cross its centreline). */
function splitStroke(st: Stroke, L: Line, gap: number): Stroke[] | null {
  const pts = st.points;
  if (pts.length < 2) return null; // a dot has no centreline to cross
  const cum = cumLengths(pts);
  const total = cum[cum.length - 1];
  const hits = strokeHits(pts, cum, L);
  if (!hits.length) return null;
  const bounds: [number, number][] = [];
  let from = 0;
  hits.forEach((hit, i) => {
    const first = i === 0, last = i === hits.length - 1;
    const before = hit.s - (first ? 0 : hits[i - 1].s), after = (last ? total : hits[i + 1].s) - hit.s;
    const pull = gap > 0 ? gap / 2 + (st.cap === 'round' ? hit.w : 0) : 0;
    // never pull a piece away completely: a short stub keeps part of its length
    bounds.push([from, hit.s - Math.min(pull, before * (first ? 0.8 : 0.4))]);
    from = hit.s + Math.min(pull, after * (last ? 0.8 : 0.4));
  });
  bounds.push([from, total]);
  return bounds.map(([s0, s1]) => ({ ...st, id: uid('s'), points: sliceStroke(pts, cum, s0, s1) }));
}

// ---------------------------------------------------------------- outlines: analysis

/** One original contour: its closed chain of cubics and its flattening (null when degenerate). */
interface Source { segs: Cubic[] | null; flat: Vec[] | null }
interface Crossing { t: number; ring: number; seg: number; u: number }
/** A stretch of the cut line inside one part's ink, from crossing c0 to crossing c1. */
interface Span { t0: number; t1: number; c0: Crossing; c1: Crossing; complete: boolean }
/** An outer contour (members[0]) with its holes, as indices into the sources. */
interface Part { members: number[]; spans: Span[] }
interface Analysis { hasCurves: boolean; sources: Source[]; parts: Part[] }

function flatOf(segs: Cubic[]): Vec[] | null {
  if (!segs.length) return null;
  const f = flattenCurves([{ start: segs[0][0], segments: segs }], STEPS)[0];
  return f && Math.abs(signedArea(f.points)) > 1e-6 ? f.points : null;
}

function sourcesOf(g: Glyph): { hasCurves: boolean; sources: Source[] } {
  if (g.curves?.length) {
    return { hasCurves: true, sources: g.curves.map((c) => { const segs = normaliseContour(c).segments as Cubic[]; return segs.length ? { segs, flat: flatOf(segs) } : { segs: null, flat: null }; }) };
  }
  return {
    hasCurves: false,
    sources: (g.contours ?? []).map((c) => {
      const pts = dedupe(c.points, 1e-6);
      if (pts.length < 3) return { segs: null, flat: null };
      const segs = pts.map((p, i) => lineSegment(p, pts[(i + 1) % pts.length]) as Cubic);
      return { segs, flat: flatOf(segs) };
    }),
  };
}

/** a point just inside `ring` next to the edge a → b (its first edge by default), exactly as the build probes it */
function probePoint(edge: Vec[], ring: Vec[] = edge): Vec {
  const a = edge[0], b = edge[1];
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1;
  const p: Vec = [mx - (dy / l) * 0.01, my + (dx / l) * 0.01];
  return pointInPolygon(p, ring) ? p : [mx + (dy / l) * 0.01, my - (dx / l) * 0.01];
}

/**
 * Group contours into parts by nesting depth, the way the build does
 * (outline/union.ts `toPolygons`): even depth = an outer, the contours one
 * level inside it = its holes. Contours that fit nowhere stay out of every
 * part and are never cut.
 */
function groupParts(flats: (Vec[] | null)[]): number[][] {
  const idx = flats.map((_, i) => i).filter((i) => flats[i]);
  const area = new Map(idx.map((i) => [i, Math.abs(signedArea(flats[i]!))]));
  const depth = new Map<number, number>(), parent = new Map<number, number>();
  for (const i of idx) {
    const probe = probePoint(flats[i]!);
    let d = 0, best = -1;
    for (const j of idx) {
      if (i === j || area.get(j)! <= area.get(i)!) continue;
      if (pointInPolygon(probe, flats[j]!)) { d++; if (best < 0 || area.get(j)! < area.get(best)!) best = j; }
    }
    depth.set(i, d); parent.set(i, best);
  }
  const parts: number[][] = [];
  for (const i of idx) {
    if (depth.get(i)! % 2) continue;
    parts.push([i, ...idx.filter((j) => parent.get(j) === i && depth.get(j) === depth.get(i)! + 1)]);
  }
  return parts;
}

/** Parameters u in 0..1 where a cubic changes side of the line. A point on the line counts as left, so loops always cross an even number of times. */
function segCrossings(seg: Cubic, L: Line): number[] {
  const f = (p: Vec) => side(L, p[0], p[1]);
  let f0 = f(seg[0]);
  // all four control points on one side: the curve (inside their hull) cannot cross
  if (seg.every((p) => (f(p) >= 0) === (f0 >= 0))) return [];
  // (straight segments go the same way: a canonical line c1 = p0, c2 = p3 is not linear in u, and the split below is by u)
  const out: number[] = [];
  const N = 24;
  let u0 = 0;
  for (let i = 1; i <= N; i++) {
    const u1 = i / N, f1 = f(i === N ? seg[3] : cubicAt(seg, u1));
    if ((f0 >= 0) !== (f1 >= 0)) {
      let lo = u0, hi = u1;
      for (let k = 0; k < 40; k++) {
        const m = (lo + hi) / 2;
        if ((f(cubicAt(seg, m)) >= 0) === (f0 >= 0)) lo = m; else hi = m;
      }
      out.push((lo + hi) / 2);
    }
    u0 = u1; f0 = f1;
  }
  return out;
}

/** The stretches of the cut line that lie inside one part's ink (even–odd along the line). */
function spansOf(rings: Cubic[][], L: Line): Span[] {
  const cs: Crossing[] = [];
  rings.forEach((segs, ring) => segs.forEach((seg, si) => {
    for (const u of segCrossings(seg, L)) { const p = cubicAt(seg, u); cs.push({ t: along(L, p[0], p[1]), ring, seg: si, u }); }
  }));
  if (cs.length % 2) return []; // cannot happen for closed loops; refuse to guess
  cs.sort((m, n) => m.t - n.t);
  const spans: Span[] = [];
  for (let i = 0; i + 1 < cs.length; i += 2) {
    const prev = spans[spans.length - 1];
    // the line only grazes the edge between two spans: treat them as one
    if (prev && (cs[i].t - prev.t1) * L.len < MIN_SPAN) { prev.t1 = cs[i + 1].t; prev.c1 = cs[i + 1]; }
    else spans.push({ t0: cs[i].t, t1: cs[i + 1].t, c0: cs[i], c1: cs[i + 1], complete: false });
  }
  const out = spans.filter((s) => (s.t1 - s.t0) * L.len >= MIN_SPAN);
  for (const s of out) s.complete = reached(s.t0) && reached(s.t1);
  return out;
}

function analyse(g: Glyph, L: Line): Analysis {
  const { hasCurves, sources } = sourcesOf(g);
  const parts = groupParts(sources.map((s) => s.flat)).map((members) => ({ members, spans: spansOf(members.map((i) => sources[i].segs!), L) }));
  return { hasCurves, sources, parts };
}

// ---------------------------------------------------------------- outlines: exact cut (gap = 0)

/** A loop being cut: tags[i] is the id of the cut point sitting at the start of segs[i] (-1 = none). */
interface Loop { segs: Cubic[]; tags: number[] }
interface CutPoint { seg: number; u: number; id: number }

const U_EPS = 1e-6;

/** Split a loop's segments at the cut points and tag the vertices they land on. */
function splitLoop(segs: Cubic[], cuts: CutPoint[]): Loop {
  const out: Cubic[] = [], tags: number[] = [];
  let carry = -1; // a cut at the very end of a segment tags the start of the next one
  for (let si = 0; si < segs.length; si++) {
    const list = cuts.filter((c) => c.seg === si).sort((m, n) => m.u - n.u);
    let rest = segs[si], base = 0, tag = carry;
    carry = -1;
    for (const c of list) {
      if (c.u - base < U_EPS) { if (tag < 0) tag = c.id; continue; }
      if (c.u > 1 - U_EPS) { if (carry < 0) carry = c.id; continue; }
      const [head, tail] = splitCubic(rest, (c.u - base) / (1 - base));
      out.push(head); tags.push(tag);
      rest = tail; base = c.u; tag = c.id;
    }
    out.push(rest); tags.push(tag);
  }
  if (carry >= 0 && tags.length && tags[0] < 0) tags[0] = carry;
  return { segs: out, tags };
}

/** Segments (and tags) from vertex `from` round to vertex `to`; the whole loop when from === to. */
function arc(loop: Loop, from: number, to: number): Loop {
  const n = loop.segs.length, segs: Cubic[] = [], tags: number[] = [];
  let i = from;
  do { segs.push(loop.segs[i]); tags.push(loop.tags[i]); i = (i + 1) % n; } while (i !== to);
  tags[0] = -1; // the cut point at its start has been used
  return { segs, tags };
}

/** Cut the loops of one part along the fully crossed spans; the pieces touch along the chords. */
function cutExact(rings: Cubic[][], spans: Span[]): Cubic[][] {
  const cuts: CutPoint[][] = rings.map(() => []);
  spans.forEach((s, k) => {
    cuts[s.c0.ring].push({ seg: s.c0.seg, u: s.c0.u, id: 2 * k });
    cuts[s.c1.ring].push({ seg: s.c1.seg, u: s.c1.u, id: 2 * k + 1 });
  });
  let loops = rings.map((segs, r) => splitLoop(segs, cuts[r]));
  const find = (id: number) => { for (const loop of loops) { const i = loop.tags.indexOf(id); if (i >= 0) return { loop, i }; } return null; };
  spans.forEach((_, k) => {
    const p = find(2 * k), q = find(2 * k + 1);
    if (!p || !q) return; // two cuts on one vertex: leave this span alone
    const P = p.loop.segs[p.i][0], Q = q.loop.segs[q.i][0];
    if (p.loop === q.loop) {
      if (p.i === q.i) return;
      // same loop: the chord splits it in two
      const one = arc(p.loop, p.i, q.i), two = arc(p.loop, q.i, p.i);
      one.segs.push(lineSegment(Q, P)); one.tags.push(-1);
      two.segs.push(lineSegment(P, Q)); two.tags.push(-1);
      loops = loops.filter((l) => l !== p.loop).concat([one, two]);
    } else {
      // different loops (outer and hole): the chord joins them into one loop with a zero-width seam
      const one = arc(p.loop, p.i, p.i), two = arc(q.loop, q.i, q.i);
      const merged: Loop = {
        segs: [...one.segs, lineSegment(P, Q), ...two.segs, lineSegment(Q, P)],
        tags: [...one.tags, -1, ...two.tags, -1],
      };
      loops = loops.filter((l) => l !== p.loop && l !== q.loop).concat([merged]);
    }
  });
  return safeStarts(loops.map((l) => l.segs).filter((segs) => { const f = flatOf(segs); return !!f && Math.abs(signedArea(f)) > 0.5; }), rings[0]);
}

/**
 * Rotate each cut loop so it starts on a good edge. The build decides what is
 * ink and what is a counter by testing ONE point next to a contour's first
 * edge against the other contours (outline/union.ts `toPolygons`). A loop left
 * starting at the cut point can have that point land inside its neighbour when
 * the source outline overlaps itself there (imported fonts do), and the build
 * would then punch the piece out as a hole. So: start on the longest edge
 * whose test point nests the way the piece should (a piece wound like the
 * part's outer contour is ink, one wound the other way is a counter).
 */
function safeStarts(loops: Cubic[][], outer: Cubic[]): Cubic[][] {
  const flats = loops.map((segs) => flatOf(segs)!);
  const areas = flats.map((f) => signedArea(f));
  const outerFlat = flatOf(outer);
  const outerSign = Math.sign(outerFlat ? signedArea(outerFlat) : 1);
  const firstEdgeEnd = (seg: Cubic): Vec => (isLine(seg) ? seg[3] : cubicAt(seg, 1 / STEPS));
  return loops.map((segs, i) => {
    const want = Math.sign(areas[i]) === outerSign ? 0 : 1;
    const order = segs.map((seg, k) => ({ k, len: Math.hypot(firstEdgeEnd(seg)[0] - seg[0][0], firstEdgeEnd(seg)[1] - seg[0][1]) })).sort((m, n) => n.len - m.len).slice(0, 16);
    let pick = order[0].k;
    for (const { k, len } of order) {
      if (len < 0.05) break;
      const probe = probePoint([segs[k][0], firstEdgeEnd(segs[k])], flats[i]);
      let depth = 0;
      for (let j = 0; j < loops.length; j++) if (j !== i && Math.abs(areas[j]) > Math.abs(areas[i]) && pointInPolygon(probe, flats[j])) depth++;
      if (depth % 2 === want) { pick = k; break; }
    }
    return segs.slice(pick).concat(segs.slice(0, pick));
  });
}

// ---------------------------------------------------------------- outlines: cut with a gap

/**
 * Subtract a slit `gap` wide from one part (outer first, then its holes).
 * `all` are the part's spans along the line, in order. Fully crossed spans
 * that follow one another share one slit, so the knife also clears ink that
 * sits beside the line where it passes through a counter between them.
 */
function cutGap(flats: Vec[][], all: Span[], L: Line, gap: number): Contour[] | null {
  const ux = L.d[0] / L.len, uy = L.d[1] / L.len, hw = gap / 2;
  const runs: { first: number; last: number }[] = [];
  all.forEach((s, i) => {
    if (!s.complete) return;
    const run = runs[runs.length - 1];
    if (run && run.last === i - 1) run.last = i; else runs.push({ first: i, last: i });
  });
  const slits = runs.map(({ first, last }) => {
    // run past the edges so an oblique edge is cleared across the whole width, without reaching into a neighbouring span the knife did not pass through
    const prev = all[first - 1], next = all[last + 1];
    const m0 = prev ? Math.min(gap, ((all[first].t0 - prev.t1) * L.len) / 2) : gap;
    const m1 = next ? Math.min(gap, ((next.t0 - all[last].t1) * L.len) / 2) : gap;
    const p = at(L, all[first].t0), q = at(L, all[last].t1);
    const p0: Vec = [p[0] - ux * m0, p[1] - uy * m0], q0: Vec = [q[0] + ux * m1, q[1] + uy * m1];
    return [[[p0[0] + uy * hw, p0[1] - ux * hw], [q0[0] + uy * hw, q0[1] - ux * hw], [q0[0] - uy * hw, q0[1] + ux * hw], [p0[0] - uy * hw, p0[1] + ux * hw]]] as [number, number][][];
  });
  const poly = flats.map((r) => r.map((p) => [p[0], p[1]] as [number, number]));
  const snap = (rings: [number, number][][]) => rings.map((r) => r.map(([x, y]) => [Math.round(x * 4) / 4, Math.round(y * 4) / 4] as [number, number]));
  for (const prep of [(r: [number, number][][]) => r, snap]) {
    try { return fromMulti(pc.difference([prep(poly)], ...slits.map((s) => [prep(s)]))); } catch { /* degenerate input: retry on a coarser grid */ }
  }
  return null;
}

// ---------------------------------------------------------------- outlines: apply

/** Cut the outline of `g` in place; returns how many parts were cut. */
function cutOutline(g: Glyph, L: Line, gap: number): number {
  const { hasCurves, sources, parts } = analyse(g, L);
  const newCurves = new Map<number, CurveContour[]>(), newContours = new Map<number, Contour[]>();
  const gone = new Set<number>();
  for (const part of parts) {
    const spans = part.spans.filter((s) => s.complete);
    if (!spans.length) continue;
    const outer = part.members[0];
    if (gap > 0) {
      const pieces = cutGap(part.members.map((i) => sources[i].flat!), part.spans, L, gap);
      if (!pieces) continue;
      if (hasCurves) newCurves.set(outer, curvesFromContours(pieces)); else newContours.set(outer, pieces);
    } else {
      const loops = cutExact(part.members.map((i) => sources[i].segs!), spans);
      if (hasCurves) newCurves.set(outer, loops.map((segs) => normaliseContour({ start: segs[0][0], segments: segs })));
      else newContours.set(outer, loops.map((segs) => ({ points: dedupe(segs.map((s) => [s[0][0], s[0][1]] as Vec), 1e-6) })));
    }
    for (const i of part.members) gone.add(i);
  }
  if (!gone.size) return 0;
  if (hasCurves) {
    g.curves = g.curves!.flatMap((c, i) => newCurves.get(i) ?? (gone.has(i) ? [] : [c]));
    g.contours = flattenCurves(g.curves, STEPS);
  } else {
    g.contours = (g.contours ?? []).flatMap((c, i) => newContours.get(i) ?? (gone.has(i) ? [] : [c]));
  }
  return newCurves.size + newContours.size;
}

// ---------------------------------------------------------------- public API

export interface KnifeResult {
  glyph: Glyph;
  /** strokes that were split */
  strokes: number;
  /** outline parts (an outer contour with its holes) that were cut */
  parts: number;
}

/**
 * Cut `g` along the segment a → b (font units), leaving `gap` units between
 * the pieces. The input is not mutated. Null when nothing was cut.
 */
export function knifeCut(g: Glyph, a: Vec, b: Vec, gap = 0): KnifeResult | null {
  const L = lineOf(a, b);
  if (!L) return null;
  const out = cloneGlyph(g);
  let strokes = 0;
  if (out.strokes?.length) {
    out.strokes = out.strokes.flatMap((st) => {
      const pieces = splitStroke(st, L, Math.max(0, gap));
      if (!pieces) return [st];
      strokes++;
      return pieces;
    });
  }
  const parts = out.kind === 'outline' ? cutOutline(out, L, Math.max(0, gap)) : 0;
  return strokes + parts ? { glyph: out, strokes, parts } : null;
}

/** `knifeCut` without the counts: the cut glyph, or null when nothing was cut. */
export function knifeGlyph(g: Glyph, a: Vec, b: Vec, gap = 0): Glyph | null {
  return knifeCut(g, a, b, gap)?.glyph ?? null;
}

/** Where a cut along a → b would land: stroke crossings and the ends of each outline span (for the tool's preview). */
export function knifeMarks(g: Glyph, a: Vec, b: Vec): { points: Vec[]; spans: [Vec, Vec][] } {
  const points: Vec[] = [], spans: [Vec, Vec][] = [];
  const L = lineOf(a, b);
  if (!L) return { points, spans };
  for (const st of g.strokes ?? []) {
    if (st.points.length < 2) continue;
    for (const hit of strokeHits(st.points, cumLengths(st.points), L)) points.push(hit.point);
  }
  if (g.kind === 'outline') {
    for (const part of analyse(g, L).parts) for (const s of part.spans) {
      if (!s.complete) continue;
      const p = at(L, s.t0), q = at(L, s.t1);
      points.push(p, q); spans.push([p, q]);
    }
  }
  return { points, spans };
}

// ---------------------------------------------------------------- DOM tool

export interface KnifeToolOptions {
  /** the letter under the knife (for the preview ticks) */
  getGlyph: () => Glyph | null | undefined;
  /** the drag ended: cut along a → b (font units) leaving `gap` units */
  onCut: (a: Vec, b: Vec, gap: number) => void;
  /** ask the host to repaint (it calls `draw` from its overlay) */
  redraw: () => void;
  /** gap left when Alt is held, in font units (default 24) */
  gap?: number;
  /** shortest drag that counts, in canvas pixels (default 4) */
  minDrag?: number;
}

interface KnifeDrag { startPx: Vec; curPx: Vec; alt: boolean; pointerId: number }

export class KnifeTool {
  readonly canvas: HTMLCanvasElement;
  private getView: () => View;
  private opts: KnifeToolOptions;
  private on = false;
  private drag: KnifeDrag | null = null;
  private accent = '#ffd166';

  constructor(canvas: HTMLCanvasElement, getView: () => View, opts: KnifeToolOptions) {
    this.canvas = canvas;
    this.getView = getView;
    this.opts = opts;
  }

  get enabled(): boolean { return this.on; }
  /** a cut line is being dragged right now */
  get dragging(): boolean { return this.drag !== null; }
  private get gap(): number { return this.opts.gap ?? KNIFE_GAP; }

  enable(): void {
    if (this.on) return;
    this.on = true;
    this.accent = cssAccent();
    this.canvas.addEventListener('pointerdown', this.onDown);
    this.canvas.addEventListener('pointermove', this.onMove);
    this.canvas.addEventListener('pointerup', this.onUp);
    this.canvas.addEventListener('pointercancel', this.onCancel);
    window.addEventListener('keydown', this.onModifier);
    window.addEventListener('keyup', this.onModifier);
    this.opts.redraw();
  }

  disable(): void {
    if (!this.on) return;
    this.on = false;
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointercancel', this.onCancel);
    window.removeEventListener('keydown', this.onModifier);
    window.removeEventListener('keyup', this.onModifier);
    this.release();
    this.opts.redraw();
  }

  /** Drop the cut line being dragged. */
  cancel(): void {
    if (!this.drag) return;
    this.release();
    this.opts.redraw();
  }

  private release(): void {
    const d = this.drag;
    this.drag = null;
    if (d) { try { this.canvas.releasePointerCapture(d.pointerId); } catch { /* not captured */ } }
  }

  private px(e: MouseEvent): Vec {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private longEnough(d: KnifeDrag): boolean {
    return Math.hypot(d.curPx[0] - d.startPx[0], d.curPx[1] - d.startPx[1]) >= (this.opts.minDrag ?? KNIFE_MIN_DRAG);
  }

  private onDown = (e: PointerEvent) => {
    if (!this.on || e.button !== 0) return;
    const p = this.px(e);
    this.drag = { startPx: p, curPx: p, alt: e.altKey, pointerId: e.pointerId };
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    e.preventDefault();
    this.opts.redraw();
  };

  private onMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!this.on || !d) return;
    d.curPx = this.px(e); d.alt = e.altKey;
    this.opts.redraw();
  };

  private onUp = (e: PointerEvent) => {
    const d = this.drag;
    if (!this.on || !d) return;
    d.curPx = this.px(e); d.alt = e.altKey;
    const ok = this.longEnough(d);
    this.release();
    if (ok) {
      const view = this.getView();
      this.opts.onCut(toFont(d.startPx, view), toFont(d.curPx, view), d.alt ? this.gap : 0);
    }
    this.opts.redraw();
  };

  private onCancel = () => { if (this.on) this.cancel(); };

  private onModifier = (e: KeyboardEvent) => {
    const d = this.drag;
    if (!d || e.key !== 'Alt') return;
    e.preventDefault(); // keep the browser menu from taking focus mid-drag
    d.alt = e.altKey;
    this.opts.redraw();
  };

  /** Draw the cut line being dragged, with ticks where it will cut. The host calls this after drawing the ink. */
  draw(ctx: CanvasRenderingContext2D, view: View = this.getView()): void {
    const d = this.drag;
    if (!this.on || !d || !this.longEnough(d)) return;
    const [x0, y0] = d.startPx, [x1, y1] = d.curPx;
    const len = Math.hypot(x1 - x0, y1 - y0) || 1;
    const ux = (x1 - x0) / len, uy = (y1 - y0) / len;
    const cut = '#ff5c7a';
    ctx.save();
    ctx.lineCap = 'round';
    if (d.alt) { // the strip that will be removed
      ctx.strokeStyle = withAlpha(this.accent, 0.28); ctx.lineWidth = Math.max(2, this.gap * view.s); ctx.lineCap = 'butt';
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      ctx.lineCap = 'round';
    }
    // the reach beyond both ends, then the dragged line itself
    const e = len * KNIFE_EXTEND;
    ctx.strokeStyle = withAlpha(this.accent, 0.45); ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(x0 - ux * e, y0 - uy * e); ctx.lineTo(x1 + ux * e, y1 + uy * e); ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 3.5;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    ctx.strokeStyle = this.accent; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    const g = this.opts.getGlyph();
    if (g) {
      const marks = knifeMarks(g, toFont(d.startPx, view), toFont(d.curPx, view));
      ctx.strokeStyle = cut; ctx.lineWidth = 2.5;
      for (const [p, q] of marks.spans) {
        const [px, py] = toCanvas(p, view), [qx, qy] = toCanvas(q, view);
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(qx, qy); ctx.stroke();
      }
      const tick = 6;
      for (const p of marks.points) {
        const [px, py] = toCanvas(p, view);
        ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 4.5;
        ctx.beginPath(); ctx.moveTo(px - uy * tick, py + ux * tick); ctx.lineTo(px + uy * tick, py - ux * tick); ctx.stroke();
        ctx.strokeStyle = cut; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.moveTo(px - uy * tick, py + ux * tick); ctx.lineTo(px + uy * tick, py - ux * tick); ctx.stroke();
      }
    }
    if (d.alt) drawPill(ctx, `gap ${Math.round(this.gap)}`, x1 + 12, y1 + 12);
    ctx.restore();
  }
}
