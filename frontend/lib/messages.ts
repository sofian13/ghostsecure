import { decryptIncomingMessage } from '@/lib/crypto';
import type { EncryptedMessage } from '@/types';

export type DecryptedMessage = {
  id: string;
  senderId: string;
  kind: 'text' | 'voice';
  text?: string;
  voice?: {
    mimeType: string;
    dataBase64: string;
    durationMs: number;
  };
  createdAt: string;
  expiresAt: string | null;
};

export async function decryptForUser(userId: string, message: EncryptedMessage): Promise<DecryptedMessage | null> {
  const wrappedKey = message.wrappedKeys[userId];
  if (!wrappedKey) return null;

  try {
    const payload = await decryptIncomingMessage(userId, {
      ciphertext: message.ciphertext,
      iv: message.iv,
      wrappedKey,
    });

    let voice: DecryptedMessage['voice'];
    try {
      const parsed = JSON.parse(payload) as {
        type?: string;
        mimeType?: string;
        dataBase64?: string;
        durationMs?: number;
      };
      if (parsed.type === 'voice' && parsed.mimeType && parsed.dataBase64) {
        voice = {
          mimeType: parsed.mimeType,
          dataBase64: parsed.dataBase64,
          durationMs: Math.max(0, Number(parsed.durationMs ?? 0)),
        };
      }
    } catch {
      voice = undefined;
    }

    return {
      id: message.id,
      senderId: message.senderId,
      kind: voice ? 'voice' : 'text',
      text: voice ? undefined : payload,
      voice,
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
  const text = (message.text ?? '').trim();
  if (!text) return 'Message chiffre';
  return text.length > 45 ? `${text.slice(0, 45)}...` : text;
}
