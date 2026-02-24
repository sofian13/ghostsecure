"use client";

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import SecurityShell from '@/components/SecurityShell';
import MessageBubble from '@/components/MessageBubble';
import { clearSession, getSession } from '@/lib/session';
import { createConversation, fetchConversationDetail, fetchConversations, fetchMessages, sendMessage } from '@/lib/api';
import { decryptIncomingMessage, encryptForParticipants } from '@/lib/crypto';
import { useRealtime } from '@/lib/useRealtime';
import type { Conversation, EncryptedMessage, Session } from '@/types';

type Decrypted = {
  id: string;
  senderId: string;
  text: string;
  createdAt: string;
  expiresAt: string | null;
};

export default function ChatPage() {
  const router = useRouter();
  const [session, setSessionState] = useState<Session | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Decrypted[]>([]);
  const [input, setInput] = useState('');
  const [peerUserId, setPeerUserId] = useState('');
  const [ephemeralSeconds, setEphemeralSeconds] = useState(300);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const s = getSession();
    if (!s) {
      router.replace('/login');
      return;
    }
    setSessionState(s);
  }, [router]);

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? null,
    [conversations, activeId]
  );

  const loadConversations = async (s: Session) => {
    const data = await fetchConversations(s);
    setConversations(data);
    if (!activeId && data.length > 0) setActiveId(data[0].id);
  };

  const loadMessages = async (s: Session, conversationId: string) => {
    const encrypted = await fetchMessages(s, conversationId);
    const decrypted = await Promise.all(encrypted.map((m) => decryptOne(s.userId, m)));
    setMessages(decrypted.filter((m): m is Decrypted => Boolean(m)));
  };

  useEffect(() => {
    if (!session) return;
    loadConversations(session).catch((e) => setError(normalizeError(e, 'Erreur chargement conversations')));
  }, [session]);

  useEffect(() => {
    if (!session || !activeId) return;
    loadMessages(session, activeId).catch((e) => setError(normalizeError(e, 'Erreur chargement messages')));
  }, [session, activeId]);

  useEffect(() => {
    if (!session || !activeId) return;
    const id = window.setInterval(() => {
      void loadMessages(session, activeId).catch(() => null);
    }, 3500);
    return () => window.clearInterval(id);
  }, [session, activeId]);

  useRealtime(session, async (payload) => {
    const event = payload as { type?: string; conversationId?: string; message?: EncryptedMessage };
    if (!session) return;
    if (event.type !== 'new_message' || !event.message) return;

    await loadConversations(session);
    if (event.conversationId === activeId) {
      const decrypted = await decryptOne(session.userId, event.message);
      if (decrypted) setMessages((prev) => [...prev, decrypted]);
    }
  });

  const onCreateConversation = async (e: FormEvent) => {
    e.preventDefault();
    if (!session || !peerUserId.trim()) return;
    try {
      const conv = await createConversation(session, peerUserId.trim());
      setPeerUserId('');
      await loadConversations(session);
      setActiveId(conv.id);
    } catch (err) {
      setError(normalizeError(err, 'Erreur creation conversation'));
    }
  };

  const onSendMessage = async (e: FormEvent) => {
    e.preventDefault();
    if (!session || !activeId || !input.trim()) return;
    try {
      const detail = await fetchConversationDetail(session, activeId);
      const encrypted = await encryptForParticipants(
        input.trim(),
        detail.participants.map((p) => ({ id: p.id, publicKey: p.publicKey }))
      );
      await sendMessage(session, activeId, {
        ...encrypted,
        expiresInSeconds: ephemeralSeconds,
      });
      setInput('');
      await loadMessages(session, activeId);
    } catch (err) {
      setError(normalizeError(err, 'Erreur envoi message'));
    }
  };

  const logout = () => {
    clearSession();
    router.replace('/login');
  };

  if (!session) return <main className="centered">Chargement...</main>;

  return (
    <SecurityShell userId={session.userId}>
      <main className="chat-shell">
        <aside className="glass-card sidebar-v2">
          <div className="sidebar-top">
            <h1>Ghost Secure</h1>
            <p className="user-id">Session: {session.userId}</p>
          </div>

          <form onSubmit={onCreateConversation} className="stack-form">
            <label className="field">
              <span>Nouveau contact</span>
              <input
                value={peerUserId}
                onChange={(e) => setPeerUserId(e.target.value)}
                placeholder="user_id"
                className="glass-input"
              />
            </label>
            <button type="submit" className="glass-btn">Creer / ouvrir</button>
          </form>

          <div className="conv-list">
            {conversations.map((conv) => (
              <button
                key={conv.id}
                type="button"
                className={`conv-item ${activeId === conv.id ? 'active' : ''}`}
                onClick={() => setActiveId(conv.id)}
              >
                <strong>{conv.peerId}</strong>
                <span>{new Date(conv.updatedAt).toLocaleString()}</span>
              </button>
            ))}
          </div>

          <div className="sidebar-actions">
            <button className="glass-btn soft" type="button" onClick={() => router.push('/call')}>Appel</button>
            <button className="glass-btn soft" type="button" onClick={() => router.push('/settings')}>Securite</button>
            <button className="glass-btn danger" type="button" onClick={logout}>Logout</button>
          </div>
        </aside>

        <section className="glass-card chat-main">
          <header className="chat-head">
            <h2>{activeConversation ? `Conversation: ${activeConversation.peerId}` : 'Aucune conversation'}</h2>
            <span className="panel-pill">E2EE ACTIVE</span>
          </header>

          <div className="message-list no-select">
            {messages.map((msg) => (
              <MessageBubble
                key={msg.id}
                text={msg.text}
                mine={msg.senderId === session.userId}
                expiresAt={msg.expiresAt}
              />
            ))}
          </div>

          <form className="compose-v2" onSubmit={onSendMessage}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              className="glass-input"
              placeholder="Ecrire un message chiffre..."
            />
            <input
              type="number"
              min={5}
              max={86400}
              className="glass-input ttl"
              value={ephemeralSeconds}
              onChange={(e) => setEphemeralSeconds(Number(e.target.value) || 300)}
              title="Auto suppression (secondes)"
            />
            <button type="submit" className="glass-btn primary" disabled={!activeConversation}>Envoyer</button>
          </form>

          {error && <p className="error-text">{error}</p>}
        </section>
      </main>
    </SecurityShell>
  );
}

function normalizeError(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback;
  const message = err.message.toLowerCase();
  if (message.includes('unauthorized') || message.includes('forbidden')) return 'Session invalide. Reconnectez-vous.';
  if (message.includes('failed to fetch')) return 'Supabase indisponible. Verifiez les variables env.';
  return fallback;
}

async function decryptOne(userId: string, message: EncryptedMessage): Promise<Decrypted | null> {
  const wrappedKey = message.wrappedKeys[userId];
  if (!wrappedKey) return null;
  try {
    const text = await decryptIncomingMessage(userId, {
      ciphertext: message.ciphertext,
      iv: message.iv,
      wrappedKey,
    });
    return {
      id: message.id,
      senderId: message.senderId,
      text,
      createdAt: message.createdAt,
      expiresAt: message.expiresAt,
    };
  } catch {
    return null;
  }
}
