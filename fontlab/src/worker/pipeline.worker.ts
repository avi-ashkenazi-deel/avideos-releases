/// <reference lib="webworker" />
import { buildAll } from '../pipeline/build';
import type { FontProject } from '../core/glyph';

export interface BuildRequest { id: number; type: 'build'; project: FontProject; otf: boolean; /** characters to build first (preview text) */ priority?: string[] }
export interface BuildResponse { id: number; type: 'result'; /** true for the quick first pass; a full result follows */ partial?: boolean; glyphs: Record<string, { char: string; unicode: number; advance: number; contours: { points: [number, number][] }[] }>; otf: ArrayBuffer | null; ms: number }

let pending: BuildRequest | null = null;
let busy = false;

self.onmessage = (ev: MessageEvent<BuildRequest>) => {
  pending = ev.data; // latest request wins; older ones are dropped
  if (!busy) drain();
};

function drain() {
  busy = true;
  // yield so a burst of slider events collapses into one build
  setTimeout(() => {
    const req = pending; pending = null;
    if (!req) { busy = false; return; }
    try {
      const all = Object.keys(req.project.glyphs);
      const prio = (req.priority ?? []).filter((ch) => req.project.glyphs[ch]);
      if (prio.length && prio.length < all.length) {
        // quick pass: just the preview text, so typing feels instant on big charsets
        const first = buildAll(req.project, { otf: req.otf, chars: prio });
        const msg1: BuildResponse = { id: req.id, type: 'result', partial: true, glyphs: first.glyphs, otf: first.otf, ms: first.ms };
        (self as any).postMessage(msg1, first.otf ? [first.otf] : []);
        if (pending) { if (pending) drain(); else busy = false; return; } // newer request arrived meanwhile
      }
      const res = buildAll(req.project, { otf: req.otf });
      const msg: BuildResponse = { id: req.id, type: 'result', glyphs: res.glyphs, otf: res.otf, ms: res.ms };
      (self as any).postMessage(msg, res.otf ? [res.otf] : []);
    } catch (e) {
      (self as any).postMessage({ id: req.id, type: 'error', message: String(e) });
    }
    if (pending) drain(); else busy = false;
  }, 0);
}
