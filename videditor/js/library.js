import { api } from './api.js';
import { h, btn, svg, modal, toast, relTime, fmtTime, debounce } from './ui.js';

export async function renderLibrary(root, { navigate }) {
  root.replaceChildren(h('div.library', h('div.empty', 'Loading…')));
  const state = await api.state();
  const grid = h('div.cards');
  grid.append(h('div.card.new', { on: { click: () => newProject(navigate) } }, svg('plus'), h('b', 'New video'), h('span.small.muted', 'Describe it and build it with your agent, or review an existing render')));
  for (const p of state.projects) grid.append(projectCard(p, navigate));
  root.replaceChildren(h('div.library',
    h('div.head', h('div', h('h1', 'Videos'), h('p.sub', 'Make videos with your agent in Studio, render them frame-exact, then review with timestamped notes, voice and drawings. The agent reads the feedback and ships the next version.')), h('div', { style: { flex: 1 } }), btn('New video', { icon: 'plus', cls: 'primary', onClick: () => newProject(navigate) })),
    state.projects.length ? grid : h('div', grid, h('div.empty', h('p', 'No projects yet. Create one to start a review loop.'), !state.ffmpeg ? h('p.small', 'ffmpeg was not found, so thumbnails and frame extraction are off.') : null)),
  ));
}

function projectCard(p, navigate) {
  const v = p.latest;
  return h('div.card', { on: { click: () => navigate(p.versions.length ? `#/p/${p.id}` : `#/studio/${p.id}`) } },
    h('div.thumb', { style: v?.posterUrl ? { backgroundImage: `url(${v.posterUrl})` } : {} }, v ? null : svg('film'), v ? h('span.pill.ver', v.label) : null, p.stats.open ? h('span.pill.open.open', `${p.stats.open} open`) : null),
    h('div.body',
      h('div.name', p.name, p.dir ? h('span.hf', { title: p.dir }, svg('spark'), 'Studio') : null),
      h('div.meta', v ? h('span', `${p.versions.length} version${p.versions.length > 1 ? 's' : ''}`) : h('span', p.dir ? 'Not rendered yet' : 'No render yet'), v?.duration ? h('span', fmtTime(v.duration)) : null, h('span', `${p.stats.total} note${p.stats.total === 1 ? '' : 's'}`), p.dir ? h('a', { href: `#/studio/${p.id}`, on: { click: (e) => e.stopPropagation() } }, 'Open Studio') : null),
      p.lastActivity ? h('div.small.muted', `${p.lastActivity.author} · ${relTime(p.lastActivity.at)} · ${p.lastActivity.body}`) : h('div.small.muted', `Created ${relTime(p.createdAt)}`),
    ));
}

export async function newProject(navigate) {
  let mode = 'make';
  const name = h('input.text', { placeholder: 'e.g. Product launch teaser', maxlength: 120 });
  const brief = h('textarea.text', { rows: 4, placeholder: 'Describe the video: what it must say, who it is for, tone, length. The agent starts from this.' });
  const size = h('select.text', { style: { width: 'auto' } }, [['1280x720', '16:9 · 1280×720'], ['1920x1080', '16:9 · 1920×1080'], ['1080x1920', '9:16 · 1080×1920 (vertical)'], ['1080x1080', '1:1 · 1080×1080']].map(([v, l]) => h('option', { value: v }, l)));
  const dir = h('input.text', { placeholder: '/path/to/folder with index.html (optional)' });
  const status = h('div.hint', { style: { marginTop: '4px' } }, 'Link a folder that already holds a Videditor composition.');
  const file = h('input', { type: 'file', accept: 'video/*', style: { display: 'none' } });
  const drop = h('div.drop', { on: { click: () => file.click() } }, svg('upload'), ' Upload a rendered video as v1');
  file.addEventListener('change', () => { drop.textContent = file.files[0] ? `v1: ${file.files[0].name}` : 'Upload a rendered video as v1'; });
  let detected = null;
  const check = debounce(async () => {
    if (!dir.value.trim()) { detected = null; status.textContent = 'Link a folder that already holds a Videditor composition.'; status.style.color = ''; return; }
    try { detected = await api.detect(dir.value.trim()); status.textContent = detected.ok ? `Composition found${detected.renderFiles.length ? ` with ${detected.renderFiles.length} render(s) that will be imported as versions` : ''}.` : `Not detected: ${detected.reason}`; status.style.color = detected.ok ? 'var(--ok)' : 'var(--warn)'; }
    catch (e) { status.textContent = e.message; }
  }, 350);
  dir.addEventListener('input', check);
  const template = h('select.text', { style: { width: 'auto' } }, [['blank', 'Blank'], ['teaser', 'Teaser: title, 3 features, call to action']].map(([v, l]) => h('option', { value: v }, l)));
  const assets = h('input.text', { placeholder: '/Users/you/Movies/footage (optional, picked up and analyzed automatically)' });
  const panes = { make: h('div', h('label.field', h('span', 'Brief for the agent'), brief), h('div', { style: { display: 'flex', gap: '12px' } }, h('label.field', { style: { flex: 1 } }, h('span', 'Format'), size), h('label.field', { style: { flex: 1 } }, h('span', 'Start from'), template)), h('label.field', h('span', 'Asset folder'), assets)), review: h('div', drop, file, h('div.muted.small', { style: { margin: '10px 0 6px' } }, 'or'), h('label.field', h('span', 'Composition folder'), dir, status)) };
  const paneHost = h('div', panes.make);
  const tabs = h('div.tabs', { style: { marginBottom: '12px' } }, [['make', 'Make a new video'], ['review', 'Review an existing render']].map(([k, l]) => h('span.tab', { class: `tab ${k === mode ? 'active' : ''}`, on: { click: (e) => { mode = k; tabs.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === e.currentTarget)); paneHost.replaceChildren(panes[k]); } } }, l)));
  const ok = await modal('New video', h('div', tabs, h('label.field', h('span', 'Name'), name), paneHost), { actions: [{ label: 'Create', cls: 'primary', onClick: () => { if (!name.value.trim() && !file.files[0]) { name.focus(); return false; } if (mode === 'review' && dir.value.trim() && detected && !detected.ok) { dir.focus(); return false; } return true; } }] });
  if (!ok) return;
  try {
    const nm = name.value.trim() || file.files[0]?.name.replace(/\.[^.]+$/, '') || 'Untitled';
    if (mode === 'make') {
      const [w, hgt] = size.value.split('x').map(Number);
      const p = await api.createProject({ name: nm, create: true, template: template.value, width: w, height: hgt, fps: 30, brief: brief.value.trim(), assetsDir: assets.value.trim() || null });
      navigate(`#/studio/${p.id}${brief.value.trim() ? `?prompt=${encodeURIComponent('Build this video from BRIEF.md: ' + brief.value.trim())}` : ''}`);
    } else {
      const p = await api.createProject({ name: nm, dir: dir.value.trim() || null });
      if (file.files[0]) { toast('Uploading…'); await api.upload(p.id, file.files[0], 'Uploaded from the browser'); }
      navigate(p.dir && !file.files[0] ? `#/studio/${p.id}` : `#/p/${p.id}`);
    }
  } catch (e) { toast(e.message, 'err'); }
}
