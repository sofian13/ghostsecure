"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import SecurityShell from '@/components/SecurityShell';
import MobileTabs from '@/components/MobileTabs';
import { createConversation } from '@/lib/api';
import { callSession, type IncomingOffer, type InviteRow, type VoicePreset } from '@/lib/callSession';
import { getSession } from '@/lib/session';
import { getSupabaseClient } from '@/lib/supabase';

const VOICE_PRESETS: { value: VoicePreset; label: string; emoji: string }[] = [
  { value: 'normal', label: 'Normal', emoji: '\uD83C\uDFA4' },
  { value: 'ghost', label: 'Ghost', emoji: '\uD83D\uDC7B' },
  { value: 'robot', label: 'Robot', emoji: '\uD83E\uDD16' },
  { value: 'deep', label: 'Deep', emoji: '\uD83C\uDF0A' },
  { value: 'vader', label: 'Vader', emoji: '\u2694\uFE0F' },
  { value: 'anonymous', label: 'Anonymous', emoji: '\uD83C\uDFAD' },
  { value: 'grave', label: 'Grave', emoji: '\uD83D\uDD0A' },
];

const REJECT_COOLDOWN_MS = 15000;

function normalizeUserId(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

export default function CallPage() {
  const router = useRouter();
  const live = useSyncExternalStore(callSession.subscribe, callSession.getSnapshot, callSession.getSnapshot);
  const [userId, setUserId] = useState<string | null>(null);
  const [targetId, setTargetId] = useState('');
  const [autoCall, setAutoCall] = useState(false);
  const [autoAccept, setAutoAccept] = useState(false);
  const [autoAcceptInviteId, setAutoAcceptInviteId] = useState('');
  const [incomingOffer, setIncomingOffer] = useState<IncomingOffer | null>(null);
  const [history, setHistory] = useState<InviteRow[]>([]);
  const autoCalledRef = useRef(false);
  const autoAcceptedRef = useRef(false);
  const incomingPollRef = useRef<number | null>(null);
  const lastIncomingInviteRef = useRef<string | null>(null);
  const rejectCooldownRef = useRef<Record<string, number>>({});
  const liveCallActiveRef = useRef(live.callActive);
  const incomingOfferRef = useRef<IncomingOffer | null>(incomingOffer);

  const displayTarget = normalizeUserId(incomingOffer?.fromUserId || (live.callActive ? live.targetId : targetId));
  const hasTarget = displayTarget !== '';

  useEffect(() => {
    liveCallActiveRef.current = live.callActive;
    incomingOfferRef.current = incomingOffer;
  }, [incomingOffer, live.callActive]);

  useEffect(() => {
    const session = getSession();
    if (!session) {
      router.replace('/login');
      return;
    }
    const me = normalizeUserId(session.userId);
    const query = new URLSearchParams(window.location.search);
    const nextTarget = normalizeUserId(query.get('target'));
    setUserId(me);
    setTargetId(nextTarget);
    setAutoCall(query.get('autocall') === '1');
    setAutoAccept(query.get('autoaccept') === '1');
    setAutoAcceptInviteId(query.get('invite') ?? '');
    if (nextTarget) callSession.setTarget(nextTarget);
  }, [router]);

  useEffect(() => {
    if (!userId) return;
    void loadHistory(userId).then(setHistory);

    const supabase = getSupabaseClient();
    const inviteChannel = supabase
      .channel(`call-invite:${userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'call_invite' }, async (payload) => {
        const row = (payload.new || payload.old) as InviteRow | undefined;
        if (!row) return;
        handleInviteEvent(row);
        const nextHistory = await loadHistory(userId);
        setHistory(nextHistory);
      })
      .subscribe();

    void hydratePendingInvite(userId);
    startIncomingPolling(userId);

    return () => {
      void supabase.removeChannel(inviteChannel);
      if (incomingPollRef.current) window.clearInterval(incomingPollRef.current);
      incomingPollRef.current = null;
    };
  }, [userId]);

  useEffect(() => {
    if (!autoCall || autoCalledRef.current || !userId || !targetId || live.callActive) return;
    autoCalledRef.current = true;
    void callSession.startCall(userId, targetId);
  }, [autoCall, live.callActive, targetId, userId]);

  useEffect(() => {
    if (!autoAccept || autoAcceptedRef.current || !userId || !incomingOffer) return;
    if (autoAcceptInviteId && incomingOffer.inviteId !== autoAcceptInviteId) return;
    autoAcceptedRef.current = true;
    const offer = incomingOffer;
    setIncomingOffer(null);
    void callSession.acceptIncoming(userId, offer);
  }, [autoAccept, autoAcceptInviteId, incomingOffer, userId]);

  if (!userId) return <main className="centered">Loading...</main>;

  const historyRows = history.map((row) => {
    const incoming = normalizeUserId(row.target_user_id) === userId;
    const peer = incoming ? row.from_user_id : row.target_user_id;
    return {
      id: row.id,
      incoming,
      peer,
      state: row.status,
      date: row.created_at ?? row.updated_at ?? new Date().toISOString(),
    };
  });

  const callPhase = incomingOffer
    ? 'Appel entrant'
    : live.connected
      ? 'En appel'
      : live.callActive
        ? 'Connexion audio'
        : 'Pret';

  const stageStatus = live.connected ? 'Canal audio securise actif' : live.statusText;

  const goToConversation = async () => {
    const session = getSession();
    if (!session || !displayTarget) {
      router.push('/chat');
      return;
    }
    const conversation = await createConversation(session, displayTarget);
    router.push(`/chat/${encodeURIComponent(conversation.id)}`);
  };

  const recallFromHistory = async (peer: string) => {
    const session = getSession();
    if (!session) {
      router.replace('/login');
      return;
    }
    const conversation = await createConversation(session, normalizeUserId(peer));
    router.push(`/chat/${encodeURIComponent(conversation.id)}?autocall=1`);
  };

  return (
    <SecurityShell userId={userId}>
      <main className="mobile-screen call-mobile">
        <header className="mobile-header">
          <div>
            <h1>Appels</h1>
            <p className="muted-text">{hasTarget ? 'Interface d appel active' : 'Historique securise'}</p>
          </div>
        </header>

        {hasTarget && (
          <section className="call-stage">
            <div className="call-stage-orbit" aria-hidden="true" />
            <div className="call-stage-avatar" aria-hidden="true">{displayTarget.slice(0, 1).toUpperCase()}</div>
            <p className="call-stage-kicker">{callPhase}</p>
            <h2>{displayTarget}</h2>
            <p className={`call-stage-status ${live.connected ? 'ok-text' : 'muted-text'}`}>{stageStatus}</p>

            <div className="call-action-grid">
              <button
                type="button"
                className={`call-action-button ${live.speakerOn ? 'active' : ''}`}
                onClick={() => void callSession.toggleSpeaker()}
                disabled={!live.callActive}
              >
                <SpeakerIcon />
                <span>Haut-parleur</span>
              </button>
              <button
                type="button"
                className="call-action-button"
                onClick={() => void goToConversation()}
                disabled={!live.callActive}
              >
                <LeaveCallIcon />
                <span>Quitter</span>
              </button>
            </div>

            <div className="call-voice-strip">
              {VOICE_PRESETS.map((preset) => (
                <button
                  key={preset.value}
                  type="button"
                  className={`call-voice-chip ${live.voicePreset === preset.value ? 'active' : ''}`}
                  onClick={() => void callSession.setVoicePreset(preset.value)}
                >
                  <span className="preset-emoji">{preset.emoji}</span>
                  <span>{preset.label}</span>
                </button>
              ))}
            </div>

            {incomingOffer && !live.callActive ? (
              <div className="call-primary-row">
                <button
                  type="button"
                  className="call-start-button"
                  onClick={() => {
                    const offer = incomingOffer;
                    lastIncomingInviteRef.current = offer.inviteId;
                    setIncomingOffer(null);
                    void callSession.acceptIncoming(userId, offer);
                  }}
                >
                  <PhoneIcon />
                  <span>Repondre</span>
                </button>
                <button
                  type="button"
                  className="call-hangup-button"
                  onClick={() => {
                    const offer = incomingOffer;
                    rejectCooldownRef.current[offer.fromUserId] = Date.now() + REJECT_COOLDOWN_MS;
                    lastIncomingInviteRef.current = offer.inviteId;
                    setIncomingOffer(null);
                    void callSession.rejectIncoming(userId, offer);
                  }}
                >
                  <HangupIcon />
                  <span>Refuser</span>
                </button>
              </div>
            ) : live.callActive ? (
              <div className="call-primary-row">
                <button type="button" className="call-hangup-button wide" onClick={() => void callSession.endCall()}>
                  <HangupIcon />
                  <span>Raccrocher</span>
                </button>
              </div>
            ) : (
              <div className="call-primary-row">
                <button type="button" className="call-start-button wide" onClick={() => void callSession.startCall(userId, displayTarget)}>
                  <PhoneIcon />
                  <span>Appeler</span>
                </button>
              </div>
            )}
          </section>
        )}

        <section className="call-list">
          {historyRows.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon" aria-hidden="true">
                <PhoneIcon />
              </div>
              <p>Aucun appel recent</p>
            </div>
          ) : (
            historyRows.map((item) => (
              <div key={item.id} className="call-row">
                <div className="chat-avatar small" aria-hidden="true">{item.peer.slice(0, 1).toUpperCase()}</div>
                <div className="chat-content">
                  <div className="chat-topline">
                    <strong>{item.peer}</strong>
                    <span>{new Date(item.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                  <p className="muted-text">{item.incoming ? 'Entrant' : 'Sortant'} - {item.state}</p>
                </div>
                <button type="button" className="ghost-primary" onClick={() => void recallFromHistory(item.peer)}>
                  Rappeler
                </button>
              </div>
            ))
          )}
        </section>

        <MobileTabs />
      </main>
    </SecurityShell>
  );

  function applyIncomingOffer(row: InviteRow) {
    const from = normalizeUserId(row.from_user_id);
    if (!from || row.status !== 'pending') return;
    const cooldownUntil = rejectCooldownRef.current[from] ?? 0;
    if (Date.now() < cooldownUntil) return;
    if (row.id === lastIncomingInviteRef.current) return;
    if (liveCallActiveRef.current) return;
    setIncomingOffer({
      inviteId: row.id,
      callId: row.call_id,
      fromUserId: from,
      sdp: row.offer_sdp,
    });
    setTargetId(from);
  }

  function handleInviteEvent(row: InviteRow) {
    const me = normalizeUserId(userId);
    const from = normalizeUserId(row.from_user_id);
    const to = normalizeUserId(row.target_user_id);

    if (row.status === 'pending' && to === me) {
      applyIncomingOffer(row);
      return;
    }

    if (to === me && (row.status === 'accepted' || row.status === 'rejected' || row.status === 'ended')) {
      if (incomingOfferRef.current?.inviteId === row.id) setIncomingOffer(null);
      lastIncomingInviteRef.current = row.id;
    }

    if (from === me && row.status === 'rejected' && liveCallActiveRef.current) {
      setIncomingOffer(null);
    }
  }

  async function hydratePendingInvite(me: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { data } = await supabase
      .from('call_invite')
      .select('id,call_id,from_user_id,target_user_id,offer_sdp,answer_sdp,status')
      .eq('target_user_id', me)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) return;
    applyIncomingOffer(data as InviteRow);
  }

  function startIncomingPolling(me: string) {
    if (incomingPollRef.current) window.clearInterval(incomingPollRef.current);
    const supabase = getSupabaseClient();
    incomingPollRef.current = window.setInterval(async () => {
      const { data } = await supabase
        .from('call_invite')
        .select('id,call_id,from_user_id,target_user_id,offer_sdp,answer_sdp,status')
        .eq('target_user_id', me)
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!data) return;
      applyIncomingOffer(data as InviteRow);
    }, 700);
  }
}

async function loadHistory(me: string): Promise<InviteRow[]> {
  const supabase = getSupabaseClient();
  const { data } = await supabase
    .from('call_invite')
    .select('id,call_id,from_user_id,target_user_id,offer_sdp,answer_sdp,status,created_at,updated_at')
    .or(`from_user_id.eq.${me},target_user_id.eq.${me}`)
    .order('created_at', { ascending: false })
    .limit(40);
  return (data ?? []) as InviteRow[];
}

function PhoneIcon() {
  return (
    <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7.1 2.6a1.5 1.5 0 0 1 1.7.9l1.2 2.9a1.5 1.5 0 0 1-.3 1.6L8.3 9.4a13.4 13.4 0 0 0 6.3 6.3l1.4-1.4a1.5 1.5 0 0 1 1.6-.3l2.9 1.2a1.5 1.5 0 0 1 .9 1.7l-.4 2.3a1.5 1.5 0 0 1-1.5 1.3c-9.6 0-17.4-7.8-17.4-17.4a1.5 1.5 0 0 1 1.3-1.5l2.3-.4Z" />
    </svg>
  );
}

function SpeakerIcon() {
  return (
    <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14.6 3.3a1 1 0 0 1 1.4.9v15.6a1 1 0 0 1-1.7.7L9.4 16H6a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h3.4l4.9-4.7a1 1 0 0 1 .3-.2Zm3.8 4.6a1 1 0 0 1 1.4 0 6 6 0 0 1 0 8.5 1 1 0 0 1-1.4-1.4 4 4 0 0 0 0-5.7 1 1 0 0 1 0-1.4Zm-2.8 2.8a1 1 0 0 1 1.4 0 2 2 0 0 1 0 2.8 1 1 0 1 1-1.4-1.4.1.1 0 0 0 0-.1.1.1 0 0 0 0-.1 1 1 0 0 1 0-1.2Z" />
    </svg>
  );
}

function LeaveCallIcon() {
  return (
    <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M11 4a1 1 0 1 1 0 2H6v12h5a1 1 0 1 1 0 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5Zm4.3 3.3a1 1 0 0 1 1.4 0l3.6 3.6a1.5 1.5 0 0 1 0 2.2l-3.6 3.6a1 1 0 1 1-1.4-1.4l1.9-1.9H10a1 1 0 1 1 0-2h7.2l-1.9-1.9a1 1 0 0 1 0-1.4Z" />
    </svg>
  );
}

function HangupIcon() {
  return (
    <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6.4 14.9c3.7-2.4 7.5-2.4 11.2 0l1.2.8a1.7 1.7 0 0 1 .7 2l-.9 2.4a1.7 1.7 0 0 1-2.1 1l-2.8-1a1.7 1.7 0 0 1-1-1.8l.2-1.1a9 9 0 0 0-2 0l.2 1.1a1.7 1.7 0 0 1-1 1.8l-2.8 1a1.7 1.7 0 0 1-2.1-1l-.9-2.4a1.7 1.7 0 0 1 .7-2l1.2-.8Z" />
    </svg>
  );
}
