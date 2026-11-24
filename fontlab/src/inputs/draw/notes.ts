/**
 * Review notes pinned to a spot on a letter (`FontProject.notes`).
 *
 * Pure helpers (unit-tested): `notesFor`, `openNoteCount`, `addNote`,
 * `updateNote`, `removeNote`, `hitNote`. The mutating ones change the project
 * they are given, so they are meant to run inside `store.update`.
 *
 * Canvas + DOM: `drawNotePins` / `drawNoteLabel` paint the numbered pins and
 * the hover label on the draw canvas; `buildNotePopover` is the small editor
 * shown next to a pin. Positions are font units, y up; a `View` maps them to
 * canvas pixels (ox + x*s, oy − y*s).
 */
import type { FontProject, ReviewNote } from '../../core/glyph';
import { uid } from '../../core/glyph';
import type { View } from '../../ui/render';
import { h, iconButton } from '../../ui/dom';
import { withAlpha } from './shapes';

/** Longest note text (the project schema drops longer ones on load). */
export const NOTE_MAX_TEXT = 2000;
/** Most notes a project keeps (the schema keeps the first 500 on load). */
export const NOTE_MAX_COUNT = 500;
/** Pin radius in canvas pixels. */
export const NOTE_PIN_RADIUS = 10;
/** How close (canvas pixels) the pointer must be to a pin's centre to hit it. */
export const NOTE_HIT_PX = 12;

type HasNotes = Pick<FontProject, 'notes'>;

// ---------------------------------------------------------------- pure helpers

/** The notes pinned to letter `ch`, oldest first (their position in this list + 1 is the pin number). */
export function notesFor(project: Partial<HasNotes>, ch: string): ReviewNote[] {
  return (project.notes ?? []).filter((n) => n.ch === ch);
}

/** How many notes on `ch` are still open (not resolved). */
export function openNoteCount(project: Partial<HasNotes>, ch: string): number {
  return notesFor(project, ch).filter((n) => !n.done).length;
}

/**
 * Pin a new note. The text is trimmed and capped at `NOTE_MAX_TEXT`; nothing
 * is added (null) for an empty text or once the project holds `NOTE_MAX_COUNT` notes.
 */
export function addNote(project: HasNotes, init: { ch: string; x: number; y: number; text: string; author?: string }, now: number = Date.now()): ReviewNote | null {
  const text = init.text.trim().slice(0, NOTE_MAX_TEXT);
  if (!text || !init.ch) return null;
  if (!Array.isArray(project.notes)) project.notes = [];
  if (project.notes.length >= NOTE_MAX_COUNT) return null;
  const note: ReviewNote = { id: uid('n'), ch: init.ch, x: Math.round(init.x * 10) / 10, y: Math.round(init.y * 10) / 10, text, createdAt: now };
  if (init.author) note.author = init.author;
  project.notes.push(note);
  return note;
}

/** Change a note's text, position, author or resolved state. Returns the note, or null when the id is unknown or the new text is empty. */
export function updateNote(project: HasNotes, id: string, patch: Partial<Pick<ReviewNote, 'text' | 'done' | 'x' | 'y' | 'author'>>): ReviewNote | null {
  const note = (project.notes ?? []).find((n) => n.id === id);
  if (!note) return null;
  if (patch.text !== undefined) {
    const text = patch.text.trim().slice(0, NOTE_MAX_TEXT);
    if (!text) return null;
    note.text = text;
  }
  if (patch.x !== undefined) note.x = Math.round(patch.x * 10) / 10;
  if (patch.y !== undefined) note.y = Math.round(patch.y * 10) / 10;
  if (patch.author !== undefined) { if (patch.author) note.author = patch.author; else delete note.author; }
  if (patch.done !== undefined) { if (patch.done) note.done = true; else delete note.done; }
  return note;
}

/** Delete a note. False when the id is unknown. */
export function removeNote(project: HasNotes, id: string): boolean {
  const i = (project.notes ?? []).findIndex((n) => n.id === id);
  if (i < 0) return false;
  project.notes.splice(i, 1);
  return true;
}

/** The note whose pin is nearest to (x, y) within `tol` font units; the newer one wins a tie (it is drawn on top). */
export function hitNote(notes: ReviewNote[], x: number, y: number, tol: number): ReviewNote | null {
  let best: ReviewNote | null = null, bestD = tol;
  for (const n of notes) {
    const d = Math.hypot(n.x - x, n.y - y);
    if (d <= bestD) { best = n; bestD = d; }
  }
  return best;
}

// ---------------------------------------------------------------- canvas

export interface NotePinOptions {
  accent?: string;
  /** the note whose popover is open */
  activeId?: string | null;
  /** the note under the pointer */
  hoverId?: string | null;
  /** where a new note is being written (font units) */
  pending?: { x: number; y: number } | null;
}

function pin(ctx: CanvasRenderingContext2D, x: number, y: number, label: string, style: { fill: string | null; stroke: string; text: string; ring?: string; dashed?: boolean }): void {
  const r = NOTE_PIN_RADIUS;
  if (style.ring) {
    ctx.strokeStyle = style.ring; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, r + 4, 0, Math.PI * 2); ctx.stroke();
  }
  // dark halo so the pin reads on white ink as well as on the dark canvas
  ctx.fillStyle = 'rgba(0,0,0,.6)';
  ctx.beginPath(); ctx.arc(x, y, r + 1.5, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(x, y, r - 1, 0, Math.PI * 2);
  ctx.fillStyle = style.fill ?? 'rgba(26,28,34,.92)';
  ctx.fill();
  ctx.setLineDash(style.dashed ? [3, 3] : []);
  ctx.strokeStyle = style.stroke; ctx.lineWidth = 2;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = style.text;
  ctx.font = `700 ${label.length > 1 ? 9 : 11}px system-ui, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(label, x, y + 0.5);
}

/** Numbered pins for one letter's notes: open ones filled with the accent, resolved ones hollow and grey. */
export function drawNotePins(ctx: CanvasRenderingContext2D, view: View, notes: ReviewNote[], opts: NotePinOptions = {}): void {
  const accent = opts.accent ?? '#ffd166';
  ctx.save();
  notes.forEach((n, i) => {
    const x = view.ox + n.x * view.s, y = view.oy - n.y * view.s;
    const hot = n.id === opts.activeId || n.id === opts.hoverId;
    if (n.done) pin(ctx, x, y, String(i + 1), { fill: null, stroke: '#9aa0ad', text: '#9aa0ad', ring: hot ? 'rgba(154,160,173,.55)' : undefined });
    else pin(ctx, x, y, String(i + 1), { fill: accent, stroke: accent, text: '#111', ring: hot ? withAlpha(accent, 0.55) : undefined });
  });
  if (opts.pending) {
    const x = view.ox + opts.pending.x * view.s, y = view.oy - opts.pending.y * view.s;
    pin(ctx, x, y, String(notes.length + 1), { fill: withAlpha(accent, 0.25), stroke: accent, text: '#fff', dashed: true });
  }
  ctx.restore();
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (let word of para.split(/\s+/).filter(Boolean)) {
      // a single word wider than the label is broken up
      while (word.length > 1 && ctx.measureText(word).width > maxWidth) {
        if (line) { lines.push(line); line = ''; }
        let k = word.length - 1;
        while (k > 1 && ctx.measureText(word.slice(0, k)).width > maxWidth) k--;
        lines.push(word.slice(0, k)); word = word.slice(k);
      }
      const next = line ? line + ' ' + word : word;
      if (line && ctx.measureText(next).width > maxWidth) { lines.push(line); line = word; } else line = next;
    }
    if (line) lines.push(line);
    if (lines.length > maxLines) break;
  }
  if (lines.length <= maxLines) return lines;
  const out = lines.slice(0, maxLines);
  let last = out[maxLines - 1];
  while (last.length > 1 && ctx.measureText(last + '…').width > maxWidth) last = last.slice(0, -1);
  out[maxLines - 1] = last + '…';
  return out;
}

/** Tooltip-like label with a note's text next to its pin (kept inside a canvas of `width` × `height` CSS pixels). */
export function drawNoteLabel(ctx: CanvasRenderingContext2D, view: View, note: ReviewNote, number: number, width: number, height: number): void {
  const px = view.ox + note.x * view.s, py = view.oy - note.y * view.s;
  ctx.save();
  ctx.font = '12px system-ui, sans-serif';
  const maxW = Math.max(80, Math.min(220, width - 24));
  const lines = wrapText(ctx, note.text, maxW, 5);
  const head = `Note ${number}${note.done ? ' · resolved' : ''}${note.author ? ' · ' + note.author : ''}`;
  ctx.font = '600 10px system-ui, sans-serif';
  const headW = ctx.measureText(head).width;
  ctx.font = '12px system-ui, sans-serif';
  const w = Math.max(headW, ...lines.map((l) => ctx.measureText(l).width)) + 16;
  const hgt = 12 + 14 + lines.length * 15;
  let x = px + NOTE_PIN_RADIUS + 8, y = py - hgt / 2;
  if (x + w > width - 4) x = px - NOTE_PIN_RADIUS - 8 - w;
  x = Math.max(4, Math.min(width - w - 4, x));
  y = Math.max(4, Math.min(height - hgt - 4, y));
  ctx.fillStyle = 'rgba(26,28,34,.96)';
  ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.lineWidth = 1;
  ctx.beginPath();
  if (typeof (ctx as any).roundRect === 'function') (ctx as any).roundRect(x, y, w, hgt, 7); else ctx.rect(x, y, w, hgt);
  ctx.fill(); ctx.stroke();
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#9aa0ad'; ctx.font = '600 10px system-ui, sans-serif';
  ctx.fillText(head, x + 8, y + 15);
  ctx.fillStyle = note.done ? '#9aa0ad' : '#e9e9ee'; ctx.font = '12px system-ui, sans-serif';
  lines.forEach((l, i) => ctx.fillText(l, x + 8, y + 32 + i * 15));
  ctx.restore();
}

// ---------------------------------------------------------------- popover

export interface NotePopoverOptions {
  /** the note being edited; leave out for a new one */
  note?: ReviewNote | null;
  /** pin number shown in the header */
  number: number;
  /** Save / Enter (the text may be empty: the host decides what that means) */
  onSave: (text: string) => void;
  /** Cancel / Escape */
  onCancel: () => void;
  /** Resolve / Reopen (existing notes only); gets the text as it stands */
  onToggleDone?: (text: string) => void;
  /** Delete (existing notes only) */
  onDelete?: () => void;
}

export interface NotePopover {
  el: HTMLElement;
  textarea: HTMLTextAreaElement;
  value: () => string;
  focus: () => void;
  /** same as pressing Save */
  submit: () => void;
}

/** The small note editor: textarea + Save / Cancel, plus Resolve / Reopen and Delete for an existing note. Enter saves, Shift+Enter is a new line, Escape cancels. */
export function buildNotePopover(o: NotePopoverOptions): NotePopover {
  const note = o.note ?? null;
  const textarea = h('textarea', { class: 'notepop-text', rows: 3, maxLength: NOTE_MAX_TEXT, placeholder: 'What should change here?', 'aria-label': 'Note text', 'data-testid': 'note-text' });
  textarea.value = note?.text ?? '';
  const value = () => textarea.value;
  const submit = () => o.onSave(value());
  const save = h('button', { type: 'button', class: 'primary', 'data-testid': 'note-save', onClick: submit }, 'Save');
  const actions = h('div', { class: 'notepop-actions' }, save);
  if (note) {
    if (o.onToggleDone) actions.append(h('button', { type: 'button', 'data-testid': 'note-resolve', title: note.done ? 'Mark this note as open again' : 'Mark this note as done', onClick: () => o.onToggleDone!(value()) }, note.done ? 'Reopen' : 'Resolve'));
    actions.append(h('span', { class: 'spacer' }));
    if (o.onDelete) actions.append(iconButton('trash', 'Delete note', () => o.onDelete!(), { iconOnly: true, cls: 'danger', testid: 'note-delete' }));
    actions.append(iconButton('x', 'Cancel', () => o.onCancel(), { iconOnly: true, testid: 'note-cancel' }));
  } else {
    actions.append(h('button', { type: 'button', 'data-testid': 'note-cancel', onClick: () => o.onCancel() }, 'Cancel'));
  }
  const head = h('div', { class: 'notepop-head' }, h('strong', {}, `Note ${o.number}`), note?.done ? h('span', { class: 'tag' }, 'resolved') : null, note ? null : h('small', {}, 'Enter saves'));
  const el = h('div', { class: 'notepop' + (note?.done ? ' done' : ''), role: 'group', 'aria-label': note ? `Note ${o.number}` : 'New note', 'data-testid': 'note-popover' }, head, textarea, actions);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); o.onCancel(); return; }
    if (e.key === 'Enter' && e.target === textarea && !e.shiftKey && !e.isComposing) { e.preventDefault(); e.stopPropagation(); submit(); return; }
    e.stopPropagation(); // typing in the note must not reach the canvas shortcuts
  });
  // a press inside the popover is not a press on the canvas under it
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
  const focus = () => { textarea.focus(); textarea.setSelectionRange(textarea.value.length, textarea.value.length); };
  return { el, textarea, value, focus, submit };
}

/**
 * Put the popover next to the pin at canvas pixel (px, py), inside `host` (the
 * positioned wrapper around the canvas): to its right, else to its left, else
 * (narrow canvas) under or over it, so the pin itself stays visible.
 */
export function placeNotePopover(el: HTMLElement, host: HTMLElement, px: number, py: number): void {
  const W = host.clientWidth, H = host.clientHeight;
  const w = el.offsetWidth, hgt = el.offsetHeight, off = NOTE_PIN_RADIUS + 8;
  let left: number, top: number;
  if (px + off + w <= W - 4 || px - off - w >= 4) {
    left = px + off + w <= W - 4 ? px + off : px - off - w;
    top = Math.max(4, Math.min(Math.max(4, H - hgt - 4), py - 18));
  } else {
    left = Math.max(4, Math.min(Math.max(4, W - w - 4), px - w / 2));
    top = py + off + hgt <= H - 4 || py - off - hgt < 4 ? py + off : py - off - hgt;
  }
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}
