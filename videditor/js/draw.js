// Canvas overlay for drawing on the frame. Strokes are stored in normalized
// coordinates [x 0..1, y 0..1, videoTime] so they survive any display size.
export const COLORS = ['#ff4d4d', '#ffd166', '#5fd38d', '#7cc4ff', '#ffffff'];

export class DrawLayer {
  constructor(canvas, getTime) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.getTime = getTime;
    this.tool = 'pen'; this.color = COLORS[0]; this.width = 4; this.enabled = false;
    this.strokes = []; this.live = null; this.ghost = []; this.onChange = null;
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(canvas);
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointercancel', (e) => this.up(e));
    this.resize();
  }
  setEnabled(v) { this.enabled = v; this.canvas.classList.toggle('drawing', v); this.canvas.style.pointerEvents = v ? 'auto' : 'none'; }
  resize() { const r = this.canvas.getBoundingClientRect(); const dpr = devicePixelRatio || 1; this.canvas.width = Math.max(1, r.width * dpr); this.canvas.height = Math.max(1, r.height * dpr); this.render(); }
  pos(e) { const r = this.canvas.getBoundingClientRect(); return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)), this.getTime()]; }
  down(e) { if (!this.enabled || e.button !== 0) return; this.canvas.setPointerCapture(e.pointerId); this.live = { tool: this.tool, color: this.color, width: this.width, points: [this.pos(e)] }; this.render(); }
  move(e) { if (!this.live) return; const p = this.pos(e); if (this.tool === 'pen') this.live.points.push(p); else this.live.points[1] = p; this.render(); }
  up() { if (!this.live) return; if (this.live.points.length === 1) this.live.points.push([...this.live.points[0]]); this.strokes.push(this.live); this.live = null; this.render(); this.onChange?.(this.strokes); }
  undo() { this.strokes.pop(); this.render(); this.onChange?.(this.strokes); }
  clear() { this.strokes = []; this.live = null; this.render(); this.onChange?.(this.strokes); }
  /** Strokes from saved comments to show (already filtered by time). */
  setGhost(strokes) { this.ghost = strokes || []; this.render(); }
  render() { const { ctx, canvas } = this; ctx.clearRect(0, 0, canvas.width, canvas.height); for (const s of this.ghost) drawStroke(ctx, s, canvas.width, canvas.height); for (const s of this.strokes) drawStroke(ctx, s, canvas.width, canvas.height); if (this.live) drawStroke(ctx, this.live, canvas.width, canvas.height); }
  /** Composite the current video frame with given strokes to a JPEG data URL. */
  static snapshot(video, strokes, { maxWidth = 1280, quality = 0.85 } = {}) {
    const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
    const scale = Math.min(1, maxWidth / vw);
    const c = document.createElement('canvas'); c.width = Math.round(vw * scale); c.height = Math.round(vh * scale);
    const ctx = c.getContext('2d');
    try { ctx.drawImage(video, 0, 0, c.width, c.height); } catch { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, c.width, c.height); }
    for (const s of strokes || []) drawStroke(ctx, s, c.width, c.height);
    return c.toDataURL('image/jpeg', quality);
  }
}

export function drawStroke(ctx, s, W, H, upTo = Infinity) {
  const pts = s.points.filter((p) => p[2] <= upTo + 1e-6); if (!pts.length) return;
  const lw = (s.width || 4) * (W / 900);
  ctx.save(); ctx.strokeStyle = s.color || '#ff4d4d'; ctx.fillStyle = s.color || '#ff4d4d'; ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = lw;
  const P = (p) => [p[0] * W, p[1] * H];
  if (s.tool === 'pen' || pts.length < 2) { ctx.beginPath(); pts.forEach((p, i) => { const [x, y] = P(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); if (pts.length === 1) { const [x, y] = P(pts[0]); ctx.arc(x, y, lw / 2, 0, Math.PI * 2); ctx.fill(); } ctx.stroke(); }
  else {
    const [x1, y1] = P(pts[0]); const [x2, y2] = P(pts[pts.length - 1]);
    if (s.tool === 'rect') { ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)); }
    else if (s.tool === 'ellipse') { ctx.beginPath(); ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2 || 1, Math.abs(y2 - y1) / 2 || 1, 0, 0, Math.PI * 2); ctx.stroke(); }
    else if (s.tool === 'arrow') { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); const a = Math.atan2(y2 - y1, x2 - x1), hl = lw * 4; ctx.beginPath(); ctx.moveTo(x2, y2); ctx.lineTo(x2 - hl * Math.cos(a - Math.PI / 7), y2 - hl * Math.sin(a - Math.PI / 7)); ctx.lineTo(x2 - hl * Math.cos(a + Math.PI / 7), y2 - hl * Math.sin(a + Math.PI / 7)); ctx.closePath(); ctx.fill(); }
  }
  ctx.restore();
}
