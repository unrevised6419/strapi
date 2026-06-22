# Phase C — Production via `vite build` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Global constraints: [`README.md`](./README.md#global-constraints). **Prerequisite: Phase B complete; Detail-after gate satisfied (assumption-5 spike DONE, decision 3 locked).**

**Goal:** Produce production output via Vite's Builder/Rolldown — a single-file **CJS** `dist/server.js` (Node, `node_modules` + installed plugins externalized, local `src/plugins/*` inlined) plus the admin SPA — and make `strapi start` run `node --enable-source-maps dist/server.js`. Behind an experimental flag, default off; the legacy `tsc`+admin-bundle build and the legacy `strapi start` stay the default until validated.

**Architecture:** `createBuilder().buildApp()` builds both environments. `client` → `dist/build` (admin SPA, as today). `server` → a **Rolldown CJS single-file** entry (`server-entry`'s `createStrapi(...).start()`) with `node_modules`/installed plugins `external` and local plugins inlined. The bundle lives **inside the app dir** so externalized bare specifiers resolve by walking up to `app/node_modules`. The app dir is injected at build time (absolute), never read from `process.cwd()`. Source maps are emitted; `strapi start` enables them with a **node flag** at spawn (NOT an in-bundle call — proven a no-op).

**Tech Stack:** Vite 8 Builder API (`createBuilder`, `builder.buildApp()`), Rolldown, the Phase A/B `strapi()` plugin + `server-entry.ts`, `@strapi/typescript-utils` (kept for `tsc --noEmit` type-checking only).

## Locked facts from the assumption-5 spike (`.superpowers/sdd/phase-c-assumption5-spike.md`)

- **CJS output is mandatory.** ESM output forces `@strapi/core`'s non-standalone `dist/index.mjs` (`ERR_UNSUPPORTED_DIR_IMPORT` on `lodash/fp`) — the Phase B wall. CJS resolves `@strapi/core` → working `dist/index.js`. The two-graph rule in prod: framework via native `require`, which only CJS output gives.
- **Externals resolve relative to the bundle file's directory** (walk up to `app/node_modules`), independent of cwd. ⇒ `dist/server.js` MUST live inside the app dir.
- **App config/content resolve via the absolute `appDir`/`distDir`** passed to `createStrapi` — inject app dir at build time (`define`) or read the bundle's own `__dirname`; never rely on cwd.
- **Single file, NOT `preserveModules`** (decision 3 locked) — per-source-file accurate stacktraces with `--enable-source-maps`. Use `rollupOptions.output.codeSplitting: false` (not lib mode; lib mode ignores `output.fileName` under Rolldown — use a plain `rollupOptions.input`).
- **Source maps need a node flag at spawn** (`--enable-source-maps` / `NODE_OPTIONS` / a 2-line loader shim). In-bundle `process.setSourceMapsEnabled(true)` is a no-op for the bundle's own frames.
- Externalized predicate that worked: `id.startsWith('node:') → external; id starts with '.' or is absolute → bundled; else (bare specifier) → external`.

## Global Constraints

See [`README.md`](./README.md#global-constraints). Phase-specific:

- **Experimental flag, default off.** A new `--experimental-vite-build` on `strapi build` (and `STRAPI_EXPERIMENTAL_VITE_BUILD=true`) selects the Builder path; `strapi start` auto-detects `dist/server.js` and runs it, else falls back to the legacy start. Flag off / no bundle ⇒ today's behavior byte-for-byte.
- Internal `packages/` deps pinned exact semver. Conventional Commits + footer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- No `any` where a type exists (prefer `unknown`).

---

## File Structure

| File                                                                | Responsibility                                                       | Change                                 |
| ------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------- |
| `packages/core/strapi/src/node/server-entry.ts`                     | the runner boot entry (Phase B)                                      | reuse; ensure a prod-build-safe export |
| `packages/core/strapi/src/node/vite/build-server.ts`                | **new** — build the `server` env → CJS single-file `dist/server.js`  | create                                 |
| `packages/core/strapi/src/node/vite/build.ts`                       | admin (`client`) prod build (Phase 0)                                | reuse; invoked via Builder in C2       |
| `packages/core/strapi/src/node/vite/builder.ts`                     | **new** — `createBuilder().buildApp()` orchestration (client+server) | create                                 |
| `packages/core/strapi/src/node/build.ts:42-108`                     | `strapi build` entry                                                 | branch to Builder path under flag      |
| `packages/core/strapi/src/cli/commands/build.ts`                    | CLI `build` command                                                  | add `--experimental-vite-build`        |
| `packages/core/strapi/src/cli/commands/start.ts:9-23`               | `strapi start`                                                       | detect+exec `dist/server.js`           |
| `packages/core/strapi/src/node/vite/__tests__/build-server.test.ts` | unit test for the server build config                                | create                                 |

---

## Task C1: Build the `server` environment → CJS single-file `dist/server.js`

**Files:**

- Create: `packages/core/strapi/src/node/vite/build-server.ts`
- Create: `packages/core/strapi/src/node/vite/__tests__/build-server.test.ts`
- Reuse: `packages/core/strapi/src/node/server-entry.ts` (Phase B; the boot)

**Interfaces:**

- Consumes: `BuildContext` (from `create-build-context.ts`); `server-entry.ts`'s `createStrapiApp`/boot.
- Produces: `export async function buildServer(ctx: BuildContext): Promise<void>` that emits `<appDir>/dist/server.js` (CJS, single file, externals walked-up). Consumed by C2's Builder and C3.

- [ ] **Step 1: Write the failing test** — assert the server build config is CJS single-file with the correct externals predicate.

```ts
// packages/core/strapi/src/node/vite/__tests__/build-server.test.ts
import { resolveServerBuildConfig } from '../build-server';

const ctx = { cwd: '/abs/app', distDir: '/abs/app/dist', appDir: '/abs/app' } as any;

describe('resolveServerBuildConfig', () => {
  it('emits a CJS single-file server bundle with externalized bare specifiers', () => {
    const cfg = resolveServerBuildConfig(ctx);
    expect(cfg.build?.ssr).toBe(true);
    const out = (cfg.build?.rollupOptions?.output ?? {}) as Record<string, unknown>;
    expect(out.format).toBe('cjs');
    expect(out.codeSplitting).toBe(false);
    const ext = cfg.build?.rollupOptions?.external as (id: string) => boolean;
    expect(ext('node:path')).toBe(true); // node builtins external
    expect(ext('@strapi/core')).toBe(true); // bare specifier external
    expect(ext('./local')).toBe(false); // relative bundled
    expect(ext('/abs/app/src/x')).toBe(false); // absolute bundled
  });

  it('injects the absolute app dir at build time (no cwd dependency)', () => {
    const cfg = resolveServerBuildConfig(ctx);
    expect((cfg.define as Record<string, string>).__STRAPI_APP_DIR__).toBe(
      JSON.stringify('/abs/app')
    );
  });
});
```

- [ ] **Step 2: Run it — fails** (`Cannot find module '../build-server'`).

Run: `yarn jest packages/core/strapi/src/node/vite/__tests__/build-server.test.ts`

- [ ] **Step 3: Implement `build-server.ts`** (config from the spike, corrected to CJS single-file).

```ts
// packages/core/strapi/src/node/vite/build-server.ts
import { build as viteBuild, type InlineConfig } from 'vite';
import path from 'node:path';
import type { BuildContext } from '../create-build-context';

const externalPredicate = (id: string): boolean => {
  if (id.startsWith('node:')) return true;
  if (id.startsWith('.') || path.isAbsolute(id)) return false; // bundle local/abs
  return true; // externalize bare specifiers (@strapi/*, deps, installed plugins)
};

export function resolveServerBuildConfig(ctx: BuildContext): InlineConfig {
  const appDir = ctx.appDir ?? ctx.cwd;
  return {
    root: ctx.cwd,
    configFile: false,
    define: { __STRAPI_APP_DIR__: JSON.stringify(appDir) },
    build: {
      ssr: true,
      outDir: ctx.distDir,
      emptyOutDir: false,
      minify: false,
      sourcemap: true,
      target: 'node22',
      rollupOptions: {
        // a real input (NOT lib mode — lib ignores output.fileName under Rolldown)
        input: { server: require.resolve('../server-entry') },
        external: externalPredicate,
        output: { format: 'cjs', codeSplitting: false, entryFileNames: 'server.js' },
      },
    },
    ssr: { target: 'node', external: true },
  };
}

export async function buildServer(ctx: BuildContext): Promise<void> {
  await viteBuild(resolveServerBuildConfig(ctx));
}
```

(Note: `server-entry.ts` must export a CJS-importable boot that reads the absolute app dir from `__STRAPI_APP_DIR__` and calls `createStrapi({ appDir, distDir: appDir }).start()`. If Phase B's `server-entry` doesn't already, add a `bootProduction()` export guarded so the dev path is unchanged.)

- [ ] **Step 4: Run the test — passes.**

- [ ] **Step 5: Integration check — build getstarted's server bundle and boot from /tmp.**

Run a throwaway: build getstarted via `buildServer`, then `cd /tmp && node --enable-source-maps <appdir>/dist/server.js`. Expected: "Strapi started", `/api/...` responds, no `dist/` resolution errors. (Mirror the spike's verified result.)

- [ ] **Step 6: Commit**

```bash
git add packages/core/strapi/src/node/vite/build-server.ts packages/core/strapi/src/node/vite/__tests__/build-server.test.ts packages/core/strapi/src/node/server-entry.ts
git commit -m "feat(strapi): build server environment to a single-file cjs bundle (experimental)"
```

---

## Task C2: Build both environments via the Builder API

**Files:**

- Create: `packages/core/strapi/src/node/vite/builder.ts`

**Interfaces:**

- Consumes: `buildServer` (C1), the admin `client` build (`vite/build.ts`, Phase 0), `BuildContext`.
- Produces: `export async function buildApp(ctx: BuildContext): Promise<void>` that emits BOTH `dist/build` (admin) and `dist/server.js` (server) from one invocation.

- [ ] **Step 1: Write the failing test** — assert `buildApp` produces both artifacts (use a temp getstarted build dir; assert files exist).

```ts
// in build-server.test.ts or a new builder.test.ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
// after running buildApp(ctx) against a fixture app dir `app`:
expect(existsSync(join(app, 'dist/build/index.html'))).toBe(true);
expect(existsSync(join(app, 'dist/server.js'))).toBe(true);
```

- [ ] **Step 2: Run it — fails** (`buildApp` not defined / artifacts missing).

- [ ] **Step 3: Implement `builder.ts`.** Prefer `createBuilder()` with both environments registered via the `strapi()` plugin's `configEnvironment` (client + server); if the Builder's server-env wiring is awkward under Rolldown, compose sequentially: `await buildClient(ctx)` (existing admin build) then `await buildServer(ctx)`. Builder builds envs in series by config order; ensure `client` empties `dist/build` only (`emptyOutDir` scoped) and `server` does NOT wipe it.

```ts
// packages/core/strapi/src/node/vite/builder.ts
import type { BuildContext } from '../create-build-context';
import { build as buildClientAdmin } from './build';
import { buildServer } from './build-server';

export async function buildApp(ctx: BuildContext): Promise<void> {
  await buildClientAdmin(ctx); // admin SPA → dist/build
  await buildServer(ctx); // server → dist/server.js
}
```

- [ ] **Step 4: Run the test — passes** (both artifacts present).

- [ ] **Step 5: Boot from the built output** — `dist/build/index.html` exists; `node --enable-source-maps dist/server.js` serves `/admin` static + `/api`. (Admin served by Strapi's static middleware from `dist/build`, as in prod today.)

- [ ] **Step 6: Commit**

```bash
git add packages/core/strapi/src/node/vite/builder.ts
git commit -m "feat(strapi): build admin and server via the vite builder (experimental)"
```

---

## Task C3: Route `strapi build` to the Builder under the experimental flag

**Files:**

- Modify: `packages/core/strapi/src/cli/commands/build.ts` (add the flag)
- Modify: `packages/core/strapi/src/node/build.ts:42-108`

**Interfaces:**

- Consumes: `buildApp` (C2).
- Produces: `strapi build --experimental-vite-build` runs the Builder path (admin + server bundle); without the flag, today's `tsUtils.compile` + admin-only build runs unchanged.

- [ ] **Step 1: Add the CLI flag** in `cli/commands/build.ts`:

```ts
.option(
  '--experimental-vite-build',
  'Build the server to a single-file bundle via the Vite builder (experimental)',
  process.env.STRAPI_EXPERIMENTAL_VITE_BUILD === 'true'
)
```

- [ ] **Step 2: Branch in `node/build.ts`** — at the top of `build()`, before the legacy `tsUtils.compile`:

```ts
if (options.experimentalViteBuild) {
  // Type-check only (no emit); the bundle is produced by the Builder.
  if (tsconfig?.config) {
    await tsUtils.compile(cwd, {
      configOptions: { ignoreDiagnostics: false, noEmit: true } as any,
    });
  }
  const ctx = await createBuildContext({ cwd, logger, tsconfig, options });
  await writeStaticClientFiles(ctx);
  const { buildApp } = await import('./vite/builder');
  await buildApp(ctx);
  return;
}
// …existing legacy path unchanged below…
```

(Confirm `tsUtils.compile` supports a `noEmit` option; if not, call `tsc --noEmit` via the existing typescript-utils type-check API. Keep emit-mode for the legacy off-path.)

- [ ] **Step 3: Verify off-path unchanged** — `cd examples/getstarted && yarn build` (no flag) compiles + builds admin exactly as before.

- [ ] **Step 4: Verify flag-on** — `yarn build --experimental-vite-build` emits `dist/build` + `dist/server.js`, type-checks, no emit of compiled server source.

- [ ] **Step 5: Commit**

```bash
git add packages/core/strapi/src/cli/commands/build.ts packages/core/strapi/src/node/build.ts
git commit -m "feat(strapi): strapi build via vite builder behind experimental flag"
```

---

## Task C4: `strapi start` → `node --enable-source-maps dist/server.js`

**Files:**

- Modify: `packages/core/strapi/src/cli/commands/start.ts:9-23`

**Interfaces:**

- Consumes: a built `dist/server.js` (C1-C3).
- Produces: `strapi start` execs the bundle (with source maps) when `dist/server.js` exists; else the legacy `createStrapi({ appDir, distDir }).start()` runs.

- [ ] **Step 1: Write the failing test** — `resolveStartTarget(appDir)` returns the bundle path + flag when `dist/server.js` exists, else legacy.

```ts
// start.test.ts
import { resolveStartTarget } from './start';
expect(resolveStartTarget('/app-with-bundle')).toEqual({
  mode: 'bundle',
  file: '/app-with-bundle/dist/server.js',
});
expect(resolveStartTarget('/legacy-app')).toEqual({ mode: 'legacy' });
```

- [ ] **Step 2: Run it — fails.**

- [ ] **Step 3: Implement** — detect the bundle; spawn `node --enable-source-maps dist/server.js` (source maps via the node flag, per the spike — NOT an in-bundle call). Keep the "build first" error for the legacy TS path.

```ts
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

export const resolveStartTarget = (appDir: string) => {
  const file = path.join(appDir, 'dist', 'server.js');
  return fs.existsSync(file) ? { mode: 'bundle' as const, file } : { mode: 'legacy' as const };
};

const action = async () => {
  const appDir = process.cwd();
  const target = resolveStartTarget(appDir);
  if (target.mode === 'bundle') {
    const child = spawn(process.execPath, ['--enable-source-maps', target.file], {
      stdio: 'inherit',
      cwd: appDir,
    });
    child.on('exit', (code) => process.exit(code ?? 0));
    return;
  }
  // …existing legacy path (tsUtils.isUsingTypeScript / resolveOutDir / build-first error / createStrapi(...).start())…
};
```

- [ ] **Step 4: Verify** — with a built bundle, `strapi start` boots prod-mode, a smoke `/api` request works, and a deliberately-thrown error shows accurate `*.ts` file:line (source maps). Without a bundle, legacy start unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/core/strapi/src/cli/commands/start.ts
git commit -m "feat(strapi): strapi start runs the single-file server bundle when present"
```

---

## Task C5: CommonJS + local-plugin compatibility in the bundle

> Closes the spike's open item: prove installed CJS plugins load as **external** `require` AND a local `src/plugins/*` is **inlined via the server entry** (not re-resolved from disk).

**Files:**

- Modify (if needed): `packages/core/strapi/src/node/server-entry.ts` (import local plugin entries so Rolldown inlines them), `build-server.ts` (ensure local plugin paths are bundled, not externalized)

**Interfaces:**

- Consumes: C1-C4.
- Produces: a prod bundle where installed CJS plugins work (external) and local TS plugins are inlined + consumed as inlined modules.

- [ ] **Step 1: Fixture** — an app with one installed CJS plugin (a `node_modules` plugin, e.g. `users-permissions`) and one local `src/plugins/<name>/strapi-server.ts`.

- [ ] **Step 2: Failing assertion** — after `buildApp` + `node dist/server.js`, both plugins are functional: the installed plugin's route responds; the local plugin's route/service responds. Write an integration check (boot bundle, curl both plugin surfaces).

- [ ] **Step 3: Wire local-plugin inlining** — ensure the server entry (or the loader path under the bundle) imports local plugin server entries so the externals predicate (relative/absolute → bundled) inlines them, while installed plugins (bare specifiers) stay external. Reconcile with Strapi's runtime plugin discovery so the inlined module is consumed rather than re-required from disk.

- [ ] **Step 4: Verify** — both plugin kinds functional from `dist/server.js`; assert EE license-gated code is NOT dead-code-eliminated (it loads dynamically from the external, intact `@strapi/*` graph — add an explicit check).

- [ ] **Step 5: Commit**

```bash
git add packages/core/strapi/src/node/server-entry.ts packages/core/strapi/src/node/vite/build-server.ts
git commit -m "feat(strapi): support installed-cjs and inlined-local plugins in the server bundle (experimental)"
```

---

## Task C6: End-to-end verification + off-path guarantee

**Files:** none (verification); fix regressions in prior files if found.

- [ ] **Step 1: Flag-on acceptance** — `yarn build --experimental-vite-build` then `strapi start` against getstarted (JS) and kitchensink-ts (TS): single-file `dist/server.js` boots prod-mode from the app dir, admin loads from `dist/build`, `/api` works, source maps accurate. Document results.

- [ ] **Step 2: Flag-off regression** — `yarn test:unit && yarn test:ts && yarn lint && yarn prettier:check`; `cd examples/getstarted && yarn build && yarn start` (legacy path) boots from compiled `dist` as before. Off-path byte-for-byte. (e2e deferred to CI — playwright hangs locally.)

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "test(strapi): verify experimental vite production build end-to-end"
```

---

## Self-Review

- **Spec coverage:** server bundle (C1), both-env Builder (C2), `strapi build` flag (C3), `strapi start` exec (C4), plugin compat (C5), e2e + off-path (C6). The 5 milestone deliverables + the gate corrections (CJS, bundle-in-app, absolute appDir, `--enable-source-maps`) are each assigned a step.
- **Spike-locked decisions applied:** CJS single-file (not ESM, not preserveModules); externals walk up from the bundle dir; app dir injected at build; source maps via node flag at spawn.
- **Off-path:** every change is behind `--experimental-vite-build` / bundle-detection; legacy `tsc`+admin-build and legacy `start` stay default.
- **Open risk carried into C5:** local-plugin inlining-via-entry is the one spike-unverified wiring — C5 is its proving step; if it can't be inlined cleanly, fall back to loading local plugins from disk (as the spike did) and document.

## Execution Handoff

Plan complete. After Phase C is green, proceed to
[`phase-d-remove-old-toolchain.md`](./phase-d-remove-old-toolchain.md).
