import { z } from 'zod';

export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  FIRESTORE_PROJECTS_COLLECTION: z.string().default('dailies_projects'),
  GCP_PROJECT_ID: z.string().optional(),
  GCS_BUCKET: z.string().optional(),
  AGENT_SERVICE_URL: z.string().url().optional(),
  AGENT_SERVICE_AUDIENCE: z.string().optional(),
  AGENT_SERVICE_TOKEN: z.string().optional(),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  YOUTUBE_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  YOUTUBE_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  YOUTUBE_OAUTH_REDIRECT_URI: z.string().url().optional(),
  YOUTUBE_OAUTH_SUCCESS_URL: z.string().url().optional(),
  YOUTUBE_TOKEN_ENCRYPTION_KEY: z.string().min(1).optional(),
  INGESTION_SERVICE_URL: z.string().url().optional(),
  INGESTION_SERVICE_AUDIENCE: z.string().optional(),
  INGESTION_SERVICE_TOKEN: z.string().optional(),
  FIRESTORE_YOUTUBE_CONNECTIONS_COLLECTION: z.string().default('dailies_youtube_connections'),
  FIRESTORE_YOUTUBE_STATES_COLLECTION: z.string().default('dailies_youtube_oauth_states'),
});
export type Config = z.infer<typeof configSchema>;
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => configSchema.parse(env);
