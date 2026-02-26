import { getSupabaseClient } from '@/lib/supabase';
import type { Conversation, ConversationDetail, EncryptedMessage, Session } from '@/types';

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

function normalizeUserId(value: string): string {
  return value.trim().toLowerCase();
}

function toSession(userId: string, token: string): Session {
  const now = new Date();
  return {
    userId,
    token,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString(),
  };
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
  if (!API_BASE_URL) {
    throw new Error('Missing env NEXT_PUBLIC_API_BASE_URL');
  }

  const headers = new Headers(init.headers ?? {});
  headers.set('Accept', 'application/json');
  if (init.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (session?.token) {
    headers.set('Authorization', `Bearer ${session.token}`);
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers,
  });

  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as T | ApiError) : ({} as T);

  if (!response.ok) {
    const message = (parsed as ApiError)?.error ?? `Request failed (${response.status})`;
    throw new Error(message);
  }

  return parsed as T;
}

export async function registerUser(publicKey: string, userId: string, password: string): Promise<Session> {
  const normalized = normalizeUserId(userId);
  const data = await apiRequest<{ userId: string; token: string }>(
    '/api/auth/register',
    {
      method: 'POST',
      body: JSON.stringify({ userId: normalized, publicKey, secret: password }),
    }
  );
  return toSession(data.userId, data.token);
}

export async function loginUser(userId: string, password: string, publicKey?: string): Promise<Session> {
  const normalized = normalizeUserId(userId);
  const resolvedPublicKey = publicKey ?? '';
  const data = await apiRequest<{ userId: string; token: string }>(
    '/api/auth/login',
    {
      method: 'POST',
      body: JSON.stringify({ userId: normalized, publicKey: resolvedPublicKey, secret: password }),
    }
  );
  return toSession(data.userId, data.token);
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

export async function fetchConversationDetail(session: Session, conversationId: string): Promise<ConversationDetail> {
  return apiRequest<ConversationDetail>(`/api/conversations/${encodeURIComponent(conversationId)}`, { method: 'GET' }, session);
}

export async function fetchMessages(session: Session, conversationId: string): Promise<EncryptedMessage[]> {
  const rows = await apiRequest<EncryptedMessage[]>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
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

// Keeping friend/call flows on Supabase for now to avoid breaking existing realtime features.
export async function sendFriendRequest(session: Session, targetUserId: string): Promise<void> {
  const supabase = getSupabaseClient();
  const me = normalizeUserId(session.userId);
  const target = normalizeUserId(targetUserId);
  if (!target || target === me) throw new Error('Utilisateur invalide');

  const { data: targetUser, error: targetError } = await supabase
    .from('app_user')
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
    .from('app_user')
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
