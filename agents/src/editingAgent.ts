import { GoogleGenAI } from '@google/genai';
import { editPlanSchema, type AnalysisResult, type EditPlan, type Recommendation } from '@dailies/shared';

export async function createEditPlan(analysis: AnalysisResult, recommendation: Recommendation): Promise<EditPlan> {
  const ai = new GoogleGenAI({ vertexai: true, project: required('GCP_PROJECT_ID'), location: process.env.VERTEX_LOCATION || 'global' });
  const prompt = `Create an assertive, viewer-first YouTube edit plan for project ${analysis.projectId}.
The user supplied one rough assembly containing all clips in a single ${analysis.durationSeconds}-second file. Optimize viewer value per second. Preserve the hook, key ideas, story continuity, personality, and payoff, but remove dead air, mistakes, repetition, tangents, and low-value setup. A long 30-minute source should become a genuinely pithy cut when the material supports it; do not preserve runtime merely because footage exists. Static software walkthroughs need especially aggressive compression: for this ${analysis.durationSeconds}-second source, target ${Math.round(analysis.durationSeconds * .58)}-${Math.round(analysis.durationSeconds * .72)} seconds unless essential speech continuity makes that impossible. Do not award clarity alone a high engagement score when visual variety, hook, pacing, or emotional momentum are weak.
Use fast_forward for necessary but low-information actions at 2x-8x. Fast-forward sections must mute original audio (originalAudioGainDb -96). Dialogue stays at 1x with original audio prominent. Added audio is controlled exclusively by the analysis audio-cue map, so set soundtrackGainDb to -96 on every segment; do not create a continuous music bed. Use visualTreatment for measured exposure/color issues, protecting skin tones. Never invent footage or reorder speech.
Use cut transitions only. Do not request dissolves; the current media renderer prioritizes precise editorial cuts.
Analysis: ${JSON.stringify(analysis.scenes)}
Precise editing signals: ${JSON.stringify(analysis.editingSignals)}
Analysis-grounded audio cues: ${JSON.stringify(analysis.audioCues)}
Original viewer score: ${JSON.stringify(analysis.viewerScore || null)}
Retention recommendation: ${JSON.stringify(recommendation)}
Return JSON with projectId, rationale, targetDurationSeconds, expectedViewerScore, audioCleanup, visualStrategy, global gain defaults, and chronological segments. Every segment needs id, optional sceneId, sourceStartSeconds, sourceEndSeconds, action (keep, tighten, remove, or fast_forward), playbackRate, per-segment originalAudioGainDb and soundtrackGainDb, transition, visualTreatment, and reason. The renderer does not shorten an interval merely because it is labeled tighten: you must split the timeline and explicitly mark discarded source intervals remove, or increase playbackRate only where accelerated audio is appropriate. The sum of retained durations divided by playbackRate must approximately equal targetDurationSeconds. Removed intervals should remain in the plan with action remove so the report explains them.`;
  const response = await ai.models.generateContent({ model: process.env.GEMINI_MODEL || 'gemini-3-flash-preview', contents: prompt, config: { responseMimeType: 'application/json', responseJsonSchema: editPlanJsonSchema } });
  if (!response.text) throw new Error('Gemini returned no edit plan');
  const plan = editPlanSchema.parse(JSON.parse(response.text));
  if (plan.projectId !== analysis.projectId) throw new Error('Gemini edit-plan project id mismatch');
  validateTimeline(plan, analysis.durationSeconds);
  const renderedDuration = plan.segments.filter((segment) => segment.action !== 'remove').reduce((total, segment) => total + (segment.sourceEndSeconds - segment.sourceStartSeconds) / segment.playbackRate, 0);
  if (analysis.durationSeconds >= 90 && renderedDuration > analysis.durationSeconds * .82) throw new Error(`Edit plan is not assertive enough: ${renderedDuration.toFixed(1)}s retained from ${analysis.durationSeconds.toFixed(1)}s`);
  return plan;
}

const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; };
const scoreJsonSchema = { type: 'object', additionalProperties: false, required: ['hook', 'pacing', 'clarity', 'visualQuality', 'audioQuality', 'total', 'rationale'], properties: { hook: { type: 'number', minimum: 0, maximum: 100 }, pacing: { type: 'number', minimum: 0, maximum: 100 }, clarity: { type: 'number', minimum: 0, maximum: 100 }, visualQuality: { type: 'number', minimum: 0, maximum: 100 }, audioQuality: { type: 'number', minimum: 0, maximum: 100 }, total: { type: 'number', minimum: 0, maximum: 100 }, rationale: { type: 'string' } } };
const visualJsonSchema = { type: 'object', additionalProperties: false, required: ['brightness', 'contrast', 'saturation', 'temperature'], properties: { brightness: { type: 'number', minimum: -1, maximum: 1 }, contrast: { type: 'number', minimum: -1, maximum: 1 }, saturation: { type: 'number', minimum: -1, maximum: 1 }, temperature: { type: 'number', minimum: -1, maximum: 1 } } };
const editPlanJsonSchema = { type: 'object', additionalProperties: false, required: ['projectId', 'segments', 'rationale', 'originalAudioGainDb', 'soundtrackGainDb', 'targetDurationSeconds', 'expectedViewerScore', 'audioCleanup', 'visualStrategy'], properties: { projectId: { type: 'string' }, rationale: { type: 'string' }, originalAudioGainDb: { type: 'number', maximum: 0 }, soundtrackGainDb: { type: 'number', maximum: 0 }, targetDurationSeconds: { type: 'number', exclusiveMinimum: 0 }, expectedViewerScore: scoreJsonSchema, audioCleanup: { type: 'object', additionalProperties: false, required: ['reduceNoise', 'removeHum', 'highPassHz', 'targetLufs'], properties: { reduceNoise: { type: 'boolean' }, removeHum: { type: 'boolean' }, highPassHz: { type: 'number', minimum: 40, maximum: 200 }, targetLufs: { type: 'number', minimum: -24, maximum: -8 } } }, visualStrategy: { type: 'string' }, segments: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['id', 'sourceStartSeconds', 'sourceEndSeconds', 'action', 'reason', 'playbackRate', 'originalAudioGainDb', 'soundtrackGainDb', 'transition', 'visualTreatment'], properties: { id: { type: 'string' }, sceneId: { type: 'string' }, sourceStartSeconds: { type: 'number' }, sourceEndSeconds: { type: 'number' }, action: { type: 'string', enum: ['keep', 'tighten', 'remove', 'fast_forward'] }, playbackRate: { type: 'number', minimum: .5, maximum: 8 }, originalAudioGainDb: { type: 'number', minimum: -96, maximum: 6 }, soundtrackGainDb: { type: 'number', minimum: -96, maximum: 6 }, transition: { type: 'string', enum: ['cut'] }, visualTreatment: visualJsonSchema, reason: { type: 'string' } } } } } };

export function validateTimeline(plan: EditPlan, sourceDurationSeconds: number) {
  let previousEnd = 0;
  for (const segment of plan.segments) {
    if (segment.sourceEndSeconds > sourceDurationSeconds + .05) throw new Error(`Edit segment ${segment.id} exceeds source duration`);
    if (segment.sourceStartSeconds < previousEnd - .05) throw new Error(`Edit segment ${segment.id} overlaps the previous segment`);
    if (segment.action === 'fast_forward' && (segment.playbackRate <= 1 || segment.originalAudioGainDb > -60)) throw new Error(`Fast-forward segment ${segment.id} must accelerate and mute source audio`);
    previousEnd = segment.sourceEndSeconds;
  }
}
