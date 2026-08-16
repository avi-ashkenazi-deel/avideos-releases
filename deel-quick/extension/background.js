/*
 * Deel Quick — background service worker.
 * One job: the CORS fetch relay. Content-script fetches run with the page's
 * origin and are subject to CORS and the page's CSP; asset CDNs that don't
 * send CORS headers can only be fetched here, under the extension's Deel
 * host permissions. The capture download itself happens in the page (anchor
 * click on a Blob URL), so no "downloads" permission is needed.
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'dq-fetch') {
    fetch(msg.url, { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) {
          sendResponse({ ok: false, status: res.status });
          return;
        }
        const buf = new Uint8Array(await res.arrayBuffer());
        let binary = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < buf.length; i += CHUNK) {
          binary += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
        }
        sendResponse({
          ok: true,
          base64: btoa(binary),
          contentType: res.headers.get('content-type') || '',
        });
      })
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // async sendResponse
  }
  return false;
});
