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

const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

export default function CallPage() {
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [targetId, setTargetId] = useState('');
  const [connected, setConnected] = useState(false);
  const [signalingReady, setSignalingReady] = useState(false);
  const [voiceFx, setVoiceFx] = useState(false);
  const [statusText, setStatusText] = useState('Initialisation signalisation...');
  const [incomingOffer, setIncomingOffer] = useState<IncomingOffer | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const processedStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const activeCallIdRef = useRef<string | null>(null);
  const activeTargetRef = useRef<string | null>(null);
  const candidateQueueRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const offerRetryRef = useRef<number | null>(null);
  const offerRetryCountRef = useRef(0);
  const offerRetryPayloadRef = useRef<CallSignalFrame | null>(null);

  useEffect(() => {
    const s = getSession();
    if (!s) {
      router.replace('/login');
      return;
    }
    setUserId(normalizeUserId(s.userId));
    const target = new URLSearchParams(window.location.search).get('target')?.trim().toLowerCase() ?? '';
    if (target) setTargetId(target);
  }, [router]);

  useEffect(() => {
    if (!userId) return;
    const supabase = getSupabaseClient();
    const channel = supabase
      .channel('call-signaling', {
        config: { broadcast: { ack: true, self: false } },
      })
      .on('broadcast', { event: 'call_signal' }, async ({ payload }) => {
        const msg = payload as CallSignalFrame;
        await onSignal(msg);
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
      setSignalingReady(false);
      teardownPeer();
    };
  }, [userId]);

  const onSignal = async (frame: CallSignalFrame): Promise<void> => {
    const me = normalizeUserId(userId);
    const target = normalizeUserId(frame.targetUserId);
    const from = normalizeUserId(frame.fromUserId);
    const action = frame.action;
    const callId = frame.callId ?? '';
    if (!me || !target || target !== me || !from || !action || !callId) return;

    if (action === 'offer' && frame.payload?.sdp?.type === 'offer') {
      if (!('Notification' in window) || Notification.permission !== 'granted') {
        // no-op
      } else {
        new Notification('Appel entrant', { body: `${from} vous appelle` });
      }
      setIncomingOffer({ callId, fromUserId: from, sdp: frame.payload.sdp });
      setTargetId(from);
      setStatusText(`Appel entrant de ${from}`);
      return;
    }

    if (action === 'answer' && frame.payload?.sdp?.type === 'answer') {
      if (activeCallIdRef.current !== callId) return;
      const pc = pcRef.current;
      if (!pc) return;
      await pc.setRemoteDescription(frame.payload.sdp);
      await flushQueuedCandidates(callId);
      stopOfferRetry();
      setStatusText('Reponse recue, connexion audio...');
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
      setStatusText(`${from} a refuse l'appel`);
      stopOfferRetry();
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
    await channelRef.current.send({
      type: 'broadcast',
      event: 'call_signal',
      payload: signal,
    });
  };

  const startOfferRetry = () => {
    stopOfferRetry();
    offerRetryCountRef.current = 0;
    offerRetryRef.current = window.setInterval(async () => {
      const payload = offerRetryPayloadRef.current;
      if (!payload) return;
      offerRetryCountRef.current += 1;
      if (offerRetryCountRef.current > 8) {
        stopOfferRetry();
        setStatusText("Aucune reponse a l'appel");
        return;
      }
      await sendSignal(payload);
    }, 2200);
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

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    outbound.getTracks().forEach((track) => pc.addTrack(track, outbound));

    pc.ontrack = (event) => {
      const [stream] = event.streams;
      if (!stream) return;
      remoteStreamRef.current = stream;
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = stream;
        void remoteAudioRef.current.play().catch(() => null);
      }
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
      if (state === 'connected') setStatusText('Canal audio actif');
      if (state === 'failed') setStatusText('Connexion echouee. Reessayez.');
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
    remoteStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    processedStreamRef.current = null;
    remoteStreamRef.current = null;
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
    const offer = await pc.createOffer();
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
    setStatusText(`Invitation envoyee a ${target}`);
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
    setStatusText(`En communication avec ${incoming.fromUserId}`);
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
        <h1>Ghost Secure Call</h1>
        <p className="muted-text">WebRTC audio E2EE (DTLS-SRTP) + notification d&apos;appel entrant.</p>
        <input
          className="glass-input"
          value={targetId}
          onChange={(e) => setTargetId(e.target.value)}
          placeholder="ID utilisateur cible"
        />
        <div className="row">
          <button className="glass-btn primary" type="button" onClick={startCall} disabled={!signalingReady}>
            Demarrer appel
          </button>
          <button className="glass-btn soft" type="button" onClick={endCall}>Terminer</button>
          <button className="glass-btn soft" type="button" onClick={() => setVoiceFx((v) => !v)}>
            {voiceFx ? 'Voice FX Off' : 'Voice FX On'}
          </button>
          <button className="glass-btn soft" type="button" onClick={() => router.push('/chat')}>Retour chat</button>
        </div>

        {incomingOffer && (
          <div className="requests-box">
            <p className="requests-title">Appel entrant: {incomingOffer.fromUserId}</p>
            <div className="row">
              <button className="glass-btn primary" type="button" onClick={acceptIncoming}>Repondre</button>
              <button className="glass-btn danger" type="button" onClick={rejectIncoming}>Refuser</button>
            </div>
          </div>
        )}

        <p>{voiceFx ? 'Mode voix fantome actif sur le flux sortant' : 'Mode voix normale'}</p>
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
