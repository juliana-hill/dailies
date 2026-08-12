import React from 'react';

export default function ErrorState({ message, onRetry, onReset }) {
  return <section className="error-state panel"><p className="eyebrow">A small interruption</p><h1>We could not finish this pass.</h1><p>{message || 'The project could not reach the analysis room. Your footage and outline are still here.'}</p><div className="button-row"><button className="button primary" onClick={onRetry}>Try again</button><button className="button secondary" onClick={onReset}>Start over</button></div></section>;
}
