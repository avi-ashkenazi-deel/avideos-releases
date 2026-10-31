import { h, button, toast, slider } from '../dom';
import { store } from '../state';
import { downloadBlob, slug } from '../../project/storage';
import { specimenSvg, type GlyphLookup } from '../../export/specimen/svg';
import { drawFrame } from '../../export/specimen/frames';
import { encodeGif } from '../../export/specimen/gif';
import { recordWebm } from '../../export/specimen/webm';
import { buildVarPayload, AXIS_DEFS, type VarAxisTag } from '../../export/variable/masters';
import { buildVariableFont, buildStaticTtf } from '../../export/variable';
import { contoursToPathD } from '../../export/specimen/svg';
import { typeTesterHtml } from '../../export/specimen/html';
import { openTypeTester } from './tester';
import { BLOCKS } from '../../core/charsets';
import { buildAll } from '../../pipeline/build';
import type { FontProject } from '../../core/glyph';
import { ensureLayer } from '../../fx/stack';
import { FX } from '../../fx/registry';

let lastVariable: { bytes: Uint8Array; axes: { tag: string; name: string; min: number; default: number; max: number }[] } | null = null;

const lookup = (): GlyphLookup => (ch) => { const b = store.built[ch]; return b && b.contours.length ? { advance: b.advance, contours: b.contours } : undefined; };

export function downloadOtf(): void {
  if (!store.otf) { toast('Nothing built yet. Draw or import some letters first.'); return; }
  downloadBlob(store.otf.slice(0), `${slug(store.project.name)}.otf`, 'font/otf');
}

let ttfBusy = false;
export async function downloadTtf(): Promise<void> {
  if (!store.otf) { toast('Nothing built yet. Draw or import some letters first.'); return; }
  if (ttfBusy) { toast('Still converting…'); return; }
  ttfBusy = true;
  try {
    const bytes = await buildStaticTtf(store.otf.slice(0), (s) => toast(s, 4000));
    downloadBlob(new Uint8Array(bytes).buffer as ArrayBuffer, `${slug(store.project.name)}.ttf`, 'font/ttf');
    toast('TrueType font downloaded.');
  } catch (e) {
    toast('TrueType export failed: ' + ((e as Error)?.message ?? String(e)).slice(0, 120) + '. The converter needs internet the first time.', 6000);
  } finally { ttfBusy = false; }
}

/** One SVG for a single glyph (viewBox = advance × (ascender − descender), baseline at y=0 flipped). */
export function glyphSvg(ch: string): string | null {
  const b = store.built[ch];
  if (!b || !b.contours.length) return null;
  const m = store.project.metrics;
  const d = contoursToPathD(b.contours);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 ${-m.ascender} ${b.advance} ${m.ascender - m.descender}" width="${b.advance}" height="${m.ascender - m.descender}"><path id="glyph-${esc(ch)}" data-char="${esc(ch)}" d="${d}" fill="#000"/></svg>`;
}
export function downloadGlyphSvg(ch: string): void {
  const svg = glyphSvg(ch);
  if (!svg) { toast(`“${ch}” has nothing to export yet.`); return; }
  downloadBlob(svg, `${slug(store.project.name)}-${glyphFileName(ch)}.svg`, 'image/svg+xml');
}
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const glyphFileName = (ch: string) => (/^[A-Za-z0-9]$/.test(ch) ? (ch === ch.toUpperCase() && ch !== ch.toLowerCase() ? ch + '_cap' : ch) : 'u' + ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0'));

/** Every inked glyph as its own <g id="glyph-X"> laid out on a grid: pull letters apart in Illustrator / Figma. */
export function downloadSvgGlyphs(): void {
  if (!store.otf) { toast('Nothing built yet.'); return; }
  const m = store.project.metrics;
  const chars = Object.keys(store.built).filter((ch) => store.built[ch].contours.length);
  if (!chars.length) { toast('Nothing built yet.'); return; }
  const cellW = Math.max(...chars.map((ch) => store.built[ch].advance), 400) + 100, cellH = m.ascender - m.descender + 120;
  const cols = Math.ceil(Math.sqrt(chars.length * 1.6));
  const rows = Math.ceil(chars.length / cols);
  const groups = chars.map((ch, i) => {
    const b = store.built[ch];
    const x = (i % cols) * cellW + 50, y = Math.floor(i / cols) * cellH + m.ascender + 60;
    return `  <g id="glyph-${esc(ch)}" data-char="${esc(ch)}" data-advance="${b.advance}" transform="translate(${x} ${y})"><path d="${contoursToPathD(b.contours)}"/></g>`;
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${cols * cellW} ${rows * cellH}" width="${cols * cellW}" height="${rows * cellH}" fill="#000">\n<title>${esc(store.project.name)} glyphs</title>\n${groups.join('\n')}\n</svg>`;
  downloadBlob(svg, `${slug(store.project.name)}-glyphs.svg`, 'image/svg+xml');
}

export function downloadSvgSpecimen(): void {
  if (!store.otf) { toast('Nothing built yet.'); return; }
  const svg = specimenSvg({ text: store.project.previewText, metrics: store.project.metrics, lookup: lookup(), animate: true });
  downloadBlob(svg, `${slug(store.project.name)}-specimen.svg`, 'image/svg+xml');
}

export function downloadTesterHtml(): void {
  if (!store.otf) { toast('Nothing built yet.'); return; }
  const enabled = new Set([...store.project.blocks, 'latin']);
  const samples = BLOCKS.filter((b) => enabled.has(b.id)).map((b) => ({ title: b.name, text: b.sample, rtl: !!b.rtl }));
  samples.unshift({ title: 'Preview', text: store.project.previewText, rtl: false });
  const html = typeTesterHtml({ name: store.project.name, otf: new Uint8Array(store.otf.slice(0)), variable: lastVariable ?? undefined, samples, metrics: store.project.metrics });
  downloadBlob(html, `${slug(store.project.name)}-type-tester.html`, 'text/html');
}

export function openTester(): void {
  if (!store.otf) { toast('Nothing built yet.'); return; }
  openTypeTester();
}

export { openAnimateDialog, openVariableDialog };

/** Frames = a sweep through DNA space (seed + axis) rendered to canvas, encoded as GIF or WebM. */
function openAnimateDialog() {
  const dlg = h('dialog', { class: 'modal' });
  const text = h('input', { type: 'text', value: store.project.previewText.split('\n')[0].slice(0, 24) || 'Funky', class: 'labels' });
  const axisSel = h('select', {}, h('option', { value: 'time' }, 'time (living drift, seamless)'), h('option', { value: 'seed' }, 'seed'), ...['wobble', 'melt', 'weight', 'glitch', 'erode', 'bounce', 'jitter', 'inflate', 'blob', 'inkNoise', 'morph', 'pixel'].map((a) => h('option', { value: a }, FX[a]?.def.label ?? a)));
  let frames = 18;
  const framesRow = slider('Frames', { min: 6, max: 48, step: 1, value: frames, onInput: (v) => (frames = v), format: (v) => String(v) });
  const canvas = h('canvas', { width: 960, height: 360, style: { width: '100%', background: '#fff', borderRadius: '8px' } });
  const status = h('div', { class: 'status' });
  const renderFrames = (): HTMLCanvasElement[] => {
    const out: HTMLCanvasElement[] = [];
    const chars = [...new Set(text.value.replace(/\s/g, ''))];
    for (let i = 0; i < frames; i++) {
      const t = i / frames;
      const p: FontProject = JSON.parse(JSON.stringify(store.project));
      const ax = axisSel.value;
      const wave = 0.5 - 0.5 * Math.cos(t * Math.PI * 2); // 0→1→0, loops cleanly
      if (ax === 'seed') p.fx.seed = store.project.fx.seed + i;
      else if (ax === 'time') p.fx.time = store.project.fx.time + wave * 1.2; // palindromic sweep → seamless loop
      else {
        const layer = ensureLayer(p.fx, ax);
        const def = FX[ax].def.params[0];
        layer.params[def.key] = def.min < 0 ? def.min + (def.max - def.min) * wave : def.min + (def.max - def.min) * wave;
      }
      const res = buildAll(p, { otf: false, chars });
      const c = document.createElement('canvas'); c.width = canvas.width; c.height = canvas.height;
      drawFrame(c.getContext('2d')!, text.value, (ch) => { const b = res.glyphs[ch]; return b && b.contours.length ? b : undefined; }, p.metrics);
      out.push(c);
      canvas.getContext('2d')!.drawImage(c, 0, 0);
    }
    return out;
  };
  const gifBtn = button('Download GIF', async () => {
    status.textContent = 'Rendering frames…';
    await new Promise((r) => setTimeout(r, 20));
    try {
      const fr = renderFrames();
      status.textContent = 'Encoding GIF…';
      const blob = await encodeGif(fr, 70, (p) => (status.textContent = `Encoding GIF… ${(p * 100).toFixed(0)}%`));
      downloadBlob(blob, `${slug(store.project.name)}.gif`, 'image/gif');
      status.textContent = `GIF ready (${(blob.size / 1024).toFixed(0)} KB)`;
    } catch (e) { status.textContent = 'GIF failed: ' + (e as Error).message; }
  }, 'primary');
  const webmBtn = button('Download WebM', async () => {
    status.textContent = 'Rendering frames…';
    await new Promise((r) => setTimeout(r, 20));
    try {
      const fr = renderFrames();
      status.textContent = 'Recording…';
      const ctx = canvas.getContext('2d')!;
      const blob = await recordWebm(canvas, (i) => ctx.drawImage(fr[i % fr.length], 0, 0), fr.length * 2, 14);
      downloadBlob(blob, `${slug(store.project.name)}.webm`, 'video/webm');
      status.textContent = `WebM ready (${(blob.size / 1024).toFixed(0)} KB)`;
    } catch (e) { status.textContent = 'WebM failed: ' + (e as Error).message; }
  });
  dlg.append(h('h2', {}, 'Animated specimen'),
    h('p', {}, 'Sweeps one DNA axis back and forth across the frames, so the loop is seamless.'),
    h('div', { class: 'row' }, h('label', {}, 'Text ', text)), h('div', { class: 'row' }, h('label', {}, 'Sweep ', axisSel), framesRow),
    canvas, status,
    h('div', { class: 'row' }, button('Preview frames', () => { renderFrames(); status.textContent = 'Previewed last frame'; }), gifBtn, webmBtn, button('Close', () => dlg.close())));
  document.body.append(dlg); dlg.showModal(); dlg.addEventListener('close', () => dlg.remove());
}

function openVariableDialog() {
  const dlg = h('dialog', { class: 'modal' });
  const checks = new Map<VarAxisTag, HTMLInputElement>();
  const list = h('div', { class: 'chips' });
  for (const tag of Object.keys(AXIS_DEFS) as VarAxisTag[]) {
    const cb = h('input', { type: 'checkbox', checked: tag === 'wght' || tag === 'WOBL' });
    checks.set(tag, cb);
    list.append(h('label', { class: 'chip', style: { display: 'inline-flex', gap: '6px', alignItems: 'center', border: '1px solid var(--line)', borderRadius: '999px', padding: '3px 10px' } }, cb, `${tag} · ${AXIS_DEFS[tag].name}`));
  }
  const status = h('div', { class: 'status' });
  const demo = h('div', { class: 'preview-out', style: { fontSize: '56px', display: 'none' } });
  const build = button('Build variable font', async () => {
    const tags = [...checks].filter(([, cb]) => cb.checked).map(([t]) => t);
    if (!tags.length) { toast('Pick at least one axis'); return; }
    build.disabled = true;
    try {
      status.textContent = 'Preparing masters…';
      await new Promise((r) => setTimeout(r, 20));
      const payload = buildVarPayload(store.project, tags);
      status.textContent = `${payload.masters.length} masters, ${payload.glyphOrder.length} glyphs. Loading Python…`;
      const bytes = await buildVariableFont(payload, (s) => (status.textContent = s));
      const copy = new Uint8Array(bytes);
      lastVariable = { bytes: copy, axes: payload.axes };
      store.variableAxes = payload.axes;
      downloadBlob(copy, `${slug(store.project.name)}-VF.ttf`, 'font/ttf');
      const face = new FontFace('FunkyVarPreview', copy.buffer as ArrayBuffer);
      await face.load(); document.fonts.add(face);
      demo.style.display = 'block'; demo.style.fontFamily = 'FunkyVarPreview';
      demo.textContent = store.project.previewText.split('\n')[0];
      const kf0 = payload.axes.map((a) => `'${a.tag}' ${a.min}`).join(', '), kf1 = payload.axes.map((a) => `'${a.tag}' ${a.max}`).join(', ');
      demo.animate([{ fontVariationSettings: kf0 }, { fontVariationSettings: kf1 }, { fontVariationSettings: kf0 }], { duration: 3000, iterations: Infinity });
      status.textContent = `Variable font ready (${(bytes.length / 1024).toFixed(0)} KB) — axes: ${payload.axes.map((a) => a.tag).join(', ')}. Downloaded.`;
      const svgBtn = button('Download animated SVG with this font', () => {
        const svg = specimenSvg({ text: store.project.previewText, metrics: store.project.metrics, lookup: lookup(), variableFont: { bytes: copy, axes: payload.axes } });
        downloadBlob(svg, `${slug(store.project.name)}-variable-specimen.svg`, 'image/svg+xml');
      });
      status.append(' ', svgBtn);
    } catch (e) { status.textContent = 'Failed: ' + (e as Error).message; console.error(e); }
    build.disabled = false;
  }, 'primary');
  dlg.append(h('h2', {}, 'Variable font'),
    h('p', {}, 'Builds a real OpenType variable font with the axes you pick (custom axes like WOBL work in CSS via font-variation-settings). Rust, Glitch and Inflate change point counts, so they are baked in as static only.'),
    list, h('div', { class: 'row' }, build, button('Close', () => dlg.close())), status, demo);
  document.body.append(dlg); dlg.showModal(); dlg.addEventListener('close', () => dlg.remove());
}
