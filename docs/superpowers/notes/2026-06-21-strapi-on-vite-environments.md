# Strapi fully on the Vite Environment API (admin + server)

> Status: **design exploration / imagination**. Not a plan of record, nothing to
> implement now. Forward-looking target architecture, grounded in the current
> codebase and the Vite Environment API as it stands in Vite 6/7.
>
> Companion to the `fix/local-ts-plugin-support` branch, which patched the
> symptoms (local `.ts` plugins not loading). This document imagines the
> architecture that would make those patches unnecessary.

---

## 0. TL;DR

Strapi today runs two unrelated toolchains: **Vite** for the admin (browser)
bundle, and a **separate `tsc` pass** (`@strapi/typescript-utils`) that emits the
server to `dist/`, after which Node `require`s the compiled `.js`. That split is
the root cause of a whole class of bugs — including the one this branch just
fixed, where a local `.ts` plugin silently fails to load because the server
loader looks in the wrong tree and the compiler doesn't mirror every asset.

The Vite **Environment API** (stable-ish in Vite 6, evolving in 7) lets a single
Vite server own _multiple_ module graphs — a `client` environment for the
browser and one or more **node environments** running through the **Module
Runner** (`environments.<name>.runner.import(url)`). If Strapi adopted it for
**both** admin and server, there would be:

- **One** resolve/transform/alias pipeline for the entire app.
- **Native TS everywhere** in dev — no `tsc` pre-step, no `dist/` mirror, no
  extension probing, no `dist.root` vs `app.root` ambiguity.
- **HMR for server code** instead of full-process cluster restarts.
- **Uniform plugin loading** — admin and server entries resolve the same way,
  `.js`/`.ts`/`.tsx` indistinguishable to the author.

The cost is real: a resident Vite server in the backend process, bundling (or
deliberately _not_ bundling) a long-running Koa app for production, Module
Runner maturity, and source-map/stacktrace fidelity in a process that runs for
weeks. This doc lays out the target dev and prod architectures, the plugin
model, a phased migration, and the open questions.

---

## 1. Why — what Strapi gains

### 1.1 The current split (grounded in the code)

Dev (`packages/core/strapi/src/node/develop.ts`):

- `cluster.isPrimary` branch compiles TS up front:
  `await tsUtils().compile(cwd, { configOptions: { ignoreDiagnostics: true } })`
  (≈ line 120), then forks a worker.
- The worker (`cluster.isWorker`) does
  `core().createStrapi({ appDir: cwd, distDir: tsconfig?.config.options.outDir ?? '', autoReload: true })`
  (≈ line 204) and loads the server **from `dist`**.
- On reload, the primary recompiles (`tsUtils().compile`, ≈ line 172) then
  `worker.send('kill')` → `cluster.fork()` — i.e. **full process restart per
  change**. The file watcher is a `chokidar` instance over `cwd` (≈ line 344)
  that ignores `**/dist/**`, `**/src/plugins/**/admin/**`, etc.

Admin build is a _separate_ Vite pipeline:
`packages/core/strapi/src/node/vite/{config,build,watch}.ts`,
`create-build-context.ts`, `staticFiles.ts`. The admin entry is the generated
`.strapi/client/app.js`; `getMapOfPluginsWithAdmin` (in
`packages/core/strapi/src/node/core/plugins.ts`) decides which plugins have an
admin part and emits extensionless imports that Vite resolves.

Prod:

- `strapi build` (`node/build.ts`) compiles server TS (when a tsconfig exists)
  **and** builds the admin bundle (Vite or webpack). Two different emitters.
- `strapi start` (`cli/commands/start.ts`) computes
  `distDir = isTSProject ? outDir : appDir` and runs `createStrapi({ appDir, distDir }).start()`.
  It hard-errors if a TS project has no `dist/`.

Server module loading is plain Node `require` of compiled `.js`:
`packages/core/core/src/loaders/plugins/get-enabled-plugins.ts` resolves a
plugin directory, `index.ts` joins `strapi-server.js`, and
`utils/load-config-file.ts` does a `switch (extname)` over `.js`/`.json` only —
**no `.ts` runtime support**. `@strapi/typescript-utils`'s compiler
(`packages/utils/typescript/lib/compilers/basic.js`) is a **pure**
`ts.createProgram(...).emit()` — no asset-copy step beyond what `tsc` itself
emits.

### 1.2 The bugs this split produces

The `fix/local-ts-plugin-support` branch is a catalogue of them:

1. The server loader resolved local plugins against `dirs.app.root` (source),
   so compiled `dist` output was never found for TS projects → fixed by
   switching to `dirs.dist.root`.
2. The project `tsconfig.json` excluded `src/plugins/**` from the server
   compile, so plugin server `.ts` was never emitted → fixed by narrowing the
   exclude to only the plugin _admin_ files.
3. The admin/Vite resolver hardcoded `strapi-admin.js` → fixed by probing
   `.{js,mjs,ts,tsx,jsx}`.
4. The loader `require`d `package.json` unconditionally from `dist`, which
   `tsc` only copies under specific tsconfig flags → fixed with a tolerant
   fallback.
5. A `tsc`-with-`allowJs:false` project drops JS-authored plugin files from
   `dist` → fixed by adding `allowJs`.

**Every one of these is an artifact of "compile to a parallel `dist` tree with
`tsc`, then resolve from that tree with Node semantics."** None of them exist if
the server's modules are loaded through the same Vite graph that already
transpiles TS on the fly for the browser.

### 1.3 The win

| Concern                      | Today                                               | Vite environments                         |
| ---------------------------- | --------------------------------------------------- | ----------------------------------------- |
| TS in dev                    | separate `tsc` → `dist`, then `require`             | transpiled on import by the Module Runner |
| `.js` vs `.ts` author choice | matters (extension probing, `allowJs`, dist mirror) | invisible — Vite resolves both            |
| Plugin resolution            | `dist.root` vs `app.root`, `package.json` in dist   | one `resolve` graph, source paths         |
| Aliases / `paths`            | duplicated across `tsc` config and Vite config      | one config                                |
| Server reload                | full cluster restart                                | HMR / module invalidation                 |
| Prod                         | `tsc` emit + admin bundler                          | `vite build` per environment              |
| Config files (`config/*.ts`) | `esbuild-register` shim in `node/core/files.ts`     | same runner                               |

---

## 2. Dev architecture

### 2.1 Environments

Vite's Environment API models each target as a named environment with its own
module graph, resolver, and (optionally) a runtime. Strapi maps cleanly to two:

- **`client`** — the admin React app. Browser consumer. This is essentially
  what `vite/config.ts` builds today, just renamed into the `environments`
  object.
- **`server`** — the Strapi Koa backend. Node consumer, run **in-process** via a
  `RunnableDevEnvironment` whose `runner` is a `ModuleRunner`.

(One could add more — e.g. a separate `admin-ssr` environment if Strapi ever
server-renders the admin shell — but two is the baseline.)

### 2.2 One Vite server hosting both

```ts
// imagined packages/core/strapi/src/node/vite/dev-server.ts
import { createServer } from 'vite';

const vite = await createServer({
  root: cwd,
  appType: 'custom',
  server: { middlewareMode: true },
  environments: {
    client: {
      // browser admin — today's resolveBaseConfig() merged here
      build: { outDir: 'dist/build', rollupOptions: { input: adminEntry } },
    },
    server: {
      // node backend — runs in this process by default
      resolve: { conditions: ['node', 'strapi-server'] },
      // dev: modules executed by a ModuleRunner in-process
    },
  },
});
```

Key facts from the current Environment API (Vite 6/7):

- `vite.environments.client` and `vite.environments.server` are
  `DevEnvironment`s. The node one is a `RunnableDevEnvironment` exposing
  `runner: ModuleRunner` (guard with `isRunnableDevEnvironment`).
- `await env.runner.import(url)` returns an instantiated module — same contract
  as the legacy `server.ssrLoadModule(url)`, but per-environment and
  Runner-based. TS/ESM transformed on the fly; no bundling.
- For the admin, `vite.transformIndexHtml` + the existing middleware-mode wiring
  in `vite/watch.ts` carry over almost unchanged.

### 2.3 Booting the Koa server through the runner

Today the worker calls `createStrapi(...).load()` and the loaders `require`
compiled files. In the target, the **entry to the entire server** is imported
through the runner:

```ts
// imagined develop.ts worker path (no more cluster compile step)
const serverEnv = vite.environments.server;
if (!isRunnableDevEnvironment(serverEnv)) throw new Error('server env not runnable');

// The Strapi bootstrap module — its own source, .ts or .js, no dist
const { createStrapiApp } = await serverEnv.runner.import('@strapi/strapi/server-entry');
const strapi = await createStrapiApp({ cwd /* no distDir! */ });
await strapi.load();
```

Inside the loaders, plugin entries load through the **same** runner instead of
`require`:

```ts
// imagined get-enabled-plugins.ts / loaders/plugins/index.ts
// was: const mod = require(join(pathToPlugin, 'strapi-server.js'))
const mod = await serverEnv.runner.import(resolvePluginEntry(pluginName));
//                                          ^ source path, extensionless
```

Consequences, each of which deletes a current workaround:

- **No extension probing.** `runner.import('.../strapi-server')` resolves
  `.ts`/`.js`/`.mjs`/`.tsx` via the environment's `resolve.extensions`. The
  `ADMIN_ENTRY_EXTENSIONS` probe in `plugins.ts` and the `.js` hardcode both
  vanish.
- **No `dist.root` vs `app.root`.** There is no `dist` in dev. Everything
  resolves from source through Vite. The `get-enabled-plugins.ts` change this
  branch made (`app.root` → `dist.root`) becomes moot.
- **No `esbuild-register`.** `node/core/files.ts` currently registers
  `esbuild-register` to load `.ts` config files; the runner does this natively
  for `config/*.ts`, `config/plugins.ts`, etc.
- **No `load-config-file.ts` `switch(extname)`.** Config of any extension loads
  through the runner.

### 2.4 HMR and the death of cluster-restart

Today every server-side change triggers: recompile all TS → `worker.send('kill')`
→ `cluster.fork()` (a cold Strapi boot, DB reconnect, plugin re-register). On a
large project that is multi-second.

With the Module Runner, Vite tracks the server module graph and emits
`vite:beforeUpdate`/`invalidate` events. Strapi could:

- **Coarse mode (phase 1):** treat any server-graph invalidation as "reload"
  and call `strapi.reload()` _in-process_ (no new node process). Still a full
  Strapi re-register, but no cluster fork, no DB process churn beyond what
  reload already does. Strictly faster than today.
- **Fine mode (later):** accept HMR for leaf modules that are safe to swap —
  controllers, services, policies, route handlers — by re-importing just the
  changed module and re-binding it in the registry, leaving the DB pool, server
  socket, and middleware chain intact. Content-type schema changes still force a
  full reload (they touch the DB layer). This is the genuinely new capability.

The current `chokidar` watcher in `develop.ts` is replaced by Vite's own
watcher; the cluster primary/worker split (its main job today is "recompile then
restart") largely disappears. A supervisor may still be wanted for crash
recovery, but not for reload.

### 2.5 What stays

- `create-build-context.ts`'s notion of "which plugins exist, which have admin
  code" stays — but it feeds environment `resolve`/input config instead of a
  webpack/Vite-bundler fork.
- `staticFiles.ts` generating the admin runtime entry stays (it's the `client`
  environment input).
- The Koa app, middleware, document service, DB layer — unchanged. Vite is a
  module loader and transform layer, not a web framework replacement. Koa still
  owns HTTP.

---

## 3. Prod architecture

Dev is the easy, high-value half. Prod is where the trade-offs bite.

### 3.1 `vite build` per environment

Replace "tsc → dist + admin bundler" with **environment builds**:

```ts
// imagined build.ts
await build({ /* ... */ environments: { client: {...} } }); // admin browser bundle → dist/build
await build({ /* ... */ environments: { server: {...} } }); // node server bundle  → dist/server
```

- **client**: same Rollup output Strapi ships today (admin SPA).
- **server**: a Rollup build targeting Node. Two sub-options:
  - **(a) Externalized build** — transpile each server module to `.js`,
    `external` all `node_modules` (and arguably all installed Strapi plugins),
    preserve the module structure (`output.preserveModules`) so the result
    looks much like today's `dist/` but produced by Rollup/esbuild instead of
    `tsc`. Lowest risk; closest to current runtime semantics.
  - **(b) Bundled build** — actually bundle the server into a few chunks.
    Faster cold start, but fights dynamic `require`, plugin discovery at
    runtime, and Strapi's heavy use of runtime resolution. Probably a
    non-starter for the full app; maybe viable for first-party core only.

(a) is the realistic target: Vite/Rollup becomes the _compiler_, replacing
`@strapi/typescript-utils`, while keeping Node's runtime resolution for
`node_modules`.

### 3.2 `strapi start`

```ts
// imagined start.ts
// was: createStrapi({ appDir, distDir }).start()
import('./dist/server/index.js').then((m) => m.start());
```

`start` no longer needs the `isTSProject ? outDir : appDir` dance — there is
always a built `dist/server` (for both JS and TS projects, since Vite handles
both). The "you must run build first" error stays (prod still needs a build).

### 3.3 Trade-offs: bundling a long-running server

This is the crux of prod skepticism.

- **For:** single compiler, native TS, dead-code elimination, consistent output,
  no `tsc` config drift, source maps from the same tool dev uses.
- **Against:**
  - A Koa server runs for **weeks**. Stacktrace/source-map fidelity matters far
    more than for a request-scoped SSR render. Rollup builds must ship accurate
    sourcemaps and Strapi must wire `--enable-source-maps`.
  - Plugin ecosystem ships **CommonJS**. An externalized build tolerates this
    (they stay in `node_modules`, loaded by Node). A bundled build does not.
  - Runtime plugin discovery (`config/plugins` `resolve`, dependency scanning in
    `get-enabled-plugins.ts`) assumes files-on-disk with Node resolution.
    Externalized + `preserveModules` keeps that working; bundling breaks it.
  - EE license checks and any runtime `require` of optional deps need to remain
    external.

Net: prod should **externalize aggressively** and treat Vite/Rollup as a
TS→JS compiler with bundling mostly _off_ for the server. The win there is
"one toolchain," not "smaller server bundle."

---

## 4. Plugin model

### 4.1 Today

- **Installed npm plugins**: discovered by scanning `info.dependencies`
  (`get-enabled-plugins.ts`), `require.resolve`d by package name, loaded from
  their own published `dist` via `exports['strapi-server']`.
- **Local plugins**: declared in `config/plugins` with a `resolve` field. The
  `resolve` string is the _only_ signal Strapi has that the plugin exists.
  `require.resolve(resolve)` is tried (works for package names), else a
  filesystem fallback (`resolve(dirs.dist.root, declaration.resolve)` after this
  branch). Needs a `package.json` at the resolved dir.
- **Dual entry**: `strapi-server.*` (node) and `strapi-admin.*` (browser),
  resolved by two different mechanisms (server loader vs
  `getMapOfPluginsWithAdmin`).

This is why `src/plugins/x` works but `packages/my-plugin` is fragile, and why
`package.json`-in-`dist` is a problem: it's all Node-resolution-against-a-
compiled-tree plumbing.

### 4.2 Under Vite environments

The `resolve` field becomes an **input to two environment resolvers**:

- `strapi-server` entry → resolved + transformed by the **server** environment.
- `strapi-admin` entry → resolved + transformed by the **client** environment
  (already the case for admin).

Both resolve from **source**, both handle any extension, neither needs a
compiled tree. So:

- **`src/plugins/x` vs `packages/my-plugin`** stops mattering for _dev_ — both
  are just paths Vite resolves. A monorepo `packages/my-plugin` works if it's on
  an alias or workspace resolution, exactly like any other source import.
- **The `package.json`-in-`dist` problem disappears** in dev (no dist) and, in
  prod, is governed by whether the build externalizes the plugin (then its real
  `package.json` is used) or includes it (then metadata is read at build time).
- **Extension probing disappears** — `runner.import('.../strapi-admin')` and
  `.../strapi-server` resolve `.ts`/`.tsx`/`.js` uniformly.

The one thing that must stay: `config/plugins` `resolve` as the **declaration**
that a local plugin exists and where its entry lives. Vite resolves it; Strapi
still needs the registration intent. A nice simplification: a single
`resolve` could point at a plugin root, and Strapi asks each environment to
resolve `<root>/strapi-server` and `<root>/strapi-admin` — no per-extension,
per-tree logic.

### 4.3 CommonJS plugins

A large fraction of community plugins are CJS, published with a built `dist`.
The server environment's Module Runner must continue to load these via Node's
CJS interop (they're `external` / in `node_modules`). This is a hard constraint:
**the migration cannot require every plugin to be ESM/TS.** Externalizing
`node_modules` in both dev (don't run third-party `dist` through the runner;
let Node `require` it) and prod is mandatory.

---

## 5. Migration path

Phased, each phase shippable and reversible.

### Phase A — admin already on Vite (done)

`vite/{config,build,watch}.ts` already exist. Formalize the admin as the
`client` environment in the Environment API config object. Mostly a refactor;
no behavior change. Establishes the `environments` structure.

### Phase B — server environment in **dev only**, behind a flag

- Add a `server` environment; introduce a `--runtime=vite` (or
  `experimental.viteServer`) flag on `strapi develop`.
- When on: boot the server through `environments.server.runner.import(...)`,
  load plugin/config entries through the runner, drop the per-change cluster
  restart in favor of `strapi.reload()` (coarse HMR).
- When off: today's `tsc` + cluster path, untouched.
- **Prod stays on `tsc`→`dist`** in this phase. `strapi build`/`start`
  unchanged.
- Backward-compatible: default off. EE features run identically (they're just
  modules the runner imports). This phase alone **kills the dev-side class of
  bugs** (the entire reason this branch exists) for opted-in users.

What breaks / to watch in B:

- `node/core/files.ts` `esbuild-register` shim becomes redundant when the flag
  is on — needs a branch.
- The cluster primary/worker code in `develop.ts` needs a parallel
  non-cluster path.
- Any code that reads `strapi.dirs.dist.*` at runtime must tolerate "no dist in
  dev."

### Phase C — prod through `vite build`

- `strapi build` gains a `server` environment build (externalized,
  `preserveModules`). `strapi start` imports the built server entry.
- Deprecate the `@strapi/typescript-utils` compile path once parity is proven
  (keep it for a major version as fallback).
- This is the riskiest phase (section 3 trade-offs). Gate behind the same flag
  graduating to default only after wide testing.

### Phase D — remove the old toolchain _and the lifecycle commands_

- Drop the `tsc`-to-`dist` server pipeline and the dual-bundler (webpack)
  admin path. One toolchain. Major version boundary.
- **Remove `strapi develop` / `strapi build` / `strapi start`.** They are now
  `vite` / `vite build` / `node dist/server.js` (§8.6). The thin back-compat
  aliases kept through phases B–C are deleted here. The Strapi CLI is left with
  only non-serving commands (codegen, admin-user, EE, scaffold).

EE considerations throughout: license gating is runtime; as long as the EE
modules are imported through the same runner/build and not tree-shaken away
incorrectly, no special handling — but the **bundled** prod option (3.1b) could
DCE-eliminate dynamically-referenced EE code, another reason to externalize.

---

## 6. Risks / open questions

1. **Module Runner maturity.** The Environment API is stable in Vite 6 but the
   surface is young; `ssrLoadModule` is legacy-but-not-removed, and patterns for
   a _long-running_ node server (vs request-scoped SSR) are under-documented.
   Most published examples are SSR render loops, not "host a framework's whole
   backend for weeks." Real risk of hitting unpolished edges.
2. **Externalizing `node_modules` correctly.** Getting the
   external/noExternal boundary right is notoriously fiddly (it's the perennial
   pain of Vite SSR / Nuxt / SvelteKit). Strapi's deep dependency tree + CJS
   plugins make this the single biggest practical hazard.
3. **Source-map / stacktrace fidelity over weeks of uptime.** A resident server
   must produce correct stacktraces for support/debugging. Runner-executed and
   Rollup-built code both need airtight sourcemaps and `--enable-source-maps`;
   regressions here are silent until an incident.
4. **Resident Vite server cost in dev.** Keeping a Vite server alive inside the
   backend process adds memory and a transform pipeline to every dev boot.
   Likely fine, but needs measuring against the current cluster model on large
   apps.
5. **Koa middleware ordering & lifecycle.** Strapi's register→bootstrap→start
   lifecycle and middleware ordering must survive HMR. Fine-grained HMR that
   re-binds a controller mid-flight risks subtle ordering/state bugs; coarse
   reload is safer but gives up much of the benefit.
6. **Cluster/worker model.** `develop.ts` uses `cluster` mainly to "recompile
   then restart." Removing it changes crash-recovery behavior; need a
   supervisor story.
7. **CommonJS ecosystem.** Cannot break CJS plugins. Hard external constraint
   (section 4.3).
8. **`ssrLoadModule` deprecation timeline.** Build on `environments.*.runner`
   /`createServerModuleRunner` and `vite/module-runner`, not the legacy API, to
   avoid building on a deprecated surface.
9. **Is `vite-node` needed?** Probably not — it predates the Environment API and
   the built-in Module Runner now covers its use case. Avoid adding it; prefer
   first-party `vite/module-runner`.
10. **Two databases of truth for resolve.** During phases B/C, both `tsc`
    config and Vite resolve config exist; alias drift between them is a
    transitional hazard until phase D removes `tsc`.

---

## 7. Relation to the current branch

The `fix/local-ts-plugin-support` branch makes five changes. Under the target
architecture:

| Branch change                                                                        | Fate under Vite environments                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get-enabled-plugins.ts`: resolve local plugins from `dirs.dist.root` not `app.root` | **Superseded.** No `dist` in dev; the server env resolves from source. The whole `dist.root` vs `app.root` question evaporates.                                                                                                                   |
| tsconfig templates: narrow `src/plugins/**` exclude so server `.ts` compiles         | **Superseded.** No `tsc` step; Vite transforms plugin `.ts` on import. The tsconfig becomes type-checking-only (IDE + `tsc --noEmit` in CI), not an emit pipeline.                                                                                |
| `allowJs: true` in server tsconfig                                                   | **Superseded** (as an _emit_ concern). `allowJs` would remain only as a _type-checking_ convenience, not because emit depends on it.                                                                                                              |
| `plugins.ts`: probe `strapi-admin.{js,mjs,ts,tsx,jsx}`                               | **Superseded.** `runner.import('.../strapi-admin')` resolves extensions natively; the probe list is deleted.                                                                                                                                      |
| `get-enabled-plugins.ts`: tolerant `package.json` fallback                           | **Mostly superseded.** No `dist` to be missing in dev. In prod, plugin metadata comes from the externalized package's real `package.json` (or build-time read). The tolerant fallback may survive as defensive code but stops being load-bearing. |

**Concepts that carry over:**

- `config/plugins` `resolve` as the local-plugin **declaration** — still needed;
  it's how Strapi knows a non-dependency plugin exists.
- `getMapOfPluginsWithAdmin`'s "which plugins have admin code" — still needed as
  the `client` environment's input selection.
- `create-build-context.ts` plugin enumeration — still needed to configure
  environment resolve/inputs.
- The dual `strapi-server` / `strapi-admin` entry convention — unchanged; it
  just maps onto two environments instead of two loaders.

**Bottom line:** this branch is the right _tactical_ fix for today's
architecture, and it should ship. The Vite Environment API is the _strategic_
move that would have made the bug impossible. They are not in conflict — the
branch buys correctness now; the environment migration (phased, flag-gated)
would later delete the machinery the branch had to patch.

---

## 8. Target shape: Vite-plugin dev, single-file Node prod

Sections 2–3 describe Strapi _owning_ `createServer()` with an inline
`environments` literal. This section refines that into the concrete shape we
actually want: **dev runs through a `strapi()` Vite plugin; prod is a single
`node dist/server.js`; a Strapi CLI owns everything else.** The Environment API
is the mechanism; it is packaged as a plugin, not hand-wired config.

### 8.1 Three modes, one mental model

| Mode                | Owner                     | Mechanism                                                                | Artifact                                |
| ------------------- | ------------------------- | ------------------------------------------------------------------------ | --------------------------------------- |
| **dev**             | Vite                      | `strapi()` plugin — `client` + `server` environments, Module Runner, HMR | (none — in-process)                     |
| **build**           | Strapi CLI → `vite build` | one build per environment                                                | `dist/build` (admin) + `dist/server.js` |
| **prod**            | Node                      | `node dist/server.js`                                                    | —                                       |
| **everything else** | Strapi CLI                | generate, console, ts:generate-types, admin user, EE                     | —                                       |

The key inversion from a naive "Strapi is a Vite app": **Vite owns dev, Node
owns prod, the CLI owns the rest.** Vite is never present at prod runtime.

**End state — the three lifecycle commands disappear entirely.** Once Strapi is
genuinely just a Vite plugin plus a runnable bundle, `strapi develop`,
`strapi build`, and `strapi start` have no reason to exist — they are exactly
`vite`, `vite build`, and `node dist/server.js`. The Strapi CLI sheds its three
largest commands and keeps only what has nothing to do with serving (codegen,
admin-user, EE, scaffold). See §8.6. (Thin aliases survive the transition for
back-compat and are dropped at phase D — §5.)

### 8.2 The `strapi()` Vite plugin (dev)

A single plugin contributes both environments and boots the backend in-process.
It leans on Vite 6/7 per-environment plugin hooks rather than a static
`environments` object:

```ts
// Illustrative only — not an API contract.
// imagined packages/core/strapi/src/node/vite/plugin.ts
import type { Plugin } from 'vite';
import { isRunnableDevEnvironment } from 'vite';

export function strapi({ cwd }: { cwd: string }): Plugin {
  let strapiApp: Strapi;
  return {
    name: 'strapi',

    // Declare the two environments + their resolution rules.
    configEnvironment(name) {
      if (name === 'server') {
        return { resolve: { conditions: ['node', 'strapi-server'] } };
      }
      if (name === 'client') {
        return {
          /* today's resolveBaseConfig() for the admin SPA */
        };
      }
    },

    // Boot Koa through the server environment's Module Runner, then mount it.
    async configureServer(server) {
      const env = server.environments.server;
      if (!isRunnableDevEnvironment(env)) throw new Error('server env not runnable');

      const { createStrapiApp } = await env.runner.import('@strapi/strapi/server-entry');
      strapiApp = await createStrapiApp({
        cwd, // no distDir — source only
        importModule: (id: string) => env.runner.import(id), // loaders use this
      });
      await strapiApp.load();

      // Vite middlewares serve /admin assets + HMR client; Koa serves the API.
      server.middlewares.use(server.middlewares); // (client env, transformIndexHtml)
      const koa = strapiApp.server.app;
      return () => server.middlewares.use((req, res) => koa.callback()(req, res));
    },

    // Server-graph change → reload. Admin HMR is Vite's default for `client`.
    hotUpdate({ environment, server }) {
      if (environment.name === 'server') {
        strapiApp.reload(); // coarse (phase 1); targeted re-bind later
        return []; // we handled it; suppress client HMR
      }
    },
  };
}
```

What this deletes (vs sections 2.3 / 4): extension probing, `dist.root` vs
`app.root`, `esbuild-register`, `load-config-file.ts`'s `switch(extname)`. The
loaders call `importModule(id)` (the runner) instead of `require`, so `.ts`,
`.tsx`, `.js`, `.mjs` plugin/config entries all resolve from source uniformly.

### 8.3 `strapi develop` is a thin wrapper

`strapi develop` runs Vite programmatically with the `strapi()` plugin so the
familiar command keeps working — but because it is _just a plugin_, a plain
`vite` with a user `vite.config.ts` (`plugins: [strapi()]`) works too. Users get
the standard Vite config surface: they can add `vite-tsconfig-paths`, `svgr`,
etc. to the same array, instead of Strapi's bespoke admin-Vite extension points.

```ts
// imagined cli/commands/develop.ts
import { createServer } from 'vite';
const vite = await createServer({
  root: cwd,
  appType: 'custom',
  server: { middlewareMode: false }, // Vite owns the dev HTTP listener
  plugins: [strapi({ cwd })],
});
await vite.listen();
```

### 8.4 Build → single `dist/server.js`

`strapi build` runs two environment builds:

- **client** → `dist/build` — the admin SPA, unchanged from today's output.
- **server** → **single-file `dist/server.js`** whose default export / top-level
  boots `strapi.start()`. Rollup config:
  - **`external`: all `node_modules` _and_ all installed Strapi plugins.** They
    stay on disk as published (mostly CJS) and are `require`d by Node at runtime.
    This is the §4.3 hard constraint — the build must never try to bundle the CJS
    plugin ecosystem.
  - **inline local plugins** (`src/plugins/*` _server_ code) into the bundle —
    they are app source, not dependencies. Their `package.json` metadata is read
    at **build time**, which is what finally kills the `package.json`-in-`dist`
    bug class (there is no `dist` plugin tree to look in).
  - **EE code stays external / explicitly kept** — never DCE-eliminated, since
    license gating references it dynamically.
  - **accurate sourcemaps** emitted; prod is launched with `--enable-source-maps`
    (§6.3 — a server runs for weeks; stacktrace fidelity is non-negotiable).

Build-time plugin enumeration already exists (`create-build-context.ts`) — it
tells the server build which local plugins to inline and which installed plugins
to externalize.

### 8.5 Prod → `node dist/server.js`

```bash
node dist/server.js          # the whole backend; no Vite, no tsc, no dist tree
```

One file plus `node_modules`. There is **no parallel compiled source tree**, so
`dirs.dist.root` vs `dirs.app.root`, extension probing, and
`package.json`-in-`dist` simply don't exist at runtime — strictly cleaner than
today's `tsc`-mirror, not merely equivalent. Installed-plugin discovery still
works because installed plugins are external and Node-resolved at runtime; local
plugins are already inlined.

### 8.6 CLI scope — what's left after the lifecycle commands die

End state: **no `strapi develop`, no `strapi build`, no `strapi start`.** They
are standard tooling:

| Old command      | Becomes               | Notes                                                  |
| ---------------- | --------------------- | ------------------------------------------------------ |
| `strapi develop` | `vite`                | plugin boots the server env in-process (§8.2)          |
| `strapi build`   | `vite build`          | Builder API emits both `dist/build` + `dist/server.js` |
| `strapi start`   | `node dist/server.js` | no flags needed — see below                            |

So `node dist/server.js` is a _bare_ invocation:

- **Sourcemaps without a flag** — the server bundle calls
  `process.setSourceMapsEnabled(true)` at its top, so no `--enable-source-maps`
  on the command line. Pure `node dist/server.js` gets accurate stacktraces.
- **Pre-start work** (DB migrations, health checks) runs inside the server entry
  on boot, not in a CLI wrapper.
- **Supervision** (crash recovery, restart) is the deploy platform's job —
  container restart policy / systemd / PM2 — not a Strapi command. The old
  `cluster` supervisor existed mainly to "recompile then restart" (§6.6); with
  compile-on-import and no restart-on-change, it has no remaining purpose.

What the Strapi CLI **keeps** (none touch Vite or serving): `generate`,
`console`, `ts:generate-types`, admin-user commands, EE tooling, project
scaffolding.

### 8.7 Open decisions

1. **`vite build` building both environments** — relies on the Vite Builder API
   (`createBuilder` / `build.app`) so a single `vite build` walks every
   environment. The `strapi()` plugin wires this; confirm the Builder API is
   stable enough in the target Vite version, else `build` temporarily stays a
   thin two-call wrapper.
2. **Local-plugin inlining granularity** — one chunk, or `preserveModules` for
   just the local-plugin subtree? Single-file is the stated goal; revisit only if
   sourcemap/debug ergonomics suffer.

---

## 9. Separated, portable deployment (Fork A: Node-anywhere)

Target: admin and server are **independent deployables**, each runnable on
commodity infrastructure. Scope is **Fork A — any host that runs Node**
(Cloudflare Containers, Fly, Render, Railway, Docker, a VPS). True edge/Workers
(Fork B — V8 isolates, web-standard runtime) is explicitly _out of scope_ here;
see 9.5.

### 9.1 Two independent axes

- **Separation** — admin and server are different artifacts that need not ship
  together. Easy: §8's build already emits `dist/build` (static) and
  `dist/server.js` (Node) as distinct outputs.
- **Portability** — each artifact runs on generic infra. Easy for Fork A: a
  static bundle and a Node process are the two most portable things there are.

### 9.2 Admin: static, deploy anywhere

The `client` build (`dist/build`) is a plain SPA — deploy to any CDN, S3,
Netlify, **Cloudflare Pages**, or behind the server itself. The only coupling to
the server is the **API base URL**. Decouple it:

- Admin reads its API origin from **runtime config** (a small injected
  `window.strapi` config blob, or a build-time `VITE_STRAPI_API_URL`), not a
  hardcoded same-origin assumption. Strapi already has partial admin-URL config;
  formalize it so the _same_ admin bundle can point at any server origin.

Result: ship the admin once to a CDN; repoint it at staging/prod servers without
rebuilding.

### 9.3 Server: a portable Node artifact

`dist/server.js` + `node_modules` is the entire deployable. Containerize it:

```dockerfile
# Illustrative.
FROM node:22-slim
WORKDIR /app
COPY package.json node_modules ./node_modules        # external deps (incl CJS plugins)
COPY dist ./dist
CMD ["node", "--enable-source-maps", "dist/server.js"]
```

Runs identically on Cloudflare Containers, Fly, Render, a VM — nothing
Strapi-specific about the host. The server exposes the REST/GraphQL API; the
admin (wherever it lives) calls it over HTTP with CORS configured for the admin's
origin.

### 9.4 Environments are the deploy-target seam

Modeling targets as Vite environments means _deploy target = environment_, which
keeps the door open without committing to edge now:

| Env                              | Target    | Output           | Build style                          | Runs on            |
| -------------------------------- | --------- | ---------------- | ------------------------------------ | ------------------ |
| `client`                         | admin SPA | `dist/build`     | Rollup, browser                      | any CDN / Pages    |
| `server`                         | Node API  | `dist/server.js` | single-file, **deps external**       | any Node host      |
| `server-edge` _(future, Fork B)_ | Worker    | worker bundle    | **bundled**, workerd-compatible only | Cloudflare Workers |

Note the Node vs edge builds are fundamentally different (external-deps
single-file vs fully-bundled workerd) — which is exactly why they are _separate
environments_ rather than one build with a flag.

### 9.5 What Fork A tolerates that Fork B would not

For Fork A these are non-issues — Node runs them everywhere. They are listed so
the **seam stays edge-capable later** and we don't accidentally couple harder:

- **Native deps** — `better-sqlite3`, `sharp`. Fine on any Node host; fatal on
  workerd. Keep them external and swappable (provider interfaces already abstract
  uploads/image).
- **Filesystem** — local upload provider, SQLite file, any runtime `fs` use.
  Fine on Node; absent on edge. Already abstracted behind providers.
- **DB drivers** — TCP to Postgres/MySQL is fine on Node; edge needs
  HTTP/binding drivers (D1, Hyperdrive, Turso). Don't hardcode TCP assumptions
  outside the `@strapi/database` driver layer.
- **Resident process / `cluster`** — fine on Node; edge is request-scoped.

None of these block Fork A. They are the Fork B (edge) backlog, captured so the
architecture doesn't regress portability.

### 9.6 Edge (Fork B) — explicitly later, possibly hybrid

True Workers deployment needs a runtime-agnostic core: **Koa → web-standard
`Request`/`Response`**, HTTP/binding DB drivers, no native deps, no runtime `fs`,
no resident process. That is a multi-year core re-architecture, not part of this
plan. If pursued, the sane product shape is **hybrid**: a read-only content API
at the edge (cache/delivery) with admin + writes on a Node origin — not the full
backend on workerd. Out of scope for Fork A; documented so the environment seam
(9.4) is built with it in mind.

---

## 10. Resolution out of runtime config

`config/plugins.{js,ts}` today crams two unrelated concerns into one runtime
file. The `resolve` field is a **toolchain** concern (where a local plugin's code
lives on disk) living inside a **runtime** file — and it is the single signal
Strapi has that a non-dependency plugin exists (§4.1/4.2). Worse, that path
string must be valid in **both** the dev source tree and the prod `dist` tree
simultaneously. That dual-validity requirement _is_ the dev↔prod coupling, and it
is precisely what the `fix/local-ts-plugin-support` branch had to patch
(`dist.root` vs `app.root`, `package.json`-in-`dist`, extension probing).

### 10.1 The split: existence/location vs enabled/options

| Field                              | Concern                  | Resolved when | Env-dependent         |
| ---------------------------------- | ------------------------ | ------------- | --------------------- |
| `enabled`                          | runtime                  | boot          | yes (`env.bool(...)`) |
| `config: {...}` (options, secrets) | runtime                  | boot          | yes                   |
| **`resolve`**                      | **toolchain (location)** | **build**     | **no**                |

The guiding principle: **existence + location are build-time; enabled + options
are runtime.** A plugin can be _known_ (present in the build manifest) yet
_disabled_ (runtime flag). These are different lifecycles and belong in different
files.

### 10.2 Where `resolve` goes instead

**(a) Convention — autodiscover `src/plugins/*`.** Nearly every `resolve` today
points at `./src/plugins/<name>`. Make that the convention and the field vanishes
for the common case: the `strapi()` plugin globs `src/plugins/*` and registers
each.

**(b) Explicit, non-standard locations → the Vite layer.** A monorepo
`packages/my-plugin` (or any path outside `src/plugins`) is declared in
`vite.config.ts` — a _build_ file — not in runtime config:

```ts
// vite.config.ts — build-time, dev=prod-agnostic
import { defineConfig } from 'vite';
import { strapi } from '@strapi/vite-plugin';

export default defineConfig({
  plugins: [
    strapi({
      // Only needed for locations the convention doesn't cover.
      plugins: { 'my-plugin': '../../packages/my-plugin' },
    }),
  ],
});
```

Resolution now lives in the layer whose job _is_ resolution. The Vite resolver
(plus the convention glob) knows where everything is — there is no reason for a
runtime config file to also know.

### 10.3 Build emits a resolved manifest (or inlines)

At build, the `strapi()` plugin enumerates local plugins
(`create-build-context.ts` already does this) and either:

- **inlines** each local plugin's `strapi-server` code into `dist/server.js`
  (§8.4) — the default for the single-file target; or
- emits a small **resolved manifest** (`dist/plugins.json`) mapping plugin name →
  resolved entry, for any plugin not inlined.

Either way, the _resolved_ result is baked at build time. Plugin `package.json`
metadata is read then, too — which is what finally retires the
`package.json`-in-`dist` problem (there is no runtime `dist` plugin tree to read
from).

### 10.4 `config/plugins.ts` becomes pure runtime data

```ts
// Before — toolchain path leaks into runtime config:
export default ({ env }) => ({
  'my-plugin': {
    enabled: true,
    resolve: './src/plugins/my-plugin', // <-- must be valid in src AND dist
    config: { foo: env('FOO') },
  },
});

// After — runtime only, no path strings:
export default ({ env }) => ({
  'my-plugin': {
    enabled: env.bool('MY_PLUGIN', true),
    config: { foo: env('FOO') },
  },
});
```

### 10.5 Runtime registry reads the manifest, never `resolve`

- **Dev:** entries are resolved live by the Vite graph (`runner.import` against
  the convention glob + explicit `vite.config.ts` declarations).
- **Prod:** the baked manifest + inlined modules.

Neither path needs a string valid in both trees. **`resolve` only needs to be
valid at build time**, where the source actually exists. The dev↔prod tie is cut
at the source.

### 10.6 Why this is the real fix

The branch's five patches all chase "make the `resolve` path resolve correctly in
`dist`." This deletes the requirement instead: resolution happens **once, at
build, in the layer that owns resolution.** A secondary win — with `resolve`
gone, `config/*` files are pure runtime _data_, so they load anywhere with no
transpile gymnastics (no `esbuild-register`, no `switch(extname)`; §2.3).

### 10.7 Scope and migration

- **Local plugins only.** Installed npm plugins use the dependency scan (§4.1),
  untouched.
- **Custom middleware / policy paths** in `config/middlewares.ts` are the same
  class of leak (a toolchain path in a runtime file) but minor — most are
  resolved by name. Same treatment applies if pursued; separate pass.
- **Migration:** keep reading `resolve` with a deprecation warning that
  auto-maps it to the convention / `vite.config.ts` declaration, then drop it at
  the phase D boundary (§5).

---

## 11. `strapi.config.ts` — the dev/build config

A root `strapi.config.ts` makes sense, scoped to **one job: Strapi's dev and
build (toolchain) configuration.** It is _not_ a merge of the runtime `config/*`
directory and it holds no runtime/env data. It is the static, env-agnostic source
of truth for how `vite` (dev) and `vite build` behave, and it is the home for
everything §10 pushed out of runtime config.

### 11.1 Three config layers, three files — no overlap

| Layer                     | File(s)                        | Read by                         | Env-dependent | Contents                                                                       |
| ------------------------- | ------------------------------ | ------------------------------- | ------------- | ------------------------------------------------------------------------------ |
| **dev/build (toolchain)** | **`strapi.config.ts`**         | Vite plugin + CLI build tooling | no            | plugin locations, environments/targets, build & dev-server options, aliases    |
| **runtime**               | `config/*.ts` + `config/env/*` | boot                            | yes           | `database`, prod `server`, `admin`, plugin `enabled`/options, middleware order |
| **secrets**               | `.env`                         | both                            | yes           | keys, URLs, connection strings                                                 |

The rule from §10 generalizes: **toolchain config is static and lives in
`strapi.config.ts`; runtime config is env-dependent and stays in `config/*`.**

### 11.2 What goes in it

- **Local plugin locations** — the §10 extractions. Convention covers
  `src/plugins/*`; explicit entries only for non-standard paths.
- **Environments / deploy targets** — `client`, `server`, future `server-edge`
  (§9.4).
- **Build options** — output dirs, sourcemaps, the externalize/inline policy
  (§8.4: deps + installed plugins external, local plugins inlined), single-file
  vs `preserveModules`.
- **Dev-server options** — port, host, https, proxy, `open` (the _Vite_ dev
  server — see the caveat in 11.5).
- **Admin build** — base path, and a passthrough for raw Vite plugins/options.

What stays out: anything in the runtime or secrets rows above.

### 11.3 Shape, and its relationship to `vite.config.ts`

`strapi.config.ts` is pure data behind a typed `defineStrapi` helper. The
`strapi()` Vite plugin auto-loads it, so a `vite.config.ts` is **optional** — it
becomes the escape hatch where power users compose other Vite plugins.

```ts
// strapi.config.ts — the file users actually edit
import { defineStrapi } from '@strapi/core';

export default defineStrapi({
  plugins: { 'my-plugin': '../../packages/my-plugin' }, // non-standard locations only
  build: { sourcemaps: true, server: { singleFile: true } },
  server: { port: 1337 }, // DEV server (Vite) — see 11.5
});

// vite.config.ts — OPTIONAL escape hatch; strapi() auto-reads strapi.config.ts
import { defineConfig } from 'vite';
import { strapi } from '@strapi/vite-plugin';
import svgr from 'vite-plugin-svgr';

export default defineConfig({ plugins: [strapi(), svgr()] });
```

Why a dedicated file rather than only `strapi()` options inline: the CLI's
**non-Vite** commands (`ts:generate-types`, scaffolding, codegen) need the
project definition — which plugins exist, where — _without booting Vite_. A
pure-data `strapi.config.ts` is a clean shared source of truth for both; having
the CLI parse `vite.config.ts` (which can be a function full of Vite internals)
is not.

### 11.4 Consumed by two readers

- **The `strapi()` Vite plugin** — turns it into `configEnvironment` /
  `configureServer` / build settings (§8.2, §8.4).
- **The Strapi CLI** — reads it directly for codegen, type generation, and
  scaffolding, with no Vite in the process.

### 11.5 Caveat: two different "servers"

`strapi.config.ts`'s `server` block configures the **Vite dev server** (port,
host, https for local development). The **runtime** Koa server (prod host/port,
public `url`, proxy trust) stays in `config/server.ts`. They are different
servers with different lifecycles; do not merge them. If the naming collision is
confusing, name the toolchain one `devServer`.

### 11.6 Relation to the rest of the doc

`strapi.config.ts` is where §9.4's environments-as-targets are declared, where
§10's plugin locations land, and what §8's `strapi()` plugin and the slimmed-down
CLI both read. It is the static half of the configuration story; `config/*` is
the runtime half.

---

## 12. Verification addendum (2026-06-22)

Facts checked against vite.dev and the codebase while writing the implementation
plan set ([`../plans/2026-06-22-vite-environments-migration/`](../plans/2026-06-22-vite-environments-migration/README.md)).
Corrections to earlier sections:

- **Vite version reality.** The repo pins **`vite@5.4.21`** — Vite 5 has **no**
  Environment API. Latest stable is **Vite 8.0.16** (Rolldown bundler). The note's
  "Vite 6/7" was aspirational. A **Vite 5→8 upgrade (Phase 0)** is a hard
  prerequisite, added to the plan set.
- **Environment API is RC, not stable** even in Vite 8. Config/runtime shapes are
  held stable between majors (safe to build on), but `hotUpdate`, `ssrLoadModule`
  removal, and "SSR via ModuleRunner" are "future major" and Vite says **don't
  migrate yet** for HMR hooks. → use `handleHotUpdate` (§2.4/§8.2 overstated
  `hotUpdate`); wrap the runner behind a thin abstraction.
- **§8.7 open decision 1 RESOLVED.** `createBuilder().buildApp()` builds all
  environments; a single `vite build` does so with a `builder` config / `--app`.
  So `strapi build` → one Builder call is viable.
- **`strapi.reload()` is cluster-coupled** (`reloader.ts:18` = `process.send('reload')`),
  **not in-process** as §2.4 assumed. Phase B must build a new in-process reload —
  its largest deliverable.
- **`RunnableDevEnvironment` is type-only** (issue #18998, since fixed); use
  `isRunnableDevEnvironment` / `createServerModuleRunner` as the runtime values.
  The note's imports already do this.
- **Two long-running-server landmines** (from the docs): first `runner` access
  mutates process globals (`setSourceMapsEnabled`/`Error.prepareStackTrace`);
  after a full-reload the runner **overrides a module's `exports`** — never cache
  `exports`, re-`import()`. Both shape the Phase B reload design.
- **`@cloudflare/vite-plugin`** (Fork B, §9.6) is real: v1.42.1, workerd
  environment, peer `vite ^6||^7||^8`. Still out of scope here.

---

## Appendix — sketch: dev server wiring

```ts
// Illustrative only — not an API contract.
import { createServer, isRunnableDevEnvironment } from 'vite';
import Koa from 'koa';

export async function developViteRuntime({ cwd }: { cwd: string }) {
  const vite = await createServer({
    root: cwd,
    appType: 'custom',
    server: { middlewareMode: true },
    environments: {
      client: {
        /* admin browser config (today's resolveBaseConfig) */
      },
      server: { resolve: { conditions: ['node', 'strapi-server'] } },
    },
  });

  const serverEnv = vite.environments.server;
  if (!isRunnableDevEnvironment(serverEnv)) throw new Error('server env not runnable');

  // Boot Strapi itself through the runner (its own source, .ts or .js)
  const { createStrapiApp } = await serverEnv.runner.import('@strapi/strapi/server-entry');

  const strapi = await createStrapiApp({
    cwd,
    // loaders import plugin/config entries via serverEnv.runner.import(...)
    importModule: (id: string) => serverEnv.runner.import(id),
  });
  await strapi.load();

  // Admin served via Vite middleware (client env), like today's vite/watch.ts
  const app: Koa = strapi.server.app;
  app.use(async (ctx, next) => {
    // vite.middlewares handles /admin assets + HMR client
    await next();
  });

  // Server HMR: invalidations → strapi.reload() (coarse) or targeted re-bind (fine)
  serverEnv.hot?.on('vite:afterUpdate', () => strapi.reload());

  return { vite, strapi };
}
```

```ts
// Illustrative loader change — extension/dist concerns gone.
async function loadPluginServer(pluginName: string, runnerImport: (id: string) => Promise<any>) {
  const entry = resolvePluginEntry(pluginName, 'strapi-server'); // source path, extensionless
  const mod = await runnerImport(entry);
  return mod.default ?? mod;
}
```
