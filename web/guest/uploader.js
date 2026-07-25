/**
 * Durable chunk uploader.
 *
 * Every recorded blob is written to IndexedDB *before* any network attempt,
 * so a crash, tab close or network loss never loses media. A drain loop then
 * batches presigned-URL requests (20 keys at a time) against
 * POST /v1/sessions/:id/uploads/sign, PUTs blobs with parallelism 2 and
 * 3 exponential-backoff retries each, and deletes rows only after a
 * successful PUT.
 *
 * IndexedDB: db "avideos-uploads", store "chunks",
 * key = "{sessionId}/{participantId}/{takeId}/{kind}/{index}".
 *
 * The upload context (api origin + upload grant) is persisted to
 * localStorage per session/participant so ChunkUploader.recoverPending()
 * can resume leftovers from a previous page load — even after a reload that
 * produced a fresh participantId.
 *
 * Events (extends EventTarget):
 *   "progress" detail {uploadedBytes, totalBytes, queuedChunks, pct}
 *   "drained"  queue reached empty
 *   "error"    detail {message, fatal} — fatal=true means the grant is dead
 */

const DB_NAME = "avideos-uploads";
const STORE = "chunks";
const CTX_PREFIX = "avideos-upload-ctx:";
const SIGN_BATCH = 20;
const PUT_PARALLELISM = 2;
const PUT_RETRIES = 3;
const CTX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** @returns {Promise<IDBDatabase>} */
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "key" });
        store.createIndex("ctxId", "ctxId", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
  });
}

/** Promise wrapper for a single-request IDB transaction. */
function idbRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB request failed"));
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** "sessions/{sid}/{pid}/{take}/{kind}/{name}.webm" -> IDB key per spec. */
function idbKeyFromR2Key(r2Key) {
  return r2Key.replace(/^sessions\//, "").replace(/\.(webm|json)$/, "");
}

export class ChunkUploader extends EventTarget {
  /**
   * @param {{api: string, sessionId: string, participantId: string, uploadGrant: string}} opts
   */
  constructor({ api, sessionId, participantId, uploadGrant }) {
    super();
    this.api = api.replace(/\/+$/, "");
    this.sessionId = sessionId;
    this.participantId = participantId;
    this.uploadGrant = uploadGrant;
    this.ctxId = `${sessionId}/${participantId}`;

    /** @type {Map<string, {key: string, r2Key: string, size: number}>} pending, blobs stay in IDB */
    this.pending = new Map();
    this.totalBytes = 0;
    this.uploadedBytes = 0;
    this._db = null;
    this._draining = false;
    this._stopped = false;
    this._beforeUnload = null;

    // Persist the context so recoverPending() can resume after a reload.
    try {
      localStorage.setItem(
        CTX_PREFIX + this.ctxId,
        JSON.stringify({ api: this.api, sessionId, participantId, uploadGrant, savedAt: Date.now() }),
      );
    } catch {
      /* private mode etc. — recovery just won't survive a reload */
    }
  }

  /** Open the DB and load any leftover rows belonging to this context. */
  async init() {
    this._db = await openDb();
    const tx = this._db.transaction(STORE, "readonly");
    const rows = await idbRequest(tx.objectStore(STORE).index("ctxId").getAll(this.ctxId));
    for (const row of rows) {
      if (!this.pending.has(row.key)) {
        this.pending.set(row.key, { key: row.key, r2Key: row.r2Key, size: row.size });
        this.totalBytes += row.size;
      }
    }
    this._installBeforeUnload();
    if (this.pending.size > 0) this._kickDrain();
    return this;
  }

  get queuedChunks() {
    return this.pending.size;
  }

  /**
   * Durably enqueue a blob for upload.
   * @param {Blob} blob
   * @param {string} r2Key full object key, e.g. "sessions/{sid}/{pid}/{take}/video/000001.webm"
   */
  async enqueue(blob, r2Key) {
    const key = idbKeyFromR2Key(r2Key);
    const record = { key, r2Key, ctxId: this.ctxId, size: blob.size, createdAt: Date.now(), blob };
    const tx = this._db.transaction(STORE, "readwrite");
    await idbRequest(tx.objectStore(STORE).put(record));
    this.pending.set(key, { key, r2Key, size: blob.size });
    this.totalBytes += blob.size;
    this._emitProgress();
    this._kickDrain();
  }

  /** Stop draining (used on fatal grant errors). Pending rows stay in IDB. */
  stop() {
    this._stopped = true;
  }

  _installBeforeUnload() {
    if (this._beforeUnload) return;
    this._beforeUnload = (e) => {
      if (this.pending.size > 0) {
        e.preventDefault();
        e.returnValue = "Recordings are still uploading. Leaving now may delay the upload.";
      }
    };
    window.addEventListener("beforeunload", this._beforeUnload);
  }

  _emitProgress() {
    const pct =
      this.totalBytes === 0 ? 100 : Math.min(100, Math.round((this.uploadedBytes / this.totalBytes) * 100));
    this.dispatchEvent(
      new CustomEvent("progress", {
        detail: {
          uploadedBytes: this.uploadedBytes,
          totalBytes: this.totalBytes,
          queuedChunks: this.pending.size,
          pct,
        },
      }),
    );
  }

  _emitError(message, fatal = false) {
    this.dispatchEvent(new CustomEvent("error", { detail: { message, fatal } }));
  }

  _kickDrain() {
    if (this._draining || this._stopped) return;
    this._draining = true;
    this._drain().finally(() => {
      this._draining = false;
      // New chunks may have arrived while the last batch finished.
      if (this.pending.size > 0 && !this._stopped) this._kickDrain();
    });
  }

  /** Request presigned URLs for a batch of keys. Returns Map(r2Key -> url). */
  async _signBatch(r2Keys) {
    const res = await fetch(`${this.api}/v1/sessions/${this.sessionId}/uploads/sign`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-upload-grant": this.uploadGrant },
      body: JSON.stringify({ keys: r2Keys }),
    });
    if (res.status === 401 || res.status === 403) {
      const err = new Error("upload grant rejected");
      err.fatal = true;
      throw err;
    }
    if (!res.ok) throw new Error(`uploads/sign returned ${res.status}`);
    const body = await res.json();
    return new Map(body.urls.map((u) => [u.key, u.url]));
  }

  /** PUT one record with retries. Returns true on success. */
  async _putOne(entry, url) {
    // Read the blob back from IDB — the in-memory map deliberately holds no
    // blobs, so memory stays bounded regardless of queue depth.
    const tx = this._db.transaction(STORE, "readonly");
    const row = await idbRequest(tx.objectStore(STORE).get(entry.key));
    if (!row) return true; // already gone (uploaded by a recovery drainer)

    for (let attempt = 0; attempt <= PUT_RETRIES; attempt++) {
      try {
        const res = await fetch(url, { method: "PUT", body: row.blob });
        if (res.ok) {
          const dtx = this._db.transaction(STORE, "readwrite");
          await idbRequest(dtx.objectStore(STORE).delete(entry.key));
          this.pending.delete(entry.key);
          this.uploadedBytes += entry.size;
          this._emitProgress();
          return true;
        }
        // 4xx other than 429 won't heal with a retry of the same URL.
        if (res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 408) {
          throw Object.assign(new Error(`PUT returned ${res.status}`), { noRetry: true });
        }
      } catch (err) {
        if (err.noRetry) throw err;
        // network error — fall through to backoff
      }
      if (attempt < PUT_RETRIES) {
        await sleep(500 * 2 ** attempt + Math.random() * 250);
      }
    }
    return false;
  }

  async _drain() {
    let consecutiveFailures = 0;
    while (this.pending.size > 0 && !this._stopped) {
      const batch = [...this.pending.values()].slice(0, SIGN_BATCH);
      let urls;
      try {
        urls = await this._signBatch(batch.map((e) => e.r2Key));
      } catch (err) {
        if (err.fatal) {
          this._emitError("Upload authorisation expired. Chunks are kept locally.", true);
          this.stop();
          return;
        }
        consecutiveFailures++;
        this._emitError(`Could not get upload URLs (${err.message}); retrying.`);
        await sleep(Math.min(60_000, 1000 * 2 ** consecutiveFailures));
        continue;
      }

      let batchHadSuccess = false;
      // Simple worker pool, parallelism PUT_PARALLELISM.
      const queue = [...batch];
      const workers = Array.from({ length: PUT_PARALLELISM }, async () => {
        for (;;) {
          const entry = queue.shift();
          if (!entry) return;
          const url = urls.get(entry.r2Key);
          if (!url) continue;
          try {
            if (await this._putOne(entry, url)) batchHadSuccess = true;
          } catch (err) {
            this._emitError(`Upload of ${entry.key} failed: ${err.message}`);
          }
        }
      });
      await Promise.all(workers);

      if (batchHadSuccess) {
        consecutiveFailures = 0;
      } else {
        consecutiveFailures++;
        await sleep(Math.min(60_000, 1000 * 2 ** consecutiveFailures));
      }
    }
    if (this.pending.size === 0) {
      this.dispatchEvent(new CustomEvent("drained"));
      this._emitProgress();
    }
  }

  /**
   * Resume leftovers from previous page loads. Scans all IDB rows, groups
   * them by session/participant context, and starts a background uploader
   * for every context whose grant is still stored in localStorage.
   *
   * @returns {Promise<ChunkUploader[]>} the recovery uploaders (already draining)
   */
  static async recoverPending() {
    let db;
    try {
      db = await openDb();
    } catch {
      return [];
    }
    const tx = db.transaction(STORE, "readonly");
    const rows = await idbRequest(tx.objectStore(STORE).getAll());
    db.close();

    const ctxIds = new Set(rows.map((r) => r.ctxId));
    const uploaders = [];
    for (const ctxId of ctxIds) {
      let ctx = null;
      try {
        ctx = JSON.parse(localStorage.getItem(CTX_PREFIX + ctxId) ?? "null");
      } catch {
        /* ignore */
      }
      if (!ctx || !ctx.uploadGrant || !ctx.api) continue;
      const uploader = new ChunkUploader({
        api: ctx.api,
        sessionId: ctx.sessionId,
        participantId: ctx.participantId,
        uploadGrant: ctx.uploadGrant,
      });
      await uploader.init();
      uploaders.push(uploader);
    }

    // Garbage-collect stale contexts that have no rows left.
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(CTX_PREFIX)) continue;
        const ctxId = k.slice(CTX_PREFIX.length);
        if (ctxIds.has(ctxId)) continue;
        const ctx = JSON.parse(localStorage.getItem(k) ?? "{}");
        if (!ctx.savedAt || Date.now() - ctx.savedAt > CTX_MAX_AGE_MS) {
          localStorage.removeItem(k);
        }
      }
    } catch {
      /* ignore */
    }
    return uploaders;
  }
}
