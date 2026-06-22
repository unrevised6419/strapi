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

  try {
    // Landmine 1: access the runner once, early, deliberately.
    const runner = getServerRunner(vite);

    // Boot the real app. server-entry is required natively (above), so
    // @strapi/core loads via CJS; the runner is handed to Strapi as
    // `importModule` so APP source resolves in-process from source.
    app = await createStrapiApp({
      cwd,
      importModule: (id: string) => runner.import(id),
    });

    await app.load(); // register → bootstrap
    await app.start(); // Strapi's Koa server begins listening

    logger.info('[vite-server] Strapi booted through the Vite server runner (source-only).');
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
