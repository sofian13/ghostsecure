"use client";

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import SecurityShell from '@/components/SecurityShell';
import MobileTabs from '@/components/MobileTabs';
import { getSession } from '@/lib/session';
import { getSupabaseClient } from '@/lib/supabase';

type VoicePreset = 'normal' | 'ghost' | 'robot' | 'deep';

type InviteRow = {
  id: string;
  call_id: string;
  from_user_id: string;
  target_user_id: string;
  offer_sdp: RTCSessionDescriptionInit;
  answer_sdp: RTCSessionDescriptionInit | null;
  status: 'pending' | 'accepted' | 'rejected' | 'ended';
  created_at?: string;
  updated_at?: string;
};

type IncomingOffer = {
  inviteId: string;
  callId: string;
  fromUserId: string;
  sdp: RTCSessionDescriptionInit;
};

function normalizeUserId(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function resolveIceServers(): RTCIceServer[] {
  const list: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];
  const turnUrl = process.env.NEXT_PUBLIC_TURN_URL ?? '';
  const turnUsername = process.env.NEXT_PUBLIC_TURN_USERNAME ?? '';
  const turnCredential = process.env.NEXT_PUBLIC_TURN_CREDENTIAL ?? '';
  if (turnUrl && turnUsername && turnCredential) {
    list.push({ urls: turnUrl, username: turnUsername, credential: turnCredential });
  } else {
    list.push({ urls: 'turn:openrelay.metered.ca:80?transport=udp', username: 'openrelayproject', credential: 'openrelayproject' });
    list.push({ urls: 'turn:openrelay.metered.ca:80?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' });
    list.push({ urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' });
    list.push({ urls: 'turns:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' });
  }
  return list;
}

function createDistortionCurve(amount: number): Float32Array {
  const k = Math.max(0, amount);
  const n = 512;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const x = (i * 2) / n - 1;
    curve[i] = ((3 + k) * x * 20 * (Math.PI / 180)) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}

const ICE_SERVERS = resolveIceServers();

export default function CallPage() {
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [targetId, setTargetId] = useState('');
  const [autoCall, setAutoCall] = useState(false);
  const [connected, setConnected] = useState(false);
  const [voicePreset, setVoicePreset] = useState<VoicePreset>('normal');
  const [statusText, setStatusText] = useState('Pret');
  const [incomingOffer, setIncomingOffer] = useState<IncomingOffer | null>(null);
  const [history, setHistory] = useState<InviteRow[]>([]);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const processedStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const processingCleanupRef = useRef<(() => void) | null>(null);
  const activeCallIdRef = useRef<string | null>(null);
  const activeInviteIdRef = useRef<string | null>(null);
  const answerPollRef = useRef<number | null>(null);
  const incomingPollRef = useRef<number | null>(null);
  const lastIncomingInviteRef = useRef<string | null>(null);
  const connectTimeoutRef = useRef<number | null>(null);
  const autoCalledRef = useRef(false);

  useEffect(() => {
    const s = getSession();
    if (!s) {
      router.replace('/login');
      return;
    }
    const me = normalizeUserId(s.userId);
    setUserId(me);
    const query = new URLSearchParams(window.location.search);
    const target = normalizeUserId(query.get('target'));
    if (target) setTargetId(target);
    setAutoCall(query.get('autocall') === '1');
  }, [router]);

  const loadHistory = async (me: string) => {
    const supabase = getSupabaseClient();
    const { data } = await supabase
      .from('call_invite')
      .select('id,call_id,from_user_id,target_user_id,offer_sdp,answer_sdp,status,created_at,updated_at')
      .or(`from_user_id.eq.${me},target_user_id.eq.${me}`)
      .order('created_at', { ascending: false })
      .limit(40);
    setHistory((data ?? []) as InviteRow[]);
  };

  useEffect(() => {
    if (!userId) return;
    const supabase = getSupabaseClient();
    const inviteChannel = supabase
      .channel(`call-invite:${userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'call_invite' }, async (payload) => {
        const row = (payload.new || payload.old) as InviteRow | undefined;
        if (!row) return;
        await handleInviteEvent(row);
        await loadHistory(userId);
      })
      .subscribe();

    void hydratePendingInvite(userId);
    void loadHistory(userId);
    startIncomingPolling(userId);
    setStatusText('Signalisation prete');

    return () => {
      void supabase.removeChannel(inviteChannel);
      if (incomingPollRef.current) window.clearInterval(incomingPollRef.current);
      incomingPollRef.current = null;
      teardownPeer();
    };
  }, [userId]);

  useEffect(() => {
    if (!autoCall || autoCalledRef.current || !targetId) return;
    autoCalledRef.current = true;
    void startCall();
  }, [autoCall, targetId]);

  useEffect(() => {
    if (!pcRef.current || !localStreamRef.current) return;
    void replaceOutgoingTrack(voicePreset);
  }, [voicePreset]);

  const hydratePendingInvite = async (me: string): Promise<void> => {
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
  };

  const handleInviteEvent = async (row: InviteRow): Promise<void> => {
    const me = normalizeUserId(userId);
    const from = normalizeUserId(row.from_user_id);
    const to = normalizeUserId(row.target_user_id);

    if (row.status === 'pending' && to === me) {
      applyIncomingOffer(row);
      return;
    }

    if (from === me && activeCallIdRef.current === row.call_id) {
      if (row.status === 'accepted' && row.answer_sdp && pcRef.current && !pcRef.current.remoteDescription) {
        await pcRef.current.setRemoteDescription(row.answer_sdp);
        setStatusText('Connexion audio...');
        if (answerPollRef.current) window.clearInterval(answerPollRef.current);
        answerPollRef.current = null;
      }
      if (row.status === 'rejected' || row.status === 'ended') {
        setStatusText('Appel termine/refuse');
        if (answerPollRef.current) window.clearInterval(answerPollRef.current);
        answerPollRef.current = null;
        teardownPeer();
      }
    }
  };

  const waitIceGatheringComplete = (pc: RTCPeerConnection): Promise<void> =>
    new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') {
        resolve();
        return;
      }
      const onState = () => {
        if (pc.iceGatheringState === 'complete') {
          pc.removeEventListener('icegatheringstatechange', onState);
          resolve();
        }
      };
      pc.addEventListener('icegatheringstatechange', onState);
      window.setTimeout(() => {
        pc.removeEventListener('icegatheringstatechange', onState);
        resolve();
      }, 14000);
    });

  const buildProcessedStream = async (input: MediaStream, preset: VoicePreset): Promise<MediaStream> => {
    const ctx = new AudioContext();
    if (ctx.state === 'suspended') await ctx.resume();
    const source = ctx.createMediaStreamSource(input);
    const destination = ctx.createMediaStreamDestination();
    const cleanup: Array<() => void> = [];

    if (preset === 'ghost') {
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 320;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1650;
      bp.Q.value = 1.1;
      const shaper = ctx.createWaveShaper();
      shaper.curve = createDistortionCurve(30);
      shaper.oversample = '4x';
      source.connect(hp);
      hp.connect(bp);
      bp.connect(shaper);
      shaper.connect(destination);
    } else if (preset === 'robot') {
      const shaper = ctx.createWaveShaper();
      shaper.curve = createDistortionCurve(55);
      shaper.oversample = '4x';
      const tremolo = ctx.createGain();
      tremolo.gain.value = 0.7;
      const lfo = ctx.createOscillator();
      const lfoDepth = ctx.createGain();
      lfo.frequency.value = 38;
      lfoDepth.gain.value = 0.28;
      lfo.connect(lfoDepth);
      lfoDepth.connect(tremolo.gain);
      lfo.start();
      cleanup.push(() => lfo.stop());
      source.connect(shaper);
      shaper.connect(tremolo);
      tremolo.connect(destination);
    } else if (preset === 'deep') {
      const lowShelf = ctx.createBiquadFilter();
      lowShelf.type = 'lowshelf';
      lowShelf.frequency.value = 180;
      lowShelf.gain.value = 14;
      const lowpass = ctx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = 1200;
      source.connect(lowShelf);
      lowShelf.connect(lowpass);
      lowpass.connect(destination);
    } else {
      source.connect(destination);
    }

    audioCtxRef.current = ctx;
    processingCleanupRef.current = () => cleanup.forEach((fn) => fn());
    return destination.stream;
  };

  const ensurePeer = async (target: string, callId: string) => {
    if (pcRef.current) return pcRef.current;
    const local = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    localStreamRef.current = local;

    let outbound = local;
    if (voicePreset !== 'normal') {
      outbound = await buildProcessedStream(local, voicePreset);
      processedStreamRef.current = outbound;
    }

    const pc = new RTCPeerConnection({
      iceServers: ICE_SERVERS,
      iceCandidatePoolSize: 10,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    });
    outbound.getTracks().forEach((track) => pc.addTrack(track, outbound));

    pc.ontrack = (event) => {
      const [stream] = event.streams;
      if (!stream || !remoteAudioRef.current) return;
      remoteAudioRef.current.srcObject = stream;
      void remoteAudioRef.current.play().catch(() => null);
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      setConnected(state === 'connected');
      if (state === 'connected') setStatusText('En appel');
      if (state === 'connecting') setStatusText('Connexion...');
      if (state === 'failed') setStatusText('Connexion echouee. Relancez appel ou configurez TURN dedie.');
      if (state === 'disconnected') setStatusText('Reseau instable, reconnexion...');
      if (state === 'connected' || state === 'failed' || state === 'closed') {
        if (connectTimeoutRef.current) window.clearTimeout(connectTimeoutRef.current);
        connectTimeoutRef.current = null;
      }
    };

    activeCallIdRef.current = callId;
    pcRef.current = pc;
    return pc;
  };

  const replaceOutgoingTrack = async (preset: VoicePreset): Promise<void> => {
    if (!pcRef.current || !localStreamRef.current) return;
    const sender = pcRef.current.getSenders().find((s) => s.track?.kind === 'audio');
    if (!sender) return;

    if (preset === 'normal') {
      const originalTrack = localStreamRef.current.getAudioTracks()[0];
      if (originalTrack) await sender.replaceTrack(originalTrack);
      processedStreamRef.current?.getTracks().forEach((t) => t.stop());
      processedStreamRef.current = null;
      processingCleanupRef.current?.();
      processingCleanupRef.current = null;
      audioCtxRef.current?.close();
      audioCtxRef.current = null;
      return;
    }

    const processed = await buildProcessedStream(localStreamRef.current, preset);
    const track = processed.getAudioTracks()[0];
    if (track) await sender.replaceTrack(track);
    processedStreamRef.current?.getTracks().forEach((t) => t.stop());
    processedStreamRef.current = processed;
  };

  const teardownPeer = () => {
    pcRef.current?.close();
    pcRef.current = null;
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    processedStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    processedStreamRef.current = null;
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
    processingCleanupRef.current?.();
    processingCleanupRef.current = null;
    audioCtxRef.current?.close();
    audioCtxRef.current = null;
    activeCallIdRef.current = null;
    activeInviteIdRef.current = null;
    if (answerPollRef.current) window.clearInterval(answerPollRef.current);
    answerPollRef.current = null;
    if (connectTimeoutRef.current) window.clearTimeout(connectTimeoutRef.current);
    connectTimeoutRef.current = null;
    setConnected(false);
  };

  const startCall = async () => {
    const me = normalizeUserId(userId);
    const target = normalizeUserId(targetId);
    if (!me || !target) return;

    await cleanupOpenInvites(me, target);
    teardownPeer();
    setIncomingOffer(null);
    setStatusText('Preparation de l appel...');

    const callId = crypto.randomUUID();
    const inviteId = crypto.randomUUID();
    const pc = await ensurePeer(target, callId);
    const offer = await pc.createOffer({ offerToReceiveAudio: true });
    await pc.setLocalDescription(offer);
    await waitIceGatheringComplete(pc);

    const supabase = getSupabaseClient();
    const { error } = await supabase.from('call_invite').insert({
      id: inviteId,
      call_id: callId,
      from_user_id: me,
      target_user_id: target,
      offer_sdp: pc.localDescription ?? offer,
      status: 'pending',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    if (error) {
      setStatusText(`Erreur signalisation: ${error.message}`);
      return;
    }
    activeInviteIdRef.current = inviteId;
    setStatusText(`Appel de ${target}...`);
    if (connectTimeoutRef.current) window.clearTimeout(connectTimeoutRef.current);
    connectTimeoutRef.current = window.setTimeout(() => {
      const state = pcRef.current?.connectionState;
      if (state !== 'connected') setStatusText('Connexion lente. Reessayez ou ajoutez TURN dedie.');
    }, 22000);
    startAnswerPolling(inviteId);
    await loadHistory(me);
  };

  const acceptIncoming = async () => {
    const incoming = incomingOffer;
    if (!incoming) return;
    setIncomingOffer(null);

    const pc = await ensurePeer(incoming.fromUserId, incoming.callId);
    await pc.setRemoteDescription(incoming.sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitIceGatheringComplete(pc);

    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('call_invite')
      .update({
        status: 'accepted',
        answer_sdp: pc.localDescription ?? answer,
        updated_at: new Date().toISOString(),
      })
      .eq('id', incoming.inviteId);
    if (error) {
      setStatusText(`Erreur reponse: ${error.message}`);
      return;
    }

    activeInviteIdRef.current = incoming.inviteId;
    lastIncomingInviteRef.current = incoming.inviteId;
    setStatusText(`Connexion avec ${incoming.fromUserId}...`);
    if (userId) await loadHistory(userId);
  };

  const rejectIncoming = async () => {
    const incoming = incomingOffer;
    if (!incoming) return;
    const supabase = getSupabaseClient();
    await supabase
      .from('call_invite')
      .update({ status: 'rejected', updated_at: new Date().toISOString() })
      .eq('id', incoming.inviteId);
    lastIncomingInviteRef.current = incoming.inviteId;
    setIncomingOffer(null);
    setStatusText('Appel refuse');
    if (userId) await loadHistory(userId);
  };

  const endCall = async () => {
    const inviteId = activeInviteIdRef.current;
    if (inviteId) {
      const supabase = getSupabaseClient();
      await supabase
        .from('call_invite')
        .update({ status: 'ended', updated_at: new Date().toISOString() })
        .eq('id', inviteId);
    }
    teardownPeer();
    setStatusText('Appel termine');
    if (userId) await loadHistory(userId);
  };

  const historyRows = useMemo(() => {
    return history.map((row) => {
      const me = normalizeUserId(userId);
      const incoming = normalizeUserId(row.target_user_id) === me;
      const peer = incoming ? row.from_user_id : row.target_user_id;
      return {
        id: row.id,
        incoming,
        peer,
        state: row.status,
        date: row.created_at ?? row.updated_at ?? new Date().toISOString(),
      };
    });
  }, [history, userId]);

  if (!userId) return <main className="centered">Loading...</main>;

  function applyIncomingOffer(row: InviteRow) {
    const from = normalizeUserId(row.from_user_id);
    if (row.id === lastIncomingInviteRef.current || !from || row.status !== 'pending') return;
    setIncomingOffer({
      inviteId: row.id,
      callId: row.call_id,
      fromUserId: from,
      sdp: row.offer_sdp,
    });
    setTargetId(from);
    setStatusText(`Appel entrant de ${from}`);
  }

  function startIncomingPolling(me: string) {
    if (incomingPollRef.current) window.clearInterval(incomingPollRef.current);
    const supabase = getSupabaseClient();
    incomingPollRef.current = window.setInterval(async () => {
      if (!me) return;
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
    }, 1500);
  }

  async function cleanupOpenInvites(me: string, target: string) {
    const supabase = getSupabaseClient();
    await supabase
      .from('call_invite')
      .update({ status: 'ended', updated_at: new Date().toISOString() })
      .in('status', ['pending', 'accepted'])
      .or(
        `and(from_user_id.eq.${me},target_user_id.eq.${target}),and(from_user_id.eq.${target},target_user_id.eq.${me})`
      );
  }

  function startAnswerPolling(inviteId: string) {
    if (answerPollRef.current) window.clearInterval(answerPollRef.current);
    const supabase = getSupabaseClient();
    const startedAt = Date.now();
    answerPollRef.current = window.setInterval(async () => {
      if (!pcRef.current) return;
      const { data } = await supabase
        .from('call_invite')
        .select('id,call_id,from_user_id,target_user_id,offer_sdp,answer_sdp,status')
        .eq('id', inviteId)
        .maybeSingle();
      if (!data) return;
      const row = data as InviteRow;
      if (row.status === 'accepted' && row.answer_sdp && !pcRef.current.remoteDescription) {
        await pcRef.current.setRemoteDescription(row.answer_sdp);
        setStatusText('Connexion audio...');
        if (answerPollRef.current) window.clearInterval(answerPollRef.current);
        answerPollRef.current = null;
      }
      if (row.status === 'rejected' || row.status === 'ended' || Date.now() - startedAt > 30000) {
        if (answerPollRef.current) window.clearInterval(answerPollRef.current);
        answerPollRef.current = null;
      }
    }, 1300);
  }

  return (
    <SecurityShell userId={userId}>
      <main className="mobile-screen call-mobile">
        <header className="mobile-header">
          <div>
            <h1>Appels</h1>
            <p className="muted-text">Historique securise</p>
          </div>
          <button type="button" className="ghost-primary" onClick={startCall}>
            Nouvel appel
          </button>
        </header>

        <section className="inline-card">
          <label className="field">
            <span>Utilisateur a appeler</span>
            <input
              className="mobile-input"
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              placeholder="ID utilisateur"
            />
          </label>

          <label className="field">
            <span>Voix</span>
            <select className="mobile-input" value={voicePreset} onChange={(e) => setVoicePreset(e.target.value as VoicePreset)}>
              <option value="normal">Normal</option>
              <option value="ghost">Ghost</option>
              <option value="robot">Robot</option>
              <option value="deep">Deep</option>
            </select>
          </label>

          <div className="row">
            <button className="ghost-primary" type="button" onClick={startCall}>Appeler</button>
            <button className="ghost-secondary" type="button" onClick={endCall}>Terminer</button>
            <button className="ghost-secondary" type="button" onClick={() => router.push('/chat')}>Retour chat</button>
          </div>

          <p className={connected ? 'ok-text' : 'muted-text'}>{connected ? 'Canal audio actif' : statusText}</p>
          <audio ref={remoteAudioRef} autoPlay playsInline />
        </section>

        {incomingOffer && (
          <section className="incoming-banner">
            <p>{incomingOffer.fromUserId} appelle</p>
            <div className="row">
              <button className="ghost-primary" type="button" onClick={acceptIncoming}>Repondre</button>
              <button className="ghost-secondary" type="button" onClick={rejectIncoming}>Refuser</button>
            </div>
          </section>
        )}

        <section className="call-list">
          {historyRows.map((item) => (
            <button
              type="button"
              key={item.id}
              className="call-row"
              onClick={() => setTargetId(normalizeUserId(item.peer))}
            >
              <div className="chat-avatar small" aria-hidden="true">{item.peer.slice(0, 1).toUpperCase()}</div>
              <div className="chat-content">
                <div className="chat-topline">
                  <strong>{item.peer}</strong>
                  <span>{new Date(item.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                <p className="muted-text">{item.incoming ? 'Entrant' : 'Sortant'} - {item.state}</p>
              </div>
            </button>
          ))}
        </section>

        <MobileTabs />
      </main>
    </SecurityShell>
  );
}
