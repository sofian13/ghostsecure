import type { Session } from '@/types';

const KEY = 'ghost-session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

type LegacySession = {
  userId: string;
  token: string;
};

function safeParse(raw: string): Session | LegacySession | null {
  try {
    return JSON.parse(raw) as Session | LegacySession;
  } catch {
    return null;
  }
}

export function getSession(): Session | null {
  if (typeof window === 'undefined') return null;

  const sessionRaw = window.sessionStorage.getItem(KEY);
  const localRaw = window.localStorage.getItem(KEY);

  // Migrate from localStorage to sessionStorage if found there
  if (localRaw && !sessionRaw) {
    const localParsed = safeParse(localRaw);
    window.localStorage.removeItem(KEY);

    if (localParsed) {
      // Force re-auth if legacy token is older than 1 hour
      const age = 'issuedAt' in localParsed
        ? Date.now() - Date.parse(localParsed.issuedAt)
        : Infinity;
      if (age > 60 * 60 * 1000) {
        return null;
      }
      const migrated: Session = {
        userId: localParsed.userId,
        token: localParsed.token,
        issuedAt: 'issuedAt' in localParsed ? localParsed.issuedAt : new Date().toISOString(),
        expiresAt: 'expiresAt' in localParsed ? localParsed.expiresAt : new Date(Date.now() + SESSION_TTL_MS).toISOString(),
      };
      setSession(migrated);
      return migrated;
    }
    return null;
  }

  // Always remove stale localStorage entry
  if (localRaw) {
    window.localStorage.removeItem(KEY);
  }

  const raw = sessionRaw;
  if (!raw) return null;
  const parsed = safeParse(raw);
  if (!parsed) return null;

  if ('issuedAt' in parsed && 'expiresAt' in parsed) {
    if (Date.now() > Date.parse(parsed.expiresAt)) {
      clearSession();
      return null;
    }
    return parsed;
  }

  if (!parsed.userId || !parsed.token) {
    clearSession();
    return null;
  }

  const upgraded: Session = {
    userId: parsed.userId,
    token: parsed.token,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  };

  setSession(upgraded);
  return upgraded;
}

export function setSession(session: Session): void {
  const safeSession: Session = {
    userId: session.userId,
    issuedAt: session.issuedAt || new Date().toISOString(),
    expiresAt: session.expiresAt || new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  };
  if (session.token) {
    safeSession.token = session.token;
  }
  window.sessionStorage.setItem(KEY, JSON.stringify(safeSession));
  window.localStorage.removeItem(KEY);
}

export function clearSession(): void {
  window.sessionStorage.removeItem(KEY);
  window.localStorage.removeItem(KEY);
}
