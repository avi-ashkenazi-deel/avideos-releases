/**
 * Collaboration protocol (pure): the font is split into independently
 * replaceable values ("keys"): one per letter, one per letter's alternates,
 * one per review note, one per project setting. An Op replaces one key.
 * Everyone converges on the host's order, last writer wins per key.
 *
 * Everything that reaches validateOp / applyOp may come from the network and
 * is treated as untrusted.
 */
import type { FontProject, Glyph, ReviewNote } from '../core/glyph';
import { DEFAULT_METRICS, DEFAULT_STATS } from '../core/glyph';
import { isGlyph, isNote, parseProject } from '../project/schema';

export type SetKey = 'fx' | 'color' | 'spacing' | 'kerning' | 'metrics' | 'name' | 'blocks' | 'customChars' | 'stats' | 'seeds' | 'mutation';
export type Op =
  | { k: 'glyph'; ch: string; v: Glyph | null }       // null = letter removed
  | { k: 'alt'; ch: string; v: Glyph[] | null }       // stylistic alternates of a letter
  | { k: 'note'; id: string; v: ReviewNote | null }
  | { k: 'set'; key: SetKey; v: unknown };

/** `previewText` is deliberately absent: each person types their own test text. */
export const SET_KEYS: readonly SetKey[] = ['name', 'metrics', 'stats', 'fx', 'mutation', 'blocks', 'customChars', 'spacing', 'kerning', 'color', 'seeds'];

const MAX_CH = 32;
const MAX_ID = 120;
const MAX_ALTERNATES = 3;

export function opKey(op: Op): string {
  switch (op.k) {
    case 'glyph': return 'glyph:' + op.ch;
    case 'alt': return 'alt:' + op.ch;
    case 'note': return 'note:' + op.id;
    default: return 'set:' + op.key;
  }
}

export function isNoteOp(op: Op): boolean {
  return op.k === 'note';
}

export type Snapshot = Map<string, string>;            // opKey → JSON of the value

// Snapshots stringify every value, and number formatting makes that the slow part (a 400 glyph font is
// several MB of JSON). Glyphs are edited in place, so object identity says nothing; instead each value gets a
// cheap structural checksum, and the JSON made last time is reused while the checksum is the same.
const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);
let h1 = 0, h2 = 0;
function mix(x: number): void {
  h1 = Math.imul(h1 ^ x, 0x85ebca6b); h1 ^= h1 >>> 13;     // a bijection per step: one changed number always changes h1
  h2 = Math.imul(h2 + x, 0xc2b2ae35) ^ (h2 >>> 15);
}
function mixString(s: string): void {
  mix(s.length ^ 0x1234567);
  for (let i = 0; i < s.length; i++) mix(s.charCodeAt(i));
}
function walk(v: unknown): void {
  switch (typeof v) {
    case 'number': f64[0] = v; mix(u32[0]); mix(u32[1] ^ 0x9e3779b9); return;
    case 'string': mixString(v); return;
    case 'boolean': mix(v ? 0xb001 : 0xb000); return;
    case 'object': {
      if (v === null) { mix(0x4e11); return; }
      if (Array.isArray(v)) { mix(0xa55a0000 ^ v.length); for (let i = 0; i < v.length; i++) walk(v[i]); return; }
      mix(0x0b1ec7);
      const o = v as Record<string, unknown>;
      for (const k in o) { const x = o[k]; if (x === undefined) continue; mixString(k); walk(x); }
      mix(0xe0d);
      return;
    }
    default: mix(0x0ddba11); return;
  }
}
/** 53-bit checksum of a JSON-like value; values with different JSON get different checksums (up to hash collisions) */
function checksum(v: unknown): number {
  h1 = 0x811c9dc5; h2 = 0x1b873593;
  walk(v);
  return (h1 >>> 0) * 2097152 + (h2 >>> 11);
}

/** per project object: key → checksum and JSON of the value when it was last snapshotted */
const lastJson = new WeakMap<object, Map<string, { sum: number; json: string }>>();

export function snapshotOf(project: FontProject): Snapshot {
  const snap: Snapshot = new Map();
  const before = lastJson.get(project);
  const now = new Map<string, { sum: number; json: string }>();
  const put = (key: string, v: unknown, fallback?: string): void => {
    if (v === undefined || v === null) { if (fallback !== undefined) snap.set(key, fallback); return; }
    const sum = checksum(v);
    let hit = before?.get(key);
    if (!hit || hit.sum !== sum) {
      const json = JSON.stringify(v);
      if (json === undefined) { if (fallback !== undefined) snap.set(key, fallback); return; }
      hit = { sum, json };
    }
    now.set(key, hit);
    snap.set(key, hit.json);
  };
  const p = project as unknown as Record<string, unknown>;
  for (const key of SET_KEYS) put('set:' + key, p[key], 'null');
  const glyphs = project.glyphs ?? {};
  for (const ch of Object.keys(glyphs)) put('glyph:' + ch, glyphs[ch]);
  const alts = project.alternates ?? {};
  for (const ch of Object.keys(alts)) {
    const list = alts[ch];
    if (Array.isArray(list) && list.length) put('alt:' + ch, list);
  }
  for (const n of project.notes ?? []) {
    if (n && typeof n.id === 'string') put('note:' + n.id, n);
  }
  lastJson.set(project, now);
  return snap;
}

/** The op that sets `key` to the value a snapshot holds for it (nothing there = the key is gone). */
export function opFromSnapshot(snap: Snapshot, key: string): Op | null {
  return opFromJson(key, snap.get(key));
}

/** Record in a snapshot what an op sets (`json` = JSON of `op.v`, if the caller already has it). */
export function recordOp(snap: Snapshot, op: Op, json?: string): void {
  const key = opKey(op);
  const gone = op.v === null || op.v === undefined || (op.k === 'alt' && !op.v.length);
  if (!gone) snap.set(key, json ?? JSON.stringify(op.v));
  else if (op.k === 'set') snap.set(key, 'null');
  else snap.delete(key);
}

function opFromJson(key: string, json: string | undefined): Op | null {
  const cut = key.indexOf(':');
  if (cut < 0) return null;
  const kind = key.slice(0, cut), rest = key.slice(cut + 1);
  const v = json === undefined ? null : JSON.parse(json);
  if (kind === 'glyph') return { k: 'glyph', ch: rest, v };
  if (kind === 'alt') return { k: 'alt', ch: rest, v };
  if (kind === 'note') return { k: 'note', id: rest, v };
  if (kind === 'set' && (SET_KEYS as readonly string[]).includes(rest)) return { k: 'set', key: rest as SetKey, v };
  return null;
}

/** ops that turn the state described by `prev` into `project`, plus the new snapshot */
export function diffProject(prev: Snapshot, project: FontProject): { ops: Op[]; next: Snapshot } {
  const next = snapshotOf(project);
  const ops: Op[] = [];
  for (const [key, json] of next) {
    if (prev.get(key) === json) continue;
    // values are re-parsed, so an op never shares objects with the live project
    const op = opFromJson(key, json);
    if (op) ops.push(op);
  }
  for (const key of prev.keys()) {
    if (next.has(key)) continue;
    const op = opFromJson(key, undefined);
    if (op && op.k !== 'set') ops.push(op);
  }
  return { ops, next };
}

/** The op that would set `key` to what `project` holds right now (the authoritative value sent with a rejection). */
export function currentOp(project: FontProject, key: string): Op | null {
  const cut = key.indexOf(':');
  if (cut < 0) return null;
  const kind = key.slice(0, cut), rest = key.slice(cut + 1);
  const own = (o: object | undefined, k: string) => !!o && Object.prototype.hasOwnProperty.call(o, k);
  if (kind === 'glyph') return { k: 'glyph', ch: rest, v: own(project.glyphs, rest) ? project.glyphs[rest] ?? null : null };
  if (kind === 'alt') {
    const list = own(project.alternates, rest) ? project.alternates[rest] : undefined;
    return { k: 'alt', ch: rest, v: Array.isArray(list) && list.length ? list : null };
  }
  if (kind === 'note') return { k: 'note', id: rest, v: (project.notes ?? []).find((n) => n && n.id === rest) ?? null };
  if (kind === 'set' && (SET_KEYS as readonly string[]).includes(rest)) return { k: 'set', key: rest as SetKey, v: (project as unknown as Record<string, unknown>)[rest] };
  return null;
}

// ---- validation

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const optBool = (v: unknown) => v === undefined || typeof v === 'boolean';
const isVec = (v: unknown) => Array.isArray(v) && v.length >= 2 && fin(v[0]) && fin(v[1]);
const okCh = (ch: unknown): ch is string => typeof ch === 'string' && ch.length > 0 && ch.length <= MAX_CH && ch !== '__proto__';

/** isGlyph plus the depth the renderers rely on: every list is a list, every coordinate a finite number. */
function isSafeGlyph(g: unknown): g is Glyph {
  if (!isGlyph(g)) return false;
  const o = g as unknown as Record<string, unknown>;
  if (!fin(o.unicode) || !fin(o.advance) || (o.char as string).length > MAX_CH) return false;
  if (o.source !== undefined && typeof o.source !== 'string') return false;
  if (!optBool(o.locked) || !optBool(o.spacingLocked)) return false;
  if (o.strokes !== undefined) {
    if (!Array.isArray(o.strokes)) return false;
    for (const s of o.strokes) {
      if (!isObj(s) || !Array.isArray(s.points)) return false;
      if (s.id !== undefined && typeof s.id !== 'string') return false;
      if (s.cap !== undefined && typeof s.cap !== 'string') return false;
      for (const p of s.points) {
        if (!isObj(p) || !fin(p.x) || !fin(p.y) || !fin(p.w)) return false;
        if (p.p !== undefined && p.p !== null && !fin(p.p)) return false;
      }
    }
  }
  if (o.contours !== undefined) {
    if (!Array.isArray(o.contours)) return false;
    for (const c of o.contours) {
      if (!isObj(c) || !Array.isArray(c.points)) return false;
      for (const p of c.points) if (!isVec(p)) return false;
    }
  }
  if (o.curves !== undefined) {
    if (!Array.isArray(o.curves)) return false;
    for (const c of o.curves) {
      if (!isObj(c) || !isVec(c.start) || !Array.isArray(c.segments)) return false;
      for (const s of c.segments) if (!Array.isArray(s) || s.length !== 4 || !s.every(isVec)) return false;
    }
  }
  if (o.recipe !== undefined) {
    const r = o.recipe;
    if (!isObj(r) || typeof r.id !== 'string' || !fin(r.seed)) return false;
    if (r.params !== undefined && (!isObj(r.params) || !Object.values(r.params).every(fin))) return false;
  }
  return true;
}

function isSafeNote(n: unknown): n is ReviewNote {
  if (!isNote(n)) return false;
  const o = n as unknown as Record<string, unknown>;
  if (!fin(o.x) || !fin(o.y) || (o.id as string).length > MAX_ID || (o.ch as string).length > MAX_CH) return false;
  if (o.author !== undefined && (typeof o.author !== 'string' || o.author.length > 120)) return false;
  if (!optBool(o.done)) return false;
  if (o.createdAt !== undefined && !fin(o.createdAt)) return false;
  return true;
}

/** JSON with sorted keys: equal for values that only differ in key order */
function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  const o = v as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of Object.keys(o).sort()) if (o[k] !== undefined) parts.push(JSON.stringify(k) + ':' + stable(o[k]));
  return '{' + parts.join(',') + '}';
}

/**
 * Shape-check a project setting, then run it through parseProject so it is
 * normalised exactly like a loaded file (unknown effects dropped, numbers
 * clamped). Returns the original value when normalising changes nothing.
 */
function checkSet(key: SetKey, v: unknown): { v: unknown } | null {
  switch (key) {
    case 'name': return typeof v === 'string' && v.length <= 200 ? { v } : null;
    case 'customChars': return typeof v === 'string' && v.length <= 20000 ? { v } : null;
    case 'mutation': return fin(v) ? { v } : null;
    case 'seeds': return Array.isArray(v) && v.length <= 5000 && v.every(isSafeGlyph) ? { v } : null;
    case 'blocks':
      if (!Array.isArray(v) || v.length > 200 || !v.every((b) => typeof b === 'string' && b.length <= 64)) return null;
      break;
    case 'metrics':
      if (!isObj(v) || !Object.keys(DEFAULT_METRICS).every((k) => fin(v[k]))) return null;
      break;
    case 'stats': {
      if (!isObj(v)) return null;
      for (const [k, d] of Object.entries(DEFAULT_STATS)) {
        if (typeof d === 'number' ? !fin(v[k]) : typeof v[k] !== 'string') return null;
      }
      if (!['round', 'flat', 'taper'].includes(v.terminal as string)) return null;
      break;
    }
    case 'spacing':
      if (!isObj(v) || !fin(v.tightness)) return null;
      break;
    case 'kerning':
      if (!isObj(v) || !fin(v.strength)) return null;
      if (v.pairs !== undefined && (!isObj(v.pairs) || Object.keys(v.pairs).length > 50000)) return null;
      break;
    case 'color':
      if (!isObj(v) || !Array.isArray(v.palette) || !fin(v.amount) || typeof v.mode !== 'string') return null;
      break;
    case 'fx':
      if (!isObj(v) || !fin(v.seed) || !Array.isArray(v.groups) || v.groups.length > 64) return null;
      for (const g of v.groups) {
        if (!isObj(g) || !Array.isArray(g.layers) || g.layers.length > 256) return null;
        for (const l of g.layers) if (!isObj(l) || typeof l.type !== 'string' || (l.params !== undefined && !isObj(l.params))) return null;
      }
      break;
    default: return null;
  }
  const norm = (parseProject({ version: 1, [key]: v }) as unknown as Record<string, unknown>)[key];
  return { v: stable(norm) === stable(v) ? v : norm };
}

/**
 * Check an untrusted op. Returns a clean op (unknown fields dropped) or null.
 * `result.v === op.v` unless the value had to be normalised.
 */
export function validateOp(op: unknown): Op | null {
  try {
    if (!isObj(op)) return null;
    const v = op.v;
    switch (op.k) {
      case 'glyph':
        if (!okCh(op.ch)) return null;
        if (v === null) return { k: 'glyph', ch: op.ch, v: null };
        return isSafeGlyph(v) ? { k: 'glyph', ch: op.ch, v } : null;
      case 'alt':
        if (!okCh(op.ch)) return null;
        if (v === null) return { k: 'alt', ch: op.ch, v: null };
        return Array.isArray(v) && v.length <= MAX_ALTERNATES && v.every(isSafeGlyph) ? { k: 'alt', ch: op.ch, v: v as Glyph[] } : null;
      case 'note':
        if (typeof op.id !== 'string' || !op.id || op.id.length > MAX_ID) return null;
        if (v === null) return { k: 'note', id: op.id, v: null };
        return isSafeNote(v) && v.id === op.id ? { k: 'note', id: op.id, v } : null;
      case 'set': {
        if (typeof op.key !== 'string' || !(SET_KEYS as readonly string[]).includes(op.key)) return null;
        const r = checkSet(op.key as SetKey, v);
        return r ? { k: 'set', key: op.key as SetKey, v: r.v } : null;
      }
      default: return null;
    }
  } catch {
    return null;   // e.g. absurdly deep nesting
  }
}

const noteOrder = (a: ReviewNote, b: ReviewNote) => ((a.createdAt ?? 0) - (b.createdAt ?? 0)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * mutate the project; validates values (isGlyph / isNote / shape checks);
 * returns false and changes nothing if invalid. The project takes ownership
 * of the op's value (it is not copied).
 */
export function applyOp(project: FontProject, op: Op): boolean {
  const o = validateOp(op);
  if (!o) return false;
  switch (o.k) {
    case 'glyph':
      if (o.v === null) delete project.glyphs[o.ch];
      else project.glyphs[o.ch] = o.v;
      return true;
    case 'alt':
      if (!project.alternates) project.alternates = {};
      if (o.v === null || !o.v.length) delete project.alternates[o.ch];
      else project.alternates[o.ch] = o.v;
      return true;
    case 'note': {
      if (!Array.isArray(project.notes)) project.notes = [];
      const notes = project.notes;
      const at = notes.findIndex((n) => n && n.id === o.id);
      if (o.v === null) { if (at >= 0) notes.splice(at, 1); return true; }
      if (at >= 0) { notes[at] = o.v; return true; }
      // new notes go in by time (then id), so everyone lists them in the same order
      let i = notes.length;
      while (i > 0 && noteOrder(notes[i - 1], o.v) > 0) i--;
      notes.splice(i, 0, o.v);
      return true;
    }
    default:
      (project as unknown as Record<string, unknown>)[o.key] = o.v;
      return true;
  }
}

/**
 * Apply several ops; when `snap` is given, record each applied value in it so
 * the next diffProject does not send it back (and leaves unsent local changes
 * to other keys alone). Returns the ops that were applied.
 */
export function applyOps(project: FontProject, ops: Op[], snap?: Snapshot): Op[] {
  const done: Op[] = [];
  for (const op of ops) {
    if (!applyOp(project, op)) continue;
    done.push(op);
    if (!snap) continue;
    // what the project holds now (a setting may have been normalised on the way in)
    const cur = currentOp(project, opKey(op));
    if (cur) recordOp(snap, cur);
  }
  return done;
}

// ---- chunking: data channels have message size limits

const CHUNK_HEAD = '{"c":"';
export const CHUNK_MAX = 48_000;
let chunkSeq = 0;

/** bytes this UTF-16 unit takes inside a JSON string sent as UTF-8 (upper bound) */
function escapedCost(code: number): number {
  if (code < 0x20) return 6;                       // \u00XX
  if (code === 0x22 || code === 0x5c) return 2;    // \" and \\
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (code >= 0xd800 && code <= 0xdfff) return 6;  // half of a pair (2 bytes) or a lone surrogate (\uXXXX)
  return 3;
}

function utf8Fits(s: string, max: number): boolean {
  if (s.length * 3 <= max) return true;
  if (s.length > max) return false;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
    if (n > max) return false;
  }
  return true;
}

/**
 * split / join long strings so every message stays under ~48 KB (bytes on the
 * wire, counted after JSON escaping). Short strings are returned as they are;
 * each chunk is itself a JSON string {c:id,i,n,d}.
 */
export function chunk(json: string, max: number = CHUNK_MAX): string[] {
  max = Math.max(256, Math.floor(max));
  const looksChunked = json.startsWith(CHUNK_HEAD);
  if (!looksChunked && utf8Fits(json, max)) return [json];
  const budget = max - 96;   // room for the envelope
  const cuts: number[] = [];
  let cost = 0;
  for (let i = 0; i < json.length; i++) {
    const code = json.charCodeAt(i);
    const c = escapedCost(code);
    // never cut between the two halves of a surrogate pair
    const lowHalf = code >= 0xdc00 && code <= 0xdfff && i > 0 && (json.charCodeAt(i - 1) & 0xfc00) === 0xd800;
    if (cost + c > budget && !lowHalf && i > (cuts[cuts.length - 1] ?? 0)) { cuts.push(i); cost = 0; }
    cost += c;
  }
  cuts.push(json.length);
  chunkSeq = (chunkSeq + 1) % 0x7fffffff;
  const id = chunkSeq.toString(36) + '-' + Math.floor(Math.random() * 0xffffffff).toString(36);
  const out: string[] = [];
  let from = 0;
  for (let i = 0; i < cuts.length; i++) {
    out.push(`${CHUNK_HEAD}${id}","i":${i},"n":${cuts.length},"d":${JSON.stringify(json.slice(from, cuts[i]))}}`);
    from = cuts[i];
  }
  return out;
}

/**
 * Puts chunked messages back together. Use one per sender. Messages that are
 * not chunks pass through. Anything larger than `maxTotal` characters is dropped.
 */
export class Reassembler {
  private streams = new Map<string, { n: number; parts: string[]; size: number }>();
  constructor(private maxTotal: number = 8 * 1024 * 1024, private maxStreams: number = 8) {}

  /** returns the full string when the last chunk arrives; passes through non-chunk messages */
  push(msg: string): string | null {
    if (typeof msg !== 'string') return null;
    if (!msg.startsWith(CHUNK_HEAD)) return msg.length > this.maxTotal ? null : msg;
    let o: unknown;
    try { o = JSON.parse(msg); } catch { return null; }
    if (!isObj(o) || typeof o.c !== 'string' || typeof o.d !== 'string' || !Number.isInteger(o.i) || !Number.isInteger(o.n)) return null;
    const id = o.c, i = o.i as number, n = o.n as number, d = o.d;
    if (n < 1 || n > 1_000_000 || i < 0 || i >= n) return null;
    let s = this.streams.get(id);
    if (!s) {
      if (i !== 0) return null;
      if (this.streams.size >= this.maxStreams) this.streams.delete(this.streams.keys().next().value as string);
      s = { n, parts: [], size: 0 };
      this.streams.set(id, s);
    }
    // chunks of one message arrive in order on a reliable channel; anything else is noise
    if (s.n !== n || i !== s.parts.length) { this.streams.delete(id); return null; }
    s.size += d.length;
    if (s.size > this.maxTotal) { this.streams.delete(id); return null; }
    s.parts.push(d);
    if (s.parts.length < n) return null;
    this.streams.delete(id);
    return s.parts.join('');
  }
}
