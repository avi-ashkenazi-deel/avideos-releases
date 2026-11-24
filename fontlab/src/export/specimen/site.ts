/**
 * Self-contained specimen *site*: one bright, roomy HTML page (hero, about,
 * variable axes, OpenType features, type tester, glyph inspector, download)
 * with the fonts embedded once as base64 data URIs, inline CSS + vanilla JS
 * and no external requests. Pure string building so it runs in Node too.
 */
import { toBase64, escapeHtml } from './html';

export interface SpecimenSiteAxis { tag: string; name: string; min: number; default: number; max: number }

export interface SpecimenSiteOptions {
  name: string;
  otf: Uint8Array | ArrayBuffer;
  variable?: { bytes: Uint8Array; axes: SpecimenSiteAxis[] };
  /** font units; `upm` defaults to 1000 */
  metrics: { ascender: number; descender: number; xHeight: number; capHeight: number; upm?: number };
  /** every character that has a glyph in the font, in display order */
  chars: string[];
  /** samples per enabled script: [{title, text, rtl?}] */
  samples: { title: string; text: string; rtl?: boolean }[];
  /** OpenType features present in the OTF: e.g. ['ss01','ss02','tnum','liga'] */
  features?: string[];
  /** chars that have stylistic alternates, per set: { ss01: 'ag', ss02: 'a' } */
  alternateChars?: Record<string, string>;
  previewText?: string;
  /** review notes pinned to letters (font units); shown as pins in the glyph inspector and as a list */
  notes?: { ch: string; x: number; y: number; text: string; done?: boolean; author?: string }[];
}

/** Bright word colours, cycled through the hero, axes and features. */
export const SITE_PALETTE = ['#ff3b3b', '#00c2a8', '#0a84ff', '#ff8a1f', '#8e44ec', '#34c759', '#ff2d92', '#a2845e', '#00b8d9'];

export const SITE_GREETINGS = ['Hello', 'Hola', 'Ciao', 'Hallo', 'Olá', 'Hei', 'Aloha', 'Salut', 'Moi', 'Tere', 'Salve', 'Halo', 'Servus',
  'Hoi', 'Szia', 'Merhaba', 'Hallo', 'Ahoj', 'Bok', 'Bonjour', 'Hej', 'Привет', 'Здравствуйте', 'שלום'];

const SYMBOLS = [...'★♥✓→⌘⇧'];
const PANGRAM = 'The quick brown fox jumps over the lazy dog';
const NUMBERS = '0123456789 $1,234.56 +3.2%';
/** words used to show off stylistic alternates */
const ALT_WORDS = ['aggregate', 'baggage', 'gallery', 'garage', 'magazine', 'luggage', 'banana', 'jumps', 'quick', 'yearly', 'Hamburgefonstiv',
  'eager', 'tiger', 'glory', 'dragon', 'apple', 'kayak', 'river', 'wavy', 'fizz', 'jazz', 'study', 'every', 'ready', 'quality', 'gallop'];

const FEATURE_LABELS: Record<string, string> = {
  tnum: 'Tabular figures', liga: 'Arrows', kern: 'Kerning', calt: 'Contextual alternates', salt: 'Stylistic alternates',
  onum: 'Oldstyle figures', lnum: 'Lining figures', pnum: 'Proportional figures', frac: 'Fractions', zero: 'Slashed zero',
  smcp: 'Small capitals', case: 'Case-sensitive forms', dlig: 'Discretionary ligatures', sups: 'Superscript', subs: 'Subscript',
};

const bytesOf = (b: Uint8Array | ArrayBuffer): Uint8Array => (b instanceof Uint8Array ? b : new Uint8Array(b));
const num = (v: number) => (Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : '0');
const validTag = (t: string) => /^[A-Za-z0-9 ]{4}$/.test(t);
const axisTag = (t: string) => t.replace(/[^A-Za-z0-9 ]/g, '').slice(0, 4).padEnd(4, ' ');
const color = (i: number) => SITE_PALETTE[((i % SITE_PALETTE.length) + SITE_PALETTE.length) % SITE_PALETTE.length];
/** Greetings (deduplicated) whose every character is in `chars`, case-sensitive. */
export function heroWords(chars: string[]): string[] {
  const set = new Set(chars);
  return [...new Set(SITE_GREETINGS)].filter((w) => [...w].every((c) => set.has(c)));
}

function altSample(alt: string, set: Set<string>): string {
  const want = [...new Set([...alt])];
  let best = '', score = 0;
  for (const w of ALT_WORDS) {
    if (![...w].every((c) => set.has(c))) continue;
    const s = want.reduce((n, c) => n + (w.includes(c) ? 1 : 0), 0) * 100 - w.length;
    if (want.some((c) => w.includes(c)) && s > score) { best = w; score = s; }
  }
  return best || want.join(' ');
}

const CSS = (upm: number, m: SpecimenSiteOptions['metrics']) => {
  const a = m.ascender / upm, d = Math.min(0, m.descender) / upm;
  const pad = 0.16;
  return `
:root,[data-theme=light]{--bg:#fff;--fg:#0b0b0c;--mute:#76767c;--line:#e7e7e4;--soft:#f6f6f3;--inv:#0b0b0c;--invfg:#fff;--card:#0b0b0c}
[data-theme=dark]{--bg:#0e0e0f;--fg:#f3f3f1;--mute:#9b9ba1;--line:#2a2a2c;--soft:#171718;--inv:#f3f3f1;--invfg:#0b0b0c;--card:#1b1b1d}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0e0e0f;--fg:#f3f3f1;--mute:#9b9ba1;--line:#2a2a2c;--soft:#171718;--inv:#f3f3f1;--invfg:#0b0b0c;--card:#1b1b1d}}
*{box-sizing:border-box}
html{scroll-behavior:smooth;-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow-x:hidden}
.f{font-family:FLStatic,system-ui}.v{font-family:FLVar,FLStatic,system-ui}
.w{max-width:1240px;margin:0 auto;padding:0 40px}
.top{position:fixed;inset:0 0 auto;z-index:10;background:color-mix(in srgb,var(--bg) 86%,transparent);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);border-bottom:1px solid var(--line)}
.top .w{display:flex;align-items:center;gap:20px;height:64px}
.top b{flex:1;font-weight:650;font-size:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.top nav{display:flex;gap:20px;margin-left:auto;font-size:14px}
.top nav a{color:var(--mute);text-decoration:none}.top nav a:hover{color:var(--fg)}
.btn{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--inv);border-radius:999px;background:var(--inv);color:var(--invfg);font:600 14px/1 system-ui,sans-serif;padding:12px 18px;text-decoration:none;cursor:pointer;white-space:nowrap}
.btn.gh{background:transparent;color:var(--fg);border-color:var(--line)}
.btn.rd{padding:0;width:40px;height:40px;justify-content:center}.rd svg{width:18px;height:18px;fill:currentColor}
.btn:hover{opacity:.85}
:is(button,a,input,[contenteditable]):focus-visible{outline:2px solid #0a84ff;outline-offset:3px}
section{padding:110px 0;scroll-margin-top:64px}
section+section{border-top:1px solid var(--line)}
.pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:6px 14px;font-size:13px;font-weight:550;margin:0 0 40px}
.tag{display:inline-block;background:var(--inv);color:var(--invfg);border-radius:999px;font:700 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;padding:7px 11px;letter-spacing:.06em}
#hero{padding-top:150px}
.hero{font-size:clamp(54px,8.6vw,136px);line-height:1.06;display:flex;flex-wrap:wrap;align-items:baseline;gap:.02em .26em;overflow-wrap:anywhere}
.hero .sy{font-size:.62em;color:var(--fg)}
.hero+p{margin:48px 0 0;color:var(--mute);font-size:18px;max-width:560px}
.big{font-size:clamp(60px,12vw,200px);line-height:.95;margin:0 0 56px;font-weight:400;overflow-wrap:anywhere}
.facts{border:1px solid var(--line);border-radius:24px;overflow:hidden}
.facts>div{display:flex;flex-wrap:wrap;margin:0 -1px -1px 0}
.facts>div>div{flex:1 1 180px;padding:24px 26px;border:solid var(--line);border-width:0 1px 1px 0}
.facts>div>.wd{flex-basis:360px}
.facts small{display:block;color:var(--mute);font-size:13px;margin-bottom:4px}
.facts strong{font-size:24px;font-weight:600;letter-spacing:-.01em;overflow-wrap:anywhere}
.row{display:grid;align-items:center;gap:28px;padding:30px 0;border-top:1px solid var(--line)}
.row:last-child{border-bottom:1px solid var(--line)}
.ax{grid-template-columns:200px minmax(0,1fr) 300px}
.lab{display:flex;flex-direction:column;align-items:flex-start;gap:10px;font-weight:550}
.word{font-size:clamp(52px,8vw,124px);line-height:1.12;white-space:nowrap;overflow:hidden;min-width:0}
.rule{display:flex;align-items:center;gap:14px}
.rule output{font:600 15px/1 system-ui,sans-serif;min-width:3.6em;text-align:right;font-variant-numeric:tabular-nums}
input.rl{-webkit-appearance:none;appearance:none;flex:1;min-width:0;height:40px;margin:0;cursor:ew-resize;background:repeating-linear-gradient(90deg,var(--fg) 0 1px,transparent 1px 50px) left center/100% 22px no-repeat,repeating-linear-gradient(90deg,var(--mute) 0 1px,transparent 1px 10px) left center/100% 10px no-repeat}
input.rl::-webkit-slider-runnable-track{height:40px;background:transparent}
input.rl::-moz-range-track{height:40px;background:transparent}
input.rl::-webkit-slider-thumb{-webkit-appearance:none;width:6px;height:40px;border-radius:3px;background:var(--c,#ff3b3b);border:0}
input.rl::-moz-range-thumb{width:6px;height:40px;border-radius:3px;background:var(--c,#ff3b3b);border:0}
.fx{grid-template-columns:90px 220px minmax(0,1fr)}
.fx .lab{flex-direction:row;color:var(--mute);font-weight:500}
.smp{font-size:clamp(40px,6.4vw,92px);line-height:1.12;cursor:pointer;-webkit-user-select:none;user-select:none;transition:color .2s;overflow-wrap:anywhere;margin:0;background:none;border:0;padding:0;color:var(--fg);text-align:left}
.smp:hover,.smp.on{font-feature-settings:var(--ff);color:var(--c)}
.hint{color:var(--mute);font-size:14px;margin:-24px 0 32px}
.tabs{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 18px}
.tab{border:1px solid var(--line);background:transparent;color:var(--fg);border-radius:999px;padding:9px 16px;font:500 14px/1 system-ui,sans-serif;cursor:pointer}
.tab[aria-selected=true]{background:var(--inv);color:var(--invfg);border-color:var(--inv)}
.tbox{background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:28px;overflow:hidden;--ts:96px;--tl:1.15;--tls:0em;--tv:normal}
.tctl{display:flex;flex-wrap:wrap;gap:12px 26px;align-items:center;padding:16px 26px;border-bottom:1px solid var(--line);background:var(--soft)}
.tctl label{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--mute)}
.tctl input{width:110px;accent-color:var(--fg)}
.tctl output{min-width:3.4em;color:var(--fg);font-variant-numeric:tabular-nums}
.tctl .btn{margin-left:auto;padding:9px 14px}
.ta{padding:36px 26px 44px;min-height:300px;font-size:var(--ts);line-height:var(--tl);letter-spacing:var(--tls);font-variation-settings:var(--tv);outline:0;white-space:pre-wrap;overflow-wrap:anywhere}
.gl{display:grid;grid-template-columns:minmax(320px,460px) minmax(0,1fr);gap:32px;align-items:start}
.insp{position:sticky;top:88px;border:1px solid var(--line);border-radius:28px;padding:22px;background:var(--soft)}
.stage{position:relative;font-size:var(--gs,230px);height:${num(a - d + pad * 2)}em;overflow:hidden}
.gch{position:absolute;left:0;right:0;top:0;text-align:center;line-height:1;white-space:nowrap}
.gch i{display:inline-block;width:0;height:0}
.ml{position:absolute;left:0;right:0;height:0;border-top:1px dashed var(--mute)}
.ml span{position:absolute;bottom:3px;left:0;right:0;display:flex;justify-content:space-between;align-items:center;font:500 11px/1 system-ui,sans-serif;color:var(--mute)}
.ml em{font-style:normal;background:var(--bg);border:1px solid var(--line);border-radius:999px;padding:3px 7px;color:var(--fg)}
.ml.b{border-top:1px solid var(--fg)}
.pin{position:absolute;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:#ff2d92;color:#fff;font:700 11px/18px system-ui,sans-serif;text-align:center;z-index:2;cursor:help}.pin.dn{background:var(--mute)}
.nl{margin:12px 0 0;padding-left:20px;font-size:14px}.nl .dn,.rn .dn{opacity:.5;text-decoration:line-through}
.rn{list-style:none;padding:0;margin:24px 0 0;display:grid;gap:10px}.rn li{display:flex;gap:14px;align-items:center}.rn .nb{flex:none;width:56px;height:56px;font-size:28px;border:1px solid var(--line);border-radius:14px;background:var(--bg);color:var(--fg);cursor:pointer}
.gi{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:16px;padding-top:16px;border-top:1px solid var(--line);font-size:14px}
.gi code{font:600 14px ui-monospace,SFMono-Regular,Menlo,monospace}
.gi span{color:var(--mute);text-align:right}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(66px,1fr));gap:8px}
.gc{font-family:FLStatic,system-ui;aspect-ratio:1;min-width:0;border:1px solid var(--line);border-radius:16px;background:var(--bg);color:var(--fg);font-size:30px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0}
.gc:hover{border-color:var(--fg)}
.gc.on{background:var(--inv);color:var(--invfg);border-color:var(--inv)}
.dl{background:var(--card);color:#fff;border-radius:36px;padding:clamp(32px,7vw,96px);border:1px solid var(--line)}
.dl .pill{border-color:#3a3a3d;color:#fff}
.dl h2{font-size:clamp(52px,9vw,140px);line-height:1;margin:0 0 20px;font-weight:400;overflow-wrap:anywhere}
.dl p{color:#a5a5ab;margin:0 0 36px;max-width:520px}
.dl .btns{display:flex;flex-wrap:wrap;gap:12px}
.dl .btn{background:#fff;color:#0b0b0c;border-color:#fff;padding:16px 22px;font-size:15px}
.dl .btn.gh{background:transparent;color:#fff;border-color:#4a4a4e}
footer .w{display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px;padding-top:32px;padding-bottom:48px;color:var(--mute);font-size:14px}
@media (max-width:1000px){.top nav{display:none}.ax{grid-template-columns:150px minmax(0,1fr)}.ax .rule{grid-column:1/-1}.fx{grid-template-columns:80px minmax(0,1fr)}.fx .smp{grid-column:1/-1}}
@media (max-width:800px){.gl{grid-template-columns:minmax(0,1fr)}.insp{position:static}}
@media (max-width:640px){.w{padding:0 16px}section{padding:72px 0}#hero{padding-top:110px}.top .w{gap:10px}.top b{font-size:15px}.top .btn{padding:10px 14px}
.ax{grid-template-columns:minmax(0,1fr);gap:14px;padding:24px 0}.lab{flex-direction:row;align-items:center}.pill{margin-bottom:28px}
.tctl{padding:14px 16px;gap:10px 18px}.tctl input{width:90px}.ta{padding:24px 16px 32px;min-height:220px}.stage{--gs:160px}.grid{grid-template-columns:repeat(auto-fill,minmax(48px,1fr));gap:6px}.gc{font-size:24px;border-radius:12px}.facts>div>div{padding:18px 20px;flex-basis:140px}.facts>div>.wd{flex-basis:100%}.facts strong{font-size:20px}.dl{border-radius:28px}}
`;
};

/** Build the specimen site page. */
export function specimenSiteHtml(o: SpecimenSiteOptions): string {
  const rawName = o.name || 'Untitled';
  const name = escapeHtml(rawName);
  const file = escapeHtml(rawName.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '').trim() || 'font');
  const upm = o.metrics.upm && o.metrics.upm > 0 ? o.metrics.upm : 1000;
  const m = o.metrics;
  const chars = o.chars;
  const set = new Set(chars);
  const hasVar = !!o.variable && o.variable.bytes.length > 0;
  const axes = hasVar ? o.variable!.axes : [];
  const fam = hasVar ? 'v' : 'f';
  const samples = o.samples;
  const preview = (o.previewText || samples[0]?.text || PANGRAM).replace(/\s+/g, ' ').trim() || PANGRAM;

  // ---- 1. hero
  let words = heroWords(chars);
  if (!words.length) {
    const solid = chars.filter((c) => !/\s/u.test(c));
    words = [];
    for (let i = 0; i < solid.length && words.length < 12; i += 4) words.push(solid.slice(i, i + 4).join(''));
    if (!words.length) words = [rawName];
  }
  const syms = SYMBOLS.filter((c) => set.has(c));
  const ax0 = axes[0];
  const heroHtml = words.map((w, i) => {
    let st = `color:${color(i)}`;
    if (ax0) {
      const v = words.length > 1 ? ax0.min + ((ax0.max - ax0.min) * i) / (words.length - 1) : ax0.default;
      st += `;font-variation-settings:'${axisTag(ax0.tag)}' ${num(v)}`;
    }
    const sym = syms.length && i < words.length - 1 ? `<span class="sy">${escapeHtml(syms[i % syms.length])}</span>` : '';
    return `<span style="${st}"${/[֐-׿]/.test(w) ? ' dir="rtl"' : ''}>${escapeHtml(w)}</span>${sym}`;
  }).join('');

  // ---- 2. about
  const scripts = samples.map((s) => s.title).filter(Boolean);
  const fact = (k: string, v: string, wide = false) => `<div${wide ? ' class="wd"' : ''}><small>${k}</small><strong>${v}</strong></div>`;
  const facts = [
    fact('Glyphs', String(chars.length)),
    fact('Scripts', scripts.length ? scripts.map(escapeHtml).join(', ') : '—', scripts.length > 2),
    fact('Ascender', num(m.ascender)),
    fact('Cap height', num(m.capHeight)),
    fact('x-height', num(m.xHeight)),
    fact('Descender', num(m.descender)),
    ...(hasVar && axes.length ? [fact('Variable axes', axes.map((a) => escapeHtml(a.name || a.tag)).join(', '), axes.length > 2)] : []),
    fact('Made with', 'FontLab'),
  ].join('');

  // ---- 3. axes
  const axisWord = (a: SpecimenSiteAxis) => (a.tag === 'wght' ? 'Heavier' : a.tag === 'slnt' ? 'Slanted' : a.name || a.tag);
  const step = (a: SpecimenSiteAxis) => (a.max - a.min > 20 ? 1 : 0.1);
  const axesHtml = hasVar && axes.length ? `<section id="axes"><div class="w"><span class="pill">Variable axes</span>${axes.map((a, i) => {
    const tag = axisTag(a.tag);
    return `<div class="row ax" style="--c:${color(i + 2)}"><div class="lab"><span class="tag">${escapeHtml(tag.trim())}</span>${escapeHtml(a.name || a.tag)}</div><div class="word v" style="color:${color(i + 2)};font-variation-settings:'${tag}' ${num(a.default)}">${escapeHtml(axisWord(a))}</div><div class="rule"><input type="range" class="rl" data-tag="${escapeHtml(tag)}" min="${num(a.min)}" max="${num(a.max)}" step="${step(a)}" value="${num(a.default)}" aria-label="${escapeHtml(a.name || a.tag)}"><output>${num(a.default)}</output></div></div>`;
  }).join('')}</div></section>` : '';

  // ---- 4. features
  const alts = o.alternateChars ?? {};
  const featTags = [...new Set([...(o.features ?? []), ...Object.keys(alts)])].filter(validTag);
  const featRows = featTags.map((t, i) => {
    let label = FEATURE_LABELS[t] ?? t;
    let sample: string;
    const ss = /^ss(\d\d)$/.exec(t);
    if (ss) {
      label = `Stylistic set ${parseInt(ss[1], 10)}`;
      sample = escapeHtml(altSample(alts[t] || '', set) || preview.split(' ')[0]);
    } else if (t === 'tnum') sample = '1,248.31<br>9,999.00';
    else if (t === 'liga') sample = escapeHtml('-> => <- <->');
    else sample = escapeHtml(preview.split(' ').slice(0, 3).join(' '));
    return `<div class="row fx"><div class="lab"><span class="tag">${escapeHtml(t.toUpperCase())}</span></div><div class="lab">${escapeHtml(label)}</div><button type="button" class="smp f" aria-pressed="false" style="--ff:'${t}' 1;--c:${color(i)}">${sample}</button></div>`;
  });
  const featHtml = featRows.length
    ? `<section id="features"><div class="w"><span class="pill">OpenType features</span><p class="hint">Hover or tap a sample to switch the feature on.</p>${featRows.join('')}</div></section>` : '';

  // ---- 5. tester
  const headline = preview.length > 42 ? preview.slice(0, 42).replace(/\s+\S*$/, '') : preview;
  const tabs: { t: string; x: string; s: number; rtl?: boolean }[] = [
    { t: 'Headline', x: headline, s: 120 },
    { t: 'Pangram', x: PANGRAM, s: 72 },
    { t: 'Numbers', x: NUMBERS, s: 88 },
    { t: 'Body', x: Array(5).fill(preview).join(' '), s: 24 },
    ...samples.map((s) => ({ t: s.title, x: s.text, s: 56, rtl: s.rtl })),
  ];
  const tabBtns = tabs.map((t, i) => `<button type="button" class="tab" role="tab" aria-selected="${i === 0}" data-s="${t.s}">${escapeHtml(t.t)}</button>`).join('');
  const panels = tabs.map((t, i) => `<div class="ta ${fam}" role="tabpanel" contenteditable="true" spellcheck="false" aria-label="${escapeHtml(t.t)}"${t.rtl ? ' dir="rtl"' : ''}${i ? ' hidden' : ''}>${escapeHtml(t.x)}</div>`).join('');
  const rng = (label: string, v: string, min: number, max: number, st: number, val: number, u = '') =>
    `<label>${label}<input type="range" data-v="${v}" data-u="${u}" min="${min}" max="${max}" step="${st}" value="${val}" aria-label="${label}"><output>${val}${u}</output></label>`;
  const testerAxes = axes.map((a) => {
    const tag = axisTag(a.tag);
    return `<label>${escapeHtml(a.name || a.tag)}<input type="range" class="tx" data-tag="${escapeHtml(tag)}" min="${num(a.min)}" max="${num(a.max)}" step="${step(a)}" value="${num(a.default)}" aria-label="${escapeHtml(a.name || a.tag)}"><output>${num(a.default)}</output></label>`;
  }).join('');

  // ---- 6. glyphs
  const lines: [string, number, string][] = [
    ['Ascender', m.ascender, ''], ['Cap height', m.capHeight, ''], ['x-height', m.xHeight, ''], ['Baseline', 0, ' b'], ['Descender', m.descender, ''],
  ];
  const baseEm = 0.16 - Math.min(0, m.descender) / upm;
  const mlines = lines.map(([l, v, c]) =>
    `<div class="ml${c}"${c ? ' id="gbl"' : ''} style="bottom:${num(baseEm + v / upm)}em"><span>${l}<em>${num(v)}</em></span></div>`).join('');
  const sel = set.has('g') ? 'g' : chars.find((c) => !/\s/u.test(c)) ?? chars[0] ?? '';
  const cells = chars.map((c) => `<button class="gc${c === sel ? ' on' : ''}">${escapeHtml(c)}</button>`).join('');

  // ---- fonts (embedded exactly once; JS reads the base64 back for downloads)
  const fonts = `@font-face{font-family:"FLStatic";src:url(data:font/otf;base64,${toBase64(bytesOf(o.otf))}) format("opentype");font-display:block}`
    + (hasVar ? `\n@font-face{font-family:"FLVar";src:url(data:font/ttf;base64,${toBase64(o.variable!.bytes)}) format("truetype");font-display:block}` : '');

  const charSet = new Set(chars);
  const notes = (o.notes ?? []).filter((n) => charSet.has(n.ch) && typeof n.text === 'string').slice(0, 300);
  const notesJson = JSON.stringify(notes.map((n) => ({ ch: n.ch, x: Math.round(n.x), y: Math.round(n.y), text: n.text, done: !!n.done, author: n.author || '' }))).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, '');
  const notesHtml = notes.length
    ? `<section id="notes"><div class="w"><span class="pill">Review notes</span><ul class="rn">${notes.map((n) => `<li${n.done ? ' class="dn"' : ''}><button type="button" class="nb f">${escapeHtml(n.ch)}</button><span>${escapeHtml(n.text)}${n.author ? ` <i>— ${escapeHtml(n.author)}</i>` : ''}</span></li>`).join('')}</ul></div></section>`
    : '';
  const script = `
(function(){
var R=document.documentElement,D=document,q=function(s,e){return(e||D).querySelector(s)},qa=function(s,e){return[].slice.call((e||D).querySelectorAll(s))};
function dark(){var t=R.getAttribute('data-theme');return t?t==='dark':!!(window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches)}
q('#theme').onclick=function(){R.setAttribute('data-theme',dark()?'light':'dark')};
qa('.ax').forEach(function(r){var i=q('input',r),w=q('.word',r),o=q('output',r);function u(){w.style.fontVariationSettings='"'+i.dataset.tag+'" '+i.value;o.textContent=i.value}i.oninput=u;i.ondblclick=function(){i.value=i.defaultValue;u()};u()});
qa('.smp').forEach(function(s){s.onclick=function(){var on=s.classList.toggle('on');s.setAttribute('aria-pressed',on)}});
var T=q('#tbox'),sz=q('[data-v="--ts"]',T);
qa('input[data-v]',T).forEach(function(i){var o=i.nextElementSibling,u=i.dataset.u;i.oninput=function(){T.style.setProperty(i.dataset.v,i.value+u);o.textContent=i.value+u};i.oninput()});
var tx=qa('input.tx',T);function fv(){T.style.setProperty('--tv',tx.map(function(a){a.nextElementSibling.textContent=a.value;return'"'+a.dataset.tag+'" '+a.value}).join(',')||'normal')}
tx.forEach(function(a){a.oninput=fv});fv();
var tb=qa('.tab'),tp=qa('.ta');tb.forEach(function(b,i){b.onclick=function(){tb.forEach(function(x,j){x.setAttribute('aria-selected',i===j)});tp.forEach(function(p,j){p.hidden=i!==j});fit(b.dataset.s)}});
function fit(v){sz.value=Math.round(Math.min(+v,Math.max(24,innerWidth/5.5)));sz.oninput()}fit(tb[0].dataset.s);
q('#tdark').onclick=function(){var c=T.getAttribute('data-theme')||(dark()?'dark':'light');T.setAttribute('data-theme',c==='dark'?'light':'dark')};
var st=q('.stage'),gc=q('#gch'),gk=q('#gck'),mk=q('i',gc),bl=q('#gbl');
var DG=['zero','one','two','three','four','five','six','seven','eight','nine'],NM={' ':'Space','.':'Full stop',',':'Comma','!':'Exclamation mark','?':'Question mark','-':'Hyphen-minus','&':'Ampersand','@':'Commercial at','#':'Number sign','$':'Dollar sign','%':'Percent sign','(':'Left parenthesis',')':'Right parenthesis',':':'Colon',';':'Semicolon','/':'Solidus','+':'Plus sign','=':'Equals sign','"':'Quotation mark',"'":'Apostrophe','*':'Asterisk','_':'Low line'};
function nm(c){if(/^[A-Z]$/.test(c))return'Latin capital letter '+c;if(/^[a-z]$/.test(c))return'Latin small letter '+c.toUpperCase();if(/^[0-9]$/.test(c))return'Digit '+DG[+c];return NM[c]||''}
function place(){var s=st.getBoundingClientRect(),cur=mk.getBoundingClientRect().top-s.top,want=bl.getBoundingClientRect().top-s.top;gc.style.top=(parseFloat(gc.style.top)||0)+want-cur+'px'}
var N=${notesJson},CUR='';
function pins(){qa('.pin',st).forEach(function(x){x.remove()});var l=q('#gnl');if(!l)return;l.innerHTML='';var fs=parseFloat(getComputedStyle(st).fontSize),s=st.getBoundingClientRect(),g=gk.getBoundingClientRect(),by=bl.getBoundingClientRect().top-s.top,k=0;N.forEach(function(n){if(n.ch!==CUR)return;k++;var p=D.createElement('b');p.className='pin'+(n.done?' dn':'');p.textContent=k;p.title=n.text;p.style.left=(g.left-s.left+n.x/${upm}*fs)+'px';p.style.top=(by-n.y/${upm}*fs)+'px';st.appendChild(p);var li=D.createElement('li');li.textContent=n.text+(n.author?' — '+n.author:'');if(n.done)li.className='dn';l.appendChild(li)})}
function pick(b){qa('.gc.on').forEach(function(x){x.classList.remove('on')});b.classList.add('on');var c=b.textContent;CUR=c;gk.textContent=c;q('#gcu').textContent='U+'+c.codePointAt(0).toString(16).toUpperCase().padStart(4,'0');q('#gcn').textContent=nm(c);place();pins()}
qa('.nb').forEach(function(b){b.onclick=function(){var t=qa('.grid .gc').filter(function(x){return x.textContent===b.textContent})[0];if(t){pick(t);q('#glyphs').scrollIntoView({behavior:'smooth'})}}});
q('.grid').onclick=function(e){var b=e.target.closest('.gc');if(b)pick(b)};
var s0=q('.gc.on');if(s0)pick(s0);addEventListener('resize',function(){place();pins()});if(D.fonts)D.fonts.ready.then(function(){place();pins()});
var FS=q('#fonts').textContent;
qa('[data-dl]').forEach(function(b){b.onclick=function(){var m=FS.match(new RegExp('"'+b.dataset.dl+'";src:url\\\\(data:([^;]+);base64,([^)]+)'));if(!m)return;var s=atob(m[2]),a=new Uint8Array(s.length);for(var i=0;i<s.length;i++)a[i]=s.charCodeAt(i);
var u=URL.createObjectURL(new Blob([a],{type:m[1]})),l=D.createElement('a');l.href=u;l.download=b.dataset.file;D.body.appendChild(l);l.click();l.remove();setTimeout(function(){URL.revokeObjectURL(u)},4000)}});
})();`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name} — specimen</title>
<style id="fonts">${fonts}</style>
<style>${CSS(upm, m)}</style>
</head>
<body>
<header class="top"><div class="w"><b>${name}</b><nav aria-label="Sections"><a href="#about">About</a>${axesHtml ? '<a href="#axes">Axes</a>' : ''}${featHtml ? '<a href="#features">Features</a>' : ''}<a href="#tester">Tester</a><a href="#glyphs">Glyphs</a></nav><button type="button" class="btn gh rd" id="theme" aria-label="Toggle dark mode"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 1.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zm0 1.8v13.4a6.7 6.7 0 0 1 0-13.4z"/></svg></button><a class="btn" href="#download">Get the font ↓</a></div></header>
<main>
<section id="hero"><div class="w"><div class="hero ${fam}">${heroHtml}</div><p>${name} — ${chars.length} glyphs${scripts.length ? ` across ${scripts.map(escapeHtml).join(', ')}` : ''}${hasVar ? `, ${axes.length} variable ax${axes.length === 1 ? 'is' : 'es'}` : ''}.</p></div></section>
<section id="about"><div class="w"><span class="pill">About</span><h2 class="big f">${name}</h2><div class="facts"><div>${facts}</div></div></div></section>
${axesHtml}
${featHtml}
<section id="tester"><div class="w"><span class="pill">Type tester</span><div class="tabs" role="tablist">${tabBtns}</div><div class="tbox" id="tbox" style="--tf:${hasVar ? 'FLVar' : 'FLStatic'}"><div class="tctl" role="group" aria-label="Tester controls">${rng('Size', '--ts', 12, 200, 1, 96, 'px')}${rng('Line height', '--tl', 0.8, 2, 0.05, 1.15)}${rng('Letter spacing', '--tls', -0.1, 0.4, 0.01, 0, 'em')}${testerAxes}<button type="button" class="btn gh" id="tdark">Dark / light</button></div>${panels}</div></div></section>
<section id="glyphs"><div class="w"><span class="pill">Glyphs</span><div class="gl"><div class="insp" aria-live="polite"><div class="stage f">${mlines}<div class="gch" id="gch"><span id="gck">${escapeHtml(sel)}</span><i></i></div></div><div class="gi"><code id="gcu"></code><span id="gcn"></span></div>${notes.length ? '<ol class="nl" id="gnl"></ol>' : ''}</div><div class="grid">${cells}</div></div></div></section>
${notesHtml}
<section id="download"><div class="w"><div class="dl"><span class="pill">Download</span><h2 class="f">${name}</h2><p>Install it, then set something big.</p><div class="btns"><button type="button" class="btn" data-dl="FLStatic" data-file="${file}.otf">Download ${name}.otf ↓</button>${hasVar ? `<button type="button" class="btn gh" data-dl="FLVar" data-file="${file}-Variable.ttf">Variable ${name}.ttf ↓</button>` : ''}</div></div></div></section>
</main>
<footer><div class="w"><span>Made with FontLab</span><span>${name}</span></div></footer>
<script>${script}</script>
</body>
</html>
`;
}
