import React, { useState } from 'react';
import image from '../../../public/assets/dailies-marketing-image-4.png';
import logo from '../../../public/assets/dailies-logo.png';

export default function AuthPage({ mode, onModeChange, onSubmit }) {
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const isSignUp = mode === 'sign-up';
  const update = (key) => (event) => setForm({ ...form, [key]: event.target.value });
  const submit = (event) => { event.preventDefault(); onSubmit({ fullName: form.name || undefined, email: form.email || undefined }); };

  return <main className="auth-page">
    <section className="auth-form-area">
      <a className="auth-brand" href="#top" onClick={(event) => event.preventDefault()}><img src={logo} alt="" /><span>Dailies</span></a>
      <div className="auth-card">
        <span className="demo-badge">Demo workspace</span>
        <p className="eyebrow">Creator studio</p>
        <h1>{isSignUp ? 'Make the next cut count.' : 'Welcome back.'}</h1>
        <p className="auth-intro">{isSignUp ? 'Set up a quiet place for your footage, score directions, and audience signals.' : 'Return to the work your last edit started.'}</p>
        <form onSubmit={submit}>
          {isSignUp && <label>Full name<input value={form.name} onChange={update('name')} placeholder="Your name" autoComplete="name" /></label>}
          <label>Email address<input value={form.email} onChange={update('email')} type="email" placeholder="you@example.com" autoComplete="email" /></label>
          <label>Password<input value={form.password} onChange={update('password')} type="password" placeholder="••••••••" autoComplete={isSignUp ? 'new-password' : 'current-password'} /></label>
          {!isSignUp && <button className="auth-forgot" type="button">Forgot password?</button>}
          <button className="button primary full" type="submit">{isSignUp ? 'Create a studio' : 'Enter your studio'} <span aria-hidden="true">↗</span></button>
        </form>
        <p className="auth-switch">{isSignUp ? 'Already have a studio?' : 'New to Dailies?'} <button type="button" onClick={() => onModeChange(isSignUp ? 'sign-in' : 'sign-up')}>{isSignUp ? 'Sign in' : 'Create an account'}</button></p>
        <p className="auth-demo-note">This is a local demo. No account is created and no credentials are sent.</p>
      </div>
    </section>
    <aside className="auth-story" aria-label="Dailies creator workspace preview"><img src={image} alt="A filmmaker reviewing a cut" /><div className="auth-story-copy"><span className="eyebrow">A considered editing bay</span><strong>See what changed.<br />Make the next move yours.</strong><p>Footage, score, and audience signals in one creative room.</p></div></aside>
  </main>;
}
