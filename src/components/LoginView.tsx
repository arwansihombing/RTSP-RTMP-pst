import { useState, type FormEvent } from 'react';
import { Lock, AlertCircle } from 'lucide-react';
import { apiFetch, setAuthToken } from '../utils/authFetch';

interface LoginViewProps {
  onLoginSuccess: () => void;
}

export function LoginView({ onLoginSuccess }: LoginViewProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!username.trim() || !password) {
      setError('Username dan password wajib diisi.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await apiFetch('/api/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ username: username.trim(), password }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAuthToken(null);
        setError(data.error || 'Login gagal. Periksa username dan password.');
        return;
      }

      if (typeof data.token === 'string' && data.token) {
        setAuthToken(data.token);
      }

      const verifyRes = await apiFetch('/auth/session');
      const verifyData = await verifyRes.json().catch(() => ({}));
      if (!verifyRes.ok || !verifyData?.authenticated) {
        setAuthToken(null);
        setError('Sesi login tidak tersimpan oleh browser atau proxy. Coba muat ulang halaman.');
        return;
      }

      onLoginSuccess();
    } catch {
      setError('Tidak dapat terhubung ke server.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center items-center px-4 py-12">
      <div className="w-full max-w-sm bg-white border border-slate-200 rounded-lg shadow-sm overflow-hidden">
        <div className="px-6 py-5 border-b border-slate-200 flex items-center gap-3">
          <div className="h-9 w-9 rounded-md bg-slate-900 text-white flex items-center justify-center shrink-0">
            <Lock className="h-4 w-4" />
          </div>
          <div>
            <h1 className="font-display text-lg font-bold tracking-tight text-slate-900">
              StreamBridge
            </h1>
            <p className="text-xs text-slate-500">RTSP to RTMP Console Login</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} noValidate className="p-6 space-y-4">
          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 p-3 text-xs text-red-800 bg-red-50 border border-red-200 rounded-md"
            >
              <AlertCircle className="h-4 w-4 shrink-0 text-red-600 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <div>
            <label htmlFor="login-username" className="block text-sm font-medium text-slate-700 mb-1">
              Username
            </label>
            <input
              id="login-username"
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="admin"
              className="w-full px-3 py-2 text-sm text-slate-900 bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-slate-900"
            />
          </div>

          <div>
            <label htmlFor="login-password" className="block text-sm font-medium text-slate-700 mb-1">
              Password
            </label>
            <input
              id="login-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 text-sm text-slate-900 bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-slate-900"
            />
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full px-4 py-2.5 text-sm font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2 disabled:opacity-50 transition-colors"
          >
            {submitting ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}
