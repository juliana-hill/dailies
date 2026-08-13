import { GoogleAuth } from 'google-auth-library';
import { Storage } from '@google-cloud/storage';
import { GoogleGenAI } from '@google/genai';
import { parseBuffer } from 'music-metadata';
import { PNG } from 'pngjs';
import { generatedMusicCueSchema, soundtrackResultSchema, type AnalysisResult, type SoundtrackResult } from '@dailies/shared';

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
export function hasTransparentBackground(bytes: Buffer, mimeType: string): boolean {
  if (mimeType !== 'image/png') return false;
  try {
    const image = PNG.sync.read(bytes); let transparent = 0; let edgeTransparent = 0; let edgePixels = 0;
    for (let y = 0; y < image.height; y += 1) for (let x = 0; x < image.width; x += 1) {
      const alpha = image.data[(image.width * y + x) * 4 + 3]; const isTransparent = alpha <= 8;
      if (isTransparent) transparent += 1;
      if (x === 0 || y === 0 || x === image.width - 1 || y === image.height - 1) { edgePixels += 1; if (isTransparent) edgeTransparent += 1; }
    }
    return transparent / (image.width * image.height) >= .05 && edgeTransparent / edgePixels >= .8;
  } catch { return false; }
}
export function selectLyriaModel(cue: AnalysisResult['audioCues'][number], proModel = 'lyria-3-pro-preview', clipModel = 'lyria-3-clip-preview'): string {
  const requestedDurationSeconds = Math.max(0, cue.endSeconds - cue.startSeconds);
  return requestedDurationSeconds <= 30 ? clipModel : proModel;
}
export async function generateScore(
  analysis: AnalysisResult,
  ownerId: string,
  onActivity?: (message: string) => void | Promise<void>,
  recovery?: { draft?: SoundtrackResult; checkpoint?: (draft: SoundtrackResult) => void | Promise<void> },
): Promise<SoundtrackResult> {
  const project = required('GCP_PROJECT_ID'); const bucket = required('GCS_BUCKET'); const model = process.env.LYRIA_MODEL || 'lyria-3-pro-preview'; const clipModel = process.env.LYRIA_CLIP_MODEL || process.env.LYRIA_EFFECT_MODEL || 'lyria-3-clip-preview';
  const requestedCues = analysis.audioCues.filter((cue) => cue.type !== 'silence'); const musicCount = requestedCues.filter((cue) => cue.type === 'music').length; const effectCount = requestedCues.length - musicCount;
  if (!requestedCues.length) return soundtrackResultSchema.parse({ needed: false, rationale: 'Analysis found no moment that justified generated music or a sonic accent.', cues: [], model });
  const client = await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient(); const headers = await client.getRequestHeaders();
  const imageModel = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
  const imageAi = new GoogleGenAI({ vertexai: true, project, location: process.env.VERTEX_LOCATION || 'global' });
  const storage = new Storage({ projectId: project }).bucket(bucket);
  const completed = new Map((recovery?.draft?.cues || []).map((cue) => [cue.id, cue]));
  if (completed.size) await onActivity?.(`Resuming asset generation with ${completed.size} of ${requestedCues.length} cue${completed.size === 1 ? '' : 's'} already checkpointed.`);
  for (const cue of requestedCues) {
    if (completed.has(cue.id)) continue;
    if (!cue.generationPrompt?.trim()) throw new Error(`Gemini audio cue ${cue.id} did not provide a Lyria generation prompt`);
    const cueModel = selectLyriaModel(cue, model, clipModel);
    await onActivity?.(`Requesting ${cue.type.replace('_', ' ')} cue ${completed.size + 1} of ${requestedCues.length} from ${cueModel}.`);
    let prompt = `${cue.generationPrompt.trim()} ${cue.type === 'music' ? 'Compose an instrumental scene cue.' : 'Render this as a very short musical accent at the beginning of the generated clip, followed by silence; it is not a continuous background track.'} Original audio only; no copyrighted melody imitation. Begin the usable asset immediately at 0.0 seconds.`;
    let response = await requestLyria(project, { ...headers } as Record<string, string>, cueModel, prompt);
    if (!response.ok) {
      const diagnostic = safeDiagnostic(await response.text());
      if (response.status === 400 && isContentBlocked(diagnostic)) {
        await onActivity?.(`Lyria blocked cue ${completed.size + 1}; Gemini is revising only that generation prompt and preserving the editorial decision.`);
        prompt = await rewriteBlockedPrompt(imageAi, cue, prompt);
        response = await requestLyria(project, { ...headers } as Record<string, string>, cueModel, prompt);
      } else throw new Error(`Lyria request failed with HTTP ${response.status}: ${diagnostic}`);
    }
    if (!response.ok) throw new Error(`Lyria request failed after a Gemini prompt revision with HTTP ${response.status}: ${safeDiagnostic(await response.text())}`);
    const audio = extractAudio(await response.json()); const metadata = await parseBuffer(audio.bytes, { mimeType: audio.mimeType }); const measuredDuration = metadata.format.duration;
    if (!measuredDuration || !Number.isFinite(measuredDuration)) throw new Error('Could not measure the generated music cue duration');
    const assetId = `score_${safe(analysis.projectId)}_${safe(cue.id)}`; const fileName = audio.mimeType === 'audio/mpeg' ? `generated-${cue.type}.mp3` : `generated-${cue.type}.wav`;
    await storage.file(`${ownerId}/${analysis.projectId}/${assetId}/${fileName}`).save(audio.bytes, { contentType: audio.mimeType, resumable: false });
    let visualAsset; let visualPrompt;
    if (cue.visualGenerationPrompt?.trim()) {
      if (!cue.visualGenerationPrompt?.trim()) throw new Error(`Gemini audio cue ${cue.id} did not provide a visual generation prompt`);
      const needsAlpha = cue.visualMode !== 'full_frame';
      visualPrompt = needsAlpha
        ? `${cue.visualGenerationPrompt.trim()} Return exactly one finished isolated visual asset as a PNG with a genuine alpha-transparent background. Background pixels must have alpha 0. Do not draw, render, simulate, or include a checkerboard, grid, canvas, backdrop, card, square, shadow panel, or background color. Keep generous transparent padding around the subject.`
        : `${cue.visualGenerationPrompt.trim()} Return exactly one polished full-frame 16:9 PNG composition. Fill every edge of the canvas. Do not include a checkerboard, watermark, fake transparency grid, or accidental border.`;
      let image: ReturnType<typeof extractImage> | undefined;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const imageResponse = await imageAi.models.generateContent({ model: imageModel, contents: `${visualPrompt} Asset validation attempt ${attempt} of 3.`, config: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { imageOutputOptions: { mimeType: 'image/png' } } } as any });
        const candidate = extractImage(imageResponse);
        if (!needsAlpha || hasTransparentBackground(candidate.bytes, candidate.mimeType)) { image = candidate; break; }
      }
      if (!image) throw new Error(`Gemini Image could not produce a valid ${needsAlpha ? 'transparent overlay' : 'full-frame composition'} for cue ${cue.id} after 3 attempts`);
      const overlayId = `overlay_${safe(analysis.projectId)}_${safe(cue.id)}`; const overlayFileName = imageExtension(image.mimeType);
      await storage.file(`${ownerId}/${analysis.projectId}/${overlayId}/${overlayFileName}`).save(image.bytes, { contentType: image.mimeType, resumable: false });
      visualAsset = { id: overlayId, kind: 'overlay' as const, fileName: overlayFileName, mimeType: image.mimeType, sizeBytes: image.bytes.byteLength, generationModel: imageModel, createdAt: new Date().toISOString() };
    }
    completed.set(cue.id, generatedMusicCueSchema.parse({ ...cue, asset: { id: assetId, kind: 'soundtrack' as const, fileName, mimeType: audio.mimeType, sizeBytes: audio.bytes.byteLength, generationModel: cueModel, createdAt: new Date().toISOString() }, visualAsset, durationSeconds: measuredDuration, prompt, visualPrompt }));
    const partial = soundtrackResultSchema.parse({ needed: true, rationale: `${musicCount} custom scene-music cue(s) and ${effectCount} custom sonic accent(s) requested from the full-video analysis; ${completed.size} of ${requestedCues.length} generated.`, cues: requestedCues.flatMap((requested) => completed.get(requested.id) || []), model });
    await recovery?.checkpoint?.(partial);
    await onActivity?.(`Generated and checkpointed ${cue.type.replace('_', ' ')} cue ${completed.size} of ${requestedCues.length} with ${cueModel}${visualAsset ? ' and its Gemini visual' : ''}.`);
  }
  const cues = requestedCues.flatMap((cue) => completed.get(cue.id) || []);
  if (cues.length !== requestedCues.length) throw new Error(`Asset checkpoint is incomplete: generated ${cues.length} of ${requestedCues.length} cues`);
  return soundtrackResultSchema.parse({ needed: true, rationale: `${musicCount} custom scene-music cue(s) and ${effectCount} custom sonic accent(s) generated from the full-video analysis.`, cues, model });
}
const requestLyria = (project: string, headers: Record<string, string>, model: string, prompt: string) => fetch(`https://aiplatform.googleapis.com/v1beta1/projects/${project}/locations/global/interactions`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ model, input: [{ type: 'text', text: prompt }] }) });
export const isContentBlocked = (diagnostic: string) => /content_blocked|blocked for an unspecified policy reason/i.test(diagnostic);
async function rewriteBlockedPrompt(ai: GoogleGenAI, cue: AnalysisResult['audioCues'][number], rejectedPrompt: string) {
  const response = await ai.models.generateContent({ model: process.env.GEMINI_MODEL || 'gemini-3-flash-preview', contents: `Rewrite this rejected Lyria prompt as one concise, policy-safe instrumental audio-generation prompt. Preserve only the editorial purpose, mood, energy, timing, and clean ending. Remove names, brands, people, lyrics, quoted phrases, imitation requests, and references to copyrighted work. Do not explain the rewrite and do not use Markdown. Cue type: ${cue.type}. Purpose: ${cue.purpose}. Mood: ${cue.mood}. Energy: ${cue.energy}. Rejected prompt: ${rejectedPrompt}` });
  const rewritten = response.text?.trim().replace(/^['"`]+|['"`]+$/g, '');
  if (!rewritten || rewritten.length < 20) throw new Error('Gemini did not return a usable policy-safe Lyria prompt revision');
  return `${rewritten} Instrumental only. Begin immediately at 0.0 seconds and end cleanly.`;
}
const safe = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 72);
const imageExtension = (mimeType: string) => mimeType === 'image/png' ? 'generated-overlay.png' : mimeType === 'image/webp' ? 'generated-overlay.webp' : 'generated-overlay.jpg';
const safeDiagnostic = (value: string) => value.replace(/(token|secret|password|authorization)=?\S*/gi, '$1=[redacted]').replace(/\s+/g, ' ').slice(0, 500);
const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; };
