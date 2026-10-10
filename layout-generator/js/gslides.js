/* Google Slides both ways. Inside claude.ai the page uses the viewer's own Google Drive connector: a Slides link is
   exported as .pptx with download_file_content, and Save to Google Slides uploads a .pptx with create_file (Drive turns
   it into a Slides file). On the local server, a deck shared "anyone with the link" comes through /api/gslides.
   Anywhere else the deck moves by hand: download it as .pptx in Google Slides, or import the exported .pptx there. */
const GSlides = (() => {
  const SERVER = 'Google Drive';
  const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  const idOf = url => (/\/presentation\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]{20,})/.exec(url || '') || /[?&]id=([a-zA-Z0-9_-]{20,})/.exec(url || '') || /^\s*([a-zA-Z0-9_-]{30,})\s*$/.exec(url || '') || [])[1] || null;
  const isLink = t => /docs\.google\.com\/presentation\//.test(t || '');
  let mcpP = null;
  const mcp = () => { if (!mcpP) mcpP = (window.claude && typeof window.claude.use === 'function') ? window.claude.use('mcp').catch(() => null) : Promise.resolve(null); return mcpP; };
  let serverP = null;
  const server = () => { if (window.claude) return Promise.resolve(false); if (!serverP) serverP = fetch('/api/ping', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(j => !!(j && j.lg)).catch(() => false); return serverP; };
  async function route() { if (await mcp()) return 'connector'; if (await server()) return 'server'; return 'manual'; }
  const b64ToBytes = s => { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
  const blobToB64 = blob => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = rej; fr.readAsDataURL(blob); });
  // The connector's answer shape is not documented: take the longest base64-looking string anywhere in it.
  function findB64(v, depth = 0) {
    if (typeof v === 'string') { const t = v.replace(/^data:[^,]*,/, '').replace(/\s+/g, ''); return t.length > 200 && /^[A-Za-z0-9+/_-]+=*$/.test(t) ? t : null; }
    if (v && typeof v === 'object' && depth < 6) { let best = null; for (const x of Object.values(v)) { const c = findB64(x, depth + 1); if (c && (!best || c.length > best.length)) best = c; } return best; }
    return null;
  }
  function findKey(v, key, depth = 0) { if (!v || typeof v !== 'object' || depth > 5) return null; if (typeof v[key] === 'string') return v[key]; for (const x of Object.values(v)) { const c = findKey(x, key, depth + 1); if (c) return c; } return null; }
  // Connector failures each have their own fix; say which.
  function friendly(e, what) {
    const code = e && e.code;
    if (code === 'server_not_connected') return new Error('Google Drive is not connected. In claude.ai open Settings → Connectors, add Google Drive, then try again.');
    if (code === 'needs_reauth') return new Error('Google Drive needs you to sign in again: reconnect it in claude.ai Settings → Connectors.');
    if (code === 'not_in_manifest' || code === 'capability_disabled' || code === 'not_granted' || code === 'denied') return new Error('This page was not allowed to use Google Drive. Allow it when asked, or download the .pptx instead.');
    if (code === 'tool_error') return new Error(`Google Drive could not ${what}: ${String(e.message || '').slice(0, 160) || 'check the link and that your account can open it'}.`);
    if (code === 'server_unavailable' || code === 'upstream_error') return new Error('Google Drive did not answer. Try again in a moment.');
    return new Error(e && e.message ? e.message : String(e));
  }
  // A Slides link -> .pptx bytes.
  async function fetchDeck(url) {
    const id = idOf(url); if (!id) throw new Error('That does not look like a Google Slides link (docs.google.com/presentation/d/…).');
    const m = await mcp();
    if (m) {
      let res; try { res = await m.callTool(SERVER, 'download_file_content', { fileId: id, exportMimeType: PPTX }, { cache: false }); } catch (e) { throw friendly(e, 'open that deck'); }
      const b = findB64(res && res.payload) || ((res && res.content) || []).map(c => c && c.type === 'text' ? findB64(c.text) : null).find(Boolean);
      if (!b) throw new Error('Google Drive sent no file back for that link.');
      const bytes = b64ToBytes(b.replace(/-/g, '+').replace(/_/g, '/'));
      if (bytes[0] !== 0x50 || bytes[1] !== 0x4B) throw new Error('Google Drive did not send a PowerPoint export for that link.');
      return bytes;
    }
    if (await server()) {
      const r = await fetch('/api/gslides?id=' + encodeURIComponent(id));
      if (!r.ok) throw new Error((await r.text()).slice(0, 300) || 'The server could not fetch that deck.');
      return new Uint8Array(await r.arrayBuffer());
    }
    throw new Error('From here, download the deck first: in Google Slides choose File → Download → Microsoft PowerPoint (.pptx), then drop the file on the canvas.');
  }
  // A .pptx blob -> a new Google Slides file in the viewer's Drive. Returns {id, url}; throws 'manual' when no route.
  async function saveDeck(blob, title) {
    const m = await mcp(); if (!m) { const err = new Error('manual'); err.manual = true; throw err; }
    let fileArgs = false; try { const t = await m.listTools(); fileArgs = !!(t && t.fileArgs); } catch { fileArgs = false; }
    const name = String(title || 'Deck').replace(/[^\w .-]+/g, ' ').trim().slice(0, 80) || 'Deck';
    const input = { title: name, contentMimeType: PPTX };
    if (fileArgs && blob.size <= 16 * 1024 * 1024) input.base64Content = { $file: { data: blob, name: name.replace(/\s+/g, '-') + '.pptx', type: PPTX } };
    else if (blob.size < 700 * 1024) input.base64Content = await blobToB64(blob);
    else throw new Error('This deck is too large to send from here. Download the PPTX and use File → Import slides in Google Slides.');
    let res; try { res = await m.callTool(SERVER, 'create_file', input, { cache: false }); } catch (e) { throw friendly(e, 'create the deck'); }
    const p = res && res.payload; const id = findKey(p, 'id') || findKey(p, 'fileId');
    const url = findKey(p, 'webViewLink') || findKey(p, 'alternateLink') || (id ? `https://docs.google.com/presentation/d/${id}/edit` : null);
    return { id, url };
  }
  return { idOf, isLink, route, fetchDeck, saveDeck, PPTX };
})();
