import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Storage } from '@google-cloud/storage';
import { finalCutResultSchema, type EditPlan, type EditorialAudioCue, type FinalCutResult, type IntroOutroCard, type RenderCheckpoint, type SoundtrackResult } from '@dailies/shared';

type Input = { projectId: string; ownerId: string; sourceUri: string; sourceDurationSeconds: number; soundtrack: SoundtrackResult; editorialCues?: EditorialAudioCue[]; editPlan: EditPlan; executionAttempt?: number; checkpoint?: RenderCheckpoint };
type MusicCue = SoundtrackResult['cues'][number];

// ---------------------------------------------------------------------------
// Incremental render steps.
//
// The original renderer compiled every cut, every overlay and every audio cue into ONE ~8KB
// -filter_complex string and executed it in a single ffmpeg process. That design has no
// observable progress (one process, one output, nothing in between), nothing is attributable
// when it goes wrong (the whole graph either works or wedges), nothing is resumable, and its
// `split=N -> trim -> concat` shape buffers raw frames for every branch at once — which is fine
// on a 30GB dev box and is not fine on a 4Gi Cloud Run instance.
//
// Each edit is now its own small ffmpeg pass writing its own intermediate file:
//   step-00..NN  one pass per retained segment (cut + speed + colour + audio cleanup)
//   step-NN      concat the segments (stream copy, no re-encode)
//   step-NN      one pass per visual cue, composited onto the previous step
//   step-NN      one pass mixing the cue audio (video stream copied, not re-encoded)
// Every pass is logged with its elapsed time, is bounded to two inputs and a handful of filters,
// and is skipped when its output already exists — so a restart resumes at the last finished edit
// instead of redoing all of it, and a wedge names the exact edit that wedged.
//
// The tradeoff is real and deliberate: N sequential encodes instead of one. Intermediates use a
// fast, near-visually-lossless setting and the audio pass copies the video stream, so the cost is
// time rather than quality — bought in exchange for a render that can be watched, attributed,
// resumed, and bounded in memory.
const INTERMEDIATE_PRESET = process.env.FFMPEG_INTERMEDIATE_PRESET || 'veryfast';
const INTERMEDIATE_CRF = process.env.FFMPEG_INTERMEDIATE_CRF || '16';

export function buildSegmentStepArgs(sourcePath: string, outputPath: string, plan: EditPlan, segment: EditPlan['segments'][number]) {
  const rate = segment.playbackRate || 1;
  const sourceDuration = segment.sourceEndSeconds - segment.sourceStartSeconds;
  const videoFilters = [`setpts=(PTS-STARTPTS)/${number(rate)}`];
  const visual = segment.visualTreatment;
  if (visual && hasVisualTreatment(visual)) {
    videoFilters.push(`eq=brightness=${number(visual.brightness)}:contrast=${number(1 + visual.contrast)}:saturation=${number(1 + visual.saturation)}`);
    if (visual.temperature) videoFilters.push(`colorbalance=rs=${number(visual.temperature * .18)}:bs=${number(visual.temperature * -.18)}`);
  }
  videoFilters.push('format=yuv420p');
  const cleanup: string[] = [];
  if (plan.audioCleanup?.removeHum) cleanup.push(`highpass=f=${plan.audioCleanup.highPassHz}`, 'equalizer=f=60:t=q:w=8:g=-18', 'equalizer=f=120:t=q:w=8:g=-12');
  if (plan.audioCleanup?.reduceNoise) cleanup.push(`highpass=f=${plan.audioCleanup.highPassHz}`, 'afftdn=nr=10:nf=-35');
  const gainDb = segment.originalAudioGainDb ?? plan.originalAudioGainDb;
  const audioFilters = ['asetpts=PTS-STARTPTS', ...atempo(rate), `volume=${number(dbFactor(gainDb))}`, 'aformat=sample_rates=48000:channel_layouts=stereo'];
  if (gainDb > -90 && cleanup.length) audioFilters.unshift(...new Set(cleanup));
  return {
    outputDuration: sourceDuration / rate,
    // Input-side -ss/-t: ffmpeg seeks to the nearest keyframe and decodes forward to the exact
    // timestamp, so this is both accurate and cheap. It also means each pass only ever decodes its
    // own segment, instead of the whole source being decoded into N buffered split branches.
    args: ['-ss', number(segment.sourceStartSeconds).toString(), '-t', number(sourceDuration).toString(), '-i', sourcePath,
      '-vf', videoFilters.join(','), '-af', audioFilters.join(','),
      '-c:v', 'libx264', '-preset', INTERMEDIATE_PRESET, '-crf', INTERMEDIATE_CRF, '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-video_track_timescale', '90000', outputPath],
  };
}

export const buildConcatStepArgs = (listPath: string, outputPath: string) => ['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-movflags', '+faststart', outputPath];

// An additive intro/outro card: a fixed-duration clip built from a still image, encoded with the
// same codec params as buildSegmentStepArgs (aac/48000/stereo/90000 timescale) so it can be spliced
// into the same stream-copy concat as every other segment. scale2ref matches the image to the real
// source's dimensions — the same pattern buildOverlayStepArgs uses — since concat requires identical
// frame size across every file in the sequence. Silent (anullsrc) when the cue has no audio asset.
export function buildStillCardStepArgs(sourcePath: string, imagePath: string, durationSeconds: number, outputPath: string, audioPath?: string) {
  const filters = ['[0:v][1:v]scale2ref=w=main_w:h=main_h[scaled][ref]', '[scaled]format=yuv420p,fps=30,setsar=1[vout]'];
  const args = ['-f', 'image2', '-loop', '1', '-i', imagePath, '-i', sourcePath];
  args.push(...(audioPath ? ['-i', audioPath] : ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo']));
  // apad: a real cue audio asset shorter than the card's duration (e.g. a 1s pop under a 3s card)
  // would otherwise leave the output audio track shorter than its video track — apad pads with
  // silence indefinitely, and the output-level -t below is what actually bounds it.
  args.push('-filter_complex', filters.join(';'), '-map', '[vout]', '-map', '2:a', '-af', 'apad', '-t', number(durationSeconds).toString(),
    '-c:v', 'libx264', '-preset', INTERMEDIATE_PRESET, '-crf', INTERMEDIATE_CRF, '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-video_track_timescale', '90000', outputPath);
  return { outputDuration: durationSeconds, args };
}

export function buildOverlayStepArgs(basePath: string, overlayPath: string, outputPath: string, cue: Pick<EditorialAudioCue, 'visualMode' | 'position' | 'effectStyle'>, start: number, end: number) {
  const filters: string[] = [];
  // Delay the overlay by PADDING it with transparent frames from t=0, not by pushing its PTS forward.
  //
  // `setpts=PTS+start/TB` leaves the overlay branch with no frames at all across [0, start): its very
  // first frame carries pts=start. `overlay` will not emit a main frame until its second input has
  // delivered a frame at or past the current timestamp, so the graph runs fine right up to the cue and
  // then starves at precisely the moment the overlay is due — no error, no exit, both cores still
  // pinned, until the stall watchdog kills it. That is exactly the observed wedge: frame stuck at the
  // cue's own timestamp, fps decaying, killed at the stall timeout, repeated on every retry.
  //
  // tpad prepends real transparent frames instead, so the branch is a continuous stream from t=0 and
  // framesync always has something to pair with the main input. The `enable=` window is still what
  // decides when the overlay is actually visible.
  const delay = start > 0 ? `,tpad=start_duration=${number(start)}:start_mode=add:color=0x00000000` : '';
  if (cue.visualMode === 'full_frame') {
    filters.push('[1:v][0:v]scale2ref=w=main_w:h=main_h[scaled][base]');
    filters.push(`[scaled]format=rgba,fade=t=in:st=0:d=0.22:alpha=1,fade=t=out:st=${number(Math.max(.22, end - start - .28))}:d=0.28:alpha=1${delay}[ov]`);
    filters.push(`[base][ov]overlay=x=0:y=0:eof_action=pass:enable='between(t,${number(start)},${number(end)})'[vout]`);
  } else {
    const enterEnd = Math.min(end, start + .24); const exitStart = Math.max(start, end - .24);
    const { x, y } = stickerPosition(cue.position, cue.effectStyle === 'comic_bubble', start, enterEnd, exitStart, end);
    filters.push(`[1:v]scale='min(480,iw)':-1,format=rgba,fade=t=in:st=0:d=0.18:alpha=1,fade=t=out:st=${number(Math.max(.18, end - start - .22))}:d=0.22:alpha=1${delay}[ov]`);
    filters.push(`[0:v][ov]overlay=x='${x}':y='${y}':eof_action=pass:enable='between(t,${number(start)},${number(end)})'[vout]`);
  }
  // Audio is copied through untouched — this pass only composites one image onto the video.
  return ['-i', basePath, ...stillImageInput(overlayPath), '-filter_complex', filters.join(';'), '-map', '[vout]', '-map', '0:a',
    '-c:v', 'libx264', '-preset', INTERMEDIATE_PRESET, '-crf', INTERMEDIATE_CRF, '-c:a', 'copy', '-shortest', outputPath];
}

export function buildAudioMixStepArgs(videoPath: string, cuePaths: string[], outputPath: string, cues: MusicCue[], editorialCues: EditorialAudioCue[], segments: EditPlan['segments'], totalDuration: number, offsetSeconds = 0) {
  const filters: string[] = [];
  const replacementRanges = editorialCues
    .filter((cue) => cue.dialoguePolicy === 'replace_source_audio')
    .map((cue) => mapCue(cue, segments, offsetSeconds))
    .filter((range): range is { start: number; end: number } => Boolean(range));
  if (replacementRanges.length) {
    const active = replacementRanges.map((range) => `between(t,${number(range.start)},${number(range.end)})`).join('+');
    filters.push(`[0:a]volume='if(gt(${active},0),0,1)':eval=frame[dialogue]`);
  } else filters.push('[0:a]anull[dialogue]');
  const mixed: string[] = [];
  cues.forEach((cue, index) => {
    const mapped = mapCue(cue, segments, offsetSeconds); if (!mapped) return;
    const duration = mapped.end - mapped.start; const fadeIn = Math.min(cue.fadeInSeconds, duration / 2); const fadeOut = Math.min(cue.fadeOutSeconds, duration / 2);
    const reelStart = cue.sourceStartSeconds || 0; const reelEnd = cue.sourceEndSeconds || reelStart + duration;
    filters.push(`[${index + 1}:a]atrim=start=${number(reelStart)}:end=${number(Math.min(reelEnd, reelStart + duration))},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${number(fadeIn)},afade=t=out:st=${number(Math.max(0, duration - fadeOut))}:d=${number(fadeOut)},volume=${number(dbFactor(cue.gainDb))},adelay=${Math.round(mapped.start * 1000)}:all=1,apad,atrim=0:${number(totalDuration)},aformat=sample_rates=48000:channel_layouts=stereo[music${index}]`);
    mixed.push(`[music${index}]`);
  });
  if (mixed.length) filters.push(`[dialogue]${mixed.join('')}amix=inputs=${mixed.length + 1}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95:attack=5:release=50,aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo[aout]`);
  else filters.push('[dialogue]aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo[aout]');
  const inputs = cuePaths.flatMap((path) => ['-stream_loop', '-1', '-i', path]);
  // The video stream is copied, never re-encoded — this pass only rebuilds the audio.
  return ['-i', videoPath, ...inputs, '-filter_complex', filters.join(';'), '-map', '0:v', '-map', '[aout]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outputPath];
}

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
    // Pad with transparent frames rather than shifting PTS — see buildOverlayStepArgs for why a PTS
    // shift starves `overlay` at the cue timestamp and wedges the graph instead of failing.
    const delay = start > 0 ? `,tpad=start_duration=${number(start)}:start_mode=add:color=0x00000000` : '';
    if (fullFrame) {
      const base = `fullframebase${index}`; const scaled = `fullframescaled${index}`;
      filters.push(`[${inputIndex}:v][${videoLabel}]scale2ref=w=main_w:h=main_h[${scaled}][${base}]`);
      filters.push(`[${scaled}]format=rgba,fade=t=in:st=0:d=0.22:alpha=1,fade=t=out:st=${number(Math.max(.22, end - start - .28))}:d=0.28:alpha=1${delay}[${overlay}]`);
      filters.push(`[${base}][${overlay}]overlay=x=0:y=0:eof_action=pass:enable='between(t,${number(start)},${number(end)})'[${next}]`); videoLabel = next; return;
    }
    filters.push(`[${inputIndex}:v]scale='min(480,iw)':-1,format=rgba,fade=t=in:st=0:d=0.18:alpha=1,fade=t=out:st=${number(Math.max(.18, end - start - .22))}:d=0.22:alpha=1${delay}[${overlay}]`);
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
  return { filter: filters.join(';'), durationSeconds: outputCursor };
}

export function buildFfmpegArgs(sourcePath: string, cuePaths: string[], outputPath: string, plan: EditPlan, cues: MusicCue[] = [], editorialCues: EditorialAudioCue[] = [], visualPaths: string[] = []) {
  const built = buildFilterComplex(plan, cues, editorialCues);
  const inputs = cuePaths.flatMap((path) => ['-stream_loop', '-1', '-i', path]);
  // Still images are held open for the whole timeline; see stillImageInput for why the demuxer must
  // be forced. The overlay's own `enable=` window is what limits when each one is visible.
  const visualInputs = visualPaths.flatMap((path) => stillImageInput(path));
  return { durationSeconds: built.durationSeconds, args: ['-y', '-i', sourcePath, ...inputs, ...visualInputs, '-filter_complex', built.filter, '-map', '[vout]', '-map', '[aout]', '-c:v', 'libx264', '-preset', process.env.FFMPEG_PRESET || 'medium', '-crf', process.env.FFMPEG_CRF || '18', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outputPath] };
}

export async function renderWithFfmpeg(input: Input, onSubmitted?: (checkpoint: RenderCheckpoint) => Promise<void>, onStep?: (message: string) => Promise<void>): Promise<FinalCutResult> {
  const bucket = required('GCS_BUCKET'); const mount = process.env.GCS_MOUNT_PATH; const renderId = input.checkpoint?.assetId || `render_${safeId(input.projectId)}_${input.executionAttempt || 1}`;
  const sourceKey = objectKey(input.sourceUri, bucket); const cues = effectiveCues(input.soundtrack, input.sourceDurationSeconds);
  const cueKeys = cues.map((cue) => `${input.ownerId}/${input.projectId}/${cue.asset.id}/${cue.asset.fileName}`);
  const visualCues = cues.filter((cue) => cue.visualAsset);
  const outputKey = `${input.ownerId}/${input.projectId}/${renderId}/enhanced-final-cut.mp4`;
  const checkpoint = input.checkpoint || { renderJobId: `ffmpeg:${renderId}`, assetId: renderId, outputUri: `gs://${bucket}/${input.ownerId}/${input.projectId}/${renderId}/`, submittedAt: new Date().toISOString() };
  if (!input.checkpoint) await onSubmitted?.(checkpoint);
  const storage = new Storage({ projectId: process.env.GCP_PROJECT_ID }); const cloudOutput = storage.bucket(bucket).file(outputKey);
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  const log = async (message: string) => { console.log(`[render ${renderId}] ${message}`); await onStep?.(message); };
  // A stable, renderId-keyed workspace rather than a fresh mkdtemp: finished steps survive a worker
  // restart, so a resumed render picks up at the last completed edit instead of redoing every one.
  const workspace = join(tmpdir(), `dailies-render-${safeId(renderId)}`);
  const segments = input.editPlan.segments.filter((segment) => segment.action !== 'remove');
  if (!segments.length) throw new Error('Edit plan removed the entire source video');
  // An introOutro card is genuinely additional runtime spliced before/after the real segments, never
  // an overlay on top of them — see buildStillCardStepArgs. Its duration comes from the referenced
  // cue's own timing (endSeconds-startSeconds), which is otherwise irrelevant once introOutro claims
  // it: that cue no longer describes a window to composite onto the source timeline at all.
  const introOutro = input.editPlan.introOutro;
  const findIntroOutroCue = (cueId: string | undefined) => cueId ? (input.editorialCues || []).find((cue) => cue.id === cueId) : undefined;
  const introCue = findIntroOutroCue(introOutro?.intro?.cueId);
  const outroCue = findIntroOutroCue(introOutro?.outro?.cueId);
  const introDuration = introCue ? introCue.endSeconds - introCue.startSeconds : 0;
  const outroDuration = outroCue ? outroCue.endSeconds - outroCue.startSeconds : 0;
  const introOutroCueIds = new Set([introOutro?.intro?.cueId, introOutro?.outro?.cueId].filter((id): id is string => Boolean(id)));
  // A step output is only trustworthy if it was published by the atomic rename in `step` below.
  // Workspaces written by an earlier build can hold a truncated intermediate that still satisfies the
  // resume check, and such a workspace can never make progress again — every attempt skips the broken
  // step and fails on the next one. Discard any workspace that predates that guarantee, once.
  const marker = join(workspace, '.step-format-v2');
  if (!(await hasOutput(marker))) await rm(workspace, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(marker, 'v2');
  // Each failed render deliberately keeps its workspace so a retry can resume, but a *superseded*
  // render (a new draft, a new attempt id) will never be resumed and its intermediates are whole
  // copies of the timeline. Drop the ones this project can no longer use rather than leaking them.
  await pruneStaleWorkspaces(input.projectId, workspace);
  const cloudExists = Boolean(input.checkpoint) && (await cloudOutput.exists())[0];
  const finalPath = mount ? join(mount, outputKey) : join(workspace, 'enhanced-final-cut.mp4');
  await mkdir(dirname(finalPath), { recursive: true });
  const step = async (index: number, label: string, description: string, build: (outputPath: string) => string[]) => {
    const stem = join(workspace, `step-${String(index).padStart(2, '0')}-${safeId(label)}`);
    const outputPath = `${stem}.mp4`;
    if (await hasOutput(outputPath)) { await log(`${description} — already done, resuming past it.`); return outputPath; }
    // Encode to a scratch name and publish it with an atomic rename only after ffmpeg exits cleanly.
    //
    // A step that is killed — by the stall watchdog, by the container being stopped, by an OOM —
    // still leaves a non-empty file at its output path, and the resume check above only asks whether
    // that path exists. Writing in place therefore lets a truncated, moov-less intermediate be
    // treated as a finished step forever after: it is never re-encoded, every later step that reads
    // it fails instantly, and the job retries that same broken state indefinitely. Renaming last
    // means the real path can only ever name a completed encode.
    const partialPath = `${stem}.partial.mp4`;
    await rm(partialPath, { force: true });
    const startedAt = Date.now();
    try {
      await run(ffmpeg, build(partialPath));
    } catch (error) {
      await rm(partialPath, { force: true });
      throw error;
    }
    await rename(partialPath, outputPath);
    await log(`${description} — done in ${Math.round((Date.now() - startedAt) / 1000)}s.`);
    return outputPath;
  };
  try {
    if (!cloudExists) {
      const sourcePath = mount ? join(mount, sourceKey) : join(workspace, 'source-video');
      const cuePaths = cueKeys.map((key, index) => mount ? join(mount, key) : join(workspace, `music-cue-${index}`));
      const visualPaths = new Map<string, string>(visualCues.map((cue, index): [string, string] => [cue.id, mount ? join(mount, `${input.ownerId}/${input.projectId}/${cue.visualAsset!.id}/${cue.visualAsset!.fileName}`) : join(workspace, `visual-cue-${index}`)]));
      if (!mount) {
        // Source can be large; skip re-downloading it when a resumed render already has it. The cue
        // and sticker assets are small enough that re-fetching them is cheaper than checking.
        const sourceReady = await hasOutput(sourcePath);
        await Promise.all([
          ...(sourceReady ? [] : [storage.bucket(bucket).file(sourceKey).download({ destination: sourcePath })]),
          ...cueKeys.map((key, index) => storage.bucket(bucket).file(key).download({ destination: cuePaths[index] })),
          ...visualCues.map((cue) => storage.bucket(bucket).file(`${input.ownerId}/${input.projectId}/${cue.visualAsset!.id}/${cue.visualAsset!.fileName}`).download({ destination: visualPaths.get(cue.id)! })),
        ]);
      }

      let index = 0; let totalDuration = introDuration; const segmentPaths: string[] = [];
      // An additive card, built from either a still image (generated_card) or a real reused interval
      // the plan already marked remove (removed_footage — literally reuses buildSegmentStepArgs, the
      // same function every ordinary cut goes through). Spliced into segmentPaths before the concat
      // list is written, so it becomes real runtime rather than something composited on top of it.
      const buildIntroOutroStep = async (card: IntroOutroCard, cue: EditorialAudioCue, label: 'intro' | 'outro') => {
        if (card.source === 'removed_footage') {
          const synthetic: EditPlan['segments'][number] = { id: `${label}-card`, sourceStartSeconds: card.footageStartSeconds!, sourceEndSeconds: card.footageEndSeconds!, action: 'keep', playbackRate: 1, originalAudioGainDb: 0, soundtrackGainDb: -96, transition: 'cut', reason: `${label} card reusing removed footage` };
          return step(index += 1, `${label}-card`, `${label === 'intro' ? 'Intro' : 'Outro'} card: reused footage ${number(card.footageStartSeconds!)}s\u2013${number(card.footageEndSeconds!)}s`, (outputPath) => buildSegmentStepArgs(sourcePath, outputPath, input.editPlan, synthetic).args);
        }
        const imagePath = visualPaths.get(cue.id);
        if (!imagePath) throw new Error(`${label} card cue ${cue.id} has no generated visual asset`);
        const musicCueIndex = cues.findIndex((item) => item.id === cue.id);
        const audioPath = musicCueIndex >= 0 ? cuePaths[musicCueIndex] : undefined;
        const duration = cue.endSeconds - cue.startSeconds;
        return step(index += 1, `${label}-card`, `${label === 'intro' ? 'Intro' : 'Outro'} card: generated visual, ${number(duration)}s`, (outputPath) => buildStillCardStepArgs(sourcePath, imagePath, duration, outputPath, audioPath).args);
      };
      if (introOutro?.intro && introCue) segmentPaths.push(await buildIntroOutroStep(introOutro.intro, introCue, 'intro'));

      for (const [position, segment] of segments.entries()) {
        const built = buildSegmentStepArgs(sourcePath, '', input.editPlan, segment);
        totalDuration += built.outputDuration;
        segmentPaths.push(await step(index += 1, `cut-${position + 1}`, `Cut ${position + 1} of ${segments.length} (${number(segment.sourceStartSeconds)}s–${number(segment.sourceEndSeconds)}s${(segment.playbackRate || 1) !== 1 ? ` at ${number(segment.playbackRate)}×` : ''})`,
          (outputPath) => buildSegmentStepArgs(sourcePath, outputPath, input.editPlan, segment).args));
      }

      if (introOutro?.outro && outroCue) { segmentPaths.push(await buildIntroOutroStep(introOutro.outro, outroCue, 'outro')); totalDuration += outroDuration; }

      const listPath = join(workspace, 'segments.txt');
      await writeFile(listPath, segmentPaths.map((path) => `file '${path.replace(/'/g, "'\\''")}'`).join('\n'));
      let current = await step(index += 1, 'assembled', `Assembled ${segmentPaths.length} cuts into one timeline`, (outputPath) => buildConcatStepArgs(listPath, outputPath));

      // One pass per visual cue, each composited onto the previous step's output. A cue that wedges
      // now names itself in the logs and is killed by the watchdog on its own, instead of taking an
      // entire monolithic graph — and everything already composited before it is kept.
      // Defensive dedup by cue id: whatever produced input.editorialCues should never contain the
      // same cue twice, but compositing a duplicate would silently double-expose that one visual, so
      // guard against it here regardless of how it got in. introOutro cues are excluded outright —
      // their card was already spliced in above as additional runtime, not composited as an overlay.
      const overlayCues = (input.editorialCues || []).filter((cue) => !introOutroCueIds.has(cue.id));
      const overlays = overlayCues.filter((cue, index, all) => all.findIndex((other) => other.id === cue.id) === index)
        .map((cue) => ({ cue, mapped: mapCue(cue, segments, introDuration), path: visualPaths.get(cue.id) })).filter((entry) => entry.mapped && entry.path);
      for (const [position, entry] of overlays.entries()) {
        const start = entry.mapped!.start;
        const span = entry.mapped!.end - entry.mapped!.start;
        const end = Math.min(totalDuration, start + (entry.cue.visualMode === 'full_frame' ? span : Math.min(1.8, Math.max(.7, span))));
        const base = current;
        current = await step(index += 1, `visual-${entry.cue.id}`, `Visual ${position + 1} of ${overlays.length}: ${entry.cue.visualMode === 'full_frame' ? 'full-frame card' : 'sticker'} "${entry.cue.id}" at ${number(start)}s`,
          (outputPath) => buildOverlayStepArgs(base, entry.path!, outputPath, entry.cue, start, end));
      }

      // introOutro cues are excluded here too — their audio is already baked into the spliced card
      // clip itself (buildIntroOutroStep), so mixing it again would duplicate it. cuePaths must stay
      // index-aligned with cues (buildAudioMixStepArgs maps cues[i] to input stream [i+1:a]), so both
      // are filtered together rather than filtering cues alone. offsetSeconds shifts every remaining
      // cue's mapped position to account for the prepended intro's runtime.
      const keptCueIndices = cues.map((_cue, cueIndex) => cueIndex).filter((cueIndex) => !introOutroCueIds.has(cues[cueIndex].id));
      const mixCues = keptCueIndices.map((cueIndex) => cues[cueIndex]);
      const mixCuePaths = keptCueIndices.map((cueIndex) => cuePaths[cueIndex]);
      const mixed = await step(index += 1, 'audio-mix', `Mixed ${mixCues.length} audio cue${mixCues.length === 1 ? '' : 's'} under the dialogue`,
        (outputPath) => buildAudioMixStepArgs(current, mixCuePaths, outputPath, mixCues, overlayCues, segments, totalDuration, introDuration));
      await copyFile(mixed, finalPath);
      await log(`Render complete: ${Math.round(totalDuration)}s across ${index} steps.`);
      if (!mount) await storage.bucket(bucket).upload(finalPath, { destination: outputKey, contentType: 'video/mp4', resumable: true, metadata: { cacheControl: 'private, max-age=0' } });
      await rm(workspace, { recursive: true, force: true });
      return finalCutResultSchema.parse({ asset: { id: renderId, kind: 'rendered_video', fileName: 'enhanced-final-cut.mp4', mimeType: 'video/mp4', generationModel: 'ffmpeg-node-media-pipeline', createdAt: new Date().toISOString() }, durationSeconds: totalDuration, renderProvider: 'ffmpeg-cloud-run', renderJobId: checkpoint.renderJobId });
    }
    const durationSeconds = introDuration + outroDuration + segments.reduce((sum, segment) => sum + (segment.sourceEndSeconds - segment.sourceStartSeconds) / (segment.playbackRate || 1), 0);
    await rm(workspace, { recursive: true, force: true });
    return finalCutResultSchema.parse({ asset: { id: renderId, kind: 'rendered_video', fileName: 'enhanced-final-cut.mp4', mimeType: 'video/mp4', generationModel: 'ffmpeg-node-media-pipeline', createdAt: new Date().toISOString() }, durationSeconds, renderProvider: 'ffmpeg-cloud-run', renderJobId: checkpoint.renderJobId });
  } catch (error) {
    // Deliberately NOT cleaning up here: the finished steps are what make a retry resume instead of
    // restarting from the first cut. The workspace is removed on success and on a fresh renderId.
    await log(`Render step failed; completed steps kept in ${workspace} so a retry resumes from there.`);
    throw error;
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
      args.push(...stillImageInput(overlayPath));
      if (fullFrame) {
        filters.push('[1:v][0:v]scale2ref=w=main_w:h=main_h[scaled][base]', '[scaled]format=rgba[ov]', `[base][ov]overlay=x=0:y=0:enable='between(t,${number(start)},${number(end)})'[vout]`);
      } else {
        const { x, y } = stickerPosition(cue.position, cue.effectStyle === 'comic_bubble', start, Math.min(end, start + .24), Math.max(start, end - .24), end);
        filters.push(`[1:v]scale='min(480,iw)':-1,format=rgba[ov]`, `[0:v][ov]overlay=x='${x}':y='${y}':enable='between(t,${number(start)},${number(end)})'[vout]`);
      }
      args.push('-filter_complex', filters.join(';')); mapArgs = ['-map', '[vout]', '-map', '0:a'];
    }
    args.push(...mapArgs, '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-c:a', 'aac', outputPath);
    await run(process.env.FFMPEG_PATH || 'ffmpeg', args);
    const previewKey = `${input.ownerId}/${input.projectId}/preview_${safeId(cue.id)}/preview.mp4`;
    await storage.bucket(bucket).upload(outputPath, { destination: previewKey, contentType: 'video/mp4' });
    return { uri: `gs://${bucket}/${previewKey}`, mimeType: 'video/mp4' };
  } finally {
    if (workspace) await rm(workspace, { recursive: true, force: true });
  }
}
const atempo = (rate: number) => { const values: number[] = []; let remaining = rate; while (remaining > 2) { values.push(2); remaining /= 2; } values.push(remaining); return values.map((value) => `atempo=${number(value)}`); };
// offsetSeconds shifts every mapped position later by however much additive intro time was spliced
// in before segment 0 (see introDuration in renderWithFfmpeg) — segments themselves are still timed
// from their own cursor at 0, this just accounts for the prepended card that isn't one of them.
const mapCue = (cue: Pick<EditorialAudioCue, 'startSeconds' | 'endSeconds'>, segments: EditPlan['segments'], offsetSeconds = 0) => { let cursor = offsetSeconds; const ranges: Array<{ start: number; end: number }> = []; for (const segment of segments) { if (segment.action === 'remove') continue; const rate = segment.playbackRate || 1; const overlapStart = Math.max(cue.startSeconds, segment.sourceStartSeconds); const overlapEnd = Math.min(cue.endSeconds, segment.sourceEndSeconds); if (overlapEnd > overlapStart) ranges.push({ start: cursor + (overlapStart - segment.sourceStartSeconds) / rate, end: cursor + (overlapEnd - segment.sourceStartSeconds) / rate }); cursor += (segment.sourceEndSeconds - segment.sourceStartSeconds) / rate; } if (!ranges.length) return undefined; return { start: ranges[0].start, end: ranges[0].start + ranges.reduce((sum, range) => sum + range.end - range.start, 0) }; };
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
// -progress pipe:1 makes ffmpeg emit periodic frame/time/speed lines on stdout so the encode is
// observable from `docker compose logs` instead of being a silent black box.
//
// Two hard limits sit on top of that, because a filter-graph deadlock in this renderer does not
// exit, does not error, and does not stop burning CPU — it spins forever on the host machine:
//   * FFMPEG_STALL_TIMEOUT_MS — no advance in the reported frame count for this long means the
//     graph is wedged, not slow. Kill it and fail the job so a person is not left waiting on a
//     process that will never finish.
//   * FFMPEG_MAX_RUNTIME_MS — an absolute ceiling for the whole encode, in case ffmpeg reports
//     progress but is pathologically slow.
// Both kill the child, so a wedged render can never again pin cores indefinitely.
const STALL_TIMEOUT_MS = Number(process.env.FFMPEG_STALL_TIMEOUT_MS || 120_000);
const MAX_RUNTIME_MS = Number(process.env.FFMPEG_MAX_RUNTIME_MS || 1_800_000);
const run = (command: string, args: string[]) => new Promise<void>((resolve, reject) => {
  // Leave headroom on the host: an unbounded encode otherwise takes every core it can get.
  const threads = process.env.FFMPEG_THREADS || String(Math.max(1, Math.min(4, (availableParallelism?.() ?? 4) - 2)));
  const child = spawn(command, ['-threads', threads, '-filter_complex_threads', threads, ...args, '-progress', 'pipe:1', '-nostats'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; let buffer = ''; let lastFrame = ''; let lastProgressAt = Date.now(); let abort: string | undefined;
  const startedAt = Date.now();
  const stop = (reason: string) => { abort = reason; child.kill('SIGKILL'); };
  const watchdog = setInterval(() => {
    if (Date.now() - startedAt > MAX_RUNTIME_MS) return stop(`exceeded the ${Math.round(MAX_RUNTIME_MS / 1000)}s maximum render runtime`);
    if (Date.now() - lastProgressAt > STALL_TIMEOUT_MS) return stop(`produced no new frames for ${Math.round(STALL_TIMEOUT_MS / 1000)}s at ${lastFrame || 'frame=0'} — the filter graph is deadlocked`);
  }, 10_000);
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n'); buffer = lines.pop() || '';
    const frame = lines.find((line) => line.startsWith('frame=')); const outTime = lines.find((line) => line.startsWith('out_time='));
    const speed = lines.find((line) => line.startsWith('speed=')); const fps = lines.find((line) => line.startsWith('fps='));
    // Only a *changing* frame count counts as progress; ffmpeg keeps emitting identical progress
    // blocks while wedged, which is exactly what made a deadlock look like a slow encode.
    if (frame && frame !== lastFrame) { lastFrame = frame; lastProgressAt = Date.now(); }
    if (frame || outTime) console.log(`[ffmpeg progress] ${[frame, fps, outTime, speed].filter(Boolean).join(' ')}`);
  });
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-16_000); });
  child.on('error', (error) => { clearInterval(watchdog); reject(error); });
  child.on('close', (code) => {
    clearInterval(watchdog);
    // Carry ffmpeg's own last words on the abort path too, not just the non-zero-exit path. A killed
    // process reports no exit diagnostic of its own, so dropping stderr here left a wedge showing
    // only "no new frames" — with nothing about which input or filter it died holding.
    const diagnostic = stderr.split('\n').map((line) => line.trim()).filter(Boolean).slice(-10).join(' | ');
    if (abort) return reject(new Error(`FFmpeg render aborted: ${abort}${diagnostic ? ` — last ffmpeg output: ${diagnostic.slice(-900)}` : ''}`));
    if (code === 0) return resolve();
    reject(new Error(`FFmpeg render failed (${code}): ${diagnostic.slice(-1400)}`));
  });
});
const safeId = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 96);
// Input args for a still image that must be held for the length of the video it is composited onto.
//
// `-f image2` is not cosmetic and must not be dropped. `loop` is an option of the *image2* demuxer,
// but a bare `-i sticker.png` is probed into `png_pipe`, which has no such option — so `-loop 1`
// lands on a demuxer that does not implement it and the read spins without ever emitting a frame.
// It fails per-file rather than outright: the 1024x1024 PNGs Gemini generates loop fine, while every
// 160x160 RGBA emoji from the fixed library hangs, which is why this only ever bit cues that used
// select_library_emoji. There is no filter graph involved — `ffmpeg -loop 1 -i emoji.png -f null -`
// alone never terminates, and burns a core while it does not. Forcing the image2 demuxer makes
// `-loop 1` mean what it says for every asset.
//
// (An earlier note here blamed an input-level `-t` for the same hang and warned against bounding
// these inputs. That was the wrong culprit — this is, and `-t` is safe once the demuxer is right.)
const stillImageInput = (path: string) => ['-f', 'image2', '-loop', '1', '-i', path];
// Best-effort: a render must never fail because a leftover directory could not be swept.
const pruneStaleWorkspaces = async (projectId: string, keep: string) => {
  const root = tmpdir(); const prefix = `dailies-render-${safeId(`render_${safeId(projectId)}`)}`;
  try {
    const entries = await readdir(root, { withFileTypes: true });
    await Promise.all(entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix) && join(root, entry.name) !== keep)
      .map((entry) => rm(join(root, entry.name), { recursive: true, force: true })));
  } catch { /* nothing to sweep, or tmp is not readable — neither is worth failing over */ }
};
const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`${name} is required for advanced media rendering`); return value; };
