import { h, slider, help, iconButton } from '../dom';
import { store } from '../state';
import { PREVIEW_FAMILY } from '../preview';
import { samplePreview } from '../../core/charsets';
import { scheduleBuild } from '../buildClient';

export function previewPanel(): HTMLElement {
  const text = h('textarea', { class: 'preview-input', rows: 2, value: store.project.previewText, placeholder: 'Type to preview…' });
  const out = h('div', { class: 'preview-out', contenteditable: 'true', spellcheck: false, role: 'textbox', 'aria-label': 'preview text (editable)', title: 'Type here to test the font', style: { fontFamily: `'${PREVIEW_FAMILY}', monospace`, fontSize: '64px' } }, store.project.previewText);
  out.addEventListener('input', () => { store.project.previewText = out.textContent ?? ''; if (text.value !== store.project.previewText) text.value = store.project.previewText; });
  text.addEventListener('input', () => { store.project.previewText = text.value; out.textContent = text.value; });
  const size = slider('Size', { min: 16, max: 220, step: 1, value: 64, onInput: (v) => { out.style.fontSize = v + 'px'; }, format: (v) => v + 'px' });
  const sample = iconButton('text', 'Insert sample text', () => { text.value = samplePreview(store.project); store.project.previewText = text.value; out.textContent = text.value; }, { title: 'A pangram for every script you have switched on' });
  // Living mode: drift `time` and rebuild only the preview text while on
  let living = false, waiting = false, frames = 0, t0 = 0;
  const DRIFT_OPS = new Set(['wobble', 'melt', 'inkNoise', 'reactionDiffusion']);
  const hasDrift = () => store.project.fx.groups.some((g) => g.enabled && g.layers.some((l) => l.enabled && DRIFT_OPS.has(l.type)));
  const livingBtn = iconButton('wave', 'Drift', () => {
    if (!living && !hasDrift()) { return; }
    living = !living;
    livingBtn.classList.toggle('primary', living);
    livingBtn.setAttribute('aria-pressed', String(living));
    if (living) { frames = 0; t0 = performance.now(); tick(); } else scheduleBuild(0);
  }, { title: 'Animate the noise-based effects (Wobble, Melt, Ink noise, Reaction-diffusion) so the letters keep moving' });
  const syncDrift = () => { const ok = hasDrift(); livingBtn.disabled = !ok && !living; livingBtn.title = ok ? 'Animate the noise-based effects so the letters keep moving' : 'Add Wobble, Melt, Ink noise or Reaction-diffusion to enable drift'; };
  store.subscribe((ev) => { if (ev === 'fx' || ev === 'project:loaded') syncDrift(); });
  syncDrift();
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
    if (ev === 'project:loaded' || ev === 'preview:text') { text.value = store.project.previewText; if (document.activeElement !== out) out.textContent = text.value; }
  });
  return h('section', { class: 'panel preview' },
    h('h2', {}, 'Preview', help('A real font built from your letters, rendered by the browser. Click the text to edit it.')),
    out, h('div', { class: 'row' }, size, sample, livingBtn), h('details', { class: 'plain', 'data-testid': 'preview-plain' }, h('summary', {}, 'Edit as plain text'), text), status,
  );
}
