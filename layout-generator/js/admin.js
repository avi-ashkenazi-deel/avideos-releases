/* Admin view: what people did with the tool, from the month summaries each person's page keeps (see js/stats.js).
   Who worked, when and on which project; projects made, screens made, generations, imports, exports, agent runs,
   library pieces used, minutes spent editing. Numbers first, then a day-by-day picture, then people, projects and the
   latest actions; everything exports as CSV. Shown to library admins (the page owner and the admin list in claude.ai,
   the admin key on the server). */
const Admin = (() => {
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let env = null, el = null, days = 30, rep = null, loading = false, tab = 'people';
  const BAR = '#7B5FD6'; // validated for the dark surface (L 0.58, 3:1+)
  const LABEL = { 'project.create': 'Projects made', 'project.open': 'Projects opened', 'frame.create': 'Screens made', generate: 'Generations', 'generate.deck': 'Deck generations', 'to-canvas': 'Layouts to canvas', 'import.figma': 'Figma imports', 'import.pptx': 'PowerPoint imports', 'import.gslides': 'Google Slides imports', 'import.web': 'Web captures', 'import.image': 'Images added', 'import.canvas': 'Canvas files opened', 'export.png': 'PNG exports', 'export.svg': 'SVG exports', 'export.pdf': 'PDF exports', 'export.pptx': 'PowerPoint exports', 'export.gslides': 'Google Slides exports', 'export.react': 'React exports', 'export.html': 'HTML exports', 'agent.run': 'Agent runs', 'agent.tool': 'Agent tool calls (MCP)', 'library.insert': 'Library pieces used', 'library.save': 'Library pieces saved', variations: 'Variation runs', trace: 'Rebuilt from images', 'look.wireframe': 'Wireframe looks', 'look.rebrand': 'Rebrand looks', 'look.original': 'Original looks' };
  const label = a => LABEL[a] || a;
  const sum = (counts, re) => Object.entries(counts || {}).filter(([k]) => re.test(k)).reduce((t, [, v]) => t + v, 0);
  const ago = t => { if (!t) return '—'; const d = Date.now() - t; const m = Math.round(d / 60000); if (m < 2) return 'just now'; if (m < 60) return m + ' min ago'; const h = Math.round(m / 60); if (h < 36) return h + ' h ago'; return Math.round(h / 24) + ' d ago'; };
  const when = t => t ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const hours = m => m >= 90 ? (m / 60).toFixed(1) + ' h' : m + ' min';
  const projName = id => { const p = typeof Projects !== 'undefined' && Projects.get(id); return p ? p.name : (id === '_root' ? 'Shared canvas' : id || '—'); };
  const folderName = id => { const p = typeof Projects !== 'undefined' && Projects.get(id); const f = p && p.folder && Projects.folders().find(x => x.id === p.folder); return f ? f.name : ''; };

  // One series of bars per day: thin marks, rounded tops anchored to the baseline, a hover readout, no legend
  // (the title names the series). Days without data stay as gaps, not zeros drawn as bars.
  function bars(title, rows, key, fmt = v => String(v)) {
    const W = 320, H = 140, padL = 34, padB = 18, padT = 8; const n = rows.length; if (!n) return `<div class="ad-chart"><h4>${esc(title)}</h4><p class="hint">No activity in this range.</p></div>`;
    const max = Math.max(1, ...rows.map(r => r[key])); const bw = Math.max(2, Math.min(18, (W - padL) / n - 2)); const step = (W - padL) / n;
    const ticks = [0, Math.round(max / 2), max];
    const y = v => padT + (H - padT - padB) * (1 - v / max);
    const grid = ticks.map(t => `<line x1="${padL}" x2="${W}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" class="ad-grid"/><text x="${padL - 6}" y="${(y(t) + 3).toFixed(1)}" class="ad-tick" text-anchor="end">${fmt(t)}</text>`).join('');
    const bar = (r, i) => { const v = r[key]; const x = padL + i * step + (step - bw) / 2; const top = y(v), bottom = y(0), h = Math.max(0, bottom - top); if (!v) return ''; const rr = Math.min(4, bw / 2, h); const d = `M${x},${bottom} V${top + rr} Q${x},${top} ${x + rr},${top} H${x + bw - rr} Q${x + bw},${top} ${x + bw},${top + rr} V${bottom} Z`; return `<path d="${d}" fill="${BAR}"><title>${esc(r.day)}: ${esc(fmt(v))}</title></path>`; };
    const labels = rows.map((r, i) => (n <= 7 || i % Math.ceil(n / 5) === 0) ? `<text x="${(padL + i * step + step / 2).toFixed(1)}" y="${H - 4}" class="ad-tick" text-anchor="middle">${esc(r.day.slice(5))}</text>` : '').join('');
    return `<div class="ad-chart"><h4>${esc(title)}</h4><svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(title)} per day">${grid}${rows.map(bar).join('')}${labels}</svg></div>`;
  }
  function render() {
    if (!el) return; const body = el.querySelector('.admin-body'); if (!body) return;
    if (loading || !rep) { body.innerHTML = '<p class="hint">Reading the summaries…</p>'; return; }
    const T = rep.totals; const people = rep.people; const minutes = people.reduce((t, p) => t + p.minutes, 0);
    const kpi = [['People who worked', people.length], ['Time editing', hours(minutes)], ['Projects worked on', rep.projects.length], ['Projects made', T['project.create'] || 0], ['Screens made', T['frame.create'] || 0], ['Generations', (T.generate || 0) + (T['generate.deck'] || 0)], ['Imports', sum(T, /^import\./)], ['Exports', sum(T, /^export\./)], ['Agent runs', (T['agent.run'] || 0) + (T['agent.tool'] || 0)], ['Library pieces used', T['library.insert'] || 0]];
    // the day rows, filled across the whole range so gaps show
    const byDay = new Map(rep.daily.map(r => [r.day, r])); const rows = []; for (let i = rep.days - 1; i >= 0; i--) { const d = new Date(Date.now() - i * 86400e3); const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; rows.push(byDay.get(k) || { day: k, people: 0, actions: 0, minutes: 0 }); }
    const counts = Object.entries(T).sort((a, b) => b[1] - a[1]).slice(0, 14);
    const tabs = [['people', `People (${people.length})`], ['projects', `Projects (${rep.projects.length})`], ['recent', `Latest actions (${rep.recent.length})`], ['actions', 'Actions by kind']];
    let table = '';
    if (tab === 'people') table = `<table class="ad-table"><thead><tr><th>Person</th><th>Last seen</th><th>Time</th><th>Actions</th><th>Projects</th><th>Mostly</th></tr></thead><tbody>${people.map(p => `<tr><td>${esc(p.name)}</td><td title="${esc(when(p.last))}">${ago(p.last)}</td><td>${hours(p.minutes)}</td><td>${p.actions}</td><td>${p.projects.slice(0, 4).map(projName).map(esc).join(', ')}${p.projects.length > 4 ? ` +${p.projects.length - 4}` : ''}</td><td>${Object.entries(p.counts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${esc(label(k))} ${v}`).join(' · ')}</td></tr>`).join('') || '<tr><td colspan="6" class="hint">Nobody yet.</td></tr>'}</tbody></table>`;
    else if (tab === 'projects') table = `<table class="ad-table"><thead><tr><th>Project</th><th>Folder</th><th>Last edit</th><th>Time</th><th>Actions</th><th>People</th></tr></thead><tbody>${rep.projects.map(q => `<tr><td>${esc(projName(q.id))}</td><td>${esc(folderName(q.id))}</td><td title="${esc(when(q.last))}">${ago(q.last)}</td><td>${hours(q.minutes)}</td><td>${q.actions}</td><td>${q.people.map(id => (people.find(p => p.uid === id) || {}).name || 'Someone').map(esc).join(', ')}</td></tr>`).join('') || '<tr><td colspan="6" class="hint">No project work yet.</td></tr>'}</tbody></table>`;
    else if (tab === 'recent') table = `<table class="ad-table"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Project</th><th></th></tr></thead><tbody>${rep.recent.slice(0, 200).map(r => `<tr><td>${esc(when(r.t))}</td><td>${esc((people.find(p => p.uid === r.uid) || {}).name || 'Someone')}</td><td>${esc(label(r.a))}</td><td>${esc(projName(r.p))}</td><td class="hint">${esc(r.d || '')}</td></tr>`).join('') || '<tr><td colspan="5" class="hint">Nothing yet.</td></tr>'}</tbody></table>`;
    else table = `<table class="ad-table"><thead><tr><th>Action</th><th>Count</th></tr></thead><tbody>${counts.map(([k, v]) => `<tr><td>${esc(label(k))}</td><td>${v}</td></tr>`).join('') || '<tr><td colspan="2" class="hint">Nothing yet.</td></tr>'}</tbody></table>`;
    body.innerHTML = `<div class="ad-top"><div class="cv-seg">${[7, 30, 90].map(d => `<button type="button" class="${days === d ? 'on' : ''}" data-days="${d}">${d} days</button>`).join('')}</div><span class="hint">${esc(Stats.mode === 'artifact' ? 'Everyone who used this page' : Stats.mode === 'server' ? 'Everyone on this server' : 'This browser only')} · since ${esc(rep.since)}</span><button type="button" class="btn small ghost" data-ad-csv>Export CSV</button></div>
      <div class="ad-kpis">${kpi.map(([k, v]) => `<div class="ad-kpi"><b>${esc(String(v))}</b><span>${esc(k)}</span></div>`).join('')}</div>
      <div class="ad-charts">${bars('People active per day', rows, 'people')}${bars('Actions per day', rows, 'actions')}${bars('Editing minutes per day', rows, 'minutes', v => hours(v))}</div>
      <div class="cv-seg ad-tabs">${tabs.map(([k, l]) => `<button type="button" class="${tab === k ? 'on' : ''}" data-tab="${k}">${esc(l)}</button>`).join('')}</div>
      <div class="ad-tablewrap">${table}</div>`;
  }
  async function load() { loading = true; render(); try { rep = await Stats.report(days); } catch (e) { rep = null; loading = false; if (el) el.querySelector('.admin-body').innerHTML = `<p class="hint">${esc(e.message || String(e))}</p>`; return; } loading = false; render(); }
  function open() { if (!el) return; el.hidden = false; load(); }
  function csv() {
    if (!rep) return; const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = ['section,name,last,minutes,actions,projects_or_people,detail'];
    for (const p of rep.people) lines.push(['person', p.name, when(p.last), p.minutes, p.actions, p.projects.map(projName).join('; '), Object.entries(p.counts).map(([k, v]) => `${label(k)}=${v}`).join('; ')].map(q).join(','));
    for (const r of rep.projects) lines.push(['project', projName(r.id), when(r.last), r.minutes, r.actions, r.people.map(id => (rep.people.find(p => p.uid === id) || {}).name || 'Someone').join('; '), Object.entries(r.counts).map(([k, v]) => `${label(k)}=${v}`).join('; ')].map(q).join(','));
    for (const r of rep.recent) lines.push(['action', (rep.people.find(p => p.uid === r.uid) || {}).name || 'Someone', when(r.t), '', label(r.a), projName(r.p), r.d || ''].map(q).join(','));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' }); env.download(blob, `layout-engine-usage-${rep.since}.csv`);
  }
  function bind(root, e) {
    el = root; env = e;
    root.addEventListener('click', ev => {
      if (ev.target === root || ev.target.closest('[data-admin-close]')) { root.hidden = true; return; }
      const d = ev.target.closest('[data-days]'); if (d) { days = +d.dataset.days; load(); return; }
      const t = ev.target.closest('[data-tab]'); if (t) { tab = t.dataset.tab; render(); return; }
      if (ev.target.closest('[data-ad-csv]')) csv();
    });
    root.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Escape') root.hidden = true; });
  }
  return { bind, open, render };
})();
