import { h, slider } from '../dom';
import { store } from '../state';
import { PREVIEW_FAMILY } from '../preview';
import { samplePreview } from '../../core/charsets';
import { button } from '../dom';
import { scheduleBuild } from '../buildClient';

export function previewPanel(): HTMLElement {
  const text = h('textarea', { class: 'preview-input', rows: 2, value: store.project.previewText, placeholder: 'Type to preview…' });
  const out = h('div', { class: 'preview-out', style: { fontFamily: `'${PREVIEW_FAMILY}', monospace`, fontSize: '64px' } }, store.project.previewText);
  text.addEventListener('input', () => { store.project.previewText = text.value; out.textContent = text.value; });
  const size = slider('Size', { min: 16, max: 220, step: 1, value: 64, onInput: (v) => { out.style.fontSize = v + 'px'; }, format: (v) => v + 'px' });
  const sample = button('Sample text for my scripts', () => { text.value = samplePreview(store.project); store.project.previewText = text.value; out.textContent = text.value; });
  // Living mode: drift `time` and rebuild only the preview text while on
  let living = false, waiting = false, frames = 0, t0 = 0;
  const livingBtn = button('🌊 Living: off', () => {
    living = !living;
    livingBtn.textContent = living ? '🌊 Living: on' : '🌊 Living: off';
    livingBtn.classList.toggle('primary', living);
    if (living) { frames = 0; t0 = performance.now(); tick(); } else scheduleBuild(0);
  });
  const tick = () => {
    if (!living || waiting) return;
    waiting = true;
    store.project.fx.time = Math.round((store.project.fx.time + 0.03) * 1000) / 1000;
    scheduleBuild(0, { previewOnly: true });
  };
  const status = h('div', { class: 'status' });
  store.subscribe((ev) => {
    if (ev === 'font:preview' && living) {
      waiting = false; frames++;
      const fps = frames / Math.max(0.001, (performance.now() - t0) / 1000);
      status.textContent = `living · ${fps.toFixed(1)} fps · t=${store.project.fx.time.toFixed(2)}`;
      requestAnimationFrame(tick);
    }
  });
  store.subscribe((ev) => {
    if ((ev === 'status' || ev === 'built') && !living) status.textContent = (store.busy ? '⏳ ' : '') + store.status;
    if (ev === 'project:loaded') { text.value = store.project.previewText; out.textContent = text.value; }
  });
  return h('section', { class: 'panel preview' },
    h('h2', {}, 'Preview ', h('small', {}, 'a real font, rendered by your browser')),
    text, h('div', { class: 'row' }, size, sample, livingBtn), out, status,
  );
}
