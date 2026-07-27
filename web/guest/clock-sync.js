/**
 * NTP-style clock synchronisation against the worker's GET /v1/time.
 *
 * Takes 5 sequential samples, keeps the one with the lowest round-trip time
 * (least queueing noise) and estimates:
 *   offset = serverTimeMs - (tSend + rtt / 2)
 * so that `Date.now() + offsetMs` approximates the server clock. The session
 * clock is what every recorder anchor and chunk-timeline entry is expressed
 * in, letting the Mac app align tracks from independent machines.
 */

const SAMPLE_COUNT = 5;
const RESAMPLE_INTERVAL_MS = 5 * 60 * 1000;

export class SessionClock {
  /**
   * @param {string} apiOrigin worker origin, e.g. "https://streamit-worker.x.workers.dev"
   */
  constructor(apiOrigin) {
    this.apiOrigin = apiOrigin.replace(/\/+$/, "");
    /** Estimated server-minus-local offset in ms. */
    this.offsetMs = 0;
    /** Half the best observed RTT — the error bound of the estimate. */
    this.uncertaintyMs = Infinity;
    this.lastSyncAt = 0;
    this._timer = null;
  }

  /** Current session time in ms (server clock estimate). */
  now() {
    return Date.now() + this.offsetMs;
  }

  /**
   * Take SAMPLE_COUNT sequential samples and adopt the min-RTT one.
   * Throws if every sample fails (e.g. network down).
   */
  async sync() {
    let best = null;
    let lastError = null;
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      try {
        const tSend = Date.now();
        const res = await fetch(`${this.apiOrigin}/v1/time`, { cache: "no-store" });
        const tRecv = Date.now();
        if (!res.ok) throw new Error(`time endpoint returned ${res.status}`);
        const body = await res.json();
        if (typeof body.serverTimeMs !== "number") throw new Error("bad time payload");
        const rtt = tRecv - tSend;
        const offset = body.serverTimeMs - (tSend + rtt / 2);
        if (!best || rtt < best.rtt) best = { rtt, offset };
      } catch (err) {
        lastError = err;
      }
    }
    if (!best) {
      throw new Error(`clock sync failed: ${lastError ? lastError.message : "no samples"}`);
    }
    this.offsetMs = best.offset;
    this.uncertaintyMs = best.rtt / 2;
    this.lastSyncAt = Date.now();
    return { offsetMs: this.offsetMs, uncertaintyMs: this.uncertaintyMs };
  }

  /** Re-run sync(); errors are swallowed (previous estimate is kept). */
  async resample() {
    try {
      await this.sync();
    } catch {
      /* keep previous estimate */
    }
  }

  /** Begin resampling every 5 minutes. Idempotent. */
  startAutoResample() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      this.resample();
    }, RESAMPLE_INTERVAL_MS);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}
