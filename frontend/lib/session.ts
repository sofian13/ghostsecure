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
  const raw = window.sessionStorage.getItem(KEY) ?? window.localStorage.getItem(KEY);
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
    token: session.token,
    issuedAt: session.issuedAt || new Date().toISOString(),
    expiresAt: session.expiresAt || new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  };
  window.sessionStorage.setItem(KEY, JSON.stringify(safeSession));
  window.localStorage.removeItem(KEY);
}

export function clearSession(): void {
  window.sessionStorage.removeItem(KEY);
  window.localStorage.removeItem(KEY);
}
