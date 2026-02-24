"use client";

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ensureIdentity } from '@/lib/crypto';
import { registerUser } from '@/lib/api';
import { setSession } from '@/lib/session';
import { checkSupabaseConnection, type SupabaseStatus } from '@/lib/supabase';

export default function LoginPage() {
  const router = useRouter();
  const [handle, setHandle] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [supabaseStatus, setSupabaseStatus] = useState<SupabaseStatus | null>(null);

  const normalizedHandle = useMemo(() => normalizeHandle(handle), [handle]);

  useEffect(() => {
    let active = true;
    checkSupabaseConnection().then((status) => {
      if (active) setSupabaseStatus(status);
    });
    return () => {
      active = false;
    };
  }, []);

  const createIdentity = async (e: FormEvent) => {
    e.preventDefault();
    if (!normalizedHandle) {
      setError('Entre un identifiant valide (3-24 caracteres).');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const suffix = crypto.randomUUID().slice(0, 8);
      const userId = `${normalizedHandle}-${suffix}`.slice(0, 36);
      const keys = await ensureIdentity(userId);
      const session = await registerUser(keys.publicKey, userId);
      setSession({
        ...session,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
      });
      router.replace('/chat');
    } catch {
      setError("Inscription impossible pour l'instant. Reessaie.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="auth-screen">
      <div className="auth-card">
        <h1>Ghost Secure</h1>
        <p>Inscription instantanee. Creation en base puis connexion automatique.</p>
        <p className="user-id">
          Supabase: {supabaseStatus === null ? 'verification...' : supabaseStatus.message}
        </p>
        <div className="auth-meta">
          <span className="auth-chip">E2EE</span>
          <span className="auth-chip">Ephemere</span>
          <span className="auth-chip">Anonyme</span>
        </div>
        <form onSubmit={createIdentity} className="auth-form">
          <input
            className="ghost-input"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="Choisis ton identifiant (ex: phantom)"
            maxLength={24}
            autoFocus
          />
          <p className="user-id">ID final: {normalizedHandle ? `${normalizedHandle}-xxxxxxxx` : '...'}</p>
          <button type="submit" className="ghost-btn" disabled={loading}>
            {loading ? 'Creation...' : "S'inscrire et continuer"}
          </button>
        </form>
        {error && <p className="error-text">{error}</p>}
      </div>
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
