import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const backend=join(root,'backend'), suffix=process.platform==='win32'?'.exe':'';
const installed=join(homedir(),'.cargo','bin',`cargo${suffix}`);
const cargo=existsSync(installed)?installed:'cargo';
const run=(program,args,cwd=root)=>new Promise((res,rej)=>{const p=spawn(program,args,{cwd,stdio:'inherit',windowsHide:true});p.once('error',rej);p.once('exit',code=>code===0?res():rej(new Error(`${program} exited with ${code}`)));});
console.log('Z-Canary: five real local keeper processes, synthetic block progression. No blockchain transactions.');
await run(cargo,['+1.99.0','build','--locked','--manifest-path',join(backend,'Cargo.toml'),'-p','zcanary-demo','-p','zcanary-keeper-service','-j1']);
const target=process.env.CARGO_TARGET_DIR?resolve(root,process.env.CARGO_TARGET_DIR):join(backend,'target');
const parent=join(backend,'state'); await mkdir(parent,{recursive:true});
const output=join(parent,`rehearsal-${new Date().toISOString().replaceAll(':','-')}`);
await run(process.execPath,[join(backend,'scripts','demo-five-keepers.mjs'),join(target,'debug',`zcanary-keeper-service${suffix}`),join(target,'debug',`zcanary-demo${suffix}`),output]);
console.log(`Public evidence and encrypted synthetic artifacts: ${output}`);
