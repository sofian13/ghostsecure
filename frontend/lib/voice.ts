"use client";

export type VoicePresetId = 'natural' | 'ghost' | 'radio' | 'vault';

export type VoicePreset = {
  id: VoicePresetId;
  label: string;
  emoji: string;
  description: string;
};

const WAV_MIME = 'audio/wav';

export const VOICE_PRESETS: VoicePreset[] = [
  { id: 'natural', label: 'Naturelle', emoji: 'N', description: 'Aucun filtre, rendu brut.' },
  { id: 'ghost', label: 'Fantome', emoji: 'G', description: 'Plus aerien et masque.' },
  { id: 'radio', label: 'Radio', emoji: 'R', description: 'Bande etroite, type talkie.' },
  { id: 'vault', label: 'Coffre', emoji: 'C', description: 'Plus dense et mecanique.' },
];

type PresetConfig = {
  highpass: number;
  lowpass: number;
  peakingFrequency: number;
  peakingGain: number;
  peakingQ: number;
  distortion: number;
  tremoloHz: number;
  tremoloDepth: number;
  outputGain: number;
};

const PRESET_CONFIG: Record<Exclude<VoicePresetId, 'natural'>, PresetConfig> = {
  ghost: {
    highpass: 180,
    lowpass: 2800,
    peakingFrequency: 2200,
    peakingGain: -5,
    peakingQ: 1.2,
    distortion: 24,
    tremoloHz: 7,
    tremoloDepth: 0.025,
    outputGain: 0.96,
  },
  radio: {
    highpass: 420,
    lowpass: 2100,
    peakingFrequency: 1400,
    peakingGain: 4,
    peakingQ: 1.8,
    distortion: 16,
    tremoloHz: 0,
    tremoloDepth: 0,
    outputGain: 0.92,
  },
  vault: {
    highpass: 120,
    lowpass: 1850,
    peakingFrequency: 780,
    peakingGain: 6,
    peakingQ: 0.9,
    distortion: 30,
    tremoloHz: 4,
    tremoloDepth: 0.015,
    outputGain: 0.98,
  },
};

function createDistortionCurve(amount: number): Float32Array {
  const k = Math.max(0, amount);
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const x = (i * 2) / n - 1;
    curve[i] = ((3 + k) * x * 20 * (Math.PI / 180)) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}

function interleaveChannels(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) {
    return buffer.getChannelData(0);
  }

  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  const result = new Float32Array(buffer.length * 2);
  for (let i = 0; i < buffer.length; i += 1) {
    result[i * 2] = left[i];
    result[i * 2 + 1] = right[i];
  }
  return result;
}

function encodeWav(buffer: AudioBuffer): Blob {
  const channels = Math.min(buffer.numberOfChannels, 2);
  const sampleRate = buffer.sampleRate;
  const source = channels === 1 ? buffer : new AudioBuffer({ length: buffer.length, numberOfChannels: channels, sampleRate });
  if (channels === 2 && source !== buffer) {
    source.copyToChannel(buffer.getChannelData(0), 0);
    source.copyToChannel(buffer.getChannelData(1), 1);
  }
  const samples = interleaveChannels(source);
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const wav = new ArrayBuffer(44 + dataSize);
  const view = new DataView(wav);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }

  return new Blob([wav], { type: WAV_MIME });
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}

async function decodeBlob(blob: Blob): Promise<AudioBuffer> {
  const audioWindow = window as Window & typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };
  const Ctx = audioWindow.AudioContext ?? audioWindow.webkitAudioContext;
  if (!Ctx) throw new Error('Traitement vocal indisponible sur cet appareil');
  const ctx = new Ctx();
  try {
    const arrayBuffer = await blob.arrayBuffer();
    return await ctx.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    await ctx.close();
  }
}

export async function transformVoiceBlob(blob: Blob, presetId: VoicePresetId): Promise<Blob> {
  if (presetId === 'natural') {
    return blob;
  }

  const buffer = await decodeBlob(blob);
  const config = PRESET_CONFIG[presetId];
  const context = new OfflineAudioContext(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  const source = context.createBufferSource();
  source.buffer = buffer;

  const highpass = context.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = config.highpass;

  const lowpass = context.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = config.lowpass;
  lowpass.Q.value = 0.8;

  const peaking = context.createBiquadFilter();
  peaking.type = 'peaking';
  peaking.frequency.value = config.peakingFrequency;
  peaking.gain.value = config.peakingGain;
  peaking.Q.value = config.peakingQ;

  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = -24;
  compressor.knee.value = 12;
  compressor.ratio.value = 10;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.16;

  const shaper = context.createWaveShaper();
  shaper.curve = createDistortionCurve(config.distortion);
  shaper.oversample = '4x';

  const output = context.createGain();
  output.gain.value = config.outputGain;

  source.connect(highpass);
  highpass.connect(lowpass);
  lowpass.connect(peaking);
  peaking.connect(compressor);
  compressor.connect(shaper);

  if (config.tremoloHz > 0 && config.tremoloDepth > 0) {
    const tremolo = context.createGain();
    tremolo.gain.value = 1 - config.tremoloDepth;
    const lfo = context.createOscillator();
    const lfoDepth = context.createGain();
    lfo.type = 'triangle';
    lfo.frequency.value = config.tremoloHz;
    lfoDepth.gain.value = config.tremoloDepth;
    lfo.connect(lfoDepth);
    lfoDepth.connect(tremolo.gain);
    shaper.connect(tremolo);
    tremolo.connect(output);
    lfo.start(0);
  } else {
    shaper.connect(output);
  }

  output.connect(context.destination);
  source.start(0);
  const rendered = await context.startRendering();
  return encodeWav(rendered);
}
