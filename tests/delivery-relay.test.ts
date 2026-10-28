import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DeliveryStore, createRelayServer } from '../backend/scripts/delivery-relay.mjs';

const sample = (index = 1) => ({
  idempotencyKey: `release-envelope-${index.toString().padStart(2, '0')}`,
  switchIdHex: '11'.repeat(32),
  manifestDigestHex: '22'.repeat(32),
  keeperId: `keeper-${index.toString().padStart(2, '0')}`,
  keeperIndex: index,
  payloadHex: 'abcd',
});

test('relay separates read/write capabilities, persists ciphertext, and deduplicates retries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zcanary-relay-'));
  try {
    const path = join(dir, 'relay.json');
    const store = await new DeliveryStore(path).open();
    const mailbox = await store.createMailbox();
    await assert.rejects(store.deliver(mailbox.mailboxId, mailbox.readCapability, sample()), /unauthorized/);
    assert.deepEqual(await store.deliver(mailbox.mailboxId, mailbox.writeCapability, sample()), { accepted: true, deduplicated: false });
    assert.deepEqual(await store.deliver(mailbox.mailboxId, mailbox.writeCapability, sample()), { accepted: true, deduplicated: true });
    assert.equal(store.list(mailbox.mailboxId, mailbox.readCapability).length, 1);
    assert.throws(() => store.list(mailbox.mailboxId, mailbox.writeCapability), /unauthorized/);

    const reopened = await new DeliveryStore(path).open();
    assert.equal(reopened.list(mailbox.mailboxId, mailbox.readCapability)[0].payloadHex, 'abcd');
    const disk = await readFile(path, 'utf8');
    assert.equal(disk.includes(mailbox.readCapability), false);
    assert.equal(disk.includes(mailbox.writeCapability), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('relay rejects conflicting keeper deliveries and malformed context', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zcanary-relay-'));
  try {
    const store = await new DeliveryStore(join(dir, 'relay.json')).open();
    const mailbox = await store.createMailbox();
    await store.deliver(mailbox.mailboxId, mailbox.writeCapability, sample());
    await assert.rejects(
      store.deliver(mailbox.mailboxId, mailbox.writeCapability, { ...sample(), payloadHex: 'beef' }),
      /idempotency_conflict/,
    );
    await assert.rejects(
      store.deliver(mailbox.mailboxId, mailbox.writeCapability, { ...sample(), idempotencyKey: 'release-envelope-other', payloadHex: 'beef' }),
      /keeper_delivery_conflict/,
    );
    await assert.rejects(
      store.deliver(mailbox.mailboxId, mailbox.writeCapability, { ...sample(), keeperId: 'keeper-02' }),
      /keeper_context_mismatch/,
    );
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('failed persistence never publishes an uncommitted delivery and retry remains possible', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zcanary-relay-'));
  try {
    const store = await new DeliveryStore(join(dir, 'relay.json')).open();
    const box = await store.createMailbox();
    const persist = store.persist.bind(store);
    store.persist = async () => { throw new Error('injected disk failure'); };
    await assert.rejects(store.deliver(box.mailboxId, box.writeCapability, sample()), /disk failure/);
    assert.equal(store.list(box.mailboxId, box.readCapability).length, 0);
    store.persist = persist;
    assert.equal((await store.deliver(box.mailboxId, box.writeCapability, sample())).deduplicated, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('HTTP relay requires creation authority, separates mailboxes, bounds payloads and rejects browser origins', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zcanary-relay-'));
  const store = await new DeliveryStore(join(dir, 'relay.json')).open();
  const adminToken = 'test-relay-admin-capability-32-characters';
  const server = createRelayServer(store, { adminToken });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const request = (path: string, method = 'GET', token?: string, body?: unknown, origin?: string) => fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(origin ? { origin } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    assert.equal((await request('/v1/mailboxes', 'POST', undefined, {})).status, 401);
    assert.equal((await request('/v1/mailboxes', 'POST', adminToken, {}, 'https://example.test')).status, 400);
    const created = await request('/v1/mailboxes', 'POST', adminToken, {});
    assert.equal(created.status, 201);
    const box = await created.json();
    const another = await (await request('/v1/mailboxes', 'POST', adminToken, {})).json();
    const path = `/v1/mailboxes/${box.mailboxId}/deliveries`;
    assert.equal((await request(path, 'POST', box.writeCapability, sample())).status, 201);
    assert.equal((await request(path, 'POST', box.writeCapability, sample())).status, 200);
    assert.equal((await request(path, 'GET', another.readCapability)).status, 401);
    const inbox = await request(path, 'GET', box.readCapability);
    assert.equal(inbox.headers.get('cache-control'), 'no-store');
    assert.equal((await inbox.json()).deliveries.length, 1);
    assert.equal((await request(path, 'POST', box.writeCapability, { ...sample(2), switchIdHex: '33'.repeat(32) })).status, 409);
    assert.equal((await request(path, 'POST', box.writeCapability, { ...sample(2), payloadHex: 'ab'.repeat(4106) })).status, 400);
    assert.equal((await request(path, 'POST', box.writeCapability, { ...sample(2), payloadHex: 'ab'.repeat(8000) })).status, 413);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
