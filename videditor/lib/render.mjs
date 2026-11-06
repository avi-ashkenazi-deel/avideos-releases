// Frame-exact renderer: Chrome steps through the composition one frame at a
// time (via the runtime's deterministic seek), each frame is screenshotted
// and piped into ffmpeg, and the composition's audio clips are mixed in.
import fs from 'node:fs';
import os from 'node:os';
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
  // The Mac app ships its own headless Chrome (VIDEDITOR_CHROME); a developer checkout uses installed Chrome/Edge.
  if (process.env.VIDEDITOR_CHROME) return pw.chromium.launch({ executablePath: process.env.VIDEDITOR_CHROME });
  try { return await pw.chromium.launch({ channel: 'chrome' }); } catch {}
  try { return await pw.chromium.launch({ channel: 'msedge' }); } catch {}
  return pw.chromium.launch();
}

function hasAudioStream(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return r.status === 0 && /audio/.test(r.stdout);
}

/**
 * renderProject({ pageUrl, dir, out, fps, quality, workers, onProgress, onLog })
 * pageUrl: the composition served with the clock + runtime injected (…/index.html?runtime=1&render=1)
 *
 * Parallel: the frames are cut into short chunks taken from a shared queue. Each worker is its own Chrome
 * (separate GPU/raster process: contexts in one browser share it and barely scale), walks the video clock
 * forward to each chunk, captures it through CDP and encodes it with its own ffmpeg. The chunks are
 * joined without re-encoding and the composition's audio is mixed in at the end.
 */
export async function renderProject({ pageUrl, dir, assetsDir = null, out, fps: fpsOpt, quality = 'looks', scale = 1, format = DEFAULT_FORMAT, crf, maxBitrate, audio = true, alpha = false, range = null, workers: workersOpt = 'auto', onProgress, onLog } = {}) {
  const log = (m) => onLog?.(m);
  const pw = loadPlaywright();
  if (!pw) throw new Error('Playwright is not installed. Run: npm install   (inside the videditor folder)');
  scale = Math.max(0.25, Math.min(4, Number(scale) || 1));
  const encoders = listEncoders();
  const fmtInfo = availableFormats(encoders)[format] || availableFormats(encoders)[DEFAULT_FORMAT];
  if (!fmtInfo.available) throw new Error(`${fmtInfo.label} needs the ${fmtInfo.vcodec} encoder, which this ffmpeg build does not have.`);
  const enc = encoderArgs(format, { quality, crf, maxBitrate, alpha, audio }, encoders);
  if (enc.alpha) pageUrl += (pageUrl.includes('?') ? '&' : '?') + 'alpha=1';
  const type = quality === 'high' || enc.alpha || format === 'gif' || format === 'mov-prores' || format === 'png-seq' ? 'png' : 'jpeg';

  const opened = []; const ffs = []; const parts = [];
  const openWorker = async (first) => {
    const browser = await launchBrowser(pw); opened.push(browser);
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: scale });
    if (first) { page.on('pageerror', (e) => log(`page error: ${e.message}`)); page.on('console', (m) => { if (m.type() === 'error') log(`console: ${m.text().slice(0, 200)}`); }); }
    await page.goto(pageUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__videditor, null, { timeout: 15000 });
    const info = await page.evaluate(() => window.__videditor.info());
    await page.setViewportSize({ width: info.width, height: info.height });
    const cdp = await page.context().newCDPSession(page);
    if (enc.alpha) await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    // Every <video> clip must decode, or it renders as black frames. Wait for metadata, then report failures.
    const bad = await page.evaluate(async () => {
      const vids = [...document.querySelectorAll('video')];
      await Promise.all(vids.map((v) => (v.readyState >= 1 || v.error ? null : new Promise((r) => { v.addEventListener('loadedmetadata', r, { once: true }); v.addEventListener('error', r, { once: true }); (window.__vdClock?.native.setTimeout || setTimeout)(r, 60000); }))));
      return vids.filter((v) => v.error || !v.videoWidth).map((v) => ({ id: v.id || null, src: v.getAttribute('src'), error: v.error ? v.error.code : null }));
    });
    if (first) for (const b of bad) log(`⚠ video ${b.id ? '#' + b.id + ' ' : ''}(${String(b.src).replace(/[?&]vdrender=1.*$/, '')}) ${b.error ? `failed to load (error ${b.error})` : 'has no picture'}: it will render as black. Check the file exists and plays in Chrome.`);
    return { browser, page, cdp, info };
  };
  // CDP ignores the page's device scale unless the clip says so: pass it explicitly (1.5× → 1080p from 720p, 3× → 4K).
  const capture = async (w) => { const clip = { x: 0, y: 0, width: w.info.width, height: w.info.height, scale }; const { data } = await w.cdp.send('Page.captureScreenshot', type === 'jpeg' ? { format: 'jpeg', quality: 90, clip } : { format: 'png', clip }); return Buffer.from(data, 'base64'); };

  try {
    // Start the likely number of workers right away (they load in parallel); extras are closed once we know the frame count.
    const guess = format === 'gif' ? 1 : Math.max(1, Math.min(16, workersOpt === 'auto' || !workersOpt ? Math.max(1, Math.min(os.cpus().length - 1, 6)) : Number(workersOpt) || 1));
    const early = [openWorker(true), ...Array.from({ length: guess - 1 }, () => openWorker(false).catch(() => null))];
    const w0 = await early[0];
    log(`browser: ${w0.browser.browserType().name()} ${w0.browser.version()}`);
    const info = w0.info;
    let fps = fpsOpt || info.fps || 30; if (format === 'gif') fps = Math.min(fps, 15);
    const width = info.width, height = info.height;
    const r0 = range && Number.isFinite(Number(range.start)) ? Math.max(0, Number(range.start)) : 0;
    const r1 = range && Number.isFinite(Number(range.end)) ? Math.min(info.duration, Number(range.end)) : info.duration;
    if (r1 <= r0) throw new Error(`Empty range ${r0}–${r1}s`);
    const outDur = r1 - r0;
    const frames = Math.max(1, Math.round(outDur * fps));

    // How many workers: leave a core for ffmpeg and the system, ~600 MB per Chrome, at least ~40 frames each.
    const big = width * height * scale * scale > 2560 * 1440;
    const auto = Math.max(1, Math.min(os.cpus().length - 1, Math.floor(os.freemem() / (big ? 1.2e9 : 6e8)), big ? 3 : 6, Math.ceil(frames / 40)));
    const nWorkers = format === 'gif' ? 1 : Math.max(1, Math.min(16, workersOpt === 'auto' || !workersOpt ? auto : Number(workersOpt) || 1, frames));
    log(`composition ${info.id}: ${width}×${height}${scale !== 1 ? ` × ${scale} = ${Math.round(width * scale)}×${Math.round(height * scale)}` : ''}, ${r0 || r1 !== info.duration ? `${r0}–${r1}s of ${info.duration}s` : `${info.duration}s`} @ ${fps}fps → ${frames} frames on ${nWorkers} worker${nWorkers > 1 ? 's' : ''}`);
    log(`format: ${enc.format.label}${enc.crf !== null ? ` · crf ${enc.crf}` : ''}${enc.alpha ? ' · transparent' : ''}${audio && enc.format.acodec ? '' : ' · no audio'}`);

    const ready = (await Promise.all(early.slice(1))).filter(Boolean);
    for (const extra of ready.splice(nWorkers - 1)) await extra.browser.close().catch(() => {});
    const ws = [w0, ...ready, ...(await Promise.all(Array.from({ length: Math.max(0, nWorkers - 1 - ready.length) }, () => openWorker(false))))];
    // Work queue: short chunks in film order; each worker takes the next free one, so busy and static
    // stretches even out. A worker's chunks only move forward in time, so its clock never runs backwards.
    // Each chunk starts with a keyframe, so fewer, longer chunks keep files small: about two per worker, at least 1 s.
    const chunk = nWorkers === 1 ? frames : Math.max(Math.round(fps), Math.ceil(frames / (nWorkers * 2)));
    const chunks = []; for (let a = 0, k = 0; a < frames; a += chunk, k++) chunks.push({ k, a, b: Math.min(frames, a + chunk) });
    let nextChunk = 0; const take = () => (nextChunk < chunks.length ? chunks[nextChunk++] : null);
    const t0 = Date.now(); let done = 0; let reused = 0; const prof = { seek: 0, capture: 0, write: 0, encodeTail: 0 };
    const tick = (t) => { done++; if (done % Math.max(1, Math.round(fps / 2)) === 0 || done === frames) onProgress?.({ frame: done, frames, t, elapsed: (Date.now() - t0) / 1000 }); };

    if (format === 'png-seq') {
      fs.mkdirSync(out, { recursive: true });
      await Promise.all(ws.map(async (w) => {
        for (let c = take(); c; c = take()) {
          if (r0 + c.a / fps > 0) await w.page.evaluate(([tt, f]) => window.__videditor.warmup(tt, f), [r0 + c.a / fps, fps]);
          for (let i = c.a; i < c.b; i++) { const t = r0 + i / fps; await w.page.evaluate((tt) => window.__videditor.seekForCapture(tt), t); fs.writeFileSync(path.join(out, `frame-${String(i + 1).padStart(5, '0')}.png`), await capture(w)); tick(t); }
        }
      }));
      log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${frames} PNGs in ${out}`);
      return { out, frames, fps, width: Math.round(width * scale), height: Math.round(height * scale), duration: info.duration, format, folder: true };
    }

    fs.mkdirSync(path.dirname(out), { recursive: true });
    const ext = path.extname(out) || '.mp4';
    const vf = scale !== 1 ? 'scale=trunc(iw/2)*2:trunc(ih/2)*2' : null;
    const sliceArgs = (part) => {
      const a = ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-i', 'pipe:0'];
      if (enc.gifFilter) a.push('-filter_complex', `[0:v]${vf ? vf + ',' : ''}${enc.gifFilter}`); else if (vf) a.push('-vf', vf);
      a.push('-an', ...enc.args, part);
      return a;
    };
    const encodeChunk = async (w, { k, a, b }) => {
      const part = format === 'gif' ? out : `${out}.part${k}${ext}`; if (part !== out) parts.push(part);
      const ff = spawn('ffmpeg', sliceArgs(part)); ffs.push(ff);
      let ffErr = ''; ff.stderr.on('data', (d) => { ffErr = (ffErr + d).slice(-8000); });
      const ffDone = new Promise((resolve, reject) => { ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${ffErr.trim().split('\n').slice(-3).join(' | ')}`)))); ff.on('error', reject); });
      const write = (buf) => new Promise((resolve, reject) => { if (!ff.stdin.writable) return reject(new Error('ffmpeg closed early: ' + ffErr.trim().split('\n').slice(-2).join(' | '))); if (ff.stdin.write(buf)) resolve(); else ff.stdin.once('drain', resolve); });
      if (r0 + a / fps > 0) await w.page.evaluate(([tt, f]) => window.__videditor.warmup(tt, f), [r0 + a / fps, fps]);
      let prev = null;
      for (let i = a; i < b; i++) {
        const t = r0 + i / fps; let q0 = Date.now(); const st = await w.page.evaluate((tt) => window.__videditor.seekForCapture(tt), t); prof.seek += Date.now() - q0;
        if (prev && st && st.same && !process.env.VD_NO_REUSE) { reused++; q0 = Date.now(); await write(prev); prof.write += Date.now() - q0; } else { q0 = Date.now(); prev = await capture(w); prof.capture += Date.now() - q0; q0 = Date.now(); await write(prev); prof.write += Date.now() - q0; }
        tick(t);
      }
      ff.stdin.end(); return { encoded: ffDone }; // the encoder finishes in the background while this worker captures the next chunk
    };
    const encoding = [];
    await Promise.all(ws.map(async (w) => { for (let c = take(); c; c = take()) { const { encoded } = await encodeChunk(w, c); encoded.catch(() => {}); encoding.push(encoded); } }));
    const q1 = Date.now(); await Promise.all(encoding); prof.encodeTail += Date.now() - q1;
    const tCapture = (Date.now() - t0) / 1000;
    if (process.env.VD_PROFILE) log(`profile (summed over workers, ms): ${JSON.stringify(prof)}`);
    await Promise.all(opened.splice(0).map((b) => b.close().catch(() => {})));

    // Audio inputs from the parsed composition (needs src paths, which the runtime doesn't expose).
    const entry = (() => { try { const u = new URL(pageUrl); const mm = /\/project-files\/[^/]+\/(.+)$/.exec(u.pathname); return mm ? decodeURIComponent(mm[1]) : 'index.html'; } catch { return 'index.html'; } })();
    const comp = parseProject(dir, entry);
    const audioClips = (comp?.clips || []).filter((c) => c.hasAudio && c.src && c.start !== null).map((c) => ({ ...c, file: resolveSrc(dir, assetsDir, c.src, c.fileAbs) })).filter((c) => c.file && fs.existsSync(c.file) && hasAudioStream(c.file));
    const wantAudio = audio && !!enc.format.acodec && audioClips.length > 0;
    log(`audio tracks: ${wantAudio ? audioClips.map((a) => path.basename(a.file)).join(', ') : audioClips.length ? 'muted' : 'none'}`);
    if (format !== 'gif') {
      // Join the chunks without re-encoding, mixing the audio in.
      const list = `${out}.parts.txt`; parts.push(list);
      fs.writeFileSync(list, chunks.map(({ k }) => `file '${`${out}.part${k}${ext}`.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
      const args = ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list];
      if (wantAudio) for (const a of audioClips) args.push('-i', a.file);
      if (wantAudio) {
        const filters = audioClips.map((a, i) => { const d = a.duration ?? (info.duration - a.start); const ms = Math.round(a.start * 1000); return `[${i + 1}:a]atrim=start=${a.mediaStart || 0}:duration=${d},asetpts=PTS-STARTPTS,volume=${a.volume ?? 1},adelay=${ms}|${ms}[a${i}]`; });
        filters.push(`${audioClips.map((_, i) => `[a${i}]`).join('')}amix=inputs=${audioClips.length}:normalize=0:duration=longest,apad=whole_dur=${info.duration}${r0 || r1 !== info.duration ? `,atrim=start=${r0}:end=${r1},asetpts=PTS-STARTPTS` : ''}[aout]`);
        args.push('-filter_complex', filters.join(';'), '-map', '0:v', '-map', '[aout]', ...enc.audioArgs);
      } else args.push('-map', '0:v', '-an');
      args.push('-c:v', 'copy');
      if (/\.(mp4|mov)$/i.test(ext)) args.push('-movflags', '+faststart');
      args.push('-t', String(outDur), out);
      const mux = spawnSync('ffmpeg', args, { encoding: 'utf8' });
      if (mux.status !== 0) throw new Error(`joining the chunks failed: ${(mux.stderr || '').trim().split('\n').slice(-3).join(' | ')}`);
    }
    log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s (capture ${tCapture.toFixed(1)}s${reused ? `, ${reused} unchanged frames reused` : ''}) → ${out}`);
    return { out, frames, fps, width: Math.round(width * scale), height: Math.round(height * scale), duration: outDur, range: r0 || r1 !== info.duration ? { start: r0, end: r1 } : null, format, label: enc.format.label, workers: ws.length };
  } finally {
    for (const ff of ffs) { try { ff.stdin?.destroy(); } catch {} try { if (ff.exitCode === null) ff.kill('SIGKILL'); } catch {} }
    for (const p of parts) { try { fs.unlinkSync(p); } catch {} }
    await Promise.all(opened.map((b) => b.close().catch(() => {})));
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
