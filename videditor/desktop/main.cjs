// Videditor for Mac. The window shows the Videditor web UI served by the bundled server, which this
// process starts (Electron's own Node, ELECTRON_RUN_AS_NODE) with everything it needs inside the app:
// ffmpeg/ffprobe, a headless Chrome for rendering, whisper for transcribing voice notes.
// Your work lives in ~/Videditor; updates replace only the app.
const { app, BrowserWindow, Menu, shell, session, ipcMain, dialog, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const updater = require('./updater.cjs');

const HOME = process.env.VIDEDITOR_HOME || path.join(os.homedir(), 'Videditor');
const LOGS = path.join(HOME, 'logs');
const SETTINGS = path.join(HOME, 'settings.json');
const RES = app.isPackaged ? process.resourcesPath : path.join(__dirname, '.dev-resources');
const SERVER_DIR = app.isPackaged ? path.join(RES, 'server') : path.resolve(__dirname, '..');
const VENDOR = app.isPackaged ? path.join(RES, 'vendor') : path.join(__dirname, 'vendor', process.arch === 'arm64' ? 'arm64' : 'x64');

const readSettings = () => { try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch { return {}; } };
const writeSettings = (patch) => { const s = { ...readSettings(), ...patch }; fs.mkdirSync(HOME, { recursive: true }); fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2)); return s; };
const log = (...a) => { try { fs.mkdirSync(LOGS, { recursive: true }); fs.appendFileSync(path.join(LOGS, 'app.log'), `[${new Date().toISOString()}] ${a.join(' ')}\n`); } catch {} };

if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

let win = null; let server = null; let port = null; let quitting = false;

// A fixed port per user (so the browser storage of the UI, like your name, survives restarts), moved on if taken.
const free = (p) => new Promise((res) => { const s = net.createServer(); s.once('error', () => res(false)); s.listen(p, '127.0.0.1', () => s.close(() => res(true))); });
async function pickPort() { const want = readSettings().port || 47870; for (let p = want; p < want + 50; p++) if (await free(p)) { if (p !== want) writeSettings({ port: p }); return p; } return 0; }
const ping = () => new Promise((res) => { const r = http.get(`http://127.0.0.1:${port}/api/state`, { timeout: 1500 }, (x) => { x.resume(); res(x.statusCode === 200); }); r.on('error', () => res(false)); r.on('timeout', () => { r.destroy(); res(false); }); });

function vendorPath(...p) { const f = path.join(VENDOR, ...p); return fs.existsSync(f) ? f : null; }
function findChrome() {
  const dir = path.join(VENDOR, 'chrome'); if (!fs.existsSync(dir)) return null;
  const stack = [dir]; while (stack.length) { const d = stack.pop(); for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) stack.push(f); else if (e.name === 'chrome-headless-shell') return f; } }
  return null;
}

async function startServer() {
  port = await pickPort();
  fs.mkdirSync(LOGS, { recursive: true });
  const out = fs.openSync(path.join(LOGS, 'server.log'), 'a');
  // Apps opened from Finder get a bare PATH: bundled tools first, then the usual places for claude / codex / git.
  const userBins = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local/bin'), path.join(os.homedir(), '.claude/local'), path.join(os.homedir(), '.npm-global/bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const env = {
    ...process.env, ELECTRON_RUN_AS_NODE: '1',
    PATH: [path.join(VENDOR, 'bin'), ...userBins, ...(process.env.PATH || '').split(':')].filter(Boolean).join(':'),
    VIDEDITOR_PACKAGED: '1', VIDEDITOR_HOME: HOME, VIDEDITOR_PORT: String(port), VIDEDITOR_APP_VERSION: app.getVersion(),
    VIDEDITOR_NO_DEMO: readSettings().demoSeeded ? '1' : '',
  };
  const chrome = findChrome(); if (chrome) env.VIDEDITOR_CHROME = chrome;
  const whisper = vendorPath('whisper', 'whisper-cli'); const model = app.isPackaged ? path.join(RES, 'vendor', 'models', 'ggml-base.en-q5_1.bin') : path.join(__dirname, 'vendor', 'models', 'ggml-base.en-q5_1.bin');
  if (whisper) env.VIDEDITOR_WHISPER = whisper; if (fs.existsSync(model)) env.VIDEDITOR_WHISPER_MODEL = model;
  log(`starting server v${app.getVersion()} on ${port} (chrome ${chrome ? 'bundled' : 'system'}, whisper ${whisper ? 'bundled' : 'none'})`);
  server = spawn(process.execPath, [path.join(SERVER_DIR, 'server.mjs')], { cwd: SERVER_DIR, env, stdio: ['ignore', out, out] });
  server.on('exit', (code) => { log(`server exited ${code}`); server = null; if (!quitting && win) showError(`The Videditor engine stopped (code ${code}).`); });
  for (let i = 0; i < 120; i++) { if (await ping()) { writeSettings({ demoSeeded: true }); return true; } await new Promise((r) => setTimeout(r, 250)); }
  return false;
}

function showError(msg) {
  const logFile = path.join(LOGS, 'server.log');
  win?.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<body style="font:14px -apple-system,system-ui;background:#0e1014;color:#e8eaf0;display:grid;place-items:center;height:100vh;margin:0;-webkit-app-region:drag"><div style="max-width:520px;text-align:center"><h2>Something went wrong</h2><p style="color:#aeb4c2">${msg}</p><p style="color:#7c8395;font-size:12px">Log: ${logFile}</p></div></body>`));
}

function createWindow() {
  const mac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 1024, minHeight: 640, show: false, backgroundColor: '#0e1014', title: 'Videditor',
    ...(mac ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 17 } } : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
  const origin = () => `http://127.0.0.1:${port}`;
  // Only Videditor itself opens inside the window; everything else goes to the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => { if (!url.startsWith(origin()) && !url.startsWith(`http://localhost:${port}`)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(origin()) && !url.startsWith(`http://localhost:${port}`) && !url.startsWith('data:')) { e.preventDefault(); shell.openExternal(url); } });
  return win;
}

function setupSession() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, cb) => cb(['media', 'microphone', 'clipboard-sanitized-write', 'clipboard-read', 'notifications', 'fullscreen'].includes(permission)));
  ses.setPermissionCheckHandler((wc, permission) => ['media', 'microphone', 'clipboard-sanitized-write', 'clipboard-read'].includes(permission));
  // Download buttons save straight to ~/Downloads and show the file in Finder.
  ses.on('will-download', (e, item) => {
    const dir = app.getPath('downloads'); let target = path.join(dir, item.getFilename());
    for (let i = 2; fs.existsSync(target); i++) { const ext = path.extname(item.getFilename()); target = path.join(dir, `${path.basename(item.getFilename(), ext)} ${i}${ext}`); }
    item.setSavePath(target);
    item.once('done', (_e, state) => { if (state === 'completed') shell.showItemInFolder(target); });
  });
}

function buildMenu() {
  const mac = process.platform === 'darwin';
  const template = [
    ...(mac ? [{ label: app.name, submenu: [{ role: 'about' }, { label: 'Check for Updates…', click: () => updater.check({ interactive: true }) }, { type: 'separator' }, { label: 'Open Videos Folder', click: () => shell.openPath(HOME) }, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { role: 'fileMenu' }, { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'Show Logs', click: () => shell.openPath(LOGS) }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Bridge for the UI (window.videditorDesktop, see preload.cjs)
ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, home: HOME, packaged: app.isPackaged }));
ipcMain.handle('app:openHome', () => shell.openPath(HOME));
ipcMain.handle('update:get', () => updater.state());
ipcMain.handle('update:check', () => updater.check({ interactive: false }));
ipcMain.handle('update:install', () => updater.install({ relaunch: true }));
ipcMain.handle('update:setAuto', (_e, on) => { writeSettings({ autoUpdate: !!on }); updater.configure({ auto: !!on }); return updater.state(); });

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';
  setupSession(); buildMenu(); createWindow();
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<body style="background:#0e1014;color:#7c8395;font:13px -apple-system,system-ui;display:grid;place-items:center;height:100vh;margin:0;-webkit-app-region:drag">Starting Videditor…</body>'));
  const ok = await startServer();
  if (!ok) return showError('The Videditor engine did not start.');
  await win.loadURL(`http://127.0.0.1:${port}/`);
  updater.init({ app, log, getWindow: () => win, auto: readSettings().autoUpdate !== false, beforeInstall: stopServer });
});

function stopServer() { quitting = true; try { server?.kill('SIGTERM'); } catch {} }
app.on('before-quit', () => { stopServer(); updater.installOnQuit(); });
app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (!win && port) { createWindow(); win.loadURL(`http://127.0.0.1:${port}/`); } });
