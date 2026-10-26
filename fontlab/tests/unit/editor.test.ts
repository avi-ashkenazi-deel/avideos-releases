import { describe, it, expect } from 'vitest';
import { EditorModel, MIN_W, MAX_W } from '../../src/inputs/draw/editor';
import { flattenCurves, curvesFromContours, curvesFromPathCommands, splitCubic } from '../../src/inputs/draw/curves';
import { isLine } from '../../src/outline/fitCurves';
import { signedArea } from '../../src/core/geometry';
import { glyphToContours } from '../../src/outline';
import { buildFont, fontToArrayBuffer } from '../../src/export/otf';
import { importFont } from '../../src/inputs/fontimport';
import { DEFAULT_METRICS } from '../../src/core/glyph';
import type { Glyph, CurveContour, Vec, Contour } from '../../src/core/glyph';
import type { View } from '../../src/ui/render';

const view: View = { ox: 100, oy: 600, s: 0.5 }; // font (x,y) -> canvas (100 + x/2, 600 - y/2)
const C = (x: number, y: number): Vec => [view.ox + x * view.s, view.oy - y * view.s];
const area = (cs: Contour[]) => cs.reduce((a, c) => a + signedArea(c.points), 0);
const near = (a: Vec, b: Vec, eps = 1e-6) => Math.hypot(a[0] - b[0], a[1] - b[1]) < eps;

function strokeGlyph(): Glyph {
  return {
    char: 'l', unicode: 108, advance: 400, source: 'drawn', kind: 'stroke',
    strokes: [
      { id: 'a', cap: 'round', points: [{ x: 100, y: 0, w: 40 }, { x: 100, y: 300, w: 40 }, { x: 100, y: 600, w: 20 }] },
      { id: 'b', cap: 'round', points: [{ x: 300, y: 0, w: 30 }] },
    ],
  };
}

/** Circle of radius r at (cx, cy) as 4 cubics (CCW in y-up). */
function circleCurves(cx: number, cy: number, r: number): CurveContour {
  const k = 0.5522847498 * r;
  return {
    start: [cx + r, cy],
    segments: [
      [[cx + r, cy], [cx + r, cy + k], [cx + k, cy + r], [cx, cy + r]],
      [[cx, cy + r], [cx - k, cy + r], [cx - r, cy + k], [cx - r, cy]],
      [[cx - r, cy], [cx - r, cy - k], [cx - k, cy - r], [cx, cy - r]],
      [[cx, cy - r], [cx + k, cy - r], [cx + r, cy - k], [cx + r, cy]],
    ],
  };
}
function outlineGlyph(curves = [circleCurves(300, 300, 200)]): Glyph {
  return { char: 'o', unicode: 111, advance: 600, source: 'imported', kind: 'outline', curves, contours: flattenCurves(curves) };
}
function polygonCircle(cx: number, cy: number, r: number, n = 64): Contour {
  const pts: Vec[] = [];
  for (let i = 0; i < n; i++) { const t = (i / n) * Math.PI * 2; pts.push([cx + Math.cos(t) * r, cy + Math.sin(t) * r]); }
  return { points: pts };
}
function assertClosed(c: CurveContour) {
  const n = c.segments.length;
  expect(near(c.start, c.segments[0][0])).toBe(true);
  for (let i = 0; i < n; i++) expect(near(c.segments[i][3], c.segments[(i + 1) % n][0])).toBe(true);
}

describe('EditorModel: stroke glyphs', () => {
  it('lists every stroke point as a node and does not mutate the input', () => {
    const g = strokeGlyph();
    const m = new EditorModel(g);
    expect(m.nodes()).toHaveLength(4);
    m.select({ stroke: 0, point: 1 });
    m.beginDrag(); m.dragNodes(10, -5); m.endDrag();
    expect(g.strokes![0].points[1]).toEqual({ x: 100, y: 300, w: 40 });
    expect(m.getGlyph().strokes![0].points[1]).toMatchObject({ x: 110, y: 295, w: 40 });
    expect(m.getGlyph()).not.toBe(g);
  });

  it('hit tests nodes and segments in canvas pixels with 7px tolerance', () => {
    const m = new EditorModel(strokeGlyph());
    const [nx, ny] = C(100, 300);
    expect(m.hitTest(nx + 4, ny - 4, view)).toMatchObject({ type: 'node', node: { stroke: 0, point: 1 } });
    expect(m.hitTest(nx + 20, ny, view)).toBeNull();
    const [sx, sy] = C(100, 150);
    const hit = m.hitTest(sx + 3, sy, view);
    expect(hit).toMatchObject({ type: 'segment', stroke: 0, segment: 0 });
    expect((hit as any).t).toBeCloseTo(0.5, 2);
  });

  it('drag moves the selection relative to the drag start and commits once', () => {
    const m = new EditorModel(strokeGlyph());
    m.select({ stroke: 0, point: 0 }); m.select({ stroke: 0, point: 2 }, true);
    m.beginDrag();
    m.dragNodes(5, 5); m.dragNodes(20, 10); // cumulative deltas, not additive
    expect(m.endDrag()).toBe(true);
    const pts = m.getGlyph().strokes![0].points;
    expect(pts[0]).toMatchObject({ x: 120, y: 10 });
    expect(pts[1]).toMatchObject({ x: 100, y: 300 });
    expect(pts[2]).toMatchObject({ x: 120, y: 610 });
    expect(m.canUndo()).toBe(true);
    m.undo();
    expect(m.canUndo()).toBe(false);
  });

  it('a drag that changes nothing leaves no history entry', () => {
    const m = new EditorModel(strokeGlyph());
    m.select({ stroke: 0, point: 0 });
    m.beginDrag(); m.dragNodes(0, 0);
    expect(m.endDrag()).toBe(false);
    expect(m.canUndo()).toBe(false);
  });

  it('inserts a node on a segment interpolating width and selects it', () => {
    const m = new EditorModel(strokeGlyph());
    const ref = m.insertStrokePoint(0, 1, 0.25);
    expect(ref).toEqual({ stroke: 0, point: 2 });
    const pts = m.getGlyph().strokes![0].points;
    expect(pts).toHaveLength(4);
    expect(pts[2]).toMatchObject({ x: 100, y: 375, w: 35 });
    expect(m.getSelection()).toEqual({ kind: 'stroke', nodes: [{ stroke: 0, point: 2 }] });
  });

  it('deletes selected nodes and drops strokes left without points', () => {
    const m = new EditorModel(strokeGlyph());
    m.select({ stroke: 0, point: 1 }); m.select({ stroke: 1, point: 0 }, true);
    expect(m.deleteSelected()).toBe(true);
    const g = m.getGlyph();
    expect(g.strokes).toHaveLength(1);
    expect(g.strokes![0].points.map((p) => p.y)).toEqual([0, 600]);
    expect(m.getSelection()).toBeNull();
    m.undo();
    expect(m.getGlyph().strokes).toHaveLength(2);
    expect(m.getGlyph().strokes![0].points).toHaveLength(3);
  });

  it('width: set/get, alt-drag and clamping to 2..200', () => {
    const m = new EditorModel(strokeGlyph());
    expect(m.getSelectedWidth()).toBeNull();
    m.select({ stroke: 0, point: 0 }); m.select({ stroke: 0, point: 2 }, true);
    expect(m.getSelectedWidth()).toBe(30);
    expect(m.setSelectedWidth(500)).toBe(true);
    expect(m.getSelectedWidth()).toBe(MAX_W);
    m.setSelectedWidth(0);
    expect(m.getSelectedWidth()).toBe(MIN_W);
    m.setSelectedWidth(60);
    m.beginDrag(); m.dragWidth(-10); m.endDrag();
    expect(m.getGlyph().strokes![0].points[0].w).toBe(50);
    expect(m.getGlyph().strokes![0].points[1].w).toBe(40); // unselected untouched
  });

  it('nudge, rectangle selection and undo/redo stack (max 50)', () => {
    const m = new EditorModel(strokeGlyph());
    m.selectInRect(50, -10, 150, 310); // two nodes of stroke 0
    expect(m.getSelection()!.nodes).toHaveLength(2);
    m.nudge(2, 0);
    expect(m.getGlyph().strokes![0].points[0].x).toBe(102);
    m.undo();
    expect(m.getGlyph().strokes![0].points[0].x).toBe(100);
    expect(m.canRedo()).toBe(true);
    m.redo();
    expect(m.getGlyph().strokes![0].points[0].x).toBe(102);
    for (let i = 0; i < 60; i++) m.nudge(1, 0);
    let n = 0;
    while (m.undo()) n++;
    expect(n).toBe(50);
    expect(m.getGlyph().strokes![0].points[0].x).toBe(112); // 60 nudges, only the last 50 undone
  });
});

describe('curves', () => {
  it('curvesFromContours → flattenCurves keeps the area within 2%', () => {
    const src = [polygonCircle(300, 300, 200), { points: [[0, 0], [100, 0], [100, 100], [0, 100]] as Vec[] }];
    const curves = curvesFromContours(src);
    expect(curves).toHaveLength(2);
    for (const c of curves) assertClosed(c);
    const flat = flattenCurves(curves);
    const a0 = area(src), a1 = area(flat);
    expect(Math.abs(a1 - a0) / Math.abs(a0)).toBeLessThan(0.02);
    // the square is four straight segments
    const sq = curves[1];
    expect(sq.segments).toHaveLength(4);
    expect(sq.segments.every((s) => isLine(s))).toBe(true);
    expect(flat[1].points).toHaveLength(4);
  });

  it('splitCubic at t keeps the curve (de Casteljau)', () => {
    const seg = circleCurves(0, 0, 100).segments[0];
    const [a, b] = splitCubic(seg, 0.3);
    expect(near(a[3], b[0])).toBe(true);
    expect(near(a[0], seg[0]) && near(b[3], seg[3])).toBe(true);
    // the split point lies on the circle
    expect(Math.hypot(a[3][0], a[3][1])).toBeCloseTo(100, 0);
  });

  it('curvesFromPathCommands handles M/L/C/Q/Z, flips y and elevates quadratics', () => {
    const cmds = [
      { type: 'M', x: 0, y: 0 }, { type: 'L', x: 100, y: 0 },
      { type: 'C', x1: 100, y1: -50, x2: 50, y2: -100, x: 0, y: -100 },
      { type: 'Q', x1: -20, y1: -50, x: 0, y: 0 }, { type: 'Z' },
      { type: 'M', x: 200, y: 0 }, { type: 'L', x: 300, y: 0 }, { type: 'L', x: 300, y: -100 }, { type: 'Z' }, // closed implicitly by Z
    ];
    const cs = curvesFromPathCommands(cmds, 2, true);
    expect(cs).toHaveLength(2);
    const [c0, c1] = cs;
    assertClosed(c0); assertClosed(c1);
    expect(c0.start).toEqual([0, 0]);
    expect(c0.segments).toHaveLength(3);
    expect(isLine(c0.segments[0])).toBe(true);
    expect(c0.segments[0][3]).toEqual([200, 0]);
    expect(c0.segments[1][1]).toEqual([200, 100]); // y flipped and scaled
    expect(c0.segments[1][3]).toEqual([0, 200]);
    // Q (-20,-50) → scaled/flipped (-40,100); elevation: c1 = p0 + 2/3 (q - p0)
    const q: Vec = [-40, 100];
    expect(c0.segments[2][1][0]).toBeCloseTo(0 + (2 / 3) * (q[0] - 0));
    expect(c0.segments[2][1][1]).toBeCloseTo(200 + (2 / 3) * (q[1] - 200));
    expect(c0.segments[2][2][0]).toBeCloseTo(0 + (2 / 3) * (q[0] - 0));
    expect(c0.segments[2][2][1]).toBeCloseTo(0 + (2 / 3) * (q[1] - 0));
    // triangle: Z adds the closing line
    expect(c1.segments).toHaveLength(3);
    expect(c1.segments.every((s) => isLine(s))).toBe(true);
    expect(c1.segments[2][3]).toEqual([400, 0]);
    expect(Math.max(...flattenCurves(cs)[0].points.map((p) => p[1]))).toBeGreaterThan(190);
  });

  it('importFont keeps real curves whose flattening matches the contours (3%)', () => {
    const g: Glyph = { char: 'A', unicode: 65, advance: 600, source: 'drawn', kind: 'stroke', strokes: [{ id: 's', cap: 'round', points: [{ x: 60, y: 0, w: 40 }, { x: 360, y: 600, w: 40 }] }] };
    const cs = glyphToContours(g);
    const buf = fontToArrayBuffer(buildFont([{ char: 'A', unicode: 65, advance: 600, contours: cs }], { familyName: 'RT', metrics: DEFAULT_METRICS }));
    const imp = importFont(buf, 'A');
    expect(imp.glyphs).toHaveLength(1);
    const ig = imp.glyphs[0];
    expect(ig.curves).toBeDefined();
    expect(ig.curves!.length).toBeGreaterThan(0);
    for (const c of ig.curves!) assertClosed(c);
    const a1 = area(ig.contours!), a2 = area(flattenCurves(ig.curves!));
    expect(Math.abs(a1 - a2) / Math.abs(a1)).toBeLessThan(0.03);
    expect(Math.abs(a1 - area(cs)) / Math.abs(area(cs))).toBeLessThan(0.08);
  });
});

describe('EditorModel: outline glyphs', () => {
  it('creates curves from contours when missing and emits them', () => {
    const g: Glyph = { char: 'o', unicode: 111, advance: 600, source: 'traced', kind: 'outline', contours: [polygonCircle(300, 300, 200)] };
    const m = new EditorModel(g);
    const out = m.getGlyph();
    expect(g.curves).toBeUndefined();
    expect(out.curves).toBeDefined();
    expect(out.curves!.length).toBe(1);
    expect(Math.abs(area(out.contours!) - area(g.contours!)) / area(g.contours!)).toBeLessThan(0.02);
  });

  it('lists anchors as nodes, handles of curve segments only, and hit tests them', () => {
    const square: CurveContour = { start: [0, 0], segments: [
      [[0, 0], [0, 0], [100, 0], [100, 0]],
      [[100, 0], [100, 0], [100, 100], [100, 100]],
      [[100, 100], [60, 140], [40, 140], [0, 100]],
      [[0, 100], [0, 100], [0, 0], [0, 0]],
    ] };
    const m = new EditorModel(outlineGlyph([square]));
    expect(m.nodes()).toHaveLength(4);
    expect(m.handles()).toHaveLength(2); // only the curved segment
    expect(m.midpoints()).toHaveLength(3);
    const [hx, hy] = C(60, 140);
    expect(m.hitTest(hx + 2, hy + 2, view)).toMatchObject({ type: 'handle', handle: { contour: 0, segment: 2, handle: 1 } });
    const [nx, ny] = C(100, 100);
    expect(m.hitTest(nx, ny, view)).toMatchObject({ type: 'node', node: { contour: 0, segment: 2 } });
    const [sx, sy] = C(30, 0);
    const seg = m.hitTest(sx, sy + 1, view);
    expect(seg).toMatchObject({ type: 'segment', contour: 0, segment: 0 });
    expect((seg as any).pos[0]).toBeCloseTo(30, 0); // t itself is not linear for the degenerate line parametrisation
    expect((seg as any).pos[1]).toBeCloseTo(0, 0);
    const [mx, my] = C(50, 0); // the midpoint marker of a straight segment wins over the segment itself
    expect(m.hitTest(mx + 1, my, view)).toMatchObject({ type: 'midpoint', contour: 0, segment: 0 });
    m.handleMode = 'selected';
    expect(m.handles()).toHaveLength(0);
    m.select({ contour: 0, segment: 2 });
    expect(m.handles()).toHaveLength(1);
  });

  it('splitting a segment keeps the shape (area within 0.5%) and the loop closed', () => {
    const m = new EditorModel(outlineGlyph());
    const before = area(flattenCurves(m.getGlyph().curves!, 32));
    const ref = m.splitSegment(0, 1, 0.37);
    expect(ref).toEqual({ contour: 0, segment: 2 });
    const g = m.getGlyph();
    expect(g.curves![0].segments).toHaveLength(5);
    assertClosed(g.curves![0]);
    const after = area(flattenCurves(g.curves!, 32));
    expect(Math.abs(after - before) / before).toBeLessThan(0.005);
    expect(g.contours).toEqual(flattenCurves(g.curves!)); // contours re-flattened
    expect(Math.hypot(g.curves![0].segments[2][0][0] - 300, g.curves![0].segments[2][0][1] - 300)).toBeCloseTo(200, 0);
  });

  it('dragging an anchor moves both adjacent handles with it; lines stay lines', () => {
    const m = new EditorModel(outlineGlyph());
    m.select({ contour: 0, segment: 1 }); // anchor at (300, 500)
    m.beginDrag(); m.dragNodes(10, 20); m.endDrag();
    const c = m.getGlyph().curves![0];
    assertClosed(c);
    expect(c.segments[1][0]).toEqual([310, 520]);
    expect(c.segments[0][3]).toEqual([310, 520]);
    expect(c.segments[1][1]).toEqual([300 - 0.5522847498 * 200 + 10, 520]); // outgoing handle moved
    expect(c.segments[0][2]).toEqual([300 + 0.5522847498 * 200 + 10, 520]); // incoming handle moved
    expect(c.segments[0][1]).toEqual([500, 300 + 0.5522847498 * 200]); // far handle untouched
    // moving anchor 0 also moves `start`
    m.select({ contour: 0, segment: 0 });
    m.beginDrag(); m.dragNodes(-5, 0); m.endDrag();
    expect(m.getGlyph().curves![0].start).toEqual([495, 300]);

    const square: CurveContour = { start: [0, 0], segments: [
      [[0, 0], [0, 0], [100, 0], [100, 0]], [[100, 0], [100, 0], [100, 100], [100, 100]],
      [[100, 100], [100, 100], [0, 100], [0, 100]], [[0, 100], [0, 100], [0, 0], [0, 0]],
    ] };
    const m2 = new EditorModel(outlineGlyph([square]));
    m2.select({ contour: 0, segment: 1 });
    m2.nudge(30, -10);
    const sq = m2.getGlyph().curves![0];
    assertClosed(sq);
    expect(sq.segments[1][0]).toEqual([130, -10]);
    expect(sq.segments.every((s) => isLine(s))).toBe(true);
  });

  it('deleting an anchor leaves a closed contour and roughly the same shape; the contour dies at 2 anchors', () => {
    const m = new EditorModel(outlineGlyph());
    m.splitSegment(0, 0, 0.5); // 5 anchors
    const before = area(flattenCurves(m.getGlyph().curves!, 32));
    m.select({ contour: 0, segment: 1 });
    expect(m.deleteSelected()).toBe(true);
    const c = m.getGlyph().curves![0];
    expect(c.segments).toHaveLength(4);
    assertClosed(c);
    expect(Math.abs(area(flattenCurves([c], 32)) - before) / before).toBeLessThan(0.02);
    // deleting anchor 0 rotates the start
    m.select({ contour: 0, segment: 0 });
    m.deleteSelected();
    const c2 = m.getGlyph().curves![0];
    expect(c2.segments).toHaveLength(3);
    assertClosed(c2);
    expect(m.getGlyph().contours).toHaveLength(1);
    m.select({ contour: 0, segment: 0 }); m.deleteSelected();
    expect(m.getGlyph().curves![0].segments).toHaveLength(2);
    m.select({ contour: 0, segment: 0 }); m.deleteSelected();
    expect(m.getGlyph().curves).toHaveLength(0);
    expect(m.getGlyph().contours).toHaveLength(0);
    m.undo();
    expect(m.getGlyph().curves![0].segments).toHaveLength(2);
  });

  it('dragging a handle of a smooth anchor keeps the opposite handle collinear (Alt breaks it)', () => {
    const m = new EditorModel(outlineGlyph());
    const c0 = m.getGlyph().curves![0];
    expect(m.isSmooth(c0, 1)).toBe(true);
    const anchor: Vec = [300, 500];
    const oppLen = Math.hypot(c0.segments[0][2][0] - anchor[0], c0.segments[0][2][1] - anchor[1]);
    // rotate the outgoing handle of anchor 1 (segment 1, handle 1) by ~30 degrees
    const target: Vec = [anchor[0] - 90, anchor[1] + 50];
    m.beginDrag(); m.dragHandle({ contour: 0, segment: 1, handle: 1 }, target, false); m.endDrag();
    const c = m.getGlyph().curves![0];
    expect(c.segments[1][1]).toEqual(target);
    const opp = c.segments[0][2];
    const a: Vec = [target[0] - anchor[0], target[1] - anchor[1]], b: Vec = [opp[0] - anchor[0], opp[1] - anchor[1]];
    expect(Math.abs(a[0] * b[1] - a[1] * b[0])).toBeLessThan(1e-6); // collinear
    expect(a[0] * b[0] + a[1] * b[1]).toBeLessThan(0); // opposite directions
    expect(Math.hypot(b[0], b[1])).toBeCloseTo(oppLen, 6); // length preserved
    assertClosed(c);
    // Alt: break symmetry
    m.undo();
    m.beginDrag(); m.dragHandle({ contour: 0, segment: 1, handle: 1 }, target, true); m.endDrag();
    const cb = m.getGlyph().curves![0];
    expect(cb.segments[1][1]).toEqual(target);
    expect(cb.segments[0][2]).toEqual(c0.segments[0][2]);
    // a corner anchor (square) does not mirror
    const corner: CurveContour = { start: [0, 0], segments: [
      [[0, 0], [30, -20], [100, -20], [100, 0]], [[100, 0], [120, 30], [120, 70], [100, 100]],
      [[100, 100], [100, 100], [0, 100], [0, 100]], [[0, 100], [0, 100], [0, 0], [0, 0]],
    ] };
    const m2 = new EditorModel(outlineGlyph([corner]));
    expect(m2.isSmooth(m2.getGlyph().curves![0], 1)).toBe(false);
    m2.beginDrag(); m2.dragHandle({ contour: 0, segment: 1, handle: 1 }, [150, 10], false); m2.endDrag();
    expect(m2.getGlyph().curves![0].segments[0][2]).toEqual([100, -20]);
  });

  it('toggles a straight segment to a curve and back', () => {
    const square: CurveContour = { start: [0, 0], segments: [
      [[0, 0], [0, 0], [100, 0], [100, 0]], [[100, 0], [100, 0], [100, 100], [100, 100]],
      [[100, 100], [100, 100], [0, 100], [0, 100]], [[0, 100], [0, 100], [0, 0], [0, 0]],
    ] };
    const m = new EditorModel(outlineGlyph([square]));
    expect(m.toggleSegmentLine(0, 0)).toBe(true);
    const seg = m.getGlyph().curves![0].segments[0];
    expect(isLine(seg)).toBe(false);
    expect(seg[0]).toEqual([0, 0]); expect(seg[3]).toEqual([100, 0]);
    expect(m.handles()).toHaveLength(2);
    m.toggleSegmentLine(0, 0);
    expect(isLine(m.getGlyph().curves![0].segments[0])).toBe(true);
    expect(m.handles()).toHaveLength(0);
  });

  it('selection survives undo only where nodes still exist; escape-style clear works', () => {
    const m = new EditorModel(outlineGlyph());
    m.splitSegment(0, 3, 0.5); // selects the new node {0,4}
    expect(m.getSelection()!.nodes).toEqual([{ contour: 0, segment: 4 }]);
    m.undo();
    expect(m.getSelection()).toBeNull();
    m.selectAll();
    expect(m.getSelection()!.nodes).toHaveLength(4);
    m.clearSelection();
    expect(m.getSelection()).toBeNull();
  });
});
