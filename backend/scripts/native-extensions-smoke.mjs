// Read-only/idempotent native acceptance. Never broadcasts or replaces an identity.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
const base = process.env.ZCANARY_NATIVE_BASE_URL || 'http://127.0.0.1:8787';
assert.match(base, /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/);
const token = (await readFile(process.env.ZCANARY_NATIVE_TOKEN_FILE, 'utf8')).trim();
const checks = [];
async function call(path, body) {
  const r = await fetch(base + path, {method: body ? 'POST' : 'GET',
    headers: {Authorization: `Bearer ${token}`, ...(body ? {'Content-Type':'application/json'} : {})},
    ...(body ? {body:JSON.stringify(body)} : {}), signal:AbortSignal.timeout(120_000)});
  return {status:r.status, value:await r.json()};
}
async function ok(path, body) { const r=await call(path,body); assert.equal(r.status,200,`native endpoint ${path} failed`); return r.value; }
function pass(name) { checks.push({name,passed:true}); console.log(`PASS ${name}`); }
const fees=await ok('/v1/fees');
assert.equal(fees.network,'testnet');
for(const key of ['feeZatoshi','noteAmountZatoshi','totalZatoshi','spendableZatoshi']) assert.ok(Number.isSafeInteger(fees[key]) && fees[key]>=0);
assert.equal(fees.noteAmountZatoshi,10000);
assert.equal(fees.totalZatoshi,fees.feeZatoshi+fees.noteAmountZatoshi);
assert.ok(fees.spendableZatoshi>=fees.totalZatoshi);
pass('actual wallet proposal provides a bounded fee estimate without submission');
const {vaults}=await ok('/v1/vaults');
assert.ok(vaults.length>=2);
for(const vault of vaults.filter(v=>v.lifecycle==='RELEASED'||v.lifecycle==='CANCELLED')) {
  const events=await ok(`/v1/vaults/${vault.id}/events`);
  assert.deepEqual(events.events,vault.events);
  const pkg=await ok(`/v1/vaults/${vault.id}/package`);
  assert.equal(pkg.format,'ZCANARY-ENCRYPTED-PACKAGE-V1');
  assert.equal(pkg.packageDigestHex,vault.manifest.packageDigestHex);
  assert.equal(pkg.manifest.manifestDigestHex,vault.manifest.manifestDigestHex);
  assert.equal(Buffer.from(pkg.packageBase64,'base64').length,vault.manifest.packageSize);
  assert.equal(Object.hasOwn(pkg,'fileName'),false);
}
pass('authenticated event history and integrity-checked ciphertext export match the vault');
for(const role of ['source','recipient']) {
  let passphrase=randomBytes(32).toString('base64url');
  const backup=await ok(`/v1/identity/${role}/export`,{passphrase});
  assert.equal(backup.version,1);assert.equal(backup.role,role);
  assert.match(backup.fingerprint,/^[0-9a-f]{64}$/);
  const restored=await ok(`/v1/identity/${role}/import`,{passphrase,expectedFingerprint:backup.fingerprint,backup});
  assert.equal(restored.restored,true);assert.equal(restored.alreadyPresent,true);
  const bad=await call(`/v1/identity/${role}/import`,{passphrase:randomBytes(32).toString('base64url'),expectedFingerprint:backup.fingerprint,backup});
  assert.equal(bad.status,409);
  pass(`${role} encrypted identity export and same-key restore succeed; wrong passphrase is rejected`);
  passphrase='';
}
const support=await ok('/v1/support-request');
assert.equal(support.network,'testnet');assert.match(support.address,/^utest1/);
assert.equal(support.memo,null);assert.equal(support.uri,`zcash:${support.address}?amount=0.00100000`);
for(const vault of vaults) assert.equal(support.uri.includes(vault.id),false);
pass('separate shielded support request contains no evidence identifier or memo');
if(process.env.ZCANARY_NATIVE_EXTENSION_EVIDENCE) await writeFile(process.env.ZCANARY_NATIVE_EXTENSION_EVIDENCE,JSON.stringify({version:1,mode:'testnet',verifiedAt:new Date().toISOString(),checks,feeEstimate:fees},null,2));
console.log(`COMPLETE ${checks.length} native extension checks; no commands submitted.`);
