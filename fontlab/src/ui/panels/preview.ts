import { h, slider, help, iconButton } from '../dom';
import { store } from '../state';
import { PREVIEW_FAMILY } from '../preview';
import { samplePreview } from '../../core/charsets';
import { scheduleBuild } from '../buildClient';
import { availableFeatures, featureCss } from '../alternates';
import { writeOnPlan, drawWriteOnFrame } from '../../export/specimen/writeOn';

export function previewPanel(): HTMLElement {
  const text = h('textarea', { class: 'preview-input', rows: 2, value: store.project.previewText, placeholder: 'Type to preview…' });
  const out = h('div', { class: 'preview-out', contenteditable: 'true', spellcheck: false, role: 'textbox', 'aria-label': 'preview text (editable)', title: 'Type here to test the font', style: { fontFamily: `'${PREVIEW_FAMILY}', monospace`, fontSize: '64px' } }, store.project.previewText);
  out.addEventListener('input', () => { store.project.previewText = out.textContent ?? ''; if (text.value !== store.project.previewText) text.value = store.project.previewText; store.emit('preview:typed'); });
  text.addEventListener('input', () => { store.project.previewText = text.value; out.textContent = text.value; store.emit('preview:typed'); });
  const size = slider('Size', { min: 16, max: 220, step: 1, value: 64, onInput: (v) => { out.style.fontSize = v + 'px'; }, format: (v) => v + 'px' });
  const sample = iconButton('text', 'Insert sample text', () => { text.value = samplePreview(store.project); store.project.previewText = text.value; out.textContent = text.value; store.emit('preview:typed'); }, { title: 'A pangram for every script you have switched on' });
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
  // Write on: the preview text draws itself stroke by stroke on a canvas laid over `out`
  const stage = h('div', { class: 'preview-stage' });
  let woStop: (() => void) | null = null;
  const hasBuilt = () => Object.values(store.built).some((b) => b.contours.length);
  const WO_TITLE = 'Watch your letters write themselves, stroke by stroke';
  const writeOnBtn = iconButton('play', 'Write on', () => { if (woStop) woStop(); else startWriteOn(); }, { title: WO_TITLE, testid: 'btn-writeon' });
  writeOnBtn.setAttribute('aria-pressed', 'false');
  const syncWriteOn = () => { const ok = hasBuilt(); writeOnBtn.disabled = !ok && !woStop; writeOnBtn.title = ok ? WO_TITLE : 'Draw or import some letters first, then watch them write themselves'; };
  store.subscribe((ev) => { if (ev === 'built' || ev === 'project:loaded') syncWriteOn(); });
  syncWriteOn();
  const startWriteOn = () => {
    if (!hasBuilt()) return;
    const fontPx = parseFloat(out.style.fontSize) || 64;
    const plan = writeOnPlan(store.project.previewText, { metrics: store.project.metrics, glyphs: store.project.glyphs, built: store.built, lineGap: 1.15, maxDurationMs: 9000 });
    if (!plan.items.length) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssW = out.offsetWidth, cssH = out.offsetHeight;
    const canvas = h('canvas', { class: 'writeon-canvas', width: Math.max(1, Math.round(cssW * dpr)), height: Math.max(1, Math.round(cssH * dpr)), 'aria-hidden': 'true',
      style: { left: out.offsetLeft + 'px', top: out.offsetTop + 'px', width: cssW + 'px', height: cssH + 'px' } });
    stage.append(canvas);
    out.style.visibility = 'hidden';
    const ctx = canvas.getContext('2d')!;
    const opts = { pad: 14 * dpr, maxScale: (fontPx / 1000) * dpr, align: 'start' as const };
    const HOLD = 800;
    let raf = 0;
    const t0 = performance.now();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') woStop?.(); };
    woStop = () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKey);
      canvas.remove();
      out.style.visibility = '';
      woStop = null;
      writeOnBtn.classList.remove('primary');
      writeOnBtn.setAttribute('aria-pressed', 'false');
      syncWriteOn();
    };
    document.addEventListener('keydown', onKey);
    writeOnBtn.classList.add('primary');
    writeOnBtn.setAttribute('aria-pressed', 'true');
    const frame = () => {
      const t = performance.now() - t0;
      drawWriteOnFrame(ctx, plan, t, opts);
      if (t >= plan.durationMs + HOLD) { woStop?.(); return; }
      raf = requestAnimationFrame(frame);
    };
    frame();
  };
  // OpenType feature chips (stylistic sets, tabular figures)
  const chips = h('div', { class: 'featchips', 'data-testid': 'feature-chips' });
  const FEAT_LABEL: Record<string, string> = { ss01: 'Stylistic set 1', ss02: 'Stylistic set 2', ss03: 'Stylistic set 3', tnum: 'Tabular figures' };
  const renderChips = () => {
    const avail = availableFeatures();
    store.features = store.features.filter((f) => avail.includes(f));
    chips.replaceChildren(...avail.map((f) => {
      const on = store.features.includes(f);
      const b = h('button', { type: 'button', class: 'chip' + (on ? ' on' : ''), 'aria-pressed': String(on), title: FEAT_LABEL[f] ?? f, 'data-feature': f }, f);
      b.addEventListener('click', () => { store.features = on ? store.features.filter((x) => x !== f) : [...store.features, f]; renderChips(); store.emit('features'); });
      return b;
    }));
    chips.style.display = avail.length ? '' : 'none';
    out.style.fontFeatureSettings = featureCss();
  };
  store.subscribe((ev) => { if (ev === 'glyph' || ev === 'project:loaded' || ev === 'features') renderChips(); });
  renderChips();
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
    (stage.append(out), stage), chips, h('div', { class: 'row' }, size, sample, livingBtn, writeOnBtn), h('details', { class: 'plain', 'data-testid': 'preview-plain' }, h('summary', {}, 'Edit as plain text'), text), status,
  );
}
