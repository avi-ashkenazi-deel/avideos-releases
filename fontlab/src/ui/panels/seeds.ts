import { h, slider, fileInput, toast, iconButton, help } from '../dom';
import { icon, type IconName } from '../icons';
import { store } from '../state';
import { scheduleBuild } from '../buildClient';
import { DrawCanvas, type CanvasMode } from '../../inputs/draw/canvas';
import { PointEditor } from '../../inputs/draw/editor';
import { PenTool, applyPenContour } from '../../inputs/draw/pen';
import { ShapeTool, cssAccent } from '../../inputs/draw/shapes';
import { KnifeTool, knifeCut } from '../../inputs/draw/knife';
import { TouchGestures } from '../../inputs/draw/gestures';
import { Loupe } from '../../inputs/draw/loupe';
import { notesFor, openNoteCount, addNote, updateNote, removeNote, hitNote, drawNotePins, drawNoteLabel, buildNotePopover, placeNotePopover, NOTE_HIT_PX, type NotePopover } from '../../inputs/draw/notes';
import { history } from '../history';
import { autoVersion } from '../versions';
import { others, peersOn, holderOf, canEditLetter, setCursor, inSession, me as collabMe } from '../collab';
import { avatar } from './shareDialog';
import { fitVerticalMetrics } from '../../generate/metrics';
import { keepAlternate } from '../alternates';
import type { Glyph, Stroke, CapStyle, CurveContour, ReviewNote, Vec } from '../../core/glyph';
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

/**
 * What the phone layout needs from the draw tab: the pieces it shows on the
 * main screen and the actions behind its buttons. 'draw:state' is emitted on
 * the store when the tool, selection, pen path, zoom or snapping changes.
 */
export interface DrawUi {
  canvasWrap: HTMLElement;
  toolStrip: HTMLElement;
  holdBanner: HTMLElement;
  tool(): CanvasMode;
  toolLabel(): string;
  setTool(t: CanvasMode): void;
  undo(): void;
  redo(): void;
  /** the selected points in Edit points, otherwise the whole letter */
  remove(): void;
  hasSelection(): boolean;
  /** previous / next letter of the character set */
  step(dir: -1 | 1): void;
  pen: { open(): boolean; canClose(): boolean; close(): void; cancel(): void };
  zoomed(): boolean;
  resetZoom(): void;
  snapping(): boolean;
  setSnapping(on: boolean): void;
}
export let drawUi: DrawUi | null = null;

const SNAP_KEY = 'fontlab:snap';

/** The draw tab's tools, in tool-strip order. `id` is the canvas mode; `key` the single-letter shortcut. */
const TOOLS: { id: CanvasMode; icon: IconName; label: string; key: string; hint: string; testid: string; sepBefore?: boolean }[] = [
  { id: 'draw', icon: 'brush', label: 'Brush', key: 'B', hint: 'draw freehand strokes', testid: 'tool-brush' },
  { id: 'edit', icon: 'nodes', label: 'Edit points', key: 'V', hint: 'move, add and delete points and curve handles', testid: 'btn-edit-points' },
  { id: 'pen', icon: 'bezier', label: 'Pen', key: 'P', hint: 'draw curves with points and handles, like a font editor', testid: 'btn-pen', sepBefore: true },
  { id: 'rect', icon: 'square', label: 'Rectangle', key: 'R', hint: 'drag out a rectangle. Shift = square, Alt = from the centre', testid: 'tool-rect' },
  { id: 'ellipse', icon: 'circle', label: 'Ellipse', key: 'O', hint: 'drag out an ellipse. Shift = circle, Alt = from the centre', testid: 'tool-ellipse' },
  { id: 'knife', icon: 'knife', label: 'Knife', key: 'K', hint: 'drag a line across the letter to cut it apart. Alt leaves a gap', testid: 'tool-knife', sepBefore: true },
  { id: 'note', icon: 'pin', label: 'Note', key: 'N', hint: 'pin a review note to a spot on the letter', testid: 'tool-note', sepBefore: true },
];

const TOOL_INFO: Record<Exclude<CanvasMode, 'draw'>, string> = {
  edit: 'Edit points: drag nodes and handles. Double-click a segment to add a point, Delete removes, Alt+drag a node changes its width, Ctrl/Cmd+Z undoes.',
  pen: 'Pen: click for corners, click and drag for curves, click the first point or press Enter to close. Backspace removes the last point, Escape cancels. A shape drawn inside ink cuts a hole; inside a counter it fills.',
  rect: 'Rectangle: drag from corner to corner. Hold Shift for a square, Alt to grow from the centre. Drawn inside ink it cuts a hole; inside a counter it fills.',
  ellipse: 'Ellipse: drag out its box. Hold Shift for a circle, Alt to grow from the centre. Drawn inside ink it cuts a counter; inside a counter it fills.',
  knife: 'Knife: drag a line right through a stroke or shape to cut it in two. The pieces stay in place and move separately in Edit points. Hold Alt to leave a visible gap.',
  note: 'Note: click a spot on the letter to pin a comment for review. Click a pin to edit, resolve or delete it. Enter saves, Shift+Enter starts a new line.',
};

/** The same hints for fingers: no keyboard, no hover. */
const TOUCH_INFO: Record<CanvasMode, string> = {
  draw: 'Draw with one finger. Two fingers zoom and move the view.',
  edit: 'Drag points and handles; two fingers can each drag a point. Double-tap a line to add a point, the bin removes the selected ones. Two fingers on empty space zoom.',
  pen: 'Tap for corners, tap and drag for curves. Tap the first point or the tick to close the shape, the cross to cancel. Undo removes the last point.',
  rect: 'Drag from corner to corner. Drawn inside ink it cuts a hole; inside a counter it fills.',
  ellipse: 'Drag out its box. Drawn inside ink it cuts a counter; inside a counter it fills.',
  knife: 'Drag a line right through a stroke or shape to cut it in two. The pieces move separately in Edit points.',
  note: 'Tap a spot on the letter to pin a comment for review. Tap a pin to edit, resolve or delete it.',
};
const coarsePointer = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

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
  void autoVersion('Before Generate');
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
    fitVerticalMetrics(p);
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
  /** the canvas sits in a positioned wrapper so the note popover can be anchored to a spot on it */
  const canvasWrap = h('div', { class: 'canvaswrap' }, canvasEl);
  /** the active tool: what the pointer does on the canvas */
  let mode: CanvasMode = 'draw';
  const pointsCb = h('input', { type: 'checkbox', 'data-testid': 'chk-points' });
  pointsCb.addEventListener('change', () => { dc.showPoints = pointsCb.checked; dc.draw(); });
  const pointsToggle = h('label', { class: 'toggle pointstoggle', title: 'Show the outline points of the built letter' }, pointsCb, ' Points');
  let editChar: string | null = null;
  const editor = new PointEditor(canvasEl, () => dc.getView(), {
    onChange: (g: Glyph) => {
      store.update((p) => { p.glyphs[g.char] = g; if (g.source === 'generated') g.source = 'drawn'; }, 'glyph');
      recomposeDependents(g.char);
      scheduleBuild(60);
      syncEditTools();
    },
    onSelect: () => { syncEditTools(); store.emit('draw:state'); },
    redraw: () => dc.draw(),
    snap: () => {
      if (!snapOn) return null;
      const m = store.project.metrics, g = store.project.glyphs[store.selected];
      return { xs: [0, g?.advance ?? 0], ys: [0, m.xHeight, m.capHeight, m.ascender, m.descender] };
    },
  });
  let snapOn = false;
  try { snapOn = localStorage.getItem(SNAP_KEY) === '1'; } catch { /* private mode */ }
  let penChar: string | null = null;
  const pen = new PenTool(canvasEl, () => dc.getView(), {
    onCommit: (c: CurveContour) => commitPen(c),
    onChange: () => store.emit('draw:state'),
    redraw: () => dc.draw(),
  });
  const shapeTool = new ShapeTool(canvasEl, () => dc.getView(), {
    onCommit: (c: CurveContour) => commitPen(c),
    redraw: () => dc.draw(),
  });
  const knife = new KnifeTool(canvasEl, () => dc.getView(), {
    getGlyph: () => store.project.glyphs[store.selected],
    onCut: (a, b, gap) => cutWithKnife(a, b, gap),
    redraw: () => dc.draw(),
  });

  // ---------- touch: two fingers zoom and pan in every tool; a magnifier shows what the finger hides
  const loupe = new Loupe(canvasEl);
  canvasWrap.append(loupe.el);
  const fingers = new Set<number>();
  const LOUPE_TOOLS = new Set<CanvasMode>(['edit', 'pen', 'rect', 'ellipse', 'knife']);
  const fingerAt = (e: PointerEvent) => {
    if (e.pointerType !== 'touch' || !LOUPE_TOOLS.has(mode)) return;
    const r = canvasEl.getBoundingClientRect();
    loupe.show(e.clientX - r.left, e.clientY - r.top);
  };
  canvasEl.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') { fingers.add(e.pointerId); fingerAt(e); } });
  canvasEl.addEventListener('pointermove', (e) => { if (fingers.has(e.pointerId)) fingerAt(e); });
  const fingerUp = (e: PointerEvent) => { if (fingers.delete(e.pointerId) && !fingers.size) loupe.hide(); };
  canvasEl.addEventListener('pointerup', fingerUp);
  canvasEl.addEventListener('pointercancel', fingerUp);
  new TouchGestures(canvasWrap, canvasEl, {
    getZoom: () => dc.getZoom(),
    setZoom: (z) => dc.setZoom(z),
    claims: (e) => mode === 'edit' && editor.wantsPointer(e),
    cancelTool: () => {
      dc.cancelLive(); editor.cancelPointers(); pen.cancelPointer(); shapeTool.cancel(); knife.cancel();
      fingers.clear(); loupe.hide();
    },
  });
  dc.onZoom = () => { fitBtn.style.display = dc.zoomed ? '' : 'none'; store.emit('draw:state'); };
  (window as unknown as { __fontlabView: () => unknown }).__fontlabView = () => dc.getView(); // debugging / e2e handle

  // ---------- review notes: pins on the canvas in every mode, a popover to write and edit them
  const accent = cssAccent();
  let notePop: { pop: NotePopover; noteId: string | null; at: Vec; ch: string } | null = null;
  let hoverNote: string | null = null;
  const letterNotes = () => notesFor(store.project, store.selected);
  const closeNotePop = () => {
    if (!notePop) return;
    notePop.pop.el.remove();
    notePop = null;
    dc.draw();
  };
  /** note changes are part of the letter's undo history; other panels listen for 'notes' */
  const changeNotes = (fn: (p: typeof store.project) => void) => { store.update(fn, 'glyph'); store.emit('notes'); };
  const openNotePop = (note: ReviewNote | null, at: Vec) => {
    closeNotePop();
    const ch = store.selected;
    const list = letterNotes();
    const id = note?.id ?? null;
    const pop = buildNotePopover({
      note,
      number: note ? list.indexOf(note) + 1 : list.length + 1,
      onSave: (text) => {
        const t = text.trim();
        closeNotePop();
        if (!t) return; // nothing written: same as Cancel
        if (id) { if (t !== note!.text) changeNotes((p) => { updateNote(p, id, { text: t }); }); return; }
        let added = false;
        changeNotes((p) => { added = !!addNote(p, { ch, x: at[0], y: at[1], text: t }); });
        if (!added) toast('This font already has the most notes it can hold. Delete some resolved ones first.');
      },
      onCancel: () => closeNotePop(),
      onToggleDone: (text) => {
        const t = text.trim(), done = !note!.done;
        closeNotePop();
        changeNotes((p) => { updateNote(p, id!, t ? { text: t, done } : { done }); });
      },
      onDelete: () => { closeNotePop(); changeNotes((p) => { removeNote(p, id!); }); },
    });
    canvasWrap.append(pop.el);
    notePop = { pop, noteId: id, at, ch };
    dc.draw(); // places the popover (see the overlay) and shows the pending pin
    pop.focus();
  };
  const fontAt = (e: MouseEvent): Vec => {
    const r = canvasEl.getBoundingClientRect(), v = dc.getView();
    return [(e.clientX - r.left - v.ox) / v.s, (v.oy - (e.clientY - r.top)) / v.s];
  };
  const setHoverNote = (id: string | null) => {
    if (id === hoverNote) return;
    hoverNote = id;
    canvasEl.classList.toggle('overpin', !!id);
    dc.draw();
  };
  canvasEl.addEventListener('click', (e) => {
    if (mode !== 'note') return;
    if (notePop) { notePop.pop.submit(); return; } // a click away keeps what was typed and closes the popover
    const [x, y] = fontAt(e);
    const hit = hitNote(letterNotes(), x, y, NOTE_HIT_PX / dc.getView().s);
    openNotePop(hit, hit ? [hit.x, hit.y] : [x, y]);
  });
  canvasEl.addEventListener('pointermove', (e) => {
    const list = letterNotes();
    if (!list.length || e.buttons) { setHoverNote(null); return; }
    const [x, y] = fontAt(e);
    setHoverNote(hitNote(list, x, y, NOTE_HIT_PX / dc.getView().s)?.id ?? null);
  });
  canvasEl.addEventListener('pointerleave', () => setHoverNote(null));

  // shared session: pointers of the people looking at the same letter
  const drawPeerCursors = (ctx: CanvasRenderingContext2D, view: { ox: number; oy: number; s: number }) => {
    if (!inSession()) return;
    for (const p of peersOn(store.selected)) {
      if (!p.cursor) continue;
      const x = view.ox + p.cursor[0] * view.s, y = view.oy - p.cursor[1] * view.s;
      ctx.save();
      ctx.fillStyle = p.color; ctx.strokeStyle = '#111'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 4, y + 15); ctx.lineTo(x + 8, y + 10); ctx.lineTo(x + 14, y + 10); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.font = '600 11px system-ui, sans-serif';
      const w = ctx.measureText(p.name).width + 10;
      ctx.beginPath(); (ctx as any).roundRect ? (ctx as any).roundRect(x + 12, y + 14, w, 17, 6) : ctx.rect(x + 12, y + 14, w, 17); ctx.fill();
      ctx.fillStyle = '#111'; ctx.fillText(p.name, x + 17, y + 26.5);
      ctx.restore();
    }
  };
  const holdBanner = h('div', { class: 'holdbanner', 'data-testid': 'hold-banner', style: { display: 'none' } });
  const syncCollab = () => {
    const ch = store.selected;
    const holder = holderOf(ch), mine = collabMe();
    const watchOnly = inSession() && !!mine && !mine.canEdit;
    if (holder) holdBanner.replaceChildren(avatar(holder, 22), `${holder.name} is working on “${ch}”. You can watch it change and leave notes; pick another letter to edit.`);
    else if (watchOnly) holdBanner.replaceChildren('You are watching this session. Use the Note tool (N) to leave comments; only the host edits.');
    holdBanner.style.display = holder || watchOnly ? '' : 'none';
    canvasEl.classList.toggle('readonly', inSession() && !canEditLetter(ch));
    for (const b of strip.children) {
      const el = b as HTMLElement, c = el.dataset.ch;
      if (!c) continue;
      const on = peersOn(c);
      el.classList.toggle('peer', on.length > 0);
      if (on.length) el.style.setProperty('--peer', on[0].color); else el.style.removeProperty('--peer');
    }
    dc.draw();
  };
  store.subscribe((ev) => { if (ev === 'collab' || ev === 'select' || ev === 'charset' || ev === 'project:loaded') syncCollab(); else if (ev === 'collab:cursor' && others().some((p) => p.ch === store.selected)) dc.draw(); });
  canvasWrap.addEventListener('pointermove', (e) => {
    if (!inSession()) return;
    const r = canvasEl.getBoundingClientRect(), v = dc.getView();
    setCursor([Math.round((e.clientX - r.left - v.ox) / v.s), Math.round((v.oy - (e.clientY - r.top)) / v.s)]);
  });
  canvasWrap.addEventListener('pointerleave', () => setCursor(null));
  dc.overlay = (ctx, view) => {
    if (mode === 'edit') editor.draw(ctx, view);
    else if (mode === 'pen') pen.draw(ctx, view);
    else if (mode === 'rect' || mode === 'ellipse') shapeTool.draw(ctx, view);
    else if (mode === 'knife') knife.draw(ctx, view);
    drawPeerCursors(ctx, view);
    const list = letterNotes();
    if (!list.length && !notePop) { loupe.render(); return; }
    drawNotePins(ctx, view, list, { accent, activeId: notePop?.noteId, hoverId: hoverNote, pending: notePop && !notePop.noteId ? { x: notePop.at[0], y: notePop.at[1] } : null });
    if (notePop) placeNotePopover(notePop.pop.el, canvasWrap, view.ox + notePop.at[0] * view.s, view.oy - notePop.at[1] * view.s);
    else if (hoverNote) {
      const i = list.findIndex((n) => n.id === hoverNote);
      if (i >= 0) drawNoteLabel(ctx, view, list[i], i + 1, canvasEl.clientWidth, canvasEl.clientHeight);
    }
    loupe.render();
  };

  const select = (ch: string) => { store.selected = ch; store.emit('select'); syncEditor(); };
  const syncEditor = () => {
    const ch = store.selected;
    const g = store.project.glyphs[ch] ?? null;
    dc.metrics = store.project.metrics;
    dc.setGlyph(g ?? blankGlyph(ch), store.built[ch]?.contours ?? []);
    if (mode === 'edit') {
      if (g && hasInk(g)) {
        // same letter still open: feed the latest glyph back (keeps undo history); new letter: start fresh
        if (editor.enabled && editChar === ch) editor.setGlyph(g); else { editor.enable(g); editChar = ch; }
      } else { mode = 'draw'; applyMode(); }
    }
    if (mode === 'pen' && penChar !== ch) { pen.cancel(); penChar = ch; } // a half-drawn path belongs to the letter it was started on
    // an open note popover belongs to its letter (and to a note that still exists, e.g. after Undo)
    if (notePop && (notePop.ch !== ch || (notePop.noteId && !store.project.notes?.some((n) => n.id === notePop!.noteId)))) closeNotePop();
    for (const b of strip.children) b.classList.toggle('selected', (b as HTMLElement).dataset.ch === ch);
    const src = g ? ({ drawn: 'drawn by hand', traced: 'traced from a photo', imported: 'from a font file', generated: 'generated' } as const)[g.source] : 'empty';
    const ns = g?.strokes?.length ?? 0, nc = g?.contours?.length ?? 0;
    const parts = !g ? 'draw to create' : g.kind === 'stroke' ? `${ns} strokes` : `${nc} contours${ns ? ` + ${ns} stroke${ns === 1 ? '' : 's'}` : ''}`;
    const code = 'U+' + (ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0');
    const alts = store.project.alternates?.[ch]?.length ?? 0;
    const nOpen = openNoteCount(store.project, ch);
    const noteChip = nOpen ? h('button', { type: 'button', class: 'notechip', 'data-testid': 'note-count', title: 'Open review notes on this letter. Click to use the Note tool.', onClick: () => setTool('note') }, icon('pin', 12), `${nOpen} note${nOpen === 1 ? '' : 's'}`) : null;
    title.replaceChildren(h('span', { class: 'big' }, ch), h('span', { class: 'ucode' }, code), h('small', {}, `${src}${g?.locked ? ' · locked' : ''} · ${parts}${alts ? ` · ${alts} alternate${alts > 1 ? 's' : ''}` : ''}`), ...(noteChip ? [noteChip] : []), pointsToggle);
    info.textContent = coarsePointer() && (mode !== 'draw' || g?.source !== 'generated') ? TOUCH_INFO[mode] : mode !== 'draw' ? TOOL_INFO[mode]
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

  /** A drag with the knife: split the strokes and shapes it passes through (one Undo step). */
  const cutWithKnife = (a: Vec, b: Vec, gap: number) => {
    const ch = store.selected, g = store.project.glyphs[ch];
    const res = g && hasInk(g) ? knifeCut(g, a, b, gap) : null;
    if (!res) { toast('Nothing to cut there'); return; }
    if (res.glyph.source === 'generated') res.glyph.source = 'drawn'; // a hand-cut letter is yours: generating again must not replace it
    store.update((p) => { p.glyphs[ch] = res.glyph; }, 'glyph');
    recomposeDependents(ch);
    scheduleBuild(40);
    const n = res.strokes + res.parts;
    toast(`Cut ${n} part${n === 1 ? '' : 's'}${gap > 0 ? ', leaving a gap' : ''}`);
  };

  /** A closed pen path, rectangle or ellipse becomes a contour of the current letter (one Undo step). */
  const commitPen = (c: CurveContour) => {
    const ch = store.selected;
    store.update((p) => { p.glyphs[ch] = applyPenContour(p.glyphs[ch], ch, c, blankGlyph(ch)); }, 'glyph');
    recomposeDependents(ch);
    scheduleBuild(40);
    dc.draw();
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
  const advRow = slider('Advance', { min: 100, max: 1400, step: 1, value: 520, onInput: (v) => { store.update((p) => { const g = p.glyphs[store.selected]; if (g) { g.advance = v; g.spacingLocked = true; } }, 'glyph'); scheduleBuild(80); }, format: (v) => v.toFixed(0) });
  advRow.title = 'Width of this letter. Setting it by hand keeps auto spacing away from it.';

  const undoProject = () => {
    if (!history.undo(store.project)) { toast('Nothing to undo'); return; }
    store.emit('glyph'); scheduleBuild(0);
  };
  const redoProject = () => {
    if (!history.redo(store.project)) { toast('Nothing to redo'); return; }
    store.emit('glyph'); scheduleBuild(0);
  };
  const doUndo = () => { if (mode === 'edit') editor.undo(); else if (mode === 'pen' && pen.inProgress) pen.undoLast(); else undoProject(); };
  const doRedo = () => { if (mode === 'edit') editor.redo(); else if (mode === 'pen' && pen.inProgress) return; else redoProject(); };
  const undoBtn = iconButton('undo', 'Undo', doUndo, { title: 'Undo the last change to the font: stroke, delete, generate, import… (Ctrl/Cmd+Z)', testid: 'btn-undo' });
  const redoBtn = iconButton('redo', 'Redo', doRedo, { iconOnly: true, title: 'Redo (Shift+Ctrl/Cmd+Z)', testid: 'btn-redo' });
  /** previous / next letter of the character set (wraps around) */
  const stepLetter = (dir: -1 | 1) => {
    const chars = projectCharset(store.project);
    const i = chars.indexOf(store.selected);
    const next = chars[(i < 0 ? 0 : (i + dir + chars.length) % chars.length)];
    if (!next) return;
    showTab('draw');
    select(next);
    strip.querySelector<HTMLElement>(`.chbtn[data-ch="${CSS.escape(next)}"]`)?.scrollIntoView({ block: 'nearest' });
  };
  window.addEventListener('keydown', (e) => {
    if (editor.enabled) return; // the point editor has its own history while open
    if (pen.enabled && pen.inProgress) return; // the pen owns the keyboard while a path is open (Ctrl/Cmd+Z removes its last point)
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) redoProject(); else undoProject(); }
    else if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redoProject(); }
    else if (!mod && !e.altKey && !e.defaultPrevented && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === '[' || e.key === ']')) {
      if (document.querySelector('dialog[open]')) return;
      e.preventDefault();
      stepLetter(e.key === 'ArrowLeft' || e.key === '[' ? -1 : 1);
    }
  });
  // tool shortcuts: B V P R O K N pick a tool, Escape goes back to the brush
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (drawTab.style.display === 'none' || document.querySelector('dialog[open], .welcome')) return;
    if (pen.enabled && pen.inProgress) return; // the pen owns the keyboard while a path is open (Escape cancels the path)
    if (e.key === 'Escape') {
      if (notePop) { closeNotePop(); return; }
      if (shapeTool.dragging) { shapeTool.cancel(); return; }
      if (knife.dragging) { knife.cancel(); return; }
      const sel = mode === 'edit' ? editor.getSelection() : null;
      if (sel && sel.nodes.length) return; // the point editor drops its selection first
      if (mode !== 'draw') { e.preventDefault(); setTool('draw'); }
      return;
    }
    if (e.shiftKey || e.repeat || e.key.length !== 1) return;
    const tool = TOOLS.find((x) => x.key === e.key.toUpperCase());
    if (!tool || shapeTool.dragging || knife.dragging) return;
    e.preventDefault();
    if (mode !== tool.id) setTool(tool.id);
  });
  const clearLetter = () => { store.update((p) => { delete p.glyphs[store.selected]; }, 'glyph'); recomposeDependents(store.selected); scheduleBuild(0); };
  const clear = iconButton('trash', 'Clear', clearLetter, { title: 'Remove this letter (it can be regenerated)' });
  const lock = iconButton('lock', 'Lock', () => { store.update((p) => { const g = p.glyphs[store.selected]; if (g) g.locked = !g.locked; }, 'glyph'); }, { title: 'Locked letters are never regenerated' });
  const keepAltBtn = iconButton('copy', 'Keep as alternate', () => keepAlternate(store.selected), { title: 'Save this version of the letter as a stylistic set (ss01–ss03), then re-roll or redraw for a new main version', testid: 'btn-keep-alt' });
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
  // tool strip: one tool is active at a time; clicking the active one (other than the brush) goes back to the brush
  const setTool = (t: CanvasMode) => { mode = t; applyMode(); };
  const toolName = h('span', { class: 'toolname', 'aria-live': 'polite' });
  const toolStrip = h('div', { class: 'toolstrip', role: 'toolbar', 'aria-label': 'Drawing tools' });
  const toolBtns = new Map<CanvasMode, HTMLButtonElement>();
  for (const t of TOOLS) {
    const b = iconButton(t.icon, t.label, () => setTool(mode === t.id && t.id !== 'draw' ? 'draw' : t.id), { iconOnly: true, title: `${t.label} (${t.key}): ${t.hint}`, testid: t.testid });
    b.setAttribute('aria-pressed', 'false');
    b.setAttribute('aria-keyshortcuts', t.key);
    if (t.sepBefore) toolStrip.append(h('span', { class: 'toolsep', 'aria-hidden': 'true' }));
    toolStrip.append(b);
    toolBtns.set(t.id, b);
  }
  const fitBtn = iconButton('fit', 'Fit', () => dc.resetZoom(), { title: 'Zoomed in or moved. Click to fit the letter again. Ctrl/Cmd + scroll (or a pinch) zooms, scrolling moves the view.', testid: 'btn-fit' });
  fitBtn.classList.add('fitbtn');
  fitBtn.style.display = 'none';
  const toolRow = h('div', { class: 'toolrow' }, toolStrip, toolName, fitBtn);
  const nodeWidth = slider('Point width', { min: 2, max: 200, step: 1, value: 40, onInput: (v) => editor.setSelectedWidth(v), format: (v) => v.toFixed(0) });
  const editTools = h('div', { class: 'row edittools' }, nodeWidth, h('small', { class: 'muted' }, 'Alt+drag a node also changes width'));
  const applyMode = () => {
    const g = store.project.glyphs[store.selected];
    if (mode === 'edit' && !(g && hasInk(g))) { mode = 'draw'; toast('Nothing to edit yet. Draw or import this letter first.'); }
    dc.mode = mode;
    for (const t of TOOLS) {
      const b = toolBtns.get(t.id)!, on = mode === t.id;
      b.classList.toggle('primary', on);
      b.setAttribute('aria-pressed', String(on));
      canvasEl.classList.toggle(t.id === 'edit' ? 'editing' : t.id, on && t.id !== 'draw');
      if (on) toolName.replaceChildren(t.label, h('kbd', {}, t.key));
    }
    editTools.style.display = mode === 'edit' ? '' : 'none';
    if (mode === 'edit' && g) { editor.enable(g); editChar = store.selected; } else { editor.disable(); editChar = null; }
    if (mode === 'pen') { pen.enable(); penChar = store.selected; } else { pen.disable(); penChar = null; }
    if (mode === 'rect' || mode === 'ellipse') shapeTool.enable(mode); else shapeTool.disable();
    if (mode === 'knife') knife.enable(); else knife.disable();
    if (mode !== 'note') closeNotePop();
    if (!LOUPE_TOOLS.has(mode)) loupe.hide();
    syncEditor();
    dc.draw();
    store.emit('draw:state');
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
      await autoVersion('Before font import');
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
    strip, title, holdBanner, toolRow, canvasWrap, info,
    h('div', { class: 'row' }, undoBtn, redoBtn, clear, lock, reroll, keepAltBtn, toStrokesBtn),
    editTools,
    h('details', { class: 'brush' }, h('summary', {}, 'Brush'), widthRow, pressureRow, velRow, smoothRow,
      h('div', { class: 'row' }, h('label', {}, 'Cap ', capSel), h('label', {}, mirror, ' Mirror')), advRow),
  );
  editTools.style.display = 'none';
  applyMode(); // light up the brush in the tool strip

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
    if (ev === 'notes') syncEditor(); // someone else changed the notes: refresh the pins and the count
    if (ev === 'built' || ev === 'glyph' || ev === 'select' || ev === 'project' || ev === 'project:loaded') {
      syncEditor();
      const g = store.project.glyphs[store.selected];
      if (g) (advRow as any).setValue(g.advance);
      if (ev === 'project:loaded') (mutationRow as any).setValue(store.project.mutation);
    }
  });
  select(store.selected);
  drawUi = {
    canvasWrap, toolStrip, holdBanner,
    tool: () => mode,
    toolLabel: () => TOOLS.find((t) => t.id === mode)?.label ?? '',
    setTool,
    undo: doUndo,
    redo: doRedo,
    remove: () => {
      if (mode === 'edit' && editor.getSelection()?.nodes.length) { editor.deleteSelected(); return; }
      const g = store.project.glyphs[store.selected];
      if (!g || !hasInk(g)) { toast('This letter is already empty'); return; }
      clearLetter();
      toast(`“${store.selected}” cleared. Undo brings it back.`);
    },
    hasSelection: () => mode === 'edit' && !!editor.getSelection()?.nodes.length,
    step: stepLetter,
    pen: { open: () => mode === 'pen' && pen.inProgress, canClose: () => pen.path.canClose(), close: () => { if (!pen.close()) toast('A shape needs at least three points'); }, cancel: () => pen.cancel() },
    zoomed: () => dc.zoomed,
    resetZoom: () => dc.resetZoom(),
    snapping: () => snapOn,
    setSnapping: (on) => { snapOn = on; try { localStorage.setItem(SNAP_KEY, on ? '1' : '0'); } catch { /* private mode */ } store.emit('draw:state'); },
  };
  return panel;
}

function outlineToStrokes_all(glyphs: Glyph[]): Glyph[] { return glyphs.map((g) => (g.kind === 'outline' ? outlineToStrokes(g) : g)); }
