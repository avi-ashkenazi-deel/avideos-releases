// Where Videditor keeps things.
//  - App code: this folder (replaced by updates).
//  - Your work: VIDEDITOR_HOME, default ~/Videditor (data/ with renders, notes, db.json; projects/ with
//    compositions). Updates never touch it.
// A developer checkout that already has data/ next to the code keeps using it (nothing moves).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const INSTALL_FILE = path.join(ROOT, '.install.json');
export const INSTALLED = fs.existsSync(INSTALL_FILE);
const legacy = !INSTALLED && fs.existsSync(path.join(ROOT, 'data', 'db.json'));
export const HOME = path.resolve(process.env.VIDEDITOR_HOME || (legacy ? ROOT : path.join(os.homedir(), 'Videditor')));
export const DATA = path.resolve(process.env.VIDEDITOR_DATA || path.join(HOME, 'data'));
export const PROJECTS = path.join(HOME, 'projects');
export const LOGS = path.join(HOME, 'logs');
export const SETTINGS_FILE = path.join(HOME, 'settings.json');
export function readSettings() { try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; } }
export function writeSettings(patch) { const s = { ...readSettings(), ...patch }; fs.mkdirSync(HOME, { recursive: true }); fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2)); return s; }
export function installInfo() { try { return JSON.parse(fs.readFileSync(INSTALL_FILE, 'utf8')); } catch { return null; } }
