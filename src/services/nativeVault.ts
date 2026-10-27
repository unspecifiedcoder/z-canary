export const MAX_NATIVE_FILE_BYTES = 10 * 1024 * 1024;
export const NATIVE_API_TIMEOUT_MS = 20_000;

export interface NativeKeeperRuntime {
  id: string;
  healthy: boolean;
}

export interface NativeRuntime {
  available: boolean;
  mode: 'testnet';
  wallet: {
    available: boolean;
    state: string;
    network?: 'testnet';
    receiveAddress?: string;
    tipHeight?: number;
    spendableZatoshi?: number;
    snapshot?: 'startup-sync';
  };
  keepers: NativeKeeperRuntime[];
  error?: string;
}

export interface NativeRecipientIdentity {
  recipient: string;
  fingerprint: string;
}

export interface NativeOperation {
  operationId: string;
  state: 'submitted' | 'broadcast' | 'confirmed' | 'failed';
  txid?: string;
  blockHeight?: number;
  error?: string;
}

export interface NativeVaultDetail {
  id: string;
  fileName: string;
  lifecycle: string;
  manifest: Record<string, unknown>;
  acknowledgements: Array<{ keeperId: string; verified: boolean }>;
  shareCount: number;
  events: Array<Record<string, unknown>>;
  lastOperation?: NativeOperation;
}

export interface NativeVaultListResponse { vaults: NativeVaultDetail[] }
export interface NativeRecipientInboxResponse { vaults: NativeVaultDetail[] }
export interface NativeSupportRequest { network: 'testnet'; address: string; uri: string; amountZatoshi: number; memo: null }
export interface NativeIdentityBackup { version: 1; role: 'source' | 'recipient'; fingerprint: string; encryptedBase64: string }
export interface NativeFeeEstimate { network: 'testnet'; feeZatoshi: number; noteAmountZatoshi: number; totalZatoshi: number; spendableZatoshi: number }

export class NativeApiError extends Error {
  constructor(message: string, readonly code?: string, readonly status?: number) {
    super(message);
    this.name = 'NativeApiError';
  }
}

function getApiUrl(baseUrl: string, route: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (!/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(base)) {
    throw new NativeApiError('Use an exact loopback agent URL such as http://127.0.0.1:8787.');
  }
  return `${base}${route}`;
}

async function call<T>(baseUrl: string, token: string, route: string, method: 'GET' | 'POST' = 'GET', body?: unknown, timeoutMs = NATIVE_API_TIMEOUT_MS): Promise<T> {
  const bearer = token.trim();
  if (!bearer) throw new NativeApiError('Enter the authenticated local-agent bearer token.');
  const url = getApiUrl(baseUrl, route);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch {
    if (controller.signal.aborted) throw new NativeApiError('The request timed out; the agent may still finish it. Refresh vaults before creating or submitting again.', 'ERR_TIMEOUT');
    throw new NativeApiError('Could not reach the loopback agent. Check that it is running and that this origin is allowed.');
  } finally {
    clearTimeout(timeout);
  }
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    throw new NativeApiError(result?.error?.message || result?.message || `Local agent returned HTTP ${response.status}.`, result?.error?.code, response.status);
  }
  return result as T;
}

export const nativeVaultApi = {
  fees: (base: string, token: string) => call<NativeFeeEstimate>(base, token, '/v1/fees', 'GET', undefined, 120_000),
  support: (base: string, token: string) => call<NativeSupportRequest>(base, token, '/v1/support-request'),
  exportIdentity: (base: string, token: string, role: 'source' | 'recipient', passphrase: string) => call<NativeIdentityBackup>(base, token, `/v1/identity/${role}/export`, 'POST', { passphrase }, 120_000),
  importIdentity: (base: string, token: string, role: 'source' | 'recipient', request: { passphrase: string; expectedFingerprint: string; backup: NativeIdentityBackup }) => call<{ role: string; fingerprint: string; restored: boolean; alreadyPresent: boolean }>(base, token, `/v1/identity/${role}/import`, 'POST', request, 120_000),
  runtime: (base: string, token: string) => call<NativeRuntime>(base, token, '/v1/runtime'),
  createRecipientIdentity: (base: string, token: string) => call<NativeRecipientIdentity>(base, token, '/v1/recipient/identity', 'POST', {}),
  listVaults: (base: string, token: string) => call<NativeVaultListResponse>(base, token, '/v1/vaults'),
  createVault: (base: string, token: string, request: {
    fileName: string; contentsBase64: string; recipient: string; recipientFingerprint: string;
    intervalBlocks: number; graceBlocks: number; confirmationTarget: number;
  }) => call<NativeVaultDetail>(base, token, '/v1/vaults', 'POST', request, 120_000),
  getVault: (base: string, token: string, id: string) => call<NativeVaultDetail>(base, token, `/v1/vaults/${encodeURIComponent(id)}`),
  exportPackage: (base: string, token: string, id: string) => call<{ format: 'ZCANARY-ENCRYPTED-PACKAGE-V1'; manifest: Record<string, unknown>; packageBase64: string; packageDigestHex: string }>(base, token, `/v1/vaults/${encodeURIComponent(id)}/package`, 'GET', undefined, 120_000),
  register: (base: string, token: string, id: string) => call<{ operationId: string }>(base, token, `/v1/vaults/${encodeURIComponent(id)}/register`, 'POST', {}),
  postpone: (base: string, token: string, id: string) => call<{ operationId: string }>(base, token, `/v1/vaults/${encodeURIComponent(id)}/postpone`, 'POST', {}),
  cancel: (base: string, token: string, id: string) => call<{ operationId: string }>(base, token, `/v1/vaults/${encodeURIComponent(id)}/cancel`, 'POST', {}),
  operation: (base: string, token: string, id: string) => call<NativeOperation>(base, token, `/v1/operations/${encodeURIComponent(id)}`),
  retry: (base: string, token: string, id: string) => call<{ operationId: string }>(base, token, `/v1/operations/${encodeURIComponent(id)}/retry`, 'POST', {}),
  provision: (base: string, token: string, id: string) => call<NativeVaultDetail>(base, token, `/v1/vaults/${encodeURIComponent(id)}/provision`, 'POST', {}, 120_000),
  recipientInbox: (base: string, token: string) => call<NativeRecipientInboxResponse>(base, token, '/v1/recipient/inbox'),
  decrypt: (base: string, token: string, id: string) => call<{ fileName: string; contentsBase64: string; digestHex: string }>(base, token, `/v1/recipient/vaults/${encodeURIComponent(id)}/decrypt`, 'POST', {}),
};

export async function fileToBase64(file: File): Promise<string> {
  if (file.size > MAX_NATIVE_FILE_BYTES) throw new NativeApiError('Choose a file no larger than 10 MiB.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const chunkBytes = 3 * 8192; // Keep each spread small and each nonfinal base64 chunk aligned.
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    chunks.push(btoa(String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.length)))));
  }
  return chunks.join('');
}

export function base64ToBytes(value: string): Uint8Array {
  const maxEncodedLength = Math.ceil(MAX_NATIVE_FILE_BYTES / 3) * 4;
  if (value.length > maxEncodedLength || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new NativeApiError('The downloaded file package has invalid base64 data.');
  }
  const binary = atob(value);
  if (binary.length > MAX_NATIVE_FILE_BYTES) throw new NativeApiError('The downloaded file exceeds the 10 MiB limit.');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const copy = bytes.slice().buffer as ArrayBuffer;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', copy));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function downloadBytes(fileName: string, bytes: Uint8Array): void {
  const safeName = fileName.replace(/[\\/\u0000-\u001f\u007f]/g, '_').slice(0, 180) || 'recovered-file.bin';
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer]));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = safeName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
