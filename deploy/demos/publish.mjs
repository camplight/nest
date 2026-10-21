#!/usr/bin/env node
import {readFile, mkdir, lstat, realpath, writeFile, copyFile, rename, unlink, symlink, readlink} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
const hash = b => createHash('sha256').update(b).digest('hex');
async function main() {
  const [source, slug, ...flags] = process.argv.slice(2);
  if (!source || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug || '') || slug.length > 64 || flags.some(f => f !== '--replace')) throw Error('Usage: node publish.mjs /path/index.html slug [--replace]');
  const root = resolve(process.env.NEST_DEMO_ROOT || '/app/.nest-data/demos');
  const origin = new URL(process.env.NEST_DEMO_ORIGIN || 'https://nest.camplight.net');
  if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw Error('Origin must be an HTTP(S) origin without credentials or a path.');
  const html = await readFile(resolve(source));
  if (!/<!doctype html/i.test(html.toString()) || !/<html[\s>]/i.test(html.toString())) throw Error('Source must be a complete HTML document.');
  if ((await realpath(root)) !== root || !(await lstat(root)).isDirectory()) throw Error('Publication root must be a real directory, not a symlink.');
  const dir = join(root, slug);
  await mkdir(dir, {recursive: true});
  if ((await realpath(dir)) !== dir) throw Error('Refusing a symlinked demo directory.');
  const dest = join(dir, 'index.html');
  // Vite resolves extensionless URLs through a .html fallback; directory indexes require a trailing slash.
  const alias = join(root, slug + '.html');
  try {
    const stat = await lstat(alias);
    if (!stat.isSymbolicLink() || await readlink(alias) !== slug + '/index.html') throw Error('Conflicting extensionless route alias.');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    await symlink(slug + '/index.html', alias);
  }
  const lock = join(dir, '.publish.lock');
  await writeFile(lock, '', {flag: 'wx', mode: 0o600});
  let temp;
  try {
    let existing;
    try { existing = await lstat(dest); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (existing) {
      if (!existing.isFile() || existing.isSymbolicLink()) throw Error('Destination must be a regular file.');
      if (!flags.includes('--replace')) throw Error('Page exists; use --replace for an authorized update.');
      const history = join(root + '-history', slug);
      await mkdir(history, {recursive: true});
      await copyFile(dest, join(history, Date.now() + '-' + randomUUID() + '.html'));
    }
    temp = join(dir, '.' + randomUUID() + '.tmp');
    await writeFile(temp, html, {flag: 'wx', mode: 0o644});
    await rename(temp, dest);
    temp = undefined;
    const url = new URL('/demo/' + slug, origin);
    const check = new URL(url); check.searchParams.set('verify', randomUUID());
    let response;
    try {
      response = await fetch(check, {signal: AbortSignal.timeout(15000), redirect: 'manual', headers: {'Cache-Control': 'no-cache'}});
      if (response.status === 401 && response.headers.get('cache-control')?.includes('no-store')) {
        if (hash(await readFile(dest)) !== hash(html)) throw Error('Installed file changed during verification');
        console.log(`Installed and anonymous access denied: ${url} (authenticated browser verification still required)`);
        return;
      }
      if (!response.ok || !response.headers.get('content-type')?.includes('text/html') || hash(Buffer.from(await response.arrayBuffer())) !== hash(html)) throw Error('HTTP response does not match the published HTML');
    } catch (e) { throw Error(`File installed at ${dest}, but public verification failed: ${e.message}`); }
    console.log(`Verified live: ${url}`);
  } finally {
    if (temp) await unlink(temp).catch(() => {});
    await unlink(lock);
  }
}
main().catch(e => {console.error(e.message); process.exitCode = 1;});
