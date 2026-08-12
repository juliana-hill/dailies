import React, { useEffect, useState } from 'react';
import { api } from '../api';

export default function FinalCutPlayer({ projectId, finalCut }) {
  const [url, setUrl] = useState(''); const [error, setError] = useState('');
  useEffect(() => { if (!finalCut?.asset?.id) return; api.assetUrl(projectId, finalCut.asset.id).then((value) => setUrl(value.url)).catch((value) => setError(value.message)); }, [projectId, finalCut?.asset?.id]);
  return <section className="final-cut report-panel"><div className="section-heading"><div><p className="eyebrow">Enhanced final cut</p><h2>The analysis, applied.</h2></div>{url && <a className="button secondary" href={url} download={finalCut.asset.fileName}>Download MP4</a>}</div>{url ? <video className="final-cut-video" controls src={url} /> : <p className="validation">{error || 'Loading the rendered final cut from Cloud Storage…'}</p>}<p className="demo-audio-note">Rendered by {finalCut.renderProvider === 'google-cloud-transcoder' ? 'Google Cloud Transcoder' : 'fixture mode'} · {Math.round(finalCut.durationSeconds)}s</p></section>;
}
