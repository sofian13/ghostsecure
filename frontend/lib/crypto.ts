import { idbGet, idbSet } from '@/lib/idb';

const PRIVATE_KEY_PREFIX = 'private-key:';

function toBase64(input: ArrayBuffer): string {
  const bytes = new Uint8Array(input);
  let binary = '';
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary);
}

function fromBase64(input: string): ArrayBuffer {
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function exportPublicKey(key: CryptoKey): Promise<string> {
  const spki = await crypto.subtle.exportKey('spki', key);
  return toBase64(spki);
}

async function exportPrivateKeyJwk(key: CryptoKey): Promise<JsonWebKey> {
  return crypto.subtle.exportKey('jwk', key);
}

async function importPublicKey(spkiBase64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'spki',
    fromBase64(spkiBase64),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    true,
    ['wrapKey']
  );
}

async function importPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['unwrapKey']
  );
}

export async function ensureIdentity(userId: string): Promise<{ publicKey: string }> {
  const keyId = `${PRIVATE_KEY_PREFIX}${userId}`;
  const existing = await idbGet<JsonWebKey>(keyId);
  if (existing) {
    if (
      existing.kty !== 'RSA' ||
      existing.alg !== 'RSA-OAEP-256' ||
      !existing.n || !existing.e ||
      !existing.d || !existing.p || !existing.q ||
      !existing.dp || !existing.dq || !existing.qi
    ) {
      throw new Error('Invalid key material');
    }
    return { publicKey: await derivePublicFromPrivateJwk(existing) };
  }

  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: 4096,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256'
    },
    true,
    ['wrapKey', 'unwrapKey']
  );

  const privateJwk = await exportPrivateKeyJwk(keyPair.privateKey);
  await idbSet(keyId, privateJwk);

  return { publicKey: await exportPublicKey(keyPair.publicKey) };
}

async function derivePublicFromPrivateJwk(privateJwk: JsonWebKey): Promise<string> {
  const publicJwk: JsonWebKey = {
    kty: privateJwk.kty,
    n: privateJwk.n,
    e: privateJwk.e,
    alg: privateJwk.alg,
    ext: true,
    key_ops: ['wrapKey']
  };
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    publicJwk,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    true,
    ['wrapKey']
  );
  return exportPublicKey(publicKey);
}

async function getPrivateKey(userId: string): Promise<CryptoKey> {
  const keyId = `${PRIVATE_KEY_PREFIX}${userId}`;
  const jwk = await idbGet<JsonWebKey>(keyId);
  if (!jwk) {
    throw new Error('Private key unavailable on this device');
  }
  return importPrivateKey(jwk);
}

export async function encryptForParticipants(plaintext: string, participants: { id: string; publicKey: string }[]): Promise<{
  ciphertext: string;
  iv: string;
  wrappedKeys: Record<string, string>;
}> {
  const encoder = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    encoder.encode(plaintext)
  );

  const wrappedKeys: Record<string, string> = {};

  for (const participant of participants) {
    const recipientPub = await importPublicKey(participant.publicKey);
    const wrapped = await crypto.subtle.wrapKey('raw', aesKey, recipientPub, { name: 'RSA-OAEP' });
    wrappedKeys[participant.id] = toBase64(wrapped);
  }

  return {
    ciphertext: toBase64(ciphertext),
    iv: toBase64(iv.buffer),
    wrappedKeys
  };
}

export async function decryptIncomingMessage(userId: string, payload: {
  ciphertext: string;
  iv: string;
  wrappedKey: string;
}): Promise<string> {
  const privateKey = await getPrivateKey(userId);
  const aesKey = await crypto.subtle.unwrapKey(
    'raw',
    fromBase64(payload.wrappedKey),
    privateKey,
    { name: 'RSA-OAEP' },
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );
  const plainBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(fromBase64(payload.iv)) },
    aesKey,
    fromBase64(payload.ciphertext)
  );

  return new TextDecoder().decode(plainBuffer);
}
