import type { Contour, FontMetrics } from '../../core/glyph';

export interface SpecimenGlyph { advance: number; contours: Contour[] }
export type GlyphLookup = (ch: string) => SpecimenGlyph | undefined;

/** Lay out text lines into positioned glyphs (font units, y-up). */
export function layoutText(text: string, lookup: GlyphLookup, metrics: FontMetrics, lineGap = 1.2): { items: { ch: string; x: number; y: number; g: SpecimenGlyph }[]; width: number; height: number; lines: number } {
  const items: { ch: string; x: number; y: number; g: SpecimenGlyph }[] = [];
  const lineH = (metrics.ascender - metrics.descender) * lineGap;
  let width = 0;
  const lines = text.split(/\r?\n/);
  lines.forEach((line, li) => {
    let x = 0;
    const y = -li * lineH;
    for (const ch of line) {
      if (ch === ' ') { x += 280; continue; }
      const g = lookup(ch);
      if (!g) { x += 500; continue; }
      items.push({ ch, x, y, g });
      x += g.advance;
    }
    width = Math.max(width, x);
  });
  return { items, width, height: lines.length * lineH, lines: lines.length };
}

export function contoursToPathD(contours: Contour[], dx = 0, dy = 0, flipY = true): string {
  let d = '';
  for (const c of contours) {
    if (c.points.length < 3) continue;
    c.points.forEach((p, i) => { d += `${i ? 'L' : 'M'}${(p[0] + dx).toFixed(1)} ${((flipY ? -p[1] : p[1]) + dy).toFixed(1)}`; });
    d += 'Z';
  }
  return d;
}

export interface SvgOptions {
  text: string;
  metrics: FontMetrics;
  lookup: GlyphLookup;
  fill?: string;
  background?: string;
  /** adds a playful per-glyph wiggle animation (CSS) */
  animate?: boolean;
  /** embed a variable font and animate its axes instead of wiggling paths */
  variableFont?: { bytes: Uint8Array; axes: { tag: string; min: number; max: number }[] };
  fontSizePx?: number;
}

/** Static or animated SVG specimen. Paths are real outlines, so it renders anywhere. */
export function specimenSvg(o: SvgOptions): string {
  const { items, width, height } = layoutText(o.text, o.lookup, o.metrics);
  const pad = 80;
  const top = o.metrics.ascender;
  const vbW = width + pad * 2, vbH = height + pad * 2;
  const fill = o.fill ?? '#111', bg = o.background ?? '#fff';
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vbW.toFixed(0)} ${vbH.toFixed(0)}" width="${(vbW / 2).toFixed(0)}" height="${(vbH / 2).toFixed(0)}">`);
  if (o.variableFont) {
    const b64 = toBase64(o.variableFont.bytes);
    const kf = o.variableFont.axes.map((a) => `'${a.tag}' ${a.min}`).join(', ');
    const kf2 = o.variableFont.axes.map((a) => `'${a.tag}' ${a.max}`).join(', ');
    parts.push(`<style>@font-face{font-family:"FunkVar";src:url(data:font/ttf;base64,${b64}) format("truetype")}` +
      `@keyframes funk{0%,100%{font-variation-settings:${kf}}50%{font-variation-settings:${kf2}}}` +
      `.t{font-family:"FunkVar";font-size:${o.fontSizePx ?? 160}px;animation:funk 3s ease-in-out infinite;fill:${fill}}</style>`);
    parts.push(`<rect width="100%" height="100%" fill="${bg}"/>`);
    const lineH = (o.metrics.ascender - o.metrics.descender) * 1.2;
    o.text.split(/\r?\n/).forEach((line, i) => parts.push(`<text class="t" x="${pad}" y="${(pad + top + i * lineH) * ((o.fontSizePx ?? 160) / 1000) + pad}" xml:space="preserve">${escapeXml(line)}</text>`));
    parts.push('</svg>');
    return parts.join('');
  }
  if (o.animate) {
    parts.push(`<style>@keyframes wig{0%,100%{transform:translate(0,0) rotate(0)}25%{transform:translate(0,-18px) rotate(-2deg)}75%{transform:translate(0,12px) rotate(2deg)}}.g{animation:wig 1.6s ease-in-out infinite;transform-box:fill-box;transform-origin:center}</style>`);
  }
  parts.push(`<rect width="100%" height="100%" fill="${bg}"/>`);
  items.forEach((it, i) => {
    const d = contoursToPathD(it.g.contours, it.x + pad, pad + top - it.y);
    const delay = o.animate ? ` style="animation-delay:${((i * 0.13) % 1.6).toFixed(2)}s"` : '';
    parts.push(`<path class="g" d="${d}" fill="${fill}"${delay}/>`);
  });
  parts.push('</svg>');
  return parts.join('');
}

function escapeXml(s: string): string { return s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!); }

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
