import { GoogleGenAI } from '@google/genai';
import { editPlanSchema, type AnalysisResult, type EditPlan, type Recommendation } from '@dailies/shared';

export async function createEditPlan(analysis: AnalysisResult, recommendation: Recommendation): Promise<EditPlan> {
  const ai = new GoogleGenAI({ vertexai: true, project: required('GCP_PROJECT_ID'), location: process.env.VERTEX_LOCATION || 'global' });
  const prompt = `Create a conservative automatic edit plan for project ${analysis.projectId}.
The source is ${analysis.durationSeconds} seconds long. Preserve dialogue, story continuity, and intentional pauses. Tighten only moments supported by pacing flags or retention evidence. Never invent footage or reorder speech.
Analysis: ${JSON.stringify(analysis.scenes)}
Retention recommendation: ${JSON.stringify(recommendation)}
Return JSON with projectId, rationale, originalAudioGainDb, soundtrackGainDb, and segments. Every segment needs id, optional sceneId, sourceStartSeconds, sourceEndSeconds, action (keep, tighten, or remove), and reason. Segments must cover the source timeline in chronological order.`;
  const response = await ai.models.generateContent({ model: process.env.GEMINI_MODEL || 'gemini-3-flash-preview', contents: prompt, config: { responseMimeType: 'application/json', responseJsonSchema: editPlanJsonSchema } });
  if (!response.text) throw new Error('Gemini returned no edit plan');
  const plan = editPlanSchema.parse(JSON.parse(response.text));
  if (plan.projectId !== analysis.projectId) throw new Error('Gemini edit-plan project id mismatch');
  return plan;
}

const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; };
const editPlanJsonSchema = { type: 'object', additionalProperties: false, required: ['projectId', 'segments', 'rationale', 'originalAudioGainDb', 'soundtrackGainDb'], properties: { projectId: { type: 'string' }, rationale: { type: 'string' }, originalAudioGainDb: { type: 'number', maximum: 0 }, soundtrackGainDb: { type: 'number', maximum: 0 }, segments: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['id', 'sourceStartSeconds', 'sourceEndSeconds', 'action', 'reason'], properties: { id: { type: 'string' }, sceneId: { type: 'string' }, sourceStartSeconds: { type: 'number' }, sourceEndSeconds: { type: 'number' }, action: { type: 'string', enum: ['keep', 'tighten', 'remove'] }, reason: { type: 'string' } } } } } };
