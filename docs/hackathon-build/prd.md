# Dailies — Product Requirements

> Working scaffold. Expand this document from the approved scope before implementation.

## Epic 1: Create an analysis project

As a creator, I want to upload a short video and optional outline so that Dailies can understand the edit I am working on.

### Acceptance criteria

- The landing page presents a clear entry point into the Dailies workflow.
- The user can select a supported video file and optionally provide an outline.
- The interface shows upload and processing status.
- Invalid or oversized files produce a useful error state.

## Epic 2: Understand the footage

As a creator, I want timestamped scene and pacing analysis so that I can see what Dailies found in my footage.

### Acceptance criteria

- Results include scene start/end timestamps.
- Results include scene summaries, mood/energy tags, and pacing flags.
- The UI distinguishes completed analysis from unavailable or failed analysis.

## Epic 3: Generate a score

As a creator, I want a soundtrack matched to the emotional arc of my footage so that I can preview a better scoring direction for the cut.

### Acceptance criteria

- The soundtrack result includes a playable audio clip.
- Each clip includes its mood and generation brief.
- If generation is unavailable, the interface clearly labels demo/fallback audio.

## Epic 4: Explain retention loss

As a creator, I want Dailies to compare my recent videos so that the recommendation is grounded in my own audience behavior.

### Acceptance criteria

- The result identifies a normalized retention position and corresponding timestamps.
- The result names supporting videos.
- The interface exposes enough evidence to understand how the recommendation was formed.
- Missing event data is stated rather than invented.

## Epic 5: Recommend the next cut

As a creator, I want one specific next-cut recommendation so that I know what to change.

### Acceptance criteria

- The recommendation is concise and actionable.
- It separates observed evidence from inferred cause.
- It references the relevant retention position and edit/music event when available.

## Epic 6: Produce the enhanced final cut

As a creator, I want Dailies to apply its analysis, retention insight, and custom soundtrack so that I receive a ready-to-review final cut rather than recommendations alone.

### Acceptance criteria

- The visible Gemini analysis is preserved after rendering.
- A timestamped edit plan states what Dailies kept, tightened, or removed and why.
- The Lyria soundtrack is mixed into the retained timeline without obscuring dialogue.
- The UI shows distinct editing and rendering progress.
- The completed project includes controlled playback and download of the rendered MP4.
- The original rough cut remains distinguishable from the enhanced final cut.

## Non-goals

- Dailies will not expose a general-purpose manual nonlinear-editing timeline in the MVP.
- Dailies will not promise causal proof from retention correlations.
- Dailies will not expose secrets or private analytics data in the browser.
