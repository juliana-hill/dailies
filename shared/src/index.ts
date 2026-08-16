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

export const viewerScoreSchema = z.object({
  hook: z.number().min(0).max(100), pacing: z.number().min(0).max(100), clarity: z.number().min(0).max(100),
  visualQuality: z.number().min(0).max(100), audioQuality: z.number().min(0).max(100), total: z.number().min(0).max(100),
  rationale: z.string().min(1),
});
export type ViewerScore = z.infer<typeof viewerScoreSchema>;

export const editingSignalSchema = z.object({
  id: z.string().min(1), startSeconds: z.number().nonnegative(), endSeconds: z.number().positive(),
  type: z.enum(['silence', 'repetition', 'tangent', 'disfluency', 'setup', 'low_information_action', 'emphasis', 'visual_issue', 'audio_noise', 'overlay_opportunity', 'joke', 'reveal', 'momentum_shift', 'montage']),
  confidence: z.number().min(0).max(1), detail: z.string().min(1), suggestedAction: z.string().min(1),
}).refine((value) => value.endSeconds > value.startSeconds, { message: 'Editing signal end must follow start' });

export const soundtrackBriefSchema = z.object({
  mood: z.string().min(1), tempo: z.string().min(1), instrumentation: z.string().min(1), prompt: z.string().min(1),
});
export const soundtrackSegmentSchema = z.object({
  id: z.string().min(1), startSeconds: z.number().nonnegative(), endSeconds: z.number().positive(),
  mood: z.string().min(1), energy: z.number().min(0).max(1), label: z.string().min(1),
});
export const editorialAudioCueSchema = z.object({
  id: z.string().min(1), startSeconds: z.number().nonnegative(), endSeconds: z.number().positive(),
  type: z.enum(['music', 'laugh_track', 'pop', 'sting', 'silence']), purpose: z.string().min(1),
  mood: z.string().min(1), energy: z.number().min(0).max(1), gainDb: z.number().min(-96).max(0).default(-18),
  fadeInSeconds: z.number().min(0).max(10).default(.5), fadeOutSeconds: z.number().min(0).max(10).default(.75),
  dialoguePolicy: z.enum(['no_dialogue', 'duck_under_dialogue', 'replace_source_audio']).default('no_dialogue'),
  visualCompanion: z.string().default(''),
  visualMode: z.enum(['sticker', 'full_frame']).optional(),
  // Rule-of-thirds zone for a sticker overlay's resting position. Ignored for full_frame (which
  // always fills the frame). Optional (not .default()) so existing object literals/fixtures built
  // before this field existed stay valid; ffmpegRenderer's stickerPosition falls back to the same
  // top-right corner every sticker used when this is absent.
  position: z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center']).optional(),
  effectStyle: z.enum(['none', 'soft_pop', 'warm_chime', 'celebration_swell', 'comic_bubble']).optional(),
  calloutText: z.string().max(24).optional(),
  generationPrompt: z.string().min(20).optional(),
  visualGenerationPrompt: z.union([z.string().min(20), z.literal('')]).optional(),
}).refine((value) => value.endSeconds > value.startSeconds, { message: 'Editorial audio cue end must follow start' });
export type EditorialAudioCue = z.infer<typeof editorialAudioCueSchema>;
export const analysisResultSchema = z.object({
  projectId: z.string().min(1), durationSeconds: z.number().positive().max(MAX_VIDEO_DURATION_SECONDS),
  scenes: z.array(sceneSchema).min(1), soundtrackBrief: soundtrackBriefSchema,
  soundtrackSegments: z.array(soundtrackSegmentSchema).default([]), audioCues: z.array(editorialAudioCueSchema).default([]), editingSignals: z.array(editingSignalSchema).default([]),
  viewerScore: viewerScoreSchema.optional(),
});
export type AnalysisResult = z.infer<typeof analysisResultSchema>;

export const assetSchema = z.object({
  id: z.string().min(1), kind: z.enum(['video', 'soundtrack', 'overlay', 'analysis', 'rendered_video']),
  fileName: z.string().min(1), mimeType: z.string().min(1), sizeBytes: z.number().int().nonnegative().optional(),
  generationModel: z.string().optional(), createdAt: z.string().datetime(),
});
export type Asset = z.infer<typeof assetSchema>;

export const generatedMusicCueSchema = editorialAudioCueSchema.and(z.object({
  type: z.enum(['music', 'laugh_track', 'pop', 'sting']), asset: assetSchema, visualAsset: assetSchema.optional(),
  durationSeconds: z.number().positive(), prompt: z.string().min(1), visualPrompt: z.string().optional(),
  sourceStartSeconds: z.number().nonnegative().optional(), sourceEndSeconds: z.number().positive().optional(),
})).refine((value) => value.sourceStartSeconds === undefined || value.sourceEndSeconds === undefined || value.sourceEndSeconds > value.sourceStartSeconds, { message: 'Sound reel slice end must follow its start' });
export const soundtrackResultSchema = z.object({
  needed: z.boolean().default(true), rationale: z.string().default('Legacy continuous soundtrack.'), cues: z.array(generatedMusicCueSchema).default([]), model: z.string().min(1),
  asset: assetSchema.optional(), durationSeconds: z.number().positive().optional(), prompt: z.string().optional(),
  provider: z.enum(['lyria', 'treblo']).optional(), providerJobId: z.string().min(1).optional(), compositionBrief: z.string().min(1).optional(),
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
  sourceEndSeconds: z.number().positive(), action: z.enum(['keep', 'tighten', 'remove', 'fast_forward']), reason: z.string().min(1),
  playbackRate: z.number().min(0.5).max(100).default(1), originalAudioGainDb: z.number().min(-96).max(6).default(0),
  soundtrackGainDb: z.number().min(-96).max(6).default(-18), transition: z.enum(['cut', 'dissolve']).default('cut'),
  visualTreatment: z.object({ brightness: z.number().min(-1).max(1).default(0), contrast: z.number().min(-1).max(1).default(0), saturation: z.number().min(-1).max(1).default(0), temperature: z.number().min(-1).max(1).default(0) }).optional(),
}).refine((value) => value.sourceEndSeconds > value.sourceStartSeconds, { message: 'Edit segment end must follow start' });
export const editPlanSchema = z.object({
  projectId: z.string().min(1), segments: z.array(editSegmentSchema).min(1), rationale: z.string().min(1),
  originalAudioGainDb: z.number().max(0).default(0), soundtrackGainDb: z.number().max(0).default(-18),
  targetDurationSeconds: z.number().positive().optional(), expectedViewerScore: viewerScoreSchema.optional(),
  audioCleanup: z.object({ reduceNoise: z.boolean().default(false), removeHum: z.boolean().default(false), highPassHz: z.number().min(40).max(200).default(80), targetLufs: z.number().min(-24).max(-8).default(-14) }).default({}),
  visualStrategy: z.string().default('Balance exposure and color conservatively while protecting skin tones.'),
});
export type EditPlan = z.infer<typeof editPlanSchema>;

export const finalCutResultSchema = z.object({
  asset: assetSchema.refine((asset) => asset.kind === 'rendered_video', { message: 'Final cut must be a rendered video asset' }),
  durationSeconds: z.number().positive(), renderProvider: z.enum(['google-cloud-transcoder', 'ffmpeg-cloud-run']), renderJobId: z.string().min(1),
});
export type FinalCutResult = z.infer<typeof finalCutResultSchema>;

export const editorialReviewSchema = z.object({
  iteration: z.number().int().positive(), decision: z.enum(['pass', 'revise']),
  score: viewerScoreSchema, summary: z.string().min(1),
  issues: z.array(z.object({ category: z.enum(['hook', 'pacing', 'clarity', 'visual', 'audio', 'continuity', 'ending']), startSeconds: z.number().nonnegative(), endSeconds: z.number().positive(), severity: z.enum(['minor', 'major', 'blocking']), diagnosis: z.string().min(1), requiredChange: z.string().min(1) }).refine((value) => value.endSeconds > value.startSeconds, { message: 'Review issue end must follow start' })),
});
export type EditorialReview = z.infer<typeof editorialReviewSchema>;

// One rendered-and-reviewed draft, preserved across revisions so the best of them can still be
// shipped as the final cut if the draft budget runs out before any single draft passes outright.
export const draftHistoryEntrySchema = z.object({
  iteration: z.number().int().positive(), editPlan: editPlanSchema, finalCut: finalCutResultSchema, editorialReview: editorialReviewSchema,
});
export type DraftHistoryEntry = z.infer<typeof draftHistoryEntrySchema>;

export const renderCheckpointSchema = z.object({
  renderJobId: z.string().min(1), assetId: z.string().min(1), outputUri: z.string().min(1), submittedAt: z.string().datetime(),
});
export type RenderCheckpoint = z.infer<typeof renderCheckpointSchema>;

export const completeProjectReportSchema = z.object({
  analysis: analysisResultSchema, soundtrack: soundtrackResultSchema, recommendation: recommendationSchema,
  editPlan: editPlanSchema.optional(), finalCut: finalCutResultSchema.optional(), editorialReview: editorialReviewSchema.optional(),
});
export type CompleteProjectReport = z.infer<typeof completeProjectReportSchema>;

export const projectSchema = z.object({
  projectId: z.string().min(1), ownerId: z.string().min(1), title: z.string().min(1), outline: z.string(),
  fileName: z.string().min(1), mimeType: z.string().min(1), fileSizeBytes: z.number().int().positive(),
  durationSeconds: z.number().positive().optional(), status: projectStatusSchema, statusMessage: z.string(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  uploadAssetId: z.string().optional(), report: completeProjectReportSchema.optional(),
  creatorHistoryEnabled: z.boolean().optional(),
  progress: z.object({ analysis: analysisResultSchema.optional(), soundtrack: soundtrackResultSchema.optional(), soundtrackDraft: soundtrackResultSchema.optional(), recommendation: recommendationSchema.optional(), editPlan: editPlanSchema.optional(), render: renderCheckpointSchema.optional(), finalCut: finalCutResultSchema.optional(), editorialReview: editorialReviewSchema.optional(), editorialIteration: z.number().int().nonnegative().optional(), draftHistory: z.array(draftHistoryEntrySchema).optional(), finalized: z.boolean().optional() }).optional(),
  error: z.string().optional(),
});
export type Project = z.infer<typeof projectSchema>;

export const projectCreationResponseSchema = z.object({ project: projectSchema, uploadTarget: uploadTargetSchema });
export const meResponseSchema = z.object({ user: authenticatedUserSchema, projects: z.array(projectSchema) });
export const assetUrlResponseSchema = z.object({ url: z.string(), expiresAt: z.string().datetime() });
export const apiErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean(), details: z.array(z.string()).optional() }) });
export type ApiError = z.infer<typeof apiErrorSchema>;
