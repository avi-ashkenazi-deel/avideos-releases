import { describe, it, expect } from 'vitest';
import { History } from '../../src/ui/history';
import { newProject, type Glyph } from '../../src/core/glyph';

const g = (ch: string, n = 1): Glyph => ({ char: ch, unicode: ch.codePointAt(0)!, advance: 500, source: 'drawn', kind: 'stroke', strokes: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, cap: 'round', points: [{ x: 0, y: 0, w: 20, p: 0.5 }, { x: 100, y: 100, w: 20, p: 0.5 }] })) });

describe('project history', () => {
  it('undo restores the state before the change and redo re-applies it', () => {
    let t = 0; const h = new History(20, 300, () => t);
    const p = newProject();
    p.glyphs.a = g('a');
    t = 1000; h.record(p, 'glyph'); delete p.glyphs.a; // delete letter
    expect(p.glyphs.a).toBeUndefined();
    expect(h.undo(p)).toBe(true);
    expect(p.glyphs.a?.strokes?.length).toBe(1);
    expect(h.redo(p)).toBe(true);
    expect(p.glyphs.a).toBeUndefined();
    expect(h.redo(p)).toBe(false);
  });
  it('snapshots are deep: later mutation does not leak into history', () => {
    let t = 0; const h = new History(20, 300, () => t);
    const p = newProject(); p.glyphs.a = g('a', 1);
    t = 1000; h.record(p, 'glyph'); p.glyphs.a.strokes!.push(g('a').strokes![0]);
    t = 2000; h.record(p, 'glyph'); p.glyphs.a.strokes!.push(g('a').strokes![0]);
    expect(p.glyphs.a.strokes!.length).toBe(3);
    h.undo(p); expect(p.glyphs.a.strokes!.length).toBe(2);
    h.undo(p); expect(p.glyphs.a.strokes!.length).toBe(1);
    expect(h.canUndo()).toBe(false);
  });
  it('coalesces bursts from the same event and caps the stack', () => {
    let t = 0; const h = new History(5, 300, () => t);
    const p = newProject(); p.glyphs.a = g('a');
    t = 0; expect(h.record(p, 'glyph')).toBe(true);
    t = 100; expect(h.record(p, 'glyph')).toBe(false); // slider drag burst
    t = 200; expect(h.record(p, 'project')).toBe(true); // different source is a new entry
    for (let i = 0; i < 10; i++) { t += 1000; h.record(p, 'glyph'); }
    let n = 0; while (h.undo(p)) n++;
    expect(n).toBe(5);
  });
  it('a new change after undo drops the redo branch; clear empties both', () => {
    let t = 0; const h = new History(20, 300, () => t);
    const p = newProject(); p.glyphs.a = g('a');
    t = 1000; h.record(p, 'glyph'); delete p.glyphs.a;
    h.undo(p); expect(h.canRedo()).toBe(true);
    t = 2000; h.record(p, 'glyph'); p.glyphs.b = g('b');
    expect(h.canRedo()).toBe(false);
    h.clear(); expect(h.canUndo()).toBe(false);
  });
});
