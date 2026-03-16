"use client";

import { getSupabaseClient } from '@/lib/supabase';

export type VoicePreset = 'normal' | 'ghost' | 'robot' | 'deep' | 'vader' | 'anonymous' | 'grave';

export type InviteRow = {
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

export type IncomingOffer = {
  inviteId: string;
  callId: string;
  fromUserId: string;
  sdp: RTCSessionDescriptionInit;
};

export type CallSessionSnapshot = {
  targetId: string;
  connected: boolean;
  voicePreset: VoicePreset;
  statusText: string;
  speakerOn: boolean;
  callActive: boolean;
};

const LOW_BANDWIDTH_AUDIO_MAX_BITRATE = 18000;
const ICE_PARTIAL_GATHERING_CALLER_MS = 2600;
const ICE_PARTIAL_GATHERING_CALLEE_MS = 2200;
const CONNECT_SLOW_NETWORK_TIMEOUT_MS = 45000;
const CALL_SETUP_MAX_MS = 18000;
const ANSWER_WAIT_TIMEOUT_MS = 30000;

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
  } else if (process.env.NODE_ENV !== 'production') {
    console.warn('Using public TURN relay (dev only). Configure NEXT_PUBLIC_TURN_* for production.');
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

class CallSessionManager {
  private listeners = new Set<() => void>();

  private state: CallSessionSnapshot = {
    targetId: '',
    connected: false,
    voicePreset: 'normal',
    statusText: 'Pret',
    speakerOn: false,
    callActive: false,
  };

  private pc: RTCPeerConnection | null = null;

  private localStream: MediaStream | null = null;

  private processedStream: MediaStream | null = null;

  private remoteAudio: HTMLAudioElement | null = null;

  private audioCtx: AudioContext | null = null;

  private processingCleanup: (() => void) | null = null;

  private activeCallId: string | null = null;

  private activeInviteId: string | null = null;

  private answerPoll: number | null = null;

  private connectTimeout: number | null = null;

  private setupTimeout: number | null = null;

  private callStarting = false;

  private accepting = false;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): CallSessionSnapshot => this.state;

  setTarget(targetId: string) {
    const nextTarget = normalizeUserId(targetId);
    if (this.state.callActive && this.state.targetId && nextTarget && this.state.targetId !== nextTarget) {
      return;
    }
    this.setState({ targetId: nextTarget });
  }

  async setVoicePreset(preset: VoicePreset) {
    this.setState({ voicePreset: preset });
    if (!this.pc || !this.localStream) return;
    await this.replaceOutgoingTrack(preset);
  }

  async toggleSpeaker() {
    const next = !this.state.speakerOn;
    this.setState({ speakerOn: next });
    await this.applySpeakerMode(next);
  }

  async startCall(userId: string, rawTargetId: string) {
    if (this.callStarting || this.pc) return;
    const me = normalizeUserId(userId);
    const target = normalizeUserId(rawTargetId || this.state.targetId);
    if (!me || !target) return;

    try {
      this.callStarting = true;
      this.setState({ targetId: target, callActive: true });

      await Promise.race([
        this.cleanupOpenInvites(me, target),
        new Promise<void>((resolve) => window.setTimeout(resolve, 700)),
      ]);

      this.teardownPeer(false);
      this.callStarting = true;
      if (this.setupTimeout) window.clearTimeout(this.setupTimeout);
      this.setupTimeout = window.setTimeout(() => {
        if (this.callStarting) this.setState({ statusText: 'Preparation trop longue. Verifiez micro/reseau puis reessayez.' });
      }, CALL_SETUP_MAX_MS);
      this.setState({ statusText: 'Preparation de l appel...' });

      const callId = crypto.randomUUID();
      const inviteId = crypto.randomUUID();
      const pc = await withTimeout(
        this.ensurePeer(target, callId),
        CALL_SETUP_MAX_MS,
        'Timeout preparation audio (micro/reseau)'
      );
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      await this.waitIceGatheringPartial(pc, ICE_PARTIAL_GATHERING_CALLER_MS);

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

      if (insertResult.error) {
        this.setState({ statusText: `Erreur signalisation: ${insertResult.error.message}` });
        this.teardownPeer(false);
        return;
      }

      this.activeInviteId = inviteId;
      this.setState({ statusText: `Sonnerie chez ${target}...`, callActive: true, targetId: target });
      if (this.connectTimeout) window.clearTimeout(this.connectTimeout);
      this.connectTimeout = window.setTimeout(() => {
        const state = this.pc?.connectionState;
        if (state !== 'connected') {
          this.setState({ statusText: 'Connexion lente. Reessayez ou ajoutez TURN dedie.' });
        }
      }, CONNECT_SLOW_NETWORK_TIMEOUT_MS);

      this.startAnswerPolling(inviteId, true);
      void this.finalizeOfferSdp(inviteId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Preparation appel echouee';
      this.setState({ statusText: message, callActive: false });
      this.teardownPeer(false);
    } finally {
      this.callStarting = false;
      if (this.setupTimeout) window.clearTimeout(this.setupTimeout);
      this.setupTimeout = null;
    }
  }

  async acceptIncoming(userId: string, incoming: IncomingOffer) {
    if (this.accepting) return;
    this.accepting = true;
    try {
      this.setState({
        targetId: normalizeUserId(incoming.fromUserId),
        statusText: `Reponse a ${incoming.fromUserId}...`,
        callActive: true,
      });

      const pc = await this.ensurePeer(incoming.fromUserId, incoming.callId);
      await pc.setRemoteDescription(incoming.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await this.waitIceGatheringPartial(pc, ICE_PARTIAL_GATHERING_CALLEE_MS);

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
        this.setState({ statusText: `Erreur reponse: ${error.message}`, callActive: false });
        this.teardownPeer(false);
        return;
      }

      const me = normalizeUserId(userId);
      if (me) {
        await supabase
          .from('call_invite')
          .update({ status: 'rejected', updated_at: new Date().toISOString() })
          .eq('target_user_id', me)
          .eq('from_user_id', incoming.fromUserId)
          .eq('status', 'pending')
          .neq('id', incoming.inviteId);
      }

      this.activeInviteId = incoming.inviteId;
      this.setState({
        targetId: normalizeUserId(incoming.fromUserId),
        statusText: `Connexion avec ${incoming.fromUserId}...`,
        callActive: true,
      });
      this.startAnswerPolling(incoming.inviteId, false);
      void this.finalizeAnswerSdp(incoming.inviteId);
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : 'Erreur inconnue';
      this.setState({ statusText: `Echec de reponse (${detail}). Reessayez.`, callActive: false });
      this.teardownPeer(false);
    } finally {
      this.accepting = false;
    }
  }

  async rejectIncoming(userId: string, incoming: IncomingOffer) {
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
    this.setState({ statusText: 'Appel refuse' });
  }

  async endCall() {
    const inviteId = this.activeInviteId;
    if (inviteId) {
      const supabase = getSupabaseClient();
      await supabase
        .from('call_invite')
        .update({ status: 'ended', updated_at: new Date().toISOString() })
        .eq('id', inviteId);
    }
    this.teardownPeer(false);
    this.setState({ statusText: 'Appel termine', callActive: false, connected: false, speakerOn: false });
  }

  private emit() {
    this.listeners.forEach((listener) => listener());
  }

  private setState(patch: Partial<CallSessionSnapshot>) {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private ensureRemoteAudio(): HTMLAudioElement {
    if (this.remoteAudio && document.body.contains(this.remoteAudio)) return this.remoteAudio;
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.muted = false;
    audio.setAttribute('playsinline', 'true');
    audio.style.position = 'fixed';
    audio.style.width = '1px';
    audio.style.height = '1px';
    audio.style.opacity = '0';
    audio.style.pointerEvents = 'none';
    audio.style.bottom = '0';
    audio.style.left = '0';
    audio.setAttribute('aria-hidden', 'true');
    document.body.appendChild(audio);
    this.remoteAudio = audio;
    void this.applySpeakerMode(this.state.speakerOn);
    return audio;
  }

  private async applySpeakerMode(enabled: boolean) {
    const media = this.ensureRemoteAudio() as HTMLAudioElement & { setSinkId?: (deviceId: string) => Promise<void> };
    if (typeof media.setSinkId !== 'function' || !navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const outputs = devices.filter((device) => device.kind === 'audiooutput');
      if (outputs.length === 0) return;
      const preferred = enabled
        ? outputs.find((device) => /speaker|haut/i.test(device.label))
        : outputs.find((device) => /default|communications|head(phone|set)|ear/i.test(device.label)) ?? outputs[0];
      if (preferred?.deviceId) await media.setSinkId(preferred.deviceId);
    } catch {
      // Output routing is browser-dependent; keep the toggle state even if routing is unsupported.
    }
  }

  private async buildProcessedStream(input: MediaStream, preset: VoicePreset): Promise<MediaStream> {
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
    } else if (preset === 'anonymous') {
      const highpass = ctx.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = 180;

      const lowpass = ctx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = 2400;
      lowpass.Q.value = 0.8;

      const notch = ctx.createBiquadFilter();
      notch.type = 'notch';
      notch.frequency.value = 900;
      notch.Q.value = 3.5;

      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -24;
      compressor.knee.value = 8;
      compressor.ratio.value = 8;
      compressor.attack.value = 0.006;
      compressor.release.value = 0.18;

      const shaper = ctx.createWaveShaper();
      shaper.curve = createDistortionCurve(35);
      shaper.oversample = '4x';

      const tremolo = ctx.createGain();
      tremolo.gain.value = 0.92;
      const lfo = ctx.createOscillator();
      const lfoDepth = ctx.createGain();
      lfo.type = 'triangle';
      lfo.frequency.value = 18;
      lfoDepth.gain.value = 0.12;
      lfo.connect(lfoDepth);
      lfoDepth.connect(tremolo.gain);
      lfo.start();
      cleanup.push(() => lfo.stop());

      source.connect(highpass);
      highpass.connect(lowpass);
      lowpass.connect(notch);
      notch.connect(compressor);
      compressor.connect(shaper);
      shaper.connect(tremolo);
      tremolo.connect(destination);
    } else if (preset === 'grave') {
      const highpass = ctx.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = 70;

      const lowShelf = ctx.createBiquadFilter();
      lowShelf.type = 'lowshelf';
      lowShelf.frequency.value = 190;
      lowShelf.gain.value = 7;

      const bodyPeak = ctx.createBiquadFilter();
      bodyPeak.type = 'peaking';
      bodyPeak.frequency.value = 260;
      bodyPeak.Q.value = 0.9;
      bodyPeak.gain.value = 4;

      const formantShift = ctx.createBiquadFilter();
      formantShift.type = 'peaking';
      formantShift.frequency.value = 1700;
      formantShift.Q.value = 1.1;
      formantShift.gain.value = -3.5;

      const lowpass = ctx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = 3200;
      lowpass.Q.value = 0.7;

      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -22;
      compressor.knee.value = 10;
      compressor.ratio.value = 4;
      compressor.attack.value = 0.004;
      compressor.release.value = 0.16;

      source.connect(highpass);
      highpass.connect(lowShelf);
      lowShelf.connect(bodyPeak);
      bodyPeak.connect(formantShift);
      formantShift.connect(lowpass);
      lowpass.connect(compressor);
      compressor.connect(destination);
    } else {
      source.connect(destination);
    }

    this.audioCtx = ctx;
    this.processingCleanup = () => cleanup.forEach((fn) => fn());
    return destination.stream;
  }

  private async ensurePeer(target: string, callId: string) {
    if (this.pc) return this.pc;
    const local = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    this.localStream = local;

    let outbound = local;
    if (this.state.voicePreset !== 'normal') {
      outbound = await this.buildProcessedStream(local, this.state.voicePreset);
      this.processedStream = outbound;
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
      if (!stream) return;
      const audio = this.ensureRemoteAudio();
      audio.srcObject = stream;
      void audio.play().catch(() => null);
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      this.setState({ connected: state === 'connected' });
      if (state === 'connected') this.setState({ statusText: 'En appel', callActive: true });
      if (state === 'connecting') this.setState({ statusText: 'Connexion...', callActive: true });
      if (state === 'failed') this.setState({ statusText: 'Connexion echouee. Relancez appel ou configurez TURN dedie.' });
      if (state === 'disconnected') this.setState({ statusText: 'Reseau instable, reconnexion...' });
      if (state === 'connected' || state === 'failed' || state === 'closed') {
        if (this.connectTimeout) window.clearTimeout(this.connectTimeout);
        this.connectTimeout = null;
      }
    };

    this.activeCallId = callId;
    this.pc = pc;
    this.setState({ targetId: normalizeUserId(target), callActive: true });
    return pc;
  }

  private async replaceOutgoingTrack(preset: VoicePreset) {
    if (!this.pc || !this.localStream) return;
    const sender = this.pc.getSenders().find((entry) => entry.track?.kind === 'audio');
    if (!sender) return;

    if (preset === 'normal') {
      const originalTrack = this.localStream.getAudioTracks()[0];
      if (originalTrack) await sender.replaceTrack(originalTrack);
      this.processedStream?.getTracks().forEach((track) => track.stop());
      this.processedStream = null;
      this.processingCleanup?.();
      this.processingCleanup = null;
      await this.audioCtx?.close();
      this.audioCtx = null;
      return;
    }

    const processed = await this.buildProcessedStream(this.localStream, preset);
    const track = processed.getAudioTracks()[0];
    if (track) await sender.replaceTrack(track);
    this.processedStream?.getTracks().forEach((oldTrack) => oldTrack.stop());
    this.processedStream = processed;
  }

  private teardownPeer(clearTarget: boolean) {
    this.pc?.close();
    this.pc = null;
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.processedStream?.getTracks().forEach((track) => track.stop());
    this.localStream = null;
    this.processedStream = null;
    if (this.remoteAudio) {
      this.remoteAudio.pause();
      this.remoteAudio.srcObject = null;
    }
    this.processingCleanup?.();
    this.processingCleanup = null;
    void this.audioCtx?.close();
    this.audioCtx = null;
    this.activeCallId = null;
    this.activeInviteId = null;
    if (this.answerPoll) window.clearInterval(this.answerPoll);
    this.answerPoll = null;
    if (this.connectTimeout) window.clearTimeout(this.connectTimeout);
    this.connectTimeout = null;
    if (this.setupTimeout) window.clearTimeout(this.setupTimeout);
    this.setupTimeout = null;
    this.callStarting = false;
    this.setState({
      connected: false,
      callActive: false,
      speakerOn: false,
      ...(clearTarget ? { targetId: '' } : {}),
    });
  }

  private async waitIceGatheringComplete(pc: RTCPeerConnection): Promise<void> {
    await new Promise<void>((resolve) => {
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
  }

  private async waitIceGatheringPartial(pc: RTCPeerConnection, ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
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
  }

  private async cleanupOpenInvites(me: string, target: string) {
    const supabase = getSupabaseClient();
    await supabase
      .from('call_invite')
      .update({ status: 'ended', updated_at: new Date().toISOString() })
      .in('status', ['pending', 'accepted'])
      .or(
        `and(from_user_id.eq.${me},target_user_id.eq.${target}),and(from_user_id.eq.${target},target_user_id.eq.${me})`
      );
  }

  private async finalizeOfferSdp(inviteId: string) {
    const pc = this.pc;
    if (!pc) return;
    await this.waitIceGatheringComplete(pc);
    const supabase = getSupabaseClient();
    await supabase
      .from('call_invite')
      .update({ offer_sdp: pc.localDescription, updated_at: new Date().toISOString() })
      .eq('id', inviteId)
      .eq('status', 'pending');
  }

  private async finalizeAnswerSdp(inviteId: string) {
    const pc = this.pc;
    if (!pc) return;
    await this.waitIceGatheringComplete(pc);
    const supabase = getSupabaseClient();
    await supabase
      .from('call_invite')
      .update({ answer_sdp: pc.localDescription, updated_at: new Date().toISOString() })
      .eq('id', inviteId)
      .eq('status', 'accepted');
  }

  private startAnswerPolling(inviteId: string, caller: boolean) {
    if (this.answerPoll) window.clearInterval(this.answerPoll);
    const supabase = getSupabaseClient();
    const startedAt = Date.now();
    this.answerPoll = window.setInterval(async () => {
      if (!this.pc && caller) return;
      const { data } = await supabase
        .from('call_invite')
        .select('id,call_id,from_user_id,target_user_id,offer_sdp,answer_sdp,status')
        .eq('id', inviteId)
        .maybeSingle();
      if (!data) return;
      const row = data as InviteRow;

      if (caller && row.status === 'accepted' && row.answer_sdp && this.pc && !this.pc.remoteDescription) {
        await this.pc.setRemoteDescription(row.answer_sdp);
        this.setState({ statusText: 'Connexion audio...', callActive: true });
      }

      if (row.status === 'rejected' || row.status === 'ended') {
        this.setState({ statusText: row.status === 'rejected' ? 'Appel refuse' : 'Appel termine' });
        this.teardownPeer(false);
        return;
      }

      if (caller && Date.now() - startedAt > ANSWER_WAIT_TIMEOUT_MS && !this.pc?.remoteDescription) {
        this.setState({ statusText: 'Aucune reponse. Verifiez la connexion puis reessayez.' });
        void getSupabaseClient()
          .from('call_invite')
          .update({ status: 'ended', updated_at: new Date().toISOString() })
          .eq('id', inviteId)
          .eq('status', 'pending');
        this.teardownPeer(false);
      }
    }, 1300);
  }
}

export const callSession = new CallSessionManager();
