/**
 * Local high-quality recorder.
 *
 * Runs MediaRecorders over the exact MediaStreamTracks LiveKit is
 * publishing (so what the host hears/sees live is what gets recorded):
 *   - "audio": audio/webm;codecs=opus @ 256 kbps — always
 *   - "video": video/webm;codecs=vp9 (vp8 fallback) at the camera's native
 *     resolution, bitrate tiered by actual height:
 *       >= 2160p: 40 Mbps, >= 1080p: 12 Mbps, else 8 Mbps
 *   - "screen": same video treatment over the screen-share track, whenever
 *     one is being shared. Unlike the other two it can start and stop
 *     MID-TAKE (shares do); each start records its own anchor, so the
 *     import aligns it like any other track.
 *
 * Chunks are cut every 5 s (timeslice 5000) and handed to the caller via
 * onChunk(takeId, kind, name, blob) where name is "000000.webm",
 * "000001.webm", ... or "meta.json".
 *
 * Sync model: at MediaRecorder "start" each kind captures an anchor
 * {mediaTimeMs: 0, sessionTimeMs: clock.now()} — media time zero equals that
 * session-clock instant. Every 6th chunk (~30 s) a {chunkIndex, sessionTimeMs}
 * pair is appended to chunkTimeline so drift is measurable. On stop, all
 * recorders flush, and a meta.json per kind (anchor, chunkTimeline,
 * chunkCount, mimeType, width/height) is emitted through the same onChunk
 * path so it rides the durable upload queue.
 *
 * Events (extends EventTarget):
 *   "disk-warning"   detail {availableBytes, projectedBytes, message}
 *   "error"          detail {kind, message}
 *   "screen-started" detail {takeId, anchor, mimeType, width, height}
 *   "screen-stopped" detail {takeId, track}   // manifest-shaped summary
 */

const TIMESLICE_MS = 5000;
const TIMELINE_EVERY_N_CHUNKS = 6;
const AUDIO_MIME = "audio/webm;codecs=opus";
const AUDIO_BPS = 256_000;
const DISK_PLANNED_SECONDS = 30 * 60; // preflight for a 30-minute take

/** @param {number} height actual capture height */
export function videoBitsPerSecondForHeight(height) {
  if (height >= 2160) return 40_000_000;
  if (height >= 1080) return 12_000_000;
  return 8_000_000;
}

/** Pick the best supported video mimeType (vp9 -> vp8 -> plain webm). */
export function pickVideoMimeType() {
  const candidates = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  for (const c of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
  }
  return null;
}

function pad6(n) {
  return String(n).padStart(6, "0");
}

export class LocalRecorder extends EventTarget {
  /**
   * @param {{
   *   audioTrack: MediaStreamTrack,
   *   videoTrack: MediaStreamTrack,
   *   clock: {now(): number},
   *   onChunk: (takeId: string, kind: "audio"|"video", name: string, blob: Blob) => void
   * }} opts
   */
  constructor({ audioTrack, videoTrack, clock, onChunk }) {
    super();
    this.audioTrack = audioTrack;
    this.videoTrack = videoTrack;
    /** The live screen-share track, when one exists (set via setScreenTrack). */
    this.screenTrack = null;
    this.clock = clock;
    this.onChunk = onChunk;
    this.takeId = null;
    /** @type {Record<string, object>|null} per-kind runtime state */
    this._state = null;
  }

  /**
   * Tell the recorder which screen-share track is live (null when the share
   * ends). Mid-take this starts/stops the "screen" recording immediately;
   * between takes it just remembers the track for the next start().
   */
  setScreenTrack(track) {
    this.screenTrack = track || null;
    if (!this.active) return;
    if (this.screenTrack && !this._state.screen) {
      this._startScreen(this.takeId);
    } else if (!this.screenTrack && this._state.screen) {
      this._finishScreen();
    }
  }

  get active() {
    return this._state !== null;
  }

  /**
   * Preflight: compare projected recording size against storage estimate.
   * Emits "disk-warning" when the projection exceeds 80% of available space.
   */
  async checkDiskSpace(videoBps, plannedSeconds = DISK_PLANNED_SECONDS) {
    if (!navigator.storage || !navigator.storage.estimate) return { ok: true };
    try {
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      const availableBytes = Math.max(0, quota - usage);
      const projectedBytes = ((videoBps + AUDIO_BPS) / 8) * plannedSeconds;
      const ok = projectedBytes < availableBytes * 0.8;
      if (!ok) {
        this.dispatchEvent(
          new CustomEvent("disk-warning", {
            detail: {
              availableBytes,
              projectedBytes,
              message:
                "Your browser may not have enough local storage for a long recording. " +
                "Free up disk space or keep takes short — chunks are removed as they upload.",
            },
          }),
        );
      }
      return { ok, availableBytes, projectedBytes };
    } catch {
      return { ok: true };
    }
  }

  /**
   * Start both recorders for a take. Resolves once both MediaRecorders have
   * fired "start" — anchors are populated when this returns.
   * @param {string} takeId
   */
  async start(takeId) {
    if (this.active) throw new Error("recorder already active");
    if (!window.MediaRecorder) throw new Error("MediaRecorder is not supported in this browser");
    if (!MediaRecorder.isTypeSupported(AUDIO_MIME)) {
      throw new Error("audio/webm;codecs=opus is not supported in this browser");
    }
    const videoMime = pickVideoMimeType();
    if (!videoMime) throw new Error("webm video recording is not supported in this browser");

    const settings = this.videoTrack.getSettings();
    const width = settings.width ?? 0;
    const height = settings.height ?? 0;
    const videoBps = videoBitsPerSecondForHeight(height);

    this.takeId = takeId;
    this._state = {
      audio: this._makeKindState("audio", takeId, new MediaRecorder(new MediaStream([this.audioTrack]), {
        mimeType: AUDIO_MIME,
        audioBitsPerSecond: AUDIO_BPS,
      }), { mimeType: AUDIO_MIME }),
      video: this._makeKindState("video", takeId, new MediaRecorder(new MediaStream([this.videoTrack]), {
        mimeType: videoMime,
        videoBitsPerSecond: videoBps,
      }), { mimeType: videoMime, width, height, videoBitsPerSecond: videoBps }),
    };

    // Non-blocking disk preflight.
    this.checkDiskSpace(videoBps);

    const started = Promise.all([
      this._state.audio.startedPromise,
      this._state.video.startedPromise,
    ]);
    this._state.audio.recorder.start(TIMESLICE_MS);
    this._state.video.recorder.start(TIMESLICE_MS);
    await started;

    // A share already in progress records from the top of the take. The
    // "screen-started" event carries its manifest patch (same as mid-take).
    if (this.screenTrack) {
      this._startScreen(takeId);
    }

    return {
      takeId,
      audio: { mimeType: AUDIO_MIME, anchor: this._state.audio.anchor },
      video: { mimeType: videoMime, width, height, videoBitsPerSecond: videoBps, anchor: this._state.video.anchor },
    };
  }

  /** Start the "screen" lane over the live share track (take running). */
  _startScreen(takeId) {
    const mime = pickVideoMimeType();
    if (!mime || !this.screenTrack) return;
    const settings = this.screenTrack.getSettings();
    const width = settings.width ?? 0;
    const height = settings.height ?? 0;
    const bps = videoBitsPerSecondForHeight(height || 1080);
    const state = this._makeKindState("screen", takeId,
      new MediaRecorder(new MediaStream([this.screenTrack]), {
        mimeType: mime,
        videoBitsPerSecond: bps,
      }),
      { mimeType: mime, width, height, videoBitsPerSecond: bps });
    this._state.screen = state;
    state.startedPromise.then(() => {
      this.dispatchEvent(new CustomEvent("screen-started", {
        detail: { takeId, anchor: state.anchor, mimeType: mime, width, height },
      }));
    });
    state.recorder.start(TIMESLICE_MS);
  }

  /**
   * Stop and finalize the "screen" lane (share ended mid-take, or the take
   * is stopping). Emits meta.json through the chunk path and a
   * "screen-stopped" event carrying the manifest-shaped summary.
   */
  async _finishScreen() {
    const state = this._state?.screen;
    if (!state) return;
    delete this._state.screen;
    if (state.recorder.state !== "inactive") {
      try {
        state.recorder.stop();
      } catch (err) {
        this.dispatchEvent(
          new CustomEvent("error", { detail: { kind: "screen", message: `stop failed: ${err.message}` } }),
        );
        state._resolveStopped();
      }
    } else {
      state._resolveStopped();
    }
    await state.stoppedPromise;
    const track = this._finishKind(state);
    this.dispatchEvent(new CustomEvent("screen-stopped", {
      detail: { takeId: state.takeId, track },
    }));
  }

  /** Emit a kind's meta.json and return its manifest-shaped summary. */
  _finishKind(state) {
    const meta = {
      takeId: state.takeId,
      kind: state.kind,
      anchor: state.anchor,
      chunkTimeline: state.chunkTimeline,
      chunkCount: state.index,
      mimeType: state.extra.mimeType,
      ...(state.kind === "audio"
        ? { audioBitsPerSecond: AUDIO_BPS }
        : { width: state.extra.width, height: state.extra.height, videoBitsPerSecond: state.extra.videoBitsPerSecond }),
      finalizedAtSession: this.clock.now(),
    };
    try {
      this.onChunk(
        state.takeId,
        state.kind,
        "meta.json",
        new Blob([JSON.stringify(meta, null, 2)], { type: "application/json" }),
      );
    } catch (err) {
      this.dispatchEvent(
        new CustomEvent("error", { detail: { kind: state.kind, message: `meta handoff failed: ${err.message}` } }),
      );
    }
    return {
      kind: state.kind,
      anchor: state.anchor,
      chunkTimeline: state.chunkTimeline,
      chunkCount: state.index,
      mimeType: state.extra.mimeType,
      width: state.extra.width,
      height: state.extra.height,
    };
  }

  /** Build per-kind runtime state and wire recorder events. */
  _makeKindState(kind, takeId, recorder, extra) {
    const state = {
      kind,
      takeId,
      recorder,
      index: 0,
      anchor: null,
      chunkTimeline: [],
      extra,
      startedPromise: null,
      stoppedPromise: null,
      _resolveStarted: null,
      _resolveStopped: null,
    };
    state.startedPromise = new Promise((r) => (state._resolveStarted = r));
    state.stoppedPromise = new Promise((r) => (state._resolveStopped = r));

    recorder.onstart = () => {
      // Media time 0 of this recording == this session-clock instant.
      state.anchor = { mediaTimeMs: 0, sessionTimeMs: this.clock.now() };
      state._resolveStarted();
    };
    recorder.ondataavailable = (event) => {
      if (!event.data || event.data.size === 0) return;
      const chunkIndex = state.index++;
      if (chunkIndex % TIMELINE_EVERY_N_CHUNKS === 0) {
        state.chunkTimeline.push({ chunkIndex, sessionTimeMs: this.clock.now() });
      }
      try {
        // Use the closed-over takeId: stop() nulls this.takeId before the
        // recorder's final dataavailable fires.
        this.onChunk(takeId, kind, `${pad6(chunkIndex)}.webm`, event.data);
      } catch (err) {
        this.dispatchEvent(
          new CustomEvent("error", { detail: { kind, message: `chunk handoff failed: ${err.message}` } }),
        );
      }
    };
    recorder.onerror = (event) => {
      const message = event.error ? event.error.message : "MediaRecorder error";
      this.dispatchEvent(new CustomEvent("error", { detail: { kind, message } }));
      state._resolveStarted();
      state._resolveStopped();
    };
    recorder.onstop = () => state._resolveStopped();
    return state;
  }

  /**
   * Stop every active recorder (audio, video, and the screen lane when a
   * share is running), flush final chunks, emit meta.json per kind and
   * return a per-track summary suitable for manifest patches.
   */
  async stop() {
    if (!this.active) throw new Error("recorder is not active");
    const state = this._state;
    const takeId = this.takeId;
    this._state = null;
    this.takeId = null;

    const kinds = Object.keys(state);
    for (const kind of kinds) {
      const s = state[kind];
      if (s.recorder.state !== "inactive") {
        try {
          s.recorder.stop(); // fires a final dataavailable, then stop
        } catch (err) {
          this.dispatchEvent(
            new CustomEvent("error", { detail: { kind, message: `stop failed: ${err.message}` } }),
          );
          s._resolveStopped();
        }
      } else {
        s._resolveStopped();
      }
    }
    await Promise.all(kinds.map((kind) => state[kind].stoppedPromise));

    return { takeId, tracks: kinds.map((kind) => this._finishKind(state[kind])) };
  }
}
