/*
 * Deel Quick — DOM snapshot (capture phases 1–2).
 * Phase 1 stamps live runtime state (input values, canvas pixels, shadow roots)
 * onto elements via data-dq-* markers, because cloneNode() copies attributes,
 * not runtime properties.
 * Phase 2 deep-clones the document, applies the stamped state, and prunes
 * everything a static prototype must not carry (scripts, handlers, CSP metas).
 */
(() => {
  const dq = window.__deelQuick;

  const STATE_ATTR = 'data-dq-i';

  // ---- Phase 1: annotate live state ----------------------------------------

  dq.annotateLiveState = () => {
    const state = new Map(); // index -> {kind, ...payload}
    let nextIndex = 0;
    const stamp = (el, entry) => {
      el.setAttribute(STATE_ATTR, String(nextIndex));
      state.set(String(nextIndex), entry);
      nextIndex++;
    };

    document.querySelectorAll('input').forEach((el) => {
      if (el.type === 'checkbox' || el.type === 'radio') {
        stamp(el, { kind: 'checked', checked: el.checked });
      } else if (el.type !== 'password') {
        stamp(el, { kind: 'value', value: el.value });
      }
    });
    document.querySelectorAll('textarea').forEach((el) => stamp(el, { kind: 'text', value: el.value }));
    document.querySelectorAll('select').forEach((el) => stamp(el, { kind: 'select', index: el.selectedIndex }));

    // Images: record the resolved current source so srcset never re-resolves
    // against the network in the prototype.
    document.querySelectorAll('img').forEach((el) => {
      const src = el.currentSrc || el.src;
      if (src) stamp(el, { kind: 'img', src });
    });

    // Canvas → PNG snapshot (charts). Tainted canvases throw; those become
    // sized placeholders and a report entry.
    document.querySelectorAll('canvas').forEach((el) => {
      const rect = el.getBoundingClientRect();
      try {
        stamp(el, { kind: 'canvas', dataUri: el.toDataURL('image/png'), w: rect.width, h: rect.height });
      } catch (_) {
        stamp(el, { kind: 'canvas-tainted', w: rect.width, h: rect.height });
      }
    });

    // Shadow roots: serialize now (from the live tree — clones drop them).
    const shadowHosts = [];
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
    for (let el = walker.currentNode; el; el = walker.nextNode()) {
      if (el.shadowRoot) shadowHosts.push(el);
    }
    shadowHosts.forEach((el) => {
      let css = '';
      try {
        (el.shadowRoot.adoptedStyleSheets || []).forEach((sheet) => {
          for (const rule of sheet.cssRules) css += rule.cssText + '\n';
        });
      } catch (_) { /* ignore unreadable adopted sheets */ }
      stamp(el, { kind: 'shadow', html: el.shadowRoot.innerHTML, css });
    });

    return state;
  };

  dq.clearLiveAnnotations = () => {
    document.querySelectorAll(`[${STATE_ATTR}]`).forEach((el) => el.removeAttribute(STATE_ATTR));
  };

  // ---- Phase 2: clone, apply state, prune -----------------------------------

  dq.buildClone = (state, report) => {
    const clone = document.documentElement.cloneNode(true);

    // Apply stamped runtime state to the clone.
    clone.querySelectorAll(`[${STATE_ATTR}]`).forEach((el) => {
      const entry = state.get(el.getAttribute(STATE_ATTR));
      el.removeAttribute(STATE_ATTR);
      if (!entry) return;
      switch (entry.kind) {
        case 'value':
          el.setAttribute('value', entry.value);
          break;
        case 'checked':
          if (entry.checked) el.setAttribute('checked', '');
          else el.removeAttribute('checked');
          break;
        case 'text':
          el.textContent = entry.value;
          break;
        case 'select':
          Array.from(el.options || []).forEach((opt, i) => {
            if (i === entry.index) opt.setAttribute('selected', '');
            else opt.removeAttribute('selected');
          });
          break;
        case 'img':
          el.setAttribute('src', entry.src);
          el.removeAttribute('srcset');
          el.removeAttribute('sizes');
          break;
        case 'canvas': {
          const img = document.createElement('img');
          img.src = entry.dataUri;
          img.setAttribute('data-dq-canvas', '');
          img.style.width = entry.w + 'px';
          img.style.height = entry.h + 'px';
          if (el.className) img.className = el.className;
          el.replaceWith(img);
          break;
        }
        case 'canvas-tainted': {
          const ph = document.createElement('div');
          ph.setAttribute('data-dq-canvas-placeholder', '');
          ph.style.cssText = `width:${entry.w}px;height:${entry.h}px;background:#e5e7eb;display:flex;align-items:center;justify-content:center;color:#6b7280;font:12px sans-serif;`;
          ph.textContent = 'canvas (could not snapshot)';
          el.replaceWith(ph);
          report.warnings.push('1 canvas was tainted and became a placeholder');
          break;
        }
        case 'shadow': {
          const tpl = document.createElement('template');
          tpl.setAttribute('shadowrootmode', 'open');
          tpl.innerHTML = (entry.css ? `<style>${entry.css}</style>` : '') + entry.html;
          el.prepend(tpl);
          break;
        }
      }
    });

    // Prune: nothing executable or network-reaching survives.
    clone.querySelectorAll('script, noscript').forEach((el) => el.remove());
    clone
      .querySelectorAll('link[rel="preload"], link[rel="prefetch"], link[rel="modulepreload"], link[rel="manifest"], link[rel="dns-prefetch"], link[rel="preconnect"]')
      .forEach((el) => el.remove());
    clone.querySelectorAll('meta[http-equiv]').forEach((el) => {
      const v = (el.getAttribute('http-equiv') || '').toLowerCase();
      if (v === 'content-security-policy' || v === 'refresh') el.remove();
    });
    clone.querySelectorAll('base').forEach((el) => el.remove());

    // Inline event handlers and javascript: URLs.
    const all = clone.querySelectorAll('*');
    all.forEach((el) => {
      for (const attr of Array.from(el.attributes)) {
        if (attr.name.startsWith('on')) el.removeAttribute(attr.name);
      }
      const href = el.getAttribute && el.getAttribute('href');
      if (href && href.trim().toLowerCase().startsWith('javascript:')) el.setAttribute('href', '#');
    });

    // Links: neutralize navigation, preserve the original target for the
    // quick-iterate skill (multi-screen linking rewrites data-orig-href).
    clone.querySelectorAll('a[href]').forEach((el) => {
      const href = el.getAttribute('href');
      if (href && href !== '#' && !href.startsWith('data:')) {
        try {
          el.setAttribute('data-orig-href', new URL(href, location.href).href);
        } catch (_) {
          el.setAttribute('data-orig-href', href);
        }
        el.setAttribute('href', '#');
      }
    });

    // Iframes → sized, labeled placeholders.
    clone.querySelectorAll('iframe').forEach((el) => {
      let host = 'iframe';
      try { host = new URL(el.getAttribute('src') || '', location.href).hostname || 'iframe'; } catch (_) { /* keep default */ }
      const ph = document.createElement('div');
      const w = el.getAttribute('width') || el.style.width || '100%';
      const h = el.getAttribute('height') || el.style.height || '200px';
      ph.setAttribute('data-dq-iframe', host);
      ph.style.cssText = `width:${w};height:${h};background:#f3f4f6;border:1px dashed #d1d5db;display:flex;align-items:center;justify-content:center;color:#6b7280;font:12px sans-serif;`;
      ph.textContent = `iframe: ${host}`;
      el.replaceWith(ph);
      report.warnings.push(`iframe placeholdered: ${host}`);
    });

    // Stylesheet <link>s go away — css-inline.js re-emits them as <style>.
    clone.querySelectorAll('link[rel~="stylesheet"]').forEach((el) => el.remove());
    clone.querySelectorAll('style').forEach((el) => el.remove());

    return clone;
  };
})();
