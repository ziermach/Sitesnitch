#!/usr/bin/env node
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

/**
 * Serves the reports root so the viewer can fetch index.json and each run's report.json.
 *
 * The viewer reads its data at runtime rather than having it baked in, and a page opened as
 * file:// is not allowed to fetch a sibling file. (It does offer drag-and-drop for that
 * case; this is the ergonomic path.)
 *
 * Binds to 127.0.0.1 explicitly. The default would be 0.0.0.0, which would publish a crawl
 * report — a list of the site's known-broken URLs — to everything on the local network.
 */
const root = resolve(process.argv[2] ?? 'reports');
const port = Number(process.argv[3] ?? 8787);

if (!existsSync(join(root, 'index.html'))) {
  console.error(`No viewer in ${root}. Run a crawl first, or pass a directory:`);
  console.error('  npx sitesnitch-report reports');
  process.exit(1);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  // Anything a report links to — screenshots, inlined marks — must come back with a real
  // content type, or it falls back to octet-stream and renders as broken.
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

const server = createServer((req, res) => {
  const requested = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const rel = requested === '/' ? 'index.html' : normalize(requested).replace(/^[/\\]+/, '');
  const path = join(root, rel);

  // Never serve outside the reports root, whatever the URL claims (../../etc/passwd).
  if (!path.startsWith(root + sep) && path !== root) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (!existsSync(path) || !statSync(path).isFile()) {
    res.writeHead(404).end('Not found');
    return;
  }

  res.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream' });
  createReadStream(path).pipe(res);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`\n  Reports:  http://127.0.0.1:${port}/\n  Serving:  ${root}\n\n  Ctrl-C to stop.\n`);
});
