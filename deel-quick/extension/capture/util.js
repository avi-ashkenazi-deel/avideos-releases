/*
 * Deel Quick — capture utilities.
 * All capture files attach to window.__deelQuick so they work both when
 * injected by the extension (chrome.scripting.executeScript, ordered files)
 * and when pasted as a DevTools snippet (see snippet/ and tools/make-snippet.sh).
 */
(() => {
  const dq = (window.__deelQuick = window.__deelQuick || {});

  // ---- Environment ---------------------------------------------------------

  dq.isExtension = !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);

  // ---- Progress reporting --------------------------------------------------

  dq.progress = (phase, detail) => {
    const msg = { type: 'dq-progress', phase, detail: detail || '' };
    if (dq.isExtension) {
      try { chrome.runtime.sendMessage(msg); } catch (_) { /* popup closed — fine */ }
    }
    // Always mirror to the console so the DevTools-snippet path has feedback.
    console.log(`[deel-quick] ${phase}${detail ? ' — ' + detail : ''}`);
  };

  // ---- Byte ledger ---------------------------------------------------------
  // Tracks payload by category so the 16MB artifact budget is visible per lever.

  dq.newLedger = () => ({ dom: 0, css: 0, fonts: 0, images: 0, canvas: 0 });

  dq.ledgerTotal = (ledger) => Object.values(ledger).reduce((a, b) => a + b, 0);

  dq.fmtBytes = (n) => {
    if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + 'MB';
    if (n >= 1024) return Math.round(n / 1024) + 'KB';
    return n + 'B';
  };

  // ---- Fetch with fallback chain ------------------------------------------
  // 1. Page-context fetch (has the user's cookies, subject to CORS/page CSP).
  // 2. Extension background relay (host permissions bypass CORS on Deel CDNs).
  // Returns { bytes: Uint8Array, contentType } or null (caller records a warning).

  dq.fetchResource = async (url) => {
    try {
      const res = await fetch(url, { credentials: 'include', cache: 'force-cache' });
      if (res.ok) {
        const buf = new Uint8Array(await res.arrayBuffer());
        return { bytes: buf, contentType: res.headers.get('content-type') || '' };
      }
    } catch (_) { /* fall through to relay */ }

    if (dq.isExtension) {
      try {
        const reply = await chrome.runtime.sendMessage({ type: 'dq-fetch', url });
        if (reply && reply.ok) {
          return { bytes: dq.base64ToBytes(reply.base64), contentType: reply.contentType || '' };
        }
      } catch (_) { /* relay unavailable */ }
    }
    return null;
  };

  // Single-flight cache so each unique URL is fetched once per capture.
  dq.resourceCache = new Map();
  dq.fetchResourceCached = (url) => {
    if (!dq.resourceCache.has(url)) dq.resourceCache.set(url, dq.fetchResource(url));
    return dq.resourceCache.get(url);
  };

  // ---- Encoding helpers ----------------------------------------------------

  dq.bytesToBase64 = (bytes) => {
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  };

  dq.base64ToBytes = (b64) => {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };

  const MIME_BY_EXT = {
    woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', avif: 'image/avif',
  };

  dq.guessMime = (url, contentType) => {
    if (contentType && contentType !== 'application/octet-stream') {
      return contentType.split(';')[0].trim();
    }
    const ext = (url.split(/[?#]/)[0].split('.').pop() || '').toLowerCase();
    return MIME_BY_EXT[ext] || 'application/octet-stream';
  };

  dq.isFontMime = (mime) => mime.startsWith('font/') || mime.includes('font-woff') || mime.includes('opentype');

  dq.toDataUri = (bytes, mime) => `data:${mime};base64,${dq.bytesToBase64(bytes)}`;

  // ---- Image downscaling ---------------------------------------------------
  // Re-encodes a data URI image to fit maxWidth (JPEG q0.8). Skips SVG and
  // anything already small. Used by the size-budget pass on images and canvas
  // snapshots.

  dq.downscaleDataUri = (dataUri, maxWidth = 1200, quality = 0.8) =>
    new Promise((resolve) => {
      if (dataUri.startsWith('data:image/svg') || dataUri.length < 50 * 1024) {
        resolve(dataUri);
        return;
      }
      const img = new Image();
      img.onload = () => {
        if (img.naturalWidth <= maxWidth) { resolve(dataUri); return; }
        const scale = maxWidth / img.naturalWidth;
        const canvas = document.createElement('canvas');
        canvas.width = maxWidth;
        canvas.height = Math.round(img.naturalHeight * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        try {
          const out = canvas.toDataURL('image/jpeg', quality);
          resolve(out.length < dataUri.length ? out : dataUri);
        } catch (_) { resolve(dataUri); }
      };
      img.onerror = () => resolve(dataUri);
      img.src = dataUri;
    });

  // ---- Misc ----------------------------------------------------------------

  dq.slugify = (text) =>
    (text || 'screen')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'screen';

  dq.escapeComment = (text) => String(text || '').replace(/--/g, '—');
})();
