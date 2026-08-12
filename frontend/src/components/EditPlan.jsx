import React from 'react';

export default function EditPlan({ plan }) { if (!plan) return null; return <section className="edit-plan report-panel"><div className="section-heading"><div><p className="eyebrow">04 · Applied edit</p><h2>What Dailies changed.</h2></div></div><p className="generation-brief">{plan.rationale}</p><div className="edit-plan-list">{plan.segments.map((segment) => <article key={segment.id}><span className={`project-status ${segment.action === 'remove' ? 'working' : 'ready'}`}>{segment.action}</span><strong>{format(segment.sourceStartSeconds)}–{format(segment.sourceEndSeconds)}</strong><p>{segment.reason}</p></article>)}</div></section>; }
const format = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
