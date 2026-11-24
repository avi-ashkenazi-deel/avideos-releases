import { h, button, toast } from '../dom';
import { store } from '../state';
import type { FontProject } from '../../core/glyph';
import { listVersions, loadVersion, saveVersion, deleteVersion, renameVersion, diffProjects, versionsPersist, type VersionMeta } from '../../project/versions';
import { currentFontKey, previewSvg, autoVersion } from '../versions';
import { timeAgo } from './libraryDialog';

export interface VersionsOptions {
  /** replace the open font's contents with this state (same font) */
  onRestore: (p: FontProject) => void | Promise<void>;
  /** open this state as a separate new font */
  onBranch: (p: FontProject) => void | Promise<void>;
}

const svgUrl = (svg: string) => (svg ? 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) : '');
const listChars = (chars: string[]) => (chars.length > 14 ? chars.slice(0, 14).join(' ') + ` … (${chars.length})` : chars.join(' '));

/** Font → Versions…: named snapshots you can compare, restore or branch from. */
export function openVersions(opts: VersionsOptions): HTMLDialogElement {
  const dlg = h('dialog', { class: 'modal versions', 'data-testid': 'versions-dialog' });
  const list = h('div', { class: 'libtable vertable' });
  const status = h('div', { class: 'status' });
  const compare = h('div', { class: 'vercompare', style: { display: 'none' } });
  const nameInput = h('input', { type: 'text', placeholder: 'Name this version, e.g. “before the bold experiment”', 'aria-label': 'Version name', class: 'vername', 'data-testid': 'version-name' }) as HTMLInputElement;

  const saveBtn = button('Save version', async () => {
    try {
      const meta = await saveVersion(currentFontKey(), store.project, { name: nameInput.value || `Version ${new Date().toLocaleString()}`, preview: previewSvg(store.project, store.built) });
      nameInput.value = '';
      toast(`Saved version “${meta.name}”`);
      await refresh();
    } catch (e) { toast('Could not save the version: ' + (e as Error).message); }
  }, 'primary');
  saveBtn.dataset.testid = 'version-save';
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveBtn.click(); } });

  const showCompare = async (v: VersionMeta) => {
    const p = await loadVersion(v.id);
    if (!p) { toast('That version could not be read.'); return; }
    const d = diffProjects(p, store.project); // what changed since the version
    const facts: string[] = [];
    if (d.added.length) facts.push(`Added since: ${listChars(d.added)}`);
    if (d.removed.length) facts.push(`Removed since: ${listChars(d.removed)}`);
    if (d.changed.length) facts.push(`Redrawn since: ${listChars(d.changed)}`);
    if (d.effects) facts.push('Effects or colours changed');
    if (d.spacing) facts.push('Spacing or kerning changed');
    if (d.metrics) facts.push('Metrics changed');
    if (d.name) facts.push(`Renamed (was “${p.name}”)`);
    if (!facts.length) facts.push('Identical to the font as it is now.');
    const img = (svg: string, label: string) => h('figure', { class: 'verfig' }, h('figcaption', {}, label), svg ? h('img', { src: svgUrl(svg), alt: label }) : h('div', { class: 'muted' }, 'no preview'));
    compare.replaceChildren(
      h('div', { class: 'verpair' }, img(v.preview, `“${v.name}” · ${timeAgo(v.createdAt)}`), img(previewSvg(store.project, store.built), 'Now')),
      h('ul', { class: 'verfacts', 'data-testid': 'version-diff' }, ...facts.map((f) => h('li', {}, f))),
    );
    compare.style.display = '';
  };

  const row = (v: VersionMeta) => {
    const name = h('strong', { class: 'libname', title: 'Click to rename', tabindex: 0, role: 'button' }, v.name);
    const rename = async () => {
      const n = prompt('Rename version', v.name);
      if (n && n.trim()) { await renameVersion(v.id, n); await refresh(); }
    };
    name.addEventListener('click', rename);
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') void rename(); });
    return h('div', { class: 'librow verrow', 'data-testid': 'version-row' },
      h('div', { class: 'libinfo' },
        v.preview ? h('img', { class: 'verthumb', src: svgUrl(v.preview), alt: '' }) : h('span', {}),
        h('div', {}, name, v.auto ? h('span', { class: 'tag' }, 'automatic') : null, h('div', {}, h('small', {}, `${timeAgo(v.createdAt)} · ${new Date(v.createdAt).toLocaleString()} · ${v.glyphCount} letters`)))),
      button('Compare', () => void showCompare(v)),
      button('Restore', async () => {
        if (!confirm(`Restore “${v.name}”? The font as it is now is saved as an automatic version first.`)) return;
        const p = await loadVersion(v.id);
        if (!p) { toast('That version could not be read.'); return; }
        await autoVersion(`Before restoring “${v.name}”`);
        await opts.onRestore(p);
        toast(`Restored “${v.name}”`);
        dlg.close();
      }),
      button('Open as new font', async () => {
        const p = await loadVersion(v.id);
        if (!p) { toast('That version could not be read.'); return; }
        p.name = `${p.name} (${v.name})`.slice(0, 80);
        await opts.onBranch(p);
        dlg.close();
      }),
      button('Delete', async () => { if (confirm(`Delete version “${v.name}”?`)) { await deleteVersion(v.id); await refresh(); } }),
    );
  };

  const refresh = async () => {
    const versions = await listVersions(currentFontKey());
    list.replaceChildren(...(versions.length ? versions.map(row) : [h('div', { class: 'fxempty' }, 'No versions yet. Save one before trying something risky; FontLab also saves one automatically before a reset, a font import, auto spacing or a restore.')]));
    status.textContent = (await versionsPersist()) ? `${versions.length} version${versions.length === 1 ? '' : 's'} of “${store.project.name}”, stored in this browser.` : 'This browser blocks storage here, so versions last only until you close the tab.';
  };

  dlg.append(
    h('h2', {}, 'Versions'),
    h('p', { class: 'muted' }, 'Snapshots of this font. Compare one with the font as it is now, go back to it, or open it as a separate font to try an alternative.'),
    h('div', { class: 'row' }, nameInput, saveBtn),
    list, compare, status,
    h('div', { class: 'row' }, button('Close', () => dlg.close())),
  );
  document.body.append(dlg); dlg.showModal(); dlg.addEventListener('close', () => dlg.remove());
  void refresh();
  return dlg;
}
