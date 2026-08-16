/*
 * Deel Quick — capture orchestrator (phase 6 + entry point).
 * window.__deelQuick.run(opts) drives the whole pipeline and hands the
 * finished file to the browser as a download. Works identically when injected
 * by the extension or pasted as a DevTools snippet.
 *
 * opts: {
 *   intent:           string  — "what do you want to improve?" (embedded in
 *                               the metadata comment)
 *   delayMs:          number  — wait before capturing (grab hover/menu state)
 *   downscaleImages:  boolean — re-encode large raster images (size budget)
 * }
 */
(() => {
  const dq = window.__deelQuick;

  const WARN_BYTES = 10 * 1024 * 1024;  // 10MB — warn
  const FLAG_BYTES = 14 * 1024 * 1024;  // 14MB — headroom under the 16MB artifact ceiling

  const buildMetadataComment = (report, opts) => {
    const L = report.ledger;
    const lines = [
      'deel-quick capture v0.1.0',
      `source: ${dq.escapeComment(location.href)}`,
      `title: ${dq.escapeComment(document.title)}`,
      `captured: ${new Date().toISOString()}`,
      `viewport: ${window.innerWidth}x${window.innerHeight}`,
      `size: dom ${dq.fmtBytes(L.dom)} / css ${dq.fmtBytes(L.css)} / fonts ${dq.fmtBytes(L.fonts)} / images ${dq.fmtBytes(L.images)} / canvas ${dq.fmtBytes(L.canvas)} = ${dq.fmtBytes(dq.ledgerTotal(L))}`,
    ];
    if (opts.intent) lines.push(`improvement-intent: ${dq.escapeComment(opts.intent)}`);
    if (report.warnings.length) lines.push(`warnings: ${dq.escapeComment(report.warnings.join(' | '))}`);
    if (report.notes.length) lines.push(`notes: ${dq.escapeComment(report.notes.join(' | '))}`);
    lines.push('changelog:');
    return `<!--\n  ${lines.join('\n  ')}\n-->`;
  };

  const download = (html, filename) => {
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  dq.run = async (opts = {}) => {
    const report = { warnings: [], notes: [], ledger: dq.newLedger() };
    dq.resourceCache.clear();

    try {
      if (opts.delayMs) {
        dq.progress('waiting', `${opts.delayMs / 1000}s — set up the UI state you want captured`);
        await new Promise((r) => setTimeout(r, opts.delayMs));
      }

      dq.progress('snapshot', 'annotating live state and cloning the DOM');
      const state = dq.annotateLiveState();
      let clone;
      try {
        clone = dq.buildClone(state, report);
      } finally {
        dq.clearLiveAnnotations();
      }

      dq.progress('styles', 'serializing stylesheets via CSSOM');
      const cssChunks = await dq.collectCss(report);

      dq.progress('fonts', 'dropping unused @font-face rules');
      for (const chunk of cssChunks) {
        chunk.css = dq.filterUnusedFontFaces(chunk.css, report);
      }

      dq.progress('assets', 'inlining images, fonts, sprites as data: URIs');
      await dq.inlineCssAssets(cssChunks, report.ledger, report, opts);
      await dq.inlineElementAssets(clone, report.ledger, report, opts);

      dq.progress('assemble', 'writing the standalone HTML file');
      const head = clone.querySelector('head') || clone;
      for (const chunk of cssChunks) {
        const style = document.createElement('style');
        style.setAttribute('data-dq-source', chunk.source);
        style.textContent = chunk.css;
        head.appendChild(style);
      }

      const bodyHtml = clone.outerHTML;
      report.ledger.dom = bodyHtml.length - dq.ledgerTotal(report.ledger);
      if (report.ledger.dom < 0) report.ledger.dom = 0;

      const total = dq.ledgerTotal(report.ledger);
      if (total > FLAG_BYTES) {
        report.warnings.push(
          `capture is ${dq.fmtBytes(total)} — OVER the 14MB artifact budget; re-capture with image downscaling or trim per the size playbook`
        );
      } else if (total > WARN_BYTES) {
        report.warnings.push(`capture is ${dq.fmtBytes(total)} — approaching the 14MB artifact budget`);
      }

      const html = `<!doctype html>\n${buildMetadataComment(report, opts)}\n${bodyHtml}`;

      const slug = dq.slugify(document.title || location.pathname);
      const date = new Date().toISOString().slice(0, 10);
      const filename = `deel-${slug}--${date}-capture.html`;
      download(html, filename);

      const result = {
        type: 'dq-done',
        filename,
        totalBytes: html.length,
        ledger: report.ledger,
        warnings: report.warnings,
        notes: report.notes,
      };
      dq.progress('done', `${filename} (${dq.fmtBytes(html.length)})`);
      if (dq.isExtension) {
        try { chrome.runtime.sendMessage(result); } catch (_) { /* popup closed */ }
      }
      console.log('[deel-quick] capture report', result);
      return result;
    } catch (err) {
      const failure = { type: 'dq-error', message: String(err && err.message || err) };
      if (dq.isExtension) {
        try { chrome.runtime.sendMessage(failure); } catch (_) { /* popup closed */ }
      }
      console.error('[deel-quick] capture failed', err);
      dq.clearLiveAnnotations();
      throw err;
    }
  };
})();
