import React from 'react';

const stages = ['Ingest', 'Analyze', 'Score', 'Insight', 'Edit', 'Render'];
export default function WorkflowStepper({ status, currentStage, events = [], activityError, creatorHistoryEnabled }) {
  const visibleStage = status === 'uploading' ? 0 : currentStage;
  const activity = compactEvents(events);
  const latestEvent = activity.length ? activity[activity.length - 1] : null;
  const liveMessage = latestEvent ? eventLabel(latestEvent) : null;
  const waitingToRetry = latestEvent?.type === 'retry_scheduled';
  return <section className="workflow-stepper" aria-label="Project processing progress">
    <div className="eyebrow-row"><span className="eyebrow">Reading your cut</span><span className="status-copy" aria-live="polite">{isLive(status) && liveMessage ? liveMessage : status === 'uploading' ? 'Uploading footage' : status === 'uploaded' ? 'Ready to start processing' : status === 'waiting_for_service' ? 'Waiting for required service — checkpoints preserved' : 'Preparing agent workflow'}</span></div>
    <div className="workflow-body"><ol>{stages.map((stage, index) => { const skipped = stage === 'Insight' && creatorHistoryEnabled === false; return <li key={stage} className={`${index < visibleStage ? 'is-complete' : index === visibleStage ? 'is-current' : ''}${skipped ? ' is-skipped' : ''}`}><span>{skipped ? '—' : index < visibleStage ? '✓' : `0${index + 1}`}</span><strong>{stage}{skipped && <small>Skipped · YouTube not connected</small>}</strong></li>; })}</ol>
      <div className="pipeline-activity" aria-live="polite"><div className="activity-heading"><span className="eyebrow">Live activity</span><span className={`activity-state ${isLive(status) && !waitingToRetry ? 'is-live' : ''}`}><i />{stateLabel(status, waitingToRetry)}</span></div>{activityError ? <p className="activity-error">Activity temporarily unavailable.</p> : activity.length ? <ul>{activity.map((event) => <li key={event.eventId}><time dateTime={event.createdAt}>{formatTime(event.createdAt)}</time><span>{eventLabel(event)}</span></li>)}</ul> : <p className="activity-empty">Waiting for the first pipeline event.</p>}</div>
    </div>
  </section>;
}
const isLive = (status) => ['analyzing', 'scoring', 'querying_insights', 'editing', 'rendering'].includes(status);
const stateLabel = (status, waitingToRetry) => waitingToRetry ? 'Waiting to retry' : isLive(status) ? 'Running' : status === 'waiting_for_service' ? 'Paused' : status === 'complete' ? 'Complete' : status === 'failed' ? 'Stopped' : 'Not started';
const compactEvents = (events) => { const latest = new Map(); events.forEach((event) => latest.set(`${event.type}|${event.stage}|${event.message || ''}`, event)); return [...latest.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-20); };
const formatTime = (value) => new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date(value));
const eventLabel = (event) => event.type === 'lease_claimed' ? 'Worker resumed the recorded pipeline.' : event.type === 'lease_recovered' ? 'Recovered an expired worker lease.' : event.type === 'checkpoint' ? event.message || `${event.stage} checkpoint saved.` : event.type === 'waiting_for_service' ? 'Paused at Insight — ClickHouse MCP configuration required.' : event.type === 'retry_scheduled' ? retryLabel(event.message) : event.type === 'completed' ? 'Final cut and report completed.' : event.type === 'failed' ? event.message || 'Pipeline stopped.' : event.type === 'submitted' || event.type === 'retry_submitted' ? event.message || 'Pipeline submitted.' : event.message || event.stage;
const retryLabel = (message = '') => /(resource_exhausted|quota|\b429\b)/i.test(message) ? `Vertex AI audio generation is temporarily at capacity; completed cues are preserved.${message.match(/retry in \d+ seconds/i)?.[0] ? ` ${message.match(/retry in \d+ seconds/i)[0]}.` : ''}` : message || 'Transient failure; retry scheduled.';
