/**
 * Optional runtime settings read from `fontlab.config.json` next to index.html,
 * so a deployment can be tuned after the build (no rebuild needed).
 *
 *   {
 *     "collab": {
 *       "peer": { "host": "peer.example.com", "port": 443, "path": "/fl", "secure": true, "key": "peerjs" },
 *       "iceServers": [{ "urls": "stun:stun.example.com:3478" },
 *                      { "urls": "turn:turn.example.com:3478", "username": "u", "credential": "p" }],
 *       "maxIdleSeconds": 45
 *     }
 *   }
 *
 * Everything is optional. Without `peer` the public PeerJS broker is used; without
 * `iceServers` the servers PeerJS ships with.
 */
export interface AppConfig {
  collab: {
    peer?: { host?: string; port?: number; path?: string; secure?: boolean; key?: string };
    iceServers?: RTCIceServer[];
    maxIdleSeconds?: number;
  };
}

let config: AppConfig = { collab: {} };
let loaded: Promise<AppConfig> | null = null;

export function getConfig(): AppConfig { return config; }

/** Fetch and validate the config once. Never rejects: a missing or broken file means defaults. */
export function loadConfig(url = './fontlab.config.json'): Promise<AppConfig> {
  if (loaded) return loaded;
  loaded = (async () => {
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (res.ok) config = parseConfig(await res.json());
    } catch { /* defaults */ }
    return config;
  })();
  return loaded;
}

const str = (v: unknown, max = 200): string | undefined => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined);

/** Keep only well-formed values; anything else falls back to the default. */
export function parseConfig(raw: unknown): AppConfig {
  const out: AppConfig = { collab: {} };
  const c = (raw as { collab?: Record<string, unknown> } | null)?.collab;
  if (!c || typeof c !== 'object') return out;
  const p = c.peer as Record<string, unknown> | undefined;
  if (p && typeof p === 'object') {
    const peer: NonNullable<AppConfig['collab']['peer']> = {};
    const host = str(p.host); if (host && /^[A-Za-z0-9.-]+$/.test(host)) peer.host = host;
    if (typeof p.port === 'number' && Number.isInteger(p.port) && p.port > 0 && p.port < 65536) peer.port = p.port;
    const path = str(p.path); if (path && path.startsWith('/')) peer.path = path;
    if (typeof p.secure === 'boolean') peer.secure = p.secure;
    const key = str(p.key, 60); if (key) peer.key = key;
    if (peer.host) out.collab.peer = peer;
  }
  if (Array.isArray(c.iceServers)) {
    const ice: RTCIceServer[] = [];
    for (const s of c.iceServers.slice(0, 8)) {
      if (!s || typeof s !== 'object') continue;
      const o = s as Record<string, unknown>;
      const urls = (Array.isArray(o.urls) ? o.urls : [o.urls]).filter((u): u is string => typeof u === 'string' && /^(stun|stuns|turn|turns):/.test(u));
      if (!urls.length) continue;
      const server: RTCIceServer = { urls };
      const username = str(o.username), credential = str(o.credential, 500);
      if (username) server.username = username;
      if (credential) server.credential = credential;
      ice.push(server);
    }
    if (ice.length) out.collab.iceServers = ice;
  }
  if (typeof c.maxIdleSeconds === 'number' && c.maxIdleSeconds >= 10 && c.maxIdleSeconds <= 3600) out.collab.maxIdleSeconds = c.maxIdleSeconds;
  return out;
}

/** Options for the WebRTC transport, from the config. */
export function peerOptions(): Record<string, unknown> {
  const c = config.collab;
  return { ...(c.peer ?? {}), ...(c.iceServers ? { iceServers: c.iceServers } : {}) };
}
