import { describe, it, expect } from 'vitest';
import { specimenSiteHtml, heroWords, type SpecimenSiteOptions } from '../../src/export/specimen/site';
import { toBase64 } from '../../src/export/specimen/html';

const fakeOtf = new Uint8Array([0, 1, 0, 0, 1, 2, 3]);
const latin = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'];
const metrics = { ascender: 800, descender: -200, xHeight: 500, capHeight: 700 };
const base = (over: Partial<SpecimenSiteOptions> = {}): SpecimenSiteOptions => ({
  name: 'Funk',
  otf: fakeOtf,
  metrics,
  chars: latin,
  samples: [{ title: 'Latin', text: 'The quick brown fox jumps over the lazy dog' }],
  ...over,
});
const stripFonts = (html: string) => html.replace(/base64,[A-Za-z0-9+/=]+/g, 'base64,');
const count = (h: string, s: string) => h.split(s).length - 1;
const section = (h: string, id: string) => {
  const i = h.indexOf(`<section id="${id}"`);
  return i < 0 ? '' : h.slice(i, h.indexOf('</section>', i));
};

describe('specimenSiteHtml', () => {
  it('builds one self-contained page with the static font embedded once', () => {
    const html = specimenSiteHtml(base());
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('@font-face');
    expect(count(html, 'data:font/otf;base64,')).toBe(1);
    expect(count(html, toBase64(fakeOtf))).toBe(1);
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toMatch(/<link/i);
    expect(html).not.toMatch(/<script\s+src/i);
    expect(html).not.toContain('@import');
    expect(html).not.toContain('font/ttf;base64');
    expect(html).toContain('href="#download"');
    expect(html).toContain('Get the font');
    expect(html).toContain('Made with FontLab');
    expect(html).toMatch(/data-theme/);
  });

  it('hero shows only greetings the font can render', () => {
    const html = specimenSiteHtml(base());
    const hero = section(html, 'hero');
    expect(hero).toContain('Hello');
    expect(hero).not.toContain('Привет');
    expect(hero).not.toContain('שלום');
    expect(hero).not.toContain('Olá'); // no á in the set
    expect(heroWords([...'Helo'])).toEqual(['Hello']);
    expect(heroWords([...'hello'])).toEqual([]); // case-sensitive
    const cyr = heroWords([...latin, ...'Привет']);
    expect(cyr).toContain('Привет');
    expect(cyr.filter((w) => w === 'Hallo')).toHaveLength(1);
  });

  it('interleaves only the UI symbols that are in the font', () => {
    const html = specimenSiteHtml(base({ chars: [...latin, '★', '→'] }));
    const hero = section(html, 'hero');
    expect(hero).toContain('★');
    expect(hero).toContain('→');
    expect(hero).not.toContain('⌘');
    expect(section(specimenSiteHtml(base()), 'hero')).not.toContain('★');
  });

  it('adds #axes only for a variable font', () => {
    expect(specimenSiteHtml(base())).not.toContain('id="axes"');
    const varBytes = new Uint8Array([0, 1, 0, 0, 9, 9, 9]);
    const html = specimenSiteHtml(base({
      variable: { bytes: varBytes, axes: [
        { tag: 'wght', name: 'Weight', min: 100, default: 400, max: 900 },
        { tag: 'slnt', name: 'Slant', min: -12, default: 0, max: 0 },
      ] },
    }));
    const axes = section(html, 'axes');
    expect(axes).toContain('data-tag="wght"');
    expect(axes).toContain('Heavier');
    expect(axes).toContain('Slanted');
    expect(axes).toContain('Variable axes');
    expect(count(html, 'data:font/ttf;base64,')).toBe(1);
    expect(count(html, 'data:font/otf;base64,')).toBe(1);
    // hero words spread over the first axis
    const hero = section(html, 'hero');
    expect(hero).toContain("'wght' 100");
    expect(hero).toContain("'wght' 900");
    // variable download button
    expect(section(html, 'download')).toContain('data-dl="FLVar"');
  });

  it('adds #features only when features or alternates exist', () => {
    expect(specimenSiteHtml(base())).not.toContain('id="features"');
    expect(specimenSiteHtml(base({ features: [], alternateChars: {} }))).not.toContain('id="features"');
    const html = specimenSiteHtml(base({ features: ['ss01', 'tnum', 'liga'], alternateChars: { ss01: 'ag', ss02: 'a' } }));
    const f = section(html, 'features');
    expect(f).toContain('SS01');
    expect(f).toContain('SS02');
    expect(f).toContain('Stylistic set 1');
    expect(f).toContain('Tabular figures');
    expect(f).toContain('1,248.31<br>9,999.00');
    expect(f).toContain('Arrows');
    expect(f).toContain('-&gt; =&gt; &lt;- &lt;-&gt;');
    expect(f).toContain("--ff:'ss01' 1");
    // alternates alone are enough; liga needs the feature
    const alt = section(specimenSiteHtml(base({ alternateChars: { ss03: 'y' } })), 'features');
    expect(alt).toContain('SS03');
    expect(alt).not.toContain('LIGA');
  });

  it('glyph grid contains every char, escaped', () => {
    const chars = [...'Ag<&>"\'', 'Ж'];
    const html = specimenSiteHtml(base({ chars }));
    const g = section(html, 'glyphs');
    for (const c of ['A', 'g', '&lt;', '&amp;', '&gt;', '&quot;', '&#39;', 'Ж']) expect(g).toContain(`>${c}</button>`);
    expect(g).not.toContain('><</button>');
    expect(g).not.toContain('>&</button>');
    expect(count(g, '<button class="gc')).toBe(chars.length);
    expect(g).toContain('class="gc on">g</button>'); // 'g' selected by default
    for (const l of ['Ascender', 'Cap height', 'x-height', 'Baseline', 'Descender']) expect(g).toContain(l);
    const noG = section(specimenSiteHtml(base({ chars: [...'XYZ'] })), 'glyphs');
    expect(noG).toContain('class="gc on">X</button>');
  });

  it('has the tester, download section and footer', () => {
    const html = specimenSiteHtml(base({ previewText: 'Big <type> & more' }));
    const t = section(html, 'tester');
    for (const tab of ['Headline', 'Pangram', 'Numbers', 'Body', 'Latin']) expect(t).toContain(`>${tab}</button>`);
    expect(t).toContain('0123456789 $1,234.56 +3.2%');
    expect(t).toContain('Big &lt;type&gt; &amp; more');
    expect(t).not.toContain('<type>');
    expect(t).toContain('contenteditable="true"');
    expect(t).toContain('min="12" max="200"');
    const d = section(html, 'download');
    expect(d).toContain('Download Funk.otf');
    expect(d).toContain('data-dl="FLStatic"');
    expect(d).not.toContain('data-dl="FLVar"');
  });

  it('gives RTL samples dir="rtl"', () => {
    const html = specimenSiteHtml(base({ samples: [
      { title: 'Latin', text: 'Hello' },
      { title: 'Hebrew', text: 'שלום עולם', rtl: true },
    ] }));
    const t = section(html, 'tester');
    expect(t).toContain('dir="rtl"');
    expect(t).toMatch(/dir="rtl"[^>]*>שלום עולם</);
    expect(count(t, 'dir="rtl"')).toBe(1);
  });

  it('escapes the font name everywhere', () => {
    const html = specimenSiteHtml(base({ name: 'Funk & Sons <Display>' }));
    expect(html).toContain('Funk &amp; Sons &lt;Display&gt;');
    expect(html).not.toContain('Funk & Sons <Display>');
  });

  it('stays under 40 KB without the font payloads', () => {
    const big = new Uint8Array(200_000).map((_, i) => i & 255);
    const chars = [...latin, ...'.,;:!?¡¿\'"‘’“”«»-–—_()[]{}/\\|@#&*+=<>~^%$€£¥¢©®™°±×÷•…§¶†‡µ¬←→↑↓↔⇒⌘⌥⇧⏎⌫✓✗★♥⚠●○■□▲▼',
      ...'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя', ...'אבגדהוזחטיכךלםמןנסעףפץצקרשת'];
    const html = specimenSiteHtml(base({
      otf: big, chars,
      variable: { bytes: big, axes: [{ tag: 'wght', name: 'Weight', min: 100, default: 400, max: 900 }, { tag: 'WOBL', name: 'Wobble', min: 0, default: 0, max: 100 }] },
      features: ['ss01', 'ss02', 'tnum', 'liga'], alternateChars: { ss01: 'ag', ss02: 'y' },
      samples: [{ title: 'Latin', text: 'The quick brown fox' }, { title: 'Cyrillic', text: 'Съешь же ещё' }, { title: 'Hebrew', text: 'דג סקרן', rtl: true }],
    }));
    expect(html.length).toBeGreaterThan(400_000);
    expect(new TextEncoder().encode(stripFonts(html)).length).toBeLessThan(40 * 1024);
  });
});

describe('review notes in the specimen site', () => {
  it('shows a notes section and inspector pins only when there are notes, safely escaped', () => {
    expect(specimenSiteHtml(base())).not.toContain('id="notes"');
    const html = specimenSiteHtml(base({ notes: [
      { ch: 'H', x: 120, y: 340, text: 'Crossbar <too> low & heavy </script>', author: 'Rae' },
      { ch: 'e', x: 10, y: 20, text: 'fine now', done: true },
      { ch: '中', x: 0, y: 0, text: 'letter not in the font' },
    ] }));
    expect(html).toContain('id="notes"');
    expect(html).toContain('id="gnl"');
    expect(html).toContain('Crossbar &lt;too&gt; low &amp; heavy');
    expect(html).not.toContain('letter not in the font');
    // the embedded JSON must not be able to close the script tag
    const script = html.slice(html.lastIndexOf('<script>'));
    expect(script.indexOf('</script>')).toBe(script.lastIndexOf('</script>'));
    expect(script).toContain('"x":120,"y":340');
    expect(html).toContain('class="dn"');
  });
});
