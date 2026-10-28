import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_BODY = 12 * 1024;
const MAX_PAYLOAD_HEX = 4105 * 2;
const MAX_MAILBOXES = 128;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const HEX_32 = /^[0-9a-f]{64}$/;
const KEEPER_ID = /^keeper-0[1-5]$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,160}$/;

const capabilityHash = (kind, value) =>
  createHash('sha256').update(`z-canary/relay/${kind}/v1\0`).update(value).digest('hex');

function equalHash(expected, actual) {
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(actual, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearer(request) {
  const value = request.headers.authorization ?? '';
  return value.startsWith('Bearer ') ? value.slice(7) : '';
}

function canonicalDelivery(body) {
  if (
    typeof body !== 'object' || body === null ||
    typeof body.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(body.idempotencyKey) ||
    typeof body.switchIdHex !== 'string' || !HEX_32.test(body.switchIdHex) ||
    typeof body.manifestDigestHex !== 'string' || !HEX_32.test(body.manifestDigestHex) ||
    typeof body.keeperId !== 'string' || !KEEPER_ID.test(body.keeperId) ||
    !Number.isInteger(body.keeperIndex) || body.keeperIndex < 1 || body.keeperIndex > 5 ||
    typeof body.payloadHex !== 'string' || body.payloadHex.length === 0 ||
    body.payloadHex.length > MAX_PAYLOAD_HEX || body.payloadHex.length % 2 !== 0 ||
    !/^[0-9a-f]+$/.test(body.payloadHex)
  ) throw Object.assign(new Error('invalid_delivery'), { status: 400 });
  if (body.keeperId !== `keeper-${String(body.keeperIndex).padStart(2, '0')}`) {
    throw Object.assign(new Error('keeper_context_mismatch'), { status: 400 });
  }
  return {
    idempotencyKey: body.idempotencyKey,
    switchIdHex: body.switchIdHex,
    manifestDigestHex: body.manifestDigestHex,
    keeperId: body.keeperId,
    keeperIndex: body.keeperIndex,
    payloadHex: body.payloadHex,
  };
}

export class DeliveryStore {
  constructor(path) {
    this.path = resolve(path);
    this.state = { version: 1, mailboxes: {} };
    this.writeQueue = Promise.resolve();
  }

  async open() {
    await mkdir(dirname(this.path), { recursive: true });
    try {
      if ((await stat(this.path)).size > MAX_STATE_BYTES) throw new Error('relay state too large');
      const parsed = JSON.parse(await readFile(this.path, 'utf8'));
      if (parsed?.version !== 1 || !parsed.mailboxes || Array.isArray(parsed.mailboxes) || typeof parsed.mailboxes !== 'object' || Object.keys(parsed.mailboxes).length > MAX_MAILBOXES) throw new Error('invalid relay state');
      for (const [id, box] of Object.entries(parsed.mailboxes)) {
        if (!/^[0-9a-f]{32}$/.test(id) || !HEX_32.test(box.readHash) || !HEX_32.test(box.writeHash) || !Array.isArray(box.deliveries) || box.deliveries.length > 5) throw new Error('invalid relay state');
        const indices = new Set();
        for (const item of box.deliveries) {
          canonicalDelivery(item);
          if (indices.has(item.keeperIndex) || item.switchIdHex !== box.deliveries[0].switchIdHex || item.manifestDigestHex !== box.deliveries[0].manifestDigestHex) throw new Error('invalid relay state');
          indices.add(item.keeperIndex);
        }
      }
      this.state = parsed;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await this.persist();
    }
    return this;
  }

  async persist(state = this.state) {
    const temp = `${this.path}.${process.pid}.tmp`;
    const bytes = Buffer.from(`${JSON.stringify(state)}\n`);
    if (bytes.length > MAX_STATE_BYTES) throw Object.assign(new Error('storage_capacity'), { status: 507 });
    try {
      const file = await open(temp, 'w', 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      await rename(temp, this.path);
    } finally { await unlink(temp).catch(() => {}); }
  }

  mutate(action) {
    const result = this.writeQueue.then(async () => {
      const next = structuredClone(this.state);
      const value = action(next);
      await this.persist(next);
      this.state = next;
      return value;
    });
    this.writeQueue = result.catch(() => {});
    return result;
  }

  async createMailbox() {
    return this.mutate(state => {
      if (Object.keys(state.mailboxes).length >= MAX_MAILBOXES) throw Object.assign(new Error('mailbox_capacity'), { status: 507 });
      let mailboxId;
      do mailboxId = randomBytes(16).toString('hex'); while (state.mailboxes[mailboxId]);
      const readCapability = randomBytes(32).toString('base64url');
      const writeCapability = randomBytes(32).toString('base64url');
      state.mailboxes[mailboxId] = {
        readHash: capabilityHash('read', readCapability),
        writeHash: capabilityHash('write', writeCapability),
        deliveries: [],
      };
      return { mailboxId, readCapability, writeCapability };
    });
  }

  authorize(mailboxId, kind, capability, state = this.state) {
    if (!/^[0-9a-f]{32}$/.test(mailboxId) || !['read', 'write'].includes(kind)) return null;
    const mailbox = state.mailboxes[mailboxId];
    if (!mailbox || typeof capability !== 'string' || capability.length !== 43) return null;
    const actual = capabilityHash(kind, capability);
    return equalHash(mailbox[`${kind}Hash`], actual) ? mailbox : null;
  }

  async deliver(mailboxId, capability, input) {
    const delivery = canonicalDelivery(input);
    return this.mutate(state => {
      const mailbox = this.authorize(mailboxId, 'write', capability, state);
      if (!mailbox) throw Object.assign(new Error('unauthorized'), { status: 401 });
      const existing = mailbox.deliveries.find(item => item.idempotencyKey === delivery.idempotencyKey);
      if (existing) {
        const prior = JSON.stringify({ ...existing, receivedAt: undefined });
        const current = JSON.stringify({ ...delivery, receivedAt: undefined });
        if (prior !== current) throw Object.assign(new Error('idempotency_conflict'), { status: 409 });
        return { accepted: true, deduplicated: true };
      }
      if (mailbox.deliveries.some(item => item.keeperIndex === delivery.keeperIndex)) {
        throw Object.assign(new Error('keeper_delivery_conflict'), { status: 409 });
      }
      if (mailbox.deliveries.some(item => item.switchIdHex !== delivery.switchIdHex || item.manifestDigestHex !== delivery.manifestDigestHex)) {
        throw Object.assign(new Error('vault_context_conflict'), { status: 409 });
      }
      mailbox.deliveries.push({ ...delivery, receivedAt: new Date().toISOString() });
      return { accepted: true, deduplicated: false };
    });
  }

  list(mailboxId, capability) {
    const mailbox = this.authorize(mailboxId, 'read', capability);
    if (!mailbox) throw Object.assign(new Error('unauthorized'), { status: 401 });
    return mailbox.deliveries.map(item => ({ ...item }));
  }
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('payload_too_large'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('invalid_json'), { status: 400 }); }
}

function reply(response, status, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': bytes.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(bytes);
}

export function createRelayServer(store, { adminToken } = {}) {
  if (typeof adminToken !== 'string' || adminToken.length < 32) throw new Error('relay admin token must contain at least 32 characters');
  const adminHash = capabilityHash('admin', adminToken);
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 5_000 }, async (request, response) => {
    try {
      const url = new URL(request.url, 'http://relay.invalid');
      if (request.headers.origin || url.search) return reply(response, 400, { error: 'unsupported_request' });
      if (request.method === 'GET' && url.pathname === '/v1/status') {
        return reply(response, 200, { service: 'zcanary-delivery-relay/1', custody: 'opaque-recipient-envelopes' });
      }
      if (request.method === 'POST' && url.pathname === '/v1/mailboxes') {
        if (!equalHash(adminHash, capabilityHash('admin', bearer(request)))) return reply(response, 401, { error: 'unauthorized' });
        await readJson(request);
        return reply(response, 201, await store.createMailbox());
      }
      const match = url.pathname.match(/^\/v1\/mailboxes\/([0-9a-f]{32})\/deliveries$/);
      if (!match) return reply(response, 404, { error: 'not_found' });
      if (request.method === 'POST') {
        if (!store.authorize(match[1], 'write', bearer(request))) return reply(response, 401, { error: 'unauthorized' });
        const result = await store.deliver(match[1], bearer(request), await readJson(request));
        return reply(response, result.deduplicated ? 200 : 201, result);
      }
      if (request.method === 'GET') {
        return reply(response, 200, { deliveries: store.list(match[1], bearer(request)) });
      }
      return reply(response, 405, { error: 'method_not_allowed' });
    } catch (error) {
      return reply(response, error?.status ?? 500, { error: error?.status ? error.message : 'internal_error' });
    }
  });
  server.maxConnections = 32;
  return server;
}

async function main() {
  const statePath = process.env.ZCANARY_RELAY_STATE ?? './state/delivery-relay.json';
  const host = process.env.ZCANARY_RELAY_HOST ?? '127.0.0.1';
  const port = Number(process.env.ZCANARY_RELAY_PORT ?? 8790);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid relay port');
  const store = await new DeliveryStore(statePath).open();
  createRelayServer(store, { adminToken: process.env.ZCANARY_RELAY_ADMIN_TOKEN }).listen(port, host, () => {
    console.error(`delivery relay ready on http://${host}:${port}; envelopes remain recipient-encrypted`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`delivery relay stopped: ${error.message}`); process.exit(1); });
}
