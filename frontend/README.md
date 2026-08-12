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

- `AuthPage` provides fixture-only sign-in and sign-up screens. It never submits credentials or creates an account.
- `Dashboard` is the mock creator desk, with an account-aware welcome, retention signal, project library, and new-project entry point.
- `AppShell` supplies the Dailies studio frame and workflow navigation.
- `ProjectUploader`, `WorkflowStepper`, `EmptyState`, and `ErrorState` cover project creation, staged progress, and retry states.
- `VideoPreview`, `SceneTimeline`, and `AnalysisPanel` present scene-level analysis in timeline order.
- `SoundtrackCard` presents the generated-score direction with an explicitly labelled synthesized demo player.
- `RetentionChart`, `EvidencePanel`, and `RecommendationCard` present the normalized retention pattern and an evidence-bounded edit recommendation.
- `fixtures.js` provides the deterministic demo report. Every fixture surface is labelled in the UI so it cannot be mistaken for live project data.

Client state is divided into Redux Toolkit slices for `auth`, `project`, `analysis`, `insight`, and `ui`. Components use hooks for local interaction; the project state is kept ready for the API contract in `shared/`. The dashboard and authentication data is deliberately seeded mock data until an account service is added.

## API handoff

The UI is fixture-first until the service boundary is connected. The intended integration points are:

- `POST /api/projects` to create a project and upload target.
- `POST /api/projects/:projectId/analyze` to begin or resume processing.
- `GET /api/projects/:projectId` to refresh lifecycle and report state.
- `GET /api/projects/:projectId/assets/:assetId` for a controlled video or soundtrack URL.

The frontend does not call Gemini, Lyria, ClickHouse, or YouTube directly. Those remain behind the API and orchestrator boundaries.
