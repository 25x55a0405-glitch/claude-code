import { useEffect, useState, type ReactNode } from 'react';
import { api, UNAUTHORIZED_EVENT } from '../api';
import { Avatar } from './Avatar';
import { Icon } from './Icon';

type Gate = 'checking' | 'in' | 'out';

/** Shows the sign-in screen when the server has a password and there's no session. */
export function AuthGate({ children }: { children: ReactNode }) {
  const [gate, setGate] = useState<Gate>('checking');

  useEffect(() => {
    api.getSession().then(
      (s) => setGate(s.authRequired && !s.signedIn ? 'out' : 'in'),
      () => setGate('in'), // can't tell; let the app show its own errors
    );
    const onUnauthorized = () => setGate('out');
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  if (gate === 'checking') return null;
  if (gate === 'out') return <SignIn onDone={() => setGate('in')} />;
  return <>{children}</>;
}

function SignIn({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.signIn(password);
      onDone();
    } catch (e) {
      setError((e as Error).message || 'Sign-in failed');
      setBusy(false);
    }
  };

  return (
    <main className="signin">
      <form className="signin-card" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <Avatar size={96} track state={error ? 'waiting' : 'idle'} />
        <h1>Sign in to Skys</h1>
        <p className="t2">Enter the password set on your Skys server.</p>
        <div className="composer signin-field">
          <input
            id="signin-password"
            type="password"
            autoFocus
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            aria-label="Password"
          />
          <button className="send" type="submit" disabled={!password || busy} aria-label="Sign in"><Icon name="up" size={18} /></button>
        </div>
        {error && <p className="send-error" role="alert">{error}</p>}
      </form>
    </main>
  );
}
