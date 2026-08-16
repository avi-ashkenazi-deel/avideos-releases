/*
 * Deel Quick — asset inlining and size budget (capture phases 4–5).
 * Everything the artifact CSP would block (any http(s) resource) becomes a
 * data: URI: <img> sources, CSS url(...) references (fonts, background
 * images), external SVG sprites, and the favicon. A byte ledger tracks each
 * category against the 16MB artifact ceiling.
 */
(() => {
  const dq = window.__deelQuick;

  const isInlineable = (url) =>
    url && !url.startsWith('data:') && !url.startsWith('#') && !url.startsWith('blob:') &&
    (url.startsWith('http://') || url.startsWith('https://'));

  const fetchAsDataUri = async (url, report) => {
    const res = await dq.fetchResourceCached(url);
    if (!res) {
      report.warnings.push(`asset unreachable, left as-is: ${url.slice(0, 120)}`);
      return null;
    }
    const mime = dq.guessMime(url, res.contentType);
    return { dataUri: dq.toDataUri(res.bytes, mime), mime, size: res.bytes.length };
  };

  // blob: URLs can only be materialized from the live page context.
  const blobToDataUri = (url) =>
    fetch(url)
      .then((r) => r.blob())
      .then(
        (blob) =>
          new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(blob);
          })
      )
      .catch(() => null);

  // ---- <img> and other element-level assets ---------------------------------

  dq.inlineElementAssets = async (clone, ledger, report, opts) => {
    const imgs = Array.from(clone.querySelectorAll('img'));
    for (const img of imgs) {
      const src = img.getAttribute('src') || '';
      if (src.startsWith('blob:')) {
        const dataUri = await blobToDataUri(src);
        if (dataUri) { img.setAttribute('src', dataUri); ledger.images += dataUri.length; }
        else report.warnings.push('a blob: image could not be materialized');
        continue;
      }
      if (!isInlineable(src)) {
        if (src.startsWith('data:')) ledger[img.hasAttribute('data-dq-canvas') ? 'canvas' : 'images'] += src.length;
        continue;
      }
      const asset = await fetchAsDataUri(new URL(src, location.href).href, report);
      if (!asset) continue;
      let dataUri = asset.dataUri;
      if (opts.downscaleImages) dataUri = await dq.downscaleDataUri(dataUri);
      img.setAttribute('src', dataUri);
      img.removeAttribute('srcset');
      img.removeAttribute('sizes');
      img.removeAttribute('loading');
      ledger.images += dataUri.length;
    }

    // Inline style="background-image: url(...)" attributes.
    for (const el of clone.querySelectorAll('[style*="url("]')) {
      const style = el.getAttribute('style');
      const newStyle = await inlineCssUrls(style, location.href, ledger, report, opts);
      el.setAttribute('style', newStyle);
    }

    // External SVG sprites: <use href="https://cdn/sprite.svg#icon">.
    const uses = Array.from(clone.querySelectorAll('use')).filter((u) => {
      const href = u.getAttribute('href') || u.getAttribute('xlink:href') || '';
      return isInlineable(href.split('#')[0]);
    });
    const sprites = new Map(); // spriteUrl -> hidden container id
    for (const use of uses) {
      const href = use.getAttribute('href') || use.getAttribute('xlink:href');
      const [spriteUrl, fragment] = href.split('#');
      const abs = new URL(spriteUrl, location.href).href;
      if (!sprites.has(abs)) {
        const res = await dq.fetchResourceCached(abs);
        if (!res) {
          report.warnings.push(`svg sprite unreachable: ${abs}`);
          sprites.set(abs, null);
        } else {
          const holder = document.createElement('div');
          holder.style.display = 'none';
          holder.setAttribute('data-dq-sprite', abs);
          holder.innerHTML = new TextDecoder().decode(res.bytes);
          clone.querySelector('body').prepend(holder);
          ledger.images += res.bytes.length;
          sprites.set(abs, holder);
        }
      }
      if (sprites.get(abs)) {
        use.setAttribute('href', '#' + fragment);
        use.removeAttribute('xlink:href');
      }
    }

    // Favicon: replace all icon links with one inlined icon (nice artifact touch).
    const iconLink = clone.querySelector('link[rel~="icon"]');
    clone.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"]').forEach((el, i) => {
      if (el !== iconLink) el.remove();
    });
    if (iconLink && isInlineable(iconLink.getAttribute('href'))) {
      const asset = await fetchAsDataUri(new URL(iconLink.getAttribute('href'), location.href).href, report);
      if (asset) { iconLink.setAttribute('href', asset.dataUri); ledger.images += asset.dataUri.length; }
      else iconLink.remove();
    }
  };

  // ---- CSS url(...) inlining -------------------------------------------------

  const CSS_URL_RE = /url\(\s*(['"]?)(https?:\/\/[^'")]+)\1\s*\)/g;

  const inlineCssUrls = async (cssText, baseHref, ledger, report, opts) => {
    const refs = [...new Set([...cssText.matchAll(CSS_URL_RE)].map((m) => m[2]))];
    for (const url of refs) {
      const asset = await fetchAsDataUri(url, report);
      if (!asset) continue;
      let dataUri = asset.dataUri;
      const isFont = dq.isFontMime(asset.mime);
      if (!isFont && opts.downscaleImages) dataUri = await dq.downscaleDataUri(dataUri);
      ledger[isFont ? 'fonts' : 'images'] += dataUri.length;
      cssText = cssText.split(`url("${url}")`).join(`url("${dataUri}")`)
        .split(`url('${url}')`).join(`url("${dataUri}")`)
        .split(`url(${url})`).join(`url("${dataUri}")`);
    }
    return cssText;
  };

  dq.inlineCssAssets = async (cssChunks, ledger, report, opts) => {
    for (const chunk of cssChunks) {
      // Count rule text before inlining so data-URI bytes land only in the
      // fonts/images categories, not in css as well.
      ledger.css += chunk.css.length;
      chunk.css = await inlineCssUrls(chunk.css, chunk.source, ledger, report, opts);
    }
  };
})();
