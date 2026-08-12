import { GoogleGenAI } from '@google/genai';
import { analysisResultSchema, type AnalysisResult } from '@dailies/shared';

export type AnalysisInput = { projectId: string; videoUri: string; mimeType: string; durationSeconds: number; outline: string };
export async function analyzeVideo(input: AnalysisInput): Promise<AnalysisResult> {
  const ai = new GoogleGenAI({ vertexai: true, project: required('GCP_PROJECT_ID'), location: process.env.VERTEX_LOCATION || 'global' });
  const prompt = `Analyze this creator-owned rough cut. Project id: ${input.projectId}. Known duration: ${input.durationSeconds} seconds. Optional outline: ${input.outline || 'none'}.
Return JSON with projectId, durationSeconds, timestamped scenes (id, startSeconds, endSeconds, summary, transcript, mood, energy 0-1, pacingFlags), soundtrackBrief (mood, tempo, instrumentation, prompt), and soundtrackSegments. Do not invent dialogue you cannot hear.`;
  const response = await ai.models.generateContent({ model: process.env.GEMINI_MODEL || 'gemini-3-flash-preview', contents: [{ role: 'user', parts: [{ fileData: { fileUri: input.videoUri, mimeType: input.mimeType } }, { text: prompt }] }], config: { responseMimeType: 'application/json', responseJsonSchema: analysisJsonSchema } });
  if (!response.text) throw new Error('Gemini returned no structured analysis');
  const parsed = analysisResultSchema.parse(JSON.parse(response.text));
  if (parsed.projectId !== input.projectId) throw new Error('Gemini project id mismatch');
  return parsed;
}
const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; };
const analysisJsonSchema = { type: 'object', additionalProperties: false, required: ['projectId', 'durationSeconds', 'scenes', 'soundtrackBrief', 'soundtrackSegments'], properties: { projectId: { type: 'string' }, durationSeconds: { type: 'number' }, scenes: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['id', 'startSeconds', 'endSeconds', 'summary', 'transcript', 'mood', 'energy', 'pacingFlags'], properties: { id: { type: 'string' }, startSeconds: { type: 'number' }, endSeconds: { type: 'number' }, summary: { type: 'string' }, transcript: { type: 'string' }, mood: { type: 'string' }, energy: { type: 'number', minimum: 0, maximum: 1 }, pacingFlags: { type: 'array', items: { type: 'string' } } } } }, soundtrackBrief: { type: 'object', additionalProperties: false, required: ['mood', 'tempo', 'instrumentation', 'prompt'], properties: { mood: { type: 'string' }, tempo: { type: 'string' }, instrumentation: { type: 'string' }, prompt: { type: 'string' } } }, soundtrackSegments: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['id', 'startSeconds', 'endSeconds', 'mood', 'energy', 'label'], properties: { id: { type: 'string' }, startSeconds: { type: 'number' }, endSeconds: { type: 'number' }, mood: { type: 'string' }, energy: { type: 'number', minimum: 0, maximum: 1 }, label: { type: 'string' } } } } } };
