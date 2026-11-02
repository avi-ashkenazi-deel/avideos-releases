// Voice notes: records audio, transcribes live (Web Speech API, where the
// browser has it), and logs "pointing phrases" (this, here, that…) with the
// video time they were spoken, so an agent knows what "this" refers to.
const POINTING = /\b(this|that|these|those|here|there|right here|over here|this one|that one|this part|this bit)\b/gi;

export class VoiceRecorder {
  constructor({ getTime, snapshot }) { this.getTime = getTime; this.snapshot = snapshot; this.reset(); }
  reset() { this.transcript = ''; this.interim = ''; this.visualReferences = []; this.frames = []; this.chunks = []; this.startTime = null; this.recording = false; this.lastPointAt = -1; }
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
    if (SR) {
      this.sr = new SR(); this.sr.continuous = true; this.sr.interimResults = true; this.sr.lang = navigator.language || 'en-US';
      this.sr.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const text = e.results[i][0].transcript;
          if (e.results[i].isFinal) { this.transcript = (this.transcript + ' ' + text).trim(); this.notePointing(text); }
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
  async stop() {
    this.recording = false;
    try { this.sr?.stop(); } catch {}
    const blob = await new Promise((resolve) => { this.rec.onstop = () => resolve(new Blob(this.chunks, { type: this.rec.mimeType || 'audio/webm' })); this.rec.stop(); });
    this.stream.getTracks().forEach((t) => t.stop());
    const audio = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
    return { audio, transcript: (this.transcript + ' ' + this.interim).trim(), visualReferences: this.visualReferences, frames: this.frames, startTime: this.startTime, endTime: this.getTime(), seconds: blob.size ? null : 0 };
  }
}
export const highlightPointing = (text) => text.replace(POINTING, (m) => `<mark>${m}</mark>`);
