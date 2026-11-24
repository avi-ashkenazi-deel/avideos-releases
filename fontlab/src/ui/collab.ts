/**
 * Binds a collaboration Session to the app: local changes are diffed and sent,
 * remote changes are applied to the store, presence follows the selected letter.
 */
import { store } from './state';
import { toast } from './dom';
import { history } from './history';
import { scheduleBuild } from './buildClient';
import type { FontProject } from '../core/glyph';
import { Session, HOST_LOST, type Peer } from '../collab/session';
import { getConfig, peerOptions, loadConfig } from './config';
import { getCurrentId } from '../project/library';
import { makeTransport, newRoomId } from '../collab/transport';
import { diffProject, snapshotOf, applyOp, opKey, type Op, type Snapshot } from '../collab/protocol';

export type CollabStatus = 'off' | 'connecting' | 'open' | 'closed' | 'error';

interface State {
  session: Session | null;
  peers: Peer[];
  status: CollabStatus;
  detail: string;
  /** 'peer' = over the internet (WebRTC); 'local' = tabs of this browser (tests, trying it out) */
  via: 'peer' | 'local';
}
export const collab: State = { session: null, peers: [], status: 'off', detail: '', via: 'peer' };

/** What this tab was doing, kept for the tab's lifetime so a reload or a network blip picks it up again. */
interface Resume { role: 'host' | 'guest'; room: string; name: string; via: 'peer' | 'local'; guestsCanEdit?: boolean; ownId?: string | null }
const SS_KEY = 'fontlab:collab:session';
function remember(r: Resume | null): void { try { if (r) sessionStorage.setItem(SS_KEY, JSON.stringify(r)); else sessionStorage.removeItem(SS_KEY); } catch { /* ignore */ } }
function remembered(): Resume | null {
  try {
    const r = JSON.parse(sessionStorage.getItem(SS_KEY) ?? 'null');
    return r && (r.role === 'host' || r.role === 'guest') && typeof r.room === 'string' && /^[A-Za-z0-9_-]{4,40}$/.test(r.room) && typeof r.name === 'string' ? { ...r, via: r.via === 'local' ? 'local' : 'peer' } : null;
  } catch { return null; }
}
/** The guest's own font (library id, or null for the unsaved one) from before they joined. */
export function ownFontId(): string | null { return remembered()?.ownId ?? null; }
const transport = (via: 'peer' | 'local') => makeTransport(via, via === 'peer' ? peerOptions() : undefined);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let reconnecting = false;

/** App-level actions the header provides (opening a project, going back to my own font). */
export const collabHooks: { openProject?: (p: FontProject) => void; restoreOwnFont?: () => void | Promise<void>; saveCopy?: (p: FontProject) => Promise<void>; /** resolves once the font of this tab has been loaded at start-up */ ready?: () => Promise<void> } = {};

let snap: Snapshot = new Map();
let applying = false;
let flushTimer: number | null = null;
let rosterSig = '';

export const inSession = (): boolean => !!collab.session && collab.status === 'open';
export const isGuest = (): boolean => inSession() && collab.session!.role === 'guest';
export const me = (): Peer | null => collab.session?.me ?? null;
export const others = (): Peer[] => (collab.session ? collab.peers.filter((p) => p.id !== collab.session!.me.id) : []);
export const peersOn = (ch: string): Peer[] => others().filter((p) => p.ch === ch);
/** May I change this letter right now? Always true outside a session. */
export function canEditLetter(ch: string): boolean { return !inSession() || collab.session!.canEditLetter(ch); }
/** Who has this letter open before me, if anyone. */
export function holderOf(ch: string): Peer | null {
  if (!inSession()) return null;
  const h = collab.session!.holder(ch);
  return h && h.id !== collab.session!.me.id ? h : null;
}
export function sessionLink(): string {
  if (!collab.session) return '';
  const u = new URL(location.href);
  u.search = ''; u.hash = '';
  u.searchParams.set('join', collab.session.room);
  if (collab.via === 'local') u.searchParams.set('via', 'local');
  return u.toString();
}
export function savedName(): string { try { return localStorage.getItem('fontlab:collab:name') ?? ''; } catch { return ''; } }
function rememberName(name: string): void { try { localStorage.setItem('fontlab:collab:name', name); } catch { /* ignore */ } }

const SYNC_EVENTS = new Set(['glyph', 'project', 'fx', 'charset', 'notes']);

function events() {
  return {
    onPeers: (peers: Peer[]) => {
      collab.peers = peers;
      const sig = peers.map((p) => `${p.id}|${p.name}|${p.ch}|${p.canEdit}|${p.host}`).join(',') + '|' + (collab.session?.guestsCanEdit ?? '');
      if (sig !== rosterSig) { rosterSig = sig; store.emit('collab'); } else store.emit('collab:cursor');
    },
    onRemoteOps: (ops: Op[], from: Peer | null) => applyRemote(ops, from),
    onInit: (project: FontProject) => {
      // the host's font replaces what is on screen; my own font stays safe in My fonts / the scratch slot
      project.previewText = store.project.previewText || project.previewText;
      applying = true;
      try {
        if (collabHooks.openProject) collabHooks.openProject(project);
        else { store.project = project; store.built = {}; store.otf = null; store.emit('project:loaded'); scheduleBuild(0); }
      } finally { applying = false; }
      history.clear();
      snap = snapshotOf(store.project);
    },
    onStatus: (status: 'connecting' | 'open' | 'closed' | 'error', detail?: string) => {
      const was = collab.status;
      collab.status = status; collab.detail = detail ?? '';
      if ((status === 'closed' || status === 'error') && collab.session) {
        const guest = collab.session.role === 'guest';
        collab.session = null; collab.peers = []; rosterSig = '';
        if (guest && was === 'open' && detail === HOST_LOST && remembered()) { void reconnect(); return; }
        remember(null);
        if (was === 'open') toast(detail || (guest ? 'The session ended.' : 'Session ended.'), 5000);
        if (guest && was === 'open') void afterGuestSession();
      }
      if (reconnecting && status !== 'open') return; // the reconnect loop reports its own progress
      store.emit('collab');
    },
  };
}

/** Host a session with the font that is open. Returns the link to send to others. `room` resumes an earlier link. */
export async function startSession(name: string, via: 'peer' | 'local' = collab.via, room?: string, guestsCanEdit = true): Promise<string> {
  if (collab.session) return sessionLink();
  rememberName(name);
  collab.via = via; collab.status = 'connecting'; collab.detail = ''; store.emit('collab');
  try {
    await loadConfig();
    let s: Session | null = null;
    // after a reload the old connection may still hold the link for a few seconds
    for (let attempt = 0; ; attempt++) {
      try { s = await Session.host(transport(via), room ?? newRoomId(), { name: name.trim() || 'Host' }, () => store.project, events()); break; }
      catch (e) { if (!room || attempt >= 6 || !/in use/i.test((e as Error).message)) throw e; await wait(2500); }
    }
    collab.session = s; collab.status = 'open'; collab.peers = s.peers();
    if (!guestsCanEdit) s.setGuestsCanEdit(false);
    remember({ role: 'host', room: s.room, name, via, guestsCanEdit });
    snap = snapshotOf(store.project);
    s.setPresence({ ch: store.selected });
    store.emit('collab');
    return sessionLink();
  } catch (e) {
    collab.session = null; collab.status = 'error'; collab.detail = (e as Error).message; remember(null); store.emit('collab');
    throw e;
  }
}

/** Host only: let guests edit, or only watch and leave notes. */
export function setGuestsCanEdit(v: boolean): void {
  const s = collab.session;
  if (!s || s.role !== 'host') return;
  s.setGuestsCanEdit(v);
  const r = remembered(); if (r) remember({ ...r, guestsCanEdit: v });
}

/** Join someone's session; their font replaces what is on screen until I leave. */
export async function joinSession(room: string, name: string, via: 'peer' | 'local' = 'peer'): Promise<void> {
  if (collab.session) leaveSession();
  rememberName(name);
  const prior = remembered();
  // my own font, to go back to afterwards (kept across reloads of this tab)
  const ownId = prior && prior.role === 'guest' && prior.room === room ? prior.ownId ?? null : getCurrentId();
  collab.via = via; collab.status = 'connecting'; collab.detail = ''; store.emit('collab');
  try {
    await loadConfig();
    const s = await Session.join(transport(via), room, { name: name.trim() || 'Guest' }, events());
    collab.session = s; collab.status = 'open'; collab.peers = s.peers();
    remember({ role: 'guest', room, name, via, ownId });
    idle = false; lastActive = Date.now();
    s.setPresence({ ch: store.selected });
    store.emit('collab');
  } catch (e) {
    collab.session = null; collab.status = 'error'; collab.detail = (e as Error).message; store.emit('collab');
    throw e;
  }
}

/** The connection to the host dropped: keep trying the same link for a while before giving up. */
async function reconnect(): Promise<void> {
  const r = remembered();
  if (!r || reconnecting) return;
  reconnecting = true;
  collab.status = 'connecting'; collab.detail = 'Reconnecting…'; store.emit('collab');
  toast('Lost the connection to the host. Trying to reconnect…', 4000);
  const until = Date.now() + 45_000;
  let ok = false;
  while (Date.now() < until && remembered()) {
    await wait(3000);
    if (!remembered()) break; // I left meanwhile
    try { await joinSession(r.room, r.name, r.via); ok = true; break; } catch { collab.status = 'connecting'; collab.detail = 'Reconnecting…'; }
  }
  reconnecting = false;
  if (ok) { toast('Reconnected. You are back in the session.', 3500); store.emit('collab'); return; }
  if (!remembered()) { store.emit('collab'); return; }
  remember(null);
  collab.status = 'closed'; collab.detail = 'The host is no longer reachable.'; store.emit('collab');
  toast('The host is no longer reachable, so the session ended.', 5000);
  void afterGuestSession();
}

/** After a reload: pick the session of this tab up again (the host keeps the same link). */
export async function resumeSession(): Promise<'host' | 'guest' | null> {
  const r = remembered();
  if (!r || collab.session) return null;
  try {
    if (r.role === 'host') { await collabHooks.ready?.(); await startSession(r.name, r.via, r.room, r.guestsCanEdit !== false); toast('Your session is back on the same link.', 3500); return 'host'; }
    for (let attempt = 0; ; attempt++) {
      try { await joinSession(r.room, r.name, r.via); break; }
      catch (e) { if (attempt >= 4) throw e; await wait(2500); }
    }
    toast('You are back in the session.', 3500);
    return 'guest';
  } catch {
    const guest = r.role === 'guest';
    remember(null);
    collab.status = 'off'; collab.detail = ''; store.emit('collab');
    toast(guest ? 'The session you were in has ended.' : 'Could not restart your session. Start a new one from Share.', 5000);
    if (guest) await collabHooks.restoreOwnFont?.();
    return null;
  }
}

export function leaveSession(): void {
  const s = collab.session;
  if (!s) { if (remembered()) { const guest = remembered()!.role === 'guest'; remember(null); collab.status = 'off'; collab.detail = ''; store.emit('collab'); if (guest) void afterGuestSession(); } return; }
  const guest = s.role === 'guest';
  flush();
  remember(null);
  collab.session = null; collab.peers = []; collab.status = 'off'; collab.detail = ''; rosterSig = '';
  try { s.leave(); } catch { /* ignore */ }
  store.emit('collab');
  if (guest) void afterGuestSession();
}

/** A guest's session is over: keep a copy of the shared font, or go back to their own. */
async function afterGuestSession(): Promise<void> {
  const keep = Object.keys(store.project.glyphs).length > 0 && confirm('The session is over. Keep a copy of this font in “My fonts”?\n\nOK keeps a copy. Cancel goes back to your own font.');
  try {
    if (keep && collabHooks.saveCopy) await collabHooks.saveCopy(store.project);
    else await collabHooks.restoreOwnFont?.();
  } catch (e) { toast((e as Error).message); }
}

// ---- idle: a letter is only held while its holder is actually around
let idle = false;
let lastActive = Date.now();
function active(): void {
  lastActive = Date.now();
  if (idle && collab.session) { idle = false; collab.session.setPresence({ ch: store.selected }); }
}
if (typeof window !== 'undefined') {
  for (const ev of ['pointerdown', 'keydown', 'pointermove', 'wheel'] as const) window.addEventListener(ev, active, { passive: true, capture: true });
  setInterval(() => {
    if (!collab.session || idle || collab.status !== 'open') return;
    const limit = (getConfig().collab.maxIdleSeconds ?? 45) * 1000;
    if (Date.now() - lastActive > limit) { flush(); idle = true; collab.session.setPresence({ ch: null, cursor: null }); }
  }, 5000);
}

// ---- local → remote

function flush(): void {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  const s = collab.session;
  if (!s || collab.status !== 'open' || applying) return;
  const prev = snap;
  const { ops, next } = diffProject(prev, store.project);
  snap = next;
  if (!ops.length) return;
  const rejected = s.sendOps(ops);
  if (rejected.length) revert(rejected, prev);
}

/** Put back what I was not allowed to change, and say why. */
function revert(rejected: Op[], prev: Snapshot): void {
  applying = true;
  try {
    for (const op of rejected) {
      const key = opKey(op);
      const old = prev.get(key);
      const value = old === undefined ? null : JSON.parse(old);
      const back = { ...op, v: value } as Op;
      if (applyOp(store.project, back)) { if (old === undefined) snap.delete(key); else snap.set(key, old); }
    }
    history.clear();
    store.emit('glyph'); store.emit('fx:external'); store.emit('notes');
    scheduleBuild(60);
  } finally { applying = false; }
  const first = rejected[0];
  const who = first.k === 'glyph' || first.k === 'alt' ? holderOf(first.ch) : null;
  const mine = collab.session?.me;
  toast(who ? `${who.name} is working on “${(first as { ch: string }).ch}”. Pick another letter, or wait until they move on.`
    : mine && !mine.canEdit ? 'The host has set this session to watch only. You can still leave notes (N).'
    : 'That change could not be shared, so it was taken back.', 4500);
}

store.subscribe((ev) => {
  if (!collab.session || applying) return;
  if (ev === 'select') { flush(); idle = false; lastActive = Date.now(); collab.session.setPresence({ ch: store.selected }); return; } // my last edit goes out before I let go of the letter
  if (ev === 'project:loaded') {
    // the host opened another font: that becomes the shared one. A guest who opens one of their own fonts has left.
    if (collab.session.role === 'host') { if (flushTimer) clearTimeout(flushTimer); flushTimer = window.setTimeout(flush, 120); }
    else { const s = collab.session; remember(null); collab.session = null; collab.peers = []; collab.status = 'off'; collab.detail = ''; rosterSig = ''; try { s.leave(); } catch { /* ignore */ } store.emit('collab'); toast('You opened another font, so you left the session.', 4000); }
    return;
  }
  if (!SYNC_EVENTS.has(ev)) return;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = window.setTimeout(flush, 120);
});

/** Pointer position on the open letter, in font units (null when the pointer leaves). */
export function setCursor(pos: [number, number] | null): void {
  if (inSession()) collab.session!.setPresence({ cursor: pos });
}

// ---- remote → local

function applyRemote(ops: Op[], _from: Peer | null): void {
  if (!ops.length) return;
  flush(); // my unsent changes go out first, so they are not swallowed by the new snapshot
  applying = true;
  const kinds = new Set<string>();
  try {
    for (const op of ops) {
      if (!applyOp(store.project, op)) continue;
      kinds.add(op.k === 'set' ? `set:${op.key}` : op.k);
      // their change becomes part of every undo state of mine, so my undo only undoes my own work
      history.rebase((h) => {
        if (op.k === 'glyph') { if (op.v) h.glyphs[op.ch] = structuredClone(op.v); else delete h.glyphs[op.ch]; }
        else if (op.k === 'alt') { if (op.v?.length) h.alternates[op.ch] = structuredClone(op.v); else delete h.alternates[op.ch]; }
        else if (op.k === 'note') { h.notes = h.notes.filter((n) => n.id !== op.id); if (op.v) h.notes.push(structuredClone(op.v)); }
        else if (op.key === 'kerning') h.kerning = structuredClone(op.v as FontProject['kerning']);
        else if (op.key === 'blocks') h.blocks = structuredClone(op.v as string[]);
        else if (op.key === 'customChars') h.customChars = op.v as string;
      });
    }
    snap = snapshotOf(store.project);
    if (kinds.has('glyph') || kinds.has('alt')) store.emit('glyph');
    if (kinds.has('note')) { store.emit('notes'); if (!kinds.has('glyph')) store.emit('glyph'); }
    if (kinds.has('set:fx') || kinds.has('set:color')) store.emit('fx:external');
    if (kinds.has('set:blocks') || kinds.has('set:customChars')) store.emit('charset');
    if ([...kinds].some((k) => k.startsWith('set:') && !['set:fx', 'set:color', 'set:blocks', 'set:customChars'].includes(k))) store.emit('project');
    scheduleBuild(80);
  } finally { applying = false; }
}
