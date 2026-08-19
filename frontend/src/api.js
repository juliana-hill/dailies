const base = import.meta.env.VITE_API_BASE_URL || '';
export class ApiClientError extends Error { constructor(message, code, retryable = false) { super(message); this.code = code; this.retryable = retryable; } }
async function call(path, options = {}) {
  const response = await fetch(`${base}${path}`, { credentials: 'include', ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiClientError(payload?.error?.message || `Request failed (${response.status})`, payload?.error?.code || 'HTTP_ERROR', Boolean(payload?.error?.retryable));
  return payload;
}
export const api = {
  me: () => call('/api/me'),
  youtubeStatus: () => call('/api/youtube/status'),
  youtubeConnect: () => call('/api/youtube/connect', { method: 'POST' }),
  youtubeSync: () => call('/api/youtube/sync', { method: 'POST' }),
  youtubeDisconnect: () => call('/api/youtube/connection', { method: 'DELETE' }),
  createProject: (input) => call('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }),
  upload: async (target, file, duration) => {
    if (target.method === 'POST') return call(target.url, { method: 'POST', headers: { ...target.headers, 'content-type': file.type, 'x-video-duration-seconds': String(duration) }, body: file });
    const response = await fetch(target.url, { method: 'PUT', headers: { ...target.headers, 'content-type': file.type }, body: file });
    if (!response.ok) throw new ApiClientError(`Cloud Storage upload failed (${response.status})`, 'UPLOAD_FAILED', true);
    return call(target.finalizeUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-video-duration-seconds': String(duration) }, body: '{}' });
  },
  analyze: (id) => call(`/api/projects/${id}/analyze`, { method: 'POST' }),
  restart: (id) => call(`/api/projects/${id}/restart`, { method: 'POST' }),
  project: (id) => call(`/api/projects/${id}`),
  activity: (id) => call(`/api/projects/${id}/activity`),
  assetUrl: async (projectId, assetId) => { const value = await call(`/api/projects/${projectId}/assets/${assetId}`); return { ...value, url: value.url.startsWith('/') ? `${base}${value.url}` : value.url }; },
};
export const readVideoDuration = (file) => new Promise((resolve, reject) => {
  const video = document.createElement('video'); const url = URL.createObjectURL(file); video.preload = 'metadata';
  video.onloadedmetadata = () => { URL.revokeObjectURL(url); Number.isFinite(video.duration) ? resolve(video.duration) : reject(new Error('Could not read video duration.')); };
  video.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read video metadata.')); }; video.src = url;
});
