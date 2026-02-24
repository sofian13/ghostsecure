"use client";

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { RealtimeChannel } from '@supabase/supabase-js';
import SecurityShell from '@/components/SecurityShell';
import { getSession } from '@/lib/session';
import { getSupabaseClient } from '@/lib/supabase';

type CallAction = 'offer' | 'answer' | 'candidate' | 'reject';

type CallSignalPayload = {
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};

type CallSignalFrame = {
  action?: CallAction;
  callId?: string;
  fromUserId?: string;
  targetUserId?: string;
  payload?: CallSignalPayload;
};

type IncomingOffer = {
  callId: string;
  fromUserId: string;
  sdp: RTCSessionDescriptionInit;
};

function resolveIceServers(): RTCIceServer[] {
  const list: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ];

  const turnUrl = process.env.NEXT_PUBLIC_TURN_URL ?? '';
  const turnUsername = process.env.NEXT_PUBLIC_TURN_USERNAME ?? '';
  const turnCredential = process.env.NEXT_PUBLIC_TURN_CREDENTIAL ?? '';
  if (turnUrl && turnUsername && turnCredential) {
    list.push({ urls: turnUrl, username: turnUsername, credential: turnCredential });
  }
  return list;
}

const ICE_SERVERS = resolveIceServers();

export default function CallPage() {
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [targetId, setTargetId] = useState('');
  const [autoCall, setAutoCall] = useState(false);
  const [connected, setConnected] = useState(false);
  const [signalingReady, setSignalingReady] = useState(false);
  const [voiceFx, setVoiceFx] = useState(false);
  const [statusText, setStatusText] = useState('Initialisation signalisation...');
  const [incomingOffer, setIncomingOffer] = useState<IncomingOffer | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const processedStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const activeCallIdRef = useRef<string | null>(null);
  const activeTargetRef = useRef<string | null>(null);
  const candidateQueueRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const offerRetryRef = useRef<number | null>(null);
  const offerRetryCountRef = useRef(0);
  const offerRetryPayloadRef = useRef<CallSignalFrame | null>(null);
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
    const channel = supabase
      .channel('call-signaling', {
        config: { broadcast: { ack: true, self: false } },
      })
      .on('broadcast', { event: 'call_signal' }, async ({ payload }) => {
        await onSignal(payload as CallSignalFrame);
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          setSignalingReady(true);
          setStatusText('Signalisation prete');
          return;
        }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          setSignalingReady(false);
          setStatusText('Signalisation indisponible');
        }
      });
    channelRef.current = channel;

    return () => {
      stopOfferRetry();
      void supabase.removeChannel(channel);
      teardownPeer();
      setSignalingReady(false);
    };
  }, [userId]);

  useEffect(() => {
    if (!autoCall || autoCalledRef.current || !signalingReady || !targetId) return;
    autoCalledRef.current = true;
    void startCall();
  }, [autoCall, signalingReady, targetId]);

  const onSignal = async (frame: CallSignalFrame): Promise<void> => {
    const me = normalizeUserId(userId);
    const target = normalizeUserId(frame.targetUserId);
    const from = normalizeUserId(frame.fromUserId);
    const action = frame.action;
    const callId = frame.callId ?? '';
    if (!me || !target || target !== me || !from || !action || !callId) return;

    if (action === 'offer' && frame.payload?.sdp?.type === 'offer') {
      setIncomingOffer({ callId, fromUserId: from, sdp: frame.payload.sdp });
      setTargetId(from);
      setStatusText(`Appel entrant de ${from}`);
      void navigator.vibrate?.([140, 90, 140, 90, 180]);
      return;
    }

    if (action === 'answer' && frame.payload?.sdp?.type === 'answer') {
      if (activeCallIdRef.current !== callId) return;
      const pc = pcRef.current;
      if (!pc) return;
      await pc.setRemoteDescription(frame.payload.sdp);
      await flushQueuedCandidates(callId);
      stopOfferRetry();
      setStatusText('Connexion audio en cours...');
      return;
    }

    if (action === 'candidate' && frame.payload?.candidate) {
      const pc = pcRef.current;
      if (!pc || activeCallIdRef.current !== callId || !pc.remoteDescription) {
        queueCandidate(callId, frame.payload.candidate);
        return;
      }
      await pc.addIceCandidate(frame.payload.candidate);
      return;
    }

    if (action === 'reject') {
      if (activeCallIdRef.current !== callId) return;
      stopOfferRetry();
      setStatusText(`${from} a termine/refuse l'appel`);
      teardownPeer();
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

  const sendSignal = async (signal: CallSignalFrame): Promise<void> => {
    if (!channelRef.current) return;
    await channelRef.current.send({ type: 'broadcast', event: 'call_signal', payload: signal });
  };

  const startOfferRetry = () => {
    stopOfferRetry();
    offerRetryCountRef.current = 0;
    offerRetryRef.current = window.setInterval(async () => {
      const payload = offerRetryPayloadRef.current;
      if (!payload) return;
      offerRetryCountRef.current += 1;
      if (offerRetryCountRef.current > 12) {
        stopOfferRetry();
        setStatusText("Aucune reponse. Verifie que l'autre est sur /chat ou /call.");
        return;
      }
      await sendSignal(payload);
    }, 1500);
  };

  const stopOfferRetry = () => {
    if (offerRetryRef.current) {
      window.clearInterval(offerRetryRef.current);
      offerRetryRef.current = null;
    }
    offerRetryPayloadRef.current = null;
  };

  const buildProcessedStream = (input: MediaStream): MediaStream => {
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(input);
    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 400;

    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i += 1) {
      const x = (i * 2) / 255 - 1;
      curve[i] = Math.tanh(2.5 * x);
    }
    shaper.curve = curve;
    shaper.oversample = '4x';

    const destination = ctx.createMediaStreamDestination();
    source.connect(filter);
    filter.connect(shaper);
    shaper.connect(destination);
    audioCtxRef.current = ctx;
    return destination.stream;
  };

  const ensurePeer = async (target: string, callId: string) => {
    if (pcRef.current) return pcRef.current;

    const local = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    localStreamRef.current = local;

    let outbound = local;
    if (voiceFx) {
      outbound = buildProcessedStream(local);
      processedStreamRef.current = outbound;
    }

    const pc = new RTCPeerConnection({
      iceServers: ICE_SERVERS,
      iceCandidatePoolSize: 10,
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
      void sendSignal({
        action: 'candidate',
        callId,
        fromUserId: userId,
        targetUserId: target,
        payload: { candidate: event.candidate.toJSON() },
      });
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      setConnected(state === 'connected');
      if (state === 'connected') setStatusText('En appel');
      if (state === 'connecting') setStatusText('Connexion...');
      if (state === 'failed') setStatusText('Connexion echouee (reseau NAT strict, TURN conseille)');
      if (state === 'disconnected') setStatusText('Connexion interrompue');
    };

    activeCallIdRef.current = callId;
    activeTargetRef.current = target;
    pcRef.current = pc;
    return pc;
  };

  const teardownPeer = () => {
    pcRef.current?.close();
    pcRef.current = null;
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    processedStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    processedStreamRef.current = null;
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
    audioCtxRef.current?.close();
    audioCtxRef.current = null;
    activeCallIdRef.current = null;
    activeTargetRef.current = null;
    setConnected(false);
  };

  const startCall = async () => {
    const me = normalizeUserId(userId);
    const target = normalizeUserId(targetId);
    if (!me || !target || !signalingReady) return;

    const callId = crypto.randomUUID();
    const pc = await ensurePeer(target, callId);
    const offer = await pc.createOffer({ offerToReceiveAudio: true });
    await pc.setLocalDescription(offer);

    const signal: CallSignalFrame = {
      action: 'offer',
      callId,
      fromUserId: me,
      targetUserId: target,
      payload: { sdp: offer },
    };
    offerRetryPayloadRef.current = signal;
    await sendSignal(signal);
    startOfferRetry();
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

    await sendSignal({
      action: 'answer',
      callId: incoming.callId,
      fromUserId: me,
      targetUserId: incoming.fromUserId,
      payload: { sdp: answer },
    });
    setStatusText(`Connexion avec ${incoming.fromUserId}...`);
  };

  const rejectIncoming = async () => {
    const incoming = incomingOffer;
    const me = normalizeUserId(userId);
    if (!incoming || !me) return;
    await sendSignal({
      action: 'reject',
      callId: incoming.callId,
      fromUserId: me,
      targetUserId: incoming.fromUserId,
    });
    setIncomingOffer(null);
    setStatusText('Appel refuse');
  };

  const endCall = async () => {
    const me = normalizeUserId(userId);
    const target = activeTargetRef.current;
    const callId = activeCallIdRef.current;
    if (me && target && callId) {
      await sendSignal({
        action: 'reject',
        callId,
        fromUserId: me,
        targetUserId: target,
      });
    }
    stopOfferRetry();
    teardownPeer();
    setStatusText('Appel termine');
  };

  if (!userId) return <main className="centered">Loading...</main>;

  return (
    <SecurityShell userId={userId}>
      <main className="glass-card call-screen">
        <h1>Appel vocal</h1>
        <p className="muted-text">Style WhatsApp: connexion rapide, reponse directe, audio distant auto-play.</p>
        <input
          className="glass-input"
          value={targetId}
          onChange={(e) => setTargetId(e.target.value)}
          placeholder="ID utilisateur cible"
        />
        <div className="row">
          <button className="glass-btn primary" type="button" onClick={startCall} disabled={!signalingReady}>
            Appeler
          </button>
          <button className="glass-btn soft" type="button" onClick={endCall}>Terminer</button>
          <button className="glass-btn soft" type="button" onClick={() => setVoiceFx((v) => !v)}>
            {voiceFx ? 'Voice FX Off' : 'Voice FX On'}
          </button>
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

        <p>{voiceFx ? 'Voix modifiee active' : 'Voix normale'}</p>
        <p className="muted-text">{statusText}</p>
        <p className={connected ? 'ok-text' : 'muted-text'}>
          {connected ? 'Canal audio securise actif' : 'En attente de connexion...'}
        </p>
        <audio ref={remoteAudioRef} autoPlay playsInline />
      </main>
    </SecurityShell>
  );
}

function normalizeUserId(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}
