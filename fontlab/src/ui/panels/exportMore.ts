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
import { specimenSiteHtml } from '../../export/specimen/site';
import { ufoZip, ufoInputFromBuild } from '../../export/ufo';
import { projectCharset } from '../../core/charsets';
import { openTypeTester } from './tester';
import { BLOCKS } from '../../core/charsets';
import { buildAll } from '../../pipeline/build';
import type { FontProject } from '../../core/glyph';
import { ensureLayer } from '../../fx/stack';
import { FX } from '../../fx/registry';
import { writeOnPlan, drawWriteOnFrame, writeOnSvg } from '../../export/specimen/writeOn';

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

/** The font as a UFO 3 source in a zip: opens in Glyphs, FontLab 8, RoboFont and Fontra. */
export async function downloadUfo(): Promise<void> {
  if (!store.otf) { toast('Nothing built yet. Draw or import some letters first.'); return; }
  toast('Preparing the UFO…');
  await new Promise((r) => setTimeout(r, 30));
  try {
    const project = store.bypassFx ? { ...store.project, fx: { ...store.project.fx, groups: [] } } : store.project;
    const res = buildAll(project, { otf: false });
    const z = ufoZip(ufoInputFromBuild({ familyName: store.project.name || 'FontLab', metrics: store.project.metrics, glyphs: res.glyphs, alternates: res.alternates, kerning: res.kerning }));
    downloadBlob(z.bytes.buffer as ArrayBuffer, z.name, 'application/zip');
    toast('UFO downloaded. Unzip it, then open the .ufo folder in your font editor.', 5000);
  } catch (e) { toast('UFO export failed: ' + (e as Error).message, 5000); }
}
/** Allo-style one-page specimen site: hero, axes, features, tester, character set, download. */
export function downloadSpecimenSite(): void {
  if (!store.otf) { toast('Nothing built yet.'); return; }
  const enabled = new Set([...store.project.blocks, 'latin']);
  const samples = BLOCKS.filter((b) => enabled.has(b.id)).map((b) => ({ title: b.name, text: b.sample, rtl: !!b.rtl }));
  const chars = projectCharset(store.project).filter((ch) => store.built[ch]?.contours.length);
  const alts = store.project.alternates ?? {};
  const alternateChars: Record<string, string> = {};
  for (const [ch, list] of Object.entries(alts)) if (store.built[ch]?.contours.length) list.forEach((_, i) => { const t = `ss0${i + 1}`; alternateChars[t] = (alternateChars[t] ?? '') + ch; });
  const features = [...Object.keys(alternateChars).sort()];
  if ('0123456789'.split('').some((d) => chars.includes(d))) features.push('tnum');
  if (chars.includes('-') && chars.includes('>') && chars.includes('→')) features.push('liga');
  const html = specimenSiteHtml({
    name: store.project.name, otf: new Uint8Array(store.otf.slice(0)), variable: lastVariable ?? undefined,
    metrics: store.project.metrics, chars, samples, features, alternateChars, previewText: store.project.previewText, notes: store.project.notes,
  });
  downloadBlob(html, `${slug(store.project.name)}-specimen.html`, 'text/html');
}

export function openTester(): void {
  if (!store.otf) { toast('Nothing built yet.'); return; }
  openTypeTester();
}

export { openAnimateDialog, openVariableDialog };

/** Frames = a write-on reveal (stroke by stroke) or a sweep through DNA space (seed + axis), rendered to canvas, encoded as GIF or WebM. */
function openAnimateDialog() {
  const dlg = h('dialog', { class: 'modal' });
  const text = h('input', { type: 'text', value: store.project.previewText.split('\n')[0].slice(0, 24) || 'Funky', class: 'labels' });
  const axisSel = h('select', {}, h('option', { value: 'writeon' }, 'Write on (stroke by stroke)'), h('option', { value: 'time' }, 'time (living drift, seamless)'), h('option', { value: 'seed' }, 'seed'), ...['wobble', 'melt', 'weight', 'glitch', 'erode', 'bounce', 'jitter', 'inflate', 'blob', 'inkNoise', 'morph', 'pixel'].map((a) => h('option', { value: a }, FX[a]?.def.label ?? a)));
  axisSel.value = 'writeon';
  axisSel.dataset.testid = 'animate-sweep';
  let frames = 18, woFrames = 48;
  const WO_HOLD = 1200;
  const isWriteOn = () => axisSel.value === 'writeon';
  const framesRow = slider('Frames', { min: 6, max: 48, step: 1, value: frames, onInput: (v) => (frames = v), format: (v) => String(v) });
  const woFramesRow = slider('Frames', { min: 6, max: 120, step: 1, value: woFrames, onInput: (v) => (woFrames = v), format: (v) => String(v) });
  const canvas = h('canvas', { width: 960, height: 360, style: { width: '100%', background: '#fff', borderRadius: '8px' } });
  const status = h('div', { class: 'status' });
  const intro = h('p', {});
  const plan = () => writeOnPlan(text.value, { metrics: store.project.metrics, glyphs: store.project.glyphs, built: store.built });
  /** write-on: total cycle (animation + hold) for the current text */
  let woCycle = 0;
  let playTimer = 0;
  const stopPlay = () => { if (playTimer) { clearInterval(playTimer); playTimer = 0; } };
  const renderWriteOn = (): HTMLCanvasElement[] => {
    const pl = plan();
    woCycle = pl.durationMs + WO_HOLD;
    const out: HTMLCanvasElement[] = [];
    for (let i = 0; i < woFrames; i++) {
      const c = document.createElement('canvas'); c.width = canvas.width; c.height = canvas.height;
      drawWriteOnFrame(c.getContext('2d')!, pl, (i * woCycle) / woFrames);
      out.push(c);
    }
    canvas.getContext('2d')!.drawImage(out[out.length - 1], 0, 0);
    return out;
  };
  const renderFrames = (): HTMLCanvasElement[] => {
    stopPlay();
    if (isWriteOn()) return renderWriteOn();
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
  /** delay per frame: write-on plays in real time, sweeps at the fixed 70 ms */
  const frameDelay = (n: number) => (isWriteOn() ? Math.max(20, Math.round(woCycle / Math.max(1, n))) : 70);
  const gifBtn = button('Download GIF', async () => {
    status.textContent = 'Rendering frames…';
    await new Promise((r) => setTimeout(r, 20));
    try {
      const fr = renderFrames();
      status.textContent = 'Encoding GIF…';
      const blob = await encodeGif(fr, frameDelay(fr.length), (p) => (status.textContent = `Encoding GIF… ${(p * 100).toFixed(0)}%`));
      downloadBlob(blob, `${slug(store.project.name)}${isWriteOn() ? '-write-on' : ''}.gif`, 'image/gif');
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
      const wo = isWriteOn();
      const blob = wo
        ? await recordWebm(canvas, (i) => ctx.drawImage(fr[i % fr.length], 0, 0), fr.length, Math.max(1, Math.round(1000 / frameDelay(fr.length))))
        : await recordWebm(canvas, (i) => ctx.drawImage(fr[i % fr.length], 0, 0), fr.length * 2, 14);
      downloadBlob(blob, `${slug(store.project.name)}${wo ? '-write-on' : ''}.webm`, 'video/webm');
      status.textContent = `WebM ready (${(blob.size / 1024).toFixed(0)} KB)`;
    } catch (e) { status.textContent = 'WebM failed: ' + (e as Error).message; }
  });
  const svgBtn = button('Download animated SVG', () => {
    const pl = plan();
    if (!pl.items.length) { toast('Nothing to write yet. Type letters that are in your font.'); return; }
    downloadBlob(writeOnSvg(pl, { fill: '#111', bg: '#fff', holdMs: WO_HOLD }), `${slug(store.project.name)}-write-on.svg`, 'image/svg+xml');
    status.textContent = 'Animated SVG downloaded (loops; plays in any browser).';
  });
  svgBtn.dataset.testid = 'btn-writeon-svg';
  const previewBtn = button('Preview frames', () => {
    const fr = renderFrames();
    if (!isWriteOn()) { status.textContent = 'Previewed last frame'; return; }
    // play the frames once at their real speed, ending on the finished text
    const ctx = canvas.getContext('2d')!;
    let i = 0;
    status.textContent = `${fr.length} frames · ${(woCycle / 1000).toFixed(1)} s`;
    playTimer = window.setInterval(() => { ctx.drawImage(fr[i], 0, 0); if (++i >= fr.length) stopPlay(); }, frameDelay(fr.length));
  });
  previewBtn.dataset.testid = 'btn-animate-preview';
  const syncMode = () => {
    const wo = isWriteOn();
    framesRow.style.display = wo ? 'none' : '';
    woFramesRow.style.display = wo ? '' : 'none';
    svgBtn.style.display = wo ? '' : 'none';
    intro.textContent = wo
      ? 'Your letters write themselves, stroke by stroke, in the order they were drawn. Imported letters follow their traced centrelines.'
      : 'Sweeps one DNA axis back and forth across the frames, so the loop is seamless.';
  };
  axisSel.addEventListener('change', () => { stopPlay(); syncMode(); });
  syncMode();
  dlg.append(h('h2', {}, 'Animated specimen'),
    intro,
    h('div', { class: 'row' }, h('label', {}, 'Text ', text)), h('div', { class: 'row' }, h('label', {}, 'Sweep ', axisSel), framesRow, woFramesRow),
    canvas, status,
    h('div', { class: 'row' }, previewBtn, gifBtn, webmBtn, svgBtn, button('Close', () => dlg.close())));
  document.body.append(dlg); dlg.showModal(); dlg.addEventListener('close', () => { stopPlay(); dlg.remove(); });
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
