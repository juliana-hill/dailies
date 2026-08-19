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
  // A job actively running under this or another worker must not be reset out from under it — its
  // next checkpoint/fail write would target a doc that no longer exists. Refuse while active; the
  // caller (the API's restart endpoint) is expected to only call this for a failed/idle project.
  async reset(jobId: string) { if (this.active.has(jobId)) throw new Error('PIPELINE_JOB_ACTIVE'); await this.store.reset(jobId); }

  async recover() { if (this.recoveryProjectId) { const job = await this.store.get(this.recoveryProjectId); if (job && !['complete', 'failed', 'waiting_for_service'].includes(job.status)) this.kick(job.jobId); return; } const jobs = await this.store.recoverable(); jobs.forEach((job) => this.kick(job.jobId)); }
  startRecoveryLoop() { void this.recover(); this.recoveryTimer = setInterval(() => void this.recover().catch((error) => console.error('Pipeline recovery scan failed', error)), Math.max(10_000, this.leaseSeconds * 500)); this.recoveryTimer.unref(); }

  kick(jobId: string) {
    if (this.active.has(jobId)) return;
    this.active.add(jobId);
    // `.catch` is load-bearing, not defensive habit. run()'s own error handler reports the failure
    // back to Firestore, so a credential or connectivity fault fails that reporting too — and an
    // unhandled rejection here terminates the entire worker process, taking every other job with it
    // and surfacing to the UI as a bare "fetch failed" from the API's next hop.
    void this.run(jobId)
      .finally(() => this.active.delete(jobId))
      .catch((error) => console.error(JSON.stringify({ level: 'error', message: 'Pipeline job aborted outside its error handler; worker staying up', jobId, error: String((error as any)?.message || error).slice(0, 500) })));
  }

  private async run(jobId: string) {
    const claimed = await this.store.claim(jobId, this.workerId); if (!claimed) return;
    const heartbeat = setInterval(() => void this.store.renew(jobId, this.workerId).catch(() => undefined), Math.max(5_000, this.leaseSeconds * 333)); heartbeat.unref();
    try {
      const input = { ...claimed.input, progress: claimed.progress, executionAttempt: claimed.attempt };
      const report = await runWorkflow(input, async (status, progress, activityMessage) => this.store.checkpoint(jobId, this.workerId, status as ProjectStatus, progress, activityMessage));
      await this.store.complete(jobId, this.workerId, report);
    } catch (error) {
      // Recording the outcome is itself Firestore I/O, and the most common reason a job just failed is
      // that Firestore is unreachable or its credentials are rejected — in which case every call below
      // fails the same way. Log and move on rather than letting the reporting failure mask the original
      // error and escalate into a process exit.
      try {
        const current = await this.store.get(jobId); const recoveryCount = current?.recoveryCount || 0;
        if (isConfigurationWait(error)) await this.store.waitForService(jobId, this.workerId, error);
        else if (isQuotaLimited(error)) {
          console.warn('Vertex AI quota limited; durable pipeline will retry', error);
          await this.store.scheduleRetry(jobId, this.workerId, new Error('Vertex AI audio generation is temporarily at capacity; completed cues are preserved'), Math.min(15 * 60_000, 10_000 * (2 ** Math.min(recoveryCount, 6))));
        }
        else if (isRetryable(error) && recoveryCount < 12) await this.store.scheduleRetry(jobId, this.workerId, error, Math.min(5 * 60_000, 10_000 * (2 ** recoveryCount)));
        else await this.store.fail(jobId, this.workerId, error);
      } catch (reportingError) {
        console.error(JSON.stringify({ level: 'error', message: 'Could not record the pipeline failure; the lease simply expires and the recovery scan picks the job up again', jobId, originalError: String((error as any)?.message || error).slice(0, 500), reportingError: String((reportingError as any)?.message || reportingError).slice(0, 300) }));
      }
    }
    finally { clearInterval(heartbeat); }
  }
}

export function createApp(coordinator: PipelineCoordinator) {
  const app = express(); app.use(express.json({ limit: '1mb' }));
  app.get('/health', (_req, res) => res.json({ ok: true, service: 'dailies-agents', cloudBacked: true, durableJobs: true, agentFramework: 'google-adk-typescript', renderedDraftReview: true, maximumDraftIterations: 3 }));
  app.use((req, res, next) => { const expected = process.env.AGENT_SERVICE_TOKEN; if (!expected) return next(); const actual = req.header('authorization')?.replace(/^Bearer /, '') || ''; const a = Buffer.from(actual), b = Buffer.from(expected); if (a.length !== b.length || !timingSafeEqual(a, b)) return res.status(401).json({ error: 'Unauthorized' }); next(); });
  app.post('/jobs', async (req, res, next) => { try { const input = req.body as JobInput; if (!input.projectId || !input.ownerId || !input.videoUri || !input.durationSeconds) return res.status(400).json({ error: 'Invalid job' }); res.status(202).json(await coordinator.submit(input)); } catch (error) { next(error); } });
  app.get('/jobs/:jobId', async (req, res, next) => { try { const value = await coordinator.get(req.params.jobId); value ? res.json(value) : res.status(404).json({ error: 'Job not found' }); } catch (error) { next(error); } });
  app.get('/jobs/:jobId/events', async (req, res, next) => { try { const value = await coordinator.get(req.params.jobId); value ? res.json({ events: await coordinator.events(req.params.jobId) }) : res.status(404).json({ error: 'Job not found' }); } catch (error) { next(error); } });
  app.delete('/jobs/:jobId', async (req, res, next) => { try { await coordinator.reset(req.params.jobId); res.status(204).end(); } catch (error: any) { if (error?.message === 'PIPELINE_JOB_ACTIVE') return res.status(409).json({ error: 'Job is still active' }); next(error); } });
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
export function isQuotaLimited(error: unknown) { return /(resource_exhausted|quota|rate.?limit|\b429\b)/i.test(String((error as any)?.message || error)); }
function isConfigurationWait(error: unknown) { return /CLICKHOUSE_MCP_(URL|AUTH_TOKEN) is required/i.test(String((error as any)?.message || error)); }
