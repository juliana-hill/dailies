import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Storage } from '@google-cloud/storage';
import { finalCutResultSchema, type EditPlan, type EditorialAudioCue, type FinalCutResult, type RenderCheckpoint, type SoundtrackResult } from '@dailies/shared';

type Input = { projectId: string; ownerId: string; sourceUri: string; sourceDurationSeconds: number; soundtrack: SoundtrackResult; editorialCues?: EditorialAudioCue[]; editPlan: EditPlan; executionAttempt?: number; checkpoint?: RenderCheckpoint };
type MusicCue = SoundtrackResult['cues'][number];

export function requiresFfmpeg(plan: EditPlan) {
  return Boolean(plan.audioCleanup?.reduceNoise || plan.audioCleanup?.removeHum || plan.segments.some((segment) => (segment.playbackRate ?? 1) !== 1 || (segment.originalAudioGainDb ?? plan.originalAudioGainDb) !== plan.originalAudioGainDb || (segment.soundtrackGainDb ?? plan.soundtrackGainDb) !== plan.soundtrackGainDb || hasVisualTreatment(segment.visualTreatment)));
}

export function buildFilterComplex(plan: EditPlan, cues: MusicCue[] = [], editorialCues: EditorialAudioCue[] = []) {
  const segments = plan.segments.filter((segment) => segment.action !== 'remove');
  if (!segments.length) throw new Error('Edit plan removed the entire source video');
  const filters: string[] = [];
  filters.push(`[0:v]split=${segments.length}${segments.map((_, index) => `[vsrc${index}]`).join('')}`);
  const cleanup: string[] = [];
  if (plan.audioCleanup.removeHum) cleanup.push(`highpass=f=${plan.audioCleanup.highPassHz}`, 'equalizer=f=60:t=q:w=8:g=-18', 'equalizer=f=120:t=q:w=8:g=-12');
  if (plan.audioCleanup.reduceNoise) cleanup.push(`highpass=f=${plan.audioCleanup.highPassHz}`, 'afftdn=nr=10:nf=-35');
  filters.push(`[0:a]${cleanup.length ? `${[...new Set(cleanup)].join(',')},` : ''}asplit=${segments.length}${segments.map((_, index) => `[asrc${index}]`).join('')}`);
  let outputCursor = 0;
  segments.forEach((segment, index) => {
    const rate = segment.playbackRate; const outputDuration = (segment.sourceEndSeconds - segment.sourceStartSeconds) / rate;
    const visual = segment.visualTreatment; const videoFilters = [`trim=start=${number(segment.sourceStartSeconds)}:end=${number(segment.sourceEndSeconds)}`, `setpts=(PTS-STARTPTS)/${number(rate)}`];
    if (visual && hasVisualTreatment(visual)) {
      videoFilters.push(`eq=brightness=${number(visual.brightness)}:contrast=${number(1 + visual.contrast)}:saturation=${number(1 + visual.saturation)}`);
      if (visual.temperature) videoFilters.push(`colorbalance=rs=${number(visual.temperature * .18)}:bs=${number(visual.temperature * -.18)}`);
    }
    videoFilters.push('format=yuv420p'); filters.push(`[vsrc${index}]${videoFilters.join(',')}[v${index}]`);
    if (segment.originalAudioGainDb <= -90) {
      filters.push(`[asrc${index}]anullsink`);
      filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${number(outputDuration)},asetpts=PTS-STARTPTS[a${index}]`);
    } else {
      const audioFilters = [`atrim=start=${number(segment.sourceStartSeconds)}:end=${number(segment.sourceEndSeconds)}`, 'asetpts=PTS-STARTPTS', ...atempo(rate), `volume=${number(dbFactor(segment.originalAudioGainDb))}`, 'aformat=sample_rates=48000:channel_layouts=stereo'];
      filters.push(`[asrc${index}]${audioFilters.join(',')}[a${index}]`);
    }
    outputCursor += outputDuration;
  });
  filters.push(`${segments.map((_, index) => `[v${index}][a${index}]`).join('')}concat=n=${segments.length}:v=1:a=1[vjoined][dialoguebase]`);
  const generatedCues = new Map(cues.map((cue) => [cue.id, cue]));
  const visualCues = cues.filter((cue) => cue.visualAsset);
  const visualInputIndex = new Map(visualCues.map((cue, index) => [cue.id, 1 + cues.length + index]));
  // A -loop 1 image input is scaled/format-converted/faded for every frame the filter graph pulls
  // from it, not just its enable= active window — with nothing bounding that, ffmpeg decodes and
  // processes each looped overlay for the full output length (~4650 frames for a 155s video), five
  // times over for five overlays, before any of it ever gets discarded by the overlay's own gate.
  // Bound each one to what its own cue actually needs (+0.6s slack for the fade in/out already in
  // the filter chain) so this is O(each overlay's own window), not O(five × the whole video).
  const visualDurations = visualCues.map((cue) => { const mapped = mapCue(cue, segments); if (!mapped) return 3; const span = mapped.end - mapped.start; return (cue.visualMode === 'full_frame' ? span : Math.min(1.8, Math.max(.7, span))) + .6; });
  const mappedEditorialCues = editorialCues.map((cue) => ({ cue, mapped: mapCue(cue, segments) })).filter((value) => value.mapped);
  const effects = mappedEditorialCues.filter(({ cue }) => cue.type !== 'silence' && Boolean(cue.visualGenerationPrompt?.trim() || cue.visualCompanion?.trim()));
  const missingAudio = effects.find(({ cue }) => !generatedCues.has(cue.id));
  if (missingAudio) throw new Error(`Visual cue ${missingAudio.cue.id} requires its generated audio asset`);
  const missingVisual = effects.find(({ cue }) => !generatedCues.get(cue.id)?.visualAsset);
  if (missingVisual) throw new Error(`Visual cue ${missingVisual.cue.id} requires its Gemini-generated image asset`);
  let videoLabel = 'vjoined';
  effects.forEach(({ cue, mapped }, index) => {
    const start = mapped!.start; const fullFrame = cue.visualMode === 'full_frame'; const duration = fullFrame ? mapped!.end - mapped!.start : Math.min(1.8, Math.max(.7, mapped!.end - mapped!.start)); const end = Math.min(outputCursor, start + duration);
    const next = `vfx${index}`; const overlay = `overlayasset${index}`; const inputIndex = visualInputIndex.get(cue.id)!;
    if (fullFrame) {
      const base = `fullframebase${index}`; const scaled = `fullframescaled${index}`;
      filters.push(`[${inputIndex}:v][${videoLabel}]scale2ref=w=main_w:h=main_h[${scaled}][${base}]`);
      filters.push(`[${scaled}]format=rgba,fade=t=in:st=0:d=0.22:alpha=1,fade=t=out:st=${number(Math.max(.22, end - start - .28))}:d=0.28:alpha=1,setpts=PTS+${number(start)}/TB[${overlay}]`);
      filters.push(`[${base}][${overlay}]overlay=x=0:y=0:eof_action=pass:enable='between(t,${number(start)},${number(end)})'[${next}]`); videoLabel = next; return;
    }
    filters.push(`[${inputIndex}:v]scale='min(480,iw)':-1,format=rgba,fade=t=in:st=0:d=0.18:alpha=1,fade=t=out:st=${number(Math.max(.18, end - start - .22))}:d=0.22:alpha=1,setpts=PTS+${number(start)}/TB[${overlay}]`);
    const enterEnd = Math.min(end, start + .24); const exitStart = Math.max(start, end - .24);
    const { x, y } = stickerPosition(cue.position, cue.effectStyle === 'comic_bubble', start, enterEnd, exitStart, end);
    filters.push(`[${videoLabel}][${overlay}]overlay=x='${x}':y='${y}':eof_action=pass:enable='between(t,${number(start)},${number(end)})'[${next}]`); videoLabel = next;
  });
  filters.push(`[${videoLabel}]null[vout]`);
  const mappedCues = cues.map((cue, index) => ({ cue, index, mapped: mapCue(cue, segments) })).filter((value) => value.mapped);
  const sourceReplacementRanges = mappedEditorialCues.filter(({ cue }) => cue.dialoguePolicy === 'replace_source_audio').map(({ mapped }) => mapped!);
  if (sourceReplacementRanges.length) {
    const active = sourceReplacementRanges.map((range) => `between(t,${number(range.start)},${number(range.end)})`).join('+');
    filters.push(`[dialoguebase]volume='if(gt(${active},0),0,1)':eval=frame[dialogue]`);
  } else filters.push('[dialoguebase]anull[dialogue]');
  mappedCues.forEach(({ cue, index, mapped }) => {
    const duration = mapped!.end - mapped!.start; const fadeIn = Math.min(cue.fadeInSeconds, duration / 2); const fadeOut = Math.min(cue.fadeOutSeconds, duration / 2);
    const reelStart = cue.sourceStartSeconds || 0; const reelEnd = cue.sourceEndSeconds || reelStart + duration;
    filters.push(`[${index + 1}:a]atrim=start=${number(reelStart)}:end=${number(Math.min(reelEnd, reelStart + duration))},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${number(fadeIn)},afade=t=out:st=${number(Math.max(0, duration - fadeOut))}:d=${number(fadeOut)},volume=${number(dbFactor(cue.gainDb))},adelay=${Math.round(mapped!.start * 1000)}:all=1,apad,atrim=0:${number(outputCursor)},aformat=sample_rates=48000:channel_layouts=stereo[music${index}]`);
  });
  const additions = mappedCues.map(({ index }) => `[music${index}]`);
  if (additions.length) filters.push(`[dialogue]${additions.join('')}amix=inputs=${additions.length + 1}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95:attack=5:release=50,aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo[aout]`);
  else filters.push(`[dialogue]aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo[aout]`);
  return { filter: filters.join(';'), durationSeconds: outputCursor, visualDurations };
}

export function buildFfmpegArgs(sourcePath: string, cuePaths: string[], outputPath: string, plan: EditPlan, cues: MusicCue[] = [], editorialCues: EditorialAudioCue[] = [], visualPaths: string[] = []) {
  const built = buildFilterComplex(plan, cues, editorialCues);
  const inputs = cuePaths.flatMap((path) => ['-stream_loop', '-1', '-i', path]);
  const visualInputs = visualPaths.flatMap((path, index) => ['-loop', '1', '-t', number(built.visualDurations[index] ?? 3).toString(), '-i', path]);
  return { durationSeconds: built.durationSeconds, args: ['-y', '-i', sourcePath, ...inputs, ...visualInputs, '-filter_complex', built.filter, '-map', '[vout]', '-map', '[aout]', '-c:v', 'libx264', '-preset', process.env.FFMPEG_PRESET || 'medium', '-crf', process.env.FFMPEG_CRF || '18', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outputPath] };
}

export async function renderWithFfmpeg(input: Input, onSubmitted?: (checkpoint: RenderCheckpoint) => Promise<void>): Promise<FinalCutResult> {
  const bucket = required('GCS_BUCKET'); const mount = process.env.GCS_MOUNT_PATH; const renderId = input.checkpoint?.assetId || `render_${safeId(input.projectId)}_${input.executionAttempt || 1}`;
  const sourceKey = objectKey(input.sourceUri, bucket); const cues = effectiveCues(input.soundtrack, input.sourceDurationSeconds); const cueKeys = cues.map((cue) => `${input.ownerId}/${input.projectId}/${cue.asset.id}/${cue.asset.fileName}`); const visualKeys = cues.filter((cue) => cue.visualAsset).map((cue) => `${input.ownerId}/${input.projectId}/${cue.visualAsset!.id}/${cue.visualAsset!.fileName}`); const outputKey = `${input.ownerId}/${input.projectId}/${renderId}/enhanced-final-cut.mp4`;
  const checkpoint = input.checkpoint || { renderJobId: `ffmpeg:${renderId}`, assetId: renderId, outputUri: `gs://${bucket}/${input.ownerId}/${input.projectId}/${renderId}/`, submittedAt: new Date().toISOString() };
  if (!input.checkpoint) await onSubmitted?.(checkpoint);
  const storage = new Storage({ projectId: process.env.GCP_PROJECT_ID }); const cloudOutput = storage.bucket(bucket).file(outputKey);
  let workspace: string | undefined;
  try {
    const sourcePath = mount ? join(mount, sourceKey) : join(workspace = await mkdtemp(join(tmpdir(), 'dailies-render-')), 'source-video');
    const cuePaths = cueKeys.map((key, index) => mount ? join(mount, key) : join(workspace!, `music-cue-${index}`));
    const visualPaths = visualKeys.map((key, index) => mount ? join(mount, key) : join(workspace!, `visual-cue-${index}`));
    const outputPath = mount ? join(mount, outputKey) : join(workspace!, 'enhanced-final-cut.mp4');
    const cloudExists = input.checkpoint && (await cloudOutput.exists())[0];
    if (!cloudExists && !mount) await Promise.all([storage.bucket(bucket).file(sourceKey).download({ destination: sourcePath }), ...cueKeys.map((key, index) => storage.bucket(bucket).file(key).download({ destination: cuePaths[index] })), ...visualKeys.map((key, index) => storage.bucket(bucket).file(key).download({ destination: visualPaths[index] }))]);
    await mkdir(dirname(outputPath), { recursive: true });
    const built = buildFfmpegArgs(sourcePath, cuePaths, outputPath, input.editPlan, cues, input.editorialCues || [], visualPaths);
    if (!cloudExists && !(await hasOutput(outputPath))) await run(process.env.FFMPEG_PATH || 'ffmpeg', built.args);
    if (!mount && !cloudExists) await storage.bucket(bucket).upload(outputPath, { destination: outputKey, contentType: 'video/mp4', resumable: true, metadata: { cacheControl: 'private, max-age=0' } });
    return finalCutResultSchema.parse({ asset: { id: renderId, kind: 'rendered_video', fileName: 'enhanced-final-cut.mp4', mimeType: 'video/mp4', generationModel: 'ffmpeg-node-media-pipeline', createdAt: new Date().toISOString() }, durationSeconds: built.durationSeconds, renderProvider: 'ffmpeg-cloud-run', renderJobId: checkpoint.renderJobId });
  } finally {
    if (workspace) await rm(workspace, { recursive: true, force: true });
  }
}

// A short, cheap, single-cue preview: just that cue's active window (+1.5s padding) at raw source
// timestamps, ultrafast/low-quality, with only that one overlay composited — a few seconds of
// encode, not the whole video. This is what lets an edit be checked as it's added instead of only
// discovering a bad sticker after a full, expensive draft render.
export async function renderCuePreview(input: { projectId: string; ownerId: string; sourceUri: string; cue: MusicCue }): Promise<{ uri: string; mimeType: string }> {
  const bucket = required('GCS_BUCKET'); const mount = process.env.GCS_MOUNT_PATH;
  const sourceKey = objectKey(input.sourceUri, bucket); const cue = input.cue;
  const padding = 1.5; const clipStart = Math.max(0, cue.startSeconds - padding); const clipEnd = cue.endSeconds + padding; const clipDuration = clipEnd - clipStart;
  const storage = new Storage({ projectId: process.env.GCP_PROJECT_ID });
  let workspace: string | undefined;
  try {
    const sourcePath = mount ? join(mount, sourceKey) : join(workspace = await mkdtemp(join(tmpdir(), 'dailies-preview-')), 'source-video');
    if (!mount) await storage.bucket(bucket).file(sourceKey).download({ destination: sourcePath });
    let overlayPath: string | undefined;
    if (cue.visualAsset) {
      const key = `${input.ownerId}/${input.projectId}/${cue.visualAsset.id}/${cue.visualAsset.fileName}`;
      overlayPath = mount ? join(mount, key) : join(workspace!, 'overlay');
      if (!mount) await storage.bucket(bucket).file(key).download({ destination: overlayPath });
    }
    const outputPath = join(workspace || tmpdir(), `preview-${safeId(cue.id)}.mp4`);
    const args = ['-y', '-ss', number(clipStart).toString(), '-t', number(clipDuration).toString(), '-i', sourcePath];
    let mapArgs: string[] = ['-map', '0:v', '-map', '0:a'];
    if (overlayPath) {
      const start = padding; const end = Math.min(clipDuration, padding + (cue.endSeconds - cue.startSeconds));
      const fullFrame = cue.visualMode === 'full_frame'; const filters: string[] = [];
      args.push('-loop', '1', '-t', number(clipDuration).toString(), '-i', overlayPath);
      if (fullFrame) {
        filters.push('[1:v][0:v]scale2ref=w=main_w:h=main_h[scaled][base]', '[scaled]format=rgba[ov]', `[base][ov]overlay=x=0:y=0:enable='between(t,${number(start)},${number(end)})'[vout]`);
      } else {
        const { x, y } = stickerPosition(cue.position, cue.effectStyle === 'comic_bubble', start, Math.min(end, start + .24), Math.max(start, end - .24), end);
        filters.push(`[1:v]scale='min(480,iw)':-1,format=rgba[ov]`, `[0:v][ov]overlay=x='${x}':y='${y}':enable='between(t,${number(start)},${number(end)})'[vout]`);
      }
      args.push('-filter_complex', filters.join(';')); mapArgs = ['-map', '[vout]', '-map', '0:a'];
    }
    args.push(...mapArgs, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-c:a', 'aac', outputPath);
    await run(process.env.FFMPEG_PATH || 'ffmpeg', args);
    const previewKey = `${input.ownerId}/${input.projectId}/preview_${safeId(cue.id)}/preview.mp4`;
    await storage.bucket(bucket).upload(outputPath, { destination: previewKey, contentType: 'video/mp4' });
    return { uri: `gs://${bucket}/${previewKey}`, mimeType: 'video/mp4' };
  } finally {
    if (workspace) await rm(workspace, { recursive: true, force: true });
  }
}
const atempo = (rate: number) => { const values: number[] = []; let remaining = rate; while (remaining > 2) { values.push(2); remaining /= 2; } values.push(remaining); return values.map((value) => `atempo=${number(value)}`); };
const mapCue = (cue: Pick<EditorialAudioCue, 'startSeconds' | 'endSeconds'>, segments: EditPlan['segments']) => { let cursor = 0; const ranges: Array<{ start: number; end: number }> = []; for (const segment of segments) { if (segment.action === 'remove') continue; const rate = segment.playbackRate || 1; const overlapStart = Math.max(cue.startSeconds, segment.sourceStartSeconds); const overlapEnd = Math.min(cue.endSeconds, segment.sourceEndSeconds); if (overlapEnd > overlapStart) ranges.push({ start: cursor + (overlapStart - segment.sourceStartSeconds) / rate, end: cursor + (overlapEnd - segment.sourceStartSeconds) / rate }); cursor += (segment.sourceEndSeconds - segment.sourceStartSeconds) / rate; } if (!ranges.length) return undefined; return { start: ranges[0].start, end: ranges[0].start + ranges.reduce((sum, range) => sum + range.end - range.start, 0) }; };
const effectiveCues = (soundtrack: SoundtrackResult, durationSeconds: number): MusicCue[] => soundtrack.cues?.length ? soundtrack.cues : soundtrack.asset && soundtrack.durationSeconds && soundtrack.prompt ? [{ id: 'legacy-continuous-score', startSeconds: 0, endSeconds: durationSeconds, type: 'music', purpose: 'Preserve a legacy continuous soundtrack.', mood: 'legacy', energy: .5, gainDb: -18, fadeInSeconds: .5, fadeOutSeconds: .75, dialoguePolicy: 'duck_under_dialogue', visualCompanion: '', asset: soundtrack.asset, durationSeconds: soundtrack.durationSeconds, prompt: soundtrack.prompt }] : [];
const dbFactor = (gainDb: number) => gainDb <= -90 ? 0 : 10 ** (gainDb / 20);
const hasVisualTreatment = (value?: { brightness: number; contrast: number; saturation: number; temperature: number }) => Boolean(value && (value.brightness || value.contrast || value.saturation || value.temperature));
const number = (value: number) => Number(value.toFixed(5));
// Rule-of-thirds resting zones for a sticker overlay, with a slide-in/out from the nearest off-
// screen edge (center holds still and relies on its own alpha fade instead). Every sticker used to
// hard-code the top-right corner; this generalizes that same slide formula to the chosen zone.
function stickerPosition(position: string | undefined, comicBubble: boolean, start: number, enterEnd: number, exitStart: number, end: number) {
  const zone = position || 'top-right';
  const restY = zone === 'bottom-left' || zone === 'bottom-right' ? 'H-h-48' : zone === 'center' ? '(H-h)/2' : '48';
  const y = comicBubble ? `${restY}+8*sin((t-${number(start)})*8)` : restY;
  if (zone === 'center') return { x: '(W-w)/2', y };
  const restX = zone === 'top-left' || zone === 'bottom-left' ? '48' : 'W-w-48';
  const offScreen = zone === 'top-left' || zone === 'bottom-left' ? '-w' : 'W';
  const enterProgress = `(t-${number(start)})/${number(Math.max(.01, enterEnd - start))}`;
  const exitProgress = `(t-${number(exitStart)})/${number(Math.max(.01, end - exitStart))}`;
  const x = `if(lt(t,${number(enterEnd)}),${offScreen}+(${restX}-(${offScreen}))*${enterProgress},if(gt(t,${number(exitStart)}),${restX}+(${offScreen}-(${restX}))*${exitProgress},${restX}))`;
  return { x, y };
}
const objectKey = (uri: string, bucket: string) => { const prefix = `gs://${bucket}/`; if (!uri.startsWith(prefix)) throw new Error('Source video must use the configured GCS bucket'); return decodeURIComponent(uri.slice(prefix.length)); };
const hasOutput = async (path: string) => { try { return (await stat(path)).size > 0; } catch { return false; } };
// stdout was previously discarded entirely, so a real, slow-but-alive encode was
// indistinguishable from a hung one from outside the process — nothing to check.
// -progress pipe:1 makes ffmpeg emit periodic frame/time/speed lines on stdout;
// log each one so `docker compose logs` shows real, verifiable progress.
const run = (command: string, args: string[]) => new Promise<void>((resolve, reject) => {
  const child = spawn(command, [...args, '-progress', 'pipe:1', '-nostats'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n'); buffer = lines.pop() || '';
    const frame = lines.find((line) => line.startsWith('frame=')); const outTime = lines.find((line) => line.startsWith('out_time='));
    const speed = lines.find((line) => line.startsWith('speed=')); const fps = lines.find((line) => line.startsWith('fps='));
    if (frame || outTime) console.log(`[ffmpeg progress] ${[frame, fps, outTime, speed].filter(Boolean).join(' ')}`);
  });
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-16_000); });
  child.on('error', reject);
  child.on('close', (code) => { if (code === 0) resolve(); else { const diagnostic = stderr.split('\n').map((line) => line.trim()).filter(Boolean).slice(-10).join(' | '); reject(new Error(`FFmpeg render failed (${code}): ${diagnostic.slice(-1400)}`)); } });
});
const safeId = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 96);
const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`${name} is required for advanced media rendering`); return value; };
