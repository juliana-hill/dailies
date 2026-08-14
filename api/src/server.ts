import { randomUUID } from 'node:crypto';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { MAX_VIDEO_DURATION_SECONDS, MAX_VIDEO_FILE_BYTES, MIN_VIDEO_DURATION_SECONDS, projectCreationRequestSchema, projectSchema, type Asset, type Project } from '@dailies/shared';
import { loadConfig, type Config } from './config.js';
import { authMiddleware, requireAuth } from './auth.js';
import { FirestoreProjectRepository, type ProjectRepository } from './repository.js';
import { GcsAssetStorage, type AssetStorage } from './storage.js';
import { HttpOrchestrator, type Orchestrator } from './orchestrator.js';
import { createYouTubeConnections, type YouTubeConnections } from './youtubeConnections.js';

type Dependencies = { config: Config; repository: ProjectRepository; storage: AssetStorage; orchestrator: Orchestrator; youtube?: YouTubeConnections };
const statusMessage: Record<Project['status'], string> = { created: 'Project created', uploading: 'Uploading footage', uploaded: 'Footage uploaded', analyzing: 'Gemini is analyzing the footage', scoring: 'Lyria is generating the score', querying_insights: 'Querying creator retention through ClickHouse MCP', waiting_for_service: 'Waiting for ClickHouse MCP configuration', editing: 'Building the enhanced edit timeline', rendering: 'Rendering the enhanced final cut', complete: 'Final cut and report ready', failed: 'Processing failed' };
const safeError = (message: string) => message.replace(/(token|secret|password|authorization)=?\S*/gi, '$1=[redacted]').slice(0, 500);

export function createApp(deps: Dependencies) {
  const { config, repository, storage, orchestrator } = deps; const youtube = deps.youtube || createYouTubeConnections(config);
  const app = express(); app.use(cors({ origin: config.CORS_ORIGIN, credentials: true })); app.use(authMiddleware());
  app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'dailies-api', cloudBacked: true }));
  app.use(express.json({ limit: '1mb' }));
  app.get('/api/me', requireAuth, async (req, res, next) => { try { res.json({ user: req.user, projects: await repository.listForOwner(req.user!.id) }); } catch (e) { next(e); } });
  app.get('/api/youtube/status', requireAuth, async (req, res, next) => { try { res.json(await youtube.status(req.user!.id)); } catch (e) { next(e); } });
  app.post('/api/youtube/connect', requireAuth, async (req, res, next) => { try { const status = await youtube.status(req.user!.id); if (!status.configured) return res.status(503).json({ error: { code: 'YOUTUBE_OAUTH_NOT_CONFIGURED', message: 'YouTube OAuth is not configured for this deployment.', retryable: false } }); res.json({ url: await youtube.begin(req.user!.id) }); } catch (e) { next(e); } });
  app.get('/api/youtube/callback', async (req, res) => { try { const state = String(req.query.state || ''); const code = String(req.query.code || ''); if (!state || !code) throw new Error('Google did not return the required authorization details'); await youtube.finish(state, code); res.redirect(youtube.successUrl('connected')); } catch (error: any) { console.error(JSON.stringify({ level: 'error', path: req.path, message: safeError(error?.message || 'YouTube authorization failed') })); res.redirect(youtube.successUrl('error')); } });
  app.post('/api/youtube/sync', requireAuth, async (req, res, next) => { try { res.json(await youtube.sync(req.user!.id)); } catch (e) { next(e); } });
  app.delete('/api/youtube/connection', requireAuth, async (req, res, next) => { try { await youtube.disconnect(req.user!.id); res.status(204).end(); } catch (e) { next(e); } });
  app.post('/api/projects', requireAuth, async (req, res, next) => { try {
    const input = projectCreationRequestSchema.parse(req.body); const now = new Date().toISOString(); const projectId = `proj_${randomUUID()}`;
    if (input.durationSeconds !== undefined && input.durationSeconds < MIN_VIDEO_DURATION_SECONDS) return res.status(400).json({ error: { code: 'INVALID_DURATION', message: 'The video must be at least one second long.', retryable: true } });
    const uploadAssetId = `asset_${randomUUID()}`;
    const project = projectSchema.parse({ projectId, ownerId: req.user!.id, ...input, uploadAssetId, status: 'created', statusMessage: statusMessage.created, createdAt: now, updatedAt: now });
    await repository.create(project);
    const path = `${project.ownerId}/${project.projectId}/${uploadAssetId}/${project.fileName}`; const signed = await storage.signedWriteUrl(path, input.mimeType);
    res.status(201).json({ project, uploadTarget: { method: 'PUT', url: signed.url, headers: { 'content-type': input.mimeType }, maxBytes: MAX_VIDEO_FILE_BYTES, finalizeUrl: `/api/projects/${projectId}/upload` } });
  } catch (e) { next(e); } });
  app.post('/api/projects/:projectId/upload', requireAuth, express.raw({ type: ['video/mp4', 'video/quicktime', 'video/webm'], limit: MAX_VIDEO_FILE_BYTES }), async (req, res, next) => { try {
    const project = await ownedProject(req, repository);
    const duration = Number(req.header('x-video-duration-seconds') || project.durationSeconds); if (!Number.isFinite(duration) || duration < MIN_VIDEO_DURATION_SECONDS || duration > MAX_VIDEO_DURATION_SECONDS) return res.status(400).json({ error: { code: 'INVALID_DURATION', message: 'A valid video duration from one second through 60 minutes is required.', retryable: true } });
    await repository.update(project.projectId, (p) => ({ ...p, status: 'uploading', statusMessage: statusMessage.uploading, updatedAt: new Date().toISOString() }));
    const assetId = project.uploadAssetId || `asset_${randomUUID()}`; const path = `${project.ownerId}/${project.projectId}/${assetId}/${project.fileName}`;
    const uploadedBytes = await storage.size(path); if (uploadedBytes !== project.fileSizeBytes) return res.status(400).json({ error: { code: 'SIZE_MISMATCH', message: 'Uploaded byte count does not match the declared file size.', retryable: true } });
    const updated = await repository.update(project.projectId, (p) => ({ ...p, durationSeconds: duration, uploadAssetId: assetId, status: 'uploaded', statusMessage: statusMessage.uploaded, updatedAt: new Date().toISOString() })); res.json(updated);
  } catch (e) { next(e); } });
  app.post('/api/projects/:projectId/analyze', requireAuth, async (req, res, next) => { try {
    const project = await ownedProject(req, repository); if (project.status === 'complete' || ['analyzing', 'scoring', 'querying_insights', 'waiting_for_service', 'editing', 'rendering'].includes(project.status)) return res.status(202).json(project);
    if (!['uploaded', 'failed'].includes(project.status) || !project.uploadAssetId) return res.status(409).json({ error: { code: 'NOT_UPLOADED', message: 'Upload the project video before starting analysis.', retryable: true } });
    let creatorHistoryEnabled = false; try { creatorHistoryEnabled = (await youtube.status(req.user!.id)).connected; } catch (error: any) { console.warn(JSON.stringify({ level: 'warn', event: 'youtube_status_unavailable', message: safeError(error?.message || 'YouTube status unavailable') })); }
    const started = await repository.update(project.projectId, (p) => ({ ...p, creatorHistoryEnabled, status: 'analyzing', statusMessage: statusMessage.analyzing, error: undefined, updatedAt: new Date().toISOString() }));
    void runWorkflow(started, repository, orchestrator, config).catch(() => undefined); res.status(202).json(started);
  } catch (e) { next(e); } });
  app.get('/api/projects/:projectId', requireAuth, async (req, res, next) => { try { res.json(await ownedProject(req, repository)); } catch (e) { next(e); } });
  app.get('/api/projects/:projectId/activity', requireAuth, async (req, res, next) => { try { const project = await ownedProject(req, repository); res.json(orchestrator.activity ? await orchestrator.activity(project.projectId) : { events: [] }); } catch (e) { next(e); } });
  app.get('/api/projects/:projectId/assets/:assetId', requireAuth, async (req, res, next) => { try {
    const project = await ownedProject(req, repository); const assets: Asset[] = reportAssets(project);
    if (project.uploadAssetId === req.params.assetId) assets.push({ id: project.uploadAssetId, kind: 'video', fileName: project.fileName, mimeType: project.mimeType, createdAt: project.createdAt });
    const asset = assets.find((a) => a.id === req.params.assetId); if (!asset) return res.status(404).json({ error: { code: 'ASSET_NOT_FOUND', message: 'Asset not found.', retryable: false } });
    res.json({ url: `/api/projects/${project.projectId}/assets/${asset.id}/content`, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() });
  } catch (e) { next(e); } });
  app.get('/api/projects/:projectId/assets/:assetId/content', requireAuth, async (req, res, next) => { try {
    const project = await ownedProject(req, repository); const assets: Asset[] = reportAssets(project);
    if (project.uploadAssetId) assets.push({ id: project.uploadAssetId, kind: 'video', fileName: project.fileName, mimeType: project.mimeType, createdAt: project.createdAt });
    const asset = assets.find((item) => item.id === req.params.assetId); if (!asset) return res.status(404).end();
    const path = `${project.ownerId}/${project.projectId}/${asset.id}/${asset.fileName}`; const total = await storage.size(path); const range = req.header('range');
    res.set({ 'Accept-Ranges': 'bytes', 'Content-Type': asset.mimeType, 'Cache-Control': 'private, max-age=0' });
    if (!range) { res.status(200).set('Content-Length', String(total)); (await storage.readStream(path)).pipe(res); return; }
    const match = /^bytes=(\d*)-(\d*)$/.exec(range); if (!match) return res.status(416).set('Content-Range', `bytes */${total}`).end();
    const start = match[1] ? Number(match[1]) : 0; const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= total) return res.status(416).set('Content-Range', `bytes */${total}`).end();
    res.status(206).set({ 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': String(end - start + 1) }); (await storage.readStream(path, { start, end })).pipe(res);
  } catch (e) { next(e); } });
  if (config.NODE_ENV === 'production') {
    const frontendDirectory = process.env.FRONTEND_DIST_DIR || '/app/frontend/dist';
    app.get('/', (_req, res) => res.redirect('/studio/'));
    app.use('/studio', express.static(frontendDirectory));
    app.get('/studio/*', (_req, res) => res.sendFile(path.join(frontendDirectory, 'index.html')));
  }
  app.use((error: any, req: Request, res: Response, _next: NextFunction) => { const validation = error?.issues?.map((issue: any) => `${issue.path.join('.')}: ${issue.message}`); const code = error?.message === 'PROJECT_NOT_FOUND' ? 404 : validation ? 400 : 500; const message = safeError(error?.message || 'Unknown service failure'); console.error(JSON.stringify({ level: 'error', method: req.method, path: req.path, code, message })); res.status(code).json({ error: { code: code === 404 ? 'PROJECT_NOT_FOUND' : validation ? 'INVALID_REQUEST' : 'SERVICE_ERROR', message: code === 500 ? `The service could not complete the request: ${message}` : validation ? `Please check the project details: ${validation.join('; ')}` : message, retryable: code >= 500, ...(validation && { details: validation }) } }); });
  return app;
}

async function ownedProject(req: Request, repository: ProjectRepository) { const value = req.params.projectId; const projectId = Array.isArray(value) ? value[0] : value; const project = await repository.get(projectId); if (!project || project.ownerId !== req.user!.id) throw new Error('PROJECT_NOT_FOUND'); return project; }
function reportAssets(project: Project): Asset[] { return [project.report?.soundtrack.asset, ...((project.report?.soundtrack.cues || []).flatMap((cue) => [cue.asset, cue.visualAsset])), project.report?.finalCut?.asset].filter(Boolean) as Asset[]; }
async function runWorkflow(project: Project, repository: ProjectRepository, orchestrator: Orchestrator, config: Config) {
  try {
    const videoUri = `gs://${config.GCS_BUCKET}/${project.ownerId}/${project.projectId}/${project.uploadAssetId}/${project.fileName}`;
    const report = await orchestrator.run(project, videoUri, async (status, progress) => { if (!['analyzing', 'scoring', 'querying_insights', 'waiting_for_service', 'editing', 'rendering'].includes(status)) return; await repository.update(project.projectId, (p) => ({ ...p, status, statusMessage: statusMessage[status], ...(progress && { progress }), updatedAt: new Date().toISOString() })); });
    await repository.update(project.projectId, (p) => ({ ...p, status: 'complete', statusMessage: statusMessage.complete, report, updatedAt: new Date().toISOString() }));
  } catch (error: any) { await repository.update(project.projectId, (p) => ({ ...p, status: 'failed', statusMessage: statusMessage.failed, error: safeError(error?.message || 'Unknown orchestration failure'), updatedAt: new Date().toISOString() })); }
}

if (process.env.NODE_ENV !== 'test') { const config = loadConfig(); const repository = new FirestoreProjectRepository(config.GCP_PROJECT_ID, config.FIRESTORE_PROJECTS_COLLECTION); const app = createApp({ config, repository, storage: new GcsAssetStorage(config), orchestrator: new HttpOrchestrator(config) }); app.listen(config.PORT, () => console.log(`Dailies API listening on ${config.PORT}`)); }
