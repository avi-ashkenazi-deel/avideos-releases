import { h, button, toast, slider } from '../dom';
import { store } from '../state';
import { traceImage, labelCellsDetailed, fileToImageData, type TraceResult } from '../../inputs/image';
import { glyphToContours } from '../../outline';
import { bboxContours } from '../../core/geometry';

type ImageLike = { width: number; height: number; data: Uint8ClampedArray };

/** Modal: trace an uploaded photo (or a video frame), label the cells in reading order, add as seeds. */
export function openImageDialog(file: File, onDone: () => void): void {
  const dlg = h('dialog', { class: 'modal' });
  const body = h('div', { class: 'modal-body' }, h('p', {}, 'Loading…'));
  dlg.append(h('h2', {}, 'Photo to letters'), body);
  document.body.append(dlg);
  dlg.showModal();
  dlg.addEventListener('close', () => dlg.remove());

  const mode = h('select', {}, h('option', { value: 'auto' }, 'auto (outline for heavy letters)'), h('option', { value: 'strokes' }, 'strokes (centreline, effect-friendly)'), h('option', { value: 'outline' }, 'outline (exact shapes)'));
  const invert = h('input', { type: 'checkbox' });
  const invertAuto = h('span', { class: 'muted' }, ' (auto)');
  let invertTouched = false;
  const split = h('input', { type: 'checkbox', checked: true });
  let thresholdOverride: number | null = null;
  let cleanupOverride: number | null = null;
  let typed = '';
  const skipped = new Set<number>();
  const overrides = new Map<number, string>();
  let image: ImageLike | null = null;

  const run = async () => {
    if (!image) return;
    body.replaceChildren(h('p', {}, 'Tracing… (thresholding, cleaning, splitting, fitting)'));
    try {
      const wanted = mode.value as 'auto' | 'strokes' | 'outline';
      const base = { invert: invertTouched ? invert.checked : ('auto' as const), threshold: thresholdOverride ?? undefined, cleanupPx: cleanupOverride ?? ('auto' as const), split: split.checked };
      let res = await traceImage(image, { mode: wanted === 'auto' ? 'outline' : wanted, ...base });
      let chosen: 'strokes' | 'outline' = wanted === 'auto' ? 'outline' : wanted;
      if (wanted === 'auto' && !res.heavy) { res = await traceImage(image, { mode: 'strokes', ...base }); chosen = 'strokes'; }
      if (!invertTouched) { invert.checked = res.inverted; }
      skipped.clear(); overrides.clear();
      render(res, chosen, wanted === 'auto');
    } catch (e) { body.replaceChildren(h('p', { class: 'err' }, 'Trace failed: ' + (e as Error).message), button('Close', () => dlg.close())); }
  };

  const render = (res: TraceResult, chosen: 'strokes' | 'outline', auto: boolean) => {
    const cells = res.cells;
    const thumbs = h('div', { class: 'cells' });
    const labelEls = new Map<number, HTMLInputElement>();
    const wraps = new Map<number, HTMLElement>();
    for (const c of cells) {
      const cv = h('canvas', { class: 'cellthumb' });
      drawVectorThumb(cv, c.glyph);
      const lab = h('input', { type: 'text', class: 'celllabel', maxlength: 2, title: 'the letter this tile becomes — type to change it', 'aria-label': 'letter for this tile' });
      lab.addEventListener('click', (e) => e.stopPropagation());
      lab.addEventListener('input', () => {
        const v = [...lab.value].filter((ch) => !/\s/u.test(ch)).slice(-1)[0];
        if (v) { overrides.set(c.cellIndex, v); skipped.delete(c.cellIndex); } else overrides.delete(c.cellIndex);
        refresh(false);
      });
      const x = button('×', (e) => { e.stopPropagation(); skipped.has(c.cellIndex) ? skipped.delete(c.cellIndex) : skipped.add(c.cellIndex); overrides.delete(c.cellIndex); refresh(); }, 'icon cellx');
      x.title = 'drop this tile (click again to restore)';
      const wrap = h('div', { class: 'cellwrap', title: 'click the picture to drop / restore this tile; type under it to set its letter', 'data-cell': c.cellIndex }, x, cv, lab);
      wrap.addEventListener('click', () => { skipped.has(c.cellIndex) ? skipped.delete(c.cellIndex) : skipped.add(c.cellIndex); overrides.delete(c.cellIndex); refresh(); });
      labelEls.set(c.cellIndex, lab); wraps.set(c.cellIndex, wrap);
      thumbs.append(wrap);
    }
    const text = h('input', { type: 'text', class: 'labels', placeholder: 'Type the letters in reading order, e.g. abcdefg', autocomplete: 'off', spellcheck: false, value: typed });
    const summary = h('div', { class: 'status' });
    const add = button('Add as seeds', () => {
      const lab = labelCellsDetailed(cells, text.value, skipped, overrides);
      if (!lab.glyphs.length) { toast('Type the letters first'); return; }
      store.update((p) => { for (const g of lab.glyphs) p.glyphs[g.char] = g; }, 'project');
      dlg.close();
      onDone();
      toast(`Added ${lab.glyphs.length} traced seeds${chosen === 'outline' ? ' (outline). Use “To strokes” for Weight / variable axes.' : ''}`);
    }, 'primary');
    const refresh = (updateInputs = true) => {
      typed = text.value;
      const lab = labelCellsDetailed(cells.map((c) => ({ ...c, glyph: { ...c.glyph } })), text.value, skipped, overrides);
      const sorted = cells.slice().sort((a, b) => a.cellIndex - b.cellIndex);
      sorted.forEach((c, i) => {
        const el = labelEls.get(c.cellIndex)!, wrap = wraps.get(c.cellIndex)!;
        const isSkip = skipped.has(c.cellIndex);
        if (updateInputs || document.activeElement !== el) el.value = isSkip ? '' : (lab.assigned[i] ?? '');
        el.placeholder = isSkip ? '×' : '?';
        el.disabled = isSkip;
        wrap.classList.toggle('skipped', isSkip);
        wrap.classList.toggle('manual', overrides.has(c.cellIndex));
        wrap.classList.toggle('unlabelled', !isSkip && lab.assigned[i] == null);
      });
      const n = lab.glyphs.length;
      const usable = cells.length - skipped.size;
      if (lab.extra > 0) {
        summary.textContent = `${lab.extra} more letter${lab.extra === 1 ? '' : 's'} typed than tiles (${usable} tiles). Remove letters, or re-trace with a lower cleanup / different threshold so more letters are found.`;
        summary.classList.add('err'); add.disabled = true; add.textContent = 'Add as seeds';
      } else if (lab.missing > 0) {
        summary.textContent = `${n} of ${usable} tiles labelled; ${lab.missing} tile${lab.missing === 1 ? '' : 's'} will be ignored (click a stray tile to drop it, or type a letter under it).`;
        summary.classList.remove('err'); add.disabled = n === 0; add.textContent = `Add ${n} of ${usable}`;
      } else {
        summary.textContent = n ? `All ${n} tiles labelled.` : 'Type the letters in reading order, or type under each tile.';
        summary.classList.remove('err'); add.disabled = n === 0; add.textContent = 'Add as seeds';
      }
    };
    text.addEventListener('input', () => refresh(true));
    const thr = slider('Threshold', { min: 0, max: 255, step: 1, value: thresholdOverride ?? res.threshold, onInput: (v) => { thresholdOverride = v; }, format: (v) => v.toFixed(0) });
    thr.querySelector('input')!.addEventListener('change', run);
    const cleanup = slider('Cleanup', { min: 0, max: 3, step: 1, value: cleanupOverride ?? res.info.cleanupPx, onInput: (v) => { cleanupOverride = v; }, format: (v) => v.toFixed(0) + 'px' });
    cleanup.querySelector('input')!.addEventListener('change', run);
    const infoBits: string[] = [];
    if (res.inverted) infoBits.push('light ink on dark');
    if (res.info.framesRemoved) infoBits.push(`removed ${res.info.framesRemoved} frame${res.info.framesRemoved === 1 ? '' : 's'}`);
    if (res.info.splits) infoBits.push(`split ${res.info.splits} block${res.info.splits === 1 ? '' : 's'} into letters`);
    infoBits.push(`cleanup ${res.info.cleanupPx} px`, `threshold ${res.threshold}`, `mode ${chosen}${auto ? ' (auto)' : ''}`);
    invertAuto.textContent = invertTouched ? '' : ' (auto)';
    body.replaceChildren(
      h('p', {}, `Found ${cells.length} letter cell${cells.length === 1 ? '' : 's'} on ${res.lines} line${res.lines === 1 ? '' : 's'}. `, h('small', { class: 'muted' }, infoBits.join(' · '))),
      ...(auto && res.heavy ? [h('p', { class: 'muted' }, 'Heavy letters: traced as exact outlines so nothing goes wavy. After adding, “To strokes” converts them if you want Weight or variable axes.')] : []),
      ...(cells.length <= 1 ? [h('p', { class: 'err' }, 'Only one cell: the letters are probably touching or the image has a frame. Try a higher Cleanup, a different Threshold, or an image with gaps between letters.')] : []),
      thumbs, text, summary,
      h('div', { class: 'row' }, h('label', {}, 'Mode ', mode), h('label', {}, invert, ' Light ink on dark', invertAuto), h('label', {}, split, ' Split merged letters'), thr, cleanup),
      h('div', { class: 'row' }, button('Re-trace', run), add, button('Cancel', () => dlg.close())),
    );
    refresh();
    text.focus();
  };
  mode.addEventListener('change', run);
  invert.addEventListener('change', () => { invertTouched = true; run(); });
  split.addEventListener('change', run);

  const start = async () => {
    try {
      if (file.type.startsWith('video/')) image = await pickVideoFrame(file, body);
      else image = await fileToImageData(file);
      await run();
    } catch (e) { body.replaceChildren(h('p', { class: 'err' }, 'Could not read that file: ' + (e as Error).message), button('Close', () => dlg.close())); }
  };
  start();
}

/** Scrub a video and pick one frame as the image to trace. */
function pickVideoFrame(file: File, body: HTMLElement): Promise<ImageLike> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = h('video', { src: url, muted: true, playsInline: true, preload: 'auto', style: { maxWidth: '100%', maxHeight: '40vh', background: '#000', borderRadius: '8px', display: 'block' } });
    const time = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: 0, style: { width: '100%' } });
    const label = h('span', { class: 'muted' }, '0.00 s');
    time.addEventListener('input', () => { video.currentTime = parseFloat(time.value); label.textContent = `${parseFloat(time.value).toFixed(2)} s`; });
    video.addEventListener('loadedmetadata', () => { time.max = String(video.duration || 1); video.currentTime = Math.min(0.5, (video.duration || 1) / 2); });
    video.addEventListener('error', () => reject(new Error('the browser could not decode this video')));
    const use = button('Use this frame', () => {
      const c = document.createElement('canvas');
      c.width = video.videoWidth; c.height = video.videoHeight;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(video, 0, 0);
      const id = ctx.getImageData(0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve({ width: c.width, height: c.height, data: id.data });
    }, 'primary');
    body.replaceChildren(h('p', {}, 'Pick the frame to trace:'), video, h('div', { class: 'row' }, time, label), h('div', { class: 'row' }, use));
  });
}

/** Draw a traced glyph's real outline (not the pixel mask) into a small canvas. */
function drawVectorThumb(cv: HTMLCanvasElement, glyph: TraceResult['cells'][number]['glyph']): void {
  const cs = glyphToContours(glyph);
  const H = 64, dpr = window.devicePixelRatio || 1;
  const bb = cs.length ? bboxContours(cs) : { minX: 0, minY: 0, maxX: 500, maxY: 700 };
  const span = Math.max(bb.maxY - bb.minY, 1);
  const s = (H - 8) / span;
  const W = Math.max(24, Math.ceil((bb.maxX - bb.minX) * s) + 8);
  cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px';
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  for (const c of cs) { c.points.forEach((p, i) => { const x = 4 + (p[0] - bb.minX) * s, y = H - 4 - (p[1] - bb.minY) * s; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.closePath(); }
  ctx.fill('nonzero');
}
