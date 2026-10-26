/**
 * Photo of handwriting -> seed glyphs.
 *
 * Pipeline: gray -> Otsu threshold -> binarise -> despeckle -> connected
 * components -> letter cells + text lines -> per cell either a skeleton
 * (stroke glyph, width from the distance transform) or a potrace outline.
 *
 * Everything except `fileToImageData` and the potrace wasm works on plain
 * `{ width, height, data }` buffers so it runs in Node as well as the browser.
 * Output is in font units (1000/em, baseline y = 0, y up).
 */
import type { Contour, Glyph, Stroke, StrokePoint, Vec } from '../../core/glyph';
import { uid } from '../../core/glyph';
import { bboxContours, bboxStrokes, clamp, simplifyRDP, smoothResample } from '../../core/geometry';
import { cleanContours } from '../../outline/fitCurves';
import { unionContours } from '../../outline/union';
import {
  binarize, boxH, compositeMask, despeckle, maskToRgba, otsuThreshold, toGray,
  type ImageLike,
} from './raster';
import { type Cell } from './segment';
import { segmentSheet, type SheetInfo } from './sheet';
import { distanceTransform, sampleField, skeletonToPolylines, zhangSuen } from './thin';
import { traceOutline } from './potrace';

export type { ImageLike, Component, PixelBox } from './raster';
export type { Cell, LineInfo, Segmentation } from './segment';
export { toGray, otsuThreshold, binarize, despeckle, connectedComponents } from './raster';
export { segmentGlyphCells } from './segment';
export { segmentSheet, splitMask, removeFrame, opening } from './sheet';
export type { SheetInfo, SheetOptions } from './sheet';
export { zhangSuen, skeletonToPolylines, distanceTransform } from './thin';
export { traceOutline, parsePotraceSvg, parsePathD } from './potrace';

export interface TraceOptions {
  mode: 'strokes' | 'outline';
  /** 0..255; default: Otsu */
  threshold?: number;
  /** light ink on dark paper */
  invert?: boolean;
  /** components smaller than this many pixels are dropped as noise (default 12) */
  minComponentPx?: number;
  /** font units the estimated cap height maps to (default 700) */
  targetCapHeight?: number;
  /** opening radius for halo / mesh removal; 'auto' (default) picks 0–2 px */
  cleanupPx?: number | 'auto';
  /** split blobs that contain several letters (default true) */
  split?: boolean;
}

export interface TracedCell {
  cellIndex: number;
  lineIndex: number;
  /** char '' / unicode 0 until labelled */
  glyph: Glyph;
  thumbnail: { width: number; height: number; mask: Uint8Array };
  /** cell bbox in image pixels (handy for UI overlays) */
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

export interface TraceResult {
  cells: TracedCell[];
  lines: number;
  /** font units */
  estimates: { capHeight: number; xHeight: number };
  /** image px -> font units factor used */
  scale: number;
  threshold: number;
  info: SheetInfo;
}

const SIDEBEARING = 60;
const MIN_HALF_W = 6;
const MAX_HALF_W = 120;

export async function traceImage(img: ImageLike, opts: TraceOptions): Promise<TraceResult> {
  const { width: w, height: h } = img;
  const targetCap = opts.targetCapHeight ?? 700;
  const gray = toGray(img);
  const threshold = opts.threshold ?? otsuThreshold(gray);
  let bin = binarize(gray, threshold, opts.invert ?? false);
  bin = despeckle(bin, w, h, opts.minComponentPx ?? 12);
  const { seg, info } = segmentSheet(bin, w, h, { cleanupPx: opts.cleanupPx ?? 'auto', split: opts.split !== false });
  if (seg.cells.length === 0) return { cells: [], lines: 0, estimates: { capHeight: 0, xHeight: 0 }, scale: 1, threshold, info };

  let capPx = seg.estimates.capHeight;
  if (!(capPx > 0)) capPx = Math.max(...seg.cells.map((c) => boxH(c.bbox)));
  const scale = targetCap / capPx;

  const cells: TracedCell[] = [];
  for (let ci = 0; ci < seg.cells.length; ci++) {
    const cell = seg.cells[ci];
    const line = seg.lines[cell.lineIndex];
    const pad = 1;
    const cm = compositeMask(cell.components, cell.bbox, pad);
    const toFont = (px: number, py: number): Vec => [
      SIDEBEARING + (cm.originX + px - cell.bbox.x0) * scale,
      (line.baseline - (cm.originY + py)) * scale,
    ];
    let glyph: Glyph;
    if (opts.mode === 'strokes') {
      glyph = strokeGlyph(cm, toFont, scale);
    } else {
      glyph = await outlineGlyph(cm, toFont);
    }
    glyph.advance = Math.round(inkWidth(glyph) + 2 * SIDEBEARING);
    cells.push({
      cellIndex: ci,
      lineIndex: cell.lineIndex,
      glyph,
      thumbnail: thumbnailOf(cell),
      bbox: { ...cell.bbox },
    });
  }
  return {
    cells,
    lines: seg.lines.length,
    estimates: { capHeight: capPx * scale, xHeight: seg.estimates.xHeight * scale },
    scale,
    threshold,
    info,
  };
}

function thumbnailOf(cell: Cell): TracedCell['thumbnail'] {
  const cm = compositeMask(cell.components, cell.bbox, 0);
  return { width: cm.width, height: cm.height, mask: cm.mask };
}

function strokeGlyph(cm: { width: number; height: number; mask: Uint8Array }, toFont: (x: number, y: number) => Vec, scale: number): Glyph {
  const { width: W, height: H, mask } = cm;
  const skel = zhangSuen(mask, W, H);
  const polys = skeletonToPolylines(skel, W, H, { minSpur: 6 });
  const dt = distanceTransform(mask, W, H);
  const strokes: Stroke[] = [];
  for (const poly of polys) {
    if (poly.length === 0) continue;
    let pts: Vec[] = poly.length >= 3 ? simplifyRDP(poly, 1.5) : poly.slice();
    if (pts.length >= 3) pts = smoothResample(pts, 4);
    const points: StrokePoint[] = pts.map(([px, py]) => {
      const hw = Math.max(0.5, sampleField(dt, W, H, px, py) - 0.5);
      const [x, y] = toFont(px, py);
      return { x, y, w: clamp(hw * scale, MIN_HALF_W, MAX_HALF_W) };
    });
    strokes.push({ id: uid('s'), points, cap: 'round' });
  }
  return { char: '', unicode: 0, advance: 0, source: 'traced', kind: 'stroke', strokes };
}

async function outlineGlyph(cm: { width: number; height: number; mask: Uint8Array }, toFont: (x: number, y: number) => Vec): Promise<Glyph> {
  const rgba = maskToRgba(cm.mask, cm.width, cm.height);
  const raw = await traceOutline(rgba, { turdsize: 2 });
  const mapped: Contour[] = raw.map((c) => ({ points: c.points.map(([x, y]) => toFont(x, y)) }));
  // the y flip reverses winding; union normalises outer = CCW, holes = CW
  const contours = cleanContours(unionContours(mapped), 40, 0.6);
  return { char: '', unicode: 0, advance: 0, source: 'traced', kind: 'outline', contours };
}

function inkWidth(g: Glyph): number {
  if (g.kind === 'stroke' && g.strokes?.length) {
    const b = bboxStrokes(g.strokes);
    return Math.max(0, b.maxX - b.minX);
  }
  if (g.kind === 'outline' && g.contours?.length) {
    const b = bboxContours(g.contours);
    return Math.max(0, b.maxX - b.minX);
  }
  return 0;
}

export interface Labelling {
  glyphs: Glyph[];
  /** per cell (by cellIndex order): the char it receives, or null */
  assigned: (string | null)[];
  /** cells left without a letter */
  missing: number;
  /** typed letters with no cell */
  extra: number;
}

/**
 * Assign characters to traced cells in reading order, skipping whitespace in
 * `text` and any cell index in `skipped`. Reports the mismatch either way.
 */
export function labelCellsDetailed(cells: TracedCell[], text: string, skipped: ReadonlySet<number> = new Set()): Labelling {
  const chars = Array.from(text).filter((c) => !/\s/u.test(c));
  const sorted = cells.slice().sort((a, b) => a.cellIndex - b.cellIndex);
  const glyphs: Glyph[] = [];
  const assigned: (string | null)[] = [];
  let ci = 0;
  for (const cell of sorted) {
    if (skipped.has(cell.cellIndex) || ci >= chars.length) { assigned.push(null); continue; }
    const ch = chars[ci++];
    const g = cell.glyph;
    g.char = ch;
    g.unicode = ch.codePointAt(0) ?? 0;
    g.advance = Math.round(inkWidth(g) + 2 * SIDEBEARING);
    glyphs.push(g);
    assigned.push(ch);
  }
  const usable = sorted.filter((c) => !skipped.has(c.cellIndex)).length;
  return { glyphs, assigned, missing: Math.max(0, usable - chars.length), extra: Math.max(0, chars.length - usable) };
}

/** Back-compat: just the labelled glyphs. */
export function labelCells(cells: TracedCell[], text: string, skipped?: ReadonlySet<number>): Glyph[] {
  return labelCellsDetailed(cells, text, skipped).glyphs;
}

/** Browser only: decode an image Blob/File into an RGBA buffer. */
export async function fileToImageData(file: Blob): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  const bmp = await createImageBitmap(file);
  const w = bmp.width, h = bmp.height;
  let ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (typeof OffscreenCanvas !== 'undefined') {
    ctx = new OffscreenCanvas(w, h).getContext('2d');
  } else {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    ctx = c.getContext('2d');
  }
  if (!ctx) throw new Error('2D canvas not available');
  ctx.drawImage(bmp, 0, 0);
  const id = ctx.getImageData(0, 0, w, h);
  bmp.close?.();
  return { width: w, height: h, data: id.data };
}

