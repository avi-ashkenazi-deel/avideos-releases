/**
 * Point / node editor for the draw canvas.
 *
 * `EditorModel` is the pure, DOM-free model (node listing, hit testing,
 * move / insert / delete / width ops, curve split / join, undo / redo) and is
 * unit-tested on its own. `PointEditor` wraps it with pointer + keyboard
 * handling on the host's canvas and draws the overlay when the host asks.
 *
 * Coordinates: the model works in font units (y up). Hit testing takes
 * canvas pixels plus a `View` (font (x,y) → canvas (ox + x*s, oy − y*s)).
 */
import type { Glyph, Stroke, StrokePoint, CurveContour, Vec } from '../../core/glyph';
import { cloneGlyph } from '../../core/glyph';
import { clamp, dist } from '../../core/geometry';
import type { View } from '../../ui/render';
import { isLine, type Cubic } from '../../outline/fitCurves';
import { glyphToContours } from '../../outline';
import { curvesFromContours, flattenCurves, splitCubic, joinSegments, nearestT, cubicAt, lineSegment } from './curves';

// ---------------------------------------------------------------- types

export interface Selection {
  kind: 'stroke' | 'outline';
  nodes: { stroke?: number; point?: number; contour?: number; segment?: number }[];
}
export type NodeRef = Selection['nodes'][number];
/** c1 (handle 1, leaves anchor `segment`) or c2 (handle 2, enters anchor `segment + 1`). */
export interface HandleRef { contour: number; segment: number; handle: 1 | 2 }

export type Hit =
  | { type: 'node'; node: NodeRef; pos: Vec }
  | { type: 'handle'; handle: HandleRef; pos: Vec }
  | { type: 'midpoint'; contour: number; segment: number; pos: Vec }
  | { type: 'segment'; stroke?: number; contour?: number; segment: number; t: number; pos: Vec };

export const MIN_W = 2;
export const MAX_W = 200;
export const HIT_TOLERANCE = 7;
export const SMOOTH_DEG = 5;
const HISTORY_MAX = 50;

const nodeKey = (n: NodeRef) => (n.stroke !== undefined ? `s${n.stroke}:${n.point}` : `o${n.contour}:${n.segment}`);
const toCanvas = (p: Vec, v: View): Vec => [v.ox + p[0] * v.s, v.oy - p[1] * v.s];
const toFont = (c: Vec, v: View): Vec => [(c[0] - v.ox) / v.s, (v.oy - c[1]) / v.s];
const copyVec = (p: Vec): Vec => [p[0], p[1]];

function segDistance(q: Vec, a: Vec, b: Vec): { d: number; t: number } {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? clamp(((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l2, 0, 1) : 0;
  return { d: Math.hypot(a[0] + t * dx - q[0], a[1] + t * dy - q[1]), t };
}

// ---------------------------------------------------------------- model

export class EditorModel {
  private glyph: Glyph;
  private past: Glyph[] = [];
  private future: Glyph[] = [];
  private selected: NodeRef[] = [];
  private snapshot: Glyph | null = null;
  /** which handles are listed / hit-testable: all curve handles, or only those next to a selected anchor */
  handleMode: 'all' | 'selected' = 'all';

  constructor(glyph: Glyph) {
    this.glyph = cloneGlyph(glyph);
    if (this.glyph.kind === 'outline') {
      if (!this.glyph.curves) this.glyph.curves = curvesFromContours(this.glyph.contours ?? []);
      if (!this.glyph.strokes) delete this.glyph.strokes;
    }
    this.sync();
  }

  get kind(): 'stroke' | 'outline' { return this.glyph.kind; }

  /** A fresh copy of the working glyph (contours re-flattened for outlines). */
  getGlyph(): Glyph { return cloneGlyph(this.glyph); }

  /** Replace the working glyph (clears history and selection). */
  setGlyph(glyph: Glyph): void {
    const m = new EditorModel(glyph);
    this.glyph = m.glyph; this.past = []; this.future = []; this.selected = []; this.snapshot = null;
  }

  private get strokes(): Stroke[] { return this.glyph.strokes ?? (this.glyph.strokes = []); }
  private get curves(): CurveContour[] { return this.glyph.curves ?? (this.glyph.curves = []); }

  /** keep `contours` in sync with `curves` for outline glyphs */
  private sync(): void {
    if (this.glyph.kind === 'outline') this.glyph.contours = flattenCurves(this.curves);
  }

  // ---- listing

  nodes(): { ref: NodeRef; pos: Vec }[] {
    const out: { ref: NodeRef; pos: Vec }[] = [];
    if (this.kind === 'stroke') {
      this.strokes.forEach((s, si) => s.points.forEach((p, pi) => out.push({ ref: { stroke: si, point: pi }, pos: [p.x, p.y] })));
    } else {
      this.curves.forEach((c, ci) => c.segments.forEach((seg, j) => out.push({ ref: { contour: ci, segment: j }, pos: copyVec(seg[0]) })));
    }
    return out;
  }

  nodePos(ref: NodeRef): Vec | null {
    if (ref.stroke !== undefined) { const p = this.strokes[ref.stroke]?.points[ref.point!]; return p ? [p.x, p.y] : null; }
    const seg = this.curves[ref.contour!]?.segments[ref.segment!];
    return seg ? copyVec(seg[0]) : null;
  }

  /** Width (half stroke width) of a stroke node. */
  nodeWidth(ref: NodeRef): number | null {
    if (ref.stroke === undefined) return null;
    return this.strokes[ref.stroke]?.points[ref.point!]?.w ?? null;
  }

  handles(): { ref: HandleRef; pos: Vec; anchor: Vec }[] {
    const out: { ref: HandleRef; pos: Vec; anchor: Vec }[] = [];
    if (this.kind !== 'outline') return out;
    const selKeys = new Set(this.selected.map(nodeKey));
    this.curves.forEach((c, ci) => {
      const n = c.segments.length;
      c.segments.forEach((seg, j) => {
        if (isLine(seg)) return;
        const a0 = selKeys.has(nodeKey({ contour: ci, segment: j }));
        const a1 = selKeys.has(nodeKey({ contour: ci, segment: (j + 1) % n }));
        if (this.handleMode === 'all' || a0) out.push({ ref: { contour: ci, segment: j, handle: 1 }, pos: copyVec(seg[1]), anchor: copyVec(seg[0]) });
        if (this.handleMode === 'all' || a1) out.push({ ref: { contour: ci, segment: j, handle: 2 }, pos: copyVec(seg[2]), anchor: copyVec(seg[3]) });
      });
    });
    return out;
  }

  /** Midpoints of straight outline segments (Alt-click target to convert line ↔ curve). */
  midpoints(): { contour: number; segment: number; pos: Vec }[] {
    const out: { contour: number; segment: number; pos: Vec }[] = [];
    if (this.kind !== 'outline') return out;
    this.curves.forEach((c, ci) => c.segments.forEach((seg, j) => {
      if (isLine(seg)) out.push({ contour: ci, segment: j, pos: [(seg[0][0] + seg[3][0]) / 2, (seg[0][1] + seg[3][1]) / 2] });
    }));
    return out;
  }

  segmentCount(ref: NodeRef): number {
    if (ref.stroke !== undefined) return this.strokes[ref.stroke]?.points.length ?? 0;
    return this.curves[ref.contour!]?.segments.length ?? 0;
  }

  // ---- hit testing (canvas pixels)

  hitTest(cx: number, cy: number, view: View, tol = HIT_TOLERANCE): Hit | null {
    const q: Vec = [cx, cy];
    const near = (p: Vec) => dist(toCanvas(p, view), q);
    // handles first (they sit on top), then nodes, then midpoints, then segments
    let best: Hit | null = null, bestD = tol;
    for (const h of this.handles()) { const d = near(h.pos); if (d <= bestD) { bestD = d; best = { type: 'handle', handle: h.ref, pos: h.pos }; } }
    if (best) return best;
    for (const n of this.nodes()) { const d = near(n.pos); if (d <= bestD) { bestD = d; best = { type: 'node', node: n.ref, pos: n.pos }; } }
    if (best) return best;
    for (const m of this.midpoints()) { const d = near(m.pos); if (d <= bestD) { bestD = d; best = { type: 'midpoint', contour: m.contour, segment: m.segment, pos: m.pos }; } }
    if (best) return best;
    if (this.kind === 'stroke') {
      this.strokes.forEach((s, si) => {
        for (let i = 0; i < s.points.length - 1; i++) {
          const a = toCanvas([s.points[i].x, s.points[i].y], view), b = toCanvas([s.points[i + 1].x, s.points[i + 1].y], view);
          const { d, t } = segDistance(q, a, b);
          if (d <= bestD) { bestD = d; best = { type: 'segment', stroke: si, segment: i, t, pos: toFont([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], view) }; }
        }
      });
    } else {
      this.curves.forEach((c, ci) => c.segments.forEach((seg, j) => {
        const cs = seg.map((p) => toCanvas(p, view)) as Cubic;
        const { t, d } = nearestT(cs, q);
        if (d <= bestD) { bestD = d; best = { type: 'segment', contour: ci, segment: j, t, pos: cubicAt(seg, t) }; }
      }));
    }
    return best;
  }

  // ---- selection

  getSelection(): Selection | null {
    return this.selected.length ? { kind: this.kind, nodes: this.selected.map((n) => ({ ...n })) } : null;
  }
  isSelected(ref: NodeRef): boolean { const k = nodeKey(ref); return this.selected.some((n) => nodeKey(n) === k); }
  select(ref: NodeRef, additive = false): void {
    if (!additive) { this.selected = [{ ...ref }]; return; }
    if (!this.isSelected(ref)) this.selected.push({ ...ref });
  }
  toggleSelect(ref: NodeRef): void {
    const k = nodeKey(ref);
    if (this.isSelected(ref)) this.selected = this.selected.filter((n) => nodeKey(n) !== k); else this.selected.push({ ...ref });
  }
  clearSelection(): void { this.selected = []; }
  selectAll(): void { this.selected = this.nodes().map((n) => n.ref); }
  /** Rectangle in font units (any corner order). */
  selectInRect(x0: number, y0: number, x1: number, y1: number, additive = false): void {
    const minX = Math.min(x0, x1), maxX = Math.max(x0, x1), minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
    if (!additive) this.selected = [];
    for (const n of this.nodes()) {
      if (n.pos[0] >= minX && n.pos[0] <= maxX && n.pos[1] >= minY && n.pos[1] <= maxY) this.select(n.ref, true);
    }
  }
  private pruneSelection(): void {
    this.selected = this.selected.filter((n) => this.nodePos(n) !== null);
  }

  // ---- history

  private pushHistory(state: Glyph = this.glyph): void {
    this.past.push(cloneGlyph(state));
    if (this.past.length > HISTORY_MAX) this.past.shift();
    this.future = [];
  }
  canUndo(): boolean { return this.past.length > 0; }
  canRedo(): boolean { return this.future.length > 0; }
  undo(): boolean {
    const prev = this.past.pop();
    if (!prev) return false;
    this.future.push(cloneGlyph(this.glyph));
    this.glyph = prev; this.snapshot = null; this.pruneSelection();
    return true;
  }
  redo(): boolean {
    const next = this.future.pop();
    if (!next) return false;
    this.past.push(cloneGlyph(this.glyph));
    this.glyph = next; this.snapshot = null; this.pruneSelection();
    return true;
  }

  // ---- drags (relative to a snapshot taken at beginDrag; commit on endDrag)

  get dragging(): boolean { return this.snapshot !== null; }
  beginDrag(): void { this.snapshot = cloneGlyph(this.glyph); }
  cancelDrag(): void { if (this.snapshot) { this.glyph = this.snapshot; this.snapshot = null; } }
  /** Commit the drag: pushes one history entry if anything changed. Returns true when changed. */
  endDrag(): boolean {
    if (!this.snapshot) return false;
    const snap = this.snapshot; this.snapshot = null;
    if (JSON.stringify(snap) === JSON.stringify(this.glyph)) return false;
    this.pushHistory(snap);
    this.sync();
    return true;
  }
  private restoreSnapshot(): Glyph {
    if (!this.snapshot) this.beginDrag();
    this.glyph = cloneGlyph(this.snapshot!);
    return this.snapshot!;
  }

  /** Move every selected node by (dx, dy) font units from its position at beginDrag. */
  dragNodes(dx: number, dy: number): void {
    const snap = this.restoreSnapshot();
    this.applyMove(this.selected, dx, dy, snap);
    this.sync();
  }

  /** Alt + vertical drag: change the width of selected stroke nodes by dw from the snapshot. */
  dragWidth(dw: number): void {
    const snap = this.restoreSnapshot();
    for (const n of this.selected) {
      if (n.stroke === undefined) continue;
      const p = this.strokes[n.stroke]?.points[n.point!], sp = snap.strokes?.[n.stroke]?.points[n.point!];
      if (p && sp) p.w = clamp(sp.w + dw, MIN_W, MAX_W);
    }
  }

  /** Move a curve handle to `pos` (font units). Mirrors the opposite handle when the anchor was smooth unless `breakSmooth`. */
  dragHandle(ref: HandleRef, pos: Vec, breakSmooth = false): void {
    const snap = this.restoreSnapshot();
    const c = this.curves[ref.contour], sc = snap.curves![ref.contour];
    if (!c) return;
    const n = c.segments.length, j = ref.segment;
    const seg = c.segments[j];
    let anchor: Vec, anchorIdx: number, opp: Vec | null, oppSeg: Cubic, oppIdx: 1 | 2;
    if (ref.handle === 1) {
      seg[1] = copyVec(pos); anchor = seg[0]; anchorIdx = j;
      const prev = (j - 1 + n) % n; oppSeg = c.segments[prev]; oppIdx = 2;
      opp = isLine(sc.segments[prev]) || prev === j ? null : oppSeg[2];
    } else {
      seg[2] = copyVec(pos); anchor = seg[3]; anchorIdx = (j + 1) % n;
      const next = (j + 1) % n; oppSeg = c.segments[next]; oppIdx = 1;
      opp = isLine(sc.segments[next]) || next === j ? null : oppSeg[1];
    }
    if (!breakSmooth && opp && this.isSmooth(sc, anchorIdx)) {
      const dx = anchor[0] - pos[0], dy = anchor[1] - pos[1];
      const l = Math.hypot(dx, dy);
      if (l > 1e-6) {
        const L = dist(opp, anchor);
        oppSeg[oppIdx] = [anchor[0] + (dx / l) * L, anchor[1] + (dy / l) * L];
      }
    }
    this.sync();
  }

  /** True when the two handles around anchor `j` are collinear within SMOOTH_DEG. */
  isSmooth(c: CurveContour, j: number): boolean {
    const n = c.segments.length;
    if (n < 2) return false;
    const out = c.segments[j], inc = c.segments[(j - 1 + n) % n];
    const a = out[0];
    const hOut: Vec = isLine(out) ? [out[3][0] - a[0], out[3][1] - a[1]] : [out[1][0] - a[0], out[1][1] - a[1]];
    const hIn: Vec = isLine(inc) ? [inc[0][0] - a[0], inc[0][1] - a[1]] : [inc[2][0] - a[0], inc[2][1] - a[1]];
    const l1 = Math.hypot(hOut[0], hOut[1]), l2 = Math.hypot(hIn[0], hIn[1]);
    if (l1 < 1e-6 || l2 < 1e-6) return false;
    const cos = -(hOut[0] * hIn[0] + hOut[1] * hIn[1]) / (l1 * l2);
    return cos > Math.cos((SMOOTH_DEG * Math.PI) / 180);
  }

  private applyMove(refs: NodeRef[], dx: number, dy: number, snap: Glyph): void {
    for (const n of refs) {
      if (n.stroke !== undefined) {
        const p = this.strokes[n.stroke]?.points[n.point!], sp = snap.strokes?.[n.stroke]?.points[n.point!];
        if (p && sp) { p.x = sp.x + dx; p.y = sp.y + dy; }
      } else {
        this.moveAnchor(n.contour!, n.segment!, dx, dy, snap);
      }
    }
  }

  /** Move anchor j of a contour; attached curve handles follow, attached lines stay straight. */
  private moveAnchor(ci: number, j: number, dx: number, dy: number, snap: Glyph): void {
    const c = this.curves[ci], sc = snap.curves?.[ci];
    if (!c || !sc) return;
    const n = c.segments.length, prev = (j - 1 + n) % n;
    const out = c.segments[j], inc = c.segments[prev];
    const sOut = sc.segments[j], sInc = sc.segments[prev];
    out[0] = [sOut[0][0] + dx, sOut[0][1] + dy];
    inc[3] = [sInc[3][0] + dx, sInc[3][1] + dy];
    if (j === 0) c.start = copyVec(out[0]);
    if (isLine(sOut)) { out[1] = copyVec(out[0]); out[2] = copyVec(out[3]); } else out[1] = [sOut[1][0] + dx, sOut[1][1] + dy];
    if (isLine(sInc)) { inc[1] = copyVec(inc[0]); inc[2] = copyVec(inc[3]); } else inc[2] = [sInc[2][0] + dx, sInc[2][1] + dy];
  }

  // ---- discrete operations (each is one history entry)

  /** Nudge the selection by (dx, dy) font units. */
  nudge(dx: number, dy: number): boolean {
    if (!this.selected.length) return false;
    const snap = cloneGlyph(this.glyph);
    this.pushHistory(snap);
    this.applyMove(this.selected, dx, dy, snap);
    this.sync();
    return true;
  }

  /** Delete selected nodes. Strokes left with no points are removed; anchors are joined with a fitted segment. */
  deleteSelected(): boolean {
    if (!this.selected.length) return false;
    this.pushHistory();
    if (this.kind === 'stroke') {
      const byStroke = new Map<number, number[]>();
      for (const n of this.selected) { if (n.stroke === undefined) continue; (byStroke.get(n.stroke) ?? byStroke.set(n.stroke, []).get(n.stroke)!).push(n.point!); }
      for (const [si, pts] of byStroke) {
        const s = this.strokes[si]; if (!s) continue;
        for (const pi of [...new Set(pts)].sort((a, b) => b - a)) s.points.splice(pi, 1);
      }
      this.glyph.strokes = this.strokes.filter((s) => s.points.length >= 1);
    } else {
      const byContour = new Map<number, number[]>();
      for (const n of this.selected) { if (n.contour === undefined) continue; (byContour.get(n.contour) ?? byContour.set(n.contour, []).get(n.contour)!).push(n.segment!); }
      const dead = new Set<number>();
      for (const [ci, segs] of byContour) {
        for (const j of [...new Set(segs)].sort((a, b) => b - a)) if (!this.deleteAnchor(ci, j)) { dead.add(ci); break; }
      }
      this.glyph.curves = this.curves.filter((_, i) => !dead.has(i));
    }
    this.selected = [];
    this.sync();
    return true;
  }

  /** Remove anchor j of contour ci, joining its neighbours. Returns false when the contour collapsed (caller removes it). */
  private deleteAnchor(ci: number, j: number): boolean {
    const c = this.curves[ci];
    if (!c) return false;
    const n = c.segments.length;
    if (n <= 2) return false;
    const prev = (j - 1 + n) % n;
    const joined = joinSegments(c.segments[prev], c.segments[j]);
    c.segments[prev] = joined;
    c.segments.splice(j, 1);
    c.start = copyVec(c.segments[0][0]);
    return true;
  }

  /** Insert a stroke point on segment `segment` of stroke `stroke` at parameter t (width/pressure interpolated). Selects the new node. */
  insertStrokePoint(stroke: number, segment: number, t: number): NodeRef | null {
    const s = this.strokes[stroke];
    if (!s || segment < 0 || segment >= s.points.length - 1) return null;
    this.pushHistory();
    const a = s.points[segment], b = s.points[segment + 1];
    const tt = clamp(t, 0, 1);
    const np: StrokePoint = { x: a.x + (b.x - a.x) * tt, y: a.y + (b.y - a.y) * tt, w: a.w + (b.w - a.w) * tt };
    if (a.p !== undefined && b.p !== undefined) np.p = a.p + (b.p - a.p) * tt;
    s.points.splice(segment + 1, 0, np);
    const ref: NodeRef = { stroke, point: segment + 1 };
    this.selected = this.selected.map((n) => (n.stroke === stroke && n.point! > segment ? { stroke, point: n.point! + 1 } : n));
    this.select(ref);
    return ref;
  }

  /** Split outline segment at t (de Casteljau); the new anchor becomes the selection. */
  splitSegment(contour: number, segment: number, t: number): NodeRef | null {
    const c = this.curves[contour];
    if (!c || !c.segments[segment]) return null;
    this.pushHistory();
    const [a, b] = splitCubic(c.segments[segment], clamp(t, 0.001, 0.999));
    c.segments.splice(segment, 1, a, b);
    this.selected = this.selected.map((n) => (n.contour === contour && n.segment! > segment ? { contour, segment: n.segment! + 1 } : n));
    const ref: NodeRef = { contour, segment: segment + 1 };
    this.select(ref);
    this.sync();
    return ref;
  }

  /** Convert a straight segment to a curve (handles along the neighbours' tangents) or a curve to a line. */
  toggleSegmentLine(contour: number, segment: number): boolean {
    const c = this.curves[contour];
    const seg = c?.segments[segment];
    if (!c || !seg) return false;
    this.pushHistory();
    if (isLine(seg)) {
      const n = c.segments.length;
      const prev = c.segments[(segment - 1 + n) % n], next = c.segments[(segment + 1) % n];
      const p0 = seg[0], p3 = seg[3];
      const L = dist(p0, p3) || 1;
      const dir = (from: Vec, to: Vec): Vec => { const d = dist(from, to) || 1; return [(to[0] - from[0]) / d, (to[1] - from[1]) / d]; };
      let t1 = isLine(prev) || n < 2 ? dir(p0, p3) : dir(prev[2], p0);
      let t2 = isLine(next) || n < 2 ? dir(p3, p0) : dir(next[1], p3);
      const cross = t1[0] * t2[1] - t1[1] * t2[0];
      if (Math.abs(cross) < 1e-3 && Math.abs(t1[0] * dir(p0, p3)[0] + t1[1] * dir(p0, p3)[1]) > 0.999) {
        // still collinear: bow the segment slightly so it reads as a curve
        const nrm: Vec = [-(p3[1] - p0[1]) / L, (p3[0] - p0[0]) / L];
        t1 = [t1[0] * 0.9 + nrm[0] * 0.45, t1[1] * 0.9 + nrm[1] * 0.45];
        t2 = [t2[0] * 0.9 + nrm[0] * 0.45, t2[1] * 0.9 + nrm[1] * 0.45];
      }
      seg[1] = [p0[0] + t1[0] * L / 3, p0[1] + t1[1] * L / 3];
      seg[2] = [p3[0] + t2[0] * L / 3, p3[1] + t2[1] * L / 3];
    } else {
      c.segments[segment] = lineSegment(seg[0], seg[3]);
    }
    this.sync();
    return true;
  }

  /** Set the width of all selected stroke nodes (clamped to 2..200). */
  setSelectedWidth(w: number): boolean {
    const refs = this.selected.filter((n) => n.stroke !== undefined);
    if (!refs.length) return false;
    const v = clamp(w, MIN_W, MAX_W);
    if (refs.every((n) => this.nodeWidth(n) === v)) return false;
    this.pushHistory();
    for (const n of refs) { const p = this.strokes[n.stroke!]?.points[n.point!]; if (p) p.w = v; }
    return true;
  }

  /** Mean width of the selected stroke nodes, or null when none are selected. */
  getSelectedWidth(): number | null {
    const ws = this.selected.map((n) => this.nodeWidth(n)).filter((w): w is number => w !== null);
    return ws.length ? ws.reduce((a, b) => a + b, 0) / ws.length : null;
  }
}

// ---------------------------------------------------------------- DOM wrapper

export interface PointEditorOptions {
  /** Called with a NEW glyph object after every committed edit (pointerup, key op, undo/redo). */
  onChange: (glyph: Glyph) => void;
  onSelect?: (sel: Selection | null) => void;
  /**
   * Called continuously during drags with the in-progress glyph so the host
   * can re-render the ink; the host is expected to redraw (and call `draw`).
   * When absent, `redraw` is used; when both are absent the editor repaints
   * the canvas itself (ink + overlay, no guides).
   */
  onPreview?: (glyph: Glyph) => void;
  /** Ask the host to repaint the canvas (it should call editor.draw(ctx) at the end). */
  redraw?: () => void;
  /** Hit tolerance in canvas px (default 7). */
  tolerance?: number;
}

type DragMode =
  | { kind: 'nodes'; startPx: Vec; moved: boolean }
  | { kind: 'width'; startPx: Vec; moved: boolean }
  | { kind: 'handle'; ref: HandleRef; moved: boolean }
  | { kind: 'marquee'; startPx: Vec; curPx: Vec; additive: boolean };

export class PointEditor {
  readonly canvas: HTMLCanvasElement;
  private getView: () => View;
  private opts: PointEditorOptions;
  private model: EditorModel | null = null;
  private drag: DragMode | null = null;
  private hover: Hit | null = null;
  private accent = '#ffd166';
  private lastEmitted: Glyph | null = null;
  private prevCursor = '';
  private pointerId: number | null = null;

  constructor(canvas: HTMLCanvasElement, getView: () => View, opts: PointEditorOptions) {
    this.canvas = canvas;
    this.getView = getView;
    this.opts = opts;
  }

  get enabled(): boolean { return this.model !== null; }
  /** The pure model (null while disabled). */
  getModel(): EditorModel | null { return this.model; }

  /** Start editing `glyph` (a deep copy is taken) and attach pointer/keyboard listeners. */
  enable(glyph: Glyph): void {
    if (this.model) this.disable();
    this.model = new EditorModel(glyph);
    this.lastEmitted = null;
    this.readAccent();
    this.prevCursor = this.canvas.style.cursor;
    this.canvas.style.cursor = 'crosshair';
    this.canvas.addEventListener('pointerdown', this.onDown);
    this.canvas.addEventListener('pointermove', this.onMove);
    this.canvas.addEventListener('pointerup', this.onUp);
    this.canvas.addEventListener('pointercancel', this.onCancel);
    this.canvas.addEventListener('dblclick', this.onDblClick);
    window.addEventListener('keydown', this.onKey);
    this.emitSelect();
    this.repaint();
  }

  /** Detach listeners and drop the working copy (history is discarded). */
  disable(): void {
    if (!this.model) return;
    if (this.drag) { this.model.cancelDrag(); this.drag = null; }
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointercancel', this.onCancel);
    this.canvas.removeEventListener('dblclick', this.onDblClick);
    window.removeEventListener('keydown', this.onKey);
    this.canvas.style.cursor = this.prevCursor;
    this.model = null; this.hover = null;
    this.opts.onSelect?.(null);
  }

  /**
   * Replace the glyph being edited (e.g. the host switched glyphs while in
   * edit mode). Glyphs the editor itself just emitted are ignored, so the
   * host may feed its state back without losing history.
   */
  setGlyph(glyph: Glyph): void {
    if (!this.model || glyph === this.lastEmitted) return;
    this.model.setGlyph(glyph);
    this.emitSelect();
    this.repaint();
  }

  getSelection(): Selection | null { return this.model?.getSelection() ?? null; }
  clearSelection(): void { if (this.model) { this.model.clearSelection(); this.emitSelect(); this.repaint(); } }
  selectAll(): void { if (this.model) { this.model.selectAll(); this.emitSelect(); this.repaint(); } }
  deleteSelected(): void { if (this.model?.deleteSelected()) { this.emitSelect(); this.commit(); } }
  canUndo(): boolean { return this.model?.canUndo() ?? false; }
  canRedo(): boolean { return this.model?.canRedo() ?? false; }
  undo(): boolean { if (!this.model?.undo()) return false; this.emitSelect(); this.commit(); return true; }
  redo(): boolean { if (!this.model?.redo()) return false; this.emitSelect(); this.commit(); return true; }
  setSelectedWidth(w: number): void { if (this.model?.setSelectedWidth(w)) this.commit(); }
  getSelectedWidth(): number | null { return this.model?.getSelectedWidth() ?? null; }
  /** Convert the segment under the given canvas point between line and curve. */
  toggleSegmentAt(cx: number, cy: number): boolean {
    const hit = this.model?.hitTest(cx, cy, this.getView(), this.tol);
    if (!hit || !this.model || (hit.type !== 'segment' && hit.type !== 'midpoint') || hit.contour === undefined) return false;
    if (!this.model.toggleSegmentLine(hit.contour, hit.segment)) return false;
    this.commit();
    return true;
  }

  private get tol(): number { return this.opts.tolerance ?? HIT_TOLERANCE; }

  private readAccent(): void {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
      this.accent = v || '#ffd166';
    } catch { this.accent = '#ffd166'; }
  }

  private px(e: MouseEvent): Vec {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private emitSelect(): void { this.opts.onSelect?.(this.model?.getSelection() ?? null); }

  /** Push the committed glyph to the host. */
  private commit(): void {
    if (!this.model) return;
    const g = this.model.getGlyph();
    this.lastEmitted = g;
    this.opts.onChange(g);
    this.repaint();
  }

  /** Repaint: host preview → host redraw → self-render fallback. */
  private repaint(): void {
    if (!this.model) return;
    if (this.opts.onPreview) { this.opts.onPreview(this.model.getGlyph()); return; }
    if (this.opts.redraw) { this.opts.redraw(); return; }
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const view = this.getView();
    const w = this.canvas.clientWidth || this.canvas.width, h = this.canvas.clientHeight || this.canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,255,255,.92)';
    ctx.beginPath();
    for (const c of glyphToContours(this.model.getGlyph())) {
      c.points.forEach((p, i) => { const [x, y] = toCanvas(p, view); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.closePath();
    }
    ctx.fill('nonzero');
    this.draw(ctx, view);
  }

  // ---- pointer handlers

  private onDown = (e: PointerEvent) => {
    const m = this.model;
    if (!m || e.button !== 0) return;
    const view = this.getView();
    const p = this.px(e);
    const hit = m.hitTest(p[0], p[1], view, this.tol);
    this.pointerId = e.pointerId;
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    e.preventDefault();
    if (hit?.type === 'handle') {
      m.beginDrag();
      this.drag = { kind: 'handle', ref: hit.handle, moved: false };
    } else if (hit?.type === 'node') {
      if (e.shiftKey) m.toggleSelect(hit.node);
      else if (!m.isSelected(hit.node)) m.select(hit.node);
      this.emitSelect();
      if (m.isSelected(hit.node)) {
        m.beginDrag();
        this.drag = e.altKey && m.kind === 'stroke' ? { kind: 'width', startPx: p, moved: false } : { kind: 'nodes', startPx: p, moved: false };
      }
    } else if (hit?.type === 'midpoint' && e.altKey) {
      if (m.toggleSegmentLine(hit.contour, hit.segment)) this.commit();
    } else {
      if (!e.shiftKey) { m.clearSelection(); this.emitSelect(); }
      this.drag = { kind: 'marquee', startPx: p, curPx: p, additive: e.shiftKey };
    }
    this.repaint();
  };

  private onMove = (e: PointerEvent) => {
    const m = this.model;
    if (!m) return;
    const view = this.getView();
    const p = this.px(e);
    const d = this.drag;
    if (!d) {
      const h = m.hitTest(p[0], p[1], view, this.tol);
      const changed = JSON.stringify(h) !== JSON.stringify(this.hover);
      this.hover = h;
      this.canvas.style.cursor = h && (h.type === 'node' || h.type === 'handle') ? 'move' : 'crosshair';
      if (changed) this.repaint();
      return;
    }
    switch (d.kind) {
      case 'nodes': {
        const dx = (p[0] - d.startPx[0]) / view.s, dy = -(p[1] - d.startPx[1]) / view.s;
        if (!d.moved && Math.hypot(p[0] - d.startPx[0], p[1] - d.startPx[1]) < 2) return;
        d.moved = true;
        m.dragNodes(dx, dy);
        break;
      }
      case 'width': {
        const dw = -(p[1] - d.startPx[1]) / view.s;
        d.moved = true;
        m.dragWidth(dw);
        break;
      }
      case 'handle':
        d.moved = true;
        m.dragHandle(d.ref, toFont(p, view), e.altKey);
        break;
      case 'marquee':
        d.curPx = p;
        break;
    }
    this.repaint();
  };

  private onUp = (e: PointerEvent) => {
    const m = this.model;
    const d = this.drag;
    if (!m || !d) return;
    this.releasePointer(e);
    this.drag = null;
    if (d.kind === 'marquee') {
      const view = this.getView();
      const a = toFont(d.startPx, view), b = toFont(d.curPx, view);
      if (Math.hypot(d.curPx[0] - d.startPx[0], d.curPx[1] - d.startPx[1]) >= 2) m.selectInRect(a[0], a[1], b[0], b[1], d.additive);
      this.emitSelect();
      this.repaint();
      return;
    }
    if (m.endDrag()) this.commit(); else { m.cancelDrag(); this.repaint(); }
  };

  private onCancel = (e: PointerEvent) => {
    if (!this.model) return;
    this.releasePointer(e);
    if (this.drag && this.drag.kind !== 'marquee') this.model.cancelDrag();
    this.drag = null;
    this.repaint();
  };

  private releasePointer(e: PointerEvent): void {
    if (this.pointerId !== null) { try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ } }
    this.pointerId = null;
  }

  private onDblClick = (e: MouseEvent) => {
    const m = this.model;
    if (!m) return;
    const p = this.px(e);
    const hit = m.hitTest(p[0], p[1], this.getView(), this.tol);
    if (!hit || (hit.type !== 'segment' && hit.type !== 'midpoint')) return;
    e.preventDefault();
    const ref = hit.type === 'midpoint' ? m.splitSegment(hit.contour, hit.segment, 0.5)
      : hit.stroke !== undefined ? m.insertStrokePoint(hit.stroke, hit.segment, hit.t) : m.splitSegment(hit.contour!, hit.segment, hit.t);
    if (ref) { this.emitSelect(); this.commit(); }
  };

  private onKey = (e: KeyboardEvent) => {
    const m = this.model;
    if (!m) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) this.redo(); else this.undo();
      return;
    }
    if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); this.redo(); return; }
    if (mod && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); this.selectAll(); return; }
    switch (e.key) {
      case 'Delete': case 'Backspace':
        e.preventDefault(); this.deleteSelected(); return;
      case 'Escape':
        if (this.drag) { if (this.drag.kind !== 'marquee') m.cancelDrag(); this.drag = null; }
        m.clearSelection(); this.emitSelect(); this.repaint(); return;
      case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': {
        const step = e.shiftKey ? 10 : 2;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0;
        if (m.nudge(dx, dy)) { e.preventDefault(); this.commit(); }
        return;
      }
    }
  };

  // ---- overlay

  /** Draw nodes / handles / selection on top of the glyph. The host calls this after drawing the ink. */
  draw(ctx: CanvasRenderingContext2D, view: View = this.getView()): void {
    const m = this.model;
    if (!m) return;
    const g = m.getGlyph();
    const accent = this.accent;
    const sq = (p: Vec, size: number, fill: string, stroke: string) => {
      const [x, y] = toCanvas(p, view);
      ctx.fillStyle = fill; ctx.strokeStyle = stroke; ctx.lineWidth = 1;
      ctx.fillRect(x - size / 2, y - size / 2, size, size);
      ctx.strokeRect(x - size / 2 + 0.5, y - size / 2 + 0.5, size - 1, size - 1);
    };
    const dot = (p: Vec, r: number, fill: string) => {
      const [x, y] = toCanvas(p, view);
      ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    };
    const hoverKey = this.hover?.type === 'node' ? nodeKey(this.hover.node) : null;
    ctx.save();
    ctx.setLineDash([]);
    if (g.kind === 'stroke') {
      // centrelines
      ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 1; ctx.lineJoin = 'round';
      for (const s of g.strokes ?? []) {
        ctx.beginPath();
        s.points.forEach((p, i) => { const [x, y] = toCanvas([p.x, p.y], view); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
        ctx.stroke();
      }
      // width circles for hovered / selected
      ctx.strokeStyle = withAlpha(accent, 0.35); ctx.lineWidth = 1;
      for (const n of m.nodes()) {
        const k = nodeKey(n.ref);
        if (!m.isSelected(n.ref) && k !== hoverKey) continue;
        const w = m.nodeWidth(n.ref) ?? 0;
        const [x, y] = toCanvas(n.pos, view);
        ctx.beginPath(); ctx.arc(x, y, Math.max(1, w * view.s), 0, Math.PI * 2); ctx.stroke();
      }
    } else {
      // contour outline
      ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 1;
      ctx.beginPath();
      for (const c of g.curves ?? []) {
        if (!c.segments.length) continue;
        const [sx, sy] = toCanvas(c.start, view);
        ctx.moveTo(sx, sy);
        for (const seg of c.segments) {
          const [x1, y1] = toCanvas(seg[1], view), [x2, y2] = toCanvas(seg[2], view), [x3, y3] = toCanvas(seg[3], view);
          if (isLine(seg)) ctx.lineTo(x3, y3); else ctx.bezierCurveTo(x1, y1, x2, y2, x3, y3);
        }
        ctx.closePath();
      }
      ctx.stroke();
      // handles
      ctx.strokeStyle = withAlpha(accent, 0.5); ctx.lineWidth = 1;
      for (const h of m.handles()) {
        const [ax, ay] = toCanvas(h.anchor, view), [hx, hy] = toCanvas(h.pos, view);
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(hx, hy); ctx.stroke();
        const hot = this.hover?.type === 'handle' && sameHandle(this.hover.handle, h.ref);
        dot(h.pos, hot ? 4 : 3, hot ? accent : withAlpha(accent, 0.85));
      }
      // midpoint markers of straight segments
      for (const mp of m.midpoints()) dot(mp.pos, 1.5, 'rgba(255,255,255,.3)');
    }
    // nodes
    for (const n of m.nodes()) {
      const k = nodeKey(n.ref);
      const sel = m.isSelected(n.ref), hot = k === hoverKey;
      sq(n.pos, sel ? 8 : 6, sel ? accent : 'rgba(255,255,255,.95)', hot ? accent : 'rgba(0,0,0,.6)');
    }
    // marquee
    if (this.drag?.kind === 'marquee') {
      const d = this.drag;
      const x = Math.min(d.startPx[0], d.curPx[0]), y = Math.min(d.startPx[1], d.curPx[1]);
      const w = Math.abs(d.curPx[0] - d.startPx[0]), h = Math.abs(d.curPx[1] - d.startPx[1]);
      ctx.fillStyle = withAlpha(accent, 0.08); ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = accent; ctx.setLineDash([4, 3]); ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w, h);
      ctx.setLineDash([]);
    }
    ctx.restore();
  }
}

const sameHandle = (a: HandleRef, b: HandleRef) => a.contour === b.contour && a.segment === b.segment && a.handle === b.handle;

/** '#rgb' / '#rrggbb' → rgba(); other colour strings are returned unchanged. */
function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  let hex = m[1];
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
