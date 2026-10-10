/* Code components: pieces of a coded design system (React components such as a Button with variant="primary") placed
   on the canvas. A manifest lists the components, how to import them and their props with allowed values; importing it
   into a shared library makes one item per component. On the canvas each one is a stand-in drawn from its name and
   props (a pill for a Button, a field for an Input, a card for a Card…), tied to the real component by `code` on its
   top box: {pkg, name, props, text}. Changing a prop in the panel redraws the stand-in; React export writes the real
   component (<Button variant="primary">Save</Button>) with its import instead of divs.
   Manifest: {lgComponents: {v: 1, name, components: [{name, import, group, props: [{name, type, values, default,
   required, description}], story}]}} — tools/ds-manifest.mjs builds one from a design-system repo. */
const CodeKit = (() => {
  const SKIP = /(Provider|Context|ApiRef|Ref|Props|Theme|Hook|Utils?)$|^use[A-Z]|^Use[A-Z]/;
  const TEXT_PROPS = ['label', 'title', 'header', 'heading', 'text', 'children', 'content', 'message', 'description'];
  // When a component documents no text prop (often inherited ones), the usual one for its kind.
  const TEXT_BY_KIND = { chip: 'label', tooltip: 'title', input: 'label', checkbox: 'label', radio: 'label', switch: 'label', avatar: 'children', iconbutton: null, divider: null, loader: null, icon: null, table: null, generic: null, layout: null };
  const KINDS = [
    ['iconbutton', /IconButton|Fab$/], ['button', /Button|CTA|^Link$|Action$/], ['chip', /Chip|Tag|Badge|Pill|Status|Lozenge/],
    ['avatar', /Avatar/], ['switch', /Switch|Toggle/], ['checkbox', /Checkbox/], ['radio', /Radio/],
    ['input', /Input|TextField|Field$|Autocomplete|Select|Dropdown|DatePicker|TimePicker|Search|Combobox|TextArea|Textarea|Composer|Upload/],
    ['dialog', /Modal|Dialog|Drawer|Sheet|Popover|Window$/], ['table', /Table|DataGrid/], ['tabs', /Tabs?$|Segmented/],
    ['alert', /Alert|Banner|Toast|Snackbar|Notice|Callout|Announcement/], ['card', /Card|Tile|Panel|Widget/],
    ['heading', /^H[1-6]$|Heading|Title$|PageHeader|Header$/], ['text', /^P$|Caption|Text$|Typography|Paragraph|RichText/],
    ['loader', /Loader|Spinner|Progress|Skeleton|Thinking|Typing|Indicator/], ['divider', /Divider|Separator/],
    ['steps', /Stepper|Steps?$|Breadcrumb|Timeline/], ['accordion', /Accordion|Collapse|Expand|Disclosure/], ['tooltip', /Tooltip/],
    ['menu', /Menu|List$|Nav/], ['icon', /Icon$|Logo$/], ['layout', /Layout|Page$|Stack|Box$|Wrapper|Container|Grid$|Shell/],
  ];
  const kindOf = name => (KINDS.find(([, re]) => re.test(name)) || ['generic'])[0];
  const esc = s => String(s ?? '');
  // ---- manifest ---------------------------------------------------------------------------------------------------------
  function readManifest(j) {
    const M = j && (j.lgComponents || j);
    if (!M || !Array.isArray(M.components)) throw new Error('not a component manifest (lgComponents)');
    const out = [];
    for (const c of M.components.slice(0, 1500)) {
      const name = String(c && c.name || '').trim(); if (!/^[A-Z][A-Za-z0-9]{0,60}$/.test(name) || SKIP.test(name)) continue;
      const props = (Array.isArray(c.props) ? c.props : []).filter(p => p && /^[A-Za-z_$][\w$]{0,40}$/.test(p.name)).slice(0, 60).map(p => ({ name: p.name, type: String(p.type || '').slice(0, 200), values: Array.isArray(p.values) ? p.values.map(String).filter(v => v.length < 40).slice(0, 30) : undefined, default: p.default != null && p.default !== '-' ? String(p.default).replace(/^`+|`+$/g, '').replace(/^'(.*)'$/, '$1').slice(0, 60) : undefined, required: !!p.required, description: p.description ? String(p.description).slice(0, 160) : undefined }));
      out.push({ name, pkg: String(c.import || M.import || '').slice(0, 80) || 'components', group: String(c.group || name).slice(0, 60), props, story: /^https:\/\/[^\s"'<>]+$/.test(String(c.story || '')) ? String(c.story).slice(0, 300) : undefined });
    }
    return { name: String(M.name || 'Components').slice(0, 60), components: out };
  }
  function textPropOf(spec) {
    const names = new Set((spec.props || []).map(p => p.name)); const named = TEXT_PROPS.find(n => names.has(n)); if (named) return named;
    const k = kindOf(spec.name); return k in TEXT_BY_KIND ? TEXT_BY_KIND[k] : 'children';
  }
  const isBool = p => /^boolean$/.test(String(p.type).replace(/[`\s]/g, ''));
  // What a prop is when nobody sets it (from the documented defaults).
  function specDefaults(spec) {
    const out = {};
    for (const p of spec.props || []) { if (p.values && p.default && p.values.includes(p.default)) out[p.name] = p.default; else if (isBool(p) && /^(true|false)$/.test(p.default || '')) out[p.name] = p.default === 'true'; }
    return out;
  }
  // Props a fresh stand-in sets explicitly: the first allowed value of a style prop that has no default.
  function defaultProps(spec) {
    const out = {}; const tp = textPropOf(spec);
    for (const p of spec.props || []) if (p.name !== tp && p.values && p.values.length && !(p.default && p.values.includes(p.default)) && (p.required || /^(variant|size|color|type|kind|appearance|intent|status)$/.test(p.name))) out[p.name] = p.values[0];
    return out;
  }
  const sampleText = (name, kind) => ({ button: name.replace(/Button$/, '') || 'Button', iconbutton: '', chip: 'Label', heading: 'Page title', text: 'Body text that explains the screen.', input: 'Label', alert: 'Something to know about this page.', tooltip: 'Helpful hint', card: name.replace(/([a-z])([A-Z])/g, '$1 $2'), dialog: 'Dialog title', tabs: 'Overview', accordion: 'Section', menu: 'Menu item', steps: 'Step', avatar: 'AM', checkbox: 'Option', radio: 'Option', switch: 'Setting' }[kind] || name.replace(/([a-z])([A-Z])/g, '$1 $2'));
  // ---- stand-ins --------------------------------------------------------------------------------------------------------
  let seq = 0; const nid = p => `${p}${Date.now().toString(36).slice(-3)}${(++seq).toString(36)}`;
  const stackS = (mode, gap, pad, more = {}) => ({ v: 2, mode, wrap: false, gap, gapAuto: false, counterGap: gap, counterGapAuto: false, pad: typeof pad === 'number' ? { t: pad, r: pad, b: pad, l: pad } : pad, main: 'start', cross: 'start', ...more });
  function tone(props, P) {
    const all = Object.values(props).map(v => String(v).toLowerCase()).join(' ');
    const intent = /danger|error|destructive|critical|negative/.test(all) ? '#D93D3D' : /success|positive|approved/.test(all) ? '#1C8C5E' : /warning|caution|pending/.test(all) ? '#C77A00' : /info|neutral/.test(all) ? '#2F6FDB' : P.core;
    const style = /outline|secondary|stroked/.test(all) ? 'outline' : /tertiary|text|ghost|link|plain|minimal/.test(all) ? 'text' : /soft|subtle|light|tonal/.test(all) ? 'soft' : 'solid';
    const scale = /\b(x?small|sm|xs|compact|dense)\b/.test(all) ? 0.82 : /\b(large|lg|xl)\b/.test(all) ? 1.18 : 1;
    return { intent, style, scale, disabled: props.disabled === true || /disabled/.test(all) };
  }
  // A stand-in for one component: a block list whose first block is the top box carrying `code`.
  function standIn(spec, props, kit, texts) {
    const P = Library.palette(kit); const B = Brand.fontCss(kit.fonts.body); const D = Brand.fontCss(kit.fonts.display);
    const kind = kindOf(spec.name); const tp = textPropOf(spec); props = props || defaultProps(spec);
    const T = tone({ ...specDefaults(spec), ...props }, P); const s = v => Math.round(v * T.scale);
    const ink = '#1B1B23', muted = '#6B6B78', line = '#DCDAE5', soft = '#EFEBFA';
    const queue = Array.isArray(texts) ? texts.slice() : [];
    const label = (fallback) => queue.length ? queue.shift() : (tp && props[tp] != null && typeof props[tp] !== 'object' ? String(props[tp]) : fallback);
    const text = (t, size, weight, fill, more = {}) => ({ id: nid('t'), kind: 'text', role: more.role || 'text', path: 'text_' + nid('p'), text: label(t), x: 0, y: 0, w: more.w || 280, h: size * 1.3, font: { family: more.display ? D : B, weight, size, lineHeight: more.lh || 1.3, letterSpacing: 0 }, fill, align: 'left', decorative: false, sizeW: more.sizeW || 'hug', sizeH: 'hug', ...(more.label ? { label: more.label } : {}) });
    const box = (props2 = {}) => ({ id: nid('bx'), kind: 'box', x: 0, y: 0, w: 100, h: 100, fill: 'none', radius: 0, clip: false, decorative: true, ...props2 });
    const field = (w, h, fill, more = {}) => ({ id: nid('f'), kind: 'field', x: 0, y: 0, w, h, fill, radius: 0, decorative: true, ...more });
    const circle = (d, fill, more = {}) => ({ id: nid('c'), kind: 'shape', shape: 'circle', x: 0, y: 0, w: d, h: d, fill, decorative: true, ...more });
    const tree = (parent, ...kids) => { const out = [parent]; for (const k of kids) { if (!k) continue; const list = Array.isArray(k) ? k : [k]; list[0].parent = parent.id; out.push(...list); } return out; };
    const solid = T.style === 'solid', outline = T.style === 'outline', plain = T.style === 'text', tint = T.style === 'soft';
    const bg = solid ? T.intent : tint ? soft : 'none'; const fg = solid ? '#FFFFFF' : T.intent;
    let root, list;
    switch (kind) {
      case 'button': root = box({ radius: 999, fill: bg, ...(outline ? { stroke: { color: T.intent, width: 1.5 } } : {}), auto: stackS('horizontal', 8, plain ? { t: s(8), r: s(4), b: s(8), l: s(4) } : { t: s(10), r: s(20), b: s(10), l: s(20) }, { main: 'center', cross: 'center' }), sizeW: 'hug', sizeH: 'hug' }); list = tree(root, text(sampleText(spec.name, kind), s(15), 600, fg)); break;
      case 'iconbutton': root = box({ radius: 999, fill: solid ? T.intent : soft, w: s(40), h: s(40), auto: stackS('horizontal', 0, 0, { main: 'center', cross: 'center' }), sizeW: 'fixed', sizeH: 'fixed' }); list = tree(root, { id: nid('ic'), kind: 'icon', name: 'plus', x: 0, y: 0, w: s(20), h: s(20), fill: solid ? '#FFFFFF' : T.intent, decorative: true }); break;
      case 'chip': root = box({ radius: 999, fill: solid && T.intent !== P.core ? T.intent : soft, ...(outline ? { fill: 'none', stroke: { color: line, width: 1 } } : {}), auto: stackS('horizontal', 6, { t: s(4), r: s(10), b: s(4), l: s(10) }, { cross: 'center' }), sizeW: 'hug', sizeH: 'hug' }); list = tree(root, text(sampleText(spec.name, kind), s(13), 600, solid && T.intent !== P.core ? '#FFFFFF' : T.intent === P.core ? P.deep : T.intent)); break;
      case 'avatar': root = box({ radius: 999, fill: soft, w: s(40), h: s(40), auto: stackS('horizontal', 0, 0, { main: 'center', cross: 'center' }), sizeW: 'fixed', sizeH: 'fixed', clip: true }); list = tree(root, text('AM', s(15), 600, P.deep)); break;
      case 'switch': { root = box({ auto: stackS('horizontal', 10, 0, { cross: 'center' }), sizeW: 'hug', sizeH: 'hug' }); const track = box({ radius: 999, fill: T.intent, w: 40, h: 24, auto: stackS('horizontal', 0, 3, { main: 'end', cross: 'center' }), sizeW: 'fixed', sizeH: 'fixed' }); list = tree(root, tree(track, circle(18, '#FFFFFF')), text(sampleText(spec.name, kind), 15, 400, ink)); break; }
      case 'checkbox': case 'radio': { root = box({ auto: stackS('horizontal', 10, 0, { cross: 'center' }), sizeW: 'hug', sizeH: 'hug' }); list = tree(root, field(20, 20, T.intent, { radius: kind === 'radio' ? 10 : 5 }), text(sampleText(spec.name, kind), 15, 400, ink)); break; }
      case 'input': { root = box({ w: 320, auto: stackS('vertical', 6, 0), sizeW: 'fixed', sizeH: 'hug' }); const f = box({ radius: 8, fill: '#FFFFFF', stroke: { color: T.intent !== P.core ? T.intent : line, width: 1 }, auto: stackS('horizontal', 8, { t: 11, r: 14, b: 11, l: 14 }, { cross: 'center' }), sizeW: 'fill', sizeH: 'hug' }); list = tree(root, text(sampleText(spec.name, kind), 13, 600, ink), tree(f, text(/Search/.test(spec.name) ? 'Search' : /Select|Dropdown|Autocomplete|Combobox/.test(spec.name) ? 'Choose…' : /Date/.test(spec.name) ? 'DD/MM/YYYY' : 'Placeholder', 15, 400, muted, { sizeW: 'fill', w: 260 }))); break; }
      case 'dialog': { root = box({ w: 480, radius: 16, fill: '#FFFFFF', shadow: { on: true, x: 0, y: 16, blur: 40, color: '#191A25', alpha: 0.18 }, auto: stackS('vertical', 16, 24), sizeW: 'fixed', sizeH: 'hug' }); const acts = box({ auto: stackS('horizontal', 8, 0, { main: 'end' }), sizeW: 'fill', sizeH: 'hug' }); list = tree(root, text(sampleText(spec.name, kind), 22, 600, ink, { display: true }), text('Supporting text for this dialog goes here.', 15, 400, muted, { sizeW: 'fill', w: 420 }), tree(acts, tree(box({ radius: 999, stroke: { color: line, width: 1 }, auto: stackS('horizontal', 0, { t: 9, r: 18, b: 9, l: 18 }), sizeW: 'hug', sizeH: 'hug' }), text('Cancel', 14, 600, ink)), tree(box({ radius: 999, fill: P.core, auto: stackS('horizontal', 0, { t: 9, r: 18, b: 9, l: 18 }), sizeW: 'hug', sizeH: 'hug' }), text('Confirm', 14, 600, '#FFFFFF')))); break; }
      case 'table': { root = box({ w: 560, radius: 12, fill: '#FFFFFF', stroke: { color: line, width: 1 }, clip: true, auto: stackS('vertical', 0, 0), sizeW: 'fixed', sizeH: 'hug' }); const row = (cells, head) => tree(box({ fill: head ? '#F6F5FA' : 'none', auto: stackS('horizontal', 0, { t: 12, r: 16, b: 12, l: 16 }), sizeW: 'fill', sizeH: 'hug' }), ...cells.map(c => text(c, 14, head ? 600 : 400, head ? muted : ink, { sizeW: 'fill', w: 160 }))); list = tree(root, row(['Name', 'Country', 'Status'], true), row(['Alex Morgan', 'Portugal', 'Active']), row(['Priya Natarajan', 'India', 'Onboarding']), row(['Jordan Reyes', 'Mexico', 'Active'])); break; }
      case 'tabs': { root = box({ auto: stackS('horizontal', 24, 0), sizeW: 'hug', sizeH: 'hug' }); const tab = (t, on) => tree(box({ auto: stackS('vertical', 8, 0), sizeW: 'hug', sizeH: 'hug' }), text(t, 15, on ? 600 : 400, on ? ink : muted), field(on ? 56 : 1, 2, on ? T.intent : 'none', { alpha: on ? 1 : 0, sizeW: 'fill' })); list = tree(root, tab(sampleText(spec.name, kind), true), tab('Details', false), tab('Activity', false)); break; }
      case 'alert': { root = box({ w: 520, radius: 10, fill: T.intent === P.core ? soft : T.intent + '1A', stroke: { color: T.intent, width: 1 }, auto: stackS('horizontal', 12, { t: 12, r: 16, b: 12, l: 16 }, { cross: 'center' }), sizeW: 'fixed', sizeH: 'hug' }); list = tree(root, { id: nid('ic'), kind: 'icon', name: 'info', x: 0, y: 0, w: 20, h: 20, fill: T.intent, decorative: true }, text(sampleText(spec.name, kind), 15, 400, ink, { sizeW: 'fill', w: 440 })); break; }
      case 'card': { root = box({ w: 360, radius: 16, fill: '#FFFFFF', stroke: { color: line, width: 1 }, auto: stackS('vertical', 8, 20), sizeW: 'fixed', sizeH: 'hug' }); list = tree(root, text(sampleText(spec.name, kind), 18, 600, ink, { sizeW: 'fill', w: 320 }), text('Short supporting text for this card.', 14, 400, muted, { sizeW: 'fill', w: 320 })); break; }
      case 'heading': root = box({ auto: stackS('vertical', 0, 0), sizeW: 'hug', sizeH: 'hug' }); list = tree(root, text(sampleText(spec.name, kind), /H1/.test(spec.name) ? 40 : /H2/.test(spec.name) ? 32 : /H4/.test(spec.name) ? 20 : 26, 600, ink, { display: true, lh: 1.15, role: 'headline' })); break;
      case 'text': root = box({ auto: stackS('vertical', 0, 0), sizeW: 'hug', sizeH: 'hug' }); list = tree(root, text(sampleText(spec.name, kind), /Caption/.test(spec.name) ? 12 : 15, 400, /Caption/.test(spec.name) ? muted : ink)); break;
      case 'loader': root = box({ auto: stackS('horizontal', 6, 0, { cross: 'center' }), sizeW: 'hug', sizeH: 'hug' }); list = tree(root, circle(10, T.intent), circle(10, T.intent, { opacity: 0.6 }), circle(10, T.intent, { opacity: 0.3 })); break;
      case 'divider': root = box({ w: 320, auto: stackS('vertical', 0, { t: 8, r: 0, b: 8, l: 0 }), sizeW: 'fixed', sizeH: 'hug' }); list = tree(root, field(320, 1, line, { sizeW: 'fill' })); break;
      case 'steps': { root = box({ auto: stackS('horizontal', 10, 0, { cross: 'center' }), sizeW: 'hug', sizeH: 'hug' }); const step = (n, on) => tree(box({ auto: stackS('horizontal', 8, 0, { cross: 'center' }), sizeW: 'hug', sizeH: 'hug' }), tree(box({ radius: 999, fill: on ? T.intent : '#ECEAF2', w: 24, h: 24, auto: stackS('horizontal', 0, 0, { main: 'center', cross: 'center' }), sizeW: 'fixed', sizeH: 'fixed' }), text(String(n), 12, 600, on ? '#FFFFFF' : muted)), text(n === 1 ? sampleText(spec.name, kind) : 'Step', 14, on ? 600 : 400, on ? ink : muted)); list = tree(root, step(1, true), field(32, 1, line), step(2, false), field(32, 1, line), step(3, false)); break; }
      case 'accordion': { root = box({ w: 480, radius: 10, stroke: { color: line, width: 1 }, auto: stackS('horizontal', 0, { t: 14, r: 16, b: 14, l: 16 }, { gapAuto: true, cross: 'center' }), sizeW: 'fixed', sizeH: 'hug' }); list = tree(root, text(sampleText(spec.name, kind), 15, 600, ink), { id: nid('ic'), kind: 'icon', name: 'caret-down', x: 0, y: 0, w: 18, h: 18, fill: muted, decorative: true }); break; }
      case 'tooltip': root = box({ radius: 6, fill: '#1B1B23', auto: stackS('horizontal', 0, { t: 6, r: 10, b: 6, l: 10 }), sizeW: 'hug', sizeH: 'hug' }); list = tree(root, text(sampleText(spec.name, kind), 13, 500, '#FFFFFF')); break;
      case 'menu': { root = box({ w: 240, radius: 10, fill: '#FFFFFF', stroke: { color: line, width: 1 }, auto: stackS('vertical', 0, 6), sizeW: 'fixed', sizeH: 'hug', shadow: { on: true, x: 0, y: 8, blur: 24, color: '#191A25', alpha: 0.12 } }); const it = t => tree(box({ radius: 6, auto: stackS('horizontal', 0, { t: 9, r: 10, b: 9, l: 10 }), sizeW: 'fill', sizeH: 'hug' }), text(t, 14, 400, ink)); list = tree(root, it(sampleText(spec.name, kind)), it('Rename'), it('Duplicate')); break; }
      case 'icon': root = box({ w: 32, h: 32, auto: stackS('horizontal', 0, 0, { main: 'center', cross: 'center' }), sizeW: 'fixed', sizeH: 'fixed' }); list = tree(root, { id: nid('ic'), kind: 'icon', name: 'sparkle', x: 0, y: 0, w: 28, h: 28, fill: T.intent, decorative: true }); break;
      default: { root = box({ w: kind === 'layout' ? 480 : 240, radius: 10, fill: '#FAFAFD', stroke: { color: '#B9B4D0', width: 1 }, auto: stackS('vertical', 4, 16, { main: 'center', cross: 'center' }), sizeW: 'fixed', sizeH: 'hug' }); list = tree(root, text('<' + spec.name + ' />', 14, 600, P.deep), text(spec.group && spec.group !== spec.name ? spec.group : 'component', 12, 400, muted)); }
    }
    if (T.disabled) root.opacity = 0.45;
    root.label = spec.name;
    root.code = { pkg: spec.pkg, name: spec.name, props: { ...props }, ...(tp ? { text: tp } : {}), standIn: true };
    return list;
  }
  // Manifest -> library items (settled at 0,0 so thumbnails and inserts are right).
  function itemsFrom(manifest, kit, libId) {
    const M = readManifest(manifest); const out = [];
    for (const spec of M.components) {
      const s = Library.settle(standIn(spec, null, kit));
      out.push({ id: ('c' + libId + '-' + (spec.pkg + '-' + spec.name).replace(/[^A-Za-z0-9]+/g, '-')).slice(0, 64), lib: libId, name: spec.name, category: 'code', approved: true, created: Date.now(), w: s.w, h: s.h, blocks: s.blocks, code: { pkg: spec.pkg, name: spec.name, spec: { group: spec.group, props: spec.props, story: spec.story } } });
    }
    return { name: M.name, items: out };
  }
  // ---- on the canvas ----------------------------------------------------------------------------------------------------
  // The spec for a placed component, from whichever library item carries it.
  function specFor(code, items) {
    if (!code) return null;
    const it = (items || []).find(x => x.code && x.code.name === code.name && x.code.pkg === code.pkg && x.code.spec);
    return it ? { name: code.name, pkg: code.pkg, ...it.code.spec } : null;
  }
  // The code component a block belongs to: itself or its nearest boxed ancestor with `code`.
  function ownerOf(frame, b) { let cur = b; const seen = new Set(); while (cur && !seen.has(cur.id)) { if (cur.code) return cur; seen.add(cur.id); cur = cur.parent ? frame.layout.blocks.find(x => x.id === cur.parent) : null; } return null; }
  // Redraw a stand-in after its props changed, keeping its place, its sizing and the words people typed.
  function restyle(frame, root, spec, kit) {
    if (!root || !root.code || !root.code.standIn || !spec) return false;
    const all = frame.layout.blocks; const I = Auto.index(frame);
    const sub = Auto.withDescendants(frame, [root]); const subIds = new Set(sub.map(b => b.id));
    const texts = sub.filter(b => b.kind === 'text' && b.id !== root.id).map(b => b.text);
    const fresh = standIn({ ...spec, name: root.code.name, pkg: root.code.pkg }, root.code.props, kit, texts);
    const top = fresh[0]; const freshTop = top.id; const keep = ['id', 'x', 'y', 'parent', 'absolute', 'rx', 'ry', 'lx', 'ly', 'label', 'locked', 'hidden', 'minW', 'maxW', 'minH', 'maxH', 'rotation'];
    for (const k of keep) if (root[k] !== undefined) top[k] = root[k]; else delete top[k];
    // sizing someone chose stays: fill stays fill, a fixed width they set stays (a hugging stand-in keeps hugging)
    for (const [k, d] of [['sizeW', 'w'], ['sizeH', 'h']]) { if (root[k] === 'fill' && Auto.inFlow(I, root)) top[k] = 'fill'; else if (root[k] === 'fixed' && top[k] === 'fixed') top[d] = root[d]; }
    for (const b of fresh.slice(1)) if (b.parent === freshTop) b.parent = root.id;
    top.code.props = { ...root.code.props };
    const at = all.findIndex(b => b.id === root.id);
    const rest = all.filter(b => !subIds.has(b.id));
    const idx = rest.findIndex((b, i) => all.indexOf(b) > at); const pos = idx < 0 ? rest.length : idx;
    for (const b of fresh) { delete b.lx; delete b.ly; if (b.kind === 'text') Canvas.refit(b); }
    for (const b of fresh.slice(1)) { b.x += root.x; b.y += root.y; }
    frame.layout.blocks = [...rest.slice(0, pos), ...fresh, ...rest.slice(pos)];
    return true;
  }
  // The text a component passes on as its label or children: its first visible text.
  function textOf(frame, root) { const t = Auto.withDescendants(frame, [root]).find(b => b.kind === 'text' && !b.hidden && b.id !== root.id); return t ? Canvas.sourceText(t).trim() : ''; }
  // JSX attributes for props: strings quoted, booleans bare, numbers and the rest in braces.
  function jsxProps(props) {
    return Object.entries(props || {}).filter(([k, v]) => /^[A-Za-z_$][\w$]*$/.test(k) && v !== undefined && v !== null && v !== '').map(([k, v]) => v === true ? ` ${k}` : typeof v === 'string' ? ` ${k}=${JSON.stringify(v)}` : ` ${k}={${JSON.stringify(v)}}`).join('');
  }
  return { readManifest, itemsFrom, standIn, restyle, specFor, ownerOf, textOf, jsxProps, defaultProps, specDefaults, textPropOf, kindOf, isBool };
})();
