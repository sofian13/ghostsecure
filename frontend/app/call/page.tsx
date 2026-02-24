"use client";

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { RealtimeChannel } from '@supabase/supabase-js';
import SecurityShell from '@/components/SecurityShell';
import { getSession } from '@/lib/session';
import { getSupabaseClient } from '@/lib/supabase';

type VoicePreset = 'normal' | 'ghost' | 'robot' | 'deep';

type CandidateSignal = {
  action: 'candidate';
  callId: string;
  fromUserId: string;
  targetUserId: string;
  payload: { candidate: RTCIceCandidateInit };
};

type InviteRow = {
  id: string;
  call_id: string;
  from_user_id: string;
  target_user_id: string;
  offer_sdp: RTCSessionDescriptionInit;
  answer_sdp: RTCSessionDescriptionInit | null;
  status: 'pending' | 'accepted' | 'rejected' | 'ended';
  created_at: string;
  updated_at: string;
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
    { urls: 'stun:global.stun.twilio.com:3478' },
  ];
  const turnUrl = process.env.NEXT_PUBLIC_TURN_URL ?? '';
  const turnUsername = process.env.NEXT_PUBLIC_TURN_USERNAME ?? '';
  const turnCredential = process.env.NEXT_PUBLIC_TURN_CREDENTIAL ?? '';
  if (turnUrl && turnUsername && turnCredential) {
    list.push({ urls: turnUrl, username: turnUsername, credential: turnCredential });
  } else {
    list.push({ urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' });
    list.push({ urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' });
    list.push({ urls: 'turns:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' });
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
  const [signalingReady, setSignalingReady] = useState(false);
  const [voicePreset, setVoicePreset] = useState<VoicePreset>('normal');
  const [statusText, setStatusText] = useState('Initialisation signalisation...');
  const [incomingOffer, setIncomingOffer] = useState<IncomingOffer | null>(null);

  const candidateChannelRef = useRef<RealtimeChannel | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const processedStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const processingCleanupRef = useRef<(() => void) | null>(null);
  const activeCallIdRef = useRef<string | null>(null);
  const activeInviteIdRef = useRef<string | null>(null);
  const activeTargetRef = useRef<string | null>(null);
  const candidateQueueRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const autoCalledRef = useRef(false);

  useEffect(() => {
    const s = getSession();
    if (!s) {
      router.replace('/login');
      return;
    }
    setUserId(normalizeUserId(s.userId));
    const query = new URLSearchParams(window.location.search);
    const target = normalizeUserId(query.get('target'));
    if (target) setTargetId(target);
    setAutoCall(query.get('autocall') === '1');
  }, [router]);

  useEffect(() => {
    if (!userId) return;
    const supabase = getSupabaseClient();

    const candidateChannel = supabase
      .channel('call-candidates', { config: { broadcast: { ack: true, self: false } } })
      .on('broadcast', { event: 'call_signal' }, async ({ payload }) => {
        const signal = payload as CandidateSignal;
        if (signal.action !== 'candidate') return;
        const me = normalizeUserId(userId);
        if (normalizeUserId(signal.targetUserId) !== me) return;
        if (!signal.callId || !signal.payload?.candidate) return;
        const pc = pcRef.current;
        if (!pc || activeCallIdRef.current !== signal.callId || !pc.remoteDescription) {
          queueCandidate(signal.callId, signal.payload.candidate);
          return;
        }
        await pc.addIceCandidate(signal.payload.candidate);
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          setSignalingReady(true);
          setStatusText('Signalisation prete');
        }
      });
    candidateChannelRef.current = candidateChannel;

    const inviteChannel = supabase
      .channel(`call-invite:${userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'call_invite' }, async (payload) => {
        const row = (payload.new || payload.old) as InviteRow | undefined;
        if (!row) return;
        await handleInviteEvent(row);
      })
      .subscribe();

    void hydratePendingInvite(userId);

    return () => {
      void supabase.removeChannel(candidateChannel);
      void supabase.removeChannel(inviteChannel);
      teardownPeer();
      setSignalingReady(false);
    };
  }, [userId]);

  useEffect(() => {
    if (!autoCall || autoCalledRef.current || !signalingReady || !targetId) return;
    autoCalledRef.current = true;
    void startCall();
  }, [autoCall, signalingReady, targetId]);

  useEffect(() => {
    if (!pcRef.current || !localStreamRef.current || !activeCallIdRef.current) return;
    void replaceOutgoingTrack(voicePreset);
  }, [voicePreset]);

  const hydratePendingInvite = async (me: string): Promise<void> => {
    const supabase = getSupabaseClient();
    const { data } = await supabase
      .from('call_invite')
      .select('id,call_id,from_user_id,target_user_id,offer_sdp,answer_sdp,status,created_at,updated_at')
      .eq('target_user_id', me)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) return;
    const row = data as InviteRow;
    setIncomingOffer({
      inviteId: row.id,
      callId: row.call_id,
      fromUserId: normalizeUserId(row.from_user_id),
      sdp: row.offer_sdp,
    });
    setTargetId(normalizeUserId(row.from_user_id));
    setStatusText(`Appel entrant de ${normalizeUserId(row.from_user_id)}`);
  };

  const handleInviteEvent = async (row: InviteRow): Promise<void> => {
    const me = normalizeUserId(userId);
    const from = normalizeUserId(row.from_user_id);
    const to = normalizeUserId(row.target_user_id);

    if (row.status === 'pending' && to === me) {
      setIncomingOffer({
        inviteId: row.id,
        callId: row.call_id,
        fromUserId: from,
        sdp: row.offer_sdp,
      });
      setTargetId(from);
      setStatusText(`Appel entrant de ${from}`);
      void navigator.vibrate?.([140, 90, 140, 90, 180]);
      return;
    }

    if (from === me && activeCallIdRef.current === row.call_id) {
      if (row.status === 'accepted' && row.answer_sdp && pcRef.current && !pcRef.current.remoteDescription) {
        await pcRef.current.setRemoteDescription(row.answer_sdp);
        await flushQueuedCandidates(row.call_id);
        setStatusText('Connexion audio en cours...');
      }
      if (row.status === 'rejected' || row.status === 'ended') {
        setStatusText('Appel termine/refuse');
        teardownPeer();
      }
    }
  };

  const queueCandidate = (callId: string, candidate: RTCIceCandidateInit): void => {
    const current = candidateQueueRef.current.get(callId) ?? [];
    current.push(candidate);
    candidateQueueRef.current.set(callId, current);
  };

  const flushQueuedCandidates = async (callId: string): Promise<void> => {
    const pc = pcRef.current;
    if (!pc) return;
    const queued = candidateQueueRef.current.get(callId) ?? [];
    for (const candidate of queued) {
      await pc.addIceCandidate(candidate);
    }
    candidateQueueRef.current.delete(callId);
  };

  const sendCandidate = async (signal: CandidateSignal): Promise<void> => {
    if (!candidateChannelRef.current) return;
    await candidateChannelRef.current.send({ type: 'broadcast', event: 'call_signal', payload: signal });
  };

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
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -28;
      compressor.ratio.value = 6;
      source.connect(hp);
      hp.connect(bp);
      bp.connect(shaper);
      shaper.connect(compressor);
      compressor.connect(destination);
    } else if (preset === 'robot') {
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 260;
      const shaper = ctx.createWaveShaper();
      shaper.curve = createDistortionCurve(52);
      shaper.oversample = '4x';
      const gain = ctx.createGain();
      gain.gain.value = 0.7;
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
      source.connect(hp);
      hp.connect(shaper);
      shaper.connect(gain);
      gain.connect(tremolo);
      tremolo.connect(destination);
    } else if (preset === 'deep') {
      const lowShelf = ctx.createBiquadFilter();
      lowShelf.type = 'lowshelf';
      lowShelf.frequency.value = 180;
      lowShelf.gain.value = 14;
      const lowpass = ctx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = 1200;
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -30;
      compressor.ratio.value = 8;
      source.connect(lowShelf);
      lowShelf.connect(lowpass);
      lowpass.connect(compressor);
      compressor.connect(destination);
    } else {
      source.connect(destination);
    }

    audioCtxRef.current = ctx;
    processingCleanupRef.current = () => cleanup.forEach((fn) => fn());
    return destination.stream;
  };

  const ensurePeer = async (target: string, callId: string) => {
    if (pcRef.current) return pcRef.current;

    const local = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: voicePreset === 'normal',
        noiseSuppression: voicePreset === 'normal',
        autoGainControl: voicePreset === 'normal',
      },
      video: false,
    });
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
      remoteAudioRef.current.muted = false;
      remoteAudioRef.current.volume = 1;
      void remoteAudioRef.current.play().catch(() => null);
    };

    pc.onicecandidate = (event) => {
      if (!event.candidate || !userId) return;
      const targetUser = activeTargetRef.current ?? target;
      const currentCallId = activeCallIdRef.current ?? callId;
      void sendCandidate({
        action: 'candidate',
        callId: currentCallId,
        fromUserId: userId,
        targetUserId: targetUser,
        payload: { candidate: event.candidate.toJSON() },
      });
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      setConnected(state === 'connected');
      if (state === 'connected') setStatusText('En appel');
      if (state === 'connecting') setStatusText('Connexion...');
      if (state === 'failed') setStatusText('Connexion echouee (TURN requis sur ce reseau)');
      if (state === 'disconnected') setStatusText('Connexion interrompue');
    };

    activeCallIdRef.current = callId;
    activeTargetRef.current = target;
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
    activeTargetRef.current = null;
    setConnected(false);
  };

  const startCall = async () => {
    const me = normalizeUserId(userId);
    const target = normalizeUserId(targetId);
    if (!me || !target || !signalingReady) return;

    const callId = crypto.randomUUID();
    const inviteId = crypto.randomUUID();
    const pc = await ensurePeer(target, callId);
    const offer = await pc.createOffer({ offerToReceiveAudio: true });
    await pc.setLocalDescription(offer);

    const supabase = getSupabaseClient();
    const { error } = await supabase.from('call_invite').insert({
      id: inviteId,
      call_id: callId,
      from_user_id: me,
      target_user_id: target,
      offer_sdp: offer,
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
  };

  const acceptIncoming = async () => {
    const incoming = incomingOffer;
    const me = normalizeUserId(userId);
    if (!incoming || !me) return;
    setIncomingOffer(null);

    const pc = await ensurePeer(incoming.fromUserId, incoming.callId);
    await pc.setRemoteDescription(incoming.sdp);
    await flushQueuedCandidates(incoming.callId);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('call_invite')
      .update({
        status: 'accepted',
        answer_sdp: answer,
        updated_at: new Date().toISOString(),
      })
      .eq('id', incoming.inviteId);
    if (error) {
      setStatusText(`Erreur reponse: ${error.message}`);
      return;
    }

    activeInviteIdRef.current = incoming.inviteId;
    setStatusText(`Connexion avec ${incoming.fromUserId}...`);
  };

  const rejectIncoming = async () => {
    const incoming = incomingOffer;
    if (!incoming) return;
    const supabase = getSupabaseClient();
    await supabase
      .from('call_invite')
      .update({ status: 'rejected', updated_at: new Date().toISOString() })
      .eq('id', incoming.inviteId);
    setIncomingOffer(null);
    setStatusText('Appel refuse');
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
  };

  if (!userId) return <main className="centered">Loading...</main>;

  return (
    <SecurityShell userId={userId}>
      <main className="glass-card call-screen">
        <h1>Appel vocal</h1>
        <p className="muted-text">Un appelle, l&apos;autre decroche. Signalisation persistante.</p>
        <input
          className="glass-input"
          value={targetId}
          onChange={(e) => setTargetId(e.target.value)}
          placeholder="ID utilisateur cible"
        />

        <label className="field">
          <span>Modificateur de voix</span>
          <select className="glass-input" value={voicePreset} onChange={(e) => setVoicePreset(e.target.value as VoicePreset)}>
            <option value="normal">Normal</option>
            <option value="ghost">Ghost</option>
            <option value="robot">Robot</option>
            <option value="deep">Deep</option>
          </select>
        </label>

        <div className="row">
          <button className="glass-btn primary" type="button" onClick={startCall} disabled={!signalingReady}>
            Appeler
          </button>
          <button className="glass-btn soft" type="button" onClick={endCall}>Terminer</button>
          <button className="glass-btn soft" type="button" onClick={() => router.push('/chat')}>Retour chat</button>
        </div>

        {incomingOffer && (
          <div className="incoming-call-sheet">
            <p className="requests-title">Appel entrant: {incomingOffer.fromUserId}</p>
            <div className="row">
              <button className="glass-btn primary" type="button" onClick={acceptIncoming}>Repondre</button>
              <button className="glass-btn danger" type="button" onClick={rejectIncoming}>Refuser</button>
            </div>
          </div>
        )}

        <p className="muted-text">{statusText}</p>
        <p className={connected ? 'ok-text' : 'muted-text'}>
          {connected ? 'Canal audio securise actif' : 'En attente de connexion...'}
        </p>
        <audio ref={remoteAudioRef} autoPlay playsInline />
      </main>
    </SecurityShell>
  );
}
