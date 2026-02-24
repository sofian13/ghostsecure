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
  peerId: string;
  peerPublicKey: string;
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
  participants: UserProfile[];
};
