"use client";

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import SecurityShell from '@/components/SecurityShell';
import MobileTabs from '@/components/MobileTabs';
import { deleteAccount, logoutAllDevices, logoutUser } from '@/lib/api';
import { clearSession, getSession } from '@/lib/session';
import { wipeLocalKeys } from '@/lib/crypto';

type ThemeMode = 'dark' | 'light';

export default function SettingsPage() {
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemeMode>('dark');
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    const session = getSession();
    if (!session) {
      router.replace('/login');
      return;
    }
    setUserId(session.userId);

    const savedTheme = window.localStorage.getItem('ghost_theme');
    const mode = savedTheme === 'light' ? 'light' : 'dark';
    setTheme(mode);
    document.documentElement.dataset.theme = mode;
  }, [router]);

  const onSwitchTheme = () => {
    const next: ThemeMode = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.dataset.theme = next;
    window.localStorage.setItem('ghost_theme', next);
  };

  if (!userId) return <main className="centered">Chargement...</main>;

  return (
    <SecurityShell userId={userId}>
      <main className="mobile-screen settings-mobile">
        <header className="mobile-header">
          <div>
            <h1>Parametres</h1>
            <p className="muted-text">Compte et securite</p>
          </div>
        </header>

        <section className="inline-card">
          <div className="profile-header">
            <div className="settings-avatar" aria-hidden="true">
              {userId.slice(0, 1).toUpperCase()}
            </div>
            <div>
              <strong>{userId}</strong>
              <p className="muted-text">@{userId}</p>
            </div>
          </div>
          <p className="muted-text">Identifiant fixe et non modifiable</p>
          {saved && <p className="ok-text">{saved}</p>}
        </section>

        <section className="inline-card">
          <p className="section-title">Affichage</p>
          <div className="settings-row">
            <div className="settings-row-left">
              <strong>Theme {theme === 'dark' ? 'sombre' : 'clair'}</strong>
              <span>Basculer entre clair et sombre</span>
            </div>
            <button
              type="button"
              className={`toggle-switch ${theme === 'light' ? 'on' : ''}`}
              onClick={onSwitchTheme}
              aria-label={`Basculer en mode ${theme === 'dark' ? 'clair' : 'sombre'}`}
            />
          </div>
        </section>

        <section className="inline-card">
          <button
            className="ghost-secondary"
            type="button"
            onClick={async () => {
              const session = getSession();
              if (session) await logoutUser(session);
              if (userId) await wipeLocalKeys(userId);
              clearSession();
              router.replace('/login');
            }}
          >
            Deconnexion
          </button>
          <button
            className="ghost-secondary"
            type="button"
            style={{ marginTop: '0.5rem' }}
            onClick={async () => {
              const session = getSession();
              if (!session) return;
              const ok = window.confirm('Deconnecter tous les appareils ? Vous devrez vous reconnecter partout.');
              if (!ok) return;
              try {
                const count = await logoutAllDevices(session);
                if (userId) await wipeLocalKeys(userId);
                clearSession();
                setSaved(`${count} session(s) revoquee(s)`);
                window.setTimeout(() => router.replace('/login'), 1500);
              } catch {
                setSaved('Erreur lors de la deconnexion');
              }
            }}
          >
            Deconnecter tous les appareils
          </button>
          <button
            className="ghost-secondary"
            type="button"
            style={{ marginTop: '0.5rem', color: 'var(--danger, #e53e3e)' }}
            onClick={async () => {
              const ok = window.confirm('Supprimer definitivement ce compte ? Cette action est irreversible et vous deconnectera de tous vos appareils.');
              if (!ok) return;
              const session = getSession();
              if (!session) return;
              try {
                await deleteAccount(session);
                if (userId) await wipeLocalKeys(userId);
                clearSession();
                router.replace('/login');
              } catch {
                setSaved('Erreur lors de la suppression du compte');
              }
            }}
          >
            Supprimer definitivement son compte
          </button>
        </section>

        <MobileTabs />
      </main>
    </SecurityShell>
  );
}
