"use client";

export type GhostPreferences = {
  hideMessagePreviews: boolean;
  hideCallerIdentity: boolean;
  keepScreenAwake: boolean;
  autoLockDelaySeconds: 0 | 15 | 60;
  disappearingTimerSeconds: 0 | 1800 | 3600 | 86400 | 604800;
  callVoiceMaskAmount: number;
};

const KEY = 'ghost_preferences_v1';

const DEFAULTS: GhostPreferences = {
  hideMessagePreviews: false,
  hideCallerIdentity: false,
  keepScreenAwake: true,
  autoLockDelaySeconds: 0,
  disappearingTimerSeconds: 3600,
  callVoiceMaskAmount: 58,
};

function clampMaskAmount(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULTS.callVoiceMaskAmount;
  return Math.min(85, Math.max(35, Math.round(numeric)));
}

function normalizePreferences(value: unknown): GhostPreferences {
  const raw = (value && typeof value === 'object') ? (value as Partial<GhostPreferences>) : {};
  const autoLockDelay = raw.autoLockDelaySeconds;
  const disappearing = raw.disappearingTimerSeconds;

  return {
    hideMessagePreviews: Boolean(raw.hideMessagePreviews),
    hideCallerIdentity: Boolean(raw.hideCallerIdentity),
    keepScreenAwake: raw.keepScreenAwake !== false,
    autoLockDelaySeconds: autoLockDelay === 15 || autoLockDelay === 60 ? autoLockDelay : 0,
    disappearingTimerSeconds:
      disappearing === 0 || disappearing === 1800 || disappearing === 3600 || disappearing === 86400 || disappearing === 604800
        ? disappearing
        : DEFAULTS.disappearingTimerSeconds,
    callVoiceMaskAmount: clampMaskAmount(raw.callVoiceMaskAmount),
  };
}

export function getGhostPreferences(): GhostPreferences {
  if (typeof window === 'undefined') return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    return normalizePreferences(JSON.parse(raw));
  } catch {
    return DEFAULTS;
  }
}

export function updateGhostPreferences(patch: Partial<GhostPreferences>): GhostPreferences {
  const next = normalizePreferences({ ...getGhostPreferences(), ...patch });
  window.localStorage.setItem(KEY, JSON.stringify(next));
  window.dispatchEvent(new CustomEvent('ghost-preferences-change'));
  return next;
}

export function subscribeGhostPreferences(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY) listener();
  };
  const onCustom = () => listener();
  window.addEventListener('storage', onStorage);
  window.addEventListener('ghost-preferences-change', onCustom);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener('ghost-preferences-change', onCustom);
  };
}

export function describeDisappearingTimer(value: GhostPreferences['disappearingTimerSeconds']): string {
  if (value === 0) return 'Desactives';
  if (value === 1800) return '30 min';
  if (value === 3600) return '1 heure';
  if (value === 86400) return '24 heures';
  return '7 jours';
}

