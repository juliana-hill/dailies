import { randomUUID, timingSafeEqual } from 'node:crypto';
import express from 'express';
import type { ProjectStatus } from '@dailies/shared';
import { FirestoreJobStore } from './jobStore.js';
import { runWorkflow, type JobInput } from './orchestrator.js';

export class PipelineCoordinator {
  private readonly workerId = `worker_${randomUUID()}`;
  private readonly active = new Set<string>();
  private recoveryTimer?: NodeJS.Timeout;

  constructor(private readonly store: FirestoreJobStore, private readonly leaseSeconds: number, private readonly recoveryProjectId?: string) {}

  async submit(input: JobInput) { const job = await this.store.submit(input); this.kick(job.jobId); return job; }
  get(jobId: string) { return this.store.get(jobId); }
  events(jobId: string) { return this.store.listEvents(jobId); }

  async recover() { if (this.recoveryProjectId) { const job = await this.store.get(this.recoveryProjectId); if (job && !['complete', 'failed', 'waiting_for_service'].includes(job.status)) this.kick(job.jobId); return; } const jobs = await this.store.recoverable(); jobs.forEach((job) => this.kick(job.jobId)); }
  startRecoveryLoop() { void this.recover(); this.recoveryTimer = setInterval(() => void this.recover().catch((error) => console.error('Pipeline recovery scan failed', error)), Math.max(10_000, this.leaseSeconds * 500)); this.recoveryTimer.unref(); }

  kick(jobId: string) {
    if (this.active.has(jobId)) return;
    this.active.add(jobId);
    void this.run(jobId).finally(() => this.active.delete(jobId));
  }

  private async run(jobId: string) {
    const claimed = await this.store.claim(jobId, this.workerId); if (!claimed) return;
    const heartbeat = setInterval(() => void this.store.renew(jobId, this.workerId).catch(() => undefined), Math.max(5_000, this.leaseSeconds * 333)); heartbeat.unref();
    try {
      const input = { ...claimed.input, progress: claimed.progress, executionAttempt: claimed.attempt };
      const report = await runWorkflow(input, async (status, progress) => this.store.checkpoint(jobId, this.workerId, status as ProjectStatus, progress));
      await this.store.complete(jobId, this.workerId, report);
    } catch (error) {
      const current = await this.store.get(jobId); const recoveryCount = current?.recoveryCount || 0;
      if (isConfigurationWait(error)) await this.store.waitForService(jobId, this.workerId, error);
      else if (isRetryable(error) && recoveryCount < 5) await this.store.scheduleRetry(jobId, this.workerId, error, Math.min(5 * 60_000, 10_000 * (2 ** recoveryCount)));
      else await this.store.fail(jobId, this.workerId, error);
    }
    finally { clearInterval(heartbeat); }
  }
}

export function createApp(coordinator: PipelineCoordinator) {
  const app = express(); app.use(express.json({ limit: '1mb' }));
  app.get('/health', (_req, res) => res.json({ ok: true, service: 'dailies-agents', fixtureMode: false, durableJobs: true }));
  app.use((req, res, next) => { const expected = process.env.AGENT_SERVICE_TOKEN; if (!expected) return next(); const actual = req.header('authorization')?.replace(/^Bearer /, '') || ''; const a = Buffer.from(actual), b = Buffer.from(expected); if (a.length !== b.length || !timingSafeEqual(a, b)) return res.status(401).json({ error: 'Unauthorized' }); next(); });
  app.post('/jobs', async (req, res, next) => { try { const input = req.body as JobInput; if (!input.projectId || !input.ownerId || !input.videoUri || !input.durationSeconds) return res.status(400).json({ error: 'Invalid job' }); res.status(202).json(await coordinator.submit(input)); } catch (error) { next(error); } });
  app.get('/jobs/:jobId', async (req, res, next) => { try { const value = await coordinator.get(req.params.jobId); value ? res.json(value) : res.status(404).json({ error: 'Job not found' }); } catch (error) { next(error); } });
  app.get('/jobs/:jobId/events', async (req, res, next) => { try { const value = await coordinator.get(req.params.jobId); value ? res.json({ events: await coordinator.events(req.params.jobId) }) : res.status(404).json({ error: 'Job not found' }); } catch (error) { next(error); } });
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => { console.error('Agent service request failed', error); res.status(500).json({ error: String(error?.message || error).slice(0, 500) }); });
  return app;
}

if (process.env.NODE_ENV !== 'test') {
  const projectId = required('GCP_PROJECT_ID'); const leaseSeconds = Number(process.env.PIPELINE_LEASE_SECONDS || 60);
  const store = new FirestoreJobStore({ projectId, jobsCollection: process.env.FIRESTORE_JOBS_COLLECTION || 'dailies_pipeline_jobs', projectsCollection: process.env.FIRESTORE_PROJECTS_COLLECTION || 'dailies_projects', leaseSeconds });
  const coordinator = new PipelineCoordinator(store, leaseSeconds, process.env.PIPELINE_RECOVERY_PROJECT_ID); coordinator.startRecoveryLoop();
  createApp(coordinator).listen(Number(process.env.PORT || 8080), () => console.log('Dailies durable agent service listening'));
}

function required(name: string) { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }
export function isRetryable(error: unknown) {
  const message = String((error as any)?.message || error).toLowerCase();
  if (/( is required|mismatch|invalid|removed the entire|no renderable|unauthorized|forbidden|\b40[0134]\b)/.test(message)) return false;
  return /(timeout|timed out|network|fetch failed|econn|socket|quota|rate|\b429\b|\b5\d\d\b|temporar|unavailable|lease)/.test(message);
}
function isConfigurationWait(error: unknown) { return /CLICKHOUSE_MCP_(URL|AUTH_TOKEN) is required/i.test(String((error as any)?.message || error)); }
