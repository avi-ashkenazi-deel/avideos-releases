import { describe, it, expect } from 'vitest';
import { injectTables, readTables, tableChecksum } from '../../src/export/sfnt';
import { buildFont, fontToArrayBuffer } from '../../src/export/otf';
import { parse } from '../../src/vendor/opentype';
import { DEFAULT_METRICS } from '../../src/core/glyph';

const rect = (x0: number, x1: number) => [{ points: [[x0, 0], [x1, 0], [x1, 700], [x0, 700]] as [number, number][] }];
const font = () => fontToArrayBuffer(buildFont([
  { char: 'H', unicode: 72, advance: 600, contours: rect(60, 540) },
  { char: 'I', unicode: 73, advance: 300, contours: rect(100, 200) },
], { familyName: 'Inject Test', metrics: DEFAULT_METRICS }));

describe('sfnt table injection', () => {
  it('adds a table, keeps the font parseable and the glyphs intact', () => {
    const base = font();
    const out = injectTables(base, { 'TEST': new Uint8Array([1, 2, 3, 4, 5]) });
    const { tables } = readTables(out);
    expect(tables.map((t) => t.tag)).toContain('TEST');
    expect([...tables.find((t) => t.tag === 'TEST')!.data]).toEqual([1, 2, 3, 4, 5]);
    expect(tables.map((t) => t.tag)).toEqual([...tables.map((t) => t.tag)].sort());
    const f = parse(out);
    expect(f.charToGlyph('H').advanceWidth).toBe(600);
    expect(f.names.fontFamily?.en ?? f.names.unicode?.fontFamily?.en ?? f.names.windows?.fontFamily?.en).toBe('Inject Test');
  });
  it('writes valid checksums: whole-file sum is 0xB1B0AFBA and each table matches its directory entry', () => {
    const out = new Uint8Array(injectTables(font(), { 'TEST': new Uint8Array(7).fill(9) }));
    expect(tableChecksum(out)).toBe(0xb1b0afba);
    const dv = new DataView(out.buffer);
    const n = dv.getUint16(4);
    for (let i = 0; i < n; i++) {
      const o = 12 + i * 16;
      const tag = String.fromCharCode(...out.slice(o, o + 4));
      const off = dv.getUint32(o + 8), len = dv.getUint32(o + 12);
      expect(off % 4).toBe(0);
      const data = out.slice(off, off + len);
      if (tag === 'head') data.fill(0, 8, 12);
      expect(tableChecksum(data), tag).toBe(dv.getUint32(o + 4));
    }
  });
  it('replaces and removes tables', () => {
    const a = injectTables(font(), { 'TEST': new Uint8Array([1]) });
    const b = injectTables(a, { 'TEST': new Uint8Array([2, 2]) });
    expect([...readTables(b).tables.find((t) => t.tag === 'TEST')!.data]).toEqual([2, 2]);
    const c = injectTables(b, { 'TEST': null });
    expect(readTables(c).tables.some((t) => t.tag === 'TEST')).toBe(false);
    expect(() => injectTables(c, { 'TOOLONG': new Uint8Array(1) })).toThrow();
  });
});
