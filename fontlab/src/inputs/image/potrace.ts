/**
 * Thin wrapper around `esm-potrace-wasm`. The wasm module is loaded lazily
 * inside `traceOutline` so importing this file never pulls it in; the SVG
 * path parser is pure and testable anywhere.
 *
 * Output contours are in IMAGE pixel space (y down), flattened.
 */
import type { Contour, Vec } from '../../core/glyph';
import { dedupe } from '../../core/geometry';
import type { ImageLike } from './raster';

export interface PotraceTraceOptions {
  /** suppress speckles of up to this many pixels */
  turdsize?: number;
  /** corner threshold (0 = polygons only, 1.334 = max smoothing) */
  alphamax?: number;
  opttolerance?: number;
  /** flattening steps per cubic segment */
  cubicSteps?: number;
}

type PotraceModule = {
  init(): Promise<void>;
  potrace(src: unknown, opts?: Record<string, unknown>): Promise<string | string[]>;
};

let modPromise: Promise<PotraceModule> | null = null;

/**
 * esm-potrace-wasm ships an Emscripten shim that calls `require` / `__dirname`
 * whenever `process.versions.node` exists, which crashes under Node ESM.
 * Provide those globals when we are in Node so the module can also run there
 * (handy for tests / CLI). Browser builds never hit this branch.
 */
async function loadPotrace(): Promise<PotraceModule> {
  if (!modPromise) {
    modPromise = (async () => {
      const g = globalThis as Record<string, unknown>;
      const proc = g.process as { versions?: { node?: string } } | undefined;
      if (proc?.versions?.node && typeof g.require !== 'function') {
        const spec = 'node:module';
        const nm = (await import(/* @vite-ignore */ spec)) as { createRequire(p: string): unknown };
        g.require = nm.createRequire(import.meta.url);
        if (typeof g.__dirname !== 'string') g.__dirname = '/';
      }
      const m = (await import('esm-potrace-wasm')) as unknown as PotraceModule;
      await m.init();
      return m;
    })();
  }
  return modPromise;
}

function toRgba(img: ImageLike): { width: number; height: number; data: Uint8ClampedArray } {
  const n = img.width * img.height;
  const ch = n ? img.data.length / n : 4;
  if (ch === 4 && img.data instanceof Uint8ClampedArray) return img as { width: number; height: number; data: Uint8ClampedArray };
  const data = new Uint8ClampedArray(n * 4);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    if (ch === 1) { data[j] = data[j + 1] = data[j + 2] = img.data[i]; data[j + 3] = 255; }
    else if (ch === 3) { data[j] = img.data[i * 3]; data[j + 1] = img.data[i * 3 + 1]; data[j + 2] = img.data[i * 3 + 2]; data[j + 3] = 255; }
    else { data[j] = img.data[i * 4]; data[j + 1] = img.data[i * 4 + 1]; data[j + 2] = img.data[i * 4 + 2]; data[j + 3] = img.data[i * 4 + 3]; }
  }
  return { width: img.width, height: img.height, data };
}

/** Trace dark ink of an image into flattened contours in image pixel space. */
export async function traceOutline(img: ImageLike, opts: PotraceTraceOptions = {}): Promise<Contour[]> {
  const m = await loadPotrace();
  const rgba = toRgba(img);
  const svg = await m.potrace(rgba, {
    turdsize: opts.turdsize ?? 2,
    turnpolicy: 4,
    alphamax: opts.alphamax ?? 1,
    opticurve: 1,
    opttolerance: opts.opttolerance ?? 0.2,
    pathonly: false,
    extractcolors: false,
    posterizelevel: 2,
    posterizationalgorithm: 0,
  });
  return parsePotraceSvg(String(svg), opts.cubicSteps ?? 8);
}

/**
 * Parse the SVG potrace returns (paths in 1/10 px with y up inside a
 * `translate(0,H) scale(0.1,-0.1)` group) into contours in image pixels.
 */
export function parsePotraceSvg(svg: string, cubicSteps = 8): Contour[] {
  let tx = 0, ty = 0, sx = 1, sy = 1;
  const g = /<g[^>]*transform="([^"]*)"/.exec(svg);
  if (g) {
    const tr = /translate\(\s*([-\d.eE+]+)[\s,]+([-\d.eE+]+)\s*\)/.exec(g[1]);
    if (tr) { tx = parseFloat(tr[1]); ty = parseFloat(tr[2]); }
    const sc = /scale\(\s*([-\d.eE+]+)(?:[\s,]+([-\d.eE+]+))?\s*\)/.exec(g[1]);
    if (sc) { sx = parseFloat(sc[1]); sy = sc[2] !== undefined ? parseFloat(sc[2]) : sx; }
  }
  const out: Contour[] = [];
  const re = /<path[^>]*\sd="([^"]*)"/g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(svg))) {
    for (const poly of parsePathD(mm[1], cubicSteps)) {
      const pts = dedupe(poly.map(([x, y]) => [tx + sx * x, ty + sy * y] as Vec), 0.01);
      if (pts.length >= 3) out.push({ points: pts });
    }
  }
  return out;
}

/** Flatten an SVG path `d` string into closed/open polylines (one per subpath). */
export function parsePathD(d: string, cubicSteps = 8): Vec[][] {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? [];
  const polys: Vec[][] = [];
  let cur: Vec[] = [];
  let cmd = '';
  let x = 0, y = 0, sx = 0, sy = 0;
  let cx = 0, cy = 0; // last control point (for S/T)
  let i = 0;
  const num = () => parseFloat(tokens[i++]);
  const flush = () => { if (cur.length) polys.push(cur); cur = []; };
  const cubic = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) => {
    for (let s = 1; s <= cubicSteps; s++) {
      const t = s / cubicSteps, mt = 1 - t;
      cur.push([
        mt * mt * mt * x + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x3,
        mt * mt * mt * y + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y3,
      ]);
    }
    cx = x2; cy = y2; x = x3; y = y3;
  };
  const quad = (x1: number, y1: number, x2: number, y2: number) => {
    const steps = Math.max(4, Math.round(cubicSteps * 0.75));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps, mt = 1 - t;
      cur.push([mt * mt * x + 2 * mt * t * x1 + t * t * x2, mt * mt * y + 2 * mt * t * y1 + t * t * y2]);
    }
    cx = x1; cy = y1; x = x2; y = y2;
  };
  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[A-Za-z]$/.test(t)) { cmd = t; i++; if (cmd === 'Z' || cmd === 'z') { if (cur.length) cur.push([sx, sy]); flush(); x = sx; y = sy; continue; } }
    if (!cmd) { i++; continue; }
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    switch (cmd.toUpperCase()) {
      case 'M': {
        flush();
        x = ox + num(); y = oy + num(); sx = x; sy = y;
        cur.push([x, y]);
        cmd = rel ? 'l' : 'L'; // subsequent pairs are implicit line-tos
        break;
      }
      case 'L': { x = ox + num(); y = oy + num(); cur.push([x, y]); break; }
      case 'H': { x = ox + num(); cur.push([x, y]); break; }
      case 'V': { y = oy + num(); cur.push([x, y]); break; }
      case 'C': {
        const x1 = ox + num(), y1 = oy + num(), x2 = ox + num(), y2 = oy + num(), x3 = ox + num(), y3 = oy + num();
        cubic(x1, y1, x2, y2, x3, y3);
        break;
      }
      case 'S': {
        const x1 = 2 * x - cx, y1 = 2 * y - cy;
        const x2 = ox + num(), y2 = oy + num(), x3 = ox + num(), y3 = oy + num();
        cubic(x1, y1, x2, y2, x3, y3);
        break;
      }
      case 'Q': { const x1 = ox + num(), y1 = oy + num(), x2 = ox + num(), y2 = oy + num(); quad(x1, y1, x2, y2); break; }
      case 'T': { const x1 = 2 * x - cx, y1 = 2 * y - cy; const x2 = ox + num(), y2 = oy + num(); quad(x1, y1, x2, y2); break; }
      case 'A': {
        // arcs are not emitted by potrace; approximate with a straight line
        i += 5; x = ox + num(); y = oy + num(); cur.push([x, y]);
        break;
      }
      default: i++;
    }
    if (cmd.toUpperCase() !== 'C' && cmd.toUpperCase() !== 'S' && cmd.toUpperCase() !== 'Q' && cmd.toUpperCase() !== 'T') { cx = x; cy = y; }
    if (Number.isNaN(x) || Number.isNaN(y)) break;
  }
  flush();
  return polys;
}
