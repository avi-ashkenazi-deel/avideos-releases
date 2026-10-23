import { h, slider } from '../dom';
import { store } from '../state';
import { PREVIEW_FAMILY } from '../preview';
import { samplePreview } from '../../core/charsets';
import { button } from '../dom';

export function previewPanel(): HTMLElement {
  const text = h('textarea', { class: 'preview-input', rows: 2, value: store.project.previewText, placeholder: 'Type to preview…' });
  const out = h('div', { class: 'preview-out', style: { fontFamily: `'${PREVIEW_FAMILY}', monospace`, fontSize: '64px' } }, store.project.previewText);
  text.addEventListener('input', () => { store.project.previewText = text.value; out.textContent = text.value; });
  const size = slider('Size', { min: 16, max: 220, step: 1, value: 64, onInput: (v) => { out.style.fontSize = v + 'px'; }, format: (v) => v + 'px' });
  const sample = button('Sample text for my scripts', () => { text.value = samplePreview(store.project); store.project.previewText = text.value; out.textContent = text.value; });
  const status = h('div', { class: 'status' });
  store.subscribe((ev) => {
    if (ev === 'status' || ev === 'built') status.textContent = (store.busy ? '⏳ ' : '') + store.status;
    if (ev === 'project:loaded') { text.value = store.project.previewText; out.textContent = text.value; }
  });
  return h('section', { class: 'panel preview' },
    h('h2', {}, 'Preview ', h('small', {}, 'a real font, rendered by your browser')),
    text, h('div', { class: 'row' }, size, sample), out, status,
  );
}
