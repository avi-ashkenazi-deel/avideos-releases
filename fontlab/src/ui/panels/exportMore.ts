import { h, button, toast, slider } from '../dom';
import { store } from '../state';
import { downloadBlob, slug } from '../../project/storage';
import { specimenSvg, type GlyphLookup } from '../../export/specimen/svg';
import { drawFrame } from '../../export/specimen/frames';
import { encodeGif } from '../../export/specimen/gif';
import { recordWebm } from '../../export/specimen/webm';
import { buildVarPayload, AXIS_DEFS, type VarAxisTag } from '../../export/variable/masters';
import { buildVariableFont } from '../../export/variable';
import { buildAll } from '../../pipeline/build';
import type { FontProject } from '../../core/glyph';

const lookup = (): GlyphLookup => (ch) => { const b = store.built[ch]; return b && b.contours.length ? { advance: b.advance, contours: b.contours } : undefined; };

export function exportMoreButtons(): HTMLElement[] {
  return [
    button('SVG specimen', () => {
      const svg = specimenSvg({ text: store.project.previewText, metrics: store.project.metrics, lookup: lookup(), animate: true });
      downloadBlob(svg, `${slug(store.project.name)}-specimen.svg`, 'image/svg+xml');
    }),
    button('🎞 Animate…', openAnimateDialog),
    button('🧬 Variable font…', openVariableDialog),
  ];
}

/** Frames = a sweep through DNA space (seed + axis) rendered to canvas, encoded as GIF or WebM. */
function openAnimateDialog() {
  const dlg = h('dialog', { class: 'modal' });
  const text = h('input', { type: 'text', value: store.project.previewText.split('\n')[0].slice(0, 24) || 'Funky', class: 'labels' });
  const axisSel = h('select', {}, ...['wobble', 'melt', 'weight', 'glitch', 'erode', 'bounce', 'jitter', 'inflate', 'seed'].map((a) => h('option', { value: a }, a)));
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
      if (ax === 'seed') p.dna.seed = store.project.dna.seed + i;
      else if (ax === 'weight') p.dna.weight = -1 + 2 * wave;
      else (p.dna as any)[ax] = wave;
      const res = buildAll(p, { otf: false, chars });
      const c = document.createElement('canvas'); c.width = canvas.width; c.height = canvas.height;
      drawFrame(c.getContext('2d')!, text.value, (ch) => { const b = res.glyphs[ch]; return b && b.contours.length ? b : undefined; }, p.metrics);
      out.push(c);
      canvas.getContext('2d')!.drawImage(c, 0, 0);
    }
    return out;
  };
  const gifBtn = button('⬇ GIF', async () => {
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
  const webmBtn = button('⬇ WebM', async () => {
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
  dlg.append(h('h2', {}, '🎞 Animated specimen'),
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
      downloadBlob(copy, `${slug(store.project.name)}-VF.ttf`, 'font/ttf');
      const face = new FontFace('FunkyVarPreview', copy.buffer as ArrayBuffer);
      await face.load(); document.fonts.add(face);
      demo.style.display = 'block'; demo.style.fontFamily = 'FunkyVarPreview';
      demo.textContent = store.project.previewText.split('\n')[0];
      const kf0 = payload.axes.map((a) => `'${a.tag}' ${a.min}`).join(', '), kf1 = payload.axes.map((a) => `'${a.tag}' ${a.max}`).join(', ');
      demo.animate([{ fontVariationSettings: kf0 }, { fontVariationSettings: kf1 }, { fontVariationSettings: kf0 }], { duration: 3000, iterations: Infinity });
      status.textContent = `Variable font ready (${(bytes.length / 1024).toFixed(0)} KB) — axes: ${payload.axes.map((a) => a.tag).join(', ')}. Downloaded.`;
      const svgBtn = button('⬇ Animated SVG with this font', () => {
        const svg = specimenSvg({ text: store.project.previewText, metrics: store.project.metrics, lookup: lookup(), variableFont: { bytes: copy, axes: payload.axes } });
        downloadBlob(svg, `${slug(store.project.name)}-variable-specimen.svg`, 'image/svg+xml');
      });
      status.append(' ', svgBtn);
    } catch (e) { status.textContent = 'Failed: ' + (e as Error).message; console.error(e); }
    build.disabled = false;
  }, 'primary');
  dlg.append(h('h2', {}, '🧬 Variable font export'),
    h('p', {}, 'Builds a real OpenType variable font with the axes you pick (custom axes like WOBL work in CSS via font-variation-settings). Rust, Glitch and Inflate change point counts, so they are baked in as static only.'),
    list, h('div', { class: 'row' }, build, button('Close', () => dlg.close())), status, demo);
  document.body.append(dlg); dlg.showModal(); dlg.addEventListener('close', () => dlg.remove());
}
