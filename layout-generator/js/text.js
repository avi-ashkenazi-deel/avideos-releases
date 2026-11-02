/* Text measurement and fitting with a canvas. Fonts must be loaded before measuring. */
const Text = (() => {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const cache = new Map();
  function fontString(f) { return `${f.style || 'normal'} ${f.weight} ${f.size}px ${quote(f.family)}`; }
  function quote(fam) { return fam.split(',').map(s => s.trim()).map(s => /^[a-zA-Z0-9-]+$/.test(s) ? s : `"${s.replace(/"/g, '')}"`).join(', '); }
  function width(str, f) {
    const key = fontString(f) + '|' + (f.letterSpacing || 0) + '|' + str;
    let w = cache.get(key);
    if (w == null) {
      ctx.font = fontString(f);
      w = ctx.measureText(str).width + (f.letterSpacing || 0) * f.size * Math.max(0, str.length - 1);
      cache.set(key, w);
    }
    return w;
  }
  // Greedy word wrap. Returns lines or null if a single word cannot fit.
  function wrap(str, f, maxWidth) {
    const paragraphs = String(str || '').replace(/\r/g, '').split('\n');
    const lines = [];
    for (const p of paragraphs) {
      const words = p.split(/\s+/).filter(Boolean);
      if (!words.length) { lines.push(''); continue; }
      let line = '';
      for (const w of words) {
        const test = line ? line + ' ' + w : w;
        if (width(test, f) <= maxWidth) line = test;
        else {
          if (!line) { if (width(w, f) > maxWidth) return null; line = w; continue; }
          lines.push(line); line = w;
          if (width(w, f) > maxWidth) return null;
        }
      }
      lines.push(line);
    }
    return lines;
  }
  // Fit text into a box by stepping the size down. Returns {size, lines, height} or null.
  function fit(str, f, maxWidth, maxHeight, opts = {}) {
    const minSize = opts.minSize || 12, step = opts.step || 2, maxLines = opts.maxLines || 99, lh = f.lineHeight || 1.2;
    let size = f.size;
    while (size >= minSize) {
      const ff = { ...f, size };
      const lines = wrap(str, ff, maxWidth);
      if (lines && lines.length <= maxLines) {
        const height = lines.length * size * lh;
        if (height <= maxHeight) return { size, lines, height, lineHeight: lh };
      }
      size -= step;
    }
    return null;
  }
  function transform(str, mode) {
    if (mode === 'upper') return String(str).toUpperCase();
    if (mode === 'lower') return String(str).toLowerCase();
    return String(str);
  }
  function clearCache() { cache.clear(); metricsCache.clear(); }
  // The face's content box in em: ascent above and descent below the baseline. A browser (and Figma) centre that box in
  // the line box, so this is where the baseline goes; without the measurement, a typical 0.78 / 0.22 split.
  const metricsCache = new Map();
  function metrics(f) {
    const key = `${f.style || 'normal'} ${f.weight || 400} ${quote(f.family || 'sans-serif')}`;
    let m = metricsCache.get(key);
    if (!m) {
      m = { asc: 0.78, desc: 0.22 };
      try { ctx.font = `${f.style || 'normal'} ${f.weight || 400} 100px ${quote(f.family || 'sans-serif')}`; const t = ctx.measureText('Hg'); if (t.fontBoundingBoxAscent > 0 && t.fontBoundingBoxDescent >= 0) m = { asc: t.fontBoundingBoxAscent / 100, desc: t.fontBoundingBoxDescent / 100 }; } catch { }
      metricsCache.set(key, m);
    }
    return m;
  }
  return { width, wrap, fit, fontString, transform, clearCache, quote, metrics };
})();
