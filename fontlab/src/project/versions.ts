/**
 * Version history: named snapshots of a font, kept in the browser.
 *
 * IndexedDB database `fontlab-versions`, store `versions` keyed by id with an
 * index on `fontId`. Without IndexedDB (Node tests, some private modes) an
 * in-memory map keeps versions for the session only.
 */
import type { FontProject, Glyph } from '../core/glyph';
import { parseProject, serializeProject } from './schema';

export interface VersionMeta {
  id: string;
  /** library id of the font, or SCRATCH for a font that was never saved */
  fontId: string;
  name: string;
  /** made automatically before a risky action (reset, import, restore…) */
  auto: boolean;
  createdAt: number;
  glyphCount: number;
  /** small SVG of the preview text, or '' */
  preview: string;
}
interface VersionRecord extends VersionMeta { json: string }

export const SCRATCH = 'scratch';
export const MAX_MANUAL = 30;
export const MAX_AUTO = 8;
const DB = 'fontlab-versions', STORE = 'versions';

const mem = new Map<string, VersionRecord>();
let dbp: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
      if (!idb) { resolve(null); return; }
      const req = idb.open(DB, 1);
      req.onupgradeneeded = () => { const s = req.result.createObjectStore(STORE, { keyPath: 'id' }); s.createIndex('fontId', 'fontId'); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbp;
}
/** true when versions survive a reload */
export async function versionsPersist(): Promise<boolean> { return !!(await db()); }

function tx<T>(d: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(r.result);
    t.onerror = () => reject(t.error ?? r.error);
    t.onabort = () => reject(t.error ?? r.error);
  });
}
async function allOf(fontId: string): Promise<VersionRecord[]> {
  const d = await db();
  if (!d) return [...mem.values()].filter((v) => v.fontId === fontId);
  return tx<VersionRecord[]>(d, 'readonly', (s) => s.index('fontId').getAll(fontId));
}
async function put(rec: VersionRecord): Promise<void> {
  const d = await db();
  if (!d) { mem.set(rec.id, rec); return; }
  await tx(d, 'readwrite', (s) => s.put(rec));
}
async function del(id: string): Promise<void> {
  const d = await db();
  if (!d) { mem.delete(id); return; }
  await tx(d, 'readwrite', (s) => s.delete(id));
}
async function get(id: string): Promise<VersionRecord | undefined> {
  const d = await db();
  if (!d) return mem.get(id);
  return tx<VersionRecord | undefined>(d, 'readonly', (s) => s.get(id));
}

let stamp = 0;
const now = () => { const t = Date.now(); stamp = t > stamp ? t : stamp + 1; return stamp; };
const newId = () => `v${now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const meta = ({ json: _json, ...m }: VersionRecord): VersionMeta => m;

/** Save a snapshot. Oldest versions beyond the caps (per font, manual and automatic separately) are dropped. */
export async function saveVersion(fontId: string, project: FontProject, opts: { name?: string; auto?: boolean; preview?: string } = {}): Promise<VersionMeta> {
  const auto = !!opts.auto;
  const rec: VersionRecord = {
    id: newId(), fontId, auto, createdAt: now(),
    name: (opts.name ?? '').trim() || (auto ? 'Automatic' : 'Version'),
    glyphCount: Object.keys(project.glyphs ?? {}).length,
    preview: opts.preview ?? '',
    json: serializeProject(project),
  };
  await put(rec);
  const same = (await allOf(fontId)).filter((v) => v.auto === auto).sort((a, b) => b.createdAt - a.createdAt);
  for (const old of same.slice(auto ? MAX_AUTO : MAX_MANUAL)) await del(old.id);
  return meta(rec);
}

/** Newest first. */
export async function listVersions(fontId: string): Promise<VersionMeta[]> {
  return (await allOf(fontId)).sort((a, b) => b.createdAt - a.createdAt).map(meta);
}

export async function loadVersion(id: string): Promise<FontProject | null> {
  const rec = await get(id);
  if (!rec) return null;
  try { return parseProject(JSON.parse(rec.json)); } catch { return null; }
}

export async function renameVersion(id: string, name: string): Promise<void> {
  const rec = await get(id);
  if (rec && name.trim()) await put({ ...rec, name: name.trim(), auto: false });
}

export async function deleteVersion(id: string): Promise<void> { await del(id); }

export async function deleteVersionsOf(fontId: string): Promise<void> {
  for (const v of await allOf(fontId)) await del(v.id);
}

/** A never-saved font was saved to the library: carry its versions over. */
export async function moveVersions(from: string, to: string): Promise<void> {
  if (from === to) return;
  for (const v of await allOf(from)) await put({ ...v, fontId: to });
}

export interface ProjectDiff { added: string[]; removed: string[]; changed: string[]; effects: boolean; metrics: boolean; spacing: boolean; name: boolean }

/** What differs between two states of a font: `added` = letters in `b` that `a` lacks. */
export function diffProjects(a: FontProject, b: FontProject): ProjectDiff {
  const ink = (g: Glyph | undefined) => !!g && ((g.strokes?.some((s) => s.points.length) ?? false) || (g.contours?.some((c) => c.points.length >= 3) ?? false));
  const added: string[] = [], removed: string[] = [], changed: string[] = [];
  for (const ch of new Set([...Object.keys(a.glyphs), ...Object.keys(b.glyphs)])) {
    const ga = a.glyphs[ch], gb = b.glyphs[ch];
    const ia = ink(ga), ib = ink(gb);
    if (!ia && ib) added.push(ch);
    else if (ia && !ib) removed.push(ch);
    else if (ia && ib && JSON.stringify(ga) !== JSON.stringify(gb)) changed.push(ch);
  }
  const s = (v: unknown) => JSON.stringify(v ?? null);
  return {
    added: added.sort(), removed: removed.sort(), changed: changed.sort(),
    effects: s(a.fx) !== s(b.fx) || s(a.color) !== s(b.color),
    metrics: s(a.metrics) !== s(b.metrics),
    spacing: s(a.kerning) !== s(b.kerning) || s(a.spacing) !== s(b.spacing),
    name: a.name !== b.name,
  };
}

/** Test helper: forget the in-memory versions. */
export function _resetMemoryVersions(): void { mem.clear(); }
