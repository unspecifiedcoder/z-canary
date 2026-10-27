import { bytesToHex, hexToBytes } from '../crypto/shamir';
import { decodeAndValidateMemo, MemoOperation, ZcashNetwork } from '../crypto/memoCodec';

export interface ReceiptVerification {
  valid: boolean;
  errorCode?: string;
  errorMessage?: string;
  operation?: 'REGISTER' | 'POSTPONE' | 'CANCEL';
  sequence?: string;
  requestedExpiryHeight?: number;
  switchIdHex?: string;
  manifestDigestHex?: string;
  sourcePubKeyHex?: string;
}

const OPERATION_NAMES: Record<number, 'REGISTER' | 'POSTPONE' | 'CANCEL'> = {
  [MemoOperation.REGISTER]: 'REGISTER',
  [MemoOperation.POSTPONE]: 'POSTPONE',
  [MemoOperation.CANCEL]: 'CANCEL',
};

/** Runs the same strict 512-byte and Ed25519 checks the keepers apply, on pasted or recorded hex. */
export function verifyReceiptHex(input: string): ReceiptVerification {
  const hex = input.replace(/\s+/g, '').replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
    return { valid: false, errorCode: 'ERR_NOT_HEX', errorMessage: 'Input is not an even-length hexadecimal string.' };
  }
  const result = decodeAndValidateMemo(new Uint8Array(hexToBytes(hex)), ZcashNetwork.TESTNET);
  if (!result.valid || !result.decoded) {
    return { valid: false, errorCode: result.errorCode, errorMessage: result.errorMessage };
  }
  const d = result.decoded;
  return {
    valid: true,
    operation: OPERATION_NAMES[d.operation],
    sequence: d.sequence.toString(),
    requestedExpiryHeight: d.requestedExpiryHeight,
    switchIdHex: d.switchIdHex,
    manifestDigestHex: d.manifestDigestHex,
    sourcePubKeyHex: bytesToHex(hexToBytes(d.sourcePubKeyHex)),
  };
}
