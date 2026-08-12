import { configureStore, createAsyncThunk, createSlice } from '@reduxjs/toolkit';
import { demoAnalysis, demoCreator, demoInsight, demoProject } from './fixtures';

const wait = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

export const runDemoProject = createAsyncThunk('project/runDemoProject', async (payload = {}) => {
  const fileName = payload.file?.name || 'Studio-visit-rough-cut.mp4';
  await wait(520);
  return { fileName, outline: payload.outline || 'A small studio visit that moves from arrival to a decisive reveal.' };
});

const projectSlice = createSlice({
  name: 'project',
  initialState: {
    id: null,
    status: 'idle',
    fileName: '',
    outline: '',
    processingStage: 0,
    error: null,
  },
  reducers: {
    projectStageChanged: (state, action) => { state.processingStage = action.payload; },
    projectCompleted: (state) => { state.status = 'complete'; state.processingStage = 4; },
    projectDemoLoaded: (state) => Object.assign(state, { id: demoProject.id, status: 'complete', fileName: 'Studio-visit-rough-cut.mp4', outline: 'A small studio visit that moves from arrival to a decisive reveal.', processingStage: 4, error: null }),
    projectFailed: (state, action) => { state.status = 'failed'; state.error = action.payload; },
    projectReset: (state) => Object.assign(state, { id: null, status: 'idle', fileName: '', outline: '', processingStage: 0, error: null }),
  },
  extraReducers: (builder) => {
    builder
      .addCase(runDemoProject.pending, (state, action) => {
        state.id = demoProject.id;
        state.status = 'uploading';
        state.fileName = action.meta.arg?.file?.name || 'Studio-visit-rough-cut.mp4';
        state.outline = action.meta.arg?.outline || '';
        state.processingStage = 0;
        state.error = null;
      })
      .addCase(runDemoProject.fulfilled, (state, action) => {
        state.status = 'processing';
        state.fileName = action.payload.fileName;
        state.outline = action.payload.outline;
        state.processingStage = 1;
      });
  },
});

const analysisSlice = createSlice({
  name: 'analysis',
  initialState: { result: null, status: 'idle', error: null, selectedSceneId: 'scene-1' },
  reducers: {
    analysisLoaded: (state) => { state.result = demoAnalysis; state.status = 'complete'; state.error = null; },
    analysisSceneSelected: (state, action) => { state.selectedSceneId = action.payload; },
    analysisReset: (state) => Object.assign(state, { result: null, status: 'idle', error: null, selectedSceneId: 'scene-1' }),
  },
});

const insightSlice = createSlice({
  name: 'insight',
  initialState: { result: null, status: 'idle', error: null },
  reducers: {
    insightLoaded: (state) => { state.result = demoInsight; state.status = 'complete'; state.error = null; },
    insightReset: (state) => Object.assign(state, { result: null, status: 'idle', error: null }),
  },
});

const authSlice = createSlice({
  name: 'auth',
  initialState: { status: 'unauthenticated', user: null },
  reducers: {
    demoSignedIn: (state, action) => { state.status = 'authenticated'; state.user = { ...demoCreator, ...(action.payload || {}) }; },
    signedOut: (state) => { state.status = 'unauthenticated'; state.user = null; },
  },
});

const queryAuthMode = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('auth') === 'sign-up' ? 'sign-up' : 'sign-in';

const uiSlice = createSlice({
  name: 'ui',
  initialState: { activeStep: 'project', isDemo: true, evidenceOpen: false, view: 'auth', authMode: queryAuthMode },
  reducers: {
    activeStepChanged: (state, action) => { state.activeStep = action.payload; },
    evidenceToggled: (state) => { state.evidenceOpen = !state.evidenceOpen; },
    viewChanged: (state, action) => { state.view = action.payload; },
    authModeChanged: (state, action) => { state.authMode = action.payload; },
    uiReset: (state) => Object.assign(state, { activeStep: 'project', isDemo: true, evidenceOpen: false, view: 'dashboard', authMode: 'sign-in' }),
  },
});

export const { projectStageChanged, projectCompleted, projectDemoLoaded, projectFailed, projectReset } = projectSlice.actions;
export const { analysisLoaded, analysisSceneSelected, analysisReset } = analysisSlice.actions;
export const { insightLoaded, insightReset } = insightSlice.actions;
export const { demoSignedIn, signedOut } = authSlice.actions;
export const { activeStepChanged, authModeChanged, evidenceToggled, uiReset, viewChanged } = uiSlice.actions;

export const store = configureStore({
  reducer: { project: projectSlice.reducer, analysis: analysisSlice.reducer, insight: insightSlice.reducer, auth: authSlice.reducer, ui: uiSlice.reducer },
});

/** @type {(state: ReturnType<typeof store.getState>) => ReturnType<typeof store.getState>} */
export const selectState = (state) => state;
