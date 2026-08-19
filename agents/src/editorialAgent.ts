import { FunctionTool, InMemorySessionService, LlmAgent, Runner, stringifyContent } from '@google/adk';
import { Type } from '@google/genai';
import { Storage } from '@google-cloud/storage';
import { editorialAudioCueSchema, editorialReviewSchema, finalCutResultSchema, generatedMusicCueSchema, type CompleteProjectReport, type DraftHistoryEntry, type Project, type ProjectStatus } from '@dailies/shared';
import { analyzeVideo } from './analysisAgent.js';
import { createEditPlan } from './editingAgent.js';
import { EMOJI_LIBRARY, LIBRARY_GCS_PREFIX, SFX_LIBRARY } from './library.js';
import { renderCuePreview } from './ffmpegRenderer.js';
import { generateScore } from './scoreAgent.js';
import { queryRetention, recommendationFromRows } from './retentionAgent.js';
import { renderFinalCut } from './renderAgent.js';
import { reviewCuePreview, reviewRenderedDraft } from './reviewAgent.js';
import type { JobInput, JobState } from './orchestrator.js';

const APP_NAME = 'dailies_editorial_agent';
const MAX_DRAFTS = 3;
// How many times one invocation may attempt a render before it stops trying. Each attempt is a full
// encode of the timeline; an unbounded model-driven retry keeps the CPU pinned for as long as it
// takes the model to give up, which in practice it does not.
const MAX_RENDER_FAILURES = 2;

export async function runEditorialAgent(input: JobInput, update: (state: JobState['status'], progress?: Project['progress'], activityMessage?: string) => void | Promise<void>): Promise<CompleteProjectReport> {
  configureVertexEnvironment();
  let progress: NonNullable<Project['progress']> = input.progress || {};
  let iteration = progress.editorialIteration || (progress.finalCut ? 1 : 0);
  let fatalToolError: unknown;
  let renderFailures = 0;

  const checkpoint = async (status: ProjectStatus, patch: Partial<NonNullable<Project['progress']>>, activityMessage?: string) => {
    progress = { ...progress, ...patch };
    await update(status, progress, activityMessage);
  };

  // Try the durable draftHistory first; if that's empty too (legacy state, predating draftHistory,
  // or every render happened before a review could record it), reconcile directly against Cloud
  // Storage — a completed render is real, billed work that should never be silently discarded just
  // because its Firestore pointer was lost. Called both from design_or_revise_edit (when the model
  // is still driving) and deterministically after the continuation loop gives up on its own — a model
  // that stops calling tools and just writes a status report must not be able to bypass recovery.
  const attemptBudgetExhaustedRecovery = async (): Promise<boolean> => {
    const best = bestDraft(progress.draftHistory);
    if (best) {
      await checkpoint('editing', { editPlan: best.editPlan, finalCut: best.finalCut, editorialReview: { ...best.editorialReview, decision: 'pass' }, editorialIteration: best.iteration, finalized: true }, `All ${MAX_DRAFTS} drafts used and none passed outright. Publishing draft ${best.iteration} (score ${Math.round(best.editorialReview.score.total)}/100, the best of ${progress.draftHistory!.length} rendered) as the final cut instead of discarding every rendered draft.`);
      iteration = best.iteration; return true;
    }
    const orphan = await findLatestOrphanedRender(input.ownerId, input.projectId);
    if (!orphan) return false;
    const finalCut = finalCutResultSchema.parse({ asset: { id: orphan.assetId, kind: 'rendered_video', fileName: orphan.fileName, mimeType: 'video/mp4', sizeBytes: orphan.sizeBytes, generationModel: 'ffmpeg-node-media-pipeline', createdAt: orphan.createdAt }, durationSeconds: progress.editPlan?.targetDurationSeconds || input.durationSeconds, renderProvider: 'ffmpeg-cloud-run', renderJobId: `ffmpeg:${orphan.assetId}` });
    const editorialReview = editorialReviewSchema.parse({ iteration: iteration || 1, decision: 'pass', score: { hook: 70, pacing: 70, clarity: 70, visualQuality: 70, audioQuality: 70, total: 70, rationale: 'Recovered directly from a completed Cloud Storage render after the draft budget was exhausted with no durable review history available; not a fresh editorial verdict.' }, summary: 'The durable checkpoint trail lost track of this draft’s review, but a finished render was found in Cloud Storage and recovered as the final cut instead of failing.', issues: [] });
    await checkpoint('editing', { editPlan: progress.editPlan, finalCut, editorialReview, finalized: true }, `No durable draft history was available, but a completed render (${orphan.assetId}) was found in Cloud Storage and recovered as the final cut.`);
    return true;
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
    const shipBestDraft = async () => attemptBudgetExhaustedRecovery();
    // The draft budget is spent with nothing finalized — whether that's a genuine 'revise' decision
    // about to design a plan render_edit_draft can never test, or a resumed job whose Firestore
    // trail already lost finalCut/editorialReview to an earlier wasted cycle (a worker restart, or
    // this exact gap before it was fixed), the pipeline must still recover rather than fail outright.
    if (!progress.finalCut && iteration >= MAX_DRAFTS) {
      if (await shipBestDraft()) return { ok: true, finalizedFromHistory: true, iteration, decision: 'pass' };
    }
    if (progress.editPlan && progress.editorialReview?.decision !== 'revise') return { ok: true, reusedDurablePlan: true, targetDurationSeconds: progress.editPlan.targetDurationSeconds, segments: progress.editPlan.segments.length, rationale: progress.editPlan.rationale };
    // Review wants another revision, but if the draft budget is already spent there is no
    // render_edit_draft call left to ever test that revision against — designing one anyway just
    // burns a full plan+asset cycle before hitting the same wall. Catch it here, before that cycle
    // is wasted, using the draft history this same review call already recorded.
    if (progress.editorialReview?.decision === 'revise' && iteration >= MAX_DRAFTS && await shipBestDraft()) return { ok: true, finalizedFromHistory: true, iteration, decision: 'pass' };
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

  const selectLibraryEmoji = new FunctionTool({ name: 'select_library_emoji', description: `Attach a pre-made emoji image from the fixed asset library to a cue instead of generating a new one with generate_visual_asset — faster and more reliable when a library entry genuinely fits. Only pick an entry whose emoji actually matches the cue's specific moment; call generate_visual_asset instead when nothing in the library fits. Library (id: emoji): ${EMOJI_LIBRARY.map((item) => `${item.id}: ${item.emoji}`).join(', ')}`, parameters: librarySelectionSchema, execute: async (toolInput) => { const { cueId, libraryId } = toolInput as { cueId: string; libraryId: string };
    if (!progress.analysis || !progress.soundtrack) return { ok: false, requiredNext: 'generate_editorial_assets' };
    const cue = progress.soundtrack.cues.find((item) => item.id === cueId); if (!cue) return { ok: false, error: `Unknown cue ${cueId}` };
    if (!cue.visualGenerationPrompt?.trim()) return { ok: true, approved: true, skipped: true, cueId };
    if (cue.visualAsset) return { ok: true, approved: true, cueId, assetId: cue.visualAsset.id, reusedDurableAsset: true };
    const entry = EMOJI_LIBRARY.find((item) => item.id === libraryId); if (!entry) return { ok: false, error: `Unknown library emoji id ${libraryId}` };
    const visualAsset = await copyLibraryAsset(input.ownerId, input.projectId, `emoji/${entry.fileName}`, `library_emoji_${safe(cueId)}`, entry.fileName, 'image/png', 'overlay');
    const soundtrack = { ...progress.soundtrack, cues: progress.soundtrack.cues.map((item) => item.id === cueId ? { ...item, visualAsset, visualPrompt: `Library emoji: ${entry.emoji} ${entry.label}` } : item) };
    await checkpoint('editing', { soundtrack }, `Attached library emoji ${entry.emoji} (${entry.label}) to ${cueId} instead of generating a new visual.`);
    return { ok: true, approved: true, cueId, assetId: visualAsset.id };
  }});

  const selectLibrarySfx = new FunctionTool({ name: 'select_library_sfx', description: `Replace a pop/laugh_track/sting cue's generated audio with a pre-made stinger from the fixed library — crisper and more reliable than a generated one-shot. Only use an entry whose character genuinely matches the cue and whose type matches the cue's own type; leave the generated audio in place when nothing fits. Call this after generate_editorial_assets has produced the cue. Library (id: type, seconds, description): ${SFX_LIBRARY.map((item) => `${item.id}: ${item.cueType}, ${item.durationSeconds}s, ${item.label}`).join(', ')}`, parameters: librarySelectionSchema, execute: async (toolInput) => { const { cueId, libraryId } = toolInput as { cueId: string; libraryId: string };
    if (!progress.analysis || !progress.soundtrack) return { ok: false, requiredNext: 'generate_editorial_assets' };
    const cue = progress.soundtrack.cues.find((item) => item.id === cueId); if (!cue) return { ok: false, error: `Unknown cue ${cueId}` };
    const entry = SFX_LIBRARY.find((item) => item.id === libraryId); if (!entry) return { ok: false, error: `Unknown library sfx id ${libraryId}` };
    if (entry.cueType !== cue.type) return { ok: false, error: `Library entry ${libraryId} is type ${entry.cueType}, but cue ${cueId} is type ${cue.type}` };
    const asset = await copyLibraryAsset(input.ownerId, input.projectId, `sfx/${entry.fileName}`, `library_sfx_${safe(cueId)}`, entry.fileName, 'audio/mpeg', 'soundtrack');
    const soundtrack = { ...progress.soundtrack, cues: progress.soundtrack.cues.map((item) => item.id === cueId ? { ...item, asset, durationSeconds: entry.durationSeconds, sourceStartSeconds: undefined, sourceEndSeconds: undefined, prompt: `Library sound effect: ${entry.label}` } : item) };
    await checkpoint('editing', { soundtrack }, `Replaced generated audio for ${cueId} with library sound effect "${entry.label}".`);
    return { ok: true, cueId, assetId: asset.id };
  }});

  const fillPacingGap = new FunctionTool({ name: 'fill_pacing_gap', description: `Add a brand-new sticker/sound-effect cue at a timestamp inspect_rendered_draft flagged as a dead pacing stretch (category=pacing issue) — the initial diagnosis's audioCues are otherwise fixed and revisions can only rearrange them, never add to them, so this is the only way to actually fill a gap the reviewer found. Uses a library sound effect for guaranteed-available audio; the sticker visual (if any) is resolved afterward via generate_visual_asset or select_library_emoji like any other cue. Call this during a revision for the most significant flagged gaps (up to 3 total, ever) before calling design_or_revise_edit, using the review's exact flagged timestamps. Library sfx (id: type, seconds, description): ${SFX_LIBRARY.map((item) => `${item.id}: ${item.cueType}, ${item.durationSeconds}s, ${item.label}`).join(', ')}`, parameters: fillPacingGapSchema, execute: async (toolInput) => { const { startSeconds, endSeconds, libraryId, visualGenerationPrompt, calloutText, position, reason } = toolInput as { startSeconds: number; endSeconds: number; libraryId: string; visualGenerationPrompt?: string; calloutText?: string; position?: string; reason: string };
    if (!progress.analysis || !progress.soundtrack) return { ok: false, requiredNext: 'generate_editorial_assets' };
    if (endSeconds <= startSeconds) return { ok: false, error: 'endSeconds must be after startSeconds' };
    const filledSoFar = progress.soundtrack.cues.filter((item) => item.id.startsWith('pacing_fill_')).length;
    if (filledSoFar >= 3) return { ok: false, error: 'Already added the maximum of 3 pacing-gap fills for this project.' };
    const entry = SFX_LIBRARY.find((item) => item.id === libraryId); if (!entry) return { ok: false, error: `Unknown library sfx id ${libraryId}` };
    const cueId = `pacing_fill_${filledSoFar + 1}`;
    const asset = await copyLibraryAsset(input.ownerId, input.projectId, `sfx/${entry.fileName}`, `library_sfx_${safe(cueId)}`, entry.fileName, 'audio/mpeg', 'soundtrack');
    const shared = { id: cueId, startSeconds, endSeconds, type: entry.cueType, purpose: `Fill a reviewer-flagged pacing gap: ${reason}`, mood: 'neutral', energy: .6, dialoguePolicy: 'duck_under_dialogue' as const, visualCompanion: '', visualMode: visualGenerationPrompt?.trim() ? ('sticker' as const) : undefined, position: position as any, effectStyle: 'none' as const, calloutText: calloutText || '', visualGenerationPrompt: visualGenerationPrompt || '' };
    const cue = generatedMusicCueSchema.parse({ ...shared, asset, durationSeconds: entry.durationSeconds, prompt: `Library sound effect: ${entry.label}` });
    const audioCue = editorialAudioCueSchema.parse(shared);
    const analysis = { ...progress.analysis, audioCues: [...progress.analysis.audioCues, audioCue] };
    const soundtrack = { ...progress.soundtrack, cues: [...progress.soundtrack.cues, cue] };
    await checkpoint('editing', { analysis, soundtrack }, `Filled a reviewer-flagged pacing gap at ${startSeconds.toFixed(1)}-${endSeconds.toFixed(1)}s with library sound effect "${entry.label}"${visualGenerationPrompt?.trim() ? ' and a new sticker' : ''}.`);
    return { ok: true, cueId, assetId: asset.id, requiresVisual: Boolean(visualGenerationPrompt?.trim()) };
  }});

  const validateVisualAsset = new FunctionTool({ name: 'validate_visual_asset', description: 'Render a short real preview of this one cue composited into the actual footage and watch it — not just checking the asset file exists. Approve, or get a concrete diagnosis to fix and call generate_visual_asset/select_library_emoji again for the same cue.', parameters: visualValidationSchema, execute: async (toolInput) => { const { cueId } = toolInput as { cueId: string };
    const cue = progress.soundtrack?.cues.find((item) => item.id === cueId);
    if (!cue) return { ok: false, approved: false, error: `Unknown soundtrack cue ${cueId}` };
    if (!cue.visualGenerationPrompt?.trim()) return { ok: true, approved: true, cueId, skipped: true };
    if (!cue.visualAsset) return { ok: true, approved: false, cueId, diagnosis: 'No visual asset was produced. Revise the prompt and call generate_visual_asset again.' };
    const preview = await renderCuePreview({ projectId: input.projectId, ownerId: input.ownerId, sourceUri: input.videoUri, cue });
    const review = await reviewCuePreview({ previewUri: preview.uri, purpose: cue.purpose, visualPrompt: cue.visualGenerationPrompt });
    if (!review.approved) return { ok: true, approved: false, cueId, diagnosis: review.diagnosis };
    return { ok: true, approved: true, cueId, assetId: cue.visualAsset.id, generationModel: cue.visualAsset.generationModel, diagnosis: review.diagnosis };
  }});

  const render = new FunctionTool({ name: 'render_edit_draft', description: 'Execute the current agent-authored edit plan with FFmpeg/Google Cloud and persist a distinct cloud draft. Never call without a current plan and generated assets.', parameters: reasonSchema, execute: async (_reason, toolContext) => {
    if (progress.finalized) return { ok: true, alreadyFinalized: true, iteration, decision: 'pass' };
    if (!progress.analysis) return { ok: false, requiredNext: 'diagnose_source_video' };
    if (!progress.editPlan) return { ok: false, requiredNext: 'design_or_revise_edit' };
    if (!progress.soundtrack) return { ok: false, requiredNext: 'generate_editorial_assets' };
    if (visualCueIds(progress).length) return { ok: false, requiredNext: 'generate_visual_asset', visualCuesRemaining: visualCueIds(progress) };
    // A render that completed but was never watched is not a slot to spend again — design_or_revise_edit
    // always clears finalCut/editorialReview before producing a revision plan, so finding a finalCut here
    // with no editorialReview means the model skipped straight from a successful render back to this tool
    // instead of reviewing it, which would silently burn the whole draft budget with nothing ever recorded
    // into draftHistory for the exhausted-budget recovery to ship.
    if (progress.finalCut && !progress.editorialReview) return { ok: false, requiredNext: 'inspect_rendered_draft', instruction: `Draft ${iteration} already rendered and is waiting to be watched. Call inspect_rendered_draft before rendering again.` };
    // A worker crash or lost lease can interrupt a render after it's submitted (progress.render
    // checkpointed) but before the draft is confirmed complete (progress.finalCut). Resuming that
    // must reattach to the same render — renderFinalCut/renderWithFfmpeg already know how to poll
    // an existing cloud job or reuse an already-uploaded output when handed that checkpoint back —
    // rather than silently starting a duplicate render and burning another of the MAX_DRAFTS slots.
    const resumingRender = Boolean(progress.render) && !progress.finalCut;
    const previousIteration = iteration;
    if (!resumingRender) {
      // Budget spent with nothing to show. design_or_revise_edit has already tried to rescue this
      // (draftHistory, then a Cloud Storage sweep for an orphaned render), so reaching here means
      // there is genuinely nothing to ship and no render left to attempt. This has to END the
      // invocation, not decline politely: a soft `ok: false` sends the model to
      // inspect_rendered_draft, which refuses with requiredNext: 'render_edit_draft', which comes
      // straight back here — a livelock that burns model quota until the lease expires, at which
      // point the recovery scan re-claims the job and starts it over.
      if (iteration >= MAX_DRAFTS) {
        if (await attemptBudgetExhaustedRecovery()) return { ok: true, finalizedFromHistory: true, iteration, decision: 'pass' };
        fatalToolError = new Error(`All ${MAX_DRAFTS} render drafts were used without producing a reviewable cut, and no completed render could be recovered. The pipeline cannot make further progress on this project.`);
        toolContext!.invocationContext.endInvocation = true;
        return { ok: false, fatal: true, draftLimitReached: true, maximumDrafts: MAX_DRAFTS, error: String((fatalToolError as any).message) };
      }
      iteration += 1; await checkpoint('rendering', { editorialIteration: iteration, render: undefined, finalCut: undefined }, `Agent approved the timeline for execution. Rendering draft ${iteration} of ${MAX_DRAFTS}.`);
    } else {
      await checkpoint('rendering', {}, `Reattaching to the in-flight render for draft ${iteration} of ${MAX_DRAFTS} after a worker restart.`);
    }
    let finalCut;
    try {
      finalCut = await renderFinalCut({ projectId: input.projectId, ownerId: input.ownerId, sourceUri: input.videoUri, sourceDurationSeconds: input.durationSeconds, soundtrack: progress.soundtrack, editorialCues: progress.analysis.audioCues, editPlan: progress.editPlan, executionAttempt: (input.executionAttempt || 1) * 10 + iteration, checkpoint: progress.render },
        async (renderCheckpoint) => checkpoint('rendering', { render: renderCheckpoint }, `Draft ${iteration} render submitted; cloud output checkpoint saved.`),
        // Every individual edit reports itself into the live activity feed as it lands, so the render
        // is a visible sequence of applied edits rather than one silent block of time.
        async (message) => checkpoint('rendering', {}, `Draft ${iteration}: ${message}`));
    } catch (error) {
      // A render that failed is not something the model can fix by asking for it again — the same
      // plan and the same assets rebuild the same ffmpeg graph. Letting the failure reach the model
      // as an ordinary tool error meant it simply called this tool again, and each of those calls is
      // minutes of a fully saturated encoder (plus a stall-timeout wait when the graph wedges rather
      // than errors). Give it one retry for a genuinely transient fault, then end the invocation and
      // let the worker's own bounded, backed-off retry own it instead of spinning here.
      renderFailures += 1;
      // Give the slot back. MAX_DRAFTS is a budget for *editorial* iterations — plans a reviewer
      // actually judged — and this render produced nothing to judge. Charging infrastructure
      // failures against it is how a project ends up at draft 3 of 3 having never once rendered,
      // which is unrecoverable: there is no draft to ship and no budget left to make one.
      if (!resumingRender) { iteration = previousIteration; await checkpoint('editing', { editorialIteration: previousIteration }, `Draft ${previousIteration + 1} failed to render and did not consume an editorial draft; ${MAX_DRAFTS - previousIteration} of ${MAX_DRAFTS} remain.`); }
      if (renderFailures < MAX_RENDER_FAILURES) return { ok: false, retryable: true, iteration, renderAttempts: renderFailures, error: String((error as any)?.message || error).slice(0, 500), instruction: 'The render failed. Do not call render_edit_draft again unless you have first changed the plan or the assets it depends on.' };
      fatalToolError = error;
      toolContext!.invocationContext.endInvocation = true;
      return { ok: false, fatal: true, retryableByWorker: true, iteration, renderAttempts: renderFailures, error: String((error as any)?.message || error).slice(0, 500) };
    }
    renderFailures = 0;
    await checkpoint('rendering', { finalCut }, `Draft ${iteration} rendered successfully (${Math.round(finalCut.durationSeconds)} seconds). It is not final until the agent watches and approves it.`);
    return { ok: true, iteration, draftUri: renderedUri(input, finalCut), durationSeconds: finalCut.durationSeconds, provider: finalCut.renderProvider };
  }});

  const review = new FunctionTool({ name: 'inspect_rendered_draft', description: 'Watch the actual cloud-rendered draft alongside the source, diagnose remaining editorial defects, and return pass or timestamped revision requirements. Rendering success is not approval.', parameters: reasonSchema, execute: async () => {
    // Already resolved by design_or_revise_edit shipping the best draft from history after the
    // budget ran out — re-reviewing the same rendered video would just risk a fresh 'revise'
    // verdict overwriting that resolution and reopening a loop with no render budget left to act on it.
    if (progress.finalized && progress.editorialReview) return { ok: true, decision: progress.editorialReview.decision, score: progress.editorialReview.score, summary: progress.editorialReview.summary, issues: progress.editorialReview.issues, draftsRemaining: 0, alreadyFinalized: true };
    if (!progress.analysis || !progress.editPlan || !progress.recommendation || !progress.finalCut) return { ok: false, requiredNext: 'render_edit_draft' };
    await checkpoint('editing', {}, `Editorial agent is now watching rendered draft ${iteration} beside the original source.`);
    const editorialReview = await reviewRenderedDraft({ iteration, sourceUri: input.videoUri, sourceMimeType: input.mimeType || 'video/mp4', draftUri: renderedUri(input, progress.finalCut), analysis: progress.analysis, editPlan: progress.editPlan, recommendation: progress.recommendation });
    const majorIssues = editorialReview.issues.filter((issue) => issue.severity !== 'minor').length;
    // The prompt tells the reviewer decision='revise' should imply a major/blocking issue, but
    // nothing enforces that on its structured output, so it can revise on minor issues or its own
    // rationale alone. Don't claim a major-issue count of 0 as the reason for revision — fall back
    // to the reviewer's own summary so the checkpoint message is never self-contradictory.
    const reviseReason = majorIssues ? `${majorIssues} major/blocking issue${majorIssues === 1 ? '' : 's'} found` : editorialReview.summary || 'reviewer flagged remaining issues';
    // Preserve every reviewed draft (plan + render + its review) even though editPlan/finalCut/
    // editorialReview themselves get overwritten or cleared on the next revision — this is what lets
    // design_or_revise_edit ship the best-scoring draft instead of failing outright if the draft
    // budget runs out before any single one passes.
    const draftHistory = [...(progress.draftHistory || []), { iteration, editPlan: progress.editPlan, finalCut: progress.finalCut, editorialReview }];
    await checkpoint('editing', { editorialReview, draftHistory }, editorialReview.decision === 'pass' ? `Draft ${iteration} passed rendered-video review with a score of ${Math.round(editorialReview.score.total)}.` : `Draft ${iteration} needs revision: ${reviseReason}. Agent will revise the edit.`);
    return { ok: true, decision: editorialReview.decision, score: editorialReview.score, summary: editorialReview.summary, issues: editorialReview.issues, draftsRemaining: MAX_DRAFTS - iteration };
  }});

  const rootAgent = new LlmAgent({
    name: 'dailies_senior_editor',
    description: 'Autonomous senior video editor that diagnoses, edits, renders, watches, and revises creator videos.',
    model: process.env.GEMINI_AGENT_MODEL || process.env.GEMINI_MODEL || 'gemini-3-flash-preview',
    instruction: `You are the senior editorial agent responsible for the finished Dailies video—not a passive pipeline router. Your goal is a pithy, engaging YouTube cut that materially improves the source while preserving truth, personality, and dialogue continuity.
Use tools and inspect their results. Required lifecycle: diagnose the entire source; load optional creator evidence; design an edit; generate the justified soundtrack; for every justified visual cue call either select_library_emoji (when a library entry genuinely matches) or generate_visual_asset followed by validate_visual_asset, revising and looping until each is approved; optionally call select_library_sfx to swap a pop/laugh_track/sting cue's generated audio for a crisper pre-made one when a library entry genuinely fits; render a cloud draft; watch that rendered draft; then either pass it or revise and repeat. Prefer the fixed library over generation whenever an entry is a genuine match — it is faster and more reliable — but never force a mismatched library asset onto a cue merely to skip generation. Never claim completion before inspect_rendered_draft returns decision=pass. A successful render is only a draft. When review says revise, first call fill_pacing_gap for the most significant category=pacing dead-stretch issues it flagged (up to 3 total across the whole project — the original diagnosis's cues are otherwise fixed and design_or_revise_edit can only rearrange them, never add to them), resolve each new cue's visual the same way as any other, then call design_or_revise_edit using the full critique, render a distinct new draft, and inspect it again. You have at most ${MAX_DRAFTS} drafts; prioritize all blocking and major issues.
Editorial rules: maximize story and entertainment value per second without imposing a duration ratio. Protect the main story, personality, useful context, evidence, and payoff. Remove diagnosed repetition, dead talking, mildly unrelated tangents, coughs, sniffles, stutters, false starts, verbal resets, and routine actions that do not earn their time. A long source may remain long when the footage is valuable. Clean dialogue is the default; retain 1x narration at full source level; mute source only inside deliberate music-led intro/outro, montage, or fast-forward intervals; never use an unexplained continuous music bed. Use contextual intro/outro visuals, timed product/feature cards, emoji/reaction accents, and paired sound effects where the material earns them. Apply consistent white-noise cleanup when diagnosed. Creator analytics are evidence, never a requirement and never a substitute for watching the source and draft.
Process footage requires format-aware judgment. In a tutorial or how-it-is-made video, preserve the steps and explanatory narration at a learnable pace. In a story, haul, review, or reveal-led video, preserve meaningful before/result anchors but an otherwise repetitive non-instructional process may become a music-led montage. A low-change, single-setting montage should normally produce about 5-10 seconds of final footage; allow more only when distinct visual beats, scenery changes, or a setup-to-result mini-arc keep earning attention. Choose the slowest speed that reaches that earned duration and keeps the motion readable—often 10× is enough; 100× is only the ceiling for rare, exceptionally repetitive passages. Delete it when neither the process nor outcome earns time.
Current durable state: ${JSON.stringify(progressSummary(progress))}`,
    tools: [diagnose, creatorEvidence, plan, assets, generateVisualAsset, selectLibraryEmoji, selectLibrarySfx, fillPacingGap, validateVisualAsset, render, review],
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
    if (fatalToolError) {
      // Even a genuinely fatal tool error (a render that's failed twice, a budget exhausted with
      // nothing to ship at the time) can become recoverable once every checkpoint from this same
      // invocation has landed — attempt the same deterministic recovery here before letting the
      // whole project fail, rather than only ever trying it from inside the tool call itself.
      if (progress.analysis && progress.recommendation && await attemptBudgetExhaustedRecovery()) break;
      throw fatalToolError;
    }
  }
  // The model may stop calling tools entirely and just narrate a status report instead of finishing
  // the lifecycle (that report is what ends up as finalMessage below) — it must not get to bypass the
  // same budget-exhausted recovery a well-behaved model would have triggered via design_or_revise_edit.
  if ((!progress.finalCut || progress.editorialReview?.decision !== 'pass') && progress.analysis && progress.recommendation) await attemptBudgetExhaustedRecovery();
  if (!progress.analysis || !progress.soundtrack || !progress.recommendation || !progress.editPlan || !progress.finalCut || progress.editorialReview?.decision !== 'pass') throw new Error(`Editorial agent stopped without an approved rendered draft${finalMessage ? `: ${finalMessage.slice(0, 300)}` : ''}`);
  return { analysis: progress.analysis, soundtrack: progress.soundtrack, recommendation: progress.recommendation, editPlan: progress.editPlan, finalCut: progress.finalCut, editorialReview: progress.editorialReview };
}

const reasonSchema = { type: Type.OBJECT, required: ['reason'], properties: { reason: { type: Type.STRING, description: 'Why this tool is the correct next editorial action.' } } };
const visualAssetSchema = { type: Type.OBJECT, required: ['cueId', 'reason'], properties: { cueId: { type: Type.STRING, description: 'The exact diagnosed cue ID to generate.' }, reason: { type: Type.STRING, description: 'The agent diagnosis and revised image-generation direction.' } } };
const visualValidationSchema = { type: Type.OBJECT, required: ['cueId'], properties: { cueId: { type: Type.STRING, description: 'The exact cue ID to validate.' } } };
const librarySelectionSchema = { type: Type.OBJECT, required: ['cueId', 'libraryId', 'reason'], properties: { cueId: { type: Type.STRING, description: 'The exact cue ID to attach this library asset to.' }, libraryId: { type: Type.STRING, description: 'The exact library entry id.' }, reason: { type: Type.STRING, description: 'Why this specific library entry genuinely matches the cue.' } } };
const fillPacingGapSchema = { type: Type.OBJECT, required: ['startSeconds', 'endSeconds', 'libraryId', 'reason'], properties: {
  startSeconds: { type: Type.NUMBER, description: 'Start of the reviewer-flagged pacing gap, in source seconds.' },
  endSeconds: { type: Type.NUMBER, description: 'End of the reviewer-flagged pacing gap, in source seconds.' },
  libraryId: { type: Type.STRING, description: 'The exact library sound-effect id to anchor this moment.' },
  visualGenerationPrompt: { type: Type.STRING, description: 'A complete Gemini Image prompt for a small sticker at this moment, or omit for audio-only.' },
  calloutText: { type: Type.STRING, description: 'Short on-screen text for the sticker, 24 characters max, or omit.' },
  position: { type: Type.STRING, enum: ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'], description: 'Rule-of-thirds zone for the sticker.' },
  reason: { type: Type.STRING, description: 'What is actually happening on screen at this exact timestamp that earns an accent here.' },
} };
const progressSummary = (progress: NonNullable<Project['progress']>) => ({ hasAnalysis: Boolean(progress.analysis), hasCreatorEvidence: Boolean(progress.recommendation), hasAssets: Boolean(progress.soundtrack), hasEditPlan: Boolean(progress.editPlan), hasDraft: Boolean(progress.finalCut), reviewDecision: progress.editorialReview?.decision, editorialIteration: progress.editorialIteration || 0 });
const visualCueIds = (progress: NonNullable<Project['progress']>) => (progress.soundtrack?.cues || []).filter((cue) => cue.visualGenerationPrompt?.trim() && !cue.visualAsset).map((cue) => cue.id);
const bestDraft = (history?: DraftHistoryEntry[]): DraftHistoryEntry | undefined => history?.length ? history.reduce((best, entry) => entry.editorialReview.score.total > best.editorialReview.score.total ? entry : best) : undefined;
// Last-resort recovery when draftHistory itself is unavailable: a render's output path
// (ownerId/projectId/render_<id>/enhanced-final-cut.mp4) is deterministic and outlives whatever
// Firestore progress does or doesn't still point at it, so a finished file there is proof of real,
// already-completed rendering work — reconcile against it rather than treat it as unrecoverable.
async function findLatestOrphanedRender(ownerId: string, projectId: string) {
  const storage = new Storage({ projectId: required('GCP_PROJECT_ID') }).bucket(required('GCS_BUCKET'));
  const [files] = await storage.getFiles({ prefix: `${ownerId}/${projectId}/render_` });
  const finished = files.filter((file) => file.name.endsWith('/enhanced-final-cut.mp4'));
  if (!finished.length) return undefined;
  finished.sort((a, b) => String(b.metadata.timeCreated || '').localeCompare(String(a.metadata.timeCreated || '')));
  const latest = finished[0]; const segments = latest.name.split('/');
  return { assetId: segments[segments.length - 2], fileName: 'enhanced-final-cut.mp4', sizeBytes: Number(latest.metadata.size || 0), createdAt: String(latest.metadata.timeCreated || new Date().toISOString()) };
}
const renderedUri = (input: JobInput, finalCut: NonNullable<Project['progress']>['finalCut']) => `gs://${required('GCS_BUCKET')}/${input.ownerId}/${input.projectId}/${finalCut!.asset.id}/${finalCut!.asset.fileName}`;
const safe = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 72);
// Library assets live once under a shared, non-project GCS prefix (see library.ts). Selecting one
// for a cue copies it into that project's own asset path — the same ownerId/projectId/assetId shape
// every other asset already uses — so rendering, asset-serving, and everything downstream needs zero
// changes to understand it; a selected library asset is indistinguishable from a generated one.
async function copyLibraryAsset(ownerId: string, projectId: string, libraryRelativePath: string, assetId: string, fileName: string, mimeType: string, kind: 'overlay' | 'soundtrack') {
  const bucket = new Storage({ projectId: required('GCP_PROJECT_ID') }).bucket(required('GCS_BUCKET'));
  const destination = bucket.file(`${ownerId}/${projectId}/${assetId}/${fileName}`);
  await bucket.file(`${LIBRARY_GCS_PREFIX}/${libraryRelativePath}`).copy(destination);
  const [metadata] = await destination.getMetadata();
  return { id: assetId, kind, fileName, mimeType, sizeBytes: Number(metadata.size || 0), generationModel: 'asset-library', createdAt: new Date().toISOString() };
}
const configureVertexEnvironment = () => { process.env.GOOGLE_GENAI_USE_VERTEXAI ||= 'true'; process.env.GOOGLE_CLOUD_PROJECT ||= required('GCP_PROJECT_ID'); process.env.GOOGLE_CLOUD_LOCATION ||= process.env.VERTEX_LOCATION || 'global'; };
const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; };
