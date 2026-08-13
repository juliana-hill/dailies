import type { AnalysisResult } from '@dailies/shared';

export type GeneratedSoundtrack = {
  bytes: Buffer;
  mimeType: string;
  model: string;
  provider: 'treblo';
  providerJobId: string;
};

export type TrebloGeneration = {
  taskId: string;
  prompt: string;
};

const TERMINAL_FAILURE = new Set(['FAILURE', 'FAILED', 'CANCELLED', 'CANCELED']);

export function shouldFallbackFromLyria(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

export function soundtrackLengthRange(cues: AnalysisResult['audioCues']): [number, number] {
  const requested = cues.reduce((total, cue) => total + Math.max(0.5, cue.endSeconds - cue.startSeconds) + 1.5, 0);
  const maximum = Math.min(300, Math.max(30, Math.ceil(requested / 30) * 30));
  const minimum = Math.max(0, maximum - 30);
  return [minimum, maximum];
}

export async function startTrebloGeneration(prompt: string, cues: AnalysisResult['audioCues']): Promise<TrebloGeneration> {
  const apiKey = required('TREBLO_API_KEY');
  const baseUrl = (process.env.TREBLO_API_BASE_URL || 'https://api.treblo.com/v1').replace(/\/$/, '');
  const model = process.env.TREBLO_MODEL || 'v3';
  const response = await fetch(`${baseUrl}/generations/${model}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt,
      instrumental: true,
      length_range: soundtrackLengthRange(cues),
      output_format: 'mp3',
      output_bit_rate: 192,
      enable_streaming: false,
    }),
  });
  if (!response.ok) throw new Error(`Treblo generation request failed with HTTP ${response.status}: ${safeDiagnostic(await response.text())}`);
  const payload = await response.json() as { task_id?: string };
  if (!payload.task_id) throw new Error('Treblo generation response did not include a task id');
  return { taskId: payload.task_id, prompt };
}

export async function awaitTrebloGeneration(
  taskId: string,
  onActivity?: (message: string) => void | Promise<void>,
): Promise<GeneratedSoundtrack> {
  const apiKey = required('TREBLO_API_KEY');
  const baseUrl = (process.env.TREBLO_API_BASE_URL || 'https://api.treblo.com/v1').replace(/\/$/, '');
  const pollMs = Math.max(1_000, Number(process.env.TREBLO_POLL_INTERVAL_MS || 5_000));
  const timeoutMs = Math.max(60_000, Number(process.env.TREBLO_GENERATION_TIMEOUT_MS || 15 * 60_000));
  const startedAt = Date.now();
  let previousStatus = '';
  while (Date.now() - startedAt < timeoutMs) {
    const response = await fetch(`${baseUrl}/generations/status/${encodeURIComponent(taskId)}`, { headers: { authorization: `Bearer ${apiKey}` } });
    if (!response.ok) throw new Error(`Treblo status request failed with HTTP ${response.status}: ${safeDiagnostic(await response.text())}`);
    const payload = await response.json();
    const status = String(typeof payload === 'string' ? payload : payload?.status || '').toUpperCase();
    if (status && status !== previousStatus) {
      previousStatus = status;
      await onActivity?.(`Treblo soundtrack job ${humanizeStatus(status)}.`);
    }
    if (status === 'SUCCESS') break;
    if (TERMINAL_FAILURE.has(status)) throw new Error(`Treblo soundtrack generation failed${payload?.error_message ? `: ${safeDiagnostic(String(payload.error_message))}` : ''}`);
    await delay(pollMs);
  }
  if (Date.now() - startedAt >= timeoutMs) throw new Error(`Treblo soundtrack generation did not finish within ${Math.round(timeoutMs / 60_000)} minutes`);

  const resultResponse = await fetch(`${baseUrl}/generations/${encodeURIComponent(taskId)}`, { headers: { authorization: `Bearer ${apiKey}` } });
  if (!resultResponse.ok) throw new Error(`Treblo result request failed with HTTP ${resultResponse.status}: ${safeDiagnostic(await resultResponse.text())}`);
  const result = await resultResponse.json() as { song_paths?: string[]; model_version?: string; error_message?: string };
  const audioUrl = result.song_paths?.[0];
  if (!audioUrl) throw new Error(`Treblo completed without an audio URL${result.error_message ? `: ${safeDiagnostic(result.error_message)}` : ''}`);
  const audioResponse = await fetch(audioUrl);
  if (!audioResponse.ok) throw new Error(`Treblo audio download failed with HTTP ${audioResponse.status}`);
  return {
    bytes: Buffer.from(await audioResponse.arrayBuffer()),
    mimeType: audioResponse.headers.get('content-type')?.split(';')[0] || 'audio/mpeg',
    model: `treblo-${result.model_version || process.env.TREBLO_MODEL || 'v3'}`,
    provider: 'treblo',
    providerJobId: taskId,
  };
}

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const humanizeStatus = (status: string) => status.toLowerCase().replaceAll('_', ' ');
const safeDiagnostic = (value: string) => value.replace(/(token|secret|password|authorization|api[_-]?key)=?\S*/gi, '$1=[redacted]').replace(/\s+/g, ' ').slice(0, 500);
const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; };
