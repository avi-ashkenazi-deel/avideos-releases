import { parse } from '../../vendor/opentype';
import type { Glyph, Contour, Vec, FontMetrics } from '../../core/glyph';
import { CHARSET } from '../../core/glyph';
import { flattenCubic } from '../../outline/fitCurves';
import { cleanContours } from '../../outline/fitCurves';
import { curvesFromPathCommands } from '../draw/curves';

export interface ImportedFont {
  glyphs: Glyph[];
  metrics: Partial<FontMetrics>;
  familyName: string;
}

const tag = (buf: ArrayBuffer) => String.fromCharCode(...new Uint8Array(buf, 0, 4));

/** WOFF2 → TTF/OTF bytes via Google's woff2 decoder compiled to WebAssembly (lazy, ~1 MB). */
export async function decompressWoff2(buf: ArrayBuffer): Promise<ArrayBuffer> {
  if (typeof Worker !== 'undefined' && typeof document !== 'undefined') return decompressInWorker(buf);
  // Node (tests): the package's own wrapper works there
  const mod: any = await import('wawoff2/decompress.js');
  const decompress = mod.default ?? mod;
  const out: Uint8Array = await decompress(new Uint8Array(buf));
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

let woff2WorkerUrl: string | null = null;

async function decompressInWorker(buf: ArrayBuffer): Promise<ArrayBuffer> {
  if (!woff2WorkerUrl) {
    const { default: src } = await import('./woff2Binding');
    const wrapper = `var module = { exports: {} }; var exports = module.exports;
self.Module = { onRuntimeInitialized: function () { self.postMessage({ ready: true }); } };
${src}
self.onmessage = function (e) {
  try {
    var out = Module.decompress(new Uint8Array(e.data));
    if (!out) { self.postMessage({ error: 'not a valid WOFF2 file' }); return; }
    var copy = new Uint8Array(out);
    self.postMessage({ result: copy.buffer }, [copy.buffer]);
  } catch (err) { self.postMessage({ error: String(err && err.message || err) }); }
};`;
    woff2WorkerUrl = URL.createObjectURL(new Blob([wrapper], { type: 'text/javascript' }));
  }
  const worker = new Worker(woff2WorkerUrl);
  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('woff2 decoder did not start')), 30000);
      worker.onmessage = (e) => { if (e.data?.ready) { clearTimeout(t); resolve(); } };
      worker.onerror = (e) => { clearTimeout(t); reject(new Error(e.message || 'woff2 decoder failed to load')); };
    });
    return await new Promise<ArrayBuffer>((resolve, reject) => {
      worker.onmessage = (e) => { if (e.data?.error) reject(new Error(e.data.error)); else resolve(e.data.result as ArrayBuffer); };
      worker.onerror = (e) => reject(new Error(e.message || 'woff2 decode failed'));
      worker.postMessage(buf.slice(0), [buf.slice(0)] as any);
    });
  } finally {
    worker.terminate();
  }
}

/** Any font file (ttf, otf, woff, woff2) → importFont. */
export async function importFontFile(buf: ArrayBuffer, chars: string | string[] = CHARSET): Promise<ImportedFont> {
  if (tag(buf) === 'wOF2') buf = await decompressWoff2(buf);
  return importFont(buf, chars);
}

/** Parse a TTF/OTF/WOFF ArrayBuffer and extract glyphs as outline glyphs at 1000 upm. */
export function importFont(buf: ArrayBuffer, chars: string | string[] = CHARSET): ImportedFont {
  if (tag(buf) === 'wOF2') throw new Error('WOFF2 needs importFontFile (async decoder)');
  const font = parse(buf);
  const upm: number = font.unitsPerEm || 1000;
  const k = 1000 / upm;
  const glyphs: Glyph[] = [];
  for (const ch of chars) {
    const g = font.charToGlyph(ch);
    if (!g || g.index === 0) continue;
    const path = g.getPath(0, 0, upm); // path in font units at fontSize=upm → 1:1, y-up? no: opentype flips y for rendering
    const contours = pathToContours(path.commands, k, true);
    if (!contours.length) continue;
    glyphs.push({
      char: ch,
      unicode: ch.codePointAt(0)!,
      advance: Math.round((g.advanceWidth ?? upm * 0.5) * k),
      source: 'imported',
      kind: 'outline',
      contours,
      curves: curvesFromPathCommands(path.commands, k, true),
    });
  }
  const os2 = font.tables?.os2 ?? {};
  const metrics: Partial<FontMetrics> = {
    ascender: Math.round((font.ascender ?? 800) * k),
    descender: Math.round((font.descender ?? -200) * k),
  };
  if (os2.sxHeight) metrics.xHeight = Math.round(os2.sxHeight * k);
  if (os2.sCapHeight) metrics.capHeight = Math.round(os2.sCapHeight * k);
  const names = font.names?.unicode ?? font.names?.windows ?? font.names?.macintosh ?? font.names ?? {};
  const pick = (rec: any) => (rec && typeof rec === 'object' ? (rec.en ?? Object.values(rec)[0]) : undefined);
  const family = pick(names.fontFamily) ?? pick(names.fullName) ?? pick(font.names?.fontFamily) ?? 'Imported';
  return { glyphs, metrics, familyName: family };
}

/** opentype path commands (y-down when produced by getPath) → y-up flattened contours. */
export function pathToContours(commands: any[], scale = 1, flipY = true): Contour[] {
  const out: Contour[] = [];
  let cur: Vec[] = [];
  let last: Vec = [0, 0];
  const P = (x: number, y: number): Vec => [x * scale, (flipY ? -y : y) * scale];
  const flush = () => { if (cur.length >= 3) out.push({ points: cur }); cur = []; };
  for (const c of commands) {
    switch (c.type) {
      case 'M': flush(); last = P(c.x, c.y); cur.push(last); break;
      case 'L': last = P(c.x, c.y); cur.push(last); break;
      case 'C': { const pts = flattenCubic([last, P(c.x1, c.y1), P(c.x2, c.y2), P(c.x, c.y)], 10); cur.push(...pts); last = pts[pts.length - 1]; break; }
      case 'Q': { const c1 = P(c.x1, c.y1), e = P(c.x, c.y); const cp1: Vec = [last[0] + (2 / 3) * (c1[0] - last[0]), last[1] + (2 / 3) * (c1[1] - last[1])]; const cp2: Vec = [e[0] + (2 / 3) * (c1[0] - e[0]), e[1] + (2 / 3) * (c1[1] - e[1])]; const pts = flattenCubic([last, cp1, cp2, e], 8); cur.push(...pts); last = e; break; }
      case 'Z': flush(); break;
    }
  }
  flush();
  return cleanContours(out, 20, 0.3);
}
