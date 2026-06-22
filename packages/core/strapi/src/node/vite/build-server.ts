import path from 'node:path';

import type { InlineConfig } from 'vite';

import type { BuildContext } from '../create-build-context';
import { appManifestPlugin, VIRTUAL_ID } from './app-manifest-plugin';

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
  // The app-source manifest is a virtual module the manifest plugin resolves +
  // inlines (Task C5). It must NOT be externalized despite being a bare-looking
  // specifier, or `require('virtual:strapi-app-manifest')` survives into the
  // bundle and fails at runtime.
  if (id === VIRTUAL_ID || id.startsWith('\0')) {
    return false;
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
/**
 * Resolve a prod entry file across BOTH package layouts:
 *
 *  - jest / source run: the entry sits next to this module at `../<name>`
 *    (`src/node/server-prod-entry*.ts`).
 *  - shipped package: this module is bundled to `dist/src/node/vite/` while the
 *    entries are emitted (per `rollup.config.mjs`) to `dist/node/`, i.e.
 *    `../../../node/<name>` relative to here.
 *
 * Try the sibling layout first, then the shipped `node/` layout. (A naive
 * `require.resolve('../<name>')` resolves only in the source/jest run and
 * throws `Cannot find module` in the shipped package.)
 */
const resolveEntry = (name: string): string => {
  const candidates = [`../${name}`, `../../../node/${name}`];
  for (const candidate of candidates) {
    try {
      // eslint-disable-next-line node/no-missing-require
      return require.resolve(candidate);
    } catch {
      // try the next layout
    }
  }
  throw new Error(
    `[strapi] could not resolve the prod entry "${name}" in any known package layout`
  );
};

const resolveProdEntry = (): string => resolveEntry('server-prod-entry');

// The manifest prod entry (Task C5): imports `virtual:strapi-app-manifest` so
// Rolldown inlines the app's own source (TS prod, source-only). Used when the
// app is TypeScript; the JS-disk app uses the plain prod entry above.
const resolveManifestEntry = (): string => resolveEntry('server-prod-entry-manifest');

/**
 * Inline the app's own source into the bundle (TS prod, source-only) when the
 * app is a TypeScript project. A JS app keeps loading its `src/**.js` from disk
 * (the proven C1-C4 path); only a TS app — which has no `.js` on disk in prod —
 * needs its source inlined via the manifest.
 */
const shouldInlineAppSource = (ctx: BuildContext): boolean => Boolean(ctx.tsconfig?.config);

export function resolveServerBuildConfig(ctx: BuildContext): InlineConfig {
  const appDir = ctx.appDir ?? ctx.cwd;
  // The bundle lives inside the app dir (load-bearing: externals walk up to
  // app/node_modules). It is emitted to `<appDir>/dist/server.js`:
  //
  // - A dedicated `<appDir>/dist` subdir (NOT `appDir` itself) keeps the server
  //   `outDir` separate from the Vite `root` (= `ctx.cwd` = appDir). Emitting to
  //   `appDir` directly triggers Vite's "outDir must not be the root or a parent of
  //   root" warning and risks clobbering app source / colliding with `publicDir`.
  // - `<appDir>/dist/server.js` is exactly where `strapi start` (Task C4) probes for
  //   the bundle, and is independent of the admin's `<dist.root>/build` output, so the
  //   two environments never fight over a directory.
  //
  // It is intentionally NOT under `<appDir>/build` (the admin SPA dir, which the CLI
  // wipes before each build) so the server bundle is not collateral of the admin
  // clean. See `builder.ts` for the full dirs reconciliation.
  const outDir = path.join(appDir, 'dist');

  const inlineAppSource = shouldInlineAppSource(ctx);

  return {
    root: ctx.cwd,
    configFile: false,
    define: { __STRAPI_APP_DIR__: JSON.stringify(appDir) },
    // The manifest plugin is harmless when unused (it only resolves the virtual
    // module the manifest entry imports), but only register it on the inlined
    // path so the JS-disk build is byte-for-byte unchanged.
    plugins: inlineAppSource ? [appManifestPlugin(appDir)] : [],
    build: {
      ssr: true,
      outDir,
      emptyOutDir: false,
      minify: false,
      sourcemap: true,
      target: 'node22',
      rollupOptions: {
        // TS app: the manifest entry inlines `src/**` + `config/**` (source-only
        // prod). JS app: the plain entry loads `src/**.js` from disk at runtime.
        input: { server: inlineAppSource ? resolveManifestEntry() : resolveProdEntry() },
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
