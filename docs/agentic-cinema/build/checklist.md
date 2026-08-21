# Dailies — Build Checklist

> Working scaffold. Lock this checklist after scope, PRD, and technical specification review.

- [x] **1. Repository and compliance foundation**
  Spec ref: `spec.md > Architecture`
  What to build: Add license, README, environment templates, dependency policy, and base folders.
  Acceptance: A fresh clone has documented setup and no committed secrets.
  Verify: Run the documented setup and dependency audit.

- [ ] **2. Marketing and application shell**
  Spec ref: `spec.md > Runtime components`
  What to build: Implement the branded Dailies landing page and workflow shell using the existing assets.
  Acceptance: The product promise, workflow, and primary CTA are clear on desktop and mobile.
  Verify: Run the static server and inspect both responsive layouts.

- [ ] **3. Fixture end-to-end result**
  Spec ref: `spec.md > Data flow`
  What to build: Render a complete fixture project with scenes, audio, retention evidence, and recommendation.
  Acceptance: The core demo story works without external credentials.
  Verify: Complete the flow locally from upload through results.

- [ ] **4. Cloud Storage upload and project status**
  Spec ref: `spec.md > Runtime components`
  What to build: Add video upload, project IDs, status tracking, and storage URIs.
  Acceptance: A supported video reaches a processing state and can be retrieved by project ID.
  Verify: Upload a short MP4 and poll status.

- [ ] **5. Gemini analysis agent**
  Spec ref: `spec.md > Critical technical decisions`
  What to build: Add structured multimodal analysis with schema validation.
  Acceptance: Real footage produces timestamped scenes and pacing flags.
  Verify: Run the analysis integration test against a permitted sample clip.

- [ ] **6. Lyria score agent**
  Spec ref: `spec.md > Runtime components`
  What to build: Generate and store a short instrumental clip from scene briefs.
  Acceptance: A playable clip and generation metadata appear in results.
  Verify: Generate once, play the returned asset, and confirm fallback behavior.

- [ ] **7. YouTube retention ingestion**
  Spec ref: `spec.md > Critical technical decisions`
  What to build: Add OAuth-authorized retrieval and normalized retention ingestion.
  Acceptance: The pipeline stores the API’s 100 normalized points without assuming one-second rows.
  Verify: Compare one imported report with stored ratios and derived timestamps.

- [ ] **8. ClickHouse MCP insight agent**
  Spec ref: `spec.md > Runtime components`
  What to build: Configure MCP and implement the retention correlation query.
  Acceptance: The recommendation depends on a live MCP query and cites supporting videos.
  Verify: Inspect MCP tool logs and run the query against fixture and real data.

- [ ] **9. ADK orchestration**
  Spec ref: `spec.md > Data flow`
  What to build: Connect analysis, score, and retention agents behind one project operation.
  Acceptance: The UI shows meaningful progress and final results for one project.
  Verify: Run an integration test with mocked specialists, then a real-service smoke test.

- [ ] **10. Cloud deployment and domain**
  Spec ref: `spec.md > Deployment target`
  What to build: Deploy the web/API service, configure secrets/logging, and map the custom domain.
  Acceptance: A fresh browser can complete the hosted workflow.
  Verify: Test the generated Cloud Run URL, then `dailies.gurlzine.com` over HTTPS.

- [ ] **11. Submission handoff**
  Spec ref: `spec.md > Deployment target`
  What to build: Finalize README, screenshots, video, Devpost draft, and compliance audit.
  Acceptance: Public repo, hosted URL, public video, and written submission agree with the shipped product.
  Verify: Perform the final live rules check and fresh-user walkthrough.
