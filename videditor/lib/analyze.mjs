// Media analysis for the asset library: what is in a file, where the cuts
// are, what it looks like (keyframes the agent can open), and for music the
// tempo and beat grid. Everything is cached under <project>/.analysis/.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const MEDIA_RE = /\.(mp4|mov|m4v|webm|mkv|avi|mp3|wav|m4a|aac|ogg|flac|png|jpe?g|webp|gif|svg)$/i;
export const kindOf = (f) => (/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(f) ? 'video' : /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(f) ? 'audio' : /\.(png|jpe?g|webp|gif|svg)$/i.test(f) ? 'image' : null);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'file';

/** List media files in a folder (recursive, capped). Returns [{ path(abs), rel, name, size, mtime, kind }]. */
export function scanMedia(dir, { max = 500, prefix = '' } = {}) {
  const out = [];
  const walk = (d, rel) => {
    let entries = []; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.') || out.length >= max) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!['node_modules', 'renders'].includes(e.name)) walk(path.join(d, e.name), r); continue; }
      if (!MEDIA_RE.test(e.name)) continue;
      let st; try { st = fs.statSync(path.join(d, e.name)); } catch { continue; }
      out.push({ path: path.join(d, e.name), rel: prefix ? `${prefix}/${r}` : r, name: e.name, size: st.size, mtime: st.mtimeMs, kind: kindOf(e.name) });
    }
  };
  walk(dir, '');
  return out;
}

export function probeMedia(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels:format=duration', '-of', 'json', file], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  try {
    const j = JSON.parse(r.stdout); const v = (j.streams || []).find((s) => s.codec_type === 'video'); const a = (j.streams || []).find((s) => s.codec_type === 'audio');
    const [n, d] = (v?.r_frame_rate || '0/1').split('/').map(Number);
    return { duration: j.format?.duration ? Number(j.format.duration) : null, width: v?.width ?? null, height: v?.height ?? null, fps: v && d ? Math.round((n / d) * 100) / 100 : null, hasVideo: !!v, hasAudio: !!a, vcodec: v?.codec_name || null, acodec: a?.codec_name || null, sampleRate: a?.sample_rate ? Number(a.sample_rate) : null };
  } catch { return null; }
}

/** Scene cuts (seconds) using ffmpeg's scene score. */
export function detectScenes(file, { threshold = 0.3, maxSeconds = 600, cap = 60 } = {}) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-t', String(maxSeconds), '-i', file, '-vf', `select='gt(scene,${threshold})',showinfo`, '-an', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const times = []; const re = /pts_time:([\d.]+)/g; let m;
  while ((m = re.exec(r.stderr || '')) && times.length < cap) times.push(Math.round(Number(m[1]) * 100) / 100);
  return times;
}

export function extractFrame(file, t, out, { width = 480 } = {}) {
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-ss', String(Math.max(0, t)), '-i', file, '-frames:v', '1', '-vf', `scale=${width}:-2`, out]);
  return r.status === 0 && fs.existsSync(out);
}

export function contactSheet(frames, out, cols = 4) {
  if (!frames.length) return false;
  const rows = Math.ceil(frames.length / cols);
  const args = ['-y', '-v', 'error']; frames.forEach((f) => args.push('-i', f));
  const pad = frames.length < cols * rows ? `,pad=iw:ih` : '';
  const inputs = frames.map((_, i) => `[${i}:v]scale=480:-2,setsar=1${pad}[s${i}]`).join(';');
  const concat = frames.map((_, i) => `[s${i}]`).join('');
  // tile needs equal sizes: scale each to 480x270 (pad) first
  const filt = frames.map((_, i) => `[${i}:v]scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2,setsar=1[s${i}]`).join(';') + `;${concat}concat=n=${frames.length}:v=1:a=0,tile=${cols}x${rows}[out]`;
  const r = spawnSync('ffmpeg', [...args, '-filter_complex', filt, '-map', '[out]', '-frames:v', '1', out]);
  return r.status === 0 && fs.existsSync(out);
}

/** Tempo and beat grid from the first 90 s of audio. Returns { bpm, offset, beats[], confidence, peaks[] } or null. */
export function analyzeAudio(file, { seconds = 90 } = {}) {
  const sr = 11025, hop = 256;
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-t', String(seconds), '-ac', '1', '-ar', String(sr), '-f', 's16le', 'pipe:1'], { maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout?.length) return null;
  const pcm = new Int16Array(r.stdout.buffer, r.stdout.byteOffset, Math.floor(r.stdout.length / 2));
  const n = Math.floor(pcm.length / hop); if (n < 40) return null;
  const energy = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < hop; j++) { const v = pcm[i * hop + j] / 32768; s += v * v; } energy[i] = Math.sqrt(s / hop); }
  // onset strength: positive change of log energy, smoothed
  const onset = new Float64Array(n);
  for (let i = 1; i < n; i++) onset[i] = Math.max(0, Math.log1p(energy[i] * 50) - Math.log1p(energy[i - 1] * 50));
  const mean = onset.reduce((a, b) => a + b, 0) / n; for (let i = 0; i < n; i++) onset[i] = Math.max(0, onset[i] - mean);
  const maxOnset = Math.max(...onset);
  // Widen the onset spikes a little so fractional lags are not penalized against integer ones.
  for (let pass = 0; pass < 2; pass++) { const prev = Float64Array.from(onset); for (let i = 1; i < n - 1; i++) onset[i] = 0.25 * prev[i - 1] + 0.5 * prev[i] + 0.25 * prev[i + 1]; }
  const fph = sr / hop; // frames per second
  // Autocorrelation with linear interpolation so non-integer lags are not penalized.
  const corr = (lagF) => { const li = Math.floor(lagF), fr = lagF - li; let s = 0; for (let i = li + 1; i < n; i++) s += onset[i] * (onset[i - li] * (1 - fr) + onset[i - li - 1] * fr); return s / (n - li - 1); };
  const cands = [];
  for (let bpm = 50; bpm <= 220; bpm += 0.25) { const lagF = (60 / bpm) * fph; if (lagF < 2 || lagF * 2 >= n) continue; cands.push({ bpm, score: corr(lagF) }); }
  if (!cands.length) return null;
  const scoreAt = (bpm) => { const c = cands.reduce((b, x) => (Math.abs(x.bpm - bpm) < Math.abs(b.bpm - bpm) ? x : b), cands[0]); return Math.abs(c.bpm - bpm) < 0.4 ? c.score : 0; };
  let best = cands.reduce((b, x) => (x.score > b.score ? x : b), cands[0]);
  // Octave fix: prefer the faster tempo when its score is close, and a range people actually count in.
  for (let k = 0; k < 2; k++) { const dbl = scoreAt(best.bpm * 2); if (best.bpm * 2 <= 190 && dbl >= best.score * 0.8) best = { bpm: best.bpm * 2, score: dbl }; }
  for (let k = 0; k < 2; k++) { const half = scoreAt(best.bpm / 2); if (best.bpm > 185 && half >= best.score * 0.6) best = { bpm: best.bpm / 2, score: half }; }
  // Confidence: how much the best lag stands out from the others, scaled by how strong the onsets are at all.
  const meanScore = cands.reduce((a, c) => a + c.score, 0) / cands.length;
  const peakiness = best.score > 0 ? Math.max(0, 1 - meanScore / best.score) : 0;
  const confidence = Math.round(peakiness * Math.min(1, maxOnset / 0.5) * 100) / 100;
  const period = 60 / best.bpm; const periodF = period * fph;
  // phase: offset within one period that maximizes onset energy at beats
  let bestOff = 0, bestSum = -1;
  for (let k = 0; k < Math.round(periodF); k++) { let s = 0, c = 0; for (let p = k; p < n; p += periodF) { s += onset[Math.round(p)] || 0; c++; } if (c && s / c > bestSum) { bestSum = s / c; bestOff = k; } }
  const offset = Math.round((bestOff / fph) * 1000) / 1000;
  const total = pcm.length / sr;
  const beats = []; for (let t = offset; t < total && beats.length < 1000; t += period) beats.push(Math.round(t * 1000) / 1000);
  // loud moments: RMS per 0.5 s, local maxima above the 80th percentile
  const win = Math.round(fph / 2); const rms = [];
  for (let i = 0; i + win <= n; i += win) { let s = 0; for (let j = 0; j < win; j++) s += energy[i + j]; rms.push(s / win); }
  const sorted = [...rms].sort((a, b) => a - b); const thr = sorted[Math.floor(sorted.length * 0.8)] || 0;
  const peaks = []; for (let i = 1; i < rms.length - 1; i++) if (rms[i] >= thr && rms[i] >= rms[i - 1] && rms[i] >= rms[i + 1]) peaks.push({ t: Math.round(i * 0.5 * 10) / 10, level: Math.round((rms[i] / (sorted[sorted.length - 1] || 1)) * 100) / 100 });
  const silenceAt = rms.findIndex((v) => v > 0.01);
  return { bpm: Math.round(best.bpm * 10) / 10, offset, beats, confidence, peaks: peaks.slice(0, 24), firstSound: silenceAt > 0 ? silenceAt * 0.5 : 0, analyzedSeconds: Math.min(seconds, total) };
}

/** Analyze one media file into outDir. Returns the manifest entry. */
export function analyzeFile(entry, outDir, { onLog } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const info = probeMedia(entry.path) || {};
  const rec = { ...entry, ...info, analyzedAt: new Date().toISOString(), scenes: [], frames: [], sheet: null, audio: null };
  const relOut = (f) => path.join('.analysis', path.basename(outDir), f);
  if (entry.kind === 'image') {
    if (extractFrame(entry.path, 0, path.join(outDir, 'thumb.jpg'), { width: 480 })) rec.frames.push({ t: 0, file: relOut('thumb.jpg') }), (rec.sheet = relOut('thumb.jpg'));
    return rec;
  }
  if (entry.kind === 'video' && info.hasVideo && info.duration) {
    onLog?.(`${entry.name}: finding cuts…`);
    rec.scenes = detectScenes(entry.path);
    const times = new Set([0.5]);
    const every = Math.max(1, info.duration / 8); for (let t = every; t < info.duration - 0.2 && times.size < 10; t += every) times.add(Math.round(t * 10) / 10);
    for (const t of rec.scenes) { if (times.size >= 16) break; times.add(Math.min(info.duration - 0.1, t + 0.15)); }
    const sorted = [...times].sort((a, b) => a - b);
    onLog?.(`${entry.name}: ${rec.scenes.length} cut(s), ${sorted.length} keyframes…`);
    sorted.forEach((t, i) => { const f = `frame-${String(i + 1).padStart(2, '0')}.jpg`; if (extractFrame(entry.path, t, path.join(outDir, f))) rec.frames.push({ t: Math.round(t * 100) / 100, file: relOut(f), atCut: rec.scenes.some((s) => Math.abs(s + 0.15 - t) < 0.01) }); });
    if (contactSheet(rec.frames.map((f) => path.join(outDir, path.basename(f.file))), path.join(outDir, 'sheet.jpg'))) rec.sheet = relOut('sheet.jpg');
  }
  if (info.hasAudio) { onLog?.(`${entry.name}: tempo…`); rec.audio = analyzeAudio(entry.path); }
  return rec;
}

const fmt = (s) => (s === null || s === undefined ? '–' : `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`);

/** Write MEDIA.md + media.json for the agent. */
export function writeManifest(projectDir, records, { libraryDir } = {}) {
  const lines = ['# Media in this project', ''];
  lines.push('Paths are relative to the project. `library/…` files live in the linked asset folder' + (libraryDir ? ` (${libraryDir})` : '') + '. Keyframes and contact sheets are under `.analysis/` (open them with Read to see what a clip looks like).', '');
  for (const r of records) {
    lines.push(`## ${r.rel}`);
    const dims = r.width ? `${r.width}×${r.height}` : ''; const bits = [r.kind, r.duration ? fmt(r.duration) : null, dims, r.fps && r.kind === 'video' ? `${r.fps} fps` : null, r.hasAudio ? 'has audio' : (r.kind === 'video' ? 'silent' : null)].filter(Boolean);
    lines.push(`- ${bits.join(' · ')}`);
    if (r.scenes?.length) lines.push(`- Cuts at: ${r.scenes.map(fmt).join(', ')}`);
    if (r.sheet) lines.push(`- Contact sheet: \`${r.sheet}\` (tiles left→right, top→bottom = ${r.frames.map((f) => fmt(f.t)).join(', ')})`);
    if (r.frames?.length && r.kind === 'video') lines.push(`- Keyframes: ${r.frames.map((f) => `${fmt(f.t)} → \`${f.file}\``).join('; ')}`);
    if (r.audio) { if (r.audio.confidence >= 0.15) lines.push(`- Tempo: ${r.audio.bpm} BPM (confidence ${r.audio.confidence}), first beat at ${r.audio.offset}s, one beat every ${(60 / r.audio.bpm).toFixed(3)}s. Beats: ${r.audio.beats.slice(0, 32).join(', ')}${r.audio.beats.length > 32 ? ' …' : ''}`); else lines.push(`- Tempo: no clear beat detected (best guess ${r.audio.bpm} BPM, confidence ${r.audio.confidence}); treat as ambient`); if (r.audio.peaks?.length) lines.push(`- Loud moments: ${r.audio.peaks.slice(0, 12).map((p) => fmt(p.t)).join(', ')}`); }
    lines.push('');
  }
  if (!records.length) lines.push('_No media yet. Drop files into assets/ or link an asset folder in Studio → Assets._');
  fs.writeFileSync(path.join(projectDir, 'MEDIA.md'), lines.join('\n'));
  fs.mkdirSync(path.join(projectDir, '.analysis'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.analysis', 'media.json'), JSON.stringify(records, null, 2));
}

export function analysisDirFor(projectDir, entry) { return path.join(projectDir, '.analysis', slug(entry.rel)); }
export function loadManifest(projectDir) { try { return JSON.parse(fs.readFileSync(path.join(projectDir, '.analysis', 'media.json'), 'utf8')); } catch { return []; } }
