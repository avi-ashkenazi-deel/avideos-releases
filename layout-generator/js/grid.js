/* Formats and the grid: columns, rows, gutters, safe space, all on a pixel grid. */
const Grid = (() => {
  const FORMATS = [
    { id: 'square',   name: 'Square post',   w: 1080, h: 1080, cols: 12, ratio: '1:1',    tags: ['instagram', 'ig', 'square', 'squares', 'feed', 'carousel', 'grid post'] },
    { id: 'story',    name: 'Story / Reel',  w: 1080, h: 1920, cols: 6,  ratio: '9:16',   tags: ['story', 'stories', 'reel', 'reels', 'tiktok', 'vertical', 'portrait', 'shorts'], safe: { top: 250, bottom: 320 } },
    { id: 'linkedin', name: 'LinkedIn post', w: 1200, h: 628,  cols: 12, ratio: '1.91:1', tags: ['linkedin', 'link', 'og', 'open graph', 'facebook'] },
    { id: 'x',        name: 'X post',        w: 1600, h: 900,  cols: 12, ratio: '16:9',   tags: ['x post', 'twitter', 'tweet', 'x'] },
    { id: 'slide',    name: 'Slide',         w: 1920, h: 1080, cols: 12, ratio: '16:9',   tags: ['slide', 'slides', 'deck', 'presentation', 'keynote', 'pitch', 'widescreen'] },
    { id: 'portrait', name: 'Portrait 4:5',  w: 1080, h: 1350, cols: 8,  ratio: '4:5',    tags: ['portrait', '4:5', 'feed portrait'] },
    { id: 'poster',   name: 'Poster A',      w: 1240, h: 1754, cols: 8,  ratio: '1:1.41', tags: ['poster', 'a4', 'a3', 'print', 'flyer', 'one-pager', 'one pager'] },
    { id: 'banner',   name: 'Wide banner',   w: 2400, h: 800,  cols: 16, ratio: '3:1',    tags: ['banner', 'billboard', 'header', 'email header', 'cover', 'hero', 'wide', 'leaderboard'] },
  ];
  const byId = Object.fromEntries(FORMATS.map(f => [f.id, f]));

  // Compute a modular grid for a format under the brand's grid rules.
  // Everything lands on integer pixels; cells are multiples of the pixel unit.
  function compute(format, rules) {
    const unit = rules.unit || 8;
    const gutter = (rules.gutterUnits || 3) * unit;
    const minDim = Math.min(format.w, format.h);
    let margin = Math.round((rules.marginRatio || 0.06) * minDim / unit) * unit;
    const cols = format.cols;
    // Columns
    let contentW = format.w - 2 * margin - (cols - 1) * gutter;
    let cw = Math.floor(contentW / (cols * unit)) * unit;
    let leftover = contentW - cw * cols;
    const mx = margin + Math.floor(leftover / 2);
    // Rows: same module vertically, count chosen to fill height
    let rows = Math.max(3, Math.round(cols * (format.h - 2 * margin) / (format.w - 2 * margin)));
    let contentH = format.h - 2 * margin - (rows - 1) * gutter;
    let rh = Math.floor(contentH / (rows * unit)) * unit;
    while (rh < unit * 3 && rows > 3) { rows--; contentH = format.h - 2 * margin - (rows - 1) * gutter; rh = Math.floor(contentH / (rows * unit)) * unit; }
    leftover = contentH - rh * rows;
    const my = margin + Math.floor(leftover / 2);
    const safe = { top: format.safe ? Math.max(my, format.safe.top) : my, bottom: format.safe ? Math.max(my, format.safe.bottom) : my, left: mx, right: mx };
    // Rows that fall in platform-reserved zones are unusable for text/logo.
    const rowY = r => my + r * (rh + gutter);
    const firstRow = [...Array(rows).keys()].find(r => rowY(r) >= safe.top) ?? 0;
    let lastRow = rows - 1;
    while (lastRow > firstRow && rowY(lastRow) + rh > format.h - safe.bottom) lastRow--;
    return { unit, gutter, cols, rows, cw, rh, mx, my, w: format.w, h: format.h, safe, firstRow, lastRow, usableRows: lastRow - firstRow + 1 };
  }
  // Rect (px) for a span of cells.
  function rect(g, c0, r0, cspan, rspan) {
    return {
      x: g.mx + c0 * (g.cw + g.gutter),
      y: g.my + r0 * (g.rh + g.gutter),
      w: cspan * g.cw + (cspan - 1) * g.gutter,
      h: rspan * g.rh + (rspan - 1) * g.gutter,
    };
  }
  const snap = (v, unit) => Math.round(v / unit) * unit;
  function detectFormats(text) {
    const t = ' ' + text.toLowerCase() + ' ';
    const found = [];
    for (const f of FORMATS) for (const tag of f.tags) {
      if (t.includes(' ' + tag + ' ') || t.includes(' ' + tag + 's ') || t.includes(' ' + tag + ',')) { found.push(f.id); break; }
    }
    if (/\b(all|every) (formats?|sizes?|channels?)\b/.test(t)) return FORMATS.map(f => f.id);
    return [...new Set(found)];
  }
  return { FORMATS, byId, compute, rect, snap, detectFormats };
})();
