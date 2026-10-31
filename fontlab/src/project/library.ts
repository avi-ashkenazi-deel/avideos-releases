/**
 * Font library: saved projects in the browser.
 *
 * Primary store is IndexedDB (database `fontlab-library`, one object store `fonts`
 * keyed by id, each record a full {@link SavedFont}). When IndexedDB is missing or
 * refuses to open (Node tests, some private-browsing modes) the same records live in
 * a single localStorage key as one JSON blob, so every write is still one atomic
 * setItem. If even localStorage is unusable, an in-memory map keeps the session alive.
 */
import type { FontProject } from '../core/glyph';
import { hashString } from '../core/prng';
import { parseProject, serializeProject } from './schema';
import { loadLocal } from './storage';

export interface FontMeta {
  id: string;
  name: string;
  updatedAt: number;
  createdAt: number;
  glyphCount: number;
  blocks: string[];
  /** small data URL preview, or '' */
  thumb?: string;
}

export interface SavedFont extends FontMeta {
  project: FontProject;
}

const DB_NAME = 'fontlab-library';
const DB_VERSION = 1;
const STORE = 'fonts';
const LS_LIBRARY_KEY = 'fontlab:library:v1';
const LS_CURRENT_KEY = 'fontlab:library:current';
const LS_MIGRATED_KEY = 'fontlab:library:migrated';

export const QUOTA_MESSAGE = 'Storage full: delete some fonts or export .json';

// ---------------------------------------------------------------------------
// Public API

/** Every saved font's metadata (no project payload), newest first. */
export async function listFonts(): Promise<FontMeta[]> {
  const all = await (await backend()).all();
  return all.map(toMeta).sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Save a project. Without `id` a new font is created; with one, that record is
 * updated in place (name / updatedAt / glyphCount / blocks follow the project).
 */
export async function saveFont(project: FontProject, id?: string, opts: { thumb?: string } = {}): Promise<FontMeta> {
  const b = await backend();
  const fontId = id ?? newId();
  const snapshot = cloneProject(project);
  const rec = await b.mutate(fontId, (existing) => {
    const t = now();
    return buildRecord(fontId, snapshot, {
      createdAt: existing?.createdAt ?? t,
      updatedAt: t,
      thumb: opts.thumb ?? existing?.thumb ?? '',
    });
  });
  return toMeta(rec!);
}

/** The saved project, validated through parseProject, or null when the id is unknown. */
export async function loadFont(id: string): Promise<FontProject | null> {
  const rec = await (await backend()).get(id);
  return rec ? parseProject(rec.project) : null;
}

export async function deleteFont(id: string): Promise<void> {
  await (await backend()).mutate(id, () => null);
  if (getCurrentId() === id) setCurrentId(null);
}

/** Copy a saved font under a new id. Default name: `<name> (copy)`. */
export async function duplicateFont(id: string, newName?: string): Promise<FontMeta> {
  const b = await backend();
  const src = await b.get(id);
  if (!src) throw new Error('Font not found');
  const name = (newName ?? '').trim() || `${src.name} (copy)`;
  const project = cloneProject(src.project);
  project.name = name;
  const copyId = newId();
  const t = now();
  const rec = await b.mutate(copyId, () => buildRecord(copyId, project, { createdAt: t, updatedAt: t, thumb: src.thumb ?? '' }));
  return toMeta(rec!);
}

export async function renameFont(id: string, name: string): Promise<void> {
  const clean = name.trim();
  if (!clean) throw new Error('Name cannot be empty');
  const rec = await (await backend()).mutate(id, (existing) => {
    if (!existing) return null;
    return { ...existing, name: clean, updatedAt: now(), project: { ...existing.project, name: clean } };
  });
  if (!rec) throw new Error('Font not found');
}

/** Which saved font the editor currently has open (null = unsaved / scratch). */
export function setCurrentId(id: string | null): void {
  const s = ls();
  try {
    if (id == null) s?.removeItem(LS_CURRENT_KEY); else s?.setItem(LS_CURRENT_KEY, id);
  } catch { /* ignore: private mode */ }
  memCurrent = id;
}

export function getCurrentId(): string | null {
  const s = ls();
  if (!s) return memCurrent;
  try { return s.getItem(LS_CURRENT_KEY); } catch { return memCurrent; }
}

/**
 * One-time import of the pre-library localStorage autosave (storage.ts `loadLocal`).
 * Runs only while the library is empty and only once per browser; returns the
 * imported font's meta, or null when there was nothing to do.
 */
export async function migrateLegacyAutosave(): Promise<FontMeta | null> {
  if (flag(LS_MIGRATED_KEY)) return null;
  const legacy = loadLocal();
  if (!legacy) return null;
  if ((await listFonts()).length > 0) { setFlag(LS_MIGRATED_KEY); return null; }
  const meta = await saveFont(legacy);
  setFlag(LS_MIGRATED_KEY);
  setCurrentId(meta.id);
  return meta;
}

/** Cheap stable hash of the serialised project, for dirty tracking. */
export function fingerprint(project: FontProject): string {
  return hashString(serializeProject(project)).toString(36);
}

// ---------------------------------------------------------------------------
// Helpers

let memCurrent: string | null = null;
let lastStamp = 0;

/** Date.now(), but strictly increasing within a session so order is never ambiguous. */
function now(): number {
  const t = Date.now();
  lastStamp = t > lastStamp ? t : lastStamp + 1;
  return lastStamp;
}

export function newId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function cloneProject(p: FontProject): FontProject {
  return JSON.parse(serializeProject(p)) as FontProject;
}

function buildRecord(id: string, project: FontProject, t: { createdAt: number; updatedAt: number; thumb: string }): SavedFont {
  return {
    id,
    name: project.name,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    glyphCount: Object.keys(project.glyphs ?? {}).length,
    blocks: [...(project.blocks ?? [])],
    thumb: t.thumb,
    project,
  };
}

function toMeta(r: SavedFont): FontMeta {
  return { id: r.id, name: r.name, updatedAt: r.updatedAt, createdAt: r.createdAt, glyphCount: r.glyphCount, blocks: [...r.blocks], thumb: r.thumb ?? '' };
}

function ls(): Storage | null {
  try {
    const s = (globalThis as { localStorage?: Storage }).localStorage;
    return s ?? null;
  } catch { return null; }
}

export function flag(key: string): boolean {
  try { return ls()?.getItem(key) === '1'; } catch { return false; }
}
export function setFlag(key: string): void {
  try { ls()?.setItem(key, '1'); } catch { /* ignore */ }
}

function isQuotaError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const { name, code, message } = e as { name?: string; code?: number; message?: string };
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' || code === 22 || code === 1014 || /quota/i.test(message ?? '');
}

function storageError(e: unknown): Error {
  if (isQuotaError(e)) return new Error(QUOTA_MESSAGE);
  const msg = e instanceof Error ? e.message : String(e);
  return new Error(`Could not write to the font library: ${msg}`);
}

// ---------------------------------------------------------------------------
// Backends

interface Backend {
  all(): Promise<SavedFont[]>;
  get(id: string): Promise<SavedFont | null>;
  /** Read-modify-write of one record in a single transaction. `fn` returning null deletes. */
  mutate(id: string, fn: (existing: SavedFont | null) => SavedFont | null): Promise<SavedFont | null>;
}

let backendPromise: Promise<Backend> | null = null;

function backend(): Promise<Backend> {
  if (!backendPromise) {
    backendPromise = openIdb().then(
      (db) => idbBackend(db),
      () => localBackend(),
    );
  }
  return backendPromise;
}

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (!idb) { reject(new Error('IndexedDB unavailable')); return; }
    let req: IDBOpenDBRequest;
    try { req = idb.open(DB_NAME, DB_VERSION); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const db = req.result;
      // another tab upgraded the schema: let go so it can proceed; next call reopens
      db.onversionchange = () => { db.close(); backendPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
}

function idbBackend(db: IDBDatabase): Backend {
  const tx = <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore, done: (v: T) => void) => void): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      let result: T;
      let t: IDBTransaction;
      try { t = db.transaction(STORE, mode); } catch (e) { reject(storageError(e)); return; }
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(storageError(t.error));
      t.onabort = () => reject(storageError(t.error ?? new Error('transaction aborted')));
      try { run(t.objectStore(STORE), (v) => { result = v; }); } catch (e) { try { t.abort(); } catch { /* already done */ } reject(storageError(e)); }
    });

  return {
    all: () => tx<SavedFont[]>('readonly', (s, done) => { const r = s.getAll(); r.onsuccess = () => done((r.result ?? []) as SavedFont[]); }),
    get: (id) => tx<SavedFont | null>('readonly', (s, done) => { const r = s.get(id); r.onsuccess = () => done((r.result as SavedFont | undefined) ?? null); }),
    mutate: (id, fn) => tx<SavedFont | null>('readwrite', (s, done) => {
      const r = s.get(id);
      r.onsuccess = () => {
        const next = fn((r.result as SavedFont | undefined) ?? null);
        if (next) s.put(next); else s.delete(id);
        done(next);
      };
    }),
  };
}

function localBackend(): Backend {
  const mem = new Map<string, SavedFont>();
  const read = (): Record<string, SavedFont> => {
    const s = ls();
    if (!s) return Object.fromEntries(mem);
    try {
      const raw = s.getItem(LS_LIBRARY_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, SavedFont> : {};
    } catch { return {}; }
  };
  const write = (fonts: Record<string, SavedFont>): void => {
    const s = ls();
    if (!s) { mem.clear(); for (const [k, v] of Object.entries(fonts)) mem.set(k, v); return; }
    try { s.setItem(LS_LIBRARY_KEY, JSON.stringify(fonts)); } catch (e) { throw storageError(e); }
  };
  return {
    all: async () => Object.values(read()),
    get: async (id) => read()[id] ?? null,
    mutate: async (id, fn) => {
      const fonts = read();
      const next = fn(fonts[id] ?? null);
      if (next) fonts[id] = next; else delete fonts[id];
      write(fonts);
      return next;
    },
  };
}
