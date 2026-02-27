"use client";

import { FormEvent, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ensureIdentity } from '@/lib/crypto';
import { loginUser, registerUser } from '@/lib/api';
import { setSession } from '@/lib/session';

type AuthMode = 'login' | 'register';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<AuthMode>('login');
  const [userIdInput, setUserIdInput] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const userId = useMemo(() => normalizeHandle(userIdInput), [userIdInput]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!userId) {
      setError('Identifiant invalide. Format: 3-24 caracteres [a-z0-9_-].');
      return;
    }
    if (password.length < 6) {
      setError('Mot de passe trop court (6 caracteres minimum).');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const keys = await ensureIdentity(userId);
      const session =
        mode === 'register'
          ? await registerUser(keys.publicKey, userId, password)
          : await loginUser(userId, password, keys.publicKey);

      setSession(session);
      router.replace('/chat');
    } catch (err) {
      const raw = err instanceof Error ? err.message : 'Erreur inconnue';
      const message = raw.toLowerCase();
      if (message.includes('invalid credentials')) {
        setError('Identifiants invalides.');
      } else if (message.includes('already exists')) {
        setError('Cet identifiant existe deja. Connectez-vous.');
      } else if (message.includes('relation') && message.includes('app_user')) {
        setError('Schema Supabase non initialise. Execute le fichier supabase/schema.sql dans SQL Editor.');
      } else if (message.includes('row-level security')) {
        setError('RLS bloque l\'operation. Applique le schema SQL fourni ou des policies autorisant l\'insert/select.');
      } else if (message.includes('invalid api key') || message.includes('jwt')) {
        setError('Cle Supabase invalide. Verifie NEXT_PUBLIC_SUPABASE_ANON_KEY.');
      } else if (message.includes('missing env')) {
        setError('Variables manquantes. Verifie NEXT_PUBLIC_API_BASE_URL.');
      } else if (message.includes('failed to fetch')) {
        setError(`API backend indisponible. Detail: ${raw}`);
      } else {
        setError(`Impossible de continuer: ${raw}`);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="auth-screen">
      <section className="glass-card auth-card-v2">
        <p className="kicker">Ghost Secure</p>
        <h1>Connexion securisee</h1>
        <p className="muted-text">Messagerie E2EE avec session token et transport temps reel.</p>

        <div className="segmented">
          <button
            type="button"
            className={`segmented-btn ${mode === 'login' ? 'active' : ''}`}
            onClick={() => setMode('login')}
          >
            Connexion
          </button>
          <button
            type="button"
            className={`segmented-btn ${mode === 'register' ? 'active' : ''}`}
            onClick={() => setMode('register')}
          >
            Inscription
          </button>
        </div>

        <form onSubmit={onSubmit} className="auth-form">
          <label className="field">
            <span>Identifiant</span>
            <input
              className="glass-input"
              value={userIdInput}
              onChange={(e) => setUserIdInput(e.target.value)}
              placeholder="ex: phantom_01"
              maxLength={24}
              autoFocus
            />
          </label>

          <label className="field">
            <span>Mot de passe</span>
            <input
              className="glass-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="6 caracteres minimum"
              minLength={6}
            />
          </label>

          <p className="user-id">ID normalise: {userId || '...'}</p>
          <button type="submit" className="glass-btn primary" disabled={loading}>
            {loading ? 'Traitement...' : mode === 'register' ? "Creer le compte" : 'Se connecter'}
          </button>
        </form>

        {error && <p className="error-text">{error}</p>}
      </section>
    </main>
  );
}

function normalizeHandle(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24);
}
