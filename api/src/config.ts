import { z } from 'zod';

const bool = z.enum(['true', 'false']).default('false').transform((v) => v === 'true');
export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  DAILIES_FIXTURE_MODE: bool,
  ALLOW_DEV_AUTH: bool,
  DEV_AUTH_EMAIL: z.string().email().default('creator@example.com'),
  DEV_AUTH_NAME: z.string().default('Local Creator'),
  PROJECT_STORE_PATH: z.string().default('.data/projects.json'),
  PROJECT_REPOSITORY: z.enum(['firestore', 'file']).default('firestore'),
  FIRESTORE_PROJECTS_COLLECTION: z.string().default('dailies_projects'),
  GCP_PROJECT_ID: z.string().optional(),
  GCS_BUCKET: z.string().optional(),
  AGENT_SERVICE_URL: z.string().url().optional(),
  AGENT_SERVICE_AUDIENCE: z.string().optional(),
  AGENT_SERVICE_TOKEN: z.string().optional(),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
});
export type Config = z.infer<typeof configSchema>;
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => configSchema.parse(env);
