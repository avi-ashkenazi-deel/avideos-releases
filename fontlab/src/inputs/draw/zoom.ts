import type { View } from '../../ui/render';
import type { Vec } from '../../core/glyph';

/**
 * Zoom and pan of the draw canvas, kept apart from the "fit the letter" view:
 * a canvas point of the fitted view `c` is shown at `c * k + (tx, ty)`.
 */
export interface Zoom { k: number; tx: number; ty: number }

export const NO_ZOOM: Zoom = { k: 1, tx: 0, ty: 0 };
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 24;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function applyZoom(base: View, z: Zoom): View {
  return { s: base.s * z.k, ox: base.ox * z.k + z.tx, oy: base.oy * z.k + z.ty };
}

export function isZoomed(z: Zoom): boolean {
  return Math.abs(z.k - 1) > 1e-3 || Math.abs(z.tx) > 0.5 || Math.abs(z.ty) > 0.5;
}

/**
 * Scale by `factor` so that what was under the canvas point `from` ends up
 * under `to`. A pinch passes the start and current midpoint of the two
 * fingers; a wheel zoom passes the cursor twice.
 */
export function zoomAbout(z: Zoom, from: Vec, to: Vec, factor: number): Zoom {
  const k = clamp(z.k * factor, MIN_ZOOM, MAX_ZOOM);
  const bx = (from[0] - z.tx) / z.k, by = (from[1] - z.ty) / z.k;
  return { k, tx: to[0] - bx * k, ty: to[1] - by * k };
}

/** Keep part of the fitted view on screen, so the letter cannot be lost off the edge. */
export function clampZoom(z: Zoom, width: number, height: number): Zoom {
  const k = clamp(z.k, MIN_ZOOM, MAX_ZOOM);
  const m = Math.min(width, height) * 0.25;
  return { k, tx: clamp(z.tx, m - width * k, width - m), ty: clamp(z.ty, m - height * k, height - m) };
}
