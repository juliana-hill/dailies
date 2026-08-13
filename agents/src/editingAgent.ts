import { GoogleGenAI } from '@google/genai';
import { editPlanSchema, type AnalysisResult, type EditPlan, type EditorialReview, type Recommendation } from '@dailies/shared';

export async function createEditPlan(analysis: AnalysisResult, recommendation: Recommendation, revision?: { previousPlan: EditPlan; review: EditorialReview }): Promise<EditPlan> {
  const ai = new GoogleGenAI({ vertexai: true, project: required('GCP_PROJECT_ID'), location: process.env.VERTEX_LOCATION || 'global' });
  const prompt = `Create an assertive, viewer-first YouTube edit plan for project ${analysis.projectId}.
The user supplied one rough assembly containing all clips in a single ${analysis.durationSeconds}-second file. Optimize viewer value per second, but derive the final duration entirely from the diagnosed material—never from a fixed source-to-output ratio. Preserve the hook, central story, essential evidence, personality, useful context, and payoff. Surgically remove dead air, mistakes, coughs, sniffles, stutters, false starts, verbal resets, repeated explanations, throat-clearing, mildly unrelated tangents, low-value setup, and routine handling when they do not advance the topic or entertainment. A twenty-minute source may correctly remain long when its footage is valuable, or become five minutes when most of it is redundant or unrelated. Do not preserve filler for conversational continuity, and do not cut valuable material merely to hit a duration target. Do not award clarity alone a high engagement score when visual variety, hook, pacing, or emotional momentum are weak.
Choose remove versus fast_forward from the video's promise and the segment's story or teaching function, not duration alone. In a tutorial/how-to/how-it-is-made video, preserve process steps, sequencing, technique, and explanatory narration at 1x or only mildly accelerate material that remains fully learnable. Remove an action when neither the action nor its outcome advances the story or instruction. Use 2x-8x for moderately repetitive but useful action. For a long non-instructional process or transformation whose before-to-process-to-result progression matters, first choose an earned final duration, then derive the playback rate from the source span. A single-setting passage with little visual change should normally resolve in about 5-10 seconds. It may remain longer only when distinct visual beats, scenery changes, or a setup-to-result mini-arc keep rewarding attention. Choose the slowest acceleration that reaches that earned duration while keeping the action readable: 10x may be sufficient, 20x-50x may suit a longer repetitive stretch, and 100x is a rare ceiling for exceptionally long, visually obvious repetition. Never default every montage to the maximum. Keep short setup/result anchor beats at 1x when they carry meaning; do not use extreme speed merely to avoid deleting useless footage or to race through educational content. Every fast-forward section must mute original audio completely (originalAudioGainDb -96). A montage above 8x must overlap an analysis-grounded music cue with dialoguePolicy replace_source_audio that ends cleanly before normal-speed dialogue resumes. Every retained keep or tighten segment at 1x must preserve original audio at exactly 0 dB; never lower narration to make an effect prominent. Added audio is controlled exclusively by the analysis audio-cue map, so set soundtrackGainDb to -96 on every segment; do not create a continuous music bed. Preserve the source moments covered by the analysis-grounded intro, reveal, and exit visual/audio cues so those required treatments survive into the final timeline. A replace_source_audio cue performs its own precise mute in the renderer, so keep its containing 1x segment at 0 dB rather than muting the whole segment. Treat a cold open and end card as short intentional music-led transitions, not dialogue beds. Request reduceNoise or removeHum when the analysis identifies a persistent white-noise floor or hum, applying cleanup consistently before cuts; otherwise leave both false so the source tone is unchanged. Use visualTreatment for measured exposure/color issues, protecting skin tones. Never invent footage or reorder speech.
Use cut transitions only. Do not request dissolves; the current media renderer prioritizes precise editorial cuts.
Analysis: ${JSON.stringify(analysis.scenes)}
Precise editing signals: ${JSON.stringify(analysis.editingSignals)}
Analysis-grounded audio cues: ${JSON.stringify(analysis.audioCues)}
Original viewer score: ${JSON.stringify(analysis.viewerScore || null)}
Retention recommendation: ${JSON.stringify(recommendation)}
${revision ? `This is a revision of a rendered draft. Previous plan: ${JSON.stringify(revision.previousPlan)}\nRendered-draft review: ${JSON.stringify(revision.review)}\nCorrect every blocking and major issue. Keep successful decisions unless the review identifies a concrete reason to change them.` : 'This is the first draft plan.'}
Return JSON with projectId, rationale, targetDurationSeconds, expectedViewerScore, audioCleanup, visualStrategy, global gain defaults, and chronological segments. Every segment needs id, optional sceneId, sourceStartSeconds, sourceEndSeconds, action (keep, tighten, remove, or fast_forward), playbackRate, per-segment originalAudioGainDb and soundtrackGainDb, transition, visualTreatment, and reason. The renderer does not shorten an interval merely because it is labeled tighten: you must split the timeline and explicitly mark discarded source intervals remove, or increase playbackRate only where accelerated audio is appropriate. The sum of retained durations divided by playbackRate must approximately equal targetDurationSeconds. Removed intervals should remain in the plan with action remove so the report explains them.`;
  const response = await ai.models.generateContent({ model: process.env.GEMINI_MODEL || 'gemini-3-flash-preview', contents: prompt, config: { responseMimeType: 'application/json', responseJsonSchema: editPlanJsonSchema } });
  if (!response.text) throw new Error('Gemini returned no edit plan');
  const plan = editPlanSchema.parse(JSON.parse(response.text));
  if (plan.projectId !== analysis.projectId) throw new Error('Gemini edit-plan project id mismatch');
  validateTimeline(plan, analysis.durationSeconds);
  validateContentRemovals(plan, analysis);
  validateExtremeMontages(plan, analysis);
  return plan;
}

export function validateExtremeMontages(plan: EditPlan, analysis: AnalysisResult) {
  for (const segment of plan.segments.filter((item) => item.action === 'fast_forward' && item.playbackRate > 8)) {
    const overlaps = (start: number, end: number) => Math.min(segment.sourceEndSeconds, end) > Math.max(segment.sourceStartSeconds, start);
    const hasProcessEvidence = analysis.editingSignals.some((signal) => (signal.type === 'montage' || signal.type === 'low_information_action') && overlaps(signal.startSeconds, signal.endSeconds));
    if (!hasProcessEvidence) throw new Error(`Extreme fast-forward segment ${segment.id} lacks diagnosed process-montage evidence`);
    const hasMusic = analysis.audioCues.some((cue) => cue.type === 'music' && cue.dialoguePolicy === 'replace_source_audio' && overlaps(cue.startSeconds, cue.endSeconds));
    if (!hasMusic) throw new Error(`Extreme fast-forward segment ${segment.id} requires an analysis-grounded source-replacing music cue`);
  }
}

export function validateContentRemovals(plan: EditPlan, analysis: AnalysisResult) {
  const removable = new Set(['silence', 'repetition', 'tangent', 'disfluency']);
  for (const signal of analysis.editingSignals.filter((item) => removable.has(item.type) && item.confidence >= .75)) {
    const duration = signal.endSeconds - signal.startSeconds;
    const unchanged = plan.segments.filter((segment) => segment.action !== 'remove' && segment.playbackRate === 1).reduce((total, segment) => total + Math.max(0, Math.min(signal.endSeconds, segment.sourceEndSeconds) - Math.max(signal.startSeconds, segment.sourceStartSeconds)), 0);
    if (unchanged > duration * .5) throw new Error(`Edit plan leaves high-confidence ${signal.type} signal ${signal.id} substantially unchanged`);
  }
}

const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; };
const scoreJsonSchema = { type: 'object', additionalProperties: false, required: ['hook', 'pacing', 'clarity', 'visualQuality', 'audioQuality', 'total', 'rationale'], properties: { hook: { type: 'number', minimum: 0, maximum: 100 }, pacing: { type: 'number', minimum: 0, maximum: 100 }, clarity: { type: 'number', minimum: 0, maximum: 100 }, visualQuality: { type: 'number', minimum: 0, maximum: 100 }, audioQuality: { type: 'number', minimum: 0, maximum: 100 }, total: { type: 'number', minimum: 0, maximum: 100 }, rationale: { type: 'string' } } };
const visualJsonSchema = { type: 'object', additionalProperties: false, required: ['brightness', 'contrast', 'saturation', 'temperature'], properties: { brightness: { type: 'number', minimum: -1, maximum: 1 }, contrast: { type: 'number', minimum: -1, maximum: 1 }, saturation: { type: 'number', minimum: -1, maximum: 1 }, temperature: { type: 'number', minimum: -1, maximum: 1 } } };
const editPlanJsonSchema = { type: 'object', additionalProperties: false, required: ['projectId', 'segments', 'rationale', 'originalAudioGainDb', 'soundtrackGainDb', 'targetDurationSeconds', 'expectedViewerScore', 'audioCleanup', 'visualStrategy'], properties: { projectId: { type: 'string' }, rationale: { type: 'string' }, originalAudioGainDb: { type: 'number', maximum: 0 }, soundtrackGainDb: { type: 'number', maximum: 0 }, targetDurationSeconds: { type: 'number', exclusiveMinimum: 0 }, expectedViewerScore: scoreJsonSchema, audioCleanup: { type: 'object', additionalProperties: false, required: ['reduceNoise', 'removeHum', 'highPassHz', 'targetLufs'], properties: { reduceNoise: { type: 'boolean' }, removeHum: { type: 'boolean' }, highPassHz: { type: 'number', minimum: 40, maximum: 200 }, targetLufs: { type: 'number', minimum: -24, maximum: -8 } } }, visualStrategy: { type: 'string' }, segments: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['id', 'sourceStartSeconds', 'sourceEndSeconds', 'action', 'reason', 'playbackRate', 'originalAudioGainDb', 'soundtrackGainDb', 'transition', 'visualTreatment'], properties: { id: { type: 'string' }, sceneId: { type: 'string' }, sourceStartSeconds: { type: 'number' }, sourceEndSeconds: { type: 'number' }, action: { type: 'string', enum: ['keep', 'tighten', 'remove', 'fast_forward'] }, playbackRate: { type: 'number', minimum: .5, maximum: 100 }, originalAudioGainDb: { type: 'number', minimum: -96, maximum: 6 }, soundtrackGainDb: { type: 'number', minimum: -96, maximum: 6 }, transition: { type: 'string', enum: ['cut'] }, visualTreatment: visualJsonSchema, reason: { type: 'string' } } } } } };

export function validateTimeline(plan: EditPlan, sourceDurationSeconds: number) {
  let previousEnd = 0;
  for (const segment of plan.segments) {
    if (segment.sourceEndSeconds > sourceDurationSeconds + .05) throw new Error(`Edit segment ${segment.id} exceeds source duration`);
    if (segment.sourceStartSeconds < previousEnd - .05) throw new Error(`Edit segment ${segment.id} overlaps the previous segment`);
    if (segment.action === 'fast_forward' && (segment.playbackRate <= 1 || segment.originalAudioGainDb > -90)) throw new Error(`Fast-forward segment ${segment.id} must accelerate and fully mute source audio`);
    if (segment.action !== 'fast_forward' && segment.action !== 'remove' && segment.playbackRate === 1 && segment.originalAudioGainDb !== 0) throw new Error(`Retained dialogue segment ${segment.id} must preserve source audio at 0 dB`);
    previousEnd = segment.sourceEndSeconds;
  }
}
