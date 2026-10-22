import type { FontProject } from '../core/glyph';
import { newProject } from '../core/glyph';
import type { BuiltGlyph } from '../pipeline/build';

type Listener = (ev: string) => void;

export class Store {
  project: FontProject = newProject();
  selected = 'a';
  built: Record<string, BuiltGlyph> = {};
  otf: ArrayBuffer | null = null;
  busy = false;
  lastBuildMs = 0;
  status = '';
  private listeners = new Set<Listener>();

  subscribe(l: Listener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
  emit(ev: string): void { for (const l of this.listeners) l(ev); }
  /** mutate project and notify; `ev` is a hint for which panels need to refresh */
  update(fn: (p: FontProject) => void, ev = 'project'): void { fn(this.project); this.emit(ev); }
}

export const store = new Store();
