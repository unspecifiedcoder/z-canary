import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentApiError, RequestEpoch, localAgent } from '../src/services/localAgent';

const token = 'unit-test-token-never-a-real-secret';

test('local agent client only accepts exact loopback HTTP origins', async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('unexpected fetch'); };
  try {
    await assert.rejects(localAgent.status('https://127.0.0.1:8787', token), /exact loopback URL/);
    await assert.rejects(localAgent.status('http://localhost.evil:8787', token), /exact loopback URL/);
    await assert.rejects(localAgent.status('http://127.0.0.1:8787/path', token), /exact loopback URL/);
    await assert.rejects(localAgent.status('http://127.0.0.1:8787', ''), /bearer token/);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('status request sends bearer auth and disables caching', async () => {
  const originalFetch = globalThis.fetch;
  let seen: RequestInit | undefined;
  globalThis.fetch = async (_input, init) => {
    seen = init;
    return new Response(JSON.stringify({ service: 'agent', state: 'wallet-unavailable' }), { status: 200 });
  };
  try {
    const status = await localAgent.status('http://127.0.0.1:8787/', token);
    assert.equal(status.service, 'agent');
    assert.equal(new Headers(seen?.headers).get('authorization'), `Bearer ${token}`);
    assert.equal(seen?.cache, 'no-store');
    assert.ok(seen?.signal);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('agent error envelopes preserve stable codes', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'ERR_WALLET_UNAVAILABLE', message: 'wallet unavailable' } }), { status: 503 });
  try {
    await assert.rejects(localAgent.status('http://127.0.0.1:8787', token), (error: unknown) => {
      assert.ok(error instanceof AgentApiError);
      assert.equal(error.code, 'ERR_WALLET_UNAVAILABLE');
      assert.equal(error.message, 'wallet unavailable');
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('evidence endpoint returns versioned runs over the authenticated client', async () => {
  const originalFetch = globalThis.fetch;
  let url = '';
  globalThis.fetch = async (input) => {
    url = String(input);
    return new Response(JSON.stringify({ available: true, report: {
      version: 1,
      label: 'Verified milestones',
      runs: [{ label: 'Synthetic rehearsals', mode: 'synthetic-chain', checks: [{ name: 'quorum release', passed: true }], transactions: [], limitations: ['Synthetic blocks only.'] }],
    } }), { status: 200 });
  };
  try {
    const response = await localAgent.evidence('http://127.0.0.1:8787', token);
    assert.equal(url, 'http://127.0.0.1:8787/v1/evidence');
    assert.equal(response.available, true);
    assert.equal(response.report?.version, 1);
    assert.equal(response.report?.runs[0].mode, 'synthetic-chain');
    assert.equal(response.report?.runs[0].transactions.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('hung local agent request times out and stale request epochs are ignored', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
  try {
    await assert.rejects(localAgent.status('http://127.0.0.1:8787', token, 5), (error: unknown) => {
      assert.ok(error instanceof AgentApiError);
      assert.equal(error.code, 'ERR_TIMEOUT');
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const epoch = new RequestEpoch();
  const pendingVerification = epoch.begin();
  epoch.invalidate(); // A credential or selected memo changed while verification was pending.
  assert.equal(epoch.isCurrent(pendingVerification), false);
  assert.equal(epoch.isCurrent(epoch.begin()), true);
});
