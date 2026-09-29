/* Color utilities: parsing, contrast (WCAG 2.x), mixing, palette extraction from images. */
const Color = (() => {
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  function hexToRgb(hex) {
    let h = String(hex || '').trim().replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return { r: 0, g: 0, b: 0 };
    const n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function rgbToHex({ r, g, b }) {
    return '#' + [r, g, b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('').toUpperCase();
  }
  function normalize(hex) { return rgbToHex(hexToRgb(hex)); }
  function luminance(hex) {
    const { r, g, b } = hexToRgb(hex);
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }
  function contrast(a, b) {
    const la = luminance(a), lb = luminance(b);
    const [hi, lo] = la > lb ? [la, lb] : [lb, la];
    return (hi + 0.05) / (lo + 0.05);
  }
  function isDark(hex) { return luminance(hex) < 0.35; }
  function mix(a, b, t) {
    const A = hexToRgb(a), B = hexToRgb(b);
    return rgbToHex({ r: A.r + (B.r - A.r) * t, g: A.g + (B.g - A.g) * t, b: A.b + (B.b - A.b) * t });
  }
  function withAlpha(hex, alpha) {
    const { r, g, b } = hexToRgb(hex);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  function saturation(hex) {
    const { r, g, b } = hexToRgb(hex);
    const mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255;
    return mx === 0 ? 0 : (mx - mn) / mx;
  }
  // Best readable foreground for a background from a candidate list; falls back to black/white.
  function bestForeground(bg, candidates, minRatio = 4.5) {
    const ok = candidates.filter(c => contrast(bg, c) >= minRatio).sort((a, b) => contrast(bg, b) - contrast(bg, a));
    if (ok.length) return ok;
    return [contrast(bg, '#FFFFFF') >= contrast(bg, '#000000') ? '#FFFFFF' : '#000000'];
  }
  // Quantize an <img> to a handful of dominant colors (skips near-greys and extremes).
  function extractPalette(img, max = 6) {
    const c = document.createElement('canvas');
    const w = 48, h = Math.max(1, Math.round(48 * img.naturalHeight / img.naturalWidth));
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const buckets = new Map();
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const e = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
      e.n++; e.r += r; e.g += g; e.b += b;
      buckets.set(key, e);
    }
    const list = [...buckets.values()].map(e => ({ n: e.n, hex: rgbToHex({ r: e.r / e.n, g: e.g / e.n, b: e.b / e.n }) }));
    list.sort((a, b) => b.n - a.n);
    const out = [];
    for (const item of list) {
      const lum = luminance(item.hex), sat = saturation(item.hex);
      if (lum > 0.95 || lum < 0.02) continue;
      if (sat < 0.12 && out.length > 1) continue;
      if (out.some(o => distance(o.hex, item.hex) < 60)) continue;
      out.push(item);
      if (out.length >= max) break;
    }
    return out.map(o => o.hex);
  }
  function distance(a, b) {
    const A = hexToRgb(a), B = hexToRgb(b);
    return Math.sqrt((A.r - B.r) ** 2 + (A.g - B.g) ** 2 + (A.b - B.b) ** 2);
  }
  // Luminance map of an image: grid of {mean, std} used for content-aware text placement.
  function luminanceMap(img, gx = 6, gy = 6) {
    const c = document.createElement('canvas');
    c.width = gx * 8; c.height = gy * 8;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const cells = [];
    for (let y = 0; y < gy; y++) for (let x = 0; x < gx; x++) {
      let s = 0, s2 = 0, n = 0;
      for (let yy = 0; yy < 8; yy++) for (let xx = 0; xx < 8; xx++) {
        const i = (((y * 8 + yy) * c.width) + (x * 8 + xx)) * 4;
        const l = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
        s += l; s2 += l * l; n++;
      }
      const mean = s / n;
      cells.push({ x, y, mean, std: Math.sqrt(Math.max(0, s2 / n - mean * mean)) });
    }
    return { gx, gy, cells };
  }
  return { hexToRgb, rgbToHex, normalize, luminance, contrast, isDark, mix, withAlpha, saturation, bestForeground, extractPalette, distance, luminanceMap };
})();
