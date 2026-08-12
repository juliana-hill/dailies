import { z } from 'zod';

export const projectStatusSchema = z.enum(['idle', 'uploading', 'processing', 'complete', 'failed']);
export type ProjectStatus = z.infer<typeof projectStatusSchema>;

export const projectSchema = z.object({
  projectId: z.string(),
  status: projectStatusSchema,
});
export type Project = z.infer<typeof projectSchema>;

export const sceneSchema = z.object({
  id: z.string(),
  startSeconds: z.number(),
  endSeconds: z.number(),
  summary: z.string(),
  transcript: z.string().optional(),
  mood: z.string(),
  energy: z.number().min(0).max(1),
  pacingFlags: z.array(z.string()),
});
export type Scene = z.infer<typeof sceneSchema>;

export const soundtrackSegmentSchema = z.object({
  id: z.string(),
  startSeconds: z.number(),
  endSeconds: z.number(),
  mood: z.string(),
  energy: z.number().min(0).max(1),
  label: z.string(),
});

export const analysisResultSchema = z.object({
  projectId: z.string(),
  durationSeconds: z.number(),
  scenes: z.array(sceneSchema),
  soundtrackBrief: z.object({
    mood: z.string(),
    tempo: z.string(),
    instrumentation: z.string(),
    prompt: z.string(),
  }),
  soundtrackSegments: z.array(soundtrackSegmentSchema),
});
export type AnalysisResult = z.infer<typeof analysisResultSchema>;

export const retentionEvidenceSchema = z.object({
  videoId: z.string(),
  title: z.string(),
  durationSeconds: z.number(),
  positionRatio: z.number().min(0).max(1),
  positionSeconds: z.number(),
  dropPercent: z.number(),
  nearbyEvents: z.array(z.string()),
});

export const retentionInsightSchema = z.object({
  dropOffPositionRatio: z.number().min(0).max(1),
  dropOffSeconds: z.number(),
  severityPercent: z.number(),
  observedEvidence: z.string(),
  inferredCause: z.string(),
  recommendationText: z.string(),
  suggestedAction: z.string(),
  confidence: z.enum(['emerging', 'moderate', 'strong']),
  supportingVideoIds: z.array(z.string()),
  evidence: z.array(retentionEvidenceSchema),
});
export type RetentionInsight = z.infer<typeof retentionInsightSchema>;
