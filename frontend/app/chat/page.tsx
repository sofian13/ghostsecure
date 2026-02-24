"use client";

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import SecurityShell from '@/components/SecurityShell';
import MobileTabs from '@/components/MobileTabs';
import { clearSession, getSession } from '@/lib/session';
import {
  acceptFriendRequest,
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
    if (!session || !peerUserId.trim()) return;
    try {
      await sendFriendRequest(session, peerUserId.trim());
      setFriendStatus(`Demande envoyee a ${peerUserId.trim().toLowerCase()}`);
      setPeerUserId('');
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

  const logout = () => {
    clearSession();
    router.replace('/login');
  };

  const filteredConversations = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return conversations;
    return conversations.filter((conv) => {
      const preview = previews[conv.id]?.text ?? '';
      return conv.peerId.toLowerCase().includes(term) || preview.toLowerCase().includes(term);
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
            P
          </button>
        </header>

        <div className="sticky-search">
          <input
            className="mobile-input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Rechercher"
          />
        </div>

        {friendRequests.length > 0 && (
          <section className="inline-card">
            <p className="section-title">Demandes d'ami</p>
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
              <p>Aucune conversation</p>
              <p className="muted-text">Appuyez sur Nouveau chat pour commencer</p>
            </div>
          )}

          {!loading &&
            filteredConversations.map((conv) => {
              const preview = previews[conv.id];
              return (
                <button
                  key={conv.id}
                  type="button"
                  className="chat-row"
                  onClick={() => router.push(`/chat/${encodeURIComponent(conv.id)}`)}
                >
                  <div className="chat-avatar" aria-hidden="true">{conv.peerId.slice(0, 1).toUpperCase()}</div>
                  <div className="chat-content">
                    <div className="chat-topline">
                      <strong>{conv.peerId}</strong>
                      <span>{formatHour(preview?.at ?? conv.updatedAt)}</span>
                    </div>
                    <div className="chat-bottomline">
                      <p>{preview?.text ?? 'Message chiffre'}</p>
                    </div>
                  </div>
                </button>
              );
            })}
        </section>

        <button type="button" className="fab" onClick={() => setSheetOpen(true)} aria-label="Nouveau chat">
          +
        </button>

        {sheetOpen && (
          <div className="sheet-backdrop" onClick={() => setSheetOpen(false)}>
            <form className="sheet" onSubmit={onSendFriendRequest} onClick={(e) => e.stopPropagation()}>
              <h2>Nouveau chat</h2>
              <label className="field">
                <span>ID utilisateur</span>
                <input
                  className="mobile-input"
                  value={peerUserId}
                  onChange={(e) => setPeerUserId(e.target.value)}
                  placeholder="ex: ghost_23"
                />
              </label>
              <div className="row">
                <button type="button" className="ghost-secondary" onClick={() => setSheetOpen(false)}>
                  Annuler
                </button>
                <button type="submit" className="ghost-primary">
                  Envoyer
                </button>
              </div>
            </form>
          </div>
        )}

        {(friendStatus || error) && (
          <div className="toast-zone">
            {friendStatus && <p className="ok-text">{friendStatus}</p>}
            {error && <p className="error-text">{error}</p>}
          </div>
        )}

        <button type="button" className="logout-link" onClick={logout}>
          Logout
        </button>

        <MobileTabs />
      </main>
    </SecurityShell>
  );
}

function normalizeError(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback;
  const message = err.message.toLowerCase();
  if (message.includes('forbidden')) return 'Action non autorisee.';
  if (message.includes('invalid') || message.includes('introuvable')) return err.message;
  if (message.includes('failed to fetch')) return 'Supabase indisponible. Verifiez les variables env.';
  return fallback;
}

function formatHour(raw: string): string {
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
