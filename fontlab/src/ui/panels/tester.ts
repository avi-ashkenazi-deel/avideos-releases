import { h, button, slider } from '../dom';
import { store } from '../state';
import { PREVIEW_FAMILY } from '../preview';
import { BLOCKS } from '../../core/charsets';

/** In-app type tester: edit live text set in the current font, waterfall, axes. */
export function openTypeTester(): void {
  const dlg = h('dialog', { class: 'modal tester' });
  const enabled = new Set([...store.project.blocks, 'latin']);
  const samples = BLOCKS.filter((b) => enabled.has(b.id)).map((b) => ({ title: b.name, text: b.sample, rtl: !!b.rtl }));
  let size = 72, lh = 1.15, ls = 0, dark = false, useVar = false;
  const vf = store.variableAxes;
  const axisValues: Record<string, number> = Object.fromEntries((vf ?? []).map((a) => [a.tag, a.default]));

  const sheet = h('div', { class: 'tester-sheet' });
  const applyStyle = () => {
    sheet.style.setProperty('--ts', size + 'px');
    sheet.style.setProperty('--tlh', String(lh));
    sheet.style.setProperty('--tls', ls + 'em');
    sheet.style.fontFamily = `'${useVar && vf ? 'FunkyVarPreview' : PREVIEW_FAMILY}', monospace`;
    sheet.style.fontVariationSettings = useVar && vf ? vf.map((a) => `'${a.tag}' ${axisValues[a.tag]}`).join(', ') : 'normal';
    dlg.classList.toggle('dark', dark);
  };
  const block = (text: string, rtl: boolean, title: string, onEdit?: (t: string) => void) => {
    const el = h('div', { class: 'tblock', contenteditable: 'true', spellcheck: false, dir: rtl ? 'rtl' : 'ltr', 'data-title': title, role: 'textbox', 'aria-label': title }, text);
    if (onEdit) el.addEventListener('input', () => onEdit(el.textContent ?? ''));
    return el;
  };
  const free = block(store.project.previewText, false, 'Type here', (t) => { store.project.previewText = t; store.emit('preview:text'); });
  sheet.append(h('div', { class: 'tlabel' }, 'Type here'), free);
  for (const s of samples) sheet.append(h('div', { class: 'tlabel' }, s.title), block(s.text, s.rtl, s.title));
  const waterfall = h('div', { class: 'waterfall' });
  const renderWaterfall = () => {
    const line = (store.project.previewText.split('\n')[0] || 'Hamburgefonstiv').slice(0, 40);
    waterfall.replaceChildren(h('div', { class: 'tlabel' }, 'Waterfall'), ...[14, 18, 24, 36, 48, 72].map((px) => h('div', { class: 'wline', style: { fontSize: px + 'px' } }, h('span', { class: 'px' }, px + ' '), line)));
  };
  renderWaterfall();
  free.addEventListener('input', renderWaterfall);

  const controls = h('div', { class: 'row tcontrols' },
    slider('Size', { min: 12, max: 220, step: 1, value: size, onInput: (v) => { size = v; applyStyle(); }, format: (v) => v.toFixed(0) + 'px' }),
    slider('Line', { min: 0.8, max: 2.2, step: 0.01, value: lh, onInput: (v) => { lh = v; applyStyle(); } }),
    slider('Spacing', { min: -0.1, max: 0.5, step: 0.005, value: ls, onInput: (v) => { ls = v; applyStyle(); }, format: (v) => v.toFixed(3) + 'em' }),
    button('☾ Dark', () => { dark = !dark; applyStyle(); }),
  );
  if (vf) {
    const varBtn = button('Variable: off', () => { useVar = !useVar; varBtn.textContent = useVar ? 'Variable: on' : 'Variable: off'; varBtn.classList.toggle('primary', useVar); applyStyle(); });
    controls.append(varBtn, ...vf.map((a) => slider(a.tag, { min: a.min, max: a.max, step: (a.max - a.min) / 200, value: a.default, onInput: (v) => { axisValues[a.tag] = v; useVar = true; varBtn.textContent = 'Variable: on'; varBtn.classList.add('primary'); applyStyle(); }, format: (v) => v.toFixed(0) })));
  }
  dlg.append(
    h('div', { class: 'row' }, h('h2', {}, '🧪 Type tester ', h('small', {}, 'everything here is editable · uses the live font')), h('span', { class: 'spacer' }), button('Close', () => dlg.close())),
    controls, sheet, waterfall,
  );
  applyStyle();
  document.body.append(dlg);
  dlg.showModal();
  dlg.addEventListener('close', () => dlg.remove());
  // re-render when the font updates while open
  const unsub = store.subscribe((ev) => { if (ev === 'font' || ev === 'font:preview') applyStyle(); });
  dlg.addEventListener('close', unsub);
}
