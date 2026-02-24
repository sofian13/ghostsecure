"use client";

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import SecurityShell from '@/components/SecurityShell';
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
  const [voicePreset, setVoicePreset] = useState<VoicePreset>('normal');
  const [statusText, setStatusText] = useState('Pret');
  const [incomingOffer, setIncomingOffer] = useState<IncomingOffer | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const processedStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const processingCleanupRef = useRef<(() => void) | null>(null);
  const activeCallIdRef = useRef<string | null>(null);
  const activeInviteIdRef = useRef<string | null>(null);
  const activeTargetRef = useRef<string | null>(null);
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
    const inviteChannel = supabase
      .channel(`call-invite:${userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'call_invite' }, async (payload) => {
        const row = (payload.new || payload.old) as InviteRow | undefined;
        if (!row) return;
        await handleInviteEvent(row);
      })
      .subscribe();

    void hydratePendingInvite(userId);
    setStatusText('Signalisation prete');

    return () => {
      void supabase.removeChannel(inviteChannel);
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
      return;
    }

    if (from === me && activeCallIdRef.current === row.call_id) {
      if (row.status === 'accepted' && row.answer_sdp && pcRef.current && !pcRef.current.remoteDescription) {
        await pcRef.current.setRemoteDescription(row.answer_sdp);
        setStatusText('Connexion audio...');
      }
      if (row.status === 'rejected' || row.status === 'ended') {
        setStatusText('Appel termine/refuse');
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
      }, 4000);
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
      if (state === 'failed') setStatusText('Connexion echouee (TURN requis sur ce reseau)');
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
    if (!me || !target) return;

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
        <p className="muted-text">Messages permanents + vocal + signalisation stable.</p>
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
          <button className="glass-btn primary" type="button" onClick={startCall}>Appeler</button>
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
