/** Read-only checks for the static site served from docs on Pages or Vercel. */
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const errors = [];
let checked = 0;
const external = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
const label = path => relative(root, path).split(sep).join('/');
const htmlIds = text => [...text.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)].map(match => match[1]);
const fail = message => errors.push(message);

async function checkReference(from, raw, { fragment = false } = {}) {
  if (!raw || external.test(raw)) return;
  if (raw.startsWith('/')) {
    fail(`${label(from)}: root-relative URL breaks project Pages: ${raw}`);
    return;
  }
  const [pathAndQuery, hash] = raw.split('#');
  const pathname = pathAndQuery.split('?')[0];
  let target;
  try { target = pathname ? resolve(dirname(from), decodeURIComponent(pathname)) : from; }
  catch { fail(`${label(from)}: malformed URL ${raw}`); return; }
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`)) {
    fail(`${label(from)}: URL leaves public directory: ${raw}`);
    return;
  }
  try {
    if ((await stat(target)).isDirectory()) target = resolve(target, 'index.html');
    if (!(await stat(target)).isFile()) throw new Error('not a file');
    checked++;
    // These hashes are application routes, not server-rendered element IDs.
    const isAppRoute = label(target) === 'app/index.html' && ['maya-noor', 'create', 'break-vault', 'judge', 'native', 'evidence', 'recipient'].includes(hash);
    if (fragment && hash && !isAppRoute && extname(target) === '.html') {
      const ids = htmlIds(await readFile(target, 'utf8'));
      if (!ids.includes(decodeURIComponent(hash))) fail(`${label(from)}: missing anchor ${raw}`);
    }
  } catch { fail(`${label(from)}: missing local target ${raw}`); }
}

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) { await walk(path); continue; }
    if (!['.html', '.css', '.js'].includes(extname(path))) continue;
    const text = await readFile(path, 'utf8');
    if (extname(path) === '.html') {
      const ids = htmlIds(text);
      for (const id of new Set(ids)) if (ids.filter(value => value === id).length > 1) fail(`${label(path)}: duplicate id ${id}`);
      for (const match of text.matchAll(/\b(src|href|poster)\s*=\s*["']([^"']+)["']/g)) {
        await checkReference(path, match[2], { fragment: match[1] === 'href' });
      }
      // The video chapter script must still target real elements after redesign.
      for (const match of text.matchAll(/getElementById\(\s*["']([^"']+)["']\s*\)/g)) {
        if (!ids.includes(match[1])) fail(`${label(path)}: script references missing id ${match[1]}`);
      }
    }
    if (extname(path) === '.css' || extname(path) === '.html') {
      for (const match of text.matchAll(/url\(\s*["']?([^\s)'"}]+)["']?\s*\)/g)) await checkReference(path, match[1]);
    }
    if (extname(path) === '.js') {
      // Vite emits relative imports for both entry dependencies and lazy chunks.
      for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["'](\.\.?\/[^"']+)["']/g)) await checkReference(path, match[1]);
    }
  }
}

for (const required of ['index.html', 'app/index.html', 'assets/canary-vault.webp', 'app/assets/canary-vault.webp', 'assets/canary-demo.vtt']) {
  try { await stat(resolve(root, required)); }
  catch { fail(`Required public output missing: ${required}`); }
}
try {
  const app = await readFile(resolve(root, 'app/index.html'), 'utf8');
  if (!/type=["']module["']/.test(app) || !/id=["']root["']/.test(app)) fail('app/index.html is not the built React entry.');
  const assetNames = await readdir(resolve(root, 'app/assets'));
  const appJavaScript = (await Promise.all(assetNames.filter(name => name.endsWith('.js')).map(name => readFile(resolve(root, 'app/assets', name), 'utf8')))).join('\n');
  for (const requiredCopy of ['Your file. Your trusted recipient.', 'Replay the real testnet run', 'Start my walkthrough', 'Prepare External Wallet Request', 'Try the 60-second challenge']) {
    if (!appJavaScript.includes(requiredCopy)) fail(`Built application is missing release copy: ${requiredCopy}`);
  }
  for (const staleCopy of ['LIVE ACCEPTANCE PENDING', 'LIVE SEND/SCAN GATE PENDING', 'Broadcast Registration']) {
    if (appJavaScript.includes(staleCopy)) fail(`Built application still contains stale release copy: ${staleCopy}`);
  }
  const landing = await readFile(resolve(root, 'index.html'), 'utf8');
  const chapterScript = await readFile(resolve(root, 'assets/landing.js'), 'utf8');
  const landingIds = htmlIds(landing);
  for (const match of chapterScript.matchAll(/getElementById\(\s*["']([^"']+)["']\s*\)/g)) {
    if (!landingIds.includes(match[1])) fail(`landing.js: missing landing element ${match[1]}`);
  }
  if (!/href=["'](?:\.\/)?app\/(?:#(?:maya-noor|create))?["']/.test(landing)) fail('Landing has no local app entry link.');
  await walk(root);
} catch (error) { fail(error.message); }
if (errors.length) {
  console.error(`Public-site verification failed (${errors.length} issues):\n${errors.map(error => `- ${error}`).join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`Public-site verification passed: ${checked} local references, application entry, artwork, captions, and script element IDs.`);
}
