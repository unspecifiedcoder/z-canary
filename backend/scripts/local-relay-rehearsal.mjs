// Run the same relay rehearsal with local executables when Docker is unavailable.
import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { DeliveryStore, createRelayServer } from './delivery-relay.mjs';

const [keeperArg, demoArg] = process.argv.slice(2);
if (!keeperArg || !demoArg) throw new Error('Usage: node backend/scripts/local-relay-rehearsal.mjs KEEPER_EXE DEMO_EXE');
const output = await mkdtemp(join(tmpdir(), 'zcanary-network-rehearsal-'));
const passphrase = randomBytes(40).toString('base64url');
const adminToken = randomBytes(32).toString('base64url');
const children = [];
const store = await new DeliveryStore(join(output, 'relay.json')).open();
const relay = createRelayServer(store, { adminToken });
await new Promise(resolveReady => relay.listen(0, '127.0.0.1', resolveReady));

function sparePort() {
  return new Promise((resolvePort, reject) => {
    const listener = createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const port = listener.address().port;
      listener.close(() => resolvePort(port));
    });
  });
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolveExit => { child.once('exit', resolveExit); child.kill(); });
}

try {
  const urls = [];
  for (let index = 1; index <= 5; index++) {
    const id = `keeper-${String(index).padStart(2, '0')}`;
    const port = await sparePort();
    urls.push(`http://127.0.0.1:${port}`);
    const child = spawn(resolve(keeperArg), [
      '--db', join(output, `${id}.sqlite`), '--keeper-id', id,
      '--network', '1', '--listen', `127.0.0.1:${port}`, '--mode', 'synthetic-chain',
    ], {
      windowsHide: true,
      env: {
        ...process.env,
        ZCANARY_IDENTITY_PASSPHRASE: passphrase,
        ZCANARY_KEEPER_TOKEN: `zcanary-compose-token-${String(index).padStart(2, '0')}-not-for-production`,
      },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    await new Promise((resolveSpawn, reject) => { child.once('spawn', resolveSpawn); child.once('error', reject); });
    children.push(child);
  }
  const controller = spawn(process.execPath, [fileURLToPath(new URL('./docker-rehearsal.mjs', import.meta.url))], {
    windowsHide: true,
    env: {
      ...process.env,
      ZCANARY_DEMO_PASSPHRASE: passphrase,
      ZCANARY_DEMO_EXE: resolve(demoArg),
      ZCANARY_REHEARSAL_OUTPUT: join(output, 'artifacts'),
      ZCANARY_KEEPER_URLS: urls.join(','),
      ZCANARY_RELAY_URL: `http://127.0.0.1:${relay.address().port}`,
      ZCANARY_RELAY_ADMIN_TOKEN: adminToken,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  children.push(controller);
  process.exitCode = await new Promise((resolveExit, reject) => { controller.once('error', reject); controller.once('exit', resolveExit); });
  console.log(`Local rehearsal artifacts: ${output}`);
} finally {
  for (const child of children) await stop(child);
  relay.closeAllConnections();
  await new Promise(resolveClose => relay.close(resolveClose));
}
