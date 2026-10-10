/* The in-app agent: a chat panel on the canvas that acts on what is selected, through the same tools outside agents
   use over MCP. Inside claude.ai it asks Claude with the page's `sample` capability (the viewer's own account, no key);
   anywhere else it runs the Anthropic SDK's tool runner with the API key from Settings. Every run is one undo step. */
const Agent = (() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const MODEL = 'claude-opus-5-5';
  const SDK = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.128.0';
  let env = null, sample = null, sampleAny = null, sampleTools = 0, busy = false, ctl = null, stopped = false;
  const turns = [];     // text history for claude.ai sample calls
  const apiTurns = [];  // text history for API calls
  const SYSTEM = `You are the design agent inside Layout Engine, a canvas for brand layouts. The canvas holds screens (frames) made of blocks: text, body text, buttons, images, rectangles (field), shapes, vectors, icons and the logo. Block boxes are pixels from the frame's top left.

Change the canvas with the tools; the person sees each change live and can undo your whole run in one step. Work on the selected screens unless they say otherwise. Stay on brand: palette colors (by name or hex), brand fonts, sentence-case headlines, no exclamation marks, no invented facts or numbers. Prefer the broadest tool that does the job: recolor_frames, apply_look, replace_text, make_variations and duplicate_frames before editing blocks one by one. Boxes can hold blocks (parent); a box or the screen with auto layout stacks its children like Figma (set_auto_layout, wrap_in_stack, size_w/size_h fixed|hug|fill). Approved pieces (logos, cards, device frames) come from list_components and insert_component. Keep text inside its box: when copy grows, widen the box or lower the size. When you are done, say in one or two short sentences what you changed.`;

  // ---- availability -----------------------------------------------------------------------------------------------
  const apiKey = () => (document.getElementById('apiKey') || {}).value || (() => { try { return JSON.parse(localStorage.getItem('lg.apiKey') || '""'); } catch { return ''; } })();
  function mode() { if (sample) return 'sample'; if (apiKey().trim()) return 'api'; return null; }
  let sdkP = null;
  function loadSdk() {
    if (!sdkP) sdkP = Promise.all([import(`${SDK}/+esm`), import(`${SDK}/helpers/beta/json-schema/+esm`)])
      .then(([a, h]) => ({ Anthropic: a.default || a.Anthropic, betaTool: h.betaTool }))
      .catch(e => { sdkP = null; throw new Error('Could not load the Anthropic SDK: ' + e.message); });
    return sdkP;
  }

  // ---- context the model reads up front (saves a round) -----------------------------------------------------------
  function context() {
    const d = CanvasUI.doc; const sel = CanvasUI.selection(); const kit = env.getKit() || { name: '', colors: [], fonts: {} };
    const lines = [`Canvas "${d.name}": ${d.frames.length} screen${d.frames.length === 1 ? '' : 's'}.`];
    if (!sel.frameIds.length) lines.push('Nothing is selected; act on the whole canvas or ask which screen.');
    else {
      lines.push(`Selected: ${sel.frameIds.length} screen${sel.frameIds.length === 1 ? '' : 's'}${sel.blockIds.length ? `, blocks ${sel.blockIds.join(', ')}` : ''}.`);
      for (const id of sel.frameIds.slice(0, 3)) {
        const f = Canvas.frameById(d, id); if (!f) continue; const L = f.layout;
        lines.push(`- screen ${f.id} "${f.name}" ${L.format.w}×${L.format.h}, background ${L.palette.bg}${L.palette.bgToken ? ' (' + L.palette.bgToken + ')' : ''}, look ${(L.meta && L.meta.look) || 'original'}`);
        if (sel.frameIds.length <= 2) for (const b of L.blocks.slice(0, 40)) { const t = b.kind === 'text' ? ` "${Canvas.sourceText(b).slice(0, 80)}"` : b.kind === 'button' ? ` "${String(b.text).slice(0, 40)}"` : ''; lines.push(`  · ${b.id} ${b.kind}${b.role ? '/' + b.role : ''}${t} @${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.w)}×${Math.round(b.h)}${b.fill ? ' ' + b.fill : ''}${b.font ? ` ${String(b.font.family).split(',')[0].replace(/["']/g, '')} ${b.font.size}/${b.font.weight}` : ''}`); }
      }
      if (sel.frameIds.length > 3) lines.push(`  (and ${sel.frameIds.length - 3} more: ${sel.frameIds.slice(3).join(', ')})`);
    }
    lines.push(`Brand ${kit.name}: ${kit.colors.map(c => `${c.name} ${Color.normalize(c.hex)} (${c.role})`).join(', ')}. Fonts: ${kit.fonts.display} (display), ${kit.fonts.body} (body).`);
    return lines.join('\n');
  }
  // Tool results for claude.ai stay small (32 KB cap): trim long lists.
  function compact(out) {
    let s = JSON.stringify(out); if (s.length < 30000) return out;
    if (out && Array.isArray(out.blocks)) return { ...out, blocks: out.blocks.slice(0, 120), note: `trimmed to 120 of ${out.blocks.length} blocks` };
    if (out && Array.isArray(out.screens)) return { ...out, screens: out.screens.slice(0, 60).map(x => ({ ...x, blocks: Array.isArray(x.blocks) ? x.blocks.length : x.blocks })), note: 'trimmed' };
    return s.slice(0, 30000);
  }
  const STEP = { get_selection: 'Reading the selection', get_canvas: 'Reading the canvas', get_frame: 'Reading a screen', get_brand: 'Reading the brand kit', get_screenshot: 'Looking at a screen', get_code: 'Reading the code' };

  // ---- UI -----------------------------------------------------------------------------------------------------------
  function init(e) {
    env = e;
    $('agentClose').addEventListener('click', hide);
    $('agentForm').addEventListener('submit', ev => { ev.preventDefault(); if (busy) stop(); else { const t = $('agentInput').value.trim(); if (t) { $('agentInput').value = ''; send(t); } } });
    $('agentInput').addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); $('agentForm').requestSubmit(); } if (ev.key === 'Escape') hide(); });
    $('agentSuggest').addEventListener('click', ev => { const b = ev.target.closest('[data-suggest]'); if (b) send(b.dataset.suggest); });
    $('agentFoot').addEventListener('click', async ev => { const c = ev.target.closest('[data-copy]'); if (c) { try { await navigator.clipboard.writeText(c.dataset.copy); env.toast('Copied'); } catch { } } const s = ev.target.closest('[data-settings]'); if (s) { ev.preventDefault(); env.openSettings(); } });
    $('cvAgent').addEventListener('click', () => ($('agentPanel').hidden ? show() : hide()));
    document.addEventListener('keydown', ev => { if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'k' && document.body.classList.contains('canvas-mode')) { ev.preventDefault(); $('agentPanel').hidden ? show() : hide(); } });
    CanvasUI.on('select', () => { if (!$('agentPanel').hidden) renderContext(); });
    (async () => {
      if (window.claude && typeof window.claude.use === 'function') {
        try { sample = await window.claude.use('sample'); } catch { sample = null; }
        sampleAny = sample;
        if (sample) { try { const lim = await sample.limits(); sampleTools = lim && lim.tools ? lim.tools.maxCount : 0; if (!sampleTools) sample = null; } catch { sample = null; } }
      }
      renderFoot();
    })();
    renderFoot();
  }
  function show() { $('agentPanel').hidden = false; $('cvAgent').classList.add('active'); renderContext(); renderFoot(); renderSuggest(); setTimeout(() => $('agentInput').focus(), 0); }
  function hide() { $('agentPanel').hidden = true; $('cvAgent').classList.remove('active'); }
  function renderContext() {
    const s = CanvasUI.selection(); const n = s.frameIds.length;
    $('agentCtx').textContent = n ? (s.blockIds.length ? `${s.blockIds.length} block${s.blockIds.length > 1 ? 's' : ''} selected` : `${n} screen${n > 1 ? 's' : ''} selected`) : 'Whole canvas';
    if (!$('agentLog').children.length) renderSuggest();
  }
  function renderSuggest() {
    const n = CanvasUI.selection().frameIds.length; const kit = env.getKit(); if (!kit) return;
    const dark = (kit.colors.find(c => c.role === 'background' && Color.luminance(Color.normalize(c.hex)) < 0.1) || kit.colors.find(c => Color.luminance(Color.normalize(c.hex)) < 0.08) || { name: 'dark' }).name;
    const list = n ? ['Make 3 variations of this', `Put these on ${dark}`, 'Shorten the headline, keep the meaning', 'Translate the copy to Spanish', 'Make the call to action stand out more', 'Turn these into a wireframe']
      : ['Create a square post announcing Akai', 'Tidy every screen into a grid', 'Make a story version of the first screen', 'Rebrand every screen'];
    $('agentSuggest').innerHTML = $('agentLog').children.length ? '' : list.map(t => `<button type="button" class="chip" data-suggest="${esc(t)}">${esc(t)}</button>`).join('');
  }
  function renderFoot() {
    const m = mode(); const room = typeof Sync !== 'undefined' && Sync.status.mode === 'server' ? Sync.status.room : null;
    const mcp = `claude mcp add layout --transport http ${location.origin}/mcp${room ? '?room=' + room : ''}`;
    let html = m === 'sample' ? 'Claude, on your claude.ai account. Each request uses your Claude usage.'
      : m === 'api' ? `Claude Opus 5.5 with the API key from <a href="#" data-settings>Settings</a>. If Claude declines, another model takes over.`
      : `To use the agent here, add an Anthropic API key in <a href="#" data-settings>Settings</a>, or open the published page on claude.ai.`;
    if (typeof Sync !== 'undefined' && Sync.status.mode === 'server') html += `<div class="agent-mcp">Claude Code, Cursor or Codex can drive this canvas too: <code>${esc(mcp)}</code> <button type="button" class="btn small ghost" data-copy="${esc(mcp)}">Copy</button></div>`;
    $('agentFoot').innerHTML = html;
    $('agentInput').placeholder = m ? 'Ask for a change: "make 3 variations", "put these on Deelberry"…' : 'Add an API key in Settings to talk to the agent';
  }
  function bubble(role, text) {
    const el = document.createElement('div'); el.className = 'agent-msg ' + role;
    el.innerHTML = role === 'assistant' ? '<div class="steps"></div><div class="txt thinking">Thinking…</div>' : `<div class="txt">${esc(text)}</div>`;
    $('agentLog').appendChild(el); $('agentSuggest').innerHTML = ''; scroll(); return el;
  }
  const scroll = () => { const l = $('agentLog'); l.scrollTop = l.scrollHeight; };
  function setText(el, t) { const x = el.querySelector('.txt'); x.classList.remove('thinking'); x.textContent = t; scroll(); }
  function step(el, t, pending) { const s = document.createElement('div'); s.className = 'step' + (pending ? ' pending' : ''); s.textContent = (pending ? '… ' : '✓ ') + t; el.querySelector('.steps').appendChild(s); scroll(); return s; }
  function setBusy(b) { busy = b; $('agentSend').textContent = b ? 'Stop' : 'Send'; $('agentSend').classList.toggle('stop', b); }
  function stop() { stopped = true; if (ctl) ctl.abort(); }

  // ---- runs -----------------------------------------------------------------------------------------------------------
  async function send(text) {
    if (busy) return; const m = mode();
    if ($('agentPanel').hidden) show();
    bubble('user', text); const box = bubble('assistant');
    if (!m) { setText(box, 'Add an Anthropic API key in Settings to use the agent here, or open the published page on claude.ai where it runs on your account.'); return; }
    setBusy(true); stopped = false; ctl = new AbortController();
    AgentTools.beginRun(s => step(box, s));
    const pendingOf = name => STEP[name] ? step(box, STEP[name], true) : null;
    const runTool = async (name, input) => {
      if (stopped) throw new Error('Stopped by the person');
      const p = pendingOf(name);
      try { return await AgentTools.call(name, input); } finally { if (p) p.remove(); }
    };
    try {
      if (m === 'sample') {
        const tools = AgentTools.defs({ core: true }).slice(0, sampleTools).map(d => ({ name: d.name, description: d.description.slice(0, 1000), inputSchema: d.inputSchema, execute: async (input, c) => { if (c && c.signal && c.signal.aborted) throw new Error('Stopped'); return compact(await runTool(d.name, input)); } }));
        const input = [{ role: 'user', content: SYSTEM }, ...turns.slice(-8), { role: 'user', content: `${context()}\n\nRequest: ${text}` }];
        const res = await sample(input, { tools, signal: ctl.signal, cache: false, onText: ({ text: t }) => setText(box, t) });
        setText(box, res.text + (res.truncated ? '\n(Cut short.)' : ''));
        turns.push({ role: 'user', content: text }, { role: 'assistant', content: res.text.slice(-2000) });
      } else {
        const { Anthropic, betaTool } = await loadSdk();
        const opts = { apiKey: apiKey().trim(), dangerouslyAllowBrowser: true }; try { const base = JSON.parse(localStorage.getItem('lg.apiBase') || 'null'); if (base) opts.baseURL = base; } catch { }
        const client = new Anthropic(opts);
        const tools = AgentTools.defs().map(d => betaTool({
          name: d.name, description: d.description, inputSchema: d.inputSchema,
          run: async input => {
            const out = await runTool(d.name, input);
            if (out && typeof out.image === 'string') { const { image, ...rest } = out; return [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.split(',')[1] } }, { type: 'text', text: JSON.stringify(rest) }]; }
            return typeof out === 'string' ? out : JSON.stringify(out);
          },
        }));
        const messages = [...apiTurns.slice(-8), { role: 'user', content: `${context()}\n\nRequest: ${text}` }];
        const runner = client.beta.messages.toolRunner({
          model: MODEL, max_tokens: 16000, system: SYSTEM, messages, tools, max_iterations: 16,
          thinking: { type: 'adaptive' }, output_config: { effort: 'medium' },
          betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
        });
        let last = null, said = '';
        for await (const msg of runner) {
          last = msg; if (stopped) break;
          const t = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim(); if (t) { said = t; setText(box, t); }
          if (msg.stop_reason === 'refusal') break;
        }
        if (last && last.stop_reason === 'refusal') setText(box, 'Claude declined this request. Try asking for it differently.');
        else if (stopped) setText(box, (said ? said + '\n' : '') + 'Stopped.');
        else if (!said) setText(box, 'Done.');
        apiTurns.push({ role: 'user', content: text }, { role: 'assistant', content: (said || 'Done.').slice(-2000) });
      }
    } catch (e) {
      const code = e && e.code; const msg = e && (e.message || String(e));
      const copy = code === 'cancelled' ? 'Stopped.' : code === 'not_granted' ? 'Claude is not allowed for this page. You can allow it from the prompt that appears on the next request.' : code === 'rate_limited' ? 'Too many requests right now. Try again in a moment.' : code === 'refused' ? 'Claude declined this request. Try asking for it differently.' : code === 'tools_unavailable' ? 'This view cannot run canvas tools.' : (e && e.status === 401) ? 'The API key was not accepted. Check it in Settings.' : stopped ? 'Stopped.' : 'Something went wrong: ' + msg;
      setText(box, (e && e.text ? e.text + '\n\n' : '') + copy);
      if (code === 'not_granted' || code === 'sampling_disabled') { sample = null; renderFoot(); }
    } finally {
      AgentTools.endRun(); setBusy(false); ctl = null;
      box.querySelectorAll('.step.pending').forEach(s => s.remove());
    }
  }
  // ---- Vision: one image and a prompt in, parsed JSON out (screenshots and slides rebuilt as layers) -------------------
  const parseJSON = t => { const m = String(t || '').replace(/^```(?:json)?\s*|\s*```\s*$/g, '').match(/\{[\s\S]*\}/); if (!m) throw new Error('Claude did not return layers'); return JSON.parse(m[0]); };
  const blobToB64 = blob => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = rej; fr.readAsDataURL(blob); });
  function canSee() { return !!sampleAny || !!apiKey().trim(); }
  async function vision(prompt, blob, opts = {}) {
    if (sampleAny) {
      let lim = null; try { lim = await sampleAny.limits(); } catch { lim = null; }
      if (lim && lim.images) {
        try { return await sampleAny.json(prompt, { images: [blob], modelTier: 'complex', signal: opts.signal }); }
        catch (e) { if (e && e.code === 'invalid_json' && e.text) return parseJSON(e.text); throw new Error(e && e.message ? e.message : 'Claude could not read the image'); }
      }
    }
    if (!apiKey().trim()) throw new Error('Rebuilding needs Claude: open this page in claude.ai, or add an Anthropic API key in Settings.');
    const { Anthropic } = await loadSdk();
    const o = { apiKey: apiKey().trim(), dangerouslyAllowBrowser: true }; try { const base = JSON.parse(localStorage.getItem('lg.apiBase') || 'null'); if (base) o.baseURL = base; } catch { }
    const client = new Anthropic(o);
    const stream = client.beta.messages.stream({ model: MODEL, max_tokens: 16000, thinking: { type: 'adaptive' }, output_config: { effort: 'medium' }, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: blob.type || 'image/png', data: await blobToB64(blob) } }, { type: 'text', text: prompt }] }] }, { signal: opts.signal });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') throw new Error('Claude declined to read this image');
    return parseJSON(msg.content.filter(c => c.type === 'text').map(c => c.text).join(''));
  }
  return { init, show, hide, send, vision, canSee, get busy() { return busy; }, _mode: mode };
})();
