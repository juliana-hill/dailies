import React from 'react';
import image from '../../../public/assets/dailies-marketing-image-1.png';
export default function EmptyState({ onStart }) {
  return <section className="empty-state"><div className="empty-copy"><p className="eyebrow">Creator studio</p><h1>Make the next cut <em>count.</em></h1><p className="intro">Bring a rough cut and Dailies will trace its emotional movement, shape a score direction, and compare it with the moments your audience has left before.</p><button className="button primary" onClick={onStart}>Start a project <span aria-hidden="true">↗</span></button><p className="quiet-note">A considered workspace for the edit that comes next.</p></div><div className="empty-image"><img src={image} alt="A cinematic editing workspace" /><div className="image-marker"><i /> Reading the cut <span>·</span> 00:42</div></div></section>;
}
