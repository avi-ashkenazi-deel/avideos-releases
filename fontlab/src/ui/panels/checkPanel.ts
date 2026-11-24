import { h, button, toast } from '../dom';
import { icon } from '../icons';
import { store } from '../state';
import { scheduleBuild } from '../buildClient';
import { runChecks, applyFix, type Issue, type FixId } from '../../check/checks';

/** Fixes that need app-level actions (set by the header: naming the font, auto spacing). */
export const fixHandlers: Partial<Record<FixId, () => void | Promise<void>>> = {};
/** Extra data for the checks that the store does not hold (auto kerning pairs). */
export const checkExtras: { kerning?: () => Record<string, number> | undefined } = {};

let last: Issue[] = [];
export function currentIssues(): Issue[] { return last; }

export function refreshChecks(): Issue[] {
  try { last = runChecks(store.project, store.built, { kerning: checkExtras.kerning?.() }); } catch (e) { console.error(e); last = []; }
  store.emit('checks');
  return last;
}

const SEV_LABEL = { error: 'Problem', warn: 'Worth a look', info: 'Note' } as const;
const openNotes = () => (store.project.notes ?? []).filter((n) => !n.done);

/** Header button: runs the checks after every full build and shows how many need attention. */
export function checkButton(): HTMLElement {
  const count = h('span', { class: 'checkcount' });
  const btn = h('button', { type: 'button', class: 'ib', title: 'Automatic checks on your font, and your review notes', 'data-testid': 'btn-check' }, icon('check'), h('span', {}, 'Check'), count);
  btn.addEventListener('click', () => openCheckPanel());
  let t: number | null = null;
  const sync = () => {
    const n = last.filter((i) => i.severity !== 'info').length, notes = openNotes().length;
    count.textContent = n + notes ? String(n + notes) : '';
    count.classList.toggle('on', n + notes > 0);
    count.classList.toggle('err', last.some((i) => i.severity === 'error'));
  };
  store.subscribe((ev) => {
    if (ev === 'font' || ev === 'project:loaded') { if (t) clearTimeout(t); t = window.setTimeout(refreshChecks, 350); }
    if (ev === 'checks' || ev === 'notes' || ev === 'glyph') sync();
  });
  return btn;
}

export function openCheckPanel(tab: 'checks' | 'notes' = 'checks'): HTMLDialogElement {
  const dlg = h('dialog', { class: 'modal checkpanel', 'data-testid': 'check-panel' });
  const body = h('div', { class: 'checkbody' });
  let current = tab;
  const jump = (ch: string) => { dlg.close(); store.selected = ch; store.emit('select'); };
  const chips = (chars: string[]) => {
    const shown = chars.slice(0, 60);
    return h('div', { class: 'checkchars' },
      ...shown.map((c) => ([...c].length === 1
        ? h('button', { type: 'button', class: 'chbtn', title: `Open “${c}”`, onClick: () => jump(c) }, c)
        : h('span', { class: 'chbtn pair', title: 'pair' }, c))),
      chars.length > shown.length ? h('span', { class: 'muted' }, ` +${chars.length - shown.length} more`) : null);
  };
  const runFix = async (issue: Issue) => {
    const fix = issue.fix!;
    const custom = fixHandlers[fix.id];
    if (custom) { await custom(); refreshChecks(); render(); return; }
    let msg = '';
    store.update((p) => { msg = applyFix(p, store.built, fix.id).message; }, 'project');
    scheduleBuild(0);
    toast(msg || 'Done');
    // the rebuild re-runs the checks; show the fresh list when it lands
    const off = store.subscribe((ev) => { if (ev === 'checks') { off(); if (dlg.isConnected) render(); } });
  };
  const checksView = () => {
    const issues = last;
    if (!issues.length) return [h('div', { class: 'checkok' }, icon('check', 20), ' No problems found. ', h('span', { class: 'muted' }, 'Checks run after every build.'))];
    return issues.map((i) => h('div', { class: `checkitem sev-${i.severity}`, 'data-check': i.id },
      h('div', { class: 'checkhead' }, h('span', { class: 'sev' }, SEV_LABEL[i.severity]), h('strong', {}, i.title),
        i.fix && (fixHandlers[i.fix.id] || !['name-font', 'auto-space'].includes(i.fix.id)) ? button(i.fix.label, () => void runFix(i), 'primary') : null),
      h('p', {}, i.detail),
      i.chars.length ? chips(i.chars) : null));
  };
  const notesView = () => {
    const notes = [...(store.project.notes ?? [])].sort((a, b) => Number(!!a.done) - Number(!!b.done) || b.createdAt - a.createdAt);
    if (!notes.length) return [h('div', { class: 'checkok' }, 'No review notes yet. ', h('span', { class: 'muted' }, 'Use the Note tool in the Draw tab to pin a note to a spot on a letter, or import notes from a reviewer (Font menu).'))];
    return notes.map((n) => h('div', { class: 'checkitem note' + (n.done ? ' done' : ''), 'data-note': n.id },
      h('div', { class: 'checkhead' },
        h('button', { type: 'button', class: 'chbtn', title: `Open “${n.ch}”`, onClick: () => jump(n.ch) }, n.ch),
        h('strong', {}, n.done ? 'Resolved' : 'Open'), n.author ? h('span', { class: 'muted' }, ` · ${n.author}`) : null,
        h('span', { class: 'muted' }, ` · ${new Date(n.createdAt).toLocaleDateString()}`),
        button(n.done ? 'Reopen' : 'Resolve', () => { store.update((p) => { const x = p.notes.find((y) => y.id === n.id); if (x) x.done = !x.done; }, 'glyph'); store.emit('notes'); render(); }),
        button('Delete', () => { store.update((p) => { p.notes = p.notes.filter((y) => y.id !== n.id); }, 'glyph'); store.emit('notes'); render(); })),
      h('p', {}, n.text)));
  };
  const tabBtn = (id: 'checks' | 'notes', label: string) => {
    const b = h('button', { type: 'button', class: 'tab' + (current === id ? ' active' : ''), role: 'tab', 'data-testid': `check-tab-${id}` }, label);
    b.addEventListener('click', () => { current = id; render(); });
    return b;
  };
  const render = () => {
    const n = last.filter((i) => i.severity !== 'info').length;
    dlg.replaceChildren(
      h('h2', {}, 'Check'),
      h('div', { class: 'tabs', role: 'tablist' }, tabBtn('checks', `Font checks${n ? ` (${n})` : ''}`), tabBtn('notes', `Review notes${openNotes().length ? ` (${openNotes().length})` : ''}`)),
      body,
      h('div', { class: 'row' }, button('Run checks again', () => { refreshChecks(); render(); }), button('Close', () => dlg.close())),
    );
    body.replaceChildren(...(current === 'checks' ? checksView() : notesView()));
  };
  refreshChecks();
  render();
  document.body.append(dlg); dlg.showModal(); dlg.addEventListener('close', () => dlg.remove());
  return dlg;
}
