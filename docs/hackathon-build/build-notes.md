# Build notes

This file records decisions made during the guided planning and implementation process.

## Existing source materials

- `docs/dailies_hackathon_plan.md` — original concept and technical outline.
- `docs/hackathon-guidelines-rule.md` — supplied hackathon rules and resources.
- `docs/dailies_devpost_submission_draft.md` — initial submission narrative.
- `docs/implementation-plan.md` — researched implementation plan.

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
