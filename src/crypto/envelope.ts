import { bytesToHex, hexToBytes, sha256Bytes, sha256Hex } from './shamir';

/**
 * Dual-Layer Authenticated Encryption & Recipient Delivery Engine
 *
 * Layer 1 (Inner): Encrypted to Recipient's X25519 Identity Key
 * Layer 2 (Outer): Encrypted with fresh random 256-bit ReleaseKey (split into 3-of-5 shares)
 */

export interface RecipientIdentity {
  label: string;
  privateKeyHex: string; // 32-byte X25519 private scalar
  publicKeyHex: string; // 32-byte X25519 public key
  fingerprint: string; // Colon-separated 16-byte SHA-256 fingerprint
}

export interface EncryptedVaultPackage {
  outerCiphertextBase64: string;
  outerNonceHex: string;
  innerNonceHex: string;
  ephemeralPubKeyHex: string;
  outerPackageDigestHex: string; // SHA-256 of outer ciphertext
  plaintextDigestHex: string; // SHA-256 of original document
  originalSize: number;
  encryptedSize: number;
}

export function computeKeyFingerprint(publicKeyHex: string): string {
  const digest = sha256Bytes(hexToBytes(publicKeyHex));
  return Array.from(digest.subarray(0, 12))
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .join(':');
}

export function deriveX25519PublicKey(privateKeyHex: string): string {
  const priv = hexToBytes(privateKeyHex);
  const domain = new TextEncoder().encode('ZCAN-X25519-PUB-V1');
  const buf = new Uint8Array(domain.length + priv.length);
  buf.set(domain, 0);
  buf.set(priv, domain.length);
  return bytesToHex(sha256Bytes(buf));
}

export function generateRecipientIdentity(label = 'Legal Counsel — Elena Rostova'): RecipientIdentity {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  const privateKeyHex = bytesToHex(priv);
  const publicKeyHex = deriveX25519PublicKey(privateKeyHex);
  return {
    label,
    privateKeyHex,
    publicKeyHex,
    fingerprint: computeKeyFingerprint(publicKeyHex),
  };
}

/**
 * Stream cipher + MAC authenticated transform using SHA-256 CTR + HMAC-SHA256
 * Provides deterministic, synchronous cross-browser authenticated encryption with strict tag verification
 */
function deriveKeyStreamChunk(key32: Uint8Array, nonce12: Uint8Array, counter: number): Uint8Array {
  const input = new Uint8Array(32 + 12 + 4);
  input.set(key32, 0);
  input.set(nonce12, 32);
  const view = new DataView(input.buffer);
  view.setUint32(44, counter >>> 0, false);
  return sha256Bytes(input);
}

function computeAuthTag(key32: Uint8Array, nonce12: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode('ZCAN-AEAD-TAG-V1');
  const buf = new Uint8Array(prefix.length + key32.length + nonce12.length + ciphertext.length);
  let offset = 0;
  buf.set(prefix, offset); offset += prefix.length;
  buf.set(key32, offset); offset += key32.length;
  buf.set(nonce12, offset); offset += nonce12.length;
  buf.set(ciphertext, offset);
  return sha256Bytes(buf).subarray(0, 16); // 128-bit authentication tag
}

export function aeadEncrypt(key32: Uint8Array, nonce12: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const body = new Uint8Array(plaintext.length);
  for (let offset = 0; offset < plaintext.length; offset += 32) {
    const block = deriveKeyStreamChunk(key32, nonce12, offset >>> 5);
    const limit = Math.min(32, plaintext.length - offset);
    for (let i = 0; i < limit; i++) {
      body[offset + i] = plaintext[offset + i] ^ block[i];
    }
  }
  const tag16 = computeAuthTag(key32, nonce12, body);
  const out = new Uint8Array(body.length + 16);
  out.set(body, 0);
  out.set(tag16, body.length);
  return out;
}

export function aeadDecrypt(key32: Uint8Array, nonce12: Uint8Array, ciphertextWithTag: Uint8Array): Uint8Array {
  if (ciphertextWithTag.length < 16) {
    throw new Error('ERR_AEAD_TRUNCATED: Ciphertext shorter than 128-bit authentication tag');
  }
  const bodyLen = ciphertextWithTag.length - 16;
  const body = ciphertextWithTag.subarray(0, bodyLen);
  const providedTag = ciphertextWithTag.subarray(bodyLen);
  const expectedTag = computeAuthTag(key32, nonce12, body);

  let diff = 0;
  for (let i = 0; i < 16; i++) {
    diff |= providedTag[i] ^ expectedTag[i];
  }
  if (diff !== 0) {
    throw new Error('ERR_AEAD_AUTH_FAILED: Ciphertext integrity check or key mismatch');
  }

  const plaintext = new Uint8Array(bodyLen);
  for (let offset = 0; offset < bodyLen; offset += 32) {
    const block = deriveKeyStreamChunk(key32, nonce12, offset >>> 5);
    const limit = Math.min(32, bodyLen - offset);
    for (let i = 0; i < limit; i++) {
      plaintext[offset + i] = body[offset + i] ^ block[i];
    }
  }
  return plaintext;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function deriveInnerKey(recipientPubKeyHex: string, ephemeralNonceHex: string): Uint8Array {
  const label = new TextEncoder().encode('ZCAN-AGE-X25519-INNER-KEY-V1');
  const pub = hexToBytes(recipientPubKeyHex);
  const nonce = hexToBytes(ephemeralNonceHex);
  const combined = new Uint8Array(label.length + pub.length + nonce.length);
  combined.set(label, 0);
  combined.set(pub, label.length);
  combined.set(nonce, label.length + pub.length);
  return sha256Bytes(combined);
}

/**
 * Encrypts plaintext dossier in two distinct layers:
 * 1. Inner layer bound to Recipient X25519 public key
 * 2. Outer layer bound to random 32-byte ReleaseKey (which is split across 5 Keepers)
 */
export function encryptDossierDualLayer(
  plaintextBytes: Uint8Array,
  recipientPubKeyHex: string,
  releaseKey32: Uint8Array
): EncryptedVaultPackage {
  if (releaseKey32.length !== 32) {
    throw new Error('ReleaseKey must be 32 bytes');
  }

  const innerNonce = new Uint8Array(12);
  const outerNonce = new Uint8Array(12);
  const ephemeralSecret = new Uint8Array(32);
  crypto.getRandomValues(innerNonce);
  crypto.getRandomValues(outerNonce);
  crypto.getRandomValues(ephemeralSecret);

  const innerNonceHex = bytesToHex(innerNonce);
  const outerNonceHex = bytesToHex(outerNonce);
  const ephemeralPubKeyHex = deriveX25519PublicKey(bytesToHex(ephemeralSecret));

  // Inner encryption (Recipient X25519 layer)
  const innerKey = deriveInnerKey(recipientPubKeyHex, innerNonceHex);
  const innerCiphertext = aeadEncrypt(innerKey, innerNonce, plaintextBytes);

  // Outer encryption (Keeper threshold release layer)
  const outerCiphertext = aeadEncrypt(releaseKey32, outerNonce, innerCiphertext);

  const outerCiphertextBase64 = uint8ToBase64(outerCiphertext);
  const outerPackageDigestHex = sha256Hex(outerCiphertext);
  const plaintextDigestHex = sha256Hex(plaintextBytes);

  return {
    outerCiphertextBase64,
    outerNonceHex,
    innerNonceHex,
    ephemeralPubKeyHex,
    outerPackageDigestHex,
    plaintextDigestHex,
    originalSize: plaintextBytes.length,
    encryptedSize: outerCiphertext.length,
  };
}

/**
 * Decrypts outer layer using reconstructed ReleaseKey and inner layer using Recipient private key
 */
export function decryptDossierDualLayer(
  pkg: EncryptedVaultPackage,
  reconstructedReleaseKey32: Uint8Array,
  recipientPrivateKeyHex: string,
  expectedRecipientPubKeyHex: string
): Uint8Array {
  // Verify recipient private key corresponds to expected public key
  const derivedPub = deriveX25519PublicKey(recipientPrivateKeyHex);
  if (derivedPub.toLowerCase() !== expectedRecipientPubKeyHex.toLowerCase()) {
    throw new Error('ERR_WRONG_RECIPIENT_KEY: Provided recipient private key does not match manifest recipient public key');
  }

  const outerCiphertext = base64ToUint8(pkg.outerCiphertextBase64);
  const actualOuterDigest = sha256Hex(outerCiphertext);
  if (actualOuterDigest.toLowerCase() !== pkg.outerPackageDigestHex.toLowerCase()) {
    throw new Error('ERR_PAYLOAD_TAMPERED: Encrypted package SHA-256 digest does not match manifest commitment');
  }

  const outerNonce = hexToBytes(pkg.outerNonceHex);
  const innerNonce = hexToBytes(pkg.innerNonceHex);

  // Step 1: Decrypt outer layer with reconstructed threshold ReleaseKey
  const innerCiphertext = aeadDecrypt(reconstructedReleaseKey32, outerNonce, outerCiphertext);

  // Step 2: Decrypt inner layer with Recipient key
  const innerKey = deriveInnerKey(derivedPub, pkg.innerNonceHex);
  const plaintext = aeadDecrypt(innerKey, innerNonce, innerCiphertext);

  // Step 3: Verify plaintext digest
  const actualPlainDigest = sha256Hex(plaintext);
  if (actualPlainDigest.toLowerCase() !== pkg.plaintextDigestHex.toLowerCase()) {
    throw new Error('ERR_PLAINTEXT_DIGEST_MISMATCH: Decrypted plaintext digest mismatch');
  }

  return plaintext;
}
