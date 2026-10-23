import { h, slider, button, fileInput, toast } from '../dom';
import { store } from '../state';
import { scheduleBuild } from '../buildClient';
import { DrawCanvas } from '../../inputs/draw/canvas';
import type { Glyph, Stroke, CapStyle } from '../../core/glyph';
import { DEFAULT_STATS } from '../../core/glyph';
import { projectCharset, groupCharset, BLOCK_BY_ID } from '../../core/charsets';
import { charsetPanel } from './charset';
import { generateGlyphs, regenerateOne, dependentsOf } from '../../generate/compose';
import { measureStats } from '../../generate/stats';
import { importFont } from '../../inputs/fontimport';
import { openImageDialog } from './imageDialog';

function blankGlyph(ch: string): Glyph {
  const upper = /[A-Z0-9]/.test(ch);
  return { char: ch, unicode: ch.codePointAt(0)!, advance: upper ? 620 : 520, source: 'drawn', kind: 'stroke', strokes: [] };
}

const SIDEBEARING = 60;

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

/** Which seeds does the generator get? Everything the user made by hand or imported. */
export function hasInk(g: Glyph | undefined | null): boolean {
  if (!g) return false;
  return g.kind === 'stroke' ? (g.strokes?.some((s) => s.points.length > 0) ?? false) : (g.contours?.some((c) => c.points.length >= 3) ?? false);
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
      p.glyphs[ch] = regenerateOne(ch, input, cur?.recipe?.seed ?? p.dna.seed);
    }
  }, 'glyph');
}

export function runGenerate(): void {
  // inkless leftovers (e.g. a cleared glyph) must not block generation
  for (const [ch, g] of Object.entries(store.project.glyphs)) if (!hasInk(g) && !g.locked) delete store.project.glyphs[ch];
  refreshStatsFromSeeds();
  const seedNumber = store.project.dna.seed;
  const chars = projectCharset(store.project);
  const generated = generateGlyphs({ seeds: store.project.seeds, stats: store.project.stats, mutation: store.project.mutation, glyphs: store.project.glyphs }, seedNumber, chars);
  store.update((p) => {
    const keep: Record<string, Glyph> = {};
    for (const ch of chars) keep[ch] = generated[ch] ?? p.glyphs[ch];
    // keep hand-made glyphs outside the current charset so switching blocks off is non-destructive
    for (const [ch, g] of Object.entries(p.glyphs)) if (!keep[ch] && g.source !== 'generated') keep[ch] = g;
    p.glyphs = keep;
  }, 'project');
  scheduleBuild(0);
  toast(`Generated ${Object.values(generated).filter((g) => g.source === 'generated').length} glyphs from ${store.project.seeds.length} seeds`);
}

export function seedsPanel(): HTMLElement {
  const canvasEl = h('canvas', { class: 'editor' });
  const strip = h('div', { class: 'charstrip' });
  const title = h('h2', {}, 'Draw ');
  const info = h('div', { class: 'info' });

  const dc = new DrawCanvas(canvasEl, store.project.metrics);

  const select = (ch: string) => {
    store.selected = ch;
    store.emit('select');
    syncEditor();
  };
  const syncEditor = () => {
    const ch = store.selected;
    const g = store.project.glyphs[ch] ?? null;
    dc.metrics = store.project.metrics;
    dc.setGlyph(g ?? blankGlyph(ch), store.built[ch]?.contours ?? []);
    for (const b of strip.children) b.classList.toggle('selected', (b as HTMLElement).dataset.ch === ch);
    title.replaceChildren('Draw ', h('span', { class: 'big' }, ch), ' ', h('small', {}, g ? `${g.source}${g.locked ? ' · locked' : ''} · ${g.kind === 'stroke' ? (g.strokes?.length ?? 0) + ' strokes' : (g.contours?.length ?? 0) + ' contours'}` : 'empty · draw to create'));
    info.textContent = g?.source === 'generated' ? 'Generated from your seeds. Draw over it to replace it, or re-roll for a different take.' : g?.kind === 'outline' ? 'Outline glyph (imported/traced). Drawing adds strokes on top.' : 'Draw with mouse, pen or finger. Pressure and speed change the width.';
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
      if (g.kind === 'outline') { g.kind = 'stroke'; g.strokes = g.strokes ?? []; g.contours = undefined; }
      g.strokes!.push(s);
      g.source = g.source === 'generated' ? 'drawn' : g.source;
      normalizeSidebearings(g);
    }, 'glyph');
    recomposeDependents(ch);
    scheduleBuild(40);
  };

  // brush controls
  const brush = dc.brush;
  const widthRow = slider('Width', { min: 14, max: 220, step: 1, value: brush.width, onInput: (v) => (brush.width = v), format: (v) => v.toFixed(0) });
  const pressureRow = slider('Pressure', { min: 0, max: 1, step: 0.05, value: brush.pressure, onInput: (v) => (brush.pressure = v) });
  const velRow = slider('Speed→thin', { min: 0, max: 1, step: 0.05, value: brush.velocity, onInput: (v) => (brush.velocity = v) });
  const smoothRow = slider('Smooth', { min: 0, max: 1, step: 0.05, value: brush.smooth, onInput: (v) => (brush.smooth = v) });
  const capSel = h('select', { class: 'cap' }, ...(['round', 'flat', 'taper'] as CapStyle[]).map((c) => h('option', { value: c }, c)));
  capSel.addEventListener('change', () => (brush.cap = capSel.value as CapStyle));
  const mirror = h('input', { type: 'checkbox' });
  mirror.addEventListener('change', () => (brush.mirror = mirror.checked));

  const undo = button('↶ Undo', () => {
    store.update((p) => { const g = p.glyphs[store.selected]; if (g?.kind === 'stroke') g.strokes?.pop(); }, 'glyph');
    recomposeDependents(store.selected);
    scheduleBuild(0);
  });
  const clear = button('Clear', () => {
    store.update((p) => { delete p.glyphs[store.selected]; }, 'glyph');
    recomposeDependents(store.selected);
    scheduleBuild(0);
  });
  const lock = button('🔒 Lock', () => {
    store.update((p) => { const g = p.glyphs[store.selected]; if (g) g.locked = !g.locked; }, 'glyph');
  });
  const reroll = button('🎲 Re-roll', () => {
    const ch = store.selected;
    const g = store.project.glyphs[ch];
    if (!g || g.source !== 'generated') { toast('Re-roll works on generated glyphs'); return; }
    const ng = regenerateOne(ch, { seeds: store.project.seeds, stats: store.project.stats, mutation: store.project.mutation, glyphs: store.project.glyphs }, Math.floor(Math.random() * 1e9));
    if (ng) store.update((p) => { p.glyphs[ch] = ng; }, 'glyph');
    recomposeDependents(ch);
    scheduleBuild(0);
  });
  const advRow = slider('Advance', { min: 100, max: 1400, step: 1, value: 520, onInput: (v) => { store.update((p) => { const g = p.glyphs[store.selected]; if (g) g.advance = v; }, 'glyph'); scheduleBuild(80); }, format: (v) => v.toFixed(0) });

  const mutationRow = slider('Mutation', { min: 0, max: 1, step: 0.05, value: store.project.mutation, onInput: (v) => (store.project.mutation = v) });
  const genBtn = button('✦ Generate the rest of the alphabet', () => {
    if (collectSeeds().length === 0) toast('No seeds yet — generating a default alphabet. Draw a few letters (o, n, a, e, H, s) for your own style.');
    runGenerate();
  }, 'primary big');

  const fontFile = fileInput('.ttf,.otf,.woff', async (f) => {
    try {
      const imp = importFont(await f.arrayBuffer(), projectCharset(store.project));
      store.update((p) => {
        for (const g of imp.glyphs) p.glyphs[g.char] = g;
        p.metrics = { ...p.metrics, ...imp.metrics, upm: 1000 };
        if (!p.name || p.name === 'Untitled Funk') p.name = imp.familyName + ' Funk';
      }, 'project');
      refreshStatsFromSeeds();
      scheduleBuild(0);
      toast(`Imported ${imp.glyphs.length} glyphs from ${imp.familyName}`);
    } catch (e) { toast('Could not read that font: ' + (e as Error).message); }
  });
  const imgFile = fileInput('image/*', (f) => openImageDialog(f, () => { refreshStatsFromSeeds(); scheduleBuild(0); }));

  const csPanel = charsetPanel(() => { renderStrip(); syncEditor(); scheduleBuild(0); });
  const panel = h('section', { class: 'panel seeds' },
    title, csPanel, strip, canvasEl, info,
    h('div', { class: 'row' }, undo, clear, lock, reroll),
    h('details', { class: 'brush', open: true }, h('summary', {}, 'Brush'),
      widthRow, pressureRow, velRow, smoothRow,
      h('div', { class: 'row' }, h('label', {}, 'Cap ', capSel), h('label', {}, mirror, ' Mirror'), ),
      advRow),
    h('div', { class: 'gen' }, mutationRow, genBtn),
    h('div', { class: 'row sources' },
      button('📷 Trace a photo of handwriting', () => imgFile.click()),
      button('⬇ Remix an existing font', () => fontFile.click()),
      fontFile, imgFile),
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
