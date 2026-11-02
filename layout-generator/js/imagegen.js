/* Image generation scaffolding. One provider interface, adapters for Google Gemini and OpenAI with their real
   request shapes, and a prompt builder that reads the frame's copy and the brand. Keys stay in this browser
   and requests go straight to the provider, so generation only runs where outbound requests are allowed
   (served locally or from your own host); published copies show the prompt but cannot call out. */
const ImageGen = (() => {
  const LS_KEY = 'lg.imagegen';
  const ASPECTS = [['1:1', 1], ['4:3', 4 / 3], ['3:4', 3 / 4], ['16:9', 16 / 9], ['9:16', 9 / 16]];
  const b64ToDataUrl = (b64, mime = 'image/png') => `data:${mime};base64,${b64}`;
  const blocked = err => err && (err.name === 'TypeError' || /Failed to fetch|NetworkError|Load failed|blocked|CSP/i.test(err.message || ''));

  async function post(url, headers, body) {
    let res;
    try { res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }); }
    catch (err) { if (blocked(err)) throw new Error('Outbound requests are blocked in this copy. Run the page locally or from your own host to generate images.'); throw err; }
    if (!res.ok) { const t = await res.text(); let msg = t.slice(0, 300); try { const j = JSON.parse(t); msg = (j.error && (j.error.message || j.error.code)) || msg; } catch { } throw new Error(`${res.status}: ${msg}`); }
    return res.json();
  }

  const PROVIDERS = {
    gemini: {
      id: 'gemini', name: 'Google Gemini', keyHint: 'AIza…', keyUrl: 'https://aistudio.google.com/apikey',
      models: [['gemini-2.5-flash-image', 'Gemini 2.5 Flash Image'], ['imagen-4.0-generate-001', 'Imagen 4'], ['imagen-4.0-fast-generate-001', 'Imagen 4 Fast']],
      async generate({ prompt, apiKey, model, aspect }) {
        const base = 'https://generativelanguage.googleapis.com/v1beta/models/';
        if (model.startsWith('imagen')) {
          const data = await post(`${base}${model}:predict`, { 'x-goog-api-key': apiKey }, { instances: [{ prompt }], parameters: { sampleCount: 1, aspectRatio: aspect } });
          const p = data.predictions && data.predictions[0]; if (!p || !p.bytesBase64Encoded) throw new Error('No image in the response');
          return { dataUrl: b64ToDataUrl(p.bytesBase64Encoded, p.mimeType || 'image/png') };
        }
        const data = await post(`${base}${model}:generateContent`, { 'x-goog-api-key': apiKey }, { contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: aspect } } });
        const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
        const img = parts.find(p => p.inlineData); if (!img) throw new Error((parts.find(p => p.text) || {}).text || 'No image in the response');
        return { dataUrl: b64ToDataUrl(img.inlineData.data, img.inlineData.mimeType || 'image/png') };
      },
      // a change to a picture that exists: the picture and the instruction go in together
      async edit({ prompt, apiKey, model, dataUrl }) {
        const base = 'https://generativelanguage.googleapis.com/v1beta/models/'; const m = model && model.startsWith('gemini') ? model : 'gemini-2.5-flash-image';
        const [, mime, b64] = /^data:([^;]+);base64,(.*)$/.exec(dataUrl) || [null, 'image/png', ''];
        const data = await post(`${base}${m}:generateContent`, { 'x-goog-api-key': apiKey }, { contents: [{ parts: [{ inlineData: { mimeType: mime, data: b64 } }, { text: prompt }] }], generationConfig: { responseModalities: ['IMAGE'] } });
        const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
        const img = parts.find(p => p.inlineData); if (!img) throw new Error((parts.find(p => p.text) || {}).text || 'No image in the response');
        return { dataUrl: b64ToDataUrl(img.inlineData.data, img.inlineData.mimeType || 'image/png'), model: m };
      },
    },
    openai: {
      id: 'openai', name: 'OpenAI', keyHint: 'sk-…', keyUrl: 'https://platform.openai.com/api-keys',
      models: [['gpt-image-1', 'GPT Image 1'], ['gpt-image-1-mini', 'GPT Image 1 mini'], ['dall-e-3', 'DALL·E 3']],
      async generate({ prompt, apiKey, model, aspect }) {
        const wide = aspect === '16:9' || aspect === '4:3', tall = aspect === '9:16' || aspect === '3:4';
        const size = model === 'dall-e-3' ? (wide ? '1792x1024' : tall ? '1024x1792' : '1024x1024') : (wide ? '1536x1024' : tall ? '1024x1536' : '1024x1024');
        const body = { model, prompt, n: 1, size }; if (model === 'dall-e-3') body.response_format = 'b64_json';
        const data = await post('https://api.openai.com/v1/images/generations', { authorization: `Bearer ${apiKey}` }, body);
        const d = data.data && data.data[0]; if (!d || !d.b64_json) throw new Error('No image in the response');
        return { dataUrl: b64ToDataUrl(d.b64_json, 'image/png') };
      },
      async edit({ prompt, apiKey, model, dataUrl, transparent }) {
        const m = model && model !== 'dall-e-3' ? model : 'gpt-image-1'; // DALL·E 3 cannot edit
        const fd = new FormData(); const blob = await (await fetch(dataUrl)).blob(); fd.append('image', blob, 'image.png'); fd.append('prompt', prompt); fd.append('model', m); fd.append('n', '1'); fd.append('size', 'auto'); if (transparent) fd.append('background', 'transparent');
        let res; try { res = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { authorization: `Bearer ${apiKey}` }, body: fd }); } catch (err) { throw new Error(blocked(err) ? 'This page cannot reach the image provider from here (scripts are sandboxed). Run Dugma from your own host or locally to generate.' : err.message); }
        const data = await res.json().catch(() => ({})); if (!res.ok) throw new Error((data.error && data.error.message) || `${res.status} from the provider`);
        const d = data.data && data.data[0]; if (!d || !d.b64_json) throw new Error('No image in the response');
        return { dataUrl: b64ToDataUrl(d.b64_json, 'image/png'), model: m };
      },
    },
  };
  // Ready-made edits; a picture with its background removed comes back as a PNG with transparency.
  const EDIT_PRESETS = [
    ['remove-bg', 'Remove background', 'Remove the background completely and return the subject alone on a fully transparent background. Keep the subject exactly as it is: same framing, colors, edges and details.', true],
    ['extend', 'Extend the picture', 'Extend this picture outward on every side, continuing the scene naturally with the same lighting, perspective, style and grain. Keep everything that is already in the picture unchanged.', false],
    ['clean', 'Clean up', 'Remove text, logos, watermarks, clutter and distracting objects from this picture. Fill what they covered naturally. Keep the main subject and the composition unchanged.', false],
    ['swap', 'Swap the subject', 'Replace the main subject of this picture with: ', false],
  ];

  const settings = {
    get() { try { return { provider: '', model: '', apiKey: '', ...(JSON.parse(localStorage.getItem(LS_KEY) || '{}')) }; } catch { return { provider: '', model: '', apiKey: '' }; } },
    set(s) { try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch { } },
  };
  function ready() { const s = settings.get(); return !!(s.provider && PROVIDERS[s.provider] && s.apiKey); }
  function aspectOf(w, h) { const r = (w || 1) / (h || 1); return ASPECTS.reduce((best, a) => Math.abs(a[1] - r) < Math.abs(best[1] - r) ? a : best, ASPECTS[0])[0]; }

  // A prompt from what the frame says and who it is for. Edit it before generating; it is a starting point.
  function promptFor(frame, kit, opts = {}) {
    const L = frame.layout;
    const text = b => b.text != null ? String(b.text) : (b.lines ? b.lines.map(l => typeof l === 'string' ? l : l.text).join(' ') : '');
    const by = role => L.blocks.filter(b => b.kind === 'text' && b.role === role && !b.decorative).map(text).find(Boolean);
    const headline = by('headline') || by('text') || by('quote') || '';
    const subhead = by('subhead') || by('body') || '';
    const subject = opts.subject || headline || kit.name;
    const dark = Color.luminance(L.palette.bg) < 0.3;
    const style = opts.style || `${dark ? 'moody, low-key' : 'bright, airy'} editorial photograph`;
    return [
      `${style} for a ${kit.name} ${L.format.name.toLowerCase()} about "${subject}".`,
      subhead ? `Context: ${subhead}` : '',
      `Real people at work or a clean product-adjacent scene, natural light, shallow depth of field, uncluttered background with empty space for a headline on the ${L.blocks.some(b => b.kind === 'text' && b.x > L.format.w / 2) ? 'left' : 'right'}.`,
      `Palette leaning ${L.palette.bgName || 'brand'} (${L.palette.bg}) with ${L.palette.accent} accents. No text, no logos, no watermarks, no borders.`,
    ].filter(Boolean).join(' ');
  }

  async function generate({ prompt, aspect = '1:1', provider, model, apiKey } = {}) {
    const s = settings.get(); provider = provider || s.provider; model = model || s.model; apiKey = apiKey || s.apiKey;
    const P = PROVIDERS[provider]; if (!P) throw new Error('Pick an image provider in Settings');
    if (!apiKey) throw new Error(`Add your ${P.name} API key in Settings`);
    if (!model || !P.models.some(m => m[0] === model)) model = P.models[0][0];
    if (!prompt || !prompt.trim()) throw new Error('Write a prompt first');
    const t0 = performance.now();
    const out = await P.generate({ prompt: prompt.trim(), apiKey, model, aspect });
    return { ...out, provider, model, aspect, ms: Math.round(performance.now() - t0) };
  }

  async function edit({ dataUrl, prompt, transparent = false, provider, model, apiKey } = {}) {
    const s = settings.get(); provider = provider || s.provider; model = model || s.model; apiKey = apiKey || s.apiKey;
    const P = PROVIDERS[provider]; if (!P) throw new Error('Pick an image provider in Settings');
    if (!apiKey) throw new Error(`Add your ${P.name} API key in Settings`);
    if (!dataUrl || !/^data:image\//.test(dataUrl)) throw new Error('This picture has no pixels to edit here');
    if (!prompt || !prompt.trim()) throw new Error('Say what should change');
    const t0 = performance.now();
    const out = await P.edit({ prompt: prompt.trim(), apiKey, model, dataUrl, transparent });
    return { ...out, provider, model: out.model || model, ms: Math.round(performance.now() - t0) };
  }
  return { PROVIDERS, EDIT_PRESETS, settings, ready, aspectOf, promptFor, generate, edit };
})();
