// The person's flow: get ready → guided webcam capture → processing →
// retouch with sliders → done (download / submit).

import { icon } from './icons.js';
import { el, esc, rulesHTML, stepper, toast, downloadCanvas, sizedCopy } from './ui.js';
import { RETOUCH_LIMITS, STRICTNESS, EDIT_GROUPS, saveSubmissions } from './policy.js';
import { getLiveLandmarker, preload } from './vision.js';
import { Guide, TARGET } from './guidance.js';
import { prepare, Renderer, composeAvatar, makeCanvas } from './pipeline.js';
import { onDeviceProvider, regenStatus, regenerate } from './ai-provider.js';
import { renderSample } from './sample.js';

const SLIDERS = [
  { group: 'light', key: 'brightness', label: 'Brightness', min: -50, max: 50 },
  { group: 'light', key: 'contrast', label: 'Contrast', min: -50, max: 50 },
  { group: 'light', key: 'warmth', label: 'Warmth', min: -50, max: 50 },
  { group: 'light', key: 'fillLight', label: 'Fill light on face', min: 0, max: 100 },
  { group: 'skin', key: 'smoothing', label: 'Smooth skin', min: 0, max: 100, limited: true },
  { group: 'skin', key: 'skinTone', label: 'Skin tone · cooler to warmer', min: -50, max: 50, limited: true },
  { group: 'skin', key: 'skinLight', label: 'Skin brightness', min: -50, max: 50, limited: true },
  { group: 'eyes', key: 'eyeBright', label: 'Brighten eyes', min: 0, max: 100, limited: true },
  { group: 'eyes', key: 'eyeClarity', label: 'Eye clarity', min: 0, max: 100, limited: true },
  { group: 'eyes', key: 'underEye', label: 'Brighten under-eyes', min: 0, max: 100, limited: true },
  { group: 'lips', key: 'lipColor', label: 'Lip color', min: -50, max: 100, limited: true },
  { group: 'framing', key: 'zoom', label: 'Zoom avatar', min: 0, max: 40 },
  { group: 'framing', key: 'offsetY', label: 'Move face up or down', min: -50, max: 50 },
];
const GROUP_ICONS = { light: 'sun', skin: 'face', eyes: 'eye', lips: 'lips', framing: 'frame' };
const CHECK_ICONS = { face: 'face', distance: 'ruler', position: 'target', head: 'level', light: 'sun', eyes: 'eye' };

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

// Fills a w x h canvas with src, cropped to cover.
function coverCopy(src, w, h) {
  const c = makeCanvas(w, h);
  const s = Math.max(w / src.width, h / src.height);
  c.getContext('2d').drawImage(src, (w - src.width * s) / 2, (h - src.height * s) / 2, src.width * s, src.height * s);
  return c;
}

// The person on a plain grey backdrop: what gets sent to the image model.
function cutoutOnGrey(prep) {
  const { W, H, masks } = prep;
  const src = prep.baseClean || prep.base;
  const c = makeCanvas(W, H);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H);
  const d = img.data;
  for (let i = 0, j = 0; i < W * H; i++, j += 4) {
    const m = masks.person[i];
    d[j] = src[j] * m + 214 * (1 - m);
    d[j + 1] = src[j + 1] * m + 217 * (1 - m);
    d[j + 2] = src[j + 2] * m + 222 * (1 - m);
    d[j + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function maskCanvas(mask, W, H) {
  const c = makeCanvas(W, H);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H);
  for (let i = 0; i < W * H; i++) {
    const v = Math.round(255 * mask[i]);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function canvasFromDataUrl(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = makeCanvas(img.naturalWidth, img.naturalHeight);
      c.getContext('2d').drawImage(img, 0, 0);
      resolve(c);
    };
    img.onerror = () => reject(new Error('bad-image'));
    img.src = src;
  });
}

export class CaptureFlow {
  constructor(root, state) {
    this.root = root;
    this.state = state;
    this.stream = null;
    this.raf = 0;
    this.session = state.session; // survives tab switches
  }

  get policy() { return this.state.policy; }

  mount() {
    preload(); // warm up the models while the person reads the intro
    const s = this.session;
    if (s?.screen === 'retouch' && s.renderer) this.showRetouch();
    else if (s?.screen === 'pick' && s.variants) this.showPick();
    else if (s?.screen === 'done' && s.renderer) this.showDone();
    else this.showIntro();
  }

  unmount() {
    this.stopCamera();
  }

  setSession(patch) {
    this.session = { ...(this.session || {}), ...patch };
    this.state.session = this.session;
  }

  // ---------- 1. intro ----------

  async showIntro() {
    this.stopCamera();
    this.setSession({ screen: 'intro' });
    const p = this.policy;
    const name = this.state.name || '';
    this.root.replaceChildren(el(`
      <section>
        ${stepper(0, this.policy.ai?.mode === 'regenerate')}
        <div class="intro">
          <div class="intro-main card">
            <div class="card-pad">
              <h1>Let's take your profile photo</h1>
              <p class="lede">${p.ai?.mode === 'regenerate'
                ? 'Sit in front of your webcam. We’ll guide you on distance, light and angle, then turn the shot into a professional studio headshot in your company’s style. You pick the version that looks most like you and can fine-tune it.'
                : 'Sit in front of your webcam. We’ll guide you on distance, light and angle, then style the photo to your company’s look. You can fine-tune it before you save.'}</p>
              <div class="tips">
                <div class="tip">${icon('sun', 20)}<strong>Face your light</strong><span>A window or lamp in front of you, not behind.</span></div>
                <div class="tip">${icon('level', 20)}<strong>Camera at eye level</strong><span>Prop up your laptop so you look straight ahead.</span></div>
                <div class="tip">${icon('face', 20)}<strong>Be yourself</strong><span>Plain top, no hat or sunglasses. A small smile helps.</span></div>
              </div>
              <div class="field" style="max-width:360px">
                <label for="hs-name">Your name</label>
                <input class="input" id="hs-name" autocomplete="name" placeholder="e.g. Jordan Lee" value="${esc(name)}">
              </div>
              <div class="actions">
                <button class="btn btn--primary btn--lg" id="start-camera">${icon('camera')}Start camera</button>
                <label class="btn btn--outlined btn--lg" for="upload">${icon('upload')}Upload a photo</label>
                <input type="file" id="upload" accept="image/*" hidden>
              </div>
              <p class="privacy">${icon('shield', 16)}${p.ai?.mode === 'regenerate'
                ? 'Only you are sent to the image model. The room and anyone else in the shot are removed on this device first.'
                : 'Your photo is processed on this device. Nothing is uploaded until you submit it.'}</p>
              <div id="cam-error" class="alert alert--warning" hidden></div>
            </div>
          </div>
          <aside class="card card-pad style-card">
            <span class="label">Your company's photo style</span>
            <div class="avatar-hero" id="style-avatar"></div>
            ${rulesHTML(p)}
            <p class="caption">Set by your admin in “${esc(p.name)}”</p>
          </aside>
        </div>
      </section>`));

    const nameInput = this.root.querySelector('#hs-name');
    nameInput.addEventListener('input', () => {
      this.state.name = nameInput.value;
      try { localStorage.setItem('hs.name', nameInput.value); } catch { /* ignore */ }
    });
    this.root.querySelector('#start-camera').addEventListener('click', () => this.showCamera());
    this.root.querySelector('#upload').addEventListener('change', (e) => this.fromFile(e.target.files?.[0]));

    const { avatar } = await renderSample(p);
    const holder = this.root.querySelector('#style-avatar');
    if (holder) holder.replaceChildren(sizedCopy(avatar, 260));
  }

  async fromFile(file) {
    if (!file) return;
    try {
      const bmp = await createImageBitmap(file);
      const s = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
      const c = makeCanvas(Math.round(bmp.width * s), Math.round(bmp.height * s));
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      this.process(c);
    } catch {
      toast('That file could not be opened. Try a JPG or PNG.');
    }
  }

  // ---------- 2. camera ----------

  async showCamera() {
    this.setSession({ screen: 'camera' });
    this.root.replaceChildren(el(`
      <section>
        ${stepper(1, this.policy.ai?.mode === 'regenerate')}
        <div class="shoot">
          <div>
            <div class="stage" id="stage">
              <video id="video" playsinline muted></video>
              <canvas class="overlay" id="overlay"></canvas>
              <div class="hint" id="hint" data-tone="bad"><span class="hint-dot"></span><span id="hint-text">Starting camera…</span></div>
              <div class="countdown" id="countdown" hidden></div>
              <div class="flash" id="flash"></div>
              <div class="stage-status" id="stage-status">Allow camera access to continue.</div>
            </div>
            <div class="shoot-bar">
              <button class="btn btn--text" id="back">${icon('arrowLeft')}Back</button>
              <button class="shutter" id="shutter" data-ready="false" aria-label="Take photo">${icon('camera', 26)}</button>
              <span class="caption" id="auto-note" style="min-width:96px;text-align:right">${this.policy.capture.autoCapture ? 'Auto capture on' : 'Press to capture'}</span>
            </div>
          </div>
          <aside class="card side-card">
            <h3>Checklist</h3>
            <div class="checks" id="checks"></div>
            <div class="meter">
              <div class="label">Light on your face</div>
              <div class="meter-track"><div class="meter-zone" id="meter-zone"></div><div class="meter-pin" id="meter-pin" style="left:0%"></div></div>
            </div>
          </aside>
        </div>
      </section>`));

    this.root.querySelector('#back').addEventListener('click', () => this.showIntro());
    this.root.querySelector('#shutter').addEventListener('click', () => this.capture());
    const minLight = (STRICTNESS[this.policy.capture.strictness] || STRICTNESS.standard).minLight;
    const zone = this.root.querySelector('#meter-zone');
    zone.style.left = (minLight / 255) * 100 + '%';
    zone.style.width = ((228 - minLight) / 255) * 100 + '%';

    const video = this.root.querySelector('#video');
    const status = this.root.querySelector('#stage-status');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 }, facingMode: 'user' },
        audio: false,
      });
    } catch (err) {
      this.showIntro().then(() => {
        const box = this.root.querySelector('#cam-error');
        if (!box) return;
        box.hidden = false;
        box.innerHTML = `${icon('camera')}<div><b>Camera unavailable.</b> ${err?.name === 'NotAllowedError'
          ? 'Camera access was blocked. Allow it in your browser’s site settings, or upload a photo instead.'
          : 'No camera was found or it is in use by another app. Close other video apps, or upload a photo instead.'}</div>`;
      });
      return;
    }
    video.srcObject = this.stream;
    await video.play().catch(() => {});
    status.textContent = 'Loading face guide…';
    this.landmarker = await getLiveLandmarker();
    status.hidden = true;
    this.guide = new Guide();
    this.lastDetect = 0;
    this.countdown = null;
    this.loop();
  }

  stopCamera() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.countdown = null;
  }

  loop() {
    this.raf = requestAnimationFrame(() => this.loop());
    const video = this.root.querySelector('#video');
    if (!video || video.readyState < 2 || this.capturing) return;
    const now = performance.now();
    if (now - this.lastDetect < 60) return;
    this.lastDetect = now;
    const result = this.landmarker.detectForVideo(video, now);
    const g = this.guide.analyze(video, result, this.policy);
    this.last = { g, result };
    this.paint(video, g);
    this.autoCapture(g, now);
  }

  paint(video, g) {
    // Hint pill
    const hint = this.root.querySelector('#hint');
    hint.dataset.tone = g.tone;
    this.root.querySelector('#hint-text').textContent = this.countdown ? 'Hold still…' : g.hint;
    this.root.querySelector('#shutter').dataset.ready = String(g.ready);

    // Checklist
    const checks = this.root.querySelector('#checks');
    checks.innerHTML = g.checks.map((c) => `
      <div class="check" data-status="${c.status}">
        ${icon(CHECK_ICONS[c.id], 18)}
        <div class="check-text"><b>${esc(c.label)}</b>${c.hint ? `<span>${esc(c.hint)}</span>` : ''}</div>
        <span class="check-state">${c.status === 'ok' ? icon('check', 12) : c.status === 'idle' ? '' : icon('x', 12)}</span>
      </div>`).join('');

    // Light meter
    if (g.light) this.root.querySelector('#meter-pin').style.left = Math.min(100, (g.light.face / 255) * 100) + '%';

    // Overlay: dim outside the oval guide, color the oval by readiness.
    const canvas = this.root.querySelector('#overlay');
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(rect.width * dpr)) {
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
    }
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const vw = video.videoWidth, vh = video.videoHeight;
    const scale = Math.max(w / vw, h / vh);
    const dw = vw * scale, dh = vh * scale, ox = (w - dw) / 2, oy = (h - dh) / 2;
    const s = STRICTNESS[this.policy.capture.strictness] || STRICTNESS.standard;
    const idealFace = ((s.minFace + s.maxFace) / 2) * (this.policy.framing === 'closeup' ? 1.18 : 1);
    const ry = (idealFace * dh) / 2 * 1.32;
    const rx = ry * 0.74;
    const cx = ox + TARGET.x * dw;
    const cy = oy + TARGET.y * dh - ry * 0.06;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(1, 20, 35, 0.45)';
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill('evenodd');
    const color = g.tone === 'ok' ? '#2fd395' : g.tone === 'warn' ? '#ffc664' : '#ff6962';
    ctx.lineWidth = 4 * dpr;
    ctx.strokeStyle = color;
    ctx.setLineDash(g.ready ? [] : [10 * dpr, 10 * dpr]);
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Shoulder guide line under the oval.
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.moveTo(cx - rx * 2.1, cy + ry * 1.9);
    ctx.quadraticCurveTo(cx - rx * 1.6, cy + ry * 1.15, cx - rx * 0.55, cy + ry * 1.12);
    ctx.moveTo(cx + rx * 0.55, cy + ry * 1.12);
    ctx.quadraticCurveTo(cx + rx * 1.6, cy + ry * 1.15, cx + rx * 2.1, cy + ry * 1.9);
    ctx.stroke();

    // Countdown progress ring.
    if (this.countdown) {
      const t = Math.min(1, (performance.now() - this.countdown.start) / this.countdown.duration);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 6 * dpr;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx + 10 * dpr, ry + 10 * dpr, 0, -Math.PI / 2, -Math.PI / 2 + t * Math.PI * 2);
      ctx.stroke();
    }
  }

  autoCapture(g, now) {
    const cd = this.root.querySelector('#countdown');
    if (!this.policy.capture.autoCapture) return;
    const steady = g.ready && g.still;
    if (!this.countdown) {
      if (steady) this.countdown = { start: now, duration: 2400 };
      return;
    }
    if (!g.ready) {
      this.countdown = null;
      cd.hidden = true;
      return;
    }
    const left = this.countdown.duration - (now - this.countdown.start);
    if (left <= 0) {
      cd.hidden = true;
      this.countdown = null;
      this.capture();
      return;
    }
    cd.hidden = false;
    cd.textContent = String(Math.ceil(left / 800));
  }

  async capture() {
    if (this.capturing) return;
    const video = this.root.querySelector('#video');
    if (!video || video.readyState < 2) return;
    this.capturing = true;
    const flash = this.root.querySelector('#flash');
    flash.classList.remove('go');
    void flash.offsetWidth;
    flash.classList.add('go');

    // Short burst; keep the frame with the most open eyes.
    let best = null;
    for (let k = 0; k < 4; k++) {
      const c = makeCanvas(video.videoWidth, video.videoHeight);
      c.getContext('2d').drawImage(video, 0, 0);
      let blink = 1;
      try {
        const r = this.landmarker.detectForVideo(c, performance.now());
        const cats = r.faceBlendshapes?.[0]?.categories || [];
        const get = (n) => cats.find((x) => x.categoryName === n)?.score ?? 1;
        blink = r.faceLandmarks?.length ? Math.max(get('eyeBlinkLeft'), get('eyeBlinkRight')) : 1;
      } catch { /* keep default */ }
      if (!best || blink < best.blink) best = { c, blink };
      await new Promise((r) => setTimeout(r, 110));
    }
    this.capturing = false;
    this.stopCamera();
    this.process(best.c);
  }

  // ---------- 3. processing ----------

  async process(source) {
    this.setSession({ screen: 'processing', source, variants: null, regenInfo: null, compareWith: null });
    const st = this.policy.ai?.mode === 'regenerate' ? await regenStatus() : null;
    const regen = !!st;
    const tasks = regen ? [
      ['face', 'Finding you'],
      ['background', 'Removing the room and anyone else'],
      ['features', 'Mapping your face'],
      ['style', 'Preparing the photo'],
      ['regen', 'Generating your studio photo'],
    ] : [
      ['face', 'Finding your face'],
      ['background', 'Removing the background'],
      ['features', 'Mapping skin, eyes and lips'],
      ['style', 'Applying your company style'],
      ['ai', 'Retouching'],
    ];
    this.root.replaceChildren(el(`
      <section>
        ${stepper(1, regen)}
        <div class="processing">
          <div class="processing-shot" id="shot"></div>
          <div>
            <h1>${regen ? 'Creating your studio photo' : 'Creating your photo'}</h1>
            <p class="lede">${regen
              ? 'Only you are sent to the image model. The room and anyone else in the shot are removed on your device first. This takes up to a minute.'
              : 'This takes a few seconds and happens on your device.'}</p>
            <ul class="ptasks" id="ptasks">${tasks.map(([id, label]) => `<li class="ptask" data-id="${id}" data-state="todo"><span class="check-state"></span>${label}</li>`).join('')}</ul>
            <div id="proc-error" hidden style="margin-top:20px"></div>
          </div>
        </div>
      </section>`));
    const shot = this.root.querySelector('#shot');
    shot.append(coverCopy(source, 400, 500));

    const mark = async (id) => {
      let seen = false;
      this.root.querySelectorAll('.ptask').forEach((li) => {
        if (li.dataset.id === id) { li.dataset.state = 'active'; seen = true; } else if (!seen) li.dataset.state = 'done';
      });
      await nextFrame();
    };

    try {
      if (!regen) {
        await this.finishWith(source, null, mark);
        return;
      }
      // Cut the person out first, so only they are uploaded.
      const prep0 = await prepare(source, 'headshoulders', mark);
      const cutout = cutoutOnGrey(prep0);
      shot.replaceChildren(coverCopy(cutout, 400, 500));
      await mark('regen');
      const result = await regenerate(cutout, this.policy, maskCanvas(prep0.masks.keep, prep0.W, prep0.H), prep0.clothing);
      this.setSession({
        variants: result.images,
        regenInfo: { provider: result.provider, model: result.model, mock: result.mock },
        compareWith: prep0.original,
      });
      this.showPick();
    } catch (err) {
      console.error(err);
      this.showProcessError(err, regen);
    }
  }

  showProcessError(err, regen) {
    const box = this.root.querySelector('#proc-error');
    if (!box) return;
    box.hidden = false;
    const noFace = err?.message === 'no-face';
    const title = noFace ? 'We couldn’t find a face.' : regen ? 'The studio photo couldn’t be generated.' : 'Something went wrong while processing.';
    const body = noFace ? 'Center your face in the oval and make sure it is well lit.'
      : regen ? esc(err?.message || 'The image model did not respond.') + ' You can try again or continue with your own photo.'
      : 'Check your connection (the face models load from the web) and try again.';
    box.innerHTML = `<div class="alert alert--warning">${icon('face')}<div><b>${title}</b> ${body}</div></div>
      <div class="actions" style="margin-top:16px">
        <button class="btn btn--primary" id="retry">${icon('refresh')}Try again</button>
        ${regen && !noFace ? `<button class="btn btn--outlined" id="use-own">Use my own photo</button>` : ''}
        <button class="btn btn--text" id="retake">${icon('camera')}Retake</button>
      </div>`;
    box.querySelector('#retry').addEventListener('click', () => (noFace ? this.showCamera() : this.process(this.session.source)));
    box.querySelector('#retake').addEventListener('click', () => this.showCamera());
    box.querySelector('#use-own')?.addEventListener('click', () => this.chooseOriginal());
  }

  // Runs the on-device pipeline on the chosen photo, then opens retouch.
  async finishWith(photo, regenInfo, mark = async () => {}) {
    const prep = await prepare(photo, this.policy.framing, mark);
    const renderer = new Renderer(prep);
    await renderer.setPolicy(this.policy);
    await mark('ai');
    const ai = await onDeviceProvider.generate(prep, this.policy, regenInfo);
    renderer.auto = ai.auto;
    this.root.querySelectorAll('.ptask').forEach((li) => { li.dataset.state = 'done'; });
    await nextFrame();
    this.setSession({ prep, renderer, ai, params: { ...ai.params }, policyStamp: JSON.stringify(this.policy), chosen: regenInfo ? 'ai' : 'original' });
    this.showRetouch();
  }

  // ---------- 3b. pick a generated option ----------

  showPick() {
    const s = this.session;
    this.setSession({ screen: 'pick' });
    const info = s.regenInfo || {};
    this.root.replaceChildren(el(`
      <section>
        ${stepper(2, true)}
        <div class="pick-head">
          <div>
            <h1>Pick the one that looks most like you</h1>
            <p class="lede">We rebuilt your photo as a studio headshot following your company’s rules. Choose an option, then fine-tune it.</p>
          </div>
          <div class="actions">
            <button class="btn btn--outlined" id="more">${icon('refresh', 16)}New options</button>
            <button class="btn btn--text" id="retake">${icon('camera', 16)}Retake</button>
          </div>
        </div>
        ${info.mock ? `<div class="alert alert--warning" style="margin-bottom:16px">${icon('sparkle')}<div><b>Test mode.</b> No image model is connected to the server, so these options are your photo unchanged. Start the server with GEMINI_API_KEY or OPENAI_API_KEY to generate real studio photos.</div></div>` : ''}
        <div class="pick-grid" id="pick-grid">
          ${s.variants.map((src, i) => `
            <button type="button" class="pick-card" data-variant="${i}">
              <img src="${src}" alt="Generated option ${i + 1}">
              <span class="pick-label"><b>Option ${i + 1}</b><span class="caption">${info.mock ? 'Test mode' : 'AI studio photo'}</span></span>
            </button>`).join('')}
          <button type="button" class="pick-card pick-card--original" data-variant="original">
            <span class="pick-original" id="pick-original"></span>
            <span class="pick-label"><b>My own photo</b><span class="caption">Retouch only, not regenerated</span></span>
          </button>
        </div>
        <p class="privacy" style="margin-top:16px">${icon('shield', 16)}Generated with ${esc(info.model || 'an image model')}. Only you were sent; the room and anyone else were removed first.</p>
      </section>`));

    if (s.compareWith) this.root.querySelector('#pick-original').append(coverCopy(s.compareWith, 400, 500));
    const cards = this.root.querySelectorAll('.pick-card');
    cards.forEach((card) => card.addEventListener('click', async () => {
      cards.forEach((c) => { c.disabled = true; });
      card.classList.add('is-busy');
      const v = card.dataset.variant;
      try {
        if (v === 'original') await this.chooseOriginal();
        else await this.finishWith(await canvasFromDataUrl(s.variants[Number(v)]), s.regenInfo);
      } catch (err) {
        console.error(err);
        cards.forEach((c) => { c.disabled = false; });
        card.classList.remove('is-busy');
        toast(err?.message === 'no-face' ? 'No face found in that option. Pick another one.' : 'That option could not be processed. Pick another one.');
      }
    }));
    this.root.querySelector('#more').addEventListener('click', () => this.process(s.source));
    this.root.querySelector('#retake').addEventListener('click', () => this.showCamera());
  }

  chooseOriginal() {
    return this.finishWith(this.session.source, null);
  }

  // ---------- 4. retouch ----------

  async showRetouch() {
    const s = this.session;
    // The admin may have changed the policy since the photo was processed.
    if (s.policyStamp !== JSON.stringify(this.policy)) {
      await s.renderer.setPolicy(this.policy);
      this.setSession({ policyStamp: JSON.stringify(this.policy) });
    }
    this.setSession({ screen: 'retouch' });
    const p = this.policy;
    const limit = RETOUCH_LIMITS[p.retouchLimit];
    const groups = Object.keys(EDIT_GROUPS).filter((g) => p.edits[g]);

    const sliderHTML = (def) => {
      const f = def.limited ? limit.max : 1;
      const min = Math.round(def.min * f), max = Math.round(def.max * f);
      const v = Math.max(min, Math.min(max, s.params[def.key] ?? 0));
      s.params[def.key] = v;
      return `<div class="slider">
        <label for="sl-${def.key}">${def.label}</label>
        <output id="out-${def.key}" for="sl-${def.key}">${v > 0 && def.min < 0 ? '+' : ''}${v}</output>
        <input type="range" id="sl-${def.key}" data-key="${def.key}" min="${min}" max="${max}" step="1" value="${v}">
      </div>`;
    };

    this.root.replaceChildren(el(`
      <section>
        ${stepper(s.variants ? 3 : 2, !!s.variants)}
        <div class="retouch">
          <div class="preview-col">
            <div class="canvas-wrap" id="view-wrap"><canvas id="view" width="800" height="1000" aria-label="Your retouched photo"></canvas>
              <span class="chip chip--info compare-badge" id="compare-badge" hidden>Original</span></div>
            <div class="preview-tools">
              <button class="btn btn--outlined btn--sm" id="compare">${icon('compare', 16)}Hold to compare</button>
              <div class="avatars" id="avatars" aria-label="Avatar previews"></div>
            </div>
          </div>
          <aside class="card panel">
            <div class="panel-section">
              <div class="panel-head"><h3>${icon('sparkle', 18)}What we did</h3></div>
              <ul class="notes">${s.ai.notes.map((n) => `<li>${icon('check', 14)}${esc(n)}</li>`).join('')}</ul>
              ${s.ai.warnings.map((w) => `<div class="alert alert--warning">${icon('eye')}<div>${esc(w)} <button class="btn btn--text btn--sm" data-retake>Retake</button></div></div>`).join('')}
            </div>
            ${groups.map((g) => `
              <div class="panel-section">
                <div class="panel-head"><h3>${icon(GROUP_ICONS[g], 18)}${EDIT_GROUPS[g]}</h3></div>
                ${SLIDERS.filter((d) => d.group === g).map(sliderHTML).join('')}
              </div>`).join('')}
            <div class="panel-section">
              <p class="limit-note">Your company allows <b>${limit.label.toLowerCase()}</b> retouching. ${esc(limit.help)}</p>
              <div class="actions">
                ${s.variants ? `<button class="btn btn--text" id="back-pick">${icon('arrowLeft', 16)}Other options</button>` : ''}
                <button class="btn btn--text" id="reset">${icon('refresh', 16)}Reset to suggested</button>
                <button class="btn btn--text" id="retake">${icon('camera', 16)}Retake</button>
              </div>
              <button class="btn btn--primary btn--lg" id="continue">Looks good${icon('arrowRight')}</button>
            </div>
          </aside>
        </div>
      </section>`));

    const view = this.root.querySelector('#view');
    const vctx = view.getContext('2d');
    const avatars = this.root.querySelector('#avatars');
    let comparing = false;
    let pending = false;

    const draw = () => {
      pending = false;
      const portrait = s.renderer.render(s.params);
      vctx.drawImage(comparing ? (s.compareWith && s.chosen === 'ai' ? s.compareWith : s.prep.original) : portrait, 0, 0, view.width, view.height);
      const av = composeAvatar(portrait, s.prep, p, s.params, 256);
      avatars.replaceChildren(sizedCopy(av, 96), sizedCopy(av, 48), sizedCopy(av, 32));
    };
    const schedule = () => {
      if (!pending) { pending = true; requestAnimationFrame(draw); }
    };
    draw();

    this.root.querySelectorAll('input[type="range"]').forEach((input) => {
      input.addEventListener('input', () => {
        const v = Number(input.value);
        s.params[input.dataset.key] = v;
        const def = SLIDERS.find((d) => d.key === input.dataset.key);
        this.root.querySelector('#out-' + def.key).textContent = `${v > 0 && def.min < 0 ? '+' : ''}${v}`;
        schedule();
      });
    });

    const cmp = this.root.querySelector('#compare');
    const badge = this.root.querySelector('#compare-badge');
    const setCompare = (on) => { comparing = on; badge.hidden = !on; schedule(); };
    cmp.addEventListener('pointerdown', () => setCompare(true));
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => cmp.addEventListener(ev, () => setCompare(false)));
    cmp.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') setCompare(true); });
    cmp.addEventListener('keyup', () => setCompare(false));

    this.root.querySelector('#reset').addEventListener('click', () => {
      this.setSession({ params: { ...s.ai.params } });
      this.showRetouch();
    });
    this.root.querySelectorAll('#retake, [data-retake]').forEach((b) => b.addEventListener('click', () => this.showCamera()));
    this.root.querySelector('#continue').addEventListener('click', () => this.showDone());
    this.root.querySelector('#back-pick')?.addEventListener('click', () => this.showPick());
  }

  // ---------- 5. done ----------

  showDone() {
    const s = this.session;
    this.setSession({ screen: 'done' });
    const p = this.policy;
    const portrait = s.renderer.render(s.params);
    const avatar = composeAvatar(portrait, s.prep, p, s.params, 512);
    const name = (this.state.name || '').trim() || 'You';
    const submitted = s.submittedId;

    this.root.replaceChildren(el(`
      <section>
        ${stepper((submitted ? 4 : 3) + (s.variants ? 1 : 0), !!s.variants)}
        <div class="done">
          <div class="card card-pad done-hero">
            <h1>${submitted ? (p.requireApproval ? 'Sent for approval' : 'Your photo is saved') : 'Your new photo'}</h1>
            <div id="final-avatar"></div>
            ${rulesHTML(p)}
            <div class="actions" style="justify-content:center">
              <button class="btn btn--primary btn--lg" id="submit" ${submitted ? 'disabled' : ''}>${icon('check')}${p.requireApproval ? 'Submit for approval' : 'Use as my profile photo'}</button>
            </div>
            <div class="actions" style="justify-content:center">
              <button class="btn btn--text btn--sm" id="dl-avatar">${icon('download', 16)}Avatar PNG</button>
              <button class="btn btn--text btn--sm" id="dl-portrait">${icon('download', 16)}Portrait JPG</button>
              <button class="btn btn--text btn--sm" id="edit">${icon('sparkle', 16)}Keep editing</button>
              <button class="btn btn--text btn--sm" id="retake">${icon('camera', 16)}Retake</button>
            </div>
          </div>
          <div class="card">
            <div class="card-pad" style="padding-bottom:8px"><span class="label">How it looks around Deel</span></div>
            <div class="mock-profile" id="mock-profile"><div><b>${esc(name)}</b><span class="caption">Profile header</span></div></div>
            <div class="mock-chat" id="mock-chat"><div><span class="caption">${esc(name)} · 9:41</span><div class="bubble">Hi team, new photo just went up!</div></div></div>
            <div class="mock-row" id="mock-row"><span>${esc(name)}</span><span class="caption" style="margin-left:auto">People list</span></div>
          </div>
        </div>
      </section>`));

    this.root.querySelector('#final-avatar').append(sizedCopy(avatar, 280));
    this.root.querySelector('#mock-profile').prepend(sizedCopy(avatar, 64));
    this.root.querySelector('#mock-chat').prepend(sizedCopy(avatar, 36));
    this.root.querySelector('#mock-row').prepend(sizedCopy(avatar, 28));

    const file = name === 'You' ? 'headshot' : name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    this.root.querySelector('#dl-avatar').addEventListener('click', () => downloadCanvas(avatar, `${file}-avatar.png`));
    this.root.querySelector('#dl-portrait').addEventListener('click', () => downloadCanvas(portrait, `${file}-portrait.jpg`, 'image/jpeg', 0.92));
    this.root.querySelector('#edit').addEventListener('click', () => this.showRetouch());
    this.root.querySelector('#retake').addEventListener('click', () => { this.setSession({ submittedId: null }); this.showCamera(); });
    this.root.querySelector('#submit').addEventListener('click', () => {
      const thumb = composeAvatar(portrait, s.prep, p, s.params, 160);
      const entry = {
        id: Date.now().toString(36),
        name,
        at: new Date().toISOString(),
        status: p.requireApproval ? 'pending' : 'approved',
        policy: p.name,
        avatar: thumb.toDataURL('image/png'),
      };
      this.state.submissions = [entry, ...this.state.submissions].slice(0, 30);
      if (!saveSubmissions(this.state.submissions)) toast('Saved for this session only. Browser storage is full.');
      else toast(p.requireApproval ? 'Sent to your admin for approval' : 'Saved as your profile photo');
      this.setSession({ submittedId: entry.id });
      this.showDone();
    });
  }
}
