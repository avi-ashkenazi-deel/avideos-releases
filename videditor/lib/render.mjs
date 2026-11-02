// Frame-exact renderer: Chrome steps through the composition one frame at a
// time (via the runtime's deterministic seek), each frame is screenshotted
// and piped into ffmpeg, and the composition's audio clips are mixed in.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { parseProject } from './composition.mjs';

const require = createRequire(import.meta.url);

export function loadPlaywright() {
  for (const m of ['playwright-core', 'playwright']) { try { return require(m); } catch {} }
  return null;
}

export async function launchBrowser(pw) {
  try { return await pw.chromium.launch({ channel: 'chrome' }); } catch {}
  try { return await pw.chromium.launch({ channel: 'msedge' }); } catch {}
  return pw.chromium.launch();
}

function hasAudioStream(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return r.status === 0 && /audio/.test(r.stdout);
}

/**
 * renderProject({ pageUrl, dir, out, fps, quality, onProgress, onLog })
 * pageUrl: the composition served with the runtime injected (…/index.html?runtime=1&render=1)
 */
export async function renderProject({ pageUrl, dir, out, fps: fpsOpt, quality = 'looks', onProgress, onLog }) {
  const log = (m) => onLog?.(m);
  const pw = loadPlaywright();
  if (!pw) throw new Error('Playwright is not installed. Run: npm install   (inside the videditor folder)');
  const browser = await launchBrowser(pw);
  log(`browser: ${browser.browserType().name()} ${browser.version()}`);
  let ffmpeg = null;
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => log(`page error: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') log(`console: ${m.text().slice(0, 200)}`); });
    await page.goto(pageUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__videditor, null, { timeout: 15000 });
    const info = await page.evaluate(() => window.__videditor.info());
    const fps = fpsOpt || info.fps || 30;
    const width = info.width, height = info.height;
    await page.setViewportSize({ width, height });
    const frames = Math.max(1, Math.round(info.duration * fps));
    log(`composition ${info.id}: ${width}×${height}, ${info.duration}s @ ${fps}fps → ${frames} frames`);

    // Audio inputs from the parsed composition (needs src paths, which the runtime doesn't expose).
    const comp = parseProject(dir);
    const audio = (comp?.clips || []).filter((c) => c.hasAudio && c.src && c.start !== null).map((c) => ({ ...c, file: path.resolve(dir, c.src.replace(/^\.?\//, '')) })).filter((c) => fs.existsSync(c.file) && hasAudioStream(c.file));
    const crf = quality === 'high' ? 14 : quality === 'draft' ? 28 : 18;
    const args = ['-y', '-v', 'error', '-stats_period', '1', '-f', 'image2pipe', '-framerate', String(fps), '-i', 'pipe:0'];
    for (const a of audio) args.push('-i', a.file);
    const filters = [];
    audio.forEach((a, i) => {
      const dur = a.duration ?? (info.duration - a.start);
      const ms = Math.round(a.start * 1000);
      filters.push(`[${i + 1}:a]atrim=start=${a.mediaStart || 0}:duration=${dur},asetpts=PTS-STARTPTS,volume=${a.volume ?? 1},adelay=${ms}|${ms}[a${i}]`);
    });
    if (audio.length) {
      filters.push(`${audio.map((_, i) => `[a${i}]`).join('')}amix=inputs=${audio.length}:normalize=0:duration=longest,apad=whole_dur=${info.duration}[aout]`);
      args.push('-filter_complex', filters.join(';'), '-map', '0:v', '-map', '[aout]', '-c:a', 'aac', '-b:a', '192k');
    } else args.push('-map', '0:v', '-an');
    args.push('-c:v', 'libx264', '-preset', quality === 'draft' ? 'veryfast' : 'medium', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-t', String(info.duration), out);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    log(`audio tracks: ${audio.length ? audio.map((a) => path.basename(a.file)).join(', ') : 'none'}`);
    ffmpeg = spawn('ffmpeg', args);
    let ffErr = '';
    ffmpeg.stderr.on('data', (d) => { ffErr += d.toString(); if (ffErr.length > 8000) ffErr = ffErr.slice(-8000); });
    const ffDone = new Promise((resolve, reject) => { ffmpeg.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${ffErr.trim().split('\n').slice(-3).join(' | ')}`)))); ffmpeg.on('error', reject); });
    const write = (buf) => new Promise((resolve, reject) => { if (!ffmpeg.stdin.writable) return reject(new Error('ffmpeg closed early: ' + ffErr.trim().split('\n').slice(-2).join(' | '))); const ok = ffmpeg.stdin.write(buf); if (ok) resolve(); else ffmpeg.stdin.once('drain', resolve); });

    const type = quality === 'high' ? 'png' : 'jpeg';
    const t0 = Date.now();
    for (let i = 0; i < frames; i++) {
      const t = i / fps;
      await page.evaluate((tt) => window.__videditor.seekAndSettle(tt), t);
      const shot = await page.screenshot({ type, ...(type === 'jpeg' ? { quality: 95 } : {}), clip: { x: 0, y: 0, width, height }, caret: 'hide' });
      await write(shot);
      if (i % Math.max(1, Math.round(fps / 2)) === 0 || i === frames - 1) onProgress?.({ frame: i + 1, frames, t, elapsed: (Date.now() - t0) / 1000 });
    }
    ffmpeg.stdin.end();
    await ffDone;
    log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${out}`);
    return { out, frames, fps, width, height, duration: info.duration };
  } finally {
    try { ffmpeg?.stdin?.destroy(); } catch {}
    await browser.close().catch(() => {});
  }
}
