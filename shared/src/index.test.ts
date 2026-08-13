import { describe, expect, it } from 'vitest';
import { analysisResultSchema, editPlanSchema, projectCreationRequestSchema, projectStatusSchema, retentionEvidenceSchema, soundtrackResultSchema } from './index.js';

describe('shared contracts', () => {
  it('accepts every persisted lifecycle state', () => {
    for (const state of ['created', 'uploading', 'uploaded', 'analyzing', 'scoring', 'querying_insights', 'complete', 'failed']) {
      expect(projectStatusSchema.parse(state)).toBe(state);
    }
  });

  it('rejects oversized and unsupported uploads', () => {
    const base = { title: 'Cut', outline: '', fileName: 'cut.mp4', mimeType: 'video/mp4', fileSizeBytes: 100 };
    expect(projectCreationRequestSchema.parse(base).mimeType).toBe('video/mp4');
    expect(() => projectCreationRequestSchema.parse({ ...base, mimeType: 'text/plain' })).toThrow();
    expect(() => projectCreationRequestSchema.parse({ ...base, fileSizeBytes: 101 * 1024 * 1024 * 1024 })).toThrow();
    expect(projectCreationRequestSchema.parse({ ...base, durationSeconds: 30 }).durationSeconds).toBe(30);
    expect(projectCreationRequestSchema.parse({ ...base, durationSeconds: 3600 }).durationSeconds).toBe(3600);
  });

  it('preserves normalized retention positions and derived seconds', () => {
    const point = retentionEvidenceSchema.parse({ videoId: 'v1', title: 'One', durationSeconds: 200, positionRatio: .42, positionSeconds: 84, dropPercent: 18, nearbyEvents: [] });
    expect(point.positionRatio).toBe(.42);
    expect(point.positionSeconds).toBe(84);
  });

  it('keeps legacy edit plans on the simple renderer unless advanced treatments are requested', () => {
    const plan = editPlanSchema.parse({
      projectId: 'project-1', rationale: 'Keep the useful material.',
      segments: [{ id: 'segment-1', sourceStartSeconds: 0, sourceEndSeconds: 30, action: 'keep', reason: 'Strong opening.' }],
    });
    expect(plan.audioCleanup).toEqual({ reduceNoise: false, removeHum: false, highPassHz: 80, targetLufs: -14 });
    expect(plan.segments[0].playbackRate).toBe(1);
  });

  it('allows analysis to intentionally recommend no added audio', () => {
    const analysis = analysisResultSchema.parse({ projectId: 'p1', durationSeconds: 10, scenes: [{ id: 's1', startSeconds: 0, endSeconds: 10, summary: 'Dialogue', mood: 'clear', energy: .5, pacingFlags: [] }], soundtrackBrief: { mood: 'none', tempo: 'none', instrumentation: 'none', prompt: 'No music.' } });
    const soundtrack = soundtrackResultSchema.parse({ needed: false, rationale: 'Dialogue is sufficient.', model: 'not-called' });
    expect(analysis.audioCues).toEqual([]);
    expect(soundtrack.cues).toEqual([]);
    expect(soundtrack.needed).toBe(false);
  });
});
