# Dailies — Scope

> Working scaffold. Complete this document through the scope conversation before locking the build plan.

## Product

Dailies is a GurlZine family product for YouTube creators. It analyzes a new video, generates a soundtrack brief and clip, and uses the creator’s historical retention data to explain one concrete improvement for the next edit.

## User

The primary user is an independent YouTube creator or small creator team who edits their own videos and wants actionable feedback without manually comparing YouTube Analytics against the timeline.

## Core promise

“Dailies identifies why your last video lost viewers and scores your next cut to correct it.”

## Candidate MVP flow

1. Upload one short video and optional outline.
2. See timestamped Gemini scene and pacing analysis.
3. Receive and play a short Lyria-generated instrumental score.
4. See a ClickHouse MCP-backed retention insight using recent creator videos.
5. Receive one evidence-backed recommendation with timestamps and supporting videos.

## What is explicitly out of scope for the first build

- Full editing or rendered rough-cut export.
- Multi-user accounts and billing.
- Mobile apps.
- TTS/narration.
- Thumbnail/title experimentation.
- Full-channel batch processing.

## Scope questions for the next planning pass

- What footage length and file types are supported for the demo?
- How much real YouTube data is available for the initial demonstration?
- What is the single “wow moment” the judges should remember?
- Which features are essential if model/API access is delayed?
- What does “done” mean for the first hosted demo?
