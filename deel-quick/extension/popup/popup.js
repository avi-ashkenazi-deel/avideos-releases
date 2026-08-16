/*
 * Deel Quick — popup controller.
 * Injects the capture pipeline into the active tab, streams phase progress,
 * and puts a ready-to-paste Claude prompt on the clipboard. The clipboard
 * write happens immediately on click (while the popup is focused) because the
 * prompt only needs the page title/URL/intent, not the capture result.
 */

const CAPTURE_FILES = [
  'capture/util.js',
  'capture/dom-snapshot.js',
  'capture/css-inline.js',
  'capture/assets.js',
  'capture/main.js',
];

const PHASE_STEPS = ['waiting', 'snapshot', 'styles', 'fonts', 'assets', 'assemble', 'done'];

const $ = (id) => document.getElementById(id);

const show = (view) => {
  ['form-view', 'progress-view', 'result-view'].forEach((v) => { $(v).hidden = v !== view; });
};

const buildPrompt = (title, url, intent) => {
  const intentLine = intent
    ? `Then: ${intent}`
    : 'Then wait for my first improvement request.';
  return (
    `Use the quick-iterate skill. Attached is a Deel Quick capture of ` +
    `"${title}" (${url}). Sanitize it, ask me about anonymizing any real ` +
    `customer/employee data, publish it as an artifact, and give me the ` +
    `share URL. ${intentLine}`
  );
};

let activeTab = null;

chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  activeTab = tab;
  const url = tab && tab.url ? new URL(tab.url) : null;
  if (!url || !/(^|\.)((deel)|(letsdeel))\.com$/.test(url.hostname)) {
    $('hint').textContent = 'Heads up: this tab is not a Deel page. Capture will still try, but the extension is tuned for app.deel.com.';
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'dq-progress') {
    const idx = PHASE_STEPS.indexOf(msg.phase);
    const pct = idx >= 0 ? Math.round(((idx + 1) / PHASE_STEPS.length) * 100) : 10;
    $('bar-fill').style.width = pct + '%';
    $('phase-label').textContent = `${msg.phase}${msg.detail ? ' — ' + msg.detail : ''}`;
  } else if (msg.type === 'dq-done') {
    renderResult(msg);
  } else if (msg.type === 'dq-error') {
    show('form-view');
    $('hint').textContent = `Capture failed: ${msg.message}. See the page console for details.`;
  }
});

const renderResult = (result) => {
  show('result-view');
  $('result-title').textContent = result.warnings.some((w) => w.includes('OVER'))
    ? 'Captured — too big for an artifact'
    : 'Captured';
  $('result-file').textContent = `${result.filename} — ${fmt(result.totalBytes)} (in your Downloads folder)`;

  const L = result.ledger;
  $('ledger').innerHTML =
    ['dom', 'css', 'fonts', 'images', 'canvas']
      .map((k) => `<tr><td>${k}</td><td>${fmt(L[k])}</td></tr>`)
      .join('') +
    `<tr class="total"><td>total</td><td>${fmt(result.totalBytes)}</td></tr>`;

  $('warnings').innerHTML = result.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('');
};

const fmt = (n) => (n >= 1024 * 1024 ? (n / 1048576).toFixed(1) + 'MB' : Math.round(n / 1024) + 'KB');
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

$('capture').addEventListener('click', async () => {
  if (!activeTab) return;
  const intent = $('intent').value.trim();
  const delayMs = $('delay').checked ? 3000 : 0;
  const downscaleImages = $('downscale').checked;

  try {
    await navigator.clipboard.writeText(buildPrompt(activeTab.title || 'Deel screen', activeTab.url, intent));
  } catch (_) { /* clipboard denied — the metadata comment still carries the intent */ }

  show('progress-view');

  try {
    await chrome.scripting.executeScript({ target: { tabId: activeTab.id }, files: CAPTURE_FILES });
    await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      func: (opts) => { window.__deelQuick.run(opts); },
      args: [{ intent, delayMs, downscaleImages }],
    });
  } catch (err) {
    show('form-view');
    $('hint').textContent = `Could not inject into this tab: ${err.message}`;
  }
});

$('again').addEventListener('click', () => show('form-view'));
$('open-claude').addEventListener('click', () => chrome.tabs.create({ url: 'https://claude.ai/new' }));
