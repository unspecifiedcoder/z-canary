import { x25519 } from '@noble/curves/ed25519.js';
import { gcm } from '@noble/ciphers/aes.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, sha256Bytes, sha256Hex } from './shamir';

// Browser demonstration format. The planned Rust agent uses the age format.
const FORMAT = 'ZCAN-DEMO-X25519-AES256GCM-V2' as const;
const text = new TextEncoder();
const INNER_DOMAIN = text.encode(FORMAT + ':inner');
const OUTER_DOMAIN = text.encode(FORMAT + ':outer');

export interface RecipientIdentity {
  label: string;
  privateKeyHex: string;
  publicKeyHex: string;
  fingerprint: string;
}

export interface EncryptedVaultPackage {
  format: typeof FORMAT;
  outerCiphertextBase64: string;
  outerNonceHex: string;
  innerNonceHex: string;
  ephemeralPubKeyHex: string;
  outerPackageDigestHex: string;
  plaintextDigestHex: string;
  originalSize: number;
  encryptedSize: number;
}

function keyBytes(hex: string): Uint8Array {
  const key = hexToBytes(hex);
  if (key.length !== 32) throw new Error('ERR_KEY_LENGTH: Expected 32 bytes');
  return key;
}

export function computeKeyFingerprint(publicKeyHex: string): string {
  return Array.from(sha256Bytes(keyBytes(publicKeyHex)).subarray(0, 16))
    .map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
}

export function deriveX25519PublicKey(privateKeyHex: string): string {
  return bytesToHex(x25519.getPublicKey(keyBytes(privateKeyHex)));
}

export function generateRecipientIdentity(label = 'Demo recipient'): RecipientIdentity {
  const privateKeyHex = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const publicKeyHex = deriveX25519PublicKey(privateKeyHex);
  return { label, privateKeyHex, publicKeyHex, fingerprint: computeKeyFingerprint(publicKeyHex) };
}

export function aeadEncrypt(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Uint8Array {
  if (key.length !== 32 || nonce.length !== 12) throw new Error('ERR_AEAD_PARAMETERS');
  return gcm(key, nonce).encrypt(plaintext);
}

export function aeadDecrypt(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  if (key.length !== 32 || nonce.length !== 12) throw new Error('ERR_AEAD_PARAMETERS');
  return gcm(key, nonce).decrypt(ciphertext);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}

function innerKey(secret: Uint8Array, peer: Uint8Array, ephemeral: Uint8Array, recipient: Uint8Array): Uint8Array {
  const shared = x25519.getSharedSecret(secret, peer);
  const salt = new Uint8Array([...ephemeral, ...recipient]);
  const key = hkdf(sha256, shared, salt, INNER_DOMAIN, 32);
  shared.fill(0);
  return key;
}

export function packageDigest(pkg: Omit<EncryptedVaultPackage, 'outerPackageDigestHex'>): string {
  return sha256Hex(JSON.stringify([
    pkg.format, pkg.ephemeralPubKeyHex, pkg.innerNonceHex, pkg.outerNonceHex,
    pkg.plaintextDigestHex, pkg.originalSize, pkg.encryptedSize, pkg.outerCiphertextBase64,
  ]));
}

export function encryptDossierDualLayer(plaintext: Uint8Array, recipientPubKeyHex: string, releaseKey: Uint8Array): EncryptedVaultPackage {
  if (releaseKey.length !== 32 || plaintext.length > 10 * 1024 * 1024) throw new Error('ERR_PACKAGE_PARAMETERS');
  const recipient = keyBytes(recipientPubKeyHex);
  const ephemeralSecret = crypto.getRandomValues(new Uint8Array(32));
  const ephemeral = x25519.getPublicKey(ephemeralSecret);
  const innerNonce = crypto.getRandomValues(new Uint8Array(12));
  const outerNonce = crypto.getRandomValues(new Uint8Array(12));
  const key = innerKey(ephemeralSecret, recipient, ephemeral, recipient);
  try {
    const inner = gcm(key, innerNonce, INNER_DOMAIN).encrypt(plaintext);
    const outer = gcm(releaseKey, outerNonce, OUTER_DOMAIN).encrypt(inner);
    const pkg = {
      format: FORMAT,
      outerCiphertextBase64: bytesToBase64(outer),
      outerNonceHex: bytesToHex(outerNonce),
      innerNonceHex: bytesToHex(innerNonce),
      ephemeralPubKeyHex: bytesToHex(ephemeral),
      plaintextDigestHex: sha256Hex(plaintext),
      originalSize: plaintext.length,
      encryptedSize: outer.length,
    };
    return { ...pkg, outerPackageDigestHex: packageDigest(pkg) };
  } finally {
    key.fill(0);
    ephemeralSecret.fill(0);
  }
}

export function decryptDossierDualLayer(pkg: EncryptedVaultPackage, releaseKey: Uint8Array, recipientPrivateKeyHex: string, expectedRecipientPubKeyHex: string, expectedPackageDigestHex: string): Uint8Array {
  if (pkg.format !== FORMAT || releaseKey.length !== 32) throw new Error('ERR_PACKAGE_PARAMETERS');
  const privateKey = keyBytes(recipientPrivateKeyHex);
  const recipient = keyBytes(expectedRecipientPubKeyHex);
  if (bytesToHex(x25519.getPublicKey(privateKey)) !== bytesToHex(recipient)) throw new Error('ERR_WRONG_RECIPIENT_KEY');
  const actualDigest = packageDigest(pkg);
  if (actualDigest !== expectedPackageDigestHex.toLowerCase() || actualDigest !== pkg.outerPackageDigestHex) throw new Error('ERR_PAYLOAD_TAMPERED');
  const ephemeral = keyBytes(pkg.ephemeralPubKeyHex);
  const key = innerKey(privateKey, ephemeral, ephemeral, recipient);
  try {
    const inner = gcm(releaseKey, hexToBytes(pkg.outerNonceHex), OUTER_DOMAIN).decrypt(base64ToBytes(pkg.outerCiphertextBase64));
    const plaintext = gcm(key, hexToBytes(pkg.innerNonceHex), INNER_DOMAIN).decrypt(inner);
    if (plaintext.length !== pkg.originalSize || sha256Hex(plaintext) !== pkg.plaintextDigestHex) throw new Error('ERR_PLAINTEXT_DIGEST_MISMATCH');
    return plaintext;
  } finally {
    key.fill(0);
    privateKey.fill(0);
  }
}
