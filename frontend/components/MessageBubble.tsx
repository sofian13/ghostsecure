"use client";

import { useEffect, useMemo, useState } from 'react';

type VoicePayload = {
  mimeType: string;
  dataBase64: string;
  durationMs: number;
};

type Props = {
  kind: 'text' | 'voice';
  text?: string;
  voice?: VoicePayload;
  mine: boolean;
  expiresAt: string | null;
};

function b64ToBytes(base64: string): Uint8Array {
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export default function MessageBubble({ kind, text, voice, mine, expiresAt }: Props) {
  const [revealed, setRevealed] = useState(false);
  const [isExpired, setIsExpired] = useState(false);

  useEffect(() => {
    if (!expiresAt) return;
    const deadline = new Date(expiresAt).getTime();
    const update = () => setIsExpired(Date.now() > deadline);
    update();
    const id = window.setInterval(update, 1000);
    return () => window.clearInterval(id);
  }, [expiresAt]);

  useEffect(() => {
    if (!revealed) return;
    const id = window.setTimeout(() => setRevealed(false), 6000);
    return () => window.clearTimeout(id);
  }, [revealed]);

  const voiceUrl = useMemo(() => {
    if (kind !== 'voice' || !voice?.dataBase64) return null;
    const blob = new Blob([b64ToBytes(voice.dataBase64)], { type: voice.mimeType || 'audio/webm' });
    return URL.createObjectURL(blob);
  }, [kind, voice?.dataBase64, voice?.mimeType]);

  useEffect(() => {
    return () => {
      if (voiceUrl) URL.revokeObjectURL(voiceUrl);
    };
  }, [voiceUrl]);

  if (isExpired) {
    return <div className={`message-bubble ${mine ? 'mine' : 'peer'}`}>[message supprime]</div>;
  }

  return (
    <button
      type="button"
      className={`message-bubble ${mine ? 'mine' : 'peer'}`}
      onClick={() => setRevealed((v) => !v)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {!revealed && (kind === 'voice' ? 'cliquer pour ecouter vocal' : 'cliquer pour afficher')}

      {revealed && kind === 'text' && <span>{text}</span>}

      {revealed && kind === 'voice' && voice && voiceUrl && (
        <div className="voice-message">
          <audio controls preload="metadata" src={voiceUrl} />
          <span>{Math.max(1, Math.round((voice.durationMs || 0) / 1000))}s</span>
        </div>
      )}
    </button>
  );
}
