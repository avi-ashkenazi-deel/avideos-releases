import { describe, it, expect, beforeEach } from 'vitest';
import { saveVersion, listVersions, loadVersion, deleteVersion, renameVersion, moveVersions, deleteVersionsOf, diffProjects, versionsPersist, _resetMemoryVersions, MAX_AUTO, MAX_MANUAL, SCRATCH } from '../../src/project/versions';
import { newProject, type Glyph } from '../../src/core/glyph';

const g = (ch: string, x = 100): Glyph => ({ char: ch, unicode: ch.codePointAt(0)!, advance: 500, source: 'drawn', kind: 'stroke', strokes: [{ id: 's', cap: 'round', points: [{ x, y: 0, w: 20, p: 0.5 }, { x, y: 700, w: 20, p: 0.5 }] }] });
const proj = (name: string, chars: string) => { const p = newProject(name); for (const c of chars) p.glyphs[c] = g(c); return p; };

describe('version history', () => {
  beforeEach(() => _resetMemoryVersions());

  it('saves, lists newest first and loads a snapshot that later edits do not touch', async () => {
    expect(await versionsPersist()).toBe(false); // Node: session-only fallback
    const p = proj('Font', 'ab');
    const v1 = await saveVersion('f1', p, { name: 'First' });
    p.glyphs.c = g('c');
    const v2 = await saveVersion('f1', p, { name: 'Second' });
    const list = await listVersions('f1');
    expect(list.map((v) => v.name)).toEqual(['Second', 'First']);
    expect(list[0].glyphCount).toBe(3);
    expect(Object.keys((await loadVersion(v1.id))!.glyphs)).toEqual(['a', 'b']);
    expect(Object.keys((await loadVersion(v2.id))!.glyphs)).toEqual(['a', 'b', 'c']);
    expect(await listVersions('other')).toEqual([]);
    expect(await loadVersion('nope')).toBeNull();
  });

  it('caps manual and automatic versions separately, dropping the oldest', async () => {
    const p = proj('Font', 'a');
    for (let i = 0; i < MAX_MANUAL + 3; i++) await saveVersion('f', p, { name: `m${i}` });
    for (let i = 0; i < MAX_AUTO + 2; i++) await saveVersion('f', p, { name: `a${i}`, auto: true });
    const list = await listVersions('f');
    const manual = list.filter((v) => !v.auto), auto = list.filter((v) => v.auto);
    expect(manual.length).toBe(MAX_MANUAL);
    expect(auto.length).toBe(MAX_AUTO);
    expect(manual[manual.length - 1].name).toBe('m3');
    expect(auto[0].name).toBe(`a${MAX_AUTO + 1}`);
  });

  it('rename keeps an automatic version (it becomes manual), delete and move work', async () => {
    const p = proj('Font', 'a');
    const a = await saveVersion(SCRATCH, p, { auto: true, name: 'Before reset' });
    await renameVersion(a.id, 'Keep this');
    expect((await listVersions(SCRATCH))[0]).toMatchObject({ name: 'Keep this', auto: false });
    await moveVersions(SCRATCH, 'f9');
    expect(await listVersions(SCRATCH)).toEqual([]);
    expect((await listVersions('f9')).length).toBe(1);
    await deleteVersion(a.id);
    expect(await listVersions('f9')).toEqual([]);
    await saveVersion('f9', p); await saveVersion('f9', p);
    await deleteVersionsOf('f9');
    expect(await listVersions('f9')).toEqual([]);
  });

  it('diffProjects lists added, removed and changed letters and setting changes', () => {
    const a = proj('A', 'abc'), b = proj('B', 'bcd');
    b.glyphs.c = g('c', 140);
    b.kerning.pairs.AV = -80;
    const d = diffProjects(a, b);
    expect(d).toMatchObject({ added: ['d'], removed: ['a'], changed: ['c'], name: true, spacing: true, effects: false, metrics: false });
    expect(diffProjects(a, a)).toMatchObject({ added: [], removed: [], changed: [], name: false, spacing: false });
  });
});
