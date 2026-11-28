import type { Vec } from '../../core/glyph';
import { zoomAbout, isZoomed, type Zoom } from './zoom';

export interface GestureHost {
  getZoom(): Zoom;
  setZoom(z: Zoom): void;
  /**
   * A further finger went down while one is already on the canvas. True when
   * the active tool wants it (a second point to drag); otherwise the two
   * fingers become a pinch.
   */
  claims?(e: PointerEvent): boolean;
  /** Drop whatever the first finger started: the gesture takes over. */
  cancelTool(): void;
}

interface Pinch { a: number; b: number; d0: number; m0: Vec; z0: Zoom }

/**
 * Two-finger zoom and pan for the draw canvas, in every tool. It listens in
 * the capture phase on the canvas' wrapper, so it sees each touch before the
 * tool does and can keep the tool out of a pinch. Ctrl/Cmd + wheel (and a
 * trackpad pinch) zooms on desktop; the wheel pans while zoomed in.
 */
export class TouchGestures {
  private touches = new Map<number, Vec>();
  private pinch: Pinch | null = null;
  /** from the start of a pinch until every finger is up, the tools see nothing */
  private swallow = false;
  private lastGesture = -1e9;

  constructor(wrap: HTMLElement, private canvas: HTMLCanvasElement, private host: GestureHost) {
    wrap.addEventListener('pointerdown', this.onDown, true);
    wrap.addEventListener('pointermove', this.onMove, true);
    wrap.addEventListener('pointerup', this.onUp, true);
    wrap.addEventListener('pointercancel', this.onUp, true);
    wrap.addEventListener('click', this.onClick, true);
    wrap.addEventListener('dblclick', this.onClick, true);
    wrap.addEventListener('wheel', this.onWheel, { passive: false });
  }

  /** a pinch is in progress, or just ended and fingers are still down */
  get active(): boolean { return this.swallow; }

  private px(e: MouseEvent): Vec {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }
  private mine(e: PointerEvent): boolean { return e.pointerType === 'touch' && e.target === this.canvas; }
  private stop(e: Event): void { e.stopPropagation(); if (e.cancelable) e.preventDefault(); }

  private begin(): void {
    const [a, b] = [...this.touches.keys()];
    const pa = this.touches.get(a)!, pb = this.touches.get(b)!;
    this.pinch = { a, b, d0: Math.max(8, Math.hypot(pb[0] - pa[0], pb[1] - pa[1])), m0: [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2], z0: this.host.getZoom() };
  }

  private onDown = (e: PointerEvent) => {
    if (!this.mine(e)) return;
    this.touches.set(e.pointerId, this.px(e));
    if (this.swallow) {
      // a finger came back during a gesture: two fingers pinch again
      if (!this.pinch && this.touches.size === 2) this.begin();
      this.stop(e);
      return;
    }
    if (this.touches.size !== 2 || this.host.claims?.(e)) return;
    this.host.cancelTool();
    this.swallow = true;
    this.begin();
    this.stop(e);
  };

  private onMove = (e: PointerEvent) => {
    if (!this.touches.has(e.pointerId)) return;
    this.touches.set(e.pointerId, this.px(e));
    if (!this.swallow) return;
    const p = this.pinch;
    if (p && (e.pointerId === p.a || e.pointerId === p.b)) {
      const pa = this.touches.get(p.a)!, pb = this.touches.get(p.b)!;
      const d = Math.max(8, Math.hypot(pb[0] - pa[0], pb[1] - pa[1]));
      this.host.setZoom(zoomAbout(p.z0, p.m0, [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2], d / p.d0));
    }
    this.stop(e);
  };

  private onUp = (e: PointerEvent) => {
    if (!this.touches.delete(e.pointerId)) return;
    if (!this.swallow) return;
    this.stop(e);
    if (this.pinch && (e.pointerId === this.pinch.a || e.pointerId === this.pinch.b)) this.pinch = null;
    this.lastGesture = performance.now();
    if (this.touches.size === 0) this.swallow = false;
  };

  /** the tap a browser may report after a pinch is not a tap */
  private onClick = (e: Event) => { if (performance.now() - this.lastGesture < 350) this.stop(e); };

  private onWheel = (e: WheelEvent) => {
    const z = this.host.getZoom();
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const at = this.px(e);
      this.host.setZoom(zoomAbout(z, at, at, Math.exp(-e.deltaY * 0.01)));
    } else if (isZoomed(z)) {
      e.preventDefault();
      this.host.setZoom({ k: z.k, tx: z.tx - e.deltaX, ty: z.ty - e.deltaY });
    }
  };
}
