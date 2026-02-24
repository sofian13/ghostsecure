"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import SecurityShell from '@/components/SecurityShell';
import MessageBubble from '@/components/MessageBubble';
import { clearSession, getSession } from '@/lib/session';
import {
  acceptFriendRequest,
  fetchConversationDetail,
  fetchConversations,
  fetchIncomingFriendRequests,
  sendFriendRequest,
  type FriendRequest,
  fetchMessages,
  sendMessage,
} from '@/lib/api';
import { decryptIncomingMessage, encryptForParticipants } from '@/lib/crypto';
import { useRealtime } from '@/lib/useRealtime';
import { getSupabaseClient } from '@/lib/supabase';
import type { Conversation, EncryptedMessage, Session } from '@/types';

type Decrypted = {
  id: string;
  senderId: string;
  kind: 'text' | 'voice';
  text?: string;
  voice?: {
    mimeType: string;
    dataBase64: string;
    durationMs: number;
  };
  createdAt: string;
  expiresAt: string | null;
};

export default function ChatPage() {
  const router = useRouter();
  const [session, setSessionState] = useState<Session | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Decrypted[]>([]);
  const [friendRequests, setFriendRequests] = useState<FriendRequest[]>([]);
  const [input, setInput] = useState('');
  const [peerUserId, setPeerUserId] = useState('');
  const [ephemeralSeconds, setEphemeralSeconds] = useState(300);
  const [error, setError] = useState<string | null>(null);
  const [friendStatus, setFriendStatus] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [incomingCallFrom, setIncomingCallFrom] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordingMs, setRecordingMs] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordStreamRef = useRef<MediaStream | null>(null);
  const recordChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<number | null>(null);
  const recordStartRef = useRef<number>(0);

  useEffect(() => {
    const s = getSession();
    if (!s) {
      router.replace('/login');
      return;
    }
    setSessionState(s);
  }, [router]);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 980px)');
    const apply = () => setSidebarOpen(!media.matches);
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, []);

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? null,
    [conversations, activeId]
  );

  const loadConversations = async (s: Session) => {
    const data = await fetchConversations(s);
    setConversations(data);
    if (!activeId && data.length > 0) setActiveId(data[0].id);
  };

  const loadFriendRequests = async (s: Session) => {
    const requests = await fetchIncomingFriendRequests(s);
    setFriendRequests(requests);
  };

  const loadMessages = async (s: Session, conversationId: string) => {
    const encrypted = await fetchMessages(s, conversationId);
    const decrypted = await Promise.all(encrypted.map((m) => decryptOne(s.userId, m)));
    setMessages(decrypted.filter((m): m is Decrypted => Boolean(m)));
  };

  useEffect(() => {
    if (!session) return;
    loadConversations(session).catch((e) => setError(normalizeError(e, 'Erreur chargement conversations')));
    loadFriendRequests(session).catch(() => null);
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

  useEffect(() => {
    if (!session) return;
    const supabase = getSupabaseClient();
    const channel = supabase
      .channel(`friend-requests:${session.userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'friend_request' },
        async () => {
          await loadFriendRequests(session);
          await loadConversations(session);
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [session?.userId]);

  useEffect(() => {
    if (!session) return;
    const me = session.userId.trim().toLowerCase();
    const supabase = getSupabaseClient();
    const channel = supabase
      .channel(`call-inbox:${me}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'call_invite' }, ({ new: row }) => {
        const frame = row as {
          status?: string;
          from_user_id?: string;
          target_user_id?: string;
        };
        const target = (frame.target_user_id ?? '').trim().toLowerCase();
        const from = (frame.from_user_id ?? '').trim().toLowerCase();
        if (!from || target !== me) return;
        if (frame.status === 'pending') setIncomingCallFrom(from);
        if (frame.status === 'rejected' || frame.status === 'ended') setIncomingCallFrom(null);
      })
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [session?.userId]);

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

  const onSendFriendRequest = async (e: FormEvent) => {
    e.preventDefault();
    if (!session || !peerUserId.trim()) return;
    try {
      await sendFriendRequest(session, peerUserId.trim());
      setFriendStatus(`Demande envoyee a ${peerUserId.trim().toLowerCase()}`);
      setPeerUserId('');
      await loadFriendRequests(session);
    } catch (err) {
      setError(normalizeError(err, "Erreur envoi demande d'ami"));
    }
  };

  const onAcceptFriendRequest = async (requestId: string) => {
    if (!session) return;
    try {
      const conv = await acceptFriendRequest(session, requestId);
      await loadFriendRequests(session);
      await loadConversations(session);
      setActiveId(conv.id);
      setSidebarOpen(false);
      setFriendStatus('Demande acceptee');
    } catch (err) {
      setError(normalizeError(err, "Erreur acceptation d'ami"));
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

  const startVoiceRecording = async () => {
    if (recording) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      const recorder = new MediaRecorder(stream, { mimeType });
      recordStreamRef.current = stream;
      recorderRef.current = recorder;
      recordChunksRef.current = [];
      recordStartRef.current = Date.now();
      setRecordingMs(0);
      setRecording(true);

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) recordChunksRef.current.push(event.data);
      };
      recorder.start(250);

      recordTimerRef.current = window.setInterval(() => {
        setRecordingMs(Date.now() - recordStartRef.current);
      }, 200);
    } catch {
      setError('Impossible de demarrer le micro');
    }
  };

  const stopVoiceRecording = async () => {
    if (!recording || !session || !activeId || !recorderRef.current) return;
    try {
      const blob = await new Promise<Blob>((resolve) => {
        const rec = recorderRef.current!;
        rec.onstop = () => {
          resolve(new Blob(recordChunksRef.current, { type: rec.mimeType || 'audio/webm' }));
        };
        rec.stop();
      });

      const detail = await fetchConversationDetail(session, activeId);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (const b of bytes) binary += String.fromCharCode(b);
      const dataBase64 = btoa(binary);
      const payload = JSON.stringify({
        type: 'voice',
        mimeType: blob.type || 'audio/webm',
        dataBase64,
        durationMs: Math.max(1000, Date.now() - recordStartRef.current),
      });

      const encrypted = await encryptForParticipants(
        payload,
        detail.participants.map((p) => ({ id: p.id, publicKey: p.publicKey }))
      );
      await sendMessage(session, activeId, {
        ...encrypted,
        expiresInSeconds: ephemeralSeconds,
      });
      await loadMessages(session, activeId);
    } catch {
      setError("Erreur d'envoi vocal");
    } finally {
      if (recordTimerRef.current) window.clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
      recorderRef.current = null;
      recordChunksRef.current = [];
      recordStreamRef.current?.getTracks().forEach((t) => t.stop());
      recordStreamRef.current = null;
      setRecording(false);
      setRecordingMs(0);
    }
  };

  const cancelVoiceRecording = () => {
    if (!recording) return;
    if (recordTimerRef.current) window.clearInterval(recordTimerRef.current);
    recordTimerRef.current = null;
    recorderRef.current?.stop();
    recorderRef.current = null;
    recordChunksRef.current = [];
    recordStreamRef.current?.getTracks().forEach((t) => t.stop());
    recordStreamRef.current = null;
    setRecording(false);
    setRecordingMs(0);
  };

  const logout = () => {
    clearSession();
    router.replace('/login');
  };

  if (!session) return <main className="centered">Chargement...</main>;

  return (
    <SecurityShell userId={session.userId}>
      <main className="chat-shell">
        <aside className={`glass-card sidebar-v2 ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
          <div className="sidebar-top">
            <h1>Ghost Secure</h1>
            <p className="user-id">Session: {session.userId}</p>
          </div>

          <form onSubmit={onSendFriendRequest} className="stack-form">
            <label className="field">
              <span>Demande d&apos;ami</span>
              <input
                value={peerUserId}
                onChange={(e) => setPeerUserId(e.target.value)}
                placeholder="user_id"
                className="glass-input"
              />
            </label>
            <button type="submit" className="glass-btn">Envoyer</button>
          </form>

          <div className="requests-box">
            <p className="requests-title">Demandes recues</p>
            {friendRequests.length === 0 && <p className="user-id">Aucune demande en attente</p>}
            {friendRequests.map((request) => (
              <div key={request.id} className="request-item">
                <span>{request.requesterId}</span>
                <button type="button" className="glass-btn soft" onClick={() => onAcceptFriendRequest(request.id)}>
                  Accepter
                </button>
              </div>
            ))}
          </div>

          <div className="conv-list">
            {conversations.map((conv) => (
              <button
                key={conv.id}
                type="button"
                className={`conv-item ${activeId === conv.id ? 'active' : ''}`}
                onClick={() => {
                  setActiveId(conv.id);
                  setSidebarOpen(false);
                }}
              >
                <strong>{conv.peerId}</strong>
                <span>{new Date(conv.updatedAt).toLocaleString()}</span>
              </button>
            ))}
          </div>

          <div className="sidebar-actions">
            <button className="glass-btn soft" type="button" onClick={() => router.push('/settings')}>Securite</button>
            <button className="glass-btn danger" type="button" onClick={logout}>Logout</button>
          </div>
        </aside>

        <section className="glass-card chat-main">
          <header className="chat-head">
            <div className="chat-head-main">
              <button type="button" className="glass-btn soft sidebar-toggle" onClick={() => setSidebarOpen((v) => !v)}>
                Contacts
              </button>
              <h2>{activeConversation ? `Conversation: ${activeConversation.peerId}` : 'Aucune conversation'}</h2>
            </div>
            <div className="chat-head-actions">
              {activeConversation && (
                <button
                  className="glass-btn primary"
                  type="button"
                  onClick={() => router.push(`/call?target=${encodeURIComponent(activeConversation.peerId)}&autocall=1`)}
                >
                  Appeler
                </button>
              )}
              <span className="panel-pill">E2EE ACTIVE</span>
            </div>
          </header>

          {incomingCallFrom && (
            <div className="incoming-call-banner">
              <p className="requests-title">Appel entrant: {incomingCallFrom}</p>
              <div className="row">
                <button
                  type="button"
                  className="glass-btn primary"
                  onClick={() => router.push(`/call?target=${encodeURIComponent(incomingCallFrom)}&autocall=0`)}
                >
                  Repondre
                </button>
                <button type="button" className="glass-btn soft" onClick={() => setIncomingCallFrom(null)}>
                  Ignorer
                </button>
              </div>
            </div>
          )}

          <div className="message-list no-select">
            {messages.map((msg) => (
              <MessageBubble
                key={msg.id}
                kind={msg.kind}
                text={msg.text}
                voice={msg.voice}
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
            {!recording && (
              <button type="button" className="glass-btn soft" onClick={startVoiceRecording} disabled={!activeConversation}>
                Vocal
              </button>
            )}
            {recording && (
              <>
                <button type="button" className="glass-btn primary" onClick={stopVoiceRecording}>Envoyer {Math.ceil(recordingMs / 1000)}s</button>
                <button type="button" className="glass-btn danger" onClick={cancelVoiceRecording}>Annuler</button>
              </>
            )}
          </form>

          {friendStatus && <p className="ok-text">{friendStatus}</p>}
          {error && <p className="error-text">{error}</p>}
        </section>
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

async function decryptOne(userId: string, message: EncryptedMessage): Promise<Decrypted | null> {
  const wrappedKey = message.wrappedKeys[userId];
  if (!wrappedKey) return null;
  try {
    const payload = await decryptIncomingMessage(userId, {
      ciphertext: message.ciphertext,
      iv: message.iv,
      wrappedKey,
    });

    let parsed:
      | { type: 'voice'; mimeType: string; dataBase64: string; durationMs: number }
      | null = null;
    try {
      const raw = JSON.parse(payload) as {
        type?: string;
        mimeType?: string;
        dataBase64?: string;
        durationMs?: number;
      };
      if (raw.type === 'voice' && raw.mimeType && raw.dataBase64) {
        parsed = {
          type: 'voice',
          mimeType: raw.mimeType,
          dataBase64: raw.dataBase64,
          durationMs: Math.max(0, Number(raw.durationMs ?? 0)),
        };
      }
    } catch {
      parsed = null;
    }

    return {
      id: message.id,
      senderId: message.senderId,
      kind: parsed ? 'voice' : 'text',
      text: parsed ? undefined : payload,
      voice: parsed
        ? {
            mimeType: parsed.mimeType,
            dataBase64: parsed.dataBase64,
            durationMs: parsed.durationMs,
          }
        : undefined,
      createdAt: message.createdAt,
      expiresAt: message.expiresAt,
    };
  } catch {
    return null;
  }
}
