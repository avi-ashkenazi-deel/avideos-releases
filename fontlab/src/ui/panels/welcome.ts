import { h } from '../dom';
import { icon, type IconName } from '../icons';
import { flag, setFlag } from '../../project/library';

const KEY = 'fontlab:welcomed';

const STEPS: { n: string; title: string; body: string; icon: IconName }[] = [
  { n: '01', title: 'Add letters', body: 'Draw a few with the pen, trace a photo or a video frame, or drop in a font file (.otf, .ttf, .woff, .woff2). Five or six letters are enough.', icon: 'pen' },
  { n: '02', title: 'Generate the rest', body: 'FontLab measures your letters and builds the missing alphabet in the same style. Re-roll what you do not like, lock what you do.', icon: 'sparkle' },
  { n: '03', title: 'Bend and break', body: 'Pick a preset, add effects from the menu, drag the sliders, or hit Randomize. Clean cuts keep imported fonts sharp.', icon: 'sliders' },
  { n: '04', title: 'Test and export', body: 'Type with your font in the tester, then export .otf, .ttf, SVG glyphs, a variable font or an animation.', icon: 'download' },
];

/** Full-screen first-run overlay. Returns the element; closes on click or Escape. */
export function showWelcome(force = false): HTMLElement | null {
  if (!force && flag(KEY)) return null;
  if (document.querySelector('.welcome')) return null;
  const close = () => { setFlag(KEY); overlay.remove(); window.removeEventListener('keydown', onKey, true); };
  const onKey = (e: KeyboardEvent) => { e.stopPropagation(); if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); close(); } };
  const overlay = h('div', { class: 'welcome', role: 'dialog', 'aria-label': 'Welcome to FontLab', 'data-testid': 'welcome' },
    h('div', { class: 'welcome-inner' },
      h('div', { class: 'welcome-head' }, h('h1', {}, 'FontLab'), h('p', {}, 'Make a typeface from a few letters, then bend it out of shape.')),
      h('div', { class: 'welcome-steps' }, ...STEPS.map((s) => h('div', { class: 'wstep' }, h('div', { class: 'wnum' }, s.n), icon(s.icon, 22), h('h3', {}, s.title), h('p', {}, s.body)))),
      h('p', { class: 'welcome-foot' }, 'Arrow keys move between letters · Delete removes a letter · Ctrl/Cmd+Z undoes · right-click a tile for more'),
      h('p', { class: 'welcome-tap' }, 'Click anywhere to begin'),
    ),
  );
  overlay.addEventListener('click', close);
  window.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  return overlay;
}
