// Cross-platform, real-crypto rehearsal over seven separate Compose services.
// Chain heights and blocks are synthetic by design; no transaction is broadcast.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const outputParent = resolve(process.env.ZCANARY_REHEARSAL_OUTPUT ?? '/workspace/artifacts');
await mkdir(outputParent, { recursive: true });
const root = await mkdtemp(join(outputParent, 'run-'));
const demoExe = process.env.ZCANARY_DEMO_EXE ?? '/usr/local/bin/zcanary-demo';
const relayUrl = process.env.ZCANARY_RELAY_URL ?? 'http://delivery-relay:8790';
const relayAdminToken = process.env.ZCANARY_RELAY_ADMIN_TOKEN;
const passphrase = process.env.ZCANARY_DEMO_PASSPHRASE;
if (!passphrase || passphrase.length < 32) throw new Error('ZCANARY_DEMO_PASSPHRASE must contain at least 32 characters');

const keeperUrls = process.env.ZCANARY_KEEPER_URLS?.split(',');
if (keeperUrls && keeperUrls.length !== 5) throw new Error('exactly five keeper URLs required');
const keepers = Array.from({ length: 5 }, (_, i) => ({
  id: `keeper-${String(i + 1).padStart(2, '0')}`,
  url: keeperUrls?.[i] ?? `http://keeper-${String(i + 1).padStart(2, '0')}:8788`,
  token: `zcanary-compose-token-${String(i + 1).padStart(2, '0')}-not-for-production`,
}));
const checks = [];
const hash = value => createHash('sha256').update(value).digest();
const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
const pass = text => { checks.push(text); console.log(`PASS ${text}`); };

async function jsonRequest(url, { method = 'GET', token, body } = {}) {
  const response = await fetch(url, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(`${response.status} ${url}: ${JSON.stringify(result)}`), { status: response.status });
  return result;
}

async function waitFor(url, token) {
  for (let attempt = 0; attempt < 120; attempt++) {
    try { return await jsonRequest(url, { token }); } catch { await sleep(500); }
  }
  throw new Error(`service unavailable: ${url}`);
}

async function keeperRequest(keeper, path, body) {
  return jsonRequest(`${keeper.url}${path}`, { method: body === undefined ? 'GET' : 'POST', token: keeper.token, body });
}

async function utility(args, expectedSuccess = true) {
  const child = spawn(demoExe, args, {
    env: { ...process.env, ZCANARY_DEMO_PASSPHRASE: passphrase },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk);
  child.stderr.on('data', chunk => stderr += chunk);
  const code = await new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', resolvePromise);
  });
  if (expectedSuccess) assert.equal(code, 0, stderr); else assert.notEqual(code, 0, 'subthreshold decrypt unexpectedly succeeded');
  return { stdout, stderr };
}

function blockHash(height) {
  return hash(Buffer.from(`Z-CANARY COMPOSE SYNTHETIC BLOCK ${height}`)).toString('hex');
}

async function scanBatch(start, end, memos = {}) {
  const blocks = Array.from({ length: end - start + 1 }, (_, offset) => {
    const height = start + offset;
    return {
      height,
      hash_hex: blockHash(height),
      previous_hash_hex: height ? blockHash(height - 1) : '00'.repeat(32),
      transactions: (memos[height] ?? []).map((memo, tx_index) => ({
        txid_hex: hash(Buffer.from(`COMPOSE SYNTHETIC TX ${height} ${tx_index} ${memo}`)).toString('hex'),
        tx_index,
        outputs: [{ tx_index, output_index: 0, memo_hex: memo }],
      })),
    };
  });
  for (const keeper of keepers) {
    await keeperRequest(keeper, '/v1/confirmed-batch', {
      adapter: 'synthetic-chain', network: 1, complete: true,
      confirmed_through: end, observed_tip_height: end + 1, blocks,
    });
  }
}

await mkdir(root, { recursive: true });
await waitFor(`${relayUrl}/v1/status`);
const statuses = [];
for (const keeper of keepers) statuses.push(await waitFor(`${keeper.url}/v1/status`, keeper.token));
assert.equal(new Set(statuses.map(status => status.recipient)).size, 5);
pass('five isolated keeper services expose five distinct encryption identities');
await writeFile(join(root, 'keeper-public-status.json'), JSON.stringify(statuses, null, 2));

const vaultDir = join(root, 'vaults');
await utility(['prepare', join(root, 'keeper-public-status.json'), vaultDir]);
const { vaults } = JSON.parse(await readFile(join(vaultDir, 'public.json'), 'utf8'));
const [cancelVault, releaseVault] = vaults;
for (const vault of vaults) {
  for (let index = 0; index < 5; index++) await keeperRequest(keepers[index], '/v1/provision', vault.provisions[index]);
}
pass('controller provisioned recipient-bound shares into five durable keeper databases');

const mailbox = await jsonRequest(`${relayUrl}/v1/mailboxes`, { method: 'POST', token: relayAdminToken, body: {} });
await scanBatch(0, 0);
await scanBatch(1, 15, { 1: vaults.map(vault => vault.register_memo_hex), 4: [cancelVault.cancel_memo_hex] });
for (const keeper of keepers) {
  const cancel = await keeperRequest(keeper, `/v1/vaults/${cancelVault.switch_id_hex}`);
  const release = await keeperRequest(keeper, `/v1/vaults/${releaseVault.switch_id_hex}`);
  assert.equal(cancel.lifecycle, 'CANCELLED');
  assert.equal(release.lifecycle, 'RELEASED');
}
pass('all keepers independently reached CANCELLED/RELEASED from the same complete synthetic scan');

const claimed = [];
for (const [index, keeper] of keepers.slice(0, 3).entries()) {
  const { delivery } = await keeperRequest(keeper, '/v1/next-delivery');
  assert.ok(delivery);
  assert.equal(delivery.switch_id_hex, releaseVault.switch_id_hex);
  assert.equal(delivery.manifest_digest_hex, releaseVault.manifest.manifestDigestHex);
  const envelope = {
    idempotencyKey: delivery.idempotency_key,
    switchIdHex: delivery.switch_id_hex,
    manifestDigestHex: delivery.manifest_digest_hex,
    keeperId: keeper.id,
    keeperIndex: index + 1,
    payloadHex: delivery.payload_hex,
  };
  await jsonRequest(`${relayUrl}/v1/mailboxes/${mailbox.mailboxId}/deliveries`, { method: 'POST', token: mailbox.writeCapability, body: envelope });
  const retry = await jsonRequest(`${relayUrl}/v1/mailboxes/${mailbox.mailboxId}/deliveries`, { method: 'POST', token: mailbox.writeCapability, body: envelope });
  assert.equal(retry.deduplicated, true);
  claimed.push({ keeper, delivery });
}
pass('three keepers delivered opaque encrypted envelopes through an idempotent network mailbox');

const { deliveries } = await jsonRequest(`${relayUrl}/v1/mailboxes/${mailbox.mailboxId}/deliveries`, { token: mailbox.readCapability });
assert.equal(deliveries.length, 3);
const deliveryPath = join(root, 'recipient-deliveries.json');
await writeFile(deliveryPath, JSON.stringify(deliveries.slice(0, 2).map(item => item.payloadHex)));
const insufficient = await utility(['decrypt', vaultDir, deliveryPath], false);
assert.match(insufficient.stderr, /at least three/);
pass('recipient rejected two envelopes as below the 3-of-5 threshold');
await writeFile(deliveryPath, JSON.stringify(deliveries.map(item => item.payloadHex)));
const decrypted = JSON.parse((await utility(['decrypt', vaultDir, deliveryPath])).stdout);
for (const { keeper, delivery } of claimed) {
  await keeperRequest(keeper, '/v1/ack-delivery', { delivery_id: delivery.delivery_id, delivered: true, cursor: delivery.cursor });
  assert.equal((await keeperRequest(keeper, '/v1/next-delivery')).delivery, null);
}
pass('recipient recovered the exact file only after three valid encrypted envelopes');

const result = {
  mode: 'synthetic-chain',
  liveTransactions: false,
  architecture: { keepers: 5, keeperProcesses: 5, relay: 'opaque capability mailbox', controllerScanner: 'complete synthetic blocks' },
  checks,
  cancellation: { lifecycle: 'CANCELLED', deliveredShares: 0 },
  release: { lifecycle: 'RELEASED', deliveredShares: deliveries.length },
  recovery: decrypted,
  boundaries: ['No Zcash transaction is broadcast by this rehearsal.', 'Compose credentials are demo-only.', 'Operators are isolated services, not independent organizations.'],
};
await writeFile(join(root, 'judge-rehearsal.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
console.log(`Evidence saved to ${join(root, 'judge-rehearsal.json')}`);
