import type { Glyph } from '../core/glyph';

/**
 * Grow ascender / descender so they cover the ink of the letters. Stats measure stroke centrelines,
 * so strokes reach half a stroke width (plus overshoot) past them and would be clipped by apps.
 * Only ever widens the metrics; ignores the odd letter that sticks out very far.
 */
export function fitVerticalMetrics(p: { glyphs: Record<string, Glyph>; metrics: { ascender: number; descender: number } }, margin = 20): void {
  const tops: number[] = [], bottoms: number[] = [];
  for (const g of Object.values(p.glyphs)) {
    let lo = Infinity, hi = -Infinity;
    for (const s of g.strokes ?? []) for (const q of s.points) { lo = Math.min(lo, q.y - q.w); hi = Math.max(hi, q.y + q.w); }
    for (const c of g.contours ?? []) for (const q of c.points) { lo = Math.min(lo, q[1]); hi = Math.max(hi, q[1]); }
    if (hi > -Infinity) { tops.push(hi); bottoms.push(lo); }
  }
  if (tops.length < 4) return;
  // 98th percentile so one stray flourish does not blow the line height up
  const pick = (a: number[], q: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]; };
  const top = Math.min(pick(tops, 0.98), 1400), bottom = Math.max(pick(bottoms, 0.02), -700);
  if (top + margin > p.metrics.ascender) p.metrics.ascender = Math.ceil(top + margin);
  if (bottom - margin < p.metrics.descender) p.metrics.descender = Math.floor(bottom - margin);
}

