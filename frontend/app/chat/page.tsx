"use client";

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import SecurityShell from '@/components/SecurityShell';
import MobileTabs from '@/components/MobileTabs';
import { getSession } from '@/lib/session';
import {
  acceptFriendRequest,
  createGroupConversation,
  fetchConversations,
  fetchIncomingFriendRequests,
  fetchMessages,
  sendFriendRequest,
  type FriendRequest,
} from '@/lib/api';
import { decryptForUser, previewLabel } from '@/lib/messages';
import { useRealtime } from '@/lib/useRealtime';
import { getSupabaseClient } from '@/lib/supabase';
import type { Conversation, Session } from '@/types';

type ConversationPreview = {
  text: string;
  at: string;
};

export default function ChatListPage() {
  const router = useRouter();
  const [session, setSessionState] = useState<Session | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [friendRequests, setFriendRequests] = useState<FriendRequest[]>([]);
  const [previews, setPreviews] = useState<Record<string, ConversationPreview>>({});
  const [search, setSearch] = useState('');
  const [peerUserId, setPeerUserId] = useState('');
  const [sheetMode, setSheetMode] = useState<'direct' | 'group'>('direct');
  const [groupTitle, setGroupTitle] = useState('');
  const [groupMembers, setGroupMembers] = useState('');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [friendStatus, setFriendStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const s = getSession();
    if (!s) {
      router.replace('/login');
      return;
    }
    setSessionState(s);
  }, [router]);

  const loadConversationsAndPreview = async (s: Session) => {
    const rows = await fetchConversations(s);
    setConversations(rows);

    const resolved = await Promise.all(
      rows.map(async (conv) => {
        try {
          const encrypted = await fetchMessages(s, conv.id);
          const last = encrypted[encrypted.length - 1];
          if (!last) {
            return [conv.id, { text: 'Nouveau chat securise', at: conv.updatedAt }] as const;
          }
          const dec = await decryptForUser(s.userId, last);
          return [conv.id, { text: previewLabel(dec), at: last.createdAt }] as const;
        } catch {
          return [conv.id, { text: 'Message chiffre', at: conv.updatedAt }] as const;
        }
      })
    );

    const next: Record<string, ConversationPreview> = {};
    for (const [id, value] of resolved) next[id] = value;
    setPreviews(next);
  };

  const loadFriendRequests = async (s: Session) => {
    const requests = await fetchIncomingFriendRequests(s);
    setFriendRequests(requests);
  };

  useEffect(() => {
    if (!session) return;
    setLoading(true);
    Promise.all([loadConversationsAndPreview(session), loadFriendRequests(session)])
      .catch((err: unknown) => setError(normalizeError(err, 'Erreur chargement')))
      .finally(() => setLoading(false));
  }, [session]);

  useEffect(() => {
    if (!session) return;
    const id = window.setInterval(() => {
      void loadConversationsAndPreview(session).catch(() => null);
    }, 6000);
    return () => window.clearInterval(id);
  }, [session]);

  useEffect(() => {
    if (!session) return;
    const supabase = getSupabaseClient();
    const channel = supabase
      .channel(`chat-list:${session.userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'friend_request' }, async () => {
        await loadFriendRequests(session);
        await loadConversationsAndPreview(session);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'message' }, async () => {
        await loadConversationsAndPreview(session);
      })
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [session?.userId]);

  useRealtime(session, async () => {
    if (!session) return;
    await loadConversationsAndPreview(session);
  });

  const onSendFriendRequest = async (e: FormEvent) => {
    e.preventDefault();
    if (!session) return;
    try {
      if (sheetMode === 'group') {
        const members = groupMembers
          .split(',')
          .map((id) => id.trim().toLowerCase())
          .filter((id) => id !== '');
        const conv = await createGroupConversation(session, groupTitle, members);
        setFriendStatus(`Groupe ${groupTitle.trim()} cree`);
        setGroupTitle('');
        setGroupMembers('');
        setSheetOpen(false);
        await loadConversationsAndPreview(session);
        router.push(`/chat/${encodeURIComponent(conv.id)}`);
        return;
      }

      if (!peerUserId.trim()) return;
      await sendFriendRequest(session, peerUserId.trim());
      setFriendStatus(`Demande envoyee a ${peerUserId.trim().toLowerCase()}`);
      setPeerUserId('');
      setSheetMode('direct');
      setSheetOpen(false);
      await loadConversationsAndPreview(session);
      await loadFriendRequests(session);
    } catch (err) {
      setError(normalizeError(err, "Erreur envoi demande d'ami"));
    }
  };

  const onAcceptFriendRequest = async (requestId: string) => {
    if (!session) return;
    try {
      const conv = await acceptFriendRequest(session, requestId);
      await loadConversationsAndPreview(session);
      await loadFriendRequests(session);
      router.push(`/chat/${encodeURIComponent(conv.id)}`);
    } catch (err) {
      setError(normalizeError(err, "Erreur acceptation d'ami"));
    }
  };

  const filteredConversations = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return conversations;
    return conversations.filter((conv) => {
      const preview = previews[conv.id]?.text ?? '';
      const title = (conv.title ?? '').toLowerCase();
      return conv.peerId.toLowerCase().includes(term) || title.includes(term) || preview.toLowerCase().includes(term);
    });
  }, [conversations, previews, search]);

  if (!session) return <main className="centered">Chargement...</main>;

  return (
    <SecurityShell userId={session.userId}>
      <main className="mobile-screen mobile-chats">
        <header className="mobile-header">
          <div>
            <h1>Ghost Secure</h1>
            <p className="muted-text">Chats chiffres</p>
          </div>
          <button type="button" className="icon-btn" onClick={() => router.push('/settings')} aria-label="Parametres">
            <SettingsGearIcon />
          </button>
        </header>

        <div className="sticky-search">
          <div className="search-wrap">
            <SearchIcon />
            <input
              className="mobile-input"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Rechercher"
            />
          </div>
        </div>

        {friendRequests.length > 0 && (
          <section className="inline-card">
            <p className="section-title">Demandes d&apos;ami</p>
            <div className="request-list">
              {friendRequests.map((request) => (
                <div key={request.id} className="request-row">
                  <div>
                    <strong>{request.requesterId}</strong>
                    <p className="muted-text">Souhaite discuter avec vous</p>
                  </div>
                  <button type="button" className="ghost-primary" onClick={() => onAcceptFriendRequest(request.id)}>
                    Accepter
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="chat-list" aria-label="Conversations">
          {loading && (
            <>
              <div className="chat-skeleton" />
              <div className="chat-skeleton" />
              <div className="chat-skeleton" />
            </>
          )}

          {!loading && filteredConversations.length === 0 && (
            <div className="empty-state">
              <div className="empty-state-icon">
                <ChatEmptyIcon />
              </div>
              <p>Aucune conversation</p>
              <p className="muted-text">Appuyez sur + pour commencer</p>
            </div>
          )}

          {!loading &&
            filteredConversations.map((conv) => {
              const preview = previews[conv.id];
              const isGroup = conv.kind === 'group';
              return (
                <button
                  key={conv.id}
                  type="button"
                  className="chat-row"
                  onClick={() => router.push(`/chat/${encodeURIComponent(conv.id)}`)}
                >
                  {isGroup ? (
                    <div className="chat-avatar group-avatar" aria-hidden="true"><GroupIcon /></div>
                  ) : (
                    <div className="chat-avatar" aria-hidden="true">{conv.peerId.slice(0, 1).toUpperCase()}</div>
                  )}
                  <div className="chat-content">
                    <div className="chat-topline">
                      <strong>{isGroup ? (conv.title ?? 'Groupe') : conv.peerId}</strong>
                      <span>{formatHour(preview?.at ?? conv.updatedAt)}</span>
                    </div>
                    <div className="chat-bottomline">
                      <p>{isGroup ? `Groupe - ${conv.memberCount} membres` : preview?.text ?? 'Message chiffre'}</p>
                    </div>
                  </div>
                </button>
              );
            })}
        </section>

        <button type="button" className="fab" onClick={() => setSheetOpen(true)} aria-label="Nouveau chat">
          <PlusIcon />
        </button>

        {sheetOpen && (
          <div className="sheet-backdrop" onClick={() => setSheetOpen(false)}>
            <form className="sheet" onSubmit={onSendFriendRequest} onClick={(e) => e.stopPropagation()}>
              <h2>Nouveau chat</h2>
              <div className="row">
                <button
                  type="button"
                  className={sheetMode === 'direct' ? 'ghost-primary' : 'ghost-secondary'}
                  onClick={() => setSheetMode('direct')}
                >
                  Ami
                </button>
                <button
                  type="button"
                  className={sheetMode === 'group' ? 'ghost-primary' : 'ghost-secondary'}
                  onClick={() => setSheetMode('group')}
                >
                  Groupe
                </button>
              </div>
              {sheetMode === 'direct' ? (
              <label className="field">
                <span>ID utilisateur</span>
                <input
                  className="mobile-input"
                  value={peerUserId}
                  onChange={(e) => setPeerUserId(e.target.value)}
                  placeholder="ex: ghost_23"
                />
              </label>
              ) : (
                <>
                  <label className="field">
                    <span>Nom du groupe</span>
                    <input
                      className="mobile-input"
                      value={groupTitle}
                      onChange={(e) => setGroupTitle(e.target.value)}
                      placeholder="ex: Equipe projet"
                    />
                  </label>
                  <label className="field">
                    <span>Membres (IDs, separes par virgule)</span>
                    <input
                      className="mobile-input"
                      value={groupMembers}
                      onChange={(e) => setGroupMembers(e.target.value)}
                      placeholder="ex: alice,bob,charlie"
                    />
                  </label>
                </>
              )}
              <div className="row">
                <button type="button" className="ghost-secondary" onClick={() => setSheetOpen(false)}>
                  Annuler
                </button>
                <button type="submit" className="ghost-primary">
                  {sheetMode === 'group' ? 'Creer' : 'Envoyer'}
                </button>
              </div>
            </form>
          </div>
        )}

        {(friendStatus || error) && (
          <div className="toast-zone">
            {friendStatus && <div className="toast toast-ok"><p className="ok-text">{friendStatus}</p></div>}
            {error && <div className="toast toast-error"><p className="error-text">{error}</p></div>}
          </div>
        )}

        <MobileTabs />
      </main>
    </SecurityShell>
  );
}

function normalizeError(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback;
  const raw = err.message.trim();
  const message = raw.toLowerCase();
  if (message.includes('forbidden')) return 'Action non autorisee.';
  if (message.includes('invalid') || message.includes('introuvable')) return raw;
  if (message.includes('network error calling')) return raw;
  if (message.includes('failed to fetch')) return `Connexion backend indisponible. Detail: ${raw}`;
  return fallback;
}

function formatHour(raw: string): string {
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function SettingsGearIcon() {
  return (
    <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="m12 2 2.2 1.2 2.5-.3 1.3 2.1 2.3 1 .1 2.5 1.6 2-1 2.3 1 2.3-1.6 2-.1 2.5-2.3 1-1.3 2.1-2.5-.3L12 22l-2.2-1.2-2.5.3-1.3-2.1-2.3-1-.1-2.5-1.6-2 1-2.3-1-2.3 1.6-2 .1-2.5 2.3-1 1.3-2.1 2.5.3L12 2Zm0 6a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg className="search-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M10.5 3a7.5 7.5 0 0 1 5.95 12.04l4.25 4.26a1 1 0 0 1-1.4 1.4l-4.26-4.25A7.5 7.5 0 1 1 10.5 3Zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z" fill="currentColor" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 4a1 1 0 0 1 1 1v6h6a1 1 0 1 1 0 2h-6v6a1 1 0 1 1-2 0v-6H5a1 1 0 1 1 0-2h6V5a1 1 0 0 1 1-1Z" />
    </svg>
  );
}

function GroupIcon() {
  return (
    <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8Zm-6 3a3 3 0 1 1 0 6 3 3 0 0 1 0-6Zm12 0a3 3 0 1 1 0 6 3 3 0 0 1 0-6ZM4 18c0-2 2-3.5 5-3.8a6.3 6.3 0 0 0-1.8 3.4c-.1.5-.2.9-.2 1.4H2.5a.5.5 0 0 1-.5-.5V18Zm16 0v.5a.5.5 0 0 1-.5.5H17c0-.5-.1-1-.2-1.4a6.3 6.3 0 0 0-1.8-3.4c3 .3 5 1.8 5 3.8Zm-8-3c3 0 5 1.5 5 3.5v.5a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1v-.5c0-2 2-3.5 5-3.5Z" />
    </svg>
  );
}

function ChatEmptyIcon() {
  return (
    <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v7A2.5 2.5 0 0 1 17.5 15H9l-4.2 3.4c-.33.27-.8.03-.8-.39V5.5Z" />
    </svg>
  );
}
