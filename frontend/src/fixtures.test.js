import { describe, expect, it } from 'vitest';
import { demoAnalysis, demoInsight } from './fixtures';

describe('Dailies demo fixtures', () => {
  it('provides a complete project report for the offline workflow', () => {
    expect(demoAnalysis.scenes).toHaveLength(4);
    expect(demoAnalysis.soundtrackSegments).toHaveLength(4);
    expect(demoInsight.evidence).toHaveLength(3);
    expect(demoInsight.recommendationText).toMatch(/00:29–00:36/);
  });
});
