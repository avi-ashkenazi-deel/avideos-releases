import { store } from './state';
import { installPreviewFont } from './preview';
import type { BuildResponse } from '../worker/pipeline.worker';

let worker: Worker | null = null;
let nextId = 1;
let timer: number | null = null;

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('../worker/pipeline.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = async (ev: MessageEvent<BuildResponse | { id: number; type: 'error'; message: string }>) => {
    const msg = ev.data;
    if (msg.id !== nextId - 1) return; // stale
    store.busy = false;
    if (msg.type === 'error') { store.status = 'Build error: ' + msg.message; store.emit('status'); return; }
    store.built = msg.partial ? { ...store.built, ...(msg.glyphs as any) } : (msg.glyphs as any);
    store.lastBuildMs = msg.ms;
    store.otf = msg.otf;
    store.busy = !!msg.partial && !msg.final;
    store.status = msg.partial && msg.final ? `preview ${Object.keys(msg.glyphs).length} glyphs in ${msg.ms.toFixed(0)} ms` : msg.partial ? `preview ready (${Object.keys(msg.glyphs).length} glyphs, ${msg.ms.toFixed(0)} ms) — building the rest…` : `built ${Object.keys(msg.glyphs).length} glyphs in ${msg.ms.toFixed(0)} ms`;
    store.emit('built');
    if (msg.otf) await installPreviewFont(msg.otf.slice(0));
    store.emit(msg.partial && msg.final ? 'font:preview' : 'font');
  };
  worker.onerror = (e) => { store.busy = false; store.status = 'Worker crashed: ' + e.message; store.emit('status'); };
  return worker;
}

/** Debounced rebuild of every glyph + the preview OTF. */
export function scheduleBuild(delay = 120, opts: { previewOnly?: boolean } = {}): void {
  if (timer) clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = null;
    store.busy = true; store.emit('status');
    const id = nextId++;
    const priority = [...new Set([...store.project.previewText.replace(/\s/g, ''), store.selected])];
    getWorker().postMessage({ id, type: 'build', project: store.project, otf: true, priority, onlyPriority: !!opts.previewOnly });
  }, delay);
}
