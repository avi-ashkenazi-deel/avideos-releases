/**
 * Teleprompter remote.
 *
 * Joins the session's LiveKit room via the same join endpoint (as "Prompter"),
 * publishes no media, and exchanges data messages with the host's Mac app:
 *
 *   host -> prompter : {type:"prompter-state", sections:[{id,title}],
 *                       playing:boolean, speed:number, activeSectionId?}
 *   prompter -> host : {type:"prompter", cmd:"play"|"pause", value?:undefined}
 *                      {type:"prompter", cmd:"speed", value:+0.1|-0.1}
 *                      {type:"prompter", cmd:"jump", value:sectionId}
 *
 * URL contract: prompter.html?room=SESSIONID&api=WORKER_ORIGIN
 */
import { Room, RoomEvent } from "livekit-client";

const $ = (id) => document.getElementById(id);
const els = {
  errorBanner: $("error-banner"),
  errorText: $("error-text"),
  errorDismiss: $("error-dismiss"),
  connState: $("conn-state"),
  sectionState: $("section-state"),
  playBtn: $("play-btn"),
  speedDown: $("speed-down"),
  speedUp: $("speed-up"),
  speedValue: $("speed-value"),
  sectionSelect: $("section-select"),
};

function showError(message, sticky = false) {
  console.error("[prompter]", message);
  els.errorText.textContent = message;
  els.errorBanner.classList.remove("hidden");
  if (!sticky) setTimeout(() => els.errorBanner.classList.add("hidden"), 10_000);
}
els.errorDismiss.addEventListener("click", () => els.errorBanner.classList.add("hidden"));

const params = new URLSearchParams(location.search);
const sessionId = (params.get("room") || "").toLowerCase();
const api = (params.get("api") || "").replace(/\/+$/, "");

let room = null;
let state = { playing: false, speed: 1.0, sections: [], activeSectionId: null };

function send(cmd, value) {
  if (!room || room.state !== "connected") {
    showError("Not connected to the session yet.");
    return;
  }
  const payload = new TextEncoder().encode(JSON.stringify({ type: "prompter", cmd, value }));
  room.localParticipant.publishData(payload, { reliable: true }).catch((err) => {
    showError(`Could not send command: ${err.message}`);
  });
}

function renderState() {
  const controls = [els.playBtn, els.speedDown, els.speedUp, els.sectionSelect];
  for (const c of controls) c.disabled = false;

  els.playBtn.textContent = state.playing ? "⏸ Pause" : "▶ Play";
  els.playBtn.classList.toggle("playing", state.playing);
  els.speedValue.textContent = `${state.speed.toFixed(1)}×`;

  els.sectionSelect.innerHTML = "";
  if (state.sections.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No sections yet";
    els.sectionSelect.appendChild(opt);
    els.sectionSelect.disabled = true;
    els.sectionState.textContent = "no script loaded";
  } else {
    for (const section of state.sections) {
      const opt = document.createElement("option");
      opt.value = section.id;
      opt.textContent = section.title;
      els.sectionSelect.appendChild(opt);
    }
    if (state.activeSectionId) els.sectionSelect.value = state.activeSectionId;
    const active = state.sections.find((s) => s.id === state.activeSectionId);
    els.sectionState.textContent = active ? `on: ${active.title}` : `${state.sections.length} sections`;
  }
}

function onData(payload) {
  let msg;
  try {
    msg = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return;
  }
  if (msg.type !== "prompter-state") return;
  state = {
    playing: !!msg.playing,
    speed: typeof msg.speed === "number" ? msg.speed : state.speed,
    sections: Array.isArray(msg.sections) ? msg.sections.filter((s) => s && s.id != null) : [],
    activeSectionId: msg.activeSectionId ?? null,
  };
  renderState();
}

els.playBtn.addEventListener("click", () => {
  send(state.playing ? "pause" : "play");
  // Optimistic flip; the authoritative state comes back via prompter-state.
  state.playing = !state.playing;
  renderState();
});
els.speedDown.addEventListener("click", () => send("speed", -0.1));
els.speedUp.addEventListener("click", () => send("speed", 0.1));
els.sectionSelect.addEventListener("change", () => {
  if (els.sectionSelect.value) send("jump", els.sectionSelect.value);
});

(async function boot() {
  if (!/^[0-9a-z]{6,20}$/.test(sessionId) || !/^https:\/\//i.test(api)) {
    showError("This link is missing session information (?room=…&api=…).", true);
    return;
  }
  try {
    const res = await fetch(`${api}/v1/sessions/${sessionId}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Prompter" }),
    });
    if (res.status === 404) throw new Error("Session not found. Ask for a fresh link.");
    if (!res.ok) throw new Error(`join failed (${res.status})`);
    const joined = await res.json();

    room = new Room();
    room
      .on(RoomEvent.DataReceived, onData)
      .on(RoomEvent.ConnectionStateChanged, (s) => {
        els.connState.textContent = s;
        els.connState.dataset.state = s;
      })
      .on(RoomEvent.Disconnected, () => showError("Disconnected. Reload to reconnect.", true));

    await room.connect(joined.livekitUrl, joined.token);
    els.connState.textContent = "connected";
    els.connState.dataset.state = "connected";
    // Ask the host for the current state on arrival.
    send("sync");
  } catch (err) {
    showError(err.message, true);
  }
})();
