import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function AssetDownloadLink({ projectId, asset, children, className = 'button secondary' }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    if (!projectId || !asset?.id) return undefined;
    api.assetUrl(projectId, asset.id).then((value) => { if (current) setUrl(value.url); }).catch((value) => { if (current) setError(value.message); });
    return () => { current = false; };
  }, [projectId, asset?.id]);
  if (!asset) return null;
  if (!url) return <span className="asset-download-status" title={error}>{error || 'Preparing download…'}</span>;
  return <a className={className} href={url} download={asset.fileName}>{children}</a>;
}
