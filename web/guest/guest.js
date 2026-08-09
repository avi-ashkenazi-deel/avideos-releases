/**
 * Guest join flow for streamit.
 *
 * URL contract: index.html?room=SESSIONID&api=https://worker-origin
 *
 * Flow: browser gate -> pre-join (name, device pickers, live preview) ->
 * join endpoint -> clock sync -> LiveKit Room connect -> local 4K recording
 * driven by host data messages -> durable chunk uploads.
 *
 * Data-channel contract (JSON, reliable):
 *   host -> guests : {type:"record-start", takeId, sessionTimeMs}
 *                    {type:"record-stop", takeId}
 *                    {type:"on-air", participantId, value}   // call-in gate
 *   guest -> host  : {type:"upload-progress", participantId, pct,
 *                     queuedChunks, uploadedBytes, totalBytes, recording}
 */
import { Room, RoomEvent, Track } from "livekit-client";
import { SessionClock } from "./clock-sync.js";
import { LocalRecorder } from "./recorder.js";
import { ChunkUploader } from "./uploader.js";

const CAPTURE_RESOLUTION = { width: 3840, height: 2160 };
const PROGRESS_INTERVAL_MS = 5000;

// ---------------------------------------------------------------------------
// DOM helpers / element refs
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const els = {
  gate: $("gate"),
  prejoin: $("prejoin"),
  call: $("call"),
  drain: $("drain"),
  errorBanner: $("error-banner"),
  errorText: $("error-text"),
  errorDismiss: $("error-dismiss"),

  name: $("name"),
  micSelect: $("mic-select"),
  camSelect: $("cam-select"),
  preview: $("preview"),
  previewHint: $("preview-hint"),
  joinBtn: $("join-btn"),

  localVideo: $("local-video"),
  hostAudio: $("host-audio"),
  enableAudioBtn: $("enable-audio"),
  recIndicator: $("rec-indicator"),
  onAirIndicator: $("onair-indicator"),
  stageStatus: $("stage-status"),
  connState: $("conn-state"),
  uploadBar: $("upload-bar"),
  uploadLabel: $("upload-label"),
  diskWarning: $("disk-warning"),
  micBtn: $("mic-btn"),
  camBtn: $("cam-btn"),
  screenBtn: $("screen-btn"),
  leaveBtn: $("leave-btn"),

  drainBar: $("drain-bar"),
  drainLabel: $("drain-label"),
};

function show(el) {
  el.classList.remove("hidden");
}
function hide(el) {
  el.classList.add("hidden");
}

let errorTimer = null;
function showError(message, sticky = false) {
  console.error("[guest]", message);
  els.errorText.textContent = message;
  show(els.errorBanner);
  if (errorTimer) clearTimeout(errorTimer);
  if (!sticky) errorTimer = setTimeout(() => hide(els.errorBanner), 10_000);
}
els.errorDismiss.addEventListener("click", () => hide(els.errorBanner));

// ---------------------------------------------------------------------------
// URL params + browser gate
// ---------------------------------------------------------------------------

const params = new URLSearchParams(location.search);
const sessionId = (params.get("room") || "").toLowerCase();
const api = (params.get("api") || "").replace(/\/+$/, "");

/** Chromium check: recording relies on MediaRecorder webm/vp9 behaviour. */
function isChromiumBased() {
  if (navigator.userAgentData && Array.isArray(navigator.userAgentData.brands)) {
    return navigator.userAgentData.brands.some((b) => /Chromium/i.test(b.brand));
  }
  const ua = navigator.userAgent;
  // Chrome, Edge, Opera, Brave all carry Chrome/ and are Chromium-based.
  // Safari carries Version/..Safari, Firefox carries Firefox/.
  return /Chrome\/\d+/.test(ua) && !/Firefox\//.test(ua);
}

function validParams() {
  return /^[0-9a-z]{6,20}$/.test(sessionId) && /^https:\/\/[^\s]+$/i.test(api);
}

// ---------------------------------------------------------------------------
// Pre-join: preview + device pickers
// ---------------------------------------------------------------------------

let previewStream = null;

async function startPreview(camId, micId) {
  stopPreview();
  const constraints = {
    video: {
      deviceId: camId ? { exact: camId } : undefined,
      width: { ideal: CAPTURE_RESOLUTION.width },
      height: { ideal: CAPTURE_RESOLUTION.height },
    },
    audio: {
      deviceId: micId ? { exact: micId } : undefined,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  };
  previewStream = await navigator.mediaDevices.getUserMedia(constraints);
  els.preview.srcObject = previewStream;
  const vs = previewStream.getVideoTracks()[0]?.getSettings() ?? {};
  els.previewHint.textContent = vs.width ? `Camera preview — ${vs.width}×${vs.height}` : "Camera preview";
}

function stopPreview() {
  if (previewStream) {
    for (const t of previewStream.getTracks()) t.stop();
    previewStream = null;
  }
  els.preview.srcObject = null;
}

async function populateDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const fill = (select, kind) => {
    const current = select.value;
    select.innerHTML = "";
    let i = 1;
    for (const d of devices.filter((x) => x.kind === kind)) {
      const opt = document.createElement("option");
      opt.value = d.deviceId;
      opt.textContent = d.label || `${kind === "videoinput" ? "Camera" : "Microphone"} ${i++}`;
      select.appendChild(opt);
    }
    if (current && [...select.options].some((o) => o.value === current)) select.value = current;
  };
  fill(els.micSelect, "audioinput");
  fill(els.camSelect, "videoinput");
}

async function initPrejoin() {
  try {
    await startPreview();
    await populateDevices();
  } catch (err) {
    showError(
      err.name === "NotAllowedError"
        ? "Camera and microphone access was denied. Allow access in the address bar and reload."
        : `Could not open camera/microphone: ${err.message}`,
      true,
    );
    return;
  }
  const restart = () =>
    startPreview(els.camSelect.value, els.micSelect.value).catch((err) =>
      showError(`Could not switch device: ${err.message}`),
    );
  els.camSelect.addEventListener("change", restart);
  els.micSelect.addEventListener("change", restart);
  navigator.mediaDevices.addEventListener?.("devicechange", () => populateDevices().catch(() => {}));
  els.joinBtn.disabled = false;
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

/** @type {Room|null} */ let room = null;
/** @type {SessionClock|null} */ let clock = null;
/** @type {ChunkUploader|null} */ let uploader = null;
/** @type {LocalRecorder|null} */ let recorder = null;
let participantId = null;
let progressTimer = null;
let leaving = false;

function chunkKey(takeId, kind, name) {
  return `sessions/${sessionId}/${participantId}/${takeId}/${kind}/${name}`;
}

/** POST a manifest merge patch with the upload grant; retries once. */
async function postManifest(patch) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${api}/v1/sessions/${sessionId}/manifest`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-upload-grant": uploader.uploadGrant },
        body: JSON.stringify(patch),
      });
      if (res.ok) return true;
      if (res.status < 500 && res.status !== 429) break; // won't heal on retry
    } catch {
      /* network hiccup — retry once */
    }
    await new Promise((r) => setTimeout(r, 750));
  }
  showError("Could not update the session manifest. The host may need your take info again.");
  return false;
}

function sendData(obj) {
  if (!room || room.state !== "connected") return;
  const payload = new TextEncoder().encode(JSON.stringify(obj));
  room.localParticipant.publishData(payload, { reliable: true }).catch(() => {});
}

function startProgressTicker() {
  if (progressTimer) return;
  progressTimer = setInterval(() => {
    const recording = !!(recorder && recorder.active);
    if (!recording && uploader.queuedChunks === 0) {
      clearInterval(progressTimer);
      progressTimer = null;
      return;
    }
    const pct =
      uploader.totalBytes === 0
        ? 100
        : Math.min(100, Math.round((uploader.uploadedBytes / uploader.totalBytes) * 100));
    sendData({
      type: "upload-progress",
      participantId,
      pct,
      queuedChunks: uploader.queuedChunks,
      uploadedBytes: uploader.uploadedBytes,
      totalBytes: uploader.totalBytes,
      recording,
    });
  }, PROGRESS_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Recording control (driven by host data messages)
// ---------------------------------------------------------------------------

function setRecordingUi(on) {
  els.recIndicator.classList.toggle("on", on);
  els.recIndicator.textContent = on ? "REC" : "standby";
  // Toggling devices mid-take would corrupt the local recording (the same
  // tracks feed the MediaRecorders), so lock the toggles while recording.
  els.micBtn.disabled = on;
  els.camBtn.disabled = on;
  els.micBtn.title = on ? "Locked while recording" : "";
  els.camBtn.title = on ? "Locked while recording" : "";
}

async function onRecordStart(msg) {
  if (!recorder || recorder.active) return;
  const takeId = String(msg.takeId);
  try {
    const info = await recorder.start(takeId);
    setRecordingUi(true);
    startProgressTicker();
    // Anchor patches — the take row itself (startedAtSession) comes from the
    // host's clock via the data message.
    await postManifest({
      take: { id: takeId, ...(typeof msg.sessionTimeMs === "number" ? { startedAtSession: msg.sessionTimeMs } : {}) },
    });
    await postManifest({
      track: { participantId, takeId, kind: "audio", anchor: info.audio.anchor, mimeType: info.audio.mimeType },
    });
    await postManifest({
      track: {
        participantId,
        takeId,
        kind: "video",
        anchor: info.video.anchor,
        mimeType: info.video.mimeType,
        width: info.video.width,
        height: info.video.height,
      },
    });
  } catch (err) {
    showError(`Recording could not start: ${err.message}`, true);
    sendData({ type: "record-error", participantId, takeId, message: err.message });
  }
}

async function onRecordStop(msg) {
  if (!recorder || !recorder.active) return;
  try {
    const summary = await recorder.stop();
    setRecordingUi(false);
    for (const t of summary.tracks) {
      await postManifest({
        track: {
          participantId,
          takeId: summary.takeId,
          kind: t.kind,
          chunkCount: t.chunkCount,
          chunkTimeline: t.chunkTimeline,
          finalized: true,
        },
      });
    }
  } catch (err) {
    setRecordingUi(false);
    showError(`Recording stop failed: ${err.message}`, true);
    sendData({ type: "record-error", participantId, takeId: msg.takeId, message: err.message });
  }
}

function onDataReceived(payload) {
  let msg;
  try {
    msg = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return;
  }
  switch (msg.type) {
    case "record-start":
      onRecordStart(msg);
      break;
    case "record-stop":
      onRecordStop(msg);
      break;
    case "on-air":
      // Broadcast to the whole room; only our own gate state applies.
      if (msg.participantId === participantId) setOnAir(msg.value === true);
      break;
    default:
      break; // prompter-* etc. are not for us
  }
}

/**
 * The call-in gate badge. Off air means the host sees and hears you in the
 * Guests panel but you are NOT on the program; local recording is unaffected
 * (podcast takes capture waiting guests too — that is by design).
 */
function setOnAir(on) {
  els.onAirIndicator.classList.toggle("on", on);
  els.onAirIndicator.textContent = on ? "ON AIR" : "off air";
  els.stageStatus.textContent = on
    ? "You're on the air."
    : "You're connected — the host will bring you in.";
}

// ---------------------------------------------------------------------------
// Join
// ---------------------------------------------------------------------------

async function join() {
  const name = els.name.value.trim();
  if (!name) {
    showError("Please enter your name first.");
    els.name.focus();
    return;
  }
  els.joinBtn.disabled = true;
  els.joinBtn.textContent = "Joining…";

  try {
    // 1) join endpoint
    const res = await fetch(`${api}/v1/sessions/${sessionId}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (res.status === 404) throw new Error("This session no longer exists. Ask the host for a fresh link.");
    if (!res.ok) throw new Error(`join failed (${res.status})`);
    const joined = await res.json();
    participantId = joined.participantId;

    // 2) clock sync (seeded roughly by serverTimeMs, refined by /v1/time)
    clock = new SessionClock(api);
    await clock.sync();
    clock.startAutoResample();

    // 3) durable uploader
    uploader = await new ChunkUploader({
      api,
      sessionId,
      participantId,
      uploadGrant: joined.uploadGrant,
    }).init();
    uploader.addEventListener("progress", (e) => updateUploadUi(e.detail));
    uploader.addEventListener("error", (e) => showError(e.detail.message, e.detail.fatal));

    // 4) LiveKit room — reacquire devices at native/4K using picked ids
    const camId = els.camSelect.value || undefined;
    const micId = els.micSelect.value || undefined;
    stopPreview();

    room = new Room({
      adaptiveStream: true,
      dynacast: true,
      videoCaptureDefaults: {
        deviceId: camId,
        resolution: { width: CAPTURE_RESOLUTION.width, height: CAPTURE_RESOLUTION.height, frameRate: 30 },
      },
      audioCaptureDefaults: {
        deviceId: micId,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    room
      .on(RoomEvent.DataReceived, onDataReceived)
      .on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
        if (participant.identity === "host" && track.kind === Track.Kind.Audio) {
          track.attach(els.hostAudio);
        }
      })
      .on(RoomEvent.TrackUnsubscribed, (track) => track.detach())
      // The browser's own "Stop sharing" bar can end a screen share without
      // our button — track the real publish state, not our last click.
      .on(RoomEvent.LocalTrackPublished, refreshScreenButton)
      .on(RoomEvent.LocalTrackUnpublished, refreshScreenButton)
      .on(RoomEvent.AudioPlaybackStatusChanged, () => {
        room.canPlaybackAudio ? hide(els.enableAudioBtn) : show(els.enableAudioBtn);
      })
      .on(RoomEvent.ConnectionStateChanged, (state) => {
        els.connState.textContent = state;
        els.connState.dataset.state = state;
      })
      .on(RoomEvent.Disconnected, () => {
        if (!leaving) showError("Disconnected from the session. Reload to rejoin — queued uploads are safe.", true);
      });

    await room.connect(joined.livekitUrl, joined.token);
    await room.localParticipant.enableCameraAndMicrophone();

    // 5) local preview + recorder over the exact published tracks
    const camPub = room.localParticipant.getTrackPublication(Track.Source.Camera);
    const micPub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (!camPub?.track || !micPub?.track) throw new Error("camera/microphone failed to publish");
    camPub.track.attach(els.localVideo);

    recorder = new LocalRecorder({
      audioTrack: micPub.track.mediaStreamTrack,
      videoTrack: camPub.track.mediaStreamTrack,
      clock,
      onChunk: (takeId, kind, chunkName, blob) => {
        uploader.enqueue(blob, chunkKey(takeId, kind, chunkName)).catch((err) => {
          showError(`Could not store a recording chunk locally: ${err.message}`, true);
        });
      },
    });
    recorder.addEventListener("disk-warning", (e) => {
      els.diskWarning.textContent = e.detail.message;
      show(els.diskWarning);
    });
    recorder.addEventListener("error", (e) => {
      showError(`Recorder (${e.detail.kind}): ${e.detail.message}`, true);
      sendData({ type: "record-error", participantId, message: e.detail.message });
    });
    // The screen lane records locally at full quality whenever a share runs
    // during a take — its manifest patches mirror the camera's.
    recorder.addEventListener("screen-started", (e) => {
      const d = e.detail;
      postManifest({
        track: {
          participantId,
          takeId: d.takeId,
          kind: "screen",
          anchor: d.anchor,
          mimeType: d.mimeType,
          width: d.width,
          height: d.height,
        },
      }).catch(() => {});
    });
    recorder.addEventListener("screen-stopped", (e) => {
      const d = e.detail;
      postManifest({
        track: {
          participantId,
          takeId: d.takeId,
          kind: "screen",
          chunkCount: d.track.chunkCount,
          chunkTimeline: d.track.chunkTimeline,
          finalized: true,
        },
      }).catch(() => {});
    });

    hide(els.prejoin);
    show(els.call);
    setRecordingUi(false);
    startProgressTicker(); // covers recovered pending uploads
  } catch (err) {
    showError(err.message, true);
    els.joinBtn.disabled = false;
    els.joinBtn.textContent = "Join session";
  }
}

// ---------------------------------------------------------------------------
// In-call UI
// ---------------------------------------------------------------------------

function updateUploadUi({ pct, queuedChunks, uploadedBytes, totalBytes }) {
  els.uploadBar.style.width = `${pct}%`;
  const mb = (n) => (n / (1024 * 1024)).toFixed(1);
  els.uploadLabel.textContent =
    queuedChunks === 0 ? "All uploads complete" : `Uploading ${mb(uploadedBytes)} / ${mb(totalBytes)} MB — ${queuedChunks} chunks queued`;
  if (!els.drain.classList.contains("hidden")) {
    els.drainBar.style.width = `${pct}%`;
    els.drainLabel.textContent =
      queuedChunks === 0
        ? "All uploads complete. You can close this tab."
        : `Finishing uploads… ${pct}% (${queuedChunks} chunks left)`;
  }
}

els.enableAudioBtn.addEventListener("click", () => {
  room?.startAudio().then(() => hide(els.enableAudioBtn)).catch(() => {});
});

els.micBtn.addEventListener("click", async () => {
  if (!room) return;
  const enabled = room.localParticipant.isMicrophoneEnabled;
  try {
    await room.localParticipant.setMicrophoneEnabled(!enabled);
    els.micBtn.classList.toggle("off", enabled);
    els.micBtn.textContent = enabled ? "Unmute mic" : "Mute mic";
  } catch (err) {
    showError(`Microphone toggle failed: ${err.message}`);
  }
});

els.camBtn.addEventListener("click", async () => {
  if (!room) return;
  const enabled = room.localParticipant.isCameraEnabled;
  try {
    await room.localParticipant.setCameraEnabled(!enabled);
    els.camBtn.classList.toggle("off", enabled);
    els.camBtn.textContent = enabled ? "Start camera" : "Stop camera";
  } catch (err) {
    showError(`Camera toggle failed: ${err.message}`);
  }
});

/** Reflect the actual publish state — the browser's own "Stop sharing" bar
 * can end the share without us, so always read back from the participant.
 * Also hands the live screen track to the local recorder: mid-take, a share
 * starting/ending starts/finalizes the full-quality "screen" recording. */
function refreshScreenButton() {
  const on = room?.localParticipant.isScreenShareEnabled === true;
  els.screenBtn.classList.toggle("on", on);
  els.screenBtn.textContent = on ? "Stop sharing" : "Share screen";
  const pub = room?.localParticipant.getTrackPublication(Track.Source.ScreenShare);
  recorder?.setScreenTrack(on ? (pub?.track?.mediaStreamTrack ?? null) : null);
}

els.screenBtn.addEventListener("click", async () => {
  if (!room) return;
  const enabled = room.localParticipant.isScreenShareEnabled;
  try {
    // Second video track, marked as a screen-share source; the studio gives
    // it its own tile and takes the interview stage with it.
    await room.localParticipant.setScreenShareEnabled(!enabled);
  } catch (err) {
    // Cancelling the browser's picker rejects — that's a choice, not an error.
    if (err.name !== "NotAllowedError") {
      showError(`Screen share failed: ${err.message}`);
    }
  }
  refreshScreenButton();
});

els.leaveBtn.addEventListener("click", async () => {
  if (recorder && recorder.active) {
    if (!confirm("Recording is in progress. Leave anyway? Your local recording will be finalized first.")) {
      return;
    }
    await onRecordStop({ takeId: recorder.takeId });
  }
  leaving = true;
  try {
    await room?.disconnect();
  } catch {
    /* ignore */
  }
  hide(els.call);
  if (uploader && uploader.queuedChunks > 0) {
    show(els.drain);
    updateUploadUi({
      pct: Math.round((uploader.uploadedBytes / Math.max(1, uploader.totalBytes)) * 100),
      queuedChunks: uploader.queuedChunks,
      uploadedBytes: uploader.uploadedBytes,
      totalBytes: uploader.totalBytes,
    });
    uploader.addEventListener("drained", () => {
      els.drainBar.style.width = "100%";
      els.drainLabel.textContent = "All uploads complete. You can close this tab.";
    });
  } else {
    show(els.drain);
    els.drainBar.style.width = "100%";
    els.drainLabel.textContent = "You left the session. All uploads are complete — you can close this tab.";
  }
});

els.joinBtn.addEventListener("click", join);
els.name.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !els.joinBtn.disabled) join();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async function boot() {
  if (!isChromiumBased()) {
    show(els.gate);
    return;
  }
  if (!validParams()) {
    show(els.prejoin);
    els.joinBtn.disabled = true;
    showError(
      "This link is missing session information (?room=…&api=…). Ask the host to resend the invite link.",
      true,
    );
    return;
  }
  show(els.prejoin);

  // Resume any uploads left over from a previous visit (crash/reload).
  ChunkUploader.recoverPending()
    .then((ups) => {
      for (const up of ups) {
        up.addEventListener("progress", (e) => updateUploadUi(e.detail));
        up.addEventListener("error", (e) => showError(e.detail.message, e.detail.fatal));
      }
      if (ups.some((u) => u.queuedChunks > 0)) {
        showError("Resuming uploads from your previous session in the background.");
      }
    })
    .catch(() => {});

  await initPrejoin();
})();
