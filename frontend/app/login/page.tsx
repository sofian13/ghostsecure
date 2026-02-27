"use client";

import { FormEvent, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ensureIdentity, wipeLocalKeys } from '@/lib/crypto';
import { loginUser, registerUser, uploadPreKeyBundle, fetchOtkCount } from '@/lib/api';
import { initRatchetIdentity, exportPreKeyBundle, generateNewPreKeys } from '@/lib/ratchet';
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
      let keys = await ensureIdentity(userId);

      // For registration: if keys already exist as non-extractable (publicKey empty),
      // wipe and regenerate so we can export the public key for the server.
      if (mode === 'register' && !keys.publicKey) {
        await wipeLocalKeys(userId);
        keys = await ensureIdentity(userId);
      }

      // Generate Signal Protocol identity and pre-key bundle
      let preKeyBundle: Awaited<ReturnType<typeof exportPreKeyBundle>> | undefined;
      try {
        const ratchetId = await initRatchetIdentity(userId);
        preKeyBundle = await exportPreKeyBundle(ratchetId);
      } catch {
        // Non-fatal: ratchet features will be unavailable
      }

      const session =
        mode === 'register'
          ? await registerUser(keys.publicKey, userId, password, keys.proof, keys.ecdhPublicKey, preKeyBundle)
          : await loginUser(userId, password, keys.publicKey || undefined, keys.ecdhPublicKey);

      // On login, upload pre-key bundle if available
      if (mode === 'login' && preKeyBundle) {
        try {
          await uploadPreKeyBundle(session, preKeyBundle);
        } catch {
          // Non-fatal
        }
      }

      // OTK replenishment: ensure at least 10 one-time pre-keys on server
      try {
        const otkCount = await fetchOtkCount(session);
        if (otkCount < 10) {
          const needed = 20 - otkCount;
          const newKeys = await generateNewPreKeys(userId, needed);
          await uploadPreKeyBundle(session, {
            identityKey: preKeyBundle?.identityKey ?? '',
            signedPrekey: preKeyBundle?.signedPrekey ?? '',
            signedPrekeySignature: preKeyBundle?.signedPrekeySignature ?? '',
            registrationId: preKeyBundle?.registrationId ?? 0,
            oneTimePreKeys: newKeys,
          });
        }
      } catch {
        // Non-fatal
      }

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
        <div className="auth-brand">
          <div className="brand-icon">
            <ShieldIcon />
          </div>
          <p className="kicker">Ghost Secure</p>
        </div>
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
            {loading ? (
              <span className="btn-content"><span className="spinner" /> Traitement</span>
            ) : mode === 'register' ? "Creer le compte" : 'Se connecter'}
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

function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2l7.5 3.5v5c0 5.25-3.19 10.15-7.5 11.5C7.69 20.65 4.5 15.75 4.5 10.5v-5L12 2Zm0 2.2L6.5 7v3.5c0 4.25 2.58 8.22 5.5 9.45 2.92-1.23 5.5-5.2 5.5-9.45V7L12 4.2Z" />
    </svg>
  );
}
