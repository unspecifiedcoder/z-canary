import { sha256 } from '@noble/hashes/sha2.js';
/**
 * Shamir's Secret Sharing over Galois Field GF(2^8)
 * Irreducible polynomial: x^8 + x^4 + x^3 + x + 1 (0x11B)
 * Default configuration: k = 3 threshold, n = 5 keepers
 */

export interface KeeperShare {
  index: number; // 1..5
  keeperId: string;
  switchIdHex: string;
  epoch: number;
  dataHex: string; // 32-byte share encoded as 64 hex chars
  commitmentHex: string; // SHA-256 commitment
}

// Precompute GF(256) log and exp tables using generator 3
const EXP_TABLE = new Uint8Array(512);
const LOG_TABLE = new Uint8Array(256);

(function initTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP_TABLE[i] = x;
    EXP_TABLE[i + 255] = x;
    LOG_TABLE[x] = i;
    // Multiply by generator 3 in GF(2^8) with polynomial 0x11B
    let x2 = x << 1;
    if (x & 0x80) {
      x2 ^= 0x11b;
    }
    x = x2 ^ x;
  }
  LOG_TABLE[0] = 0;
})();

function gfAdd(a: number, b: number): number {
  return a ^ b;
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP_TABLE[LOG_TABLE[a] + LOG_TABLE[b]];
}

function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error('GF(256) division by zero');
  if (a === 0) return 0;
  return EXP_TABLE[LOG_TABLE[a] + 255 - LOG_TABLE[b]];
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/i, '');
  if (clean.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(clean)) {
    throw new Error('Invalid hex string length');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const val = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(val)) throw new Error('Malformed hex character');
    out[i] = val;
  }
  return out;
}

export function sha256Bytes(data: Uint8Array): Uint8Array {
  return sha256(data);
}

export function sha256Hex(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return bytesToHex(sha256Bytes(bytes));
}

export function computeShareCommitment(
  switchIdHex: string,
  index: number,
  epoch: number,
  shareDataHex: string
): string {
  const payload = `ZCAN-SHARE-V1:${switchIdHex.toLowerCase()}:${index}:${epoch}:${shareDataHex.toLowerCase()}`;
  return sha256Hex(payload);
}

/**
 * Splits a 32-byte secret into n shares with threshold k
 */
export function splitSecret(
  secretBytes: Uint8Array,
  switchIdHex: string,
  epoch = 1,
  n = 5,
  k = 3,
  deterministicSeed?: Uint8Array
): KeeperShare[] {
  if (secretBytes.length !== 32) {
    throw new Error('Release secret must be exactly 32 bytes (256 bits)');
  }
  if (!Number.isInteger(k) || !Number.isInteger(n) || k !== 3 || n !== 5) {
    throw new Error('Invalid threshold parameters');
  }

  const sharesData: Uint8Array[] = Array.from({ length: n }, () => new Uint8Array(secretBytes.length));

  for (let byteIdx = 0; byteIdx < secretBytes.length; byteIdx++) {
    // Polynomial coefficients: coeffs[0] = secret byte, coeffs[1..k-1] = uniformly random field elements, including zero
    const coeffs = new Uint8Array(k);
    coeffs[0] = secretBytes[byteIdx];

    if (deterministicSeed) {
      const seedHash = sha256Bytes(
        new Uint8Array([...deterministicSeed, byteIdx, epoch])
      );
      for (let d = 1; d < k; d++) {
        coeffs[d] = seedHash[d];
      }
    } else {
      const rand = new Uint8Array(k - 1);
      crypto.getRandomValues(rand);
      for (let d = 1; d < k; d++) {
        coeffs[d] = rand[d - 1];
      }
    }

    // Evaluate polynomial at x = 1..n using Horner's method in GF(256)
    for (let i = 0; i < n; i++) {
      const x = i + 1;
      let y = 0;
      for (let d = k - 1; d >= 0; d--) {
        y = gfAdd(gfMul(y, x), coeffs[d]);
      }
      sharesData[i][byteIdx] = y;
    }
  }

  return sharesData.map((data, idx) => {
    const index = idx + 1;
    const dataHex = bytesToHex(data);
    return {
      index,
      keeperId: `keeper-0${index}`,
      switchIdHex,
      epoch,
      dataHex,
      commitmentHex: computeShareCommitment(switchIdHex, index, epoch, dataHex),
    };
  });
}

/**
 * Reconstructs the 32-byte secret from >= k valid distinct KeeperShares
 * Validates switchId, epoch, index uniqueness, and cryptographic commitments
 */
export function reconstructSecret(
  shares: KeeperShare[],
  expectedSwitchIdHex: string,
  expectedEpoch: number,
  expectedCommitments: Record<number, string>,
  k = 3
): Uint8Array {
  if (k !== 3) throw new Error('ERR_THRESHOLD_POLICY: Only 3-of-5 is supported');
  if (shares.length < k) {
    throw new Error(`ERR_THRESHOLD_INSUFFICIENT: Need at least ${k} valid shares, received ${shares.length}`);
  }

  const seenIndices = new Set<number>();
  const validatedShares: { x: number; bytes: Uint8Array }[] = [];

  for (const share of shares) {
    if (share.switchIdHex.toLowerCase() !== expectedSwitchIdHex.toLowerCase()) {
      throw new Error(`ERR_SHARE_SWITCH_MISMATCH: Share from ${share.keeperId} belongs to a different switch`);
    }
    if (share.epoch !== expectedEpoch) {
      throw new Error(`ERR_SHARE_EPOCH_MISMATCH: Share epoch ${share.epoch} != expected ${expectedEpoch}`);
    }
    if (!Number.isInteger(share.index) || share.index < 1 || share.index > 5) {
      throw new Error(`ERR_SHARE_INVALID_INDEX: Keeper index ${share.index} out of bounds [1..5]`);
    }
    if (share.keeperId !== `keeper-0${share.index}`) throw new Error('ERR_SHARE_KEEPER_MISMATCH');
    if (hexToBytes(share.dataHex).length !== 32) throw new Error('ERR_SHARE_LENGTH');
    if (seenIndices.has(share.index)) {
      throw new Error(`ERR_SHARE_DUPLICATE_INDEX: Duplicate share index ${share.index}`);
    }

    const expectedComm = expectedCommitments[share.index];
    const actualComm = computeShareCommitment(
      share.switchIdHex,
      share.index,
      share.epoch,
      share.dataHex
    );

    if (!expectedComm || actualComm.toLowerCase() !== expectedComm.toLowerCase() || share.commitmentHex.toLowerCase() !== expectedComm.toLowerCase()) {
      throw new Error(`ERR_SHARE_COMMITMENT_MISMATCH: Keeper #${share.index} share failed commitment check`);
    }

    seenIndices.add(share.index);
    validatedShares.push({
      x: share.index,
      bytes: hexToBytes(share.dataHex),
    });


  }

  const secretLength = validatedShares[0].bytes.length;
  const reconstructed = new Uint8Array(secretLength);

  // Lagrange interpolation at x = 0 over GF(256)
  for (let byteIdx = 0; byteIdx < secretLength; byteIdx++) {
    let secretByte = 0;
    for (let i = 0; i < k; i++) {
      const xi = validatedShares[i].x;
      const yi = validatedShares[i].bytes[byteIdx];

      let num = 1;
      let den = 1;
      for (let j = 0; j < k; j++) {
        if (i === j) continue;
        const xj = validatedShares[j].x;
        num = gfMul(num, xj); // (0 - xj) = xj in GF(2^8)
        den = gfMul(den, gfAdd(xi, xj)); // (xi - xj) = xi ^ xj
      }

      const lagrangeBasis = gfDiv(num, den);
      secretByte = gfAdd(secretByte, gfMul(yi, lagrangeBasis));
    }
    reconstructed[byteIdx] = secretByte;
  }

  return reconstructed;
}
