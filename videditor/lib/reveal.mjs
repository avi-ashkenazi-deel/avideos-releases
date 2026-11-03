// Show a file in the computer's file manager (Finder on macOS), with the file selected.
// Only ever called with paths Videditor itself wrote (render outputs); never with request input.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function revealFile(file) {
  if (!file || !fs.existsSync(file)) return false;
  const isDir = fs.statSync(file).isDirectory();
  const [cmd, args] = process.platform === 'darwin' ? ['open', isDir ? [file] : ['-R', file]]
    : process.platform === 'win32' ? ['explorer', isDir ? [file] : [`/select,${file}`]]
    : ['xdg-open', [isDir ? file : path.dirname(file)]];
  try { const p = spawn(cmd, args, { detached: true, stdio: 'ignore' }); p.on('error', () => {}); p.unref(); return true; } catch { return false; }
}
