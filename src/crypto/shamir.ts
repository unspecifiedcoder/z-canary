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
  if (clean.length % 2 !== 0) {
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

/**
 * Synchronous deterministic SHA-256 implementation (FIPS 180-4)
 * Used for synchronous share commitment verification and manifest digests
 */
const K_SHA256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

function rotr(n: number, x: number): number {
  return (x >>> n) | (x << (32 - n));
}

export function sha256Bytes(data: Uint8Array): Uint8Array {
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const bitLen = data.length * 8;
  const padLen = ((data.length + 8) >> 6) * 64 + 64;
  const padded = new Uint8Array(padLen);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padLen - 4, bitLen >>> 0, false);
  view.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000), false);

  const w = new Uint32Array(64);
  for (let offset = 0; offset < padLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(7, w[i - 15]) ^ rotr(18, w[i - 15]) ^ (w[i - 15] >>> 3);
      const s1 = rotr(17, w[i - 2]) ^ rotr(19, w[i - 2]) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K_SHA256[i] + w[i]) >>> 0;
      const S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0, false);
  outView.setUint32(4, h1, false);
  outView.setUint32(8, h2, false);
  outView.setUint32(12, h3, false);
  outView.setUint32(16, h4, false);
  outView.setUint32(20, h5, false);
  outView.setUint32(24, h6, false);
  outView.setUint32(28, h7, false);
  return out;
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
  if (k < 2 || k > n || n > 255) {
    throw new Error('Invalid threshold parameters');
  }

  const sharesData: Uint8Array[] = Array.from({ length: n }, () => new Uint8Array(secretBytes.length));

  for (let byteIdx = 0; byteIdx < secretBytes.length; byteIdx++) {
    // Polynomial coefficients: coeffs[0] = secret byte, coeffs[1..k-1] = random non-zero bytes
    const coeffs = new Uint8Array(k);
    coeffs[0] = secretBytes[byteIdx];

    if (deterministicSeed) {
      const seedHash = sha256Bytes(
        new Uint8Array([...deterministicSeed, byteIdx, epoch])
      );
      for (let d = 1; d < k; d++) {
        coeffs[d] = seedHash[d] === 0 ? 0x5a : seedHash[d];
      }
    } else {
      const rand = new Uint8Array(k - 1);
      crypto.getRandomValues(rand);
      for (let d = 1; d < k; d++) {
        coeffs[d] = rand[d - 1] === 0 ? 0x37 : rand[d - 1];
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
    if (share.index < 1 || share.index > 5) {
      throw new Error(`ERR_SHARE_INVALID_INDEX: Keeper index ${share.index} out of bounds [1..5]`);
    }
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

    if (validatedShares.length === k) break;
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
