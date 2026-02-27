import { idbGet, idbSet, idbDelete } from '@/lib/idb';

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

// Deliberate choice: RSASSA-PKCS1-v1_5 (RS256) is used here instead of RSA-PSS
// because PHP's openssl_verify() with OPENSSL_ALGO_SHA256 expects PKCS#1 v1.5.
// Both schemes are secure for signatures; this matches the backend verifier.
async function signRegistrationProof(userId: string, privateKeyJwk: JsonWebKey): Promise<string> {
  const signingKey = await crypto.subtle.importKey(
    'jwk',
    { ...privateKeyJwk, alg: 'RS256', key_ops: ['sign'] },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    signingKey,
    new TextEncoder().encode(userId)
  );
  return toBase64(signature);
}

function isJsonWebKey(value: unknown): value is JsonWebKey {
  return typeof value === 'object' && value !== null && 'kty' in value;
}

export async function ensureIdentity(userId: string): Promise<{ publicKey: string; ecdhPublicKey?: string; proof?: string }> {
  const keyId = `${PRIVATE_KEY_PREFIX}${userId}`;
  const stored = await idbGet<CryptoKey | JsonWebKey>(keyId);

  if (stored) {
    // Already a non-extractable CryptoKey — user is already registered.
    // Can't export the public key, but login doesn't need it.
    if (stored instanceof CryptoKey) {
      return { publicKey: '' };
    }

    if (isJsonWebKey(stored)) {
      // Legacy JWK — validate and migrate to non-extractable CryptoKey
      const jwk = stored;
      if (
        jwk.kty !== 'RSA' ||
        jwk.alg !== 'RSA-OAEP-256' ||
        !jwk.n || !jwk.e ||
        !jwk.d || !jwk.p || !jwk.q ||
        !jwk.dp || !jwk.dq || !jwk.qi
      ) {
        throw new Error('Invalid key material');
      }
      const publicKey = await derivePublicFromPrivateJwk(jwk);
      const nonExtractableKey = await crypto.subtle.importKey(
        'jwk', jwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['unwrapKey']
      );
      await idbSet(keyId, nonExtractableKey);
      return { publicKey };
    } else {
      throw new Error('Invalid key material');
    }
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

  const publicKeyB64 = await exportPublicKey(keyPair.publicKey);
  const privateJwk = await exportPrivateKeyJwk(keyPair.privateKey);

  // Generate proof of possession before making key non-extractable
  const proof = await signRegistrationProof(userId, privateJwk);

  // Re-import as non-extractable CryptoKey for secure storage
  const nonExtractableKey = await crypto.subtle.importKey(
    'jwk',
    privateJwk,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['unwrapKey']
  );
  await idbSet(keyId, nonExtractableKey);

  // Generate ECDH keypair for forward secrecy
  const ecdhPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits']
  );
  const ecdhPub = await exportPublicKey(ecdhPair.publicKey);
  await idbSet(`ecdh-private:${userId}`, ecdhPair.privateKey);

  return { publicKey: publicKeyB64, ecdhPublicKey: ecdhPub, proof };
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
  const stored = await idbGet<CryptoKey | JsonWebKey>(keyId);
  if (!stored) {
    throw new Error('Private key unavailable on this device');
  }

  // Already a CryptoKey (non-extractable)
  if (stored instanceof CryptoKey) {
    return stored;
  }

  // Legacy JWK — import and migrate
  if (isJsonWebKey(stored)) {
    const key = await importPrivateKey(stored);
    const nonExtractableKey = await crypto.subtle.importKey(
      'jwk', stored, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['unwrapKey']
    );
    await idbSet(keyId, nonExtractableKey);
    return key;
  }

  throw new Error('Private key unavailable on this device');
}

async function ecdhWrapKey(
  aesKey: CryptoKey,
  recipientEcdhPubBase64: string,
  conversationId: string,
  ephPair: CryptoKeyPair
): Promise<string> {
  // Import recipient ECDH public key
  const recipientPub = await crypto.subtle.importKey(
    'spki',
    fromBase64(recipientEcdhPubBase64),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );

  // Derive shared secret
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: recipientPub },
    ephPair.privateKey,
    256
  );

  // HKDF to derive wrapping key
  const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  const wrappingKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode(conversationId), info: new Uint8Array(0) },
    hkdfKey,
    { name: 'AES-KW', length: 256 },
    false,
    ['wrapKey']
  );

  // Wrap the AES message key
  const wrapped = await crypto.subtle.wrapKey('raw', aesKey, wrappingKey, 'AES-KW');
  return toBase64(wrapped);
}

export async function encryptForParticipants(
  plaintext: string,
  participants: { id: string; publicKey: string; ecdhPublicKey?: string }[],
  conversationId?: string,
  senderId?: string
): Promise<{
  ciphertext: string;
  iv: string;
  wrappedKeys: Record<string, string>;
  ephemeralPublicKey?: string;
}> {
  const encoder = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);

  // Sealed sender: wrap plaintext with sender identity
  const actualPlaintext = senderId
    ? JSON.stringify({ v: 2, s: senderId, c: plaintext })
    : plaintext;

  const gcmParams: AesGcmParams = { name: 'AES-GCM', iv };
  if (conversationId) {
    gcmParams.additionalData = encoder.encode(conversationId);
  }

  const ciphertext = await crypto.subtle.encrypt(
    gcmParams,
    aesKey,
    encoder.encode(actualPlaintext)
  );

  const wrappedKeys: Record<string, string> = {};
  let ephemeralPublicKey: string | undefined;

  // Generate a single ephemeral ECDH keypair shared by all participants
  const needsEcdh = participants.some((p) => p.ecdhPublicKey && conversationId);
  const ephPair = needsEcdh
    ? await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
    : null;
  if (ephPair) {
    ephemeralPublicKey = await exportPublicKey(ephPair.publicKey);
  }

  for (const participant of participants) {
    if (participant.ecdhPublicKey && conversationId && ephPair) {
      // Forward secrecy path: ECDH key wrapping (shared ephemeral keypair)
      wrappedKeys[participant.id] = await ecdhWrapKey(aesKey, participant.ecdhPublicKey, conversationId, ephPair);
    } else {
      // Legacy RSA-OAEP wrapping
      const recipientPub = await importPublicKey(participant.publicKey);
      const wrapped = await crypto.subtle.wrapKey('raw', aesKey, recipientPub, { name: 'RSA-OAEP' });
      wrappedKeys[participant.id] = toBase64(wrapped);
    }
  }

  return {
    ciphertext: toBase64(ciphertext),
    iv: toBase64(iv.buffer),
    wrappedKeys,
    ephemeralPublicKey
  };
}

export async function decryptIncomingMessage(userId: string, payload: {
  ciphertext: string;
  iv: string;
  wrappedKey: string;
  ephemeralPublicKey?: string | null;
}, conversationId?: string, createdAt?: string): Promise<string> {
  let aesKey: CryptoKey;

  if (payload.ephemeralPublicKey && conversationId) {
    // Forward secrecy path: ECDH unwrap
    const ecdhPrivate = await idbGet<CryptoKey>(`ecdh-private:${userId}`);
    if (!ecdhPrivate) {
      throw new Error('ECDH private key unavailable on this device');
    }

    const ephPub = await crypto.subtle.importKey(
      'spki',
      fromBase64(payload.ephemeralPublicKey),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    );

    const sharedBits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: ephPub },
      ecdhPrivate,
      256
    );

    const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
    const wrappingKey = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode(conversationId), info: new Uint8Array(0) },
      hkdfKey,
      { name: 'AES-KW', length: 256 },
      false,
      ['unwrapKey']
    );

    aesKey = await crypto.subtle.unwrapKey(
      'raw',
      fromBase64(payload.wrappedKey),
      wrappingKey,
      'AES-KW',
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );
  } else {
    // Legacy RSA-OAEP unwrap
    const privateKey = await getPrivateKey(userId);
    aesKey = await crypto.subtle.unwrapKey(
      'raw',
      fromBase64(payload.wrappedKey),
      privateKey,
      { name: 'RSA-OAEP' },
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );
  }

  const iv = new Uint8Array(fromBase64(payload.iv));
  const ciphertextBuf = fromBase64(payload.ciphertext);
  const encoder = new TextEncoder();

  // AAD enforcement: always try with conversation ID as additional authenticated data.
  // This binds ciphertext to its conversation and prevents cross-conversation replay.
  // All new messages are encrypted with AAD. The no-AAD fallback below exists solely
  // for messages encrypted before AAD was introduced — it will be removed in a future
  // release once all legacy messages have expired or been migrated.
  if (conversationId) {
    try {
      const plainBuffer = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: encoder.encode(conversationId) },
        aesKey,
        ciphertextBuf
      );
      return new TextDecoder().decode(plainBuffer);
    } catch {
      // Legacy fallback: message was encrypted without AAD (pre-enforcement)
    }
  }

  const plainBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    ciphertextBuf
  );
  return new TextDecoder().decode(plainBuffer);
}

export async function generateSafetyNumber(publicKeyBase64: string): Promise<string> {
  const spki = fromBase64(publicKeyBase64);
  const hash = await crypto.subtle.digest('SHA-256', spki);
  const bytes = new Uint8Array(hash);
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  return hex.match(/.{1,8}/g)?.join(' ') ?? hex;
}

export async function wipeLocalKeys(userId: string): Promise<void> {
  const keyId = `${PRIVATE_KEY_PREFIX}${userId}`;
  await idbDelete(keyId);
  await idbDelete(`ecdh-private:${userId}`);
}
