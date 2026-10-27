import test from 'node:test';
import assert from 'node:assert/strict';
import { base64ToBytes, fileToBase64, isLoopbackHostname, MAX_NATIVE_FILE_BYTES, NativeApiError, nativeVaultApi, sha256HexBytes } from '../src/services/nativeVault';

test('wallet controls are enabled only for exact loopback browser hostnames', () => {
  for (const hostname of ['localhost', 'LOCALHOST', '127.0.0.1', '[::1]', '::1']) assert.equal(isLoopbackHostname(hostname), true);
  for (const hostname of ['unspecifiedcoder.github.io', 'localhost.evil.test', '127.0.0.1.evil.test', '0.0.0.0']) assert.equal(isLoopbackHostname(hostname), false);
});

const token = 'native-agent-test-token';

test('native agent client rejects non-loopback URLs and missing credentials before fetch', async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('unexpected fetch'); };
  try {
    await assert.rejects(nativeVaultApi.runtime('https://127.0.0.1:8787', token), /exact loopback agent URL/);
    await assert.rejects(nativeVaultApi.runtime('http://127.0.0.1.evil:8787', token), /exact loopback agent URL/);
    await assert.rejects(nativeVaultApi.runtime('http://127.0.0.1:8787/path', token), /exact loopback agent URL/);
    await assert.rejects(nativeVaultApi.runtime('http://127.0.0.1:8787', ''), /bearer token/);
    assert.equal(called, false);
  } finally { globalThis.fetch = originalFetch; }
});

test('native client sends bearer auth, no-store, and the exact vault endpoint', async () => {
  const originalFetch = globalThis.fetch;
  let seenUrl = '';
  let seenInit: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    seenUrl = String(input); seenInit = init;
    return new Response(JSON.stringify({ operationId: 'op-1' }), { status: 200 });
  };
  try {
    const result = await nativeVaultApi.register('http://localhost:8787/', token, 'vault/alpha');
    assert.equal(result.operationId, 'op-1');
    assert.equal(seenUrl, 'http://localhost:8787/v1/vaults/vault%2Falpha/register');
    assert.equal(new Headers(seenInit?.headers).get('authorization'), `Bearer ${token}`);
    assert.equal(seenInit?.cache, 'no-store');
    assert.equal(seenInit?.method, 'POST');
    assert.ok(seenInit?.signal);
  } finally { globalThis.fetch = originalFetch; }
});

test('native wallet errors preserve status and stable error codes', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'ERR_WALLET_UNAVAILABLE', message: 'native wallet unavailable' } }), { status: 503 });
  try {
    await assert.rejects(nativeVaultApi.runtime('http://127.0.0.1:8787', token), (error: unknown) => {
      assert.ok(error instanceof NativeApiError);
      assert.equal(error.code, 'ERR_WALLET_UNAVAILABLE');
      assert.equal(error.status, 503);
      assert.equal(error.message, 'native wallet unavailable');
      return true;
    });
  } finally { globalThis.fetch = originalFetch; }
});

test('file encoding preserves arbitrary binary data and enforces the 10 MiB limit', async () => {
  const bytes = new Uint8Array(32_777);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 37) & 0xff;
  const file = new File([bytes], 'binary.dat');
  const encoded = await fileToBase64(file);
  assert.deepEqual(base64ToBytes(encoded), bytes);
  assert.equal((await sha256HexBytes(base64ToBytes(encoded))).length, 64);
  assert.throws(() => base64ToBytes(`${encoded}x`), /invalid base64/);
  assert.equal(MAX_NATIVE_FILE_BYTES, 10 * 1024 * 1024);
  const oversized = new File([new Uint8Array(MAX_NATIVE_FILE_BYTES + 1)], 'too-large.bin');
  await assert.rejects(fileToBase64(oversized), /no larger than 10 MiB/);
});

test('retry resumes the existing operation and identity export carries only explicit role/passphrase', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string | undefined; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ operationId: 'immutable-operation' }), { status: 200 });
  };
  try {
    await nativeVaultApi.retry('http://127.0.0.1:8787', token, 'immutable-operation');
    assert.deepEqual(requests[0], { url: 'http://127.0.0.1:8787/v1/operations/immutable-operation/retry', method: 'POST', body: {} });
    await nativeVaultApi.exportIdentity('http://127.0.0.1:8787', token, 'recipient', 'public-test-passphrase');
    assert.deepEqual(requests[1], { url: 'http://127.0.0.1:8787/v1/identity/recipient/export', method: 'POST', body: { passphrase: 'public-test-passphrase' } });
    await nativeVaultApi.fees('http://127.0.0.1:8787', token);
    assert.deepEqual(requests[2], { url: 'http://127.0.0.1:8787/v1/fees', method: 'GET', body: null });
  } finally { globalThis.fetch = originalFetch; }
});
