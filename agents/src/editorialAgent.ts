import { FunctionTool, InMemorySessionService, LlmAgent, Runner, stringifyContent } from '@google/adk';
import { Type } from '@google/genai';
import type { CompleteProjectReport, Project, ProjectStatus } from '@dailies/shared';
import { analyzeVideo } from './analysisAgent.js';
import { createEditPlan } from './editingAgent.js';
import { generateScore } from './scoreAgent.js';
import { queryRetention, recommendationFromRows } from './retentionAgent.js';
import { renderFinalCut } from './renderAgent.js';
import { reviewRenderedDraft } from './reviewAgent.js';
import type { JobInput, JobState } from './orchestrator.js';

const APP_NAME = 'dailies_editorial_agent';
const MAX_DRAFTS = 3;

export async function runEditorialAgent(input: JobInput, update: (state: JobState['status'], progress?: Project['progress'], activityMessage?: string) => void | Promise<void>): Promise<CompleteProjectReport> {
  configureVertexEnvironment();
  let progress: NonNullable<Project['progress']> = input.progress || {};
  let iteration = progress.editorialIteration || (progress.finalCut ? 1 : 0);
  let fatalToolError: unknown;

  const checkpoint = async (status: ProjectStatus, patch: Partial<NonNullable<Project['progress']>>, activityMessage?: string) => {
    progress = { ...progress, ...patch };
    await update(status, progress, activityMessage);
  };

  const diagnose = new FunctionTool({ name: 'diagnose_source_video', description: 'Watch and deeply diagnose the complete source video. Use this before making editing decisions. Reuses a durable diagnosis when present.', parameters: reasonSchema, execute: async () => {
    if (progress.analysis) return { ok: true, reusedDurableDiagnosis: true, sourceScore: progress.analysis.viewerScore, scenes: progress.analysis.scenes.length, editSignals: progress.analysis.editingSignals.length, audioVisualCues: progress.analysis.audioCues.length };
    if (!progress.analysis) await checkpoint('analyzing', {}, 'Editorial agent is watching the complete source and diagnosing its hook, pacing, audio, visuals, and payoff.');
    const analysis = progress.analysis || await analyzeVideo({ projectId: input.projectId, videoUri: input.videoUri, mimeType: input.mimeType || 'video/mp4', durationSeconds: input.durationSeconds, outline: input.outline });
    await checkpoint('analyzing', { analysis }, `Source diagnosis complete: ${analysis.scenes.length} scenes, ${analysis.editingSignals.length} edit signals, and ${analysis.audioCues.length} audio/visual moments identified.`);
    return { ok: true, sourceScore: analysis.viewerScore, scenes: analysis.scenes.length, editSignals: analysis.editingSignals.length, audioVisualCues: analysis.audioCues.length };
  }});

  const creatorEvidence = new FunctionTool({ name: 'load_creator_evidence', description: 'Load optional authorized YouTube/ClickHouse retention evidence. Absence of creator authorization must never block editing.', parameters: reasonSchema, execute: async () => {
    if (!progress.analysis) return { ok: false, requiredNext: 'diagnose_source_video' };
    if (progress.recommendation) return { ok: true, reusedDurableEvidence: true, creatorHistoryUsed: input.creatorHistoryEnabled === true, recommendation: progress.recommendation.recommendationText, confidence: progress.recommendation.confidence };
    await checkpoint(input.creatorHistoryEnabled ? 'querying_insights' : 'editing', {}, input.creatorHistoryEnabled ? 'Agent is querying authorized creator-retention evidence through ClickHouse MCP.' : 'Creator history is not connected; agent is continuing from the source diagnosis without analytics.');
    const recommendation = progress.recommendation || (input.creatorHistoryEnabled ? await queryRetention(input.ownerId, input.durationSeconds) : recommendationFromRows([], input.durationSeconds));
    await checkpoint('editing', { recommendation }, input.creatorHistoryEnabled ? `Creator evidence loaded (${recommendation.confidence} confidence) and added to the editorial context.` : 'Optional creator-history stage skipped; no editing capability is blocked.');
    return { ok: true, creatorHistoryUsed: input.creatorHistoryEnabled === true, recommendation: recommendation.recommendationText, confidence: recommendation.confidence };
  }});

  const plan = new FunctionTool({ name: 'design_or_revise_edit', description: 'Create the initial executable timeline or revise it from the latest rendered-draft critique. Call again after every review with decision revise.', parameters: reasonSchema, execute: async () => {
    if (!progress.analysis) return { ok: false, requiredNext: 'diagnose_source_video' };
    if (!progress.recommendation) return { ok: false, requiredNext: 'load_creator_evidence' };
    if (progress.editPlan && progress.editorialReview?.decision !== 'revise') return { ok: true, reusedDurablePlan: true, targetDurationSeconds: progress.editPlan.targetDurationSeconds, segments: progress.editPlan.segments.length, rationale: progress.editPlan.rationale };
    await checkpoint('editing', {}, progress.editorialReview?.decision === 'revise' ? `Agent is revising draft ${progress.editorialReview.iteration} from the rendered-video critique.` : 'Agent is designing the first executable edit from the complete diagnosis.');
    const revision = progress.editorialReview?.decision === 'revise' && progress.editPlan ? { previousPlan: progress.editPlan, review: progress.editorialReview } : undefined;
    const editPlan = await createEditPlan(progress.analysis, progress.recommendation, revision);
    const accelerated = editPlan.segments.filter((segment) => segment.action === 'fast_forward');
    const fastest = accelerated.reduce((maximum, segment) => Math.max(maximum, segment.playbackRate), 1);
    await checkpoint('editing', { editPlan, render: undefined, finalCut: undefined, editorialReview: undefined }, `${revision ? 'Revised' : 'Initial'} edit plan ready: ${editPlan.segments.length} timeline decisions targeting ${Math.round(editPlan.targetDurationSeconds || 0)} seconds${accelerated.length ? `, including ${accelerated.length} accelerated process segment${accelerated.length === 1 ? '' : 's'} up to ${fastest}×` : ''}.`);
    return { ok: true, revisedFromDraft: Boolean(revision), targetDurationSeconds: editPlan.targetDurationSeconds, segments: editPlan.segments.length, rationale: editPlan.rationale };
  }});

  const assets = new FunctionTool({ name: 'generate_editorial_assets', description: 'Generate and checkpoint the single analysis-grounded soundtrack. Visual assets are delegated to generate_visual_asset and validate_visual_asset tools.', parameters: reasonSchema, execute: async (_reason, toolContext) => {
    if (!progress.analysis) return { ok: false, requiredNext: 'diagnose_source_video' };
    if (progress.soundtrack) return { ok: true, reusedDurableAssets: true, requiredNext: visualCueIds(progress).length ? 'generate_visual_asset' : 'render_edit_draft', needed: progress.soundtrack.needed, generatedCues: progress.soundtrack.cues.length, visualCuesRemaining: visualCueIds(progress) };
    if (fatalToolError) { toolContext!.invocationContext.endInvocation = true; return { ok: false, fatal: true, error: String((fatalToolError as any)?.message || fatalToolError).slice(0, 500) }; }
    await checkpoint('scoring', {}, 'Agent is generating only the music, sound, and visual assets justified by its timestamped diagnosis.');
    try {
      const soundtrack = await generateScore(
        progress.analysis,
        input.ownerId,
        (message) => checkpoint('scoring', {}, message),
        { draft: progress.soundtrackDraft, checkpoint: (soundtrackDraft) => checkpoint('scoring', { soundtrackDraft }, `Durable asset checkpoint saved (${soundtrackDraft.cues.length} of ${progress.analysis!.audioCues.filter((cue) => cue.type !== 'silence').length} cues).`) },
        { skipVisuals: true },
      );
      await checkpoint('editing', { soundtrack, soundtrackDraft: undefined }, soundtrack.cues.length ? `Generated ${soundtrack.cues.length} synchronized editorial asset cue${soundtrack.cues.length === 1 ? '' : 's'} for the planned moments.` : 'Agent determined that this cut does not need generated audio or visual assets.');
      return { ok: true, requiredNext: visualCueIds({ ...progress, soundtrack }).length ? 'generate_visual_asset' : 'render_edit_draft', needed: soundtrack.needed, generatedCues: soundtrack.cues.length, visualCuesRemaining: visualCueIds({ ...progress, soundtrack }), rationale: soundtrack.rationale };
    } catch (error) {
      fatalToolError = error;
      toolContext!.invocationContext.endInvocation = true;
      return { ok: false, fatal: true, retryableByWorker: true, error: String((error as any)?.message || error).slice(0, 500) };
    }
  }});

  const generateVisualAsset = new FunctionTool({ name: 'generate_visual_asset', description: 'Generate exactly one analysis-grounded visual asset for a cue. If validation fails, diagnose the result, revise the reason/prompt, and call this tool again for the same cue.', parameters: visualAssetSchema, execute: async (toolInput) => { const { cueId, reason } = toolInput as { cueId: string; reason: string };
    if (!progress.analysis || !progress.soundtrack) return { ok: false, requiredNext: 'generate_editorial_assets' };
    const cue = progress.soundtrack.cues.find((item) => item.id === cueId);
    if (!cue) return { ok: false, error: `Unknown soundtrack cue ${cueId}` };
    if (!cue.visualGenerationPrompt?.trim()) return { ok: true, approved: true, skipped: true, cueId };
    if (cue.visualAsset) return { ok: true, approved: true, cueId, assetId: cue.visualAsset.id, reusedDurableAsset: true };
    await checkpoint('scoring', {}, `Agent tool generating visual asset for ${cueId}; prompt revision: ${reason.slice(0, 180)}`);
    try {
      const soundtrack = await generateScore(progress.analysis, input.ownerId, (message) => checkpoint('scoring', {}, message), { draft: progress.soundtrack }, { visualCueId: cueId, visualPromptOverride: reason });
      await checkpoint('editing', { soundtrack }, `Visual generation tool completed for ${cueId}; validation is now required.`);
      return { ok: true, approved: false, requiresValidation: true, cueId, assetId: soundtrack.cues.find((item) => item.id === cueId)?.visualAsset?.id };
    } catch (error) {
      return { ok: false, retryable: true, cueId, error: String((error as any)?.message || error).slice(0, 500), instruction: 'Diagnose the image failure, revise the reason/prompt, and call generate_visual_asset again.' };
    }
  }});

  const validateVisualAsset = new FunctionTool({ name: 'validate_visual_asset', description: 'Validate one generated visual asset against the cue requirement. If missing or unsuitable, return a diagnosis so the agent can revise and call generate_visual_asset again.', parameters: visualValidationSchema, execute: async (toolInput) => { const { cueId } = toolInput as { cueId: string };
    const cue = progress.soundtrack?.cues.find((item) => item.id === cueId);
    if (!cue) return { ok: false, approved: false, error: `Unknown soundtrack cue ${cueId}` };
    if (!cue.visualGenerationPrompt?.trim()) return { ok: true, approved: true, cueId, skipped: true };
    if (!cue.visualAsset) return { ok: true, approved: false, cueId, diagnosis: 'No visual asset was produced. Revise the prompt and call generate_visual_asset again.' };
    return { ok: true, approved: true, cueId, assetId: cue.visualAsset.id, generationModel: cue.visualAsset.generationModel, diagnosis: 'Asset exists and is checkpointed for rendering.' };
  }});

  const render = new FunctionTool({ name: 'render_edit_draft', description: 'Execute the current agent-authored edit plan with FFmpeg/Google Cloud and persist a distinct cloud draft. Never call without a current plan and generated assets.', parameters: reasonSchema, execute: async () => {
    if (!progress.analysis) return { ok: false, requiredNext: 'diagnose_source_video' };
    if (!progress.editPlan) return { ok: false, requiredNext: 'design_or_revise_edit' };
    if (!progress.soundtrack) return { ok: false, requiredNext: 'generate_editorial_assets' };
    if (visualCueIds(progress).length) return { ok: false, requiredNext: 'generate_visual_asset', visualCuesRemaining: visualCueIds(progress) };
    if (iteration >= MAX_DRAFTS) return { ok: false, draftLimitReached: true, maximumDrafts: MAX_DRAFTS };
    iteration += 1; await checkpoint('rendering', { editorialIteration: iteration, render: undefined, finalCut: undefined }, `Agent approved the timeline for execution. Rendering draft ${iteration} of ${MAX_DRAFTS}.`);
    const finalCut = await renderFinalCut({ projectId: input.projectId, ownerId: input.ownerId, sourceUri: input.videoUri, sourceDurationSeconds: input.durationSeconds, soundtrack: progress.soundtrack, editorialCues: progress.analysis.audioCues, editPlan: progress.editPlan, executionAttempt: (input.executionAttempt || 1) * 10 + iteration }, async (renderCheckpoint) => checkpoint('rendering', { render: renderCheckpoint }, `Draft ${iteration} render submitted; cloud output checkpoint saved.`));
    await checkpoint('rendering', { finalCut }, `Draft ${iteration} rendered successfully (${Math.round(finalCut.durationSeconds)} seconds). It is not final until the agent watches and approves it.`);
    return { ok: true, iteration, draftUri: renderedUri(input, finalCut), durationSeconds: finalCut.durationSeconds, provider: finalCut.renderProvider };
  }});

  const review = new FunctionTool({ name: 'inspect_rendered_draft', description: 'Watch the actual cloud-rendered draft alongside the source, diagnose remaining editorial defects, and return pass or timestamped revision requirements. Rendering success is not approval.', parameters: reasonSchema, execute: async () => {
    if (!progress.analysis || !progress.editPlan || !progress.recommendation || !progress.finalCut) return { ok: false, requiredNext: 'render_edit_draft' };
    await checkpoint('editing', {}, `Editorial agent is now watching rendered draft ${iteration} beside the original source.`);
    const editorialReview = await reviewRenderedDraft({ iteration, sourceUri: input.videoUri, sourceMimeType: input.mimeType || 'video/mp4', draftUri: renderedUri(input, progress.finalCut), analysis: progress.analysis, editPlan: progress.editPlan, recommendation: progress.recommendation });
    const majorIssues = editorialReview.issues.filter((issue) => issue.severity !== 'minor').length;
    // The prompt tells the reviewer decision='revise' should imply a major/blocking issue, but
    // nothing enforces that on its structured output, so it can revise on minor issues or its own
    // rationale alone. Don't claim a major-issue count of 0 as the reason for revision — fall back
    // to the reviewer's own summary so the checkpoint message is never self-contradictory.
    const reviseReason = majorIssues ? `${majorIssues} major/blocking issue${majorIssues === 1 ? '' : 's'} found` : editorialReview.summary || 'reviewer flagged remaining issues';
    await checkpoint('editing', { editorialReview }, editorialReview.decision === 'pass' ? `Draft ${iteration} passed rendered-video review with a score of ${Math.round(editorialReview.score.total)}.` : `Draft ${iteration} needs revision: ${reviseReason}. Agent will revise the edit.`);
    return { ok: true, decision: editorialReview.decision, score: editorialReview.score, summary: editorialReview.summary, issues: editorialReview.issues, draftsRemaining: MAX_DRAFTS - iteration };
  }});

  const rootAgent = new LlmAgent({
    name: 'dailies_senior_editor',
    description: 'Autonomous senior video editor that diagnoses, edits, renders, watches, and revises creator videos.',
    model: process.env.GEMINI_AGENT_MODEL || process.env.GEMINI_MODEL || 'gemini-3-flash-preview',
    instruction: `You are the senior editorial agent responsible for the finished Dailies video—not a passive pipeline router. Your goal is a pithy, engaging YouTube cut that materially improves the source while preserving truth, personality, and dialogue continuity.
Use tools and inspect their results. Required lifecycle: diagnose the entire source; load optional creator evidence; design an edit; generate the justified soundtrack; call generate_visual_asset and validate_visual_asset for every justified visual cue, revising prompts and looping until each is approved; render a cloud draft; watch that rendered draft; then either pass it or revise and repeat. Never claim completion before inspect_rendered_draft returns decision=pass. A successful render is only a draft. When review says revise, call design_or_revise_edit using that critique, render a distinct new draft, and inspect it again. You have at most ${MAX_DRAFTS} drafts; prioritize all blocking and major issues.
Editorial rules: maximize story and entertainment value per second without imposing a duration ratio. Protect the main story, personality, useful context, evidence, and payoff. Remove diagnosed repetition, dead talking, mildly unrelated tangents, coughs, sniffles, stutters, false starts, verbal resets, and routine actions that do not earn their time. A long source may remain long when the footage is valuable. Clean dialogue is the default; retain 1x narration at full source level; mute source only inside deliberate music-led intro/outro, montage, or fast-forward intervals; never use an unexplained continuous music bed. Use contextual intro/outro visuals, timed product/feature cards, emoji/reaction accents, and paired sound effects where the material earns them. Apply consistent white-noise cleanup when diagnosed. Creator analytics are evidence, never a requirement and never a substitute for watching the source and draft.
Process footage requires format-aware judgment. In a tutorial or how-it-is-made video, preserve the steps and explanatory narration at a learnable pace. In a story, haul, review, or reveal-led video, preserve meaningful before/result anchors but an otherwise repetitive non-instructional process may become a music-led montage. A low-change, single-setting montage should normally produce about 5-10 seconds of final footage; allow more only when distinct visual beats, scenery changes, or a setup-to-result mini-arc keep earning attention. Choose the slowest speed that reaches that earned duration and keeps the motion readable—often 10× is enough; 100× is only the ceiling for rare, exceptionally repetitive passages. Delete it when neither the process nor outcome earns time.
Current durable state: ${JSON.stringify(progressSummary(progress))}`,
    tools: [diagnose, creatorEvidence, plan, assets, generateVisualAsset, validateVisualAsset, render, review],
  });
  const sessionService = new InMemorySessionService();
  await sessionService.createSession({ appName: APP_NAME, userId: input.ownerId, sessionId: input.projectId, state: { projectId: input.projectId, editorialIteration: iteration } });
  const runner = new Runner({ appName: APP_NAME, agent: rootAgent, sessionService });
  let finalMessage = '';
  for (let continuation = 0; continuation < 6 && progress.editorialReview?.decision !== 'pass'; continuation += 1) {
    const state = progressSummary(progress);
    const instruction = continuation === 0
      ? 'Take ownership of this project and produce the strongest final cut. Continue from durable state, use the tools, inspect every rendered draft, and stop only after the reviewer passes it.'
      : `You stopped before the required lifecycle completed. Current durable state: ${JSON.stringify(state)}. Continue with the next missing tool now. Do not summarize or claim completion until inspect_rendered_draft returns decision=pass.`;
    for await (const event of runner.runAsync({ userId: input.ownerId, sessionId: input.projectId, newMessage: { role: 'user', parts: [{ text: instruction }] }, runConfig: { maxLlmCalls: 24 } })) {
      const text = stringifyContent(event).trim(); if (text) finalMessage = text;
    }
    if (fatalToolError) throw fatalToolError;
  }
  if (!progress.analysis || !progress.soundtrack || !progress.recommendation || !progress.editPlan || !progress.finalCut || progress.editorialReview?.decision !== 'pass') throw new Error(`Editorial agent stopped without an approved rendered draft${finalMessage ? `: ${finalMessage.slice(0, 300)}` : ''}`);
  return { analysis: progress.analysis, soundtrack: progress.soundtrack, recommendation: progress.recommendation, editPlan: progress.editPlan, finalCut: progress.finalCut, editorialReview: progress.editorialReview };
}

const reasonSchema = { type: Type.OBJECT, required: ['reason'], properties: { reason: { type: Type.STRING, description: 'Why this tool is the correct next editorial action.' } } };
const visualAssetSchema = { type: Type.OBJECT, required: ['cueId', 'reason'], properties: { cueId: { type: Type.STRING, description: 'The exact diagnosed cue ID to generate.' }, reason: { type: Type.STRING, description: 'The agent diagnosis and revised image-generation direction.' } } };
const visualValidationSchema = { type: Type.OBJECT, required: ['cueId'], properties: { cueId: { type: Type.STRING, description: 'The exact cue ID to validate.' } } };
const progressSummary = (progress: NonNullable<Project['progress']>) => ({ hasAnalysis: Boolean(progress.analysis), hasCreatorEvidence: Boolean(progress.recommendation), hasAssets: Boolean(progress.soundtrack), hasEditPlan: Boolean(progress.editPlan), hasDraft: Boolean(progress.finalCut), reviewDecision: progress.editorialReview?.decision, editorialIteration: progress.editorialIteration || 0 });
const visualCueIds = (progress: NonNullable<Project['progress']>) => (progress.soundtrack?.cues || []).filter((cue) => cue.visualGenerationPrompt?.trim() && !cue.visualAsset).map((cue) => cue.id);
const renderedUri = (input: JobInput, finalCut: NonNullable<Project['progress']>['finalCut']) => `gs://${required('GCS_BUCKET')}/${input.ownerId}/${input.projectId}/${finalCut!.asset.id}/${finalCut!.asset.fileName}`;
const configureVertexEnvironment = () => { process.env.GOOGLE_GENAI_USE_VERTEXAI ||= 'true'; process.env.GOOGLE_CLOUD_PROJECT ||= required('GCP_PROJECT_ID'); process.env.GOOGLE_CLOUD_LOCATION ||= process.env.VERTEX_LOCATION || 'global'; };
const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; };
