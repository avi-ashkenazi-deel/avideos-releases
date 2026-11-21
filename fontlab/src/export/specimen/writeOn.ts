/**
 * Write-on animation: letters draw themselves stroke by stroke, in the order
 * they were drawn (tegaki-style). Shared by the preview panel, the GIF / WebM
 * frame renderer and the animated SVG export.
 *
 * The reveal is a mask: the FINAL built glyph (after effects) is filled, but
 * only inside fattened ribbons around the strokes written so far. During the
 * last 10% of each glyph's slot the unmasked glyph fades in, so anything the
 * strokes miss (effects that move ink, skeleton gaps) still ends up exact.
 *
 * Pure TS: imports cleanly in Node. Only drawWriteOnFrame touches a canvas.
 * Coordinates are font units (1000/em, y up) unless stated otherwise.
 */
import type { Contour, FontMetrics, Glyph, Stroke, StrokePoint } from '../../core/glyph';
import { outlineToStrokes } from '../../inputs/fontimport/toStrokes';
import { expandStroke } from '../../outline/strokeExpand';
import { layoutText, contoursToPathD } from './svg';

// ---------------------------------------------------------------------------
// stroke order

const defaultCache = new Map<string, Stroke[]>();

/** Cheap fingerprint of an outline: contour count, point count, a few points, coordinate sum. */
function contourKey(g: Glyph): string {
  const cs = g.contours ?? [];
  let n = 0, sum = 0;
  for (const c of cs) { n += c.points.length; for (const p of c.points) sum += p[0] * 0.7 + p[1] * 1.3; }
  const firsts = cs.slice(0, 4).map((c) => (c.points[0] ? `${Math.round(c.points[0][0])},${Math.round(c.points[0][1])}` : '')).join(';');
  return `${g.char}|${cs.length}|${n}|${firsts}|${Math.round(sum)}`;
}

/** Reverse a stroke's points (new object). */
const reversed = (s: Stroke): Stroke => ({ ...s, points: s.points.slice().reverse() });

/**
 * Orient a skeleton stroke the way a hand would write it: closed loops start at
 * their top-most point and run anticlockwise (like an "o"); open strokes run
 * top→bottom when mostly vertical, left→right otherwise.
 */
function orient(s: Stroke): Stroke {
  const pts = s.points;
  if (pts.length < 2) return s;
  const a = pts[0], b = pts[pts.length - 1];
  const closed = pts.length > 3 && Math.hypot(a.x - b.x, a.y - b.y) < 2;
  if (closed) {
    let area = 0;
    for (let i = 0; i < pts.length - 1; i++) area += pts[i].x * pts[i + 1].y - pts[i + 1].x * pts[i].y;
    let ring = pts.slice(0, -1);
    if (area < 0) ring.reverse(); // y-up maths: positive area = anticlockwise on screen too
    let top = 0;
    ring.forEach((p, i) => { if (p.y > ring[top].y) top = i; });
    ring = [...ring.slice(top), ...ring.slice(0, top)];
    return { ...s, points: [...ring, { ...ring[0] }] };
  }
  const dx = b.x - a.x, dy = b.y - a.y;
  if (Math.abs(dy) > Math.abs(dx)) return dy > 0 ? reversed(s) : s; // want start on top (y up)
  return dx < 0 ? reversed(s) : s;
}

/** Reading-order key for a stroke start: top-left first (x − y, font units, y up). */
const orderKey = (s: Stroke) => (s.points.length ? s.points[0].x - s.points[0].y : 0);

/**
 * Strokes in writing order. Stroke glyphs: `g.strokes` as drawn. Outline glyphs:
 * a cached centreline skeleton (sorted top-left first, each stroke oriented like
 * handwriting) followed by any strokes drawn on top (mixed glyphs).
 */
export function orderedStrokes(g: Glyph, cache: Map<string, Stroke[]> = defaultCache): Stroke[] {
  const drawn = (g.strokes ?? []).filter((s) => s.points.length > 0);
  if (g.kind !== 'outline' || !g.contours?.length) return drawn;
  const key = contourKey(g);
  let skel = cache.get(key);
  if (!skel) {
    try {
      const res = outlineToStrokes({ ...g, strokes: undefined });
      skel = res.kind === 'stroke' ? (res.strokes ?? []).filter((s) => s.points.length > 0).map(orient) : [];
    } catch { skel = []; }
    skel.sort((a, b) => orderKey(a) - orderKey(b));
    if (cache.size > 4000) cache.clear();
    cache.set(key, skel);
  }
  return [...skel, ...drawn];
}

// ---------------------------------------------------------------------------
// partial strokes

/** Arc length of a stroke's centreline (font units). */
export function strokeLength(s: Stroke): number {
  let L = 0;
  for (let i = 1; i < s.points.length; i++) L += Math.hypot(s.points[i].x - s.points[i - 1].x, s.points[i].y - s.points[i - 1].y);
  return L;
}

/**
 * The first `t` (0..1, by arc length) of a stroke, ending in an interpolated tip.
 * null when nothing is written yet; the stroke itself at t ≥ 1. A tapered stroke
 * is treated as round while partial so the growing tip does not pinch.
 */
export function partialStroke(s: Stroke, t: number): Stroke | null {
  if (!(t > 1e-4) || !s.points.length) return null;
  if (t >= 1) return s;
  const L = strokeLength(s);
  if (L <= 1e-9) return s; // a dot: all or nothing
  const target = t * L;
  const pts: StrokePoint[] = [s.points[0]];
  let acc = 0;
  for (let i = 1; i < s.points.length; i++) {
    const a = s.points[i - 1], b = s.points[i];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (acc + d >= target) {
      const k = d > 0 ? (target - acc) / d : 0;
      pts.push({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, w: a.w + (b.w - a.w) * k, p: a.p });
      break;
    }
    pts.push(b);
    acc += d;
  }
  return { ...s, cap: s.cap === 'taper' ? 'round' : s.cap, points: pts };
}

// ---------------------------------------------------------------------------
// timing plan

export interface WriteOnItem {
  ch: string;
  /** glyph origin (font units, y up; line n sits at y = −n × line height) */
  x: number;
  y: number;
  /** final built shapes */
  contours: Contour[];
  /** strokes in writing order (glyph-local font units); empty = fades in */
  strokes: Stroke[];
  /** ms from the start of the animation, one per stroke (or one fade slot when no strokes) */
  starts: number[];
  durations: number[];
}

export interface WriteOnPlan {
  items: WriteOnItem[];
  width: number;
  height: number;
  /** ascender: distance from the layout's top edge to the first baseline */
  top: number;
  durationMs: number;
}

export interface WriteOnOptions {
  metrics: FontMetrics;
  /** source glyphs (strokes) keyed by char */
  glyphs: Record<string, Glyph>;
  /** final built glyphs keyed by char */
  built: Record<string, { advance: number; contours: Contour[] } | undefined>;
  /** pen speed, font units per second (default 2600) */
  speed?: number;
  /** pause between letters, ms (default 90) */
  letterPause?: number;
  /** pause between strokes of one letter, ms (default 40) */
  strokePause?: number;
  /** skeleton cache for outline glyphs */
  cache?: Map<string, Stroke[]>;
  /** line height in em (default 1.2) */
  lineGap?: number;
  /** speed everything up uniformly so the whole thing takes at most this long */
  maxDurationMs?: number;
}

const FADE_MS = 200;
const MIN_STROKE_MS = 60;

/** Lay out `text` (newlines only) and schedule every stroke of every glyph. */
export function writeOnPlan(text: string, o: WriteOnOptions): WriteOnPlan {
  const speed = o.speed ?? 2600, letterPause = o.letterPause ?? 90, strokePause = o.strokePause ?? 40;
  const lookup = (ch: string) => { const b = o.built[ch]; return b && b.contours.length ? { advance: b.advance, contours: b.contours } : undefined; };
  const lay = layoutText(text, lookup, o.metrics, o.lineGap ?? 1.2);
  const items: WriteOnItem[] = [];
  let cursor = 0, end = 0;
  for (const it of lay.items) {
    if (items.length) cursor = end + letterPause;
    const src = o.glyphs[it.ch];
    const strokes = src ? orderedStrokes(src, o.cache) : [];
    const starts: number[] = [], durations: number[] = [];
    if (!strokes.length) { starts.push(cursor); durations.push(FADE_MS); }
    strokes.forEach((s, i) => {
      if (i) cursor += strokePause;
      const d = Math.max(MIN_STROKE_MS, (strokeLength(s) / speed) * 1000);
      starts.push(cursor); durations.push(d);
      cursor += d;
    });
    end = starts[starts.length - 1] + durations[durations.length - 1];
    cursor = end;
    items.push({ ch: it.ch, x: it.x, y: it.y, contours: it.g.contours, strokes, starts, durations });
  }
  let durationMs = items.length ? end : 0;
  if (o.maxDurationMs && durationMs > o.maxDurationMs) {
    const k = o.maxDurationMs / durationMs;
    for (const it of items) { it.starts = it.starts.map((v) => v * k); it.durations = it.durations.map((v) => v * k); }
    const last = items[items.length - 1];
    durationMs = last.starts[last.starts.length - 1] + last.durations[last.durations.length - 1];
  }
  return { items, width: lay.width, height: lay.height, top: o.metrics.ascender, durationMs };
}

const itemStart = (it: WriteOnItem) => it.starts[0];
const itemEnd = (it: WriteOnItem) => it.starts[it.starts.length - 1] + it.durations[it.durations.length - 1];
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Fattened reveal ribbon for a (partial) stroke: half-width w·1.6 + 8. */
const fatten = (s: Stroke): Stroke => ({ ...s, cap: 'round', points: s.points.map((p) => ({ ...p, w: p.w * 1.6 + 8 })) });

// ---------------------------------------------------------------------------
// canvas

export interface DrawWriteOnOptions {
  /** canvas pixel size (defaults to ctx.canvas) */
  width?: number;
  height?: number;
  fill?: string;
  bg?: string;
  /** draw a dot at the pen tip */
  nib?: boolean;
  nibColor?: string;
  /** padding in canvas px (default 60, like drawFrame) */
  pad?: number;
  /** cap on the fit scale (canvas px per font unit), e.g. font size / 1000 */
  maxScale?: number;
  /** 'center' (default) centres the text; 'start' pins it to the top-left padding */
  align?: 'center' | 'start';
}

/** Draw the animation at `tMs` (fit and centred like drawFrame). After durationMs everything is drawn. */
export function drawWriteOnFrame(ctx: CanvasRenderingContext2D, plan: WriteOnPlan, tMs: number, opts: DrawWriteOnOptions = {}): void {
  const width = opts.width ?? ctx.canvas.width, height = opts.height ?? ctx.canvas.height;
  const fill = opts.fill ?? '#111', bg = opts.bg ?? '#fff';
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  if (bg === 'transparent') ctx.clearRect(0, 0, width, height);
  else { ctx.fillStyle = bg; ctx.fillRect(0, 0, width, height); }
  const pad = opts.pad ?? 60;
  let s = Math.min((width - pad * 2) / Math.max(1, plan.width), (height - pad * 2) / Math.max(1, plan.height));
  if (opts.maxScale != null) s = Math.min(s, opts.maxScale);
  s = Math.max(1e-4, s);
  const ox = opts.align === 'start' ? pad : (width - plan.width * s) / 2;
  const oy = (opts.align === 'start' ? pad : (height - plan.height * s) / 2) + plan.top * s;
  const X = (it: WriteOnItem, x: number) => ox + (it.x + x) * s;
  const Y = (it: WriteOnItem, y: number) => oy - (it.y + y) * s;
  const glyphPath = (it: WriteOnItem) => {
    ctx.beginPath();
    for (const c of it.contours) {
      c.points.forEach((p, i) => (i ? ctx.lineTo(X(it, p[0]), Y(it, p[1])) : ctx.moveTo(X(it, p[0]), Y(it, p[1]))));
      ctx.closePath();
    }
  };
  ctx.fillStyle = fill;
  let tip: { x: number; y: number; r: number } | null = null;
  for (const it of plan.items) {
    const t0 = itemStart(it), t1 = itemEnd(it);
    if (tMs < t0) continue;
    if (tMs >= t1) { glyphPath(it); ctx.fill('nonzero'); continue; }
    if (!it.strokes.length) {
      ctx.globalAlpha = clamp01((tMs - t0) / Math.max(1, t1 - t0));
      glyphPath(it); ctx.fill('nonzero');
      ctx.globalAlpha = 1;
      continue;
    }
    // reveal mask = union of fattened ribbons of the strokes written so far
    ctx.save();
    ctx.beginPath();
    let any = false;
    it.strokes.forEach((st, j) => {
      const p = partialStroke(st, clamp01((tMs - it.starts[j]) / Math.max(1, it.durations[j])));
      if (!p) return;
      for (const ring of expandStroke(fatten(p))) {
        if (ring.length < 3) continue;
        ring.forEach((q, i) => (i ? ctx.lineTo(X(it, q[0]), Y(it, q[1])) : ctx.moveTo(X(it, q[0]), Y(it, q[1]))));
        ctx.closePath();
        any = true;
      }
      if (tMs < it.starts[j] + it.durations[j]) {
        const e = p.points[p.points.length - 1];
        tip = { x: X(it, e.x), y: Y(it, e.y), r: Math.max(3, e.w * s * 0.55) };
      }
    });
    if (any) { ctx.clip('nonzero'); glyphPath(it); ctx.fill('nonzero'); }
    ctx.restore();
    // last 10% of the slot: blend in the real glyph so nothing the skeleton missed is lost
    const blend = clamp01((tMs - (t1 - 0.1 * (t1 - t0))) / Math.max(1, 0.1 * (t1 - t0)));
    if (blend > 0) { ctx.globalAlpha = blend; glyphPath(it); ctx.fill('nonzero'); ctx.globalAlpha = 1; }
  }
  if (opts.nib !== false && tip) {
    const { x, y, r } = tip as { x: number; y: number; r: number };
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = opts.nibColor ?? '#ef476f'; ctx.fill();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// SVG

export interface WriteOnSvgOptions {
  fill?: string;
  bg?: string;
  loop?: boolean;
  /** how long the finished text stays before the loop restarts, ms */
  holdMs?: number;
}

const pct = (ms: number, total: number) => `${Math.min(100, Math.max(0, (ms / total) * 100)).toFixed(3)}%`;

/**
 * Self-contained animated SVG (CSS keyframes, no scripts, no external URLs).
 * Each glyph is filled and masked by its centreline paths, whose dash offset runs
 * 1→0 in writing order. Every animation shares one cycle (durationMs + holdMs)
 * with per-path keyframe offsets, so a loop stays in sync.
 */
export function writeOnSvg(plan: WriteOnPlan, o: WriteOnSvgOptions = {}): string {
  const fill = o.fill ?? '#111', bg = o.bg ?? '#fff', loop = o.loop ?? true, hold = o.holdMs ?? 1200;
  const pad = 80;
  const vbW = plan.width + pad * 2, vbH = plan.height + pad * 2;
  const total = Math.max(1, plan.durationMs + hold);
  const anim = (name: string) => `animation:${name} ${total.toFixed(0)}ms linear ${loop ? 'infinite' : '1 forwards'}`;
  const css: string[] = [];
  const body: string[] = [];
  const defs: string[] = [];
  const OFF = 1.01; // just past the dash so no round cap peeks out at the start
  css.push(`.wo-c{fill:none;stroke:#fff;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:1 2;stroke-dashoffset:${OFF}}`);
  plan.items.forEach((it, i) => {
    const dx = it.x + pad, dy = pad + plan.top - it.y;
    const d = contoursToPathD(it.contours, dx, dy);
    if (!d) return;
    const t0 = itemStart(it), t1 = itemEnd(it);
    if (!it.strokes.length) {
      css.push(`@keyframes wo-f${i}{0%,${pct(t0, total)}{opacity:0}${pct(t1, total)},100%{opacity:1}}.wo-f${i}{opacity:0;${anim(`wo-f${i}`)}}`);
      body.push(`<path class="wo-f${i}" d="${d}"/>`);
      return;
    }
    const paths: string[] = [];
    it.strokes.forEach((st, j) => {
      const pts = st.points;
      let cd = pts.map((p, k) => `${k ? 'L' : 'M'}${(p.x + dx).toFixed(1)} ${(dy - p.y).toFixed(1)}`).join('');
      if (pts.length === 1 || strokeLength(st) < 0.5) cd = `M${(pts[0].x + dx).toFixed(1)} ${(dy - pts[0].y).toFixed(1)}l0.5 0`;
      const meanW = pts.reduce((a, p) => a + p.w, 0) / pts.length;
      const sw = 2 * meanW * 1.6 + 16;
      const a = it.starts[j], b = a + it.durations[j];
      const k = `wo-s${i}-${j}`;
      css.push(`@keyframes ${k}{0%,${pct(a, total)}{stroke-dashoffset:${OFF}}${pct(b, total)},100%{stroke-dashoffset:0}}.${k}{${anim(k)}}`);
      paths.push(`<path class="wo-c ${k}" pathLength="1" stroke-width="${sw.toFixed(1)}" d="${cd}"/>`);
    });
    defs.push(`<mask id="wo-m${i}" maskUnits="userSpaceOnUse" x="0" y="0" width="${vbW.toFixed(0)}" height="${vbH.toFixed(0)}">${paths.join('')}</mask>`);
    body.push(`<path d="${d}" mask="url(#wo-m${i})"/>`);
    // final 10% of the slot: the unmasked glyph fades in so the result is exact
    const fadeFrom = t1 - 0.1 * (t1 - t0);
    css.push(`@keyframes wo-b${i}{0%,${pct(fadeFrom, total)}{opacity:0}${pct(t1, total)},100%{opacity:1}}.wo-b${i}{opacity:0;${anim(`wo-b${i}`)}}`);
    body.push(`<path class="wo-b${i}" d="${d}"/>`);
  });
  if (loop) {
    const fadeOut = Math.max(plan.durationMs, total - Math.min(250, hold / 3));
    css.push(`@keyframes wo-out{0%,${pct(fadeOut, total)}{opacity:1}100%{opacity:0}}.wo-all{${anim('wo-out')}}`);
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vbW.toFixed(0)} ${vbH.toFixed(0)}" width="${(vbW / 2).toFixed(0)}" height="${(vbH / 2).toFixed(0)}">`,
    `<style>${css.join('')}</style>`,
    `<defs>${defs.join('')}</defs>`,
    `<rect width="100%" height="100%" fill="${bg}"/>`,
    `<g class="wo-all" fill="${fill}" fill-rule="nonzero">${body.join('')}</g>`,
    '</svg>',
  ].join('\n');
}
