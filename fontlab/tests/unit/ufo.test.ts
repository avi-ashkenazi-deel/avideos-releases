import { describe, it, expect } from 'vitest';
import { zipStore, crc32 } from '../../src/export/zip';
import { ufoFiles, ufoZip, glifFileName, ufoInputFromBuild, contourToUfoPoints, type UfoInput, type UfoGlyph } from '../../src/export/ufo';
import { DEFAULT_METRICS, type Contour, type Vec } from '../../src/core/glyph';
import { signedArea } from '../../src/core/geometry';

/* ---------- helpers ---------- */

/** Reference CRC-32, bit by bit (no table), to cross-check the table-driven one. */
function crcRef(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface Entry { name: string; data: Uint8Array; crc: number; method: number; flags: number; localName: string }

/** Tiny ZIP reader: end record → central directory → local headers. */
function unzip(zip: Uint8Array): Entry[] {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const dec = new TextDecoder('utf-8', { fatal: true });
  const end = zip.length - 22;
  expect(v.getUint32(end, true)).toBe(0x06054b50);
  const count = v.getUint16(end + 10, true);
  expect(v.getUint16(end + 8, true)).toBe(count);
  const cdSize = v.getUint32(end + 12, true), cdStart = v.getUint32(end + 16, true);
  expect(cdStart + cdSize).toBe(end);
  const out: Entry[] = [];
  let p = cdStart;
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(p, true)).toBe(0x02014b50);
    const flags = v.getUint16(p + 8, true), method = v.getUint16(p + 10, true);
    const crc = v.getUint32(p + 16, true), csize = v.getUint32(p + 20, true), usize = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true), extra = v.getUint16(p + 30, true), comment = v.getUint16(p + 32, true);
    const offset = v.getUint32(p + 42, true);
    const name = dec.decode(zip.subarray(p + 46, p + 46 + nameLen));
    expect(csize).toBe(usize);
    // local header must agree with the central directory
    expect(v.getUint32(offset, true)).toBe(0x04034b50);
    expect(v.getUint16(offset + 6, true)).toBe(flags);
    expect(v.getUint16(offset + 8, true)).toBe(method);
    expect(v.getUint32(offset + 14, true)).toBe(crc);
    expect(v.getUint32(offset + 18, true)).toBe(csize);
    expect(v.getUint32(offset + 22, true)).toBe(usize);
    const lNameLen = v.getUint16(offset + 26, true), lExtra = v.getUint16(offset + 28, true);
    const localName = dec.decode(zip.subarray(offset + 30, offset + 30 + lNameLen));
    const start = offset + 30 + lNameLen + lExtra;
    out.push({ name, data: zip.subarray(start, start + csize), crc, method, flags, localName });
    p += 46 + nameLen + extra + comment;
  }
  expect(p).toBe(end);
  return out;
}

const rect = (x0: number, y0: number, x1: number, y1: number): Contour => ({ points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] });
const hole = (x0: number, y0: number, x1: number, y1: number): Contour => ({ points: [[x0, y0], [x0, y1], [x1, y1], [x1, y0]] });
const circle = (cx: number, cy: number, r: number, n = 96): Contour => ({ points: Array.from({ length: n }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)] as Vec) });

interface P { x: number; y: number; type?: string; smooth: boolean }
function parseGlif(xml: string): { name: string; advance: number; unicodes: string[]; contours: P[][] } {
  const attr = (tag: string, a: string) => new RegExp(`${a}="([^"]*)"`).exec(tag)?.[1];
  const contours = [...xml.matchAll(/<contour>([\s\S]*?)<\/contour>/g)].map((m) =>
    [...m[1].matchAll(/<point [^>]*\/>/g)].map((pm) => ({ x: +attr(pm[0], 'x')!, y: +attr(pm[0], 'y')!, type: attr(pm[0], 'type'), smooth: attr(pm[0], 'smooth') === 'yes' })));
  return {
    name: /<glyph name="([^"]*)" format="2">/.exec(xml)![1],
    advance: +/<advance width="(-?\d+)"\/>/.exec(xml)![1],
    unicodes: [...xml.matchAll(/<unicode hex="([0-9A-F]+)"\/>/g)].map((m) => m[1]),
    contours,
  };
}

function input(glyphs: UfoGlyph[], extra: Partial<UfoInput> = {}): UfoInput {
  return { familyName: 'Test Funk', metrics: DEFAULT_METRICS, glyphs, ...extra };
}
const fileOf = (files: { path: string; data: string }[], path: string) => {
  const f = files.find((x) => x.path === path);
  if (!f) throw new Error(`missing ${path}: ${files.map((x) => x.path).join(', ')}`);
  return f.data;
};
const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
/** key → string pairs of a flat plist dict (XML entities decoded) */
const dictStrings = (xml: string) => Object.fromEntries([...xml.matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g)].map((m) => [unescape(m[1]), unescape(m[2])]));
const dictNumber = (xml: string, key: string) => +new RegExp(`<key>${key}</key>\\s*<(?:integer|real)>(-?[\\d.]+)<`).exec(xml)![1];

/* ---------- zip ---------- */

describe('zipStore', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32('123456789')).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
    const bytes = Uint8Array.from({ length: 5000 }, (_, i) => (i * 131 + 7) & 0xff);
    expect(crc32(bytes)).toBe(crcRef(bytes));
  });

  it('writes local headers, central directory and end record that parse back', () => {
    const binary = Uint8Array.from({ length: 1000 }, (_, i) => (i * 37) & 0xff);
    const files = [
      { path: 'Font.ufo/metainfo.plist', data: '<plist/>\n' },
      { path: 'Font.ufo/glyphs/ж_é.glif', data: 'žluťoučký kůň — ✓' },
      { path: 'Font.ufo/data.bin', data: binary },
      { path: 'empty.txt', data: '' },
    ];
    const zip = zipStore(files, new Date(Date.UTC(2026, 0, 2, 3, 4, 6)));
    const entries = unzip(zip);
    expect(entries.map((e) => e.name)).toEqual(files.map((f) => f.path));
    const enc = new TextEncoder();
    entries.forEach((e, i) => {
      const want = typeof files[i].data === 'string' ? enc.encode(files[i].data as string) : (files[i].data as Uint8Array);
      expect(e.localName).toBe(e.name);
      expect(e.method).toBe(0);                 // stored
      expect(e.flags & 0x0800).toBe(0x0800);    // UTF-8 names
      expect([...e.data]).toEqual([...want]);
      expect(e.crc).toBe(crcRef(want));
    });
    // DOS date/time of the first local header: 2026-01-02 03:04:06
    const v = new DataView(zip.buffer);
    expect(v.getUint16(12, true)).toBe(((2026 - 1980) << 9) | (1 << 5) | 2);
    expect(v.getUint16(10, true)).toBe((3 << 11) | (4 << 5) | 3);
    // total size: headers + names + data, nothing else
    const nameBytes = files.reduce((a, f) => a + enc.encode(f.path).length, 0);
    const dataBytes = entries.reduce((a, e) => a + e.data.length, 0);
    expect(zip.length).toBe(22 + files.length * (30 + 46) + 2 * nameBytes + dataBytes);
  });

  it('normalises paths and rejects escapes', () => {
    const entries = unzip(zipStore([{ path: '/a\\b/./c.txt', data: 'x' }, { path: 'a/b/c.txt', data: 'y' }]));
    expect(entries.map((e) => e.name)).toEqual(['a/b/c.txt']);
    expect(new TextDecoder().decode(entries[0].data)).toBe('y');
    expect(() => zipStore([{ path: '../evil', data: '' }])).toThrow();
    expect(unzip(zipStore([]))).toEqual([]);
  });
});

/* ---------- file names ---------- */

describe('glifFileName (UFO 3 user name → file name)', () => {
  it('follows the convention', () => {
    const cases: [string, string][] = [
      ['A', 'A_.glif'], ['a', 'a.glif'], ['A.alt', 'A_.alt.glif'], ['a.ss01', 'a.ss01.glif'], ['con', '_con.glif'],
      ['f_f_i', 'f_f_i.glif'], ['T_H', 'T__H_.glif'], ['AE', 'A_E_.glif'], ['Aacute', 'A_acute.glif'], ['.notdef', '_notdef.glif'],
      ['zero.tnum', 'zero.tnum.glif'], ['uni0416', 'uni0416.glif'], ['a*b', 'a_b.glif'], ['a/b:c', 'a_b_c.glif'], ['a"b', 'a_b.glif'],
      ['com1.alt', '_com1.alt.glif'], ['prn.AUX', '_prn.A_U_X_.glif'], ['nul', '_nul.glif'], ['a[1]', 'a_1_.glif'], ['Ж', 'Ж_.glif'], ['a\u0007b', 'a_b.glif'],
    ];
    for (const [name, file] of cases) expect(glifFileName(name)).toBe(file);
  });

  it('clips to 255 characters', () => {
    const f = glifFileName('x'.repeat(400));
    expect(f.length).toBe(255);
    expect(f.endsWith('.glif')).toBe(true);
  });

  it('resolves clashes on case-insensitive disks', () => {
    const used = new Set<string>();
    expect(glifFileName('a_b', used)).toBe('a_b.glif');
    expect(used.has('a_b.glif')).toBe(true);
    expect(glifFileName('a*b', used)).toBe('a_b000000000000001.glif');
    expect(glifFileName('a/b', used)).toBe('a_b000000000000002.glif');
    // "A" → "A_" and "a_" both lowercase to "a_"
    expect(glifFileName('A', used)).toBe('A_.glif');
    expect(glifFileName('a_', used)).toBe('a_000000000000001.glif');
    expect(used.size).toBe(5);
    const long = new Set<string>();
    const first = glifFileName('y'.repeat(400), long), second = glifFileName('y'.repeat(400), long);
    expect(second).not.toBe(first);
    expect(second.length).toBe(255);
  });
});

/* ---------- glif ---------- */

describe('UFO glyphs', () => {
  it('writes a rectangle as 4 line points, a ring as two contours, keeping direction', () => {
    const files = ufoFiles(input([
      { name: 'H', unicodes: [0x48], advance: 600.4, contours: [rect(50, 0, 550, 700)] },
      { name: 'O', unicodes: [0x4f, 0x39f], advance: 700, contours: [rect(50, 0, 650, 700), hole(150, 100, 550, 600)] },
    ]));
    const h = parseGlif(fileOf(files, 'glyphs/H_.glif'));
    expect(h.name).toBe('H');
    expect(h.advance).toBe(600);
    expect(h.unicodes).toEqual(['0048']);
    expect(h.contours).toHaveLength(1);
    expect(h.contours[0]).toHaveLength(4);
    expect(h.contours[0].every((p) => p.type === 'line' && !p.smooth)).toBe(true);
    expect(new Set(h.contours[0].map((p) => `${p.x},${p.y}`))).toEqual(new Set(['50,0', '550,0', '550,700', '50,700'])); // no repeated closing point
    const o = parseGlif(fileOf(files, 'glyphs/O_.glif'));
    expect(o.unicodes).toEqual(['004F', '039F']);
    expect(o.contours).toHaveLength(2);
    expect(o.contours.map((c) => c.length)).toEqual([4, 4]);
    // outer counter-clockwise (positive area), hole clockwise: same as our own convention
    expect(signedArea(o.contours[0].map((p) => [p.x, p.y]))).toBeGreaterThan(0);
    expect(signedArea(o.contours[1].map((p) => [p.x, p.y]))).toBeLessThan(0);
  });

  it('writes curves as two off-curve points before each curve point', () => {
    const files = ufoFiles(input([{ name: 'o', unicodes: [0x6f], advance: 600, contours: [circle(300, 250, 250), { points: circle(300, 250, 150).points.slice().reverse() }] }]));
    const o = parseGlif(fileOf(files, 'glyphs/o.glif'));
    expect(o.contours).toHaveLength(2);
    for (const c of o.contours) {
      const n = c.length;
      const curves = c.filter((p) => p.type === 'curve');
      expect(curves.length).toBeGreaterThanOrEqual(3);
      expect(c.filter((p) => !p.type).length).toBe(2 * curves.length);
      expect(c[0].type).toBe('curve'); // starts on an on-curve point; its handles close the cycle
      c.forEach((p, i) => {
        if (p.type !== 'curve') return;
        expect(c[(i - 1 + n) % n].type).toBeUndefined();
        expect(c[(i - 2 + n) % n].type).toBeUndefined();
        expect(c[(i - 3 + n) % n].type).toBeDefined();
      });
      expect(curves.every((p) => p.smooth)).toBe(true);
      expect(c.every((p) => Number.isInteger(p.x) && Number.isInteger(p.y))).toBe(true);
      // first and last on-curve points differ: the contour is closed by being a cycle
      const on = c.filter((p) => p.type);
      expect(`${on[0].x},${on[0].y}`).not.toBe(`${on[on.length - 1].x},${on[on.length - 1].y}`);
      // all on-curve points sit on the circle
      const r = signedArea(c.map((p) => [p.x, p.y])) > 0 ? 250 : 150;
      for (const p of on) expect(Math.abs(Math.hypot(p.x - 300, p.y - 250) - r)).toBeLessThan(3);
    }
    expect(signedArea(o.contours[0].map((p) => [p.x, p.y]))).toBeGreaterThan(0);
    expect(signedArea(o.contours[1].map((p) => [p.x, p.y]))).toBeLessThan(0);
  });

  it('mixes lines and curves in one contour (a D shape)', () => {
    const arc: Vec[] = Array.from({ length: 49 }, (_, i) => { const a = -Math.PI / 2 + (Math.PI * i) / 48; return [300 + 300 * Math.cos(a), 350 + 350 * Math.sin(a)] as Vec; });
    const d = contourToUfoPoints({ points: [[60, 0], ...arc, [60, 700]] });
    expect(d.some((p) => p.type === 'line')).toBe(true);
    expect(d.some((p) => p.type === 'curve')).toBe(true);
    expect(d.filter((p) => !p.type).length).toBe(2 * d.filter((p) => p.type === 'curve').length);
    expect(d.find((p) => p.x === 60 && p.y === 0)?.smooth).toBeFalsy();
  });

  it('keeps curves on the outline when the fitter overshoots', () => {
    // a real case: the macron of a generated "ō" — a nearly straight, slightly wobbly bar
    const bar: Vec[] = [[104.4, 719.6], [109.8, 704.8], [119.9, 692.7], [133.6, 684.8], [149.1, 682.1], [181.1, 682.9], [213.1, 681.7], [245.1, 682.8], [293.1, 681.2], [366.9, 683.1], [382, 685.8], [395.4, 693.5], [405.3, 705.3], [410.5, 719.8], [410.5, 735.2], [405.3, 749.6], [395.4, 761.4], [382, 769.1], [366.9, 771.8], [293.1, 773.7], [245.1, 772.1], [213.1, 773.3], [181.1, 772], [149.1, 772.9], [133.6, 770.1], [119.9, 762.3], [109.8, 750.2], [104.4, 735.4]];
    const pts = contourToUfoPoints({ points: bar });
    expect(pts.length).toBeGreaterThan(8);
    // the raw fit puts handles 15,000 units away here; ours stay next to the 307 × 93 bar
    for (const p of pts) {
      expect(p.x).toBeGreaterThan(104 - 30); expect(p.x).toBeLessThan(411 + 30);
      expect(p.y).toBeGreaterThan(681 - 30); expect(p.y).toBeLessThan(774 + 30);
    }
    for (const p of pts.filter((q) => q.type)) {
      expect(p.x).toBeGreaterThanOrEqual(104); expect(p.x).toBeLessThanOrEqual(411);
      expect(p.y).toBeGreaterThanOrEqual(681); expect(p.y).toBeLessThanOrEqual(774);
    }
  });

  it('skips degenerate contours and writes empty glyphs without an outline', () => {
    const files = ufoFiles(input([{ name: 'x', unicodes: [0x78], advance: 500, contours: [{ points: [[0, 0], [10, 0]] }, { points: [] }, { points: [[5, 5], [5.2, 5.1], [5.1, 5.3]] }] }]));
    const x = fileOf(files, 'glyphs/x.glif');
    expect(x).not.toContain('<outline>');
    expect(x).toContain('<advance width="500"/>');
  });
});

/* ---------- the UFO as a whole ---------- */

describe('ufoFiles', () => {
  const glyphs: UfoGlyph[] = [
    { name: 'A', unicodes: [0x41], advance: 600, contours: [rect(50, 0, 550, 700)] },
    { name: 'a', unicodes: [0x61], advance: 500, contours: [rect(50, 0, 450, 500)] },
    { name: 'V', unicodes: [0x56], advance: 600, contours: [rect(60, 0, 540, 900)] },
    { name: 'a.ss01', unicodes: [], advance: 520, contours: [rect(50, 0, 470, 500)] },
    { name: 'Q&A<"x">', unicodes: [0x26], advance: 700, contours: [rect(50, -250, 650, 700)] },
    { name: 'A', unicodes: [0x391], advance: 1, contours: [] },            // duplicate name: ignored
    { name: 'Alpha', unicodes: [0x41, 0x391], advance: 600, contours: [] }, // U+0041 already taken by A
  ];
  const files = ufoFiles(input(glyphs, {
    familyName: 'Tom & Jerry\'s <Font>', note: 'made with <3 & "love"',
    kerning: { A: { V: -85.4, a: 0, missing: -10 }, V: { A: -80, 'Q&A<"x">': 12 }, ghost: { A: -5 } },
    features: 'feature ss01 { sub a by a.ss01; } ss01;',
  }));

  it('has the UFO 3 skeleton', () => {
    const paths = files.map((f) => f.path);
    for (const p of ['metainfo.plist', 'fontinfo.plist', 'layercontents.plist', 'lib.plist', 'kerning.plist', 'features.fea', 'glyphs/contents.plist']) expect(paths).toContain(p);
    expect(new Set(paths).size).toBe(paths.length);
    const meta = fileOf(files, 'metainfo.plist');
    expect(dictNumber(meta, 'formatVersion')).toBe(3);
    expect(dictStrings(meta).creator).toMatch(/^[a-z0-9.-]+$/);
    expect(fileOf(files, 'layercontents.plist')).toMatch(/<array>\s*<array>\s*<string>public\.default<\/string>\s*<string>glyphs<\/string>\s*<\/array>\s*<\/array>/);
    expect(fileOf(files, 'features.fea')).toBe('feature ss01 { sub a by a.ss01; } ss01;\n');
    for (const f of files.filter((x) => x.path.endsWith('.plist') || x.path.endsWith('.glif'))) expect(f.data.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
  });

  it('lists every glyph in contents.plist and public.glyphOrder, .notdef and space first', () => {
    const contents = dictStrings(fileOf(files, 'glyphs/contents.plist'));
    expect(Object.keys(contents)).toEqual(['.notdef', 'space', 'A', 'a', 'V', 'a.ss01', 'Q&A<"x">', 'Alpha']);
    expect(contents['.notdef']).toBe('_notdef.glif');
    expect(contents.A).toBe('A_.glif');
    expect(contents.a).toBe('a.glif');
    expect(contents['a.ss01']).toBe('a.ss01.glif');
    expect(contents.Alpha).toBe('A_lpha.glif');
    const glifs = files.filter((f) => f.path.startsWith('glyphs/') && f.path.endsWith('.glif')).map((f) => f.path.slice(7));
    expect(glifs.sort()).toEqual(Object.values(contents).sort());
    expect(new Set(glifs.map((g) => g.toLowerCase())).size).toBe(glifs.length);
    const order = [...fileOf(files, 'lib.plist').matchAll(/<string>([^<]*)<\/string>/g)].map((m) => unescape(m[1]));
    expect(order).toEqual(Object.keys(contents));
    // added glyphs match the OTF export; a code point belongs to one glyph only
    const notdef = parseGlif(fileOf(files, 'glyphs/_notdef.glif'));
    expect(notdef.advance).toBe(500);
    expect(notdef.contours).toHaveLength(2);
    const space = parseGlif(fileOf(files, 'glyphs/space.glif'));
    expect(space.advance).toBe(280);
    expect(space.unicodes).toEqual(['0020']);
    expect(parseGlif(fileOf(files, 'glyphs/A_.glif')).unicodes).toEqual(['0041']);
    expect(parseGlif(fileOf(files, 'glyphs/A_lpha.glif')).unicodes).toEqual(['0391']);
    expect(parseGlif(fileOf(files, 'glyphs/a.ss01.glif')).unicodes).toEqual([]);
  });

  it('does not add .notdef or space twice', () => {
    const own = ufoFiles(input([{ name: 'space', unicodes: [32], advance: 333, contours: [] }, { name: '.notdef', unicodes: [], advance: 444, contours: [rect(0, 0, 400, 700)] }]));
    expect(Object.keys(dictStrings(fileOf(own, 'glyphs/contents.plist')))).toEqual(['space', '.notdef']);
    expect(parseGlif(fileOf(own, 'glyphs/space.glif')).advance).toBe(333);
  });

  it('writes fontinfo.plist from the metrics', () => {
    const info = fileOf(files, 'fontinfo.plist');
    const s = dictStrings(info);
    expect(s.familyName).toBe('Tom & Jerry\'s <Font>');
    expect(info).toContain('<string>Tom &amp; Jerry&apos;s &lt;Font&gt;</string>');
    expect(s.styleName).toBe('Regular');
    expect(s.styleMapStyleName).toBe('regular');
    expect(s.postscriptFontName).toBe('TomJerrysFont-Regular');
    expect(s.note).toBe('made with <3 & "love"');
    for (const [k, v] of Object.entries({
      unitsPerEm: 1000, ascender: 800, descender: -200, xHeight: 500, capHeight: 700, versionMajor: 1, versionMinor: 0,
      openTypeOS2TypoAscender: 800, openTypeOS2TypoDescender: -200, openTypeOS2TypoLineGap: 0, openTypeHheaAscender: 800, openTypeHheaDescender: -200,
      openTypeOS2WinAscent: 900, openTypeOS2WinDescent: 250, // cover the ink (V reaches 900, & dips to -250)
    })) expect([k, dictNumber(info, k)]).toEqual([k, v]);
    expect(info).not.toContain('<real>');
  });

  it('nests kerning.plist by first then second glyph and drops unknown glyphs and zeros', () => {
    const k = fileOf(files, 'kerning.plist');
    const flat = k.replace(/\s+/g, '');
    expect(flat).toContain('<dict><key>A</key><dict><key>V</key><integer>-85</integer></dict><key>V</key><dict><key>A</key><integer>-80</integer><key>Q&amp;A&lt;&quot;x&quot;&gt;</key><integer>12</integer></dict></dict>');
    expect(k).not.toContain('missing');
    expect(k).not.toContain('ghost');
    expect(ufoFiles(input(glyphs)).some((f) => f.path === 'kerning.plist' || f.path === 'features.fea')).toBe(false);
    expect(ufoFiles(input(glyphs, { kerning: { ghost: { A: -5 } } })).some((f) => f.path === 'kerning.plist')).toBe(false);
  });

  it('escapes XML in glyph names', () => {
    const contents = fileOf(files, 'glyphs/contents.plist');
    expect(contents).toContain('<key>Q&amp;A&lt;&quot;x&quot;&gt;</key>');
    expect(contents).toContain('<string>Q_&amp;A___x__.glif</string>'); // < " > are illegal in file names, & is not
    const glif = files.find((f) => f.path.startsWith('glyphs/Q_'))!;
    expect(glif.path).toBe('glyphs/Q_&A___x__.glif');
    expect(glif.data).toContain('<glyph name="Q&amp;A&lt;&quot;x&quot;&gt;" format="2">');
    expect(glif.data).not.toMatch(/name="[^"]*[<>]/);
    for (const f of files) if (f.path !== 'features.fea') expect(f.data).not.toMatch(/&(?!(amp|lt|gt|quot|apos);)/);
  });
});

describe('ufoZip', () => {
  it('packs one <Family>-<Style>.ufo folder into <slug>.ufo.zip', () => {
    const z = ufoZip(input([{ name: 'A', unicodes: [0x41], advance: 600, contours: [rect(50, 0, 550, 700)] }], { familyName: 'Tom & Jerry' }), new Date(Date.UTC(2026, 5, 1)));
    expect(z.name).toBe('tom-jerry.ufo.zip');
    const entries = unzip(z.bytes);
    expect(entries.every((e) => e.name.startsWith('TomJerry-Regular.ufo/'))).toBe(true);
    const names = entries.map((e) => e.name.slice('TomJerry-Regular.ufo/'.length));
    expect(names).toEqual(expect.arrayContaining(['metainfo.plist', 'fontinfo.plist', 'layercontents.plist', 'lib.plist', 'glyphs/contents.plist', 'glyphs/A_.glif', 'glyphs/_notdef.glif', 'glyphs/space.glif']));
    const glif = new TextDecoder().decode(entries.find((e) => e.name.endsWith('glyphs/A_.glif'))!.data);
    expect(parseGlif(glif).contours[0]).toHaveLength(4);
    const bold = ufoZip(input([], { familyName: 'Шрифт', styleName: 'Bold Italic' }));
    expect(bold.name).toBe('font-bold-italic.ufo.zip');
    expect(unzip(bold.bytes)[0].name.startsWith('Шрифт-BoldItalic.ufo/')).toBe(true);
  });
});

describe('ufoInputFromBuild', () => {
  const b = (char: string, advance: number, contours: Contour[] = [rect(50, 0, advance - 50, 600)]) => ({ char, unicode: char.codePointAt(0)!, advance, contours });
  const res = ufoInputFromBuild({
    familyName: 'Built', metrics: DEFAULT_METRICS,
    glyphs: { b: b('b', 500), a: b('a', 520), A: b('A', 640), V: b('V', 600), 0: b('0', 560), 1: b('1', 360), '-': b('-', 400), '>': b('>', 500), '→': b('→', 800), ж: b('ж', 700), empty: b('e', 500, []) },
    alternates: { 'a#ss01': b('a', 600), 'a#ss02': b('a', 610), 'z#ss01': b('z', 500), 'b#ss01': b('b', 500, []) },
    kerning: { AV: -80, VA: -75.6, 'A?': -10, Aж: 15, 'A ': -20, bad: 5, ab: 0 },
  });

  it('names glyphs like the OTF export, in code point order, with alternates and tabular figures', () => {
    expect(res.glyphs.map((g) => g.name)).toEqual(['hyphen', 'zero', 'one', 'greater', 'A', 'V', 'a', 'b', 'uni0436', 'arrowright', 'a.ss01', 'a.ss02', 'zero.tnum', 'one.tnum']);
    expect(res.glyphs.find((g) => g.name === 'a.ss01')).toMatchObject({ unicodes: [], advance: 600 });
    const one = res.glyphs.find((g) => g.name === 'one.tnum')!;
    expect(one.advance).toBe(560);
    expect(one.contours[0].points[0][0]).toBe(150); // centred in the wider cell
    expect(res.glyphs.find((g) => g.name === 'uni0436')!.unicodes).toEqual([0x436]);
  });

  it('writes matching features and kerning by glyph name', () => {
    expect(res.features).toContain('languagesystem DFLT dflt;');
    expect(res.features).toContain('feature ss01 {\n  sub a by a.ss01;\n} ss01;');
    expect(res.features).toContain('feature ss02 {\n  sub a by a.ss02;\n} ss02;');
    expect(res.features).toContain('sub a from [a.ss01 a.ss02];');
    expect(res.features).toContain('sub one by one.tnum;');
    expect(res.features).toContain('feature liga {\n  sub hyphen greater by arrowright;\n} liga;');
    expect(res.features).not.toContain('b.ss01');
    expect(res.kerning).toEqual({ A: { V: -80, uni0436: 15, space: -20 }, V: { A: -76 } });
    const files = ufoFiles(res);
    expect(fileOf(files, 'kerning.plist')).toContain('<key>uni0436</key>');
    expect(Object.keys(dictStrings(fileOf(files, 'glyphs/contents.plist')))).toHaveLength(16);
    expect(ufoInputFromBuild({ familyName: 'x', metrics: DEFAULT_METRICS, glyphs: { a: b('a', 500) } }).features).toBeUndefined();
  });
});
