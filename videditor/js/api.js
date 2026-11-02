async function req(method, url, body, headers = {}) {
  const r = await fetch(url, { method, headers: body && !(body instanceof Blob) ? { 'Content-Type': 'application/json', ...headers } : headers, body: body && !(body instanceof Blob) ? JSON.stringify(body) : body });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error(data?.error || data || r.statusText);
  return data;
}
export const api = {
  state: () => req('GET', '/api/state'),
  project: (id) => req('GET', `/api/projects/${id}`),
  createProject: (b) => req('POST', '/api/projects', b),
  updateProject: (id, b) => req('PATCH', `/api/projects/${id}`, b),
  deleteProject: (id) => req('DELETE', `/api/projects/${id}`),
  detect: (p) => req('GET', `/api/hyperframes/detect?path=${encodeURIComponent(p)}`),
  composition: (id, t) => req('GET', `/api/projects/${id}/composition${t !== undefined ? `?t=${t}` : ''}`),
  files: (id) => req('GET', `/api/projects/${id}/files`),
  file: (id, p) => req('GET', `/api/projects/${id}/files?path=${encodeURIComponent(p)}`),
  prompt: (id, versionId) => req('GET', `/api/projects/${id}/prompt${versionId ? `?versionId=${versionId}` : ''}`),
  version: (id) => req('GET', `/api/versions/${id}`),
  updateVersion: (id, b) => req('PATCH', `/api/versions/${id}`, b),
  render: (id, b) => req('POST', `/api/projects/${id}/render`, b || {}),
  feedback: (params) => req('GET', `/api/feedback?${new URLSearchParams(params)}`),
  feedbackItem: (id) => req('GET', `/api/feedback/${id}`),
  postFeedback: (b) => req('POST', '/api/feedback', b),
  updateFeedback: (id, b) => req('PATCH', `/api/feedback/${id}`, b),
  deleteFeedback: (id) => req('DELETE', `/api/feedback/${id}`),
  /** Upload a video file as a new version, with progress callback 0..1 */
  upload: (projectId, file, notes, onProgress) => new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', `/api/projects/${projectId}/versions`);
    x.setRequestHeader('Content-Type', 'application/octet-stream');
    x.setRequestHeader('X-Filename', encodeURIComponent(file.name));
    x.setRequestHeader('X-Notes', encodeURIComponent(notes || ''));
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    x.onload = () => { try { const d = JSON.parse(x.responseText); if (x.status >= 400) reject(new Error(d.error || x.statusText)); else resolve(d); } catch (e) { reject(e); } };
    x.onerror = () => reject(new Error('Upload failed'));
    x.send(file);
  }),
};
