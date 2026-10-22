import type { Contour, Stroke, FontMetrics } from '../core/glyph';

export interface View { ox: number; oy: number; s: number } // font (x,y) -> canvas (ox + x*s, oy - y*s)

export function fitView(_width: number, height: number, metrics: FontMetrics, pad = 24): View {
  const top = metrics.ascender + 80, bottom = metrics.descender - 80;
  const s = (height - pad * 2) / (top - bottom);
  return { ox: pad + 40 * s, oy: pad + top * s, s };
}

export function contourPath(contours: Contour[], v: View): Path2D {
  const p = new Path2D();
  for (const c of contours) {
    if (c.points.length < 3) continue;
    const [x0, y0] = c.points[0];
    p.moveTo(v.ox + x0 * v.s, v.oy - y0 * v.s);
    for (let i = 1; i < c.points.length; i++) p.lineTo(v.ox + c.points[i][0] * v.s, v.oy - c.points[i][1] * v.s);
    p.closePath();
  }
  return p;
}

export function drawContours(ctx: CanvasRenderingContext2D, contours: Contour[], v: View, fill: string): void {
  ctx.fillStyle = fill;
  ctx.fill(contourPath(contours, v), 'nonzero');
}

export function drawStrokeRaw(ctx: CanvasRenderingContext2D, s: Stroke, v: View, color: string): void {
  ctx.strokeStyle = color; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (let i = 0; i < s.points.length - 1; i++) {
    const a = s.points[i], b = s.points[i + 1];
    ctx.lineWidth = Math.max(1, (a.w + b.w) * v.s);
    ctx.beginPath();
    ctx.moveTo(v.ox + a.x * v.s, v.oy - a.y * v.s);
    ctx.lineTo(v.ox + b.x * v.s, v.oy - b.y * v.s);
    ctx.stroke();
  }
  if (s.points.length === 1) {
    const a = s.points[0];
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(v.ox + a.x * v.s, v.oy - a.y * v.s, a.w * v.s, 0, Math.PI * 2); ctx.fill();
  }
}

export function drawGuides(ctx: CanvasRenderingContext2D, v: View, m: FontMetrics, advance: number, width: number): void {
  const line = (y: number, color: string, label: string) => {
    const cy = v.oy - y * v.s;
    ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash(y === 0 ? [] : [4, 4]);
    ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(width, cy); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color; ctx.font = '10px ui-monospace, monospace'; ctx.fillText(label, 4, cy - 3);
  };
  line(m.ascender, 'rgba(120,120,255,.5)', 'ascender');
  line(m.capHeight, 'rgba(255,140,0,.6)', 'cap');
  line(m.xHeight, 'rgba(0,180,120,.6)', 'x-height');
  line(0, 'rgba(255,255,255,.55)', 'baseline');
  line(m.descender, 'rgba(255,80,120,.5)', 'descender');
  // sidebearings
  ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.setLineDash([2, 4]);
  for (const x of [0, advance]) { const cx = v.ox + x * v.s; ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, ctx.canvas.height); ctx.stroke(); }
  ctx.setLineDash([]);
}

/** Render contours to a small thumbnail canvas (used by the glyph grid). */
export function renderThumb(canvas: HTMLCanvasElement, contours: Contour[], metrics: FontMetrics, advance: number, fill: string): void {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 72, h = canvas.clientHeight || 80;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const top = metrics.ascender + 60, bottom = metrics.descender - 60;
  const s = Math.min((h - 8) / (top - bottom), (w - 8) / Math.max(400, advance + 80));
  const v: View = { ox: (w - advance * s) / 2, oy: 4 + top * s, s };
  ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.beginPath(); ctx.moveTo(0, v.oy); ctx.lineTo(w, v.oy); ctx.stroke();
  drawContours(ctx, contours, v, fill);
}
