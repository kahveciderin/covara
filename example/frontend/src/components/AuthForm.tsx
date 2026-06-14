import { useState, FormEvent } from 'react';
import { useAuth } from 'covara/client/react';

interface AuthFormProps {
  onLogin: () => void;
  version?: string;
}

export function AuthForm({ onLogin, version }: AuthFormProps) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login, signup } = useAuth();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      if (mode === 'login') {
        await login(email, password);
      } else {
        await signup({ email, password, name });
      }
      onLogin();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'An error occurred');
    }

    setLoading(false);
  };

  return (
    <div className="container">
      <div className="card">
        <div className="header">
          <h1>📝 Todo App</h1>
          <p>{mode === 'login' ? 'Welcome back!' : 'Create your account'}</p>
        </div>
        <form className="content" onSubmit={handleSubmit}>
          {mode === 'signup' && (
            <div className="input-group">
              <label>Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                required
              />
            </div>
          )}
          <div className="input-group">
            <label>Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
            />
          </div>
          <div className="input-group">
            <label>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </div>
          {error && <p className="error-message">{error}</p>}
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Loading...' : mode === 'login' ? 'Sign In' : 'Create Account'}
          </button>
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setMode(mode === 'login' ? 'signup' : 'login');
              setError('');
            }}
          >
            {mode === 'login'
              ? "Don't have an account? Sign up"
              : 'Already have an account? Sign in'}
          </button>
        </form>
        {version && <div className="version-badge">v{version}</div>}
      </div>
    </div>
  );
}
