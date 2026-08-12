import { configureStore, createSlice } from '@reduxjs/toolkit';

const projectSlice = createSlice({
  name: 'project',
  initialState: { id: null, status: 'idle', error: null },
  reducers: {
    projectStarted: (state, action) => { state.id = action.payload; state.status = 'processing'; state.error = null; },
    projectCompleted: (state) => { state.status = 'complete'; },
    projectFailed: (state, action) => { state.status = 'failed'; state.error = action.payload; },
  },
});

export const { projectStarted, projectCompleted, projectFailed } = projectSlice.actions;
export const store = configureStore({ reducer: { project: projectSlice.reducer } });
