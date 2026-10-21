import {readFile, realpath, stat} from 'node:fs/promises';
import {resolve, sep, extname} from 'node:path';
import type {Hono} from 'hono';
import type {OrgOpsClient} from '@nest/orgops-client';

// Published files stay outside UI static roots. Every read revalidates the human session.
export function registerDemoRoutes(app: Hono, {orgops, root}: {orgops: OrgOpsClient; root: string}) {
  app.all('/demo', c => c.redirect('/demo/', 302));
  app.all('/demo/*', async c => {
    c.header('Cache-Control', 'private, no-store');
    c.header('Vary', 'Cookie');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Robots-Tag', 'noindex, nofollow');
    const human = await orgops.currentHuman(c.req.raw.headers);
    if (!human) return c.html('<!doctype html><title>Sign in required</title><p><a href="/">Sign in to Nest</a> to view this demo, then reopen its link.</p>', 401);
    if (!['GET', 'HEAD'].includes(c.req.method)) return c.text('Method not allowed', 405, {Allow: 'GET, HEAD'});
    let path: string;
    try { path = decodeURIComponent(c.req.path.slice('/demo/'.length)); }
    catch { return c.text('Not found', 404); }
    const parts = path.replace(/\/$/, '').split('/');
    if (parts.some(part => !part || part.startsWith('.') || part.includes('\\') || part.includes('\0'))) return c.text('Not found', 404);
    if (parts.length === 1 && /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.html)?$/.test(parts[0])) {
      path = parts[0].replace(/\.html$/, '') + '/index.html';
    }
    try {
      const base = await realpath(root);
      const file = await realpath(resolve(base, path));
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
