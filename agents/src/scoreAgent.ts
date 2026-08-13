import { GoogleAuth } from 'google-auth-library';
import { Storage } from '@google-cloud/storage';
import { GoogleGenAI } from '@google/genai';
import { parseBuffer } from 'music-metadata';
import { soundtrackResultSchema, type AnalysisResult, type SoundtrackResult } from '@dailies/shared';

export function extractAudio(payload: any): { bytes: Buffer; mimeType: string } {
  const output = payload?.outputs?.find((item: any) => item?.type === 'audio' && item?.data);
  if (!output) throw new Error('Lyria response did not contain encoded audio');
  return { bytes: Buffer.from(output.data, 'base64'), mimeType: output.mime_type || 'audio/mpeg' };
}
export function extractImage(payload: any): { bytes: Buffer; mimeType: string } {
  const parts = payload?.candidates?.flatMap((candidate: any) => candidate?.content?.parts || []) || [];
  const image = parts.find((part: any) => part?.inlineData?.data && part?.inlineData?.mimeType?.startsWith('image/'))?.inlineData;
  if (!image) throw new Error('Gemini Image response did not contain an encoded image');
  return { bytes: Buffer.from(image.data, 'base64'), mimeType: image.mimeType };
}
export async function generateScore(analysis: AnalysisResult, ownerId: string): Promise<SoundtrackResult> {
  const project = required('GCP_PROJECT_ID'); const bucket = required('GCS_BUCKET'); const model = process.env.LYRIA_MODEL || 'lyria-3-pro-preview';
  const requestedCues = analysis.audioCues.filter((cue) => cue.type !== 'silence'); const musicCount = requestedCues.filter((cue) => cue.type === 'music').length; const effectCount = requestedCues.length - musicCount;
  if (!requestedCues.length) return soundtrackResultSchema.parse({ needed: false, rationale: 'Analysis found no moment that justified generated music or a sonic accent.', cues: [], model });
  const client = await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient(); const headers = await client.getRequestHeaders();
  const imageModel = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
  const imageAi = new GoogleGenAI({ vertexai: true, project, location: process.env.VERTEX_LOCATION || 'global' });
  const storage = new Storage({ projectId: project }).bucket(bucket); const cues = [];
  for (const cue of requestedCues) {
    if (!cue.generationPrompt?.trim()) throw new Error(`Gemini audio cue ${cue.id} did not provide a Lyria generation prompt`);
    const cueModel = cue.type === 'music' ? model : process.env.LYRIA_EFFECT_MODEL || model;
    const prompt = `${cue.generationPrompt.trim()} ${cue.type === 'music' ? 'Compose an instrumental scene cue.' : 'Render this as a very short musical accent at the beginning of the generated clip, followed by silence; it is not a continuous background track.'} Original audio only; no copyrighted melody imitation. Begin the usable asset immediately at 0.0 seconds.`;
    const response = await fetch(`https://aiplatform.googleapis.com/v1beta1/projects/${project}/locations/global/interactions`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' } as Record<string, string>, body: JSON.stringify({ model: cueModel, input: [{ type: 'text', text: prompt }] }) });
    if (!response.ok) throw new Error(`Lyria request failed with HTTP ${response.status}: ${safeDiagnostic(await response.text())}`);
    const audio = extractAudio(await response.json()); const metadata = await parseBuffer(audio.bytes, { mimeType: audio.mimeType }); const measuredDuration = metadata.format.duration;
    if (!measuredDuration || !Number.isFinite(measuredDuration)) throw new Error('Could not measure the generated music cue duration');
    const assetId = `score_${safe(analysis.projectId)}_${safe(cue.id)}`; const fileName = audio.mimeType === 'audio/mpeg' ? `generated-${cue.type}.mp3` : `generated-${cue.type}.wav`;
    await storage.file(`${ownerId}/${analysis.projectId}/${assetId}/${fileName}`).save(audio.bytes, { contentType: audio.mimeType, resumable: false });
    let visualAsset; let visualPrompt;
    if (cue.type !== 'music') {
      if (!cue.visualGenerationPrompt?.trim()) throw new Error(`Gemini audio cue ${cue.id} did not provide a visual generation prompt`);
      visualPrompt = `${cue.visualGenerationPrompt.trim()} Return only the finished isolated visual asset. Preserve transparent background when supported.`;
      const imageResponse = await imageAi.models.generateContent({ model: imageModel, contents: visualPrompt, config: { responseModalities: ['TEXT', 'IMAGE'] as any } });
      const image = extractImage(imageResponse); const overlayId = `overlay_${safe(analysis.projectId)}_${safe(cue.id)}`; const overlayFileName = imageExtension(image.mimeType);
      await storage.file(`${ownerId}/${analysis.projectId}/${overlayId}/${overlayFileName}`).save(image.bytes, { contentType: image.mimeType, resumable: false });
      visualAsset = { id: overlayId, kind: 'overlay' as const, fileName: overlayFileName, mimeType: image.mimeType, sizeBytes: image.bytes.byteLength, generationModel: imageModel, createdAt: new Date().toISOString() };
    }
    cues.push({ ...cue, asset: { id: assetId, kind: 'soundtrack' as const, fileName, mimeType: audio.mimeType, sizeBytes: audio.bytes.byteLength, generationModel: cueModel, createdAt: new Date().toISOString() }, visualAsset, durationSeconds: measuredDuration, prompt, visualPrompt });
  }
  return soundtrackResultSchema.parse({ needed: true, rationale: `${musicCount} custom scene-music cue(s) and ${effectCount} custom sonic accent(s) generated from the full-video analysis.`, cues, model });
}
const safe = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 72);
const imageExtension = (mimeType: string) => mimeType === 'image/png' ? 'generated-overlay.png' : mimeType === 'image/webp' ? 'generated-overlay.webp' : 'generated-overlay.jpg';
const safeDiagnostic = (value: string) => value.replace(/(token|secret|password|authorization)=?\S*/gi, '$1=[redacted]').replace(/\s+/g, ' ').slice(0, 500);
const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; };
