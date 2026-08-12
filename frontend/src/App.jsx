import { useSelector } from 'react-redux';

export default function App() {
  const status = useSelector((state) => state.project.status);

  return (
    <main style={{ fontFamily: 'system-ui', maxWidth: 720, margin: '6rem auto', padding: '0 1.5rem' }}>
      <p style={{ letterSpacing: '.12em', textTransform: 'uppercase', color: '#a88fdf' }}>Dailies</p>
      <h1 style={{ fontFamily: 'Georgia', fontSize: 'clamp(3rem, 9vw, 6rem)', fontWeight: 400, lineHeight: 1 }}>Make the next cut count.</h1>
      <p style={{ color: '#706d7c', fontSize: '1.2rem', maxWidth: 520 }}>The interactive creator workflow will live here: upload, analyze, score, and learn from your audience.</p>
      <p aria-live="polite">Project status: <strong>{status}</strong></p>
    </main>
  );
}
