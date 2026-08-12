import React from 'react';

const stages = ['Ingest', 'Analyze', 'Score', 'Insight'];
export default function WorkflowStepper({ status, currentStage }) {
  const visibleStage = status === 'uploading' ? 0 : currentStage;
  return <section className="workflow-stepper" aria-label="Project processing progress">
    <div className="eyebrow-row"><span className="eyebrow">Reading your cut</span><span className="status-copy" aria-live="polite">{status === 'uploading' ? 'Preparing upload' : status === 'processing' ? `${stages[visibleStage - 1] || 'Ingest'} in progress` : 'Ready'}</span></div>
    <ol>{stages.map((stage, index) => <li key={stage} className={index < visibleStage ? 'is-complete' : index === visibleStage ? 'is-current' : ''}><span>{index < visibleStage ? '✓' : `0${index + 1}`}</span><strong>{stage}</strong></li>)}</ol>
  </section>;
}
