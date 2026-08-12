import { z } from 'zod';

export const projectStatusSchema = z.enum(['idle', 'uploading', 'processing', 'complete', 'failed']);
export type ProjectStatus = z.infer<typeof projectStatusSchema>;

export const projectSchema = z.object({
  projectId: z.string(),
  status: projectStatusSchema,
});
export type Project = z.infer<typeof projectSchema>;
