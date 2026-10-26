// The library follows the code. Re-captures a design system's components from its Storybook (tools/storybook-capture.mjs),
// compares them with the library as it is now, and writes the items that changed, with their ids and block ids kept
// where the structure still matches, so instances on every canvas update in place and keep their overrides.
//
//   node tools/ds-sync.mjs --manifest sync.json --current <library.json | dir of item docs> --out-dir changed/ \
//     [--baseline baseline.json] [--captured captured.json] [--app http://127.0.0.1:8123/index.html] [--only regex] \
//     [--server http://host:8787 --admin-key K] [--dry]
//
// sync.json: { storybook, pkg, lib, prefix, stories: [ … as tools/storybook-capture.mjs --list … ] }
//   storybook  the Storybook URL; pkg  the package the components come from (@scope/ui); lib  the shared library id;
//   prefix     how item ids are formed from story keys (prefix + key, e.g. "dui-"); stories  what to capture.
// --current is the library today: an lgLibrary export (Library → Export) or a folder of item documents (one JSON per
// item, as the claude.ai database stores them). Output: one document per changed or new item in --out-dir (ready to
// write back: claude.ai database `libitems/<id>`, or Library → Import of out-dir/changed.lgLibrary.json), and a summary.
// --baseline is the previous run's baseline.json (what Storybook looked like last time, per item): with it, an item
// changes only when Storybook changed, so pieces people curated in the library (slots, labels, removed sample content)
// are left alone until the component itself moves. Every run writes a new baseline.json to --out-dir; keep it for the
// next run. Without a baseline the capture is compared with the library as it is now (a first run).
// --captured reuses a capture file from an earlier run instead of capturing again.
// --server posts the changed items to a self-hosted server (POST /api/libraries putItem, x-lg-admin header).
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const has = k => process.argv.includes('--' + k);
const MAN = arg('manifest'); const CUR = arg('current'); const OUTD = arg('out-dir', 'ds-sync-out'); const APP = arg('app', 'http://127.0.0.1:8123/index.html'); const ONLY = arg('only');
const SERVER = arg('server'); const KEY = arg('admin-key', process.env.LG_ADMIN_KEY || ''); const DRY = has('dry');
const BASE = arg('baseline') ? (b => b.items || b)(JSON.parse(readFileSync(arg('baseline'), 'utf8'))) : null; const CAPTURED = arg('captured');
if (!MAN || !CUR) { console.error('Usage: node tools/ds-sync.mjs --manifest sync.json --current <library.json | dir> --out-dir changed/ [--app url] [--only regex] [--server url --admin-key K] [--dry]'); process.exit(1); }
const M = JSON.parse(readFileSync(MAN, 'utf8')); const prefix = M.prefix || ''; const libId = M.lib;
if (!M.storybook || !Array.isArray(M.stories) || !libId) { console.error('The manifest needs storybook, lib and stories'); process.exit(1); }
mkdirSync(OUTD, { recursive: true });

// The library today, by item id.
const current = new Map();
if (statSync(CUR).isDirectory()) { for (const f of readdirSync(CUR)) if (f.endsWith('.json')) { const d = JSON.parse(readFileSync(join(CUR, f), 'utf8')); const it = d.lgLibrary ? null : (d.data && d.data.blocks ? d.data : d); if (it && it.id && Array.isArray(it.blocks)) current.set(it.id, it); } }
else { const d = JSON.parse(readFileSync(CUR, 'utf8')); for (const it of (d.lgLibrary && d.lgLibrary.items) || d.items || []) current.set(it.id, it); }
console.log(`current library: ${current.size} items`);

// 1. capture
const tmp = join(os.tmpdir(), `ds-sync-${Date.now()}`); mkdirSync(tmp, { recursive: true });
const list = join(tmp, 'stories.json'); writeFileSync(list, JSON.stringify(M.stories));
const capOut = CAPTURED || join(tmp, 'captured.json'); let skipped = [];
if (!CAPTURED) {
  const cmd = [join(here, 'storybook-capture.mjs'), '--storybook', M.storybook, '--list', list, '--app', APP, '--out', capOut, '--name', 'ds-sync', '--pkg', M.pkg || 'components', ...(ONLY ? ['--only', ONLY] : [])];
  console.log('capturing…'); const r = spawnSync(process.execPath, cmd, { stdio: ['ignore', 'pipe', 'inherit'], env: process.env, maxBuffer: 64 * 1024 * 1024 });
  const capLog = String(r.stdout || ''); if (r.status !== 0 || !existsSync(capOut)) { console.error(capLog.slice(-2000)); console.error('capture failed'); process.exit(1); }
  skipped = capLog.split('\n').filter(l => l.startsWith('skipped')); for (const l of skipped) console.log(l);
  writeFileSync(join(OUTD, 'captured.json'), readFileSync(capOut));
} else console.log(`reusing capture ${CAPTURED}`);
const captured = JSON.parse(readFileSync(capOut, 'utf8')).lgLibrary.items;
console.log(`captured: ${captured.length} items`);

// 2. compare: what a person would see, not ids
const r2 = v => Math.round(Number(v) || 0);
const sig = b => [b.kind, b.label || '', b.kind === 'text' || b.kind === 'button' ? String(b.text || '') : '', b.fill || '', r2(b.w), r2(b.h), b.font ? `${b.font.size}/${b.font.weight}` : '', b.radius ? r2(b.radius) : '', b.auto ? b.auto.mode : '', b.stroke ? `${b.stroke.width}:${b.stroke.color}` : '', b.d ? String(b.d).length : '', b.asset ? 'img' : ''].join('|');
const signature = it => (it.blocks || []).map(sig).join('\n');
// a prop's allowed values come back in any order from Storybook: compare them sorted
const normType = t => String(t || '').split('|').map(x => x.trim()).filter(Boolean).sort().join(' | ');
const codeSig = it => it.code ? JSON.stringify({ n: it.code.name, p: (it.code.spec && it.code.spec.props || []).map(p => [p.name, normType(p.type), p.default == null ? null : String(p.default)]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))) }) : '';
const sha = s => createHash('sha1').update(s).digest('hex').slice(0, 16);
const stamp = it => ({ sig: sha(signature(it)), code: sha(codeSig(it)), w: r2(it.w), h: r2(it.h), blocks: (it.blocks || []).length });
const sameStamp = (a, b) => a && b && a.sig === b.sig && a.code === b.code && a.w === b.w && a.h === b.h;
// Old block ids where the structure still matches (same kind at the same place), so instances keep their src mapping.
function alignIds(oldBlocks, newBlocks) {
  const map = new Map(); const used = new Set(oldBlocks.map(b => b.id));
  newBlocks.forEach((b, i) => { const o = oldBlocks[i]; if (o && o.kind === b.kind) map.set(b.id, o.id); });
  for (const b of newBlocks) if (!map.has(b.id) && used.has(b.id)) map.set(b.id, b.id + '_'); // never collide with an old id we did not claim
  return newBlocks.map(b => { const c = { ...b }; c.id = map.get(b.id) || b.id; if (c.parent) c.parent = map.get(c.parent) || c.parent; if (c.code && c.code.from) c.code = { ...c.code }; return c; });
}
const changed = [], fresh = [], same = [], missing = []; const baseline = {};
for (const s of M.stories) {
  if (ONLY && !new RegExp(ONLY).test(s.key)) continue;
  const id = prefix + s.key; const cap = captured.find(it => it.id === ('sb-' + s.key).replace(/[^A-Za-z0-9_.:-]/g, '-').slice(0, 64));
  const cur = current.get(id);
  if (!cap) { if (cur) missing.push(id); continue; }
  baseline[id] = stamp(cap);
  // with a baseline, only Storybook's own changes count: what people curated in the library stays
  if (cur && BASE && BASE[id]) { if (sameStamp(BASE[id], baseline[id])) { same.push(id); continue; } }
  const next = { ...(cur || {}), ...cap, id, lib: libId, name: s.label || cap.name, category: s.screen ? 'screens' : (cur && cur.category) || cap.category, approved: cur ? cur.approved !== false : true, created: (cur && cur.created) || cap.created, group: s.group || cap.group };
  delete next.updated;
  if (cur) {
    if (!(BASE && BASE[id]) && sameStamp(stamp(cur), baseline[id])) { same.push(id); continue; }
    next.blocks = alignIds(cur.blocks, cap.blocks); const top = next.blocks.find(b => !b.parent); if (top && top.code) top.code.from = id;
    // slots and labels people gave the current version stay where the block survived
    const byId = new Map(cur.blocks.map(b => [b.id, b])); for (const b of next.blocks) { const o = byId.get(b.id); if (o && o.slot) b.slot = o.slot; if (o && o.label && o.label !== b.label && !/^[a-z0-9]+\./.test(o.label)) b.label = o.label; }
    next.v = (cur.v || 1) + 1; next.updated = Date.now(); changed.push(next);
  } else { const top = next.blocks.find(b => !b.parent); if (top && top.code) top.code.from = id; next.v = 1; next.updated = Date.now(); fresh.push(next); }
}
for (const it of [...changed, ...fresh]) writeFileSync(join(OUTD, it.id + '.json'), JSON.stringify(it));
const lib = { lgLibrary: { v: 2, libraries: [{ id: libId, name: M.name || libId, defaultOn: true, updated: Date.now() }], items: [...changed, ...fresh] } };
writeFileSync(join(OUTD, 'changed.lgLibrary.json'), JSON.stringify(lib));
writeFileSync(join(OUTD, 'baseline.json'), JSON.stringify({ at: new Date().toISOString(), storybook: M.storybook, items: baseline }, null, 1));
writeFileSync(join(OUTD, 'summary.json'), JSON.stringify({ at: new Date().toISOString(), storybook: M.storybook, baseline: !!BASE, same, changed: changed.map(i => i.id), new: fresh.map(i => i.id), missing, skipped }, null, 1));
console.log(`unchanged ${same.length} · changed ${changed.length} · new ${fresh.length} · missing from Storybook ${missing.length}${skipped.length ? ` · skipped ${skipped.length}` : ''}`);
if (changed.length) console.log('changed:', changed.map(i => i.id).join(', ')); if (fresh.length) console.log('new:', fresh.map(i => i.id).join(', ')); if (missing.length) console.log('missing:', missing.join(', '));
console.log(`wrote ${OUTD}/ (one document per item, changed.lgLibrary.json, baseline.json for the next run, summary.json)`);

// 3. a self-hosted server takes the items straight away
if (SERVER && !DRY && (changed.length || fresh.length)) {
  for (const it of [...changed, ...fresh]) {
    const res = await fetch(String(SERVER).replace(/\/$/, '') + '/api/libraries', { method: 'POST', headers: { 'content-type': 'application/json', ...(KEY ? { 'x-lg-admin': KEY } : {}) }, body: JSON.stringify({ op: 'putItem', item: it }) });
    console.log(res.ok ? `server: ${it.id} updated` : `server: ${it.id} ${res.status} ${await res.text()}`);
  }
}
