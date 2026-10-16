// Storybook stories -> a shared library of real components (lgLibrary v2), captured and editable, tied to the code.
//
//   node tools/storybook-capture.mjs --storybook https://storybook.example.com --list stories.json \
//     --app http://127.0.0.1:8123/index.html --out library.json [--name "Design system"] [--pkg @scope/ui] [--only regex]
//
// stories.json is a list of { key, label, group, story, args?, screen?, w?, h?, wait?, click?, crop? }:
//   story   the story id (iframe.html?id=…), args  props to set before capturing (Storybook updateStoryArgs),
//   screen  a whole page (exact positions, Screens category), w/h  viewport, wait  ms after load,
//   click   open it first by clicking its first button (modals, drawers), crop  CSS selector to keep (e.g. a dialog's paper).
// Each story is rendered in a headless browser, recorded with Dugma's web capture (js/webimport.js), cropped to what it
// painted, then converted by the app itself (served at --app) into blocks: auto layout stacks for components, exact
// positions for screens. Items carry { code: { pkg, name, spec } } from the story's component and argTypes, and their
// top box { code: { props, from } }, so props in the panel swap between captured variants and React export writes the
// real component. Needs Playwright (npm i -g playwright, or a project that has it). Import the file in the app with
// Library → Libraries → Import.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const SB = String(arg('storybook', '')).replace(/\/(iframe\.html|index\.html)?$/, '');
const LIST = arg('list'); const APP = arg('app', 'http://127.0.0.1:8123/index.html'); const OUT = arg('out', 'library.json');
const NAME = arg('name', 'Design system'); const PKG = arg('pkg', 'components'); const ONLY = arg('only') ? new RegExp(arg('only')) : null;
if (!SB || !LIST) { console.error('Usage: node tools/storybook-capture.mjs --storybook <url> --list stories.json [--app url] [--out file] [--name text] [--pkg name]'); process.exit(1); }
const req = createRequire(import.meta.url);
let chromium; try { ({ chromium } = req('playwright')); } catch { try { ({ chromium } = await import('playwright')); } catch { console.error('Playwright is needed: npm i -g playwright (or run from a project that has it)'); process.exit(1); } }
const WEB = readFileSync(join(root, 'js/webimport.js'), 'utf8');
const stories = JSON.parse(readFileSync(LIST, 'utf8')).filter(s => s && s.key && s.story && (!ONLY || ONLY.test(s.key)));

// What the story painted: text, icons, images and anything with a fill, border or shadow (not the page around it).
async function captureStory(p, s) {
  await p.setViewportSize({ width: s.w || 1000, height: s.h || 760 });
  await p.goto(`${SB}/iframe.html?id=${encodeURIComponent(s.story)}&viewMode=story`, { waitUntil: 'networkidle', timeout: 90000 });
  await p.waitForTimeout(s.wait || 1500);
  const meta = await p.evaluate(async ({ story, args }) => {
    const P = window.__STORYBOOK_PREVIEW__; const st = await P.storyStoreValue.loadStory({ storyId: story });
    if (args) { P.channel.emit('updateStoryArgs', { storyId: story, updatedArgs: args }); await new Promise(r => setTimeout(r, 1200)); }
    const at = st.argTypes || {}; const spec = []; const props = {};
    for (const [k, v] of Object.entries(at)) {
      if (v.table && v.table.disable) continue; const t = v.type && v.type.name;
      if (!(v.options || t === 'boolean' || t === 'string' || t === 'number')) continue;
      spec.push({ name: k, type: v.options ? v.options.map(o => `'${o}'`).join(' | ') : t, values: v.options ? v.options.map(String) : undefined, default: v.table && v.table.defaultValue ? String(v.table.defaultValue.summary).replace(/^['"]|['"]$/g, '') : undefined, description: (v.description || '').slice(0, 160) });
    }
    for (const [k, v] of Object.entries({ ...(st.initialArgs || {}), ...(args || {}) })) if (['string', 'number', 'boolean'].includes(typeof v) && at[k] && !/^on[A-Z]|^data-|^sx$|^component$/.test(k)) props[k] = v;
    return { component: st.component && (st.component.displayName || st.component.name) || null, props, spec };
  }, { story: s.story, args: s.args || null });
  if (s.click) { await p.click('#storybook-root button'); await p.waitForTimeout(1500); }
  await p.addScriptTag({ content: WEB });
  const got = await p.evaluate(async crop => {
    const root = document.getElementById('storybook-root'); let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    const add = r => { if (r.width < 1 || r.height < 1 || (r.width >= innerWidth - 1 && r.height >= innerHeight - 1)) return; x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom); };
    const paints = cs => { const bg = cs.backgroundColor; return (bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg)) || ['Top', 'Right', 'Bottom', 'Left'].some(d => parseFloat(cs['border' + d + 'Width']) > 0 && cs['border' + d + 'Style'] !== 'none' && !/rgba\(0, 0, 0, 0\)/.test(cs['border' + d + 'Color'])) || (cs.boxShadow && cs.boxShadow !== 'none') || (cs.backgroundImage && cs.backgroundImage !== 'none'); };
    const scope = [root, ...document.querySelectorAll('body > div:not(#storybook-root):not(#storybook-docs):not(.sb-wrapper):not([class^=sb-])')];
    for (const top of scope) for (const el of top.querySelectorAll('*')) {
      const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) continue;
      if (el instanceof SVGSVGElement || el.tagName === 'IMG' || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') { add(el.getBoundingClientRect()); continue; }
      if (el.closest('svg')) continue;
      if (paints(cs)) add(el.getBoundingClientRect());
      for (const k of el.childNodes) if (k.nodeType === 3 && k.nodeValue.trim()) { const rg = document.createRange(); rg.selectNodeContents(k); add(rg.getBoundingClientRect()); }
    }
    if (crop) { const el = document.querySelector(crop); if (el) { const r = el.getBoundingClientRect(); x0 = r.left; y0 = r.top; x1 = r.right; y1 = r.bottom; } }
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(x1, innerWidth); y1 = Math.min(y1, Math.max(innerHeight, document.documentElement.scrollHeight));
    const cap = await WebImport.capturePage({ maxHeight: 3000 }); const pnl = document.getElementById('__lg_capture_panel'); if (pnl) pnl.remove();
    return { cap, box: [x0 + scrollX, y0 + scrollY, x1 - x0, y1 - y0] };
  }, s.crop || null);
  return { ...meta, ...got };
}
// Keep what lies inside the painted box, drop the page wrappers around it, move it to 0,0.
function crop(cap, box, title) {
  const [bx, by, bw, bh] = box; const drop = new Set(); const nodes = [];
  const inside = n => n.x < bx + bw - 0.5 && n.x + n.w > bx + 0.5 && n.y < by + bh - 0.5 && n.y + n.h > by + 0.5;
  const contains = n => n.x <= bx + 0.5 && n.y <= by + 0.5 && n.x + n.w >= bx + bw - 0.5 && n.y + n.h >= by + bh - 0.5;
  for (const n of cap.nodes) {
    if (!inside(n)) { if (n.t === 'frame') drop.add(n.id); continue; }
    if ((n.t === 'frame' || n.t === 'box') && contains(n) && n.w * n.h > bw * bh * 1.02) { if (n.t === 'frame') drop.add(n.id); continue; }
    if (n.t === 'box' && /Backdrop/.test(n.name || '')) continue;
    if (n.t === 'text' && /"viewMode"/.test(n.text || '')) continue;
    nodes.push({ ...n, x: n.x - bx, y: n.y - by });
  }
  for (const n of nodes) if (n.p && drop.has(n.p)) n.p = 0;
  return { ...cap, url: SB + '/', title, w: Math.round(bw), h: Math.round(bh), scrollY: 0, nodes };
}

const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
const sbPage = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
const caps = [];
for (const s of stories) {
  try {
    const c = await captureStory(sbPage, s);
    // props as code would write them: no false, empty or default values
    const defs = {}; for (const sp of c.spec) if (sp.default != null) defs[sp.name] = sp.default;
    for (const k of Object.keys(c.props)) { const v = c.props[k]; if (v === false || v === '' || String(v) === defs[k]) delete c.props[k]; }
    caps.push({ s, c }); console.log('captured', s.key, c.component || '-', c.cap.nodes.length, 'layers'); }
  catch (e) { console.log('skipped', s.key, e.message.slice(0, 160)); }
}
const app = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
await app.goto(APP, { waitUntil: 'networkidle' });
await app.evaluate(() => { localStorage.clear(); localStorage.setItem('lg.mode', '"canvas"'); }); await app.reload({ waitUntil: 'networkidle' });
await app.waitForFunction(() => typeof CanvasUI !== 'undefined' && typeof LibStore !== 'undefined' && typeof WebImport !== 'undefined');
await app.evaluate(async () => { for (const f of ['400 14px Inter', '500 14px Inter', '600 14px Inter']) await document.fonts.load(f).catch(() => { }); });
const libId = await app.evaluate(async ({ name, sb }) => (await LibStore.createLibrary({ name, description: `Components captured from ${sb}: editable layers tied to the real component.`, defaultOn: true })).id, { name: NAME, sb: SB });
for (const { s, c } of caps) {
  const r = await app.evaluate(async ({ s, c, cap, libId, pkg, sb }) => {
    localStorage.setItem('lg.importLayout', JSON.stringify(s.screen ? 'fixed' : 'auto'));
    const f = await WebImport.importCapture(cap); if (!f) return { err: 'nothing captured' };
    const blocks = Canvas.clone(f.layout.blocks); const bg = f.layout.palette && f.layout.palette.bg;
    CanvasUI.mutate(d => { d.frames = d.frames.filter(x => x.id !== f.id); });
    const ids = new Set(blocks.map(x => x.id)); let tops = blocks.filter(x => !x.parent || !ids.has(x.parent));
    const wrap = props => { const top = { id: 'bx' + Math.random().toString(36).slice(2, 7), kind: 'box', x: 0, y: 0, w: cap.w, h: cap.h, radius: 0, clip: false, decorative: true, ...props }; for (const t of tops) t.parent = top.id; blocks.unshift(top); tops = [top]; };
    if (s.screen) wrap({ fill: bg || '#FFFFFF', clip: true, label: s.label }); else if (tops.length > 1) wrap({ fill: 'none', label: c.component || s.label });
    const st = Library.settle(blocks);
    const item = { id: ('sb-' + s.key).replace(/[^A-Za-z0-9_.:-]/g, '-').slice(0, 64), lib: libId, name: String(s.label || s.key).slice(0, 60), category: s.screen ? 'screens' : 'code', approved: true, created: Date.now(), w: st.w, h: st.h, blocks: st.blocks, group: s.group || '', capture: true };
    if (!s.screen && c.component && /^[A-Z][A-Za-z0-9]+$/.test(c.component)) {
      const top = st.blocks.find(x => x.id === tops[0].id); const tp = CodeKit.textPropOf({ name: c.component, props: c.spec });
      top.code = { pkg, name: c.component, props: c.props, from: item.id, ...(tp && typeof c.props[tp] === 'string' ? { text: tp } : {}) };
      item.code = { pkg, name: c.component, spec: { group: s.group || c.component, props: c.spec, story: `${sb}/?path=/story/${s.story}` } };
    }
    const saved = await LibStore.putItem(item);
    return { n: saved.blocks.length, kb: Math.round(JSON.stringify(saved).length / 1024) };
  }, { s, c: { component: c.component, props: c.props, spec: c.spec }, cap: crop(c.cap, c.box, s.label), libId, pkg: PKG, sb: SB });
  console.log('item', s.key, JSON.stringify(r));
}
const lib = await app.evaluate(id => LibStore.exportJSON([id]), libId);
writeFileSync(OUT, JSON.stringify(lib));
console.log(`wrote ${OUT}: ${lib.lgLibrary.items.length} items`);
await browser.close();
