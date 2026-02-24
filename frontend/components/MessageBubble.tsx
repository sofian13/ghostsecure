"use client";

import { useEffect, useId, useMemo, useState } from 'react';

type VoicePayload = {
  mimeType: string;
  dataBase64: string;
  durationMs: number;
};

type Props = {
  kind: 'text' | 'voice' | 'file';
  text?: string;
  voice?: VoicePayload;
  file?: {
    name: string;
    mimeType: string;
    dataBase64: string;
    sizeBytes: number;
  };
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

export default function MessageBubble({ kind, text, voice, file, mine, createdAt, status = 'sent', expiresAt }: Props) {
  const [isExpired, setIsExpired] = useState(false);
  const [playing, setPlaying] = useState(false);
  const voiceAudioId = useId();

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

  const fileUrl = useMemo(() => {
    if (kind !== 'file' || !file?.dataBase64) return null;
    const blob = new Blob([b64ToBytes(file.dataBase64)], { type: file.mimeType || 'application/octet-stream' });
    return URL.createObjectURL(blob);
  }, [kind, file?.dataBase64, file?.mimeType]);
  const isImageFile = kind === 'file' && (file?.mimeType ?? '').startsWith('image/');

  useEffect(() => {
    return () => {
      if (voiceUrl) URL.revokeObjectURL(voiceUrl);
      if (fileUrl) URL.revokeObjectURL(fileUrl);
    };
  }, [voiceUrl, fileUrl]);

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
          <button
            type="button"
            className="voice-play-btn"
            aria-label={playing ? 'Pause vocal' : 'Lire vocal'}
            onClick={() => {
              const audio = document.getElementById(voiceAudioId) as HTMLAudioElement | null;
              if (!audio) return;
              if (audio.paused) {
                void audio.play();
              } else {
                audio.pause();
              }
            }}
          >
            <VoiceIcon />
          </button>
          <audio
            id={voiceAudioId}
            controls
            preload="metadata"
            src={voiceUrl}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
          />
          <span>{Math.max(1, Math.round((voice.durationMs || 0) / 1000))}s</span>
        </div>
      )}
      {kind === 'file' && file && fileUrl && (
        <div className="file-message">
          {isImageFile && (
            <a href={fileUrl} target="_blank" rel="noreferrer" className="file-preview-link">
              <img src={fileUrl} alt={file.name} className="file-image-preview" />
            </a>
          )}
          <span className="file-name">{file.name}</span>
          <a href={fileUrl} download={file.name} className="file-download">
            {isImageFile ? 'Ouvrir image' : 'Telecharger'}
          </a>
        </div>
      )}
      <div className="message-meta">
        <span>{time}</span>
        {statusLabel && <span className="message-status">{statusLabel}</span>}
      </div>
    </div>
  );
}

function VoiceIcon() {
  return (
    <svg className="icon-svg voice-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 1 1-6 0V6a3 3 0 0 1 3-3Zm-6 9a1 1 0 0 1 1 1 5 5 0 0 0 10 0 1 1 0 1 1 2 0 7 7 0 0 1-6 6.93V22h2a1 1 0 1 1 0 2H9a1 1 0 1 1 0-2h2v-2.07A7 7 0 0 1 5 13a1 1 0 0 1 1-1Z" />
    </svg>
  );
}
