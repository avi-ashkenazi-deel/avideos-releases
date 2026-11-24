/**
 * Transports for collaboration sessions. Star topology: guests are connected
 * to the host only. A transport moves opaque strings and reports who came and
 * went; everything else (ordering, roster, permissions) lives in session.ts.
 *
 *  - MemoryHub      in-process, for unit tests
 *  - LocalTransport BroadcastChannel: tabs of one browser
 *  - PeerTransport  WebRTC data channels via PeerJS (loaded on first use)
 */
import type { Peer as PeerJs, DataConnection, PeerOptions } from 'peerjs';

export interface Transport {
  /** my id once open */
  readonly id: string;
  /** host: start listening as `room`. guest: connect to the host of `room`. Resolves when ready; rejects with a readable Error on failure/timeout (20 s). */
  open(role: 'host' | 'guest', room: string): Promise<void>;
  /** to = peer id, or null: guests send to the host; the host sends to every guest */
  send(to: string | null, data: string): void;
  onMessage: (from: string, data: string) => void;
  onPeerOpen: (id: string) => void;     // host: a guest connected. guest: connected to host (id = host id)
  onPeerClose: (id: string) => void;    // host: a guest left. guest: host went away
  close(): void;
}

const ROOM_RE = /^[A-Za-z0-9]{4,64}$/;
const ROOM_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';   // 32 symbols, no l / o / 0 / 1

function randomId(len: number): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < len; i++) out += ROOM_ALPHABET[bytes[i] & 31];
  return out;
}

/** short, URL-safe, unguessable enough: 10 symbols of base32 = 50 random bits */
export function newRoomId(): string {
  return randomId(10);
}

function guard(fn: () => void): void {
  try { fn(); } catch (e) { console.error('[collab] handler failed', e); }
}

// ---------------------------------------------------------------- memory

export interface MemoryHubOptions {
  /** deliver messages of different senders in random order (order between one pair is always kept) */
  shuffle?: boolean;
  /** seed for the shuffle, so a failing order can be replayed */
  seed?: number;
  /** deliver one message every 0..delay ms (setTimeout) instead of one per microtask */
  delay?: number;
}

/**
 * in-process hub for unit tests: any number of transports, async delivery,
 * per-pair ordering preserved, optional artificial delay/shuffle between
 * different senders.
 */
export class MemoryHub {
  /** false = nothing is delivered until step() / flush() is called */
  auto = true;
  private hosts = new Map<string, MemoryTransport>();
  private queues = new Map<string, Array<() => void>>();
  private fifo: string[] = [];
  private count = 0;
  private pumping = false;
  private ids = 0;
  private rnd: () => number;

  constructor(private opts: MemoryHubOptions = {}) {
    let s = (opts.seed ?? 1) >>> 0 || 1;
    this.rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 0x100000000; };
  }

  transport(): Transport {
    return new MemoryTransport(this);
  }

  /** messages and connection events still on their way */
  get inFlight(): number { return this.count; }

  /** deliver one thing now; false if nothing is waiting */
  step(): boolean {
    if (!this.count) return false;
    let key: string;
    if (this.opts.shuffle) {
      const live = [...this.queues.keys()];
      key = live[Math.floor(this.rnd() * live.length)];
      this.fifo.splice(this.fifo.indexOf(key), 1);
    } else key = this.fifo.shift()!;
    const q = this.queues.get(key)!;
    const fn = q.shift()!;
    if (!q.length) this.queues.delete(key);
    this.count--;
    guard(fn);
    return true;
  }

  /** resolves once nothing is in flight (delivers everything itself when `auto` is off) */
  async flush(): Promise<void> {
    for (;;) {
      if (!this.auto) while (this.step()) { /* deliver */ }
      if (!this.count) { await Promise.resolve(); if (!this.count) return; }
      else if (this.opts.delay) await new Promise((r) => setTimeout(r, 1));
      else await Promise.resolve();
    }
  }

  // -- used by MemoryTransport

  /** @internal */ nextId(role: string): string { return `${role}${++this.ids}`; }
  /** @internal */ hostOf(room: string): MemoryTransport | undefined { return this.hosts.get(room); }
  /** @internal */ setHost(room: string, t: MemoryTransport | null): void { if (t) this.hosts.set(room, t); else this.hosts.delete(room); }
  /** @internal */ post(from: string, to: string, fn: () => void): void {
    const key = from + '>' + to;
    let q = this.queues.get(key);
    if (!q) this.queues.set(key, (q = []));
    q.push(fn);
    this.fifo.push(key);
    this.count++;
    this.pump();
  }

  private pump(): void {
    if (this.pumping || !this.auto) return;
    this.pumping = true;
    const run = () => {
      this.pumping = false;
      if (!this.auto) return;
      this.step();
      if (this.count) this.pump();
    };
    if (this.opts.delay) setTimeout(run, Math.floor(this.rnd() * this.opts.delay));
    else queueMicrotask(run);
  }

  /** start delivering again after `auto` was switched back on */
  resume(): void { this.auto = true; if (this.count) this.pump(); }
}

class MemoryTransport implements Transport {
  id = '';
  onMessage: (from: string, data: string) => void = () => {};
  onPeerOpen: (id: string) => void = () => {};
  onPeerClose: (id: string) => void = () => {};
  private role: 'host' | 'guest' | null = null;
  private room = '';
  private closed = false;
  private host: MemoryTransport | null = null;           // guest: my host
  private guests = new Map<string, MemoryTransport>();   // host: my guests

  constructor(private hub: MemoryHub) {}

  open(role: 'host' | 'guest', room: string): Promise<void> {
    if (this.role || this.closed) return Promise.reject(new Error('This connection was already used'));
    this.role = role; this.room = room;
    if (role === 'host') {
      if (this.hub.hostOf(room)) { this.closed = true; return Promise.reject(new Error('This session link is already in use')); }
      this.id = this.hub.nextId('host');
      this.hub.setHost(room, this);
      return Promise.resolve();
    }
    const host = this.hub.hostOf(room);
    if (!host) { this.closed = true; return Promise.reject(new Error('No session found for this link. The host may have ended it.')); }
    this.id = this.hub.nextId('guest');
    this.host = host;
    return new Promise<void>((resolve, reject) => {
      this.hub.post(this.id, host.id, () => {
        if (host.closed || this.closed) return;
        host.guests.set(this.id, this);
        host.onPeerOpen(this.id);
      });
      this.hub.post(host.id, this.id, () => {
        if (host.closed) { this.closed = true; reject(new Error('No session found for this link. The host may have ended it.')); return; }
        if (this.closed) { reject(new Error('Closed')); return; }
        this.onPeerOpen(host.id);
        resolve();
      });
    });
  }

  send(to: string | null, data: string): void {
    if (this.closed || !this.role) return;
    if (this.role === 'guest') {
      const host = this.host;
      if (host) this.hub.post(this.id, host.id, () => { if (!host.closed && host.guests.get(this.id) === this) host.onMessage(this.id, data); });
      return;
    }
    const targets = to === null ? [...this.guests.values()] : this.guests.has(to) ? [this.guests.get(to)!] : [];
    for (const g of targets) this.hub.post(this.id, g.id, () => { if (!g.closed && g.host === this) g.onMessage(this.id, data); });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.role === 'host') {
      if (this.hub.hostOf(this.room) === this) this.hub.setHost(this.room, null);
      for (const g of this.guests.values()) {
        this.hub.post(this.id, g.id, () => { if (g.closed || g.host !== this) return; g.host = null; g.onPeerClose(this.id); });
      }
      this.guests.clear();
    } else if (this.role === 'guest' && this.host) {
      const host = this.host;
      this.host = null;
      // queued behind anything I sent before closing, like a real channel
      this.hub.post(this.id, host.id, () => { if (host.closed || host.guests.get(this.id) !== this) return; host.guests.delete(this.id); host.onPeerClose(this.id); });
    }
  }
}

// ---------------------------------------------------------------- local (BroadcastChannel)

export interface LocalTransportOptions {
  /** how long a guest looks for the host before giving up (default 6 s; nothing in one browser takes longer) */
  timeoutMs?: number;
  /** heartbeat period (default 2 s); a peer that stays silent for three periods is dropped */
  heartbeatMs?: number;
}

type LocalMsg = { k: 'up' | 'taken' | 'hi' | 'ok' | 'm' | 'hb' | 'ha' | 'bye' | 'gone'; f: string; t?: string; d?: string };

/**
 * BroadcastChannel('fontlab-room-<room>'): tabs of one browser. Used by e2e
 * tests and for trying a session on one computer.
 */
export class LocalTransport implements Transport {
  id = '';
  onMessage: (from: string, data: string) => void = () => {};
  onPeerOpen: (id: string) => void = () => {};
  onPeerClose: (id: string) => void = () => {};
  private role: 'host' | 'guest' | null = null;
  private bc: BroadcastChannel | null = null;
  private closed = false;
  private hostId = '';
  /** peers I am connected to → whether I heard from them since my last heartbeat, and how many heartbeats they missed */
  private peers = new Map<string, { seen: boolean; missed: number }>();
  private beat: ReturnType<typeof setInterval> | null = null;
  private settle: ((err?: Error) => void) | null = null;
  private onHide = () => this.close();

  constructor(private opts: LocalTransportOptions = {}) {}

  open(role: 'host' | 'guest', room: string): Promise<void> {
    if (this.role || this.closed) return Promise.reject(new Error('This connection was already used'));
    if (!ROOM_RE.test(room)) return Promise.reject(new Error('This session link is not valid'));
    if (typeof BroadcastChannel === 'undefined') return Promise.reject(new Error('This browser cannot connect tabs to each other'));
    this.role = role;
    this.id = (role === 'host' ? 'h-' : 'g-') + randomId(8);
    const bc = this.bc = new BroadcastChannel('fontlab-room-' + room);
    bc.onmessage = (ev: MessageEvent) => { try { this.receive(ev.data as LocalMsg); } catch (e) { console.error('[collab] local transport', e); } };
    if (typeof addEventListener === 'function') addEventListener('pagehide', this.onHide);
    return new Promise<void>((resolve, reject) => {
      const timers: Array<ReturnType<typeof setTimeout>> = [];
      this.settle = (err) => {
        this.settle = null;
        for (const t of timers) { clearTimeout(t); clearInterval(t); }
        if (err) { this.close(); reject(err); return; }
        const every = this.opts.heartbeatMs ?? 2000;
        this.beat = setInterval(() => this.heartbeat(), every);
        resolve();
      };
      if (role === 'host') {
        // another tab already hosting this room answers 'taken' at once
        this.post({ k: 'up', f: this.id });
        timers.push(setTimeout(() => this.settle?.(), 150));
      } else {
        const hello = () => this.post({ k: 'hi', f: this.id });
        hello();
        timers.push(setInterval(hello, 400));
        timers.push(setTimeout(() => this.settle?.(new Error('No session found for this link. The host may have ended it, or it is open in a different browser.')), this.opts.timeoutMs ?? 6000));
      }
    });
  }

  send(to: string | null, data: string): void {
    if (this.closed || !this.bc || this.settle) return;
    if (this.role === 'guest') { if (this.hostId) this.post({ k: 'm', f: this.id, t: this.hostId, d: data }); return; }
    if (to === null) { for (const id of this.peers.keys()) this.post({ k: 'm', f: this.id, t: id, d: data }); }
    else if (this.peers.has(to)) this.post({ k: 'm', f: this.id, t: to, d: data });
  }

  close(): void {
    if (this.closed) return;
    if (this.bc && this.id) this.post({ k: 'bye', f: this.id });
    this.closed = true;
    if (this.beat) clearInterval(this.beat);
    this.beat = null;
    if (typeof removeEventListener === 'function') removeEventListener('pagehide', this.onHide);
    const bc = this.bc;
    this.bc = null;
    this.peers.clear();
    try { bc?.close(); } catch { /* already closed */ }
    this.settle?.(new Error('Closed'));
  }

  private post(m: LocalMsg): void {
    try { this.bc?.postMessage(m); } catch { /* channel closed under us */ }
  }

  private receive(m: LocalMsg): void {
    if (this.closed || !m || typeof m !== 'object' || typeof m.f !== 'string' || m.f === this.id) return;
    if (m.t !== undefined && m.t !== this.id) return;
    const known = this.peers.get(m.f);
    if (known) known.seen = true;
    if (this.role === 'host') {
      switch (m.k) {
        case 'up': this.post({ k: 'taken', f: this.id, t: m.f }); break;
        case 'taken': this.settle?.(new Error('This session is already open in another tab')); break;
        case 'hi':
          if (this.settle) break;   // not hosting yet
          this.post({ k: 'ok', f: this.id, t: m.f });
          if (!known) { this.peers.set(m.f, { seen: true, missed: 0 }); guard(() => this.onPeerOpen(m.f)); }
          break;
        case 'm': if (known && typeof m.d === 'string') { const d = m.d; guard(() => this.onMessage(m.f, d)); } break;
        case 'hb':
          if (known) this.post({ k: 'ha', f: this.id, t: m.f });
          else if (m.t === this.id) this.post({ k: 'gone', f: this.id, t: m.f });   // I dropped this guest earlier: tell it
          break;
        case 'bye': if (known) this.drop(m.f); break;
        default: break;
      }
      return;
    }
    switch (m.k) {
      case 'ok':
        if (!this.settle || this.hostId) break;
        this.hostId = m.f;
        this.peers.set(m.f, { seen: true, missed: 0 });
        this.settle();
        guard(() => this.onPeerOpen(m.f));
        break;
      case 'm': if (m.f === this.hostId && typeof m.d === 'string') { const d = m.d; guard(() => this.onMessage(m.f, d)); } break;
      case 'hb': if (m.f === this.hostId) this.post({ k: 'ha', f: this.id, t: m.f }); break;
      case 'bye':
      case 'gone': if (m.f === this.hostId) this.drop(m.f); break;
      default: break;
    }
  }

  private drop(id: string): void {
    if (!this.peers.delete(id)) return;
    guard(() => this.onPeerClose(id));
    if (this.role === 'guest') this.close();
  }

  /**
   * Counts heartbeats, not seconds: a tab whose timers are throttled in the
   * background never drops a peer that is still answering.
   */
  private heartbeat(): void {
    if (this.closed) return;
    for (const [id, p] of [...this.peers]) {
      if (p.seen) { p.seen = false; p.missed = 0; continue; }
      if (++p.missed >= 3) this.drop(id);
    }
    if (this.closed) return;
    if (this.role === 'host') { if (this.peers.size) this.post({ k: 'hb', f: this.id }); }
    else if (this.hostId) this.post({ k: 'hb', f: this.id, t: this.hostId });
  }
}

// ---------------------------------------------------------------- PeerJS (WebRTC)

export interface PeerTransportOptions {
  /** PeerServer to broker connections; default is the public PeerJS cloud (0.peerjs.com) */
  host?: string;
  port?: number;
  path?: string;
  secure?: boolean;
  key?: string;
  /** STUN / TURN servers; default is the set PeerJS ships with */
  iceServers?: RTCIceServer[];
  /** default 20 s */
  timeoutMs?: number;
  /** PeerJS log level 0..3 */
  debug?: number;
}

const PEER_PREFIX = 'fontlab-';

function peerErrorText(err: unknown): string {
  const type = (err as { type?: string })?.type;
  const detail = (err as { message?: string })?.message ?? String(err);
  switch (type) {
    case 'browser-incompatible': return 'This browser cannot make direct connections (WebRTC is missing or blocked).';
    case 'unavailable-id': return 'This session link is already in use. Start a new session.';
    case 'peer-unavailable': return 'No session found for this link. The host may have ended it.';
    case 'invalid-id':
    case 'invalid-key': return 'This session link is not valid.';
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
    case 'ssl-unavailable': return 'Could not reach the connection server. Check your internet connection and try again.';
    case 'webrtc': return `The direct connection failed (${detail}).`;
    default: return `Connection problem: ${detail}`;
  }
}

/**
 * PeerJS: the broker (PeerServer) only introduces the browsers to each other;
 * the font travels over a reliable WebRTC data channel between them.
 */
export class PeerTransport implements Transport {
  id = '';
  onMessage: (from: string, data: string) => void = () => {};
  onPeerOpen: (id: string) => void = () => {};
  onPeerClose: (id: string) => void = () => {};
  private role: 'host' | 'guest' | null = null;
  private peer: PeerJs | null = null;
  private conns = new Map<string, DataConnection>();
  private hostId = '';
  private closed = false;
  private ready = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 1000;
  private stalled = new Map<DataConnection, ReturnType<typeof setTimeout>>();
  private onHide = () => this.close();

  constructor(private opts: PeerTransportOptions = {}) {}

  async open(role: 'host' | 'guest', room: string): Promise<void> {
    if (this.role || this.closed) throw new Error('This connection was already used');
    if (!ROOM_RE.test(room)) throw new Error('This session link is not valid');
    this.role = role;
    this.hostId = PEER_PREFIX + room;
    let PeerCtor: typeof PeerJs;
    try {
      const mod = await import('peerjs');
      PeerCtor = mod.Peer ?? (mod as unknown as { default: typeof PeerJs }).default;
    } catch {
      throw new Error('Could not load the connection code. Check your internet connection and reload.');
    }
    if (this.closed) throw new Error('Closed');
    const o = this.opts;
    const options: PeerOptions = { debug: o.debug ?? 0 };
    if (o.host !== undefined) options.host = o.host;
    if (o.port !== undefined) options.port = o.port;
    if (o.path !== undefined) options.path = o.path;
    if (o.secure !== undefined) options.secure = o.secure;
    if (o.key !== undefined) options.key = o.key;
    if (o.iceServers) options.config = { iceServers: o.iceServers };

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let stage = 'reach the connection server';
      const timer = setTimeout(() => fail(stage === 'reach the host'
        ? 'Could not connect to the host in time. A firewall or network may be blocking direct connections.'
        : 'Timed out trying to reach the connection server.'), o.timeoutMs ?? 20000);
      const fail = (text: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.close();
        reject(new Error(text));
      };
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.ready = true;
        resolve();
      };

      let peer: PeerJs;
      try {
        peer = role === 'host' ? new PeerCtor(this.hostId, options) : new PeerCtor(options);
      } catch (e) { fail(peerErrorText(e)); return; }
      this.peer = peer;
      if (typeof addEventListener === 'function') addEventListener('pagehide', this.onHide);

      peer.on('open', (id: string) => {
        this.id = id;
        this.retryDelay = 1000;
        if (role === 'host') { done(); return; }
        if (settled) return;   // a reconnect to the broker: the data connection is already there
        stage = 'reach the host';
        const conn = peer.connect(this.hostId, { reliable: true, serialization: 'raw' });
        this.wire(conn, () => { done(); guard(() => this.onPeerOpen(this.hostId)); });
      });
      if (role === 'host') peer.on('connection', (conn: DataConnection) => this.wire(conn, () => guard(() => this.onPeerOpen(conn.peer))));
      peer.on('error', (err: unknown) => {
        if (!settled) { fail(peerErrorText(err)); return; }
        // after opening: data connections survive broker trouble; just get back in touch with the broker
        const type = (err as { type?: string })?.type;
        if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed') this.reconnectSoon();
      });
      peer.on('disconnected', () => { if (settled) this.reconnectSoon(); });
    });
  }

  send(to: string | null, data: string): void {
    if (this.closed || !this.ready) return;
    const targets = this.role === 'guest' ? [this.conns.get(this.hostId)] : to === null ? [...this.conns.values()] : [this.conns.get(to)];
    for (const c of targets) {
      if (!c || !c.open) continue;
      try { void c.send(data); } catch (e) { console.error('[collab] send failed', e); }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    if (this.retry) clearTimeout(this.retry);
    for (const t of this.stalled.values()) clearTimeout(t);
    this.stalled.clear();
    if (typeof removeEventListener === 'function') removeEventListener('pagehide', this.onHide);
    this.conns.clear();
    try { this.peer?.destroy(); } catch { /* nothing left to clean up */ }
    this.peer = null;
  }

  private wire(conn: DataConnection, onOpen: () => void): void {
    const id = conn.peer;
    conn.on('open', () => {
      if (this.closed) return;
      const old = this.conns.get(id);
      this.conns.set(id, conn);
      if (old && old !== conn) { try { old.close(); } catch { /* gone */ } }
      onOpen();
    });
    conn.on('data', (d: unknown) => {
      if (this.closed || this.conns.get(id) !== conn || typeof d !== 'string') return;
      guard(() => this.onMessage(id, d));
    });
    const gone = () => {
      const t = this.stalled.get(conn);
      if (t) { clearTimeout(t); this.stalled.delete(conn); }
      if (this.closed || this.conns.get(id) !== conn) return;
      this.conns.delete(id);
      guard(() => this.onPeerClose(id));
    };
    conn.on('close', gone);
    conn.on('error', () => { if (!conn.open) gone(); });
    // a vanished peer shows up as ICE 'disconnected' long before the browser gives up on it
    conn.on('iceStateChanged', (state: RTCIceConnectionState) => {
      const t = this.stalled.get(conn);
      if (t) { clearTimeout(t); this.stalled.delete(conn); }
      if (state === 'disconnected') this.stalled.set(conn, setTimeout(() => { try { conn.close(); } catch { /* gone */ } gone(); }, 10000));
    });
  }

  /** hosts need the broker to let new guests in; keep trying while the session lives */
  private reconnectSoon(): void {
    if (this.closed || this.retry || this.role !== 'host') return;
    this.retry = setTimeout(() => {
      this.retry = null;
      const p = this.peer;
      if (this.closed || !p || p.destroyed) return;
      this.retryDelay = Math.min(30000, this.retryDelay * 2);
      if (p.disconnected) { try { p.reconnect(); } catch { /* next round */ } }
    }, this.retryDelay);
  }
}

// ----------------------------------------------------------------

export function makeTransport(kind: 'peer' | 'local', opts?: Record<string, unknown>): Transport {
  return kind === 'local' ? new LocalTransport(opts as LocalTransportOptions) : new PeerTransport(opts as PeerTransportOptions);
}
