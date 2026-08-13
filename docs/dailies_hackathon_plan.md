# Dailies — Build Guide for Agentic Cinema Hackathon (Google Cloud × ClickHouse Track)

**Hand this document to Claude Code / Codex as the primary spec.** Written to be implementation-ready.

---

## 1. Project Snapshot

**Name:** Dailies (film-industry term for raw unedited footage reviewed each day — fits the "Agentic Cinema" studio-backlot branding)

**One-line pitch:** An agentic post-production assistant for YouTube creators that generates a custom soundtrack for your edit and tells you — using your own channel's real retention data — exactly where your last video lost viewers and why, so the next cut is data-driven instead of guesswork.

**Core function:**
1. Ingest raw footage + script/outline
2. Gemini multimodal analysis transcribes and tags scene-level moments, pacing issues, dead air
3. Lyria 3 generates a custom soundtrack matched to the edit's emotional arc (no copyright-strike risk — freshly generated, not licensed stock)
4. ClickHouse stores the creator's historical retention-curve data (from their own YouTube Analytics export); the agent queries this to correlate past cut/music choices with viewer drop-off points
5. Agent produces a rough-cut recommendation and a timestamped edit-decision list ("sustain the score through 0:40-0:55 — your last 3 videos lost ~40% of viewers exactly there when the music cut out")
6. The editing pipeline applies those decisions and the custom score to render an enhanced final cut; the UI preserves the original analysis and explains every applied change

**Why this wins on the rubric:**
- **Technological Implementation** — real, non-decorative use of Gemini multimodal, Lyria 3, ADK orchestration, and ClickHouse MCP queries — every piece does real work
- **Design** — a complete creator workflow (ingest → analyze → score → recommend), not a single-feature tech demo
- **Potential Impact** — every YouTube creator obsesses over retention; this addresses a documented, universal pain point with a concrete mechanism, not a vague claim
- **Quality of Idea** — pairing generative soundtrack tooling with a genuine analytics feedback loop is not the obvious "AI video editor" pitch most teams will bring

---

## 2. Hackathon Compliance Map

Source of truth: https://agentic-cinema.devpost.com/rules and https://agentic-cinema.devpost.com/resources — **re-verify before final submission**, requirements can shift.

| Requirement | How Dailies satisfies it |
|---|---|
| Powered by Gemini + Google Cloud Agent Builder | Core orchestration built natively on ADK (Agent Development Kit) + deployed on Agent Engine |
| One Partner track, genuinely used at runtime | **ClickHouse** — retention-curve data lives in ClickHouse, queried live via the official `mcp-clickhouse` MCP server, not just named in the README |
| No AI/agent tooling from AWS, Azure, OpenAI, Anthropic | Only Gemini models (`google-genai`/`google-cloud-aiplatform`), Imagen 3, Lyria 3, Gemini TTS — all Google Cloud native |
| Platform: web, Android, or iOS | Web app |
| Team size ≤ 4 | Confirm if solo or team |
| New project only | Confirm this is not a reuse of Juliluna Yoga or Couchbumming |
| Public open-source repo w/ detectable license | MIT or Apache-2.0, license file at repo root |
| Hosted, functional project URL | Deploy via Cloud Run |
| Repo demonstrates Google Cloud + ClickHouse actually imported/called at runtime | `@google/adk` and `@google/genai` are imported and executed in the Node.js agent service; the official ClickHouse MCP endpoint is invoked through the TypeScript MCP SDK, not just named in config |
| Demo video ≤ 3 min, public on YouTube/Vimeo, English | Script in §9 |
| Deadline | **September 7, 2026, 2:00 PM PT** |
| Prize (ClickHouse track) | 1st $7,500 (+ social promo opportunity), 2nd $3,000, 3rd $2,000 ([official rules](https://agentic-cinema.devpost.com/rules)) |

---

## 3. Data Sources

| Data | Source | Notes |
|---|---|---|
| Raw footage + script | User-uploaded for the demo | Use your own YouTube footage/b-roll for a fully authentic demo |
| Retention-curve / audience-retention data | **YouTube Analytics API** (official, OAuth, creator's own channel) | This is the legitimate, ToS-compliant way to get real per-video retention timestamps — do not scrape YouTube Studio directly |
| Generated soundtrack | Lyria 3 | Generated fresh per project, avoids licensing/copyright-strike risk entirely |
| Transcription/scene tagging | Gemini multimodal video analysis | Timestamped transcript + scene metadata |

For the hackathon demo, pulling your own real channel's retention data via the YouTube Analytics API (rather than synthetic data) is a strong authenticity signal for judges — it proves the recommendation engine works on real numbers, not a toy dataset.

---

## 4. System Architecture

```
                     ┌───────────────────────────┐
                     │   Frontend (web app)        │
                     │  upload footage/script,      │
                     │  view soundtrack + brief      │
                     └─────────────┬───────────────┘
                                   │ REST
                     ┌─────────────▼───────────────┐
                     │  Orchestrator Agent (ADK)     │
                     │  routes to sub-agents below   │
                     └──┬───────┬───────┬───────────┘
                        │       │       │
     ┌──────────────────▼┐ ┌────▼─────┐ ┌▼─────────────────────┐
     │ Analysis Agent      │ │ Score     │ │ Retention-Insight     │
     │ - Gemini multimodal │ │ Agent     │ │ Agent                 │
     │ - transcription      │ │ - Lyria 3 │ │ - ClickHouse MCP      │
     │ - scene/pacing tags  │ │ soundtrack│ │   queries              │
     └──────────────────────┘ └───────────┘ └───────────┬───────────┘
                                                          │
                                            ┌─────────────▼─────────────┐
                                            │  ClickHouse Cloud cluster   │
                                            │  - retention_curve_points   │
                                            │  - videos / cut_events      │
                                            │  - music_segments            │
                                            └─────────────────────────────┘
                                                          ▲
                                            ┌─────────────┴─────────────┐
                                            │ Ingestion job (Cloud Run)   │
                                            │ - pulls YouTube Analytics    │
                                            │   API data periodically      │
                                            └───────────────────────────────┘
```

---

## 5. ClickHouse Schema

ClickHouse is a column-store optimized for time-series/analytical queries — a strong natural fit for per-second retention curves across many videos.

```sql
CREATE TABLE videos (
    video_id String,
    channel_id String,
    title String,
    published_at DateTime,
    duration_seconds UInt32
) ENGINE = MergeTree()
ORDER BY (channel_id, published_at);

-- one row per second (or per few seconds) of relative audience retention, pulled from YouTube Analytics API
CREATE TABLE retention_curve_points (
    video_id String,
    second_offset UInt32,
    audience_retention_pct Float32,      -- 0-100, relative retention at this timestamp
    absolute_retention_pct Float32
) ENGINE = MergeTree()
ORDER BY (video_id, second_offset);

-- edit metadata: where cuts/music transitions happened in the final edit, aligned to the same timeline as retention data
CREATE TABLE cut_events (
    video_id String,
    second_offset UInt32,
    event_type String,      -- 'cut', 'music_start', 'music_end', 'music_style_change'
    metadata String         -- JSON blob: e.g. music genre/mood tag, cut type
) ENGINE = MergeTree()
ORDER BY (video_id, second_offset);

-- Lyria-generated soundtrack segments tied to a specific project/edit
CREATE TABLE music_segments (
    project_id String,
    segment_start_offset UInt32,
    segment_end_offset UInt32,
    mood_tag String,
    generation_prompt String,
    audio_asset_url String,
    created_at DateTime DEFAULT now()
) ENGINE = MergeTree()
ORDER BY (project_id, segment_start_offset);

-- generated recommendations, stored so a creator's history compounds over time
CREATE TABLE recommendations (
    project_id String,
    channel_id String,
    generated_at DateTime DEFAULT now(),
    drop_off_second UInt32,
    drop_off_severity_pct Float32,
    likely_cause String,      -- e.g. 'music_gap', 'slow_pacing', 'cut_too_long'
    recommendation_text String,
    supporting_video_ids Array(String)
) ENGINE = MergeTree()
ORDER BY (channel_id, generated_at);
```

**Query pattern that powers the core insight** (the "load-bearing analytics" the judges should see in the demo):
```sql
-- find timestamps where retention consistently drops across recent videos, correlated with cut_events
SELECT
    r.second_offset,
    avg(r.audience_retention_pct) AS avg_retention,
    groupArray(c.event_type) AS concurrent_events
FROM retention_curve_points r
LEFT JOIN cut_events c
    ON r.video_id = c.video_id AND abs(r.second_offset - c.second_offset) < 3
WHERE r.video_id IN (
    SELECT video_id FROM videos WHERE channel_id = {channel_id} ORDER BY published_at DESC LIMIT 5
)
GROUP BY r.second_offset
ORDER BY avg_retention ASC
LIMIT 10;
```

**Compliance note:** all reads/writes should route through the official **ClickHouse MCP server** (`mcp-clickhouse`) as MCP tool calls from the agent layer — this is what satisfies the "actively used at runtime via the ClickHouse MCP server" requirement, not raw SQL client calls from the app tier.

---

## 6. Agent Logic Detail

### 6.1 Analysis Agent
1. Receive uploaded footage + optional script
2. Call Gemini multimodal (video + text input) → get timestamped transcript, scene boundaries, pacing flags (long static shots, dead air gaps)
3. Write scene/pacing metadata to a working store for the Score Agent to consume

### 6.2 Score Agent
1. For each tagged scene/mood segment from the Analysis Agent, construct a Lyria 3 prompt (mood, tempo, instrumentation cues derived from scene tags)
2. Generate soundtrack segment(s), store in `music_segments`
3. Return stitched soundtrack + per-segment metadata to the frontend

### 6.3 Retention-Insight Agent
1. On project creation, MCP tool call → pull the creator's last N videos' `retention_curve_points` from ClickHouse
2. Run the correlation query above to find low-retention timestamps common across recent videos
3. Cross-reference with `cut_events`/music-timing patterns from those same videos (if available) to infer likely cause
4. Call Gemini to turn the raw correlation into a natural-language recommendation
5. Write result to `recommendations`, surface it in the UI alongside the new soundtrack

### 6.4 Editing and Render Pipeline
1. Convert the visible Gemini analysis and retention recommendation into a schema-validated edit-decision list
2. Preserve dialogue and intentional story beats while trimming flagged dead air and low-value pauses
3. Apply the Lyria soundtrack across the retained timeline with dialogue-aware gain instructions
4. Submit the source footage, soundtrack, and edit list to Google Cloud Transcoder API from the Node.js service
5. Store the rendered MP4 in Cloud Storage and return a controlled playback/download URL
6. Keep the original analysis visible beside an explicit “what changed” summary and the enhanced final cut

---

## 7. Repo Structure

```
dailies/
├── README.md                 # must name Gemini/Google Cloud + ClickHouse tools used, per submission rules
├── LICENSE
├── docs/architecture.png
├── infra/
│   ├── clickhouse/schema.sql
│   └── cloudrun/service.yaml
├── agents/
│   └── src/
│       ├── orchestrator.ts        # workflow coordinator
│       ├── analysisAgent.ts       # Gemini multimodal tool calls
│       ├── scoreAgent.ts          # Lyria 3 tool calls
│       └── retentionAgent.ts      # ClickHouse MCP tool calls
├── ingestion/
│   └── src/youtubeAnalytics.ts     # pulls retention data via YouTube Analytics API (OAuth)
├── frontend/                   # web app: upload, soundtrack preview, recommendation display
└── tests/
```

---

## 8. Google Cloud Integration Details

- **ADK + Agent Engine**: build the orchestrator and sub-agents natively per the resources guide, deploy via `Deploying ADK Agents to Agent Engine`
- **Gemini multimodal**: video/text input for transcription, scene tagging, pacing analysis
- **Lyria 3**: soundtrack generation
- **Gemini TTS** (optional stretch): auto-generated narration/voiceover option for creators who want a scripted VO track
- **Cloud Run**: hosts the web frontend/API if not fully served via Agent Builder's managed web chat/REST endpoint
- **Secret Manager**: store YouTube API OAuth tokens and ClickHouse credentials
- **Gemini Safety Settings**: configure moderation on any generated narration/text content

---

## 9. Build Timeline (today is Wed Aug 5; deadline is Sep 7, 2:00 PM PT — more runway than the CockroachDB hackathon, use it well)

| Week | Focus |
|---|---|
| Aug 5-9 | Repo scaffold, license, ClickHouse Cloud cluster + schema, Google Cloud project + Agent Builder/ADK environment, YouTube Analytics API OAuth flow working |
| Aug 10-16 | Analysis Agent (Gemini multimodal transcription/scene tagging) working end-to-end on real uploaded footage |
| Aug 17-23 | Score Agent (Lyria 3) generating soundtrack segments matched to scene tags; Retention-Insight Agent querying ClickHouse via MCP server |
| Aug 24-30 | Frontend: upload flow, soundtrack preview/player, recommendation display; wire the three agents together in the orchestrator |
| Aug 31-Sep 3 | Deploy to Cloud Run/Agent Engine, end-to-end test with real channel data, polish UI |
| Sep 4-5 | Record demo video |
| Sep 6 | Buffer day, README finalization, submission form draft |
| Sep 7 | Submit by 2:00 PM PT — do not wait until the deadline hour |

---

## 10. Demo Video Script (under 3 minutes)

1. **0:00-0:20 — Hook**: "Every YouTube creator has felt this: you pour hours into an edit, post it, and watch half your audience disappear at some random timestamp — with no idea why. Dailies tells you exactly why, and fixes your next edit's soundtrack to match."
2. **0:20-0:50 — Ingest + Analysis**: Show raw footage going in, Gemini's scene/pacing tagging surfacing in real time.
3. **0:50-1:30 — The ClickHouse insight (critical for judging)**: Show the retention-correlation query running live — pull up 3-5 of the creator's actual past videos, show the shared drop-off timestamp the agent found, and the natural-language explanation it generates. This is the single most important shot for "Potential Impact" and "Quality of Idea."
4. **1:30-2:10 — Score generation**: Show Lyria 3 generating a soundtrack segment specifically to sustain energy through the identified problem timestamp; play a short clip.
5. **2:10-2:45 — Full loop**: Show the finished recommendation + soundtrack together in the UI, framed as "this is what your next upload should do differently."
6. **2:45-3:00 — Close**: Restate the mission line, show the product name/branding.

---

## 11. Submission Checklist

- [ ] Repo public with detectable open-source license
- [ ] README names Gemini/Google Cloud tools AND ClickHouse MCP server explicitly, with code-level evidence (not just README claims)
- [ ] `mcp-clickhouse` connection genuinely instantiated in code, connected to a real ClickHouse Cloud/self-hosted cluster
- [ ] Only Google Cloud AI tooling used anywhere in the stack — audit for accidental AWS/OpenAI/Anthropic SDK imports
- [ ] Hosted, functional project URL tested fresh right before submission
- [ ] Demo video ≤ 3 minutes, public on YouTube/Vimeo, in English
- [ ] Confirm this is a new project, not derived from Couchbumming or Juliluna Yoga
- [ ] Re-check https://agentic-cinema.devpost.com/rules once more before final submission

---

## 12. Guardrails

- Use only the **YouTube Analytics API** (official OAuth) for retention data — never scrape YouTube Studio's UI directly, which would violate ToS and risk account issues.
- Lyria-generated music sidesteps copyright-strike risk by design — call this out explicitly as a "Production Readiness" talking point in the README/demo.
- Configure Gemini Safety Settings on any generated narration text to avoid inappropriate content in auto-generated voiceover scripts.
