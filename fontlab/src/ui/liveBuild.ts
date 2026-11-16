import { store } from './state';
import { scheduleBuild } from './buildClient';

/**
 * Throttled live rebuilds for continuous gestures (drag pad, Drift): only one
 * preview-only build is in flight; while it runs, further requests collapse
 * into one. Builds posted faster than they finish would all be dropped as
 * stale, so this is what keeps the letters moving while you drag.
 */
let waiting = false;
let pending = false;
let guard: number | null = null;

export function liveRequest(): void {
  if (waiting) { pending = true; return; }
  waiting = true;
  scheduleBuild(0, { previewOnly: true });
  if (guard) clearTimeout(guard);
  guard = window.setTimeout(() => { waiting = false; if (pending) { pending = false; liveRequest(); } }, 3000);
}

/** End of the gesture: one full build of every glyph. */
export function liveFinish(): void {
  pending = false;
  scheduleBuild(0);
}

store.subscribe((ev) => {
  if (ev !== 'font:preview' || !waiting) return;
  waiting = false;
  if (guard) { clearTimeout(guard); guard = null; }
  if (pending) { pending = false; requestAnimationFrame(liveRequest); }
});
