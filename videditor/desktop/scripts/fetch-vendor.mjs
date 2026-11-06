#!/usr/bin/env node
// Puts the tools Videditor bundles into desktop/vendor/<arch>/ before packaging:
//   bin/ffmpeg, bin/ffprobe   static builds (ffmpeg-static, ffprobe-static)
//   chrome/…/chrome-headless-shell   Chrome for Testing headless shell (renders)
//   whisper/whisper-cli       built by CI from whisper.cpp (pass --whisper <path> to copy it in)
// and vendor/models/ggml-base.en-q5_1.bin (speech model, shared by both chips).
// Usage: node scripts/fetch-vendor.mjs --arch arm64|x64 [--whisper path/to/whisper-cli]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const arch = arg('--arch', process.arch === 'arm64' ? 'arm64' : 'x64');
const platform = arg('--platform', 'darwin');
const out = path.join(HERE, 'vendor', arch); const bin = path.join(out, 'bin');
fs.mkdirSync(bin, { recursive: true });
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-vendor-'));

console.log(`vendor: ${platform}/${arch} → ${out}`);
// ffmpeg + ffprobe (static, per chip)
run('npm', ['install', '--no-save', '--no-audit', '--no-fund', 'ffmpeg-static@5.3.0', 'ffprobe-static@3.1.0'], { cwd: tmp, env: { ...process.env, npm_config_platform: platform, npm_config_arch: arch } });
fs.copyFileSync(path.join(tmp, 'node_modules', 'ffmpeg-static', platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'), path.join(bin, 'ffmpeg'));
fs.copyFileSync(path.join(tmp, 'node_modules', 'ffprobe-static', 'bin', platform, arch, 'ffprobe'), path.join(bin, 'ffprobe'));
for (const f of ['ffmpeg', 'ffprobe']) fs.chmodSync(path.join(bin, f), 0o755);
console.log('vendor: ffmpeg, ffprobe ✓');
// headless Chrome for rendering
const cftPlatform = platform === 'darwin' ? (arch === 'arm64' ? 'mac_arm' : 'mac') : 'linux';
fs.rmSync(path.join(out, 'chrome'), { recursive: true, force: true });
run('npx', ['--yes', '@puppeteer/browsers@2.10.10', 'install', 'chrome-headless-shell@stable', '--platform', cftPlatform, '--path', path.join(out, 'chrome')], { cwd: tmp });
console.log('vendor: chrome-headless-shell ✓');
// whisper (built separately: see .github/workflows/videditor-mac.yml)
const w = arg('--whisper');
if (w) { fs.mkdirSync(path.join(out, 'whisper'), { recursive: true }); fs.copyFileSync(w, path.join(out, 'whisper', 'whisper-cli')); fs.chmodSync(path.join(out, 'whisper', 'whisper-cli'), 0o755); console.log('vendor: whisper-cli ✓'); }
else console.log('vendor: whisper-cli skipped (pass --whisper <path>); voice notes will not be transcribed in this build');
// speech model (same file for both chips)
const models = path.join(HERE, 'vendor', 'models'); const model = path.join(models, 'ggml-base.en-q5_1.bin');
if (!fs.existsSync(model)) { fs.mkdirSync(models, { recursive: true }); run('curl', ['-fsSL', '-o', model, 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en-q5_1.bin']); }
console.log('vendor: speech model ✓');
fs.rmSync(tmp, { recursive: true, force: true });
