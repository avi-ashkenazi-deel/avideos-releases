// Frame-exact renderer: Chrome steps through the composition one frame at a
// time (via the runtime's deterministic seek), each frame is screenshotted
// and piped into ffmpeg, and the composition's audio clips are mixed in.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { parseProject, resolveSrc } from './composition.mjs';
import { encoderArgs, availableFormats, DEFAULT_FORMAT } from './formats.mjs';
import { listEncoders } from './media.mjs';

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
export async function renderProject({ pageUrl, dir, assetsDir = null, out, fps: fpsOpt, quality = 'looks', scale = 1, format = DEFAULT_FORMAT, crf, maxBitrate, audio = true, alpha = false, range = null, onProgress, onLog }) {
  const log = (m) => onLog?.(m);
  const pw = loadPlaywright();
  if (!pw) throw new Error('Playwright is not installed. Run: npm install   (inside the videditor folder)');
  const browser = await launchBrowser(pw);
  log(`browser: ${browser.browserType().name()} ${browser.version()}`);
  let ffmpeg = null;
  try {
    scale = Math.max(0.25, Math.min(4, Number(scale) || 1));
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: scale });
    page.on('pageerror', (e) => log(`page error: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') log(`console: ${m.text().slice(0, 200)}`); });
    const encoders = listEncoders();
    const fmtInfo = availableFormats(encoders)[format] || availableFormats(encoders)[DEFAULT_FORMAT];
    if (!fmtInfo.available) throw new Error(`${fmtInfo.label} needs the ${fmtInfo.vcodec} encoder, which this ffmpeg build does not have.`);
    const enc = encoderArgs(format, { quality, crf, maxBitrate, alpha, audio }, encoders);
    if (enc.alpha) pageUrl += (pageUrl.includes('?') ? '&' : '?') + 'alpha=1';
    await page.goto(pageUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__videditor, null, { timeout: 15000 });
    const info = await page.evaluate(() => window.__videditor.info());
    let fps = fpsOpt || info.fps || 30; if (format === 'gif') fps = Math.min(fps, 15);
    const width = info.width, height = info.height;
    await page.setViewportSize({ width, height });
    // Optional range: render only [start, end) of the timeline.
    const r0 = range && Number.isFinite(Number(range.start)) ? Math.max(0, Number(range.start)) : 0;
    const r1 = range && Number.isFinite(Number(range.end)) ? Math.min(info.duration, Number(range.end)) : info.duration;
    if (r1 <= r0) throw new Error(`Empty range ${r0}–${r1}s`);
    const outDur = r1 - r0;
    const frames = Math.max(1, Math.round(outDur * fps));
    log(`composition ${info.id}: ${width}×${height}${scale !== 1 ? ` × ${scale} = ${Math.round(width * scale)}×${Math.round(height * scale)}` : ''}, ${r0 || r1 !== info.duration ? `${r0}–${r1}s of ${info.duration}s` : `${info.duration}s`} @ ${fps}fps → ${frames} frames`);
    log(`format: ${enc.format.label}${enc.crf !== null ? ` · crf ${enc.crf}` : ''}${enc.alpha ? ' · transparent' : ''}${audio && enc.format.acodec ? '' : ' · no audio'}`);
    // Every <video> clip must decode, or it renders as black frames. Wait for metadata, then say which ones fail.
    const bad = await page.evaluate(async () => {
      const vids = [...document.querySelectorAll('video')];
      await Promise.all(vids.map((v) => (v.readyState >= 1 || v.error ? null : new Promise((r) => { v.addEventListener('loadedmetadata', r, { once: true }); v.addEventListener('error', r, { once: true }); setTimeout(r, 20000); }))));
      return vids.filter((v) => v.error || !v.videoWidth).map((v) => ({ id: v.id || null, src: v.getAttribute('src'), error: v.error ? v.error.code : null }));
    });
    for (const b of bad) log(`⚠ video ${b.id ? '#' + b.id + ' ' : ''}(${b.src}) ${b.error ? `failed to load (error ${b.error})` : 'has no picture'}: it will render as black. Check the file exists and plays in Chrome.`);
    if (format === 'png-seq') {
      // PNG sequence: frames straight to a folder, no ffmpeg.
      fs.mkdirSync(out, { recursive: true });
      const t0 = Date.now();
      for (let i = 0; i < frames; i++) { await page.evaluate((tt) => window.__videditor.seekAndSettle(tt), r0 + i / fps); const shot = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width, height }, omitBackground: enc.alpha, caret: 'hide' }); fs.writeFileSync(path.join(out, `frame-${String(i + 1).padStart(5, '0')}.png`), shot); if (i % Math.max(1, Math.round(fps / 2)) === 0 || i === frames - 1) onProgress?.({ frame: i + 1, frames, t: i / fps, elapsed: (Date.now() - t0) / 1000 }); }
      log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${frames} PNGs in ${out}`);
      return { out, frames, fps, width: Math.round(width * scale), height: Math.round(height * scale), duration: info.duration, format, folder: true };
    }

    // Audio inputs from the parsed composition (needs src paths, which the runtime doesn't expose).
    const entry = (() => { try { const u = new URL(pageUrl); const mm = /\/project-files\/[^/]+\/(.+)$/.exec(u.pathname); return mm ? decodeURIComponent(mm[1]) : 'index.html'; } catch { return 'index.html'; } })();
    const comp = parseProject(dir, entry);
    const audioClips = (comp?.clips || []).filter((c) => c.hasAudio && c.src && c.start !== null).map((c) => ({ ...c, file: resolveSrc(dir, assetsDir, c.src, c.fileAbs) })).filter((c) => c.file && fs.existsSync(c.file) && hasAudioStream(c.file));
    const wantAudio = audio && !!enc.format.acodec && audioClips.length > 0;
    const args = ['-y', '-v', 'error', '-stats_period', '1', '-f', 'image2pipe', '-framerate', String(fps), '-i', 'pipe:0'];
    if (wantAudio) for (const a of audioClips) args.push('-i', a.file);
    const filters = [];
    const vfilters = [];
    if (scale !== 1) vfilters.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');
    if (enc.gifFilter) vfilters.push(enc.gifFilter);
    if (vfilters.length) filters.push(`[0:v]${vfilters.join(',')}[vout]`);
    if (wantAudio) {
      audioClips.forEach((a, i) => { const dur = a.duration ?? (info.duration - a.start); const ms = Math.round(a.start * 1000); filters.push(`[${i + 1}:a]atrim=start=${a.mediaStart || 0}:duration=${dur},asetpts=PTS-STARTPTS,volume=${a.volume ?? 1},adelay=${ms}|${ms}[a${i}]`); });
      filters.push(`${audioClips.map((_, i) => `[a${i}]`).join('')}amix=inputs=${audioClips.length}:normalize=0:duration=longest,apad=whole_dur=${info.duration}${r0 || r1 !== info.duration ? `,atrim=start=${r0}:end=${r1},asetpts=PTS-STARTPTS` : ''}[aout]`);
    }
    if (filters.length) args.push('-filter_complex', filters.join(';'));
    args.push('-map', vfilters.length ? '[vout]' : '0:v');
    if (wantAudio) args.push('-map', '[aout]', ...enc.audioArgs); else args.push('-an');
    args.push(...enc.args, '-t', String(outDur), out);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    log(`audio tracks: ${wantAudio ? audioClips.map((a) => path.basename(a.file)).join(', ') : audioClips.length ? 'muted' : 'none'}`);
    ffmpeg = spawn('ffmpeg', args);
    let ffErr = '';
    ffmpeg.stderr.on('data', (d) => { ffErr += d.toString(); if (ffErr.length > 8000) ffErr = ffErr.slice(-8000); });
    const ffDone = new Promise((resolve, reject) => { ffmpeg.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${ffErr.trim().split('\n').slice(-3).join(' | ')}`)))); ffmpeg.on('error', reject); });
    const write = (buf) => new Promise((resolve, reject) => { if (!ffmpeg.stdin.writable) return reject(new Error('ffmpeg closed early: ' + ffErr.trim().split('\n').slice(-2).join(' | '))); const ok = ffmpeg.stdin.write(buf); if (ok) resolve(); else ffmpeg.stdin.once('drain', resolve); });

    const type = quality === 'high' || enc.alpha || format === 'gif' || format === 'mov-prores' ? 'png' : 'jpeg';
    const t0 = Date.now();
    for (let i = 0; i < frames; i++) {
      const t = r0 + i / fps;
      await page.evaluate((tt) => window.__videditor.seekAndSettle(tt), t);
      const shot = await page.screenshot({ type, ...(type === 'jpeg' ? { quality: 95 } : {}), clip: { x: 0, y: 0, width, height }, omitBackground: enc.alpha, caret: 'hide' });
      await write(shot);
      if (i % Math.max(1, Math.round(fps / 2)) === 0 || i === frames - 1) onProgress?.({ frame: i + 1, frames, t, elapsed: (Date.now() - t0) / 1000 });
    }
    ffmpeg.stdin.end();
    await ffDone;
    log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${out}`);
    return { out, frames, fps, width: Math.round(width * scale), height: Math.round(height * scale), duration: outDur, range: r0 || r1 !== info.duration ? { start: r0, end: r1 } : null, format, label: enc.format.label };
  } finally {
    try { ffmpeg?.stdin?.destroy(); } catch {}
    await browser.close().catch(() => {});
  }
}

// ---- live frame capture (Review "Live" mode, MCP get_frame on the composition). One warm page per URL.
const livePages = new Map(); // pageUrl -> { browser, page, timer, info }
export async function captureFrame({ pageUrl, t, width = 1280 }) {
  const pw = loadPlaywright(); if (!pw) throw new Error('Playwright is not installed (npm install in videditor/)');
  let lp = livePages.get(pageUrl);
  if (!lp) {
    const browser = await launchBrowser(pw);
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    await page.goto(pageUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__videditor, null, { timeout: 15000 });
    const info = await page.evaluate(() => window.__videditor.info());
    await page.setViewportSize({ width: info.width, height: info.height });
    lp = { browser, page, info, timer: null }; livePages.set(pageUrl, lp);
  } else { await lp.page.reload({ waitUntil: 'load' }).catch(() => {}); await lp.page.waitForFunction(() => !!window.__videditor, null, { timeout: 15000 }); lp.info = await lp.page.evaluate(() => window.__videditor.info()); }
  clearTimeout(lp.timer); lp.timer = setTimeout(async () => { livePages.delete(pageUrl); await lp.browser.close().catch(() => {}); }, 90 * 1000); lp.timer.unref?.();
  await lp.page.evaluate((tt) => window.__videditor.seekAndSettle(tt), Math.max(0, Math.min(lp.info.duration, t)));
  const scale = Math.min(1, width / lp.info.width);
  const buf = await lp.page.screenshot({ type: 'jpeg', quality: 90, clip: { x: 0, y: 0, width: lp.info.width, height: lp.info.height }, scale: 'css' });
  return { buf, info: lp.info, scale };
}
