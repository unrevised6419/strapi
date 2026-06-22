import path from 'node:path';

import type { InlineConfig } from 'vite';

import type { BuildContext } from '../create-build-context';

/**
 * Phase C Task C1 — build the Vite `server` environment to a single-file CJS
 * `dist/server.js`. Config locked by `.superpowers/sdd/phase-c-assumption5-spike.md`:
 *
 * - **CJS, not ESM.** ESM output forces `@strapi/core`'s non-standalone
 *   `dist/index.mjs` (the Phase B wall, `ERR_UNSUPPORTED_DIR_IMPORT`). CJS resolves
 *   the working `dist/index.js`. The framework graph must load via native `require`.
 * - **Single file** (`output.codeSplitting: false`), NOT `preserveModules` and NOT
 *   lib mode (lib mode ignores `output.entryFileNames`/`fileName` under Rolldown).
 *   A plain `rollupOptions.input` controls the `server.js` name.
 * - **Externalize bare specifiers + `node:`**; bundle relative/absolute. Externals
 *   resolve at runtime by walking up from the bundle's own directory to
 *   `app/node_modules`, so the bundle MUST live inside the app dir.
 * - **Inject the absolute app dir at build time** (`define.__STRAPI_APP_DIR__`),
 *   never `process.cwd()` — the prod boot (`server-entry.ts`'s `bootProduction`)
 *   reads it.
 */

/**
 * Externalize a module id. `node:` builtins and bare specifiers (`@strapi/*`,
 * deps, installed plugins) are left as runtime `require`; relative/absolute ids
 * (the entry, local `src/plugins/*`) are bundled.
 */
export const externalPredicate = (id: string): boolean => {
  if (id.startsWith('node:')) {
    return true;
  }
  if (id.startsWith('.') || path.isAbsolute(id)) {
    return false;
  }
  return true;
};

/**
 * The module Rolldown uses as the bundle entry. Resolved here (not statically
 * imported) so importing this config module never triggers the prod boot. It
 * resolves to `…/node/server-prod-entry.{ts,js}` in both the jest (src) run and
 * the shipped package (dist) because `require.resolve` handles the extension.
 */
// Resolved at runtime; the file exists as src/node/server-prod-entry.ts (jest) and
// dist/node/server-prod-entry.js (shipped package), but the static analyzer only
// sees the literal.
// eslint-disable-next-line node/no-missing-require
const resolveProdEntry = (): string => require.resolve('../server-prod-entry');

export function resolveServerBuildConfig(ctx: BuildContext): InlineConfig {
  const appDir = ctx.appDir ?? ctx.cwd;
  // The bundle lives inside the app dir (load-bearing: externals walk up to
  // app/node_modules). `distPath` is `<dist.root>/build` for the admin; the
  // server bundle sits one level up, directly in the app's dist root.
  const outDir = path.dirname(ctx.distPath);

  return {
    root: ctx.cwd,
    configFile: false,
    define: { __STRAPI_APP_DIR__: JSON.stringify(appDir) },
    build: {
      ssr: true,
      outDir,
      emptyOutDir: false,
      minify: false,
      sourcemap: true,
      target: 'node22',
      rollupOptions: {
        input: { server: resolveProdEntry() },
        external: externalPredicate,
        output: {
          format: 'cjs',
          codeSplitting: false,
          entryFileNames: 'server.js',
        },
      },
    },
    ssr: { target: 'node', external: true },
  };
}

export async function buildServer(ctx: BuildContext): Promise<void> {
  const { build: viteBuild } = await import('vite');
  ctx.logger.debug('Vite server build config', resolveServerBuildConfig(ctx));
  await viteBuild(resolveServerBuildConfig(ctx));
}
