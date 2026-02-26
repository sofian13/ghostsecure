"use client";

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import SecurityShell from '@/components/SecurityShell';
import MobileTabs from '@/components/MobileTabs';
import { createConversation } from '@/lib/api';
import { getSession } from '@/lib/session';
import { getSupabaseClient } from '@/lib/supabase';

type VoicePreset = 'normal' | 'ghost' | 'robot' | 'deep' | 'vader';

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

async function withTimeout<T>(promise: Promise<T>, ms: number, reason: string): Promise<T> {
  let timer: number | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(reason)), ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) window.clearTimeout(timer);
  }
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
const LOW_BANDWIDTH_AUDIO_MAX_BITRATE = 18000;
const ICE_PARTIAL_GATHERING_CALLER_MS = 2600;
const ICE_PARTIAL_GATHERING_CALLEE_MS = 2200;
const CONNECT_SLOW_NETWORK_TIMEOUT_MS = 45000;
const CALL_SETUP_MAX_MS = 18000;
const ANSWER_WAIT_TIMEOUT_MS = 30000;
const REJECT_COOLDOWN_MS = 15000;

export default function CallPage() {
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [targetId, setTargetId] = useState('');
  const [autoCall, setAutoCall] = useState(false);
  const [autoAccept, setAutoAccept] = useState(false);
  const [autoAcceptInviteId, setAutoAcceptInviteId] = useState('');
  const [connected, setConnected] = useState(false);
  const [voicePreset, setVoicePreset] = useState<VoicePreset>('normal');
  const [statusText, setStatusText] = useState('Pret');
  const [incomingOffer, setIncomingOffer] = useState<IncomingOffer | null>(null);
  const [history, setHistory] = useState<InviteRow[]>([]);
  const hasTarget = targetId.trim() !== '';

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
  const rejectCooldownRef = useRef<Record<string, number>>({});
  const connectTimeoutRef = useRef<number | null>(null);
  const setupTimeoutRef = useRef<number | null>(null);
  const callStartingRef = useRef(false);
  const autoCalledRef = useRef(false);
  const autoAcceptedRef = useRef(false);

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
    setAutoAccept(query.get('autoaccept') === '1');
    setAutoAcceptInviteId(query.get('invite') ?? '');
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
    void loadHistory(userId);
  }, [userId]);

  useEffect(() => {
    if (!userId || !hasTarget) return;
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
    startIncomingPolling(userId);
    setStatusText('Signalisation prete');

    return () => {
      void supabase.removeChannel(inviteChannel);
      if (incomingPollRef.current) window.clearInterval(incomingPollRef.current);
      incomingPollRef.current = null;
    };
  }, [userId, hasTarget]);

  useEffect(() => {
    if (!hasTarget || !autoCall || autoCalledRef.current || !targetId) return;
    autoCalledRef.current = true;
    void startCall();
  }, [autoCall, targetId, hasTarget]);

  useEffect(() => {
    if (!autoAccept || autoAcceptedRef.current || !incomingOffer) return;
    if (autoAcceptInviteId && incomingOffer.inviteId !== autoAcceptInviteId) return;
    autoAcceptedRef.current = true;
    void acceptIncoming();
  }, [autoAccept, autoAcceptInviteId, incomingOffer]);

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

    if (to === me && (row.status === 'accepted' || row.status === 'rejected' || row.status === 'ended')) {
      if (incomingOffer?.inviteId === row.id) setIncomingOffer(null);
      lastIncomingInviteRef.current = row.id;
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

  const waitIceGatheringPartial = (pc: RTCPeerConnection, ms: number): Promise<void> =>
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
      }, ms);
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
      lowShelf.frequency.value = 200;
      lowShelf.gain.value = 22;
      const peaking = ctx.createBiquadFilter();
      peaking.type = 'peaking';
      peaking.frequency.value = 260;
      peaking.Q.value = 1.1;
      peaking.gain.value = 12;
      const lowpass = ctx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = 900;
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -30;
      compressor.knee.value = 16;
      compressor.ratio.value = 12;
      compressor.attack.value = 0.008;
      compressor.release.value = 0.22;
      const shaper = ctx.createWaveShaper();
      shaper.curve = createDistortionCurve(75);
      shaper.oversample = '4x';
      source.connect(lowShelf);
      lowShelf.connect(peaking);
      peaking.connect(lowpass);
      lowpass.connect(compressor);
      compressor.connect(shaper);
      shaper.connect(destination);
    } else if (preset === 'vader') {
      const highpass = ctx.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = 55;

      const lowShelf = ctx.createBiquadFilter();
      lowShelf.type = 'lowshelf';
      lowShelf.frequency.value = 160;
      lowShelf.gain.value = 26;

      const lowpass = ctx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = 520;
      lowpass.Q.value = 0.9;

      const peaking = ctx.createBiquadFilter();
      peaking.type = 'peaking';
      peaking.frequency.value = 115;
      peaking.Q.value = 1.4;
      peaking.gain.value = 18;

      const ring = ctx.createGain();
      ring.gain.value = 0.8;
      const lfo = ctx.createOscillator();
      const lfoDepth = ctx.createGain();
      lfo.type = 'sawtooth';
      lfo.frequency.value = 36;
      lfoDepth.gain.value = 0.55;
      lfo.connect(lfoDepth);
      lfoDepth.connect(ring.gain);
      lfo.start();
      cleanup.push(() => lfo.stop());

      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -36;
      compressor.knee.value = 20;
      compressor.ratio.value = 14;
      compressor.attack.value = 0.004;
      compressor.release.value = 0.2;

      const shaper = ctx.createWaveShaper();
      shaper.curve = createDistortionCurve(120);
      shaper.oversample = '4x';

      const delay = ctx.createDelay(0.08);
      delay.delayTime.value = 0.028;
      const delayGain = ctx.createGain();
      delayGain.gain.value = 0.24;
      delay.connect(delayGain);
      delayGain.connect(delay);

      source.connect(highpass);
      highpass.connect(lowShelf);
      lowShelf.connect(peaking);
      peaking.connect(lowpass);
      lowpass.connect(ring);
      ring.connect(compressor);
      compressor.connect(shaper);
      shaper.connect(destination);
      shaper.connect(delay);
      delay.connect(destination);
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
    const senders = outbound.getTracks().map((track) => pc.addTrack(track, outbound));
    for (const sender of senders) {
      if (sender.track?.kind !== 'audio') continue;
      try {
        const params = sender.getParameters();
        const encodings = params.encodings?.length ? [...params.encodings] : [{}];
        encodings[0] = { ...encodings[0], maxBitrate: LOW_BANDWIDTH_AUDIO_MAX_BITRATE };
        await sender.setParameters({ ...params, encodings });
      } catch {
        // Some browsers can reject setParameters early; call setup remains functional without it.
      }
    }

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
    if (setupTimeoutRef.current) window.clearTimeout(setupTimeoutRef.current);
    setupTimeoutRef.current = null;
    callStartingRef.current = false;
    setConnected(false);
  };

  const startCall = async () => {
    if (callStartingRef.current) return;
    const me = normalizeUserId(userId);
    const target = normalizeUserId(targetId);
    if (!me || !target) return;

    try {
      callStartingRef.current = true;
      await Promise.race([
        cleanupOpenInvites(me, target),
        new Promise<void>((resolve) => window.setTimeout(resolve, 700)),
      ]);
      teardownPeer();
      callStartingRef.current = true;
      if (setupTimeoutRef.current) window.clearTimeout(setupTimeoutRef.current);
      setupTimeoutRef.current = window.setTimeout(() => {
        if (callStartingRef.current) setStatusText('Preparation trop longue. Verifiez micro/reseau puis reessayez.');
      }, CALL_SETUP_MAX_MS);
      setIncomingOffer(null);
      setStatusText('Preparation de l appel...');

      const callId = crypto.randomUUID();
      const inviteId = crypto.randomUUID();
      const pc = await withTimeout(
        ensurePeer(target, callId),
        CALL_SETUP_MAX_MS,
        'Timeout preparation audio (micro/reseau)'
      );
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      await waitIceGatheringPartial(pc, ICE_PARTIAL_GATHERING_CALLER_MS);

      const supabase = getSupabaseClient();
      const insertResult = (await withTimeout(
        Promise.resolve(supabase.from('call_invite').insert({
          id: inviteId,
          call_id: callId,
          from_user_id: me,
          target_user_id: target,
          offer_sdp: pc.localDescription ?? offer,
          status: 'pending',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })),
        CALL_SETUP_MAX_MS,
        'Timeout signalisation appel'
      )) as { error: { message: string } | null };
      const { error } = insertResult;
      if (error) {
        setStatusText(`Erreur signalisation: ${error.message}`);
        teardownPeer();
        return;
      }
      activeInviteIdRef.current = inviteId;
      setStatusText(`Sonnerie chez ${target}...`);
      if (connectTimeoutRef.current) window.clearTimeout(connectTimeoutRef.current);
      connectTimeoutRef.current = window.setTimeout(() => {
        const state = pcRef.current?.connectionState;
        if (state !== 'connected') setStatusText('Connexion lente. Reessayez ou ajoutez TURN dedie.');
      }, CONNECT_SLOW_NETWORK_TIMEOUT_MS);
      startAnswerPolling(inviteId);
      void finalizeOfferSdp(inviteId);
      await loadHistory(me);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Preparation appel echouee';
      setStatusText(message);
      teardownPeer();
    } finally {
      callStartingRef.current = false;
      if (setupTimeoutRef.current) window.clearTimeout(setupTimeoutRef.current);
      setupTimeoutRef.current = null;
    }
  };

  const acceptIncoming = async () => {
    const incoming = incomingOffer;
    if (!incoming) return;
    lastIncomingInviteRef.current = incoming.inviteId;
    setIncomingOffer(null);
    setStatusText(`Reponse automatique a ${incoming.fromUserId}...`);

    const pc = await ensurePeer(incoming.fromUserId, incoming.callId);
    await pc.setRemoteDescription(incoming.sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitIceGatheringPartial(pc, ICE_PARTIAL_GATHERING_CALLEE_MS);

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
    void finalizeAnswerSdp(incoming.inviteId);
    if (userId) await loadHistory(userId);
  };

  const rejectIncoming = async () => {
    const incoming = incomingOffer;
    if (!incoming) return;
    const me = normalizeUserId(userId);
    const supabase = getSupabaseClient();
    await supabase
      .from('call_invite')
      .update({ status: 'rejected', updated_at: new Date().toISOString() })
      .eq('id', incoming.inviteId);
    if (me) {
      await supabase
        .from('call_invite')
        .update({ status: 'rejected', updated_at: new Date().toISOString() })
        .eq('target_user_id', me)
        .eq('from_user_id', incoming.fromUserId)
        .eq('status', 'pending');
    }
    rejectCooldownRef.current[incoming.fromUserId] = Date.now() + REJECT_COOLDOWN_MS;
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

  const recallFromHistory = async (peer: string) => {
    const session = getSession();
    if (!session) {
      router.replace('/login');
      return;
    }
    const conversation = await createConversation(session, normalizeUserId(peer));
    router.push(`/chat/${encodeURIComponent(conversation.id)}?autocall=1`);
  };

  function applyIncomingOffer(row: InviteRow) {
    const from = normalizeUserId(row.from_user_id);
    if (!from || row.status !== 'pending') return;
    const cooldownUntil = rejectCooldownRef.current[from] ?? 0;
    if (Date.now() < cooldownUntil) return;
    if (row.id === lastIncomingInviteRef.current) return;
    if (incomingOffer?.inviteId === row.id) return;
    if (activeInviteIdRef.current === row.id) return;
    if (connected || pcRef.current) return;
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
    }, 700);
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

  async function finalizeOfferSdp(inviteId: string) {
    const pc = pcRef.current;
    if (!pc) return;
    await waitIceGatheringComplete(pc);
    const supabase = getSupabaseClient();
    await supabase
      .from('call_invite')
      .update({ offer_sdp: pc.localDescription, updated_at: new Date().toISOString() })
      .eq('id', inviteId)
      .eq('status', 'pending');
  }

  async function finalizeAnswerSdp(inviteId: string) {
    const pc = pcRef.current;
    if (!pc) return;
    await waitIceGatheringComplete(pc);
    const supabase = getSupabaseClient();
    await supabase
      .from('call_invite')
      .update({ answer_sdp: pc.localDescription, updated_at: new Date().toISOString() })
      .eq('id', inviteId)
      .eq('status', 'accepted');
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
      if (row.status === 'rejected' || row.status === 'ended' || Date.now() - startedAt > ANSWER_WAIT_TIMEOUT_MS) {
        if (Date.now() - startedAt > ANSWER_WAIT_TIMEOUT_MS) {
          setStatusText('Aucune reponse. Verifiez la connexion puis reessayez.');
          void getSupabaseClient()
            .from('call_invite')
            .update({ status: 'ended', updated_at: new Date().toISOString() })
            .eq('id', inviteId)
            .eq('status', 'pending');
          teardownPeer();
        }
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
            <p className="muted-text">{hasTarget ? 'Appel en cours' : 'Historique securise'}</p>
          </div>
        </header>

        {hasTarget && (
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
              <option value="vader">Vader</option>
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
        )}

        {hasTarget && incomingOffer && (
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
          ))}
        </section>

        <MobileTabs />
      </main>
    </SecurityShell>
  );
}
