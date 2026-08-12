import React from 'react';

const time = (seconds) => `00:${String(seconds).padStart(2, '0')}`;
export default function SceneTimeline({ scenes, activeId, onSelect }) { return <div className="scene-timeline" role="list">{scenes.map((scene) => <button key={scene.id} role="listitem" className={scene.id === activeId ? 'scene-row is-selected' : 'scene-row'} onClick={() => onSelect(scene.id)}><span className="scene-time">{time(scene.startSeconds)}<i /></span><span className="scene-detail"><strong>{scene.summary}</strong><small>{scene.mood} <b>·</b> {Math.round(scene.energy * 100)}% energy</small></span>{scene.pacingFlags.length > 0 && <span className="flag-count">{scene.pacingFlags.length} flag{scene.pacingFlags.length > 1 ? 's' : ''}</span>}</button>)}</div>; }
