import { build as buildClientAdmin } from './build';
import { buildServer } from './build-server';

import type { BuildContext } from '../create-build-context';

/**
 * Phase C Task C2 — build BOTH Vite environments (the admin `client` SPA and the
 * `server` CJS single-file bundle) from a single invocation.
 *
 * ## Why sequential, not `createBuilder().buildApp()`
 *
 * The two environments have structurally incompatible output requirements that do
 * not compose cleanly under one Rolldown `buildApp()` pass:
 *
 * - The `client` env is a **browser** build (esbuild target from browserslist,
 *   `base`/`envPrefix`, the `@vitejs/plugin-react-swc` plugin, the design-system
 *   aliases) emitting an ES-module SPA to `<dist.root>/build`.
 * - The `server` env is an **SSR/Node CJS** build (`ssr: true`, `format: 'cjs'`,
 *   `target: 'node22'`, the bare-specifier externals predicate, the
 *   `__STRAPI_APP_DIR__` define) emitting a single file to the app's dist root.
 *
 * Their configs share almost nothing, and the spike (`phase-c-assumption5-spike.md`)
 * proved the server build in isolation with a dedicated `vite build` call. The plan
 * (`phase-c-prod-vite-build.md`, Task C2 Step 3) explicitly allows composing the two
 * builds sequentially when the Builder's server-env wiring is awkward. Two focused
 * `vite build` calls keep each environment's config self-contained and independently
 * testable, and avoid threading a Node-CJS env through the browser-oriented
 * `resolveProductionConfig` plugin stack.
 *
 * ## Output reconciliation (the dirs model) — the C1 review I1 finding
 *
 * For a JS app `distDir` defaults to `appDir` (see `resolveWorkingDirectories`). The
 * dirs model (`get-dirs.ts`) couples three runtime consumers to `distDir`:
 *
 * - `dirs.dist.root` → the admin static middleware serves `<dirs.dist.root>/build`.
 * - `dirs.dist.src` / `dirs.dist.config` → the content & config loaders.
 *
 * For a JS app the app's real source lives at `<appDir>/src` + `<appDir>/config`, so
 * `distDir` MUST stay `appDir` for content/config to load (proven in the spike). That
 * forces the admin SPA dir to `<appDir>/build`. The two outputs are therefore:
 *
 * - **admin** → `ctx.distPath` = `<dirs.dist.root>/build` = `<appDir>/build`
 *   (the client build's `outDir`, served at runtime from `<appDir>/build`).
 * - **server** → `<appDir>/dist/server.js` (see `build-server.ts`): a dedicated
 *   `dist/` subdir, NOT `<appDir>` itself (would equal the Vite root and clobber
 *   source) and NOT `<appDir>/build` (the admin dir, wiped each build). It is where
 *   `strapi start` (C4) probes, and stays inside `appDir` for externals walk-up.
 *
 * **I1 resolution:** because admin reconciles purely through `distDir = appDir`, the
 * existing `bootProduction()` (`createStrapi({ appDir, distDir: appDir })`) is already
 * correct for the JS app — no change to `server-entry.ts` is required. A single
 * `<appDir>` serves admin (`<appDir>/build`) AND api (`<appDir>/src`,
 * `<appDir>/config`). (The TS-app prod-source-loading case is a separate open design
 * question — see the C2 report.)
 *
 * ## emptyOutDir safety
 *
 * Both builds set `emptyOutDir: false`; the CLI (`createBuildContext`) cleans only
 * `ctx.distPath` (`<appDir>/build`) before either build runs. The client build writes
 * into `<appDir>/build` and never touches `<appDir>/dist/server.js`; the server build
 * writes `server.js` into `<appDir>/dist` and (with `emptyOutDir: false`) never wipes
 * the sibling `build/` dir. Order is therefore safe either way; client runs first so a
 * later server failure still leaves a usable admin build.
 */
export async function buildApp(ctx: BuildContext): Promise<void> {
  // Admin `client` SPA → <dirs.dist.root>/build
  await buildClientAdmin(ctx);

  // `server` env → <appDir>/dist/server.js (CJS single file)
  await buildServer(ctx);
}
