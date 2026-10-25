/**
 * Self-contained HTML type tester: one document, fonts embedded as base64
 * data URIs, inline CSS + vanilla JS, no external requests. Pure string
 * building so it runs in the worker and in Node.
 */

export interface TypeTesterAxis { tag: string; name: string; min: number; default: number; max: number }

export interface TypeTesterOptions {
  name: string;
  otf: Uint8Array | ArrayBuffer;
  variable?: { bytes: Uint8Array; axes: TypeTesterAxis[] };
  samples: { title: string; text: string; rtl?: boolean }[];
  metrics?: { ascender: number; descender: number; xHeight: number; capHeight: number };
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 (with padding) of raw bytes; no btoa / Buffer needed. */
export function toBase64(bytes: Uint8Array): string {
  const out: string[] = [];
  let i = 0;
  const n = bytes.length;
  for (; i + 2 < n; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out.push(B64[v >> 18], B64[(v >> 12) & 63], B64[(v >> 6) & 63], B64[v & 63]);
  }
  if (i < n) {
    const b0 = bytes[i], b1 = i + 1 < n ? bytes[i + 1] : 0;
    const v = (b0 << 16) | (b1 << 8);
    out.push(B64[v >> 18], B64[(v >> 12) & 63], i + 1 < n ? B64[(v >> 6) & 63] : '=', '=');
  }
  return out.join('');
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const bytesOf = (b: Uint8Array | ArrayBuffer): Uint8Array => (b instanceof Uint8Array ? b : new Uint8Array(b));
const safeTag = (t: string) => t.replace(/[^A-Za-z0-9 ]/g, '').slice(0, 4).padEnd(4, ' ');
const num = (v: number) => (Number.isFinite(v) ? String(v) : '0');

const WATERFALL = [14, 18, 24, 36, 48, 72];

/** Build the type-tester page. */
export function typeTesterHtml(o: TypeTesterOptions): string {
  const name = escapeHtml(o.name || 'Untitled');
  const otfB64 = toBase64(bytesOf(o.otf));
  const axes = o.variable?.axes ?? [];
  const hasVar = !!o.variable && o.variable.bytes.length > 0;
  const samples = o.samples.length ? o.samples : [{ title: 'Sample', text: 'The quick brown fox jumps over the lazy dog' }];
  const lineText = samples[0].text.split(/\r?\n/)[0] || 'Hamburgefonstiv';

  const glyphs = [...new Set([...samples.map((s) => s.text).join('')].filter((c) => !/\s/u.test(c)))]
    .sort((a, b) => a.codePointAt(0)! - b.codePointAt(0)!);

  const css = `
:root{--bg:#fafafa;--fg:#141414;--mute:#6b6b6b;--line:#dcdcdc;--card:#fff;--acc:#2f6fed;--fam:"FLStatic";--size:48px;--lh:1.25;--ls:0em;--fvs:normal}
:root[data-theme=dark]{--bg:#121212;--fg:#f0f0f0;--mute:#9a9a9a;--line:#2e2e2e;--card:#1a1a1a;--acc:#7aa2ff}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#121212;--fg:#f0f0f0;--mute:#9a9a9a;--line:#2e2e2e;--card:#1a1a1a;--acc:#7aa2ff}}
@font-face{font-family:"FLStatic";src:url(data:font/otf;base64,${otfB64}) format("opentype");font-display:block}
${hasVar ? `@font-face{font-family:"FLVar";src:url(data:font/ttf;base64,${toBase64(o.variable!.bytes)}) format("truetype");font-display:block}` : ''}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:0 16px 40px}
header{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 16px;padding:20px 0 12px;border-bottom:1px solid var(--line)}
h1{margin:0;font:400 28px/1.1 var(--fam);font-variation-settings:var(--fvs)}
.meta{color:var(--mute);font-size:12px}
.ctl{display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center;padding:12px 0;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:2}
.ctl label{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--mute)}
.ctl input[type=range]{width:120px;accent-color:var(--acc)}
.ctl output{min-width:3.5em;color:var(--fg);font-variant-numeric:tabular-nums}
button,.tg{font:inherit;font-size:12px;padding:5px 10px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg);cursor:pointer}
button[aria-pressed=true]{border-color:var(--acc);color:var(--acc)}
:is(button,input,[contenteditable]):focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.ax{display:none;gap:10px 18px;flex-wrap:wrap}
:root[data-var="1"] .ax{display:flex}
h2{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--mute);margin:28px 0 8px;font-weight:600}
.t{font-family:var(--fam);font-size:var(--size);line-height:var(--lh);letter-spacing:var(--ls);font-variation-settings:var(--fvs)}
.s{padding:14px 16px;border:1px solid var(--line);border-radius:10px;background:var(--card);white-space:pre-wrap;word-break:break-word;min-height:1.2em}
.s:empty::before{content:attr(data-ph);color:var(--mute)}
.wf div{display:flex;align-items:baseline;gap:12px;padding:6px 0;border-bottom:1px dashed var(--line);white-space:nowrap;overflow:hidden}
.wf small{flex:none;width:3em;color:var(--mute);font-size:11px;text-align:right}
.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(64px,1fr));gap:6px}
.g div{border:1px solid var(--line);border-radius:8px;background:var(--card);text-align:center;padding:8px 2px 4px}
.g span{display:block;font-family:var(--fam);font-size:34px;line-height:1.2;font-variation-settings:var(--fvs)}
.g small{color:var(--mute);font-size:10px}
footer{margin-top:40px;color:var(--mute);font-size:12px;border-top:1px solid var(--line);padding-top:12px}
@media (max-width:600px){.ctl input[type=range]{width:90px}h1{font-size:22px}}
`;

  const range = (id: string, label: string, min: number, max: number, step: number, val: number, unit = '') =>
    `<label>${label}<input type="range" id="${id}" min="${num(min)}" max="${num(max)}" step="${num(step)}" value="${num(val)}" aria-label="${label}"><output for="${id}">${num(val)}${unit}</output></label>`;

  const axisCtl = axes.map((a) => {
    const tag = safeTag(a.tag);
    return `<label>${escapeHtml(a.name || a.tag)} <code>${escapeHtml(tag.trim())}</code><input type="range" class="axis" data-tag="${escapeHtml(tag)}" min="${num(a.min)}" max="${num(a.max)}" step="${(a.max - a.min) > 20 ? 1 : 0.1}" value="${num(a.default)}" aria-label="${escapeHtml(a.name || a.tag)}"><output>${num(a.default)}</output></label>`;
  }).join('');

  const sampleBlocks = samples.map((s, i) =>
    `<section><h2>${escapeHtml(s.title)}</h2><div class="t s" contenteditable="true" spellcheck="false" role="textbox" aria-multiline="true" aria-label="${escapeHtml(s.title)}" id="smp${i}"${s.rtl ? ' dir="rtl"' : ''}>${escapeHtml(s.text)}</div></section>`).join('');

  const waterfall = WATERFALL.map((px) =>
    `<div><small>${px}</small><span class="t" style="font-size:${px}px;line-height:1.2">${escapeHtml(lineText)}</span></div>`).join('');

  const grid = glyphs.map((c) =>
    `<div><span>${escapeHtml(c)}</span><small>U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}</small></div>`).join('');

  const metrics = o.metrics
    ? `<span class="meta">asc ${num(o.metrics.ascender)} · desc ${num(o.metrics.descender)} · x ${num(o.metrics.xHeight)} · cap ${num(o.metrics.capHeight)}</span>` : '';

  const js = `
(function(){
var R=document.documentElement,q=function(s){return document.querySelector(s)},qa=function(s){return [].slice.call(document.querySelectorAll(s))};
function bind(id,v,f){var el=q('#'+id),o=el.nextElementSibling;function u(){R.style.setProperty(v,f(el.value));o.textContent=el.value+(f.unit||'')}el.addEventListener('input',u);u()}
var px=function(v){return v+'px'};px.unit='px';
var em=function(v){return v+'em'};em.unit='em';
bind('size','--size',px);bind('lh','--lh',function(v){return v});bind('ls','--ls',em);
var th=q('#theme');function setTheme(d){R.setAttribute('data-theme',d?'dark':'light');th.setAttribute('aria-pressed',d?'true':'false');th.textContent=d?'Light':'Dark'}
th.addEventListener('click',function(){setTheme(R.getAttribute('data-theme')!=='dark')});
setTheme(window.matchMedia&&window.matchMedia('(prefers-color-scheme:dark)').matches);
var vt=q('#var');if(vt){var fvs=function(){var s=qa('.axis').map(function(a){a.nextElementSibling.textContent=a.value;return '"'+a.dataset.tag+'" '+a.value}).join(',');R.style.setProperty('--fvs',s||'normal')};
var setVar=function(on){R.setAttribute('data-var',on?'1':'0');R.style.setProperty('--fam',on?'"FLVar"':'"FLStatic"');vt.setAttribute('aria-pressed',on?'true':'false');if(on)fvs();else R.style.setProperty('--fvs','normal')};
vt.addEventListener('click',function(){setVar(R.getAttribute('data-var')!=='1')});qa('.axis').forEach(function(a){a.addEventListener('input',fvs)});setVar(false)}
qa('.axis').forEach(function(a){a.addEventListener('dblclick',function(){a.value=a.defaultValue;a.dispatchEvent(new Event('input'))})});
})();`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name} — type tester</title>
<style>${css}</style>
</head>
<body>
<header><h1>${name}</h1><span class="meta">${hasVar ? 'static + variable' : 'static'} · ${glyphs.length} glyphs in samples</span>${metrics}</header>
<div class="ctl" role="group" aria-label="Controls">
${range('size', 'Size', 12, 220, 1, 48, 'px')}
${range('lh', 'Line height', 0.8, 2.2, 0.05, 1.25)}
${range('ls', 'Letter spacing', -0.1, 0.5, 0.01, 0, 'em')}
<button type="button" id="theme" aria-pressed="false">Dark</button>
${hasVar ? `<button type="button" id="var" aria-pressed="false" title="Switch to the variable font">Variable</button><div class="ax" role="group" aria-label="Axes">${axisCtl}</div>` : ''}
</div>
<main>
${sampleBlocks}
<section><h2>Type here</h2><div class="t s" contenteditable="true" spellcheck="false" role="textbox" aria-multiline="true" aria-label="Type here" data-ph="Type here…"></div></section>
<section><h2>Waterfall</h2><div class="wf">${waterfall}</div></section>
<section><h2>Glyphs</h2><div class="g">${grid}</div></section>
</main>
<footer>Made with FontLab</footer>
<script>${js}</script>
</body>
</html>
`;
}
