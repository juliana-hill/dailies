# Dailies: Devpost Submission Draft
### Agentic Cinema: The Blockbuster Hackathon; Partner Track: ClickHouse

---

## Project name
Dailies

## Elevator pitch (200 character limit)
Dailies identifies why your last video lost viewers and scores your next cut to correct it.

*(92 characters, within the limit)*

## Thumbnail (3:2 ratio)
Use `dailies_devpost_thumbnail_final.jpg`, a photograph of an editing bay at night displaying a waveform on screen, with the Dailies logo composited into the frame.

---

## About the project

### Inspiration

Every YouTube creator has experienced this outcome: hours invested in an edit, the video is published, and a significant portion of the audience departs at an unexplained point in the timeline. Retention data exists within YouTube Studio, but it remains disconnected from the editing process itself. Nothing currently connects the observation of precisely where viewers stopped watching to a concrete recommendation for what to change in the next edit. Dailies was created to close that gap, and to provide creators with an original soundtrack for each edit rather than licensed stock music that carries a risk of copyright infringement claims.

### What it does

Dailies is an agentic post production assistant for YouTube creators that combines generative soundtrack tools with a genuine analytics feedback loop.

- It ingests raw footage along with an optional script or outline.
- It analyzes the footage using Gemini's multimodal video understanding, producing a transcription, scene level tagging, and pacing flags for issues such as dead air or overlong static shots.
- It scores the edit using Lyria 3, generating a custom soundtrack matched to the emotional arc of the footage. Because the soundtrack is generated rather than licensed, there is no associated risk of a copyright strike.
- It incorporates the creator's own performance data by retrieving retention curve data through the official YouTube Analytics API and storing it in ClickHouse, then querying across recent videos to identify timestamps where retention consistently declines.
- It produces a specific recommendation derived from that correlation. For example, it may indicate that the creator's last three videos lost approximately forty percent of viewers at the point where the music ended near the forty five second mark, and recommend sustaining the score through that section in the next edit.

### How we are using Google Cloud and ClickHouse

- Gemini's multimodal capability performs video transcription and scene and pacing analysis.
- Lyria 3 generates the soundtrack, matched to the scene mood tags produced during analysis.
- The Agent Development Kit and Agent Engine provide native multi agent orchestration for the Analysis, Score, and Retention Insight agents, deployed on Google Cloud.
- ClickHouse, accessed through its official MCP server, stores per second retention curve data and cut and music timing events. The Retention Insight agent runs live correlation queries against this data, making ClickHouse a functionally necessary component rather than a supplementary one, since the core recommendation cannot be produced without it.
- Cloud Run hosts the web frontend and API.
- No AWS, Azure, OpenAI, or Anthropic tooling is used anywhere in the stack, consistent with the hackathon's technology requirements.

### How we built it

Dailies is a new project developed specifically for this hackathon. Its architecture is organized around three Agent Development Kit sub agents coordinated by a central orchestrator: an Analysis Agent that converts raw footage into timestamped, tagged metadata using Gemini; a Score Agent that translates those tags into soundtrack generation prompts for Lyria 3; and a Retention Insight Agent that queries ClickHouse, through its MCP server, for genuine correlations between audience retention and the creator's own past videos, after which Gemini converts the resulting correlation into a natural language recommendation. Retention data is retrieved through the official YouTube Analytics API under OAuth authorization, using the creator's own verified channel data rather than any method that would violate YouTube Studio's terms of service.

### Challenges we ran into

- Ensuring that ClickHouse served a genuinely necessary function rather than acting as a supplementary analytics dashboard. The correlation query, which joins retention curves against cut and music timing events, needed to directly inform the recommendation produced by the agent rather than simply populate a chart.
- Sourcing retention data appropriately. Only the official, OAuth authenticated YouTube Analytics API was acceptable, since retrieving data by other means from YouTube Studio's interface would violate its terms of service.
- Designing soundtrack generation prompts that respond meaningfully to scene level mood tags, rather than producing generic background music regardless of the underlying content.

### Accomplishments that we're proud of

- A genuine feedback loop, in which performance data from previous videos actively informs the recommendation for the next one, rather than the tool functioning as a single use generator.
- Soundtrack generation that entirely avoids the risk of a copyright strike, since every track is generated rather than licensed.
- An agent architecture in which every required component of the technology stack, namely Gemini, the Agent Development Kit, and the ClickHouse MCP server, performs substantive work within the recommendation pipeline.

### What we learned

- Pairing a generative feature, such as soundtrack generation, with a genuine analytics feedback loop, such as ClickHouse backed retention correlation, produces a considerably stronger product narrative than either feature would on its own. The connection between creating something and learning from its performance is the primary differentiator.
- Framing the tool around established film and editing terminology, including terms such as dailies, score, and rough cut, reinforced product decisions that felt native to how creators already conceive of their workflow, rather than presenting as a generic application of artificial intelligence.

### What's next for Dailies

- Extend the Retention Insight agent to correlate against thumbnail and title selection in addition to cut and music timing.
- Add an optional narration or voiceover generation feature using Gemini text to speech for creators who prefer a fully scripted voiceover track.
- Support batch analysis across a creator's entire video catalog rather than only their most recent uploads.

---

## Built With (individual tags, up to 25)

```
gemini
google-cloud
vertex-ai
agent-development-kit
agent-engine
lyria-3
clickhouse
model-context-protocol
mcp
youtube-analytics-api
cloud-run
node.js
typescript
react
secret-manager
oauth
javascript
```

---

## "Try it out" links

| Link | Status |
|---|---|
| Functional demo URL | Pending. To be deployed to Cloud Run once the build is complete. |
| GitHub repository (source code) | Pending. A public repository with an appropriate license, such as MIT or Apache 2.0, has not yet been created. |
| Demo video | Pending. The script has been drafted; recording has not yet begun. |

---

## Team
- Juliana Hill

---

## Additional info (visible to judges and organizers only)

| Field | Value |
|---|---|
| Submitter Type | Individual |
| Country of Residence | United States |
| Partner Track | ClickHouse |
| Platform | Web |
| Google Cloud and ClickHouse tools used | Gemini, Agent Development Kit, Agent Engine, and Lyria 3 (Google Cloud); ClickHouse, accessed through its official MCP server. See "How we are using Google Cloud and ClickHouse" above. |
| Repository visibility | To be confirmed as public once created. |
| Installation instructions | Not required once a hosted demonstration URL is available. |
| Upload a file | Optional. None selected at this time. |

---
*This is a draft written before development began. It reflects the planned build described in the project's technical specification (see `docs/dailies_hackathon_plan.md`). The sections titled "How we built it," "Challenges we ran into," "Accomplishments that we're proud of," and "What we learned" should be revised to reflect the actual outcome once the build is complete, and the pending links above should be finalized before submission. Please confirm that the Agentic Cinema hackathon rules (https://agentic-cinema.devpost.com/rules) have not changed prior to submitting, including the current prize amounts for the ClickHouse track.*
