const TESTNET_UNIFIED_ADDRESS = /^utest1[0-9a-z]+$/;
const TXID = /^[0-9a-f]{64}$/i;

export interface Zip321RegistrationRequest {
  address: string;
  amountZatoshi: number;
  amountZec: string;
  memoBase64Url: string;
  memoHex: string;
  message: string;
  uri: string;
}

export interface ExternalWalletSubmission {
  request: Zip321RegistrationRequest;
  txid: string;
  explorerUrl: string;
}

function hexToBytesStrict(hex: string): Uint8Array {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) {
    throw new Error('Memo must be hexadecimal.');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

export function formatZatoshiAmount(amountZatoshi: number): string {
  if (!Number.isSafeInteger(amountZatoshi) || amountZatoshi < 1) {
    throw new Error('Amount must be a positive whole number of zatoshi.');
  }
  const whole = Math.floor(amountZatoshi / 100_000_000);
  const fraction = String(amountZatoshi % 100_000_000).padStart(8, '0');
  return `${whole}.${fraction}`;
}

export function buildZip321RegistrationRequest(input: {
  address: string;
  amountZatoshi: number;
  memoHex: string;
  message?: string;
}): Zip321RegistrationRequest {
  const address = input.address.trim().toLowerCase();
  if (!TESTNET_UNIFIED_ADDRESS.test(address)) {
    throw new Error('A Zcash testnet Unified Address is required.');
  }

  const memoHex = input.memoHex.toLowerCase();
  const memoBytes = hexToBytesStrict(memoHex);
  if (memoBytes.length !== 512) {
    throw new Error(`REGISTER memo must be exactly 512 bytes, got ${memoBytes.length}.`);
  }

  const amountZec = formatZatoshiAmount(input.amountZatoshi);
  const memoBase64Url = base64UrlEncode(memoBytes);
  const message = input.message ?? 'Canary REGISTER command (Zcash testnet)';
  const uri = `zcash:${address}?amount=${amountZec}&memo=${memoBase64Url}&message=${encodeURIComponent(message)}`;

  return {
    address,
    amountZatoshi: input.amountZatoshi,
    amountZec,
    memoBase64Url,
    memoHex,
    message,
    uri,
  };
}

export function normalizeTestnetTxid(value: string): string | null {
  const txid = value.trim().toLowerCase();
  return TXID.test(txid) ? txid : null;
}

export function testnetExplorerUrl(txid: string): string {
  const normalized = normalizeTestnetTxid(txid);
  if (!normalized) throw new Error('Transaction ID must be 64 hexadecimal characters.');
  return `https://testnet.zecblock.com/tx/${normalized}`;
}
