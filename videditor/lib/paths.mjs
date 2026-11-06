// Where Videditor keeps things.
//  - App code: this folder (inside the Mac app it is read-only and replaced by updates).
//  - Your work: VIDEDITOR_HOME, default ~/Videditor (data/ with renders, notes, db.json; projects/ with
//    compositions). The Mac app always uses it; updates never touch it.
// A developer checkout that already has data/ next to the code keeps using it (nothing moves).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PACKAGED = process.env.VIDEDITOR_PACKAGED === '1'; // set by the Mac app
const legacy = !PACKAGED && !process.env.VIDEDITOR_HOME && fs.existsSync(path.join(ROOT, 'data', 'db.json'));
export const HOME = path.resolve(process.env.VIDEDITOR_HOME || (legacy ? ROOT : path.join(os.homedir(), 'Videditor')));
export const DATA = path.resolve(process.env.VIDEDITOR_DATA || path.join(HOME, 'data'));
export const PROJECTS = path.join(HOME, 'projects');
export const LOGS = path.join(HOME, 'logs');
export const appVersion = () => process.env.VIDEDITOR_APP_VERSION || (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return '0.0.0'; } })();
