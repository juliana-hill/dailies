import { describe, expect, it } from 'vitest'; import { PNG } from 'pngjs'; import { extractAudio, extractImage, hasTransparentBackground, isContentBlocked, selectLyriaModel } from './scoreAgent.js'; import { buildCorrelationQuery, queryRetention, recommendationFromRows, rowsFromMcpText } from './retentionAgent.js';
import { isQuotaLimited, isRetryable } from './server.js';
import { editPlanSchema } from '@dailies/shared';
import { buildFilterComplex, requiresFfmpeg } from './ffmpegRenderer.js';
import { validateContentRemovals, validateExtremeMontages, validateTimeline } from './editingAgent.js';
import { missingRequiredVisualMoments, normalizeAnalysisTimestamps } from './analysisAgent.js';
import { resolveCreatorRecommendation } from './orchestrator.js';

describe('agent integrations', () => {
  it('handles Lyria 3 output', () => expect(extractAudio({ outputs: [{ type: 'audio', data: Buffer.from('audio').toString('base64'), mime_type: 'audio/mpeg' }] }).bytes.toString()).toBe('audio'));
  it('recognizes Lyria policy blocks that require a Gemini prompt revision', () => { expect(isContentBlocked('{"code":"content_blocked"}')).toBe(true); expect(isContentBlocked('Request blocked for an unspecified policy reason')).toBe(true); expect(isContentBlocked('quota exceeded')).toBe(false); });
  it('uses Lyria Clip for short music and effects and reserves Pro for long compositions', () => {
    const cue = { startSeconds: 0, endSeconds: 4 } as any;
    expect(selectLyriaModel({ ...cue, type: 'music' })).toBe('lyria-3-clip-preview');
    expect(selectLyriaModel({ ...cue, type: 'pop' })).toBe('lyria-3-clip-preview');
    expect(selectLyriaModel({ ...cue, endSeconds: 31, type: 'music' })).toBe('lyria-3-pro-preview');
  });
  it('handles Gemini Image output', () => expect(extractImage({ candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from('image').toString('base64'), mimeType: 'image/png' } }] } }] }).bytes.toString()).toBe('image'));
  it('accepts genuine PNG alpha transparency and rejects opaque checkerboard-capable pixels', () => {
    const transparent = new PNG({ width: 4, height: 4 }); transparent.data.fill(0); transparent.data[4 * (4 + 1) + 3] = 255;
    const opaque = new PNG({ width: 4, height: 4 }); opaque.data.fill(255);
    expect(hasTransparentBackground(PNG.sync.write(transparent), 'image/png')).toBe(true);
    expect(hasTransparentBackground(PNG.sync.write(opaque), 'image/png')).toBe(false);
    expect(hasTransparentBackground(PNG.sync.write(transparent), 'image/jpeg')).toBe(false);
  });
  it('builds a normalized read query', () => { const query = buildCorrelationQuery('owner', 100); expect(query).toContain('position_ratio'); expect(query).not.toContain('INSERT'); });
  it('reads the ClickHouse MCP columns-and-rows response envelope', () => { const rows = rowsFromMcpText(JSON.stringify({ columns: [{ name: 'position_ratio' }], rows: [{ position_ratio: .42 }] })); expect(rows).toEqual([{ position_ratio: .42 }]); });
  it('maps ClickHouse MCP positional rows to their column names', () => { expect(rowsFromMcpText(JSON.stringify({ columns: ['position_ratio', 'severity_percent'], rows: [[.42, 18]] }))).toEqual([{ position_ratio: .42, severity_percent: 18 }]); });
  it('labels inference without events', () => expect(recommendationFromRows([{ position_ratio: .42, target_seconds: 42, severity_percent: 18, supporting_video_ids: ['a','b'], video_id: 'a', title: 'A', duration_seconds: 100, position_seconds: 42, nearby_events: [] }]).inferredCause).toContain('cannot be inferred'));
  it('continues without creator history when ClickHouse is not configured', async () => { const previous = process.env.CLICKHOUSE_MCP_URL; delete process.env.CLICKHOUSE_MCP_URL; try { const result = await queryRetention('owner', 30); expect(result.observedEvidence).toContain('No synchronized YouTube'); expect(result.recommendationText).toContain('optional'); } finally { if (previous) process.env.CLICKHOUSE_MCP_URL = previous; } });
  it('does not call the retention service when YouTube is not connected', async () => { let calls = 0; const result = await resolveCreatorRecommendation('owner', 30, false, async () => { calls += 1; throw new Error('Retention service must not be called'); }); expect(calls).toBe(0); expect(result.observedEvidence).toContain('No synchronized YouTube'); });
  it('retries transient service failures but not invalid configuration', () => { expect(isRetryable(new Error('fetch failed: ECONNRESET'))).toBe(true); expect(isRetryable(new Error('Lyria request failed with HTTP 429: quota exceeded'))).toBe(true); expect(isRetryable(new Error('Lyria request failed with HTTP 503'))).toBe(true); expect(isRetryable(new Error('CLICKHOUSE_MCP_URL is required'))).toBe(false); expect(isRetryable(new Error('Gemini project id mismatch'))).toBe(false); });
  it('keeps quota exhaustion in a durable capacity-wait state', () => { expect(isQuotaLimited(new Error('{"status":"RESOURCE_EXHAUSTED"}'))).toBe(true); expect(isQuotaLimited(new Error('HTTP 429'))).toBe(true); expect(isQuotaLimited(new Error('HTTP 503'))).toBe(false); });
  it('requires content-based removal without imposing a duration ratio', () => {
    const analysis = { projectId: 'p', durationSeconds: 1200, scenes: [{ id: 's', startSeconds: 0, endSeconds: 1200, summary: 'story', transcript: '', mood: 'clear', energy: .5, pacingFlags: [] }], soundtrackBrief: { mood: 'none', tempo: 'none', instrumentation: 'none', prompt: 'No music.' }, soundtrackSegments: [], audioCues: [], editingSignals: [{ id: 'cough', startSeconds: 20, endSeconds: 21, type: 'disfluency' as const, confidence: .95, detail: 'Cough interrupts sentence.', suggestedAction: 'Remove the cough and close the sentence.' }] };
    const retained = editPlanSchema.parse({ projectId: 'p', rationale: 'Bad.', segments: [{ id: 'all', sourceStartSeconds: 0, sourceEndSeconds: 1200, action: 'keep', reason: 'Keep everything.' }] });
    const cleaned = editPlanSchema.parse({ projectId: 'p', rationale: 'Clean.', segments: [{ id: 'before', sourceStartSeconds: 0, sourceEndSeconds: 20, action: 'keep', reason: 'Story.' }, { id: 'cough', sourceStartSeconds: 20, sourceEndSeconds: 21, action: 'remove', reason: 'Cough.' }, { id: 'after', sourceStartSeconds: 21, sourceEndSeconds: 1200, action: 'keep', reason: 'Story.' }] });
    expect(() => validateContentRemovals(retained, analysis)).toThrow('high-confidence disfluency');
    expect(() => validateContentRemovals(cleaned, analysis)).not.toThrow();
  });

  it('renders fast-forward, cleanup, color treatment, a timed music cue, and loudness normalization', () => {
    const plan = editPlanSchema.parse({
      projectId: 'project-1', rationale: 'Make the action compact.', originalAudioGainDb: 0, soundtrackGainDb: -18,
      audioCleanup: { reduceNoise: true, removeHum: true, highPassHz: 80, targetLufs: -14 },
      segments: [
        { id: 'dialogue', sourceStartSeconds: 0, sourceEndSeconds: 5, action: 'keep', playbackRate: 1, originalAudioGainDb: 0, soundtrackGainDb: -24, transition: 'cut', reason: 'Clear speech.' },
        { id: 'action', sourceStartSeconds: 5, sourceEndSeconds: 21, action: 'fast_forward', playbackRate: 4, originalAudioGainDb: -96, soundtrackGainDb: -10, transition: 'cut', visualTreatment: { brightness: .05, contrast: .1, saturation: .08, temperature: .04 }, reason: 'Compress repetitive action.' },
      ],
    });
    validateTimeline(plan, 21);
    const built = buildFilterComplex(plan, [{ id: 'music-1', startSeconds: 5, endSeconds: 21, type: 'music', purpose: 'Build momentum through the fast-forward.', mood: 'playful', energy: .8, gainDb: -10, fadeInSeconds: .5, fadeOutSeconds: .75, dialoguePolicy: 'replace_source_audio', visualCompanion: '', asset: { id: 'asset-1', kind: 'soundtrack', fileName: 'cue.mp3', mimeType: 'audio/mpeg', createdAt: new Date().toISOString() }, durationSeconds: 10, prompt: 'Playful momentum cue.' }]);
    expect(requiresFfmpeg(plan)).toBe(true);
    expect(built.durationSeconds).toBe(9);
    expect(built.filter).toContain('setpts=(PTS-STARTPTS)/4');
    expect(built.filter).toContain('[asrc1]anullsink');
    expect(built.filter).toContain('anullsrc=r=48000:cl=stereo,atrim=duration=4');
    expect(built.filter).not.toContain('[asrc1]atrim');
    expect(built.filter).toContain('afftdn=nr=10:nf=-35');
    expect(built.filter).toContain('equalizer=f=60');
    expect(built.filter).toContain('eq=brightness=0.05:contrast=1.1:saturation=1.08');
    expect(built.filter).toContain('[1:a]atrim=0:4');
    expect(built.filter).toContain('adelay=5000:all=1');
    expect(built.filter).not.toContain('loudnorm=');
    expect(built.filter).toContain('alimiter=limit=0.95');
  });

  it('supports an analysis-grounded 100x process montage with silent source audio', () => {
    const plan = editPlanSchema.parse({
      projectId: 'project-1', rationale: 'Preserve the transformation without showing every repetitive motion.', targetDurationSeconds: 16,
      segments: [
        { id: 'setup', sourceStartSeconds: 0, sourceEndSeconds: 3, action: 'keep', playbackRate: 1, originalAudioGainDb: 0, reason: 'Explain the setup.' },
        { id: 'build', sourceStartSeconds: 3, sourceEndSeconds: 1003, action: 'fast_forward', playbackRate: 100, originalAudioGainDb: -96, reason: 'Show the necessary construction as a montage.' },
        { id: 'result', sourceStartSeconds: 1003, sourceEndSeconds: 1006, action: 'keep', playbackRate: 1, originalAudioGainDb: 0, reason: 'Show the result.' },
      ],
    });
    const analysis = {
      editingSignals: [{ id: 'process', startSeconds: 3, endSeconds: 1003, type: 'montage', confidence: .95, detail: 'Long non-instructional build.', suggestedAction: 'Compress while preserving transformation.' }],
      audioCues: [{ id: 'build-music', startSeconds: 3, endSeconds: 1003, type: 'music', dialoguePolicy: 'replace_source_audio' }],
    } as any;
    expect(() => validateTimeline(plan, 1006)).not.toThrow();
    expect(() => validateExtremeMontages(plan, analysis)).not.toThrow();
    const built = buildFilterComplex(plan);
    expect(built.durationSeconds).toBe(16);
    expect(built.filter).toContain('setpts=(PTS-STARTPTS)/100');
    expect(built.filter).toContain('anullsrc=r=48000:cl=stereo,atrim=duration=10');
    expect(built.filter).not.toContain('atempo=2');
  });

  it('rejects 100x treatment when a process is not diagnosed and scored for montage music', () => {
    const plan = editPlanSchema.parse({ projectId: 'project-1', rationale: 'Unsupported acceleration.', segments: [{ id: 'rushed', sourceStartSeconds: 0, sourceEndSeconds: 100, action: 'fast_forward', playbackRate: 100, originalAudioGainDb: -96, reason: 'Rush it.' }] });
    expect(() => validateExtremeMontages(plan, { editingSignals: [], audioCues: [] } as any)).toThrow('lacks diagnosed process-montage evidence');
  });

  it('keeps the entire output music-free when analysis provides no music cues', () => {
    const plan = editPlanSchema.parse({ projectId: 'project-1', rationale: 'Dialogue needs no score.', segments: [{ id: 'dialogue', sourceStartSeconds: 0, sourceEndSeconds: 8, action: 'keep', soundtrackGainDb: -96, reason: 'Clear speech.' }] });
    const built = buildFilterComplex(plan, []);
    expect(built.filter).not.toContain('[1:a]');
    expect(built.filter).toContain('[dialogue]aresample=48000');
    expect(built.filter).not.toContain('highpass=');
    expect(built.filter).toContain('aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo[aout]');
  });

  it('always pairs a rendered visual callout with an audible effect track', () => {
    const plan = editPlanSchema.parse({ projectId: 'project-1', rationale: 'Celebrate the reveal.', segments: [{ id: 'reveal', sourceStartSeconds: 0, sourceEndSeconds: 8, action: 'keep', reason: 'Feature reveal.' }] });
    const editorial = { id: 'reveal-pop', startSeconds: 2, endSeconds: 3, type: 'pop' as const, purpose: 'feature reveal', mood: 'bright', energy: .7, gainDb: -3, fadeInSeconds: 0, fadeOutSeconds: .2, dialoguePolicy: 'duck_under_dialogue' as const, visualCompanion: 'new_feature', effectStyle: 'soft_pop' as const, calloutText: 'Meet the dashboard' };
    const generated = { ...editorial, asset: { id: 'lyria-reveal', kind: 'soundtrack' as const, fileName: 'generated-pop.mp3', mimeType: 'audio/mpeg', createdAt: new Date().toISOString() }, visualAsset: { id: 'gemini-reveal', kind: 'overlay' as const, fileName: 'generated-overlay.png', mimeType: 'image/png', createdAt: new Date().toISOString() }, durationSeconds: 30, prompt: 'Original warm feature accent.' };
    const built = buildFilterComplex(plan, [generated], [editorial]);
    expect(built.filter).toContain('[2:v]scale=');
    expect(built.filter).toContain("overlay=x='if(lt(t,");
    expect(built.filter).not.toContain('drawtext=');
    expect(built.filter).not.toContain('drawbox=');
    expect(built.filter).not.toContain('sine=frequency');
    expect(built.filter).toContain('[1:a]atrim=0:1');
    expect(built.filter).not.toContain('volume=0.32');
    expect(built.filter).not.toContain('dialogueduck');
    expect(built.filter).toContain('normalize=0');
  });

  it('renders music-led full-frame transitions and mutes source audio only inside their mapped ranges', () => {
    const plan = editPlanSchema.parse({ projectId: 'project-1', rationale: 'Open with a designed title and finish with an end card.', segments: [{ id: 'all', sourceStartSeconds: 0, sourceEndSeconds: 12, action: 'keep', originalAudioGainDb: 0, reason: 'Preserve the performance.' }] });
    const editorial = { id: 'cold-open', startSeconds: 0, endSeconds: 2.5, type: 'music' as const, purpose: 'music-led title sequence', mood: 'warm', energy: .7, gainDb: -4, fadeInSeconds: .1, fadeOutSeconds: .25, dialoguePolicy: 'replace_source_audio' as const, visualCompanion: 'custom title artwork', visualMode: 'full_frame' as const, effectStyle: 'celebration_swell' as const, calloutText: '', generationPrompt: 'Create a warm short instrumental cold-open cue.', visualGenerationPrompt: 'Create a polished full-frame title composition.' };
    const generated = { ...editorial, asset: { id: 'lyria-intro', kind: 'soundtrack' as const, fileName: 'intro.mp3', mimeType: 'audio/mpeg', createdAt: new Date().toISOString() }, visualAsset: { id: 'gemini-intro', kind: 'overlay' as const, fileName: 'intro.png', mimeType: 'image/png', createdAt: new Date().toISOString() }, durationSeconds: 30, prompt: 'Warm intro.' };
    const built = buildFilterComplex(plan, [generated], [editorial]);
    expect(built.filter).toContain('[2:v][vjoined]scale2ref=w=main_w:h=main_h');
    expect(built.filter).toContain("[dialoguebase]volume='if(gt(between(t,0,2.5),0),0,1)':eval=frame[dialogue]");
    expect(built.filter).toContain('[1:a]atrim=0:2.5');
    expect(built.filter).not.toContain('volume=0.32');
  });

  it('rejects a visual effect without its Lyria-generated audio asset', () => {
    const plan = editPlanSchema.parse({ projectId: 'project-1', rationale: 'Reveal.', segments: [{ id: 'reveal', sourceStartSeconds: 0, sourceEndSeconds: 8, action: 'keep', reason: 'Feature reveal.' }] });
    expect(() => buildFilterComplex(plan, [], [{ id: 'missing', startSeconds: 2, endSeconds: 3, type: 'pop', purpose: 'feature reveal', mood: 'warm', energy: .6, gainDb: -3, fadeInSeconds: 0, fadeOutSeconds: .2, dialoguePolicy: 'duck_under_dialogue', visualCompanion: 'feature' }])).toThrow('requires its Lyria-generated audio asset');
  });

  it('rejects a visual effect without its Gemini-generated image asset', () => {
    const plan = editPlanSchema.parse({ projectId: 'project-1', rationale: 'Reveal.', segments: [{ id: 'reveal', sourceStartSeconds: 0, sourceEndSeconds: 8, action: 'keep', reason: 'Feature reveal.' }] });
    const cue = { id: 'missing-visual', startSeconds: 2, endSeconds: 3, type: 'pop' as const, purpose: 'feature reveal', mood: 'warm', energy: .6, gainDb: -3, fadeInSeconds: 0, fadeOutSeconds: .2, dialoguePolicy: 'duck_under_dialogue' as const, visualCompanion: 'feature' };
    const generated = { ...cue, asset: { id: 'lyria', kind: 'soundtrack' as const, fileName: 'effect.mp3', mimeType: 'audio/mpeg', createdAt: new Date().toISOString() }, durationSeconds: 30, prompt: 'Warm effect' };
    expect(() => buildFilterComplex(plan, [generated], [cue])).toThrow('requires its Gemini-generated image asset');
  });

  it('rejects a fast-forward segment that leaves source dialogue audible', () => {
    const plan = editPlanSchema.parse({ projectId: 'project-1', rationale: 'Invalid test.', segments: [{ id: 'bad', sourceStartSeconds: 0, sourceEndSeconds: 8, action: 'fast_forward', playbackRate: 4, originalAudioGainDb: 0, reason: 'Bad mix.' }] });
    expect(() => validateTimeline(plan, 8)).toThrow('must accelerate and fully mute source audio');
  });

  it('rejects lowering retained dialogue to feature an added effect', () => {
    const plan = editPlanSchema.parse({ projectId: 'project-1', rationale: 'Invalid mix.', segments: [{ id: 'dialogue', sourceStartSeconds: 0, sourceEndSeconds: 8, action: 'keep', playbackRate: 1, originalAudioGainDb: -6, reason: 'Wrongly duck dialogue.' }] });
    expect(() => validateTimeline(plan, 8)).toThrow('must preserve source audio at 0 dB');
  });

  it('safely renders a persisted dissolve plan as a precise cut', () => {
    const plan = editPlanSchema.parse({ projectId: 'project-1', rationale: 'Legacy transition.', segments: [{ id: 'legacy', sourceStartSeconds: 0, sourceEndSeconds: 8, action: 'keep', transition: 'dissolve', reason: 'Previously checkpointed plan.' }] });
    expect(() => buildFilterComplex(plan)).not.toThrow();
  });

  it('repairs point and out-of-bounds model timestamps before contract validation', () => {
    const normalized = normalizeAnalysisTimestamps({
      scenes: [{ startSeconds: -2, endSeconds: 155 }],
      soundtrackSegments: [{ startSeconds: 154.8, endSeconds: 200 }],
      audioCues: [{ startSeconds: 30, endSeconds: 30 }],
      editingSignals: [{ startSeconds: 30, endSeconds: 30 }, { startSeconds: 200, endSeconds: 200 }],
    }, 154.579002);
    expect(normalized.scenes[0]).toMatchObject({ startSeconds: 0, endSeconds: 154.579002 });
    expect(normalized.soundtrackSegments[0].endSeconds).toBe(154.579002);
    expect(normalized.audioCues[0]).toMatchObject({ startSeconds: 30, endSeconds: 30.5 });
    expect(normalized.editingSignals[0]).toMatchObject({ startSeconds: 30, endSeconds: 30.5 });
    expect(normalized.editingSignals[1]).toMatchObject({ startSeconds: 154.079002, endSeconds: 154.579002 });
  });

  it('requires generated visual coverage for the intro, major reveal, and exit', () => {
    const cue = (id: string, startSeconds: number, endSeconds: number) => ({ id, startSeconds, endSeconds, type: 'pop' as const, purpose: id, mood: 'warm', energy: .6, gainDb: -8, fadeInSeconds: .1, fadeOutSeconds: .2, dialoguePolicy: 'no_dialogue' as const, visualCompanion: id, generationPrompt: 'Generate a warm original musical accent.', visualGenerationPrompt: 'Generate an isolated transparent contextual emoji.' });
    const analysis = { projectId: 'p', durationSeconds: 100, scenes: [{ id: 's', startSeconds: 0, endSeconds: 100, summary: 'demo', transcript: '', mood: 'clear', energy: .5, pacingFlags: [] }], soundtrackBrief: { mood: 'clean', tempo: 'none', instrumentation: 'none', prompt: 'Sparse.' }, soundtrackSegments: [], audioCues: [cue('intro', 2, 3), cue('reveal', 49, 51), cue('exit', 91, 93)], editingSignals: [{ id: 'r', startSeconds: 50, endSeconds: 51, type: 'reveal' as const, confidence: .9, detail: 'Feature reveal', suggestedAction: 'Celebrate it.' }] };
    expect(missingRequiredVisualMoments(analysis)).toEqual([]);
    expect(missingRequiredVisualMoments({ ...analysis, audioCues: [cue('reveal', 49, 51)] })).toEqual(['opening hook visual treatment', 'closing payoff or CTA visual treatment']);
  });
});
