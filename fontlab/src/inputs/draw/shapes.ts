/**
 * Rectangle and ellipse tools for the draw canvas.
 *
 * `rectContour` / `ellipseContour` are pure (unit-tested): two opposite
 * corners in font units → a closed, counter-clockwise `CurveContour`, the same
 * whichever way the corners were dragged. `ShapeTool` wraps them with pointer
 * handling on the host's canvas: drag to preview, Shift = square / circle,
 * Alt = grow from the centre, release hands the contour to the host.
 *
 * Coordinates: font units, y up. Canvas pixels map through a `View`
 * (font (x,y) → canvas (ox + x*s, oy − y*s)).
 */
import type { CurveContour, Vec } from '../../core/glyph';
import type { View } from '../../ui/render';
import { lineSegment } from './curves';

/** Control-point distance for a quarter circle of radius 1. */
export const KAPPA = 0.5523;
/** Drags shorter than this many canvas pixels are ignored (a stray click). */
export const SHAPE_MIN_DRAG = 4;

export type ShapeKind = 'rect' | 'ellipse';

const box = (a: Vec, b: Vec) => ({
  x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]),
  y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]),
});

/** Axis-aligned rectangle through two opposite corners: 4 straight segments, counter-clockwise from the bottom-left corner. */
export function rectContour(a: Vec, b: Vec): CurveContour {
  const { x0, x1, y0, y1 } = box(a, b);
  const p: Vec[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  return { start: [x0, y0], segments: p.map((q, i) => lineSegment(q, p[(i + 1) % 4])) };
}

/** Ellipse inscribed in the box of two opposite corners: 4 cubic quarter arcs, counter-clockwise from the right-most point. */
export function ellipseContour(a: Vec, b: Vec): CurveContour {
  const { x0, x1, y0, y1 } = box(a, b);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
  const kx = rx * KAPPA, ky = ry * KAPPA;
  const E: Vec = [x1, cy], N: Vec = [cx, y1], W: Vec = [x0, cy], S: Vec = [cx, y0];
  const P = (p: Vec): Vec => [p[0], p[1]];
  return {
    start: P(E),
    segments: [
      [P(E), [x1, cy + ky], [cx + kx, y1], P(N)],
      [P(N), [cx - kx, y1], [x0, cy + ky], P(W)],
      [P(W), [x0, cy - ky], [cx - kx, y0], P(S)],
      [P(S), [cx + kx, y0], [x1, cy - ky], P(E)],
    ],
  };
}

export function shapeContour(kind: ShapeKind, a: Vec, b: Vec): CurveContour {
  return kind === 'ellipse' ? ellipseContour(a, b) : rectContour(a, b);
}

/**
 * The two opposite corners for a drag from `start` to `cur`.
 * `square`: equal width and height (the longer side wins). `centre`: `start`
 * is the middle of the shape instead of a corner.
 */
export function dragCorners(start: Vec, cur: Vec, opts: { square?: boolean; centre?: boolean } = {}): [Vec, Vec] {
  let dx = cur[0] - start[0], dy = cur[1] - start[1];
  if (opts.square) {
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    dx = (dx < 0 ? -1 : 1) * m; dy = (dy < 0 ? -1 : 1) * m;
  }
  if (opts.centre) return [[start[0] - dx, start[1] - dy], [start[0] + dx, start[1] + dy]];
  return [[start[0], start[1]], [start[0] + dx, start[1] + dy]];
}

// ---------------------------------------------------------------- shared canvas helpers

/** The app's accent colour (CSS `--accent`), with a fallback outside a styled document. */
export function cssAccent(): string {
  try { return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#ffd166'; } catch { return '#ffd166'; }
}

/** '#rgb' / '#rrggbb' → rgba(); other colour strings are returned unchanged. */
export function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  let hex = m[1];
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export const toCanvas = (p: Vec, v: View): Vec => [v.ox + p[0] * v.s, v.oy - p[1] * v.s];
export const toFont = (c: Vec, v: View): Vec => [(c[0] - v.ox) / v.s, (v.oy - c[1]) / v.s];

/** Small dark pill with light text, used for size / hint read-outs next to the cursor. */
export function drawPill(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  ctx.save();
  ctx.font = '600 10px ui-monospace, monospace';
  const w = ctx.measureText(text).width + 10, hgt = 16;
  const maxX = (ctx.canvas.clientWidth || ctx.canvas.width) - w - 2;
  const px = Math.max(2, Math.min(maxX, x)), py = Math.max(2, y);
  ctx.fillStyle = 'rgba(17,18,22,.88)';
  ctx.beginPath();
  if (typeof (ctx as any).roundRect === 'function') (ctx as any).roundRect(px, py, w, hgt, 5); else ctx.rect(px, py, w, hgt);
  ctx.fill();
  ctx.fillStyle = '#e9e9ee';
  ctx.fillText(text, px + 5, py + 11.5);
  ctx.restore();
}

// ---------------------------------------------------------------- DOM tool

export interface ShapeToolOptions {
  /** a finished shape, ready to add to the letter */
  onCommit: (c: CurveContour, kind: ShapeKind) => void;
  /** ask the host to repaint (it calls `draw` from its overlay) */
  redraw: () => void;
  /** shortest drag that counts, in canvas pixels (default 4) */
  minDrag?: number;
}

interface ShapeDrag { startPx: Vec; curPx: Vec; shift: boolean; alt: boolean; pointerId: number }

const round1 = (v: number) => Math.round(v * 10) / 10;

export class ShapeTool {
  readonly canvas: HTMLCanvasElement;
  kind: ShapeKind = 'rect';
  private getView: () => View;
  private opts: ShapeToolOptions;
  private on = false;
  private drag: ShapeDrag | null = null;
  private accent = '#ffd166';

  constructor(canvas: HTMLCanvasElement, getView: () => View, opts: ShapeToolOptions) {
    this.canvas = canvas;
    this.getView = getView;
    this.opts = opts;
  }

  get enabled(): boolean { return this.on; }
  /** a shape is being dragged out right now */
  get dragging(): boolean { return this.drag !== null; }

  enable(kind: ShapeKind): void {
    this.kind = kind;
    if (this.on) { this.opts.redraw(); return; }
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

  /** Drop the shape being dragged. */
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

  /** The dragged corners in font units, rounded to 0.1 (null when the drag is too small to count). */
  private corners(d: ShapeDrag): [Vec, Vec] | null {
    const view = this.getView();
    const [a, b] = dragCorners(toFont(d.startPx, view), toFont(d.curPx, view), { square: d.shift, centre: d.alt });
    const min = this.opts.minDrag ?? SHAPE_MIN_DRAG;
    if (Math.hypot(d.curPx[0] - d.startPx[0], d.curPx[1] - d.startPx[1]) < min) return null;
    const ra: Vec = [round1(a[0]), round1(a[1])], rb: Vec = [round1(b[0]), round1(b[1])];
    // a flat drag has no area: nothing to add
    if (Math.abs(rb[0] - ra[0]) * view.s < 1 || Math.abs(rb[1] - ra[1]) * view.s < 1) return null;
    return [ra, rb];
  }

  private onDown = (e: PointerEvent) => {
    if (!this.on || e.button !== 0) return;
    const p = this.px(e);
    this.drag = { startPx: p, curPx: p, shift: e.shiftKey, alt: e.altKey, pointerId: e.pointerId };
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    e.preventDefault();
    this.opts.redraw();
  };

  private onMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!this.on || !d) return;
    d.curPx = this.px(e); d.shift = e.shiftKey; d.alt = e.altKey;
    this.opts.redraw();
  };

  private onUp = (e: PointerEvent) => {
    const d = this.drag;
    if (!this.on || !d) return;
    d.curPx = this.px(e); d.shift = e.shiftKey; d.alt = e.altKey;
    const c = this.corners(d);
    this.release();
    if (c) this.opts.onCommit(shapeContour(this.kind, c[0], c[1]), this.kind);
    this.opts.redraw();
  };

  private onCancel = () => { if (this.on) this.cancel(); };

  /** Shift / Alt pressed or released while the pointer rests: update the preview. */
  private onModifier = (e: KeyboardEvent) => {
    const d = this.drag;
    if (!d || (e.key !== 'Shift' && e.key !== 'Alt')) return;
    if (e.key === 'Alt') e.preventDefault(); // keep the browser menu from taking focus mid-drag
    d.shift = e.shiftKey; d.alt = e.altKey;
    this.opts.redraw();
  };

  /** Draw the shape being dragged. The host calls this after drawing the ink. */
  draw(ctx: CanvasRenderingContext2D, view: View = this.getView()): void {
    const d = this.drag;
    if (!this.on || !d) return;
    const c = this.corners(d);
    if (!c) return;
    const shape = shapeContour(this.kind, c[0], c[1]);
    ctx.save();
    ctx.beginPath();
    const [sx, sy] = toCanvas(shape.start, view);
    ctx.moveTo(sx, sy);
    for (const s of shape.segments) {
      const [x1, y1] = toCanvas(s[1], view), [x2, y2] = toCanvas(s[2], view), [x3, y3] = toCanvas(s[3], view);
      ctx.bezierCurveTo(x1, y1, x2, y2, x3, y3);
    }
    ctx.closePath();
    ctx.fillStyle = withAlpha(this.accent, 0.22);
    ctx.fill();
    ctx.strokeStyle = this.accent; ctx.lineWidth = 1.5; ctx.setLineDash([]);
    ctx.stroke();
    if (d.alt) { // centre mark
      ctx.fillStyle = this.accent;
      ctx.beginPath(); ctx.arc(d.startPx[0], d.startPx[1], 2.5, 0, Math.PI * 2); ctx.fill();
    }
    const w = Math.abs(c[1][0] - c[0][0]), hgt = Math.abs(c[1][1] - c[0][1]);
    drawPill(ctx, `${Math.round(w)} × ${Math.round(hgt)}`, d.curPx[0] + 12, d.curPx[1] + 12);
    ctx.restore();
  }
}
