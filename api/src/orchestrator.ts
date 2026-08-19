import { GoogleAuth } from 'google-auth-library';
import { completeProjectReportSchema, projectStatusSchema, type CompleteProjectReport, type Project, type ProjectStatus } from '@dailies/shared';
import type { Config } from './config.js';

export interface Orchestrator { run(project: Project, videoUri: string, onStatus?: (status: ProjectStatus, progress?: Project['progress']) => Promise<void>): Promise<CompleteProjectReport>; activity?(projectId: string): Promise<{ events: unknown[] }>; reset?(projectId: string): Promise<void>; }
export class HttpOrchestrator implements Orchestrator {
  constructor(private readonly config: Config) {}
  async activity(projectId: string) { const response = await fetch(`${requiredUrl(this.config.AGENT_SERVICE_URL)}/jobs/${projectId}/events`, { headers: await this.headers() }); if (response.status === 404) return { events: [] }; if (!response.ok) throw new Error(`Agent activity returned ${response.status}`); return response.json() as Promise<{ events: unknown[] }>; }
  // Deletes the agent service's own durable job trail (draftHistory, editorialIteration, render
  // checkpoints, event log) so the next run() submit for this projectId has no prior state to
  // resume from — a genuine restart from the uploaded source, not a continuation of a failed one.
  async reset(projectId: string) { const response = await fetch(`${requiredUrl(this.config.AGENT_SERVICE_URL)}/jobs/${projectId}`, { method: 'DELETE', headers: await this.headers() }); if (!response.ok && response.status !== 404) throw new Error(`Agent service reset returned ${response.status}`); }
  async run(project: Project, videoUri: string, onStatus?: (status: ProjectStatus, progress?: Project['progress']) => Promise<void>) {
    if (!this.config.AGENT_SERVICE_URL) throw new Error('AGENT_SERVICE_URL is not configured');
    const headers = await this.headers();
    let latestProgress = project.progress;
    const submit = async () => { const response = await fetch(`${this.config.AGENT_SERVICE_URL}/jobs`, { method: 'POST', headers, body: JSON.stringify({ projectId: project.projectId, ownerId: project.ownerId, videoUri, mimeType: project.mimeType, outline: project.outline, title: project.title, durationSeconds: project.durationSeconds, creatorHistoryEnabled: project.creatorHistoryEnabled === true, progress: latestProgress }) }); if (!response.ok) throw new Error(`Agent service returned ${response.status}`); return response.json() as Promise<any>; };
    const accepted = await submit();
    if (accepted.analysis) return completeProjectReportSchema.parse(accepted);
    if (!accepted.jobId) throw new Error('Agent service did not return a job id');
    let jobId = accepted.jobId; let recoveries = 0;
    let consecutiveTransportFailures = 0;
    for (let attempt = 0; attempt < 4500; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      let statusResponse: Response;
      try { statusResponse = await fetch(`${this.config.AGENT_SERVICE_URL}/jobs/${jobId}`, { headers }); consecutiveTransportFailures = 0; }
      catch (error) { consecutiveTransportFailures += 1; if (consecutiveTransportFailures <= 90) continue; throw error; }
      if (statusResponse.status === 404 && recoveries < 3) { const recovered = await submit(); if (!recovered.jobId) throw new Error('Recovered agent service did not return a job id'); jobId = recovered.jobId; recoveries += 1; continue; }
      if (!statusResponse.ok) throw new Error(`Agent job status returned ${statusResponse.status}`); const job: any = await statusResponse.json();
      if (job.progress) latestProgress = job.progress;
      const status = projectStatusSchema.safeParse(job.status); if (status.success && onStatus) await onStatus(status.data, latestProgress);
      if (job.status === 'complete') return completeProjectReportSchema.parse(job.report);
      if (job.status === 'failed') throw new Error(job.error || 'Agent job failed');
    }
    throw new Error('Agent job exceeded the 150 minute monitoring timeout');
  }
  private async headers() {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.config.AGENT_SERVICE_TOKEN) headers.authorization = `Bearer ${this.config.AGENT_SERVICE_TOKEN}`;
    else if (this.config.AGENT_SERVICE_AUDIENCE) {
      const client = await new GoogleAuth().getIdTokenClient(this.config.AGENT_SERVICE_AUDIENCE);
      Object.assign(headers, await client.getRequestHeaders());
    }
    return headers;
  }
}
const requiredUrl = (value?: string) => { if (!value) throw new Error('AGENT_SERVICE_URL is not configured'); return value; };
