import { GoogleAuth } from 'google-auth-library';
import { Storage } from '@google-cloud/storage';
import { GoogleGenAI } from '@google/genai';
import { parseBuffer } from 'music-metadata';
import { PNG } from 'pngjs';
import { generatedMusicCueSchema, soundtrackResultSchema, type AnalysisResult, type SoundtrackResult } from '@dailies/shared';
import { awaitTrebloGeneration, shouldFallbackFromLyria, startTrebloGeneration } from './soundtrackProviders.js';

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
function removeFlatBackground(bytes: Buffer, mimeType: string): { bytes: Buffer; mimeType: string } {
  if (mimeType !== 'image/png') return { bytes, mimeType };
  try {
    const image = PNG.sync.read(bytes);
    const sample = (x: number, y: number) => { const i = (image.width * y + x) * 4; return [image.data[i], image.data[i + 1], image.data[i + 2]]; };
    const corners = [sample(0, 0), sample(image.width - 1, 0), sample(0, image.height - 1), sample(image.width - 1, image.height - 1)];
    const bg = [0, 1, 2].map((channel) => Math.round(corners.reduce((sum, color) => sum + color[channel], 0) / corners.length));
    for (let y = 0; y < image.height; y += 1) for (let x = 0; x < image.width; x += 1) {
      const i = (image.width * y + x) * 4;
      const distance = Math.abs(image.data[i] - bg[0]) + Math.abs(image.data[i + 1] - bg[1]) + Math.abs(image.data[i + 2] - bg[2]);
      if (distance < 75) image.data[i + 3] = 0;
    }
    return { bytes: PNG.sync.write(image), mimeType: 'image/png' };
  } catch { return { bytes, mimeType }; }
}
export function isImageCapacityError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /429|resource[_ ]exhausted|quota|rate.?limit|temporarily at capacity/i.test(text);
}
async function requestNanoBanana(ai: GoogleGenAI, prompt: string) {
  const model = process.env.GEMINI_IMAGE_FALLBACK_MODEL || 'gemini-3.1-flash-lite-image';
  const response = await ai.models.generateContent({ model, contents: prompt, config: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { imageOutputOptions: { mimeType: 'image/png' } } } } as any);
  return { ...extractImage(response), model };
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
  requestedCues.forEach((cue) => { if (!cue.generationPrompt?.trim()) throw new Error(`Gemini audio cue ${cue.id} did not provide a generation direction`); });
  const client = await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient(); const headers = await client.getRequestHeaders();
  const imageModel = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
  const imageAi = new GoogleGenAI({ vertexai: true, project, location: process.env.VERTEX_LOCATION || 'global' });
  const storage = new Storage({ projectId: project }).bucket(bucket);
  const recoverableDraft = recovery?.draft;
  const recovered = recoverableDraft?.asset?.id.startsWith('sound_reel_') || recoverableDraft?.providerJobId || recoverableDraft?.compositionBrief ? recoverableDraft : undefined;
  let reelAsset = recovered?.asset; let reelDuration = recovered?.durationSeconds; let reelPrompt = recovered?.prompt; let cueModel = recovered?.model;
  let provider = recovered?.provider; let providerJobId = recovered?.providerJobId; let compositionBrief = recovered?.compositionBrief;
  if (!reelAsset || !reelDuration || !reelPrompt) {
    cueModel ||= selectReelModel(requestedCues, model, clipModel);
    if (!compositionBrief) {
      await onActivity?.(`Gemini is directing one consolidated soundtrack with ${requestedCues.length} ordered intro, outro, montage, music, and sound-effect moments.`);
      compositionBrief = await createCompositionBrief(imageAi, analysis, requestedCues, onActivity);
      await recovery?.checkpoint?.(soundtrackResultSchema.parse({ needed: true, rationale: 'Gemini composition brief checkpointed; soundtrack generation is pending.', cues: [], model: cueModel, compositionBrief }));
    }

    let audio: { bytes: Buffer; mimeType: string };
    if (provider === 'treblo' && providerJobId) {
      await onActivity?.('Resuming the durable Treblo soundtrack job; analysis and editorial decisions are preserved.');
      const generated = await awaitTrebloGeneration(providerJobId, onActivity);
      audio = generated; cueModel = generated.model; provider = generated.provider;
    } else {
      reelPrompt = await createProviderPrompt(imageAi, compositionBrief, 'lyria');
      await onActivity?.(`Gemini adapted its composition brief for ${cueModel}; requesting one cohesive editorial soundtrack.`);
      let response: Response | undefined; let requestFailure: unknown;
      try { response = await requestLyria(project, { ...headers } as Record<string, string>, cueModel, reelPrompt); } catch (error) { requestFailure = error; }
      const useFallback = Boolean(process.env.TREBLO_API_KEY) && (requestFailure !== undefined || (response && shouldFallbackFromLyria(response.status)));
      if (useFallback) {
        const reason = requestFailure ? 'network availability' : `HTTP ${response!.status} capacity`;
        await onActivity?.(`Lyria is unavailable due to ${reason}. The circuit breaker is routing the same Gemini composition brief to Treblo without restarting analysis.`);
        provider = 'treblo';
        reelPrompt = await createProviderPrompt(imageAi, compositionBrief, 'treblo');
        const generation = await startTrebloGeneration(reelPrompt, requestedCues);
        providerJobId = generation.taskId; cueModel = `treblo-${process.env.TREBLO_MODEL || 'v3'}`;
        await recovery?.checkpoint?.(soundtrackResultSchema.parse({ needed: true, rationale: 'Treblo fallback job accepted; generation is pending.', cues: [], model: cueModel, provider, providerJobId, prompt: reelPrompt, compositionBrief }));
        await onActivity?.('One Treblo fallback soundtrack job accepted and durably checkpointed.');
        const generated = await awaitTrebloGeneration(providerJobId, onActivity);
        audio = generated; cueModel = generated.model;
      } else {
        if (requestFailure) throw requestFailure;
        if (!response!.ok) throw new Error(`Lyria soundtrack request failed with HTTP ${response!.status}: ${safeDiagnostic(await response!.text())}`);
        audio = extractAudio(await response!.json()); provider = 'lyria';
      }
    }
    const metadata = await parseBuffer(audio.bytes, { mimeType: audio.mimeType }); reelDuration = metadata.format.duration;
    if (!reelDuration || !Number.isFinite(reelDuration)) throw new Error('Could not measure the generated editorial sound reel duration');
    const assetId = `sound_reel_${safe(analysis.projectId)}`; const fileName = audio.mimeType === 'audio/mpeg' ? 'organic-editorial-soundtrack.mp3' : 'organic-editorial-soundtrack.wav';
    await storage.file(`${ownerId}/${analysis.projectId}/${assetId}/${fileName}`).save(audio.bytes, { contentType: audio.mimeType, resumable: false });
    reelAsset = { id: assetId, kind: 'soundtrack' as const, fileName, mimeType: audio.mimeType, sizeBytes: audio.bytes.byteLength, generationModel: cueModel, createdAt: new Date().toISOString() };
    await recovery?.checkpoint?.(soundtrackResultSchema.parse({ needed: true, rationale: `One consolidated ${providerName(provider)} soundtrack generated; Gemini indexing is pending.`, cues: [], model: cueModel, provider, providerJobId, asset: reelAsset, durationSeconds: reelDuration, prompt: reelPrompt, compositionBrief }));
    await onActivity?.(`One ${providerName(provider)} soundtrack generated and checkpointed (${Math.round(reelDuration)} seconds). No additional audio-generation call is needed for this project.`);
  } else await onActivity?.(`Resuming from the checkpointed ${providerName(provider)} soundtrack; no new audio-generation request is being made.`);

  const existing = new Map((recovered?.cues || []).map((cue) => [cue.id, cue]));
  let cues = requestedCues.flatMap((cue) => existing.get(cue.id) || []);
  if (cues.length !== requestedCues.length || cues.some((cue) => cue.sourceStartSeconds === undefined || cue.sourceEndSeconds === undefined)) {
    await onActivity?.('Gemini is listening to the generated reel and locating each requested music or sound-effect slice.');
    const slices = await indexSoundReel(imageAi, `gs://${bucket}/${ownerId}/${analysis.projectId}/${reelAsset.id}/${reelAsset.fileName}`, reelAsset.mimeType, reelDuration, requestedCues);
    cues = requestedCues.map((cue) => {
      const slice = slices.get(cue.id); if (!slice) throw new Error(`Gemini did not locate sound reel cue ${cue.id}`);
      return generatedMusicCueSchema.parse({ ...cue, asset: reelAsset, visualAsset: existing.get(cue.id)?.visualAsset, durationSeconds: slice.endSeconds - slice.startSeconds, sourceStartSeconds: slice.startSeconds, sourceEndSeconds: slice.endSeconds, prompt: reelPrompt });
    });
    await recovery?.checkpoint?.(soundtrackResultSchema.parse({ needed: true, rationale: `One soundtrack indexed into ${cues.length} analysis-grounded cue slices.`, cues, model: cueModel!, provider, providerJobId, asset: reelAsset, durationSeconds: reelDuration, prompt: reelPrompt, compositionBrief }));
    await onActivity?.(`Gemini indexed all ${cues.length} editorial cues inside the single checkpointed soundtrack.`);
  }

  const completed = new Map(cues.map((cue) => [cue.id, cue]));
  for (const cue of requestedCues) {
    const generated = completed.get(cue.id)!; if (!cue.visualGenerationPrompt?.trim() || generated.visualAsset) continue;
    const needsAlpha = cue.visualMode !== 'full_frame';
    const visualPrompt = needsAlpha
      ? `${cue.visualGenerationPrompt.trim()} Return exactly one finished isolated visual asset as a PNG with a genuine alpha-transparent background. Background pixels must have alpha 0. Do not draw, render, simulate, or include a checkerboard, grid, canvas, backdrop, card, square, shadow panel, or background color. Keep generous transparent padding around the subject.`
      : `${cue.visualGenerationPrompt.trim()} Return exactly one polished full-frame 16:9 PNG composition. Fill every edge of the canvas. Do not include a checkerboard, watermark, fake transparency grid, or accidental border.`;
    let image: ReturnType<typeof extractImage> & { model?: string };
    let capacityError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const imageResponse = await imageAi.models.generateContent({ model: imageModel, contents: `${visualPrompt} This is validation attempt ${attempt} of 3; ensure the requested transparent background is real alpha, never a checkerboard.`, config: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { imageOutputOptions: { mimeType: 'image/png' } } } } as any);
        const candidate = extractImage(imageResponse);
        if (needsAlpha && !hasTransparentBackground(candidate.bytes, candidate.mimeType)) {
          await onActivity?.(`Gemini Image returned an opaque overlay for cue ${cue.id}; retrying image generation (${attempt}/3).`);
          continue;
        }
        image = { ...candidate, model: imageModel };
        break;
      } catch (error) {
        if (!isImageCapacityError(error)) throw error;
        capacityError = error;
        break;
      }
    }
    if (!image!) {
      if (!capacityError) throw new Error(`Gemini Image could not produce a valid transparent overlay for cue ${cue.id} after 3 attempts`);
      await onActivity?.(`Gemini Image is at capacity for cue ${cue.id}; switching to Nano Banana 2 Lite.`);
      let candidate: Awaited<ReturnType<typeof requestNanoBanana>> | undefined;
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const revision = attempt === 1 ? '' : attempt === 2 ? ' Revise the prompt: make the subject a clean sticker cutout with transparent pixels outside the silhouette.' : attempt === 3 ? ' Revise again: export PNG RGBA with alpha 0 outside the subject; never use white, black, gray, or checkerboard as a background.' : ' Final revision: create only the isolated foreground object, surrounded by empty transparent canvas; do not draw any backdrop.';
        const generated = await requestNanoBanana(imageAi, `${visualPrompt}${revision} Nano Banana validation attempt ${attempt} of 5.`);
        if (!needsAlpha || hasTransparentBackground(generated.bytes, generated.mimeType)) { candidate = generated; break; }
        await onActivity?.(`Nano Banana returned an opaque overlay for cue ${cue.id}; retrying image generation (${attempt}/3).`);
      }
      if (!candidate) throw new Error(`Nano Banana could not produce a transparent overlay for cue ${cue.id} after 5 prompt revisions`);
      image = candidate;
      await onActivity?.(`Nano Banana 2 Lite generated the visual asset for cue ${cue.id}.`);
    }
    if (needsAlpha && !hasTransparentBackground(image.bytes, image.mimeType)) throw new Error(`Image providers could not produce a transparent overlay for cue ${cue.id}`);
    const overlayId = `overlay_${safe(analysis.projectId)}_${safe(cue.id)}`; const overlayFileName = imageExtension(image.mimeType);
    await storage.file(`${ownerId}/${analysis.projectId}/${overlayId}/${overlayFileName}`).save(image.bytes, { contentType: image.mimeType, resumable: false });
    generated.visualAsset = { id: overlayId, kind: 'overlay' as const, fileName: overlayFileName, mimeType: image.mimeType, sizeBytes: image.bytes.byteLength, generationModel: image.model || imageModel, createdAt: new Date().toISOString() }; generated.visualPrompt = visualPrompt;
    await recovery?.checkpoint?.(soundtrackResultSchema.parse({ needed: true, rationale: `One soundtrack indexed into ${cues.length} analysis-grounded cue slices.`, cues, model: cueModel!, provider, providerJobId, asset: reelAsset, durationSeconds: reelDuration, prompt: reelPrompt, compositionBrief }));
    await onActivity?.(`Generated and checkpointed the Gemini visual paired with reel cue ${cue.id}.`);
  }
  return soundtrackResultSchema.parse({ needed: true, rationale: `${musicCount} music moment(s) and ${effectCount} sonic accent(s) sliced by Gemini from one consolidated ${providerName(provider)} soundtrack.`, cues, model: cueModel!, provider, providerJobId, asset: reelAsset, durationSeconds: reelDuration, prompt: reelPrompt, compositionBrief });
}
const requestLyria = (project: string, headers: Record<string, string>, model: string, prompt: string) => fetch(`https://aiplatform.googleapis.com/v1beta1/projects/${project}/locations/global/interactions`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ model, input: [{ type: 'text', text: prompt }] }) });
export const isContentBlocked = (diagnostic: string) => /content_blocked|blocked for an unspecified policy reason/i.test(diagnostic);
export function selectReelModel(cues: AnalysisResult['audioCues'], proModel = 'lyria-3-pro-preview', clipModel = 'lyria-3-clip-preview') { return cues.reduce((sum, cue) => sum + Math.max(.5, cue.endSeconds - cue.startSeconds), 0) <= 30 ? clipModel : proModel; }
async function createCompositionBrief(ai: GoogleGenAI, analysis: AnalysisResult, cues: AnalysisResult['audioCues'], onActivity?: (message: string) => void | Promise<void>) {
  const basePrompt = `Act as the supervising sound editor for this diagnosed video. Design ONE provider-neutral, executable soundtrack composition brief containing every justified intro, outro, montage, reveal, joke, transition, music, and sound-effect moment in the requested order. The file is an asset reel: sections will later be sliced and placed at their source-video timestamps, so give every section a distinctive onset, complete musical shape, and 0.5-2 seconds of separation. Do not create an always-on background bed.

Choose context-specific organic sounds from the video's actual meaning. Favor warm, tactile, physically plausible sources—water bubbles, keys or small metal objects, glass or wooden taps, fabric movement, finger snaps, hand percussion, breathy air, and natural room textures—only when they serve the diagnosed moment. Integrate sound effects musically; avoid generic high-pitched pings and disconnected soundboard effects. Preserve natural dialogue volume in the eventual edit. Music must be instrumental. Never name or imitate artists, copyrighted songs, brands, lyrics, or spoken catchphrases.

Complete diagnosis: ${JSON.stringify({ soundtrackBrief: analysis.soundtrackBrief, viewerScore: analysis.viewerScore, scenes: analysis.scenes.map(({ id, startSeconds, endSeconds, summary, mood, energy, pacingFlags }) => ({ id, startSeconds, endSeconds, summary, mood, energy, pacingFlags })), editingSignals: analysis.editingSignals, requestedCues: cues.map((cue) => ({ id: cue.id, sourceVideoStartSeconds: cue.startSeconds, sourceVideoEndSeconds: cue.endSeconds, type: cue.type, purpose: cue.purpose, mood: cue.mood, energy: cue.energy, desiredAssetSeconds: Math.max(.5, cue.endSeconds - cue.startSeconds), dialoguePolicy: cue.dialoguePolicy, direction: cue.generationPrompt, visualCompanion: cue.visualCompanion })) })}`;
  let correction = '';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL || 'gemini-3-flash-preview',
      contents: `${basePrompt}${correction}`,
      config: { responseMimeType: 'application/json', responseJsonSchema: compositionBriefJsonSchema(cues.map((cue) => cue.id)) },
    });
    if (!response.text) {
      correction = '\n\nCORRECTION REQUIRED: The previous attempt returned no JSON. Return a complete brief with every required cue exactly once and in the requested order.';
      await onActivity?.(`Gemini returned no composition brief; correcting the same soundtrack plan (attempt ${attempt + 1} of 3).`);
      continue;
    }
    const parsed = JSON.parse(response.text);
    const validation = validateCompositionBrief(parsed, cues);
    if (validation.valid) return JSON.stringify(parsed);
    if (attempt < 3) {
      const missing = validation.missingIds.length ? validation.missingIds.join(', ') : 'none';
      await onActivity?.(`Gemini omitted or reordered soundtrack cues; iterating the composition brief with missing cue IDs preserved (${missing}).`);
      correction = `\n\nCORRECTION REQUIRED: Revise the previous brief below instead of starting over. Preserve every valid section, add the missing cue IDs, remove duplicates or unexpected IDs, and return exactly one section per required cue in this exact order: ${cues.map((cue) => cue.id).join(', ')}. Missing IDs detected: ${missing}. Previous brief: ${JSON.stringify(parsed)}`;
    }
  }
  throw new Error(`Gemini could not produce a complete ordered composition brief for all ${cues.length} audio cues after 3 attempts`);
}

export function validateCompositionBrief(parsed: any, cues: AnalysisResult['audioCues']) {
  const expectedIds = cues.map((cue) => cue.id);
  const actualIds = Array.isArray(parsed?.sections) ? parsed.sections.map((section: any) => section?.cueId) : [];
  const missingIds = expectedIds.filter((id) => !actualIds.includes(id));
  const valid = actualIds.length === expectedIds.length && actualIds.every((id: unknown, index: number) => id === expectedIds[index]);
  return { valid, missingIds };
}
async function createProviderPrompt(ai: GoogleGenAI, compositionBrief: string, provider: 'lyria' | 'treblo') {
  const providerDirection = provider === 'lyria'
    ? 'Adapt this for Google Lyria. Be concise and describe the continuous musical/audio progression in chronological order.'
    : 'Adapt this for Treblo Melodia v3. Request one instrumental soundtrack whose ordered sections remain clearly distinguishable. Treblo infers tags from the prompt, so use precise production, instrumentation, mood, transition, and organic-sample language without lyrics.';
  const response = await ai.models.generateContent({ model: process.env.GEMINI_MODEL || 'gemini-3-flash-preview', contents: `${providerDirection} Preserve every cue and its order from the approved composition brief; do not add unrelated sections. This is one generation request for one continuous audio file, not separate requests per cue. Include brief natural separation between sections so a later Gemini listening pass can locate exact ranges. Remove artist names, brands, copyrighted references, quoted phrases, lyrics, vocals, and speech. Return only the final provider prompt, no Markdown. Composition brief: ${compositionBrief}` });
  const prompt = response.text?.trim().replace(/^['"`]+|['"`]+$/g, '');
  if (!prompt || prompt.length < 40) throw new Error(`Gemini did not return a usable consolidated ${providerName(provider)} soundtrack prompt`);
  return `${prompt} One continuous cohesive instrumental audio file; no vocals or speech; organic found sounds may be used as musical material; preserve the complete ordered section sequence.`;
}
async function indexSoundReel(ai: GoogleGenAI, uri: string, mimeType: string, durationSeconds: number, cues: AnalysisResult['audioCues']) {
  let correction = '';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await ai.models.generateContent({ model: process.env.GEMINI_MODEL || 'gemini-3-flash-preview', contents: [{ role: 'user', parts: [{ fileData: { fileUri: uri, mimeType } }, { text: `Listen to this generated editorial sound reel completely. Locate the best audible range for each requested cue, using actual audio evidence rather than evenly dividing the file. Return one non-overlapping range per id in the requested order. Exclude separating silence. The measured audio ends at exactly ${durationSeconds} seconds. Every startSeconds and endSeconds must be within 0 and ${durationSeconds}; never infer, round up, or describe audio beyond that measured end. Requested cues: ${JSON.stringify(cues.map((cue) => ({ id: cue.id, type: cue.type, purpose: cue.purpose, mood: cue.mood, desiredSeconds: Math.max(.5, cue.endSeconds - cue.startSeconds) })))}${correction}` }] }], config: { responseMimeType: 'application/json', responseJsonSchema: reelIndexJsonSchema(durationSeconds, cues.map((cue) => cue.id)) } });
    if (!response.text) { correction = ' Previous attempt returned no JSON. Return all requested ids with measured ranges.'; continue; }
    const parsed = JSON.parse(response.text); const result = validateReelIndex(parsed, cues, durationSeconds);
    if (result) return result;
    correction = ` Previous attempt ${attempt} was invalid because it omitted an id, overlapped ranges, changed their order, or exceeded ${durationSeconds} seconds. Correct those timestamps after listening again.`;
  }
  throw new Error(`Gemini could not produce a valid index for all ${cues.length} soundtrack cues after 3 listening passes`);
}
export function validateReelIndex(parsed: any, cues: AnalysisResult['audioCues'], durationSeconds: number) {
  const result = new Map<string, { startSeconds: number; endSeconds: number }>(); let previousEnd = 0;
  if (!Array.isArray(parsed?.cues) || parsed.cues.length !== cues.length) return undefined;
  for (let index = 0; index < cues.length; index += 1) {
    const expected = cues[index]; const slice = parsed.cues[index]; const startSeconds = Number(slice?.startSeconds); const endSeconds = Number(slice?.endSeconds);
    if (slice?.id !== expected.id || !Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < previousEnd || endSeconds <= startSeconds || endSeconds > durationSeconds) return undefined;
    result.set(expected.id, { startSeconds, endSeconds }); previousEnd = endSeconds;
  }
  return result;
}
const reelIndexJsonSchema = (durationSeconds: number, ids: string[]) => ({
  type: 'object', additionalProperties: false, required: ['cues'],
  properties: {
    cues: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'startSeconds', 'endSeconds'],
        properties: { id: { type: 'string', enum: ids }, startSeconds: { type: 'number', minimum: 0, maximum: durationSeconds }, endSeconds: { type: 'number', minimum: 0, maximum: durationSeconds } },
      },
    },
  },
});
const compositionBriefJsonSchema = (cueIds: string[]) => ({
  type: 'object', additionalProperties: false, required: ['concept', 'continuity', 'productionPalette', 'sections', 'prohibitions'],
  properties: {
    concept: { type: 'string' }, continuity: { type: 'string' }, productionPalette: { type: 'array', items: { type: 'string' } }, prohibitions: { type: 'array', items: { type: 'string' } },
    sections: {
      type: 'array', minItems: cueIds.length, maxItems: cueIds.length,
      items: {
        type: 'object', additionalProperties: false, required: ['cueId', 'role', 'targetDurationSeconds', 'musicalDirection', 'organicSoundEvents', 'transitionIn', 'transitionOut', 'silenceAfterSeconds'],
        properties: {
          cueId: { type: 'string', enum: cueIds }, role: { type: 'string' }, targetDurationSeconds: { type: 'number' }, musicalDirection: { type: 'string' }, organicSoundEvents: { type: 'array', items: { type: 'string' } }, transitionIn: { type: 'string' }, transitionOut: { type: 'string' }, silenceAfterSeconds: { type: 'number' },
        },
      },
    },
  },
});
const providerName = (provider?: 'lyria' | 'treblo') => provider === 'treblo' ? 'Treblo Melodia' : 'Lyria';
const safe = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 72);
const imageExtension = (mimeType: string) => mimeType === 'image/png' ? 'generated-overlay.png' : mimeType === 'image/webp' ? 'generated-overlay.webp' : 'generated-overlay.jpg';
const safeDiagnostic = (value: string) => value.replace(/(token|secret|password|authorization)=?\S*/gi, '$1=[redacted]').replace(/\s+/g, ' ').slice(0, 500);
const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; };
