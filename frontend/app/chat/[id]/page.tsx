"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import SecurityShell from '@/components/SecurityShell';
import MessageBubble from '@/components/MessageBubble';
import { getSession } from '@/lib/session';
import { addGroupMember, fetchConversationDetail, fetchMessages, fetchPreKeyBundle, leaveGroupConversation, sendMessage, updateConversationSettings } from '@/lib/api';
import { encryptForParticipants } from '@/lib/crypto';
import { decryptForUser, type DecryptedMessage } from '@/lib/messages';
import { describeDisappearingTimer, useGhostPreferences } from '@/lib/preferences';
import { hasRatchetSession, createOutboundSession, encryptRatchet } from '@/lib/ratchet';
import { useRealtime } from '@/lib/useRealtime';
import { getSupabaseClient } from '@/lib/supabase';
import { type VoicePresetId, VOICE_PRESETS, transformVoiceBlob } from '@/lib/voice';
import type { EncryptedMessage, Session } from '@/types';

const MESSAGE_POLL_INTERVAL_MS = 1_500;
const MAX_POLL_INTERVAL_MS = 120_000;
const DISAPPEARING_OPTIONS: Array<{ value: 0 | 1800 | 3600 | 86400 | 604800; label: string }> = [
  { value: 0, label: 'Off' },
  { value: 1800, label: '30 min' },
  { value: 3600, label: '1 h' },
  { value: 86400, label: '24 h' },
  { value: 604800, label: '7 j' },
];

export default function ConversationPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const preferences = useGhostPreferences();
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
  const [draftVoiceSourceBlob, setDraftVoiceSourceBlob] = useState<Blob | null>(null);
  const [draftVoiceBlob, setDraftVoiceBlob] = useState<Blob | null>(null);
  const [draftVoiceMime, setDraftVoiceMime] = useState<string>('audio/webm');
  const [draftVoiceDurationMs, setDraftVoiceDurationMs] = useState(0);
  const [draftVoicePreset, setDraftVoicePreset] = useState<VoicePresetId>('natural');
  const [voiceProcessing, setVoiceProcessing] = useState(false);
  const [conversationTimer, setConversationTimer] = useState<0 | 1800 | 3600 | 86400 | 604800>(preferences.disappearingTimerSeconds);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);

  const dismissedCallInvitesRef = useRef<Set<string>>(new Set());
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordStreamRef = useRef<MediaStream | null>(null);
  const recordChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<number | null>(null);
  const recordStartRef = useRef<number>(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const voiceDraftTaskRef = useRef(0);

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
    detailRef.current = detail;
    detailFetchedAtRef.current = Date.now();
    setConversationKind(detail.kind);
    setConversationTimer(detail.disappearingTimerSeconds);
    if (detail.kind === 'group') {
      setPeerId(detail.title?.trim() || 'Groupe');
      return;
    }
    const peer = detail.participants.find((p) => p.id !== s.userId)?.id ?? 'Contact';
    setPeerId(peer);
  };

  // Track already-decrypted message IDs to avoid re-decrypting on every poll
  const knownIdsRef = useRef<Set<string>>(new Set());

  const loadMessages = async (s: Session) => {
    const encrypted = await fetchMessages(s, conversationId);
    console.debug('[GS:poll] fetched', encrypted.length, 'messages, known:', knownIdsRef.current.size);
    // Only decrypt messages we haven't seen yet
    const newMessages = encrypted.filter((m) => !knownIdsRef.current.has(m.id));
    if (newMessages.length === 0 && knownIdsRef.current.size > 0) return;

    console.debug('[GS:poll] new messages to decrypt:', newMessages.length);
    for (const m of newMessages) {
      console.debug('[GS:poll]   msg', m.id, 'wrappedKeys:', Object.keys(m.wrappedKeys), 'hasMyKey:', !!(m.wrappedKeys[s.userId] || m.wrappedKeys[s.userId.trim().toLowerCase()]));
    }

    const newDecrypted = await Promise.all(
      newMessages.map(async (m) => {
        const result = await decryptForUser(s.userId, m, conversationId);
        if (!result) {
          console.warn('[GS:poll] FAILED to decrypt msg', m.id, '- userId:', s.userId, 'keys:', Object.keys(m.wrappedKeys));
          // Show undecryptable messages as placeholder instead of hiding them
          return {
            id: m.id,
            senderId: m.senderId ?? 'unknown',
            kind: 'text' as const,
            text: '\u{1F512} Message chiffre (indechiffrable)',
            createdAt: m.createdAt,
            expiresAt: m.expiresAt,
          } satisfies DecryptedMessage;
        }
        return result;
      })
    );
    const validNew = newDecrypted.filter((m): m is DecryptedMessage => Boolean(m));

    console.debug('[GS:poll] decrypted', validNew.length, '/', newMessages.length);

    for (const m of validNew) knownIdsRef.current.add(m.id);

    if (validNew.length > 0) {
      setMessages((prev) => sortAndDedupe([...prev, ...validNew]));
    }
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
    let delay = MESSAGE_POLL_INTERVAL_MS;
    let timer: number;
    const poll = () => {
      loadMessages(session)
        .then(() => { delay = MESSAGE_POLL_INTERVAL_MS; })
        .catch((err: unknown) => {
          if (err instanceof Error && err.message.includes('429')) {
            delay = Math.min(delay * 2, MAX_POLL_INTERVAL_MS);
          }
        })
        .finally(() => { timer = window.setTimeout(poll, delay); });
    };
    void loadMessages(session).catch(() => null);
    timer = window.setTimeout(poll, delay);
    return () => window.clearTimeout(timer);
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
    console.debug('[GS:realtime] event received:', event.type, 'convId:', event.conversationId);
    if (!session) return;
    if (event.type !== 'new_message' || event.conversationId !== conversationId || !event.message) return;
    // Skip if already shown (optimistic display or previous poll)
    if (knownIdsRef.current.has(event.message.id)) return;
    console.debug('[GS:realtime] new msg', event.message.id, 'wrappedKeys:', Object.keys(event.message.wrappedKeys));
    const decrypted = await decryptForUser(session.userId, event.message, conversationId);
    if (decrypted) {
      console.debug('[GS:realtime] decrypted OK:', decrypted.id);
      knownIdsRef.current.add(decrypted.id);
      setMessages((prev) => sortAndDedupe([...prev, decrypted]));
    } else {
      console.warn('[GS:realtime] FAILED to decrypt msg', event.message.id, '- userId:', session.userId, 'keys:', Object.keys(event.message.wrappedKeys));
    }
  });

  // Keep conversation detail fresh enough to pick up key rotation across devices.
  const detailRef = useRef<Awaited<ReturnType<typeof fetchConversationDetail>> | null>(null);
  const detailFetchedAtRef = useRef<number>(0);
  const DETAIL_MAX_AGE_MS = 10_000;

  const getDetail = async (
    s: Session,
    options?: { forceRefresh?: boolean; maxAgeMs?: number }
  ) => {
    const maxAgeMs = options?.maxAgeMs ?? DETAIL_MAX_AGE_MS;
    const isStale = Date.now() - detailFetchedAtRef.current > maxAgeMs;
    if (!detailRef.current || options?.forceRefresh || isStale) {
      detailRef.current = await fetchConversationDetail(s, conversationId);
      detailFetchedAtRef.current = Date.now();
    }
    return detailRef.current;
  };

  const encryptAndSend = async (s: Session, plaintext: string): Promise<DecryptedMessage | null> => {
    // Force a fresh participant-key read before each send.
    const detail = await getDetail(s, { forceRefresh: true });
    const peer = detail.kind === 'direct'
      ? detail.participants.find((p) => p.id !== s.userId)
      : undefined;

    // Try Double Ratchet for direct conversations
    if (detail.kind === 'direct' && peer) {
      try {
        const hasSession = await hasRatchetSession(conversationId);
        if (!hasSession && peer.identityKey && peer.signedPrekey && peer.signedPrekeySignature && peer.registrationId) {
          const bundle = await fetchPreKeyBundle(s, peer.id);
          await createOutboundSession(s.userId, conversationId, bundle);
        }

        if (await hasRatchetSession(conversationId)) {
          const encrypted = await encryptRatchet(s.userId, conversationId, plaintext, s.userId, peer.id);
          const sent = await sendMessage(s, conversationId, {
            ...encrypted,
            expiresInSeconds: conversationTimer > 0 ? conversationTimer : undefined,
          });
          return buildSenderMessage(sent, s.userId, plaintext);
        }
      } catch {
        // Fallback to ECDH/RSA on ratchet failure
      }
    }

    // Fallback: existing ECDH/RSA encryption
    const participantList = detail.participants.map((p) => ({ id: p.id, publicKey: p.publicKey, ecdhPublicKey: p.ecdhPublicKey }));
    console.debug('[GS:send] encrypting for participants:', participantList.map((p) => ({ id: p.id, hasEcdh: !!p.ecdhPublicKey })));
    const encrypted = await encryptForParticipants(
      plaintext,
      participantList,
      conversationId,
      s.userId
    );
    console.debug('[GS:send] wrappedKeys:', Object.keys(encrypted.wrappedKeys), 'hasEphemeral:', !!encrypted.ephemeralPublicKey);
    const sent = await sendMessage(s, conversationId, {
      ...encrypted,
      expiresInSeconds: conversationTimer > 0 ? conversationTimer : undefined,
    });
    return buildSenderMessage(sent, s.userId, plaintext);
  };

  const sendText = async (e: FormEvent) => {
    e.preventDefault();
    if (!session || !input.trim()) return;
    const text = input.trim();
    setInput('');

    try {
      const decrypted = await encryptAndSend(session, text);
      if (decrypted) {
        knownIdsRef.current.add(decrypted.id);
        setMessages((prev) => sortAndDedupe([...prev, decrypted]));
      }
    } catch (err) {
      setInput(text);
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
      setError(null);
      setRecordingMs(0);
      setRecording(true);

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) recordChunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        setError('Enregistrement vocal interrompu');
        cleanupVoiceRecorder();
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
      const blob = await new Promise<Blob>((resolve, reject) => {
        const rec = recorderRef.current!;
        const timeout = window.setTimeout(() => reject(new Error('recording timeout')), 4000);
        rec.onstop = () => {
          window.clearTimeout(timeout);
          const result = new Blob(recordChunksRef.current, { type: rec.mimeType || 'audio/webm' });
          if (result.size === 0) {
            reject(new Error('empty recording'));
            return;
          }
          resolve(result);
        };
        rec.onerror = () => {
          window.clearTimeout(timeout);
          reject(new Error('recording failed'));
        };
        rec.requestData();
        rec.stop();
      });

      const duration = Math.max(800, Date.now() - recordStartRef.current);
      await prepareVoiceDraft(blob, duration, 'natural');
    } catch {
      setError('Erreur de preparation du vocal');
    } finally {
      cleanupVoiceRecorder();
    }
  };

  const sendDraftVoice = async () => {
    if (!session || !draftVoiceBlob) return;
    try {
      const dataBase64 = arrayBufferToBase64(await draftVoiceBlob.arrayBuffer());
      const payload = JSON.stringify({
        type: 'voice',
        mimeType: draftVoiceMime || 'audio/webm',
        dataBase64,
        durationMs: draftVoiceDurationMs || 1000,
      });
      const decrypted = await encryptAndSend(session, payload);
      if (decrypted) {
        knownIdsRef.current.add(decrypted.id);
        setMessages((prev) => sortAndDedupe([...prev, decrypted]));
      }
      discardDraftVoice();
    } catch (err) {
      setError(normalizeError(err, "Erreur d'envoi vocal"));
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
      const dataBase64 = arrayBufferToBase64(await file.arrayBuffer());
      const payload = JSON.stringify({
        type: 'file',
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        dataBase64,
        sizeBytes: file.size,
      });

      const decrypted = await encryptAndSend(session, payload);
      if (decrypted) {
        knownIdsRef.current.add(decrypted.id);
        setMessages((prev) => sortAndDedupe([...prev, decrypted]));
      }
    } catch (err) {
      setError(normalizeError(err, "Erreur envoi piece jointe"));
    }
  };

  const discardDraftVoice = () => {
    if (draftVoiceUrl) URL.revokeObjectURL(draftVoiceUrl);
    setDraftVoiceUrl(null);
    setDraftVoiceSourceBlob(null);
    setDraftVoiceBlob(null);
    setDraftVoiceDurationMs(0);
    setDraftVoiceMime('audio/webm');
    setDraftVoicePreset('natural');
    setVoiceProcessing(false);
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

  const groupedMessages = useMemo(() => {
    const groups: { label: string; items: DecryptedMessage[] }[] = [];
    let currentLabel = '';
    for (const msg of messages) {
      const label = dateSeparatorLabel(msg.createdAt);
      if (label !== currentLabel) {
        currentLabel = label;
        groups.push({ label, items: [msg] });
      } else {
        groups[groups.length - 1].items.push(msg);
      }
    }
    return groups;
  }, [messages]);

  if (!session) return <main className="centered">Chargement...</main>;

  async function prepareVoiceDraft(blob: Blob, durationMs: number, presetId: VoicePresetId) {
    const taskId = Date.now();
    voiceDraftTaskRef.current = taskId;
    setVoiceProcessing(true);
    setDraftVoiceSourceBlob(blob);
    setDraftVoicePreset(presetId);
    try {
      const processed = await transformVoiceBlob(blob, presetId);
      if (voiceDraftTaskRef.current !== taskId) return;
      const nextUrl = URL.createObjectURL(processed);
      setDraftVoiceUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return nextUrl;
      });
      setDraftVoiceBlob(processed);
      setDraftVoiceMime(processed.type || blob.type || 'audio/webm');
      setDraftVoiceDurationMs(durationMs);
    } catch {
      if (voiceDraftTaskRef.current !== taskId) return;
      setError('Erreur traitement vocal');
    } finally {
      if (voiceDraftTaskRef.current === taskId) {
        setVoiceProcessing(false);
      }
    }
  }

  return (
    <SecurityShell userId={session.userId}>
      <main className="mobile-conversation">
        <header className="conversation-header">
          <button type="button" className="icon-btn" onClick={() => router.push('/chat')} aria-label="Retour">
            <BackArrowIcon />
          </button>
          <div className="conv-avatar" aria-hidden="true">{peerId.slice(0, 1).toUpperCase()}</div>
          <div className="conv-header-info">
            <strong>{peerId || 'Contact'}</strong>
            <span>{status} · {describeDisappearingTimer(conversationTimer)}</span>
          </div>
          <div className="conv-header-actions">
            <button
              type="button"
              className="icon-btn"
              onClick={() => setSettingsOpen(true)}
              aria-label="Parametres de la conversation"
            >
              <TuneIcon />
            </button>
            {conversationKind !== 'group' && (
              <button
                type="button"
                className="icon-btn"
                onClick={() => router.push(`/call?target=${encodeURIComponent(peerId)}&autocall=1`)}
                aria-label="Appeler"
              >
                <PhoneIcon />
              </button>
            )}
          </div>
        </header>

        {conversationKind === 'group' && (
          <div className="conv-group-bar">
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
        )}

        {incomingCallFrom && (
          <div className="incoming-banner">
            <p>{preferences.hideCallerIdentity ? 'Appel entrant securise' : `${incomingCallFrom} vous appelle`}</p>
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
          <div className="security-pill">Chiffrement de bout en bout active</div>
          <div className="security-pill secondary">Messages ephemeres: {describeDisappearingTimer(conversationTimer)}</div>

          {messages.length === 0 && (
            <div className="conv-empty">
              <p>Aucun message</p>
              <p>Demarrez la conversation</p>
            </div>
          )}

          {groupedMessages.map((group) => (
            <div key={group.label} className="message-group">
              <div className="date-separator"><span>{group.label}</span></div>
              {group.items.map((msg) => (
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
            </div>
          ))}
        </section>

        {draftVoiceUrl && (
          <section className="voice-draft">
            <audio controls preload="metadata" src={draftVoiceUrl} />
            <p className="muted-text">
              Vocal: {Math.max(1, Math.round(draftVoiceDurationMs / 1000))}s · Voix {VOICE_PRESETS.find((preset) => preset.id === draftVoicePreset)?.label.toLowerCase()}
            </p>
            <div className="voice-presets">
              {VOICE_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={`voice-preset-card ${draftVoicePreset === preset.id ? 'active' : ''}`}
                  onClick={() => {
                    if (!draftVoiceSourceBlob || voiceProcessing || draftVoicePreset === preset.id) return;
                    void prepareVoiceDraft(draftVoiceSourceBlob, draftVoiceDurationMs, preset.id);
                  }}
                  disabled={voiceProcessing}
                >
                  <span className="preset-emoji" aria-hidden="true">{preset.emoji}</span>
                  <span className="preset-label">{preset.label}</span>
                </button>
              ))}
            </div>
            {voiceProcessing && <p className="muted-text">Traitement du vocal...</p>}
            <div className="row">
              <button type="button" className="ghost-secondary" onClick={discardDraftVoice}>
                Ne pas envoyer
              </button>
              <button type="button" className="ghost-primary" onClick={sendDraftVoice} disabled={voiceProcessing}>
                Envoyer le vocal
              </button>
            </div>
          </section>
        )}

        {recording && (
          <div className="recording-indicator">
            <span className="recording-dot" />
            <span>Enregistrement {Math.ceil(recordingMs / 1000)}s</span>
          </div>
        )}

        {error && <div className="conv-error-toast">{error}</div>}

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

        {settingsOpen && (
          <div className="sheet-backdrop" onClick={() => setSettingsOpen(false)}>
            <section className="sheet" onClick={(event) => event.stopPropagation()}>
              <h2>Parametres de la discussion</h2>
              <p className="muted-text">Le timer choisi s applique aux prochains messages de cette conversation.</p>
              <div className="settings-chip-row">
                {DISAPPEARING_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`settings-chip ${conversationTimer === option.value ? 'active' : ''}`}
                    disabled={settingsSaving}
                    onClick={async () => {
                      if (!session || settingsSaving || conversationTimer === option.value) return;
                      setSettingsSaving(true);
                      try {
                        const result = await updateConversationSettings(session, conversationId, { disappearingTimerSeconds: option.value });
                        setConversationTimer(result.disappearingTimerSeconds);
                        if (detailRef.current) {
                          detailRef.current = { ...detailRef.current, disappearingTimerSeconds: result.disappearingTimerSeconds };
                        }
                        setStatus(`Messages ephemeres: ${describeDisappearingTimer(result.disappearingTimerSeconds)}`);
                      } catch (err) {
                        setError(normalizeError(err, 'Erreur mise a jour conversation'));
                      } finally {
                        setSettingsSaving(false);
                      }
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <div className="row">
                <button type="button" className="ghost-secondary" onClick={() => setSettingsOpen(false)}>
                  Fermer
                </button>
              </div>
            </section>
          </div>
        )}
      </main>
    </SecurityShell>
  );
}

/**
 * Build a DecryptedMessage for the sender from the API response and plaintext.
 * The sender already knows the plaintext — no need to decrypt their own message.
 */
function buildSenderMessage(sent: EncryptedMessage, senderId: string, plaintext: string): DecryptedMessage {
  let voice: DecryptedMessage['voice'];
  let file: DecryptedMessage['file'];
  try {
    const parsed = JSON.parse(plaintext) as {
      type?: string; mimeType?: string; dataBase64?: string;
      durationMs?: number; name?: string; sizeBytes?: number;
    };
    if (parsed.type === 'voice' && parsed.mimeType && parsed.dataBase64) {
      voice = { mimeType: parsed.mimeType, dataBase64: parsed.dataBase64, durationMs: Math.max(0, Number(parsed.durationMs ?? 0)) };
    }
    if (parsed.type === 'file' && parsed.mimeType && parsed.dataBase64 && parsed.name) {
      file = { name: parsed.name, mimeType: parsed.mimeType, dataBase64: parsed.dataBase64, sizeBytes: Math.max(0, Number(parsed.sizeBytes ?? 0)) };
    }
  } catch { /* plain text message */ }

  return {
    id: sent.id,
    senderId,
    kind: voice ? 'voice' : file ? 'file' : 'text',
    text: voice || file ? undefined : plaintext,
    voice,
    file,
    createdAt: sent.createdAt,
    expiresAt: sent.expiresAt,
  };
}

function normalizeError(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback;
  const message = err.message.toLowerCase();
  if (message.includes('forbidden')) return 'Action non autorisee.';
  if (message.includes('failed to fetch')) return 'Hors ligne. Reessayez.';
  return fallback;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    chunks.push(String.fromCharCode(...slice));
  }
  return btoa(chunks.join(''));
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

function dateSeparatorLabel(raw: string): string {
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((today.getTime() - msgDay.getTime()) / 86400000);
  if (diffDays === 0) return "Aujourd'hui";
  if (diffDays === 1) return 'Hier';
  return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

function BackArrowIcon() {
  return (
    <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M15.7 4.3a1 1 0 0 1 0 1.4L9.4 12l6.3 6.3a1 1 0 0 1-1.4 1.4l-7-7a1 1 0 0 1 0-1.4l7-7a1 1 0 0 1 1.4 0Z" />
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

function TuneIcon() {
  return (
    <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7h9a2.5 2.5 0 1 0 0-2H4a1 1 0 1 0 0 2Zm16 0a1 1 0 1 0 0-2h-1a1 1 0 1 0 0 2h1ZM4 13h3a2.5 2.5 0 1 0 0-2H4a1 1 0 1 0 0 2Zm9 0h7a1 1 0 1 0 0-2h-7a1 1 0 1 0 0 2ZM4 19h11a2.5 2.5 0 1 0 0-2H4a1 1 0 1 0 0 2Zm16 0a1 1 0 1 0 0-2h-3a1 1 0 1 0 0 2h3Z" />
    </svg>
  );
}
