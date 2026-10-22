import type { FontMetrics } from '../../core/glyph';
import { layoutText, type GlyphLookup } from './svg';

/** Draw one specimen frame onto a canvas (used by GIF + WebM export). */
export function drawFrame(ctx: CanvasRenderingContext2D, text: string, lookup: GlyphLookup, metrics: FontMetrics, opts: { fill?: string; bg?: string } = {}): void {
  const { width, height } = ctx.canvas;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = opts.bg ?? '#ffffff';
  ctx.fillRect(0, 0, width, height);
  const lay = layoutText(text, lookup, metrics);
  const pad = 60;
  const s = Math.min((width - pad * 2) / Math.max(1, lay.width), (height - pad * 2) / Math.max(1, lay.height));
  const ox = (width - lay.width * s) / 2, oy = (height - lay.height * s) / 2 + metrics.ascender * s;
  ctx.fillStyle = opts.fill ?? '#111111';
  for (const it of lay.items) {
    ctx.beginPath();
    for (const c of it.g.contours) {
      c.points.forEach((p, i) => { const x = ox + (it.x + p[0]) * s, y = oy - (it.y + p[1]) * s; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.closePath();
    }
    ctx.fill('nonzero');
  }
}
