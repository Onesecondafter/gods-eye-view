/**
 * God's Eye View — hosted entrypoint.
 *
 * All of this app's live-data proxies (/api/firms, /api/ais-live,
 * /api/realtime/token, /api/tomtom, OpenSky, CelesTrak, …) are Vite dev-server
 * middlewares defined in vite.config.js. `vite preview` does NOT run them, so to
 * host the full app we run the real Vite dev server and put a thin
 * authenticating reverse proxy in front of it.
 *
 *   internet ──HTTP/WS──▶  this proxy  (Basic Auth on $GODSEYE_USER/$GODSEYE_PASS)
 *                                │
 *                                ▼
 *                     vite dev server on 127.0.0.1:$INNER_PORT
 *
 * Env:
 *   PORT           - public port Render assigns (default 4173)
 *   GODSEYE_USER   - Basic Auth username (if unset AND GODSEYE_PASS unset → no auth)
 *   GODSEYE_PASS   - Basic Auth password
 *   INNER_PORT     - internal vite port (default 5199)
 * plus every key the proxies read: GOOGLE_MAPS_API_KEY, OPENAI_API_KEY,
 * AISSTREAM_API_KEY, FIRMS_MAP_KEY, OPENSKY_AUTH_MODE, TOMTOM_API_KEY, …
 */

import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';

const PUBLIC_PORT = Number(process.env.PORT) || 4173;
const INNER_PORT = Number(process.env.INNER_PORT) || 5199;
const USER = process.env.GODSEYE_USER || '';
const PASS = process.env.GODSEYE_PASS || '';
const AUTH_ON = Boolean(USER || PASS);

// ---------------------------------------------------------------------------
// 1. start the real Vite dev server, bound to loopback only
// ---------------------------------------------------------------------------
const vite = spawn(
  process.execPath,
  [
    './node_modules/vite/bin/vite.js',
    '--config', './vite.hosted.config.mjs',
    '--host', '127.0.0.1',
    '--port', String(INNER_PORT),
    '--strictPort',
  ],
  { stdio: ['ignore', 'inherit', 'inherit'], env: process.env },
);
vite.on('exit', (code) => {
  console.error(`[godseye] vite exited (${code}) — shutting down`);
  process.exit(code ?? 1);
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { vite.kill(sig); } catch {} process.exit(0); });
}

// ---------------------------------------------------------------------------
// 2. Basic Auth check
// ---------------------------------------------------------------------------
function eq(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  try { return timingSafeEqual(ab, bb); } catch { return false; }
}
function authed(req) {
  if (!AUTH_ON) return true;
  const h = req.headers['authorization'] || '';
  const m = /^Basic\s+(.+)$/i.exec(h);
  if (!m) return false;
  const [u, ...rest] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
  return eq(u, USER) && eq(rest.join(':'), PASS);
}
function deny(res) {
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="God\'s Eye View", charset="UTF-8"',
    'Content-Type': 'text/plain',
  });
  res.end('Authentication required.');
}

// ---------------------------------------------------------------------------
// 3. reverse proxy  (HTTP)
// ---------------------------------------------------------------------------
// Vite 6's dev server rejects any Host header not in server.allowedHosts.
// Behind this proxy the browser's Host is the public Render domain, which Vite
// doesn't know — so rewrite it to loopback (always allowed) before forwarding.
const INNER_HOST = `127.0.0.1:${INNER_PORT}`;

const proxy = http.createServer((req, res) => {
  if (!authed(req)) return deny(res);
  const headers = { ...req.headers, host: INNER_HOST };
  const upstream = http.request(
    { host: '127.0.0.1', port: INNER_PORT, method: req.method, path: req.url, headers },
    (up) => { res.writeHead(up.statusCode || 502, up.headers); up.pipe(res); },
  );
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Upstream unavailable.'); });
  req.pipe(upstream);
});

// ---------------------------------------------------------------------------
// 4. reverse proxy  (WebSocket upgrade: HMR + AIS live)
// ---------------------------------------------------------------------------
proxy.on('upgrade', (req, socket, head) => {
  if (!authed(req)) { socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="God\'s Eye View"\r\n\r\n'); socket.destroy(); return; }
  const up = net.connect(INNER_PORT, '127.0.0.1', () => {
    const fwd = { ...req.headers, host: INNER_HOST };
    up.write(
      `${req.method} ${req.url} HTTP/1.1\r\n` +
      Object.entries(fwd).map(([k, v]) => `${k}: ${v}`).join('\r\n') +
      '\r\n\r\n',
    );
    if (head && head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

// ---------------------------------------------------------------------------
// 5. wait for vite, then open the public port
// ---------------------------------------------------------------------------
async function waitForVite(tries = 60) {
  for (let i = 0; i < tries; i++) {
    const ok = await new Promise((resolve) => {
      const s = net.connect(INNER_PORT, '127.0.0.1');
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => resolve(false));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

if (!(await waitForVite())) {
  console.error('[godseye] vite never became reachable on', INNER_PORT);
  process.exit(1);
}
proxy.listen(PUBLIC_PORT, '0.0.0.0', () => {
  console.log(`[godseye] listening on :${PUBLIC_PORT} → vite :${INNER_PORT}  (auth ${AUTH_ON ? 'ON' : 'OFF — set GODSEYE_USER/GODSEYE_PASS'})`);
});
