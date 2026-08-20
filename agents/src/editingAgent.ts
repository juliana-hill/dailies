import { GoogleGenAI } from '@google/genai';
import { editPlanSchema, type AnalysisResult, type EditPlan, type EditorialReview, type IntroOutroCard, type Recommendation } from '@dailies/shared';

export async function createEditPlan(analysis: AnalysisResult, recommendation: Recommendation, revision?: { previousPlan: EditPlan; review: EditorialReview }): Promise<EditPlan> {
  const ai = new GoogleGenAI({ vertexai: true, project: required('GCP_PROJECT_ID'), location: process.env.VERTEX_LOCATION || 'global' });
  const basePrompt = `Create an assertive, viewer-first YouTube edit plan for project ${analysis.projectId}.
The user supplied one rough assembly containing all clips in a single ${analysis.durationSeconds}-second file. Optimize viewer value per second, but derive the final duration entirely from the diagnosed material—never from a fixed source-to-output ratio. Preserve the hook, central story, essential evidence, personality, useful context, and payoff. Surgically remove dead air, mistakes, coughs, sniffles, stutters, false starts, verbal resets, repeated explanations, throat-clearing, mildly unrelated tangents, low-value setup, and routine handling when they do not advance the topic or entertainment. A twenty-minute source may correctly remain long when its footage is valuable, or become five minutes when most of it is redundant or unrelated. Do not preserve filler for conversational continuity, and do not cut valuable material merely to hit a duration target. Do not award clarity alone a high engagement score when visual variety, hook, pacing, or emotional momentum are weak.
Choose remove versus fast_forward from the video's promise and the segment's story or teaching function, not duration alone. In a tutorial/how-to/how-it-is-made video, preserve process steps, sequencing, technique, and explanatory narration at 1x or only mildly accelerate material that remains fully learnable. Remove an action when neither the action nor its outcome advances the story or instruction. Use 2x-8x for moderately repetitive but useful action. For a long non-instructional process or transformation whose before-to-process-to-result progression matters, first choose an earned final duration, then derive the playback rate from the source span. A single-setting passage with little visual change should normally resolve in about 5-10 seconds. It may remain longer only when distinct visual beats, scenery changes, or a setup-to-result mini-arc keep rewarding attention. Choose the slowest acceleration that reaches that earned duration while keeping the action readable: 10x may be sufficient, 20x-50x may suit a longer repetitive stretch, and 100x is a rare ceiling for exceptionally long, visually obvious repetition. Never default every montage to the maximum. Keep short setup/result anchor beats at 1x when they carry meaning; do not use extreme speed merely to avoid deleting useless footage or to race through educational content. Every fast-forward section must mute original audio completely (originalAudioGainDb -96). A montage above 8x must overlap an analysis-grounded music cue with dialoguePolicy replace_source_audio that ends cleanly before normal-speed dialogue resumes. Every retained keep or tighten segment at 1x must preserve original audio at exactly 0 dB; never lower narration to make an effect prominent. Added audio is controlled exclusively by the analysis audio-cue map, so set soundtrackGainDb to -96 on every segment; do not create a continuous music bed. Dialogue preservation is non-negotiable: never remove, fast-forward, mute, or cover the spoken opening introduction or closing statement. Request reduceNoise or removeHum when the analysis identifies a persistent white-noise floor or hum, applying cleanup consistently before cuts; otherwise leave both false so the source tone is unchanged. Use visualTreatment for measured exposure/color issues, protecting skin tones. Never invent footage or reorder speech.
If any dialogue must be cut elsewhere, cut only at a clearly audible vocal stop: a completed sentence or clause followed by a natural pause or breath. Never cut mid-word, mid-syllable, mid-breath, or across a word boundary; preserve a natural lead-in and tail on every retained phrase. A clause-level pause is only a valid cut point when the same sentence resumes at the start of the very next retained segment; it is never valid as the sourceEndSeconds of the last segment in the whole plan, because nothing follows it there. The final retained segment must end only after the closing statement's sentence or thought is grammatically and semantically complete, even if that means keeping a few extra seconds past the nearest audible pause. Use cut transitions only. Do not request dissolves; the current media renderer prioritizes precise editorial cuts.
A mid-video full_frame cue (a reveal card) is still composited on top of the source timeline like any sticker: it is an addition around the source dialogue and must never replace or cover essential speech — if it overlaps spoken dialogue, retain that source interval at 1x/0 dB and place the card over a non-blocking region or immediately before/after the spoken phrase.
A full_frame cue near the very start or end (a cold open or end card) works differently: it is never composited over the source timeline at all — it is genuinely additional runtime, spliced in before the first retained segment or after the last one, so it can never mute or cover real dialogue no matter where it sits. To use one, set introOutro.intro and/or introOutro.outro to { cueId, source }, where cueId is that cue's exact id from the analysis-grounded audio cues below and the cue's own endSeconds-startSeconds becomes how long the inserted card plays. source is "generated_card" to use that cue's generated/library visual and sound, or "removed_footage" to instead reuse a real interval you are already discarding elsewhere in the source (set footageStartSeconds/footageEndSeconds to that exact interval) — for example a nice establishing shot or reaction that got cut. A removed_footage interval must fall entirely inside segments you marked action remove; it can never overlap anything you are keeping, tightening, or fast-forwarding. The original source seconds the intro/outro cue's own timestamps describe still need their own ordinary segment decision (keep/tighten/remove) on their own editorial merits, exactly like any other part of the video — introOutro only decides whether that cue's card plays as extra bonus time, not what happens to the source seconds it was diagnosed at.
Analysis: ${JSON.stringify(analysis.scenes)}
Precise editing signals: ${JSON.stringify(analysis.editingSignals)}
Analysis-grounded audio cues: ${JSON.stringify(analysis.audioCues)}
Original viewer score: ${JSON.stringify(analysis.viewerScore || null)}
Retention recommendation: ${JSON.stringify(recommendation)}
${revision ? `This is a revision of a rendered draft. Previous plan: ${JSON.stringify(revision.previousPlan)}\nRendered-draft review: ${JSON.stringify(revision.review)}\nCorrect every blocking and major issue. Keep successful decisions unless the review identifies a concrete reason to change them.` : 'This is the first draft plan.'}
Return JSON with projectId, rationale, targetDurationSeconds, expectedViewerScore, audioCleanup, visualStrategy, global gain defaults, optional introOutro, and chronological segments. Every segment needs id, optional sceneId, sourceStartSeconds, sourceEndSeconds, action (keep, tighten, remove, or fast_forward), playbackRate, per-segment originalAudioGainDb and soundtrackGainDb, transition, visualTreatment, and reason. The renderer does not shorten an interval merely because it is labeled tighten: you must split the timeline and explicitly mark discarded source intervals remove, or increase playbackRate only where accelerated audio is appropriate. The sum of retained durations divided by playbackRate, plus any introOutro card durations, must approximately equal targetDurationSeconds. Removed intervals should remain in the plan with action remove so the report explains them.`;
  let correction = '';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await ai.models.generateContent({ model: process.env.GEMINI_MODEL || 'gemini-3-flash-preview', contents: `${basePrompt}${correction}`, config: { responseMimeType: 'application/json', responseJsonSchema: editPlanJsonSchema } });
    if (!response.text) throw new Error('Gemini returned no edit plan');
    const plan = editPlanSchema.parse(JSON.parse(response.text));
    if (plan.projectId !== analysis.projectId) throw new Error('Gemini edit-plan project id mismatch');
    validateTimeline(plan, analysis.durationSeconds);
    validateContentRemovals(plan, analysis);
    validateExtremeMontages(plan, analysis);
    validateIntroOutro(plan, analysis);
    // Sentence-boundary continuity is checked here, before any render, and on every revision — not
    // just the numeric segment/timeline validators above. There is no word-level transcript to check
    // programmatically (only one free-text transcript per scene), so this is a targeted Gemini
    // judgment over exactly the boundaries that are actually at risk: a kept segment or a reused
    // introOutro footage window that only partially covers a scene's transcript.
    const problems = await checkDialogueContinuity(ai, plan, analysis);
    if (!problems.length) return plan;
    correction = `\nYour previous plan cut the following at what reads like a mid-sentence point: ${problems.map((problem) => `${problem.segmentId} (${problem.reason})`).join('; ')}. Move those exact cut points to the nearest complete sentence/clause boundary instead, keeping every other decision unchanged.`;
  }
  throw new Error('Gemini edit plan left one or more cuts landing mid-sentence after 2 attempts');
}

// The "never cuts off main content or audio" guarantee for a reused-footage intro/outro: its window
// must fall entirely inside segments this same plan already marked for removal, never overlapping
// anything retained. Cue-placement rules (spacing, on-screen coincidence) are deliberately not
// enforced here — those govern cues throughout the video (see problematicCuePlacement in
// analysisAgent.ts) and don't apply to a footage-cut/insert decision like this one.
export function validateIntroOutro(plan: EditPlan, analysis: AnalysisResult) {
  const check = (card: IntroOutroCard | undefined, label: string) => {
    if (!card) return;
    const cue = analysis.audioCues.find((item) => item.id === card.cueId);
    if (!cue) throw new Error(`${label} references unknown cue ${card.cueId}`);
    if (cue.visualMode !== 'full_frame') throw new Error(`${label} cue ${card.cueId} must be a full_frame cue`);
    if (card.source !== 'removed_footage') return;
    const windowDuration = card.footageEndSeconds! - card.footageStartSeconds!;
    const removedCoverage = plan.segments.filter((segment) => segment.action === 'remove').reduce((total, segment) => total + Math.max(0, Math.min(card.footageEndSeconds!, segment.sourceEndSeconds) - Math.max(card.footageStartSeconds!, segment.sourceStartSeconds)), 0);
    if (removedCoverage < windowDuration - .05) throw new Error(`${label} removed_footage window ${card.footageStartSeconds}-${card.footageEndSeconds}s is not fully covered by removed segments; it must only reuse footage the plan is already discarding`);
  };
  check(plan.introOutro?.intro, 'introOutro.intro');
  check(plan.introOutro?.outro, 'introOutro.outro');
}

async function checkDialogueContinuity(ai: GoogleGenAI, plan: EditPlan, analysis: AnalysisResult): Promise<{ segmentId: string; reason: string }[]> {
  const risks: string[] = [];
  const describePartial = (label: string, windowStart: number, windowEnd: number) => {
    analysis.scenes.filter((scene) => Math.min(scene.endSeconds, windowEnd) > Math.max(scene.startSeconds, windowStart)).forEach((scene) => {
      if (windowStart > scene.startSeconds + .25 || windowEnd < scene.endSeconds - .25) risks.push(`${label} (${windowStart.toFixed(1)}-${windowEnd.toFixed(1)}s) only partially covers scene ${scene.id}'s transcript (${scene.startSeconds.toFixed(1)}-${scene.endSeconds.toFixed(1)}s): "${scene.transcript}"`);
    });
  };
  plan.segments.filter((segment) => segment.action !== 'remove').forEach((segment) => describePartial(`Segment ${segment.id}`, segment.sourceStartSeconds, segment.sourceEndSeconds));
  if (plan.introOutro?.intro?.source === 'removed_footage') describePartial('introOutro.intro', plan.introOutro.intro.footageStartSeconds!, plan.introOutro.intro.footageEndSeconds!);
  if (plan.introOutro?.outro?.source === 'removed_footage') describePartial('introOutro.outro', plan.introOutro.outro.footageStartSeconds!, plan.introOutro.outro.footageEndSeconds!);
  if (!risks.length) return [];
  const prompt = `Original full transcript by timestamp:\n${analysis.scenes.map((scene) => `[${scene.startSeconds.toFixed(1)}-${scene.endSeconds.toFixed(1)}] ${scene.transcript}`).join('\n')}\n\nEach of the following cuts or reused footage intervals only partially retains one scene's transcript. Read that scene's wording and judge whether the retained/reused portion plausibly ends after a complete sentence or clause, or whether it looks like it cuts off mid-sentence:\n${risks.join('\n')}\n\nReturn JSON {"problems":[{"segmentId":"...","reason":"..."}]} listing only the ones that look like a mid-sentence cut, using the exact identifier given above (e.g. "Segment seg_3" or "introOutro.intro") as segmentId. Return an empty problems array if none look wrong.`;
  const response = await ai.models.generateContent({ model: process.env.GEMINI_MODEL || 'gemini-3-flash-preview', contents: prompt, config: { responseMimeType: 'application/json', responseJsonSchema: continuityJsonSchema } });
  if (!response.text) return [];
  return (JSON.parse(response.text).problems || []);
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
const introOutroCardJsonSchema = { type: 'object', additionalProperties: false, required: ['cueId', 'source'], properties: { cueId: { type: 'string' }, source: { type: 'string', enum: ['generated_card', 'removed_footage'] }, footageStartSeconds: { type: 'number' }, footageEndSeconds: { type: 'number' } } };
const continuityJsonSchema = { type: 'object', additionalProperties: false, required: ['problems'], properties: { problems: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['segmentId', 'reason'], properties: { segmentId: { type: 'string' }, reason: { type: 'string' } } } } } };
const editPlanJsonSchema = { type: 'object', additionalProperties: false, required: ['projectId', 'segments', 'rationale', 'originalAudioGainDb', 'soundtrackGainDb', 'targetDurationSeconds', 'expectedViewerScore', 'audioCleanup', 'visualStrategy'], properties: { projectId: { type: 'string' }, rationale: { type: 'string' }, originalAudioGainDb: { type: 'number', maximum: 0 }, soundtrackGainDb: { type: 'number', maximum: 0 }, targetDurationSeconds: { type: 'number', exclusiveMinimum: 0 }, expectedViewerScore: scoreJsonSchema, audioCleanup: { type: 'object', additionalProperties: false, required: ['reduceNoise', 'removeHum', 'highPassHz', 'targetLufs'], properties: { reduceNoise: { type: 'boolean' }, removeHum: { type: 'boolean' }, highPassHz: { type: 'number', minimum: 40, maximum: 200 }, targetLufs: { type: 'number', minimum: -24, maximum: -8 } } }, visualStrategy: { type: 'string' }, introOutro: { type: 'object', additionalProperties: false, properties: { intro: introOutroCardJsonSchema, outro: introOutroCardJsonSchema } }, segments: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['id', 'sourceStartSeconds', 'sourceEndSeconds', 'action', 'reason', 'playbackRate', 'originalAudioGainDb', 'soundtrackGainDb', 'transition', 'visualTreatment'], properties: { id: { type: 'string' }, sceneId: { type: 'string' }, sourceStartSeconds: { type: 'number' }, sourceEndSeconds: { type: 'number' }, action: { type: 'string', enum: ['keep', 'tighten', 'remove', 'fast_forward'] }, playbackRate: { type: 'number', minimum: .5, maximum: 100 }, originalAudioGainDb: { type: 'number', minimum: -96, maximum: 6 }, soundtrackGainDb: { type: 'number', minimum: -96, maximum: 6 }, transition: { type: 'string', enum: ['cut'] }, visualTreatment: visualJsonSchema, reason: { type: 'string' } } } } } };

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
