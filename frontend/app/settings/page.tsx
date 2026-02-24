"use client";

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import SecurityShell from '@/components/SecurityShell';
import MobileTabs from '@/components/MobileTabs';
import { clearSession, getSession } from '@/lib/session';

type ThemeMode = 'dark' | 'light';

export default function SettingsPage() {
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemeMode>('dark');

  useEffect(() => {
    const s = getSession();
    if (!s) {
      router.replace('/login');
      return;
    }
    setUserId(s.userId);

    const saved = window.localStorage.getItem('ghost_theme');
    const mode = saved === 'light' ? 'light' : 'dark';
    setTheme(mode);
    document.documentElement.dataset.theme = mode;
  }, [router]);

  const onSwitchTheme = () => {
    const next: ThemeMode = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.dataset.theme = next;
    window.localStorage.setItem('ghost_theme', next);
  };

  if (!userId) return <main className="centered">Loading...</main>;

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
          <p className="section-title">Affichage</p>
          <div className="row">
            <button type="button" className="ghost-primary" onClick={onSwitchTheme}>
              Basculer {theme === 'dark' ? 'clair' : 'sombre'}
            </button>
          </div>
        </section>

        <section className="inline-card">
          <p className="section-title">Securite active</p>
          <ul className="security-list">
            <li>Chiffrement de bout en bout</li>
            <li>Masquage auto si perte de focus</li>
            <li>Blocage copier/coller et drag-drop</li>
            <li>Session temporaire navigateur</li>
          </ul>
        </section>

        <section className="inline-card">
          <button
            className="ghost-secondary"
            type="button"
            onClick={() => {
              clearSession();
              router.replace('/login');
            }}
          >
            Logout secure
          </button>
        </section>

        <MobileTabs />
      </main>
    </SecurityShell>
  );
}
