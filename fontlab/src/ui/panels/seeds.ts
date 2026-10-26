import { h, slider, fileInput, toast, iconButton, help } from '../dom';
import { icon } from '../icons';
import { store } from '../state';
import { scheduleBuild } from '../buildClient';
import { DrawCanvas } from '../../inputs/draw/canvas';
import { PointEditor } from '../../inputs/draw/editor';
import { history } from '../history';
import type { Glyph, Stroke, CapStyle } from '../../core/glyph';
import { DEFAULT_STATS } from '../../core/glyph';
import { projectCharset, groupCharset, BLOCK_BY_ID } from '../../core/charsets';
import { charsetPanel } from './charset';
import { generateGlyphs, regenerateOne, dependentsOf } from '../../generate/compose';
import { measureStats } from '../../generate/stats';
import { importFontFile } from '../../inputs/fontimport';
import { outlineToStrokes } from '../../inputs/fontimport/toStrokes';
import { openImageDialog } from './imageDialog';

function blankGlyph(ch: string): Glyph {
  const upper = /[A-Z0-9]/.test(ch);
  return { char: ch, unicode: ch.codePointAt(0)!, advance: upper ? 620 : 520, source: 'drawn', kind: 'stroke', strokes: [] };
}

const SIDEBEARING = 60;

export function hasInk(g: Glyph | undefined | null): boolean {
  if (!g) return false;
  return (g.strokes?.some((s) => s.points.length > 0) ?? false) || (g.contours?.some((c) => c.points.length >= 3) ?? false);
}

/** Slide the ink so it starts at a fixed left sidebearing and fit the advance to it (typewriter-style). */
export function normalizeSidebearings(g: Glyph): void {
  if (g.kind !== 'stroke' || !g.strokes?.length) return;
  const pts = g.strokes.flatMap((st) => st.points);
  if (!pts.length) return;
  const minX = Math.min(...pts.map((p) => p.x - p.w));
  const maxX = Math.max(...pts.map((p) => p.x + p.w));
  const dx = SIDEBEARING - minX;
  if (Math.abs(dx) > 0.5) for (const st of g.strokes) for (const p of st.points) p.x = Math.round((p.x + dx) * 10) / 10;
  g.advance = Math.round(maxX - minX + 2 * SIDEBEARING);
}

function collectSeeds(): Glyph[] {
  return Object.values(store.project.glyphs).filter((g) => g.source !== 'generated' && hasInk(g));
}

export function refreshStatsFromSeeds(): void {
  const seeds = collectSeeds();
  store.project.seeds = seeds;
  store.project.stats = measureStats(seeds, { ...DEFAULT_STATS });
  const s = store.project.stats;
  store.project.metrics = { ...store.project.metrics, xHeight: Math.round(s.xHeight), capHeight: Math.round(s.capHeight), ascender: Math.max(Math.round(s.ascender) + 40, Math.round(s.capHeight) + 60), descender: Math.min(Math.round(s.descender) - 20, -120) };
}

/** Accents / aliases / small caps built from `base` follow it when it changes. */
export function recomposeDependents(base: string): void {
  const deps = dependentsOf(base, projectCharset(store.project));
  if (!deps.length) return;
  const input = { seeds: store.project.seeds, stats: store.project.stats, mutation: store.project.mutation, glyphs: store.project.glyphs };
  store.update((p) => {
    for (const ch of deps) {
      const cur = p.glyphs[ch];
      if (cur && (cur.locked || (cur.source !== 'generated' && hasInk(cur)))) continue;
      p.glyphs[ch] = regenerateOne(ch, input, cur?.recipe?.seed ?? p.fx.seed);
    }
  }, 'glyph');
}

export function runGenerate(): void {
  for (const [ch, g] of Object.entries(store.project.glyphs)) if (!hasInk(g) && !g.locked) delete store.project.glyphs[ch];
  refreshStatsFromSeeds();
  const seedNumber = store.project.fx.seed;
  const chars = projectCharset(store.project);
  const generated = generateGlyphs({ seeds: store.project.seeds, stats: store.project.stats, mutation: store.project.mutation, glyphs: store.project.glyphs }, seedNumber, chars);
  store.update((p) => {
    const keep: Record<string, Glyph> = {};
    for (const ch of chars) keep[ch] = generated[ch] ?? p.glyphs[ch];
    for (const [ch, g] of Object.entries(p.glyphs)) if (!keep[ch] && g.source !== 'generated') keep[ch] = g;
    p.glyphs = keep;
  }, 'project');
  scheduleBuild(0);
  toast(`Generated ${Object.values(generated).filter((g) => g.source === 'generated').length} letters from ${store.project.seeds.length} seeds`);
}

/** Left column: Add letters (Draw / Photo / Font file tabs), character set, generate. */
export function seedsPanel(): HTMLElement {
  // ---------- draw tab
  const canvasEl = h('canvas', { class: 'editor' });
  const strip = h('div', { class: 'charstrip' });
  const title = h('div', { class: 'drawtitle' });
  const info = h('div', { class: 'info' });
  const dc = new DrawCanvas(canvasEl, store.project.metrics);
  let editMode = false;
  let editChar: string | null = null;
  const editor = new PointEditor(canvasEl, () => dc.getView(), {
    onChange: (g: Glyph) => {
      store.update((p) => { p.glyphs[g.char] = g; if (g.source === 'generated') g.source = 'drawn'; }, 'glyph');
      recomposeDependents(g.char);
      scheduleBuild(60);
      syncEditTools();
    },
    onSelect: () => syncEditTools(),
    redraw: () => dc.draw(),
  });
  dc.overlay = (ctx, view) => { if (editMode) editor.draw(ctx, view); };

  const select = (ch: string) => { store.selected = ch; store.emit('select'); syncEditor(); };
  const syncEditor = () => {
    const ch = store.selected;
    const g = store.project.glyphs[ch] ?? null;
    dc.metrics = store.project.metrics;
    dc.setGlyph(g ?? blankGlyph(ch), store.built[ch]?.contours ?? []);
    if (editMode) {
      if (g && hasInk(g)) {
        // same letter still open: feed the latest glyph back (keeps undo history); new letter: start fresh
        if (editor.enabled && editChar === ch) editor.setGlyph(g); else { editor.enable(g); editChar = ch; }
      } else { editMode = false; applyMode(); }
    }
    for (const b of strip.children) b.classList.toggle('selected', (b as HTMLElement).dataset.ch === ch);
    const src = g ? ({ drawn: 'drawn by hand', traced: 'traced from a photo', imported: 'from a font file', generated: 'generated' } as const)[g.source] : 'empty';
    const ns = g?.strokes?.length ?? 0, nc = g?.contours?.length ?? 0;
    const parts = !g ? 'draw to create' : g.kind === 'stroke' ? `${ns} strokes` : `${nc} contours${ns ? ` + ${ns} stroke${ns === 1 ? '' : 's'}` : ''}`;
    title.replaceChildren(h('span', { class: 'big' }, ch), h('small', {}, `${src}${g?.locked ? ' · locked' : ''} · ${parts}`));
    info.textContent = editMode
      ? 'Edit points: drag nodes and handles. Double-click a segment to add a point, Delete removes, Alt+drag a node changes its width, Ctrl/Cmd+Z undoes.'
      : g?.source === 'generated' ? 'Generated from your seeds. Draw over it to replace it, re-roll for another take, or switch to Edit points.' : 'Draw with mouse, pen or finger. Pressure and speed change the width. Edit points lets you adjust what is there.';
  };
  const renderStrip = () => {
    strip.replaceChildren();
    for (const [block, chars] of groupCharset(projectCharset(store.project))) {
      strip.append(h('div', { class: 'strip-group' }, BLOCK_BY_ID[block]?.name ?? 'Custom'));
      for (const ch of chars) strip.append(h('button', { type: 'button', class: 'chbtn' + (BLOCK_BY_ID[block]?.rtl ? ' rtl' : ''), 'data-ch': ch, onClick: () => select(ch) }, ch));
    }
  };
  renderStrip();

  dc.onStroke = (s: Stroke) => {
    const ch = store.selected;
    store.update((p) => {
      let g = p.glyphs[ch];
      if (!g || g.source === 'generated') { g = blankGlyph(ch); p.glyphs[ch] = g; }
      g.strokes = g.strokes ?? []; // outline letters keep their outline: the stroke is added on top
      g.strokes.push(s);
      g.source = g.source === 'generated' ? 'drawn' : g.source;
      normalizeSidebearings(g);
    }, 'glyph');
    recomposeDependents(ch);
    scheduleBuild(40);
  };

  // tools
  const brush = dc.brush;
  const widthRow = slider('Width', { min: 14, max: 220, step: 1, value: brush.width, onInput: (v) => (brush.width = v), format: (v) => v.toFixed(0) });
  const pressureRow = slider('Pressure', { min: 0, max: 1, step: 0.05, value: brush.pressure, onInput: (v) => (brush.pressure = v) });
  const velRow = slider('Speed thins', { min: 0, max: 1, step: 0.05, value: brush.velocity, onInput: (v) => (brush.velocity = v) });
  const smoothRow = slider('Smooth', { min: 0, max: 1, step: 0.05, value: brush.smooth, onInput: (v) => (brush.smooth = v) });
  const capSel = h('select', { class: 'cap' }, ...(['round', 'flat', 'taper'] as CapStyle[]).map((c) => h('option', { value: c }, c)));
  capSel.addEventListener('change', () => (brush.cap = capSel.value as CapStyle));
  const mirror = h('input', { type: 'checkbox' });
  mirror.addEventListener('change', () => (brush.mirror = mirror.checked));
  const advRow = slider('Advance', { min: 100, max: 1400, step: 1, value: 520, onInput: (v) => { store.update((p) => { const g = p.glyphs[store.selected]; if (g) g.advance = v; }, 'glyph'); scheduleBuild(80); }, format: (v) => v.toFixed(0) });

  const undoProject = () => {
    if (!history.undo(store.project)) { toast('Nothing to undo'); return; }
    store.emit('glyph'); scheduleBuild(0);
  };
  const redoProject = () => {
    if (!history.redo(store.project)) { toast('Nothing to redo'); return; }
    store.emit('glyph'); scheduleBuild(0);
  };
  const undoBtn = iconButton('undo', 'Undo', () => { if (editMode) editor.undo(); else undoProject(); }, { title: 'Undo the last change to the font: stroke, delete, generate, import… (Ctrl/Cmd+Z)', testid: 'btn-undo' });
  const redoBtn = iconButton('redo', 'Redo', () => { if (editMode) editor.redo(); else redoProject(); }, { iconOnly: true, title: 'Redo (Shift+Ctrl/Cmd+Z)', testid: 'btn-redo' });
  window.addEventListener('keydown', (e) => {
    if (editor.enabled) return; // the point editor has its own history while open
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) redoProject(); else undoProject(); }
    else if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redoProject(); }
  });
  const clear = iconButton('trash', 'Clear', () => { store.update((p) => { delete p.glyphs[store.selected]; }, 'glyph'); recomposeDependents(store.selected); scheduleBuild(0); }, { title: 'Remove this letter (it can be regenerated)' });
  const lock = iconButton('lock', 'Lock', () => { store.update((p) => { const g = p.glyphs[store.selected]; if (g) g.locked = !g.locked; }, 'glyph'); }, { title: 'Locked letters are never regenerated' });
  const reroll = iconButton('dice', 'Re-roll', () => {
    const ch = store.selected, g = store.project.glyphs[ch];
    if (!g || g.source !== 'generated') { toast('Re-roll works on generated letters'); return; }
    const ng = regenerateOne(ch, { seeds: store.project.seeds, stats: store.project.stats, mutation: store.project.mutation, glyphs: store.project.glyphs }, Math.floor(Math.random() * 1e9));
    if (ng) store.update((p) => { p.glyphs[ch] = ng; }, 'glyph');
    recomposeDependents(ch); scheduleBuild(0);
  }, { title: 'Generate this letter again with a new seed' });
  const toStrokesBtn = iconButton('wave', 'To strokes', () => {
    const ch = store.selected, g = store.project.glyphs[ch];
    if (!g || g.kind !== 'outline') { toast('Only outline letters (from a font or traced as outline) can be converted'); return; }
    store.update((p) => { p.glyphs[ch] = outlineToStrokes(g); }, 'glyph');
    recomposeDependents(ch); scheduleBuild(0);
  }, { title: 'Convert this outline letter into centreline strokes' });
  const editBtn = iconButton('nodes', 'Edit points', () => { editMode = !editMode; applyMode(); }, { title: 'Move, add and delete points and curve handles', testid: 'btn-edit-points' });
  const nodeWidth = slider('Point width', { min: 2, max: 200, step: 1, value: 40, onInput: (v) => editor.setSelectedWidth(v), format: (v) => v.toFixed(0) });
  const editTools = h('div', { class: 'row edittools' }, nodeWidth, h('small', { class: 'muted' }, 'Alt+drag a node also changes width'));
  const applyMode = () => {
    const g = store.project.glyphs[store.selected];
    if (editMode && !(g && hasInk(g))) { editMode = false; toast('Nothing to edit yet. Draw or import this letter first.'); }
    dc.mode = editMode ? 'edit' : 'draw';
    editBtn.classList.toggle('primary', editMode);
    editTools.style.display = editMode ? '' : 'none';
    canvasEl.classList.toggle('editing', editMode);
    if (editMode && g) { editor.enable(g); editChar = store.selected; } else { editor.disable(); editChar = null; }
    syncEditor();
    dc.draw();
  };
  const syncEditTools = () => { const w = editor.getSelectedWidth(); if (w != null) (nodeWidth as any).setValue(w); };

  const mutationRow = slider('Mutation', { min: 0, max: 1, step: 0.05, value: store.project.mutation, onInput: (v) => (store.project.mutation = v) });
  const genBtn = iconButton('sparkle', 'Generate the rest of the alphabet', () => {
    if (collectSeeds().length === 0) toast('No seeds yet: generating a default alphabet. Draw or import a few letters for your own style.');
    runGenerate();
  }, { cls: 'primary big', testid: 'btn-generate' });

  // ---------- photo tab
  const imgFile = fileInput('image/*,video/*', (f) => openImageDialog(f, () => { refreshStatsFromSeeds(); scheduleBuild(0); }));
  const photoTab = h('div', { class: 'tab-body' },
    h('p', {}, 'Photograph handwriting, a type specimen, or pick a frame from a video. Light-on-dark is detected, frames and halos are removed and glued letters are split. You label each tile with its letter.'),
    iconButton('image', 'Choose photo or video', () => imgFile.click(), { cls: 'primary', testid: 'btn-photo' }), imgFile);

  // ---------- font file tab
  const convertOnImport = h('input', { type: 'checkbox', checked: false, 'data-testid': 'chk-strokes' });
  const fontFile = fileInput('.ttf,.otf,.woff,.woff2', async (f) => {
    try {
      const imp = await importFontFile(await f.arrayBuffer(), projectCharset(store.project));
      if (convertOnImport.checked) { toast(`Converting ${imp.glyphs.length} letters to strokes…`); await new Promise((r) => setTimeout(r, 30)); imp.glyphs = outlineToStrokes_all(imp.glyphs); }
      store.update((p) => {
        for (const g of imp.glyphs) p.glyphs[g.char] = g;
        p.metrics = { ...p.metrics, ...imp.metrics, upm: 1000 };
        if (!p.name || p.name === 'Untitled') p.name = imp.familyName + ' remix';
      }, 'project');
      refreshStatsFromSeeds();
      const hadFx = store.project.fx.groups.some((g) => g.enabled && g.layers.some((l) => l.enabled));
      if (hadFx) { store.bypassFx = true; store.emit('bypass'); }
      scheduleBuild(0);
      toast(`Imported ${imp.glyphs.length} letters from ${imp.familyName}${hadFx ? '. Showing the original; untick “Show original” in Effects when ready.' : ''}`);
    } catch (e) { toast('Could not read that font: ' + (e as Error).message); }
  });
  const fontTab = h('div', { class: 'tab-body' },
    h('p', {}, 'Open a .ttf, .otf, .woff or .woff2. The letters come in exactly as they are, ready for crisp effects or point editing.'),
    iconButton('upload', 'Choose font file', () => fontFile.click(), { cls: 'primary', testid: 'btn-font' }), fontFile,
    h('label', { class: 'toggle' }, convertOnImport, ' Convert to centreline strokes ', help('Needed for Weight, terminals and variable axes. Changes the exact shapes (round ends, single-width strokes).')),
    iconButton('wave', 'Convert all outlines to strokes', () => {
      const n = Object.values(store.project.glyphs).filter((g) => g.kind === 'outline').length;
      if (!n) { toast('No outline letters to convert'); return; }
      store.update((p) => { for (const [ch, g] of Object.entries(p.glyphs)) if (g.kind === 'outline') p.glyphs[ch] = outlineToStrokes(g); }, 'project');
      refreshStatsFromSeeds(); scheduleBuild(0); toast(`Converted ${n} letters to strokes`);
    }, { testid: 'btn-all-strokes' }));

  // ---------- draw tab body
  const drawTab = h('div', { class: 'tab-body draw' },
    strip, title, canvasEl, info,
    h('div', { class: 'row' }, undoBtn, redoBtn, clear, lock, reroll, toStrokesBtn, editBtn),
    editTools,
    h('details', { class: 'brush' }, h('summary', {}, 'Brush'), widthRow, pressureRow, velRow, smoothRow,
      h('div', { class: 'row' }, h('label', {}, 'Cap ', capSel), h('label', {}, mirror, ' Mirror')), advRow),
  );
  editTools.style.display = 'none';

  // ---------- tabs
  const tabs: { id: string; label: string; icon: 'pen' | 'image' | 'type'; body: HTMLElement }[] = [
    { id: 'draw', label: 'Draw', icon: 'pen', body: drawTab },
    { id: 'photo', label: 'Photo or video', icon: 'image', body: photoTab },
    { id: 'font', label: 'Font file', icon: 'type', body: fontTab },
  ];
  const tabBar = h('div', { class: 'tabs', role: 'tablist' });
  const bodies = h('div', { class: 'tabbodies' });
  const showTab = (id: string) => {
    for (const t of tabs) { t.body.style.display = t.id === id ? '' : 'none'; }
    for (const b of tabBar.children) b.classList.toggle('active', (b as HTMLElement).dataset.tab === id);
    if (id === 'draw') dc.resize();
  };
  for (const t of tabs) {
    tabBar.append(h('button', { type: 'button', class: 'tab', role: 'tab', 'data-tab': t.id, 'data-testid': 'tab-' + t.id, onClick: () => showTab(t.id) }, icon(t.icon), h('span', {}, t.label)));
    bodies.append(t.body);
  }
  showTab('draw');

  const csPanel = charsetPanel(() => { renderStrip(); syncEditor(); scheduleBuild(0); });
  const panel = h('section', { class: 'panel seeds' },
    h('h2', {}, 'Add letters'),
    tabBar, bodies,
    csPanel,
    h('div', { class: 'gen' }, mutationRow, genBtn),
  );

  store.subscribe((ev) => {
    if (ev === 'project:loaded' || ev === 'charset') renderStrip();
    if (ev === 'built' || ev === 'glyph' || ev === 'select' || ev === 'project' || ev === 'project:loaded') {
      syncEditor();
      const g = store.project.glyphs[store.selected];
      if (g) (advRow as any).setValue(g.advance);
      if (ev === 'project:loaded') (mutationRow as any).setValue(store.project.mutation);
    }
  });
  select(store.selected);
  return panel;
}

function outlineToStrokes_all(glyphs: Glyph[]): Glyph[] { return glyphs.map((g) => (g.kind === 'outline' ? outlineToStrokes(g) : g)); }
