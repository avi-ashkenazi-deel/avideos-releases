import { api } from './api.js';
import { h, btn, svg, modal, toast, relTime, fmtTime, debounce } from './ui.js';

export async function renderLibrary(root, { navigate }) {
  root.replaceChildren(h('div.library', h('div.empty', 'Loading…')));
  const state = await api.state();
  const grid = h('div.cards');
  grid.append(h('div.card.new', { on: { click: () => newProject(navigate) } }, svg('plus'), h('b', 'New project'), h('span.small.muted', 'Upload a render or link a HyperFrames folder')));
  for (const p of state.projects) grid.append(projectCard(p, navigate));
  root.replaceChildren(h('div.library',
    h('div.head', h('div', h('h1', 'Projects'), h('p.sub', 'Review renders with timestamped notes, voice and drawings. Your agent reads the feedback, edits the HyperFrames project and posts the next version.')), h('div', { style: { flex: 1 } }), btn('New project', { icon: 'plus', cls: 'primary', onClick: () => newProject(navigate) })),
    state.projects.length ? grid : h('div', grid, h('div.empty', h('p', 'No projects yet. Create one to start a review loop.'), !state.ffmpeg ? h('p.small', 'ffmpeg was not found, so thumbnails and frame extraction are off.') : null)),
  ));
}

function projectCard(p, navigate) {
  const v = p.latest;
  return h('div.card', { on: { click: () => navigate(`#/p/${p.id}`) } },
    h('div.thumb', { style: v?.posterUrl ? { backgroundImage: `url(${v.posterUrl})` } : {} }, v ? null : svg('film'), v ? h('span.pill.ver', v.label) : null, p.stats.open ? h('span.pill.open.open', `${p.stats.open} open`) : null),
    h('div.body',
      h('div.name', p.name, p.hyperframesDir ? h('span.hf', { title: p.hyperframesDir }, svg('spark'), 'HyperFrames') : null),
      h('div.meta', v ? h('span', `${p.versions.length} version${p.versions.length > 1 ? 's' : ''}`) : h('span', 'No render yet'), v?.duration ? h('span', fmtTime(v.duration)) : null, h('span', `${p.stats.total} note${p.stats.total === 1 ? '' : 's'}`)),
      p.lastActivity ? h('div.small.muted', `${p.lastActivity.author} · ${relTime(p.lastActivity.at)} · ${p.lastActivity.body}`) : h('div.small.muted', `Created ${relTime(p.createdAt)}`),
    ));
}

export async function newProject(navigate) {
  const name = h('input.text', { placeholder: 'e.g. Product launch teaser', maxlength: 120 });
  const dir = h('input.text', { placeholder: '/path/to/my-video  (folder with index.html or hyperframes.json)' });
  const status = h('div.hint', { style: { marginTop: '4px' } }, 'Optional. Linking a folder lets Videditor show which clips are on screen at each note, import existing renders, and render new versions.');
  const file = h('input', { type: 'file', accept: 'video/*', style: { display: 'none' } });
  const drop = h('div.drop', { on: { click: () => file.click() } }, svg('upload'), ' Upload a rendered video as v1 (optional)');
  file.addEventListener('change', () => { drop.textContent = file.files[0] ? `v1: ${file.files[0].name}` : 'Upload a rendered video as v1 (optional)'; });
  let detected = null;
  const check = debounce(async () => {
    if (!dir.value.trim()) { detected = null; status.textContent = 'Optional. Linking a folder lets Videditor show which clips are on screen at each note, import existing renders, and render new versions.'; return; }
    try { detected = await api.detect(dir.value.trim()); status.textContent = detected.ok ? `HyperFrames project found${detected.renderFiles.length ? ` with ${detected.renderFiles.length} render(s) in renders/ that will be imported as versions` : ''}.` : `Not detected: ${detected.reason}`; status.style.color = detected.ok ? 'var(--ok)' : 'var(--warn)'; }
    catch (e) { status.textContent = e.message; }
  }, 350);
  dir.addEventListener('input', check);
  const ok = await modal('New project', h('div',
    h('label.field', h('span', 'Name'), name),
    h('label.field', h('span', 'HyperFrames project folder (on the machine running the server)'), dir, status),
    drop, file,
  ), { actions: [{ label: 'Create', cls: 'primary', onClick: () => { if (!name.value.trim() && !file.files[0]) { name.focus(); return false; } if (dir.value.trim() && detected && !detected.ok) { dir.focus(); return false; } return true; } }] });
  if (!ok) return;
  try {
    const p = await api.createProject({ name: name.value.trim() || file.files[0]?.name.replace(/\.[^.]+$/, '') || 'Untitled', hyperframesDir: dir.value.trim() || null });
    if (file.files[0]) { toast('Uploading…'); await api.upload(p.id, file.files[0], 'Uploaded from the browser'); }
    navigate(`#/p/${p.id}`);
  } catch (e) { toast(e.message, 'err'); }
}
