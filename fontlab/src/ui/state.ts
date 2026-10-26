import type { FontProject } from '../core/glyph';
import { newProject } from '../core/glyph';
import type { BuiltGlyph } from '../pipeline/build';
import { history } from './history';

type Listener = (ev: string) => void;

export class Store {
  project: FontProject = newProject();
  selected = 'a';
  built: Record<string, BuiltGlyph> = {};
  otf: ArrayBuffer | null = null;
  busy = false;
  /** preview/export without effects (auto-on after a font import) */
  bypassFx = false;
  /** axes of the variable font built this session (FontFace 'FunkyVarPreview'), if any */
  variableAxes: { tag: string; name: string; min: number; default: number; max: number }[] | null = null;
  lastBuildMs = 0;
  status = '';
  private listeners = new Set<Listener>();

  subscribe(l: Listener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
  emit(ev: string): void { if (ev === 'project:loaded') history.clear(); for (const l of this.listeners) l(ev); }
  /** mutate project and notify; `ev` is a hint for which panels need to refresh. Letter changes are recorded for Undo. */
  update(fn: (p: FontProject) => void, ev = 'project'): void {
    if (ev === 'glyph' || ev === 'project') history.record(this.project, ev);
    fn(this.project); this.emit(ev);
  }
}

export const store = new Store();
