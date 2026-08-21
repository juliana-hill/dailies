# Dailies — Technical Specification

> Working scaffold. Refine this document after the product requirements are approved.

## Architecture

- `public/` — static marketing and application shell assets.
- `frontend/` — React creator-facing workflow UI using hooks and Redux Toolkit.
- `api/` — Express upload, project status, and orchestration boundary.
- `shared/` — TypeScript request/response contracts and validation schemas.
- `agents/` — ADK root orchestrator and specialist agents.
- `ingestion/` — YouTube Analytics OAuth and ClickHouse ingestion.
- `infra/` — Cloud Run, Cloud Storage, Secret Manager, and ClickHouse configuration.
- `tests/` — schema, retention normalization, MCP, API, and integration tests.

The deployment topology is service-oriented: frontend, API, orchestration, and ingestion have distinct boundaries and can be deployed independently. The MVP should still keep the operational surface small and avoid splitting every agent or database operation into its own network service.

## Runtime components

1. Cloud Run serves the React web application and Express API as separate deployables.
2. Cloud Storage holds uploaded footage and generated audio.
3. Vertex AI Agent Engine hosts the ADK orchestrator when the selected package/API versions support the deployment.
4. Gemini analyzes video and writes grounded recommendation language.
5. Lyria generates short instrumental audio clips.
6. ClickHouse MCP provides the Retention Insight agent’s analytical query path.
7. Secret Manager stores OAuth and service credentials.

## Frontend state model

Use Redux Toolkit with a small number of slices:

- `project`: project ID, upload metadata, and lifecycle status.
- `analysis`: scenes, pacing flags, soundtrack briefs, and loading/error state.
- `insight`: retention evidence, recommendation, supporting videos, and loading/error state.
- `ui`: active step, notifications, and demo/fallback labeling.

Use React hooks for component behavior and typed selectors/actions. Keep server state normalized around `project_id`; do not duplicate the complete project result in unrelated components.

## API service model

Express should expose a narrow API:

- `POST /api/projects` — create a project and return an upload target.
- `POST /api/projects/:projectId/analyze` — start or resume the workflow.
- `GET /api/projects/:projectId` — return status and available results.
- `GET /api/projects/:projectId/assets/:assetId` — return a controlled audio/video asset URL.
- `GET /api/health` — service health check.

The API should not implement Gemini, Lyria, or ClickHouse logic directly. It forwards workflow requests to the orchestrator and reads status from the project state boundary.

## Data flow

```text
Browser → Cloud Run API → Cloud Storage
                      ↓
                ADK orchestrator
          ↙          ↓           ↘
      Gemini       Lyria      ClickHouse MCP
          ↘          ↓           ↙
             Project result/report
```

## Critical technical decisions

- Store YouTube retention by `elapsedVideoTimeRatio` and derived seconds.
- Keep agent ClickHouse access read-only by default.
- Validate all model JSON before persistence or display.
- Support fixture adapters so the product can be demonstrated while external credentials are unavailable.
- Re-check the actual enabled Lyria model and ADK/Agent Engine versions before implementation locks.

## Deployment target

- Development URL: Cloud Run generated HTTPS URL.
- Product URL: `dailies.gurlzine.com` after DNS/domain mapping is configured.
- Public assets and landing page should remain independently testable before backend integration.
