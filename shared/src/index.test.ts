import { describe, expect, it } from 'vitest';
import { projectCreationRequestSchema, projectStatusSchema, retentionEvidenceSchema } from './index.js';

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
});
