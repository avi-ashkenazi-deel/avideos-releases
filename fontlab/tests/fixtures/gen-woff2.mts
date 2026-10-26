// Generates tests/fixtures/sample.woff2 from FontLab's own generated alphabet.
// Usage: npx tsx tests/fixtures/gen-woff2.mts
import { writeFileSync } from 'node:fs';
import { generateGlyphs } from '../../src/generate/compose';
import { glyphToContours } from '../../src/outline';
import { buildFont, fontToArrayBuffer } from '../../src/export/otf';
import { DEFAULT_STATS, DEFAULT_METRICS, CHARSET } from '../../src/core/glyph';
const glyphs = generateGlyphs({ seeds: [], stats: { ...DEFAULT_STATS }, mutation: 0.2, glyphs: {} }, 3, CHARSET);
const list = Object.values(glyphs).map((g) => ({ char: g.char, unicode: g.unicode, advance: g.advance, contours: glyphToContours(g) }));
const otf = fontToArrayBuffer(buildFont(list, { familyName: 'Sample Funk', metrics: DEFAULT_METRICS }));
const compress = (await import('wawoff2/compress.js')).default;
const woff2 = await compress(new Uint8Array(otf));
writeFileSync('tests/fixtures/sample.woff2', woff2);
console.log('wrote tests/fixtures/sample.woff2', woff2.length, 'bytes (otf was', otf.byteLength, ')');
