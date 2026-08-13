import type { Project } from '@dailies/shared'; import { queryRetention, recommendationFromRows } from './retentionAgent.js'; import { runEditorialAgent } from './editorialAgent.js';
export type JobInput = { projectId: string; ownerId: string; videoUri: string; mimeType?: string; outline: string; title: string; durationSeconds: number; creatorHistoryEnabled?: boolean; progress?: Project['progress']; executionAttempt?: number };
export type JobState = { jobId: string; status: string; progress?: Project['progress']; report?: unknown; error?: string };
export async function resolveCreatorRecommendation(ownerId: string, durationSeconds: number, enabled: boolean, query = queryRetention) { return enabled ? query(ownerId, durationSeconds) : recommendationFromRows([], durationSeconds); }
export async function runWorkflow(input: JobInput, update: (state: JobState['status'], progress?: Project['progress'], activityMessage?: string) => void | Promise<void>) {
  return runEditorialAgent(input, update);
}
