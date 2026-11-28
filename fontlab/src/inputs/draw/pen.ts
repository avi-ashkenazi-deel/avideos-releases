/**
 * Pen tool for the draw canvas, like the pen in a font editor (Glyphs, Shift):
 * click to place corner points, click and drag to place a smooth point and
 * pull out symmetric curve handles, click the first point (or press Enter) to
 * close the path. The closed path is handed to the host as a `CurveContour`.
 *
 * `PenPath` is the pure, DOM-free model (unit-tested); `PenTool` wraps it with
 * pointer + keyboard handling on the host's canvas and draws the overlay when
 * the host asks. `applyPenContour` merges a finished contour into a glyph.
 *
 * Coordinates: the model works in font units (y up). Hit testing takes canvas
 * pixels plus a `View` (font (x,y) → canvas (ox + x*s, oy − y*s)).
 */
import type { Glyph, CurveContour, Vec } from '../../core/glyph';
import { cloneGlyph } from '../../core/glyph';
import { dist, signedArea } from '../../core/geometry';
import type { View } from '../../ui/render';
import type { Cubic } from '../../outline/fitCurves';
import { curvesFromContours, flattenCurves, lineSegment, normaliseContour } from './curves';

export interface PenAnchor { p: Vec; hIn?: Vec; hOut?: Vec }

/** Hit tolerance in canvas pixels. */
export const PEN_HIT_TOLERANCE = 8;
/** A press turns into a handle drag after this many canvas pixels. */
export const PEN_DRAG_THRESHOLD = 3;

const copy = (p: Vec): Vec => [p[0], p[1]];
const same = (a: Vec, b: Vec) => dist(a, b) < 1e-6;

// ---------------------------------------------------------------- model

export class PenPath {
  anchors: PenAnchor[] = [];

  get length(): number { return this.anchors.length; }
  get last(): PenAnchor | undefined { return this.anchors[this.anchors.length - 1]; }

  /** Add a corner point (no handles). A point on top of the last one is ignored. */
  addCorner(p: Vec): boolean {
    const l = this.last;
    if (l && same(l.p, p)) return false;
    this.anchors.push({ p: copy(p) });
    return true;
  }

  /** Add a smooth point; with `drag`, its handles are pulled out to it straight away. */
  addSmooth(p: Vec, drag?: Vec): boolean {
    if (!this.addCorner(p)) return false;
    if (drag) this.setHandle(drag);
    return true;
  }

  /**
   * Pull the handles of anchor `index` (default: the last one) towards `drag`:
   * hOut = drag, hIn mirrored through the anchor. With `cusp`, only hOut moves.
   * Dragging back onto the anchor removes the handles (a corner again).
   */
  setHandle(drag: Vec, cusp = false, index = this.anchors.length - 1): void {
    const a = this.anchors[index];
    if (!a) return;
    if (same(drag, a.p) && !cusp) { delete a.hIn; delete a.hOut; return; }
    a.hOut = copy(drag);
    if (!cusp) a.hIn = [2 * a.p[0] - drag[0], 2 * a.p[1] - drag[1]];
  }

  removeLast(): boolean { return this.anchors.pop() !== undefined; }
  clear(): void { this.anchors = []; }

  isNearStart(p: Vec, tol: number): boolean {
    return this.anchors.length > 0 && dist(p, this.anchors[0].p) <= tol;
  }

  hasCurve(): boolean { return this.anchors.some((a) => a.hIn || a.hOut); }

  /** A closed path needs 3 points, or 2 with a curve between them. */
  canClose(): boolean {
    const n = this.anchors.length;
    if (n >= 3) return true;
    return n === 2 && this.hasCurve() && !same(this.anchors[0].p, this.anchors[1].p);
  }

  /** The cubic from anchor a to anchor b (a line when neither has a handle on that side). */
  static segment(a: PenAnchor, b: PenAnchor): Cubic {
    if (!a.hOut && !b.hIn) return lineSegment(a.p, b.p);
    return [copy(a.p), copy(a.hOut ?? a.p), copy(b.hIn ?? b.p), copy(b.p)];
  }

  /** Segments of the open path so far (anchor i → i + 1). */
  openSegments(): Cubic[] {
    const out: Cubic[] = [];
    for (let i = 0; i + 1 < this.anchors.length; i++) out.push(PenPath.segment(this.anchors[i], this.anchors[i + 1]));
    return out;
  }

  /**
   * The closed contour: the open segments plus the closing one back to the
   * first point. Zero-length straight segments are dropped. Always counter-
   * clockwise (positive area, the outer-contour convention); a path clicked
   * clockwise is reversed.
   */
  toCurveContour(): CurveContour {
    const n = this.anchors.length;
    if (n < 2) return { start: n ? copy(this.anchors[0].p) : [0, 0], segments: [] };
    const segs: Cubic[] = [];
    for (let i = 0; i < n; i++) {
      const s = PenPath.segment(this.anchors[i], this.anchors[(i + 1) % n]);
      const flatLine = same(s[0], s[3]) && same(s[1], s[0]) && same(s[2], s[3]);
      if (!flatLine) segs.push(s);
    }
    let c = normaliseContour({ start: copy(this.anchors[0].p), segments: segs });
    const flat = flattenCurves([c], 16);
    if (flat.length && signedArea(flat[0].points) < 0) c = reverseContour(c);
    return c;
  }
}

/** Same loop, opposite direction (start point unchanged). */
export function reverseContour(c: CurveContour): CurveContour {
  const segments = c.segments.slice().reverse().map((s) => [copy(s[3]), copy(s[2]), copy(s[1]), copy(s[0])] as Cubic);
  return { start: copy(c.start), segments };
}

/**
 * Add a pen contour to the letter `ch` and return the new glyph (the input is
 * not mutated). `blank` is the host's empty glyph for `ch` (advance etc.).
 *  - no glyph, or a generated one → a new drawn outline glyph with just `c`;
 *  - stroke glyph → becomes an outline glyph that keeps its strokes (they are
 *    unioned with the contours when the letter is built) plus `c`;
 *  - outline glyph → `c` is appended to its curves (fitted from its contours first if needed).
 * The advance is kept, widened to the shape's right edge + 40 if the shape sticks out.
 */
export function applyPenContour(glyph: Glyph | undefined | null, ch: string, c: CurveContour, blank: Glyph): Glyph {
  const cc = normaliseContour(c);
  let g: Glyph;
  if (!glyph || glyph.source === 'generated') {
    g = cloneGlyph(blank);
    g.char = ch;
    g.unicode = ch.codePointAt(0) ?? g.unicode;
    g.kind = 'outline';
    g.source = 'drawn';
    delete g.strokes;
    delete g.recipe;
    g.curves = [cc];
  } else {
    g = cloneGlyph(glyph);
    if (g.kind === 'stroke') {
      g.kind = 'outline';
      g.curves = [cc];
    } else {
      if (!g.curves) g.curves = curvesFromContours(g.contours ?? []);
      g.curves.push(cc);
    }
  }
  g.contours = flattenCurves(g.curves!, 16); // finer than the default: pen shapes are often large single curves
  const shape = flattenCurves([cc], 16);
  if (shape.length) {
    const maxX = Math.max(...shape[0].points.map((p) => p[0]));
    if (maxX > g.advance) g.advance = Math.round(maxX + 40);
  }
  return g;
}

// ---------------------------------------------------------------- DOM tool

export interface PenToolOptions {
  /** a closed path, ready to add to the letter */
  onCommit: (c: CurveContour) => void;
  /** ask the host to repaint (it calls `draw` from its overlay) */
  redraw: () => void;
  /** the path in progress changed (points added / removed / cancelled) */
  onChange?: () => void;
  /** hit tolerance in canvas pixels (default 8) */
  tolerance?: number;
}

interface PenDrag { index: number; startPx: Vec; moved: boolean; added?: boolean }

const toCanvas = (p: Vec, v: View): Vec => [v.ox + p[0] * v.s, v.oy - p[1] * v.s];
const toFont = (c: Vec, v: View): Vec => [(c[0] - v.ox) / v.s, (v.oy - c[1]) / v.s];

export class PenTool {
  readonly canvas: HTMLCanvasElement;
  readonly path = new PenPath();
  private getView: () => View;
  private opts: PenToolOptions;
  private on = false;
  private drag: PenDrag | null = null;
  /** cursor in canvas pixels (null when outside the canvas) */
  private cursor: Vec | null = null;
  private pointerId: number | null = null;
  /** the last pointer was a finger: larger hit areas */
  private touch = false;
  private accent = '#ffd166';
  private prevCursor = '';

  constructor(canvas: HTMLCanvasElement, getView: () => View, opts: PenToolOptions) {
    this.canvas = canvas;
    this.getView = getView;
    this.opts = opts;
  }

  get enabled(): boolean { return this.on; }
  /** a path has been started and not closed or cancelled yet */
  get inProgress(): boolean { return this.path.length > 0; }

  enable(): void {
    if (this.on) return;
    this.on = true;
    this.readAccent();
    this.prevCursor = this.canvas.style.cursor;
    this.canvas.addEventListener('pointerdown', this.onDown);
    this.canvas.addEventListener('pointermove', this.onMove);
    this.canvas.addEventListener('pointerup', this.onUp);
    this.canvas.addEventListener('pointercancel', this.onUp);
    this.canvas.addEventListener('pointerleave', this.onLeave);
    window.addEventListener('keydown', this.onKey);
    this.opts.redraw();
  }

  /** Detach listeners; an unfinished path is dropped. */
  disable(): void {
    if (!this.on) return;
    this.on = false;
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointercancel', this.onUp);
    this.canvas.removeEventListener('pointerleave', this.onLeave);
    window.removeEventListener('keydown', this.onKey);
    this.canvas.style.cursor = this.prevCursor;
    this.drag = null; this.cursor = null;
    if (this.path.length) { this.path.clear(); this.opts.onChange?.(); }
    this.opts.redraw();
  }

  /** Drop the path in progress. */
  cancel(): void {
    this.drag = null;
    if (!this.path.length) return;
    this.path.clear();
    this.changed();
  }

  /** Remove the last point of the path in progress (false when there is none). */
  undoLast(): boolean {
    if (!this.path.length) return false;
    this.drag = null;
    this.path.removeLast();
    this.changed();
    return true;
  }

  /** Close the path and hand it to the host (false when it cannot be closed yet). */
  close(): boolean {
    if (!this.path.canClose()) return false;
    const c = this.path.toCurveContour();
    this.path.clear();
    this.drag = null;
    this.updateCursorStyle();
    this.opts.onChange?.();
    if (c.segments.length) this.opts.onCommit(c);
    this.opts.redraw();
    return true;
  }

  private get tol(): number { return this.opts.tolerance ?? (this.touch ? PEN_HIT_TOLERANCE * 2.2 : PEN_HIT_TOLERANCE); }

  /**
   * Take back what the pointer that is still down has done (a second finger
   * arrived: it is a pinch, not a point).
   */
  cancelPointer(): void {
    const d = this.drag;
    if (!d) return;
    if (this.pointerId !== null) { try { this.canvas.releasePointerCapture(this.pointerId); } catch { /* not captured */ } }
    this.pointerId = null;
    this.drag = null;
    this.cursor = null;
    if (d.added) this.path.removeLast();
    this.changed();
  }

  private changed(): void {
    this.updateCursorStyle();
    this.opts.onChange?.();
    this.opts.redraw();
  }

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

  private nearPx(a: Vec, px: Vec): boolean {
    const [x, y] = toCanvas(a, this.getView());
    return Math.hypot(x - px[0], y - px[1]) <= this.tol;
  }

  /** the cursor is over the first point and a click there would close the path */
  private closeHot(): boolean {
    return !!this.cursor && !this.drag && this.path.canClose() && this.nearPx(this.path.anchors[0].p, this.cursor);
  }

  private updateCursorStyle(): void {
    this.canvas.style.cursor = this.closeHot() ? 'pointer' : '';
  }

  // ---- pointer handlers

  private onDown = (e: PointerEvent) => {
    if (!this.on || e.button !== 0 || this.drag) return; // one point at a time
    this.touch = e.pointerType === 'touch';
    const view = this.getView();
    const px = this.px(e);
    const p = toFont(px, view);
    this.cursor = px;
    const path = this.path;
    if (path.length && path.canClose() && path.isNearStart(p, this.tol / view.s)) { this.close(); return; }
    let index: number, added = false;
    if (path.last && this.nearPx(path.last.p, px)) {
      index = path.length - 1; // drag handles out of the last point instead of stacking a new one on it
    } else {
      path.addCorner(p);
      index = path.length - 1;
      added = true;
      this.opts.onChange?.();
    }
    this.drag = { index, startPx: px, moved: false, added };
    this.pointerId = e.pointerId;
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    this.updateCursorStyle();
    this.opts.redraw();
  };

  private onMove = (e: PointerEvent) => {
    if (!this.on) return;
    const px = this.px(e);
    this.cursor = px;
    const d = this.drag;
    if (d) {
      if (!d.moved && Math.hypot(px[0] - d.startPx[0], px[1] - d.startPx[1]) < PEN_DRAG_THRESHOLD) return;
      d.moved = true;
      this.path.setHandle(toFont(px, this.getView()), e.altKey, d.index);
    }
    this.updateCursorStyle();
    this.opts.redraw();
  };

  private onUp = (e: PointerEvent) => {
    if (!this.on || !this.drag || (this.pointerId !== null && e.pointerId !== this.pointerId)) return;
    if (this.pointerId !== null) { try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ } }
    this.pointerId = null;
    this.drag = null;
    this.updateCursorStyle();
    this.opts.redraw();
  };

  private onLeave = () => {
    if (!this.on || this.drag) return;
    this.cursor = null;
    this.updateCursorStyle();
    this.opts.redraw();
  };

  private onKey = (e: KeyboardEvent) => {
    if (!this.on) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (!this.path.length) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); this.undoLast(); return; }
    if (mod || e.altKey) return;
    switch (e.key) {
      case 'Enter':
        if (t && (t.tagName === 'BUTTON' || t.tagName === 'A')) return; // let a focused button activate
        e.preventDefault();
        this.close();
        return;
      case 'Backspace': case 'Delete':
        e.preventDefault(); this.undoLast(); return;
      case 'Escape':
        e.preventDefault(); this.cancel(); return;
    }
  };

  // ---- overlay

  /** Draw the path in progress. The host calls this after drawing the ink. */
  draw(ctx: CanvasRenderingContext2D, view: View = this.getView()): void {
    if (!this.on) return;
    const path = this.path;
    const accent = this.accent;
    const cur = this.cursor ? toFont(this.cursor, view) : null;
    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const trace = (segs: Cubic[]) => {
      for (const s of segs) {
        const [x1, y1] = toCanvas(s[1], view), [x2, y2] = toCanvas(s[2], view), [x3, y3] = toCanvas(s[3], view);
        ctx.bezierCurveTo(x1, y1, x2, y2, x3, y3);
      }
    };
    if (path.length) {
      const segs = path.openSegments();
      const [sx, sy] = toCanvas(path.anchors[0].p, view);
      // preview fill of the closed shape
      if (path.canClose()) {
        ctx.beginPath(); ctx.moveTo(sx, sy);
        trace(segs);
        trace([PenPath.segment(path.last!, path.anchors[0])]);
        ctx.closePath();
        ctx.fillStyle = withAlpha(accent, 0.12);
        ctx.fill('nonzero');
      }
      // the path so far
      ctx.beginPath(); ctx.moveTo(sx, sy);
      trace(segs);
      ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.setLineDash([]);
      ctx.stroke();
      // rubber band from the last point to the cursor (or to the first point when it would close)
      if (cur && !this.drag) {
        const closing = this.closeHot();
        const target: PenAnchor = closing ? path.anchors[0] : { p: cur };
        const seg = PenPath.segment(path.last!, target);
        const [lx, ly] = toCanvas(path.last!.p, view);
        ctx.beginPath(); ctx.moveTo(lx, ly); trace([seg]);
        ctx.setLineDash([5, 4]); ctx.lineWidth = 1.25;
        ctx.strokeStyle = withAlpha(accent, closing ? 0.95 : 0.7);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // handles
      ctx.lineWidth = 1;
      path.anchors.forEach((a) => {
        const [ax, ay] = toCanvas(a.p, view);
        for (const hnd of [a.hIn, a.hOut]) {
          if (!hnd) continue;
          const [hx, hy] = toCanvas(hnd, view);
          ctx.strokeStyle = withAlpha(accent, 0.6);
          ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(hx, hy); ctx.stroke();
          ctx.fillStyle = accent;
          ctx.beginPath(); ctx.arc(hx, hy, 3, 0, Math.PI * 2); ctx.fill();
        }
      });
      // anchors: squares for corners, circles for smooth points; the first one is larger and lights up when a click would close
      const hot = this.closeHot();
      path.anchors.forEach((a, i) => {
        const [x, y] = toCanvas(a.p, view);
        const first = i === 0, lastOne = i === path.length - 1;
        const size = first ? (hot ? 12 : 9) : lastOne ? 8 : 7;
        ctx.fillStyle = first && hot ? accent : lastOne ? accent : 'rgba(255,255,255,.95)';
        ctx.strokeStyle = first ? accent : 'rgba(0,0,0,.65)';
        ctx.lineWidth = first ? 2 : 1;
        ctx.beginPath();
        if (a.hIn || a.hOut) ctx.arc(x, y, size / 2, 0, Math.PI * 2);
        else ctx.rect(x - size / 2, y - size / 2, size, size);
        ctx.fill(); ctx.stroke();
        if (first && hot) {
          ctx.strokeStyle = withAlpha(accent, 0.5); ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(x, y, size, 0, Math.PI * 2); ctx.stroke();
        }
      });
    }
    // cursor cross-hair dot where the next point would go
    if (cur && !this.drag && !this.closeHot()) {
      const [x, y] = this.cursor!;
      ctx.fillStyle = withAlpha(accent, 0.9);
      ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
}

/** '#rgb' / '#rrggbb' → rgba(); other colour strings are returned unchanged. */
function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  let hex = m[1];
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
