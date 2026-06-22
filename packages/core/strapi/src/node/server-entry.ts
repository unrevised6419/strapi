import { createStrapi } from '@strapi/core';

import type { Core } from '@strapi/types';

/**
 * Phase B — the module the Vite `server` environment Module Runner imports to
 * boot a real Strapi app from SOURCE (no `tsc`, no `dist`).
 *
 * The dev server imports THIS module through the runner
 * (`runner.import('@strapi/strapi/node/server-entry')`) and calls
 * {@link createStrapiApp}. Because the call happens inside the runner, the
 * `@strapi/core` import here, and everything it transitively pulls, is hosted
 * in-process by the runner — proving README assumption 1 (source-only boot).
 *
 * `importModule` is the runner's `import` bound by the caller; Strapi threads it
 * (Task 3) into its plugin/config loaders so app source resolves through the
 * runner with CJS→ESM interop rather than a `dist/` build.
 */
export interface CreateStrapiAppOptions {
  /** App root (the example app dir). Source is read directly from here. */
  cwd: string;
  /** The runner's `import`, used by Strapi's loaders to resolve app source. */
  importModule: (id: string) => Promise<unknown>;
  /** Serve the prebuilt admin panel (off by default in the source-only path). */
  serveAdminPanel?: boolean;
  /**
   * In-process reload hook (experimental). Threaded to the `reload` service so a
   * Strapi-internal reload trigger (e.g. a content-type change) re-boots the app
   * in the same process instead of signalling a cluster re-fork.
   */
  onReload?: () => void | Promise<void>;
}

export async function createStrapiApp(opts: CreateStrapiAppOptions): Promise<Core.Strapi> {
  const { cwd, importModule, serveAdminPanel = false, onReload } = opts;

  // distDir === appDir: in the source-only dev path there is no compiled output,
  // so Strapi's `dirs.dist.*` point straight at the app source (src/, config/, …).
  // This is what kills the `dist.root` assumption (see Task 7 notes).
  const app = createStrapi({
    appDir: cwd,
    distDir: cwd,
    autoReload: true,
    serveAdminPanel,
    importModule,
    onReload,
  });

  return app;
}

/**
 * Phase C — the PRODUCTION boot (no Vite runner). Replaced at build time by the
 * server-environment Rolldown build (`vite/build-server.ts`), which injects the
 * absolute app dir as `__STRAPI_APP_DIR__` via `define`. The bundled
 * `dist/server.js` lives INSIDE the app dir; passing the absolute app dir (never
 * `process.cwd()`) is what lets app config/content + externalized `@strapi/*`
 * resolve correctly when the process is launched from an arbitrary cwd
 * (verified in `.superpowers/sdd/phase-c-assumption5-spike.md`).
 *
 * This path is intentionally distinct from {@link createStrapiApp} (the dev boot,
 * driven by the Module Runner in `dev-server.ts`) so the Phase B dev flow is
 * unaffected. `__STRAPI_APP_DIR__` is a compile-time constant — referenced only
 * here, only reached when the bundle (not source) is executed.
 */
// eslint-disable-next-line @typescript-eslint/naming-convention -- build-time define constant
declare const __STRAPI_APP_DIR__: string | undefined;

export async function bootProduction(): Promise<Core.Strapi> {
  // `__STRAPI_APP_DIR__` is substituted by `define` at build time. The fallback to
  // the bundle's own directory keeps the function safe if it is ever evaluated
  // without the define (e.g. a stray import from source) — the bundle always sits
  // inside the app dir, so its directory IS the app dir at runtime.
  const appDir = typeof __STRAPI_APP_DIR__ === 'string' ? __STRAPI_APP_DIR__ : __dirname;

  const app = createStrapi({ appDir, distDir: appDir });

  await app.start();

  return app;
}
