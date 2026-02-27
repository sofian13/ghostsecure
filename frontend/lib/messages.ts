import { decryptIncomingMessage } from '@/lib/crypto';
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
    const payload = await decryptIncomingMessage(userId, {
      ciphertext: message.ciphertext,
      iv: message.iv,
      wrappedKey,
    }, conversationId);

    let voice: DecryptedMessage['voice'];
    let file: DecryptedMessage['file'];
    try {
      const parsed = JSON.parse(payload) as {
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
      senderId: message.senderId,
      kind: voice ? 'voice' : file ? 'file' : 'text',
      text: voice || file ? undefined : payload,
      voice,
      file,
      createdAt: message.createdAt,
      expiresAt: message.expiresAt,
    };
  } catch {
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
