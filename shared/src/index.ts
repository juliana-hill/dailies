import { z } from 'zod';

export const MIN_VIDEO_DURATION_SECONDS = 1;
export const MAX_VIDEO_DURATION_SECONDS = 60 * 60;
export const MAX_VIDEO_FILE_BYTES = 100 * 1024 * 1024 * 1024;

export const projectStatusSchema = z.enum([
  'created', 'uploading', 'uploaded', 'analyzing', 'scoring',
  'querying_insights', 'waiting_for_service', 'editing', 'rendering', 'complete', 'failed',
]);
export type ProjectStatus = z.infer<typeof projectStatusSchema>;

export const authenticatedUserSchema = z.object({
  id: z.string().min(1),
  email: z.string().email(),
  fullName: z.string().min(1),
  firstName: z.string().min(1),
  initials: z.string().min(1).max(4),
  plan: z.string().default('Creator studio'),
});
export type AuthenticatedUser = z.infer<typeof authenticatedUserSchema>;

export const projectCreationRequestSchema = z.object({
  title: z.string().trim().min(1).max(160),
  outline: z.string().trim().max(10_000).default(''),
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.enum(['video/mp4', 'video/quicktime', 'video/webm']),
  fileSizeBytes: z.number().int().positive().max(MAX_VIDEO_FILE_BYTES),
  durationSeconds: z.number().positive().max(MAX_VIDEO_DURATION_SECONDS).optional(),
});
export type ProjectCreationRequest = z.infer<typeof projectCreationRequestSchema>;

export const uploadTargetSchema = z.object({
  method: z.enum(['POST', 'PUT']),
  url: z.string(),
  headers: z.record(z.string()),
  maxBytes: z.number().int().positive(),
  finalizeUrl: z.string().optional(),
});
export type UploadTarget = z.infer<typeof uploadTargetSchema>;

export const sceneSchema = z.object({
  id: z.string().min(1), startSeconds: z.number().nonnegative(), endSeconds: z.number().positive(),
  summary: z.string().min(1), transcript: z.string().default(''), mood: z.string().min(1),
  energy: z.number().min(0).max(1), pacingFlags: z.array(z.string()),
}).refine((value) => value.endSeconds > value.startSeconds, { message: 'Scene end must follow start' });
export type Scene = z.infer<typeof sceneSchema>;

export const soundtrackBriefSchema = z.object({
  mood: z.string().min(1), tempo: z.string().min(1), instrumentation: z.string().min(1), prompt: z.string().min(1),
});
export const soundtrackSegmentSchema = z.object({
  id: z.string().min(1), startSeconds: z.number().nonnegative(), endSeconds: z.number().positive(),
  mood: z.string().min(1), energy: z.number().min(0).max(1), label: z.string().min(1),
});
export const analysisResultSchema = z.object({
  projectId: z.string().min(1), durationSeconds: z.number().positive().max(MAX_VIDEO_DURATION_SECONDS),
  scenes: z.array(sceneSchema).min(1), soundtrackBrief: soundtrackBriefSchema,
  soundtrackSegments: z.array(soundtrackSegmentSchema).min(1),
});
export type AnalysisResult = z.infer<typeof analysisResultSchema>;

export const assetSchema = z.object({
  id: z.string().min(1), kind: z.enum(['video', 'soundtrack', 'analysis', 'rendered_video']),
  fileName: z.string().min(1), mimeType: z.string().min(1), sizeBytes: z.number().int().nonnegative().optional(),
  generationModel: z.string().optional(), createdAt: z.string().datetime(),
});
export type Asset = z.infer<typeof assetSchema>;

export const soundtrackResultSchema = z.object({
  asset: assetSchema, durationSeconds: z.number().positive(), model: z.string().min(1), prompt: z.string().min(1),
});
export type SoundtrackResult = z.infer<typeof soundtrackResultSchema>;

export const retentionCurvePointSchema = z.object({
  positionRatio: z.number().min(0).max(1), audienceWatchRatio: z.number().nonnegative(),
});
export const retentionEvidenceSchema = z.object({
  videoId: z.string().min(1), title: z.string().min(1), durationSeconds: z.number().positive(),
  positionRatio: z.number().min(0).max(1), positionSeconds: z.number().nonnegative(),
  dropPercent: z.number().nonnegative(), nearbyEvents: z.array(z.string()),
});
export type RetentionEvidence = z.infer<typeof retentionEvidenceSchema>;

export const recommendationSchema = z.object({
  dropOffPositionRatio: z.number().min(0).max(1), dropOffSeconds: z.number().nonnegative(),
  severityPercent: z.number().nonnegative(), observedEvidence: z.string().min(1), inferredCause: z.string().min(1),
  recommendationText: z.string().min(1), suggestedAction: z.string().min(1),
  confidence: z.enum(['emerging', 'moderate', 'strong']), supportingVideoIds: z.array(z.string()),
  evidence: z.array(retentionEvidenceSchema), retentionCurve: z.array(retentionCurvePointSchema).optional(),
});
export type Recommendation = z.infer<typeof recommendationSchema>;
export const retentionInsightSchema = recommendationSchema;
export type RetentionInsight = Recommendation;

export const editSegmentSchema = z.object({
  id: z.string().min(1), sceneId: z.string().optional(), sourceStartSeconds: z.number().nonnegative(),
  sourceEndSeconds: z.number().positive(), action: z.enum(['keep', 'tighten', 'remove']), reason: z.string().min(1),
}).refine((value) => value.sourceEndSeconds > value.sourceStartSeconds, { message: 'Edit segment end must follow start' });
export const editPlanSchema = z.object({
  projectId: z.string().min(1), segments: z.array(editSegmentSchema).min(1), rationale: z.string().min(1),
  originalAudioGainDb: z.number().max(0).default(0), soundtrackGainDb: z.number().max(0).default(-18),
});
export type EditPlan = z.infer<typeof editPlanSchema>;

export const finalCutResultSchema = z.object({
  asset: assetSchema.refine((asset) => asset.kind === 'rendered_video', { message: 'Final cut must be a rendered video asset' }),
  durationSeconds: z.number().positive(), renderProvider: z.enum(['google-cloud-transcoder', 'fixture']), renderJobId: z.string().min(1),
});
export type FinalCutResult = z.infer<typeof finalCutResultSchema>;

export const renderCheckpointSchema = z.object({
  renderJobId: z.string().min(1), assetId: z.string().min(1), outputUri: z.string().min(1), submittedAt: z.string().datetime(),
});
export type RenderCheckpoint = z.infer<typeof renderCheckpointSchema>;

export const completeProjectReportSchema = z.object({
  analysis: analysisResultSchema, soundtrack: soundtrackResultSchema, recommendation: recommendationSchema,
  editPlan: editPlanSchema.optional(), finalCut: finalCutResultSchema.optional(),
});
export type CompleteProjectReport = z.infer<typeof completeProjectReportSchema>;

export const projectSchema = z.object({
  projectId: z.string().min(1), ownerId: z.string().min(1), title: z.string().min(1), outline: z.string(),
  fileName: z.string().min(1), mimeType: z.string().min(1), fileSizeBytes: z.number().int().positive(),
  durationSeconds: z.number().positive().optional(), status: projectStatusSchema, statusMessage: z.string(),
  fixtureMode: z.boolean(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  uploadAssetId: z.string().optional(), report: completeProjectReportSchema.optional(),
  progress: z.object({ analysis: analysisResultSchema.optional(), soundtrack: soundtrackResultSchema.optional(), recommendation: recommendationSchema.optional(), editPlan: editPlanSchema.optional(), render: renderCheckpointSchema.optional() }).optional(),
  error: z.string().optional(),
});
export type Project = z.infer<typeof projectSchema>;

export const projectCreationResponseSchema = z.object({ project: projectSchema, uploadTarget: uploadTargetSchema });
export const meResponseSchema = z.object({ user: authenticatedUserSchema, fixtureMode: z.boolean(), projects: z.array(projectSchema) });
export const assetUrlResponseSchema = z.object({ url: z.string(), expiresAt: z.string().datetime() });
export const apiErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean(), details: z.array(z.string()).optional() }) });
export type ApiError = z.infer<typeof apiErrorSchema>;
