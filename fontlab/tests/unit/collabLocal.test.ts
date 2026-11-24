/**
 * LocalTransport (BroadcastChannel) run inside one Node process: Node 18+ has a
 * global BroadcastChannel that delivers between instances of the same thread,
 * which is all the transport needs. The suite skips itself where it is missing.
 */
import { describe, it, expect } from 'vitest';
import { newProject } from '../../src/core/glyph';
import { snapshotOf } from '../../src/collab/protocol';
import { LocalTransport, makeTransport, newRoomId } from '../../src/collab/transport';
import { Session, type Peer, type SessionEvents } from '../../src/collab/session';

const hasChannel = typeof BroadcastChannel !== 'undefined';
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('timed out waiting'); await tick(5); }
}

describe.skipIf(!hasChannel)('collab LocalTransport', () => {
  it('connects a host and guests, carries messages both ways, and says who left', async () => {
    const room = newRoomId();
    const h = new LocalTransport({ heartbeatMs: 40 });
    const a = new LocalTransport({ heartbeatMs: 40 });
    const b = makeTransport('local', { heartbeatMs: 40 });
    const opened: string[] = [], closed: string[] = [];
    const got: Record<string, string[]> = { h: [], a: [], b: [] };
    h.onPeerOpen = (id) => opened.push(id);
    h.onPeerClose = (id) => closed.push(id);
    h.onMessage = (from, d) => got.h.push(from + ':' + d);
    a.onMessage = (from, d) => got.a.push(from + ':' + d);
    b.onMessage = (from, d) => got.b.push(from + ':' + d);
    let aHost = '';
    a.onPeerOpen = (id) => { aHost = id; };
    try {
      await h.open('host', room);
      await Promise.all([a.open('guest', room), b.open('guest', room)]);
      expect(aHost).toBe(h.id);
      expect(opened.sort()).toEqual([a.id, b.id].sort());
      expect(new Set([h.id, a.id, b.id]).size).toBe(3);

      a.send(null, 'from a');
      b.send('ignored for guests', 'from b');
      h.send(null, 'to all');
      h.send(a.id, 'to a');
      h.send('nobody', 'lost');
      await until(() => got.h.length === 2 && got.a.length === 2 && got.b.length === 1);
      expect(got.h.sort()).toEqual([a.id + ':from a', b.id + ':from b'].sort());
      expect(got.a).toEqual([h.id + ':to all', h.id + ':to a']);
      expect(got.b).toEqual([h.id + ':to all']);

      // heartbeats keep everyone in while they answer
      await tick(300);
      expect(closed).toEqual([]);

      // a clean close is noticed at once
      b.close();
      await until(() => closed.length === 1);
      expect(closed).toEqual([b.id]);

      // a tab that just vanishes (no goodbye) is dropped after three silent heartbeats
      const dead = a as unknown as { bc: BroadcastChannel; beat: ReturnType<typeof setInterval> };
      clearInterval(dead.beat);
      dead.bc.close();
      await until(() => closed.length === 2, 2000);
      expect(closed).toEqual([b.id, a.id]);
    } finally { h.close(); a.close(); b.close(); }
  });

  it('guests notice a host that vanished; a second host and a missing host are refused', async () => {
    const room = newRoomId();
    const h = new LocalTransport({ heartbeatMs: 40 });
    const g = new LocalTransport({ heartbeatMs: 40 });
    const lost: string[] = [];
    g.onPeerClose = (id) => lost.push(id);
    try {
      await h.open('host', room);
      await expect(new LocalTransport().open('host', room)).rejects.toThrow(/already open/);
      await g.open('guest', room);
      const dead = h as unknown as { bc: BroadcastChannel; beat: ReturnType<typeof setInterval> };
      clearInterval(dead.beat);
      dead.bc.close();
      await until(() => lost.length === 1, 2000);
      expect(lost).toEqual([h.id]);
      await expect(new LocalTransport({ timeoutMs: 300 }).open('guest', newRoomId())).rejects.toThrow(/No session found/);
      await expect(new LocalTransport().open('guest', 'bad room!')).rejects.toThrow(/not valid/);
    } finally { h.close(); g.close(); }
  });

  it('runs a whole session between "tabs"', async () => {
    const room = newRoomId();
    const hostProject = newProject('Tabbed');
    hostProject.glyphs['a'] = { char: 'a', unicode: 97, advance: 500, source: 'drawn', kind: 'stroke', strokes: [] };
    let guestProject = newProject('mine');
    let guestPeers: Peer[] = [];
    const status: string[] = [];
    const events = (onInit?: SessionEvents['onInit']): SessionEvents => ({ onPeers: (p) => { guestPeers = onInit ? p : guestPeers; }, onRemoteOps: () => {}, onStatus: (s, d) => { if (onInit) status.push(s + (d ? ': ' + d : '')); }, onInit });
    const host = await Session.host(new LocalTransport({ heartbeatMs: 40 }), room, { name: 'H' }, () => hostProject, events());
    const guest = await Session.join(new LocalTransport({ heartbeatMs: 40 }), room, { name: 'G' }, events((p) => { guestProject = p; }));
    try {
      expect([...snapshotOf(guestProject)]).toEqual([...snapshotOf(hostProject)]);
      await until(() => guestPeers.length === 2);
      expect(guestPeers.map((p) => p.name)).toEqual(['H', 'G']);
      host.leave();
      await until(() => status.at(-1)!.startsWith('closed'));
      expect(status).toEqual(['connecting', 'open', 'closed: The host ended the session']);
    } finally { host.leave(); guest.leave(); }
  });
});
