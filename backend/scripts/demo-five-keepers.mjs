// Real isolated keeper processes and encryption; explicitly synthetic block feed.
import assert from 'node:assert/strict';
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';

const [keeperArg, demoArg, outputArg] = process.argv.slice(2);
if (!keeperArg || !demoArg || !outputArg) throw new Error('Usage: node demo-five-keepers.mjs KEEPER_EXE DEMO_EXE NEW_OUTPUT_DIR');
const keeperExe = resolve(keeperArg), demoExe = resolve(demoArg), output = resolve(outputArg);
await mkdir(output, { recursive: false });
const passphrase = randomBytes(40).toString('base64url');
const agents = [], checks = [], logs = [];
let artifacts;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hash = b => createHash('sha256').update(b).digest();
const hex32 = s => { const b = Buffer.from(s, 'hex'); assert.equal(b.length,32); return b; };
const evidence = text => { checks.push(text); console.log(`PASS ${text}`); };

async function unusedPort() { return new Promise((res,rej) => { const s=net.createServer(); s.once('error',rej); s.listen(0,'127.0.0.1',()=>{ const p=s.address().port; s.close(()=>res(p)); }); }); }
async function request(agent,path,body,token=agent.token) {
  const response = await fetch(`http://127.0.0.1:${agent.port}${path}`,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  const result=await response.json();
  if(!response.ok) throw Object.assign(new Error(`HTTP ${response.status} ${path}: ${JSON.stringify(result)}`),{status:response.status});
  return result;
}
async function start(agent) {
  agent.child = spawn(keeperExe,['--db',join(output,`${agent.id}.sqlite`),'--keeper-id',agent.id,'--network','1','--listen',`127.0.0.1:${agent.port}`,'--mode','synthetic-chain'],{windowsHide:true,env:{...process.env,ZCANARY_KEEPER_TOKEN:agent.token,ZCANARY_IDENTITY_PASSPHRASE:passphrase},stdio:['ignore','pipe','pipe']});
  agent.child.on('error',e=>logs.push(`${agent.id}: spawn ${e.message}`));
  for(const stream of [agent.child.stdout,agent.child.stderr]) stream.on('data',b=>logs.push(`${agent.id}: ${b}`));
  for(let n=0;n<240;n++) { if(agent.child.exitCode!==null) throw new Error(`${agent.id} exited: ${logs.slice(-3).join('')}`); try {const s=await request(agent,'/v1/status'); if(agent.status) {assert.equal(s.recipient,agent.status.recipient); assert.equal(s.signing_pubkey_hex,agent.status.signing_pubkey_hex);} agent.status=s; return;}catch{} await sleep(250); }
  throw new Error(`${agent.id} startup timeout`);
}
async function stop(agent) {
  const child=agent.child; if(!child || child.exitCode!==null || child.signalCode!==null) return;
  await new Promise(resolve=>{child.once('exit',resolve);child.kill();});
}
async function utility(args, expectedSuccess=true) {
  const child=spawn(demoExe,args,{windowsHide:true,env:{...process.env,ZCANARY_DEMO_PASSPHRASE:passphrase},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr=''; child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);
  const code=await new Promise((res,rej)=>{child.once('error',rej);child.once('exit',res);});
  if(expectedSuccess) assert.equal(code,0,stderr); else assert.notEqual(code,0,'invalid threshold unexpectedly decrypted');
  return {code,stdout,stderr};
}
function checkAck(ack, agent, provision) {
  assert.equal(ack.keeper_id,agent.id); assert.equal(ack.keeper_index,provision.keeper_index);
  assert.equal(ack.signing_pubkey_hex,agent.status.signing_pubkey_hex);
  assert.equal(ack.switch_id_hex,provision.manifest.switchIdHex);
  assert.equal(ack.epoch,provision.manifest.configurationEpoch);
  assert.equal(ack.manifest_digest_hex,provision.manifest.manifestDigestHex);
  const e=provision.envelope;
  const envelopeBytes=Buffer.from(JSON.stringify({version:e.version,keeper_id_hex:e.keeper_id_hex,index:e.index,ciphertext_hex:e.ciphertext_hex}));
  assert.equal(ack.envelope_digest_hex,hash(envelopeBytes).toString('hex'));
  const epoch=Buffer.alloc(4);epoch.writeUInt32LE(ack.epoch);
  const signed=Buffer.concat([Buffer.from('z-canary/keeper-provision-ack/v1\0'),Buffer.from(ack.keeper_id),Buffer.from([ack.keeper_index]),hex32(ack.switch_id_hex),epoch,hex32(ack.manifest_digest_hex),hex32(ack.envelope_digest_hex)]);
  const pub=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),hex32(ack.signing_pubkey_hex)]),format:'der',type:'spki'});
  assert.ok(verify(null,signed,pub,Buffer.from(ack.signature_hex,'hex')),'signed durable acknowledgement');
}
function blockHash(height) { return hash(Buffer.from(`Z-CANARY SYNTHETIC CHAIN BLOCK ${height}`)).toString('hex'); }
async function batch(start,end,memos={},targets=agents) {
  const blocks=Array.from({length:end-start+1},(_,i)=>{ const height=start+i; return {height,hash_hex:blockHash(height),previous_hash_hex:height?blockHash(height-1):'00'.repeat(32),transactions:(memos[height]||[]).map((memo,tx_index)=>({txid_hex:hash(Buffer.from(`SYNTHETIC TX ${height} ${tx_index} ${memo}`)).toString('hex'),tx_index,outputs:[{tx_index,output_index:0,memo_hex:memo}]}))}; });
  for(const a of targets) await request(a,'/v1/confirmed-batch',{adapter:'synthetic-chain',network:1,complete:true,confirmed_through:end,observed_tip_height:end+1,blocks});
}
async function lifecycle(vault,expected,targets=agents) { for(const a of targets) assert.equal((await request(a,`/v1/vaults/${vault.switch_id_hex}`)).lifecycle,expected); }
async function noDelivery(targets=agents) { for(const a of targets) assert.equal((await request(a,'/v1/next-delivery')).delivery,null); }

try {
  for(let i=0;i<5;i++) { const a={id:`keeper-${String(i+1).padStart(2,'0')}`,port:await unusedPort(),token:randomBytes(32).toString('base64url')}; agents.push(a); await start(a); }
  assert.equal(new Set(agents.map(a=>a.child.pid)).size,5); assert.equal(new Set(agents.map(a=>a.status.recipient)).size,5);
  evidence('five separate processes, keys, ports and SQLite databases');
  await assert.rejects(request(agents[0],'/v1/status',undefined,'incorrect'),e=>e.status===401);
  evidence('keeper endpoints reject incorrect authentication');
  await writeFile(join(output,'keeper-public-status.json'),JSON.stringify(agents.map(a=>a.status),null,2));
  artifacts=join(output,'vaults');
  await utility(['prepare',join(output,'keeper-public-status.json'),artifacts]);
  const {vaults}=JSON.parse(await readFile(join(artifacts,'public.json'),'utf8'));
  const [cancel,release]=vaults;
  evidence('source and recipient encrypted identities exported and restored');
  const acknowledgements=[];
  for(const vault of vaults) for(let i=0;i<5;i++) { const p=vault.provisions[i]; const ack=await request(agents[i],'/v1/provision',p); checkAck(ack,agents[i],p); acknowledgements.push(ack); }
  checkAck(await request(agents[0],'/v1/provision',release.provisions[0]),agents[0],release.provisions[0]);
  evidence('lost provisioning acknowledgements can be retried without changing the stored share');
  await writeFile(join(output,'signed-provisioning-acks.json'),JSON.stringify(acknowledgements,null,2));
  evidence('all five durable signed provisioning acknowledgements verified before registration');
  await batch(0,0); await lifecycle(cancel,'DRAFT'); await noDelivery();
  await batch(1,11,{1:vaults.map(v=>v.register_memo_hex)}); await lifecycle(release,'GRACE'); await noDelivery();
  await batch(12,13,{12:[release.postpone_memo_hex]}); await lifecycle(release,'ACTIVE'); await noDelivery();
  evidence('postponement during grace prevents release at the old deadline');
  await batch(14,14,{14:[cancel.cancel_memo_hex]}); await lifecycle(cancel,'CANCELLED'); await noDelivery();
  evidence('cancellation in the inclusive last grace block prevents all five releases');
  for(const a of agents) await stop(a);
  for(const a of agents) {await start(a); assert.equal(a.status.healthy,false); await assert.rejects(request(a,'/v1/next-delivery'));}
  evidence('all five processes restart with the same keys and suspend dispatch until fresh scan');
  await batch(15,23); await lifecycle(cancel,'CANCELLED'); await lifecycle(release,'GRACE'); await noDelivery();
  await assert.rejects(request(agents[0],'/v1/confirmed-batch',{adapter:'synthetic-chain',network:1,complete:false,blocks:[]}));
  assert.equal((await request(agents[0],'/v1/status')).healthy,false);
  await assert.rejects(request(agents[0],'/v1/next-delivery'));
  evidence('an incomplete scan suspends release dispatch');
  for(const a of agents.slice(3)) await stop(a);
  await batch(24,24,{},agents.slice(0,3)); await lifecycle(release,'RELEASED',agents.slice(0,3));
  const deliveries=[];
  for(const a of agents.slice(0,3)) {const {delivery}=await request(a,'/v1/next-delivery'); assert.ok(delivery); assert.equal(delivery.switch_id_hex,release.switch_id_hex); deliveries.push(delivery);}
  const deliveryPath=join(output,'recipient-deliveries.json');
  await writeFile(deliveryPath,JSON.stringify(deliveries.slice(0,2).map(d=>d.payload_hex)));
  const insufficient=await utility(['decrypt',artifacts,deliveryPath],false); assert.match(insufficient.stderr,/at least three/);
  evidence('two delivered shares cannot decrypt');
  await writeFile(deliveryPath,JSON.stringify(deliveries.map(d=>d.payload_hex)));
  const decrypted=await utility(['decrypt',artifacts,deliveryPath]);
  evidence('three valid shares decrypt the exact synthetic PDF with two keepers offline');
  for(let i=0;i<3;i++) await request(agents[i],'/v1/ack-delivery',{delivery_id:deliveries[i].delivery_id,delivered:true,cursor:deliveries[i].cursor});
  await noDelivery(agents.slice(0,3));
  evidence('acknowledged deliveries are not offered again');
  const summary={mode:'synthetic-chain',live_transactions:false,completed:true,checks,decryption:JSON.parse(decrypted.stdout),limitations:['Locally operated keepers; not independent organizations.','Synthetic authenticated block feed, not a testnet scanner.','Demo passphrases exist only in runner memory; encrypted test artifacts cannot be reopened after runner exits.']};
  await writeFile(join(output,'evidence.json'),JSON.stringify(summary,null,2));
  console.log(JSON.stringify(summary,null,2));
} finally {
  for(const a of agents) await stop(a);
  // Logs contain only service readiness and sanitized errors; tokens are never logged.
  await writeFile(join(output,'process.log'),logs.join(''));
}
