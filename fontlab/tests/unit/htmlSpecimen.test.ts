import { describe, it, expect } from 'vitest';
import { typeTesterHtml, toBase64, escapeHtml } from '../../src/export/specimen/html';

const fakeOtf = new Uint8Array([0x4f, 0x54, 0x54, 0x4f, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]); // 'OTTO' + bytes
const samples = [
  { title: 'Pangram', text: 'The quick brown fox jumps over the lazy dog' },
  { title: 'Hebrew', text: 'שלום עולם', rtl: true },
  { title: 'Markup', text: 'a <b>bold</b> & brave <tag>' },
];

describe('typeTesterHtml', () => {
  it('builds one self-contained document with the embedded font', () => {
    const html = typeTesterHtml({ name: 'Funk & Sons <Display>', otf: fakeOtf, samples });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<meta name="viewport"');
    expect(html).toContain('@font-face');
    expect(html).toContain(`font/otf;base64,${toBase64(fakeOtf)}`);
    expect(html).toContain('Funk &amp; Sons &lt;Display&gt;');
    expect(html).not.toContain('Funk & Sons <Display>');
    expect(html).toContain('The quick brown fox jumps over the lazy dog');
    expect(html).toContain('שלום עולם');
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('contenteditable="true"');
    expect(html).toContain('Made with FontLab');
    expect(html).not.toMatch(/<script\s+src=/i);
    expect(html).not.toMatch(/<link\s/i);
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toContain('@import');
    // no variable UI without a variable font
    expect(html).not.toContain('font/ttf;base64');
    expect(html).not.toContain('id="var"');
  });

  it('escapes sample text and attribute values', () => {
    const html = typeTesterHtml({ name: 'X', otf: fakeOtf, samples: [{ title: 'T "q"', text: 'a <b>bold</b> & brave' }] });
    expect(html).toContain('a &lt;b&gt;bold&lt;/b&gt; &amp; brave');
    expect(html).not.toContain('<b>bold</b>');
    expect(html).toContain('aria-label="T &quot;q&quot;"');
    expect(escapeHtml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&#39;');
  });

  it('adds the variable font, a toggle and one slider per axis when present', () => {
    const varBytes = new Uint8Array([0, 1, 0, 0, 9, 9, 9]);
    const html = typeTesterHtml({
      name: 'Var', otf: fakeOtf, samples,
      variable: { bytes: varBytes, axes: [
        { tag: 'wght', name: 'Weight', min: 100, default: 400, max: 900 },
        { tag: 'WOBL', name: 'Wobble', min: 0, default: 0, max: 100 },
      ] },
      metrics: { ascender: 800, descender: -200, xHeight: 500, capHeight: 700 },
    });
    expect(html).toContain(`font/ttf;base64,${toBase64(varBytes)}`);
    expect(html).toContain('font-variation-settings');
    expect(html).toContain('data-tag="wght"');
    expect(html).toContain('data-tag="WOBL"');
    expect(html).toContain('id="var"');
    expect(html).toContain('asc 800');
    expect(html).toContain('cap 700');
  });

  it('includes a waterfall and a glyph grid of every character in the samples', () => {
    const html = typeTesterHtml({ name: 'G', otf: fakeOtf, samples: [{ title: 'S', text: 'ab ba\nש' }] });
    for (const px of [14, 18, 24, 36, 48, 72]) expect(html).toContain(`font-size:${px}px`);
    expect(html).toContain('<span>a</span><small>U+0061</small>');
    expect(html).toContain('<span>b</span><small>U+0062</small>');
    expect(html).toContain('<span>ש</span><small>U+05E9</small>');
    expect(html.match(/<span>a<\/span>/g)).toHaveLength(1); // deduped
  });

  it('stays small before the font data and accepts an ArrayBuffer', () => {
    const buf = new ArrayBuffer(4096);
    const html = typeTesterHtml({ name: 'Size', otf: buf, samples });
    const stripped = html.replace(/base64,[A-Za-z0-9+/=]+/g, 'base64,');
    expect(stripped.length).toBeLessThan(12 * 1024);
    expect(html).toContain(toBase64(new Uint8Array(buf)));
  });

  it('base64 helper round-trips bytes 0..255 and odd lengths', () => {
    const all = new Uint8Array(256).map((_, i) => i);
    for (const n of [0, 1, 2, 3, 4, 5, 255, 256]) {
      const bytes = all.subarray(0, n);
      const b64 = toBase64(bytes);
      expect(b64).toBe(Buffer.from(bytes).toString('base64'));
      expect(new Uint8Array(Buffer.from(b64, 'base64'))).toEqual(bytes);
    }
  });
});
