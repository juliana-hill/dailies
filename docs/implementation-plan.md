# Dailies Implementation Plan

## 1. Objective

Dailies is a GurlZine family product and a new standalone hackathon project for the Google Cloud Agentic Cinema ClickHouse track.

The MVP helps a creator understand where recent videos lose audience attention, analyzes a new video or rough cut, generates a purpose-built soundtrack, and produces one evidence-backed recommendation for the next edit.

The implementation must demonstrate a real end-to-end workflow:

```text
Upload footage + optional outline
        ↓
Gemini video analysis
        ↓
Scene, pacing, and music brief
        ↓
Lyria soundtrack generation
        ↓
ClickHouse MCP retention correlation
        ↓
Evidence-backed edit recommendation
        ↓
Creator-facing project report
```

## 2. Hackathon compliance targets

| Requirement | Implementation decision | Proof for judges |
|---|---|---|
| Gemini and Google Cloud Agent Builder | Build the orchestrator with Google ADK and deploy it to Vertex AI Agent Engine where practical | ADK dependency, agent source, deployed endpoint |
| ClickHouse partner track | Use the official ClickHouse MCP server for live retention queries from the Retention Insight agent | MCP configuration, tool call, visible query/result in demo |
| Google Cloud AI only | Use Gemini through Vertex AI/Google Gen AI SDK and Lyria through Google Cloud; do not add OpenAI, Anthropic, AWS, or Azure AI SDKs | Dependency and import audit |
| Web platform | Cloud Run-hosted web application | Public HTTPS URL |
| Public open source project | Add a complete MIT license and setup instructions | Public repository and detectable license |
| Functional demonstration | Record the complete ingest → analyze → score → insight workflow in under three minutes | Public YouTube or Vimeo video |
| New project | Keep the codebase and project identity distinct from existing GurlZine products while retaining the Dailies brand relationship | Repository history and README language |

The official rules and live documentation must be rechecked immediately before submission because model availability, APIs, dates, and partner requirements can change.

## 3. MVP boundary

### Build for the submission

1. A branded Dailies web interface.
2. Upload of one short video and optional text outline.
3. Gemini analysis returning strict structured JSON:
   - timestamped scenes;
   - transcript or key dialogue summary;
   - pacing flags;
   - mood and energy tags;
   - soundtrack brief.
4. Lyria generation of one or two short instrumental soundtrack clips based on the analysis.
5. ClickHouse retention data for a small set of the creator’s own videos.
6. Retention Insight agent using ClickHouse MCP to identify common low-retention positions and nearby edit/music events.
7. Gemini-written recommendation with supporting timestamps and source video IDs.
8. A results screen showing analysis, soundtrack playback, retention evidence, and recommendation.
9. A deterministic demo mode using seeded/local fixture data if OAuth or external services are unavailable during recording, while still showing the real production integration in code and configuration.

### Explicitly defer

- General-purpose manual nonlinear editing, multicam workflows, or frame-by-frame effects.
- Multi-user accounts and billing.
- Catalog-wide background synchronization.
- Gemini TTS and narration.
- Thumbnail/title experimentation.
- Complex music stitching or mastering.
- Mobile applications.
- Real-time collaboration.

These features may be described as future work but must not jeopardize the core demo.

## 4. Recommended architecture

### Frontend and service boundary

Use a React frontend with hooks and Redux Toolkit for client state, backed by an Express API. The product is dense enough to benefit from service boundaries, but the first deployment should use a small number of independently deployable services rather than a distributed maze.

Recommended boundaries:

- `frontend`: React application for upload, progress, playback, and results.
- `api`: Express API for authentication boundary, project creation, status, and signed asset URLs.
- `orchestrator`: ADK service/Agent Engine deployment for the project workflow.
- `ingestion-worker`: YouTube Analytics and ClickHouse ingestion job, invoked manually or by a scheduled trigger.
- `shared`: TypeScript contracts and validation schemas shared by frontend and API.

The frontend and API can run together locally for convenience, while production services remain separately deployable. Cloud Run is suitable for the frontend/API and worker services; Agent Engine is the managed runtime target for the ADK orchestrator.

### Agent layer

Use one root ADK orchestrator with three focused specialists:

1. **Analysis Agent**
   - Accepts a Cloud Storage URI for the uploaded video and optional outline text.
   - Calls Gemini multimodal generation.
   - Validates the response against a JSON schema.
   - Returns scenes, pacing flags, and soundtrack briefs.

2. **Score Agent**
   - Converts soundtrack briefs into Lyria prompts.
   - Requests short instrumental clips.
   - Stores generated audio in Cloud Storage.
   - Returns signed or controlled-access asset URLs and prompt metadata.

3. **Retention Insight Agent**
   - Calls ClickHouse MCP tools at runtime.
   - Runs a parameterized correlation query.
   - Cross-references retention positions with cut/music events.
   - Uses Gemini to explain the evidence without inventing unsupported causes.
   - Persists the recommendation through the approved write path.

The root orchestrator should expose one job-oriented operation, such as `analyze_project`, and maintain explicit status transitions rather than relying on an opaque conversational loop.

### Storage and services

| Concern | Service | MVP use |
|---|---|---|
| Uploaded video/audio | Cloud Storage | Input footage and generated audio assets |
| Agent runtime | Vertex AI Agent Engine | ADK orchestrator and specialist agents |
| Web/API hosting | Cloud Run | Public application URL |
| Secrets | Secret Manager | YouTube OAuth, ClickHouse MCP, application secrets |
| Analytics store | ClickHouse Cloud | Retention points, video metadata, edit/music events, recommendations |
| Retention ingestion | YouTube Analytics API | OAuth-authorized creator data |
| AI analysis | Gemini on Vertex AI | Video understanding and recommendation wording |
| Music generation | Lyria on Google Cloud | Instrumental soundtrack clips |

## 5. Corrected retention data model

The original plan described one row per second. The YouTube Analytics API returns 100 evenly spaced audience-retention points per video using `elapsedVideoTimeRatio`, so the schema should preserve normalized position and derive seconds from duration.

```sql
CREATE TABLE videos (
    video_id String,
    channel_id String,
    title String,
    published_at DateTime,
    duration_seconds UInt32
) ENGINE = MergeTree()
ORDER BY (channel_id, published_at, video_id);

CREATE TABLE retention_curve_points (
    video_id String,
    position_ratio Float32,
    position_seconds Float32,
    audience_watch_ratio Float32,
    relative_retention_performance Float32 DEFAULT 0
) ENGINE = MergeTree()
ORDER BY (video_id, position_ratio);

CREATE TABLE cut_events (
    video_id String,
    position_seconds Float32,
    event_type LowCardinality(String),
    metadata String
) ENGINE = MergeTree()
ORDER BY (video_id, position_seconds);

CREATE TABLE music_segments (
    project_id String,
    segment_start_seconds Float32,
    segment_end_seconds Float32,
    mood_tag String,
    generation_prompt String,
    audio_asset_url String,
    created_at DateTime DEFAULT now()
) ENGINE = MergeTree()
ORDER BY (project_id, segment_start_seconds);

CREATE TABLE recommendations (
    project_id String,
    channel_id String,
    generated_at DateTime DEFAULT now(),
    drop_off_position_ratio Float32,
    drop_off_seconds Float32,
    drop_off_severity_pct Float32,
    likely_cause String,
    recommendation_text String,
    supporting_video_ids Array(String)
) ENGINE = MergeTree()
ORDER BY (channel_id, generated_at);
```

The primary cross-video comparison should align videos by normalized position, then convert the selected position to seconds for each source video and the new project. This avoids treating a 60-second video and a 20-minute video as if their 40th data points occurred at the same number of seconds.

## 6. ClickHouse MCP design

The official ClickHouse MCP server provides query tools such as `run_query` and is read-only by default. This is useful for keeping the agent’s analytical access narrow.

Use two paths:

1. **Agent read path:** Retention Insight Agent → MCP server → ClickHouse `run_query`.
2. **Controlled ingestion/write path:** YouTube sync job → validated batch writer or explicitly write-enabled MCP operation → ClickHouse.

The agent must not quietly fall back to a direct ClickHouse client for the core insight. The demo should show the MCP call or its observable tool trace, the query result, and the recommendation derived from it.

For local development, support a fixture dataset and a local ClickHouse-compatible test path, but keep the production MCP configuration explicit and testable.

## 7. Data flow and contracts

### Project creation

```text
POST /api/projects
  → create project_id
  → upload video to Cloud Storage
  → enqueue/start agent job
  → return project status
```

### Analysis result

```json
{
  "project_id": "project_123",
  "duration_seconds": 74.2,
  "scenes": [
    {
      "start_seconds": 0,
      "end_seconds": 18.5,
      "summary": "...",
      "mood": "curious",
      "energy": 0.6,
      "pacing_flags": ["long_setup"]
    }
  ],
  "soundtrack_briefs": [
    {
      "start_seconds": 0,
      "end_seconds": 18.5,
      "prompt": "instrumental cinematic ...",
      "mood": "curious",
      "energy": 0.6
    }
  ]
}
```

### Recommendation result

```json
{
  "drop_off_position_ratio": 0.42,
  "drop_off_seconds": 31.2,
  "severity_pct": 18.4,
  "likely_cause": "music_gap_near_retention_drop",
  "supporting_video_ids": ["video_a", "video_b", "video_c"],
  "evidence": [
    {
      "video_id": "video_a",
      "position_ratio": 0.42,
      "position_seconds": 28.7,
      "nearby_events": ["music_end"]
    }
  ],
  "recommendation_text": "..."
}
```

All model outputs should be schema-validated before being shown to the user. Recommendations should distinguish evidence from inference and should say when edit-event data is unavailable.

## 8. Implementation phases

### Phase 0 — Project and compliance foundation

- Confirm the ClickHouse track and solo/team submission details.
- Confirm the Google Cloud project, billing account, region, and available credits.
- Create the standalone repository structure.
- Add MIT or Apache-2.0 license.
- Add a README with architecture, local setup, runtime Google Cloud/ClickHouse evidence, and safety/data notes.
- Create environment templates without committing secrets.
- Add a dependency audit that fails on prohibited AI SDKs.

**Exit criteria:** fresh clone can start the application shell; license and compliance notes are present.

### Phase 1 — Vertical slice with fixtures

- Build the frontend shell and project status screen.
- Implement a fake/fixture agent adapter with the final response shapes.
- Render scenes, pacing flags, retention evidence, recommendation, and audio player.
- Add loading, empty, and failure states.

**Exit criteria:** the complete product story can be demonstrated locally without external credentials.

### Phase 2 — Cloud Storage and Gemini analysis

- Upload the video to Cloud Storage.
- Call Gemini with the video URI and structured-output prompt.
- Validate and persist the analysis result.
- Add retry and size/duration validation.

**Exit criteria:** a real uploaded clip produces timestamped structured analysis.

### Phase 3 — Lyria soundtrack generation

- Verify the currently enabled Lyria model and supported region/API in the selected project.
- Generate short instrumental clips from scene briefs.
- Store audio output in Cloud Storage.
- Add graceful fallback to a clearly labeled fixture clip for demo resilience.

**Exit criteria:** at least one real generated clip plays in the Dailies results view.

### Phase 4 — ClickHouse and YouTube ingestion

- Provision ClickHouse Cloud or an approved self-hosted cluster.
- Apply the corrected schema.
- Implement OAuth authorization for the creator’s own YouTube Analytics data.
- Query audience-retention reports using `elapsedVideoTimeRatio` and `audienceWatchRatio`.
- Normalize and write the 100 points per video.
- Ingest known cut/music events from demo metadata or an explicitly documented event source.

**Exit criteria:** ClickHouse contains enough real or clearly labeled demo data for three to five videos.

### Phase 5 — MCP-powered Retention Insight agent

- Configure the official ClickHouse MCP server.
- Implement parameterized read-only correlation queries.
- Align retention by normalized position.
- Detect nearby music/cut events with a documented tolerance.
- Use Gemini to write a grounded explanation.
- Persist and return the recommendation.

**Exit criteria:** the agent’s recommendation cannot be produced without the ClickHouse MCP query, and the evidence is visible in logs/UI.

### Phase 6 — Orchestration and deployment

- Connect the three specialist agents under the ADK orchestrator.
- Add job status and idempotency.
- Deploy the agent to Vertex AI Agent Engine if supported by the selected ADK/API versions.
- Deploy the frontend/API to Cloud Run.
- Store credentials in Secret Manager.
- Configure logging and basic request tracing.

**Exit criteria:** a fresh user can complete the full workflow through the hosted web URL.

### Phase 7 — Domain, polish, and submission evidence

- Map `dailies.gurlzine.com` through the chosen Cloud Run custom-domain architecture.
- Configure the required DNS records at the domain provider.
- Test HTTPS, cold start, upload limits, and audio playback.
- Record the under-three-minute demo.
- Capture screenshots of the analysis, MCP-backed insight, soundtrack, and final recommendation.
- Finalize README, license, Devpost draft, and public repository.
- Re-check live rules and all third-party terms before submission.

**Exit criteria:** hosted URL, public repository, public video, and Devpost materials are all complete and mutually consistent.

## 9. Verification strategy

### Automated checks

- Unit tests for retention normalization and position-to-seconds conversion.
- Schema tests for Gemini and recommendation JSON.
- Correlation-query tests against fixture data.
- MCP adapter tests that verify the expected tool name and query parameters.
- API tests for project creation, status polling, and error responses.
- Dependency audit for prohibited AI tooling.
- Container build and startup test.

### Manual checks

- Upload a short MP4 and confirm progress states.
- Confirm a real Gemini response includes timestamps.
- Confirm a real Lyria clip is playable.
- Confirm the ClickHouse MCP query appears in the agent trace or server logs.
- Confirm the recommendation cites supporting video IDs and timestamps.
- Test the hosted URL in a fresh browser session.
- Test the demo path with external services unavailable and verify the labeled fallback behavior.

## 10. Cost and reliability controls

- Use short demo clips and a small number of historical videos.
- Cache analysis and generated audio by content hash.
- Use fixture data for UI development and most automated tests.
- Keep ClickHouse retention data limited to the demonstration channel/videos.
- Add explicit timeouts and retries around model, MCP, and YouTube calls.
- Never expose YouTube or ClickHouse secrets to the browser.
- Add a visible “demo data” label whenever fixture data is used.
- Monitor Google Cloud spend and set budget alerts before enabling repeated generation.

## 11. Risks and decisions to resolve early

| Risk | Decision/check |
|---|---|
| Lyria model/API mismatch | Verify enabled model, region, request shape, output duration, and quota before building the Score Agent around it |
| YouTube retention access | Confirm the authorized channel has usable retention reports and implement a fixture fallback |
| ClickHouse MCP writes | Keep agent reads MCP-based; choose and document a secure ingestion write path |
| Agent Engine compatibility | Validate the exact ADK and Vertex AI package versions before committing to deployment topology |
| Video upload cost/latency | Set strict demo limits and use Cloud Storage URIs rather than sending large inline payloads |
| Recommendation overclaiming | Require evidence fields and phrase inferred causes as hypotheses |
| Domain deployment delay | Use the Cloud Run URL during development; configure the subdomain only after the service is stable |
| Submission rules changing | Re-check the live Devpost rules before recording and again before submitting |

## 12. Definition of done

Dailies is ready for submission when a fresh visitor can open the hosted web app, upload a short video, see Gemini-derived scene/pacing analysis, hear a Lyria-generated soundtrack clip, observe a ClickHouse MCP-backed retention insight based on authorized creator data, and receive a grounded next-cut recommendation. The public repository must contain the complete source, license, setup instructions, and runtime evidence for the required Google Cloud and ClickHouse integrations.
