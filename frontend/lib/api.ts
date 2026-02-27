import { getSupabaseClient } from '@/lib/supabase';
import type { Conversation, ConversationDetail, EncryptedMessage, PreKeyBundle, Session } from '@/types';

type FriendRequest = {
  id: string;
  requesterId: string;
  targetUserId: string;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: string;
};

type FriendRequestRow = {
  id: string;
  requester_id: string;
  target_user_id: string;
  status: 'pending' | 'accepted' | 'rejected';
  created_at: string;
};

type ApiError = { error?: string };

const API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL ?? '').replace(/\/+$/, '');

function resolveApiBaseUrl(): string {
  if (API_BASE_URL) {
    if (typeof window !== 'undefined') {
      try {
        const url = new URL(API_BASE_URL);
        const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
        const browserHost = window.location.hostname;
        const browserIsLocal = browserHost === 'localhost' || browserHost === '127.0.0.1';
        if (isLocal && !browserIsLocal) {
          url.hostname = browserHost;
          return url.toString().replace(/\/+$/, '');
        }
      } catch {
        return API_BASE_URL;
      }
    }
    return API_BASE_URL;
  }

  if (typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:8000`;
  }

  throw new Error('Missing env NEXT_PUBLIC_API_BASE_URL');
}

function normalizeUserId(value: string): string {
  return value.trim().toLowerCase();
}

function toSession(userId: string, expiresAt?: string, token?: string): Session {
  const now = new Date();
  const session: Session = {
    userId,
    issuedAt: now.toISOString(),
    expiresAt: expiresAt ?? new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString(),
  };
  if (token) session.token = token;
  return session;
}

function toFriendRequest(row: FriendRequestRow): FriendRequest {
  return {
    id: row.id,
    requesterId: row.requester_id,
    targetUserId: row.target_user_id,
    status: row.status,
    createdAt: row.created_at,
  };
}

async function apiRequest<T>(path: string, init: RequestInit = {}, session?: Session): Promise<T> {
  const baseUrl = resolveApiBaseUrl();
  const requestUrl = `${baseUrl}${path}`;

  const headers = new Headers(init.headers ?? {});
  headers.set('Accept', 'application/json');
  if (init.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (session?.token) {
    headers.set('Authorization', `Bearer ${session.token}`);
  }

  let response: Response;
  try {
    response = await fetch(requestUrl, {
      ...init,
      headers,
      credentials: 'include',
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown network error';
    throw new Error(
      `Network error calling ${requestUrl}: ${reason}. Verify API URL, backend availability, APP_ALLOWED_ORIGINS and CSP connect-src.`
    );
  }

  const text = await response.text();
  let parsed: T | ApiError = {} as T;
  if (text) {
    try {
      parsed = JSON.parse(text) as T | ApiError;
    } catch {
      const sample = text.slice(0, 180);
      throw new Error(
        `Invalid JSON response from ${requestUrl} (${response.status} ${response.statusText}). Body starts with: ${sample}`
      );
    }
  }

  if (!response.ok) {
    const message = (parsed as ApiError)?.error ?? `Request failed (${response.status})`;
    throw new Error(`${message} [${response.status} ${response.statusText}] (${requestUrl})`);
  }

  return parsed as T;
}

export async function registerUser(
  publicKey: string,
  userId: string,
  password: string,
  proof?: string,
  ecdhPublicKey?: string,
  preKeyBundle?: {
    identityKey: string;
    signedPrekey: string;
    signedPrekeySignature: string;
    registrationId: number;
    oneTimePreKeys: { keyId: number; publicKey: string }[];
  }
): Promise<Session> {
  const normalized = normalizeUserId(userId);
  const body: Record<string, unknown> = { userId: normalized, publicKey, secret: password };
  if (proof) body.proof = proof;
  if (ecdhPublicKey) body.ecdhPublicKey = ecdhPublicKey;
  if (preKeyBundle) body.preKeyBundle = preKeyBundle;
  const data = await apiRequest<{ userId: string; token?: string; expiresAt?: string }>(
    '/api/auth/register',
    {
      method: 'POST',
      body: JSON.stringify(body),
    }
  );
  return toSession(data.userId, data.expiresAt, data.token);
}

export async function loginUser(userId: string, password: string, publicKey?: string, ecdhPublicKey?: string): Promise<Session> {
  const normalized = normalizeUserId(userId);
  const body: Record<string, string> = { userId: normalized, secret: password };
  if (publicKey) body.publicKey = publicKey;
  if (ecdhPublicKey) body.ecdhPublicKey = ecdhPublicKey;
  const data = await apiRequest<{ userId: string; token?: string; expiresAt?: string }>(
    '/api/auth/login',
    {
      method: 'POST',
      body: JSON.stringify(body),
    }
  );
  return toSession(data.userId, data.expiresAt, data.token);
}

export async function logoutUser(session: Session): Promise<void> {
  try {
    await apiRequest<{ ok: boolean }>(
      '/api/auth/logout',
      { method: 'POST' },
      session
    );
  } catch {
    // Best-effort: session will expire server-side regardless
  }
}

export async function logoutAllDevices(session: Session): Promise<number> {
  const data = await apiRequest<{ ok: boolean; sessionsRevoked: number }>(
    '/api/auth/logout-all',
    { method: 'POST' },
    session
  );
  return data.sessionsRevoked;
}

export async function fetchConversations(session: Session): Promise<Conversation[]> {
  return apiRequest<Conversation[]>('/api/conversations', { method: 'GET' }, session);
}

export async function createConversation(session: Session, peerUserId: string): Promise<Conversation> {
  return apiRequest<Conversation>(
    '/api/conversations',
    {
      method: 'POST',
      body: JSON.stringify({ peerUserId: normalizeUserId(peerUserId) }),
    },
    session
  );
}

export async function createGroupConversation(
  session: Session,
  title: string,
  memberUserIds: string[]
): Promise<Conversation> {
  const members = memberUserIds.map(normalizeUserId).filter((id) => id !== '');
  return apiRequest<Conversation>(
    '/api/conversations',
    {
      method: 'POST',
      body: JSON.stringify({ kind: 'group', title: title.trim(), memberUserIds: members }),
    },
    session
  );
}

export async function fetchConversationDetail(session: Session, conversationId: string): Promise<ConversationDetail> {
  return apiRequest<ConversationDetail>(`/api/conversations/${encodeURIComponent(conversationId)}`, { method: 'GET' }, session);
}

export async function fetchMessages(session: Session, conversationId: string, limit?: number): Promise<EncryptedMessage[]> {
  const query = limit ? `?limit=${limit}` : '';
  const rows = await apiRequest<EncryptedMessage[]>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages${query}`,
    { method: 'GET' },
    session
  );

  const now = Date.now();
  return rows.filter((m) => !m.expiresAt || Date.parse(m.expiresAt) > now);
}

export async function sendMessage(
  session: Session,
  conversationId: string,
  payload: {
    ciphertext: string;
    iv: string;
    wrappedKeys: Record<string, string>;
    expiresInSeconds?: number;
    ephemeralPublicKey?: string;
    ratchetHeader?: string;
  }
): Promise<EncryptedMessage> {
  return apiRequest<EncryptedMessage>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    session
  );
}

export async function addGroupMember(session: Session, conversationId: string, userId: string): Promise<void> {
  await apiRequest<{ ok: boolean }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/members`,
    {
      method: 'POST',
      body: JSON.stringify({ userId: normalizeUserId(userId) }),
    },
    session
  );
}

export async function leaveGroupConversation(session: Session, conversationId: string): Promise<void> {
  await apiRequest<{ ok: boolean }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/members/me`,
    { method: 'DELETE' },
    session
  );
}

export async function uploadPreKeyBundle(
  session: Session,
  bundle: {
    identityKey: string;
    signedPrekey: string;
    signedPrekeySignature: string;
    registrationId: number;
    oneTimePreKeys: { keyId: number; publicKey: string }[];
  }
): Promise<void> {
  await apiRequest<{ ok: boolean }>(
    '/api/keys/bundle',
    { method: 'POST', body: JSON.stringify(bundle) },
    session
  );
}

export async function fetchPreKeyBundle(session: Session, userId: string): Promise<PreKeyBundle> {
  return apiRequest<PreKeyBundle>(
    `/api/users/${encodeURIComponent(userId)}/keys/bundle`,
    { method: 'GET' },
    session
  );
}

export async function fetchOtkCount(session: Session): Promise<number> {
  const data = await apiRequest<{ count: number }>(
    '/api/keys/count',
    { method: 'GET' },
    session
  );
  return data.count;
}

// Keeping friend/call flows on Supabase for now to avoid breaking existing realtime features.
export async function sendFriendRequest(session: Session, targetUserId: string): Promise<void> {
  const supabase = getSupabaseClient();
  const me = normalizeUserId(session.userId);
  const target = normalizeUserId(targetUserId);
  if (!target || target === me) throw new Error('Utilisateur invalide');

  const { data: targetUser, error: targetError } = await supabase
    .from('app_user_public')
    .select('id')
    .eq('id', target)
    .maybeSingle();
  if (targetError) throw new Error(`Friend request failed: ${targetError.message}`);
  if (!targetUser) throw new Error('Utilisateur introuvable');

  const { data: reversePending, error: reverseError } = await supabase
    .from('friend_request')
    .select('id')
    .eq('requester_id', target)
    .eq('target_user_id', me)
    .eq('status', 'pending')
    .maybeSingle();
  if (reverseError) throw new Error(`Friend request failed: ${reverseError.message}`);

  if (reversePending) {
    await acceptFriendRequest(session, reversePending.id);
    return;
  }

  const request: FriendRequestRow = {
    id: crypto.randomUUID(),
    requester_id: me,
    target_user_id: target,
    status: 'pending',
    created_at: new Date().toISOString(),
  };

  const { error: requestError } = await supabase.from('friend_request').insert(request);
  if (requestError && !requestError.message.toLowerCase().includes('duplicate')) {
    throw new Error(`Friend request failed: ${requestError.message}`);
  }
}

export async function fetchIncomingFriendRequests(session: Session): Promise<FriendRequest[]> {
  const supabase = getSupabaseClient();
  const me = normalizeUserId(session.userId);
  const { data, error } = await supabase
    .from('friend_request')
    .select('id,requester_id,target_user_id,status,created_at')
    .eq('target_user_id', me)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  if (error) throw new Error(`Friend requests failed: ${error.message}`);
  return ((data ?? []) as FriendRequestRow[]).map(toFriendRequest);
}

export async function acceptFriendRequest(session: Session, requestId: string): Promise<Conversation> {
  const supabase = getSupabaseClient();
  const me = normalizeUserId(session.userId);

  const { data: requestRow, error: requestError } = await supabase
    .from('friend_request')
    .select('id,requester_id,target_user_id,status,created_at')
    .eq('id', requestId)
    .maybeSingle();
  if (requestError) throw new Error(`Accept request failed: ${requestError.message}`);
  if (!requestRow) throw new Error('Demande introuvable');
  const request = requestRow as FriendRequestRow;
  if (request.target_user_id !== me) throw new Error('Forbidden');
  if (request.status !== 'pending') throw new Error('Demande deja traitee');

  const { data: peer, error: peerError } = await supabase
    .from('app_user_public')
    .select('id,public_key')
    .eq('id', request.requester_id)
    .maybeSingle();
  if (peerError) throw new Error(`Accept request failed: ${peerError.message}`);
  if (!peer) throw new Error('Utilisateur introuvable');

  const { error: updateError } = await supabase.from('friend_request').update({ status: 'accepted' }).eq('id', request.id);
  if (updateError) throw new Error(`Accept request failed: ${updateError.message}`);

  return createConversation(session, request.requester_id);
}

export type { FriendRequest };
