// ffmpeg / ffprobe helpers and the demo seed.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export function hasFfmpeg() {
  const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  return r.status === 0;
}

export function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate:format=duration', '-of', 'json', file], { encoding: 'utf8' });
  if (r.status !== 0) return { duration: null, width: null, height: null, fps: null };
  try {
    const j = JSON.parse(r.stdout);
    const s = j.streams?.[0] || {};
    const [n, d] = (s.r_frame_rate || '30/1').split('/').map(Number);
    return { duration: j.format?.duration ? Number(j.format.duration) : null, width: s.width ?? null, height: s.height ?? null, fps: d ? Math.round((n / d) * 100) / 100 : null };
  } catch { return { duration: null, width: null, height: null, fps: null }; }
}

export function poster(file, out, at = 0.5) {
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-vf', 'scale=640:-2', out]);
  return r.status === 0;
}

/** Extract one JPEG frame at time t. Returns a Buffer or null. */
export function frameAt(file, t, { width = 1280 } = {}) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(Math.max(0, t)), '-i', file, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-f', 'image2', '-c:v', 'mjpeg', '-q:v', '3', 'pipe:1'], { maxBuffer: 20 * 1024 * 1024 });
  return r.status === 0 && r.stdout?.length ? r.stdout : null;
}

/** Make a small demo render with ffmpeg so the app has content on first run. */
export function hasFilter(name) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' });
  return r.status === 0 && new RegExp(`\\s${name}\\s`).test(r.stdout);
}

export function makeDemoVideo(out, { title = 'Launch day', seconds = 6, hue = 200, titleAt = 1.0, label = 'demo render', text = hasFilter('drawtext') } = {}) {
  // Homebrew and some distro ffmpeg builds ship without drawtext (needs libfreetype): fall back to a plain gradient.
  const font = text ? findFont() : null;
  const bg = `gradients=s=1280x720:d=${seconds}:c0=${hslHex(hue, 0.6, 0.25)}:c1=${hslHex((hue + 60) % 360, 0.7, 0.45)}:speed=0.02`;
  const drawText = font
    ? `,drawtext=fontfile=${font}:text='${title.replace(/[':\\]/g, '')}':fontcolor=white:fontsize=96:x=(w-text_w)/2:y=(h-text_h)/2:enable='gte(t\\,${titleAt})':alpha='min(1\\,(t-${titleAt})/0.8)'` +
      `,drawtext=fontfile=${font}:text='${label.replace(/[':\\]/g, '')}':fontcolor=white@0.6:fontsize=28:x=48:y=h-80`
    : '';
  const args = ['-y', '-v', 'error', '-f', 'lavfi', '-i', bg, '-f', 'lavfi', '-i', `sine=frequency=330:d=${seconds}`, '-filter_complex', `[0:v]format=yuv420p${drawText}[v]`, '-map', '[v]', '-map', '1:a', '-t', String(seconds), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', out];
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (r.status !== 0) console.error('[demo] ffmpeg failed:', r.stderr?.slice(0, 400));
  return r.status === 0;
}

export function hslHex(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return '0x' + [f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

function findFont() {
  const candidates = ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf', '/System/Library/Fonts/Helvetica.ttc', 'C:/Windows/Fonts/arialbd.ttf'];
  return candidates.find((f) => fs.existsSync(f)) || null;
}

export function copyInto(src, destDir, name) {
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, name);
  fs.copyFileSync(src, dest);
  return dest;
}

/** Video/audio encoders this ffmpeg build has. */
export function listEncoders() {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  const out = new Set();
  for (const name of ['libx264', 'libx265', 'libsvtav1', 'libaom-av1', 'librav1e', 'libvpx-vp9', 'prores_ks', 'gif', 'aac', 'libopus']) if (new RegExp(`\\s${name.replace(/[-]/g, '\\-')}\\s`).test(r.stdout || '')) out.add(name);
  return [...out];
}
