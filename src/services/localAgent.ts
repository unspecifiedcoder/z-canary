export interface AgentStatus {
  service: string;
  state: string;
  network: string;
  simulation: boolean;
  wallet: { available: boolean; state: string };
  keepers: { running: boolean; state: string };
  capabilities: {
    memoVerification: boolean;
    walletCommands: boolean;
    keeperRelease: boolean;
  };
}

export interface VerifiedMemo {
  verified: boolean;
  network: number;
  operation: string;
  switchIdHex: string;
  sequence: string;
  requestedExpiryHeight: number;
  manifestDigestHex: string;
  sourcePubkeyHex: string;
}

export interface AgentEvidenceReport {
  version: 1;
  label: string;
  runs: Array<{
    label: string;
    mode: 'testnet' | 'synthetic-chain';
    checks: Array<{ name: string; passed: boolean }>;
    transactions: Array<{ label: string; txid: string; blockHeight?: number; network: 'testnet' }>;
    limitations: string[];
  }>;
}

export interface AgentEvidenceResponse {
  available: boolean;
  report?: AgentEvidenceReport;
}

export class AgentApiError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'AgentApiError';
  }
}

export const LOCAL_AGENT_TIMEOUT_MS = 12_000;

/** Prevents late responses from an older credential or memo selection from replacing current UI state. */
export class RequestEpoch {
  private value = 0;
  begin(): number { return ++this.value; }
  invalidate(): void { this.value += 1; }
  isCurrent(epoch: number): boolean { return this.value === epoch; }
}

function apiUrl(baseUrl: string, path: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (!/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(base)) {
    throw new AgentApiError('Use an exact loopback URL such as http://127.0.0.1:8787.');
  }
  return `${base}${path}`;
}

async function request<T>(baseUrl: string, token: string, path: string, init?: RequestInit, timeoutMs = LOCAL_AGENT_TIMEOUT_MS): Promise<T> {
  const bearer = token.trim();
  if (!bearer) throw new AgentApiError('Enter the local agent bearer token.');
  const url = apiUrl(baseUrl, path);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${bearer}`,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch {
    if (controller.signal.aborted) {
      throw new AgentApiError(`Local agent request timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`, 'ERR_TIMEOUT');
    }
    throw new AgentApiError('Could not reach the local agent. Check that it is running and that this origin is allowed.');
  } finally {
    clearTimeout(timeout);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new AgentApiError(body?.error?.message || `Local agent returned HTTP ${response.status}.`, body?.error?.code);
  }
  return body as T;
}

export const localAgent = {
  status: (baseUrl: string, token: string, timeoutMs?: number) => request<AgentStatus>(baseUrl, token, '/v1/status', undefined, timeoutMs),
  verifyMemo: (baseUrl: string, token: string, memoHex: string, timeoutMs?: number) => request<VerifiedMemo>(baseUrl, token, '/v1/memos/verify', {
    method: 'POST', body: JSON.stringify({ memoHex }),
  }, timeoutMs),
  evidence: (baseUrl: string, token: string, timeoutMs?: number) => request<AgentEvidenceResponse>(baseUrl, token, '/v1/evidence', undefined, timeoutMs),
};
