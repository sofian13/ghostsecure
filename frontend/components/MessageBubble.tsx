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
  createdAt: string;
  status?: 'sent' | 'received' | 'read';
  expiresAt: string | null;
};

function b64ToBytes(base64: string): Uint8Array {
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export default function MessageBubble({ kind, text, voice, mine, createdAt, status = 'sent', expiresAt }: Props) {
  const [isExpired, setIsExpired] = useState(false);

  useEffect(() => {
    if (!expiresAt) return;
    const deadline = new Date(expiresAt).getTime();
    const update = () => setIsExpired(Date.now() > deadline);
    update();
    const id = window.setInterval(update, 1000);
    return () => window.clearInterval(id);
  }, [expiresAt]);

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

  const time = new Date(createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const statusLabel = mine ? (status === 'read' ? 'Lu' : status === 'received' ? 'Recu' : 'Envoye') : '';

  if (isExpired) {
    return <div className={`message-bubble ${mine ? 'mine' : 'peer'}`}>[message supprime]</div>;
  }

  return (
    <div className={`message-bubble ${mine ? 'mine' : 'peer'} ${kind === 'voice' ? 'voice-bubble' : ''}`}>
      {kind === 'text' && <p className="message-text">{text}</p>}
      {kind === 'voice' && voice && voiceUrl && (
        <div className="voice-message">
          <audio controls preload="metadata" src={voiceUrl} />
          <span>{Math.max(1, Math.round((voice.durationMs || 0) / 1000))}s</span>
        </div>
      )}
      <div className="message-meta">
        <span>{time}</span>
        {statusLabel && <span className="message-status">{statusLabel}</span>}
      </div>
    </div>
  );
}
