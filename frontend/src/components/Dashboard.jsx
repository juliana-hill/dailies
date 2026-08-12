import React, { useEffect, useRef } from 'react';
import studioImage from '../../../public/assets/dailies-marketing-image-1.png';
import mossImage from '../../../public/assets/dailies-marketing-image-3.png';
import clayImage from '../../../public/assets/dailies-marketing-image-2.png';
import { dashboardProjects, dashboardSignal } from '../fixtures';

const imageFor = { studio: studioImage, moss: mossImage, clay: clayImage };

export default function Dashboard({ user, onNewProject, onOpenProject, onBrowseProjects }) {
  const dashboardRef = useRef(null);

  useEffect(() => {
    const root = dashboardRef.current;
    if (!root || window.matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) return undefined;
    const targets = root.querySelectorAll('[data-dashboard-reveal]');
    root.classList.add('motion-ready');
    const observer = new IntersectionObserver((entries) => entries.forEach((entry) => {
      if (entry.isIntersecting) { entry.target.classList.add('is-visible'); observer.unobserve(entry.target); }
    }), { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    targets.forEach((target) => observer.observe(target));
    return () => observer.disconnect();
  }, []);

  return <main ref={dashboardRef} className="dashboard-main">
    <section className="dashboard-welcome" data-dashboard-reveal><div><p className="eyebrow">Creator desk <span className="demo-badge">Mock data</span></p><h1>Good afternoon, <em>{user.firstName}.</em></h1><p>Your next cut is ready for a closer read.</p></div><button className="button primary" onClick={onNewProject}>Start a project <span aria-hidden="true">↗</span></button></section>
    <section className="dashboard-grid" data-dashboard-reveal>
      <article className="dashboard-focus"><div className="focus-top"><span className="eyebrow">From your last pass</span><span className="focus-mark">✦</span></div><h2>{dashboardSignal.headline}</h2><p>{dashboardSignal.detail}</p><div className="focus-stat"><span><strong>{dashboardSignal.videos}</strong> recent videos</span><span><strong>{dashboardSignal.movement}</strong> near the first transition</span></div><button className="text-button dashboard-link" onClick={onOpenProject}>Open the evidence <span aria-hidden="true">→</span></button></article>
      <article className="dashboard-activity"><p className="eyebrow">A gentle place to begin</p><h2>What is waiting.</h2><div className="activity-list"><div><i className="activity-dot lavender" /><span><strong>1</strong> project ready to review</span></div><div><i className="activity-dot apricot" /><span><strong>1</strong> score direction in progress</span></div><div><i className="activity-dot green" /><span><strong>4</strong> recent videos informing your signal</span></div></div><button className="text-button dashboard-link" onClick={onBrowseProjects}>View every project <span aria-hidden="true">→</span></button></article>
    </section>
    <section className="project-library" data-dashboard-reveal><div className="library-heading"><div><p className="eyebrow">Recent projects</p><h2>The work on your desk.</h2></div><button className="text-button dashboard-link" onClick={onBrowseProjects}>All projects <span aria-hidden="true">→</span></button></div><div className="project-card-grid">{dashboardProjects.map((project, index) => <article className="project-card" data-dashboard-reveal style={{ '--dashboard-index': index }} key={project.id}><div className="project-card-image"><img src={imageFor[project.image]} alt="" /><span className={`project-status ${project.statusTone}`}>{project.status}</span></div><div className="project-card-body"><div><p className="project-updated">{project.updated}</p><h3>{project.title}</h3><p>{project.subtitle}</p></div><dl><div><dt>{project.duration}</dt><dd>rough cut</dd></div><div><dt>{project.sceneCount}</dt><dd>scenes</dd></div></dl><div className="project-card-insight"><span>Next note</span><strong>{project.insight}</strong></div><button className="project-open" onClick={onOpenProject}>{project.statusTone === 'ready' ? 'Review report' : 'View project'} <span aria-hidden="true">↗</span></button></div></article>)}</div></section>
    <section className="dashboard-bottom" data-dashboard-reveal><article><p className="eyebrow">Working with care</p><h2>Creative direction, with its sources close.</h2><p>Dailies keeps observed behaviour and inferred cause separate, so a recommendation can be considered instead of accepted on faith.</p></article><article className="new-pass-card"><span>Next up</span><strong>Bring in the rough cut that still needs a second thought.</strong><button className="button secondary" onClick={onNewProject}>New project</button></article></section>
  </main>;
}
