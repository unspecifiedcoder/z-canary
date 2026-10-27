// Public test identity: transport evidence only, never a protected real dossier.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { encodeShieldedMemo, deriveSourcePublicKey } from '../../src/crypto/memoCodec';
import { buildDeterministicManifest, verifyManifest } from '../../src/engine/protocolStore';

const [heightArg, outputArg] = process.argv.slice(2);
const height=Number(heightArg);
if (!Number.isInteger(height) || height<1 || height>0xffffffff-240 || !outputArg) throw new Error('Usage: node --import tsx backend/scripts/make-transport-commands.ts CURRENT_TESTNET_HEIGHT NEW_OUTPUT_DIR');
const directory=resolve(outputArg); await mkdir(directory,{recursive:false});
const fixture=JSON.parse(await readFile(new URL('../fixtures/typescript-v1.json',import.meta.url),'utf8'));
// RFC 8032 vector, deliberately public and never a wallet spending key.
const seed='9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const manifest=buildDeterministicManifest({...fixture.manifest,switchIdHex:randomBytes(32).toString('hex'),initialIntervalBlocks:120,maxExtensionBlocks:1000},seed);
if(!verifyManifest(manifest)) throw new Error('Generated manifest did not verify');
await writeFile(join(directory,'manifest.json'),JSON.stringify(manifest,null,2));
for(const [name,operation,sequence,expiry] of [['register',1,0n,height+120],['postpone',2,1n,height+240],['cancel',3,2n,0]] as const) {
  const bytes=encodeShieldedMemo({version:1,network:1,operation,sequence,requestedExpiryHeight:expiry,switchIdHex:manifest.switchIdHex,manifestDigestHex:manifest.manifestDigestHex,sourcePubKeyHex:deriveSourcePublicKey(seed)},seed);
  await writeFile(join(directory,`${name}.hex`),Buffer.from(bytes).toString('hex')+'\n');
}
await writeFile(join(directory,'README.txt'),'These signed commands use a public RFC test identity and fixture commitments. They demonstrate real shielded memo transport and independent viewing-only recovery only. No keeper was provisioned for this manifest and no dossier is protected by it.\n');
console.log(JSON.stringify({mode:'testnet-transport-fixture',switchIdHex:manifest.switchIdHex,commands:3}));
