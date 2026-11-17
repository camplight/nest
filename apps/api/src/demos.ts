import {readFile, realpath, stat, readdir, lstat} from 'node:fs/promises';
import {resolve, sep, extname} from 'node:path';
import type {Hono} from 'hono';
import type {OrgOpsClient} from '@nest/orgops-client';

// Published files stay outside UI static roots. Every read revalidates the human session.
export function registerDemoRoutes(app: Hono, {orgops, root, restrictedRoot = resolve(root, '../restricted-demos')}: {orgops: OrgOpsClient; root: string; restrictedRoot?: string}) {
  // Restricted namespaces are stored separately: older releases cannot serve them.
  async function separateRoots() {
    const canonical = async (path: string) => {
      try { return await realpath(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolve(path); throw error; }
    };
    const [ordinary, privateRoot] = await Promise.all([canonical(root), canonical(restrictedRoot)]);
    if (ordinary === privateRoot || ordinary.startsWith(privateRoot + sep) || privateRoot.startsWith(ordinary + sep)) {
      throw new Error('Restricted demo root must be separate from ordinary demos');
    }
  }
  const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  async function restrictedNamespace(name: string) {
    try { await lstat(resolve(restrictedRoot, name)); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  async function permitted(namespace: string, humanId: string) {
    try {
      const base = await realpath(restrictedRoot);
      const directory = resolve(base, namespace);
      const policy = resolve(directory, '.access.json');
      // No symlink namespaces, policies or assets, including internal aliases.
      if (await realpath(directory) !== directory || await realpath(policy) !== policy) return false;
      const info = await stat(policy);
      if (!info.isFile() || info.size > 65536) return false;
      const value = JSON.parse(await readFile(policy, 'utf8'));
      return value?.version === 1 && Array.isArray(value.allowedHumanIds)
        && value.allowedHumanIds.length > 0 && value.allowedHumanIds.length <= 1000
        && value.allowedHumanIds.every((id: unknown) => typeof id === 'string' && id.length > 0 && id.length <= 256 && !/\s/.test(id))
        && value.allowedHumanIds.includes(humanId);
    } catch { return false; } // Missing, malformed or unreadable policies deny access.
  }
  app.get('/api/artifacts',async c=>{
    c.header('Cache-Control','private, no-store');
    const human=await orgops.currentHuman(c.req.raw.headers);
    if(!human)return c.json({error:'Sign in required'},401);
    if(human.mustChangePassword)return c.json({error:'Complete password setup first'},403);
    await separateRoots();
    let base:string;
    try{base=await realpath(root);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return c.json({items:[]});throw e;}
    const items=[];
    for(const entry of await readdir(base,{withFileTypes:true})){
      if(!entry.isDirectory()||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name)||entry.name.length>64)continue;
      try{
        if(await restrictedNamespace(entry.name))continue;
        const file=resolve(base,entry.name,'index.html');
        if((await realpath(file))!==file)continue;
        const info=await lstat(file);if(!info.isFile())continue;
        items.push({name:entry.name.replaceAll('-',' '),url:'/demo/'+entry.name,updatedAt:info.mtimeMs,size:info.size});
      }catch(e){if(!['ENOENT','ENOTDIR'].includes((e as NodeJS.ErrnoException).code??''))throw e;}
    }
    return c.json({items:items.sort((a,b)=>b.updatedAt-a.updatedAt||a.url.localeCompare(b.url))});
  });
  app.all('/demo', c => c.redirect('/demo/', 302));
  app.all('/demo/*', async c => {
    c.header('Cache-Control', 'private, no-store');
    c.header('Vary', 'Cookie, Accept');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Robots-Tag', 'noindex, nofollow');
    const human = await orgops.currentHuman(c.req.raw.headers);
    if (!human && /(?:^|,)\s*text\/html(?:\s*;|\s*,|$)/i.test(c.req.header('Accept') ?? '')) {
      const url = new URL(c.req.url);
      return c.redirect('/?returnTo=' + encodeURIComponent(url.pathname + url.search), 302);
    }
    if (!human) return c.html('<!doctype html><title>Sign in required</title><p><a href="/">Sign in to Nest</a> to view this demo, then reopen its link.</p>', 401);
    if (human.mustChangePassword) return c.text('Complete password setup first', 403);
    if (!['GET', 'HEAD'].includes(c.req.method)) return c.text('Method not allowed', 405, {Allow: 'GET, HEAD'});
    await separateRoots();
    let path: string;
    try { path = decodeURIComponent(c.req.path.slice('/demo/'.length)); }
    catch { return c.text('Not found', 404); }
    const parts = path.replace(/\/$/, '').split('/');
    if (parts.some(part => !part || part.startsWith('.') || part.includes('\\') || part.includes('\0'))) return c.text('Not found', 404);
    const namespace = parts[0].replace(/\.html$/, '');
    const restricted = slug.test(namespace) && await restrictedNamespace(namespace);
    if (restricted && !await permitted(namespace, human.id)) return c.text('Not found', 404);
    if (restricted && parts.length === 2 && slug.test(parts[1].replace(/\.html$/, ''))) {
      path = namespace + '/' + parts[1].replace(/\.html$/, '') + '/index.html';
    }
    if (parts.length === 1 && /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.html)?$/.test(parts[0])) {
      path = parts[0].replace(/\.html$/, '') + '/index.html';
    }
    try {
      const base = await realpath(restricted ? restrictedRoot : root);
      const file = await realpath(resolve(base, path));
      if (restricted && file !== resolve(base, path)) return c.text('Not found', 404);
      if (!file.startsWith(base + sep)) return c.text('Not found', 404);
      const info = await stat(file, {bigint:true});
      if (!info.isFile()) return c.text('Not found', 404);
      const types: Record<string, string> = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.woff2':'font/woff2','.ico':'image/x-icon'};
      c.header('ETag', `W/"${info.ino}-${info.size}-${info.mtimeNs}-${info.ctimeNs}"`);
      c.header('Content-Type', types[extname(file)] ?? 'application/octet-stream');
      return c.body(c.req.method === 'HEAD' ? null : new Uint8Array(await readFile(file)));
    } catch (error) {
      if (['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return c.text('Not found', 404);
      throw error;
    }
  });
}
