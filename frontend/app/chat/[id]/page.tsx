"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import SecurityShell from '@/components/SecurityShell';
import MessageBubble from '@/components/MessageBubble';
import MobileTabs from '@/components/MobileTabs';
import { getSession } from '@/lib/session';
import { fetchConversationDetail, fetchMessages, sendMessage } from '@/lib/api';
import { encryptForParticipants } from '@/lib/crypto';
import { decryptForUser, type DecryptedMessage } from '@/lib/messages';
import { useRealtime } from '@/lib/useRealtime';
import { getSupabaseClient } from '@/lib/supabase';
import type { EncryptedMessage, Session } from '@/types';

export default function ConversationPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const conversationId = decodeURIComponent(params.id);

  const [session, setSessionState] = useState<Session | null>(null);
  const [peerId, setPeerId] = useState<string>('');
  const [messages, setMessages] = useState<DecryptedMessage[]>([]);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('En ligne');
  const [incomingCallFrom, setIncomingCallFrom] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordingMs, setRecordingMs] = useState(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordStreamRef = useRef<MediaStream | null>(null);
  const recordChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<number | null>(null);
  const recordStartRef = useRef<number>(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const s = getSession();
    if (!s) {
      router.replace('/login');
      return;
    }
    setSessionState(s);
  }, [router]);

  const loadContext = async (s: Session) => {
    const detail = await fetchConversationDetail(s, conversationId);
    const peer = detail.participants.find((p) => p.id !== s.userId)?.id ?? 'Contact';
    setPeerId(peer);
  };

  const loadMessages = async (s: Session) => {
    const encrypted = await fetchMessages(s, conversationId);
    const decrypted = await Promise.all(encrypted.map((m) => decryptForUser(s.userId, m)));
    setMessages(decrypted.filter((m): m is DecryptedMessage => Boolean(m)));
  };

  useEffect(() => {
    if (!session) return;
    Promise.all([loadContext(session), loadMessages(session)]).catch((e: unknown) => {
      setError(normalizeError(e, 'Erreur chargement conversation'));
    });
  }, [session, conversationId]);

  useEffect(() => {
    if (!session) return;
    const id = window.setInterval(() => {
      void loadMessages(session).catch(() => null);
    }, 3500);
    return () => window.clearInterval(id);
  }, [session, conversationId]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length]);

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
        if (frame.status === 'pending') {
          setIncomingCallFrom(from);
          setStatus('Appel entrant');
        }
        if (frame.status === 'rejected' || frame.status === 'ended') {
          setIncomingCallFrom(null);
          setStatus('Vu recemment');
        }
      })
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [session?.userId]);

  useRealtime(session, async (payload) => {
    const event = payload as { type?: string; conversationId?: string; message?: EncryptedMessage };
    if (!session) return;
    if (event.type !== 'new_message' || event.conversationId !== conversationId || !event.message) return;
    const decrypted = await decryptForUser(session.userId, event.message);
    if (decrypted) setMessages((prev) => [...prev, decrypted]);
  });

  const sendText = async (e: FormEvent) => {
    e.preventDefault();
    if (!session || !input.trim()) return;

    try {
      const detail = await fetchConversationDetail(session, conversationId);
      const encrypted = await encryptForParticipants(
        input.trim(),
        detail.participants.map((p) => ({ id: p.id, publicKey: p.publicKey }))
      );
      await sendMessage(session, conversationId, { ...encrypted });
      setInput('');
      await loadMessages(session);
    } catch (err) {
      setError(normalizeError(err, 'Message non envoye'));
    }
  };

  const startVoiceRecording = async () => {
    if (recording || !session) return;
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
      setError('Micro indisponible');
    }
  };

  const stopVoiceRecording = async () => {
    if (!recording || !session || !recorderRef.current) return;

    try {
      const blob = await new Promise<Blob>((resolve) => {
        const rec = recorderRef.current!;
        rec.onstop = () => {
          resolve(new Blob(recordChunksRef.current, { type: rec.mimeType || 'audio/webm' }));
        };
        rec.stop();
      });

      const detail = await fetchConversationDetail(session, conversationId);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (const b of bytes) binary += String.fromCharCode(b);
      const payload = JSON.stringify({
        type: 'voice',
        mimeType: blob.type || 'audio/webm',
        dataBase64: btoa(binary),
        durationMs: Math.max(800, Date.now() - recordStartRef.current),
      });

      const encrypted = await encryptForParticipants(
        payload,
        detail.participants.map((p) => ({ id: p.id, publicKey: p.publicKey }))
      );
      await sendMessage(session, conversationId, { ...encrypted });
      await loadMessages(session);
    } catch {
      setError("Erreur d'envoi vocal");
    } finally {
      cleanupVoiceRecorder();
    }
  };

  const cleanupVoiceRecorder = () => {
    if (recordTimerRef.current) window.clearInterval(recordTimerRef.current);
    recordTimerRef.current = null;
    recorderRef.current = null;
    recordChunksRef.current = [];
    recordStreamRef.current?.getTracks().forEach((t) => t.stop());
    recordStreamRef.current = null;
    setRecording(false);
    setRecordingMs(0);
  };

  const rightAction = useMemo(() => {
    if (input.trim()) {
      return (
        <button type="submit" className="composer-send" aria-label="Envoyer">
          Env
        </button>
      );
    }
    return (
      <button
        type="button"
        className={`composer-mic ${recording ? 'recording' : ''}`}
        onPointerDown={startVoiceRecording}
        onPointerUp={stopVoiceRecording}
        onPointerCancel={cleanupVoiceRecorder}
        aria-label="Maintenir pour vocal"
      >
        Mic
      </button>
    );
  }, [input, recording]);

  if (!session) return <main className="centered">Chargement...</main>;

  return (
    <SecurityShell userId={session.userId}>
      <main className="mobile-screen mobile-conversation">
        <header className="conversation-header">
          <button type="button" className="icon-btn" onClick={() => router.push('/chat')} aria-label="Retour">
            {'<'}
          </button>
          <div className="chat-avatar small" aria-hidden="true">{peerId.slice(0, 1).toUpperCase()}</div>
          <div className="conversation-head-copy">
            <strong>{peerId || 'Contact'}</strong>
            <span>{status}</span>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={() => router.push(`/call?target=${encodeURIComponent(peerId)}&autocall=1`)}
            aria-label="Appeler"
          >
            Tel
          </button>
          <button type="button" className="icon-btn" onClick={() => router.push('/settings')} aria-label="Options">
            ...
          </button>
        </header>

        <div className="security-pill">Chiffrement de bout en bout active</div>

        {incomingCallFrom && (
          <div className="incoming-banner">
            <p>{incomingCallFrom} vous appelle</p>
            <button
              type="button"
              className="ghost-primary"
              onClick={() => router.push(`/call?target=${encodeURIComponent(incomingCallFrom)}&autocall=0`)}
            >
              Repondre
            </button>
          </div>
        )}

        <section className="message-thread" ref={listRef}>
          {messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              kind={msg.kind}
              text={msg.text}
              voice={msg.voice}
              mine={msg.senderId === session.userId}
              createdAt={msg.createdAt}
              status={msg.senderId === session.userId ? 'sent' : 'received'}
              expiresAt={msg.expiresAt}
            />
          ))}
        </section>

        <form className="composer" onSubmit={sendText}>
          <button type="button" className="icon-btn composer-left" aria-label="Joindre" onClick={() => setError('Piece jointe bientot')}>
            +
          </button>
          <input
            className="composer-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Message"
            enterKeyHint="send"
          />
          {rightAction}
        </form>

        {recording && <p className="recording-state">Enregistrement {Math.ceil(recordingMs / 1000)}s</p>}
        {error && <p className="error-text">{error}</p>}

        <MobileTabs />
      </main>
    </SecurityShell>
  );
}

function normalizeError(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback;
  const message = err.message.toLowerCase();
  if (message.includes('forbidden')) return 'Action non autorisee.';
  if (message.includes('failed to fetch')) return 'Hors ligne. Reessayez.';
  return fallback;
}
