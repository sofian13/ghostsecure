"use client";

import { useEffect, useRef, useState } from 'react';

type Props = {
  active: boolean;
};

export default function VoiceModifier({ active }: Props) {
  const audioCtx = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      audioCtx.current?.close();
    };
  }, []);

  const start = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    streamRef.current = stream;

    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
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

    source.connect(filter);
    filter.connect(shaper);
    shaper.connect(ctx.destination);

    audioCtx.current = ctx;
    setEnabled(true);
  };

  const stop = async () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    await audioCtx.current?.close();
    audioCtx.current = null;
    setEnabled(false);
  };

  if (!active) return null;

  return (
    <div className="voice-modifier-card">
      <p>Voice modifier: pitch + light distortion</p>
      <button type="button" onClick={enabled ? stop : start} className="ghost-btn">
        {enabled ? 'Desactiver modificateur' : 'Activer modificateur'}
      </button>
    </div>
  );
}
