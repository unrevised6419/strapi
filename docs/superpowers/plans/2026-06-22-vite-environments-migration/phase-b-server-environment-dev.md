# Phase B — Server environment in dev (flag-gated) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
>
> Global constraints: [`README.md`](./README.md#global-constraints). **Prerequisite: Phases 0 + A complete.**

**Goal:** Run the Strapi backend in dev through the Vite **`server` environment**'s
Module Runner — booting Strapi, its plugins, and its config from **source** (no
`tsc`, no `dist`) — behind an experimental flag, with coarse in-process reload
replacing the cluster restart. The existing `tsc`+cluster path stays the default
and is untouched when the flag is off.

**Architecture:** One Vite server (`createServer`, `appType: 'custom'`,
`middlewareMode`) hosts `client` (admin, Phase A) and a new `server` environment.
The server env is a `RunnableDevEnvironment`; `env.runner.import(id)` loads node
modules in-process with on-the-fly TS transform. A new injectable `importModule`
threads the runner into Strapi's plugin/config loaders so they resolve from source
instead of `require`-ing compiled `dist`. A new in-process reload re-imports
changed modules (never caching stale `exports`) instead of forking the cluster.

**Tech Stack:** Vite 8 Environment API — `RunnableDevEnvironment`,
`isRunnableDevEnvironment`, `createServerModuleRunner`, `handleHotUpdate`.

## Vite facts (verified 2026-06-22) — load-bearing for this phase

- `createServer({ appType:'custom', server:{middlewareMode:true}, environments:{ server:{} } })`;
  reach it via `server.environments.server`. ([frameworks guide](https://vite.dev/guide/api-environment-frameworks))
- Default non-client environments are `RunnableDevEnvironment` in dev;
  `if (isRunnableDevEnvironment(env)) await env.runner.import(id)`. `runner.import`
  is the modern replacement for `ssrLoadModule`. ([instances](https://vite.dev/guide/api-environment-instances))
- `RunnableDevEnvironment` is **type-only**; import it as a type, guard with
  `isRunnableDevEnvironment` (value) or build a runner via
  `createServerModuleRunner(env)` (value, `@experimental`).
- **HMR:** use **`handleHotUpdate`** (current); Vite says do **not** migrate to
  `hotUpdate` yet. ([hotupdate-hook](https://vite.dev/changes/hotupdate-hook))
- **Landmine 1:** first `runner` access mutates process globals
  (`process.setSourceMapsEnabled`, `Error.prepareStackTrace`). Access it once,
  early, deliberately.
- **Landmine 2:** after a full-reload, the Module Runner **overrides a module's
  `exports`** — never cache `exports`; re-`import()` to get the live module. The
  in-process reload (Task 5) MUST re-import, not reuse references.

## Codebase facts (verified 2026-06-22)

- Dev/cluster: `packages/core/strapi/src/node/develop.ts` — `cluster.isPrimary`
  compiles TS (`tsUtils().compile`, ~L120) + `cluster.fork()` (~L197); worker
  (~L200) `createStrapi({ appDir, distDir, autoReload:true })`; reload = IPC
  `'reload'`→`worker.send('kill')`→re-fork. `chokidar` watcher (~L344).
- **Reload is cluster-coupled:** `packages/core/core/src/services/reloader.ts:18`
  = `process.send?.('reload')`. **No in-process reload exists** — this phase
  builds one.
- Plugin server load: `packages/core/core/src/loaders/plugins/index.ts` resolves
  `strapi-server` entry then `loadConfigFile(serverEntrypointPath)`.
- Config load: `packages/core/core/src/utils/load-config-file.ts:36` —
  `switch(extname)` over `.js`/`.json` only. `.ts` config handled separately by
  `esbuild-register` in `packages/core/strapi/src/node/core/files.ts`.
- `createStrapi(options)` accepts `{ appDir, distDir, autoReload, serveAdminPanel }`
  (`Strapi.ts` ~L601). `strapi.dirs` from `get-dirs.ts` (`dist.root`, `app.root`).

## Global Constraints

See [`README.md`](./README.md#global-constraints). Phase-specific:

- **Flag default OFF.** Flag on ⇒ new path; flag off ⇒ today's `tsc`+cluster path
  byte-for-byte unchanged. Every task must preserve the off path.

---

## File Structure

| File                                                      | Responsibility                                               | Change                           |
| --------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------- |
| `packages/core/strapi/src/cli/commands/develop.ts`        | CLI flag                                                     | add `--experimental-vite-server` |
| `packages/core/strapi/src/node/develop.ts`                | dev entry                                                    | branch to new path when flag on  |
| `packages/core/strapi/src/node/vite/dev-server.ts`        | **new** — one Vite server, client+server envs, runner        | create                           |
| `packages/core/strapi/src/node/vite/plugin.ts`            | add `server` env via `configEnvironment` + `handleHotUpdate` | extend (from Phase A)            |
| `packages/core/strapi/src/node/server-entry.ts`           | **new** — runner entry that boots Strapi                     | create                           |
| `packages/core/core/src/factories/index.ts` / `Strapi.ts` | accept injectable `importModule`                             | extend `StrapiOptions`           |
| `packages/core/core/src/loaders/plugins/index.ts`         | use `importModule` when present                              | branch                           |
| `packages/core/core/src/utils/load-config-file.ts`        | async + `importModule` path                                  | branch                           |
| `packages/core/core/src/services/reloader.ts`             | in-process reload mode                                       | extend                           |

---

## Task 1: Experimental flag, default off

**Files:**

- Modify: `packages/core/strapi/src/cli/commands/develop.ts:28-45`
- Modify: `packages/core/strapi/src/node/develop.ts` (entry, add early branch)

**Interfaces:**

- Produces: `options.experimentalViteServer: boolean` (also settable via
  `STRAPI_EXPERIMENTAL_VITE_SERVER=true`). When false → existing path.

- [ ] **Step 1: Add the CLI option**

In `develop.ts` (CLI), add to the command:

```ts
.option(
  '--experimental-vite-server',
  'Run the backend through the Vite server environment (experimental)',
  process.env.STRAPI_EXPERIMENTAL_VITE_SERVER === 'true'
)
```

- [ ] **Step 2: Branch in the node develop entry (off = unchanged)**

At the top of `node/develop.ts`'s `develop()`, before the cluster logic:

```ts
if (options.experimentalViteServer) {
  const { developViteServer } = await import('./vite/dev-server');
  return developViteServer(options);
}
// …existing cluster path unchanged below…
```

- [ ] **Step 3: Verify the off path is untouched**

Run: `cd examples/getstarted && yarn develop`
Expected: identical behavior to before (tsc compile + cluster). No flag = no change.

- [ ] **Step 4: Commit**

```bash
git add packages/core/strapi/src/cli/commands/develop.ts packages/core/strapi/src/node/develop.ts
git commit -m "feat(strapi): add experimental --experimental-vite-server flag (off by default)"
```

---

## Task 2: SPIKE — prove a `server` environment runner can run in-process

> This task validates README assumption 1 (runner hosts node code in the Strapi
> process). It is intentionally minimal — a probe, not the real boot. If this
> fails or the runner cannot host a resident app, STOP and revisit the design
> before Tasks 3–7.

**Files:**

- Create: `packages/core/strapi/src/node/vite/dev-server.ts`
- Modify: `packages/core/strapi/src/node/vite/plugin.ts` (add `server` env)

**Interfaces:**

- Produces: `export async function developViteServer(options: DevelopOptions): Promise<void>`
  and a `getServerRunner(vite)` helper returning the server env's `ModuleRunner`.

- [ ] **Step 1: Add the `server` environment to the plugin**

In `plugin.ts`, replace the `return undefined` branch:

```ts
configEnvironment(name) {
  if (name === 'client') { /* …Phase A… */ }
  if (name === 'server') {
    return { resolve: { conditions: ['node', 'strapi-server'] } };
  }
  return undefined;
},
```

- [ ] **Step 2: Write the spike dev-server with a probe import**

```ts
// packages/core/strapi/src/node/vite/dev-server.ts
import { createServer, isRunnableDevEnvironment } from 'vite';
import type { RunnableDevEnvironment } from 'vite';
import type { DevelopOptions } from '../develop';
import { strapi as strapiPlugin } from './plugin';

export function getServerRunner(vite: Awaited<ReturnType<typeof createServer>>) {
  const env = vite.environments.server as RunnableDevEnvironment;
  if (!isRunnableDevEnvironment(env)) {
    throw new Error('Strapi: server environment is not runnable');
  }
  return env.runner;
}

export async function developViteServer(options: DevelopOptions): Promise<void> {
  const { cwd } = options;
  const vite = await createServer({
    root: cwd,
    appType: 'custom',
    server: { middlewareMode: true },
    configFile: false,
    plugins: [
      /* ctx-less probe plugin is fine for the spike */
    ],
    environments: {
      server: { resolve: { conditions: ['node', 'strapi-server'] } },
    },
  });

  // Landmine 1: access runner once, deliberately (mutates process globals).
  const runner = getServerRunner(vite);

  // Probe: import a trivial source module and run it in-process.
  const probe = await runner.import('/src/index'); // any app source entry
  options.logger.info(`[vite-server spike] imported probe: ${typeof probe}`);

  // Keep alive briefly to confirm the resident server holds, then exit for the spike.
  await vite.close();
}
```

- [ ] **Step 3: Run the spike against the sandbox**

Run: `cd examples/getstarted && yarn develop --experimental-vite-server`
Expected: logs `[vite-server spike] imported probe: object` (or `function`) with
no crash — proving the runner imports + executes app source in the Strapi process.
Record the result. **Gate: if this fails, halt and reassess.**

- [ ] **Step 4: Commit the spike**

```bash
git add packages/core/strapi/src/node/vite/dev-server.ts packages/core/strapi/src/node/vite/plugin.ts
git commit -m "feat(strapi): spike server environment module runner (experimental)"
```

---

## Task 3: Injectable `importModule` in the loaders

**Files:**

- Modify: `Strapi.ts` `StrapiOptions` + the factory that builds `createStrapi`
- Modify: `packages/core/core/src/loaders/plugins/index.ts`
- Modify: `packages/core/core/src/utils/load-config-file.ts`

**Interfaces:**

- Consumes: nothing new at call sites (optional param).
- Produces: `StrapiOptions.importModule?: (id: string) => Promise<any>`. When set,
  plugin server entries and config files load through it; when unset, today's
  `require`/`loadConfigFile` path runs (off-path preserved).

- [ ] **Step 1: Write a failing unit test for the config loader branch**

```ts
// packages/core/core/src/utils/__tests__/load-config-file.test.ts (add case)
import { loadConfigFile } from '../load-config-file';

it('uses injected importModule when provided', async () => {
  const fake = async (id: string) => ({ default: { from: id } });
  const result = await loadConfigFile('/abs/config/server.ts', { importModule: fake });
  expect(result).toEqual({ from: '/abs/config/server.ts' });
});
```

- [ ] **Step 2: Run it — fails (loadConfigFile is sync, no options)**

Run: `yarn vitest run packages/core/core/src/utils/__tests__/load-config-file.test.ts`
Expected: FAIL.

- [ ] **Step 3: Make `loadConfigFile` accept `importModule` (and async)**

```ts
// load-config-file.ts
export const loadConfigFile = async (
  file: string,
  opts: { importModule?: (id: string) => Promise<any> } = {}
) => {
  if (opts.importModule) {
    const mod = await opts.importModule(file);
    const val = mod?.default ?? mod;
    return typeof val === 'function' ? val({ env }) : val;
  }
  // …existing switch(extname) path unchanged…
};
```

Update the few sync call sites to `await` (they're already in async loaders).

- [ ] **Step 4: Thread `importModule` into the plugin server loader**

In `loaders/plugins/index.ts`, where it calls `loadConfigFile(serverEntrypointPath)`:

```ts
const pluginServer = await loadConfigFile(serverEntrypointPath, {
  importModule: strapi.importModule, // undefined off-path
});
```

And expose `strapi.importModule` from `StrapiOptions` (store on the instance).

- [ ] **Step 5: Run the test — passes; run unit suite**

Run: `yarn vitest run packages/core/core/src/utils/__tests__/load-config-file.test.ts && yarn test:unit`
Expected: PASS, no regressions on the off-path.

- [ ] **Step 6: Commit**

```bash
git add packages/core/core/src/utils/load-config-file.ts packages/core/core/src/loaders/plugins/index.ts packages/core/core/src/Strapi.ts
git commit -m "feat(core): allow injectable importModule for plugin/config loading"
```

---

## Task 4: `server-entry` — boot Strapi through the runner

> **Spike-gated (Task 2 must pass).** Exact wiring may adjust to what the spike
> revealed about runner + resident-app behavior.

**Files:**

- Create: `packages/core/strapi/src/node/server-entry.ts`
- Modify: `packages/core/strapi/src/node/vite/dev-server.ts`

**Interfaces:**

- Consumes: `getServerRunner`, `StrapiOptions.importModule` (Task 3).
- Produces: `export async function createStrapiApp(opts): Promise<Strapi>` (the
  module imported through the runner), and `developViteServer` booting it.

- [ ] **Step 1: Write the runner entry**

```ts
// packages/core/strapi/src/node/server-entry.ts
import { createStrapi } from '@strapi/core';

export async function createStrapiApp(opts: {
  cwd: string;
  importModule: (id: string) => Promise<any>;
}) {
  // No distDir: everything resolves from source via the runner.
  const app = createStrapi({
    appDir: opts.cwd,
    distDir: opts.cwd, // dirs.dist.* === source in dev; see Task 7 notes
    autoReload: true,
    importModule: opts.importModule,
  });
  return app;
}
```

- [ ] **Step 2: Boot it from the dev-server (replace the spike probe)**

```ts
// dev-server.ts — replace the probe block
const runner = getServerRunner(vite);
const { createStrapiApp } = await runner.import('@strapi/strapi/node/server-entry');
const app = await createStrapiApp({
  cwd,
  importModule: (id: string) => runner.import(id),
});
await app.load(); // register → bootstrap
await app.start(); // start Koa
```

- [ ] **Step 3: Verify a JS app boots with no dist**

Run: `cd examples/getstarted && rm -rf dist && yarn develop --experimental-vite-server`
Expected: Strapi boots, `/admin` and `/api` reachable, **no `dist/` created**.
This proves source-only boot (README assumption — kills the `dist.root` problem).

- [ ] **Step 4: Verify a local `.ts` plugin loads with no precompile**

Use the `fix/local-ts-plugin-support` reproduction (a local `src/plugins/*.ts`
plugin). Confirm it loads under the flag with no `tsc` step.
Expected: plugin routes/services available; no extension-probe, no dist.

- [ ] **Step 5: Commit**

```bash
git add packages/core/strapi/src/node/server-entry.ts packages/core/strapi/src/node/vite/dev-server.ts
git commit -m "feat(strapi): boot strapi through the vite server runner (experimental)"
```

---

## Task 5: In-process reload (replace cluster restart)

> **The largest deliverable.** Today reload = `process.send('reload')` → cluster
> re-fork (`reloader.ts:18`). Under the flag there is no cluster; build an
> in-process reload that respects Landmine 2 (re-import, never cache `exports`).

**Files:**

- Modify: `packages/core/core/src/services/reloader.ts`
- Modify: `packages/core/strapi/src/node/vite/dev-server.ts` (watcher → reload)

**Interfaces:**

- Consumes: the running `app` (Task 4), the Vite server.
- Produces: an in-process reload triggered by server-graph changes; `reloader`
  gains an `inProcess` mode that calls a supplied `onReload` instead of
  `process.send`.

- [ ] **Step 1: Add in-process mode to the reloader**

```ts
// reloader.ts
export const createReloader = (strapi, opts: { onReload?: () => void } = {}) => {
  function reload() {
    if (state.shouldReload > 0) {
      /* …unchanged… */ return;
    }
    if (opts.onReload) return opts.onReload(); // in-process path
    if (strapi.config.get('autoReload')) process.send?.('reload'); // cluster path
  }
  // …unchanged property defs…
};
```

- [ ] **Step 2: Wire coarse reload from the Vite watcher**

In `dev-server.ts`, after boot, on a server-graph change re-create the app
(coarse mode — full re-register, no process fork), tearing down the old instance
so no stale module references survive (Landmine 2):

```ts
let app = await bootApp();
vite.watcher.on('change', async (file) => {
  if (!isServerGraphFile(file)) return; // ignore admin/client files
  await app.destroy();
  runner.clearCache(); // drop stale module graph
  app = await bootApp(); // re-import everything fresh
  options.logger.info(`[vite-server] reloaded (${file})`);
});
```

Use `handleHotUpdate` in the plugin to scope which files count as server-graph
(do **not** use `hotUpdate` — Vite says not yet).

- [ ] **Step 3: Verify reload works in-process (no fork)**

Run: `cd examples/getstarted && yarn develop --experimental-vite-server`, then edit
a controller/service `.ts`. Expected: log `[vite-server] reloaded`, change visible
on next request, **no new node process** (check with `ps`/PID stability of the
parent). Reload latency < cluster cold boot.

- [ ] **Step 4: Verify the off-path reloader is unchanged**

Run: `yarn test:unit` (reloader tests) + `cd examples/getstarted && yarn develop`
then edit a file. Expected: cluster restart as before (off-path intact).

- [ ] **Step 5: Commit**

```bash
git add packages/core/core/src/services/reloader.ts packages/core/strapi/src/node/vite/dev-server.ts
git commit -m "feat(strapi): in-process reload for the vite server path (experimental)"
```

---

## Task 6: Mount the admin (`client`) alongside the API

**Files:**

- Modify: `packages/core/strapi/src/node/vite/dev-server.ts`

**Interfaces:**

- Consumes: the booted `app` (Koa) + the Vite server.
- Produces: `/admin` served via Vite middleware + `transformIndexHtml`; `/api`
  served by Koa — both from the one Vite server.

- [ ] **Step 1: Mount Vite middleware for /admin, Koa for the rest**

```ts
// dev-server.ts after boot
const koa = app.server.app;
koa.use(async (ctx, next) => {
  if (ctx.path.startsWith('/admin')) {
    return new Promise((res) => vite.middlewares(ctx.req, ctx.res, () => res(next())));
  }
  return next();
});
```

Reuse Phase 0/A's `transformIndexHtml` recipe for the admin HTML entry.

- [ ] **Step 2: Verify both surfaces**

Run: `cd examples/getstarted && yarn develop --experimental-vite-server`
Expected: `/admin` loads the SPA with HMR; `/api/...` returns content-type data.
Editing admin `.tsx` hot-updates; editing a server `.ts` triggers Task 5 reload.

- [ ] **Step 3: Commit**

```bash
git add packages/core/strapi/src/node/vite/dev-server.ts
git commit -m "feat(strapi): serve admin and api from one vite server (experimental)"
```

---

## Task 7: End-to-end verification + off-path guarantee

**Files:** none (verification); fix regressions in prior files if found.

- [ ] **Step 1: Flag-on acceptance**

Run the sandbox with the flag; confirm: source-only boot (no `dist`), local `.ts`
plugin loads, `.ts` config loads (no `esbuild-register` needed under flag), admin
HMR, server reload in-process. Document results in this file under a "Spike
results" heading.

- [ ] **Step 2: Flag-off regression**

Run: `yarn test:unit && yarn test:front && yarn test:ts && yarn lint && yarn prettier:check`
Plus `cd examples/getstarted && yarn develop` (cluster path) and `yarn build`.
Expected: all green; off-path behavior identical to pre-Phase-B.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "test(strapi): verify experimental vite server path end-to-end"
```

---

## Self-Review

- **Spec coverage:** flag (T1), runner feasibility spike (T2), injectable loader
  (T3), source boot (T4), in-process reload (T5), admin+api serving (T6), e2e +
  off-path (T7). README assumptions 1–4 are each proven by a concrete run step
  (1→T2/T4, 2→T5, 3→T4/T7, 4→T6).
- **Type consistency:** `importModule: (id: string) => Promise<any>` is identical
  in `StrapiOptions` (T3), `createStrapiApp` (T4), and the runner call (T4). `strapi()`
  plugin extended, not redefined (Phase A interface preserved).
- **No placeholders:** Tasks 1–3 are fully concrete. Tasks 4–6 are spike-gated:
  their code is concrete but **finalize step-level details after Task 2's spike
  result is recorded** — flagged inline, not left blank.

## Execution Handoff

Plan complete. Phase B's spike results gate Phases C and D. Proceed to
[`phase-c-prod-vite-build.md`](./phase-c-prod-vite-build.md) **only after** Task 7
is green and the Spike results are recorded.
