# Phase C — Production via `vite build` (milestone plan)

> **For agentic workers:** This is a **milestone-level** plan, not step-level.
> Per the writing-plans skill's no-placeholder rule, its bite-sized TDD steps are
> deliberately **deferred** until the Detail-after gate below is satisfied — the
> exact build code depends on what Phase B proves about the runner/runtime model
> and on prototyping README assumption 5 (single-file externals resolution).
>
> Global constraints: [`README.md`](./README.md#global-constraints).
> **Prerequisite: Phase B Task 7 green + Spike results recorded.**

**Goal:** Produce production output via the Vite **Builder API** — a single-file
`dist/server.js` (Node, deps externalized, local plugins inlined) plus the admin
SPA — and make `strapi start` run `node dist/server.js`.

**Architecture:** `createBuilder().buildApp()` builds both environments. `client`
→ `dist/build` (admin SPA, as today). `server` → Rolldown build, single entry that
boots `strapi.start()`, with `node_modules` + installed plugins `external` and
local plugins inlined. Sourcemaps on; the bundle enables them itself
(`process.setSourceMapsEnabled(true)`) so `node dist/server.js` needs no flags.

## Vite facts (verified 2026-06-22)

- `createBuilder()` / `builder.buildApp()` builds all environments;
  `builder.build(env)` builds one. A single `vite build` builds all envs only with
  a `builder` config present or `--app`. ([frameworks guide](https://vite.dev/guide/api-environment-frameworks))
- Vite 8 uses **Rolldown** — `rollupOptions` has a compat layer; `output.format`,
  `external`, `preserveModules` still apply. Validate single-file vs
  `preserveModules` output under Rolldown specifically.
- Builder builds environments **in series** by default (config order).

## Codebase facts (verified 2026-06-22)

- Prod build today: `packages/core/strapi/src/node/build.ts:42-115` — `tsUtils.compile`
  then admin bundler (vite/webpack).
- `strapi start`: `packages/core/strapi/src/cli/commands/start.ts:9-23` —
  `distDir = isTSProject ? outDir : appDir`, hard-errors if TS project lacks
  `dist`, then `createStrapi({ appDir, distDir }).start()`.

---

## Milestones

### C1 — `server` environment build config (externalized)

Add a `server` build to the `strapi()` plugin / `strapi.config.ts`: input = the
server entry (`server-entry.ts` boot), `output.format` = ESM, single file,
`external` = all `node_modules` **and** installed Strapi plugins, **inline** local
`src/plugins/*` server code. Emit sourcemaps; bundle calls
`process.setSourceMapsEnabled(true)` at top. **Deliverable:** `vite build` (server
env) emits a runnable `dist/server.js`. **Test:** `node dist/server.js` boots the
API against the getstarted sandbox.

### C2 — `client` environment build via Builder

Move the admin prod build under `builder.buildApp()` so one `vite build` emits both
`dist/build` and `dist/server.js`. **Deliverable:** single `vite build` produces
both. **Test:** both artifacts present, admin loads from `dist/build`, API runs
from `dist/server.js`.

### C3 — `strapi build` → Builder API

Replace `build.ts`'s `tsUtils.compile` + admin-only bundle with
`createBuilder().buildApp()`. Keep `tsc --noEmit` for type-checking only (not
emit). **Deliverable:** `strapi build` calls the Builder. **Test:** build output
parity with C1+C2; `yarn build` green.

### C4 — `strapi start` → `node dist/server.js`

Change `start.ts` to spawn/exec `node dist/server.js` (drop the
`isTSProject ? outDir : appDir` dance — always `dist/server.js`). Keep the
"build first" error. **Deliverable:** `strapi start` runs the bundle. **Test:**
prod-mode boot + a smoke API request; verify accurate stacktraces (sourcemaps).

### C5 — CommonJS plugin compatibility

Verify an **installed CJS plugin** (e.g. a community plugin in `node_modules`)
loads at runtime from `dist/server.js` (external, Node-required), and a local TS
plugin is correctly inlined. **Deliverable:** both plugin kinds work in prod.
**Test:** a fixture app with one installed CJS plugin + one local TS plugin; both
functional after `node dist/server.js`.

---

## Detail-after gate

Expand C1–C5 into bite-sized TDD steps only once ALL of the following hold:

1. **Phase B Spike results recorded** — runner hosts a resident Strapi, in-process
   reload works. (If the runtime model changed, C's server entry changes with it.)
2. **README assumption 5 prototyped** — a single-file Rolldown bundle with
   externalized `node_modules` actually resolves and boots from an arbitrary cwd.
   Build a throwaway `dist/server.js` from getstarted and run it from `/tmp`.
   Record: ESM vs CJS output, how externals resolve, whether `preserveModules` is
   needed. **This is the riskiest unknown in C** — do it first.
3. **Decision locked:** single-file vs `preserveModules` for local-plugin inlining
   (README/§8.7 open decision 2), chosen from the prototype's debug ergonomics.

Until then, C stays milestone-level — writing step code now would be invention.

## Risks specific to C

- Rolldown is new (Vite 8) — single-file + external + sourcemap behavior may
  differ from Rollup; the prototype (gate item 2) de-risks this.
- Runtime plugin discovery (`get-enabled-plugins.ts`) assumes files-on-disk + Node
  resolution for installed plugins — preserved by externalizing them; verify the
  dependency scan still works against a bundled entry.
- EE license gating references code dynamically — ensure it is `external`/kept, not
  DCE'd. Add an explicit test in C5.

## Execution Handoff

After the Detail-after gate is satisfied, return to the writing-plans skill to
expand C1–C5 into step-level tasks, then proceed to
[`phase-d-remove-old-toolchain.md`](./phase-d-remove-old-toolchain.md).
