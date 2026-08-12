import { GoogleAuth } from 'google-auth-library';
import { Storage } from '@google-cloud/storage';
import { soundtrackResultSchema, type AnalysisResult, type SoundtrackResult } from '@dailies/shared';

export function extractAudio(payload: any): { bytes: Buffer; mimeType: string } {
  const output = payload?.outputs?.find((item: any) => item?.type === 'audio' && item?.data);
  if (!output) throw new Error('Lyria response did not contain encoded audio');
  return { bytes: Buffer.from(output.data, 'base64'), mimeType: output.mime_type || 'audio/mpeg' };
}
export async function generateScore(analysis: AnalysisResult, ownerId: string): Promise<SoundtrackResult> {
  const project = required('GCP_PROJECT_ID'); const bucket = required('GCS_BUCKET'); const model = process.env.LYRIA_MODEL || 'lyria-3-pro-preview';
  const prompt = `Instrumental only. Create a complete composition lasting approximately ${Math.min(184, Math.ceil(analysis.durationSeconds))} seconds. ${analysis.soundtrackBrief.prompt}. Mood: ${analysis.soundtrackBrief.mood}. Tempo: ${analysis.soundtrackBrief.tempo}. Instrumentation: ${analysis.soundtrackBrief.instrumentation}. No vocals or copyrighted melodies.`;
  const client = await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient(); const headers = await client.getRequestHeaders();
  const response = await fetch(`https://aiplatform.googleapis.com/v1beta1/projects/${project}/locations/global/interactions`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' } as Record<string, string>, body: JSON.stringify({ model, input: [{ type: 'text', text: prompt }] }) });
  if (!response.ok) throw new Error(`Lyria request failed with HTTP ${response.status}`);
  const audio = extractAudio(await response.json()); const assetId = `score_${analysis.projectId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 96)}`; const fileName = audio.mimeType === 'audio/mpeg' ? 'generated-score.mp3' : 'generated-score.wav';
  await new Storage({ projectId: project }).bucket(bucket).file(`${ownerId}/${analysis.projectId}/${assetId}/${fileName}`).save(audio.bytes, { contentType: audio.mimeType, resumable: false });
  return soundtrackResultSchema.parse({ asset: { id: assetId, kind: 'soundtrack', fileName, mimeType: audio.mimeType, sizeBytes: audio.bytes.byteLength, generationModel: model, createdAt: new Date().toISOString() }, durationSeconds: Math.min(184, analysis.durationSeconds), model, prompt });
}
const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; };
