import { describe, expect, it } from 'vitest'; import { extractAudio } from './scoreAgent.js'; import { buildCorrelationQuery, queryRetention, recommendationFromRows, rowsFromMcpText } from './retentionAgent.js';
import { isRetryable } from './server.js';
import { editPlanSchema } from '@dailies/shared';
import { buildFilterComplex, requiresFfmpeg } from './ffmpegRenderer.js';
import { validateTimeline } from './editingAgent.js';
import { normalizeAnalysisTimestamps } from './analysisAgent.js';
import { resolveCreatorRecommendation } from './orchestrator.js';

describe('agent integrations', () => {
  it('handles Lyria 3 output', () => expect(extractAudio({ outputs: [{ type: 'audio', data: Buffer.from('audio').toString('base64'), mime_type: 'audio/mpeg' }] }).bytes.toString()).toBe('audio'));
  it('builds a normalized read query', () => { const query = buildCorrelationQuery('owner', 100); expect(query).toContain('position_ratio'); expect(query).not.toContain('INSERT'); });
  it('reads the ClickHouse MCP columns-and-rows response envelope', () => { const rows = rowsFromMcpText(JSON.stringify({ columns: [{ name: 'position_ratio' }], rows: [{ position_ratio: .42 }] })); expect(rows).toEqual([{ position_ratio: .42 }]); });
  it('maps ClickHouse MCP positional rows to their column names', () => { expect(rowsFromMcpText(JSON.stringify({ columns: ['position_ratio', 'severity_percent'], rows: [[.42, 18]] }))).toEqual([{ position_ratio: .42, severity_percent: 18 }]); });
  it('labels inference without events', () => expect(recommendationFromRows([{ position_ratio: .42, target_seconds: 42, severity_percent: 18, supporting_video_ids: ['a','b'], video_id: 'a', title: 'A', duration_seconds: 100, position_seconds: 42, nearby_events: [] }]).inferredCause).toContain('cannot be inferred'));
  it('continues without creator history when ClickHouse is not configured', async () => { const previous = process.env.CLICKHOUSE_MCP_URL; delete process.env.CLICKHOUSE_MCP_URL; try { const result = await queryRetention('owner', 30); expect(result.observedEvidence).toContain('No synchronized YouTube'); expect(result.recommendationText).toContain('optional'); } finally { if (previous) process.env.CLICKHOUSE_MCP_URL = previous; } });
  it('does not call the retention service when YouTube is not connected', async () => { let calls = 0; const result = await resolveCreatorRecommendation('owner', 30, false, async () => { calls += 1; throw new Error('Retention service must not be called'); }); expect(calls).toBe(0); expect(result.observedEvidence).toContain('No synchronized YouTube'); });
  it('retries transient service failures but not invalid configuration', () => { expect(isRetryable(new Error('fetch failed: ECONNRESET'))).toBe(true); expect(isRetryable(new Error('Lyria request failed with HTTP 503'))).toBe(true); expect(isRetryable(new Error('CLICKHOUSE_MCP_URL is required'))).toBe(false); expect(isRetryable(new Error('Gemini project id mismatch'))).toBe(false); });

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
    expect(built.filter).toContain('atempo=2,atempo=2');
    expect(built.filter).toContain('afftdn=nr=10:nf=-35');
    expect(built.filter).toContain('equalizer=f=60');
    expect(built.filter).toContain('eq=brightness=0.05:contrast=1.1:saturation=1.08');
    expect(built.filter).toContain('[1:a]atrim=0:4');
    expect(built.filter).toContain('adelay=5000:all=1');
    expect(built.filter).toContain('loudnorm=I=-14');
  });

  it('keeps the entire output music-free when analysis provides no music cues', () => {
    const plan = editPlanSchema.parse({ projectId: 'project-1', rationale: 'Dialogue needs no score.', segments: [{ id: 'dialogue', sourceStartSeconds: 0, sourceEndSeconds: 8, action: 'keep', soundtrackGainDb: -96, reason: 'Clear speech.' }] });
    const built = buildFilterComplex(plan, []);
    expect(built.filter).not.toContain('[1:a]');
    expect(built.filter).toContain('[dialogue]loudnorm=I=-14');
    expect(built.filter).toContain('aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo[aout]');
  });

  it('always pairs a rendered visual callout with an audible effect track', () => {
    const plan = editPlanSchema.parse({ projectId: 'project-1', rationale: 'Celebrate the reveal.', segments: [{ id: 'reveal', sourceStartSeconds: 0, sourceEndSeconds: 8, action: 'keep', reason: 'Feature reveal.' }] });
    const built = buildFilterComplex(plan, [], [{ id: 'reveal-pop', startSeconds: 2, endSeconds: 3, type: 'pop', purpose: 'feature reveal', mood: 'bright', energy: .7, gainDb: -15, fadeInSeconds: 0, fadeOutSeconds: .2, dialoguePolicy: 'duck_under_dialogue', visualCompanion: 'new_feature' }]);
    expect(built.filter).toContain("drawtext=text='✦ NEW!'");
    expect(built.filter).toContain('sine=frequency=880');
    expect(built.filter).toContain('[fx0]');
    expect(built.filter).toContain('normalize=0');
  });

  it('rejects a fast-forward segment that leaves source dialogue audible', () => {
    const plan = editPlanSchema.parse({ projectId: 'project-1', rationale: 'Invalid test.', segments: [{ id: 'bad', sourceStartSeconds: 0, sourceEndSeconds: 8, action: 'fast_forward', playbackRate: 4, originalAudioGainDb: 0, reason: 'Bad mix.' }] });
    expect(() => validateTimeline(plan, 8)).toThrow('must accelerate and mute source audio');
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
});
