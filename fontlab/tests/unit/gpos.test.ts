import { describe, it, expect } from 'vitest';
import { buildGposKern, kernToGlyphPairs, kerningFea, type GlyphPair } from '../../src/export/gpos';
import { injectTables, readTables } from '../../src/export/sfnt';
import { buildFont, fontToArrayBuffer } from '../../src/export/otf';
import { parse } from '../../src/vendor/opentype';
import { DEFAULT_METRICS, type Contour, type Vec } from '../../src/core/glyph';

const poly = (...pts: Vec[]): Contour[] => [{ points: pts }];
const GLYPHS = [
  { char: 'H', unicode: 72, advance: 670, contours: poly([85, 0], [175, 0], [175, 305], [495, 305], [495, 0], [585, 0], [585, 700], [495, 700], [495, 395], [175, 395], [175, 700], [85, 700]) },
  { char: 'A', unicode: 65, advance: 534, contours: poly([17, 0], [107, 0], [267, 546], [427, 0], [517, 0], [312, 700], [222, 700]) },
  { char: 'V', unicode: 86, advance: 534, contours: poly([222, 0], [312, 0], [517, 700], [427, 700], [267, 154], [107, 700], [17, 700]) },
  { char: 'T', unicode: 84, advance: 534, contours: poly([222, 0], [312, 0], [312, 610], [517, 610], [517, 700], [17, 700], [17, 610], [222, 610]) },
  { char: 'o', unicode: 111, advance: 588, contours: poly([44, 0], [544, 0], [544, 500], [44, 500]) },
];
const makeFont = () => buildFont(GLYPHS, { familyName: 'Kern Test', metrics: DEFAULT_METRICS });

/** Independent reader for the subset of GPOS the writer emits (follows every offset, checks every bound). */
function readGpos(u8: Uint8Array) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const u16 = (o: number) => { expect(o + 2).toBeLessThanOrEqual(u8.length); return dv.getUint16(o); };
  const tag = (o: number) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  expect(dv.getUint32(0)).toBe(0x00010000);
  const scriptList = u16(4), featureList = u16(6), lookupList = u16(8);
  const scripts: Record<string, number[]> = {};
  for (let i = 0; i < u16(scriptList); i++) {
    const rec = scriptList + 2 + i * 6;
    const script = scriptList + u16(rec + 4);
    expect(u16(script + 2)).toBe(0); // no LangSysRecords
    const langSys = script + u16(script);
    expect(u16(langSys)).toBe(0);
    expect(u16(langSys + 2)).toBe(0xffff);
    scripts[tag(rec)] = Array.from({ length: u16(langSys + 4) }, (_, k) => u16(langSys + 6 + k * 2));
  }
  const features: { tag: string; lookups: number[] }[] = [];
  for (let i = 0; i < u16(featureList); i++) {
    const rec = featureList + 2 + i * 6;
    const f = featureList + u16(rec + 4);
    expect(u16(f)).toBe(0);
    features.push({ tag: tag(rec), lookups: Array.from({ length: u16(f + 2) }, (_, k) => u16(f + 4 + k * 2)) });
  }
  expect(u16(lookupList)).toBe(1);
  const lookup = lookupList + u16(lookupList + 2);
  const lookupType = u16(lookup);
  expect(u16(lookup + 2)).toBe(0);
  const subtables: { start: number; firsts: number[]; coverageFormat: number; size: number }[] = [];
  const pairs = new Map<string, number>();
  for (let i = 0; i < u16(lookup + 4); i++) {
    let st = lookup + u16(lookup + 6 + i * 2);
    if (lookupType === 9) {
      expect(u16(st)).toBe(1);
      expect(u16(st + 2)).toBe(2);
      st += dv.getUint32(st + 4);
    } else expect(lookupType).toBe(2);
    expect(u16(st)).toBe(1);          // PairPosFormat1
    expect(u16(st + 4)).toBe(0x0004); // XAdvance on the first glyph
    expect(u16(st + 6)).toBe(0);      // nothing on the second
    const cov = st + u16(st + 2);
    const coverageFormat = u16(cov);
    const firsts: number[] = [];
    if (coverageFormat === 1) for (let k = 0; k < u16(cov + 2); k++) firsts.push(u16(cov + 4 + k * 2));
    else {
      expect(coverageFormat).toBe(2);
      for (let k = 0; k < u16(cov + 2); k++) {
        const r = cov + 4 + k * 6;
        expect(u16(r + 4)).toBe(firsts.length); // startCoverageIndex
        for (let g = u16(r); g <= u16(r + 2); g++) firsts.push(g);
      }
    }
    expect(firsts).toEqual([...firsts].sort((a, b) => a - b));
    expect(new Set(firsts).size).toBe(firsts.length);
    expect(u16(st + 8)).toBe(firsts.length);
    let end = st;
    firsts.forEach((first, k) => {
      const ps = st + u16(st + 10 + k * 2);
      const n = u16(ps);
      let prev = -1;
      for (let j = 0; j < n; j++) {
        const second = u16(ps + 2 + j * 4);
        expect(second).toBeGreaterThan(prev); // sorted by second glyph, no duplicates
        prev = second;
        expect(pairs.has(`${first},${second}`)).toBe(false);
        pairs.set(`${first},${second}`, dv.getInt16(ps + 4 + j * 4));
      }
      end = Math.max(end, ps + 2 + n * 4);
    });
    subtables.push({ start: st, firsts, coverageFormat, size: end - st });
  }
  return { scripts, features, lookupType, subtables, pairs };
}
const asMap = (ps: GlyphPair[]) => new Map(ps.map((p) => [`${p.left},${p.right}`, p.value]));
/** deterministic pairs: `firsts` first glyphs with `per` second glyphs each */
function synthetic(firsts: number, per: number): GlyphPair[] {
  const out: GlyphPair[] = [];
  for (let i = 0; i < firsts; i++) {
    for (let j = 0; j < per; j++) out.push({ left: 3 + ((i * 37) % 997), right: 2 + ((i * 11 + j * 7) % 1500), value: (((i * 13 + j * 29) % 121) - 60) * 5 || 5 });
  }
  return out.sort((a, b) => ((a.left * 31 + a.right * 17) % 101) - ((b.left * 31 + b.right * 17) % 101)); // shuffled
}

describe('GPOS kern table', () => {
  it('writes pairs that opentype.js reads back from an injected font', () => {
    const font = makeFont();
    const kern = { AV: -85, VA: -80, To: -105, TA: -30, 'A?': -50, HH: 0 };
    const pairs = kernToGlyphPairs(kern, (ch) => font.charToGlyphIndex(ch));
    expect(pairs.length).toBe(4); // '?' has no glyph, HH is 0
    const gpos = buildGposKern(pairs)!;
    expect(gpos).toBeInstanceOf(Uint8Array);
    const otf = injectTables(fontToArrayBuffer(font), { GPOS: gpos });
    expect(readTables(otf).tables.map((t) => t.tag)).toContain('GPOS');
    const f = parse(otf);
    const k = (a: string, b: string) => f.getKerningValue(f.charToGlyph(a), f.charToGlyph(b));
    expect(k('A', 'V')).toBe(-85);
    expect(k('V', 'A')).toBe(-80);
    expect(k('T', 'o')).toBe(-105);
    expect(k('T', 'A')).toBe(-30);
    expect(k('H', 'H')).toBe(0);
    expect(k('o', 'T')).toBe(0);
    expect(k('A', 'T')).toBe(0);
    // the glyphs survived the surgery
    expect(f.charToGlyph('H').advanceWidth).toBe(670);
    expect(f.charToGlyph('A').path.commands.length).toBeGreaterThan(4);
    // what the layout engines look up: script → default language → feature 'kern' → lookup
    for (const script of ['DFLT', 'latn', 'cyrl']) {
      const lookups = f.position.getKerningTables(script, 'dflt');
      expect(lookups.length, script).toBe(1);
      expect(f.position.getKerningValue(lookups, f.charToGlyphIndex('A'), f.charToGlyphIndex('V'))).toBe(-85);
    }
  });
  it('has the documented layout', () => {
    const g = readGpos(buildGposKern([{ left: 7, right: 9, value: -85 }, { left: 3, right: 20, value: 40 }, { left: 7, right: 4, value: -10 }])!);
    expect(Object.keys(g.scripts)).toEqual(['DFLT', 'cyrl', 'latn']); // sorted by tag
    for (const idx of Object.values(g.scripts)) expect(idx).toEqual([0]);
    expect(g.features).toEqual([{ tag: 'kern', lookups: [0] }]);
    expect(g.lookupType).toBe(2);
    expect(g.subtables.length).toBe(1);
    expect(g.subtables[0].firsts).toEqual([3, 7]);
    expect([...g.pairs]).toEqual([['3,20', 40], ['7,4', -10], ['7,9', -85]]);
    // a run of consecutive first glyphs is stored as a range
    const run = readGpos(buildGposKern(Array.from({ length: 40 }, (_, i) => ({ left: 10 + i, right: 5, value: -20 })))!);
    expect(run.subtables[0].coverageFormat).toBe(2);
    expect(run.subtables[0].firsts.length).toBe(40);
    const custom = readGpos(buildGposKern([{ left: 1, right: 2, value: -5 }], { scripts: ['latn', 'grek', 'bad'] })!);
    expect(Object.keys(custom.scripts)).toEqual(['grek', 'latn']);
  });
  it('drops unusable pairs, keeps the last duplicate and returns null when nothing is left', () => {
    expect(buildGposKern([])).toBeNull();
    expect(buildGposKern([{ left: 5, right: 6, value: 0 }, { left: 0, right: 6, value: -50 }, { left: 6, right: 0, value: -50 }])).toBeNull();
    expect(buildGposKern([{ left: 5, right: 6, value: -50 }, { left: 5, right: 6, value: 0 }])).toBeNull();
    const g = readGpos(buildGposKern([
      { left: 5, right: 6, value: -50 }, { left: 5, right: 6, value: -70 }, { left: 5, right: 7, value: 12.4 },
      { left: 70000, right: 6, value: -5 }, { left: 5.5, right: 6, value: -5 }, { left: -1, right: 6, value: -5 },
      { left: 8, right: 9, value: -99999 }, { left: 8, right: 10, value: NaN },
    ])!);
    expect([...g.pairs]).toEqual([['5,6', -70], ['5,7', 12], ['8,9', -32768]]);
  });
  it('round-trips 5,000 pairs and splits them into several subtables when they outgrow the size limit', () => {
    const pairs = synthetic(250, 20);
    const want = asMap(pairs);
    expect(want.size).toBe(5000);
    const one = readGpos(buildGposKern(pairs)!); // 5,000 × 4 bytes fit a single subtable
    expect(one.lookupType).toBe(2);
    expect(one.subtables.length).toBe(1);
    expect(one.subtables[0].size).toBeLessThan(65536);
    expect(one.pairs).toEqual(want);

    const bytes = buildGposKern(pairs, { maxSubtableBytes: 6000 })!;
    const split = readGpos(bytes);
    expect(split.lookupType).toBe(2);
    expect(split.subtables.length).toBeGreaterThanOrEqual(4);
    expect(split.pairs).toEqual(want);
    const seenFirst = new Set<number>();
    for (const st of split.subtables) {
      expect(st.size).toBeLessThanOrEqual(6000);
      for (const f of st.firsts) { expect(seenFirst.has(f)).toBe(false); seenFirst.add(f); } // a first glyph lives in one subtable
    }
    // opentype.js walks the subtables too
    const f = parse(injectTables(fontToArrayBuffer(makeFont()), { GPOS: bytes }));
    const lookups = f.position.getKerningTables('latn', 'dflt');
    expect(lookups[0].subtables.length).toBe(split.subtables.length);
    for (const p of pairs.filter((_, i) => i % 50 === 0)) expect(f.position.getKerningValue(lookups, p.left, p.right)).toBe(p.value);
  });
  it('switches to extension subtables when the lookup outgrows 16-bit offsets', () => {
    const pairs = synthetic(900, 50);
    const want = asMap(pairs);
    expect(want.size).toBe(45000);
    const bytes = buildGposKern(pairs)!;
    expect(bytes.length).toBeGreaterThan(180000);
    const g = readGpos(bytes);
    expect(g.lookupType).toBe(9);
    expect(g.subtables.length).toBeGreaterThanOrEqual(3);
    for (const st of g.subtables) expect(st.size).toBeLessThanOrEqual(60000);
    expect(g.pairs).toEqual(want);
    // one first glyph with more pairs than a subtable normally holds stays in one piece
    const fat: GlyphPair[] = Array.from({ length: 20000 }, (_, i) => ({ left: 9, right: 1 + i, value: -(1 + (i % 300)) }));
    fat.push({ left: 4, right: 2, value: -15 }, { left: 12, right: 2, value: 25 });
    const h = readGpos(buildGposKern(fat)!);
    expect(h.pairs).toEqual(asMap(fat));
    expect(h.subtables.filter((st) => st.firsts.includes(9)).length).toBe(1);
  });
  it('kernToGlyphPairs maps characters to glyph indices', () => {
    const index: Record<string, number> = { A: 3, V: 4, '😀': 9 };
    const calls: string[] = [];
    const pairs = kernToGlyphPairs({ AV: -85.4, VA: -80, Ax: -10, xA: -10, 'A😀': 30, AVA: -5, A: -5, AA: 0, VV: NaN }, (ch) => { calls.push(ch); return index[ch] ?? 0; });
    expect(pairs).toEqual([{ left: 3, right: 4, value: -85 }, { left: 4, right: 3, value: -80 }, { left: 3, right: 9, value: 30 }]);
    expect(calls.length).toBe(new Set(calls).size); // each character is looked up once
  });
  it('kerningFea writes an AFDKO kern feature', () => {
    const names: Record<string, string> = { A: 'A', V: 'V', '.': 'period', T: 'T' };
    const fea = kerningFea({ 'T.': -80, AV: -85, VA: -80.2, 'A?': -10, TT: 0 }, (ch) => names[ch] ?? '');
    expect(fea).toBe('feature kern {\n  pos A V -85;\n  pos T period -80;\n  pos V A -80;\n} kern;\n');
    expect(kerningFea({}, () => 'x')).toBe('');
    expect(kerningFea({ AV: 0 }, () => 'x')).toBe('');
  });
});
