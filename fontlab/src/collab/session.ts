/**
 * A collaboration session: one host, up to 12 guests, one font.
 *
 * The host is the sequencer. A guest's change goes to the host, which checks
 * it, applies it, and relays it to every guest (the sender gets it back as an
 * echo). Guests ignore other people's changes to a value while their own
 * change to it is still on its way, so everyone ends up with the host's order
 * (last writer wins per value).
 *
 * Nothing here touches the project directly: changes are handed to
 * `events.onRemoteOps`, already validated.
 */
import type { FontProject } from '../core/glyph';
import { parseProject, serializeProject } from '../project/schema';
import { chunk, diffProject, opFromSnapshot, opKey, Reassembler, recordOp, snapshotOf, validateOp, type Op, type Snapshot } from './protocol';
import type { Transport } from './transport';

export interface Peer { id: string; name: string; color: string; host: boolean; canEdit: boolean; ch: string | null; cursor: [number, number] | null }
export interface SessionEvents {
  onPeers(peers: Peer[]): void;                      // roster, presence, permissions or locks changed
  onRemoteOps(ops: Op[], from: Peer | null): void;   // ordered ops to apply to the local project (already validated)
  onInit?(project: FontProject): void;               // guest only: the host's font arrived (parsed with parseProject)
  onStatus(status: 'connecting' | 'open' | 'closed' | 'error', detail?: string): void;
}

export const MAX_GUESTS = 12;
export const PEER_COLORS: readonly string[] = ['#e5484d', '#0a84ff', '#30a46c', '#f76b15', '#8e4ec6', '#12a594', '#e93d82', '#ad7f58'];
const MAX_NAME = 40;
const MAX_CH = 32;
/** nobody reads a message larger than this (after reassembly) */
const MAX_MESSAGE = 8 * 1024 * 1024;
/** the host reads less from a guest than guests read from the host, so whatever it accepts it can always relay */
const MAX_FROM_GUEST = 4 * 1024 * 1024;
/** one value larger than this cannot be shared */
const MAX_OP = 3 * 1024 * 1024;
/** many changes at once (regenerating a whole font) go out as several messages of about this size */
const OPS_BATCH = 512 * 1024;
const MAX_NOTES = 500;
const CURSOR_MS = 66;          // ~15 cursor updates a second
const JOIN_TIMEOUT = 20000;
/** changes to a letter I just left are still mine for a moment (the app sends edits a beat after they are made) */
const LEAVE_GRACE_MS = 1000;
/** the host chose to end the session */
export const HOST_ENDED = 'The host ended the session';
/** the connection to the host dropped (network, reload, closed tab): worth trying to rejoin */
export const HOST_LOST = 'Lost the connection to the host';
const HOST_GONE = HOST_ENDED;

type Cursor = [number, number] | null;
interface WirePeer { id: string; name: string; color: string; host: boolean; ch: string | null; st: number; cur: Cursor }
type Msg = Record<string, unknown> & { t: string };

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function cleanName(name: unknown): string {
  if (typeof name !== 'string') return '';
  return Array.from(name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).slice(0, MAX_NAME).join('').trim();
}
/** undefined = not a valid letter */
function cleanCh(ch: unknown): string | null | undefined {
  if (ch === null) return null;
  return typeof ch === 'string' && ch.length > 0 && ch.length <= MAX_CH ? ch : undefined;
}
/** undefined = not a valid cursor */
function cleanCursor(c: unknown): Cursor | undefined {
  if (c === null) return null;
  return Array.isArray(c) && c.length === 2 && fin(c[0]) && fin(c[1]) ? [c[0], c[1]] : undefined;
}
function errorText(e: unknown): string {
  return e instanceof Error && e.message ? e.message : String(e);
}
/** JSON of an op (with `v` in place of its value, if given) and of the value alone, stringifying the value once */
function encode(op: Op, v: unknown = op.v): { json: string; v: string } {
  const value = JSON.stringify(v) ?? 'null';
  const head = op.k === 'set' ? { k: op.k, key: op.key } : op.k === 'note' ? { k: op.k, id: op.id } : { k: op.k, ch: op.ch };
  return { v: value, json: `${JSON.stringify(head).slice(0, -1)},"v":${value}}` };
}
/** comma-joined groups of about OPS_BATCH characters */
function batches(jsons: string[]): string[] {
  const out: string[] = [];
  let cur: string[] = [], size = 0;
  for (const j of jsons) {
    if (cur.length && size + j.length > OPS_BATCH) { out.push(cur.join(',')); cur = []; size = 0; }
    cur.push(j); size += j.length;
  }
  if (cur.length) out.push(cur.join(','));
  return out;
}
/** key of something that claims to be an op, without trusting it */
function looseKey(op: unknown): string | null {
  if (!op || typeof op !== 'object') return null;
  const o = op as Record<string, unknown>;
  if ((o.k === 'glyph' || o.k === 'alt') && typeof o.ch === 'string' && o.ch.length <= MAX_CH) return o.k + ':' + o.ch;
  if (o.k === 'note' && typeof o.id === 'string' && o.id.length <= 120) return 'note:' + o.id;
  if (o.k === 'set' && typeof o.key === 'string' && o.key.length <= 20) return 'set:' + o.key;
  return null;
}

export class Session {
  readonly role: 'host' | 'guest';
  readonly room: string;
  readonly me: Peer;

  private transport: Transport;
  private events: SessionEvents;
  private getProject: (() => FontProject) | null;
  /** 'starting': joined, but the caller has not had a chance to store the session yet, so incoming traffic waits */
  private state: 'handshake' | 'starting' | 'open' | 'closed' = 'handshake';
  private backlog: Array<() => void> = [];
  private roster = new Map<string, Peer>();
  /** when each peer opened its current letter (host's counter); the lowest stamp on a letter holds it */
  private stamps = new Map<string, number>();
  private canGuestsEdit = true;
  private peersQueued = false;
  /** the letter each peer had open before the current one, and when it left it */
  private left = new Map<string, { ch: string; at: number }>();

  // host
  private guests = new Map<string, Reassembler>();
  /**
   * The font as sequenced so far, value by value. The host's live project can run ahead of it (changes the app
   * has not sent yet, and may still take back), so what guests are told always comes from here.
   */
  private sequenced: Snapshot = new Map();
  private seq = 0;
  private stampCounter = 0;

  // guest
  private hostId = '';
  private inbox = new Reassembler(MAX_MESSAGE);
  /** my ops the host has not answered yet, per key */
  private pending = new Map<string, number>();
  /** keys where a remote value was handed over while my own op was in flight: my echo must be applied again */
  private reapply = new Set<string>();
  private joinDone: ((err?: Error) => void) | null = null;

  // cursor throttle
  private cursorTimer: ReturnType<typeof setTimeout> | null = null;
  private cursorSentAt = 0;
  private cursorWaiting = false;

  private constructor(role: 'host' | 'guest', transport: Transport, room: string, name: string, events: SessionEvents, getProject: (() => FontProject) | null) {
    this.role = role;
    this.room = room;
    this.transport = transport;
    this.events = events;
    this.getProject = getProject;
    this.me = { id: '', name, color: PEER_COLORS[0], host: role === 'host', canEdit: true, ch: null, cursor: null };
    transport.onMessage = (from, data) => this.receive(from, data);
    transport.onPeerOpen = () => {};
    transport.onPeerClose = (id) => this.peerClosed(id);
  }

  static async host(transport: Transport, room: string, me: { name: string }, getProject: () => FontProject, events: SessionEvents): Promise<Session> {
    const s = new Session('host', transport, room, cleanName(me?.name) || 'Host', events, getProject);
    s.state = 'starting';
    s.emitStatus('connecting');
    try {
      await transport.open('host', room);
    } catch (e) {
      const text = errorText(e);
      s.state = 'closed';
      try { transport.close(); } catch { /* never opened */ }
      s.emitStatus('error', text);
      throw new Error(text);
    }
    s.me.id = transport.id;
    s.roster.set(s.me.id, s.me);
    try { s.sequenced = snapshotOf(getProject()); } catch (e) { console.error('[collab] could not read the font', e); }
    setTimeout(() => s.start(), 0);
    return s;
  }

  static join(transport: Transport, room: string, me: { name: string }, events: SessionEvents): Promise<Session> {
    const s = new Session('guest', transport, room, cleanName(me?.name) || 'Guest', events, null);
    s.emitStatus('connecting');
    return new Promise<Session>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      s.joinDone = (err) => {
        s.joinDone = null;
        if (timer) clearTimeout(timer);
        if (!err) { resolve(s); return; }
        s.state = 'closed';
        try { transport.close(); } catch { /* never opened */ }
        s.emitStatus('error', err.message);
        reject(err);
      };
      transport.onPeerOpen = (id) => { if (!s.hostId) s.hostId = id; };
      transport.open('guest', room).then(() => {
        if (s.state !== 'handshake') return;
        s.me.id = transport.id;
        timer = setTimeout(() => s.joinDone?.(new Error('The host did not answer in time.')), JOIN_TIMEOUT);
        s.send(null, { t: 'hello', v: 1, name: s.me.name });
      }, (e) => s.joinDone?.(new Error(errorText(e))));
    });
  }

  get guestsCanEdit(): boolean { return this.canGuestsEdit; }

  /** everyone including me, host first */
  peers(): Peer[] {
    const all = [...this.roster.values()];
    return [...all.filter((p) => p.host), ...all.filter((p) => !p.host)].map((p) => ({ ...p, cursor: p.cursor ? [p.cursor[0], p.cursor[1]] as [number, number] : null }));
  }

  /** who currently holds this letter (the first peer whose `ch` is that letter), or null */
  holder(ch: string): Peer | null {
    const h = this.holderOf(ch);
    return h ? { ...h } : null;
  }

  canEditLetter(ch: string): boolean {
    if (!this.me.canEdit) return false;
    const h = this.holderOf(ch);
    return !h || h === this.me;
  }

  /**
   * send local changes. Returns the ops that are NOT allowed for me right now
   * (view-only guest sending non-note ops, or a letter someone else holds):
   * the caller must undo those locally.
   */
  sendOps(ops: Op[]): Op[] {
    if (this.state === 'closed' || this.state === 'handshake') return [];
    const rejected: Op[] = [];
    const out: string[] = [];
    const corrected: Op[] = [];
    for (const op of ops) {
      const valid = validateOp(op);
      if (!valid || !this.allowed(this.me, valid)) { rejected.push(op); continue; }
      // a guest sends what it has: the host normalises, and its answer says if anything changed
      const enc = this.role === 'host' ? encode(valid) : encode(valid, op.v);
      if (enc.json.length > MAX_OP) { rejected.push(op); continue; }
      out.push(enc.json);
      if (this.role === 'host') {
        recordOp(this.sequenced, valid, enc.v);
        if (valid.v !== op.v) corrected.push(valid);
      } else {
        const key = opKey(valid);
        this.pending.set(key, (this.pending.get(key) ?? 0) + 1);
      }
    }
    for (const body of batches(out)) {
      if (this.role === 'host') this.broadcastJson(`{"t":"ops","seq":${++this.seq},"from":${JSON.stringify(this.me.id)},"ops":[${body}]}`);
      else this.sendJson(null, `{"t":"ops","ops":[${body}]}`);
    }
    // the host's own value was normalised on the way out: bring the host's project in line with what was sent
    if (corrected.length) queueMicrotask(() => { if (this.state !== 'closed') this.emitRemote(corrected, null); });
    return rejected;
  }

  /** cursor updates throttled to ~15/s */
  setPresence(p: { ch?: string | null; cursor?: [number, number] | null }): void {
    if (this.state === 'closed' || this.state === 'handshake' || !p) return;
    if (p.ch !== undefined) {
      const ch = cleanCh(p.ch);
      if (ch !== undefined && ch !== this.me.ch) {
        this.leaveLetter(this.me);
        this.me.ch = ch;
        // a cursor belongs to the letter it was on
        this.me.cursor = null;
        this.cursorWaiting = false;
        if (this.role === 'host') {
          this.stamps.set(this.me.id, ++this.stampCounter);
          this.broadcastRoster();
        } else {
          this.stamps.set(this.me.id, Infinity);   // behind everyone already there, until the host says otherwise
          this.send(null, { t: 'pres', ch });
        }
        this.peersSoon();
      }
    }
    if (p.cursor !== undefined) {
      const c = cleanCursor(p.cursor);
      if (c === undefined) return;
      const was = this.me.cursor;
      if (was === c || (was && c && was[0] === c[0] && was[1] === c[1])) return;
      this.me.cursor = c;
      this.cursorWaiting = true;
      const wait = CURSOR_MS - (Date.now() - this.cursorSentAt);
      if (wait <= 0) this.flushCursor();
      else if (!this.cursorTimer) this.cursorTimer = setTimeout(() => { this.cursorTimer = null; this.flushCursor(); }, wait);
    }
  }

  /** host only; false = guests can watch and add/resolve notes only */
  setGuestsCanEdit(v: boolean): void {
    if (this.role !== 'host' || this.state === 'closed' || this.canGuestsEdit === !!v) return;
    this.canGuestsEdit = !!v;
    for (const p of this.roster.values()) p.canEdit = p.host || this.canGuestsEdit;
    this.broadcastRoster();
    this.peersSoon();
  }

  /** Idempotent. The caller knows it left: no status event is sent for it. */
  leave(): void {
    if (this.state === 'closed') return;
    const joining = this.joinDone;
    if (this.role === 'host') this.broadcast({ t: 'end' });
    else if (this.state !== 'handshake') this.send(null, { t: 'bye' });
    this.shut();
    joining?.(new Error('Left before the session started'));
  }

  // ---------------------------------------------------------------- shared internals

  private shut(): void {
    this.state = 'closed';
    this.backlog = [];
    if (this.cursorTimer) clearTimeout(this.cursorTimer);
    this.cursorTimer = null;
    this.pending.clear();
    this.reapply.clear();
    try { this.transport.close(); } catch (e) { console.error('[collab] close failed', e); }
  }

  private start(): void {
    if (this.state !== 'starting') return;
    this.state = 'open';
    this.emitStatus('open');
    this.emitPeers();
    const waiting = this.backlog;
    this.backlog = [];
    for (const fn of waiting) fn();
  }

  private holderOf(ch: string): Peer | null {
    let best: Peer | null = null;
    let bestStamp = Infinity;
    for (const p of this.roster.values()) {
      if (p.ch !== ch) continue;
      const st = this.stamps.get(p.id) ?? Infinity;
      if (!best || st < bestStamp) { best = p; bestStamp = st; }
    }
    return best;
  }

  private allowed(who: Peer, op: Op): boolean {
    if (!who.host && !this.canGuestsEdit && op.k !== 'note') return false;
    if (op.k === 'glyph' || op.k === 'alt') {
      const h = this.holderOf(op.ch);
      if (h && h.id !== who.id) {
        const was = this.left.get(who.id);
        return !!was && was.ch === op.ch && Date.now() - was.at < LEAVE_GRACE_MS;
      }
    }
    return true;
  }

  /** call before changing `who.ch` */
  private leaveLetter(who: Peer): void {
    // only a holder keeps a moment of grace: someone who was waiting never had the letter
    if (who.ch !== null && this.holderOf(who.ch) === who) this.left.set(who.id, { ch: who.ch, at: Date.now() });
    else this.left.delete(who.id);
  }

  private send(to: string | null, msg: Msg): void {
    try { this.sendJson(to, JSON.stringify(msg)); } catch (e) { console.error('[collab] send failed', e); }
  }

  private sendJson(to: string | null, json: string): void {
    try {
      for (const part of chunk(json)) this.transport.send(to, part);
    } catch (e) { console.error('[collab] send failed', e); }
  }

  /** host → every guest that has joined (not merely connected) */
  private broadcast(msg: Msg, except?: string): void {
    if (!this.guests.size) return;
    try { this.broadcastJson(JSON.stringify(msg), except); } catch (e) { console.error('[collab] send failed', e); }
  }

  private broadcastJson(json: string, except?: string): void {
    if (!this.guests.size) return;
    try {
      const parts = chunk(json);
      for (const id of this.guests.keys()) {
        if (id !== except) for (const part of parts) this.transport.send(id, part);
      }
    } catch (e) { console.error('[collab] send failed', e); }
  }

  private flushCursor(): void {
    if (!this.cursorWaiting || this.state === 'closed') return;
    this.cursorWaiting = false;
    this.cursorSentAt = Date.now();
    if (this.role === 'host') this.broadcast({ t: 'cur', id: this.me.id, c: this.me.cursor });
    else this.send(null, { t: 'cur', c: this.me.cursor });
  }

  private emitStatus(status: 'connecting' | 'open' | 'closed' | 'error', detail?: string): void {
    try { this.events.onStatus(status, detail); } catch (e) { console.error('[collab] onStatus failed', e); }
  }
  private emitPeers(): void {
    try { this.events.onPeers(this.peers()); } catch (e) { console.error('[collab] onPeers failed', e); }
  }
  /** after a local call: tell the caller once it is done with what it was doing */
  private peersSoon(): void {
    if (this.peersQueued) return;
    this.peersQueued = true;
    queueMicrotask(() => { this.peersQueued = false; if (this.state === 'open') this.emitPeers(); });
  }
  private emitRemote(ops: Op[], from: Peer | null): void {
    try { this.events.onRemoteOps(ops, from ? { ...from } : null); } catch (e) { console.error('[collab] onRemoteOps failed', e); }
  }

  private receive(from: string, data: string): void {
    try {
      if (this.state === 'closed') return;
      if (this.state === 'starting') { this.backlog.push(() => this.receive(from, data)); return; }
      if (typeof from !== 'string' || typeof data !== 'string') return;
      let full: string | null;
      if (this.role === 'host') {
        const inbox = this.guests.get(from);
        // strangers may only say hello, and briefly
        full = inbox ? inbox.push(data) : data.length <= 4096 && !data.startsWith('{"c":') ? data : null;
      } else {
        if (this.hostId && from !== this.hostId) return;
        full = this.inbox.push(data);
      }
      if (full === null || full.length > (this.role === 'host' ? MAX_FROM_GUEST : MAX_MESSAGE)) return;
      const msg = JSON.parse(full) as unknown;
      if (!msg || typeof msg !== 'object' || typeof (msg as Msg).t !== 'string') return;
      if (this.role === 'host') this.hostReceive(from, msg as Msg);
      else this.guestReceive(msg as Msg);
    } catch (e) {
      // never throw from a message handler: a bad message is only ever ignored
      if (!(e instanceof SyntaxError)) console.error('[collab] message ignored', e);
    }
  }

  private peerClosed(id: string): void {
    try {
      if (this.state === 'closed') return;
      if (this.state === 'starting') { this.backlog.push(() => this.peerClosed(id)); return; }
      if (this.role === 'host') { this.removeGuest(id); return; }
      if (this.hostId && id !== this.hostId) return;
      this.hostGone(true); // the connection dropped without a goodbye
    } catch (e) { console.error('[collab] close ignored', e); }
  }

  // ---------------------------------------------------------------- host

  private wirePeers(): WirePeer[] {
    return [...this.roster.values()].map((p) => ({ id: p.id, name: p.name, color: p.color, host: p.host, ch: p.ch, st: this.stamps.get(p.id) ?? 0, cur: p.cursor }));
  }

  private broadcastRoster(except?: string): void {
    if (this.role !== 'host') return;
    this.broadcast({ t: 'roster', gce: this.canGuestsEdit, peers: this.wirePeers() }, except);
  }

  private pickColor(): string {
    const used = new Map<string, number>();
    for (const p of this.roster.values()) used.set(p.color, (used.get(p.color) ?? 0) + 1);
    let best = PEER_COLORS[0], bestCount = Infinity;
    for (const c of PEER_COLORS) {
      const n = used.get(c) ?? 0;
      if (n < bestCount) { best = c; bestCount = n; }
    }
    return best;
  }

  private removeGuest(id: string): void {
    if (id === this.me.id || !this.roster.has(id)) return;
    this.roster.delete(id);
    this.guests.delete(id);
    this.stamps.delete(id);
    this.left.delete(id);
    this.broadcastRoster();
    this.emitPeers();
  }

  private hostReceive(from: string, m: Msg): void {
    const peer = this.guests.has(from) ? this.roster.get(from) : undefined;
    if (!peer) {
      if (m.t === 'hello') this.admit(from, m);
      return;
    }
    switch (m.t) {
      case 'ops': this.hostOps(peer, m.ops); break;
      case 'pres': {
        const ch = cleanCh(m.ch);
        if (ch === undefined || ch === peer.ch) break;
        this.leaveLetter(peer);
        peer.ch = ch;
        peer.cursor = null;
        this.stamps.set(peer.id, ++this.stampCounter);
        this.broadcastRoster();
        this.emitPeers();
        break;
      }
      case 'cur': {
        const c = cleanCursor(m.c);
        if (c === undefined) break;
        peer.cursor = c;
        this.broadcast({ t: 'cur', id: peer.id, c }, peer.id);
        this.emitPeers();
        break;
      }
      case 'bye': this.removeGuest(from); break;
      default: break;
    }
  }

  private admit(from: string, m: Msg): void {
    const refuse = (reason: string) => this.send(from, { t: 'no', reason });
    if (this.guests.size >= MAX_GUESTS) { refuse(`This session is full (${MAX_GUESTS} guests). Ask the host to let you know when someone leaves.`); return; }
    let project: string;
    const ahead: Op[] = [];
    try {
      const live = this.getProject!();
      project = serializeProject(live);
      // where the app is ahead of what has been sequenced, the newcomer starts from the sequenced value like everyone else
      for (const op of diffProject(this.sequenced, live).ops) { const std = opFromSnapshot(this.sequenced, opKey(op)); if (std) ahead.push(std); }
    } catch { refuse('The host could not share the font. Ask them to try again.'); return; }
    if (project.length > MAX_MESSAGE - 65536) { refuse('This font is too large to work on together.'); return; }
    const peer: Peer = { id: from, name: cleanName(m.name) || 'Guest', color: this.pickColor(), host: false, canEdit: this.canGuestsEdit, ch: null, cursor: null };
    this.roster.set(from, peer);
    this.guests.set(from, new Reassembler(MAX_FROM_GUEST));
    // the font goes in as JSON within JSON-text (not as a string): escaping it twice would nearly double a large font on the wire
    const head = JSON.stringify({ t: 'init', you: from, seq: this.seq, gce: this.canGuestsEdit, peers: this.wirePeers() });
    this.sendJson(from, `${head.slice(0, -1)},"project":${project}}`);
    if (ahead.length) this.send(from, { t: 'fix', ops: ahead });
    this.broadcastRoster(from);
    this.emitPeers();
  }

  /** check a guest's ops, apply the good ones, relay them, and answer the rest with the value that stands */
  private hostOps(peer: Peer, raw: unknown): void {
    if (!Array.isArray(raw) || raw.length > 50000) return;
    const accepted: Op[] = [];   // applied here and relayed to everyone else
    const echo = new Set<Op>();  // accepted exactly as sent: the sender only needs to hear that
    const fixKeys: string[] = [];   // refused or normalised: the sender gets the standing value, once per op
    let noteIds: Set<string> | null = null;
    for (const item of raw) {
      const key = looseKey(item);
      if (key === null) continue;
      let op = validateOp(item);
      if (op && !this.allowed(peer, op)) op = null;
      if (op && op.k === 'note' && op.v) {
        if (!noteIds) noteIds = new Set((this.getProject!().notes ?? []).map((n) => n.id));
        if (!noteIds.has(op.id)) { if (noteIds.size >= MAX_NOTES) op = null; else noteIds.add(op.id); }
      }
      if (!op) { fixKeys.push(key); continue; }
      accepted.push(op);
      if (op.v !== (item as { v: unknown }).v) fixKeys.push(key); else echo.add(op);
    }
    if (accepted.length) {
      // apply first: if the host has unsent changes of its own it sends them from this callback, and they must be ordered before these
      this.emitRemote(accepted, peer);
      if (this.state === 'closed') return;
      const head = `{"t":"ops","seq":${++this.seq},"from":${JSON.stringify(peer.id)},"ops":[`;
      const all: string[] = [], back: string[] = [];
      for (const op of accepted) {
        const enc = encode(op);
        recordOp(this.sequenced, op, enc.v);
        all.push(enc.json);
        if (echo.has(op)) back.push(enc.json);
      }
      this.broadcastJson(`${head}${all.join(',')}]}`, peer.id);
      this.sendJson(peer.id, `${head}${back.join(',')}]}`);
    }
    if (fixKeys.length) {
      const ops: Op[] = [];
      for (const key of fixKeys) { const op = opFromSnapshot(this.sequenced, key); if (op) ops.push(op); }
      this.send(peer.id, { t: 'fix', ops });
    }
  }

  // ---------------------------------------------------------------- guest

  private guestReceive(m: Msg): void {
    if (this.state === 'handshake') {
      if (m.t === 'init') this.guestInit(m);
      else if (m.t === 'no') this.joinDone?.(new Error(cleanReason(m.reason) || 'The host did not let you in.'));
      return;
    }
    switch (m.t) {
      case 'ops': this.guestOps(m); break;
      case 'fix': this.guestFix(m.ops); break;
      case 'roster':
        this.canGuestsEdit = m.gce !== false;
        this.applyRoster(m.peers);
        this.emitPeers();
        break;
      case 'cur': {
        const p = typeof m.id === 'string' && m.id !== this.me.id ? this.roster.get(m.id) : undefined;
        const c = cleanCursor(m.c);
        if (!p || c === undefined) break;
        p.cursor = c;
        this.emitPeers();
        break;
      }
      case 'end': this.hostGone(); break;
      default: break;
    }
  }

  private guestInit(m: Msg): void {
    if (typeof m.you !== 'string' || !m.project || !Array.isArray(m.peers)) { this.joinDone?.(new Error('The host runs a version of FontLab this one cannot work with.')); return; }
    let project: FontProject;
    try {
      const raw = (typeof m.project === 'string' ? JSON.parse(m.project) : m.project) as Record<string, unknown>;
      for (const part of ['glyphs', 'alternates']) {
        const o = raw?.[part];
        if (o && typeof o === 'object') delete (o as Record<string, unknown>)['__proto__'];
      }
      project = parseProject(raw);
    } catch { this.joinDone?.(new Error('The font the host sent could not be read.')); return; }
    this.me.id = m.you;
    this.canGuestsEdit = m.gce !== false;
    this.applyRoster(m.peers);
    this.state = 'starting';
    try { this.events.onInit?.(project); } catch (e) { console.error('[collab] onInit failed', e); }
    if (this.state !== 'starting') return;   // the caller left from inside onInit
    this.joinDone?.();
    setTimeout(() => this.start(), 0);
  }

  private applyRoster(raw: unknown): void {
    if (!Array.isArray(raw) || raw.length > MAX_GUESTS + 4) return;
    const next = new Map<string, Peer>();
    const stamps = new Map<string, number>();
    for (const w of raw as Array<Partial<WirePeer>>) {
      if (!w || typeof w !== 'object' || typeof w.id !== 'string' || !w.id || w.id.length > 200 || next.has(w.id)) continue;
      const host = w.host === true;
      const ch = cleanCh(w.ch) ?? null;
      const color = typeof w.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(w.color) ? w.color : PEER_COLORS[0];
      const name = cleanName(w.name) || (host ? 'Host' : 'Guest');
      const canEdit = host || this.canGuestsEdit;
      const stamp = fin(w.st) ? w.st : Infinity;
      if (w.id === this.me.id) {
        // which letter I have open is mine to say; the host's stamp counts once it has caught up with me
        Object.assign(this.me, { name, color, host: false, canEdit });
        next.set(w.id, this.me);
        stamps.set(w.id, ch === this.me.ch ? stamp : Infinity);
      } else {
        next.set(w.id, { id: w.id, name, color, host, canEdit, ch, cursor: cleanCursor(w.cur) ?? null });
        stamps.set(w.id, stamp);
      }
    }
    if (!next.has(this.me.id)) { this.me.canEdit = this.canGuestsEdit; next.set(this.me.id, this.me); stamps.set(this.me.id, Infinity); }
    this.roster = next;
    this.stamps = stamps;
  }

  /** one of my ops was answered; true when nothing of mine is in flight for that key any more */
  private answered(key: string): boolean {
    const n = (this.pending.get(key) ?? 0) - 1;
    if (n > 0) { this.pending.set(key, n); return false; }
    this.pending.delete(key);
    return true;
  }

  private guestOps(m: Msg): void {
    if (!Array.isArray(m.ops)) return;
    const list: Op[] = [];
    if (m.from === this.me.id) {
      // my own ops, now in the host's order: nothing to apply, they are no longer in flight
      for (const item of m.ops) {
        const key = looseKey(item);
        if (key === null || !this.answered(key) || !this.reapply.delete(key)) continue;
        const op = validateOp(item);
        if (op) list.push(op);
      }
      if (list.length) this.deliver(list, null);
      return;
    }
    for (const item of m.ops) {
      const op = validateOp(item);
      // while my own change to this value is in flight it wins here: the host ordered it later, or will answer it with a fix
      if (op && !this.pending.has(opKey(op))) list.push(op);
    }
    if (list.length) this.deliver(list, (typeof m.from === 'string' && this.roster.get(m.from)) || null);
  }

  /** the host refused or adjusted ops of mine: this is what stands */
  private guestFix(raw: unknown): void {
    if (!Array.isArray(raw)) return;
    const list: Op[] = [];
    for (const item of raw) {
      const key = looseKey(item);
      if (key === null || !this.answered(key)) continue;
      this.reapply.delete(key);
      const op = validateOp(item);
      if (op) list.push(op);
    }
    if (list.length) this.deliver(list, null);
  }

  private deliver(ops: Op[], from: Peer | null): void {
    this.emitRemote(ops, from);
    // the callback may have sent a local change to one of these keys first and then overwritten it with the
    // remote value: when that change comes back from the host it has to be applied, not just counted
    for (const op of ops) { const key = opKey(op); if (this.pending.has(key)) this.reapply.add(key); }
  }

  private hostGone(lost = false): void {
    if (this.state === 'closed') return;
    if (this.joinDone) { this.joinDone(new Error(lost ? HOST_LOST : HOST_GONE)); return; }
    this.shut();
    this.emitStatus('closed', lost ? HOST_LOST : HOST_GONE);
  }
}

function cleanReason(r: unknown): string {
  return typeof r === 'string' ? r.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300) : '';
}
