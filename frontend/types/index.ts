export type Session = {
  userId: string;
  token: string;
  issuedAt: string;
  expiresAt: string;
};

export type UserProfile = {
  id: string;
  publicKey: string;
};

export type Conversation = {
  id: string;
  kind: 'direct' | 'group';
  title: string | null;
  memberCount: number;
  peerId: string;
  peerPublicKey: string | null;
  updatedAt: string;
};

export type EncryptedMessage = {
  id: string;
  senderId: string;
  ciphertext: string;
  iv: string;
  wrappedKeys: Record<string, string>;
  createdAt: string;
  expiresAt: string | null;
};

export type ConversationDetail = {
  id: string;
  kind: 'direct' | 'group';
  title: string | null;
  participants: UserProfile[];
};
