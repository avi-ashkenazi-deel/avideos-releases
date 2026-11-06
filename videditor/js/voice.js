// Voice notes: records audio, transcribes live (Web Speech API, where the
// browser has it), and logs "pointing phrases" (this, here, that…) with the
// video time they were spoken, so an agent knows what "this" refers to.
const POINTING = /\b(this|that|these|those|here|there|right here|over here|this one|that one|this part|this bit)\b/gi;

export class VoiceRecorder {
  constructor({ getTime, snapshot }) { this.getTime = getTime; this.snapshot = snapshot; this.reset(); }
  reset() { this.transcript = ''; this.interim = ''; this.visualReferences = []; this.frames = []; this.chunks = []; this.startTime = null; this.recording = false; this.lastPointAt = -1; this.segments = []; this._segStart = {}; this._lastIdx = -1; }
  static supported() { return !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder); }
  static speechSupported() { return !!(window.SpeechRecognition || window.webkitSpeechRecognition); }

  async start(onUpdate) {
    this.reset(); this.onUpdate = onUpdate;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
    this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.rec.start(250);
    this.recording = true; this.startTime = this.getTime();
    this.frames.push({ time: this.startTime, label: 'start of note', dataUrl: this.snapshot() });
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    // Inside the Mac app (or a browser without live speech) the recording is transcribed locally when it
    // stops. Keep a map of recording time → video time so each phrase lands on the cut it was said over.
    this.serverMode = !!window.videditorDesktop || !SR;
    if (this.serverMode) {
      this.t0 = performance.now(); this.timeMap = [[0, this.getTime()]];
      this.mapTimer = setInterval(() => { this.timeMap.push([performance.now() - this.t0, this.getTime()]); }, 100);
      this.interim = ''; this.pending = true;
    }
    if (SR && !this.serverMode) {
      this.sr = new SR(); this.sr.continuous = true; this.sr.interimResults = true; this.sr.lang = navigator.language || 'en-US';
      this.sr.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const text = e.results[i][0].transcript;
          // Each recognizer result is one utterance; remember the video time it started (recognition lags speech by ~0.6s).
          if (this._segStart[i] === undefined) { this._segStart[i] = Math.max(0, this.getTime() - 0.6); this._lastIdx = i; }
          if (e.results[i].isFinal) { this.transcript = (this.transcript + ' ' + text).trim(); this.notePointing(text); if (text.trim()) this.segments.push({ text: text.trim(), start: this._segStart[i], end: this.getTime() }); }
          else { interim += text; this.notePointing(text, true); }
        }
        this.interim = interim; this.onUpdate?.(this);
      };
      this.sr.onerror = () => {}; this.sr.onend = () => { if (this.recording) { try { this.sr.start(); } catch {} } };
      try { this.sr.start(); } catch {}
    }
    this.onUpdate?.(this);
  }
  notePointing(text, interim = false) {
    const t = this.getTime(); const m = text.match(POINTING); if (!m) return;
    // One reference per ~0.8s of video time to avoid duplicates from interim results.
    if (Math.abs(t - this.lastPointAt) < 0.8) return;
    this.lastPointAt = t;
    this.visualReferences.push({ phrase: m[m.length - 1].toLowerCase(), time: t });
    if (this.frames.length < 12) this.frames.push({ time: t, label: `"${m[m.length - 1]}"`, dataUrl: this.snapshot() });
  }
  /** Video time for a moment of the recording (seconds), interpolated from the map recorded while talking. */
  videoTimeAt(sec) {
    const ms = sec * 1000; const m = this.timeMap || [[0, this.startTime || 0]];
    if (ms <= m[0][0]) return m[0][1];
    for (let i = 1; i < m.length; i++) if (m[i][0] >= ms) { const [a0, v0] = m[i - 1], [a1, v1] = m[i]; return v0 + ((v1 - v0) * (ms - a0)) / Math.max(1, a1 - a0); }
    return m[m.length - 1][1];
  }
  async stop() {
    this.recording = false;
    if (this.mapTimer) { clearInterval(this.mapTimer); this.timeMap.push([performance.now() - this.t0, this.getTime()]); }
    try { this.sr?.stop(); } catch {}
    const blob = await new Promise((resolve) => { this.rec.onstop = () => resolve(new Blob(this.chunks, { type: this.rec.mimeType || 'audio/webm' })); this.rec.stop(); });
    this.stream.getTracks().forEach((t) => t.stop());
    const audio = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
    if (this.serverMode && blob.size) {
      try {
        const r = await fetch('/api/transcribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ audio }) });
        const j = await r.json(); if (!r.ok) throw new Error(j.error || r.statusText);
        this.segments = j.segments.map((s) => ({ text: s.text, start: this.videoTimeAt(s.start), end: this.videoTimeAt(Math.max(s.start, s.end)) }));
        this.transcript = j.text || this.segments.map((s) => s.text).join(' '); this.interim = '';
        this.visualReferences = [];
        for (const s of j.segments) { const words = s.text.match(POINTING); if (words) this.visualReferences.push({ phrase: words[words.length - 1].toLowerCase(), time: this.videoTimeAt(s.start) }); }
      } catch (e) { this.transcribeError = e.message; console.warn('transcription failed:', e.message); }
    }
    for (const f of this.frames) { try { f.dataUrl = await f.dataUrl; } catch { f.dataUrl = null; } }
    this.frames = this.frames.filter((f) => f.dataUrl);
    if (this.interim.trim()) this.segments.push({ text: this.interim.trim(), start: this._segStart[this._lastIdx] ?? Math.max(0, this.getTime() - 1), end: this.getTime() });
    return { audio, transcript: (this.transcript + ' ' + this.interim).trim(), visualReferences: this.visualReferences, frames: this.frames, segments: this.segments, transcribeError: this.transcribeError || null, startTime: this.startTime, endTime: this.getTime(), seconds: blob.size ? null : 0 };
  }
}
export const highlightPointing = (text) => text.replace(POINTING, (m) => `<mark>${m}</mark>`);
