/**
 * God's Eye View — LEAN hosted entrypoint.
 *
 * Serves the PRE-BUILT static app from dist/ and reuses this project's own
 * live-data proxy plugins (defined in vite.config.js) by invoking their
 * `configureServer` hooks against an Express app — no Vite dev server, no
 * module transforming, no file watcher. Runs in a fraction of the memory of
 * server.mjs and fits Render's $7 / 512 MB plan.
 *
 *   internet ──HTTP/WS──▶  Basic Auth  ──▶  /api/* proxy middleware (from vite.config.js)
 *                                       └─▶  static dist/  +  SPA fallback
 *
 * Env: GODSEYE_USER / GODSEYE_PASS (Basic Auth; unset both = no auth),
 *      PORT (Render injects it), plus every key the proxies read
 *      (GOOGLE_MAPS_API_KEY, OPENAI_API_KEY, AISSTREAM_API_KEY, FIRMS_MAP_KEY,
 *      OPENSKY_AUTH_MODE, OPENAI_REALTIME_VOICE, TOMTOM_API_KEY, …).
 *
 * Build the app first (`npm run build`); the Docker image does that at start
 * so the env vars are present for vite.config.js's `define:` block.
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4173;
const DIST = path.join(__dirname, 'dist');
const USER = process.env.GODSEYE_USER || '';
const PASS = process.env.GODSEYE_PASS || '';
const AUTH_ON = Boolean(USER || PASS);

if (!existsSync(path.join(DIST, 'index.html'))) {
  console.error(`[godseye-lean] no dist/index.html — run "npm run build" first (looked in ${DIST})`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');

// 1. health check — before auth
app.get('/healthz', (_req, res) => res.status(200).type('text/plain').send('ok'));

// 2. Basic Auth gate — everything past here needs credentials (if configured)
function eq(a, b) {
  const ab = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  try { return timingSafeEqual(ab, bb); } catch { return false; }
}
app.use((req, res, next) => {
  if (!AUTH_ON) return next();
  const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization || '');
  if (m) {
    const [u, ...rest] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
    if (eq(u, USER) && eq(rest.join(':'), PASS)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="God\'s Eye View", charset="UTF-8"');
  res.status(401).type('text/plain').send('Authentication required.');
});

// ---------------------------------------------------------------------------
// 3. Reuse the project's own /api/* proxy plugins.
//    vite.config.js default-exports `defineConfig(({mode}) => ({ plugins:[...] }))`.
//    We call it, then run every plugin's `configureServer` hook against a
//    minimal fake Vite dev-server whose `.middlewares` is this Express app.
// ---------------------------------------------------------------------------
const httpServer = http.createServer(app);

const fakeServer = {
  middlewares: app,
  httpServer,
  config: {
    root: __dirname,
    command: 'serve',
    mode: 'production',
    logger: { info: () => {}, warn: (m) => console.warn(m), error: (m) => console.error(m), warnOnce: () => {} },
    server: {},
    build: {},
    env: {},
    resolve: {},
  },
  ws: { on() {}, off() {}, send() {}, clients: new Set(), listen() {}, close() {} },
  hot: { on() {}, off() {}, send() {} },
  watcher: { on() { return this; }, add() { return this; }, unwatch() { return this; }, close() { return Promise.resolve(); } },
  moduleGraph: { getModuleById() { return undefined; }, invalidateModule() {} },
  pluginContainer: {},
  restart() {},
};

async function wireProxies() {
  const mod = await import(pathToFileURL(path.join(__dirname, 'vite.config.js')).href);
  const factory = mod.default;
  const resolved = typeof factory === 'function'
    ? await factory({ command: 'serve', mode: 'production', isSsrBuild: false, isPreview: false })
    : factory;
  const plugins = (resolved.plugins || []).flat(Infinity).filter(Boolean);

  let wired = 0;
  const post = [];
  for (const p of plugins) {
    const cs = p && p.configureServer;
    if (!cs) continue;
    try {
      const hook = typeof cs === 'function' ? cs : (cs && typeof cs.handler === 'function' ? cs.handler : null);
      if (!hook) continue;
      const ret = await hook.call(p, fakeServer);
      if (typeof ret === 'function') post.push(ret);
      wired++;
    } catch (e) {
      console.warn(`[godseye-lean] plugin "${p.name || '(anon)'}" configureServer skipped: ${e.message}`);
    }
  }
  for (const fn of post) { try { fn(); } catch (e) { console.warn(`[godseye-lean] post-hook skipped: ${e.message}`); } }
  console.log(`[godseye-lean] wired ${wired} proxy plugin(s) onto /api/*`);
}

// ---------------------------------------------------------------------------
// 4. static built app + SPA fallback (registered AFTER the proxies)
// ---------------------------------------------------------------------------
function mountStatic() {
  app.use(express.static(DIST, {
    index: false,
    maxAge: '1h',
    setHeaders: (res, p) => { if (p.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache'); },
  }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(DIST, 'index.html'));
  });
}

// ---------------------------------------------------------------------------
wireProxies()
  .catch((e) => { console.error('[godseye-lean] proxy wiring failed:', e); })
  .finally(() => {
    mountStatic();
    httpServer.listen(PORT, '0.0.0.0', () =>
      console.log(`[godseye-lean] listening on :${PORT}  (auth ${AUTH_ON ? 'ON' : 'OFF'}, static ${DIST})`));
  });

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { httpServer.close(); } catch {} process.exit(0); });
