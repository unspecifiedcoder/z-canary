/** Real testnet acceptance runner. Requires an already running native agent.
 * No wallet keys or tokens are written to progress or evidence. Fixtures are
 * deliberately public, non-sensitive test data. This spends valueless TAZ.
 * Resume with the SAME ZCANARY_NATIVE_TEST_DIR. An uncertain POST is reconciled
 * against the agent journal; it is never blindly submitted a second time.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { open, mkdir, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const base = (process.env.ZCANARY_NATIVE_BASE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
assert.match(base, /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/, 'Agent URL must be exact loopback HTTP');
const tokenPath = process.env.ZCANARY_NATIVE_TOKEN_FILE;
assert.ok(tokenPath, 'ZCANARY_NATIVE_TOKEN_FILE is required');
const token = (await readFile(tokenPath, 'utf8')).trim();
assert.match(token, /^[A-Za-z0-9_-]{43,}$/, 'Invalid native token format');
const testDir = resolve(process.env.ZCANARY_NATIVE_TEST_DIR || resolve(scriptDir, '../state/native-live-smoke'));
await mkdir(testDir, { recursive: true });
const progressPath = resolve(testDir, 'progress.json');
const evidencePath = resolve(testDir, 'evidence.json');
const lockPath = resolve(testDir, 'runner.lock');
const owner = randomUUID();
let lock;
try {
  lock = await open(lockPath, 'wx');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  const existing = JSON.parse(await readFile(lockPath, 'utf8'));
  let alive = true;
  try { process.kill(existing.pid, 0); } catch (probe) { if (probe.code === 'ESRCH') alive = false; }
  assert.equal(alive, false, 'Another smoke runner is active, or its ownership cannot be verified');
  await unlink(lockPath);
  lock = await open(lockPath, 'wx');
}
await lock.writeFile(JSON.stringify({ pid: process.pid, owner }));
await lock.sync();
await lock.close();

let progress;
try { progress = JSON.parse(await readFile(progressPath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
progress ??= {
  version: 1, runId: randomUUID(), base, mode: 'testnet', startedAt: new Date().toISOString(),
  status: 'running', checks: {}, vaults: {}, operations: {},
};
assert.equal(progress.version, 1, 'Unsupported progress version');
assert.equal(progress.base, base, 'Resume must use the original agent URL');
const POLL_MS = 20_000;
const OPERATION_TIMEOUT_MS = 30 * 60_000;
const RECOVERY_TIMEOUT_MS = 5 * 60_000;
const requireKeeperState = process.env.ZCANARY_REQUIRE_KEEPER_STATE === '1';
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fixture = role => Buffer.from(`Canary public native acceptance fixture v1\nRun: ${progress.runId}\nScenario: ${role}\nNo private evidence is included.\n`, 'utf8');
let stage = 'startup';

async function writeAtomic(path, value) {
  const temporary = `${path}.${owner}.tmp`;
  const file = await open(temporary, 'w');
  await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
  await file.sync();
  await file.close();
  await rename(temporary, path);
}
function evidence() {
  return {
    version: 1, label: 'Native API → shielded testnet → five keeper processes → recipient recovery',
    mode: 'testnet', status: progress.status, startedAt: progress.startedAt,
    updatedAt: new Date().toISOString(), completedAt: progress.completedAt,
    checks: Object.entries(progress.checks).map(([name, passed]) => ({ name, passed })),
    transactions: Object.entries(progress.operations).filter(([, op]) => op.state === 'confirmed' && op.contextVerified === true).map(([label, op]) => ({ label, network: 'testnet', txid: op.txid, blockHeight: op.blockHeight })),
    vaults: Object.entries(progress.vaults).map(([scenario, vault]) => ({ scenario, switchId: vault.id, lifecycle: vault.lifecycle, shareCount: vault.shareCount, packageDigestHex: vault.packageDigestHex, recoveredDigestHex: vault.recoveredDigestHex, keeperAgreement: vault.keeperAgreement, keeperLastSequence: vault.keeperLastSequence, keeperExpiryHeight: vault.keeperExpiryHeight })),
    limitations: [
      'Five isolated keeper processes run on one Windows PC; this is not five independent operators.',
      'Live Zcash testnet TAZ is valueless; no mainnet transactions are performed.',
      'This runner verifies API and cryptographic behavior, not browser appearance.',
      ...(progress.checks.exactly_two_shares_cannot_decrypt ? [] : ['An exact two-share API window was not observed; the pre-release threshold gate was checked instead.']),
    ],
    ...(progress.status === 'failed' ? { stoppedAtStage: progress.stoppedAtStage, failure: progress.failure } : {}),
  };
}
async function save() {
  await writeAtomic(progressPath, progress);
  await writeAtomic(evidencePath, evidence());
}
async function check(name) {
  if (!progress.checks[name]) {
    progress.checks[name] = true;
    await save();
    console.log(`PASS ${name}`);
  }
}
async function http(route, { method = 'GET', body, bearer = true, origin, timeout = 120_000 } = {}) {
  let response;
  try {
    response = await fetch(`${base}${route}`, {
      method, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(timeout),
      headers: { ...(bearer ? { Authorization: `Bearer ${token}` } : {}), ...(origin ? { Origin: origin } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error(`Agent transport unavailable during ${method} ${route.split('/').slice(0, 3).join('/')}; inspect persisted intent before resuming`);
  }
  let value;
  try { value = await response.json(); } catch { throw new Error('Agent returned a non-JSON response'); }
  return { status: response.status, ok: response.ok, value };
}
async function api(route, options) {
  const response = await http(route, options);
  assert.ok(response.ok, `Agent HTTP ${response.status} at ${stage}`);
  return response.value;
}
async function vault(id) { return api(`/v1/vaults/${id}`); }
function verifiedAcks(detail) {
  return detail.acknowledgements?.length === 5 && detail.acknowledgements.every(ack => ack.verified === true) && new Set(detail.acknowledgements.map(ack => ack.keeperId)).size === 5;
}
async function waitFor(label, get, predicate, timeout = OPERATION_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await get();
    if (await predicate(value)) return value;
    await sleep(POLL_MS);
  }
  throw new Error(`${label} did not complete within ${Math.round(timeout / 60_000)} minutes; progress preserved for resume`);
}
async function ensureVault(role, recipient) {
  stage = `${role}:create`;
  let record = progress.vaults[role];
  if (!record) {
    record = progress.vaults[role] = { fileName: `canary-${role}-${progress.runId}.txt`, creation: 'not-started' };
    await save();
  }
  if (!record.id) {
    const find = async () => {
      const list = await api('/v1/vaults');
      const found = list.vaults.filter(item => item.fileName === record.fileName);
      assert.ok(found.length <= 1, 'Duplicate smoke fixture vaults detected');
      return found[0];
    };
    let detail = await find();
    if (!detail && record.creation === 'uncertain') {
      detail = await waitFor('Previously requested vault creation', find, Boolean, RECOVERY_TIMEOUT_MS);
    }
    if (!detail) {
      record.creation = 'uncertain';
      await save();
      detail = await api('/v1/vaults', { method: 'POST', body: {
        fileName: record.fileName, contentsBase64: fixture(role).toString('base64'),
        recipient: recipient.recipient, recipientFingerprint: recipient.fingerprint,
        intervalBlocks: role === 'release' ? 8 : 100, graceBlocks: role === 'release' ? 1 : 4, confirmationTarget: 2,
      } });
    }
    assert.match(detail.id, /^[a-f0-9]{64}$/);
    record.id = detail.id;
    record.creation = 'created';
    record.packageDigestHex = detail.manifest.packageDigestHex;
    await save();
  }
  let detail = await vault(record.id);
  if (!verifiedAcks(detail)) {
    // Provisioning retries are idempotent and cannot publish a chain command.
    await api(`/v1/vaults/${record.id}/provision`, { method: 'POST', body: {} });
    detail = await vault(record.id);
  }
  assert.ok(verifiedAcks(detail), 'Five distinct verified provisioning acknowledgements required');
  assert.equal(detail.manifest.network, 1);
  assert.equal(detail.manifest.threshold, 3);
  await check(`${role}_five_verified_keeper_acknowledgements`);
  return record;
}
async function command(role, action) {
  stage = `${role}:${action}`;
  const id = progress.vaults[role].id;
  const key = `${role}_${action}`;
  let saved = progress.operations[key];
  if (!saved) {
    const detail = await waitFor('Keeper lifecycle before command', () => vault(id), item => action === 'register' ? item.lifecycle === 'DRAFT' : ['ACTIVE', 'GRACE'].includes(item.lifecycle));
    saved = progress.operations[key] = { state: 'not-started', previousOperationId: detail.lastOperation?.operationId || null };
    if (requireKeeperState && action === 'postpone') {
      assert.ok(detail.keeperAgreement >= 3 && Number.isSafeInteger(detail.expiryHeight), 'Postpone requires agreed keeper expiry before submission');
      assert.equal(detail.keeperLastSequence, '0');
      saved.previousKeeperExpiry = detail.expiryHeight;
      saved.previousKeeperSequence = detail.keeperLastSequence;
    }
    await save();
  }
  if (!saved.operationId && saved.state === 'uncertain') {
    const found = await waitFor('Previously requested command journal', () => vault(id), detail => detail.lastOperation?.operationId && detail.lastOperation.operationId !== saved.previousOperationId, RECOVERY_TIMEOUT_MS);
    saved.operationId = found.lastOperation.operationId;
    saved.state = found.lastOperation.state;
    await save();
  }
  if (!saved.operationId) {
    saved.state = 'uncertain';
    await save();
    const submitted = await api(`/v1/vaults/${id}/${action}`, { method: 'POST', body: {} });
    assert.match(submitted.operationId, /^[a-f0-9]{32}$/);
    saved.operationId = submitted.operationId;
    saved.state = 'submitted';
    await save();
  }
  const result = await waitFor('Shielded command confirmation', () => api(`/v1/operations/${saved.operationId}`), async operation => {
    assert.equal(operation.operationId, saved.operationId, 'Agent returned a different operation journal');
    if (operation.state !== saved.state) {
      saved.state = operation.state;
      if (operation.txid) saved.txid = operation.txid;
      await save();
      console.log(`${key}: ${operation.state}`);
    }
    assert.notEqual(operation.state, 'failed', `${key} failed; no automatic retry of a possibly broadcast command`);
    return operation.state === 'confirmed';
  });
  assert.match(result.txid, /^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(result.blockHeight) && result.blockHeight > 0);
  const confirmedVault = await vault(id);
  assert.ok(confirmedVault.events.some(event => event.type === action && event.txid === result.txid && event.blockHeight === result.blockHeight), 'Confirmed operation does not match the intended vault action');
  assert.ok(!Object.entries(progress.operations).some(([otherKey, operation]) => otherKey !== key && operation.txid === result.txid), 'Two intended commands resolved to the same transaction');
  Object.assign(saved, { state: 'confirmed', contextVerified: true, txid: result.txid, blockHeight: result.blockHeight });
  await save();
  await check(`${key}_confirmed_on_testnet`);
  if (requireKeeperState && action === 'postpone' && progress.operations[`${role}_cancel`]?.state !== 'confirmed') {
    assert.ok(Number.isSafeInteger(saved.previousKeeperExpiry), 'No pre-postpone keeper expiry was recorded; cannot assert an observed extension');
    const applied = await waitFor('Keeper application of POSTPONE', () => vault(id), detail => detail.keeperAgreement >= 3 && detail.keeperLastSequence === '1' && Number.isSafeInteger(detail.expiryHeight) && detail.expiryHeight === detail.requestedExpiryHeight && detail.expiryHeight > saved.previousKeeperExpiry);
    saved.appliedKeeperExpiry = applied.expiryHeight;
    saved.appliedKeeperSequence = applied.keeperLastSequence;
    saved.keeperAgreement = applied.keeperAgreement;
    await check('postpone_applied_by_agreeing_keeper_databases');
  }
}
async function verifyTerminalKeeperState() {
  const cancelled = await waitFor('Persisted keeper cancellation state', () => vault(progress.vaults.cancel.id), detail => detail.keeperAgreement >= 3 && detail.lifecycle === 'CANCELLED' && detail.keeperLastSequence === '2' && Number.isSafeInteger(detail.expiryHeight) && detail.expiryHeight > 0 && detail.expiryHeight === detail.requestedExpiryHeight);
  assert.equal(cancelled.shareCount, 0);
  Object.assign(progress.vaults.cancel, { keeperAgreement: cancelled.keeperAgreement, keeperLastSequence: cancelled.keeperLastSequence, keeperExpiryHeight: cancelled.expiryHeight });
  await check('cancelled_keeper_databases_preserve_sequence_and_requested_postpone_expiry');
  const released = await waitFor('Persisted keeper release state', () => vault(progress.vaults.release.id), detail => detail.keeperAgreement >= 3 && detail.lifecycle === 'RELEASED' && detail.keeperLastSequence === '0' && Number.isSafeInteger(detail.expiryHeight) && detail.expiryHeight > 0 && detail.expiryHeight === detail.requestedExpiryHeight);
  assert.ok(released.shareCount >= 3);
  Object.assign(progress.vaults.release, { keeperAgreement: released.keeperAgreement, keeperLastSequence: released.keeperLastSequence, keeperExpiryHeight: released.expiryHeight });
  await check('released_keeper_databases_preserve_registration_sequence_and_expiry');
}
async function thresholdGate(role) {
  const record = progress.vaults[role];
  const before = await vault(record.id);
  if (before.shareCount >= 3) return;
  const result = await http(`/v1/recipient/vaults/${record.id}/decrypt`, { method: 'POST', body: {} });
  // A share can arrive while the request runs. Only assert rejection if the
  // same subthreshold state is still visible after it completes.
  const after = await vault(record.id);
  if (after.shareCount < 3) {
    assert.equal(result.ok, false, 'Recipient decrypted before threshold participation');
    assert.equal(result.status, 409, 'Subthreshold check failed for a reason outside the native operation gate');
    assert.equal(result.value.error?.code, 'ERR_NATIVE_OPERATION');
    assert.equal(result.value.contentsBase64, undefined, 'Rejected recovery leaked evidence');
    await check('subthreshold_recipient_recovery_rejected');
    if (before.shareCount === 2 && after.shareCount === 2) await check('exactly_two_shares_cannot_decrypt');
  }
}

try {
  if (progress.status === 'complete') {
    if (requireKeeperState) {
      stage = 'completed-run:keeper-state-audit';
      await verifyTerminalKeeperState();
    }
    console.log('This run is already complete. Existing evidence preserved; no new vaults or transactions created.');
  } else {
    progress.status = 'running';
    delete progress.failure;
    delete progress.stoppedAtStage;
    await save();
    stage = 'authentication';
    assert.equal((await http('/v1/runtime', { bearer: false })).status, 401);
    await check('unauthenticated_api_rejected');
    assert.equal((await http('/v1/runtime', { origin: 'https://unauthorized.example' })).status, 403);
    await check('unapproved_browser_origin_rejected');
    stage = 'runtime';
    const runtime = await api('/v1/runtime');
    assert.equal(runtime.available, true);
    assert.equal(runtime.mode, 'testnet');
    assert.equal(runtime.wallet.available, true);
    assert.equal(runtime.keepers.length, 5);
    await check('native_testnet_runtime_and_five_keepers_available');
    stage = 'recipient';
    const recipient = await api('/v1/recipient/identity', { method: 'POST', body: {} });
    const restored = await api('/v1/recipient/identity', { method: 'POST', body: {} });
    assert.equal(recipient.recipient, restored.recipient);
    assert.equal(recipient.fingerprint, restored.fingerprint);
    await check('recipient_identity_restores_across_cli_processes');
    await ensureVault('release', recipient);
    await thresholdGate('release');
    await ensureVault('cancel', recipient);
    // Start the short release clock before exercising owner operations.
    await command('release', 'register');
    await command('cancel', 'register');
    await command('cancel', 'postpone');
    await command('cancel', 'cancel');
    stage = 'cancel:keeper-confirmation';
    const cancelled = await waitFor('Keeper cancellation', () => vault(progress.vaults.cancel.id), item => item.lifecycle === 'CANCELLED');
    assert.equal(cancelled.shareCount, 0);
    Object.assign(progress.vaults.cancel, { lifecycle: cancelled.lifecycle, shareCount: cancelled.shareCount });
    await check('cancelled_vault_releases_no_shares');
    stage = 'release:threshold';
    const released = await waitFor('Recipient threshold release', () => vault(progress.vaults.release.id), async item => {
      const record = progress.vaults.release;
      if (record.lifecycle !== item.lifecycle || record.shareCount !== item.shareCount) {
        Object.assign(record, { lifecycle: item.lifecycle, shareCount: item.shareCount });
        await save();
        console.log(`release: ${item.lifecycle}, ${item.shareCount}/3 verified shares`);
      }
      if (item.shareCount < 3) await thresholdGate('release');
      return item.lifecycle === 'RELEASED' && item.shareCount >= 3;
    });
    assert.ok(released.shareCount >= 3 && released.shareCount <= 5);
    await check('confirmed_expiration_releases_threshold_shares');
    stage = 'release:decrypt';
    const recovered = await api(`/v1/recipient/vaults/${progress.vaults.release.id}/decrypt`, { method: 'POST', body: {} });
    const bytes = Buffer.from(recovered.contentsBase64, 'base64');
    const digest = sha256(bytes);
    assert.equal(digest, sha256(fixture('release')));
    assert.equal(recovered.digestHex, digest);
    assert.equal(recovered.fileName, progress.vaults.release.fileName);
    progress.vaults.release.recoveredDigestHex = digest;
    bytes.fill(0);
    recovered.contentsBase64 = '';
    await check('recipient_decryption_matches_original_sha256');
    stage = 'inbox';
    const inbox = await api('/v1/recipient/inbox');
    assert.ok(inbox.vaults.some(item => item.id === progress.vaults.release.id && item.shareCount >= 3));
    const finalCancelled = await vault(progress.vaults.cancel.id);
    assert.equal(finalCancelled.lifecycle, 'CANCELLED');
    assert.equal(finalCancelled.shareCount, 0);
    await check('recipient_inbox_exposes_verified_release');
    if (requireKeeperState) {
      stage = 'terminal-keeper-state';
      await verifyTerminalKeeperState();
    }
    progress.status = 'complete';
    progress.completedAt = new Date().toISOString();
    await save();
    console.log(`COMPLETE ${Object.keys(progress.checks).length} checks; ${Object.values(progress.operations).filter(op => op.state === 'confirmed').length} confirmed shielded commands.`);
  }
} catch (error) {
  progress.status = 'failed';
  progress.stoppedAtStage = stage;
  // Assertion/error messages are controlled by this runner, never API payloads.
  progress.failure = String(error.message || 'Native acceptance failed').split('\n')[0].slice(0, 250);
  await save();
  console.error(`STOPPED ${stage}: ${progress.failure}`);
  process.exitCode = 1;
} finally {
  const current = JSON.parse(await readFile(lockPath, 'utf8'));
  if (current.owner === owner) await unlink(lockPath);
}
