"use client";

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { RealtimeChannel } from '@supabase/supabase-js';
import SecurityShell from '@/components/SecurityShell';
import { getSession } from '@/lib/session';
import { getSupabaseClient } from '@/lib/supabase';

type CallSignalPayload = {
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};

type CallSignalFrame = {
  fromUserId?: string;
  targetUserId?: string;
  payload?: CallSignalPayload;
};

export default function CallPage() {
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [targetId, setTargetId] = useState('');
  const [connected, setConnected] = useState(false);
  const [voiceFx, setVoiceFx] = useState(false);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const processedStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    const s = getSession();
    if (!s) {
      router.replace('/login');
      return;
    }
    setUserId(s.userId);
  }, [router]);

  useEffect(() => {
    if (!userId) return;
    const supabase = getSupabaseClient();
    const channel = supabase
      .channel('call-signaling')
      .on('broadcast', { event: 'call_signal' }, async ({ payload }) => {
        const msg = payload as CallSignalFrame;
        if (!msg || msg.targetUserId !== userId || !msg.fromUserId) return;

        setTargetId(msg.fromUserId);
        await ensurePeer(msg.fromUserId);
        const pc = pcRef.current;
        if (!pc) return;

        if (msg.payload?.sdp) {
          await pc.setRemoteDescription(msg.payload.sdp);
          if (msg.payload.sdp.type === 'offer') {
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            await channel.send({
              type: 'broadcast',
              event: 'call_signal',
              payload: {
                fromUserId: userId,
                targetUserId: msg.fromUserId,
                payload: { sdp: answer }
              }
            });
          }
        }

        if (msg.payload?.candidate) {
          await pc.addIceCandidate(msg.payload.candidate);
        }
      })
      .subscribe();
    channelRef.current = channel;

    return () => {
      void supabase.removeChannel(channel);
      pcRef.current?.close();
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      processedStreamRef.current?.getTracks().forEach((t) => t.stop());
      audioCtxRef.current?.close();
      pcRef.current = null;
      localStreamRef.current = null;
      processedStreamRef.current = null;
      audioCtxRef.current = null;
    };
  }, [userId]);

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

  const ensurePeer = async (targetOverride?: string) => {
    if (pcRef.current) return;

    const local = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    localStreamRef.current = local;

    let outbound = local;
    if (voiceFx) {
      outbound = buildProcessedStream(local);
      processedStreamRef.current = outbound;
    }

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    outbound.getTracks().forEach((track) => pc.addTrack(track, outbound));

    pc.onicecandidate = (event) => {
      const target = (targetOverride ?? targetId).trim();
      if (!event.candidate || !channelRef.current || !target || !userId) return;
      void channelRef.current.send({
        type: 'broadcast',
        event: 'call_signal',
        payload: {
          fromUserId: userId,
          targetUserId: target,
          payload: { candidate: event.candidate.toJSON() }
        }
      });
    };

    pc.onconnectionstatechange = () => {
      setConnected(pc.connectionState === 'connected');
    };

    pcRef.current = pc;
  };

  const startCall = async () => {
    if (!targetId.trim() || !channelRef.current || !userId) return;
    await ensurePeer();
    const pc = pcRef.current;
    if (!pc) return;

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    await channelRef.current.send({
      type: 'broadcast',
      event: 'call_signal',
      payload: {
        fromUserId: userId,
        targetUserId: targetId.trim(),
        payload: { sdp: offer }
      }
    });
  };

  const endCall = () => {
    pcRef.current?.close();
    pcRef.current = null;
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    processedStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    processedStreamRef.current = null;
    audioCtxRef.current?.close();
    audioCtxRef.current = null;
    setConnected(false);
  };

  if (!userId) return <main className="centered">Loading...</main>;

  return (
    <SecurityShell userId={userId}>
      <main className="call-screen">
        <h1>Ghost Secure Call</h1>
        <p>WebRTC audio E2EE (DTLS-SRTP) + mode voix fantome.</p>
        <input
          className="ghost-input"
          value={targetId}
          onChange={(e) => setTargetId(e.target.value)}
          placeholder="ID utilisateur cible"
        />
        <div className="row">
          <button className="ghost-btn" type="button" onClick={startCall}>Demarrer appel</button>
          <button className="ghost-btn muted" type="button" onClick={endCall}>Terminer</button>
          <button className="ghost-btn muted" type="button" onClick={() => setVoiceFx((v) => !v)}>
            {voiceFx ? 'Voice FX Off' : 'Voice FX On'}
          </button>
          <button className="ghost-btn muted" type="button" onClick={() => router.push('/chat')}>Retour chat</button>
        </div>
        <p>{voiceFx ? 'Mode voix fantome actif sur le flux sortant' : 'Mode voix normale'}</p>
        <p className={connected ? 'ok-text' : ''}>{connected ? 'Canal audio securise actif' : 'En attente de connexion...'}</p>
      </main>
    </SecurityShell>
  );
}
