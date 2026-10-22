import { h, button, toast } from '../dom';
import { store } from '../state';
import { traceImage, labelCells, fileToImageData, type TracedCell } from '../../inputs/image';

/** Modal: trace an uploaded photo, let the user type the letters in reading order, add as seeds. */
export function openImageDialog(file: File, onDone: () => void): void {
  const dlg = h('dialog', { class: 'modal' });
  const body = h('div', { class: 'modal-body' }, h('p', {}, 'Tracing… (thresholding, thinning, fitting strokes)'));
  dlg.append(h('h2', {}, '📷 Handwriting → seeds'), body);
  document.body.append(dlg);
  dlg.showModal();
  dlg.addEventListener('close', () => dlg.remove());

  const mode = h('select', {}, h('option', { value: 'strokes' }, 'strokes (centreline, DNA-friendly)'), h('option', { value: 'outline' }, 'outline (exact shapes)'));
  const invert = h('input', { type: 'checkbox' });
  const run = async () => {
    body.replaceChildren(h('p', {}, 'Tracing…'));
    try {
      const img = await fileToImageData(file);
      const res = await traceImage(img, { mode: mode.value as 'strokes' | 'outline', invert: invert.checked });
      render(res.cells, res.lines);
    } catch (e) { body.replaceChildren(h('p', { class: 'err' }, 'Trace failed: ' + (e as Error).message)); }
  };
  const render = (cells: TracedCell[], lines: number) => {
    const thumbs = h('div', { class: 'cells' });
    for (const c of cells) {
      const cv = h('canvas', { width: c.thumbnail.width, height: c.thumbnail.height, class: 'cellthumb' });
      const ctx = cv.getContext('2d')!;
      const id = ctx.createImageData(c.thumbnail.width, c.thumbnail.height);
      for (let i = 0; i < c.thumbnail.mask.length; i++) { const v = c.thumbnail.mask[i] ? 255 : 0; id.data[i * 4] = v; id.data[i * 4 + 1] = v; id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255; }
      ctx.putImageData(id, 0, 0);
      thumbs.append(h('div', { class: 'cellwrap' }, cv, h('span', {}, String(c.cellIndex + 1))));
    }
    const text = h('input', { type: 'text', class: 'labels', placeholder: 'Type the letters in reading order, e.g. abcdefg', autocomplete: 'off', spellcheck: false });
    const add = button('Add as seeds', () => {
      const glyphs = labelCells(cells, text.value);
      if (!glyphs.length) { toast('Type the letters first'); return; }
      store.update((p) => { for (const g of glyphs) p.glyphs[g.char] = g; }, 'project');
      dlg.close();
      onDone();
      toast(`Added ${glyphs.length} traced seeds`);
    }, 'primary');
    body.replaceChildren(
      h('p', {}, `Found ${cells.length} letter cells on ${lines} line${lines === 1 ? '' : 's'}. Label them left→right, top→bottom (spaces are ignored):`),
      thumbs, text,
      h('div', { class: 'row' }, h('label', {}, 'Mode ', mode), h('label', {}, invert, ' Light ink on dark'), button('Re-trace', run), add, button('Cancel', () => dlg.close())),
    );
    text.focus();
  };
  mode.addEventListener('change', run);
  invert.addEventListener('change', run);
  run();
}
