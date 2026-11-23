// Speech to text for footage, on this computer (nothing is uploaded). Engines, first available wins:
//   VIDEDITOR_TRANSCRIBER   a program with the chopchop-transcribe contract (tests, other engines)
//   apple                   macOS: native/transcribe.swift, compiled once with swiftc into <data>/bin
//   whisper                 VIDEDITOR_WHISPER + VIDEDITOR_WHISPER_MODEL (the Mac app bundles these)
// VIDEDITOR_TRANSCRIBE_ENGINE=whisper skips the Apple engine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SWIFT_SRC = path.join(ROOT, 'native', 'transcribe.swift');
const PLIST = path.join(ROOT, 'native', 'Info.plist');
export const TRANSCRIPT_VERSION = 1;

const which = (bin) => { const r = spawnSync('which', [bin], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim().split('\n')[0] : null; };
// macOS ships a swiftc stub even without the developer tools; xcode-select -p says whether they are installed.
let swiftChecked = 0, swiftOk = false;
const hasSwift = () => { if (Date.now() - swiftChecked > (swiftOk ? 3600e3 : 60e3)) { swiftChecked = Date.now(); swiftOk = spawnSync('xcode-select', ['-p']).status === 0 && !!which('swiftc'); } return swiftOk; };
const whisperReady = () => !!(process.env.VIDEDITOR_WHISPER && process.env.VIDEDITOR_WHISPER_MODEL && fs.existsSync(process.env.VIDEDITOR_WHISPER) && fs.existsSync(process.env.VIDEDITOR_WHISPER_MODEL));

// The compiled Apple helper. state: unknown | building | ready | failed
const helper = { state: 'unknown', path: null, error: null, analyzer: null, os: null };
let building = null;
const helperPath = (dataDir) => {
  const h = crypto.createHash('sha1').update(fs.readFileSync(SWIFT_SRC)).update(fs.readFileSync(PLIST)).digest('hex').slice(0, 10);
  return path.join(dataDir, 'bin', `chopchop-transcribe-${h}`);
};

/** Which engine will transcribe, and whether it can. { kind, label, ready, note?, reason? } */
export function engineInfo(dataDir) {
  if (process.env.VIDEDITOR_TRANSCRIBER) { const ok = fs.existsSync(process.env.VIDEDITOR_TRANSCRIBER); return { kind: 'custom', label: 'Custom transcriber', ready: ok, ...(ok ? {} : { reason: `VIDEDITOR_TRANSCRIBER not found: ${process.env.VIDEDITOR_TRANSCRIBER}` }) }; }
  if (process.platform === 'darwin' && process.env.VIDEDITOR_TRANSCRIBE_ENGINE !== 'whisper' && helper.state !== 'failed') {
    const built = fs.existsSync(helperPath(dataDir));
    if (built || hasSwift()) return { kind: 'apple', label: 'Apple speech recognition, on this Mac', ready: true, note: built || helper.state === 'ready' ? null : 'Sets itself up the first time (about a minute).' };
  }
  if (whisperReady()) return { kind: 'whisper', label: 'Whisper, on this computer', ready: true };
  if (process.platform === 'darwin') return { kind: null, ready: false, reason: helper.error ? `Mac transcription could not be set up: ${helper.error}` : 'Install the Xcode Command Line Tools (run: xcode-select --install), then try again.' };
  return { kind: null, ready: false, reason: 'Transcription runs on a Mac (Apple speech recognition), or with Whisper (set VIDEDITOR_WHISPER and VIDEDITOR_WHISPER_MODEL).' };
}

const run = (bin, args, { onStderr } = {}) => new Promise((resolve) => {
  let out = '', err = '';
  let p; try { p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return resolve({ code: -1, out, err: e.message }); }
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { const s = String(d); err = (err + s).slice(-20000); onStderr?.(s); });
  p.on('error', (e) => resolve({ code: -1, out, err: e.message }));
  p.on('close', (code) => resolve({ code, out, err }));
});
const lastLines = (s, n = 6) => String(s || '').trim().split('\n').filter((l) => !/^\s*$/.test(l)).slice(-n).join('\n');

/** Compile the Apple helper once (about a minute). Tries the macOS 26 SpeechAnalyzer build first, then the older API. */
export function ensureHelper(dataDir, { onLog } = {}) {
  const out = helperPath(dataDir);
  if (fs.existsSync(out)) { helper.state = 'ready'; helper.path = out; return Promise.resolve(out); }
  if (building) return building;
  helper.state = 'building';
  building = (async () => {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const tmp = `${out}.build-${process.pid}`;
    const base = ['-O', '-parse-as-library', SWIFT_SRC, '-o', tmp, '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', PLIST];
    onLog?.('setting up Mac transcription (compiling a small helper, first time only)…');
    let r = await run('swiftc', base);
    if (r.code !== 0) {
      const first = r.err;
      onLog?.('the SpeechAnalyzer build did not compile on this Mac; trying the older speech API');
      r = await run('swiftc', [...base, '-D', 'CHOPCHOP_NO_ANALYZER']);
      if (r.code !== 0) { helper.state = 'failed'; helper.error = lastLines(first || r.err, 4) || 'swiftc failed'; try { fs.rmSync(tmp, { force: true }); } catch {} throw new Error(helper.error); }
    }
    fs.renameSync(tmp, out); fs.chmodSync(out, 0o755);
    const c = await run(out, ['--check']); try { const j = JSON.parse(c.out); helper.analyzer = j.analyzer; helper.os = j.os; } catch {}
    onLog?.(`Mac transcription ready (macOS ${helper.os || '?'}, ${helper.analyzer ? 'SpeechAnalyzer' : 'SFSpeechRecognizer'})`);
    helper.state = 'ready'; helper.path = out; return out;
  })().finally(() => { building = null; });
  return building;
}

/** 16 kHz mono WAV of a media file's first audio stream. */
function extractWav(file, wav) {
  return run('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vn', '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]).then((r) => { if (r.code !== 0) throw new Error(`could not read the audio: ${lastLines(r.err, 1)}`); });
}

/**
 * transcribeFile(file, { dataDir, locale, onProgress(0..1), onLog }) → { engine, locale, segments: [{ start, end, text, words? }] }
 * Times are seconds in the file. Segments come back as sentences.
 */
export async function transcribeFile(file, { dataDir, locale = null, onProgress, onLog } = {}) {
  const info = engineInfo(dataDir);
  if (!info.ready) throw new Error(info.reason || 'no transcription engine');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-tx-'));
  try {
    const wav = path.join(dir, 'audio.wav');
    await extractWav(file, wav);
    const progressFrom = (s) => { for (const m of s.matchAll(/PROGRESS ([\d.]+)|progress = (\d+)%/g)) onProgress?.(m[1] ? Number(m[1]) : Number(m[2]) / 100); for (const l of s.split('\n')) if (l.trim() && !/PROGRESS|progress =|^whisper_|^ggml_|^main:|^system_info/.test(l)) onLog?.(l.trim()); };
    if (info.kind === 'custom' || info.kind === 'apple') {
      let bin = process.env.VIDEDITOR_TRANSCRIBER;
      if (info.kind === 'apple') {
        try { bin = await ensureHelper(dataDir, { onLog }); }
        catch (e) { if (whisperReady()) { onLog?.(`Mac transcription unavailable (${e.message.split('\n')[0]}); using Whisper`); return await whisperFile(wav, { onProgress, progressFrom }); } throw new Error(`Mac transcription could not be set up:\n${e.message}`); }
      }
      const r = await run(bin, [wav, ...(locale ? ['--locale', locale] : [])], { onStderr: progressFrom });
      if (r.code !== 0) throw new Error(lastLines(r.err, 3) || `transcriber exited ${r.code}`);
      const j = JSON.parse(r.out.trim().split('\n').pop());
      return { engine: j.engine || info.kind, locale: j.locale || locale, segments: toSentences(j.segments || []) };
    }
    return await whisperFile(wav, { onProgress, progressFrom });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function whisperFile(wav, { progressFrom }) {
  const base = wav.replace(/\.wav$/, '');
  const r = await run(process.env.VIDEDITOR_WHISPER, ['-m', process.env.VIDEDITOR_WHISPER_MODEL, '-f', wav, '-oj', '-of', base, '-pp', '-t', String(Math.max(2, Math.min(8, os.cpus().length - 1)))], { onStderr: progressFrom });
  if (r.code !== 0) throw new Error(`Whisper failed: ${lastLines(r.err, 1)}`);
  const j = JSON.parse(fs.readFileSync(`${base}.json`, 'utf8'));
  const segments = (j.transcription || []).map((x) => ({ start: (x.offsets?.from ?? 0) / 1000, end: (x.offsets?.to ?? 0) / 1000, text: String(x.text || '').replace(/\[[^\]]*\]|\([^)]*\)/g, '').trim() })).filter((x) => x.text);
  return { engine: 'whisper', locale: j.result?.language || null, segments: toSentences(segments) };
}

/** Long segments with word times become sentences (split at . ? !, long pauses, or 30 words). */
export function toSentences(segments) {
  const out = [];
  for (const s of segments) {
    const words = (s.words || []).filter((w) => w && w.text && Number.isFinite(w.start));
    if (!words.length || s.end - s.start <= 12) { if (String(s.text || '').trim()) out.push({ start: s.start, end: s.end, text: String(s.text).trim(), ...(words.length ? { words } : {}) }); continue; }
    let cur = [];
    const flush = () => { if (!cur.length) return; out.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map((w) => w.text).join(' ').replace(/\s+([,.;:!?])/g, '$1'), words: cur }); cur = []; };
    words.forEach((w, i) => {
      cur.push(w);
      const next = words[i + 1];
      if ((/[.?!]["')\]]*$/.test(w.text) && cur.length >= 2) || (next && next.start - w.end > 0.8) || cur.length >= 30) flush();
    });
    flush();
  }
  return out.map((s) => ({ ...s, start: round(s.start), end: round(s.end) }));
}
const round = (n) => Math.round(n * 100) / 100;

/** Cache file for a media file's transcript (by path, size and modification time). */
export function cachePathFor(dataDir, file) {
  let st; try { st = fs.statSync(file); } catch { return null; }
  return path.join(dataDir, 'transcripts', crypto.createHash('sha1').update(`${path.resolve(file)}|${st.size}|${Math.round(st.mtimeMs)}|v${TRANSCRIPT_VERSION}`).digest('hex').slice(0, 20) + '.json');
}
export function readCached(dataDir, file) { const p = cachePathFor(dataDir, file); if (!p) return null; try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
export function writeCached(dataDir, file, data) { const p = cachePathFor(dataDir, file); if (!p) return; fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(data)); }

/**
 * What is said in a composition, in composition time. clips: parsed clips; fileOf(clip) → absolute media path;
 * transcriptOf(file) → { segments } or null. Returns [{ t0, t1, text, clip, src, s0, s1, partial }] sorted by t0.
 */
export function mapToComposition(clips, fileOf, transcriptOf) {
  const lines = [];
  for (const c of clips || []) {
    if (!c.src || !c.hasAudio || c.start === null || c.start === undefined) continue;
    const file = fileOf(c); const tr = file ? transcriptOf(file) : null; if (!tr) continue;
    const ms = c.mediaStart || 0; const me = c.duration !== null && c.duration !== undefined ? ms + c.duration : Infinity;
    for (const s of tr.segments || []) {
      if (s.end <= ms || s.start >= me) continue;
      let a = Math.max(s.start, ms), b = Math.min(s.end, me), text = s.text, partial = false;
      if (s.start < ms - 0.05 || s.end > me + 0.05) {
        partial = true;
        if (s.words?.length) {
          const ws = s.words.filter((w) => (w.start + w.end) / 2 >= ms && (w.start + w.end) / 2 < me); if (!ws.length) continue;
          text = ws.map((w) => w.text).join(' '); a = Math.max(ws[0].start, ms); b = Math.min(ws[ws.length - 1].end, me);
        }
      }
      lines.push({ t0: round(c.start + (a - ms)), t1: round(c.start + (b - ms)), text, clip: c.id || null, src: c.src, s0: round(a), s1: round(b), partial });
    }
  }
  return lines.sort((x, y) => x.t0 - y.t0);
}

export const fmtT = (s) => { const m = Math.floor(s / 60); const r = s - m * 60; return `${String(m).padStart(2, '0')}:${r.toFixed(1).padStart(4, '0')}`; };

/** Markdown for the agent: one source file, source times. */
export function fileMarkdown(rel, tr) {
  return [`# Transcript: ${rel}`, `Engine: ${tr.engine}${tr.locale ? `, ${tr.locale}` : ''}. Times are seconds in this file (what data-media-start refers to). Generated by ChopChop; do not edit.`, '',
    ...tr.segments.map((s) => `[${fmtT(s.start)}–${fmtT(s.end)}] ${s.text}`), ''].join('\n');
}
/** Markdown for the agent: what is said in the composition, composition times, with clip and source times. */
export function compositionMarkdown(entry, lines) {
  return [`# Transcript of ${entry} (what is said in the video, in order)`, 'Each line: [composition time] #clip-id (source file: seconds in the file) text. Lines marked (partly cut) are cut mid-sentence by the clip edge. Generated by ChopChop from transcripts/; do not edit.', '',
    ...lines.map((l) => `[${fmtT(l.t0)}–${fmtT(l.t1)}] ${l.clip ? '#' + l.clip : '(no id)'} (${path.basename(l.src)}: ${l.s0.toFixed(2)}–${l.s1.toFixed(2)})${l.partial ? ' (partly cut)' : ''} ${l.text}`), ''].join('\n');
}
