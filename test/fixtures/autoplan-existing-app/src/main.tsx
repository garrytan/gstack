import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Workspace } from './pages/Workspace';

function App() {
  const [state, setState] = useState<'loading' | 'login' | 'workspace' | 'error'>('loading');
  useEffect(() => { fetch('/api/session').then(response => setState(response.ok ? 'workspace' : response.status === 401 ? 'login' : 'error')).catch(() => setState('error')); }, []);
  if (state === 'loading') return <p role="status">Loading workspace…</p>;
  if (state === 'error') return <p role="alert">Workspace unavailable. Reload to retry.</p>;
  if (state === 'workspace') return <Workspace />;
  return <main className="mx-auto max-w-md p-6"><h1 className="text-2xl font-bold">Sign in</h1><form onSubmit={async event => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const response = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: form.get('email'), password: form.get('password') }) }).catch(() => null);
    if (response?.ok) location.assign('/workspace'); else setState('error');
  }}><label>Email<input className="block border focus-visible:outline" name="email" type="email" autoComplete="username" required /></label><label>Password<input className="block border focus-visible:outline" name="password" type="password" autoComplete="current-password" required /></label><button className="mt-4 rounded bg-blue-700 px-4 py-2 text-white focus-visible:outline" type="submit">Sign in</button></form></main>;
}
createRoot(document.getElementById('root')!).render(<App />);
