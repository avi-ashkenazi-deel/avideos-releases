// Browser-safe proxies for footage. Chrome (above all headless Chrome, which renders) cannot decode
// every codec a Mac produces: HEVC often, ProRes / DNxHD / 10-bit or 4:2:2 H.264 never. Such clips
// rendered as silent black frames. Here they get a cached H.264 copy (originals untouched) that the
// preview and the renderer load instead. Short keyframe interval = fast, exact per-frame seeks.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const VIDEO_EXT = /\.(mp4|m4v|mov|mkv|webm|avi|mts|m2ts|mxf|qt)$/i;
const SAFE = new Set(['h264', 'vp8', 'vp9', 'av1']);
const SAFE_PIX = new Set(['yuv420p', 'yuvj420p']);
const infoCache = new Map(); // key -> info
const inflight = new Map(); // proxy path -> promise

const keyOf = (file) => { try { const st = fs.statSync(file); return `${file}|${st.size}|${Math.round(st.mtimeMs)}`; } catch { return null; } };

export const isVideoFile = (file) => VIDEO_EXT.test(file || '');

/** { codec, pix, width, height } of the first video stream, or null. Cached per file version. */
export function videoInfo(file) {
  const key = keyOf(file); if (!key) return null;
  if (infoCache.has(key)) return infoCache.get(key);
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,pix_fmt,width,height', '-of', 'json', file], { encoding: 'utf8' });
  let info = null;
  try { const s = JSON.parse(r.stdout).streams?.[0]; if (s) info = { codec: s.codec_name, pix: s.pix_fmt, width: s.width, height: s.height }; } catch {}
  infoCache.set(key, info);
  return info;
}

/** Why this file needs a proxy ('hevc', 'prores', 'h264 yuv422p10le', …), or null if the browser plays it as is. */
export function proxyReason(file) {
  if (!isVideoFile(file)) return null;
  const i = videoInfo(file); if (!i) return null;
  if (!SAFE.has(i.codec)) return i.codec;
  if (i.codec === 'h264' && i.pix && !SAFE_PIX.has(i.pix)) return `h264 ${i.pix}`;
  return null;
}

export function proxyPathFor(cacheDir, file) {
  const key = keyOf(file); if (!key) return null;
  return path.join(cacheDir, crypto.createHash('sha1').update(key).digest('hex').slice(0, 16) + '.mp4');
}

/** Path of a ready proxy, creating it if needed (deduplicated). Resolves to null when no proxy is needed or ffmpeg failed. */
export function ensureProxy(cacheDir, file, { onLog } = {}) {
  const reason = proxyReason(file); if (!reason) return Promise.resolve(null);
  const out = proxyPathFor(cacheDir, file); if (!out) return Promise.resolve(null);
  if (fs.existsSync(out)) return Promise.resolve(out);
  if (inflight.has(out)) return inflight.get(out);
  fs.mkdirSync(cacheDir, { recursive: true });
  const tmp = out.replace(/\.mp4$/, `.part-${process.pid}.mp4`);
  onLog?.(`making a browser-safe copy of ${path.basename(file)} (${reason} → H.264)…`);
  const p = new Promise((resolve) => {
    const ff = spawn('ffmpeg', ['-y', '-v', 'error', '-i', file, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', '-g', '15', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', tmp]);
    let errText = ''; ff.stderr.on('data', (d) => { errText = (errText + d).slice(-2000); });
    ff.on('error', () => resolve(null));
    ff.on('close', (code) => {
      if (code === 0) { try { fs.renameSync(tmp, out); onLog?.(`browser-safe copy ready: ${path.basename(file)}`); return resolve(out); } catch {} }
      try { fs.unlinkSync(tmp); } catch {}
      onLog?.(`could not convert ${path.basename(file)}: ${errText.trim().split('\n').pop() || 'ffmpeg failed'}`);
      resolve(null);
    });
  }).finally(() => inflight.delete(out));
  inflight.set(out, p);
  return p;
}

// Render copies: every frame a keyframe, at the composition's frame rate and no larger than its size.
// Chrome seeks these in ~30 ms instead of up to half a second per frame for long-GOP camera or screen
// recordings. Used only while rendering; cached, so later renders of the same footage start at once.
const renderInflight = new Map();
export function renderProxyPathFor(cacheDir, file, { fps = 30, w = 1920, h = 1080 } = {}) {
  const key = keyOf(file); if (!key) return null;
  return path.join(cacheDir, 'render', crypto.createHash('sha1').update(`${key}|${fps}|${w}x${h}|v1`).digest('hex').slice(0, 20) + '.mp4');
}
export function ensureRenderProxy(cacheDir, file, opts = {}, { onLog } = {}) {
  if (!isVideoFile(file) || !videoInfo(file)) return Promise.resolve(null);
  const fps = Math.max(1, Math.min(120, Number(opts.fps) || 30)); const w = Math.max(16, Number(opts.w) || 1920); const h = Math.max(16, Number(opts.h) || 1080);
  const out = renderProxyPathFor(cacheDir, file, { fps, w, h }); if (!out) return Promise.resolve(null);
  if (fs.existsSync(out)) return Promise.resolve(out);
  if (renderInflight.has(out)) return renderInflight.get(out);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = out.replace(/\.mp4$/, `.part-${process.pid}.mp4`);
  const t0 = Date.now();
  const p = new Promise((resolve) => {
    // Scale down to fit the composition (never up), keep even sizes, constant frame rate, all-intra.
    const vf = `fps=${fps},scale='min(iw,${w})':'min(ih,${h})':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`;
    const ff = spawn('ffmpeg', ['-y', '-v', 'error', '-i', file, '-map', '0:v:0', '-an', '-vf', vf, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-g', '1', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', tmp]);
    let errText = ''; ff.stderr.on('data', (d) => { errText = (errText + d).slice(-2000); });
    ff.on('error', () => resolve(null));
    ff.on('close', (code) => {
      if (code === 0) { try { fs.renameSync(tmp, out); onLog?.(`render copy of ${path.basename(file)} ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`); return resolve(out); } catch {} }
      try { fs.unlinkSync(tmp); } catch {}
      onLog?.(`could not make a render copy of ${path.basename(file)}: ${errText.trim().split('\n').pop() || 'ffmpeg failed'}`);
      resolve(null);
    });
  }).finally(() => renderInflight.delete(out));
  renderInflight.set(out, p);
  return p;
}
