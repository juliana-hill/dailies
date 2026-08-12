# Dailies

Dailies is an agentic post-production assistant for YouTube creators. The production path uploads creator-owned footage to Cloud Storage, analyzes it with Gemini multimodal, generates an instrumental score with Lyria, queries the creator's normalized retention history through the official ClickHouse MCP server, and returns a grounded next-cut recommendation.

The app never silently falls back to demo data. `DAILIES_FIXTURE_MODE` defaults to `false`; explicit fixture mode is visibly labeled throughout the UI.

## Architecture

- `frontend/`: Terra's React/Redux Toolkit UI, now backed by authenticated API calls.
- `api/`: Express ownership, upload, persistence, asset, and orchestration boundary.
- `shared/`: TypeScript/Zod contracts.
- `agents/`: Node.js/TypeScript Express orchestration service for Gemini, Lyria, ClickHouse MCP, edit planning, and Cloud Transcoder. Pipeline jobs, leases, checkpoints, and an append-only event ledger are persisted in Firestore.
- `ingestion/`: Node.js/TypeScript Express service for official YouTube Analytics OAuth sync and controlled ClickHouse writes.
- `infra/`: corrected ClickHouse schema and deployment configuration.

The ClickHouse insight read path is `Retention Agent → mcp-clickhouse run_query → ClickHouse Cloud`. The ingestion worker uses a separate least-privilege write user; the MCP user remains read-only.

## Local development

Requirements: Node 20+, Google Cloud Application Default Credentials, a private Cloud Storage bucket, a ClickHouse database, and creator-authorized YouTube OAuth credentials.

```bash
cp .env.example .env
npm install
npm run build
npm test
PORT=8081 AGENT_SERVICE_TOKEN=local-agent-token npm run dev:agents
PORT=8082 INGESTION_SERVICE_TOKEN=local-ingestion-token npm run dev:ingestion
ALLOW_DEV_AUTH=true PROJECT_REPOSITORY=file AGENT_SERVICE_URL=http://localhost:8081 AGENT_SERVICE_TOKEN=local-agent-token npm run dev:api
npm run dev:frontend
```

Local auth is allowed only when `ALLOW_DEV_AUTH=true` and `NODE_ENV` is not `production`. Production trusts Google Cloud's authenticated identity headers; see [authentication](docs/authentication.md).

## Deployment

Set the project and region first:

```bash
gcloud config set project "$GCP_PROJECT_ID"
gcloud services enable artifactregistry.googleapis.com cloudbuild.googleapis.com run.googleapis.com aiplatform.googleapis.com storage.googleapis.com firestore.googleapis.com secretmanager.googleapis.com youtubeanalytics.googleapis.com youtube.googleapis.com
gcloud artifacts repositories create dailies --repository-format=docker --location="$VERTEX_LOCATION"
gcloud builds submit . --config infra/cloudbuild.yaml --substitutions="_DOCKERFILE=agents/Dockerfile,_IMAGE=$VERTEX_LOCATION-docker.pkg.dev/$GCP_PROJECT_ID/dailies/agents:latest"
gcloud run deploy dailies-agents --image "$VERTEX_LOCATION-docker.pkg.dev/$GCP_PROJECT_ID/dailies/agents:latest" --region "$VERTEX_LOCATION" --no-allow-unauthenticated --no-cpu-throttling --min 1 --memory 2Gi --timeout 900 --service-account "dailies-agents@$GCP_PROJECT_ID.iam.gserviceaccount.com" --set-env-vars "GCP_PROJECT_ID=$GCP_PROJECT_ID,GCS_BUCKET=$GCS_BUCKET,VERTEX_LOCATION=$VERTEX_LOCATION,GEMINI_MODEL=$GEMINI_MODEL,LYRIA_MODEL=$LYRIA_MODEL,CLICKHOUSE_MCP_URL=$CLICKHOUSE_MCP_URL,FIRESTORE_PROJECTS_COLLECTION=dailies_projects,FIRESTORE_JOBS_COLLECTION=dailies_pipeline_jobs,PIPELINE_LEASE_SECONDS=60" --set-secrets "CLICKHOUSE_MCP_AUTH_TOKEN=clickhouse-mcp-token:latest"
export AGENT_SERVICE_URL="$(gcloud run services describe dailies-agents --region "$VERTEX_LOCATION" --format='value(status.url)')"
gcloud builds submit . --config infra/cloudbuild.yaml --substitutions="_DOCKERFILE=api/Dockerfile,_IMAGE=$VERTEX_LOCATION-docker.pkg.dev/$GCP_PROJECT_ID/dailies/api:latest"
gcloud run deploy dailies-api --image "$VERTEX_LOCATION-docker.pkg.dev/$GCP_PROJECT_ID/dailies/api:latest" --region "$VERTEX_LOCATION" --no-allow-unauthenticated --no-cpu-throttling --memory 1Gi --timeout 900 --service-account "dailies-api@$GCP_PROJECT_ID.iam.gserviceaccount.com" --set-env-vars "GCP_PROJECT_ID=$GCP_PROJECT_ID,GCS_BUCKET=$GCS_BUCKET,AGENT_SERVICE_URL=$AGENT_SERVICE_URL,AGENT_SERVICE_AUDIENCE=$AGENT_SERVICE_URL,PROJECT_REPOSITORY=firestore,DAILIES_FIXTURE_MODE=false"
gcloud run services add-iam-policy-binding dailies-agents --region "$VERTEX_LOCATION" --member "serviceAccount:dailies-api@$GCP_PROJECT_ID.iam.gserviceaccount.com" --role roles/run.invoker
gcloud builds submit . --config infra/cloudbuild.yaml --substitutions="_DOCKERFILE=frontend/Dockerfile,_IMAGE=$VERTEX_LOCATION-docker.pkg.dev/$GCP_PROJECT_ID/dailies/frontend:latest"
gcloud run deploy dailies-frontend --image "$VERTEX_LOCATION-docker.pkg.dev/$GCP_PROJECT_ID/dailies/frontend:latest" --region "$VERTEX_LOCATION" --no-allow-unauthenticated
gcloud builds submit . --config infra/cloudbuild.yaml --substitutions="_DOCKERFILE=ingestion/Dockerfile,_IMAGE=$VERTEX_LOCATION-docker.pkg.dev/$GCP_PROJECT_ID/dailies/ingestion:latest"
gcloud run deploy dailies-ingestion --image "$VERTEX_LOCATION-docker.pkg.dev/$GCP_PROJECT_ID/dailies/ingestion:latest" --region "$VERTEX_LOCATION" --no-allow-unauthenticated --service-account "dailies-ingestion@$GCP_PROJECT_ID.iam.gserviceaccount.com" --set-env-vars "CLICKHOUSE_HOST=$CLICKHOUSE_HOST,CLICKHOUSE_INGEST_USER=$CLICKHOUSE_INGEST_USER,CLICKHOUSE_SECURE=true" --set-secrets "YOUTUBE_OAUTH_TOKEN_JSON=youtube-oauth-token:latest,CLICKHOUSE_INGEST_PASSWORD=clickhouse-ingest-password:latest,INGESTION_SERVICE_TOKEN=ingestion-service-token:latest"
```

Build and serve `frontend/dist` behind the same IAP-protected HTTPS origin or set `VITE_API_BASE_URL` and an exact credentialed CORS origin before building. Apply `infra/clickhouse/schema.sql` with the controlled ingestion identity. Grant the agent MCP identity `SELECT` only; never set `CLICKHOUSE_ALLOW_WRITE_ACCESS=true` for the agent service.

Lyria 3 is public preview. The configured default is `lyria-3-pro-preview` on the global interactions endpoint; model access, quotas, and response format must be smoke-tested in the target project before deployment is called verified.

## Durable pipeline recovery

Each project has one durable job document in `dailies_pipeline_jobs`. The document stores the latest stage outputs required to resume, the active worker lease, retry timing, and the final report. Its `events` subcollection is an append-only execution record covering submission, lease ownership, checkpoints, automatic retry scheduling, completion, and terminal failure. Workers renew short leases while running; another instance reclaims an expired lease after a crash or deployment. Transcoder job IDs and output locations are checkpointed and deterministic for each execution attempt, preventing duplicate renders during the submission/checkpoint failure window. Transient failures use bounded exponential retry; invalid inputs and missing configuration fail immediately for operator action.
