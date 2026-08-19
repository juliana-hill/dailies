import { configureStore, createAsyncThunk, createSlice } from '@reduxjs/toolkit';
import { api, readVideoDuration } from './api';

const errorPayload = (error) => ({ message: error.message || 'Request failed.', code: error.code || 'CLIENT_ERROR', retryable: Boolean(error.retryable) });
export const loadSession = createAsyncThunk('auth/loadSession', async (_, { rejectWithValue }) => { try { return await api.me(); } catch (error) { return rejectWithValue(errorPayload(error)); } });
export const submitProject = createAsyncThunk('project/submit', async ({ file, outline }, { rejectWithValue }) => { try {
  if (!file) throw new Error('Choose a video before starting analysis.'); const durationSeconds = await readVideoDuration(file);
  const created = await api.createProject({ title: file.name.replace(/\.[^/.]+$/, ''), outline, fileName: file.name, mimeType: file.type, fileSizeBytes: file.size, durationSeconds });
  await api.upload(created.uploadTarget, file, durationSeconds); return await api.analyze(created.project.projectId);
} catch (error) { return rejectWithValue(errorPayload(error)); } });
export const fetchProject = createAsyncThunk('project/fetch', async (id, { rejectWithValue }) => { try { return await api.project(id); } catch (error) { return rejectWithValue(errorPayload(error)); } });
export const fetchPipelineActivity = createAsyncThunk('project/activity', async (id, { rejectWithValue }) => { try { return await api.activity(id); } catch (error) { return rejectWithValue(errorPayload(error)); } });
export const retryProject = createAsyncThunk('project/retry', async (id, { rejectWithValue }) => { try { return await api.analyze(id); } catch (error) { return rejectWithValue(errorPayload(error)); } });
export const restartProject = createAsyncThunk('project/restart', async (id, { rejectWithValue }) => { try { return await api.restart(id); } catch (error) { return rejectWithValue(errorPayload(error)); } });
export const openProject = createAsyncThunk('project/open', async (id, { rejectWithValue }) => { try { return await api.project(id); } catch (error) { return rejectWithValue(errorPayload(error)); } });

const projectInitial = { id: null, status: 'idle', fileName: '', outline: '', processingStage: 0, error: null, errorCode: null, retryable: false, report: null, activity: [], activityError: null, uploadAssetId: null, creatorHistoryEnabled: null };
// Numbered to match the WorkflowStepper's step order (Ingest/Analyze/Insight/Edit/Score/Render),
// which itself follows the editorial agent's actual first-pass sequence — analyze, then optional
// creator evidence, then the edit plan, then the assets that plan justifies, then render.
const stageFor = { created: 0, uploading: 0, uploaded: 1, analyzing: 1, querying_insights: 2, waiting_for_service: 2, editing: 3, scoring: 4, rendering: 5, complete: 6, failed: 0 };
// A project fetched from the backend at status 'created' never made it past the initial
// record — the browser's direct-to-GCS upload never finalized (network drop, CORS, tab
// closed mid-upload, etc). There's no pipeline running to poll for, so surface it as a
// failure with a path back to a fresh upload rather than showing a fake progress screen.
const assignProject = (state, project) => {
  const stalled = project.status === 'created'; const sameProject = state.id === project.projectId; const targetStage = stageFor[project.status] ?? 0;
  state.id = project.projectId; state.status = stalled ? 'failed' : project.status; state.fileName = project.fileName; state.outline = project.outline;
  // The editorial agent's edit/score checkpoints interleave — a revision loop re-enters 'editing'
  // after 'scoring', and 'editing' recurs again after 'rendering' for review — rather than advancing
  // strictly through stageFor's order. Track the furthest stage reached per project instead of the
  // latest status literally, or the stepper visibly jumps backward each time an earlier stage recurs.
  state.processingStage = sameProject ? Math.max(state.processingStage, targetStage) : targetStage;
  state.error = stalled ? 'The upload never finished, so there is nothing to analyze yet. Start over to upload the footage again.' : project.error || null; state.errorCode = stalled ? 'UPLOAD_NOT_FINALIZED' : state.errorCode; state.retryable = stalled ? false : state.retryable; state.report = project.report || null; state.progress = project.progress || null; state.uploadAssetId = project.uploadAssetId || null; state.creatorHistoryEnabled = project.creatorHistoryEnabled ?? null;
};
const projectSlice = createSlice({ name: 'project', initialState: projectInitial, reducers: { projectReset: () => projectInitial, projectFailed: (state, action) => { state.status = 'failed'; state.error = action.payload; }, }, extraReducers: (builder) => builder
  .addCase(submitProject.pending, (state, action) => { state.status = 'uploading'; state.fileName = action.meta.arg.file?.name || ''; state.outline = action.meta.arg.outline || ''; state.error = null; })
  .addCase(submitProject.fulfilled, (state, action) => assignProject(state, action.payload))
  .addCase(submitProject.rejected, (state, action) => { state.status = 'failed'; state.error = action.payload?.message || action.error.message; state.errorCode = action.payload?.code; state.retryable = action.payload?.retryable; })
  .addCase(fetchProject.fulfilled, (state, action) => assignProject(state, action.payload))
  .addCase(fetchProject.rejected, (state, action) => { state.status = 'failed'; state.error = action.payload?.message || action.error.message; state.retryable = action.payload?.retryable; })
  .addCase(fetchPipelineActivity.fulfilled, (state, action) => { state.activity = action.payload.events || []; state.activityError = null; })
  .addCase(fetchPipelineActivity.rejected, (state, action) => { state.activityError = action.payload?.message || action.error.message; })
  .addCase(retryProject.pending, (state) => { state.status = 'analyzing'; state.error = null; state.retryable = false; })
  .addCase(retryProject.fulfilled, (state, action) => assignProject(state, action.payload))
  .addCase(retryProject.rejected, (state, action) => { state.status = 'failed'; state.error = action.payload?.message || action.error.message; state.retryable = action.payload?.retryable; })
  // Unlike retryProject, the server has thrown away every durable stage (analysis, editorial review,
  // draftHistory) for this project, so the previous pass's report/progress must not linger in the UI
  // while the fresh one runs — assignProject already nulls them out, but clear activity here since
  // that's this slice's own field, not something assignProject touches.
  .addCase(restartProject.pending, (state) => { state.status = 'analyzing'; state.error = null; state.retryable = false; state.activity = []; state.activityError = null; })
  .addCase(restartProject.fulfilled, (state, action) => assignProject(state, action.payload))
  .addCase(restartProject.rejected, (state, action) => { state.status = 'failed'; state.error = action.payload?.message || action.error.message; state.retryable = action.payload?.retryable; })
  .addCase(openProject.fulfilled, (state, action) => assignProject(state, action.payload)) });

const projectResultActions = [fetchProject.fulfilled.type, retryProject.fulfilled.type, openProject.fulfilled.type];
const analysisSlice = createSlice({ name: 'analysis', initialState: { result: null, status: 'idle', selectedSceneId: null }, reducers: { analysisSceneSelected: (state, action) => { state.selectedSceneId = action.payload; }, analysisReset: (state) => { state.result = null; state.status = 'idle'; state.selectedSceneId = null; } }, extraReducers: (builder) => builder.addCase(submitProject.fulfilled, (state) => { state.status = 'loading'; }).addCase(restartProject.pending, (state) => { state.result = null; state.status = 'loading'; state.selectedSceneId = null; }).addMatcher((action) => projectResultActions.includes(action.type), (state, action) => { const analysis = action.payload.report?.analysis || action.payload.progress?.analysis; if (analysis) { state.result = analysis; state.status = 'complete'; state.selectedSceneId ||= analysis.scenes[0]?.id; } }) });
const insightSlice = createSlice({ name: 'insight', initialState: { result: null, status: 'idle' }, reducers: { insightReset: (state) => { state.result = null; state.status = 'idle'; } }, extraReducers: (builder) => builder.addCase(submitProject.fulfilled, (state) => { state.status = 'loading'; }).addCase(restartProject.pending, (state) => { state.result = null; state.status = 'loading'; }).addMatcher((action) => projectResultActions.includes(action.type), (state, action) => { const recommendation = action.payload.report?.recommendation || action.payload.progress?.recommendation; if (recommendation) { state.result = recommendation; state.status = 'complete'; } }) });
const authSlice = createSlice({ name: 'auth', initialState: { status: 'loading', user: null, projects: [], error: null }, reducers: { signedOut: (state) => { state.status = 'unauthenticated'; state.user = null; }, signInFailed: (state) => { state.status = 'unauthenticated'; state.error = 'Google sign-in did not complete. Please try again.'; } }, extraReducers: (builder) => builder.addCase(loadSession.fulfilled, (state, action) => { state.status = 'authenticated'; state.user = action.payload.user; state.projects = action.payload.projects; state.error = null; }).addCase(loadSession.rejected, (state, action) => { state.status = 'unauthenticated'; state.error = action.payload?.code === 'AUTH_REQUIRED' ? null : action.payload?.message || action.error.message; }) });
const uiSlice = createSlice({ name: 'ui', initialState: { activeStep: 'project', evidenceOpen: false, view: 'dashboard' }, reducers: { activeStepChanged: (s, a) => { s.activeStep = a.payload; }, evidenceToggled: (s) => { s.evidenceOpen = !s.evidenceOpen; }, viewChanged: (s, a) => { s.view = a.payload; }, uiReset: (s) => { s.activeStep = 'project'; s.evidenceOpen = false; s.view = 'dashboard'; } } });
export const { projectFailed, projectReset } = projectSlice.actions; export const { analysisSceneSelected, analysisReset } = analysisSlice.actions; export const { insightReset } = insightSlice.actions; export const { signedOut, signInFailed } = authSlice.actions; export const { activeStepChanged, evidenceToggled, uiReset, viewChanged } = uiSlice.actions;
export const store = configureStore({ reducer: { project: projectSlice.reducer, analysis: analysisSlice.reducer, insight: insightSlice.reducer, auth: authSlice.reducer, ui: uiSlice.reducer } });
export const selectState = (state) => state;
