"use client";

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import SecurityShell from '@/components/SecurityShell';
import { clearSession, getSession } from '@/lib/session';

export default function SettingsPage() {
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    const s = getSession();
    if (!s) {
      router.replace('/login');
      return;
    }
    setUserId(s.userId);
  }, [router]);

  if (!userId) return <main className="centered">Loading...</main>;

  return (
    <SecurityShell userId={userId}>
      <main className="settings-screen">
        <h1>Parametres Securite</h1>
        <ul className="security-list">
          <li>Mode texte uniquement actif (media off)</li>
          <li>Masquage auto a la perte de focus</li>
          <li>Selection / copy / paste / drag-drop bloques</li>
          <li>Verrouillage manuel de l'ecran</li>
          <li>Messages ephemeres disponibles</li>
          <li>Cle privee locale en IndexedDB</li>
          <li>Session navigateur temporaire (TTL 8h)</li>
        </ul>
        <div className="row">
          <button className="ghost-btn" type="button" onClick={() => router.push('/chat')}>Retour</button>
          <button
            className="ghost-btn danger"
            type="button"
            onClick={() => {
              clearSession();
              router.replace('/login');
            }}
          >
            Logout secure
          </button>
        </div>
      </main>
    </SecurityShell>
  );
}
