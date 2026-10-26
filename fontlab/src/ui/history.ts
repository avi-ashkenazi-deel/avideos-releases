import type { FontProject, Glyph } from '../core/glyph';

interface Snapshot {
  glyphs: Record<string, Glyph>;
  blocks: FontProject['blocks'];
  customChars: FontProject['customChars'];
}

/**
 * Project-level undo/redo for everything that changes the letters of the font
 * (strokes, deletes, generate, import, re-roll, advance…). Snapshots are
 * taken *before* a change, so one entry = one action. Bursts of updates from
 * the same source (slider drags) within `coalesceMs` collapse into one entry.
 */
export class History {
  private past: Snapshot[] = [];
  private future: Snapshot[] = [];
  private lastAt = 0;
  private lastEv = '';
  constructor(public readonly limit = 20, public readonly coalesceMs = 300, private clock: () => number = () => Date.now()) {}

  /** Call before mutating `p`. Returns true when a new entry was pushed. */
  record(p: FontProject, ev = 'project'): boolean {
    const t = this.clock();
    const burst = ev === this.lastEv && t - this.lastAt < this.coalesceMs && this.past.length > 0;
    this.lastAt = t; this.lastEv = ev;
    if (burst) return false;
    this.past.push(snap(p));
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
    return true;
  }
  canUndo(): boolean { return this.past.length > 0; }
  canRedo(): boolean { return this.future.length > 0; }
  undo(p: FontProject): boolean {
    const s = this.past.pop();
    if (!s) return false;
    this.future.push(snap(p));
    apply(p, s);
    this.lastEv = ''; // the next change is a fresh entry
    return true;
  }
  redo(p: FontProject): boolean {
    const s = this.future.pop();
    if (!s) return false;
    this.past.push(snap(p));
    apply(p, s);
    this.lastEv = '';
    return true;
  }
  clear(): void { this.past = []; this.future = []; this.lastEv = ''; }
}

function snap(p: FontProject): Snapshot {
  return structuredClone({ glyphs: p.glyphs, blocks: p.blocks, customChars: p.customChars });
}
function apply(p: FontProject, s: Snapshot): void {
  p.glyphs = structuredClone(s.glyphs);
  p.blocks = structuredClone(s.blocks);
  p.customChars = structuredClone(s.customChars);
}

export const history = new History();
