import { h, button, slider, toast, help } from '../dom';
import { store } from '../state';
import { scheduleBuild } from '../buildClient';
import { PREVIEW_FAMILY } from '../preview';
import { autoSpaceProject } from '../../spacing';
import { autoVersion } from '../versions';

/** Re-space every letter from its shape (skips letters whose width was set by hand). One undo step. */
export async function autoSpaceAll(): Promise<number> {
  await autoVersion('Before auto spacing');
  const res = autoSpaceProject(store.project);
  const locked = Object.values(store.project.glyphs).filter((g) => g.spacingLocked).length;
  if (!res.changed.length) { toast(locked ? `Nothing to change (${locked} letters have a hand-set width).` : 'Spacing is already even.'); return 0; }
  store.update((p) => { for (const ch of res.changed) p.glyphs[ch] = res.glyphs[ch]; p.alternates = res.alternates; }, 'glyph');
  scheduleBuild(0);
  toast(`Re-spaced ${res.changed.length} letters${locked ? `, left ${locked} with a hand-set width alone` : ''}. Undo brings the old spacing back.`, 4500);
  return res.changed.length;
}

const pairOf = (s: string): string | null => { const c = [...s.replace(/\s/g, '')]; return c.length >= 2 ? c[0] + c[1] : null; };

/** Header → Spacing: tightness, auto spacing, auto kerning and a pair editor. */
export function openSpacingDialog(): HTMLDialogElement {
  const dlg = h('dialog', { class: 'modal spacing', 'data-testid': 'spacing-dialog' });
  const fontStyle = { fontFamily: `'${PREVIEW_FAMILY}', monospace` };

  // ---- spacing
  const tight = slider('Tightness', { min: 0, max: 1, step: 0.01, value: store.project.spacing.tightness, onInput: (v) => { store.update((p) => { p.spacing.tightness = v; }, 'project'); scheduleBuild(200); }, format: (v) => (v < 0.34 ? 'tight' : v > 0.66 ? 'loose' : 'normal') });
  const spaceBtn = button('Auto space all letters', () => void autoSpaceAll(), 'primary');
  spaceBtn.dataset.testid = 'btn-autospace';

  // ---- kerning
  const autoCb = h('input', { type: 'checkbox', checked: store.project.kerning.auto, id: 'kernauto', 'data-testid': 'chk-autokern' }) as HTMLInputElement;
  autoCb.addEventListener('change', () => { store.update((p) => { p.kerning.auto = autoCb.checked; }, 'glyph'); scheduleBuild(0); });
  const strength = slider('Strength', { min: 0, max: 1, step: 0.05, value: store.project.kerning.strength, onInput: (v) => { store.update((p) => { p.kerning.strength = v; }, 'project'); scheduleBuild(200); }, format: (v) => Math.round(v * 100) + '%' });
  const stats = h('div', { class: 'status', 'data-testid': 'kern-stats' });

  // ---- pair editor
  const pairInput = h('input', { type: 'text', value: 'AV', maxlength: 4, class: 'pairinput', 'aria-label': 'Pair of letters', 'data-testid': 'pair-input', spellcheck: false }) as HTMLInputElement;
  const pairView = h('div', { class: 'pairview', style: fontStyle });
  const pairPlain = h('div', { class: 'pairview plain', style: { ...fontStyle, fontKerning: 'none' }, title: 'Without kerning' });
  const valInput = h('input', { type: 'number', step: 5, min: -1000, max: 1000, class: 'pairval', 'aria-label': 'Kerning value', 'data-testid': 'pair-value' }) as HTMLInputElement;
  const pairNote = h('small', { class: 'muted' });
  const setManual = (v: number | null) => {
    const pair = pairOf(pairInput.value);
    if (!pair) return;
    const cur = store.project.kerning.pairs[pair];
    if (v === null ? cur === undefined : cur === Math.max(-1000, Math.min(1000, Math.round(v)))) return; // nothing to change, no undo step
    store.update((p) => { if (v === null) delete p.kerning.pairs[pair]; else p.kerning.pairs[pair] = Math.max(-1000, Math.min(1000, Math.round(v))); }, 'glyph');
    scheduleBuild(60);
    renderPair();
  };
  const nudge = (d: number) => setManual((Number(valInput.value) || 0) + d);
  valInput.addEventListener('change', () => setManual(Number(valInput.value) || 0));
  pairInput.addEventListener('input', () => renderPair());
  const renderPair = () => {
    const pair = pairOf(pairInput.value);
    pairView.textContent = pairPlain.textContent = pair ?? '';
    const manual = pair != null ? store.project.kerning.pairs[pair] : undefined;
    const inFont = pair != null ? store.kerning[pair] ?? 0 : 0;
    if (document.activeElement !== valInput) valInput.value = String(manual ?? inFont);
    const missing = pair ? [...pair].filter((c) => !store.built[c]?.contours.length) : [];
    pairNote.textContent = !pair ? 'Type two letters.' : missing.length ? `“${missing.join('')}” is not in the font yet.` : manual !== undefined ? `Set by hand (${manual}). In the font now: ${inFont}.` : inFont ? `Automatic: ${inFont}.` : 'No kerning on this pair.';
    resetBtn.disabled = manual === undefined;
  };
  const resetBtn = button('Back to automatic', () => setManual(null));
  const manualList = h('div', { class: 'pairchips', 'data-testid': 'manual-pairs' });
  const proof = h('div', { class: 'kernproof', style: fontStyle, contenteditable: 'true', spellcheck: false, title: 'The strongest pairs in your font. Editable.' });
  const proofToggle = h('input', { type: 'checkbox', checked: true, id: 'kernon' }) as HTMLInputElement;
  proofToggle.addEventListener('change', () => { proof.style.fontKerning = proofToggle.checked ? 'normal' : 'none'; });

  const renderLists = () => {
    const manual = Object.entries(store.project.kerning.pairs);
    manualList.replaceChildren(...(manual.length ? manual.map(([pair, v]) => {
      const chip = h('button', { type: 'button', class: 'chip pairchip', title: 'Edit this pair' }, h('span', { style: fontStyle }, pair), ` ${v}`);
      chip.addEventListener('click', () => { pairInput.value = pair; renderPair(); });
      return chip;
    }) : [h('small', { class: 'muted' }, 'No hand-set pairs.')]));
    const all = Object.entries(store.kerning);
    stats.textContent = all.length ? `${all.length} kerning pair${all.length === 1 ? '' : 's'} in the font (${manual.length} set by hand).` : store.project.kerning.auto ? 'No pairs needed kerning at this setting.' : 'Auto kerning is off. Hand-set pairs still apply.';
    if (document.activeElement !== proof) {
      const top = all.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 28).map(([pair]) => pair);
      proof.textContent = top.length ? top.join(' ') : 'AV To LT Ty r. P, nn HH oo';
    }
  };
  const off = store.subscribe((ev) => { if (ev === 'font' || ev === 'font:preview') { renderPair(); renderLists(); } });
  dlg.addEventListener('close', () => { off(); dlg.remove(); });

  dlg.append(
    h('h2', {}, 'Spacing & kerning'),
    h('h3', {}, 'Spacing', help('How much white sits beside each letter. Auto spacing measures every shape and sets the space on both sides so the rhythm is even: round letters sit closer than straight ones, open ones like T, L and r are pulled in.')),
    tight,
    h('div', { class: 'row' }, spaceBtn, h('small', { class: 'muted' }, 'Letters whose width you set by hand are left alone. A version is saved first.')),
    h('h3', {}, 'Kerning', help('Kerning adjusts single pairs that still look too far apart or too close after spacing, such as AV, To or r. — it is written into the exported font.')),
    h('div', { class: 'row' }, h('label', { class: 'toggle', for: 'kernauto' }, autoCb, ' Auto kerning'), strength),
    stats,
    h('div', { class: 'paired' },
      h('div', { class: 'pairbox' }, pairView, pairPlain),
      h('div', { class: 'pairctl' },
        h('label', {}, 'Pair ', pairInput),
        h('div', { class: 'row' }, button('−10', () => nudge(-10)), button('−5', () => nudge(-5)), valInput, button('+5', () => nudge(5)), button('+10', () => nudge(10))),
        h('div', { class: 'row' }, resetBtn), pairNote)),
    h('div', { class: 'row' }, h('strong', {}, 'Hand-set pairs'), manualList),
    h('div', { class: 'row' }, h('strong', {}, 'Strongest pairs'), h('label', { class: 'toggle', for: 'kernon' }, proofToggle, ' kerning on')),
    proof,
    h('div', { class: 'row' }, button('Close', () => dlg.close())),
  );
  renderPair(); renderLists();
  document.body.append(dlg); dlg.showModal();
  return dlg;
}
