/**
 * A small magnifier for touch: while a finger drags a point it hides exactly
 * what is being moved, so the area under the finger is shown enlarged in a
 * corner of the canvas. It copies pixels from the draw canvas, so whatever
 * the tools paint shows up in it.
 */
export class Loupe {
  readonly el: HTMLCanvasElement;
  private at: [number, number] | null = null;

  constructor(private source: HTMLCanvasElement, private size = 108, private mag = 2.4) {
    const el = document.createElement('canvas');
    el.className = 'loupe';
    el.setAttribute('aria-hidden', 'true');
    el.style.display = 'none';
    el.style.width = el.style.height = `${size}px`;
    this.el = el;
  }

  get visible(): boolean { return this.at !== null; }

  /** Show the area around a canvas point (CSS pixels from the canvas' top-left corner). */
  show(x: number, y: number): void {
    this.at = [x, y];
    const w = this.source.clientWidth, h = this.source.clientHeight;
    // bottom centre, out of the way of most drags; jump to the top when the finger gets there
    const left = (w - this.size) / 2, low = h - this.size - 64;
    const underFinger = Math.abs(x - w / 2) < this.size && y > low - this.size * 0.6;
    this.el.style.left = `${Math.round(left)}px`;
    this.el.style.top = `${Math.round(underFinger ? 12 : Math.max(12, low))}px`;
    this.el.style.display = '';
    this.render();
  }

  hide(): void {
    if (!this.at) return;
    this.at = null;
    this.el.style.display = 'none';
  }

  /** Repaint from the source canvas. Call after the source was redrawn. */
  render(): void {
    if (!this.at) return;
    const src = this.source, cssW = src.clientWidth || 1;
    const dpr = src.width / cssW;
    const px = Math.round(this.size * Math.min(2, dpr));
    if (this.el.width !== px) { this.el.width = px; this.el.height = px; }
    const ctx = this.el.getContext('2d');
    if (!ctx) return;
    const span = this.size / this.mag; // CSS pixels of the source shown in the loupe
    ctx.fillStyle = '#0b0c10';
    ctx.fillRect(0, 0, px, px);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(src, (this.at[0] - span / 2) * dpr, (this.at[1] - span / 2) * dpr, span * dpr, span * dpr, 0, 0, px, px);
    // where the finger is
    ctx.strokeStyle = 'rgba(255,255,255,.55)';
    ctx.lineWidth = Math.max(1, px / this.size);
    ctx.beginPath(); ctx.arc(px / 2, px / 2, px * 0.07, 0, Math.PI * 2); ctx.stroke();
  }
}
