import { describe, it, expect } from 'vitest';
import { parseConfig } from '../../src/ui/config';

describe('runtime config', () => {
  it('defaults when the file is missing, empty or malformed', () => {
    for (const raw of [undefined, null, 5, 'x', {}, { collab: 3 }, { collab: { peer: 'nope', iceServers: 'nope' } }]) expect(parseConfig(raw)).toEqual({ collab: {} });
  });
  it('keeps a well-formed broker, ICE servers and idle time', () => {
    const c = parseConfig({ collab: {
      peer: { host: 'peer.example.com', port: 443, path: '/fl', secure: true, key: 'k' },
      iceServers: [{ urls: 'stun:stun.example.com:3478' }, { urls: ['turn:t.example.com:3478', 'http://evil'], username: 'u', credential: 'p' }, { urls: 'javascript:alert(1)' }, null],
      maxIdleSeconds: 90,
    } });
    expect(c.collab.peer).toEqual({ host: 'peer.example.com', port: 443, path: '/fl', secure: true, key: 'k' });
    expect(c.collab.iceServers).toEqual([{ urls: ['stun:stun.example.com:3478'] }, { urls: ['turn:t.example.com:3478'], username: 'u', credential: 'p' }]);
    expect(c.collab.maxIdleSeconds).toBe(90);
  });
  it('drops bad pieces without dropping the rest', () => {
    const c = parseConfig({ collab: { peer: { host: 'bad host/', port: 99999 }, maxIdleSeconds: 2, iceServers: [{ urls: 'stun:ok.example:1' }] } });
    expect(c.collab.peer).toBeUndefined();
    expect(c.collab.maxIdleSeconds).toBeUndefined();
    expect(c.collab.iceServers).toEqual([{ urls: ['stun:ok.example:1'] }]);
  });
});
