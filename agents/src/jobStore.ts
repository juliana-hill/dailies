import { randomUUID } from 'node:crypto';
import { FieldValue, Firestore, type DocumentReference, type Transaction } from '@google-cloud/firestore';
import type { CompleteProjectReport, Project, ProjectStatus } from '@dailies/shared';
import type { JobInput, JobState } from './orchestrator.js';

export type DurableJob = JobState & {
  input: JobInput;
  attempt: number;
  recoveryCount?: number;
  nextAttemptAt?: string;
  createdAt: string;
  updatedAt: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
};

export type PipelineEvent = {
  eventId: string;
  jobId: string;
  projectId: string;
  type: 'submitted' | 'retry_submitted' | 'lease_claimed' | 'lease_recovered' | 'checkpoint' | 'retry_scheduled' | 'waiting_for_service' | 'completed' | 'failed';
  stage: string;
  attempt: number;
  workerId?: string;
  message?: string;
  createdAt: string;
};

const statusMessage: Record<ProjectStatus, string> = {
  created: 'Project created', uploading: 'Uploading footage', uploaded: 'Footage uploaded', analyzing: 'Gemini is analyzing the footage',
  scoring: 'Gemini is directing the consolidated soundtrack', querying_insights: 'Querying creator retention through ClickHouse MCP', editing: 'Building the enhanced edit timeline',
  rendering: 'Rendering the enhanced final cut', waiting_for_service: 'Waiting for ClickHouse MCP configuration', complete: 'Final cut and report ready', failed: 'Processing failed',
};
const activeStatuses = ['queued', 'analyzing', 'scoring', 'querying_insights', 'editing', 'rendering'];

export class FirestoreJobStore {
  private readonly firestore: Firestore;
  private readonly jobs;
  private readonly projects;
  private readonly leaseMilliseconds: number;

  constructor(options: { projectId: string; jobsCollection: string; projectsCollection: string; leaseSeconds: number }) {
    this.firestore = new Firestore({ projectId: options.projectId, ignoreUndefinedProperties: true });
    this.jobs = this.firestore.collection(options.jobsCollection);
    this.projects = this.firestore.collection(options.projectsCollection);
    this.leaseMilliseconds = options.leaseSeconds * 1000;
  }

  async submit(input: JobInput): Promise<DurableJob> {
    const jobId = input.projectId;
    const reference = this.jobs.doc(jobId);
    return this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      const now = new Date().toISOString();
      const current = snapshot.exists ? snapshot.data() as DurableJob : undefined;
      if (current?.status === 'complete') return current;
      if (current && activeStatuses.includes(current.status)) return current;
      const attempt = (current?.attempt || 0) + 1;
      const progress = current?.status === 'failed' && current.progress ? withoutRender(current.progress) : current?.progress || input.progress;
      const next: DurableJob = { jobId, input: { ...input, progress }, status: 'queued', progress, attempt, recoveryCount: 0, createdAt: current?.createdAt || now, updatedAt: now };
      transaction.set(reference, next);
      this.appendEvent(transaction, reference, next, current ? 'retry_submitted' : 'submitted', 'queued', undefined, current ? 'Retry requested from latest durable checkpoint' : 'Pipeline submitted');
      return next;
    });
  }

  async get(jobId: string): Promise<DurableJob | undefined> {
    const snapshot = await this.jobs.doc(jobId).get();
    return snapshot.exists ? snapshot.data() as DurableJob : undefined;
  }

  // "Start over" needs a genuinely blank slate, not the failed-status resume path submit() takes
  // (which deliberately keeps draftHistory/editorialIteration/analysis and only drops the render
  // checkpoint). Deleting the job doc and its event trail outright means the next submit() for this
  // same projectId has no `current` to inherit from, so it starts every stage — diagnosis, plan,
  // assets, render — from the uploaded source instead of resuming stale editorial state.
  async reset(jobId: string): Promise<void> {
    const reference = this.jobs.doc(jobId);
    const events = await reference.collection('events').listDocuments();
    const batch = this.firestore.batch();
    events.forEach((doc) => batch.delete(doc));
    batch.delete(reference);
    await batch.commit();
  }

  async listEvents(jobId: string, limit = 200): Promise<PipelineEvent[]> {
    const snapshot = await this.jobs.doc(jobId).collection('events').orderBy('createdAt', 'desc').limit(limit).get();
    return snapshot.docs.map((doc) => doc.data() as PipelineEvent).reverse();
  }

  async recoverable(): Promise<DurableJob[]> {
    const snapshot = await this.jobs.where('status', 'in', activeStatuses).get();
    return snapshot.docs.map((doc) => doc.data() as DurableJob);
  }

  async claim(jobId: string, workerId: string): Promise<DurableJob | undefined> {
    const reference = this.jobs.doc(jobId);
    return this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference); if (!snapshot.exists) return undefined;
      const current = snapshot.data() as DurableJob; if (!activeStatuses.includes(current.status)) return undefined;
      const nowMs = Date.now(); const expired = !current.leaseExpiresAt || Date.parse(current.leaseExpiresAt) <= nowMs;
      if (current.nextAttemptAt && Date.parse(current.nextAttemptAt) > nowMs) return undefined;
      if (!expired && current.leaseOwner !== workerId) return undefined;
      const now = new Date(nowMs).toISOString();
      const next = { ...current, leaseOwner: workerId, leaseExpiresAt: new Date(nowMs + this.leaseMilliseconds).toISOString(), nextAttemptAt: undefined, updatedAt: now };
      transaction.set(reference, next);
      this.appendEvent(transaction, reference, next, current.leaseOwner && current.leaseOwner !== workerId ? 'lease_recovered' : 'lease_claimed', current.status, workerId, expired && current.leaseOwner ? 'Expired worker lease recovered' : 'Worker lease acquired');
      return next;
    });
  }

  async checkpoint(jobId: string, workerId: string, status: ProjectStatus, progress: Project['progress'], activityMessage?: string): Promise<void> {
    const reference = this.jobs.doc(jobId); const projectReference = this.projects.doc(jobId);
    await this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference); if (!snapshot.exists) throw new Error('PIPELINE_JOB_NOT_FOUND');
      const current = snapshot.data() as DurableJob; this.assertLease(current, workerId);
      const nowMs = Date.now(); const now = new Date(nowMs).toISOString();
      const next = { ...current, status, progress, input: { ...current.input, progress }, leaseExpiresAt: new Date(nowMs + this.leaseMilliseconds).toISOString(), updatedAt: now };
      transaction.set(reference, next);
      transaction.set(projectReference, { status, statusMessage: statusMessage[status], progress, error: FieldValue.delete(), updatedAt: now }, { merge: true });
      this.appendEvent(transaction, reference, next, 'checkpoint', status, workerId, activityMessage?.slice(0, 500) || checkpointSummary(progress));
    });
  }

  async renew(jobId: string, workerId: string): Promise<void> {
    const reference = this.jobs.doc(jobId);
    await this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference); if (!snapshot.exists) throw new Error('PIPELINE_JOB_NOT_FOUND');
      const current = snapshot.data() as DurableJob; if (current.leaseOwner !== workerId) throw new Error('PIPELINE_LEASE_LOST');
      const nowMs = Date.now(); transaction.update(reference, { leaseExpiresAt: new Date(nowMs + this.leaseMilliseconds).toISOString(), updatedAt: new Date(nowMs).toISOString() });
    });
  }

  async complete(jobId: string, workerId: string, report: CompleteProjectReport): Promise<void> {
    const reference = this.jobs.doc(jobId); const projectReference = this.projects.doc(jobId);
    await this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference); if (!snapshot.exists) throw new Error('PIPELINE_JOB_NOT_FOUND');
      const current = snapshot.data() as DurableJob; this.assertLease(current, workerId);
      const now = new Date().toISOString(); const next = { ...current, status: 'complete', report, error: undefined, leaseOwner: undefined, leaseExpiresAt: undefined, updatedAt: now };
      transaction.set(reference, next);
      transaction.set(projectReference, { status: 'complete', statusMessage: statusMessage.complete, report, progress: current.progress, error: FieldValue.delete(), updatedAt: now }, { merge: true });
      this.appendEvent(transaction, reference, next, 'completed', 'complete', workerId, 'Pipeline completed and final cut recorded');
    });
  }

  async fail(jobId: string, workerId: string, error: unknown): Promise<void> {
    const reference = this.jobs.doc(jobId); const projectReference = this.projects.doc(jobId);
    await this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference); if (!snapshot.exists) return;
      const current = snapshot.data() as DurableJob; if (current.leaseOwner !== workerId) return;
      // Slice from the tail, not the head: a long message (e.g. ffmpeg's diagnostic, which is itself
      // already trimmed to its last stderr lines) puts the actual terminal error at the end — front-
      // truncating discards exactly the part that explains the failure and keeps only leading banner
      // noise. Short messages are unaffected either way.
      const message = String((error as any)?.message || error || 'Unknown pipeline failure').slice(-500); const now = new Date().toISOString();
      const next = { ...current, status: 'failed', error: message, leaseOwner: undefined, leaseExpiresAt: undefined, updatedAt: now };
      transaction.set(reference, next);
      transaction.set(projectReference, { status: 'failed', statusMessage: statusMessage.failed, progress: current.progress, error: message, updatedAt: now }, { merge: true });
      this.appendEvent(transaction, reference, next, 'failed', 'failed', workerId, message);
    });
  }

  async scheduleRetry(jobId: string, workerId: string, error: unknown, delayMilliseconds: number): Promise<void> {
    const reference = this.jobs.doc(jobId);
    await this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference); if (!snapshot.exists) return;
      const current = snapshot.data() as DurableJob; if (current.leaseOwner !== workerId) return;
      const message = String((error as any)?.message || error || 'Transient pipeline failure').slice(-500); const nowMs = Date.now(); const now = new Date(nowMs).toISOString();
      const next = { ...current, status: 'queued', error: message, recoveryCount: (current.recoveryCount || 0) + 1, nextAttemptAt: new Date(nowMs + delayMilliseconds).toISOString(), leaseOwner: undefined, leaseExpiresAt: undefined, updatedAt: now };
      transaction.set(reference, next);
      this.appendEvent(transaction, reference, next, 'retry_scheduled', 'queued', workerId, `${message}; retry in ${Math.ceil(delayMilliseconds / 1000)} seconds`);
    });
  }

  async waitForService(jobId: string, workerId: string, error: unknown): Promise<void> {
    const reference = this.jobs.doc(jobId); const projectReference = this.projects.doc(jobId);
    await this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference); if (!snapshot.exists) return;
      const current = snapshot.data() as DurableJob; if (current.leaseOwner !== workerId) return;
      const message = String((error as any)?.message || error || 'Required service is not configured').slice(-500); const now = new Date().toISOString();
      const next = { ...current, status: 'waiting_for_service', error: message, nextAttemptAt: undefined, leaseOwner: undefined, leaseExpiresAt: undefined, updatedAt: now };
      transaction.set(reference, next);
      transaction.set(projectReference, { status: 'waiting_for_service', statusMessage: statusMessage.waiting_for_service, progress: current.progress, error: message, updatedAt: now }, { merge: true });
      this.appendEvent(transaction, reference, next, 'waiting_for_service', 'waiting_for_service', workerId, message);
    });
  }

  private assertLease(job: DurableJob, workerId: string) {
    if (job.leaseOwner !== workerId || !job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= Date.now()) throw new Error('PIPELINE_LEASE_LOST');
  }

  private appendEvent(transaction: Transaction, jobReference: DocumentReference, job: DurableJob, type: PipelineEvent['type'], stage: string, workerId?: string, message?: string) {
    const eventId = randomUUID(); const event: PipelineEvent = { eventId, jobId: job.jobId, projectId: job.input.projectId, type, stage, attempt: job.attempt, workerId, message, createdAt: new Date().toISOString() };
    transaction.set(jobReference.collection('events').doc(eventId), event);
  }
}

function checkpointSummary(progress: Project['progress']) {
  if (!progress) return 'Checkpoint recorded';
  const durable = ['analysis', 'soundtrackDraft', 'soundtrack', 'recommendation', 'editPlan', 'render', 'finalCut', 'editorialReview'].filter((key) => Boolean((progress as any)[key]));
  const iteration = progress.editorialIteration ? `draft ${progress.editorialIteration}` : '';
  const decision = progress.editorialReview ? `review ${progress.editorialReview.decision}` : '';
  return `Checkpoint recorded: ${[...durable, iteration, decision].filter(Boolean).join(', ') || 'stage start'}`;
}
function withoutRender(progress: NonNullable<Project['progress']>): Project['progress'] {
  if (progress.finalCut && progress.editorialReview?.decision !== 'revise') { const { render: _render, ...reviewable } = progress; return reviewable; }
  if (progress.editorialReview?.decision === 'revise') { const { render: _render, finalCut: _finalCut, editorialIteration: _iteration, ...revisable } = progress; return { ...revisable, editorialIteration: 0 }; }
  const { render: _render, ...reusable } = progress; return reusable;
}
