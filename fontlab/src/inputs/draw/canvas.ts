import type { Glyph, Stroke, StrokePoint, FontMetrics, CapStyle, Contour } from '../../core/glyph';
import { uid } from '../../core/glyph';
import { simplifyRDP } from '../../core/geometry';
import { fitView, drawContours, drawGuides, drawStrokeRaw, type View } from '../../ui/render';

export interface BrushSettings {
  /** full stroke width in font units */
  width: number;
  cap: CapStyle;
  /** 0..1: how much pointer pressure modulates width */
  pressure: number;
  /** 0..1: faster strokes get thinner (calligraphic feel) */
  velocity: number;
  /** 0..1 smoothing of the raw pointer path */
  smooth: number;
  /** mirror strokes horizontally about the glyph centre (symmetry mode) */
  mirror: boolean;
}

export const DEFAULT_BRUSH: BrushSettings = { width: 90, cap: 'round', pressure: 0.6, velocity: 0.35, smooth: 0.5, mirror: false };

interface Live { pts: StrokePoint[]; lastT: number; lastX: number; lastY: number }

/**
 * Pointer-driven glyph editor. Holds no project state of its own: the host
 * passes the current glyph and receives `onStroke` when a stroke completes.
 */
export class DrawCanvas {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private view: View;
  private live: Live | null = null;
  glyph: Glyph | null = null;
  contours: Contour[] = [];
  metrics: FontMetrics;
  brush: BrushSettings = { ...DEFAULT_BRUSH };
  onStroke: (s: Stroke) => void = () => {};
  /** 'draw' = freehand strokes; 'edit' = pointer events belong to the point editor */
  mode: 'draw' | 'edit' = 'draw';
  /** extra overlay drawn after the glyph (the point editor's nodes) */
  overlay: ((ctx: CanvasRenderingContext2D, view: View) => void) | null = null;
  getView(): View { return this.view; }

  constructor(canvas: HTMLCanvasElement, metrics: FontMetrics) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.metrics = metrics;
    this.view = fitView(canvas.clientWidth, canvas.clientHeight, metrics);
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('pointerleave', this.onUp);
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth || 480, h = this.canvas.clientHeight || 520;
    this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.view = fitView(w, h, this.metrics);
    this.draw();
  }

  setGlyph(g: Glyph | null, contours: Contour[]): void { this.glyph = g; this.contours = contours; this.draw(); }

  private toFont(e: PointerEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    const cx = e.clientX - r.left, cy = e.clientY - r.top;
    return [(cx - this.view.ox) / this.view.s, (this.view.oy - cy) / this.view.s];
  }

  private widthFor(e: PointerEvent, speed: number): number {
    const b = this.brush;
    let w = b.width;
    const pr = e.pointerType === 'mouse' ? 0.5 : e.pressure || 0.5;
    w *= 1 + (pr - 0.5) * 1.6 * b.pressure;
    const v = Math.min(1, speed / 3000); // font units per second
    w *= 1 - v * 0.7 * b.velocity;
    return Math.max(6, w) / 2;
  }

  private onDown = (e: PointerEvent) => {
    if (!this.glyph || this.mode !== 'draw') return;
    this.canvas.setPointerCapture(e.pointerId);
    const [x, y] = this.toFont(e);
    this.live = { pts: [{ x, y, w: this.widthFor(e, 0), p: e.pressure }], lastT: e.timeStamp, lastX: x, lastY: y };
  };
  private onMove = (e: PointerEvent) => {
    if (!this.live) return;
    const events = (e as any).getCoalescedEvents?.() as PointerEvent[] | undefined;
    for (const ev of events && events.length ? events : [e]) {
      const [x, y] = this.toFont(ev);
      const dt = Math.max(1, ev.timeStamp - this.live.lastT) / 1000;
      const d = Math.hypot(x - this.live.lastX, y - this.live.lastY);
      if (d < 1.5) continue;
      const speed = d / dt;
      const prev = this.live.pts[this.live.pts.length - 1];
      const w = prev.w * 0.6 + this.widthFor(ev, speed) * 0.4; // low-pass the width
      this.live.pts.push({ x, y, w, p: ev.pressure });
      this.live.lastT = ev.timeStamp; this.live.lastX = x; this.live.lastY = y;
    }
    this.draw();
  };
  private onUp = (e: PointerEvent) => {
    if (!this.live) return;
    try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    const pts = this.finish(this.live.pts);
    this.live = null;
    if (pts.length) {
      this.onStroke({ id: uid('s'), points: pts, cap: this.brush.cap });
      if (this.brush.mirror && this.glyph) {
        const cx = this.glyph.advance / 2;
        this.onStroke({ id: uid('s'), points: pts.map((p) => ({ ...p, x: 2 * cx - p.x })), cap: this.brush.cap });
      }
    }
    this.draw();
  };

  /** smooth + simplify a raw pointer trail, keeping widths. */
  private finish(raw: StrokePoint[]): StrokePoint[] {
    if (raw.length === 0) return [];
    if (raw.length < 3) return raw.map((p) => ({ ...p }));
    const k = this.brush.smooth;
    const passes = Math.round(k * 3);
    let pts = raw.map((p) => ({ ...p }));
    for (let n = 0; n < passes; n++) {
      const out = pts.map((p) => ({ ...p }));
      for (let i = 1; i < pts.length - 1; i++) {
        out[i].x = (pts[i - 1].x + 2 * pts[i].x + pts[i + 1].x) / 4;
        out[i].y = (pts[i - 1].y + 2 * pts[i].y + pts[i + 1].y) / 4;
        out[i].w = (pts[i - 1].w + 2 * pts[i].w + pts[i + 1].w) / 4;
      }
      pts = out;
    }
    const xy = pts.map((p) => [p.x, p.y] as [number, number]);
    const simp = simplifyRDP(xy, 1.2 + k * 1.5);
    // map widths back by nearest original index
    const out: StrokePoint[] = [];
    let j = 0;
    for (const [x, y] of simp) {
      while (j < pts.length - 1 && (pts[j].x !== x || pts[j].y !== y)) j++;
      out.push({ x: round1(x), y: round1(y), w: round1(pts[Math.min(j, pts.length - 1)].w), p: pts[Math.min(j, pts.length - 1)].p });
    }
    return out;
  }

  draw(): void {
    const { ctx, view } = this;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    if (!this.glyph) return;
    drawGuides(ctx, view, this.metrics, this.glyph.advance, w);
    // finished ink
    drawContours(ctx, this.contours, view, 'rgba(255,255,255,.92)');
    // centrelines of stroke glyphs (subtle)
    if (this.glyph.kind === 'stroke' && this.glyph.strokes) {
      ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 1;
      for (const s of this.glyph.strokes) {
        ctx.beginPath();
        s.points.forEach((p, i) => { const cx = view.ox + p.x * view.s, cy = view.oy - p.y * view.s; i ? ctx.lineTo(cx, cy) : ctx.moveTo(cx, cy); });
        ctx.stroke();
      }
    }
    if (this.live) drawStrokeRaw(ctx, { id: 'live', points: this.live.pts, cap: this.brush.cap }, view, 'rgba(255,230,0,.9)');
    if (this.overlay) this.overlay(ctx, view);
  }
}

const round1 = (v: number) => Math.round(v * 10) / 10;
