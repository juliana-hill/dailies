import type { Project } from '@dailies/shared'; import { analyzeVideo } from './analysisAgent.js'; import { createEditPlan } from './editingAgent.js'; import { generateScore } from './scoreAgent.js'; import { queryRetention } from './retentionAgent.js'; import { renderFinalCut } from './renderAgent.js';
export type JobInput = { projectId: string; ownerId: string; videoUri: string; mimeType?: string; outline: string; title: string; durationSeconds: number; progress?: Project['progress']; executionAttempt?: number };
export type JobState = { jobId: string; status: string; progress?: Project['progress']; report?: unknown; error?: string };
export async function runWorkflow(input: JobInput, update: (state: JobState['status'], progress?: Project['progress']) => void | Promise<void>) {
  let checkpoint = input.progress || {};
  await update(checkpoint.analysis ? 'scoring' : 'analyzing', checkpoint);
  const analysis = checkpoint.analysis || await analyzeVideo({ projectId: input.projectId, videoUri: input.videoUri, mimeType: input.mimeType || 'video/mp4', durationSeconds: input.durationSeconds, outline: input.outline });
  checkpoint = { ...checkpoint, analysis }; await update(checkpoint.soundtrack ? 'querying_insights' : 'scoring', checkpoint);
  const soundtrack = checkpoint.soundtrack || await generateScore(analysis, input.ownerId);
  checkpoint = { ...checkpoint, soundtrack }; await update(checkpoint.recommendation ? 'editing' : 'querying_insights', checkpoint);
  const recommendation = checkpoint.recommendation || await queryRetention(input.ownerId, input.durationSeconds);
  checkpoint = { ...checkpoint, recommendation }; await update(checkpoint.editPlan ? 'rendering' : 'editing', checkpoint);
  const editPlan = checkpoint.editPlan || await createEditPlan(analysis, recommendation);
  checkpoint = { ...checkpoint, editPlan }; await update('rendering', checkpoint);
  const finalCut = await renderFinalCut({ projectId: input.projectId, ownerId: input.ownerId, sourceUri: input.videoUri, sourceDurationSeconds: input.durationSeconds, soundtrack, editPlan, executionAttempt: input.executionAttempt, checkpoint: checkpoint.render }, async (render) => { checkpoint = { ...checkpoint, render }; await update('rendering', checkpoint); });
  return { analysis, soundtrack, recommendation, editPlan, finalCut };
}
