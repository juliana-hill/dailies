import { GoogleAuth } from 'google-auth-library';
import { Storage } from '@google-cloud/storage';
import { parseBuffer } from 'music-metadata';
import { soundtrackResultSchema, type AnalysisResult, type SoundtrackResult } from '@dailies/shared';

export function extractAudio(payload: any): { bytes: Buffer; mimeType: string } {
  const output = payload?.outputs?.find((item: any) => item?.type === 'audio' && item?.data);
  if (!output) throw new Error('Lyria response did not contain encoded audio');
  return { bytes: Buffer.from(output.data, 'base64'), mimeType: output.mime_type || 'audio/mpeg' };
}
export async function generateScore(analysis: AnalysisResult, ownerId: string): Promise<SoundtrackResult> {
  const project = required('GCP_PROJECT_ID'); const bucket = required('GCS_BUCKET'); const model = process.env.LYRIA_MODEL || 'lyria-3-pro-preview';
  const musicCues = analysis.audioCues.filter((cue) => cue.type === 'music'); const deferredEffects = analysis.audioCues.filter((cue) => ['laugh_track', 'pop', 'sting'].includes(cue.type));
  if (!musicCues.length) return soundtrackResultSchema.parse({ needed: deferredEffects.length > 0, rationale: `Analysis found no moment that justified generated music.${deferredEffects.length ? ` ${deferredEffects.length} analyzed pop/celebration effect(s) will be synthesized in the edit timeline.` : ''}`, cues: [], model });
  const client = await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient(); const headers = await client.getRequestHeaders();
  const storage = new Storage({ projectId: project }).bucket(bucket); const cues = [];
  for (const cue of musicCues) {
    const requestedDuration = Math.min(184, Math.max(4, Math.ceil(cue.endSeconds - cue.startSeconds + cue.fadeInSeconds + cue.fadeOutSeconds)));
    const prompt = `Instrumental cue only, approximately ${requestedDuration} seconds. This cue exists specifically to ${cue.purpose}. Mood: ${cue.mood}. Energy: ${Math.round(cue.energy * 100)}%. ${analysis.soundtrackBrief.prompt}. Tempo: ${analysis.soundtrackBrief.tempo}. Instrumentation: ${analysis.soundtrackBrief.instrumentation}. Begin decisively, provide a clean ending, no vocals, no copyrighted melodies, and do not create a continuous background bed.`;
    const response = await fetch(`https://aiplatform.googleapis.com/v1beta1/projects/${project}/locations/global/interactions`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' } as Record<string, string>, body: JSON.stringify({ model, input: [{ type: 'text', text: prompt }] }) });
    if (!response.ok) throw new Error(`Lyria request failed with HTTP ${response.status}`);
    const audio = extractAudio(await response.json()); const metadata = await parseBuffer(audio.bytes, { mimeType: audio.mimeType }); const measuredDuration = metadata.format.duration;
    if (!measuredDuration || !Number.isFinite(measuredDuration)) throw new Error('Could not measure the generated music cue duration');
    const assetId = `score_${safe(analysis.projectId)}_${safe(cue.id)}`; const fileName = audio.mimeType === 'audio/mpeg' ? 'generated-cue.mp3' : 'generated-cue.wav';
    await storage.file(`${ownerId}/${analysis.projectId}/${assetId}/${fileName}`).save(audio.bytes, { contentType: audio.mimeType, resumable: false });
    cues.push({ ...cue, type: 'music' as const, asset: { id: assetId, kind: 'soundtrack' as const, fileName, mimeType: audio.mimeType, sizeBytes: audio.bytes.byteLength, generationModel: model, createdAt: new Date().toISOString() }, durationSeconds: measuredDuration, prompt });
  }
  return soundtrackResultSchema.parse({ needed: true, rationale: `${cues.length} analysis-grounded music cue(s) generated.${deferredEffects.length ? ` ${deferredEffects.length} analyzed pop/celebration effect(s) will be synthesized in the edit timeline.` : ''}`, cues, model });
}
const safe = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 72);
const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; };
