import { decryptIncomingMessage } from '@/lib/crypto';
import { decryptRatchet } from '@/lib/ratchet';
import type { EncryptedMessage } from '@/types';

export type DecryptedMessage = {
  id: string;
  senderId: string;
  kind: 'text' | 'voice' | 'file';
  text?: string;
  voice?: {
    mimeType: string;
    dataBase64: string;
    durationMs: number;
  };
  file?: {
    name: string;
    mimeType: string;
    dataBase64: string;
    sizeBytes: number;
  };
  createdAt: string;
  expiresAt: string | null;
};

export async function decryptForUser(userId: string, message: EncryptedMessage, conversationId?: string): Promise<DecryptedMessage | null> {
  const normalizedUserId = userId.trim().toLowerCase();
  const wrappedKey = message.wrappedKeys[userId]
    ?? message.wrappedKeys[normalizedUserId]
    ?? Object.entries(message.wrappedKeys).find(([id]) => id.trim().toLowerCase() === normalizedUserId)?.[1];
  if (!wrappedKey) return null;

  try {
    let rawPayload: string;

    console.debug('[GS:decrypt]', message.id, '| ratchet:', !!message.ratchetHeader, '| ecdh:', !!message.ephemeralPublicKey, '| userId:', userId);

    if (message.ratchetHeader && conversationId) {
      // v3: Double Ratchet decryption
      rawPayload = await decryptRatchet(userId, conversationId, message.ciphertext, message.ratchetHeader);
    } else {
      // v2/v1: ECDH/RSA decryption
      rawPayload = await decryptIncomingMessage(userId, {
        ciphertext: message.ciphertext,
        iv: message.iv,
        wrappedKey,
        ephemeralPublicKey: message.ephemeralPublicKey,
      }, conversationId, message.createdAt);
    }

    // Sealed sender: extract senderId from encrypted envelope
    let senderId = message.senderId ?? 'unknown';
    let actualPayload = rawPayload;
    try {
      const envelope = JSON.parse(rawPayload) as { v?: number; s?: string; c?: string };
      if ((envelope.v === 2 || envelope.v === 3) && envelope.s && envelope.c !== undefined) {
        senderId = envelope.s;
        actualPayload = envelope.c;
      }
    } catch {
      // Not an envelope — use raw payload
    }

    let voice: DecryptedMessage['voice'];
    let file: DecryptedMessage['file'];
    try {
      const parsed = JSON.parse(actualPayload) as {
        type?: string;
        mimeType?: string;
        dataBase64?: string;
        durationMs?: number;
        name?: string;
        sizeBytes?: number;
      };
      if (parsed.type === 'voice' && parsed.mimeType && parsed.dataBase64) {
        voice = {
          mimeType: parsed.mimeType,
          dataBase64: parsed.dataBase64,
          durationMs: Math.max(0, Number(parsed.durationMs ?? 0)),
        };
      }
      if (parsed.type === 'file' && parsed.mimeType && parsed.dataBase64 && parsed.name) {
        file = {
          name: parsed.name,
          mimeType: parsed.mimeType,
          dataBase64: parsed.dataBase64,
          sizeBytes: Math.max(0, Number(parsed.sizeBytes ?? 0)),
        };
      }
    } catch {
      voice = undefined;
      file = undefined;
    }

    return {
      id: message.id,
      senderId,
      kind: voice ? 'voice' : file ? 'file' : 'text',
      text: voice || file ? undefined : actualPayload,
      voice,
      file,
      createdAt: message.createdAt,
      expiresAt: message.expiresAt,
    };
  } catch (err) {
    console.warn('[GS:decrypt] FAIL', message.id, '| error:', err instanceof Error ? err.message : err);
    return null;
  }
}

export function previewLabel(message: DecryptedMessage | null): string {
  if (!message) return 'Message chiffre';
  if (message.kind === 'voice') return 'Vocal';
  if (message.kind === 'file') {
    if ((message.file?.mimeType ?? '').startsWith('image/')) return `Photo: ${message.file?.name ?? 'image'}`;
    return `Piece jointe: ${message.file?.name ?? 'fichier'}`;
  }
  const text = (message.text ?? '').trim();
  if (!text) return 'Message chiffre';
  return text.length > 45 ? `${text.slice(0, 45)}...` : text;
}
