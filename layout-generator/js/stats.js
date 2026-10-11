/* Usage analytics for the admin view: who worked, when, on which project, and what they did (projects made,
   generations, imports, exports, agent runs, library pieces used, minutes spent editing). Each person's own page
   counts their actions and the minutes they were active, and writes one summary per month:
   - claude.ai: stats/{their id}/months/{YYYYMM} (their own subtree; admins read everyone's)
   - server: POST /api/events, kept in server/data/stats/YYYYMM.jsonl; GET /api/analytics sums them up
   - neither: this browser only
   A summary holds counts per day and per project, plus the last 120 actions with their time. Nothing is sent
   anywhere else, and only ids, names people already share in the room, and action names are kept. */
const Stats = (() => {
  const LS = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } } };
  const RECENT = 120, FLUSH_MS = 20000;
  let env = null, backend = null, started = null, mode = 'local', uid = null, meName = '';
  const day = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const month = (t = Date.now()) => day(t).slice(0, 7).replace('-', '');
  const empty = m => ({ v: 1, month: m, uid, name: meName, days: {}, projects: {}, counts: {}, recent: [], first: 0, last: 0 });
  // this person's current month summary (in memory), merged into the stored one on flush
  let cur = null; let dirty = false; let flushTimer = 0; let lastActiveMinute = ''; let currentProject = () => null;
  function bump(obj, k, n = 1) { obj[k] = (obj[k] || 0) + n; }
  function track(action, info = {}) {
    if (!cur || cur.month !== month()) cur = empty(month());
    const t = Date.now(); const d = day(t); const pid = info.project || (currentProject() || ''); const a = String(action).slice(0, 40);
    bump(cur.counts, a); const D = cur.days[d] = cur.days[d] || { actions: 0, minutes: 0, counts: {}, projects: {} }; D.actions++; bump(D.counts, a);
    if (pid) { const P = cur.projects[pid] = cur.projects[pid] || { actions: 0, minutes: 0, counts: {}, first: t, last: t }; P.actions++; bump(P.counts, a); P.last = t; bump(D.projects, pid); }
    cur.recent.push({ t, a, p: pid, ...(info.detail ? { d: String(info.detail).slice(0, 80) } : {}) }); if (cur.recent.length > RECENT) cur.recent.splice(0, cur.recent.length - RECENT);
    cur.first = cur.first || t; cur.last = t; dirty = true; schedule();
  }
  // A minute counts as worked when the person touched the canvas during it.
  function active() {
    const t = Date.now(); const key = `${day(t)}T${new Date(t).getHours()}:${new Date(t).getMinutes()}`; if (key === lastActiveMinute) return; lastActiveMinute = key;
    if (!cur || cur.month !== month()) cur = empty(month());
    const d = day(t); const pid = currentProject() || '';
    const D = cur.days[d] = cur.days[d] || { actions: 0, minutes: 0, counts: {}, projects: {} }; D.minutes++;
    if (pid) { const P = cur.projects[pid] = cur.projects[pid] || { actions: 0, minutes: 0, counts: {}, first: t, last: t }; P.minutes++; P.last = t; }
    cur.first = cur.first || t; cur.last = t; dirty = true; schedule();
  }
  function schedule() { if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS); }
  function merge(stored, mine) {
    if (!stored) return mine; const out = { ...stored, name: mine.name || stored.name, last: Math.max(stored.last || 0, mine.last || 0), first: Math.min(stored.first || mine.first, mine.first || stored.first) };
    const addCounts = (a, b) => { for (const [k, v] of Object.entries(b || {})) a[k] = (a[k] || 0) + v; return a; };
    out.counts = addCounts({ ...(stored.counts || {}) }, mine.counts);
    out.days = { ...(stored.days || {}) }; for (const [d, v] of Object.entries(mine.days || {})) { const s = out.days[d] || { actions: 0, minutes: 0, counts: {}, projects: {} }; out.days[d] = { actions: s.actions + v.actions, minutes: s.minutes + v.minutes, counts: addCounts({ ...s.counts }, v.counts), projects: addCounts({ ...s.projects }, v.projects) }; }
    out.projects = { ...(stored.projects || {}) }; for (const [p, v] of Object.entries(mine.projects || {})) { const s = out.projects[p] || { actions: 0, minutes: 0, counts: {}, first: v.first, last: v.last }; out.projects[p] = { actions: s.actions + v.actions, minutes: s.minutes + v.minutes, counts: addCounts({ ...s.counts }, v.counts), first: Math.min(s.first, v.first), last: Math.max(s.last, v.last) }; }
    out.recent = [...(stored.recent || []), ...(mine.recent || [])].slice(-RECENT);
    return out;
  }
  async function flush() {
    flushTimer = 0; if (!dirty || !cur || !backend) return; const mine = cur; dirty = false; cur = null;
    try { await backend.write(mine); } catch (e) { console.warn('stats', e && e.message); cur = merge(mine, cur || empty(mine.month)); dirty = true; }
  }

  // ---- backends -------------------------------------------------------------------------------------------------------
  async function artifactBackend() {
    if (!(window.claude && typeof window.claude.use === 'function')) return null;
    const [db, user] = await Promise.all(['db', 'user'].map(n => window.claude.use(n).catch(() => null)));
    if (!db) return null;
    try { uid = user && user.id ? await user.id() : null; } catch { uid = null; }
    try { const me = user && user.me ? await user.me() : null; meName = (me && me.name) || ''; } catch { }
    if (!uid) return { kind: 'artifact', write: async () => { }, read: async () => [] };
    const ref = m => db.doc(`stats/${uid}/months/${m}`);
    return {
      kind: 'artifact',
      write: async mine => { const snap = await ref(mine.month).get(); const stored = snap && snap.exists ? snap.data() : null; await ref(mine.month).set(merge(stored, mine)); },
      // admins: everyone's summaries for the given months (people whose subtree the rules open to admins)
      read: async months => { const out = []; for (const m of months) { try { const q = await db.collection('stats').get(); for (const d of q.docs) { try { const s = await db.doc(`stats/${d.id}/months/${m}`).get(); if (s && s.exists) out.push({ ...s.data(), uid: d.id }); } catch { } } } catch { } } return out; },
      profiles: user && user.profiles ? ids => user.profiles(ids) : null,
    };
  }
  async function serverBackend() {
    if (window.claude || !/^https?:$/.test(location.protocol)) return null;
    try { const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 1500); const r = await fetch('/api/ping', { cache: 'no-store', signal: ctl.signal }); clearTimeout(t); const j = r.ok ? await r.json() : null; if (!(j && j.lg)) return null; } catch { return null; }
    uid = LS.get('lg.clientId', null); meName = LS.get('lg.name', '') || '';
    return {
      kind: 'server',
      write: async mine => { const r = await fetch('/api/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uid, name: meName || (typeof Sync !== 'undefined' && Sync.me.name) || '', summary: mine }) }); if (!r.ok) throw new Error('events ' + r.status); },
      read: async months => { const r = await fetch('/api/analytics?months=' + months.join(','), { headers: { 'x-lg-admin': LS.get('lg.adminKey', '') || '' } }); if (!r.ok) throw new Error(r.status === 401 ? 'This server shows analytics to people with the admin key (Libraries → Admins).' : 'analytics ' + r.status); return (await r.json()).summaries || []; },
    };
  }
  function localBackend() {
    uid = LS.get('lg.clientId', null) || 'me'; meName = LS.get('lg.name', '') || '';
    const key = m => `lg.stats.${m}`;
    return { kind: 'local', write: async mine => { LS.set(key(mine.month), merge(LS.get(key(mine.month), null), mine)); }, read: async months => months.map(m => LS.get(key(m), null)).filter(Boolean) };
  }

  // ---- public ---------------------------------------------------------------------------------------------------------
  function init(e) { env = e; currentProject = e.currentProject || (() => null); }
  function start() {
    if (started) return started;
    started = (async () => {
      backend = (await artifactBackend()) || (await serverBackend()) || localBackend(); mode = backend.kind;
      if (!meName && typeof Sync !== 'undefined') meName = Sync.me.name || '';
      window.addEventListener('pagehide', () => { if (dirty) { clearTimeout(flushTimer); flushTimer = 0; flush(); } });
      return mode;
    })();
    return started;
  }
  // Summaries (everyone's, for admins) for the last `days`, plus the person names the platform knows.
  async function report(days = 30) {
    if (!backend) await start();
    const months = []; const now = Date.now(); for (let t = now - days * 86400e3; t <= now + 86400e3; t += 86400e3 * 28) { const m = month(t); if (!months.includes(m)) months.push(m); } if (!months.includes(month(now))) months.push(month(now));
    if (dirty && cur) { clearTimeout(flushTimer); flushTimer = 0; await flush(); }
    const sums = await backend.read(months);
    const since = day(now - days * 86400e3);
    const people = new Map(); const projects = new Map(); const dayRows = new Map(); const recent = []; const totals = {};
    for (const s of sums) {
      if (!s || !s.uid) continue; const P = people.get(s.uid) || { uid: s.uid, name: s.name || '', minutes: 0, actions: 0, counts: {}, projects: new Set(), first: 0, last: 0 }; people.set(s.uid, P);
      if (s.name && !P.name) P.name = s.name;
      for (const [d, v] of Object.entries(s.days || {})) { if (d < since) continue; P.minutes += v.minutes; P.actions += v.actions; for (const [k, n] of Object.entries(v.counts || {})) { P.counts[k] = (P.counts[k] || 0) + n; totals[k] = (totals[k] || 0) + n; } const R = dayRows.get(d) || { day: d, people: new Set(), actions: 0, minutes: 0, counts: {} }; R.people.add(s.uid); R.actions += v.actions; R.minutes += v.minutes; for (const [k, n] of Object.entries(v.counts || {})) R.counts[k] = (R.counts[k] || 0) + n; dayRows.set(d, R); for (const pid of Object.keys(v.projects || {})) P.projects.add(pid); }
      for (const [pid, v] of Object.entries(s.projects || {})) { if (v.last && day(v.last) < since) continue; const Q = projects.get(pid) || { id: pid, minutes: 0, actions: 0, people: new Set(), last: 0, counts: {} }; Q.minutes += v.minutes; Q.actions += v.actions; Q.people.add(s.uid); Q.last = Math.max(Q.last, v.last || 0); for (const [k, n] of Object.entries(v.counts || {})) Q.counts[k] = (Q.counts[k] || 0) + n; projects.set(pid, Q); P.first = P.first ? Math.min(P.first, v.first || P.first) : (v.first || 0); P.last = Math.max(P.last, v.last || 0); }
      for (const r of s.recent || []) if (day(r.t) >= since) recent.push({ ...r, uid: s.uid });
    }
    let names = {}; if (backend.profiles) { try { const ps = await backend.profiles([...people.keys()]); for (const [id, p] of Object.entries(ps || {})) if (p && p.name) names[id] = p.name; } catch { } }
    for (const P of people.values()) { P.name = names[P.uid] || P.name || 'Someone'; P.projects = [...P.projects]; }
    for (const Q of projects.values()) Q.people = [...Q.people];
    recent.sort((a, b) => b.t - a.t);
    const daysOut = [...dayRows.values()].sort((a, b) => a.day.localeCompare(b.day)).map(r => ({ ...r, people: r.people.size }));
    return { days, since, totals, people: [...people.values()].sort((a, b) => b.last - a.last), projects: [...projects.values()].sort((a, b) => b.last - a.last), daily: daysOut, recent: recent.slice(0, 300) };
  }
  return { init, start, track, active, flush, report, get mode() { return mode; }, get uid() { return uid; } };
})();
