// Export formats: container + codec + the ffmpeg arguments that make a good file at a given quality.
// `crf` scales differ per codec, so each format maps draft/looks/high to its own numbers.
export const FORMATS = {
  'mp4-h264':  { label: 'MP4 · H.264', ext: '.mp4', vcodec: 'libx264', acodec: 'aac', crf: { draft: 28, looks: 18, high: 14 }, alpha: false, note: 'Plays everywhere. LinkedIn, Slack, email, decks.' },
  'mp4-hevc':  { label: 'MP4 · HEVC (H.265)', ext: '.mp4', vcodec: 'libx265', acodec: 'aac', crf: { draft: 30, looks: 22, high: 18 }, alpha: false, note: 'About 40% smaller than H.264 at the same quality. Apple devices and modern browsers; not Chrome on Windows.' },
  'mp4-av1':   { label: 'MP4 · AV1', ext: '.mp4', vcodec: 'libsvtav1', acodec: 'aac', crf: { draft: 42, looks: 32, high: 26 }, alpha: false, note: 'Smallest files, best quality per byte. Modern browsers and phones; slower to encode.' },
  'webm-av1':  { label: 'WebM · AV1', ext: '.webm', vcodec: 'libsvtav1', acodec: 'libopus', crf: { draft: 42, looks: 32, high: 26 }, alpha: false, note: 'For the web. Same codec as MP4 · AV1 in a WebM container with Opus audio.' },
  'webm-vp9':  { label: 'WebM · VP9', ext: '.webm', vcodec: 'libvpx-vp9', acodec: 'libopus', crf: { draft: 40, looks: 31, high: 24 }, alpha: true, note: 'Web video with optional transparency (overlays, product UI on a page).' },
  'mov-prores': { label: 'MOV · ProRes 4444', ext: '.mov', vcodec: 'prores_ks', acodec: 'aac', crf: null, alpha: true, note: 'For editing in Premiere / Final Cut / After Effects, with alpha. Very large files; does not play in browsers.' },
  'gif':       { label: 'GIF', ext: '.gif', vcodec: 'gif', acodec: null, crf: null, alpha: false, note: 'No sound, 256 colors, capped at 15 fps. For chat and docs only.' },
  'png-seq':   { label: 'PNG sequence', ext: '', vcodec: null, acodec: null, crf: null, alpha: true, note: 'One PNG per frame with alpha, in a folder. For compositing elsewhere.' },
};
export const DEFAULT_FORMAT = 'mp4-h264';

/** Which formats can run on this machine, given ffmpeg's encoders. */
export function availableFormats(encoders) {
  const has = (e) => !e || encoders.includes(e);
  return Object.fromEntries(Object.entries(FORMATS).map(([k, f]) => {
    let vcodec = f.vcodec;
    if (vcodec === 'libsvtav1' && !has('libsvtav1')) vcodec = has('libaom-av1') ? 'libaom-av1' : has('librav1e') ? 'librav1e' : 'libsvtav1';
    const available = k === 'png-seq' || (has(vcodec) && (f.acodec ? has(f.acodec) || has('aac') : true));
    return [k, { ...f, vcodec, available }];
  }));
}

/** ffmpeg video/audio arguments for a format at a quality. opts: { crf, maxBitrate (Mbps), fps, alpha, audio } */
export function encoderArgs(key, { quality = 'looks', crf, maxBitrate, alpha = false, audio = true, preset } = {}, encoders = []) {
  const f = availableFormats(encoders)[key] || availableFormats(encoders)[DEFAULT_FORMAT];
  const q = f.crf ? (Number.isFinite(Number(crf)) ? Number(crf) : f.crf[quality] || f.crf.looks) : null;
  const v = []; const a = []; const filters = [];
  const useAlpha = alpha && f.alpha;
  const pix = useAlpha ? (f.vcodec === 'libvpx-vp9' ? 'yuva420p' : 'yuva444p10le') : (f.vcodec === 'libx265' || f.vcodec?.includes('av1') || f.vcodec === 'libx264' || f.vcodec === 'libvpx-vp9') ? 'yuv420p' : 'yuv422p10le';
  switch (f.vcodec) {
    case 'libx264': v.push('-c:v', 'libx264', '-preset', preset || (quality === 'draft' ? 'veryfast' : quality === 'high' ? 'slow' : 'medium'), '-crf', String(q), '-profile:v', 'high', '-pix_fmt', pix, '-movflags', '+faststart'); break;
    case 'libx265': v.push('-c:v', 'libx265', '-preset', preset || (quality === 'draft' ? 'fast' : 'medium'), '-crf', String(q), '-tag:v', 'hvc1', '-pix_fmt', pix, '-movflags', '+faststart'); break;
    case 'libsvtav1': v.push('-c:v', 'libsvtav1', '-crf', String(q), '-preset', preset || (quality === 'draft' ? '10' : quality === 'high' ? '4' : '6'), '-svtav1-params', 'tune=0', '-pix_fmt', pix); if (f.ext === '.mp4') v.push('-movflags', '+faststart'); break;
    case 'libaom-av1': v.push('-c:v', 'libaom-av1', '-crf', String(q), '-b:v', '0', '-cpu-used', quality === 'high' ? '3' : '6', '-row-mt', '1', '-pix_fmt', pix); if (f.ext === '.mp4') v.push('-movflags', '+faststart'); break;
    case 'librav1e': v.push('-c:v', 'librav1e', '-qp', String(Math.round(q * 255 / 63)), '-speed', quality === 'high' ? '4' : '8', '-pix_fmt', pix); break;
    case 'libvpx-vp9': v.push('-c:v', 'libvpx-vp9', '-crf', String(q), '-b:v', '0', '-row-mt', '1', '-deadline', quality === 'draft' ? 'realtime' : 'good', '-cpu-used', quality === 'high' ? '1' : '3', '-pix_fmt', pix); if (useAlpha) v.push('-auto-alt-ref', '0'); break;
    case 'prores_ks': v.push('-c:v', 'prores_ks', '-profile:v', useAlpha ? '4' : '3', '-pix_fmt', useAlpha ? 'yuva444p10le' : 'yuv422p10le', '-vendor', 'apl0'); break;
    case 'gif': filters.push('split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3'); break;
  }
  if (maxBitrate && f.vcodec && f.vcodec !== 'prores_ks' && f.vcodec !== 'gif') { const mb = Number(maxBitrate); v.push('-maxrate', `${mb}M`, '-bufsize', `${mb * 2}M`); }
  if (f.acodec && audio) a.push('-c:a', f.acodec, '-b:a', f.acodec === 'libopus' ? '128k' : '192k'); else a.push('-an');
  return { format: f, args: [...v], audioArgs: a, gifFilter: filters[0] || null, alpha: useAlpha, crf: q, pix };
}
