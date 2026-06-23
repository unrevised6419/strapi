# Phase 0 — Upgrade admin build to Vite 8 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Global constraints live in [`README.md`](./README.md#global-constraints) — every task implicitly includes them.

**Goal:** Upgrade the Strapi admin bundler from `vite@5.4.21` to `vite@^8`, fixing
all breaking changes, with the existing admin build + tests green — so the
Environment API (Vite 6+) becomes available for Phases A–D.

**Architecture:** No Strapi-architecture change. This is a dependency upgrade of
the admin Vite pipeline (`packages/core/strapi/src/node/vite/*`) plus the
`@vitejs/plugin-react` peer. The existing admin build and `test:front` / e2e
suites are the test harness — a dependency upgrade's "failing test" is the build
or suite breaking under the new version.

**Tech Stack:** Vite 8 (Rolldown/Oxc bundler), `@vitejs/plugin-react`, React 18,
existing `vitest` front tests, Playwright e2e.

## Vite facts (verified 2026-06-22 against vite.dev migration guides)

Breaking changes between v5 and v8 that can touch the admin build:

- **v6:** Node 18 dropped (Strapi is ≥22 — fine). **Sass legacy API removed**
  (modern API only). `splitVendorChunkPlugin` removed.
- **v7:** Node floor 20.19+/22.12+ (fine). **Default build `target` changed** from
  `'modules'` to `'baseline-widely-available'`. Admin sets `target` explicitly via
  `browserslistToEsbuild`, so verify it still applies.
- **v8:** **Rolldown + Oxc** replace esbuild + Rollup. `import.meta.hot.accept(url)`
  must pass an **id**, not a URL. **`define` no longer shares object references**
  per value (affects the admin's `define: { process: {}, 'process.env': ... }`).
  **CJS interop changed** — escape hatch `legacy.inconsistentCjsInterop: true`.
- Sources: [v6 migration](https://v6.vite.dev/guide/migration), [v7 migration](https://v7.vite.dev/guide/migration), [v8 migration](https://vite.dev/guide/migration), [announcing Vite 8](https://vite.dev/blog/announcing-vite8).

## Global Constraints

See [`README.md`](./README.md#global-constraints). Phase-specific:

- Internal `packages/` deps use pinned semver — bump `vite` to an exact `8.x` to
  match repo convention, not a caret, in `package.json` files. Run
  `yarn version:check` after editing any `package.json`.

---

## File Structure

| File                                           | Responsibility                           | Change                                |
| ---------------------------------------------- | ---------------------------------------- | ------------------------------------- |
| `packages/core/strapi/package.json`            | declares `vite` + `@vitejs/plugin-react` | bump versions                         |
| `packages/core/strapi/src/node/vite/config.ts` | admin Vite config (base/prod/dev)        | fix `define`, `target`, plugin opts   |
| `packages/core/strapi/src/node/vite/build.ts`  | prod admin build                         | verify Builder/Rolldown compat        |
| `packages/core/strapi/src/node/vite/watch.ts`  | dev admin middleware server              | verify `middlewareMode`/HMR compat    |
| any admin `*.scss` consumers                   | styles                                   | migrate Sass API only if Sass is used |

---

## Task 1: Bump Vite and the React plugin

**Files:**

- Modify: `packages/core/strapi/package.json` (the `"vite": "5.4.21"` line ~167, and `@vitejs/plugin-react`)

**Interfaces:**

- Produces: a repo resolving `vite@8.x` for `@strapi/admin`'s build, consumed by all later tasks and phases.

- [ ] **Step 1: Find the current Vite-related versions**

Run: `grep -n '"vite"\|plugin-react\|"rollup"\|browserslist-to-esbuild' packages/core/strapi/package.json`
Expected: `"vite": "5.4.21"` and a `@vitejs/plugin-react` entry.

- [ ] **Step 2: Check the React plugin version that supports Vite 8**

Run: `npm view @vitejs/plugin-react peerDependencies.vite dist-tags.latest`
Expected: a latest version whose `peerDependencies.vite` range includes `^8`. Record it.

- [ ] **Step 3: Edit `package.json` to the new pinned versions**

In `packages/core/strapi/package.json`, set `vite` to the exact latest `8.x`
(e.g. `"8.0.16"`) and `@vitejs/plugin-react` to the exact latest that lists
`^8` in its peer range. Keep them pinned (no caret), matching repo convention.

- [ ] **Step 4: Install and check version drift**

Run: `yarn install && yarn version:check`
Expected: install succeeds; `version:check` reports no inconsistency it didn't
report before this change. Resolve any new mismatch it flags.

- [ ] **Step 5: Commit**

```bash
git add packages/core/strapi/package.json yarn.lock
git commit -m "chore(strapi): bump admin bundler to vite 8"
```

---

## Task 2: Make the admin production build pass under Vite 8

**Files:**

- Modify: `packages/core/strapi/src/node/vite/config.ts:12-179` (`resolveBaseConfig`, `resolveProductionConfig`)
- Modify (if needed): `packages/core/strapi/src/node/vite/build.ts:5-14`

**Interfaces:**

- Consumes: `vite@8` from Task 1.
- Produces: a green `yarn nx build @strapi/admin` (Vite/Rolldown prod build of the admin SPA).

- [ ] **Step 1: Run the build to surface breakages (the failing test)**

Run: `yarn nx build @strapi/admin`
Expected: FAIL or warnings under Vite 8. Capture the exact errors/warnings — they
drive the fixes below. (If it passes clean, skip to Step 6.)

- [ ] **Step 2: Fix the `define` object-reference change**

Vite 8 gives each `define` value a separate object copy. The admin config
(`config.ts`, in `resolveBaseConfig`) has:

```ts
define: {
  process: {},
  'process.env': JSON.stringify(ctx.env),
},
```

`'process.env'` is already a JSON string (safe). Verify `process: {}` still
shims correctly under Vite 8; if a runtime `process is not defined` appears in the
built admin, replace the empty-object define with explicit values:

```ts
define: {
  'process.env': JSON.stringify(ctx.env),
  'process.platform': JSON.stringify(''),
  'process.version': JSON.stringify(''),
},
```

- [ ] **Step 3: Verify the build `target` still applies**

In `resolveBaseConfig`, `const target = browserslistToEsbuild(ctx.target);` feeds
`build.target`. Vite 7+ changed the _default_ target, but an explicit `target`
overrides it — confirm the built output still respects `ctx.target`. If
`browserslistToEsbuild` output is incompatible with Rolldown/Oxc target parsing,
pass the browserslist query through Vite's native browser-target support instead.
Expected after fix: build emits without target-parse errors.

- [ ] **Step 4: Migrate Sass only if used**

Run: `grep -rl "\.scss\|\.sass\|preprocessorOptions" packages/core/admin/src packages/core/strapi/src/node/vite || echo "NO SASS"`

- If `NO SASS`: nothing to do.
- Else: remove any `css.preprocessorOptions.scss.api` / `.sass.api` option (legacy
  API removed in v6) and ensure the modern Sass compiler (`sass` ≥1.45) is the
  resolved dependency.

- [ ] **Step 5: Apply the CJS-interop escape hatch only if a CJS import breaks**

If Step 1 surfaced a CJS default-import failure, add to the admin config as a
temporary measure (with a TODO to remove):

```ts
legacy: { inconsistentCjsInterop: true },
```

- [ ] **Step 6: Re-run the build to confirm it passes**

Run: `yarn nx build @strapi/admin`
Expected: PASS, no errors. Note any remaining warnings.

- [ ] **Step 7: Commit**

```bash
git add packages/core/strapi/src/node/vite/config.ts packages/core/strapi/src/node/vite/build.ts
git commit -m "fix(strapi): adapt admin vite config to vite 8 build"
```

---

## Task 3: Make the admin dev (watch) server pass under Vite 8

**Files:**

- Modify (if needed): `packages/core/strapi/src/node/vite/config.ts:181-216` (`resolveDevelopmentConfig`)
- Modify (if needed): `packages/core/strapi/src/node/vite/watch.ts:13-102`

**Interfaces:**

- Consumes: `vite@8`, the fixed prod config from Task 2.
- Produces: a working `develop --watch-admin` dev server (Vite middleware mounted on Strapi's Koa router with HMR).

- [ ] **Step 1: Boot the dev sandbox with admin watch (the failing test)**

Run: `cd examples/getstarted && yarn develop --watch-admin`
Expected: surfaces any `createServer` / `middlewareMode` / HMR incompatibility
under Vite 8. Capture errors. Confirm the admin loads at `/admin` and HMR works
(edit a `.tsx` in `packages/core/admin/src`, see it hot-update).

- [ ] **Step 2: Verify `middlewareMode` + `appType: 'custom'` + HMR-server reuse**

`resolveDevelopmentConfig` sets:

```ts
server: {
  middlewareMode: true,
  hmr: { overlay: false, server: ctx.strapi.server.httpServer },
},
appType: 'custom',
```

These shapes are unchanged in Vite 8 — confirm the HMR client still connects when
sharing `ctx.strapi.server.httpServer`. If the HMR websocket fails to attach,
check Vite 8's `server.hmr.server` handling and adjust.

- [ ] **Step 3: Fix `import.meta.hot.accept` callers if any pass a URL**

Run: `grep -rn "import.meta.hot.accept(" packages/core/admin/src packages/core/strapi/src || echo "NONE"`

- If any call passes a URL string, change it to a module **id** (Vite 8 dropped
  URL support). If `NONE`, skip.

- [ ] **Step 4: Re-run dev to confirm**

Run: `cd examples/getstarted && yarn develop --watch-admin`
Expected: admin serves at `/admin`, HMR applies a `.tsx` edit without full reload.

- [ ] **Step 5: Commit**

```bash
git add packages/core/strapi/src/node/vite/config.ts packages/core/strapi/src/node/vite/watch.ts
git commit -m "fix(strapi): adapt admin vite dev server to vite 8"
```

---

## Task 4: Green the full test suite

**Files:** none (verification only; fix regressions in the files above if found)

**Interfaces:**

- Consumes: all prior tasks.
- Produces: passing `test:front`, `test:ts`, lint, and admin e2e — the gate that
  declares Phase 0 done.

- [ ] **Step 1: Front tests**

Run: `yarn test:front && yarn test:front:ce`
Expected: PASS. Vitest runs through Vite 8; fix any transform/config breakage.

- [ ] **Step 2: Types + lint + format**

Run: `yarn test:ts && yarn lint && yarn prettier:check`
Expected: PASS.

- [ ] **Step 3: Admin e2e smoke**

Run: `yarn test:e2e --domains admin --concurrency=1`
Expected: PASS (login, navigate, basic CRUD render). This proves the built admin
runs in a browser under Vite 8.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "test(strapi): green admin suite on vite 8"
```

---

## Self-Review

- **Spec coverage:** version bump (T1), prod build (T2), dev server (T3), full
  suite (T4) — all v5→v8 breaking-change categories from the Vite facts block are
  assigned to a task step (Node floor: implicit/fine; Sass: T2.4; target: T2.3;
  define: T2.2; CJS: T2.5; hot.accept: T3.3; Rolldown: covered by re-running build
  in T2.6/T4).
- **No placeholders:** the only "discover then fix" steps (T2.1, T3.1) are
  deliberate — a dependency upgrade's breakages are found by running, and each
  known category has a concrete fix step.
- **Hand-off:** Phase A starts from a green Vite-8 admin build.

## Execution Handoff

Plan complete. After Phase 0 is green, proceed to
[`phase-a-client-environment.md`](./phase-a-client-environment.md).
