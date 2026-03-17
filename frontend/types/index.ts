export type Session = {
  userId: string;
  token?: string;
  issuedAt: string;
  expiresAt: string;
};

export type UserProfile = {
  id: string;
  publicKey: string;
  ecdhPublicKey?: string;
  identityKey?: string;
  signedPrekey?: string;
  signedPrekeySignature?: string;
  registrationId?: number;
};

export type Conversation = {
  id: string;
  kind: 'direct' | 'group';
  title: string | null;
  memberCount: number;
  disappearingTimerSeconds: 0 | 1800 | 3600 | 86400 | 604800;
  peerId: string;
  peerPublicKey: string | null;
  updatedAt: string;
};

export type EncryptedMessage = {
  id: string;
  senderId: string | null;
  ciphertext: string;
  iv: string;
  wrappedKeys: Record<string, string>;
  createdAt: string;
  expiresAt: string | null;
  ephemeralPublicKey?: string | null;
  ratchetHeader?: string | null;
};

export type PreKeyBundle = {
  userId: string;
  identityKey: string;
  signedPrekey: string;
  signedPrekeySignature: string;
  registrationId: number;
  oneTimePreKey?: { keyId: number; publicKey: string };
};

export type ConversationDetail = {
  id: string;
  kind: 'direct' | 'group';
  title: string | null;
  disappearingTimerSeconds: 0 | 1800 | 3600 | 86400 | 604800;
  participants: UserProfile[];
};
