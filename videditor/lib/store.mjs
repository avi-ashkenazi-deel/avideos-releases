// Tiny JSON-file store. One file, one in-memory object, atomic writes.
// Shape: { projects: [], versions: [], feedback: [], seq: 0 }
import fs from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'db.json');
    this.db = { projects: [], versions: [], feedback: [], seq: 0 };
    this.listeners = new Set();
    fs.mkdirSync(dataDir, { recursive: true });
    for (const sub of ['media', 'frames', 'audio', 'refs']) fs.mkdirSync(path.join(dataDir, sub), { recursive: true });
    if (fs.existsSync(this.file)) {
      try { this.db = { ...this.db, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }; }
      catch (e) { console.error('[store] could not read db.json, starting empty:', e.message); }
    }
  }

  id(prefix) {
    this.db.seq += 1;
    return `${prefix}_${Date.now().toString(36)}${this.db.seq.toString(36)}`;
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.db, null, 2));
    fs.renameSync(tmp, this.file);
    for (const fn of this.listeners) { try { fn(); } catch {} }
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  // ---- projects
  project(id) { return this.db.projects.find((p) => p.id === id) || null; }
  projects() { return [...this.db.projects].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')); }
  addProject(data) {
    const now = new Date().toISOString();
    const p = { id: this.id('prj'), name: 'Untitled', hyperframesDir: null, tags: [], createdAt: now, updatedAt: now, ...data };
    this.db.projects.push(p); this.save(); return p;
  }
  updateProject(id, patch) {
    const p = this.project(id); if (!p) return null;
    Object.assign(p, patch, { updatedAt: new Date().toISOString() }); this.save(); return p;
  }
  removeProject(id) {
    this.db.projects = this.db.projects.filter((p) => p.id !== id);
    this.db.versions = this.db.versions.filter((v) => v.projectId !== id);
    this.db.feedback = this.db.feedback.filter((f) => f.projectId !== id);
    this.save();
  }
  touch(projectId) { const p = this.project(projectId); if (p) { p.updatedAt = new Date().toISOString(); } }

  // ---- versions
  version(id) { return this.db.versions.find((v) => v.id === id) || null; }
  versions(projectId) { return this.db.versions.filter((v) => v.projectId === projectId).sort((a, b) => a.number - b.number); }
  latestVersion(projectId) { const vs = this.versions(projectId); return vs[vs.length - 1] || null; }
  addVersion(projectId, data) {
    const number = this.versions(projectId).length + 1;
    const v = { id: this.id('ver'), projectId, number, label: `v${number}`, createdAt: new Date().toISOString(), notes: '', source: 'upload', postedByAgent: false, ...data };
    this.db.versions.push(v); this.touch(projectId); this.save(); return v;
  }
  updateVersion(id, patch) { const v = this.version(id); if (!v) return null; Object.assign(v, patch); this.touch(v.projectId); this.save(); return v; }

  // ---- feedback
  feedbackItem(id) { return this.db.feedback.find((f) => f.id === id) || null; }
  feedback({ projectId, versionId, since, status } = {}) {
    return this.db.feedback.filter((f) =>
      (!projectId || f.projectId === projectId) &&
      (!versionId || f.versionId === versionId) &&
      (!status || f.status === status) &&
      (!since || f.createdAt > since)
    ).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  addFeedback(data) {
    const f = { id: this.id('fb'), createdAt: new Date().toISOString(), author: 'Anonymous', body: '', time: null, timeEnd: null, kind: 'text', status: 'open', tags: [], replyTo: null, postedByAgent: false, transcript: null, visualReferences: [], drawing: null, frames: [], audioUrl: null, refs: [], clipContext: [], ...data };
    this.db.feedback.push(f); this.touch(f.projectId); this.save(); return f;
  }
  updateFeedback(id, patch) { const f = this.feedbackItem(id); if (!f) return null; Object.assign(f, patch, { updatedAt: new Date().toISOString() }); this.touch(f.projectId); this.save(); return f; }
  removeFeedback(id) { this.db.feedback = this.db.feedback.filter((f) => f.id !== id && f.replyTo !== id); this.save(); }

  stats(projectId) {
    const fb = this.feedback({ projectId });
    return { total: fb.length, open: fb.filter((f) => f.status === 'open' && !f.replyTo).length, done: fb.filter((f) => f.status === 'done' && !f.replyTo).length };
  }
}
