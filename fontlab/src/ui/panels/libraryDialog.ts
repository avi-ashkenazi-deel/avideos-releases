import type { FontProject } from '../../core/glyph';
import { h, button, toast, fileInput } from '../dom';
import { store, type Store } from '../state';
import { parseProject } from '../../project/schema';
import {
  listFonts, saveFont, loadFont, deleteFont, duplicateFont, renameFont,
  getCurrentId, setCurrentId, type FontMeta,
} from '../../project/library';

export interface LibraryOptions {
  /** called after the user picks a font; the current id is already set to `meta.id` */
  onOpen: (p: FontProject, meta: FontMeta) => void;
  /** "Save current as new…": the dialog sets the name on store.project, then calls this */
  onSaveCurrent: () => Promise<FontMeta | null>;
}

/**
 * Save `store.project` into the library under the font it was opened from, or as a
 * new font when `asNew` or nothing is current. Sets the current id. The host's
 * Font → Save / Save as menu items call this.
 */
export async function saveCurrent(s: Store, opts: { asNew?: boolean; thumb?: string } = {}): Promise<FontMeta> {
  const id = opts.asNew ? undefined : (getCurrentId() ?? undefined);
  const meta = await saveFont(s.project, id, { thumb: opts.thumb });
  setCurrentId(meta.id);
  return meta;
}

/** Modal: every saved font, with open / duplicate / rename / delete, plus save-as-new and import. */
export function openLibrary(opts: LibraryOptions): HTMLDialogElement {
  const dlg = h('dialog', { class: 'modal library' });
  const list = h('div', { class: 'libtable' });
  const status = h('div', { class: 'status' });

  const saveAs = button('Save current as new…', async () => {
    const name = prompt('Name for this font', store.project.name);
    if (name == null) return;
    const clean = name.trim();
    if (clean) store.update((p) => { p.name = clean; }, 'project');
    try {
      const meta = await opts.onSaveCurrent();
      if (meta) toast(`Saved "${meta.name}"`);
    } catch (e) { toast(errMsg(e)); }
    await refresh();
  }, 'primary');

  const importInput = fileInput('.json,application/json', async (f) => {
    try {
      const p = parseProject(JSON.parse(await f.text()));
      const meta = await saveFont(p);
      toast(`Imported "${meta.name}"`);
    } catch (e) { toast('Import failed: ' + errMsg(e)); }
    await refresh();
  });
  const importBtn = button('Import .json', () => importInput.click());

  dlg.append(
    h('h2', {}, 'My fonts'),
    h('div', { class: 'row' }, saveAs, importBtn, importInput),
    list,
    status,
    h('div', { class: 'row' }, button('Close', () => dlg.close())),
  );
  document.body.append(dlg);
  dlg.showModal();
  dlg.addEventListener('close', () => dlg.remove());

  const refresh = async () => {
    let fonts: FontMeta[];
    try { fonts = await listFonts(); } catch (e) { status.textContent = 'Could not read the library: ' + errMsg(e); return; }
    const current = getCurrentId();
    list.replaceChildren(...fonts.map((m) => row(m, m.id === current)));
    status.textContent = fonts.length ? '' : "No saved fonts yet. Save the one you're working on with Font → Save.";
  };

  const row = (m: FontMeta, isCurrent: boolean): HTMLElement => {
    const name = h('span', { class: 'libname', title: 'Click to rename', tabindex: 0, role: 'button' }, m.name);
    const startRename = () => {
      const input = h('input', { type: 'text', class: 'libname', value: m.name, 'aria-label': 'Font name' });
      let finished = false;
      const finish = async (commit: boolean) => {
        if (finished) return; finished = true;
        const next = input.value.trim();
        if (commit && next && next !== m.name) {
          try {
            await renameFont(m.id, next);
            if (getCurrentId() === m.id) store.update((p) => { p.name = next; }, 'project');
          } catch (e) { toast(errMsg(e)); }
        }
        await refresh();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      input.addEventListener('blur', () => finish(true));
      name.replaceWith(input);
      input.focus(); input.select();
    };
    name.addEventListener('click', startRename);
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startRename(); } });

    const meta = h('span', { class: 'libmeta muted' },
      `${m.glyphCount} glyph${m.glyphCount === 1 ? '' : 's'}`, ' · ',
      m.blocks.length ? m.blocks.join(', ') : 'latin', ' · ',
      `updated ${timeAgo(m.updatedAt)}`,
    );

    const open = button(isCurrent ? 'Reopen' : 'Open', async () => {
      try {
        const p = await loadFont(m.id);
        if (!p) { toast('That font is no longer in the library'); await refresh(); return; }
        setCurrentId(m.id);
        dlg.close();
        opts.onOpen(p, m);
      } catch (e) { toast('Could not open: ' + errMsg(e)); }
    }, isCurrent ? '' : 'primary');
    const dup = button('Duplicate', async () => {
      try { const c = await duplicateFont(m.id); toast(`Created "${c.name}"`); } catch (e) { toast(errMsg(e)); }
      await refresh();
    });
    const del = button('Delete', async () => {
      if (!confirm(`Delete "${m.name}"? This cannot be undone.`)) return;
      try { await deleteFont(m.id); toast(`Deleted "${m.name}"`); } catch (e) { toast(errMsg(e)); }
      await refresh();
    });

    return h('div', { class: 'librow' + (isCurrent ? ' current' : ''), 'data-id': m.id },
      h('div', { class: 'libinfo' }, name, meta),
      h('div', { class: 'libactions' }, open, dup, del),
    );
  };

  status.textContent = 'Loading…';
  refresh();
  return dlg;
}

/** "just now", "3 min ago", "2 h ago", "yesterday", "5 days ago", else a short date. */
export function timeAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr} h ago`;
  const d = Math.round(hr / 24);
  if (d === 1) return 'yesterday';
  if (d < 30) return `${d} days ago`;
  return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
