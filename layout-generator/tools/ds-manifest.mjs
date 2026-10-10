#!/usr/bin/env node
// Build a component manifest (lgComponents) from a design-system repo, for Library → Import in the Layout Engine.
// It reads what the repo already documents; nothing is installed or run:
//   - a generated TypeScript reference in markdown (## Group / ### Component / import line / props table /
//     "Available values for `prop`:" lines), e.g. docs/typescript-reference.md
//   - React components in a folder of .tsx files that export `type XProps = { ... }` (string-literal unions become
//     the allowed values, `prop = 'x'` defaults in the component's signature become defaults)
//   - optionally a Storybook reference in markdown ("### Name" … "[View in Storybook →](url)") for links
//
//   node tools/ds-manifest.mjs <repo> [--name "Design system"] [--md docs/typescript-reference.md]
//        [--tsx packages/ai-components/src/components --tsx-import my-components/components]
//        [--stories docs/storybook-reference.md] [--out manifest.json]
//
// With no --md/--tsx flags it looks for docs/typescript-reference.md and packages/*/src/components.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const pos = []; for (let i = 0; i < args.length; i++) { if (args[i].startsWith('--')) { i++; continue; } pos.push(args[i]); }
const repo = path.resolve(pos[0] || '.');
const name = flag('--name', path.basename(repo));
const out = flag('--out', null);

// ---- markdown reference ----------------------------------------------------------------------------------------------
// Table cells split on | outside backtick spans (types like `number | string` stay whole).
function cells(line) {
  const out = []; let cur = ''; let i = 0; let tick = 0;
  const s = line.trim().replace(/^\||\|$/g, '');
  while (i < s.length) {
    if (s[i] === '`') { let n = 0; while (s[i + n] === '`') n++; if (!tick) tick = n; else if (tick === n) tick = 0; cur += s.slice(i, i + n); i += n; continue; }
    if (s[i] === '|' && !tick) { out.push(cur.trim()); cur = ''; i++; continue; }
    cur += s[i++];
  }
  out.push(cur.trim()); return out;
}
const unquote = v => v.replace(/^`+\s*|\s*`+$/g, '').trim();
function literals(type) {
  const t = unquote(type); if (!/^\s*'[^']*'(\s*\|\s*'[^']*')+\s*$/.test(t) && !/^\s*'[^']*'\s*$/.test(t)) return null;
  return [...t.matchAll(/'([^']*)'/g)].map(m => m[1]);
}
function fromMarkdown(file) {
  const lines = readFileSync(file, 'utf8').split('\n'); const comps = []; let group = ''; let cur = null; let valuesFor = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if ((m = /^## (.+)$/.exec(l))) { group = m[1].trim(); cur = null; continue; }
    if ((m = /^### (.*)$/.exec(l))) { const n = m[1].trim(); cur = /^[A-Z][A-Za-z0-9]*$/.test(n) ? { name: n, group, import: '', props: [] } : null; if (cur) comps.push(cur); continue; }
    if (!cur) continue;
    if ((m = /^import\s*\{([^}]*)\}\s*from\s*'([^']+)'/.exec(l.trim()))) { cur.import = m[2]; continue; }
    if (/^\|\s*Prop\s*\|/.test(l) || /^\|[-\s|]+\|$/.test(l)) continue;
    if (l.startsWith('|')) {
      const [prop, type, def, req, desc] = cells(l); if (!prop || !/^[A-Za-z_$][\w$]*$/.test(prop)) continue;
      const p = { name: prop, type: unquote(type || '') }; const vals = literals(type || ''); if (vals) p.values = vals;
      const d = unquote(def || ''); if (d && d !== '-') p.default = d.replace(/^'(.*)'$/, '$1');
      if (/^yes$/i.test(req || '')) p.required = true; if (desc && desc !== '-') p.description = desc;
      cur.props.push(p); continue;
    }
    if ((m = /^\*\*Available values for `([^`]+)`:\*\*/.exec(l))) { valuesFor = m[1]; continue; }
    if (valuesFor && l.trim()) { const p = cur.props.find(x => x.name === valuesFor); if (p && !p.values) p.values = l.split(',').map(x => x.trim()).filter(Boolean); valuesFor = null; }
  }
  return comps;
}
// ---- .tsx components ---------------------------------------------------------------------------------------------------
function typeBody(src, start) {
  let depth = 0; for (let i = start; i < src.length; i++) { const c = src[i]; if (c === '{') depth++; else if (c === '}') { depth--; if (!depth) return src.slice(start + 1, i); } }
  return null;
}
function members(body) {
  const out = []; let depth = 0, cur = '', doc = '';
  const flush = () => { const t = cur.trim(); cur = ''; if (!t) return; const m = /^(?:readonly\s+)?([A-Za-z_$][\w$]*)(\?)?\s*:\s*([\s\S]+)$/.exec(t); if (m) out.push({ name: m[1], optional: !!m[2], type: m[3].replace(/\s+/g, ' ').trim(), doc: doc.trim() }); doc = ''; };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (!depth && body.startsWith('/**', i)) { const e = body.indexOf('*/', i); doc = body.slice(i + 3, e).replace(/^\s*\*\s?/gm, '').trim(); i = e + 1; continue; }
    if (!depth && body.startsWith('//', i)) { const e = body.indexOf('\n', i); doc = body.slice(i + 2, e < 0 ? body.length : e).trim(); i = e < 0 ? body.length : e; continue; }
    if ('{([<'.includes(c)) depth++; else if ('})]>'.includes(c) && !(c === '>' && body[i - 1] === '=')) depth--;
    if (!depth && (c === ';' || c === '\n') && cur.trim() && !/[|&:,(<]\s*$/.test(cur.trim())) { flush(); continue; }
    cur += c;
  }
  flush(); return out;
}
function fromTsx(dir, importPath) {
  const comps = [];
  for (const f of readdirSync(dir).filter(f => f.endsWith('.tsx')).sort()) {
    const src = readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/export\s+(?:type|interface)\s+([A-Z][A-Za-z0-9]*)Props\s*(?:=\s*)?\{/g)) {
      const comp = m[1]; if (!new RegExp(`export\\s+(?:const|function)\\s+${comp}\\b`).test(src)) continue;
      const body = typeBody(src, m.index + m[0].length - 1); if (body == null) continue;
      const sig = (new RegExp(`export\\s+(?:const|function)\\s+${comp}[^]*?\\(\\s*\\{([^]*?)\\}\\s*:`).exec(src) || [])[1] || '';
      const props = members(body).map(p => {
        const o = { name: p.name, type: p.type }; const vals = literals(p.type); if (vals) o.values = vals;
        const d = new RegExp(`\\b${p.name}\\s*=\\s*('[^']*'|"[^"]*"|true|false|-?\\d+(?:\\.\\d+)?)`).exec(sig); if (d) o.default = d[1].replace(/^['"]|['"]$/g, '');
        if (!p.optional) o.required = true; if (p.doc) o.description = p.doc.split('\n')[0].slice(0, 160);
        return o;
      });
      comps.push({ name: comp, group: 'AI components', import: importPath, props });
    }
  }
  return comps;
}
// ---- Storybook links ---------------------------------------------------------------------------------------------------
// Name -> {url, group}. Headings like "Text Field" become TextField; docs pages and hooks are left out.
function stories(file) {
  const map = new Map(); let cur = null; let group = '';
  for (const l of readFileSync(file, 'utf8').split('\n')) {
    let m;
    if ((m = /^##\s+(.+)$/.exec(l)) && !l.startsWith('###')) { group = m[1].trim(); cur = null; continue; }
    if ((m = /^###\s+(.+)$/.exec(l))) { const raw = m[1].trim(); cur = /^[A-Z][A-Za-z0-9 ]*$/.test(raw) ? raw.split(/\s+/).map(w => w[0].toUpperCase() + w.slice(1)).join('') : null; continue; }
    if (cur && (m = /\[View in Storybook[^\]]*\]\((https:\/\/[^)\s]+)\)/.exec(l)) && !map.has(cur)) map.set(cur, { url: m[1], group: group.replace(/^Components\s*\/\s*/, '') });
  }
  return map;
}

// ---- run ---------------------------------------------------------------------------------------------------------------
const md = flag('--md', existsSync(path.join(repo, 'docs/typescript-reference.md')) ? 'docs/typescript-reference.md' : null);
let tsx = flag('--tsx', null); let tsxImport = flag('--tsx-import', null);
if (!tsx && existsSync(path.join(repo, 'packages'))) {
  for (const p of readdirSync(path.join(repo, 'packages'))) { const d = path.join('packages', p, 'src/components'); if (existsSync(path.join(repo, d))) { tsx = d; try { tsxImport = tsxImport || JSON.parse(readFileSync(path.join(repo, 'packages', p, 'package.json'), 'utf8')).name + '/components'; } catch { } break; } }
}
const st = flag('--stories', existsSync(path.join(repo, 'docs/storybook-reference.md')) ? 'docs/storybook-reference.md' : null);
let comps = [];
if (md) comps.push(...fromMarkdown(path.join(repo, md)));
if (tsx) comps.push(...fromTsx(path.join(repo, tsx), tsxImport || 'components'));
const links = st ? stories(path.join(repo, st)) : new Map();
const seen = new Set(); comps = comps.filter(c => { const k = c.import + ':' + c.name; if (seen.has(k)) return false; seen.add(k); return true; });
const linkLc = new Map([...links].map(([k, v]) => [k.toLowerCase(), v]));
for (const c of comps) { const s = links.get(c.name) || linkLc.get(c.name.toLowerCase()); if (s) c.story = s.url; }
// Components the Storybook shows but the reference does not document (often re-exported ones such as Button): listed
// without props, imported from the package most components come from.
const counts = {}; for (const c of comps) counts[c.import] = (counts[c.import] || 0) + 1;
const mainImport = flag('--stories-import', Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'components');
const names = new Set(comps.map(c => c.name.toLowerCase()));
for (const [n, s] of links) if (!names.has(n.toLowerCase()) && !/^(Introduction|Examples?|Formik|Refactor|Cells?|Loading|Pagination|Virtualization|Stickiness)$/.test(n)) { comps.push({ name: n, group: s.group || 'Storybook', import: mainImport, props: [], story: s.url }); names.add(n.toLowerCase()); }
for (const c of comps) if (!c.props.length) delete c.props;
const manifest = { lgComponents: { v: 1, name, generated: new Date().toISOString(), components: comps } };
const json = JSON.stringify(manifest, null, 1);
if (out) { writeFileSync(out, json); console.error(`${comps.length} components → ${out}`); } else process.stdout.write(json + '\n');
