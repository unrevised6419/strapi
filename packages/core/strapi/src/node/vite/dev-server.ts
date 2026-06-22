import path from 'node:path';
import { createRequire } from 'node:module';

import { createServer, isRunnableDevEnvironment, createRunnableDevEnvironment } from 'vite';

import type { RunnableDevEnvironment } from 'vite';
import type { ModuleRunner } from 'vite/module-runner';
import type { Core } from '@strapi/types';

import { strapi } from './plugin';
import { strapiCjsInterop } from './cjs-interop';
import { createStrapiApp } from '../server-entry';
import type { DevelopOptions } from '../develop';

type ViteServer = Awaited<ReturnType<typeof createServer>>;

/**
 * Phase B Task 4 — boot a real Strapi app through the Vite `server` environment
 * Module Runner, from SOURCE (no `tsc`, no `dist`). Experimental; behind
 * `--experimental-vite-server`.
 *
 * Architecture (resolved from the Task 2/4 spike reality):
 *
 * - The Vite `server` environment is a {@link RunnableDevEnvironment}; its
 *   `runner.import(id)` hosts and evaluates *app source* in-process. We bind
 *   that as Strapi's `importModule` (Task 3), so plugin/config loaders resolve
 *   app source through the runner instead of a built `dist/`.
 *
 * - App source is CommonJS; the runner evaluates ESM. {@link strapiCjsInterop}
 *   wraps detected CJS into a runner-evaluable ESM shim (see that file for the
 *   full rationale and why `@rollup/plugin-commonjs` was rejected).
 *
 * - The FRAMEWORK (`@strapi/core` / `@strapi/strapi`) is NOT loaded through the
 *   runner. Its `dist/index.mjs` (the ESM build) is not standalone-importable —
 *   even plain Node fails on its `import 'lodash/fp'` — and the runner imports
 *   externalized deps via dynamic `import()`, which forces that broken ESM
 *   entry. We therefore load `server-entry` (and through it `@strapi/core`) via
 *   native CJS `require`, which resolves the working `dist/index.js` CJS build.
 *   The runner owns the *app* graph; native require owns the *framework* graph.
 *
 * - Strapi runs its own Koa HTTP server and listens on its own port, so the
 *   Vite server stays in `middlewareMode` purely as the runner host; no Vite
 *   middleware needs wiring into Koa for the backend to serve `/api`.
 */

/**
 * Returns the `server` environment's Module Runner.
 *
 * NOTE (Landmine 1): the first access of `env.runner` lazily constructs the
 * runner and mutates `process` globals (it calls `setSourceMapsEnabled` and
 * installs an `Error.prepareStackTrace`). We touch `env.runner` exactly once,
 * early and deliberately, and pass the resulting runner around — callers must
 * not re-derive it ad hoc.
 */
export function getServerRunner(vite: ViteServer): ModuleRunner {
  const env = vite.environments.server;
  if (!isRunnableDevEnvironment(env)) {
    throw new Error('Strapi: server environment is not runnable');
  }
  // `env` is narrowed to RunnableDevEnvironment by the type guard above; the
  // assertion is restated at the `.runner` access against the RC env union.
  return (env as RunnableDevEnvironment).runner;
}

export async function developViteServer(options: DevelopOptions): Promise<void> {
  const { cwd, logger } = options;

  const vite = await createServer({
    root: cwd,
    appType: 'custom',
    server: { middlewareMode: true },
    configFile: false,
    // `ctx` is not consumed by the plugin's `configEnvironment` (the server/
    // client branches are static), so we don't pay for a second Strapi instance
    // just to satisfy the type. The real ctx is wired in the admin path.
    plugins: [strapi({ ctx: undefined }), strapiCjsInterop()],
    environments: {
      server: {
        resolve: { conditions: ['node', 'strapi-server'] },
        // Make the `server` environment runnable so we get an in-process
        // ModuleRunner (the default dev env may be fetch-only).
        dev: {
          createEnvironment: (name, config) => createRunnableDevEnvironment(name, config),
        },
      },
    },
  });

  let app: Core.Strapi | undefined;

  const shutdown = async (code = 0): Promise<void> => {
    try {
      await app?.destroy();
    } catch (err) {
      logger.error(`Error destroying Strapi: ${(err as Error).message}`);
    }
    try {
      await vite.close();
    } catch {
      // ignore — best-effort teardown
    }
    process.exit(code);
  };

  process.once('SIGINT', () => {
    shutdown(0).catch(() => process.exit(1));
  });
  process.once('SIGTERM', () => {
    shutdown(0).catch(() => process.exit(1));
  });

  // Landmine 1: access the runner once, early, deliberately.
  const runner = getServerRunner(vite);

  /**
   * Coarse, in-process reload (Phase B Task 5 — the Phase B win over the
   * cluster-fork+tsc path).
   *
   * Landmine 2 (load-bearing): after a Module Runner reload a previously
   * evaluated module's `exports` go stale. We therefore NEVER reuse the old
   * `app` or any cached module reference — we:
   *   1. fully tear down the old Strapi instance (`app.destroy()`),
   *   2. clear the runner's module cache so the next import re-evaluates fresh,
   *   3. re-import EVERYTHING and re-boot a brand-new instance.
   *
   * `reloading` guards against overlapping reloads; `reloadQueued` coalesces
   * edits that land mid-reload into a single follow-up pass.
   */
  let reloading = false;
  let reloadQueued = false;

  // Used to purge Node's CJS require cache for app source on reload (see below).
  const appRequire = createRequire(path.join(cwd, 'noop.js'));

  /**
   * Landmine 2, the OTHER half: `runner.clearCache()` only drops the Vite runner
   * (Module Runner) graph — the modules loaded via Strapi's `importModule`
   * (config + plugin entries). But Strapi's API loader (`loaders/apis.ts`) reads
   * route/controller/service `.js` files via native `require` (`importDefault`),
   * whose results live in Node's CJS `require.cache` and are NOT touched by
   * `runner.clearCache()`. Without purging them, a re-boot reuses the previous
   * boot's router objects — e.g. the core router's memoized `routes` getter still
   * holds the route already mutated by `applyExtraParamsToRoutes`, so re-applying
   * `addInputParams` throws `param "clientMutationId" already exists`.
   *
   * We therefore evict every cached module physically under `cwd` (the app dir)
   * except `node_modules`, so app source re-evaluates fresh on the next boot.
   * The framework graph (`@strapi/*` under `node_modules`) is deliberately left
   * cached — it is stateless across boots and re-requiring it is unnecessary.
   */
  const purgeAppRequireCache = (): void => {
    const cache = appRequire.cache;
    const nm = `${path.sep}node_modules${path.sep}`;
    for (const id of Object.keys(cache)) {
      if (id.startsWith(cwd + path.sep) && !id.includes(nm)) {
        delete cache[id];
      }
    }
  };

  const bootApp = async (): Promise<Core.Strapi> => {
    const next = await createStrapiApp({
      cwd,
      importModule: (id: string) => runner.import(id),
      // Wire the SAME coarse-reload routine so a Strapi-internal reload trigger
      // (e.g. a content-type change calling `strapi.reload()`) also reloads
      // in-process rather than signalling a cluster re-fork.
      onReload() {
        return reload('strapi.reload()');
      },
    });
    await next.load(); // register → bootstrap (re-imports app source fresh)
    await next.start(); // Strapi's Koa server begins listening
    return next;
  };

  const reload = async (reason: string): Promise<void> => {
    if (reloading) {
      reloadQueued = true;
      return;
    }
    reloading = true;
    try {
      logger.info(`[vite-server] reloading (${reason})…`);
      const start = Date.now();

      // 1. Tear down the old instance fully (frees the Koa port, DB, watchers).
      try {
        await app?.destroy();
      } catch (err) {
        logger.error(`[vite-server] error destroying old Strapi: ${(err as Error).message}`);
      }
      // Drop the reference so a failed re-boot can't leave a stale app around.
      app = undefined;

      // 2a. Clear the runner module graph so config + plugin entries loaded via
      //     `importModule` re-evaluate fresh (verified Vite 8 API: clearCache()).
      runner.clearCache();
      // 2b. Purge Node's require cache for app source so route/controller/service
      //     `.js` files loaded via native `require` re-evaluate fresh too. Both
      //     halves are required to honour Landmine 2 (no stale module refs).
      purgeAppRequireCache();

      // 3. Re-import everything and re-boot a brand-new instance.
      app = await bootApp();

      logger.info(`[vite-server] reloaded in ${Date.now() - start}ms (${reason}).`);
    } catch (err) {
      const e = err as Error;
      logger.error(`[vite-server] reload failed: ${e.message}`);
      if (e.stack) {
        logger.error(e.stack);
      }
    } finally {
      reloading = false;
      if (reloadQueued) {
        reloadQueued = false;
        reload('coalesced edits').catch(() => {});
      }
    }
  };

  /**
   * Server-graph file filter: only files that feed the backend graph trigger a
   * reload. App source lives under `src/` and `config/`; the admin/client graph
   * (`src/admin/`) and Vite's own internals are explicitly ignored so editing
   * the admin panel doesn't re-boot the server.
   *
   * We also ignore GENERATED output that the backend writes back into `src/` at
   * bootstrap (e.g. the documentation plugin regenerates
   * `src/extensions/documentation/documentation/<v>/full_documentation.json` on
   * every boot). Watching those would trigger a reload on boot and loop, since
   * each reload re-bootstraps and re-writes the file.
   */
  const srcDir = path.join(cwd, 'src');
  const configDir = path.join(cwd, 'config');
  const adminDir = path.join(cwd, 'src', 'admin');
  const docsGenDir = path.join(cwd, 'src', 'extensions', 'documentation', 'documentation');
  const isServerGraphFile = (file: string): boolean => {
    const f = path.resolve(file);
    if (f.startsWith(adminDir + path.sep)) return false; // admin/client graph
    if (f.startsWith(docsGenDir + path.sep)) return false; // generated OpenAPI spec
    if (f.includes(`${path.sep}node_modules${path.sep}`)) return false;
    if (f.endsWith('.json') && f.includes(`${path.sep}extensions${path.sep}`)) return false;
    return f.startsWith(srcDir + path.sep) || f.startsWith(configDir + path.sep);
  };

  const onWatchEvent = (file: string): void => {
    if (!isServerGraphFile(file)) return;
    reload(path.relative(cwd, file)).catch(() => {});
  };

  try {
    // Boot the real app. server-entry is required natively (above), so
    // @strapi/core loads via CJS; the runner is handed to Strapi as
    // `importModule` so APP source resolves in-process from source.
    app = await bootApp();

    logger.info('[vite-server] Strapi booted through the Vite server runner (source-only).');

    // Wire the coarse in-process reload to server-graph file changes. We watch
    // Vite's chokidar instance directly (the dev server is in middlewareMode, so
    // there is no HMR client driving the server graph for us).
    //
    // In middlewareMode Vite only watches files as they enter the module graph;
    // many backend files (lazily-loaded controllers/services/configs) aren't in
    // the graph at boot. We explicitly add the server source dirs so every
    // server-graph edit is observed, then filter events to the server graph.
    //
    // We react to `change`/`unlink` only — NOT `add`. chokidar emits `add` for
    // every pre-existing file during its initial scan after `watcher.add()`,
    // which would otherwise trigger a spurious reload at boot.
    vite.watcher.add([srcDir, configDir]);
    vite.watcher.on('change', onWatchEvent);
    vite.watcher.on('unlink', onWatchEvent);
  } catch (err) {
    const e = err as Error;
    logger.error(`[vite-server] Failed to boot Strapi: ${e.message}`);
    if (e.stack) {
      logger.error(e.stack);
    }
    await shutdown(1);
  }

  // Keep the process alive: Strapi owns the HTTP port; the Vite server stays up
  // as the runner host. Do NOT close vite here (unlike the spike).
}
