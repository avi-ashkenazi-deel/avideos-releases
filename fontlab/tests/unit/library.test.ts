import { describe, it, expect, beforeEach } from 'vitest';
import {
  listFonts, saveFont, loadFont, deleteFont, duplicateFont, renameFont,
  setCurrentId, getCurrentId, migrateLegacyAutosave, fingerprint, QUOTA_MESSAGE,
} from '../../src/project/library';
import { timeAgo } from '../../src/ui/panels/libraryDialog';
import { saveLocal, clearLocal } from '../../src/project/storage';
import { newProject, type FontProject, type Glyph } from '../../src/core/glyph';

/** Minimal in-memory Storage so the localStorage fallback path runs in Node. */
class MemStorage implements Storage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  removeItem(k: string) { this.m.delete(k); }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
}
const ls = new MemStorage();
(globalThis as any).localStorage = ls;

function glyph(char: string, w = 30): Glyph {
  return { char, unicode: char.codePointAt(0)!, advance: 500, source: 'drawn', kind: 'stroke', strokes: [{ id: 's' + char, cap: 'round', points: [{ x: 0, y: 0, w }, { x: 100, y: 200, w }] }] };
}
function project(name: string, chars = 'ab'): FontProject {
  const p = newProject(name);
  for (const c of chars) p.glyphs[c] = glyph(c);
  p.blocks = ['latin', 'cyrillic'];
  return p;
}

beforeEach(() => { ls.clear(); setCurrentId(null); });

describe('font library (localStorage fallback)', () => {
  it('saves, lists newest first and loads a round-tripped project', async () => {
    const a = await saveFont(project('Alpha', 'abc'));
    const b = await saveFont(project('Beta', 'a'));
    expect(a.id).not.toBe(b.id);
    expect(a.glyphCount).toBe(3);
    expect(a.blocks).toEqual(['latin', 'cyrillic']);
    expect(b.updatedAt).toBeGreaterThan(a.updatedAt);

    const list = await listFonts();
    expect(list.map((m) => m.name)).toEqual(['Beta', 'Alpha']);
    expect((list[0] as any).project).toBeUndefined();

    const loaded = await loadFont(a.id);
    expect(loaded).toEqual(project('Alpha', 'abc'));
    expect(await loadFont('nope')).toBeNull();
  });

  it('saveFont with an id updates in place and follows the project name', async () => {
    const first = await saveFont(project('One', 'a'));
    const p2 = project('One renamed', 'abcd');
    const second = await saveFont(p2, first.id);
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
    expect(second.name).toBe('One renamed');
    expect(second.glyphCount).toBe(4);
    const list = await listFonts();
    expect(list).toHaveLength(1);
    expect((await loadFont(first.id))!.name).toBe('One renamed');
  });

  it('keeps a thumb across saves unless replaced', async () => {
    const m = await saveFont(project('T'), undefined, { thumb: 'data:x' });
    expect(m.thumb).toBe('data:x');
    const m2 = await saveFont(project('T'), m.id);
    expect(m2.thumb).toBe('data:x');
    const m3 = await saveFont(project('T'), m.id, { thumb: 'data:y' });
    expect(m3.thumb).toBe('data:y');
  });

  it('duplicates under a new id with a (copy) suffix by default', async () => {
    const src = await saveFont(project('Orig', 'ab'));
    const copy = await duplicateFont(src.id);
    expect(copy.id).not.toBe(src.id);
    expect(copy.name).toBe('Orig (copy)');
    expect(copy.glyphCount).toBe(2);
    expect((await loadFont(copy.id))!.name).toBe('Orig (copy)');
    const named = await duplicateFont(src.id, 'Fork');
    expect(named.name).toBe('Fork');
    expect((await listFonts()).map((m) => m.name)).toEqual(['Fork', 'Orig (copy)', 'Orig']);
    await expect(duplicateFont('missing')).rejects.toThrow('Font not found');
  });

  it('renames both the record and the stored project', async () => {
    const m = await saveFont(project('Old'));
    await renameFont(m.id, '  New  ');
    const list = await listFonts();
    expect(list[0].name).toBe('New');
    expect(list[0].updatedAt).toBeGreaterThan(m.updatedAt);
    expect((await loadFont(m.id))!.name).toBe('New');
    await expect(renameFont(m.id, '   ')).rejects.toThrow();
    await expect(renameFont('missing', 'x')).rejects.toThrow('Font not found');
  });

  it('deletes, and clears the current id if it pointed at the deleted font', async () => {
    const a = await saveFont(project('A'));
    const b = await saveFont(project('B'));
    setCurrentId(a.id);
    await deleteFont(a.id);
    expect((await listFonts()).map((m) => m.id)).toEqual([b.id]);
    expect(await loadFont(a.id)).toBeNull();
    expect(getCurrentId()).toBeNull();
    await expect(deleteFont('missing')).resolves.toBeUndefined();
  });

  it('tracks the current id', () => {
    expect(getCurrentId()).toBeNull();
    setCurrentId('abc');
    expect(getCurrentId()).toBe('abc');
    setCurrentId(null);
    expect(getCurrentId()).toBeNull();
  });

  it('migrates the legacy autosave once', async () => {
    expect(await migrateLegacyAutosave()).toBeNull();
    saveLocal(project('Legacy Funk', 'xyz'));
    const meta = await migrateLegacyAutosave();
    expect(meta).not.toBeNull();
    expect(meta!.name).toBe('Legacy Funk');
    expect(meta!.glyphCount).toBe(3);
    expect(getCurrentId()).toBe(meta!.id);
    expect((await listFonts()).map((m) => m.name)).toEqual(['Legacy Funk']);
    expect(await migrateLegacyAutosave()).toBeNull();
    await deleteFont(meta!.id);
    expect(await migrateLegacyAutosave()).toBeNull();
    expect(await listFonts()).toEqual([]);
    clearLocal();
  });

  it('does not migrate into a library that already has fonts', async () => {
    await saveFont(project('Existing'));
    saveLocal(project('Legacy'));
    expect(await migrateLegacyAutosave()).toBeNull();
    expect((await listFonts()).map((m) => m.name)).toEqual(['Existing']);
    clearLocal();
  });

  it('fingerprint is stable for equal projects and changes with a glyph', () => {
    const a = project('F', 'ab'), b = project('F', 'ab');
    expect(fingerprint(a)).toBe(fingerprint(b));
    b.glyphs['a'].strokes![0].points[1].x += 1;
    expect(fingerprint(a)).not.toBe(fingerprint(b));
    const c = project('F', 'ab');
    c.glyphs['c'] = glyph('c');
    expect(fingerprint(a)).not.toBe(fingerprint(c));
  });

  it('turns a quota error into a friendly message and leaves the library intact', async () => {
    const before = await saveFont(project('Kept'));
    const orig = ls.setItem.bind(ls);
    ls.setItem = () => { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; };
    try {
      await expect(saveFont(project('Too big'))).rejects.toThrow(QUOTA_MESSAGE);
      await expect(saveFont(project('Too big'))).rejects.toThrow('Storage full: delete some fonts or export .json');
    } finally { ls.setItem = orig; }
    expect((await listFonts()).map((m) => m.id)).toEqual([before.id]);
  });
});

describe('timeAgo', () => {
  const now = 1_700_000_000_000;
  it('formats relative times', () => {
    expect(timeAgo(now, now)).toBe('just now');
    expect(timeAgo(now - 3 * 60_000, now)).toBe('3 min ago');
    expect(timeAgo(now - 2 * 3_600_000, now)).toBe('2 h ago');
    expect(timeAgo(now - 26 * 3_600_000, now)).toBe('yesterday');
    expect(timeAgo(now - 5 * 86_400_000, now)).toBe('5 days ago');
    expect(timeAgo(now - 90 * 86_400_000, now)).toMatch(/\d{4}/);
  });
});
