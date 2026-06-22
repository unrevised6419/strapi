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
}

export async function createStrapiApp(opts: CreateStrapiAppOptions): Promise<Core.Strapi> {
  const { cwd, importModule, serveAdminPanel = false } = opts;

  // distDir === appDir: in the source-only dev path there is no compiled output,
  // so Strapi's `dirs.dist.*` point straight at the app source (src/, config/, …).
  // This is what kills the `dist.root` assumption (see Task 7 notes).
  const app = createStrapi({
    appDir: cwd,
    distDir: cwd,
    autoReload: true,
    serveAdminPanel,
    importModule,
  });

  return app;
}
