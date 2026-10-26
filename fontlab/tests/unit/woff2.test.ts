import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { importFont, importFontFile, decompressWoff2 } from '../../src/inputs/fontimport';

const load = (p: string) => { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; };

describe('woff2 import', () => {
  it('decompresses a woff2 to a parseable OpenType font', async () => {
    const buf = load('tests/fixtures/sample.woff2');
    expect(String.fromCharCode(...new Uint8Array(buf, 0, 4))).toBe('wOF2');
    const ttf = await decompressWoff2(buf);
    expect(String.fromCharCode(...new Uint8Array(ttf, 0, 4))).toBe('OTTO');
    const imp = importFont(ttf);
    expect(imp.glyphs.length).toBe(62);
    expect(imp.familyName).toBe('Sample Funk');
  });
  it('importFontFile handles woff2 transparently and importFont refuses it with a clear error', async () => {
    const buf = load('tests/fixtures/sample.woff2');
    const imp = await importFontFile(buf, 'Aa1');
    expect(imp.glyphs.map((g) => g.char)).toEqual(['A', 'a', '1']);
    expect(imp.glyphs[0].kind).toBe('outline');
    expect(() => importFont(buf)).toThrow(/WOFF2/);
  });
});
