#!/usr/bin/env node
// Load test for the sync server: many synthetic people in one room, each editing blocks and moving a cursor, the way
// the browser does over the WebSocket protocol (hello / recs / presence). Reports how long an edit takes to reach the
// others (p50 / p95 / p99), message and byte rates, and the server's CPU and memory from /api/stats. No dependencies;
// Node 22+ (built-in WebSocket).
//
//   node tools/loadtest.mjs --url http://127.0.0.1:8787 --clients 50 --edits 2 --cursor 20 --seconds 20
//   node tools/loadtest.mjs --frames 40 --blocks 60 --seed        # push a 40-screen, 2,400-block canvas first
//   node tools/loadtest.mjs --room load1 --clients 100 --json      # machine-readable summary
//
// --clients N      synthetic people (default 25)       --edits R      edits per second per person (default 2)
// --cursor HZ      cursor moves per second (default 20)  --seconds S    measuring window after warm-up (default 20)
// --frames F       screens in the canvas (default 40)  --blocks B     blocks per screen (default 60)
// --seed           (re)create the canvas in the room   --same-frame   everyone edits the same screen
// --room ID        room id (default: loadtest)          --keep         leave the room's data in place afterwards
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : d; };
const URL_ = String(opt('url', 'http://127.0.0.1:8787')).replace(/\/$/, '');
const ROOM = String(opt('room', 'loadtest'));
const N = +opt('clients', 25), EDITS = +opt('edits', 2), CURSOR = +opt('cursor', 20), SECONDS = +opt('seconds', 20);
const FRAMES = +opt('frames', 40), BLOCKS = +opt('blocks', 60);
const SEED = !!opt('seed', false), SAME = !!opt('same-frame', false), JSON_OUT = !!opt('json', false);
const WS = URL_.replace(/^http/, 'ws') + '/sync?room=' + encodeURIComponent(ROOM);

const pct = (arr, p) => { if (!arr.length) return 0; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
let clock = Date.now() * 1000; const tick = () => { clock = Math.max(clock + 1, Date.now() * 1000); return clock; };
const fmt = { id: 'slide', name: 'Slide 16:9', w: 1920, h: 1080 };
const fid = i => 'lf' + String(i).padStart(3, '0'); const bid = (i, j) => 'b' + String(i).padStart(3, '0') + '_' + String(j).padStart(3, '0');

// A canvas the browser can open: screens with text and shapes, the records shaped like js/sync.js makes them.
function seedRecords() {
  const out = [{ _k: 'meta', name: 'Load test canvas' }];
  for (let i = 0; i < FRAMES; i++) {
    const order = [];
    for (let j = 0; j < BLOCKS; j++) {
      const id = bid(i, j); order.push(id);
      const col = j % 6, row = Math.floor(j / 6);
      const b = j % 3 === 0
        ? { id, kind: 'text', role: 'text', path: 'text_' + id, text: `Block ${j} on screen ${i}: payroll in ${90 + (j % 60)} countries`, x: 80 + col * 300, y: 80 + row * 100, w: 280, h: 60, font: { family: 'Inter, sans-serif', size: 18, weight: 500, lineHeight: 1.3, letterSpacing: 0 }, fill: '#191A25', align: 'left', decorative: false }
        : { id, kind: 'field', x: 80 + col * 300, y: 80 + row * 100, w: 280, h: 72, fill: j % 3 === 1 ? '#5938B8' : '#E4DDFB', radius: 12, decorative: true };
      out.push({ _k: `b~${fid(i)}~${id}`, ...b });
    }
    out.push({ _k: 'f~' + fid(i), id: fid(i), name: 'Screen ' + (i + 1), x: (i % 8) * 2040, y: Math.floor(i / 8) * 1200, z: i, order,
      layout: { id: 'load-' + i, seed: 0, archetype: 'blank', archetypeLabel: 'Blank', format: fmt, grid: { unit: 8, gutter: 24, cols: 12, rows: 8, cw: 128, rh: 108, mx: 96, my: 72, safe: 48 }, palette: { bg: '#FFFFFF', fg: '#191A25', accent: '#5938B8', bgName: 'White' }, type: { level: 2, headline: 96, body: 26, display: 'Inter', body_font: 'Inter' }, brand: 'Load', meta: {}, metrics: { whitespace: 1, density: 0, balance: 1 } } });
  }
  return out;
}
async function stats() { try { const r = await fetch(URL_ + '/api/stats'); return r.ok ? await r.json() : null; } catch { return null; } }
function connect(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS); const t0 = Date.now();
    const c = { ws, name, got: 0, bytes: 0, lat: [], presence: 0, snapshotBytes: 0, joinMs: 0, recsIn: 0 };
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', client: { id: name, name, color: '#7C5CFF' }, tools: [] }));
    // Only edits are parsed (for their timestamps); cursor messages are counted by their prefix, so the generator
    // itself stays cheap with a hundred people in it.
    ws.onmessage = ev => {
      const s = String(ev.data); c.got++; c.bytes += s.length;
      if (s.startsWith('{"t":"presence')) { c.presence++; return; }
      let m; try { m = JSON.parse(s); } catch { return; }
      if (m.t === 'snapshot') { c.snapshotBytes = s.length; c.joinMs = Date.now() - t0; resolve(c); return; }
      if (m.t === 'recs') { const now = Date.now(); for (const r of m.recs || []) { c.recsIn++; if (typeof r._v === 'number' && r._v > 1e15) { const l = now - Math.floor(r._v / 1000); if (l >= 0 && l < 60000) c.lat.push(l); } } }
    };
    ws.onerror = e => reject(new Error('connect failed: ' + (e.message || 'ws error')));
    ws.onclose = () => { c.closed = true; };
  });
}
(async () => {
  const before = await stats();
  const seeder = await connect('seed');
  if (SEED || !seeder.snapshotBytes || seeder.snapshotBytes < 2000) {
    const recs = seedRecords().map(r => ({ ...r, _v: tick(), _by: 'seed' }));
    for (let i = 0; i < recs.length; i += 500) seeder.ws.send(JSON.stringify({ t: 'recs', recs: recs.slice(i, i + 500), live: false }));
    await new Promise(r => setTimeout(r, 500));
    if (!JSON_OUT) console.log(`seeded ${FRAMES} screens × ${BLOCKS} blocks (${recs.length} records)`);
  }
  const clients = [];
  const t0 = Date.now();
  const joinTimeout = +opt('join-timeout', 60) * 1000;
  for (let i = 0; i < N; i++) { clients.push(await Promise.race([connect('p' + i), new Promise((_, rej) => setTimeout(() => rej(new Error(`person ${i} could not join within ${joinTimeout / 1000} s (server overloaded?)`)), joinTimeout))])); if (i % 10 === 9) await new Promise(r => setTimeout(r, 20)); }
  const joinAll = Date.now() - t0;
  if (!JSON_OUT) console.log(`${N} people joined in ${joinAll} ms (snapshot ${(clients[0].snapshotBytes / 1024).toFixed(0)} KB each, first join ${clients[0].joinMs} ms, last ${clients[N - 1].joinMs} ms)`);
  // warm-up 2 s, then measure
  let sent = 0, cursors = 0; const timers = [];
  clients.forEach((c, i) => {
    const frame = SAME ? 0 : i % FRAMES; let seq = 0;
    if (EDITS > 0) timers.push(setInterval(() => {
      if (c.ws.readyState !== 1) return;
      const j = (seq++ * 7 + i) % BLOCKS; const id = bid(frame, j); const col = j % 6, row = Math.floor(j / 6);
      const rec = { _k: `b~${fid(frame)}~${id}`, _v: tick(), _by: c.name, id, kind: j % 3 === 0 ? 'text' : 'field', x: 80 + col * 300 + (seq % 40), y: 80 + row * 100 + (seq % 20), w: 280, h: j % 3 === 0 ? 60 : 72, fill: j % 3 === 0 ? '#191A25' : j % 3 === 1 ? '#5938B8' : '#E4DDFB', radius: 12, decorative: j % 3 !== 0 };
      if (j % 3 === 0) Object.assign(rec, { role: 'text', path: 'text_' + id, text: `Block ${j} on screen ${frame}: edit ${seq} by ${c.name}`, font: { family: 'Inter, sans-serif', size: 18, weight: 500, lineHeight: 1.3, letterSpacing: 0 }, align: 'left' });
      c.ws.send(JSON.stringify({ t: 'recs', recs: [rec], live: true })); sent++;
    }, 1000 / EDITS));
    if (CURSOR > 0) timers.push(setInterval(() => { if (c.ws.readyState === 1) { c.ws.send(JSON.stringify({ t: 'presence', p: { cursor: { x: Math.round(Math.random() * 4000), y: Math.round(Math.random() * 3000) } } })); cursors++; } }, 1000 / CURSOR));
  });
  await new Promise(r => setTimeout(r, 2000));
  for (const c of clients) { c.lat = []; c.got = 0; c.bytes = 0; c.presence = 0; c.recsIn = 0; } sent = 0; cursors = 0;
  const s0 = await stats(); const m0 = Date.now();
  await new Promise(r => setTimeout(r, SECONDS * 1000));
  const s1 = await stats(); const secs = (Date.now() - m0) / 1000;
  timers.forEach(clearInterval);
  const lat = clients.flatMap(c => c.lat); const got = clients.reduce((t, c) => t + c.got, 0); const bytes = clients.reduce((t, c) => t + c.bytes, 0);
  const expected = sent * (N - 1); const delivered = clients.reduce((t, c) => t + c.recsIn, 0);
  const cpu = s0 && s1 ? ((s1.cpuMs - s0.cpuMs) / (secs * 1000) * 100) : null;
  const out = { clients: N, editsPerSec: EDITS, cursorHz: CURSOR, frames: FRAMES, blocks: BLOCKS, sameFrame: SAME, seconds: +secs.toFixed(1), joinAllMs: joinAll, snapshotKB: +(clients[0].snapshotBytes / 1024).toFixed(0),
    editsSent: sent, editsPerSecTotal: +(sent / secs).toFixed(1), delivered: +(delivered / Math.max(1, expected) * 100).toFixed(1), latencyMs: { p50: pct(lat, 0.5), p95: pct(lat, 0.95), p99: pct(lat, 0.99), max: lat.length ? Math.max(...lat) : 0, samples: lat.length },
    inbound: { msgsPerSec: +(got / secs).toFixed(0), kbPerSec: +(bytes / secs / 1024).toFixed(0), perClientMsgsPerSec: +(got / secs / N).toFixed(0) },
    server: s1 ? { cpuPct: cpu == null ? null : +cpu.toFixed(0), rssMB: +(s1.rssMB).toFixed(0), heapMB: +(s1.heapMB).toFixed(0), outMsgsPerSec: s0 ? +((s1.msgsOut - s0.msgsOut) / secs).toFixed(0) : null, outMBPerSec: s0 ? +((s1.bytesOut - s0.bytesOut) / secs / 1048576).toFixed(2) : null, loopLagMaxMs: s1.loopLagMaxMs, loopLagP95Ms: s1.loopLagP95Ms, saves: s0 ? s1.saves - s0.saves : null, saveMsMax: s1.saveMsMax, dropped: s0 ? (s1.dropped || 0) - (s0.dropped || 0) : null, version: s1.version } : null,
    closed: clients.filter(c => c.closed).length };
  if (JSON_OUT) console.log(JSON.stringify(out));
  else {
    console.log(`\n${N} people · ${EDITS} edits/s each (${out.editsPerSecTotal}/s total) · cursor ${CURSOR} Hz · ${FRAMES}×${BLOCKS} canvas${SAME ? ' · same screen' : ''}`);
    console.log(`edit reaches others: p50 ${out.latencyMs.p50} ms · p95 ${out.latencyMs.p95} ms · p99 ${out.latencyMs.p99} ms · max ${out.latencyMs.max} ms · delivered ${out.delivered}%`);
    console.log(`each person receives ${out.inbound.perClientMsgsPerSec} msgs/s · all: ${out.inbound.msgsPerSec} msgs/s, ${out.inbound.kbPerSec} KB/s`);
    if (out.server) console.log(`server: CPU ${out.server.cpuPct == null ? '?' : out.server.cpuPct + '%'} · RSS ${out.server.rssMB} MB · out ${out.server.outMsgsPerSec} msgs/s ${out.server.outMBPerSec} MB/s · loop lag p95 ${out.server.loopLagP95Ms} ms max ${out.server.loopLagMaxMs} ms · saves ${out.server.saves} (max ${out.server.saveMsMax} ms)${out.server.dropped ? ` · dropped ${out.server.dropped}` : ''}`);
    else console.log('server: no /api/stats (older server?)');
    if (out.closed) console.log(`${out.closed} connections were closed by the server`);
  }
  for (const c of clients) c.ws.close(); seeder.ws.close();
  setTimeout(() => process.exit(0), 200);
})().catch(e => { console.error(e.message || e); process.exit(1); });
