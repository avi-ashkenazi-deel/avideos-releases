import type { FontProject } from '../core/glyph';
import { parseProject, serializeProject } from './schema';

const KEY = 'fontlab:project:v1';

export function saveLocal(p: FontProject): void {
  try { localStorage.setItem(KEY, serializeProject(p)); } catch { /* quota / private mode */ }
}

export function loadLocal(): FontProject | null {
  try {
    const s = localStorage.getItem(KEY);
    return s ? parseProject(JSON.parse(s)) : null;
  } catch { return null; }
}

export function clearLocal(): void {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

export function downloadBlob(data: BlobPart, filename: string, type = 'application/octet-stream'): void {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.style.display = 'none';
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}

export function downloadProject(p: FontProject): void {
  downloadBlob(serializeProject(p), `${slug(p.name)}.fontlab.json`, 'application/json');
}

export async function readProjectFile(file: Blob): Promise<FontProject> {
  return parseProject(JSON.parse(await file.text()));
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'font';
}
