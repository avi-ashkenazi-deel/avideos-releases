// Entry point: shared state and a two-view hash router (#capture, #admin).

import { loadPolicy, loadSubmissions } from './policy.js';
import { CaptureFlow } from './capture.js';
import { AdminView } from './admin.js';

const state = {
  policy: loadPolicy(),
  submissions: loadSubmissions(),
  session: null,
  name: (() => { try { return localStorage.getItem('hs.name') || ''; } catch { return ''; } })(),
};

const root = document.getElementById('app');
let view = null;

function route() {
  const name = location.hash === '#admin' ? 'admin' : 'capture';
  view?.unmount();
  document.querySelectorAll('.tab').forEach((t) => {
    if (t.id === 'nav-' + name) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  });
  view = name === 'admin' ? new AdminView(root, state) : new CaptureFlow(root, state);
  view.mount();
  window.scrollTo(0, 0);
}

// Keep tabs in this browser in sync when the admin edits the policy elsewhere.
window.addEventListener('storage', (e) => {
  if (e.key === 'hs.policy.v1') state.policy = loadPolicy();
  if (e.key === 'hs.submissions.v1') state.submissions = loadSubmissions();
});

window.addEventListener('hashchange', route);
route();

// Exposed for automated tests.
window.__hs = state;
