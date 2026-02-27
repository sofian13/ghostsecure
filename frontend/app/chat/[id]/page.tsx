"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import SecurityShell from '@/components/SecurityShell';
import MessageBubble from '@/components/MessageBubble';
import MobileTabs from '@/components/MobileTabs';
import { getSession } from '@/lib/session';
import { addGroupMember, fetchConversationDetail, fetchMessages, leaveGroupConversation, sendMessage } from '@/lib/api';
import { encryptForParticipants } from '@/lib/crypto';
import { decryptForUser, type DecryptedMessage } from '@/lib/messages';
import { useRealtime } from '@/lib/useRealtime';
import { getSupabaseClient } from '@/lib/supabase';
import type { EncryptedMessage, Session } from '@/types';

const MESSAGE_POLL_INTERVAL_MS = 900;

export default function ConversationPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const conversationId = decodeURIComponent(params.id);

  const [session, setSessionState] = useState<Session | null>(null);
  const [peerId, setPeerId] = useState<string>('');
  const [conversationKind, setConversationKind] = useState<'direct' | 'group'>('direct');
  const [messages, setMessages] = useState<DecryptedMessage[]>([]);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('En ligne');
  const [incomingCallFrom, setIncomingCallFrom] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordingMs, setRecordingMs] = useState(0);
  const [draftVoiceUrl, setDraftVoiceUrl] = useState<string | null>(null);
  const [draftVoiceBlob, setDraftVoiceBlob] = useState<Blob | null>(null);
  const [draftVoiceMime, setDraftVoiceMime] = useState<string>('audio/webm');
  const [draftVoiceDurationMs, setDraftVoiceDurationMs] = useState(0);

  const dismissedCallInvitesRef = useRef<Set<string>>(new Set());
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordStreamRef = useRef<MediaStream | null>(null);
  const recordChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<number | null>(null);
  const recordStartRef = useRef<number>(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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
    setConversationKind(detail.kind);
    if (detail.kind === 'group') {
      setPeerId(detail.title?.trim() || 'Groupe');
      return;
    }
    const peer = detail.participants.find((p) => p.id !== s.userId)?.id ?? 'Contact';
    setPeerId(peer);
  };

  const loadMessages = async (s: Session) => {
    const encrypted = await fetchMessages(s, conversationId);
    const decrypted = await Promise.all(encrypted.map((m) => decryptForUser(s.userId, m)));
    setMessages(sortAndDedupe(decrypted.filter((m): m is DecryptedMessage => Boolean(m))));
  };

  useEffect(() => {
    if (!session) return;
    Promise.all([loadContext(session), loadMessages(session)]).catch((e: unknown) => {
      setError(normalizeError(e, 'Erreur chargement conversation'));
    });
  }, [session, conversationId]);

  useEffect(() => {
    if (searchParams.get('autocall') !== '1') return;
    if (!peerId) return;
    router.replace(`/call?target=${encodeURIComponent(peerId)}&autocall=1`);
  }, [searchParams, peerId, router]);

  useEffect(() => {
    if (!session) return;
    const id = window.setInterval(() => {
      void loadMessages(session).catch(() => null);
    }, MESSAGE_POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [session, conversationId]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length]);

  useEffect(() => {
    return () => {
      if (draftVoiceUrl) URL.revokeObjectURL(draftVoiceUrl);
    };
  }, [draftVoiceUrl]);

  useEffect(() => {
    if (!session) return;
    const me = session.userId.trim().toLowerCase();
    const supabase = getSupabaseClient();
    const channel = supabase
      .channel(`call-inbox:${me}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'call_invite' }, ({ new: row }) => {
        const frame = row as {
          id?: string;
          status?: string;
          from_user_id?: string;
          target_user_id?: string;
        };
        const target = (frame.target_user_id ?? '').trim().toLowerCase();
        const from = (frame.from_user_id ?? '').trim().toLowerCase();
        const inviteId = frame.id ?? '';
        if (!from || target !== me) return;
        if (frame.status === 'pending') {
          if (dismissedCallInvitesRef.current.has(inviteId)) return;
          setIncomingCallFrom(from);
          setStatus('Appel entrant');
        }
        if (frame.status === 'rejected' || frame.status === 'ended' || frame.status === 'accepted') {
          if (inviteId) dismissedCallInvitesRef.current.add(inviteId);
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
    if (decrypted) setMessages((prev) => sortAndDedupe([...prev, decrypted]));
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
      const sent = await sendMessage(session, conversationId, { ...encrypted });
      const decrypted = await decryptForUser(session.userId, sent);
      if (decrypted) setMessages((prev) => sortAndDedupe([...prev, decrypted]));
      setInput('');
    } catch (err) {
      setError(normalizeError(err, 'Message non envoye'));
    }
  };

  const startVoiceRecording = async () => {
    if (recording || !session) return;
    try {
      if (typeof MediaRecorder === 'undefined') {
        setError('Vocal non supporte sur ce navigateur');
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const candidates = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
      const mimeType = candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
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

      const duration = Math.max(800, Date.now() - recordStartRef.current);
      const nextUrl = URL.createObjectURL(blob);
      if (draftVoiceUrl) URL.revokeObjectURL(draftVoiceUrl);
      setDraftVoiceBlob(blob);
      setDraftVoiceMime(blob.type || 'audio/webm');
      setDraftVoiceDurationMs(duration);
      setDraftVoiceUrl(nextUrl);
    } catch {
      setError("Erreur d'envoi vocal");
    } finally {
      cleanupVoiceRecorder();
    }
  };

  const sendDraftVoice = async () => {
    if (!session || !draftVoiceBlob) return;
    try {
      const detail = await fetchConversationDetail(session, conversationId);
      const bytes = new Uint8Array(await draftVoiceBlob.arrayBuffer());
      let binary = '';
      for (const b of bytes) binary += String.fromCharCode(b);
      const payload = JSON.stringify({
        type: 'voice',
        mimeType: draftVoiceMime || 'audio/webm',
        dataBase64: btoa(binary),
        durationMs: draftVoiceDurationMs || 1000,
      });
      const encrypted = await encryptForParticipants(
        payload,
        detail.participants.map((p) => ({ id: p.id, publicKey: p.publicKey }))
      );
      const sent = await sendMessage(session, conversationId, { ...encrypted });
      const decrypted = await decryptForUser(session.userId, sent);
      if (decrypted) setMessages((prev) => sortAndDedupe([...prev, decrypted]));
      discardDraftVoice();
    } catch {
      setError("Erreur d'envoi vocal");
    }
  };

  const onPickAttachment = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !session) return;
    if (file.size > 3 * 1024 * 1024) {
      setError('Fichier trop volumineux (max 3MB)');
      return;
    }

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (const b of bytes) binary += String.fromCharCode(b);
      const payload = JSON.stringify({
        type: 'file',
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        dataBase64: btoa(binary),
        sizeBytes: file.size,
      });

      const detail = await fetchConversationDetail(session, conversationId);
      const encrypted = await encryptForParticipants(
        payload,
        detail.participants.map((p) => ({ id: p.id, publicKey: p.publicKey }))
      );
      const sent = await sendMessage(session, conversationId, { ...encrypted });
      const decrypted = await decryptForUser(session.userId, sent);
      if (decrypted) setMessages((prev) => sortAndDedupe([...prev, decrypted]));
    } catch {
      setError("Erreur envoi piece jointe");
    }
  };

  const discardDraftVoice = () => {
    if (draftVoiceUrl) URL.revokeObjectURL(draftVoiceUrl);
    setDraftVoiceUrl(null);
    setDraftVoiceBlob(null);
    setDraftVoiceDurationMs(0);
    setDraftVoiceMime('audio/webm');
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
          <SendIcon />
        </button>
      );
    }
    if (draftVoiceUrl && !recording) {
      return (
        <button
          type="button"
          className="composer-mic"
          onClick={() => {
            discardDraftVoice();
            void startVoiceRecording();
          }}
          aria-label="Reenregistrer vocal"
        >
          <RedoIcon />
        </button>
      );
    }
    return (
      <button
        type="button"
        className={`composer-mic ${recording ? 'recording' : ''}`}
        onClick={() => {
          if (recording) {
            void stopVoiceRecording();
            return;
          }
          void startVoiceRecording();
        }}
        aria-label={recording ? 'Arreter enregistrement' : 'Demarrer vocal'}
      >
        {recording ? <StopIcon /> : <MicIcon />}
      </button>
    );
  }, [input, draftVoiceUrl, recording, startVoiceRecording, stopVoiceRecording]);

  if (!session) return <main className="centered">Chargement...</main>;

  return (
    <SecurityShell userId={session.userId}>
      <main className="mobile-screen mobile-conversation">
        <header className="conversation-header">
          <button type="button" className="icon-btn" onClick={() => router.push('/chat')} aria-label="Retour">
            <BackArrowIcon />
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
            disabled={conversationKind === 'group'}
          >
            <PhoneIcon />
          </button>
          <button type="button" className="icon-btn" onClick={() => router.push('/settings')} aria-label="Options">
            <MoreDotsIcon />
          </button>
        </header>

        <div className="security-pill">Chiffrement de bout en bout active</div>

        {conversationKind === 'group' && (
          <section className="inline-card">
            <div className="row">
              <button
                type="button"
                className="ghost-secondary"
                onClick={async () => {
                  if (!session) return;
                  const nextUserId = window.prompt('ID utilisateur a ajouter au groupe');
                  if (!nextUserId?.trim()) return;
                  try {
                    await addGroupMember(session, conversationId, nextUserId.trim());
                    await loadContext(session);
                    setStatus(`${nextUserId.trim().toLowerCase()} ajoute au groupe`);
                  } catch (err) {
                    setError(normalizeError(err, 'Erreur ajout membre'));
                  }
                }}
              >
                Ajouter membre
              </button>
              <button
                type="button"
                className="ghost-secondary"
                onClick={async () => {
                  if (!session) return;
                  const ok = window.confirm('Quitter ce groupe ?');
                  if (!ok) return;
                  try {
                    await leaveGroupConversation(session, conversationId);
                    router.push('/chat');
                  } catch (err) {
                    setError(normalizeError(err, 'Erreur sortie groupe'));
                  }
                }}
              >
                Quitter groupe
              </button>
            </div>
          </section>
        )}

        {incomingCallFrom && (
          <div className="incoming-banner">
            <p>{incomingCallFrom} vous appelle</p>
            <button
              type="button"
              className="ghost-primary"
              onClick={() => {
                setIncomingCallFrom(null);
                router.push(`/call?target=${encodeURIComponent(incomingCallFrom)}&autocall=0`);
              }}
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
              file={msg.file}
              mine={msg.senderId === session.userId}
              createdAt={msg.createdAt}
              status={msg.senderId === session.userId ? 'sent' : 'received'}
              expiresAt={msg.expiresAt}
            />
          ))}
        </section>

        {draftVoiceUrl && (
          <section className="voice-draft">
            <audio controls preload="metadata" src={draftVoiceUrl} />
            <p className="muted-text">Vocal: {Math.max(1, Math.round(draftVoiceDurationMs / 1000))}s</p>
            <div className="row">
              <button type="button" className="ghost-secondary" onClick={discardDraftVoice}>
                Ne pas envoyer
              </button>
              <button type="button" className="ghost-primary" onClick={sendDraftVoice}>
                Envoyer le vocal
              </button>
            </div>
          </section>
        )}

        <form className="composer" onSubmit={sendText}>
          <button
            type="button"
            className="icon-btn composer-left"
            aria-label="Joindre"
            onClick={() => fileInputRef.current?.click()}
          >
            <AttachmentIcon />
          </button>
          <input ref={fileInputRef} type="file" className="hidden-file-input" onChange={onPickAttachment} />
          <input
            className="composer-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Message"
            enterKeyHint="send"
          />
          {rightAction}
        </form>

        {recording && (
          <div className="recording-indicator">
            <span className="recording-dot" />
            <span>Enregistrement {Math.ceil(recordingMs / 1000)}s</span>
          </div>
        )}
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

function sortAndDedupe(items: DecryptedMessage[]): DecryptedMessage[] {
  const byId = new Map<string, DecryptedMessage>();
  for (const item of items) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => {
    const byCreatedAt = Date.parse(a.createdAt) - Date.parse(b.createdAt);
    if (byCreatedAt !== 0) return byCreatedAt;
    return a.id.localeCompare(b.id);
  });
}

function BackArrowIcon() {
  return (
    <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M15.7 4.3a1 1 0 0 1 0 1.4L9.4 12l6.3 6.3a1 1 0 0 1-1.4 1.4l-7-7a1 1 0 0 1 0-1.4l7-7a1 1 0 0 1 1.4 0Z" />
    </svg>
  );
}

function MoreDotsIcon() {
  return (
    <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 8a2 2 0 1 1 0-4 2 2 0 0 1 0 4Zm0 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4Zm0 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4Z" />
    </svg>
  );
}

function AttachmentIcon() {
  return (
    <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12.5 3a5.5 5.5 0 0 1 5.5 5.5v8a3.5 3.5 0 1 1-7 0v-7a2 2 0 1 1 4 0v6.5a1 1 0 1 1-2 0V9.5a0 0 0 0 0 0 0v6.5a1.5 1.5 0 0 0 3 0v-7.5A3.5 3.5 0 0 0 9 8.5v8a5.5 5.5 0 1 0 11 0v-8A5.5 5.5 0 0 0 12.5 3Z" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 1 1-6 0V6a3 3 0 0 1 3-3Zm-6 9a1 1 0 0 1 1 1 5 5 0 0 0 10 0 1 1 0 1 1 2 0 7 7 0 0 1-6 6.93V22h2a1 1 0 1 1 0 2H9a1 1 0 1 1 0-2h2v-2.07A7 7 0 0 1 5 13a1 1 0 0 1 1-1Z" />
    </svg>
  );
}

function PhoneIcon() {
  return (
    <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7.1 2.6a1.5 1.5 0 0 1 1.7.9l1.2 2.9a1.5 1.5 0 0 1-.3 1.6L8.3 9.4a13.4 13.4 0 0 0 6.3 6.3l1.4-1.4a1.5 1.5 0 0 1 1.6-.3l2.9 1.2a1.5 1.5 0 0 1 .9 1.7l-.4 2.3a1.5 1.5 0 0 1-1.5 1.3c-9.6 0-17.4-7.8-17.4-17.4a1.5 1.5 0 0 1 1.3-1.5l2.3-.4Z" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2.3 11.1 20.9 2.3c.8-.4 1.7.3 1.5 1.2l-3.1 17.8c-.1.8-1.1 1.1-1.6.6l-4.6-4.4-3.8 3a1 1 0 0 1-1.6-.7l-.4-5.2-5-2c-.8-.3-.8-1.4 0-1.7Zm4.9.6 2.6 1.1 7.6-6.3-6.2 7.6.2 3.2 1.8-1.4a1 1 0 0 1 1.3 0l3 2.9 2.1-12.2-12.4 5.1Z" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 8h8v8H8z" />
    </svg>
  );
}

function RedoIcon() {
  return (
    <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5a7 7 0 0 1 6.3 4H21a1 1 0 1 1 0 2h-4a1 1 0 0 1-1-1V6a1 1 0 1 1 2 0v1a9 9 0 1 0 2.5 7.2 1 1 0 1 1 2 .3A11 11 0 1 1 12 5Z" />
    </svg>
  );
}
