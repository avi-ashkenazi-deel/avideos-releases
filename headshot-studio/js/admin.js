// Admin: set the company photo policy, preview it live, review submissions.

import { icon } from './icons.js';
import { el, esc, rulesHTML, toast, sizedCopy } from './ui.js';
import {
  BACKGROUND_PRESETS, TREATMENTS, RETOUCH_LIMITS, STRICTNESS, EDIT_GROUPS,
  savePolicy, resetPolicy, saveSubmissions,
} from './policy.js';
import { renderSample } from './sample.js';
import { ATTIRE, EXPRESSION, buildPrompt } from './prompt.js';
import { regenStatus } from './ai-provider.js';
import { composeAvatar, makeCanvas } from './pipeline.js';

const TREAT_SWATCH = {
  natural: 'linear-gradient(135deg, #e8b48f, #8aa9d6)',
  bw: 'linear-gradient(135deg, #f2f2f2, #1a1a1a)',
  warm: 'linear-gradient(135deg, #f7d9a8, #b8754a)',
  cool: 'linear-gradient(135deg, #d6e6f7, #4c6f9c)',
  duotone: null, // uses the brand color
};

function segHTML(name, options, value) {
  return `<div class="seg" role="group" data-seg="${name}">${Object.entries(options).map(([k, label]) =>
    `<button type="button" data-value="${k}" aria-pressed="${k === value}">${label}</button>`).join('')}</div>`;
}

function switchHTML(id, label, help, checked) {
  return `<div class="switch-row">
    <div><div style="font-weight:500">${label}</div>${help ? `<div class="caption">${help}</div>` : ''}</div>
    <label class="switch"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''} aria-label="${esc(label)}"><span></span></label>
  </div>`;
}

export class AdminView {
  constructor(root, state, onPolicyChange) {
    this.root = root;
    this.state = state;
    this.onPolicyChange = onPolicyChange;
    this.previewSource = state.session?.renderer ? 'photo' : 'sample';
  }

  get policy() { return this.state.policy; }

  mount() { this.render(); }
  unmount() {}

  commit(mutator, rerender = true) {
    mutator(this.policy);
    if (!savePolicy(this.policy)) toast('That image is too large to save. Try a smaller one.');
    this.onPolicyChange?.();
    if (rerender) this.render(); else this.refreshPreview();
  }

  render() {
    const p = this.policy;
    const bg = p.background;
    const presetSwatch = (pr) => {
      const fill = pr.type === 'blur' ? 'linear-gradient(135deg,#cbb8a3,#8f7a66)'
        : pr.type === 'original' ? 'linear-gradient(135deg,#d9c8b4 40%,#6b5644 40% 60%,#eef3f7 60%)'
        : pr.colors.length > 1 ? (pr.type === 'studio' ? `radial-gradient(circle at 50% 35%, ${pr.colors[0]}, ${pr.colors[1]})` : `linear-gradient(180deg, ${pr.colors[0]}, ${pr.colors[1]})`)
        : pr.colors[0];
      const inner = pr.type === 'blur' ? icon('background', 20) : '';
      return `<button type="button" class="swatch" data-preset="${pr.id}" aria-pressed="${bg.preset === pr.id && bg.type === pr.type}">
        <span class="swatch-fill" style="background:${fill}">${inner}</span>${pr.label}</button>`;
    };
    const customColor = bg.type === 'color' && bg.preset === 'custom' ? bg.colors[0] : '#5c9be1';

    this.root.replaceChildren(el(`
      <section>
        <div class="admin-head">
          <div class="title">
            <span class="label">Company photo policy</span>
            <input class="policy-name" id="policy-name" value="${esc(p.name)}" aria-label="Policy name">
            ${rulesHTML(p)}
          </div>
          <div class="actions">
            <button class="btn btn--text" id="reset-policy">${icon('refresh', 16)}Reset</button>
            <button class="btn btn--primary" id="copy-link">${icon('link', 16)}Copy invite link</button>
          </div>
        </div>
        <div class="admin">
          <div class="settings">
            <div class="card card-pad">
              <div class="setting-head">${icon('sparkle', 20)}<div><h3>AI studio photo</h3><p>An image model rebuilds each photo as a professional studio headshot: proper outfit, studio light, no drinks, props or other people. The person picks from a few options, then the style below is applied.</p></div></div>
              <div class="field"><span class="label">Mode</span>${segHTML('ai.mode', { regenerate: 'On · regenerate as a studio photo', off: 'Off · retouch the real photo' }, p.ai.mode)}</div>
              ${p.ai.mode === 'regenerate' ? `
              <div class="row-2">
                <div class="field"><span class="label">Outfit</span>${segHTML('ai.attire', ATTIRE, p.ai.attire)}</div>
                <div class="field"><span class="label">Expression</span>${segHTML('ai.expression', EXPRESSION, p.ai.expression)}</div>
              </div>
              <div class="field"><span class="label">Options to choose from</span>${segHTML('ai.variations', { 1: '1', 2: '2', 3: '3', 4: '4' }, String(p.ai.variations))}</div>
              <div class="switch-row" style="padding:0"><span class="caption">Image model</span><span class="chip" id="ai-status">Checking…</span></div>
              <details><summary>What the model is told</summary><pre class="prompt-box">${esc(buildPrompt(p))}</pre></details>
              <p class="caption">${icon('shield', 14)} Only the person is sent to the model. The room and anyone else in the shot are removed on their device first.</p>` : ''}
            </div>

            <div class="card card-pad">
              <div class="setting-head">${icon('background', 20)}<div><h3>Background</h3><p>Replaces whatever is behind the person. Brand colors stay exact; photo backgrounds follow the color treatment.</p></div></div>
              <div class="swatches">
                ${BACKGROUND_PRESETS.map(presetSwatch).join('')}
                <label class="swatch" aria-pressed="${bg.preset === 'custom'}">
                  <input type="color" id="custom-color" value="${esc(customColor)}" aria-label="Custom background color">Custom color
                </label>
                <label class="swatch" for="bg-upload" aria-pressed="${bg.type === 'image'}">
                  <span class="swatch-fill" style="${bg.type === 'image' && bg.image ? `background-image:url('${bg.image}')` : 'background:var(--neutral-light)'}">${bg.type === 'image' ? '' : icon('upload', 20)}</span>Company image
                </label>
                <input type="file" id="bg-upload" accept="image/*" hidden>
              </div>
            </div>

            <div class="card card-pad">
              <div class="setting-head">${icon('palette', 20)}<div><h3>Look</h3><p>One color treatment for everyone, so the team page looks consistent.</p></div></div>
              <div class="treatments">
                ${Object.entries(TREATMENTS).map(([k, label]) => `
                  <button type="button" class="swatch" data-treatment="${k}" aria-pressed="${p.treatment === k}">
                    <span class="treat-thumb" style="background:${TREAT_SWATCH[k] || `linear-gradient(135deg, #011423, ${p.brandColor}, #f4f7ff)`}"></span>${label}
                  </button>`).join('')}
              </div>
              <div class="field" style="max-width:220px">
                <label for="brand-color">Brand color · used for the ring and duotone</label>
                <input type="color" id="brand-color" value="${esc(p.brandColor)}" style="width:100%;height:40px;border:1px solid var(--neutral-dark);border-radius:8px;padding:2px;background:var(--paper)">
              </div>
            </div>

            <div class="card card-pad">
              <div class="setting-head">${icon('frame', 20)}<div><h3>Framing and avatar</h3><p>How the photo is cropped and the shape it takes across Deel.</p></div></div>
              <div class="row-2">
                <div class="field"><span class="label">Framing</span>${segHTML('framing', { headshoulders: 'Head & shoulders', closeup: 'Close-up' }, p.framing)}</div>
                <div class="field"><span class="label">Avatar shape</span>${segHTML('shape', { circle: 'Circle', rounded: 'Rounded', square: 'Square' }, p.shape)}</div>
              </div>
              ${switchHTML('ring', 'Brand ring', 'A thin ring in your brand color around the avatar.', p.ring.enabled)}
            </div>

            <div class="card card-pad">
              <div class="setting-head">${icon('sparkle', 20)}<div><h3>Retouching</h3><p>How far people can adjust their own photo after it is generated.</p></div></div>
              <div class="field"><span class="label">Retouch limit</span>${segHTML('retouchLimit', Object.fromEntries(Object.entries(RETOUCH_LIMITS).map(([k, v]) => [k, v.label])), p.retouchLimit)}
                <span class="caption">${esc(RETOUCH_LIMITS[p.retouchLimit].help)}</span></div>
              <div class="field"><span class="label">Sliders people can use</span>
                <div class="seg" role="group" aria-label="Allowed slider groups">${Object.entries(EDIT_GROUPS).map(([k, label]) =>
                  `<button type="button" data-edit="${k}" aria-pressed="${p.edits[k]}">${p.edits[k] ? icon('check', 14) : ''}${label}</button>`).join('')}</div>
              </div>
            </div>

            <div class="card card-pad">
              <div class="setting-head">${icon('camera', 20)}<div><h3>Capture guidance</h3><p>How strict the on-screen coach is before a photo can be taken.</p></div></div>
              <div class="field"><span class="label">Strictness</span>${segHTML('strictness', Object.fromEntries(Object.entries(STRICTNESS).map(([k, v]) => [k, v.label])), p.capture.strictness)}</div>
              <div>
                ${switchHTML('auto-capture', 'Auto capture', 'Takes the photo with a 3-second countdown once everything is right.', p.capture.autoCapture)}
                ${switchHTML('eyes-open', 'Require open eyes', 'Blocks capture while eyes are closed.', p.capture.eyesOpen)}
                ${switchHTML('approval', 'Admin approval', 'New photos wait for approval before they appear on profiles.', p.requireApproval)}
              </div>
            </div>
          </div>

          <aside class="card preview-panel">
            <div class="panel-head"><h3>Live preview</h3>
              ${this.state.session?.renderer ? segHTML('previewSource', { sample: 'Sample', photo: 'Last photo' }, this.previewSource) : '<span class="caption">Sample person</span>'}
            </div>
            <div class="avatar-hero" id="preview-avatar"></div>
            <div class="preview-portrait" id="preview-portrait"></div>
            <p class="caption">This is exactly what the person sees after capture, before their own adjustments.</p>
          </aside>
        </div>

        <div class="card subs">
          <div class="subs-head">
            <div><h2>Submitted photos</h2><span class="caption">Photos taken in this browser. In Deel this list would come from the org.</span></div>
            <a class="btn btn--outlined btn--sm" href="#capture">${icon('camera', 16)}Take a test photo</a>
          </div>
          ${this.subsHTML()}
        </div>
      </section>`));

    this.bind();
    this.refreshPreview();
    this.showModelStatus();
  }

  subsHTML() {
    const list = this.state.submissions;
    if (!list.length) {
      return `<div class="empty">${icon('users', 32)}<b>No photos yet</b><span>Copy the invite link and share it with your team. Their photos will show up here.</span></div>`;
    }
    const chip = { pending: 'chip--warning">Waiting for approval', approved: 'chip--success">Approved', retake: 'chip--error">Retake requested' };
    return `<div class="table-wrap"><table>
      <thead><tr><th>Photo</th><th>Name</th><th>Submitted</th><th>Status</th><th></th></tr></thead>
      <tbody>${list.map((s) => `
        <tr data-id="${esc(s.id)}">
          <td><img src="${s.avatar}" alt="${esc(s.name)}" width="40" height="40"></td>
          <td>${esc(s.name)}<div class="caption">${esc(s.policy)}</div></td>
          <td style="white-space:nowrap">${new Date(s.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</td>
          <td><span class="chip ${chip[s.status] || chip.pending}</span></td>
          <td style="white-space:nowrap;text-align:right">
            ${s.status !== 'approved' ? `<button class="btn btn--text btn--sm" data-act="approve">Approve</button>` : ''}
            ${s.status !== 'retake' ? `<button class="btn btn--text btn--sm" data-act="retake">Ask for retake</button>` : ''}
            <button class="btn btn--danger btn--sm" data-act="delete" aria-label="Delete">${icon('x', 14)}</button>
          </td>
        </tr>`).join('')}</tbody></table></div>`;
  }

  bind() {
    const $ = (sel) => this.root.querySelector(sel);

    $('#policy-name').addEventListener('change', (e) => this.commit((q) => { q.name = e.target.value.trim() || 'Team profile photos'; }));
    $('#reset-policy').addEventListener('click', () => {
      this.state.policy = resetPolicy();
      this.onPolicyChange?.();
      this.render();
      toast('Policy reset to defaults');
    });
    $('#copy-link').addEventListener('click', async () => {
      const url = location.href.split('#')[0] + '#capture';
      try {
        await navigator.clipboard.writeText(url);
        toast('Invite link copied');
      } catch {
        toast(url);
      }
    });

    this.root.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
      const pr = BACKGROUND_PRESETS.find((x) => x.id === b.dataset.preset);
      this.commit((q) => { q.background = { preset: pr.id, type: pr.type, colors: [...pr.colors], image: null }; });
    }));
    $('#custom-color').addEventListener('change', (e) => {
      this.commit((q) => { q.background = { preset: 'custom', type: 'color', colors: [e.target.value], image: null }; });
    });
    $('#bg-upload').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const bmp = await createImageBitmap(file);
        const s = Math.min(1, 1200 / Math.max(bmp.width, bmp.height));
        const c = makeCanvas(Math.round(bmp.width * s), Math.round(bmp.height * s));
        c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
        const url = c.toDataURL('image/jpeg', 0.85);
        this.commit((q) => { q.background = { preset: 'image', type: 'image', colors: [], image: url }; });
      } catch {
        toast('That file could not be opened. Try a JPG or PNG.');
      }
    });

    this.root.querySelectorAll('[data-treatment]').forEach((b) => b.addEventListener('click', () => {
      this.commit((q) => { q.treatment = b.dataset.treatment; });
    }));
    $('#brand-color').addEventListener('change', (e) => this.commit((q) => { q.brandColor = e.target.value; }));

    this.root.querySelectorAll('[data-seg]').forEach((group) => {
      group.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
        const v = b.dataset.value;
        const key = group.dataset.seg;
        if (key === 'previewSource') {
          this.previewSource = v;
          group.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
          this.refreshPreview();
          return;
        }
        this.commit((q) => {
          if (key === 'strictness') q.capture.strictness = v;
          else if (key.startsWith('ai.')) q.ai[key.slice(3)] = key === 'ai.variations' ? Number(v) : v;
          else q[key] = v;
        });
      }));
    });
    this.root.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
      this.commit((q) => { q.edits[b.dataset.edit] = !q.edits[b.dataset.edit]; });
    }));

    $('#ring').addEventListener('change', (e) => this.commit((q) => { q.ring.enabled = e.target.checked; }));
    $('#auto-capture').addEventListener('change', (e) => this.commit((q) => { q.capture.autoCapture = e.target.checked; }));
    $('#eyes-open').addEventListener('change', (e) => this.commit((q) => { q.capture.eyesOpen = e.target.checked; }));
    $('#approval').addEventListener('change', (e) => this.commit((q) => { q.requireApproval = e.target.checked; }));

    this.root.querySelectorAll('tr[data-id] [data-act]').forEach((b) => b.addEventListener('click', () => {
      const id = b.closest('tr').dataset.id;
      const act = b.dataset.act;
      let list = this.state.submissions;
      if (act === 'delete') list = list.filter((s) => s.id !== id);
      else list = list.map((s) => (s.id === id ? { ...s, status: act === 'approve' ? 'approved' : 'retake' } : s));
      this.state.submissions = list;
      saveSubmissions(list);
      this.render();
    }));
  }

  async showModelStatus() {
    const chip = this.root.querySelector('#ai-status');
    if (!chip) return;
    const st = await regenStatus();
    if (!st) {
      chip.className = 'chip chip--warning';
      chip.textContent = 'Not connected: start server.mjs with an API key';
    } else if (st.mock) {
      chip.className = 'chip chip--warning';
      chip.textContent = 'Test mode: returns photos unchanged';
    } else {
      chip.className = 'chip chip--success';
      chip.textContent = `Connected · ${st.model}`;
    }
  }

  async refreshPreview() {
    const p = this.policy;
    const token = (this.previewToken = (this.previewToken || 0) + 1);
    let portrait, avatar;
    const session = this.state.session;
    if (this.previewSource === 'photo' && session?.renderer) {
      await session.renderer.setPolicy(p);
      session.policyStamp = JSON.stringify(p);
      portrait = session.renderer.render(session.ai.params);
      avatar = composeAvatar(portrait, session.prep, p, session.ai.params, 480);
    } else {
      ({ portrait, avatar } = await renderSample(p));
    }
    if (token !== this.previewToken) return;
    const a = this.root.querySelector('#preview-avatar');
    const pp = this.root.querySelector('#preview-portrait');
    if (!a || !pp) return;
    a.replaceChildren(sizedCopy(avatar, 240));
    const copy = makeCanvas(portrait.width, portrait.height);
    copy.getContext('2d').drawImage(portrait, 0, 0);
    pp.replaceChildren(copy);
  }
}
