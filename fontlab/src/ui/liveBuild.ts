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
let frame: number | null = null;

export function liveRequest(): void {
  frame = null;
  if (waiting) { pending = true; return; }
  waiting = true;
  scheduleBuild(0, { previewOnly: true });
  if (guard) clearTimeout(guard);
  guard = window.setTimeout(() => { guard = null; waiting = false; if (pending) { pending = false; liveRequest(); } }, 3000);
}

/**
 * End of the gesture: one full build of every glyph. Anything still queued
 * from the gesture is cancelled first, because a late preview request would
 * replace (debounce away) this full build.
 */
export function liveFinish(): void {
  pending = false;
  if (frame != null) { cancelAnimationFrame(frame); frame = null; }
  if (guard) { clearTimeout(guard); guard = null; }
  waiting = false; // an in-flight preview result is now stale and is dropped
  scheduleBuild(0);
}

store.subscribe((ev) => {
  if (ev !== 'font:preview' || !waiting) return;
  waiting = false;
  if (guard) { clearTimeout(guard); guard = null; }
  if (pending) { pending = false; frame = requestAnimationFrame(liveRequest); }
});
