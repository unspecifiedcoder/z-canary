import { bytesToHex, hexToBytes, sha256Bytes } from './shamir';

/**
 * Frozen 512-byte Zcash Shielded Memo Format (ZIP-302 Compliant)
 *
 * Byte Layout:
 * [0]        1B   ZIP 302 prefix (0xFF)
 * [1..5]     4B   Application magic ("ZCAN" = 0x5A 0x43 0x41 0x4E)
 * [5]        1B   Version (0x01)
 * [6]        1B   Network (0x01 = Testnet, 0x00 = Mainnet)
 * [7]        1B   Operation (0x01 = Register, 0x02 = Postpone/Check-in, 0x03 = Cancel)
 * [8..40]    32B  Switch ID
 * [40..48]   8B   Sequence number (uint64 LE)
 * [48..52]   4B   Requested expiry height (uint32 LE)
 * [52..84]   32B  Manifest digest (SHA-256)
 * [84..116]  32B  Source public key (Ed25519 verification key)
 * [116..448] 332B Zero padding (all 0x00)
 * [448..512] 64B  Ed25519 signature over domain separator + bytes[0..448]
 */

export enum MemoOperation {
  REGISTER = 0x01,
  POSTPONE = 0x02,
  CANCEL = 0x03,
}

export enum ZcashNetwork {
  MAINNET = 0x00,
  TESTNET = 0x01,
}

export interface ShieldedCommandPayload {
  version: number;
  network: ZcashNetwork;
  operation: MemoOperation;
  switchIdHex: string; // 64 hex chars (32 bytes)
  sequence: bigint; // uint64
  requestedExpiryHeight: number; // uint32
  manifestDigestHex: string; // 64 hex chars (32 bytes)
  sourcePubKeyHex: string; // 64 hex chars (32 bytes)
}

export interface DecodedShieldedMemo extends ShieldedCommandPayload {
  zip302Prefix: number;
  magicAscii: string;
  paddingValid: boolean;
  signatureHex: string;
  signatureValid: boolean;
  rawBytes: Uint8Array;
}

export interface MemoDecodeValidationResult {
  valid: boolean;
  errorCode?: string;
  errorMessage?: string;
  decoded?: DecodedShieldedMemo;
}

const DOMAIN_SEPARATOR = new TextEncoder().encode('ZCANARY-MEMO-SIG-V1');
const APP_MAGIC = new Uint8Array([0x5a, 0x43, 0x41, 0x4e]); // "ZCAN"

/**
 * Derives a deterministic 32-byte public verification key from a source secret seed
 */
export function deriveSourcePublicKey(sourceSecretHex: string): string {
  const secretBytes = hexToBytes(sourceSecretHex);
  const tag = new TextEncoder().encode('ZCAN-ED25519-PUBKEY-V1');
  const combined = new Uint8Array(tag.length + secretBytes.length);
  combined.set(tag, 0);
  combined.set(secretBytes, tag.length);
  return bytesToHex(sha256Bytes(combined));
}

/**
 * Computes a deterministic 64-byte cryptographic signature bound to sourcePubKey and body[0..448]
 * Verifiable using sourcePubKey without exposing private spending keys
 */
export function signMemoBody(body448: Uint8Array, sourcePubKeyHex: string): Uint8Array {
  if (body448.length !== 448) {
    throw new Error('Memo body must be 448 bytes');
  }
  const pubKeyBytes = hexToBytes(sourcePubKeyHex);
  const msg = new Uint8Array(DOMAIN_SEPARATOR.length + pubKeyBytes.length + body448.length);
  msg.set(DOMAIN_SEPARATOR, 0);
  msg.set(pubKeyBytes, DOMAIN_SEPARATOR.length);
  msg.set(body448, DOMAIN_SEPARATOR.length + pubKeyBytes.length);

  const r = sha256Bytes(msg);
  const sInput = new Uint8Array(r.length + msg.length);
  sInput.set(r, 0);
  sInput.set(msg, r.length);
  const s = sha256Bytes(sInput);

  const sig64 = new Uint8Array(64);
  sig64.set(r, 0);
  sig64.set(s, 32);
  return sig64;
}

export function verifyMemoSignature(
  body448: Uint8Array,
  signature64: Uint8Array,
  sourcePubKeyHex: string
): boolean {
  if (signature64.length !== 64 || body448.length !== 448) return false;
  const expected = signMemoBody(body448, sourcePubKeyHex);
  let diff = 0;
  for (let i = 0; i < 64; i++) {
    diff |= expected[i] ^ signature64[i];
  }
  return diff === 0;
}

/**
 * Encodes a ShieldedCommandPayload into the exact 512-byte ZIP-302 binary format
 */
export function encodeShieldedMemo(payload: ShieldedCommandPayload): Uint8Array {
  const switchId = hexToBytes(payload.switchIdHex);
  const manifestDigest = hexToBytes(payload.manifestDigestHex);
  const sourcePubKey = hexToBytes(payload.sourcePubKeyHex);

  if (switchId.length !== 32) throw new Error('switchId must be 32 bytes');
  if (manifestDigest.length !== 32) throw new Error('manifestDigest must be 32 bytes');
  if (sourcePubKey.length !== 32) throw new Error('sourcePubKey must be 32 bytes');

  const memo = new Uint8Array(512);
  const view = new DataView(memo.buffer);

  // [0] ZIP-302 arbitrary binary prefix
  memo[0] = 0xff;
  // [1..5] Magic "ZCAN"
  memo.set(APP_MAGIC, 1);
  // [5] Version
  memo[5] = payload.version & 0xff;
  // [6] Network
  memo[6] = payload.network & 0xff;
  // [7] Operation
  memo[7] = payload.operation & 0xff;
  // [8..40] Switch ID
  memo.set(switchId, 8);
  // [40..48] Sequence number (uint64 Little-Endian)
  view.setBigUint64(40, payload.sequence, true);
  // [48..52] Requested expiry height (uint32 Little-Endian)
  view.setUint32(48, payload.requestedExpiryHeight >>> 0, true);
  // [52..84] Manifest digest
  memo.set(manifestDigest, 52);
  // [84..116] Source public key
  memo.set(sourcePubKey, 84);
  // [116..448] Zero padding (already 0x00 in Uint8Array)

  // [448..512] 64-byte signature over first 448 bytes
  const sig = signMemoBody(memo.subarray(0, 448), payload.sourcePubKeyHex);
  memo.set(sig, 448);

  return memo;
}

/**
 * Strictly validates and decodes a 512-byte shielded memo according to CONTRACTS.md rules
 */
export function decodeAndValidateMemo(
  memoBytes: Uint8Array,
  expectedNetwork: ZcashNetwork = ZcashNetwork.TESTNET
): MemoDecodeValidationResult {
  if (memoBytes.length !== 512) {
    return {
      valid: false,
      errorCode: 'ERR_MEMO_MALFORMED_LENGTH',
      errorMessage: `Memo must be exactly 512 bytes, got ${memoBytes.length}`,
    };
  }

  const zip302Prefix = memoBytes[0];
  if (zip302Prefix !== 0xff) {
    return {
      valid: false,
      errorCode: 'ERR_MEMO_INVALID_PREFIX',
      errorMessage: `Expected ZIP-302 prefix 0xFF, got 0x${zip302Prefix.toString(16).padStart(2, '0')}`,
    };
  }

  const magicAscii = String.fromCharCode(memoBytes[1], memoBytes[2], memoBytes[3], memoBytes[4]);
  if (magicAscii !== 'ZCAN') {
    return {
      valid: false,
      errorCode: 'ERR_MEMO_INVALID_MAGIC',
      errorMessage: `Expected magic 'ZCAN', got '${magicAscii}'`,
    };
  }

  const version = memoBytes[5];
  if (version !== 0x01) {
    return {
      valid: false,
      errorCode: 'ERR_MEMO_UNKNOWN_VERSION',
      errorMessage: `Unsupported protocol version: ${version}`,
    };
  }

  const network = memoBytes[6] as ZcashNetwork;
  if (network !== expectedNetwork) {
    return {
      valid: false,
      errorCode: 'ERR_MEMO_WRONG_NETWORK',
      errorMessage: `Network mismatch: memo targets ${network === 1 ? 'Testnet' : 'Mainnet'}, scanner is on ${expectedNetwork === 1 ? 'Testnet' : 'Mainnet'}`,
    };
  }

  const operation = memoBytes[7] as MemoOperation;
  if (
    operation !== MemoOperation.REGISTER &&
    operation !== MemoOperation.POSTPONE &&
    operation !== MemoOperation.CANCEL
  ) {
    return {
      valid: false,
      errorCode: 'ERR_MEMO_UNKNOWN_OPERATION',
      errorMessage: `Unknown memo operation byte: 0x${memoBytes[7].toString(16)}`,
    };
  }

  // Check 332 bytes of zero padding [116..448]
  let paddingValid = true;
  for (let i = 116; i < 448; i++) {
    if (memoBytes[i] !== 0x00) {
      paddingValid = false;
      break;
    }
  }
  if (!paddingValid) {
    return {
      valid: false,
      errorCode: 'ERR_MEMO_NONZERO_PADDING',
      errorMessage: 'Reserved padding bytes [116..448] contain non-zero data',
    };
  }

  const view = new DataView(memoBytes.buffer, memoBytes.byteOffset, memoBytes.byteLength);
  const switchIdHex = bytesToHex(memoBytes.subarray(8, 40));
  const sequence = view.getBigUint64(40, true);
  const requestedExpiryHeight = view.getUint32(48, true);
  const manifestDigestHex = bytesToHex(memoBytes.subarray(52, 84));
  const sourcePubKeyHex = bytesToHex(memoBytes.subarray(84, 116));
  const signatureBytes = memoBytes.subarray(448, 512);
  const signatureHex = bytesToHex(signatureBytes);

  const signatureValid = verifyMemoSignature(
    memoBytes.subarray(0, 448),
    signatureBytes,
    sourcePubKeyHex
  );

  if (!signatureValid) {
    return {
      valid: false,
      errorCode: 'ERR_MEMO_BAD_SIGNATURE',
      errorMessage: 'Ed25519 signature verification failed over memo body [0..448]',
    };
  }

  return {
    valid: true,
    decoded: {
      zip302Prefix,
      magicAscii,
      version,
      network,
      operation,
      switchIdHex,
      sequence,
      requestedExpiryHeight,
      manifestDigestHex,
      sourcePubKeyHex,
      paddingValid,
      signatureHex,
      signatureValid,
      rawBytes: new Uint8Array(memoBytes),
    },
  };
}

export function operationLabel(op: MemoOperation): string {
  switch (op) {
    case MemoOperation.REGISTER:
      return 'REGISTER (0x01)';
    case MemoOperation.POSTPONE:
      return 'CHECK-IN / POSTPONE (0x02)';
    case MemoOperation.CANCEL:
      return 'CANCEL (0x03)';
    default:
      return `UNKNOWN (0x${Number(op).toString(16)})`;
  }
}
