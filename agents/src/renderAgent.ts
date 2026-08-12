import { GoogleAuth } from 'google-auth-library';
import { finalCutResultSchema, type EditPlan, type FinalCutResult, type RenderCheckpoint, type SoundtrackResult } from '@dailies/shared';

type RenderInput = { projectId: string; ownerId: string; sourceUri: string; sourceDurationSeconds: number; soundtrack: SoundtrackResult; editPlan: EditPlan; executionAttempt?: number; checkpoint?: RenderCheckpoint };

export async function renderFinalCut(input: RenderInput, onSubmitted?: (checkpoint: RenderCheckpoint) => Promise<void>): Promise<FinalCutResult> {
  if (input.sourceDurationSeconds < 5) throw new Error('Cloud Transcoder requires source footage of at least five seconds');
  const project = required('GCP_PROJECT_ID'); const bucket = required('GCS_BUCKET'); const location = process.env.TRANSCODER_LOCATION || 'us-central1';
  const soundtrackUri = `gs://${bucket}/${input.ownerId}/${input.projectId}/${input.soundtrack.asset.id}/${input.soundtrack.asset.fileName}`;
  const renderId = input.checkpoint?.assetId || `render_${safeId(input.projectId)}_${input.executionAttempt || 1}`; const outputPrefix = `${input.ownerId}/${input.projectId}/${renderId}/`; const outputUri = input.checkpoint?.outputUri || `gs://${bucket}/${outputPrefix}`;
  const retained = input.editPlan.segments.filter((segment) => segment.action !== 'remove');
  if (!retained.length) throw new Error('Edit plan removed the entire source video');
  const editList = retained.map((segment, index) => ({ key: `atom${index}`, inputs: ['source', 'score'], startTimeOffset: seconds(segment.sourceStartSeconds), endTimeOffset: seconds(Math.min(segment.sourceEndSeconds, input.soundtrack.durationSeconds)) })).filter((atom) => Number(atom.endTimeOffset.slice(0, -1)) > Number(atom.startTimeOffset.slice(0, -1)));
  if (!editList.length) throw new Error('No renderable edit segments overlap the generated soundtrack');
  const mapping = editList.flatMap((atom) => [
    { atomKey: atom.key, inputKey: 'source', inputTrack: 1, inputChannel: 0, outputChannel: 0, gainDb: input.editPlan.originalAudioGainDb },
    { atomKey: atom.key, inputKey: 'source', inputTrack: 1, inputChannel: 1, outputChannel: 1, gainDb: input.editPlan.originalAudioGainDb },
    { atomKey: atom.key, inputKey: 'score', inputTrack: 0, inputChannel: 0, outputChannel: 0, gainDb: input.editPlan.soundtrackGainDb },
    { atomKey: atom.key, inputKey: 'score', inputTrack: 0, inputChannel: 1, outputChannel: 1, gainDb: input.editPlan.soundtrackGainDb },
  ]);
  const job = { config: { inputs: [{ key: 'source', uri: input.sourceUri }, { key: 'score', uri: soundtrackUri }], editList, elementaryStreams: [
    { key: 'video', videoStream: { h264: { frameRate: 60, bitrateBps: 20_000_000, rateControlMode: 'crf', crfLevel: 18, frameRateConversionStrategy: 'DOWNSAMPLE', gopDuration: '2s', profile: 'high', preset: 'medium' } } },
    { key: 'audio', audioStream: { codec: 'aac', bitrateBps: 192_000, channelCount: 2, channelLayout: ['fl', 'fr'], sampleRateHertz: 48_000, mapping } },
  ], muxStreams: [{ key: 'final-cut', fileName: 'enhanced-final-cut.mp4', container: 'mp4', elementaryStreams: ['video', 'audio'] }], output: { uri: outputUri } } };
  const client = await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient(); const headers = await client.getRequestHeaders();
  const deterministicJobName = `projects/${project}/locations/${location}/jobs/${renderId}`;
  let jobName = input.checkpoint?.renderJobId || deterministicJobName;
  if (!input.checkpoint) {
    const endpoint = `https://transcoder.googleapis.com/v1/projects/${project}/locations/${location}/jobs?jobId=${encodeURIComponent(renderId)}`;
    const created = await fetch(endpoint, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' } as Record<string, string>, body: JSON.stringify(job) });
    if (created.ok) { const value: any = await created.json(); jobName = String(value.name || deterministicJobName); }
    else if (created.status !== 409) throw new Error(`Transcoder job creation failed (${created.status}): ${(await created.text()).slice(0, 400)}`);
    const checkpoint = { renderJobId: jobName, assetId: renderId, outputUri, submittedAt: new Date().toISOString() } satisfies RenderCheckpoint;
    await onSubmitted?.(checkpoint);
  }
  for (let attempt = 0; attempt < 480; attempt += 1) { await delay(15_000); const status = await fetch(`https://transcoder.googleapis.com/v1/${jobName}`, { headers: headers as Record<string, string> }); if (!status.ok) throw new Error(`Transcoder status failed (${status.status})`); const current: any = await status.json(); if (current.state === 'SUCCEEDED') { const durationSeconds = retained.reduce((sum, segment) => sum + segment.sourceEndSeconds - segment.sourceStartSeconds, 0); return finalCutResultSchema.parse({ asset: { id: renderId, kind: 'rendered_video', fileName: 'enhanced-final-cut.mp4', mimeType: 'video/mp4', generationModel: 'google-cloud-transcoder', createdAt: new Date().toISOString() }, durationSeconds, renderProvider: 'google-cloud-transcoder', renderJobId: jobName }); } if (current.state === 'FAILED') throw new Error(`Transcoder render failed: ${current.error?.message || 'unknown error'}`); }
  throw new Error('Transcoder render exceeded the two-hour monitoring timeout');
}

const seconds = (value: number) => `${Math.max(0, Number(value.toFixed(3)))}s`;
const safeId = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 96);
const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; };
