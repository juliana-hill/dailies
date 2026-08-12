import React, { useEffect, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import AppShell from './components/AppShell';
import AuthPage from './components/AuthPage';
import Dashboard from './components/Dashboard';
import ProjectUploader from './components/ProjectUploader';
import WorkflowStepper from './components/WorkflowStepper';
import ErrorState from './components/ErrorState';
import VideoPreview from './components/VideoPreview';
import AnalysisPanel from './components/AnalysisPanel';
import SoundtrackCard from './components/SoundtrackCard';
import RetentionChart from './components/RetentionChart';
import EvidencePanel from './components/EvidencePanel';
import RecommendationCard from './components/RecommendationCard';
import {
  activeStepChanged, analysisLoaded, analysisReset, analysisSceneSelected, authModeChanged, demoSignedIn,
  evidenceToggled, insightLoaded, insightReset, projectCompleted, projectDemoLoaded, projectFailed,
  projectReset, projectStageChanged, runDemoProject, signedOut, uiReset, viewChanged,
} from './store';

const selectProject = (state) => state.project;
const selectAnalysis = (state) => state.analysis;
const selectInsight = (state) => state.insight;
const selectUi = (state) => state.ui;
const selectAuth = (state) => state.auth;

export default function App() {
  const dispatch = useDispatch();
  const project = useSelector(selectProject);
  const analysis = useSelector(selectAnalysis);
  const insight = useSelector(selectInsight);
  const ui = useSelector(selectUi);
  const auth = useSelector(selectAuth);
  const mainRef = useRef(null);
  const selectedScene = analysis.result?.scenes.find((scene) => scene.id === analysis.selectedSceneId) || analysis.result?.scenes[0];

  useEffect(() => {
    if (project.status !== 'processing') return undefined;
    const timer = window.setTimeout(() => {
      if (project.processingStage < 4) { dispatch(projectStageChanged(project.processingStage + 1)); return; }
      dispatch(analysisLoaded()); dispatch(insightLoaded()); dispatch(projectCompleted()); dispatch(activeStepChanged('analysis'));
    }, 780);
    return () => window.clearTimeout(timer);
  }, [dispatch, project.processingStage, project.status]);

  useEffect(() => { if (project.status === 'complete' && ui.view === 'project') mainRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, [project.status, ui.view]);

  const start = (payload = {}) => dispatch(runDemoProject(payload));
  const resetProject = () => { dispatch(projectReset()); dispatch(analysisReset()); dispatch(insightReset()); };
  const startNewProject = () => { window.scrollTo({ top: 0 }); resetProject(); dispatch(activeStepChanged('project')); dispatch(viewChanged('project')); };
  const openDemoReport = () => { window.scrollTo({ top: 0 }); dispatch(projectDemoLoaded()); dispatch(analysisLoaded()); dispatch(insightLoaded()); dispatch(activeStepChanged('analysis')); dispatch(viewChanged('project')); };
  const navigate = (destination) => {
    if (destination === 'dashboard') { dispatch(viewChanged('dashboard')); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    if (destination === 'projects') { dispatch(viewChanged('dashboard')); window.setTimeout(() => document.querySelector('.project-library')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0); return; }
    if (destination === 'insights') { dispatch(viewChanged('dashboard')); window.setTimeout(() => document.querySelector('.dashboard-focus')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 0); }
  };
  const switchStep = (step) => {
    if (project.status !== 'complete' && step !== 'project') return;
    dispatch(activeStepChanged(step));
    document.getElementById(step)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const setAuthMode = (mode) => { const url = new URL(window.location.href); url.searchParams.set('auth', mode); window.history.replaceState({}, '', url); dispatch(authModeChanged(mode)); };
  const signIn = (payload) => { window.scrollTo({ top: 0 }); window.history.replaceState({}, '', new URL('/studio/', window.location.origin)); dispatch(demoSignedIn(payload)); dispatch(viewChanged('dashboard')); };
  const signOut = () => { window.scrollTo({ top: 0 }); dispatch(signedOut()); dispatch(authModeChanged('sign-in')); dispatch(viewChanged('auth')); };

  if (auth.status !== 'authenticated') return <AuthPage mode={ui.authMode} onModeChange={setAuthMode} onSubmit={signIn} />;

  return <AppShell view={ui.view} activeStep={ui.activeStep} onNavigate={navigate} onStepChange={switchStep} onSignOut={signOut} user={auth.user}>
    {ui.view === 'dashboard' && <Dashboard user={auth.user} onNewProject={startNewProject} onOpenProject={openDemoReport} onBrowseProjects={() => navigate('projects')} />}
    {ui.view === 'project' && <main ref={mainRef} className="studio-main">
      {project.status === 'idle' && <div id="project-form"><ProjectUploader onSubmit={start} onFailure={() => dispatch(projectFailed('The connection to the project room was interrupted. This is a demo failure state.'))} /></div>}
      {(project.status === 'uploading' || project.status === 'processing') && <section className="processing-view"><div className="processing-copy"><p className="eyebrow">Project in progress</p><h1>Making sense of the <em>material.</em></h1><p>{project.status === 'uploading' ? 'Preparing your footage for a private project workspace.' : 'Dailies is moving through the footage, the score brief, and your retention history.'}</p><p className="project-file">{project.fileName}</p></div><WorkflowStepper status={project.status} currentStage={project.processingStage} /><p className="fixture-caption centered">Demo mode is showing staged local processing. Live integration will use the documented project API endpoints.</p></section>}
      {project.status === 'failed' && <ErrorState message={project.error} onRetry={() => start({ outline: project.outline })} onReset={startNewProject} />}
      {project.status === 'complete' && analysis.result && insight.result && <div className="project-report">
        <div className="report-intro"><div><p className="eyebrow">Project report <span className="demo-badge">Demo data</span></p><h1>{project.fileName.replace(/\.[^/.]+$/, '')}</h1><p>One pass through a new cut, with retained context from your recent videos.</p></div><div className="project-metrics"><span><strong>01:14</strong> rough cut</span><span><strong>04</strong> scenes found</span><span><strong>03</strong> source videos</span></div></div>
        <section id="analysis" className="preview-and-analysis"><VideoPreview scene={selectedScene} duration={analysis.result.durationSeconds} /><AnalysisPanel result={analysis.result} selectedScene={selectedScene} selectedSceneId={analysis.selectedSceneId} onSceneSelect={(id) => dispatch(analysisSceneSelected(id))} /></section>
        <section id="score"><SoundtrackCard brief={analysis.result.soundtrackBrief} segments={analysis.result.soundtrackSegments} /></section>
        <section id="insight" className="insight-section"><div className="section-heading"><div><p className="eyebrow">03 · Retention insight</p><h2>A pattern worth holding onto.</h2></div><span className="demo-badge">Fixture evidence</span></div><RetentionChart insight={insight.result} /><EvidencePanel insight={insight.result} open={ui.evidenceOpen} onToggle={() => dispatch(evidenceToggled())} /></section>
        <RecommendationCard insight={insight.result} />
        <div className="new-project"><span>Ready for another pass?</span><button className="button secondary" onClick={startNewProject}>Start a new project</button></div>
      </div>}
    </main>}
  </AppShell>;
}
