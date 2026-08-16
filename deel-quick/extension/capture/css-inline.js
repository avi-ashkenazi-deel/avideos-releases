/*
 * Deel Quick — stylesheet inlining via CSSOM (capture phase 3).
 * Serializing from CSSOM (not the raw text) matters for React apps: CSS-in-JS
 * libraries insert rules directly into empty <style> tags, so cssRules is the
 * only complete source of truth. Cross-origin sheets fall back to fetching the
 * href (page context → background relay). Every sheet's relative url(...) is
 * resolved against that sheet's own base before concatenation.
 */
(() => {
  const dq = window.__deelQuick;

  const resolveUrls = (cssText, baseHref) =>
    cssText.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (match, quote, ref) => {
      const trimmed = ref.trim();
      if (trimmed.startsWith('data:') || trimmed.startsWith('#') || trimmed.startsWith('blob:')) return match;
      try {
        return `url("${new URL(trimmed, baseHref).href}")`;
      } catch (_) {
        return match;
      }
    });

  const serializeRules = (rules, baseHref, out) => {
    for (const rule of rules) {
      if (rule.type === CSSRule.IMPORT_RULE && rule.styleSheet) {
        try {
          serializeRules(rule.styleSheet.cssRules, rule.styleSheet.href || baseHref, out);
          continue;
        } catch (_) { /* cross-origin import — fall through to cssText (kept as-is, reported) */ }
      }
      out.push(resolveUrls(rule.cssText, baseHref));
    }
  };

  const readSheet = async (sheet, report) => {
    const baseHref = sheet.href || location.href;
    try {
      const out = [];
      serializeRules(sheet.cssRules, baseHref, out);
      return out.join('\n');
    } catch (_) {
      // SecurityError: cross-origin without CORS. Fetch the raw text instead.
      if (!sheet.href) return '';
      const res = await dq.fetchResourceCached(sheet.href);
      if (!res) {
        report.warnings.push(`stylesheet unreadable, skipped: ${sheet.href}`);
        return '';
      }
      let text = new TextDecoder().decode(res.bytes);
      // Recursively pull in @imports from fetched text.
      const importRe = /@import\s+(?:url\()?\s*['"]?([^'")\s;]+)['"]?\)?[^;]*;/g;
      const imports = [...text.matchAll(importRe)];
      for (const m of imports) {
        let importedText = '';
        try {
          const importUrl = new URL(m[1], sheet.href).href;
          const sub = await dq.fetchResourceCached(importUrl);
          if (sub) importedText = resolveUrls(new TextDecoder().decode(sub.bytes), importUrl);
          else report.warnings.push(`@import unreadable, skipped: ${importUrl}`);
        } catch (_) { /* leave importedText empty */ }
        text = text.replace(m[0], importedText);
      }
      return resolveUrls(text, sheet.href);
    }
  };

  // ---- Used-font filtering ---------------------------------------------------
  // The single biggest 16MB lever: only @font-face rules whose family+weight
  // were actually loaded by the page survive.

  const loadedFontKeys = () => {
    const keys = new Set();
    try {
      document.fonts.forEach((face) => {
        if (face.status === 'loaded') {
          const family = face.family.replace(/['"]/g, '').toLowerCase().trim();
          keys.add(`${family}|${face.weight}|${face.style}`);
          keys.add(family); // family-level fallback for range weights
        }
      });
    } catch (_) { /* document.fonts unavailable — keep all fonts */ }
    return keys;
  };

  const weightMatches = (faceWeight, loadedKeys, family) => {
    // face weight can be "400", "bold", or a range "100 900".
    for (const key of loadedKeys) {
      if (!key.includes('|')) continue;
      const [fam, weight] = key.split('|');
      if (fam !== family) continue;
      const w = parseInt(weight, 10) || (weight === 'bold' ? 700 : 400);
      const parts = String(faceWeight || 'normal').trim().split(/\s+/);
      const lo = parseInt(parts[0], 10) || (parts[0] === 'bold' ? 700 : 400);
      const hi = parts[1] ? parseInt(parts[1], 10) || lo : lo;
      if (w >= lo && w <= hi) return true;
    }
    return false;
  };

  dq.filterUnusedFontFaces = (cssText, report) => {
    const keys = loadedFontKeys();
    if (keys.size === 0) return cssText; // can't tell — keep everything
    let dropped = 0;
    const result = cssText.replace(/@font-face\s*\{[^}]*\}/g, (block) => {
      const famMatch = block.match(/font-family\s*:\s*['"]?([^'";}]+)['"]?/i);
      if (!famMatch) return block;
      const family = famMatch[1].toLowerCase().trim();
      if (!keys.has(family)) { dropped++; return ''; }
      const weightMatch = block.match(/font-weight\s*:\s*([^;}]+)/i);
      const faceWeight = weightMatch ? weightMatch[1] : 'normal';
      if (weightMatches(faceWeight, keys, family)) return block;
      dropped++;
      return '';
    });
    if (dropped > 0) report.notes.push(`${dropped} unused @font-face rules dropped`);
    return result;
  };

  // ---- Entry point -----------------------------------------------------------
  // Returns a single <style> payload string (all sheets, original order).

  dq.collectCss = async (report) => {
    const chunks = [];
    const sheets = [...document.styleSheets, ...(document.adoptedStyleSheets || [])];
    for (const sheet of sheets) {
      if (sheet.disabled) continue;
      if (sheet.media && sheet.media.mediaText === 'print') continue;
      const css = await readSheet(sheet, report);
      if (!css.trim()) continue;
      const media = sheet.media && sheet.media.mediaText && sheet.media.mediaText !== 'all'
        ? sheet.media.mediaText : null;
      chunks.push({
        source: sheet.href || 'inline',
        css: media ? `@media ${media} {\n${css}\n}` : css,
      });
    }
    return chunks;
  };
})();
