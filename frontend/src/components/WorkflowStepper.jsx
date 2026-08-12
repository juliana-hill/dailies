import React from 'react';

const stages = ['Ingest', 'Analyze', 'Score', 'Insight', 'Edit', 'Render'];
export default function WorkflowStepper({ status, currentStage }) {
  const visibleStage = status === 'uploading' ? 0 : currentStage;
  return <section className="workflow-stepper" aria-label="Project processing progress">
    <div className="eyebrow-row"><span className="eyebrow">Reading your cut</span><span className="status-copy" aria-live="polite">{status === 'uploading' ? 'Uploading footage' : status === 'uploaded' ? 'Ready to start processing' : status === 'analyzing' ? 'Gemini analysis in progress' : status === 'scoring' ? 'Lyria generation in progress' : status === 'querying_insights' ? 'ClickHouse MCP query in progress' : status === 'waiting_for_service' ? 'Waiting for ClickHouse MCP — checkpoints preserved' : status === 'editing' ? 'Building the enhanced timeline' : status === 'rendering' ? 'Rendering the final cut' : 'Preparing workflow'}</span></div>
    <ol>{stages.map((stage, index) => <li key={stage} className={index < visibleStage ? 'is-complete' : index === visibleStage ? 'is-current' : ''}><span>{index < visibleStage ? '✓' : `0${index + 1}`}</span><strong>{stage}</strong></li>)}</ol>
  </section>;
}
