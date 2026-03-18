"use client";

const WAV_MIME = 'audio/wav';

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

/**
 * Transform a voice blob to the deepest/gravest voice possible.
 * Uses aggressive lowpass, pitch-shifting formant, and bass boost.
 */
export async function transformVoiceBlob(blob: Blob): Promise<Blob> {
  const buffer = await decodeBlob(blob);

  // Resample at lower rate to pitch-shift down (makes voice much deeper)
  const pitchFactor = 0.65;
  const newLength = Math.round(buffer.length / pitchFactor);
  const context = new OfflineAudioContext(buffer.numberOfChannels, newLength, buffer.sampleRate);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = pitchFactor;

  // Heavy lowpass to cut highs and keep only deep tones
  const lowpass = context.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = 1800;
  lowpass.Q.value = 0.6;

  // Highpass to remove rumble
  const highpass = context.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 80;

  // Bass boost
  const bass = context.createBiquadFilter();
  bass.type = 'peaking';
  bass.frequency.value = 200;
  bass.gain.value = 8;
  bass.Q.value = 0.8;

  // Compressor to keep it even
  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = -20;
  compressor.knee.value = 10;
  compressor.ratio.value = 12;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.15;

  // Mild distortion for texture
  const shaper = context.createWaveShaper();
  shaper.curve = createDistortionCurve(20);
  shaper.oversample = '4x';

  const output = context.createGain();
  output.gain.value = 0.95;

  source.connect(highpass);
  highpass.connect(lowpass);
  lowpass.connect(bass);
  bass.connect(compressor);
  compressor.connect(shaper);
  shaper.connect(output);
  output.connect(context.destination);
  source.start(0);

  const rendered = await context.startRendering();
  return encodeWav(rendered);
}
