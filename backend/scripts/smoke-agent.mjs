// Run with Node 22+: node backend/scripts/smoke-agent.mjs ABSOLUTE_AGENT_BINARY
// Uses a fresh local-only token, a free port, and the public RFC test fixture.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

assert(process.argv[2], 'Supply the built zcanary-agent binary path');
const reserve = createServer();
await new Promise((ok, fail) => reserve.once('error', fail).listen(0, '127.0.0.1', ok));
const port = reserve.address().port;
await new Promise(ok => reserve.close(ok));
const directory = await mkdtemp(join(tmpdir(), 'zcanary-smoke-'));
const tokenPath = join(directory, 'token');
const evidencePath = join(directory, 'evidence.json');
const token = randomBytes(32).toString('base64url');
await writeFile(tokenPath, token, { mode: 0o600, flag: 'wx' });
await writeFile(evidencePath, JSON.stringify({
  version: 1,
  label: 'Smoke-test evidence schema',
  runs: [
    { label: 'Synthetic lifecycle checks', mode: 'synthetic-chain', checks: [{ name: 'fixture lifecycle passes', passed: true }], transactions: [], limitations: ['Synthetic fixture only.'] },
    { label: 'Testnet transaction proof', mode: 'testnet', checks: [{ name: 'independent memo recovery', passed: true }], transactions: [{ label: 'Shielded memo transaction', txid: 'ab'.repeat(32), blockHeight: 123, network: 'testnet' }], limitations: ['Smoke-test transaction ID is a schema fixture.'] },
  ],
}), { flag: 'wx' });
const origin = 'http://127.0.0.1:4174';
const child = spawn(resolve(process.argv[2]), [
  '--token-file', tokenPath, '--listen', `127.0.0.1:${port}`, '--allowed-origin', origin,
  '--evidence-file', evidencePath,
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let childError;
child.once('error', error => { childError = error; });
const exited = new Promise(ok => child.once('close', ok));
const url = `http://127.0.0.1:${port}`;
const headers = { Authorization: `Bearer ${token}`, Origin: origin };
const request = (path, options = {}) => fetch(url + path, {
  ...options, signal: AbortSignal.timeout(5000),
});
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (childError) throw childError;
    assert.equal(child.exitCode, null, 'Agent exited before accepting requests');
    try {
      const response = await request('/v1/status');
      assert.equal(response.status, 401);
      ready = true;
      break;
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error;
      await delay(100);
    }
  }
  assert(ready, 'Agent did not start within the readiness window');
  const status = await request('/v1/status', { headers });
  assert.equal(status.status, 200);
  assert.equal(status.headers.get('access-control-allow-origin'), origin);
  const state = await status.json();
  assert.equal(state.simulation, false);
  assert.equal(state.wallet.available, false);
  assert.equal(state.keepers.running, false);

  const evidenceResponse = await request('/v1/evidence', { headers });
  assert.equal(evidenceResponse.status, 200);
  const evidence = await evidenceResponse.json();
  assert.equal(evidence.available, true);
  assert.equal(evidence.report.version, 1);
  assert.deepEqual(evidence.report.runs.map(run => run.mode), ['synthetic-chain', 'testnet']);
  assert.equal(evidence.report.runs[1].transactions[0].txid, 'ab'.repeat(32));

  const fixture = JSON.parse(await readFile(new URL('../fixtures/typescript-v1.json', import.meta.url), 'utf8'));
  for (const command of fixture.commands) {
    const response = await request('/v1/memos/verify', {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ memoHex: command.memoHex }),
    });
    assert.equal(response.status, 200);
    const verified = await response.json();
    assert.equal(verified.verified, true);
    assert.equal(verified.sequence, command.command.sequence);
  }
  const forbidden = await request('/v1/status', { headers: { ...headers, Origin: 'https://example.com' } });
  assert.equal(forbidden.status, 403);
  const unavailable = await request('/v1/vaults', { method: 'POST', headers });
  assert.equal(unavailable.status, 503);
  const failure = await unavailable.json();
  assert.equal(failure.error.code, 'ERR_WALLET_UNAVAILABLE');
  assert.match(failure.error.requestId, /^[0-9a-f]+$/);
  const wrongMethod = await request('/v1/status', { method: 'POST', headers });
  assert.equal(wrongMethod.status, 405);
  assert.equal((await wrongMethod.json()).error.code, 'ERR_METHOD_NOT_ALLOWED');
  console.log('PASS: real loopback HTTP process; bearer/origin controls; three signed memos; u64 sequence; truthful 503 wallet status; structured 405 errors.');
} finally {
  if (child.exitCode === null) child.kill();
  await exited;
  await unlink(tokenPath);
  await unlink(evidencePath);
  await rmdir(directory);
}
