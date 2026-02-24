import { getSupabaseClient } from '@/lib/supabase';
import type { Conversation, ConversationDetail, EncryptedMessage, Session, UserProfile } from '@/types';

type UserRow = { id: string; public_key: string };
type ConversationMemberRow = { conversation_id: string; user_id: string };
type MessageRow = {
  id: string;
  conversation_id: string;
  sender_id: string;
  ciphertext: string;
  iv: string;
  wrapped_keys: Record<string, string>;
  created_at: string;
  expires_at: string | null;
};

export type FriendRequest = {
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

function normalizeUserId(value: string): string {
  return value.trim().toLowerCase();
}

function toMessage(row: MessageRow): EncryptedMessage {
  return {
    id: row.id,
    senderId: row.sender_id,
    ciphertext: row.ciphertext,
    iv: row.iv,
    wrappedKeys: row.wrapped_keys ?? {},
    createdAt: row.created_at,
    expiresAt: row.expires_at,
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

function toSession(userId: string): Session {
  const now = new Date().toISOString();
  return {
    userId,
    token: userId,
    issuedAt: now,
    expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
  };
}

async function requireMembership(userId: string, conversationId: string): Promise<void> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('conversation_member')
    .select('conversation_id')
    .eq('conversation_id', conversationId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw new Error(`Access check failed: ${error.message}`);
  if (!data) throw new Error('Forbidden');
}

async function findOrCreateConversation(me: string, peerUserId: string, peerPublicKey: string): Promise<Conversation> {
  const supabase = getSupabaseClient();
  const { data: existingRows, error: existingError } = await supabase
    .from('conversation_member')
    .select('conversation_id,user_id')
    .in('user_id', [me, peerUserId]);
  if (existingError) throw new Error(`Create conversation failed: ${existingError.message}`);

  const participantsByConversation = new Map<string, Set<string>>();
  for (const row of (existingRows ?? []) as ConversationMemberRow[]) {
    if (!participantsByConversation.has(row.conversation_id)) {
      participantsByConversation.set(row.conversation_id, new Set());
    }
    participantsByConversation.get(row.conversation_id)?.add(row.user_id);
  }

  for (const [conversationId, participants] of participantsByConversation.entries()) {
    if (participants.has(me) && participants.has(peerUserId)) {
      return {
        id: conversationId,
        peerId: peerUserId,
        peerPublicKey,
        updatedAt: new Date().toISOString(),
      };
    }
  }

  const conversationId = crypto.randomUUID();
  const now = new Date().toISOString();

  const { error: convError } = await supabase.from('conversation').insert({ id: conversationId, created_at: now });
  if (convError) throw new Error(`Create conversation failed: ${convError.message}`);

  const { error: membersError } = await supabase.from('conversation_member').insert([
    { conversation_id: conversationId, user_id: me },
    { conversation_id: conversationId, user_id: peerUserId },
  ]);
  if (membersError) throw new Error(`Create conversation failed: ${membersError.message}`);

  return {
    id: conversationId,
    peerId: peerUserId,
    peerPublicKey,
    updatedAt: now,
  };
}

export async function registerUser(publicKey: string, userId: string): Promise<Session> {
  const supabase = getSupabaseClient();
  const now = new Date().toISOString();
  const normalized = normalizeUserId(userId);

  const { error } = await supabase.from('app_user').upsert(
    {
      id: normalized,
      public_key: publicKey,
      created_at: now,
    },
    { onConflict: 'id' }
  );
  if (error) throw new Error(`Register failed: ${error.message}`);

  return toSession(normalized);
}

export async function loginUser(userId: string, publicKey?: string): Promise<Session> {
  const supabase = getSupabaseClient();
  const normalized = normalizeUserId(userId);
  const { data, error } = await supabase.from('app_user').select('id').eq('id', normalized).maybeSingle();
  if (error) throw new Error(`Login failed: ${error.message}`);
  if (!data) throw new Error('Invalid credentials');
  if (publicKey) {
    const { error: updateError } = await supabase.from('app_user').update({ public_key: publicKey }).eq('id', normalized);
    if (updateError) throw new Error(`Login failed: ${updateError.message}`);
  }
  return toSession(normalized);
}

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

  return findOrCreateConversation(me, request.requester_id, (peer as UserRow).public_key);
}

export async function fetchConversations(session: Session): Promise<Conversation[]> {
  const supabase = getSupabaseClient();
  const me = session.userId;

  const { data: mine, error: mineError } = await supabase
    .from('conversation_member')
    .select('conversation_id,user_id')
    .eq('user_id', me);
  if (mineError) throw new Error(`Conversations failed: ${mineError.message}`);
  if (!mine || mine.length === 0) return [];

  const conversationIds = [...new Set(mine.map((r) => r.conversation_id))];
  const { data: allMembers, error: membersError } = await supabase
    .from('conversation_member')
    .select('conversation_id,user_id')
    .in('conversation_id', conversationIds);
  if (membersError) throw new Error(`Conversations failed: ${membersError.message}`);

  const peerByConversation = new Map<string, string>();
  for (const row of (allMembers ?? []) as ConversationMemberRow[]) {
    if (row.user_id !== me && !peerByConversation.has(row.conversation_id)) {
      peerByConversation.set(row.conversation_id, row.user_id);
    }
  }

  const peerIds = [...new Set([...peerByConversation.values()])];
  const peerMap = new Map<string, UserRow>();
  if (peerIds.length > 0) {
    const { data: peers, error: peersError } = await supabase
      .from('app_user')
      .select('id,public_key')
      .in('id', peerIds);
    if (peersError) throw new Error(`Conversations failed: ${peersError.message}`);
    for (const peer of (peers ?? []) as UserRow[]) peerMap.set(peer.id, peer);
  }

  const { data: messageRows, error: msgError } = await supabase
    .from('message')
    .select('conversation_id,created_at')
    .in('conversation_id', conversationIds)
    .order('created_at', { ascending: false });
  if (msgError) throw new Error(`Conversations failed: ${msgError.message}`);

  const updatedByConversation = new Map<string, string>();
  for (const row of messageRows ?? []) {
    if (!updatedByConversation.has(row.conversation_id)) {
      updatedByConversation.set(row.conversation_id, row.created_at);
    }
  }

  const rows: Conversation[] = [];
  for (const conversationId of conversationIds) {
    const peerId = peerByConversation.get(conversationId);
    if (!peerId) continue;
    const peer = peerMap.get(peerId);
    if (!peer) continue;
    rows.push({
      id: conversationId,
      peerId,
      peerPublicKey: peer.public_key,
      updatedAt: updatedByConversation.get(conversationId) ?? new Date().toISOString(),
    });
  }

  rows.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return rows;
}

export async function createConversation(session: Session, peerUserId: string): Promise<Conversation> {
  const supabase = getSupabaseClient();
  const me = session.userId;
  if (me === peerUserId) throw new Error('Peer not found');

  const { data: peer, error: peerError } = await supabase
    .from('app_user')
    .select('id,public_key')
    .eq('id', normalizeUserId(peerUserId))
    .maybeSingle();
  if (peerError) throw new Error(`Create conversation failed: ${peerError.message}`);
  if (!peer) throw new Error('Peer not found');

  return findOrCreateConversation(me, (peer as UserRow).id, (peer as UserRow).public_key);
}

export async function fetchConversationDetail(session: Session, conversationId: string): Promise<ConversationDetail> {
  const supabase = getSupabaseClient();
  await requireMembership(session.userId, conversationId);

  const { data: members, error: membersError } = await supabase
    .from('conversation_member')
    .select('user_id')
    .eq('conversation_id', conversationId);
  if (membersError) throw new Error(`Conversation detail failed: ${membersError.message}`);

  const userIds = [...new Set((members ?? []).map((row) => row.user_id))];
  if (userIds.length === 0) return { id: conversationId, participants: [] };

  const { data: users, error: usersError } = await supabase
    .from('app_user')
    .select('id,public_key')
    .in('id', userIds);
  if (usersError) throw new Error(`Conversation detail failed: ${usersError.message}`);

  const participants: UserProfile[] = ((users ?? []) as UserRow[]).map((u) => ({
    id: u.id,
    publicKey: u.public_key,
  }));

  return { id: conversationId, participants };
}

export async function fetchMessages(session: Session, conversationId: string): Promise<EncryptedMessage[]> {
  const supabase = getSupabaseClient();
  await requireMembership(session.userId, conversationId);

  const { data, error } = await supabase
    .from('message')
    .select('id,conversation_id,sender_id,ciphertext,iv,wrapped_keys,created_at,expires_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`Messages failed: ${error.message}`);

  const now = Date.now();
  return ((data ?? []) as MessageRow[])
    .map(toMessage)
    .filter((m) => !m.expiresAt || Date.parse(m.expiresAt) > now);
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
  const supabase = getSupabaseClient();
  await requireMembership(session.userId, conversationId);

  const ttl = Math.max(0, Math.min(payload.expiresInSeconds ?? 0, 86400));
  const now = new Date();
  const expiresAt = ttl > 0 ? new Date(now.getTime() + ttl * 1000).toISOString() : null;
  const row: MessageRow = {
    id: crypto.randomUUID(),
    conversation_id: conversationId,
    sender_id: session.userId,
    ciphertext: payload.ciphertext,
    iv: payload.iv,
    wrapped_keys: payload.wrappedKeys,
    created_at: now.toISOString(),
    expires_at: expiresAt,
  };

  const { data, error } = await supabase
    .from('message')
    .insert(row)
    .select('id,conversation_id,sender_id,ciphertext,iv,wrapped_keys,created_at,expires_at')
    .single();
  if (error) throw new Error(`Send failed: ${error.message}`);

  return toMessage(data as MessageRow);
}
