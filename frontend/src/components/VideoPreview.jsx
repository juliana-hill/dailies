import React from 'react';
import image from '../../../public/assets/dailies-marketing-image-2.png';
const formatTime = (seconds) => `00:${String(Math.round(seconds)).padStart(2, '0')}`;
export default function VideoPreview({ scene, duration }) { return <section className="video-preview"><div className="preview-image"><img src={image} alt="Preview of the selected studio scene" /><button className="play-control" aria-label="Play preview">▶</button><div className="timecode">{formatTime(scene?.startSeconds || 0)} <span>/</span> {formatTime(duration)}</div></div><div className="preview-caption"><span className="eyebrow">Selected scene</span><strong>{scene?.summary || 'Choose a scene from the timeline.'}</strong></div></section>; }
