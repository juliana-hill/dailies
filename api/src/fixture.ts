import type { CompleteProjectReport, Project } from '@dailies/shared';
import type { Orchestrator } from './orchestrator.js';

export class FixtureOrchestrator implements Orchestrator {
  async run(project: Project, _videoUri: string, onStatus?: (status: Project['status']) => Promise<void>): Promise<CompleteProjectReport> {
    if (!project.fixtureMode) throw new Error('Fixture orchestrator refused a live project');
    const createdAt = new Date().toISOString(); const duration = project.durationSeconds || 60;
    for (const state of ['scoring', 'querying_insights'] as const) { await delay(2200); await onStatus?.(state); }
    await delay(2200);
    return {
      analysis: { projectId: project.projectId, durationSeconds: duration, scenes: [{ id: 'fixture-scene-1', startSeconds: 0, endSeconds: duration, summary: 'Explicit offline fixture scene.', transcript: '', mood: 'neutral', energy: .5, pacingFlags: ['fixture-only'] }], soundtrackBrief: { mood: 'Neutral fixture', tempo: '90 BPM', instrumentation: 'None', prompt: 'Fixture mode does not call Lyria.' }, soundtrackSegments: [{ id: 'fixture-segment-1', startSeconds: 0, endSeconds: duration, mood: 'neutral', energy: .5, label: 'Fixture segment' }] },
      soundtrack: { asset: { id: 'fixture-audio', kind: 'soundtrack', fileName: 'fixture-not-generated.wav', mimeType: 'audio/wav', sizeBytes: 0, generationModel: 'fixture', createdAt }, durationSeconds: duration, model: 'fixture', prompt: 'Fixture mode does not call Lyria.' },
      recommendation: { dropOffPositionRatio: .5, dropOffSeconds: duration / 2, severityPercent: 0, observedEvidence: 'Explicit fixture mode contains no observed creator evidence.', inferredCause: 'No cause is inferred from fixture data.', recommendationText: 'Connect live YouTube and ClickHouse services for a grounded recommendation.', suggestedAction: 'Disable fixture mode after configuring live services.', confidence: 'emerging', supportingVideoIds: [], evidence: [] },
    };
  }
}

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
