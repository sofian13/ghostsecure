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

const SAFE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const SAFE_AUDIO_TYPES = new Set(['audio/webm', 'audio/mp4', 'audio/mpeg']);

function sanitizeMime(mime: string, kind: 'image' | 'audio' | 'file'): string {
  const lower = mime.toLowerCase();
  if (kind === 'image' && SAFE_IMAGE_TYPES.has(lower)) return lower;
  if (kind === 'audio' && SAFE_AUDIO_TYPES.has(lower)) return lower;
  return 'application/octet-stream';
}

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
    const safeMime = sanitizeMime(voice.mimeType || 'audio/webm', 'audio');
    const blob = new Blob([b64ToBytes(voice.dataBase64)], { type: safeMime });
    return URL.createObjectURL(blob);
  }, [kind, voice?.dataBase64, voice?.mimeType]);

  const isImageFile = kind === 'file' && SAFE_IMAGE_TYPES.has((file?.mimeType ?? '').toLowerCase());

  const fileUrl = useMemo(() => {
    if (kind !== 'file' || !file?.dataBase64) return null;
    const safeMime = isImageFile
      ? sanitizeMime(file.mimeType, 'image')
      : sanitizeMime(file.mimeType || 'application/octet-stream', 'file');
    const blob = new Blob([b64ToBytes(file.dataBase64)], { type: safeMime });
    return URL.createObjectURL(blob);
  }, [kind, file?.dataBase64, file?.mimeType, isImageFile]);

  useEffect(() => {
    return () => {
      if (voiceUrl) URL.revokeObjectURL(voiceUrl);
      if (fileUrl) URL.revokeObjectURL(fileUrl);
    };
  }, [voiceUrl, fileUrl]);

  const time = new Date(createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

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
            <button
              type="button"
              className="file-preview-link"
              onClick={() => {
                const a = document.createElement('a');
                a.href = fileUrl;
                a.download = file.name;
                a.click();
              }}
            >
              <img src={fileUrl} alt={file.name} className="file-image-preview" />
            </button>
          )}
          <span className="file-name">{file.name}</span>
          <a href={fileUrl} download={file.name} className="file-download">
            {isImageFile ? 'Telecharger image' : 'Telecharger'}
          </a>
        </div>
      )}
      <div className="message-meta">
        <span>{time}</span>
        {mine && <StatusIcon status={status} />}
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: 'sent' | 'received' | 'read' }) {
  if (status === 'read') return <DoubleCheckIcon className="message-status-icon read" />;
  if (status === 'received') return <DoubleCheckIcon className="message-status-icon" />;
  return <CheckIcon className="message-status-icon" />;
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M13.3 4.3a1 1 0 0 1 0 1.4l-6 6a1 1 0 0 1-1.4 0l-2.6-2.6a1 1 0 1 1 1.4-1.4L6.6 9.6l5.3-5.3a1 1 0 0 1 1.4 0Z" fill="currentColor" />
    </svg>
  );
}

function DoubleCheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M11.3 4.3a1 1 0 0 1 0 1.4l-6 6a1 1 0 0 1-1.4 0L1.3 9.1a1 1 0 1 1 1.4-1.4l2.2 2.2 5.3-5.3a1 1 0 0 1 1.4 0Zm3 0a1 1 0 0 1 0 1.4l-6 6a1 1 0 0 1-1.2.2l.7-.7 5.3-5.3a1 1 0 0 1 1.4 0Z" fill="currentColor" />
    </svg>
  );
}

function VoiceIcon() {
  return (
    <svg className="icon-svg voice-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 1 1-6 0V6a3 3 0 0 1 3-3Zm-6 9a1 1 0 0 1 1 1 5 5 0 0 0 10 0 1 1 0 1 1 2 0 7 7 0 0 1-6 6.93V22h2a1 1 0 1 1 0 2H9a1 1 0 1 1 0-2h2v-2.07A7 7 0 0 1 5 13a1 1 0 0 1 1-1Z" />
    </svg>
  );
}
