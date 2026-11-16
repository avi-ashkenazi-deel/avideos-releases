import { h, help } from '../dom';
import { store } from '../state';
import { FX } from '../../fx/registry';
import type { FxLayer, FxParamDef } from '../../fx/types';
import type { Contour } from '../../core/glyph';
import { drawContours, type View } from '../render';
import { liveRequest, liveFinish } from '../liveBuild';

interface Axis { layer: FxLayer; p: FxParamDef; label: string; id: string }

const isToggle = (p: FxParamDef) => p.step >= 1 && p.max - p.min <= 1 && p.min === 0;

/** Every slider param in the stack, as pad axis candidates. */
function candidates(): Axis[] {
  const out: Axis[] = [];
  for (const g of store.project.fx.groups) for (const l of g.layers) {
    const def = FX[l.type]?.def; if (!def) continue;
    for (const p of def.params) if (!isToggle(p)) out.push({ layer: l, p, label: `${def.label} · ${p.label}`, id: `${l.id}|${p.key}` });
  }
  return out;
}

const fmt = (p: FxParamDef, v: number) => (p.step < 0.01 ? v.toFixed(3) : p.step < 1 ? v.toFixed(2) : v.toFixed(0));
const snap = (p: FxParamDef, v: number) => Math.min(p.max, Math.max(p.min, Math.round(v / p.step) * p.step));

/**
 * Two-axis drag pad (after Allo's weight × roundness pad): X drives one effect
 * slider, Y another; the selected letter is drawn live with its outline points.
 * `onParam` keeps the matching slider in the effects list in sync.
 */
export function xyPad(onParam: (layerId: string, key: string, v: number) => void): HTMLElement {
  const xSel = h('select', { 'aria-label': 'X axis', 'data-testid': 'pad-x' });
  const ySel = h('select', { 'aria-label': 'Y axis', 'data-testid': 'pad-y' });
  const pad = h('canvas', { class: 'padcanvas', tabindex: 0, 'data-testid': 'pad', 'aria-label': 'Drag to change two effect settings at once' });
  const glyphCv = h('canvas', { class: 'padglyph' });
  const readout = h('div', { class: 'padread' });
  const empty = h('div', { class: 'fxempty' }, 'Add an effect with sliders to use the pad.');
  let axes: Axis[] = [];
  let sig = '';

  const axis = (sel: HTMLSelectElement) => axes.find((a) => a.id === sel.value) ?? null;
  const val = (a: Axis | null) => (a ? (a.layer.params[a.p.key] ?? a.p.default) : 0);
  const norm = (a: Axis | null) => (a ? (val(a) - a.p.min) / (a.p.max - a.p.min || 1) : 0.5);

  const fill = () => {
    const next = candidates();
    const nsig = next.map((a) => a.id).join(',');
    axes = next;
    if (nsig === sig) return;
    sig = nsig;
    const keepX = xSel.value, keepY = ySel.value;
    const opts = (sel: HTMLSelectElement, none: boolean) => sel.replaceChildren(...(none ? [h('option', { value: '' }, 'none')] : []), ...axes.map((a) => h('option', { value: a.id }, a.label)));
    opts(xSel, false); opts(ySel, true);
    xSel.value = axes.some((a) => a.id === keepX) ? keepX : axes[0]?.id ?? '';
    ySel.value = axes.some((a) => a.id === keepY) ? keepY : axes.find((a) => a.id !== xSel.value)?.id ?? '';
    const has = axes.length > 0;
    empty.style.display = has ? 'none' : '';
    for (const el of [xSel, ySel, pad]) (el as HTMLElement).style.display = has ? '' : 'none';
  };

  const size = (cv: HTMLCanvasElement) => {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || 260, hh = cv.clientHeight || 200;
    if (cv.width !== w * dpr || cv.height !== hh * dpr) { cv.width = w * dpr; cv.height = hh * dpr; }
    const ctx = cv.getContext('2d')!; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h: hh };
  };

  const drawPad = () => {
    const { ctx, w, h: H } = size(pad);
    const css = getComputedStyle(document.documentElement);
    const accent = css.getPropertyValue('--accent').trim() || '#ffd166';
    const muted = css.getPropertyValue('--muted').trim() || '#888';
    ctx.clearRect(0, 0, w, H);
    ctx.strokeStyle = 'rgba(255,255,255,.07)'; ctx.lineWidth = 1;
    for (let i = 1; i < 10; i++) { const x = (w * i) / 10, y = (H * i) / 10; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    const ax = axis(xSel), ay = axis(ySel);
    ctx.fillStyle = muted; ctx.font = '10px ui-monospace, monospace';
    if (ax) { ctx.fillText(fmt(ax.p, ax.p.min), 4, H - 4); const t = fmt(ax.p, ax.p.max); ctx.fillText(t, w - 4 - ctx.measureText(t).width, H - 4); }
    if (ay) { ctx.fillText(fmt(ay.p, ay.p.max), 4, 12); }
    const px = norm(ax) * w, py = (1 - (ay ? norm(ay) : 0.5)) * H;
    ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); if (ay) { ctx.moveTo(0, py); ctx.lineTo(w, py); } ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(px, py, 7, 0, Math.PI * 2); ctx.fill();
    readout.textContent = [ax && `${ax.label} ${fmt(ax.p, val(ax))}`, ay && `${ay.label} ${fmt(ay.p, val(ay))}`].filter(Boolean).join('   ');
  };

  const drawGlyph = () => {
    const { ctx, w, h: H } = size(glyphCv);
    ctx.clearRect(0, 0, w, H);
    const b = store.built[store.selected];
    const m = store.project.metrics;
    const contours: Contour[] = b?.contours ?? [];
    const adv = b?.advance ?? 500;
    const top = m.ascender + 60, bottom = m.descender - 60;
    const s = Math.min((H - 16) / (top - bottom), (w - 16) / Math.max(400, adv + 80));
    const v: View = { ox: (w - adv * s) / 2, oy: 8 + top * s, s };
    ctx.strokeStyle = 'rgba(255,255,255,.15)';
    for (const y of [0, m.xHeight, m.capHeight]) { ctx.beginPath(); ctx.moveTo(0, v.oy - y * s); ctx.lineTo(w, v.oy - y * s); ctx.stroke(); }
    drawContours(ctx, contours, v, 'rgba(255,255,255,.9)');
    // outline points (thinned so dense outlines stay readable)
    const total = contours.reduce((n, c) => n + c.points.length, 0);
    const every = Math.max(1, Math.ceil(total / 260));
    ctx.fillStyle = '#ff3b6b'; ctx.strokeStyle = '#111';
    let i = 0;
    for (const c of contours) for (const [x, y] of c.points) { if (i++ % every) continue; ctx.fillRect(v.ox + x * s - 2, v.oy - y * s - 2, 4, 4); }
  };

  const setFrom = (ev: PointerEvent) => {
    const r = pad.getBoundingClientRect();
    const nx = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
    const ny = Math.min(1, Math.max(0, 1 - (ev.clientY - r.top) / r.height));
    apply(nx, ny);
  };
  const apply = (nx: number, ny: number | null) => {
    const ax = axis(xSel), ay = axis(ySel);
    if (ax) { const v = snap(ax.p, ax.p.min + nx * (ax.p.max - ax.p.min)); ax.layer.params[ax.p.key] = v; onParam(ax.layer.id, ax.p.key, v); }
    if (ay && ny != null) { const v = snap(ay.p, ay.p.min + ny * (ay.p.max - ay.p.min)); ay.layer.params[ay.p.key] = v; onParam(ay.layer.id, ay.p.key, v); }
    store.emit('fx');
    drawPad();
    liveRequest();
  };
  let dragging = false;
  pad.addEventListener('pointerdown', (e) => { if (!axis(xSel)) return; dragging = true; pad.setPointerCapture(e.pointerId); setFrom(e); });
  pad.addEventListener('pointermove', (e) => { if (dragging) setFrom(e); });
  const end = () => { if (!dragging) return; dragging = false; liveFinish(); };
  pad.addEventListener('pointerup', end);
  pad.addEventListener('pointercancel', end);
  pad.addEventListener('dblclick', () => {
    for (const a of [axis(xSel), axis(ySel)]) if (a) { a.layer.params[a.p.key] = a.p.default; onParam(a.layer.id, a.p.key, a.p.default); }
    store.emit('fx'); drawPad(); liveFinish();
  });
  pad.addEventListener('keydown', (e) => {
    const ax = axis(xSel), ay = axis(ySel);
    const step = e.shiftKey ? 0.1 : 0.02;
    let nx = norm(ax), ny = ay ? norm(ay) : null;
    if (e.key === 'ArrowLeft') nx -= step; else if (e.key === 'ArrowRight') nx += step;
    else if (e.key === 'ArrowUp' && ny != null) ny += step; else if (e.key === 'ArrowDown' && ny != null) ny -= step;
    else return;
    e.preventDefault(); e.stopPropagation();
    apply(Math.min(1, Math.max(0, nx)), ny == null ? null : Math.min(1, Math.max(0, ny)));
    liveFinish();
  });
  xSel.addEventListener('change', drawPad);
  ySel.addEventListener('change', drawPad);

  const card = h('div', { class: 'xypad', 'data-testid': 'xypad' },
    h('div', { class: 'row padaxes' }, h('label', {}, 'X ', xSel), h('label', {}, 'Y ', ySel), help('Drag in the square to change two settings at once. The letter on the right updates as you drag. Double-click resets both to their defaults; arrow keys nudge.')),
    empty,
    h('div', { class: 'padbody' }, pad, glyphCv),
    readout,
  );
  const refresh = () => { if (!card.isConnected) return; fill(); drawPad(); drawGlyph(); };
  store.subscribe((ev) => {
    if (ev === 'fx' || ev === 'project:loaded' || ev === 'fx:external') { if (!dragging) { fill(); drawPad(); } }
    if (ev === 'built' || ev === 'select') drawGlyph();
  });
  (card as any).refresh = refresh;
  return card;
}
