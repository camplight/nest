import {posix} from 'node:path';
import {request} from 'node:http';
import type {Plugin, Connect} from 'vite';

// Runs before Vite's static middleware, including on preview. This also covers
// legacy demo symlinks restored by an older host controller.
export function demoProxy(): Plugin {
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    let path: string;
    try { path = posix.normalize(decodeURIComponent((req.url ?? '/').split('?')[0]).replaceAll('\\', '/')); }
    catch { res.statusCode = 400; res.end(); return; }
    if (path !== '/demo' && !path.startsWith('/demo/')) return next();
    const port = process.env.NEST_INTERNAL_API_PORT ?? '8787';
    const upstream = request({hostname: '127.0.0.1', port, path: req.url, method: req.method,
      headers: {cookie: req.headers.cookie ?? ''}}, response => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502, {'Cache-Control':'no-store'}); res.end(); });
    upstream.setTimeout(30000, () => upstream.destroy());
    req.pipe(upstream);
  };
  return {name: 'nest-authenticated-demos',
    configureServer(server) { server.middlewares.use(middleware); },
    configurePreviewServer(server) { server.middlewares.use(middleware); },
  };
}
