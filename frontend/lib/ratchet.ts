import {
  AsymmetricRatchet,
  ECPublicKey,
  Identity,
  PreKeyBundleProtocol,
  PreKeyMessageProtocol,
  MessageSignedProtocol,
  IdentityProtocol,
  RemoteIdentity,
  setEngine,
} from '2key-ratchet';
import { idbGet, idbSet, idbDelete } from '@/lib/idb';
import type { PreKeyBundle } from '@/types';

// Initialize crypto engine for browser environment
if (typeof globalThis !== 'undefined' && globalThis.crypto) {
  setEngine('webcrypto', globalThis.crypto);
}

// Access internal protocol classes via PreKeyBundleProtocol metadata.
// These classes are not directly exported by the library but are needed
// to construct pre-key bundles for X3DH key agreement.
/* eslint-disable @typescript-eslint/no-explicit-any */
const bundleItems = (PreKeyBundleProtocol as any).items as Record<string, { parser?: any }>;
const PreKeySignedProtocol = bundleItems.preKeySigned.parser;
const PreKeyProtocol = bundleItems.preKey.parser;
/* eslint-enable @typescript-eslint/no-explicit-any */

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

function fromBase64(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

const IDB_IDENTITY_PREFIX = 'ratchet-identity:';
const IDB_SESSION_PREFIX = 'ratchet-session:';

// ---------------------------------------------------------------------------
// Identity Management
// ---------------------------------------------------------------------------

/**
 * Load or create the local Signal Protocol identity for a user.
 * The identity includes signing key, exchange key, signed pre-keys, and OTKs.
 * Stored in IndexedDB as structured-cloneable CryptoKeyPair objects.
 */
export async function initRatchetIdentity(userId: string): Promise<Identity> {
  const key = `${IDB_IDENTITY_PREFIX}${userId}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stored = await idbGet<any>(key);

  if (stored) {
    return Identity.fromJSON(stored);
  }

  // 14-bit registration ID (Signal spec)
  const registrationId = crypto.getRandomValues(new Uint32Array(1))[0] & 0x3FFF;
  // 1 signed pre-key, 20 one-time pre-keys
  const identity = await Identity.create(registrationId, 1, 20);

  const json = await identity.toJSON();
  await idbSet(key, json);

  return identity;
}

/**
 * Save the identity back to IDB (e.g. after adding new pre-keys).
 */
async function saveIdentity(userId: string, identity: Identity): Promise<void> {
  const json = await identity.toJSON();
  await idbSet(`${IDB_IDENTITY_PREFIX}${userId}`, json);
}

/**
 * Export the identity's public keys and pre-keys for server upload.
 * Keys are exported as Base64-encoded SPKI format.
 * The signed pre-key ID uses array index 0 (library convention).
 */
export async function exportPreKeyBundle(identity: Identity): Promise<{
  identityKey: string;
  signedPrekey: string;
  signedPrekeySignature: string;
  registrationId: number;
  oneTimePreKeys: { keyId: number; publicKey: string }[];
}> {
  const signingPub = identity.signingKey.publicKey as ECPublicKey;
  const exchangePub = identity.exchangeKey.publicKey as ECPublicKey;

  const signingKeySpki = toBase64(await crypto.subtle.exportKey('spki', signingPub.key));
  const exchangeKeySpki = toBase64(await crypto.subtle.exportKey('spki', exchangePub.key));

  // Sign the exchange key with the signing key
  const exchangeKeySig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    identity.signingKey.privateKey,
    exchangePub.serialize()
  );

  // Export signed pre-key (index 0)
  const spk = identity.signedPreKeys[0];
  const spkPub = spk.publicKey as ECPublicKey;
  const spkSpki = toBase64(await crypto.subtle.exportKey('spki', spkPub.key));

  const spkSig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    identity.signingKey.privateKey,
    spkPub.serialize()
  );

  const identityKey = JSON.stringify({
    signingKey: signingKeySpki,
    exchangeKey: exchangeKeySpki,
    signature: toBase64(exchangeKeySig),
    createdAt: identity.createdAt.toISOString(),
  });

  const signedPrekey = JSON.stringify({ id: 0, key: spkSpki });

  // Export one-time pre-keys (array index as keyId)
  const oneTimePreKeys: { keyId: number; publicKey: string }[] = [];
  for (let i = 0; i < identity.preKeys.length; i++) {
    const pkPub = identity.preKeys[i].publicKey as ECPublicKey;
    const pkSpki = toBase64(await crypto.subtle.exportKey('spki', pkPub.key));
    oneTimePreKeys.push({ keyId: i, publicKey: pkSpki });
  }

  return {
    identityKey,
    signedPrekey,
    signedPrekeySignature: toBase64(spkSig),
    registrationId: identity.id,
    oneTimePreKeys,
  };
}

// ---------------------------------------------------------------------------
// Protocol Conversion
// ---------------------------------------------------------------------------

/**
 * Convert a server-side PreKeyBundle into a 2key-ratchet PreKeyBundleProtocol
 * for X3DH session initiation.
 */
export async function serverBundleToProtocol(bundle: PreKeyBundle): Promise<PreKeyBundleProtocol> {
  const identityData = JSON.parse(bundle.identityKey) as {
    signingKey: string;
    exchangeKey: string;
    signature: string;
    createdAt: string;
  };

  const signingKeyCrypto = await crypto.subtle.importKey(
    'spki', fromBase64(identityData.signingKey),
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']
  );
  const exchangeKeyCrypto = await crypto.subtle.importKey(
    'spki', fromBase64(identityData.exchangeKey),
    { name: 'ECDH', namedCurve: 'P-256' }, true, []
  );

  const identityProto = new IdentityProtocol();
  identityProto.signingKey = await ECPublicKey.create(signingKeyCrypto);
  identityProto.exchangeKey = await ECPublicKey.create(exchangeKeyCrypto);
  identityProto.signature = new Uint8Array(fromBase64(identityData.signature));
  identityProto.createdAt = new Date(identityData.createdAt);

  // Signed pre-key
  const spkData = JSON.parse(bundle.signedPrekey) as { id: number; key: string };
  const spkKeyCrypto = await crypto.subtle.importKey(
    'spki', fromBase64(spkData.key),
    { name: 'ECDH', namedCurve: 'P-256' }, true, []
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const spkProto = new PreKeySignedProtocol() as any;
  spkProto.id = spkData.id;
  spkProto.key = await ECPublicKey.create(spkKeyCrypto);
  spkProto.signature = new Uint8Array(fromBase64(bundle.signedPrekeySignature));

  const proto = new PreKeyBundleProtocol();
  proto.registrationId = bundle.registrationId;
  proto.identity = identityProto;
  proto.preKeySigned = spkProto;

  // Optional one-time pre-key
  if (bundle.oneTimePreKey) {
    const otkKeyCrypto = await crypto.subtle.importKey(
      'spki', fromBase64(bundle.oneTimePreKey.publicKey),
      { name: 'ECDH', namedCurve: 'P-256' }, true, []
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const otkProto = new PreKeyProtocol() as any;
    otkProto.id = bundle.oneTimePreKey.keyId;
    otkProto.key = await ECPublicKey.create(otkKeyCrypto);
    proto.preKey = otkProto;
  }

  return proto;
}

// ---------------------------------------------------------------------------
// Session Management
// ---------------------------------------------------------------------------

async function loadSession(
  conversationId: string,
  identity: Identity
): Promise<AsymmetricRatchet | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stored = await idbGet<{ session: any; remote: any }>(`${IDB_SESSION_PREFIX}${conversationId}`);
  if (!stored) return null;

  const remote = await RemoteIdentity.fromJSON(stored.remote);
  return AsymmetricRatchet.fromJSON(identity, remote, stored.session);
}

async function saveSession(
  conversationId: string,
  session: AsymmetricRatchet
): Promise<void> {
  const sessionJson = await session.toJSON();
  const remoteJson = await session.remoteIdentity.toJSON();
  await idbSet(`${IDB_SESSION_PREFIX}${conversationId}`, {
    session: sessionJson,
    remote: remoteJson,
  });
}

/**
 * Create an outbound Double Ratchet session with a peer.
 * Performs X3DH key agreement using the peer's pre-key bundle.
 */
export async function createOutboundSession(
  userId: string,
  conversationId: string,
  peerBundle: PreKeyBundle
): Promise<AsymmetricRatchet> {
  const identity = await initRatchetIdentity(userId);
  const bundle = await serverBundleToProtocol(peerBundle);
  const session = await AsymmetricRatchet.create(identity, bundle);
  await saveSession(conversationId, session);
  return session;
}

export async function hasRatchetSession(conversationId: string): Promise<boolean> {
  const stored = await idbGet(`${IDB_SESSION_PREFIX}${conversationId}`);
  return stored != null;
}

export async function deleteRatchetSession(conversationId: string): Promise<void> {
  await idbDelete(`${IDB_SESSION_PREFIX}${conversationId}`);
}

// ---------------------------------------------------------------------------
// Encrypt / Decrypt
// ---------------------------------------------------------------------------

/**
 * Encrypt a plaintext message using the Double Ratchet session.
 * Wraps the message in a v3 sealed sender envelope.
 */
export async function encryptRatchet(
  userId: string,
  conversationId: string,
  plaintext: string,
  senderId: string,
  recipientId: string
): Promise<{
  ciphertext: string;
  iv: string;
  wrappedKeys: Record<string, string>;
  ratchetHeader: string;
}> {
  const identity = await initRatchetIdentity(userId);
  const session = await loadSession(conversationId, identity);
  if (!session) {
    throw new Error('No ratchet session for this conversation');
  }

  const envelope = JSON.stringify({ v: 3, s: senderId, c: plaintext });
  const encoded = new TextEncoder().encode(envelope);

  const protocol = await session.encrypt(encoded.buffer as ArrayBuffer);
  await saveSession(conversationId, session);

  const protocolBytes = await protocol.exportProto();
  const isPreKey = 'signedMessage' in protocol;

  return {
    ciphertext: toBase64(protocolBytes),
    iv: 'ratchet',
    wrappedKeys: { [recipientId]: 'ratchet', [senderId]: 'ratchet' },
    ratchetHeader: JSON.stringify({ v: 3, type: isPreKey ? 'prekey' : 'msg' }),
  };
}

/**
 * Decrypt a ratchet-encrypted message.
 * Handles both PreKeyMessage (first message) and regular messages.
 */
export async function decryptRatchet(
  userId: string,
  conversationId: string,
  ciphertext: string,
  ratchetHeader: string
): Promise<string> {
  const header = JSON.parse(ratchetHeader) as { v: number; type: string };
  const protocolBytes = fromBase64(ciphertext);

  const identity = await initRatchetIdentity(userId);
  let session = await loadSession(conversationId, identity);

  let plainBuffer: ArrayBuffer;

  if (header.type === 'prekey') {
    const preKeyMsg = await PreKeyMessageProtocol.importProto(protocolBytes);
    if (!session) {
      session = await AsymmetricRatchet.create(identity, preKeyMsg);
    }
    plainBuffer = await session.decrypt(preKeyMsg.signedMessage);
  } else {
    if (!session) {
      throw new Error('No ratchet session and received a non-PreKey message');
    }
    const signedMsg = await MessageSignedProtocol.importProto(protocolBytes);
    plainBuffer = await session.decrypt(signedMsg);
  }

  await saveSession(conversationId, session);
  return new TextDecoder().decode(plainBuffer);
}

// ---------------------------------------------------------------------------
// OTK Replenishment
// ---------------------------------------------------------------------------

/**
 * Generate new one-time pre-keys and add them to the identity.
 */
export async function generateNewPreKeys(
  userId: string,
  count: number
): Promise<{ keyId: number; publicKey: string }[]> {
  const identity = await initRatchetIdentity(userId);
  const startIdx = identity.preKeys.length;

  const newKeys: { keyId: number; publicKey: string }[] = [];

  for (let i = 0; i < count; i++) {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits']
    );

    const ecPub = await ECPublicKey.create(keyPair.publicKey);
    identity.preKeys.push({
      publicKey: ecPub,
      privateKey: keyPair.privateKey,
    });

    const spki = toBase64(await crypto.subtle.exportKey('spki', keyPair.publicKey));
    // keyId = array index in identity.preKeys
    newKeys.push({ keyId: startIdx + i, publicKey: spki });
  }

  await saveIdentity(userId, identity);
  return newKeys;
}
