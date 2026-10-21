// Test server of spec 034, section 5: serves apps/site/dist the way CloudFront plus the viewer-request
// function of #81 will, with every header of apps/site/headers.json on every response.
//
//   GET and HEAD only (anything else: 405)
//   a path ending in "/"                  -> <path>index.html
//   a last segment without a "."          -> <path>/index.html
//   not found, or outside the root        -> 404.html with status 404 (plain text when 404.html is missing)
//
// It starts even when dist/ does not exist yet: files are read per request.
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ROOT = resolve(REPO_ROOT, 'apps', 'site', 'dist');
const HEADERS_FILE = resolve(REPO_ROOT, 'apps', 'site', 'headers.json');
const PORT = Number(process.env['PORT'] ?? 4322);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
};
// Pagefind files (.pf_meta, .pf_fragment, .pf_index, .pagefind...) and anything unknown.
const FALLBACK_TYPE = 'application/octet-stream';

/** The headers of apps/site/headers.json, read once. A missing file is reported and served without. */
function loadSecurityHeaders() {
  let text;
  try {
    text = readFileSync(HEADERS_FILE, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      console.error(
        `production-headers server: ${HEADERS_FILE} is missing; serving no extra headers`,
      );
      return {};
    }
    throw error;
  }
  return JSON.parse(text);
}

const securityHeaders = loadSecurityHeaders();

/** Maps a request path to a file inside ROOT, or undefined when it resolves outside the root. */
function fileFor(pathname) {
  let path = pathname;
  if (path.endsWith('/')) path += 'index.html';
  else if (!path.slice(path.lastIndexOf('/') + 1).includes('.')) path += '/index.html';
  const file = resolve(join(ROOT, path));
  if (file !== ROOT && !file.startsWith(ROOT + sep)) return undefined;
  return file;
}

async function readIfFile(file) {
  try {
    if (!(await stat(file)).isFile()) return undefined;
    return await readFile(file);
  } catch {
    return undefined;
  }
}

function send(res, method, status, type, body, extra = {}) {
  res.writeHead(status, {
    ...extra,
    ...securityHeaders,
    'Content-Type': type,
    'Content-Length': body.length,
  });
  res.end(method === 'HEAD' ? undefined : body);
}

async function handle(req, res) {
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    send(res, method, 405, 'text/plain; charset=utf-8', Buffer.from('Method Not Allowed\n'), {
      Allow: 'GET, HEAD',
    });
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  } catch {
    pathname = undefined;
  }
  const file = pathname === undefined || pathname.includes('\0') ? undefined : fileFor(pathname);
  const body = file === undefined ? undefined : await readIfFile(file);
  if (file !== undefined && body !== undefined) {
    send(res, method, 200, CONTENT_TYPES[extname(file).toLowerCase()] ?? FALLBACK_TYPE, body);
    return;
  }

  const notFound = await readIfFile(join(ROOT, '404.html'));
  if (notFound !== undefined) {
    send(res, method, 404, CONTENT_TYPES['.html'], notFound);
    return;
  }
  send(res, method, 404, 'text/plain; charset=utf-8', Buffer.from('Not Found\n'));
}

const server = createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error(error);
    if (!res.headersSent)
      send(
        res,
        req.method ?? 'GET',
        500,
        'text/plain; charset=utf-8',
        Buffer.from('Server Error\n'),
      );
    else res.end();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`production-headers server on http://127.0.0.1:${String(PORT)} (root ${ROOT})`);
});
