/**
 * Vite config for the HOSTED deployment (server.mjs spawns Vite with
 * `--config vite.hosted.config.mjs`). Takes the full project config and turns
 * off three dev-only behaviours that don't belong on a server:
 *
 *   - allowedHosts: true  — requests arrive via the auth reverse proxy with the
 *     public Render Host header; the app is already gated, so accept any host.
 *   - hmr: false           — no hot-module reload on a server.
 *   - watch: null          — disable the file watcher. On Render's container it
 *     blew past the open-file limit on startup:
 *       Error: EMFILE: too many open files, watch '/app/src/data/...'
 *
 * Everything else — every /api/* proxy, the Cesium plugin, the define block —
 * comes straight from vite.config.js untouched.
 */
import baseConfig from './vite.config.js';

export default async (configEnv) => {
  const cfg = await baseConfig(configEnv);
  cfg.server = cfg.server || {};
  cfg.server.allowedHosts = true;
  cfg.server.hmr = false;
  cfg.server.watch = null;
  return cfg;
};
