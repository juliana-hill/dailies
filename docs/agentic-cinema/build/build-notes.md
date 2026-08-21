# Build notes

This file records decisions made during the guided planning and implementation process.

## Existing source materials

- `docs/agentic-cinema/dailies_hackathon_plan.md` — original concept and technical outline.
- `docs/agentic-cinema/hackathon-guidelines-rule.md` — supplied hackathon rules and resources.
- `docs/agentic-cinema/dailies_devpost_submission_draft.md` — initial submission narrative.
- `docs/agentic-cinema/implementation-plan.md` — researched implementation plan.

## Initial implementation decisions

- Partner track: ClickHouse.
- Platform: web.
- Product URL target: `dailies.gurlzine.com`.
- Primary workflow: upload → Gemini analysis → Lyria score → ClickHouse MCP insight → recommendation.
- Retention points are modeled by normalized video position, not assumed one-row-per-second data.

## Open decisions

- Exact Lyria model/API enabled in the selected Google Cloud project.
- Agent Engine deployment shape and supported ADK package versions.
- Controlled ClickHouse ingestion/write path.
- Final MVP time budget and demo fixture strategy.

## 2026-08-12 — Real service integration pass

- Replaced the frontend's default fixture/auth/timer path with authenticated API session loading, project creation, controlled upload, idempotent analysis start, persisted status polling, real report rendering, and signed asset playback.
- Added the Express ownership boundary, file-backed repository abstraction, Cloud Storage adapter, safe errors, IAP-compatible identity parsing, explicit-only fixture adapter, and monitored agent jobs.
- Implemented the agent and ingestion boundaries as independently deployable Node.js/TypeScript Express services.
- Corrected retention storage/querying around normalized `position_ratio`; derived seconds remain per-video display values.
- Verified: workspace builds, 9 JavaScript tests, and prohibited-AI dependency audit.
- Not live verified: Google identity/IAP, Cloud Storage, Gemini, Lyria quota/model access, YouTube OAuth/channel data, ClickHouse Cloud/MCP, Agent Engine, Cloud Run, or the custom domain. Those require project credentials and deployed resources.
- Dependency note: npm reports a moderate `uuid@9` advisory transitively through the current Google Cloud Storage HTTP stack. npm's proposed automatic remediation is a breaking storage downgrade and was not applied.
