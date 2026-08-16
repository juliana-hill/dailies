import React from 'react';
import logo from '../../../public/assets/dailies-logo.png';

export default function AppShell({ children, view, activeStep, onNavigate, onStepChange, onSignOut, user }) {
  const projectSteps = [['project', 'Project'], ['analysis', 'Analysis'], ['score', 'Score'], ['insight', 'Insight']];
  const dashboardItems = [['dashboard', 'Overview'], ['projects', 'Projects'], ['insights', 'Insights']];
  const items = view === 'project' ? projectSteps : dashboardItems;
  const handleItem = (id) => view === 'project' ? onStepChange(id) : onNavigate(id);

  return <div className="app-shell">
    <header className="app-header">
      <button className="brand-lockup" onClick={() => onNavigate('dashboard')} aria-label="Return to your Dailies dashboard"><img src={logo} alt="" /><span>Dailies</span></button>
      <nav className="desktop-nav" aria-label="Creator studio sections">
        {items.map(([id, label]) => <button key={id} className={(view === 'project' ? activeStep === id : view === id) ? 'nav-link is-active' : 'nav-link'} onClick={() => handleItem(id)}>{label}</button>)}
      </nav>
      <div className="account-area"><span className="avatar-button" aria-hidden="true">{user?.initials || 'D'}</span><button className="sign-out-link" onClick={onSignOut}>Sign out</button></div>
    </header>
    {children}
  </div>;
}
