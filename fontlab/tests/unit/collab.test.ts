import { describe, it, expect } from 'vitest';
import { newProject, DEFAULT_STATS, type FontProject, type Glyph, type ReviewNote } from '../../src/core/glyph';
import { parseProject, serializeProject } from '../../src/project/schema';
import { generateGlyphs } from '../../src/generate/compose';
import { makeRng } from '../../src/core/prng';
import {
  applyOp, applyOps, chunk, currentOp, diffProject, isNoteOp, opKey, Reassembler, snapshotOf, validateOp, CHUNK_MAX,
  type Op, type Snapshot,
} from '../../src/collab/protocol';
import { MemoryHub, newRoomId, type Transport } from '../../src/collab/transport';
import { Session, MAX_GUESTS, PEER_COLORS, type Peer, type SessionEvents } from '../../src/collab/session';

// ---------------------------------------------------------------- helpers

/** random delivery orders tried per convergence test; COLLAB_SEEDS=5000 for a long soak */
const SEEDS = Number((globalThis as { process?: { env?: Record<string, string> } }).process?.env?.COLLAB_SEEDS) || 150;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const plain = (s: Snapshot) => Object.fromEntries([...s].sort(([a], [b]) => (a < b ? -1 : 1)));
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const bytes = (s: string) => new TextEncoder().encode(s).length;

function strokeGlyph(char: string, advance = 500, n = 4): Glyph {
  return {
    char, unicode: char.codePointAt(0)!, advance, source: 'drawn', kind: 'stroke',
    strokes: [{ id: 's-' + char, cap: 'round', points: Array.from({ length: n }, (_, i) => ({ x: i * 10, y: (i * 37) % 700, w: 30 })) }],
  };
}
function note(id: string, ch = 'a', text = 'hm'): ReviewNote {
  return { id, ch, x: 10, y: 20, text, author: 'T', createdAt: 1000 + id.length };
}
function generated(name = 'Gen'): FontProject {
  const p = newProject(name);
  p.glyphs = generateGlyphs({ seeds: [], stats: { ...DEFAULT_STATS }, mutation: 0.3, glyphs: {} }, 7);
  return clone(p);
}
function small(name = 'Small'): FontProject {
  const p = newProject(name);
  for (const ch of 'abc') p.glyphs[ch] = strokeGlyph(ch);
  return p;
}

/** A stand-in for the app's binding (src/ui/collab.ts): diff + send local changes, apply remote ones. */
class Client {
  project: FontProject;
  snap: Snapshot;
  session!: Session;
  peers: Peer[] = [];
  status: Array<[string, string | undefined]> = [];
  remote: Array<{ ops: Op[]; from: Peer | null }> = [];
  inits = 0;
  /** host only: every op in the order the host sequenced it */
  order: string[] = [];
  /** like the app: send my unsent changes before applying remote ones, then re-snapshot everything */
  flushInHandler = true;
  rejectedLocally: Op[] = [];

  constructor(project: FontProject = newProject('mine')) {
    this.project = project;
    this.snap = snapshotOf(project);
  }

  events(): SessionEvents {
    return {
      onPeers: (peers) => { this.peers = peers; },
      onStatus: (s, d) => { this.status.push([s, d]); },
      onInit: (p) => { this.inits++; this.project = p; this.snap = snapshotOf(p); },
      onRemoteOps: (ops, from) => {
        this.remote.push({ ops: clone(ops), from });
        if (this.flushInHandler) {
          this.flush();
          applyOps(this.project, ops);
          this.snap = snapshotOf(this.project);
        } else applyOps(this.project, ops, this.snap);
        if (this.session?.role === 'host' && from) for (const op of ops) this.order.push(JSON.stringify(op));
      },
    };
  }

  flush(): Op[] {
    const prev = this.snap;
    const { ops, next } = diffProject(prev, this.project);
    this.snap = next;
    if (!ops.length || !this.session) return [];
    const rejected = this.session.sendOps(ops);
    if (this.session.role === 'host') for (const op of ops) if (!rejected.includes(op)) this.order.push(JSON.stringify(op));
    for (const op of rejected) {
      const key = opKey(op);
      const old = prev.get(key);
      if (applyOp(this.project, { ...op, v: old === undefined ? null : JSON.parse(old) } as Op)) {
        if (old === undefined) this.snap.delete(key); else this.snap.set(key, old);
      }
    }
    this.rejectedLocally.push(...rejected);
    return rejected;
  }

  edit(fn: (p: FontProject) => void): Op[] {
    fn(this.project);
    return this.flush();
  }
}

async function settle(hub: MemoryHub): Promise<void> {
  for (let i = 0; i < 3; i++) { await hub.flush(); await tick(); }
  await hub.flush();
}

async function room(hub: MemoryHub, guests: number, project: FontProject = small(), names: string[] = ['Ana', 'Ben', 'Cy', 'Di']) {
  const id = newRoomId();
  const host = new Client(project);
  host.session = await Session.host(hub.transport(), id, { name: 'Hana' }, () => host.project, host.events());
  const gs: Client[] = [];
  for (let i = 0; i < guests; i++) {
    const g = new Client();
    g.session = await Session.join(hub.transport(), id, { name: names[i] ?? `G${i}` }, g.events());
    gs.push(g);
  }
  await settle(hub);
  return { id, host, guests: gs, all: [host, ...gs] };
}

// ---------------------------------------------------------------- protocol

describe('collab protocol: snapshot, diff, apply', () => {
  it('diff of an unchanged project is empty, and previewText is not synced', () => {
    const p = generated();
    const snap = snapshotOf(p);
    expect(diffProject(snap, p).ops).toEqual([]);
    p.previewText = 'my own test text';
    expect(diffProject(snap, p).ops).toEqual([]);
    expect([...snap.keys()].some((k) => k.includes('previewText'))).toBe(false);
  });

  it('a glyph changed in place gives exactly one op, with a copy of the value', () => {
    const p = generated();
    const snap = snapshotOf(p);
    p.glyphs['a'].advance += 17;   // same object, mutated
    const { ops, next } = diffProject(snap, p);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ k: 'glyph', ch: 'a' });
    expect(opKey(ops[0])).toBe('glyph:a');
    expect((ops[0] as { v: Glyph }).v).toEqual(p.glyphs['a']);
    expect((ops[0] as { v: Glyph }).v).not.toBe(p.glyphs['a']);
    expect(diffProject(next, p).ops).toEqual([]);
  });

  it('deleting a letter, notes, alternates and settings each give one op; applying the ops reproduces the project', () => {
    const before = generated();
    const p = clone(before);
    const snap = snapshotOf(p);
    delete p.glyphs['b'];
    p.notes.push(note('n1'));
    p.fx.groups[0].layers.push({ id: 'w1', type: 'wobble', enabled: true, params: { amount: 0.4 } });
    p.alternates['c'] = [clone(p.glyphs['c'])];
    p.kerning.pairs['AV'] = -80;
    p.name = 'Renamed';
    const { ops, next } = diffProject(snap, p);
    expect(ops.map(opKey).sort()).toEqual(['alt:c', 'glyph:b', 'note:n1', 'set:fx', 'set:kerning', 'set:name']);
    expect(ops.find((o) => o.k === 'glyph')).toEqual({ k: 'glyph', ch: 'b', v: null });
    expect(ops.filter(isNoteOp)).toHaveLength(1);

    const replica = clone(before);
    for (const op of ops) expect(applyOp(replica, op)).toBe(true);
    expect(plain(snapshotOf(replica))).toEqual(plain(next));
    expect(replica.glyphs['b']).toBeUndefined();
    expect(replica.fx.groups[0].layers[0].type).toBe('wobble');

    // and back: remove the note and the alternates
    const snap2 = snapshotOf(p);
    p.notes = [];
    delete p.alternates['c'];
    const back = diffProject(snap2, p);
    expect(back.ops.map((o) => [opKey(o), o.v])).toEqual(expect.arrayContaining([['note:n1', null], ['alt:c', null]]));
    expect(back.ops).toHaveLength(2);
    for (const op of back.ops) expect(applyOp(replica, op)).toBe(true);
    expect(replica.notes).toEqual([]);
    expect(replica.alternates).toEqual({});
    expect(plain(snapshotOf(replica))).toEqual(plain(back.next));
  });

  it('a note update replaces in place and new notes are listed by time', () => {
    const p = newProject();
    applyOp(p, { k: 'note', id: 'b', v: { ...note('b'), createdAt: 20 } });
    applyOp(p, { k: 'note', id: 'a', v: { ...note('a'), createdAt: 10 } });
    applyOp(p, { k: 'note', id: 'c', v: { ...note('c'), createdAt: 30 } });
    expect(p.notes.map((n) => n.id)).toEqual(['a', 'b', 'c']);
    applyOp(p, { k: 'note', id: 'b', v: { ...note('b'), createdAt: 20, done: true } });
    expect(p.notes.map((n) => n.id)).toEqual(['a', 'b', 'c']);
    expect(p.notes[1].done).toBe(true);
  });

  it('sees every kind of in-place change (snapshots reuse JSON by checksum, never by object identity)', () => {
    const p = generated();
    p.notes.push(note('n1'));
    p.alternates['a'] = [clone(p.glyphs['a'])];
    p.seeds = [clone(p.glyphs['b'])];
    let snap = snapshotOf(p);
    const g = p.glyphs['a'];
    const pts = g.strokes![0].points;
    const changes: Array<[string, () => void, string]> = [
      ['a tiny coordinate nudge', () => { pts[0].x += 1e-9; }, 'glyph:a'],
      ['two points swapped', () => { [pts[0], pts[1]] = [pts[1], pts[0]]; }, 'glyph:a'],
      ['a point removed', () => { pts.pop(); }, 'glyph:a'],
      ['a flag added', () => { g.locked = true; }, 'glyph:a'],
      ['a flag flipped', () => { g.locked = false; }, 'glyph:a'],
      ['a flag removed', () => { delete g.locked; }, 'glyph:a'],
      ['a string changed', () => { g.strokes![0].cap = g.strokes![0].cap === 'flat' ? 'round' : 'flat'; }, 'glyph:a'],
      ['x and y exchanged', () => { const q = pts[0]; [q.x, q.y] = [q.y, q.x]; }, 'glyph:a'],
      ['0 became -1', () => { pts[0].w = 0; snap = snapshotOf(p); pts[0].w = -1; }, 'glyph:a'],
      ['an empty stroke added', () => { g.strokes!.push({ id: 'e', cap: 'round', points: [] }); }, 'glyph:a'],
      ['an alternate edited', () => { p.alternates['a'][0].advance += 1; }, 'alt:a'],
      ['a seed edited', () => { p.seeds[0].advance += 1; }, 'set:seeds'],
      ['a note resolved', () => { p.notes[0].done = true; }, 'note:n1'],
      ['a kerning pair', () => { p.kerning.pairs['AV'] = -1; }, 'set:kerning'],
      ['a palette colour', () => { p.color.palette[1] = '#000000'; }, 'set:color'],
      ['an effect parameter', () => { p.fx.groups[0].layers.push({ id: 'w', type: 'wobble', enabled: true, params: { amount: 0.1 } }); snap = snapshotOf(p); p.fx.groups[0].layers[0].params.amount = 0.2; }, 'set:fx'],
    ];
    for (const [what, change, key] of changes) {
      change();
      const { ops, next } = diffProject(snap, p);
      expect(ops.map(opKey), what).toEqual([key]);
      expect(plain(next), what).toEqual(plain(snapshotOf(clone(p))));   // a clone has no history: stringified from scratch
      snap = next;
    }
    // an undefined property is not a change (JSON drops it)
    (g as unknown as Record<string, unknown>).extra = undefined;
    expect(diffProject(snap, p).ops).toEqual([]);
  });

  it('random in-place edits: the reused snapshot always equals one made from scratch', () => {
    const p = generated();
    const rng = makeRng(99);
    const chars = Object.keys(p.glyphs);
    let snap = snapshotOf(p);
    for (let i = 0; i < 100; i++) {
      const g = p.glyphs[chars[Math.floor(rng() * chars.length)]];
      const stroke = g.strokes?.[Math.floor(rng() * (g.strokes?.length ?? 0))];
      const pt = stroke?.points[Math.floor(rng() * stroke.points.length)];
      const kind = Math.floor(rng() * 5);
      if (kind === 0 && pt) pt.x += (rng() - 0.5) * 1e-6;
      else if (kind === 1 && pt) pt.y = Math.round(rng() * 700);
      else if (kind === 2 && stroke && stroke.points.length > 1) stroke.points.splice(Math.floor(rng() * stroke.points.length), 1);
      else if (kind === 3) g.advance = Math.round(rng() * 1000);
      else if (stroke) stroke.points.reverse();
      const before = JSON.stringify(g);
      const { ops, next } = diffProject(snap, p);
      const fresh = snapshotOf(clone(p));
      expect(plain(next)).toEqual(plain(fresh));
      expect(ops.length).toBe(snap.get('glyph:' + g.char) === before ? 0 : 1);
      snap = next;
    }
  });

  it('diffing 400 glyphs is fast', () => {
    const p = generated();
    const base = Object.values(p.glyphs);
    for (let i = 0; Object.keys(p.glyphs).length < 400; i++) {
      const ch = String.fromCodePoint(0x400 + i);
      p.glyphs[ch] = { ...clone(base[i % base.length]), char: ch, unicode: 0x400 + i };
    }
    const snap = snapshotOf(p);
    p.glyphs['a'].advance++;
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) { const t = performance.now(); expect(diffProject(snap, p).ops).toHaveLength(1); runs.push(performance.now() - t); }
    expect(Math.min(...runs)).toBeLessThan(50);
  });

  it('applyOp rejects garbage and changes nothing', () => {
    const p = small();
    const before = JSON.stringify(p);
    const g = strokeGlyph('a');
    const bad: unknown[] = [
      null, 42, 'glyph', {}, { k: 'nope', v: 1 },
      { k: 'glyph', ch: 'a', v: { char: 'a' } },                                  // not a glyph
      { k: 'glyph', ch: 'a', v: 'x' },
      { k: 'glyph', ch: '', v: g },
      { k: 'glyph', ch: '__proto__', v: g },
      { k: 'glyph', ch: 'x'.repeat(100), v: g },
      { k: 'glyph', ch: 'a', v: { ...g, strokes: [null] } },                       // would crash a renderer
      { k: 'glyph', ch: 'a', v: { ...g, strokes: [{ id: 's', cap: 'round', points: [{ x: 'NaN', y: 0, w: 1 }] }] } },
      { k: 'glyph', ch: 'a', v: { ...g, kind: 'outline', contours: [{ points: [[1]] }] } },
      { k: 'glyph', ch: 'a', v: { ...g, advance: null } },
      { k: 'alt', ch: 'a', v: [g, { char: 'a' }] },
      { k: 'alt', ch: 'a', v: [g, g, g, g] },
      { k: 'alt', ch: 'a', v: {} },
      { k: 'note', id: 'n', v: { id: 'n', ch: 'a', x: 1, y: 2 } },                 // no text
      { k: 'note', id: 'n', v: { ...note('other') } },                             // id mismatch
      { k: 'note', id: 'n', v: { ...note('n'), text: 'x'.repeat(3000) } },
      { k: 'note', id: 5, v: null },
      { k: 'set', key: 'previewText', v: 'hi' },                                   // not a synced key
      { k: 'set', key: 'glyphs', v: {} },
      { k: 'set', key: 'version', v: 2 },
      { k: 'set', key: 'name', v: 5 },
      { k: 'set', key: 'mutation', v: 'lots' },
      { k: 'set', key: 'metrics', v: { ascender: 'tall' } },
      { k: 'set', key: 'stats', v: null },
      { k: 'set', key: 'fx', v: { groups: 'none' } },
      { k: 'set', key: 'fx', v: null },
      { k: 'set', key: 'color', v: 'red' },
      { k: 'set', key: 'spacing', v: {} },
      { k: 'set', key: 'kerning', v: { auto: true, strength: 1, pairs: [] } },
      { k: 'set', key: 'blocks', v: [1, 2] },
      { k: 'set', key: 'customChars', v: ['a'] },
      { k: 'set', key: 'seeds', v: [{ char: 'a' }] },
    ];
    for (const op of bad) {
      expect(validateOp(op), JSON.stringify(op)).toBeNull();
      expect(applyOp(p, op as Op), JSON.stringify(op)).toBe(false);
    }
    expect(JSON.stringify(p)).toBe(before);
    expect(Object.getPrototypeOf(p.glyphs)).toBe(Object.prototype);
  });

  it('settings are normalised like a loaded file, and left alone when already clean', () => {
    const p = small();
    // unknown effect types are dropped, kerning is rounded and clamped
    const fx = { seed: 3, time: 0, groups: [{ id: 'g0', enabled: true, op: 'union', layers: [{ id: 'x', type: 'no-such-effect', enabled: true, params: {} }] }] };
    const a = validateOp({ k: 'set', key: 'fx', v: fx }) as Extract<Op, { k: 'set' }>;
    expect(a.v).not.toBe(fx);
    expect((a.v as FontProject['fx']).groups[0].layers).toEqual([]);
    const kern = { auto: true, strength: 1, pairs: { AV: -80.4, To: 99999, toolong: 3 } };
    const b = validateOp({ k: 'set', key: 'kerning', v: kern }) as Extract<Op, { k: 'set' }>;
    expect(b.v).toEqual({ auto: true, strength: 1, pairs: { AV: -80, To: 1000 } });
    // every setting of a real project passes through untouched (same object: nothing to correct)
    for (const key of ['fx', 'color', 'spacing', 'kerning', 'metrics', 'name', 'blocks', 'customChars', 'stats', 'seeds', 'mutation'] as const) {
      const v = (p as unknown as Record<string, unknown>)[key];
      const out = validateOp({ k: 'set', key, v }) as Extract<Op, { k: 'set' }>;
      expect(out, key).not.toBeNull();
      expect(out.v, key).toBe(v);
    }
    // key order alone is not a correction
    const metrics = { capHeight: 700, xHeight: 510, descender: -200, ascender: 800, upm: 1000 };
    expect((validateOp({ k: 'set', key: 'metrics', v: metrics }) as { v: unknown }).v).toBe(metrics);
  });

  it('currentOp reads the standing value of a key; applyOps keeps a snapshot in step', () => {
    const p = small();
    expect(currentOp(p, 'glyph:a')).toEqual({ k: 'glyph', ch: 'a', v: p.glyphs['a'] });
    expect(currentOp(p, 'glyph:zz')).toEqual({ k: 'glyph', ch: 'zz', v: null });
    expect(currentOp(p, 'glyph:constructor')).toEqual({ k: 'glyph', ch: 'constructor', v: null });
    expect(currentOp(p, 'note:nope')).toEqual({ k: 'note', id: 'nope', v: null });
    expect(currentOp(p, 'set:name')).toEqual({ k: 'set', key: 'name', v: 'Small' });
    expect(currentOp(p, 'set:previewText')).toBeNull();

    const snap = snapshotOf(p);
    p.name = 'local, unsent';   // must survive remote ops to other keys
    applyOps(p, [{ k: 'glyph', ch: 'a', v: null }, { k: 'glyph', ch: 'q', v: strokeGlyph('q') }, { k: 'note', id: 'n1', v: note('n1') }], snap);
    expect(diffProject(snap, p).ops).toEqual([{ k: 'set', key: 'name', v: 'local, unsent' }]);
  });
});

describe('collab protocol: chunking', () => {
  it('short messages pass through untouched', () => {
    const msg = JSON.stringify({ t: 'ops', ops: [] });
    expect(chunk(msg)).toEqual([msg]);
    const r = new Reassembler();
    expect(r.push(msg)).toBe(msg);
    expect(r.push('not json at all')).toBe('not json at all');
  });

  it('round-trips a 2 MB string in pieces under the limit', () => {
    const rng = makeRng(5);
    let s = '';
    const alphabet = ['a', 'b', '"', '\\', '\n', 'é', '字', '😀', '{', '}', ' ', '\u0001'];
    while (s.length < 2_000_000) s += alphabet[Math.floor(rng() * alphabet.length)].repeat(1 + Math.floor(rng() * 6));
    const parts = chunk(s);
    expect(parts.length).toBeGreaterThan(40);
    for (const p of parts) expect(bytes(p)).toBeLessThanOrEqual(CHUNK_MAX);
    const r = new Reassembler();
    let out: string | null = null;
    parts.forEach((p, i) => { out = r.push(p); if (i < parts.length - 1) expect(out).toBeNull(); });
    expect(out).toBe(s);
  });

  it('respects a custom limit and never loses a character', () => {
    const s = '😀'.repeat(500) + '"quoted"'.repeat(300);
    const parts = chunk(s, 300);
    for (const p of parts) expect(bytes(p)).toBeLessThanOrEqual(300);
    const r = new Reassembler();
    expect(parts.map((p) => r.push(p)).pop()).toBe(s);
  });

  it('keeps two interleaved streams apart', () => {
    const a = 'A'.repeat(150_000), b = 'B'.repeat(120_000);
    const pa = chunk(a), pb = chunk(b);
    const r = new Reassembler();
    const got: string[] = [];
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      for (const p of [pa[i], pb[i]]) { if (p === undefined) continue; const out = r.push(p); if (out !== null) got.push(out); }
    }
    expect(got.sort()).toEqual([a, b]);
  });

  it('a message that looks like a chunk is wrapped, so it still round-trips', () => {
    const tricky = '{"c":"x","i":0,"n":2,"d":"half"}';
    const parts = chunk(tricky);
    expect(parts).toHaveLength(1);
    expect(parts[0]).not.toBe(tricky);
    expect(new Reassembler().push(parts[0])).toBe(tricky);
  });

  it('drops oversized and malformed streams', () => {
    const r = new Reassembler(1000);
    const parts = chunk('x'.repeat(5000), 600);
    expect(parts.map((p) => r.push(p)).every((v) => v === null)).toBe(true);
    expect(r.push('y'.repeat(2000))).toBeNull();
    const r2 = new Reassembler();
    const p2 = chunk('z'.repeat(200_000));
    expect(r2.push(p2[1])).toBeNull();               // starts in the middle
    expect(r2.push(p2[0])).toBeNull();
    expect(r2.push(p2[2])).toBeNull();               // skipped one: stream is dropped
    expect(r2.push(p2[1])).toBeNull();
    expect(r2.push('{"c":"q","i":0,"n":0,"d":""}')).toBeNull();
    expect(r2.push('{"c":"q","i":"0","n":1,"d":""}')).toBeNull();
    expect(r2.push('{"c":"broken')).toBeNull();
  });
});

// ---------------------------------------------------------------- transport

describe('collab MemoryHub', () => {
  it('connects guests to the host only and keeps order between a pair', async () => {
    const hub = new MemoryHub({ shuffle: true, seed: 9 });
    const h = hub.transport(), a = hub.transport(), b = hub.transport();
    const opened: string[] = [], closed: string[] = [];
    const got: Record<string, string[]> = { h: [], a: [], b: [] };
    h.onPeerOpen = (id) => opened.push(id);
    h.onPeerClose = (id) => closed.push(id);
    h.onMessage = (from, d) => got.h.push(from + ':' + d);
    a.onMessage = (_f, d) => got.a.push(d);
    b.onMessage = (_f, d) => got.b.push(d);
    await h.open('host', 'room1');
    await Promise.all([a.open('guest', 'room1'), b.open('guest', 'room1')]);
    expect(opened.sort()).toEqual([a.id, b.id].sort());
    for (let i = 0; i < 50; i++) { a.send(null, 'a' + i); b.send(null, 'b' + i); h.send(null, 'h' + i); h.send(a.id, 'only-a' + i); }
    await hub.flush();
    const seq = (list: string[], prefix: string) => list.filter((m) => m.startsWith(prefix)).map((m) => +m.slice(prefix.length));
    const inOrder = Array.from({ length: 50 }, (_, i) => i);
    expect(seq(got.h, a.id + ':a')).toEqual(inOrder);
    expect(seq(got.h, b.id + ':b')).toEqual(inOrder);
    expect(seq(got.a, 'h')).toEqual(inOrder);
    expect(seq(got.a, 'only-a')).toEqual(inOrder);
    expect(seq(got.b, 'h')).toEqual(inOrder);
    expect(got.b.some((m) => m.startsWith('only-a'))).toBe(false);
    // the shuffle really interleaves the two senders differently from send order
    expect(got.h.map((m) => m.split(':')[1])).not.toEqual(Array.from({ length: 100 }, (_, i) => (i % 2 ? 'b' : 'a') + (i >> 1)));

    let aLost = '';
    a.onPeerClose = (id) => { aLost = id; };
    b.close();
    await hub.flush();
    expect(closed).toEqual([b.id]);
    h.close();
    await hub.flush();
    expect(aLost).toBe(h.id);
    await expect(hub.transport().open('guest', 'room1')).rejects.toThrow(/No session found/);
  });

  it('refuses a second host for the same room, and delivers with a delay when asked', async () => {
    const hub = new MemoryHub({ delay: 3 });
    const h = hub.transport();
    await h.open('host', 'r');
    await expect(hub.transport().open('host', 'r')).rejects.toThrow(/already in use/);
    const g = hub.transport();
    const got: string[] = [];
    g.onMessage = (_f, d) => got.push(d);
    await g.open('guest', 'r');
    h.send(null, 'x');
    expect(got).toEqual([]);
    await hub.flush();
    expect(got).toEqual(['x']);
  });

  it('room ids are short, URL-safe and do not repeat', () => {
    const ids = new Set(Array.from({ length: 500 }, newRoomId));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(id).toMatch(/^[a-z2-9]{10}$/);
  });
});

// ---------------------------------------------------------------- session

describe('collab session: joining and editing', () => {
  it('guests receive the host font, a colour and the roster', async () => {
    const hub = new MemoryHub();
    const project = generated('Shared');
    project.previewText = 'host text';
    project.notes.push(note('n0'));
    project.kerning.pairs['AV'] = -60;
    const { host, guests: [a, b] } = await room(hub, 2, project);
    for (const g of [a, b]) {
      expect(g.inits).toBe(1);
      expect(g.project).toEqual(parseProject(JSON.parse(serializeProject(host.project))));
      expect(plain(snapshotOf(g.project))).toEqual(plain(snapshotOf(host.project)));
      expect(g.project).not.toBe(host.project);
      expect(g.status.map((s) => s[0])).toEqual(['connecting', 'open']);
      expect(g.session.role).toBe('guest');
    }
    expect(host.status.map((s) => s[0])).toEqual(['connecting', 'open']);
    expect(host.session.role).toBe('host');
    for (const c of [host, a, b]) {
      expect(c.peers.map((p) => p.name)).toEqual(['Hana', 'Ana', 'Ben']);
      expect(c.peers.map((p) => p.host)).toEqual([true, false, false]);
      expect(c.peers.every((p) => p.canEdit)).toBe(true);
      expect(c.session.peers()).toEqual(c.peers);
      expect(c.session.guestsCanEdit).toBe(true);
    }
    expect(new Set(host.peers.map((p) => p.color)).size).toBe(3);
    expect(a.session.me).toMatchObject({ name: 'Ana', host: false, canEdit: true, color: host.peers[1].color, id: host.peers[1].id });
    expect(a.session.me.id).not.toBe(b.session.me.id);
  });

  it('an edit by any party reaches the other two', async () => {
    const hub = new MemoryHub();
    const { host, guests: [a, b], all } = await room(hub, 2);
    const same = () => { const s = plain(snapshotOf(host.project)); for (const c of all) expect(plain(snapshotOf(c.project))).toEqual(s); };

    host.edit((p) => { p.glyphs['a'].advance = 611; });
    await settle(hub);
    expect(a.project.glyphs['a'].advance).toBe(611);
    expect(b.project.glyphs['a'].advance).toBe(611);
    expect(a.remote.at(-1)!.from).toMatchObject({ name: 'Hana', host: true });

    a.edit((p) => { p.glyphs['b'].strokes![0].points.push({ x: 1, y: 2, w: 3 }); p.fx.seed = 77; });
    await settle(hub);
    expect(host.project.glyphs['b'].strokes![0].points).toHaveLength(5);
    expect(b.project.fx.seed).toBe(77);
    expect(host.remote.at(-1)!.from).toMatchObject({ name: 'Ana', host: false });
    expect(b.remote.at(-1)!.from).toMatchObject({ name: 'Ana' });

    b.edit((p) => { delete p.glyphs['c']; p.notes.push(note('nb', 'a', 'from Ben')); p.glyphs['d'] = strokeGlyph('d'); });
    await settle(hub);
    expect(host.project.glyphs['c']).toBeUndefined();
    expect(a.project.glyphs['c']).toBeUndefined();
    expect(a.project.glyphs['d']).toEqual(strokeGlyph('d'));
    expect(host.project.notes.map((n) => n.text)).toEqual(['from Ben']);
    same();
    // nobody was handed their own change, nothing bounced back
    expect(a.remote.every((r) => r.from !== null)).toBe(true);
    for (const c of all) expect(diffProject(c.snap, c.project).ops).toEqual([]);
    expect(all.every((c) => c.rejectedLocally.length === 0)).toBe(true);
  });

  it('previewText stays personal', async () => {
    const hub = new MemoryHub();
    const { host, guests: [a] } = await room(hub, 1);
    a.project.previewText = 'guest text';
    expect(a.edit((p) => { p.previewText = 'guest text 2'; })).toEqual([]);
    await settle(hub);
    expect(host.project.previewText).not.toBe('guest text 2');
    expect(host.remote).toEqual([]);
  });

  it('a 1.5 MB font joins through chunking, in messages under 48 KB', async () => {
    const hub = new MemoryHub();
    const project = newProject('Big');
    for (let i = 0; serializeProject(project).length < 1_500_000; i++) {
      for (let j = 0; j < 20; j++) { const ch = String.fromCodePoint(0x4e00 + i * 20 + j); project.glyphs[ch] = strokeGlyph(ch, 500, 300); }
    }
    const id = newRoomId();
    const host = new Client(project);
    const ht = hub.transport();
    let biggest = 0, count = 0;
    const send = ht.send.bind(ht);
    ht.send = (to, data) => { biggest = Math.max(biggest, bytes(data)); count++; send(to, data); };
    host.session = await Session.host(ht, id, { name: 'H' }, () => host.project, host.events());
    const g = new Client();
    g.session = await Session.join(hub.transport(), id, { name: 'G' }, g.events());
    await settle(hub);
    expect(count).toBeGreaterThan(30);
    expect(biggest).toBeLessThanOrEqual(CHUNK_MAX);
    expect(Object.keys(g.project.glyphs)).toHaveLength(Object.keys(project.glyphs).length);
    expect(plain(snapshotOf(g.project))).toEqual(plain(snapshotOf(project)));
    // and big edits travel back the same way
    g.edit((p) => { for (const ch of Object.keys(p.glyphs)) p.glyphs[ch].advance = 444; });
    await settle(hub);
    expect(Object.values(host.project.glyphs).every((gl) => gl.advance === 444)).toBe(true);
    expect(host.remote.length).toBeGreaterThanOrEqual(3);   // 1.5 MB of changes went out as several batches
    expect(host.remote.reduce((n, r) => n + r.ops.length, 0)).toBe(Object.keys(project.glyphs).length);
    expect(biggest).toBeLessThanOrEqual(CHUNK_MAX);
    // one value too large to share is handed back instead of being sent
    const huge = strokeGlyph('huge', 500, 150_000);
    expect(g.session.sendOps([{ k: 'glyph', ch: 'huge', v: huge }, { k: 'set', key: 'name', v: 'small enough' }]).map(opKey)).toEqual(['glyph:huge']);
    expect(host.session.sendOps([{ k: 'glyph', ch: 'huge', v: huge }]).map(opKey)).toEqual(['glyph:huge']);
    await settle(hub);
    expect(host.project.name).toBe('small enough');
    expect(host.project.glyphs['huge']).toBeUndefined();
  });

  it('joining a room that does not exist fails with a readable error', async () => {
    const hub = new MemoryHub();
    const g = new Client();
    await expect(Session.join(hub.transport(), 'nobodyhere', { name: 'G' }, g.events())).rejects.toThrow(/No session found/);
    expect(g.status.map((s) => s[0])).toEqual(['connecting', 'error']);
    expect(g.status[1][1]).toMatch(/No session found/);
  });
});

describe('collab session: convergence', () => {
  it('two guests and the host writing the same value at once end up with the host order', async () => {
    const hub = new MemoryHub();
    const { host, guests: [a, b], all } = await room(hub, 2);
    hub.auto = false;
    a.edit((p) => { p.name = 'from A'; });
    b.edit((p) => { p.name = 'from B'; });
    host.edit((p) => { p.name = 'from H'; });
    // host order: H (sent at once), then whichever guest op the host receives first
    hub.resume();
    await settle(hub);
    const last = JSON.parse(host.order.at(-1)!).v;
    expect(['from A', 'from B']).toContain(last);
    for (const c of all) expect(c.project.name).toBe(last);
  });

  it('a guest that sends from inside its remote handler still converges (echo is applied again)', async () => {
    const hub = new MemoryHub();
    const { host, guests: [a, b] } = await room(hub, 2);
    hub.auto = false;
    b.edit((p) => { p.name = 'X'; });
    while (hub.step()) { /* X reaches host and both guests */ }
    expect(a.project.name).toBe('X');
    b.edit((p) => { p.name = 'Y'; });
    hub.step();                       // b → host: Y is sequenced
    a.project.name = 'L';             // a has an unsent local change…
    while (hub.step()) { /* …when Y arrives: a's handler flushes L, then applies Y on top of it */ }
    await settle(hub);
    expect(host.project.name).toBe('L');
    expect(b.project.name).toBe('L');
    expect(a.project.name).toBe('L');
  });

  it('while my own change is in flight I am not shown older values of the same thing', async () => {
    const hub = new MemoryHub();
    const { host, guests: [a, b], all } = await room(hub, 2);
    hub.auto = false;
    b.edit((p) => { p.name = 'B1'; p.fx.seed = 5; });
    hub.step();                                  // host sequences B1 and relays it
    a.edit((p) => { p.name = 'A1'; });           // a writes before B1 reaches it
    while (hub.step()) expect(a.project.name).toBe('A1');   // never flickers to B1
    await settle(hub);
    for (const c of all) expect(c.project.name).toBe('A1');
    expect(a.project.fx.seed).toBe(5);           // the part of b's change that did not clash arrived
    expect(a.remote.flatMap((r) => r.ops.map(opKey))).toEqual(['set:fx']);
    expect(host.order.map((j) => JSON.parse(j).v).filter((v) => typeof v === 'string')).toEqual(['B1', 'A1']);
  });

  it('a refusal does not undo a later change of mine that is still in flight', async () => {
    const hub = new MemoryHub();
    const { host, guests: [a, b], all } = await room(hub, 2);
    hub.auto = false;
    a.edit((p) => { p.name = 'n1'; });           // on its way…
    host.session.setGuestsCanEdit(false);        // …when the host switches to view-only
    hub.step();                                  // host refuses n1
    expect(host.project.name).toBe('Small');
    host.session.setGuestsCanEdit(true);
    a.edit((p) => { p.name = 'n2'; });           // a has heard none of this yet
    while (hub.step()) expect(a.project.name).toBe('n2');
    await settle(hub);
    for (const c of all) expect(c.project.name).toBe('n2');
    expect(a.remote).toEqual([]);                // the fix for n1 was counted, not shown
    expect(b.remote.flatMap((r) => r.ops.map((o) => o.v))).toEqual(['n2']);
  });

  async function randomRun(seed: number, withLocks: boolean, flushInHandler: boolean) {
    const rng = makeRng(seed * 7919 + (withLocks ? 13 : 0));
    const pick = <T>(list: readonly T[]): T => list[Math.floor(rng() * list.length)];
    const hub = new MemoryHub({ shuffle: true, seed });
    const { host, all } = await room(hub, 2);
    const initial = clone(host.project);
    for (const c of all) c.flushInHandler = flushInHandler;
    hub.auto = false;
    let n = 0;
    const letters = ['a', 'b', 'c'];
    for (let step = 0; step < 70; step++) {
      const c = pick(all);
      const p = c.project;
      const ch = pick(letters);
      switch (Math.floor(rng() * 9)) {
        case 0: case 1: if (p.glyphs[ch]) p.glyphs[ch].advance = Math.floor(rng() * 900); else p.glyphs[ch] = strokeGlyph(ch, Math.floor(rng() * 900)); break;
        case 2: if (p.glyphs[ch]) p.glyphs[ch].strokes![0].points.push({ x: Math.floor(rng() * 500), y: 3, w: 20 }); break;
        case 3: delete p.glyphs[ch]; break;
        case 4: p.name = 'name ' + Math.floor(rng() * 1000); break;
        case 5: p.fx.seed = Math.floor(rng() * 1000); p.kerning.pairs['AV'] = Math.floor(rng() * 200) - 100; break;
        case 6: p.notes.push({ id: `n${seed}-${++n}`, ch, x: 1, y: 2, text: 't' + n, createdAt: n }); break;
        case 7: if (p.notes.length) { const note = pick(p.notes); if (rng() < 0.5) note.done = !note.done; else p.notes = p.notes.filter((x) => x !== note); } break;
        default: if (rng() < 0.5) p.alternates[ch] = [strokeGlyph(ch, Math.floor(rng() * 900))]; else delete p.alternates[ch]; break;
      }
      if (rng() < 0.75) c.flush();   // sometimes the change waits (the app debounces)
      if (withLocks) {
        if (rng() < 0.25) pick(all).session.setPresence({ ch: rng() < 0.3 ? null : pick(letters) });
        if (rng() < 0.06) host.session.setGuestsCanEdit(!host.session.guestsCanEdit);
      }
      for (let k = Math.floor(rng() * 5); k > 0; k--) hub.step();
      if (rng() < 0.3) await Promise.resolve();
    }
    for (const c of all) c.flush();
    hub.resume();
    await settle(hub);
    for (const c of all) c.flush();
    await settle(hub);

    const want = plain(snapshotOf(host.project));
    for (const c of all) expect(plain(snapshotOf(c.project)), `seed ${seed} ${c.session.me.name}`).toEqual(want);
    // …and that state is exactly the host's sequence of ops applied to the starting font
    const replay = clone(initial);
    for (const json of host.order) expect(applyOp(replay, JSON.parse(json))).toBe(true);
    expect(plain(snapshotOf(replay)), `seed ${seed} replay`).toEqual(want);
    for (const c of all) expect(diffProject(c.snap, c.project).ops, `seed ${seed} leftovers`).toEqual([]);
    return { ops: host.order.length, rejected: all.reduce((s, c) => s + c.rejectedLocally.length, 0), fixes: all.reduce((s, c) => s + c.remote.filter((r) => r.from === null).length, 0) };
  }

  it('three-way concurrent writes converge under shuffled delivery (app-style handler)', async () => {
    let ops = 0;
    for (let seed = 1; seed <= SEEDS; seed++) ops += (await randomRun(seed, false, true)).ops;
    expect(ops).toBeGreaterThan(SEEDS * 20);
  }, 600000);

  it('three-way concurrent writes converge under shuffled delivery (snapshot-per-key handler)', async () => {
    for (let seed = 1; seed <= SEEDS; seed++) await randomRun(seed, false, false);
  }, 600000);

  it('still converges with letters being held and view-only toggling (rejections and fixes in the mix)', async () => {
    let rejected = 0, fixes = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = await randomRun(seed, true, seed % 2 === 0);
      rejected += r.rejected; fixes += r.fixes;
    }
    expect(rejected).toBeGreaterThan(50);
    expect(fixes).toBeGreaterThan(5);
  }, 600000);
});

describe('collab session: permissions and letters', () => {
  it('view-only guests cannot change the font but can leave notes', async () => {
    const hub = new MemoryHub();
    const { host, guests: [a, b] } = await room(hub, 2);
    host.session.setGuestsCanEdit(false);
    await settle(hub);
    expect(a.session.guestsCanEdit).toBe(false);
    expect(a.session.me.canEdit).toBe(false);
    expect(a.peers.map((p) => p.canEdit)).toEqual([true, false, false]);
    expect(host.peers.map((p) => p.canEdit)).toEqual([true, false, false]);
    expect(a.session.canEditLetter('a')).toBe(false);
    expect(host.session.canEditLetter('a')).toBe(true);

    const hostRemote = host.remote.length, bRemote = b.remote.length;
    const rejected = a.edit((p) => { p.glyphs['a'].advance = 999; p.name = 'nope'; p.notes.push(note('n1', 'a', 'please fix')); });
    expect(rejected.map(opKey).sort()).toEqual(['glyph:a', 'set:name']);
    expect(a.project.glyphs['a'].advance).toBe(500);   // the stand-in app undid it
    await settle(hub);
    expect(host.project.glyphs['a'].advance).toBe(500);
    expect(host.project.name).toBe('Small');
    expect(host.project.notes.map((n) => n.id)).toEqual(['n1']);
    expect(b.project.notes.map((n) => n.id)).toEqual(['n1']);
    expect(host.remote.slice(hostRemote).flatMap((r) => r.ops.map(opKey))).toEqual(['note:n1']);
    expect(b.remote.slice(bRemote).flatMap((r) => r.ops.map(opKey))).toEqual(['note:n1']);

    // resolving a note works too; the host can still edit
    b.edit((p) => { p.notes[0].done = true; });
    host.edit((p) => { p.glyphs['a'].advance = 501; });
    await settle(hub);
    expect(a.project.notes[0].done).toBe(true);
    expect(a.project.glyphs['a'].advance).toBe(501);

    host.session.setGuestsCanEdit(true);
    await settle(hub);
    expect(a.session.canEditLetter('a')).toBe(true);
    expect(a.edit((p) => { p.glyphs['a'].advance = 502; })).toEqual([]);
    await settle(hub);
    expect(host.project.glyphs['a'].advance).toBe(502);
    // guests cannot flip the switch
    a.session.setGuestsCanEdit(false);
    await settle(hub);
    expect(host.session.guestsCanEdit).toBe(true);
  });

  it('a guest that ignores view-only is refused by the host and put right', async () => {
    const hub = new MemoryHub();
    const { host, guests: [a, b] } = await room(hub, 2);
    hub.auto = false;
    host.session.setGuestsCanEdit(false);
    // a has not heard yet: it still thinks it may edit
    expect(a.edit((p) => { p.glyphs['a'].advance = 999; })).toEqual([]);
    expect(a.project.glyphs['a'].advance).toBe(999);
    hub.resume();
    await settle(hub);
    expect(host.project.glyphs['a'].advance).toBe(500);
    expect(b.project.glyphs['a'].advance).toBe(500);
    expect(a.project.glyphs['a'].advance).toBe(500);
    expect(a.remote.at(-1)).toMatchObject({ from: null, ops: [{ k: 'glyph', ch: 'a' }] });
    expect(host.remote).toEqual([]);
  });

  it('the first to open a letter holds it; the next in line takes over', async () => {
    const hub = new MemoryHub();
    const { host, guests: [a, b] } = await room(hub, 2);
    a.session.setPresence({ ch: 'a' });
    await settle(hub);
    b.session.setPresence({ ch: 'a' });
    expect(b.session.canEditLetter('a')).toBe(false);   // known at once, before the host confirms
    await settle(hub);
    for (const c of [host, a, b]) {
      expect(c.session.holder('a')).toMatchObject({ name: 'Ana' });
      expect(c.peers.map((p) => p.ch)).toEqual([null, 'a', 'a']);
      expect(c.session.holder('b')).toBeNull();
    }
    expect(a.session.canEditLetter('a')).toBe(true);
    expect(b.session.canEditLetter('a')).toBe(false);
    expect(host.session.canEditLetter('a')).toBe(false);
    expect(b.session.canEditLetter('b')).toBe(true);

    // b tries anyway: refused locally; the host and everyone else never see it
    expect(b.edit((p) => { p.glyphs['a'].advance = 1; }).map(opKey)).toEqual(['glyph:a']);
    expect(host.edit((p) => { p.glyphs['a'].advance = 2; }).map(opKey)).toEqual(['glyph:a']);
    // a client that sends regardless is refused by the host, with a fix carrying the standing value
    const sneaky = { t: 'ops', ops: [{ k: 'glyph', ch: 'a', v: strokeGlyph('a', 1) }, { k: 'alt', ch: 'a', v: [strokeGlyph('a', 1)] }, { k: 'glyph', ch: 'b', v: strokeGlyph('b', 321) }] };
    (b.session as unknown as { transport: Transport }).transport.send(null, JSON.stringify(sneaky));
    await settle(hub);
    expect(host.project.glyphs['a'].advance).toBe(500);
    expect(host.project.alternates['a']).toBeUndefined();
    expect(host.project.glyphs['b'].advance).toBe(321);   // the free letter went through
    expect(a.project.glyphs['b'].advance).toBe(321);
    expect(b.remote.at(-1)).toEqual({ from: null, ops: [{ k: 'glyph', ch: 'a', v: host.project.glyphs['a'] }, { k: 'alt', ch: 'a', v: null }] });
    // the holder edits freely
    expect(a.edit((p) => { p.glyphs['a'].advance = 640; })).toEqual([]);
    await settle(hub);
    expect(b.project.glyphs['a'].advance).toBe(640);

    // a moves on → b, who was waiting, holds it now
    a.session.setPresence({ ch: 'b' });
    await settle(hub);
    for (const c of [host, a, b]) expect(c.session.holder('a')).toMatchObject({ name: 'Ben' });
    expect(b.session.canEditLetter('a')).toBe(true);
    expect(b.edit((p) => { p.glyphs['a'].advance = 700; })).toEqual([]);
    await settle(hub);
    expect(host.project.glyphs['a'].advance).toBe(700);
    expect(a.project.glyphs['a'].advance).toBe(700);

    // the host queues up behind b; when b leaves the session the host takes over
    host.session.setPresence({ ch: 'a' });
    await settle(hub);
    expect(a.session.holder('a')).toMatchObject({ name: 'Ben' });
    b.session.leave();
    await settle(hub);
    expect(a.session.holder('a')).toMatchObject({ name: 'Hana' });
    expect(host.session.canEditLetter('a')).toBe(true);
    // coming back to a letter puts you at the end of the line
    a.session.setPresence({ ch: 'a' });
    await settle(hub);
    expect(a.session.holder('a')).toMatchObject({ name: 'Hana' });
    expect(a.session.canEditLetter('a')).toBe(false);
  });

  it('cursor positions reach the others without a roster round, throttled', async () => {
    const hub = new MemoryHub();
    const { host, guests: [a, b] } = await room(hub, 2);
    a.session.setPresence({ ch: 'a' });
    await settle(hub);
    const ht = (host.session as unknown as { transport: Transport }).transport;
    const sent: string[] = [];
    const send = ht.send.bind(ht);
    ht.send = (to, data) => { sent.push(data); send(to, data); };
    for (let i = 0; i < 40; i++) a.session.setPresence({ cursor: [i, i * 2] });
    expect(a.session.me.cursor).toEqual([39, 78]);
    await settle(hub);
    await tick(120);
    await settle(hub);
    const cursorOf = (c: Client, name: string) => c.peers.find((p) => p.name === name)!.cursor;
    expect(cursorOf(host, 'Ana')).toEqual([39, 78]);
    expect(cursorOf(b, 'Ana')).toEqual([39, 78]);
    expect(a.session.peers().find((p) => p.name === 'Ana')!.cursor).toEqual([39, 78]);
    expect(sent.length).toBeLessThanOrEqual(3);                   // first + last (a third only if a timer slipped), not 40
    expect(sent.every((m) => m.startsWith('{"t":"cur"') && m.length < 100)).toBe(true);
    // host cursor goes out too; changing letter clears the cursor; null is "pointer left"
    host.session.setPresence({ cursor: [5, 6] });
    await tick(100);
    await settle(hub);
    expect(cursorOf(a, 'Hana')).toEqual([5, 6]);
    a.session.setPresence({ ch: 'b' });
    await settle(hub);
    expect(cursorOf(b, 'Ana')).toBeNull();
    host.session.setPresence({ cursor: null });
    await tick(100);
    await settle(hub);
    expect(cursorOf(b, 'Hana')).toBeNull();
    // nonsense is ignored
    a.session.setPresence({ cursor: [NaN, 1] as [number, number] });
    a.session.setPresence({ ch: 5 as unknown as string });
    expect(a.session.me.ch).toBe('b');
  });
});

describe('collab session: what the host has not sent yet', () => {
  it('a newcomer and a refused guest get the sequenced font, not the host\'s unsent changes', async () => {
    const hub = new MemoryHub();
    const { id, host, guests: [a] } = await room(hub, 1);
    host.session.setGuestsCanEdit(false);
    await settle(hub);
    // the host is mid-change (the app sends a beat later)…
    host.project.glyphs['a'].advance = 777;
    host.project.name = 'half typed';
    // …while a client that ignores view-only sends, and somebody joins
    (a.session as unknown as { transport: Transport }).transport.send(null, JSON.stringify({ t: 'ops', ops: [{ k: 'glyph', ch: 'a', v: strokeGlyph('a', 1) }] }));
    const b = new Client();
    b.session = await Session.join(hub.transport(), id, { name: 'Ben' }, b.events());
    await settle(hub);
    expect(a.project.glyphs['a'].advance).toBe(500);
    expect(b.project.glyphs['a'].advance).toBe(500);
    expect(b.project.name).toBe('Small');
    // …then the host takes its change back (undo) and never sends it: nobody is left with it
    host.project.glyphs['a'].advance = 500;
    host.project.name = 'Small';
    expect(host.flush()).toEqual([]);
    await settle(hub);
    for (const c of [a, b]) expect(plain(snapshotOf(c.project))).toEqual(plain(snapshotOf(host.project)));
    // had the host sent it instead, everyone gets it the normal way
    host.edit((p) => { p.name = 'typed'; });
    await settle(hub);
    expect(a.project.name).toBe('typed');
    expect(b.project.name).toBe('typed');
  });

  it('the last change to a letter still goes through just after its holder moved on', async () => {
    const hub = new MemoryHub();
    const { host, guests: [a, b] } = await room(hub, 2);
    a.session.setPresence({ ch: 'a' });
    await settle(hub);
    b.session.setPresence({ ch: 'a' });
    await settle(hub);
    a.project.glyphs['a'].advance = 612;    // edited, not sent yet
    a.session.setPresence({ ch: 'b' });      // …and already on the next letter: b holds 'a' now
    expect(a.session.holder('a')).toMatchObject({ name: 'Ben' });
    expect(a.flush()).toEqual([]);
    await settle(hub);
    expect(host.session.holder('a')).toMatchObject({ name: 'Ben' });
    expect(host.project.glyphs['a'].advance).toBe(612);
    expect(b.project.glyphs['a'].advance).toBe(612);
    // someone who was only waiting gets no such grace
    host.session.setPresence({ ch: 'a' });
    host.session.setPresence({ ch: 'c' });
    expect(host.edit((p) => { p.glyphs['a'].advance = 1; }).map(opKey)).toEqual(['glyph:a']);
    // and the grace is short
    await tick(1100);
    expect(a.edit((p) => { p.glyphs['a'].advance = 2; }).map(opKey)).toEqual(['glyph:a']);
    await settle(hub);
    expect(b.project.glyphs['a'].advance).toBe(612);
  });
});

describe('collab session: coming and going', () => {
  it('a guest leaving shrinks the roster; leave is idempotent', async () => {
    const hub = new MemoryHub();
    const { host, guests: [a, b] } = await room(hub, 2);
    b.session.leave();
    b.session.leave();
    await settle(hub);
    expect(host.peers.map((p) => p.name)).toEqual(['Hana', 'Ana']);
    expect(a.peers.map((p) => p.name)).toEqual(['Hana', 'Ana']);
    expect(b.status.map((s) => s[0])).toEqual(['connecting', 'open']);   // b knows it left: no event
    // after leaving nothing is sent or reported any more
    expect(b.session.sendOps([{ k: 'set', key: 'name', v: 'ghost' }])).toEqual([]);
    b.session.setPresence({ ch: 'a' });
    host.edit((p) => { p.name = 'after'; });
    await settle(hub);
    expect(a.project.name).toBe('after');
    expect(b.project.name).toBe('Small');
    // a guest whose connection just drops is removed as well
    (a.session as unknown as { transport: Transport }).transport.close();
    await settle(hub);
    expect(host.peers.map((p) => p.name)).toEqual(['Hana']);
  });

  it('the host leaving (or vanishing) closes the session for the guests', async () => {
    for (const how of ['leave', 'vanish'] as const) {
      const hub = new MemoryHub();
      const { host, guests: [a, b] } = await room(hub, 2);
      if (how === 'leave') { host.session.leave(); host.session.leave(); }
      else (host.session as unknown as { transport: Transport }).transport.close();
      await settle(hub);
      for (const g of [a, b]) {
        // a goodbye means it is over; a silent drop is worth a rejoin attempt
        expect(g.status.at(-1)).toEqual(['closed', how === 'leave' ? 'The host ended the session' : 'Lost the connection to the host']);
        expect(g.status.filter((s) => s[0] === 'closed')).toHaveLength(1);
        expect(g.session.sendOps([{ k: 'set', key: 'name', v: 'x' }])).toEqual([]);
      }
    }
  });

  it('the 13th guest is refused politely; a freed place can be taken', async () => {
    const hub = new MemoryHub();
    const { id, host, guests } = await room(hub, MAX_GUESTS, small(), Array.from({ length: MAX_GUESTS }, (_, i) => 'Guest ' + (i + 1)));
    expect(host.peers).toHaveLength(MAX_GUESTS + 1);
    // 8 distinct colours, then they repeat evenly
    const counts = new Map<string, number>();
    for (const p of host.peers) counts.set(p.color, (counts.get(p.color) ?? 0) + 1);
    expect(counts.size).toBe(PEER_COLORS.length);
    expect(Math.max(...counts.values())).toBe(2);
    expect(new Set(host.peers.slice(0, 8).map((p) => p.color)).size).toBe(8);

    const late = new Client();
    await expect(Session.join(hub.transport(), id, { name: 'Late' }, late.events())).rejects.toThrow(/full/);
    expect(late.status.at(-1)![0]).toBe('error');
    expect(late.inits).toBe(0);
    await settle(hub);
    expect(host.peers).toHaveLength(MAX_GUESTS + 1);
    guests[3].session.leave();
    await settle(hub);
    late.session = await Session.join(hub.transport(), id, { name: 'Late' }, late.events());
    await settle(hub);
    expect(host.peers.map((p) => p.name)).toContain('Late');
    expect(late.project.glyphs['a']).toBeDefined();
  });

  it('names are cleaned up and cut to 40 characters', async () => {
    const hub = new MemoryHub();
    const { host } = await room(hub, 2, small(), ['  ' + 'x'.repeat(80) + '\n', '\u0000\u0007']);
    expect(host.peers[1].name).toBe('x'.repeat(40));
    expect(host.peers[2].name).toBe('Guest');
  });

  it('values the host has to normalise come back corrected to the sender', async () => {
    const hub = new MemoryHub();
    const { host, guests: [a, b], all } = await room(hub, 2);
    a.edit((p) => { p.kerning.pairs['AV'] = -80.4; });
    await settle(hub);
    for (const c of all) expect(c.project.kerning.pairs).toEqual({ AV: -80 });
    expect(a.remote.at(-1)!.from).toBeNull();
    // the host's own unnormalised values are corrected at the source too
    host.edit((p) => { p.kerning.pairs['To'] = 12.7; });
    await settle(hub);
    for (const c of all) expect(c.project.kerning.pairs).toEqual({ AV: -80, To: 13 });
    expect(b.remote.at(-1)!.from).toMatchObject({ host: true });
    for (const c of all) { c.flush(); }
    await settle(hub);
    for (const c of all) expect(plain(snapshotOf(c.project))).toEqual(plain(snapshotOf(host.project)));
  });
});

describe('collab session: hostile input', () => {
  it('the host ignores garbage, strangers and oversized messages, and keeps working', async () => {
    const hub = new MemoryHub();
    const { id, host, guests: [a] } = await room(hub, 1);
    const before = JSON.stringify(host.project);
    const stranger = hub.transport();
    await stranger.open('guest', id);
    const glyph = strokeGlyph('a', 1);
    const junk: string[] = [
      '', 'null', '[]', '{', '"hello"', '{"t":5}', '{"t":"ops"}', '{"t":"ops","ops":"all"}',
      JSON.stringify({ t: 'ops', ops: [{ k: 'glyph', ch: 'a', v: glyph }] }),      // not joined: ignored
      JSON.stringify({ t: 'pres', ch: 'a' }),
      JSON.stringify({ t: 'bye' }),
      '{"c":"x","i":0,"n":3,"d":"{\\"t\\":\\"hello\\""}',                           // strangers may not chunk
      JSON.stringify({ t: 'hello', name: 'x'.repeat(5000) }),                       // too long for a stranger
    ];
    for (const j of junk) stranger.send(null, j);
    await settle(hub);
    expect(host.peers).toHaveLength(2);
    expect(JSON.stringify(host.project)).toBe(before);

    // now from someone who is in: malformed ops are dropped one by one, good ones in the same batch still count
    const at = (a.session as unknown as { transport: Transport }).transport;
    const inside: unknown[] = [
      { t: 'ops', ops: [null, 5, { k: 'glyph' }, { k: 'glyph', ch: 'a', v: { char: 'a' } }, { k: 'set', key: 'name', v: { toString: 1 } }, { k: 'set', key: '__proto__', v: {} }, { k: 'glyph', ch: '__proto__', v: glyph }] },
      { t: 'ops', ops: [{ k: 'set', key: 'name', v: 'ok' }, { k: 'note', id: 'n', v: { id: 'n' } }] },
      { t: 'pres', ch: { no: 1 } }, { t: 'pres', ch: 'x'.repeat(500) }, { t: 'cur', c: [1, 'two'] }, { t: 'cur', c: 'here' },
      { t: 'hello', name: 'again' }, { t: 'init', project: '{}' }, { t: 'roster', peers: [] }, { t: 'end' }, { t: 'unknown' },
    ];
    for (const m of inside) at.send(null, JSON.stringify(m));
    at.send(null, '{"c":"big","i":0,"n":1000000,"d":"' + 'x'.repeat(1000) + '"}');
    at.send(null, 'x'.repeat(9 * 1024 * 1024));
    await settle(hub);
    expect(host.project.name).toBe('ok');
    expect({ ...host.project, name: 'Small' }).toEqual(JSON.parse(before));
    expect(Object.getPrototypeOf(host.project.glyphs)).toBe(Object.prototype);
    expect(host.peers.map((p) => [p.name, p.ch, p.cursor])).toEqual([['Hana', null, null], ['Ana', null, null]]);
    // the sender was told what stands for everything refused that had a key
    expect(a.project.name).toBe('Small');   // (the raw sends bypassed a's own bookkeeping)
    host.edit((p) => { p.name = 'still alive'; });
    await settle(hub);
    expect(a.project.name).toBe('still alive');
    expect(host.status.map((s) => s[0])).toEqual(['connecting', 'open']);
  });

  it('a guest survives a misbehaving host', async () => {
    const hub = new MemoryHub();
    const fake = hub.transport();
    await fake.open('host', 'evilroom');
    let guestId = '';
    fake.onMessage = (from) => { guestId = from; };
    const g = new Client();
    const joining = Session.join(hub.transport(), 'evilroom', { name: 'G' }, g.events());
    await settle(hub);
    expect(guestId).not.toBe('');
    const failed = joining.then(() => null, (e: Error) => e);
    for (const junk of ['', '{', 'null', '{"t":"ops","ops":[{"k":"set","key":"name","v":"too early"}]}', '{"t":"init"}']) fake.send(guestId, junk);
    await settle(hub);
    // a broken init fails the join cleanly
    expect((await failed)?.message).toMatch(/cannot work with/);
    expect(g.status.map((s) => s[0])).toEqual(['connecting', 'error']);
    expect(g.inits).toBe(0);

    const g2 = new Client();
    const joining2 = Session.join(hub.transport(), 'evilroom', { name: 'G' }, g2.events());
    await settle(hub);
    const raw = serializeProject(small('Evil')).replace('"glyphs":{', '"glyphs":{"__proto__":{"polluted":true},"bad":{"char":"x"},');
    const peers = [{ id: fake.id, name: 'H', color: 'javascript:alert(1)', host: true, ch: null, st: 0, cur: null }, { id: guestId, name: 'G', color: '#123456', host: false, ch: null, st: 0, cur: null }, null, 7, { id: 5 }];
    fake.send(guestId, JSON.stringify({ t: 'init', you: guestId, seq: 0, gce: true, peers }).slice(0, -1) + ',"project":' + raw + '}');
    g2.session = await joining2;
    await settle(hub);
    expect(g2.project.name).toBe('Evil');
    expect(Object.keys(g2.project.glyphs).sort()).toEqual(['a', 'b', 'c']);
    expect(Object.getPrototypeOf(g2.project.glyphs)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(g2.peers.map((p) => p.color)).toEqual([PEER_COLORS[0], '#123456']);
    const before = JSON.stringify(g2.project);
    const junk: unknown[] = [
      { t: 'ops', seq: 1, from: fake.id, ops: [{ k: 'glyph', ch: 'a', v: { char: 'a' } }, null, { k: 'set', key: 'previewText', v: 'x' }, { k: 'set', key: 'fx', v: 3 }] },
      { t: 'ops', ops: 'x' }, { t: 'fix', ops: [{ k: 'glyph', ch: 'a', v: 3 }] }, { t: 'fix' }, { t: 'roster', peers: 'everyone' }, { t: 'roster', peers: Array.from({ length: 500 }, (_, i) => ({ id: 'p' + i })) },
      { t: 'cur', id: 'nobody', c: [1, 2] }, { t: 'cur', id: fake.id, c: 'x' }, { t: 'no', reason: 'late' }, { t: 'hello' }, { t: 'bye' }, { t: 42 },
    ];
    for (const m of junk) fake.send(guestId, JSON.stringify(m));
    fake.send(guestId, 'x'.repeat(9 * 1024 * 1024));
    await settle(hub);
    expect(JSON.stringify(g2.project)).toBe(before);
    expect(g2.status.at(-1)![0]).toBe('open');
    // valid traffic still works
    fake.send(guestId, JSON.stringify({ t: 'ops', seq: 2, from: fake.id, ops: [{ k: 'set', key: 'name', v: 'fine' }] }));
    await settle(hub);
    expect(g2.project.name).toBe('fine');
    fake.send(guestId, JSON.stringify({ t: 'end' }));
    await settle(hub);
    expect(g2.status.at(-1)).toEqual(['closed', 'The host ended the session']);
  });

  it('a throwing app callback never breaks the session', async () => {
    const hub = new MemoryHub();
    const { host, guests: [a] } = await room(hub, 1);
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      const ev = (host.session as unknown as { events: SessionEvents }).events;
      const real = ev.onRemoteOps;
      ev.onRemoteOps = () => { throw new Error('app bug'); };
      a.edit((p) => { p.name = 'one'; });
      await settle(hub);
      ev.onRemoteOps = real;
      a.edit((p) => { p.name = 'two'; });
      await settle(hub);
    } finally { console.error = orig; }
    expect(errors.length).toBe(1);
    expect(host.project.name).toBe('two');
  });
});
