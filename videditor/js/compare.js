import { api } from './api.js';
import { h, btn, svg, fmtTime } from './ui.js';

export async function renderCompare(root, { projectId, a, b, navigate, topbar }) {
  const p = await api.project(projectId);
  const vs = p.versions;
  const va = vs.find((v) => v.id === a) || vs[vs.length - 2] || vs[0];
  const vb = vs.find((v) => v.id === b) || vs[vs.length - 1];
  if (!va || !vb) { root.replaceChildren(h('div.empty', 'Need at least one version to compare.')); return; }
  let mode = localStorage.getItem('videditor.compareMode') || 'side';
  const sel = (cur, onChange) => h('select.text', { style: { width: 'auto' }, on: { change: (e) => onChange(e.target.value) } }, vs.map((v) => h('option', { value: v.id, selected: v.id === cur.id }, `${v.label}${v.postedByAgent ? ' · agent' : ''}`)));
  topbar([
    btn('Back to review', { icon: 'back', cls: 'ghost', onClick: () => navigate(`#/p/${p.id}?v=${vb.id}`) }),
    h('span.crumb', '/'), h('span.title', `${p.name} · compare`),
    h('span.spacer'),
    sel(va, (id) => navigate(`#/p/${p.id}/compare?a=${id}&b=${vb.id}`)), h('span.muted', 'vs'), sel(vb, (id) => navigate(`#/p/${p.id}/compare?a=${va.id}&b=${id}`)),
    btn(mode === 'side' ? 'Wipe' : 'Side by side', { icon: 'compare', onClick: () => { localStorage.setItem('videditor.compareMode', mode === 'side' ? 'wipe' : 'side'); renderCompare(root, { projectId, a: va.id, b: vb.id, navigate, topbar }); } }),
  ]);
  const ar = va.width && va.height ? `${va.width}/${va.height}` : '16/9';
  const A = h('video', { src: va.mediaUrl, preload: 'auto', playsinline: true, class: 'a' });
  const B = h('video', { src: vb.mediaUrl, preload: 'auto', playsinline: true, muted: true, class: 'b' });
  const handle = h('div.handle');
  const pair = mode === 'side'
    ? h('div.pair', h('div.cell', { style: { '--ar': ar } }, A, h('span.pill.lbl', va.label)), h('div.cell', { style: { '--ar': ar } }, B, h('span.pill.lbl', vb.label)))
    : h('div.pair.wipe', h('div.cell', { style: { '--ar': ar } }, A, B, handle, h('span.pill.lbl', `${va.label} | ${vb.label}`)));
  const cell = pair.querySelector('.cell');
  if (mode === 'wipe') { B.style.position = 'absolute'; B.style.inset = '0'; cell.style.setProperty('--wipe', '50%'); cell.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'touch' || true) { const r = cell.getBoundingClientRect(); const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); cell.style.setProperty('--wipe', `${x * 100}%`); } }); }
  const time = h('span.mono.muted', '0:00.0');
  const range = h('input', { type: 'range', min: 0, max: 1000, value: 0 });
  const playBtn = btn('', { icon: 'play', cls: 'icon', title: 'Play / pause (space)', onClick: toggle });
  const bar = h('div.bar', playBtn, btn('', { icon: 'stepBack', cls: 'icon ghost', title: 'Back one frame', onClick: () => seek(A.currentTime - 1 / 30) }), btn('', { icon: 'stepFwd', cls: 'icon ghost', title: 'Forward one frame', onClick: () => seek(A.currentTime + 1 / 30) }), time, range, h('span.hint', 'Playback is synced. Audio from the left version.'));
  const notes = h('div.notes2', noteCard(va), noteCard(vb));
  root.replaceChildren(h('div.compare', pair, bar, notes));

  function sync() { if (Math.abs(B.currentTime - A.currentTime) > 0.06) B.currentTime = A.currentTime; }
  function toggle() { if (A.paused) { A.play(); B.play(); } else { A.pause(); B.pause(); sync(); } }
  function seek(t) { A.currentTime = Math.max(0, t); B.currentTime = A.currentTime; }
  A.addEventListener('play', () => { playBtn.replaceChildren(svg('pause')); B.play().catch(() => {}); });
  A.addEventListener('pause', () => { playBtn.replaceChildren(svg('play')); B.pause(); });
  A.addEventListener('ended', () => B.pause());
  let raf; const tick = () => { if (!A.paused) sync(); time.textContent = fmtTime(A.currentTime); if (A.duration) range.value = Math.round((A.currentTime / A.duration) * 1000); raf = requestAnimationFrame(tick); }; tick();
  range.addEventListener('input', () => { if (A.duration) seek((range.value / 1000) * A.duration); });
  const key = (e) => { if (e.target.matches('input,textarea,select')) return; if (e.code === 'Space') { e.preventDefault(); toggle(); } if (e.key === 'ArrowLeft') seek(A.currentTime - 1 / 30); if (e.key === 'ArrowRight') seek(A.currentTime + 1 / 30); };
  document.addEventListener('keydown', key);
  root._cleanup = () => { cancelAnimationFrame(raf); document.removeEventListener('keydown', key); A.pause(); B.pause(); };
}
const noteCard = (v) => h('div.section', { style: { border: '1px solid var(--line)', borderRadius: '10px' } }, h('h3', v.label, v.postedByAgent ? h('span.pill.agent', 'agent') : null, h('span.spacer'), h('span.small.muted', `${v.feedbackCount} notes · ${v.openCount} open`)), h('div.notes', v.notes || ''));
