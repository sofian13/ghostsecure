"use client";

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import SecurityShell from '@/components/SecurityShell';
import MobileTabs from '@/components/MobileTabs';
import { deleteAccount, logoutAllDevices, logoutUser } from '@/lib/api';
import { wipeLocalKeys } from '@/lib/crypto';
import { idbClearAll } from '@/lib/idb';
import { describeDisappearingTimer, resetGhostPreferences, updateGhostPreferences, useGhostPreferences } from '@/lib/preferences';
import { clearSession, getSession } from '@/lib/session';

type ThemeMode = 'dark' | 'light';

const DISAPPEARING_OPTIONS: Array<{ value: 0 | 1800 | 3600 | 86400 | 604800; label: string }> = [
  { value: 0, label: 'Off' },
  { value: 1800, label: '30 min' },
  { value: 3600, label: '1 h' },
  { value: 86400, label: '24 h' },
  { value: 604800, label: '7 j' },
];

export default function SettingsPage() {
  const router = useRouter();
  const preferences = useGhostPreferences();
  const [userId, setUserId] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemeMode>('dark');
  const [saved, setSaved] = useState<string | null>(null);
  const [draftVoiceMaskAmount, setDraftVoiceMaskAmount] = useState(preferences.callVoiceMaskAmount);
  const savedTimerRef = useRef<number | null>(null);

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

  const flashSaved = (message: string) => {
    if (savedTimerRef.current) window.clearTimeout(savedTimerRef.current);
    setSaved(message);
    savedTimerRef.current = window.setTimeout(() => {
      setSaved(null);
      savedTimerRef.current = null;
    }, 1800);
  };

  useEffect(() => {
    setDraftVoiceMaskAmount(preferences.callVoiceMaskAmount);
  }, [preferences.callVoiceMaskAmount]);

  useEffect(() => () => {
    if (savedTimerRef.current) window.clearTimeout(savedTimerRef.current);
  }, []);

  const wipeDeviceData = async (targetUserId?: string | null) => {
    if (targetUserId) {
      await wipeLocalKeys(targetUserId);
    }
    await idbClearAll();
    resetGhostPreferences();
    window.localStorage.removeItem('ghost_theme');
  };

  const onSwitchTheme = () => {
    const next: ThemeMode = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.dataset.theme = next;
    window.localStorage.setItem('ghost_theme', next);
    flashSaved(`Theme ${next === 'dark' ? 'sombre' : 'clair'} active`);
  };

  const updatePreference = <K extends keyof typeof preferences>(key: K, value: (typeof preferences)[K], message: string) => {
    updateGhostPreferences({ [key]: value });
    flashSaved(message);
  };

  const commitVoiceMaskAmount = () => {
    if (draftVoiceMaskAmount === preferences.callVoiceMaskAmount) return;
    updatePreference('callVoiceMaskAmount', draftVoiceMaskAmount, 'Voix masquee ajustee');
  };

  if (!userId) return <main className="centered">Chargement...</main>;

  return (
    <SecurityShell userId={userId}>
      <main className="mobile-screen settings-mobile settings-redesign">
        <header className="mobile-header">
          <div>
            <h1>Parametres</h1>
          </div>
        </header>

        <section className="inline-card settings-hero">
          <div className="profile-header">
            <div className="settings-avatar" aria-hidden="true">
              {userId.slice(0, 1).toUpperCase()}
            </div>
            <div>
              <strong>{userId}</strong>
              <p className="muted-text">@{userId}</p>
            </div>
          </div>
          {saved && <p className="ok-text">{saved}</p>}
        </section>

        <section className="inline-card">
          <div className="settings-section-head">
            <div>
              <p className="section-title">Confidentialite</p>
              <strong>Moins d infos visibles, moins d exposition</strong>
            </div>
            <span className="secure-badge">Signal-like</span>
          </div>

          <div className="pref-stack">
            <PreferenceToggle
              title="Masquer les apercus des messages"
              checked={preferences.hideMessagePreviews}
              onToggle={() => updatePreference('hideMessagePreviews', !preferences.hideMessagePreviews, 'Apercus mis a jour')}
            />
            <PreferenceToggle
              title="Masquer l identite des appels entrants"
              checked={preferences.hideCallerIdentity}
              onToggle={() => updatePreference('hideCallerIdentity', !preferences.hideCallerIdentity, 'Confidentialite des appels mise a jour')}
            />
            <PreferenceToggle
              title="Garder l ecran allume pendant l usage"
              checked={preferences.keepScreenAwake}
              onToggle={() => updatePreference('keepScreenAwake', !preferences.keepScreenAwake, 'Preference ecran mise a jour')}
            />
          </div>

        </section>

        <section className="inline-card">
          <div className="settings-section-head">
            <div>
              <p className="section-title">Messages</p>
              <strong>Expiration par defaut</strong>
            </div>
          </div>
          <div className="settings-chip-row">
            {DISAPPEARING_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`settings-chip ${preferences.disappearingTimerSeconds === option.value ? 'active' : ''}`}
                onClick={() => updatePreference('disappearingTimerSeconds', option.value, `Messages ephemeres: ${describeDisappearingTimer(option.value)}`)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </section>

        <section className="inline-card">
          <div className="settings-section-head">
            <div>
              <p className="section-title">Appels</p>
              <strong>Une seule voix masquee, reglable</strong>
            </div>
          </div>
          <label className="field">
            <span>Niveau de masquage: {draftVoiceMaskAmount}%</span>
            <input
              className="settings-range"
              type="range"
              min="35"
              max="85"
              step="1"
              value={draftVoiceMaskAmount}
              onChange={(e) => setDraftVoiceMaskAmount(Number(e.target.value))}
              onMouseUp={commitVoiceMaskAmount}
              onTouchEnd={commitVoiceMaskAmount}
              onKeyUp={commitVoiceMaskAmount}
              onBlur={commitVoiceMaskAmount}
            />
          </label>
          <div className="settings-range-legend">
            <span>Plus naturel</span>
            <span>Plus anonyme</span>
          </div>
        </section>

        <section className="inline-card">
          <p className="section-title">Affichage</p>
          <div className="settings-row">
            <div className="settings-row-left">
              <strong>Theme {theme === 'dark' ? 'sombre' : 'clair'}</strong>
            </div>
            <button
              type="button"
              className={`toggle-switch ${theme === 'light' ? 'on' : ''}`}
              onClick={onSwitchTheme}
              aria-label={`Basculer en mode ${theme === 'dark' ? 'clair' : 'sombre'}`}
            />
          </div>
        </section>

        <section className="inline-card danger-zone">
          <p className="section-title">Compte</p>
          <button
            className="ghost-secondary"
            type="button"
            onClick={async () => {
              const session = getSession();
              if (session) await logoutUser(session);
              await wipeDeviceData(userId);
              clearSession();
              router.replace('/login');
            }}
          >
            Deconnexion de cet appareil
          </button>
          <button
            className="ghost-secondary"
            type="button"
            style={{ marginTop: '0.5rem' }}
            onClick={async () => {
              const session = getSession();
              if (!session) return;
              const ok = window.confirm('Deconnecter tous les appareils ? Toutes les sessions actives seront revoquees.');
              if (!ok) return;
              try {
                const count = await logoutAllDevices(session);
                await wipeDeviceData(userId);
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
              const ok = window.confirm('Supprimer definitivement le compte, les conversations, les messages, les demandes, les appels et les donnees de cet appareil ? Cette action est irreversible.');
              if (!ok) return;
              const session = getSession();
              if (!session) return;
              try {
                await deleteAccount(session);
                await wipeDeviceData(userId);
                clearSession();
                router.replace('/login');
              } catch {
                setSaved('Erreur lors de la suppression du compte');
              }
            }}
          >
            Supprimer tout definitivement
          </button>
        </section>

        <MobileTabs />
      </main>
    </SecurityShell>
  );
}

function PreferenceToggle({
  title,
  checked,
  onToggle,
}: {
  title: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-left">
        <strong>{title}</strong>
      </div>
      <button
        type="button"
        className={`toggle-switch ${checked ? 'on' : ''}`}
        onClick={onToggle}
        aria-label={title}
      />
    </div>
  );
}
