import { h, button, toast, slider } from '../dom';
import { store } from '../state';
import { traceImage, labelCellsDetailed, fileToImageData, type TraceResult } from '../../inputs/image';

/** Modal: trace an uploaded photo, let the user label the cells in reading order, add as seeds. */
export function openImageDialog(file: File, onDone: () => void): void {
  const dlg = h('dialog', { class: 'modal' });
  const body = h('div', { class: 'modal-body' }, h('p', {}, 'Tracing… (thresholding, cleaning, splitting, fitting strokes)'));
  dlg.append(h('h2', {}, '📷 Handwriting → seeds'), body);
  document.body.append(dlg);
  dlg.showModal();
  dlg.addEventListener('close', () => dlg.remove());

  const mode = h('select', {}, h('option', { value: 'strokes' }, 'strokes (centreline, effect-friendly)'), h('option', { value: 'outline' }, 'outline (exact shapes)'));
  const invert = h('input', { type: 'checkbox' });
  const split = h('input', { type: 'checkbox', checked: true });
  let thresholdOverride: number | null = null;
  let cleanupOverride: number | null = null;
  let imgPromise: Promise<{ width: number; height: number; data: Uint8ClampedArray }> | null = null;
  let typed = '';
  const skipped = new Set<number>();

  const run = async () => {
    body.replaceChildren(h('p', {}, 'Tracing…'));
    try {
      imgPromise ??= fileToImageData(file);
      const img = await imgPromise;
      const res = await traceImage(img, {
        mode: mode.value as 'strokes' | 'outline', invert: invert.checked,
        threshold: thresholdOverride ?? undefined, cleanupPx: cleanupOverride ?? 'auto', split: split.checked,
      });
      skipped.clear();
      render(res);
    } catch (e) { body.replaceChildren(h('p', { class: 'err' }, 'Trace failed: ' + (e as Error).message), button('Close', () => dlg.close())); }
  };

  const render = (res: TraceResult) => {
    const cells = res.cells;
    const thumbs = h('div', { class: 'cells' });
    const labelEls = new Map<number, HTMLElement>();
    const wraps = new Map<number, HTMLElement>();
    for (const c of cells) {
      const cv = h('canvas', { width: c.thumbnail.width, height: c.thumbnail.height, class: 'cellthumb' });
      const ctx = cv.getContext('2d')!;
      const id = ctx.createImageData(c.thumbnail.width, c.thumbnail.height);
      for (let i = 0; i < c.thumbnail.mask.length; i++) { const v = c.thumbnail.mask[i] ? 255 : 0; id.data[i * 4] = v; id.data[i * 4 + 1] = v; id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255; }
      ctx.putImageData(id, 0, 0);
      const lab = h('span', { class: 'celllabel' }, '·');
      const wrap = h('div', { class: 'cellwrap', title: 'click to skip / unskip this cell', 'data-cell': c.cellIndex }, cv, lab);
      wrap.addEventListener('click', () => { skipped.has(c.cellIndex) ? skipped.delete(c.cellIndex) : skipped.add(c.cellIndex); refresh(); });
      labelEls.set(c.cellIndex, lab); wraps.set(c.cellIndex, wrap);
      thumbs.append(wrap);
    }
    const text = h('input', { type: 'text', class: 'labels', placeholder: 'Type the letters in reading order, e.g. abcdefg', autocomplete: 'off', spellcheck: false, value: typed });
    const summary = h('div', { class: 'status' });
    const add = button('Add as seeds', () => {
      const lab = labelCellsDetailed(cells, text.value, skipped);
      if (!lab.glyphs.length) { toast('Type the letters first'); return; }
      store.update((p) => { for (const g of lab.glyphs) p.glyphs[g.char] = g; }, 'project');
      dlg.close();
      onDone();
      toast(`Added ${lab.glyphs.length} traced seeds`);
    }, 'primary');
    const refresh = () => {
      typed = text.value;
      const lab = labelCellsDetailed(cells.map((c) => ({ ...c, glyph: { ...c.glyph } })), text.value, skipped);
      const sorted = cells.slice().sort((a, b) => a.cellIndex - b.cellIndex);
      sorted.forEach((c, i) => {
        const el = labelEls.get(c.cellIndex)!, wrap = wraps.get(c.cellIndex)!;
        const isSkip = skipped.has(c.cellIndex);
        el.textContent = isSkip ? 'skip' : (lab.assigned[i] ?? '?');
        wrap.classList.toggle('skipped', isSkip);
        wrap.classList.toggle('unlabelled', !isSkip && lab.assigned[i] == null);
      });
      const n = lab.glyphs.length;
      const usable = cells.length - skipped.size;
      if (lab.extra > 0) {
        summary.textContent = `${lab.extra} more letter${lab.extra === 1 ? '' : 's'} typed than cells (${usable} cells). Remove letters, or re-trace with a lower cleanup / different threshold so more letters are found.`;
        summary.classList.add('err'); add.disabled = true; add.textContent = 'Add as seeds';
      } else if (lab.missing > 0) {
        summary.textContent = `${n} of ${usable} cells labelled; ${lab.missing} cell${lab.missing === 1 ? '' : 's'} will be ignored (or click a stray cell to skip it).`;
        summary.classList.remove('err'); add.disabled = n === 0; add.textContent = `Add ${n} of ${usable}`;
      } else {
        summary.textContent = n ? `All ${n} cells labelled.` : 'Type the letters in reading order.';
        summary.classList.remove('err'); add.disabled = n === 0; add.textContent = 'Add as seeds';
      }
    };
    text.addEventListener('input', refresh);
    const thr = slider('Threshold', { min: 0, max: 255, step: 1, value: thresholdOverride ?? res.threshold, onInput: (v) => { thresholdOverride = v; }, format: (v) => v.toFixed(0) });
    thr.querySelector('input')!.addEventListener('change', run);
    const cleanup = slider('Cleanup', { min: 0, max: 3, step: 1, value: cleanupOverride ?? res.info.cleanupPx, onInput: (v) => { cleanupOverride = v; }, format: (v) => v.toFixed(0) + 'px' });
    cleanup.querySelector('input')!.addEventListener('change', run);
    const infoBits: string[] = [];
    if (res.info.framesRemoved) infoBits.push(`removed ${res.info.framesRemoved} frame${res.info.framesRemoved === 1 ? '' : 's'}`);
    if (res.info.splits) infoBits.push(`split ${res.info.splits} block${res.info.splits === 1 ? '' : 's'} into letters`);
    infoBits.push(`cleanup ${res.info.cleanupPx} px`, `threshold ${res.threshold}`);
    body.replaceChildren(
      h('p', {}, `Found ${cells.length} letter cell${cells.length === 1 ? '' : 's'} on ${res.lines} line${res.lines === 1 ? '' : 's'}. `, h('small', { class: 'muted' }, infoBits.join(' · '))),
      ...(cells.length <= 1 ? [h('p', { class: 'err' }, 'Only one cell: the letters are probably touching or the image has a frame. Try a higher Cleanup, a different Threshold, or an image with gaps between letters.')] : []),
      thumbs, text, summary,
      h('div', { class: 'row' }, h('label', {}, 'Mode ', mode), h('label', {}, invert, ' Light ink on dark'), h('label', {}, split, ' Split merged letters'), thr, cleanup),
      h('div', { class: 'row' }, button('Re-trace', run), add, button('Cancel', () => dlg.close())),
    );
    refresh();
    text.focus();
  };
  mode.addEventListener('change', run);
  invert.addEventListener('change', run);
  split.addEventListener('change', run);
  run();
}
