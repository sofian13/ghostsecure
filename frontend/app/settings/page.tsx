"use client";

import { useEffect, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import SecurityShell from '@/components/SecurityShell';
import MobileTabs from '@/components/MobileTabs';
import { deleteAccount, logoutAllDevices, logoutUser } from '@/lib/api';
import { wipeLocalKeys } from '@/lib/crypto';
import { describeDisappearingTimer, getGhostPreferences, subscribeGhostPreferences, updateGhostPreferences } from '@/lib/preferences';
import { clearSession, getSession } from '@/lib/session';

type ThemeMode = 'dark' | 'light';

const AUTO_LOCK_OPTIONS: Array<{ value: 0 | 15 | 60; label: string }> = [
  { value: 0, label: 'Instant' },
  { value: 15, label: '15 s' },
  { value: 60, label: '60 s' },
];

const DISAPPEARING_OPTIONS: Array<{ value: 0 | 1800 | 3600 | 86400 | 604800; label: string }> = [
  { value: 0, label: 'Off' },
  { value: 1800, label: '30 min' },
  { value: 3600, label: '1 h' },
  { value: 86400, label: '24 h' },
  { value: 604800, label: '7 j' },
];

export default function SettingsPage() {
  const router = useRouter();
  const preferences = useSyncExternalStore(subscribeGhostPreferences, getGhostPreferences, getGhostPreferences);
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

  const flashSaved = (message: string) => {
    setSaved(message);
    window.setTimeout(() => setSaved(null), 1800);
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

  if (!userId) return <main className="centered">Chargement...</main>;

  return (
    <SecurityShell userId={userId}>
      <main className="mobile-screen settings-mobile settings-redesign">
        <header className="mobile-header">
          <div>
            <h1>Parametres</h1>
            <p className="muted-text">Confidentialite, appels et controle local</p>
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
          <div className="secure-chip-row">
            <span className="secure-chip">E2E</span>
            <span className="secure-chip">Sealed sender</span>
            <span className="secure-chip">{describeDisappearingTimer(preferences.disappearingTimerSeconds)}</span>
            <span className="secure-chip">Voix masquee</span>
          </div>
          <p className="muted-text">Identifiant fixe. Les reglages ci-dessous restent locaux a cet appareil.</p>
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
              description="Le contenu des chats n apparait plus dans la liste principale."
              checked={preferences.hideMessagePreviews}
              onToggle={() => updatePreference('hideMessagePreviews', !preferences.hideMessagePreviews, 'Apercus mis a jour')}
            />
            <PreferenceToggle
              title="Masquer l identite des appels entrants"
              description="Les notifications et popups d appel restent generiques."
              checked={preferences.hideCallerIdentity}
              onToggle={() => updatePreference('hideCallerIdentity', !preferences.hideCallerIdentity, 'Confidentialite des appels mise a jour')}
            />
            <PreferenceToggle
              title="Garder l ecran allume pendant l usage"
              description="Pratique pour les appels et longues conversations. Desactivez pour plus de discretion physique."
              checked={preferences.keepScreenAwake}
              onToggle={() => updatePreference('keepScreenAwake', !preferences.keepScreenAwake, 'Preference ecran mise a jour')}
            />
          </div>

          <div className="pref-group">
            <div className="pref-group-label">
              <strong>Verrouillage auto apres sortie</strong>
              <span>Cache l interface au retour au multitache.</span>
            </div>
            <div className="settings-chip-row">
              {AUTO_LOCK_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`settings-chip ${preferences.autoLockDelaySeconds === option.value ? 'active' : ''}`}
                  onClick={() => updatePreference('autoLockDelaySeconds', option.value, 'Delai de verrouillage mis a jour')}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="inline-card">
          <div className="settings-section-head">
            <div>
              <p className="section-title">Messages</p>
              <strong>Expiration par defaut</strong>
            </div>
          </div>
          <p className="muted-text">Chaque nouveau message, vocal ou piece jointe peut disparaitre automatiquement.</p>
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
          <p className="muted-text">Votre voix reste claire, mais plus difficile a reconnaitre.</p>
          <label className="field">
            <span>Niveau de masquage: {preferences.callVoiceMaskAmount}%</span>
            <input
              className="settings-range"
              type="range"
              min="35"
              max="85"
              step="1"
              value={preferences.callVoiceMaskAmount}
              onChange={(e) => updatePreference('callVoiceMaskAmount', Number(e.target.value), 'Voix masquee ajustee')}
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

        <section className="inline-card danger-zone">
          <p className="section-title">Compte</p>
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

function PreferenceToggle({
  title,
  description,
  checked,
  onToggle,
}: {
  title: string;
  description: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-left">
        <strong>{title}</strong>
        <span>{description}</span>
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
