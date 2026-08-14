# Dailies frontend

The creator-facing Dailies application. It is deliberately separate from the framework-independent marketing page in [`../public/index.html`](../public/index.html).

## Run locally

From the repository root:

```bash
npm install
npm run dev:frontend
```

Open the Vite address printed in the terminal. Build and test the application with:

```bash
npm --workspace frontend run build
npm --workspace frontend test
```

The studio is served at `/studio/`. Use `/studio/?auth=sign-up` or `/studio/?auth=sign-in` for the matching marketing-page entry state.

## UI architecture

- `AuthPage` starts the configured Google identity flow; it never submits credentials to Dailies.
- `Dashboard` is the cloud-backed creator desk, with an account-aware welcome, retention signal, project library, and new-project entry point.
- `AppShell` supplies the Dailies studio frame and workflow navigation.
- `ProjectUploader`, `WorkflowStepper`, `EmptyState`, and `ErrorState` cover project creation, staged progress, and retry states.
- `VideoPreview`, `SceneTimeline`, and `AnalysisPanel` present scene-level analysis in timeline order.
- `SoundtrackCard` presents the generated-score direction and cloud-hosted cue players.
- `RetentionChart`, `EvidencePanel`, and `RecommendationCard` present the normalized retention pattern and an evidence-bounded edit recommendation.
Client state is divided into Redux Toolkit slices for `auth`, `project`, `analysis`, `insight`, and `ui`. Components use hooks for interaction; all project and account data comes through the authenticated API contract in `shared/`.

## API handoff

The UI uses only the connected service boundary:

- `POST /api/projects` to create a project and upload target.
- `POST /api/projects/:projectId/analyze` to begin or resume processing.
- `GET /api/projects/:projectId` to refresh lifecycle and report state.
- `GET /api/projects/:projectId/assets/:assetId` for a controlled video or soundtrack URL.

The frontend does not call Gemini, Lyria, ClickHouse, or YouTube directly. Those remain behind the API and orchestrator boundaries.
