import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { CompleteProjectReport } from '@dailies/shared';
import { createApp } from './server.js';
import { configSchema } from './config.js';
import { MemoryProjectRepository } from './repository.js';
import { MemoryAssetStorage } from './storage.js';

const config = configSchema.parse({ NODE_ENV: 'test', ALLOW_DEV_AUTH: 'true', DAILIES_FIXTURE_MODE: 'true' });
const report = { analysis: { projectId: 'placeholder', durationSeconds: 300, scenes: [{ id: 's1', startSeconds: 0, endSeconds: 300, summary: 'Scene', transcript: '', mood: 'quiet', energy: .3, pacingFlags: [] }], soundtrackBrief: { mood: 'quiet', tempo: '80 BPM', instrumentation: 'piano', prompt: 'instrumental' }, soundtrackSegments: [{ id: 'ss1', startSeconds: 0, endSeconds: 300, mood: 'quiet', energy: .3, label: 'Open' }] }, soundtrack: { asset: { id: 'audio1', kind: 'soundtrack', fileName: 'score.wav', mimeType: 'audio/wav', createdAt: new Date().toISOString() }, durationSeconds: 300, model: 'lyria', prompt: 'instrumental' }, recommendation: { dropOffPositionRatio: .4, dropOffSeconds: 120, severityPercent: 10, observedEvidence: 'Observed', inferredCause: 'Possible', recommendationText: 'Do this', suggestedAction: 'Cut', confidence: 'emerging', supportingVideoIds: [], evidence: [] } } satisfies CompleteProjectReport;
const setup = () => { const repository = new MemoryProjectRepository(); const storage = new MemoryAssetStorage(); let calls = 0; const app = createApp({ config, repository, storage, orchestrator: { run: async (project, _uri, onStatus) => { calls += 1; await onStatus?.('scoring'); await onStatus?.('querying_insights'); return { ...report, analysis: { ...report.analysis, projectId: project.projectId } }; } } }); return { app, repository, getCalls: () => calls }; };
const input = { title: 'Cut', outline: '', fileName: 'cut.mp4', mimeType: 'video/mp4', fileSizeBytes: 4, durationSeconds: 30 };

describe('API', () => {
  it('protects user endpoints', async () => { const app = createApp({ config: { ...config, ALLOW_DEV_AUTH: false }, repository: new MemoryProjectRepository(), storage: new MemoryAssetStorage(), orchestrator: { run: async () => report } }); expect((await request(app).get('/api/me')).status).toBe(401); });
  it('creates, validates upload, and starts analysis idempotently', async () => {
    const { app, getCalls } = setup(); const created = await request(app).post('/api/projects').send(input); expect(created.status).toBe(201); const id = created.body.project.projectId;
    expect((await request(app).post(`/api/projects/${id}/upload`).set('content-type', 'video/mp4').set('x-video-duration-seconds', '30').send(Buffer.from('bad'))).status).toBe(400);
    expect((await request(app).post(`/api/projects/${id}/upload`).set('content-type', 'video/mp4').set('x-video-duration-seconds', '30').send(Buffer.from('good'))).status).toBe(200);
    const assetId = (await request(app).get(`/api/projects/${id}`)).body.uploadAssetId; const asset = await request(app).get(`/api/projects/${id}/assets/${assetId}`); expect(asset.body.url).toContain('/content');
    const range = await request(app).get(asset.body.url).set('range', 'bytes=1-2'); expect(range.status).toBe(206); expect(range.headers['content-range']).toBe('bytes 1-2/4'); expect(range.body.toString()).toBe('oo');
    expect((await request(app).post(`/api/projects/${id}/analyze`)).status).toBe(202); expect((await request(app).post(`/api/projects/${id}/analyze`)).status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 20)); expect(getCalls()).toBe(1); expect((await request(app).get(`/api/projects/${id}`)).body.status).toBe('complete');
  });
  it('retries a failed project without requiring another upload', async () => {
    const { app, repository, getCalls } = setup(); const created = await request(app).post('/api/projects').send(input); const id = created.body.project.projectId;
    await request(app).post(`/api/projects/${id}/upload`).set('content-type', 'video/mp4').set('x-video-duration-seconds', '30').send(Buffer.from('good'));
    await repository.update(id, (project) => ({ ...project, status: 'failed', statusMessage: 'Processing failed', error: 'Temporary service failure' }));
    const retried = await request(app).post(`/api/projects/${id}/analyze`); expect(retried.status).toBe(202); expect(retried.body.status).toBe('analyzing'); expect(retried.body.error).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 20)); expect(getCalls()).toBe(1); expect((await request(app).get(`/api/projects/${id}`)).body.status).toBe('complete');
  });
});
