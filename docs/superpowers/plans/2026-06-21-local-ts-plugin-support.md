# Local TS/JS Plugin Support (dev out-of-the-box, prod from dist) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make local plugins (declared via `config/plugins` `resolve: './src/plugins/x'`) load whether their entry files are `.js` or `.ts`, with zero developer-facing JS-vs-TS differentiation — working out of the box in `develop` and loading from `dist` in production.

**Architecture:** Do NOT add a runtime transpiler (no `esbuild-register`/`tsx`). Instead lean on the pipeline Strapi already has: `develop` compiles TS → `dist` on boot and on every reload, and `start` already computes `distDir` (= `outDir` for TS projects, = `appDir` for JS projects). Three gaps block local plugins from riding that pipeline: (1) the server loader resolves local plugins from `dirs.app.root` (source) instead of `dirs.dist.root`; (2) the project `tsconfig.json` excludes `src/plugins/**` so plugin server files are never compiled into `dist`; (3) the admin/Vite resolver gate hardcodes `strapi-admin.js`. Fixing all three yields one uniform code path — JS projects resolve `dist.root === appDir` (source `.js`), TS projects resolve `dist.root === outDir` (compiled `.js`) — with no `isTSProject` branching added anywhere.

**Tech Stack:** TypeScript, Node ≥22, Yarn 4 workspaces, Jest (`yarn test:unit`), Vite (admin bundler), `@strapi/typescript-utils` (tsc wrapper), API integration harness (`yarn test:api`).

## Global Constraints

- Target branch is `develop`; all PRs target `develop` (never `main`).
- Node-20-safe: no syntax/APIs that break on Node 20 (CI dropped Node 20 but engines/@types keep it).
- Never use `global.strapi`; use the injected `strapi` instance. (The existing code in `get-enabled-plugins.ts` references a module-global `strapi` — keep using that same reference; do not introduce a _new_ `global.strapi` access.)
- Import shared types from `@strapi/types`; never use `any` where a type exists (`unknown` otherwise).
- Conventional Commits, valid types: `feat fix chore ci docs enhancement test revert security future release`.
- Do not commit changes under `examples/` (sandboxes only) unless a task explicitly says so.
- Compiled plugin output is always `.js`; the server loader must continue to look up `strapi-server.js` (do NOT add `.ts` probing server-side — TS is compiled away before the loader runs).
- Admin entry files are read from **source** by Vite (which transpiles `.ts`/`.tsx`); they must NOT be compiled by the server `tsc`.

---

## File Structure

| File                                                                                      | Responsibility                                            | Change                                                                                       |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `packages/core/core/src/loaders/plugins/get-enabled-plugins.ts`                           | Resolves each enabled plugin's directory (`pathToPlugin`) | Resolve local plugins from `dirs.dist.root`; export `toDetailedDeclaration` for unit testing |
| `packages/core/core/src/loaders/plugins/__tests__/get-enabled-plugins.test.ts`            | Unit test for local-plugin dir resolution                 | Create                                                                                       |
| `packages/cli/create-strapi-app/templates/vanilla/tsconfig.json`                          | Default TS project server tsconfig                        | Compile plugin server files; keep plugin admin files out                                     |
| `packages/cli/create-strapi-app/templates/example/tsconfig.json`                          | Example TS project server tsconfig                        | Same change as vanilla                                                                       |
| `packages/core/strapi/src/node/core/plugins.ts`                                           | Admin/Vite plugin discovery (`getMapOfPluginsWithAdmin`)  | Probe multiple extensions for the legacy `strapi-admin` entry                                |
| `packages/core/strapi/src/node/core/__tests__/plugins.test.ts`                            | Unit test for admin entry extension probing               | Create or extend                                                                             |
| `tests/api/core/strapi/loaders/local-ts-plugin.test.api.js` (path per harness convention) | Integration: local TS plugin loads & exposes a route      | Create                                                                                       |

---

## Task 1: Server loader resolves local plugins from `dist`, not source

**Files:**

- Modify: `packages/core/core/src/loaders/plugins/get-enabled-plugins.ts:75` (and export `toDetailedDeclaration`)
- Test: `packages/core/core/src/loaders/plugins/__tests__/get-enabled-plugins.test.ts`

**Interfaces:**

- Consumes: module-global `strapi` with `strapi.dirs.dist.root` (set by `get-dirs.ts`; `distDir` from `createStrapi({ distDir })`).
- Produces: `toDetailedDeclaration(declaration: boolean | PluginDeclaration): { enabled: boolean; pathToPlugin?: string }` — now exported. For a local declaration `{ enabled, resolve, isModule: false }` whose `require.resolve` fails, `pathToPlugin === resolve(strapi.dirs.dist.root, declaration.resolve)`.

Why `dist.root`: `start.ts` sets `distDir = isTSProject ? outDir : appDir`, and `get-dirs.ts` sets `dirs.dist.root = distDir`. So for JS projects `dist.root === appDir` (source `.js` plugins keep working unchanged), and for TS projects `dist.root === outDir` (compiled plugins are found). One path, no `isTSProject` branch.

- [ ] **Step 1: Write the failing test**

Create `packages/core/core/src/loaders/plugins/__tests__/get-enabled-plugins.test.ts`:

```ts
import path from 'path';
import { toDetailedDeclaration } from '../get-enabled-plugins';

describe('toDetailedDeclaration - local plugin resolution', () => {
  const originalStrapi = (global as any).strapi;

  beforeEach(() => {
    (global as any).strapi = {
      dirs: {
        dist: { root: '/app/dist' },
        app: { root: '/app' },
      },
    };
    // Force the require.resolve() branch to throw so the fallback path is used.
    jest.spyOn(require('fs'), 'existsSync').mockReturnValue(true);
    jest.spyOn(require('fs'), 'statSync').mockReturnValue({ isDirectory: () => true } as any);
  });

  afterEach(() => {
    (global as any).strapi = originalStrapi;
    jest.restoreAllMocks();
  });

  it('resolves a local plugin path against dirs.dist.root (not app.root)', () => {
    const result = toDetailedDeclaration({
      enabled: true,
      resolve: './src/plugins/my-plugin',
      isModule: false,
    });

    expect(result.pathToPlugin).toBe(path.resolve('/app/dist', './src/plugins/my-plugin'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn jest packages/core/core/src/loaders/plugins/__tests__/get-enabled-plugins.test.ts`
Expected: FAIL — either `toDetailedDeclaration is not a function` (not yet exported) or `pathToPlugin` equals `/app/src/plugins/my-plugin` (resolved against `app.root`).

- [ ] **Step 3: Apply the implementation change**

In `packages/core/core/src/loaders/plugins/get-enabled-plugins.ts`, change the local-plugin fallback resolution to use the dist root, and export the helper.

Change line 54 from:

```ts
const toDetailedDeclaration = (declaration: boolean | PluginDeclaration) => {
```

to:

```ts
export const toDetailedDeclaration = (declaration: boolean | PluginDeclaration) => {
```

Change line 75 from:

```ts
pathToPlugin = resolve(strapi.dirs.app.root, declaration.resolve);
```

to:

```ts
// Local plugins are loaded from the dist root so that compiled TS output is
// picked up in production. For JS projects dist.root === appDir, so source
// .js plugins keep resolving unchanged.
pathToPlugin = resolve(strapi.dirs.dist.root, declaration.resolve);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn jest packages/core/core/src/loaders/plugins/__tests__/get-enabled-plugins.test.ts`
Expected: PASS

- [ ] **Step 5: Type-check the package**

Run: `yarn nx run @strapi/core:test:ts` (or `yarn test:ts` for the full sweep)
Expected: no new type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/core/core/src/loaders/plugins/get-enabled-plugins.ts \
        packages/core/core/src/loaders/plugins/__tests__/get-enabled-plugins.test.ts
git commit -m "fix(core): resolve local plugins from dist root so compiled TS entries load"
```

---

## Task 2: Compile local plugin SERVER files into `dist` (keep admin out)

**Files:**

- Modify: `packages/cli/create-strapi-app/templates/vanilla/tsconfig.json:42`
- Modify: `packages/cli/create-strapi-app/templates/example/tsconfig.json` (same `exclude` block)

**Interfaces:**

- Consumes: nothing in code; this changes what `tsUtils.compile()` emits during `strapi develop` / `strapi build`.
- Produces: after compile, `dist/src/plugins/<name>/strapi-server.js` (and `dist/src/plugins/<name>/server/**`) exist. Plugin admin files (`admin/**`, root `strapi-admin.*`) remain excluded from the server compile (Vite + `src/admin/tsconfig.json` handle those).

Rationale: `src/plugins/**` was excluded wholesale because the plugin's admin `.tsx` files broke the server `tsc` (no JSX config — see strapi/documentation#3025). The fix is to exclude only the _admin_ portion of plugins, not the whole plugin.

- [ ] **Step 1: Edit the vanilla template tsconfig exclude**

In `packages/cli/create-strapi-app/templates/vanilla/tsconfig.json`, replace the trailing exclude entry. Change:

```json
    // Do not include admin files in the server compilation
    "src/admin/",
    // Do not include test files
    "**/*.test.*",
    // Do not include plugins in the server compilation
    "src/plugins/**"
  ]
```

to:

```json
    // Do not include admin files in the server compilation
    "src/admin/",
    // Do not include test files
    "**/*.test.*",
    // Plugin admin code is compiled by Vite / src/admin/tsconfig.json, not the
    // server tsc (it may contain JSX). Plugin SERVER code IS compiled so that
    // local plugins are emitted to dist and load in production.
    "src/plugins/**/admin/**",
    "src/plugins/**/strapi-admin.*"
  ]
```

- [ ] **Step 2: Apply the identical change to the example template**

In `packages/cli/create-strapi-app/templates/example/tsconfig.json`, make the exact same replacement of the `"src/plugins/**"` line with the two `src/plugins/**/admin/**` and `src/plugins/**/strapi-admin.*` lines plus the updated comment.

- [ ] **Step 3: Verify the JSON is valid**

Run: `node -e "require('./packages/cli/create-strapi-app/templates/vanilla/tsconfig.json'); require('./packages/cli/create-strapi-app/templates/example/tsconfig.json'); console.log('ok')"`
Expected: prints `ok` (JSON with `//` comments — if this errors on comments, instead validate with the project's jsonc-aware lint: `yarn prettier:check "packages/cli/create-strapi-app/templates/**/tsconfig.json"`).

- [ ] **Step 4: Commit**

```bash
git add packages/cli/create-strapi-app/templates/vanilla/tsconfig.json \
        packages/cli/create-strapi-app/templates/example/tsconfig.json
git commit -m "fix(create-strapi-app): compile local plugin server files into dist (keep admin out)"
```

---

## Task 3: Admin/Vite resolver probes multiple extensions for the legacy `strapi-admin` entry

**Files:**

- Modify: `packages/core/strapi/src/node/core/plugins.ts:230`
- Test: `packages/core/strapi/src/node/core/__tests__/plugins.test.ts`

**Interfaces:**

- Consumes: `plugin.path` (absolute local plugin dir) and `plugin.modulePath` from the node-side `PluginMeta`.
- Produces: `getMapOfPluginsWithAdmin` includes a local plugin when ANY of `strapi-admin.{js,mjs,ts,tsx,jsx}` exists at its root (previously only `strapi-admin.js`). The emitted import specifier stays extensionless (`'<modulePath>/strapi-admin'`); Vite resolves and transpiles `.ts`/`.tsx` via its default `resolve.extensions`.

- [ ] **Step 1: Write the failing test**

Create or extend `packages/core/strapi/src/node/core/__tests__/plugins.test.ts`:

```ts
import fs from 'fs';
import { getMapOfPluginsWithAdmin } from '../plugins';

describe('getMapOfPluginsWithAdmin - local plugin admin entry extensions', () => {
  afterEach(() => jest.restoreAllMocks());

  it('includes a local plugin whose admin entry is strapi-admin.ts', () => {
    jest.spyOn(fs, 'existsSync').mockImplementation((p) => {
      const str = String(p);
      // No package.json (force legacy fallback), no .js, but a .ts entry exists.
      if (str.endsWith('package.json')) return false;
      if (str.endsWith('strapi-admin.ts')) return true;
      return false;
    });

    const plugins = {
      'my-plugin': {
        name: 'my-plugin',
        path: '/app/src/plugins/my-plugin',
        modulePath: '/app/src/plugins/my-plugin',
      },
    } as any;

    const result = getMapOfPluginsWithAdmin(plugins);

    expect(result).toHaveLength(1);
    expect(result[0].modulePath).toBe('/app/src/plugins/my-plugin/strapi-admin');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn jest packages/core/strapi/src/node/core/__tests__/plugins.test.ts`
Expected: FAIL — `result` has length 0 (only `strapi-admin.js` is checked, so the `.ts`-only plugin is filtered out).

- [ ] **Step 3: Apply the implementation change**

In `packages/core/strapi/src/node/core/plugins.ts`, just above `getMapOfPluginsWithAdmin` (near the other module constants, e.g. after the `PLUGIN_CONFIGS` declaration around line 167), add:

```ts
const ADMIN_ENTRY_EXTENSIONS = ['.js', '.mjs', '.ts', '.tsx', '.jsx'];
```

Then replace the legacy check at lines 229-233:

```ts
// Check if legacy admin file exists in local plugin
if (fs.existsSync(path.join(localPluginPath, 'strapi-admin.js'))) {
  pluginImportPaths[plugin.modulePath] = 'strapi-admin';
  return true;
}
```

with:

```ts
// Check if a legacy admin entry exists in the local plugin, for any
// supported extension. The import specifier stays extensionless so
// Vite resolves/transpiles .ts/.tsx itself.
const hasLegacyAdminEntry = ADMIN_ENTRY_EXTENSIONS.some((ext) =>
  fs.existsSync(path.join(localPluginPath, `strapi-admin${ext}`))
);

if (hasLegacyAdminEntry) {
  pluginImportPaths[plugin.modulePath] = 'strapi-admin';
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn jest packages/core/strapi/src/node/core/__tests__/plugins.test.ts`
Expected: PASS

- [ ] **Step 5: Type-check**

Run: `yarn nx run @strapi/strapi:test:ts`
Expected: no new type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/core/strapi/src/node/core/plugins.ts \
        packages/core/strapi/src/node/core/__tests__/plugins.test.ts
git commit -m "fix(strapi): probe js/ts/tsx for local plugin admin entry in vite resolver"
```

---

## Task 4: Integration test — a local TS plugin loads and serves a route

**Files:**

- Create: `tests/api/core/strapi/loaders/local-ts-plugin.test.api.js` (place under the existing `tests/api` tree following the nearest sibling's path/naming; the harness generates the test app via `yarn test:generate-app`)
- Create (fixture, inside the generated/seed app per harness convention): a local plugin with a TS-only server entry.

**Interfaces:**

- Consumes: the API test harness (`yarn test:api`) which generates a TS test app, runs `strapi develop`/load, and exposes an HTTP client.
- Produces: proof that `config/plugins` `resolve: './src/plugins/ts-fixture'` with `src/plugins/ts-fixture/strapi-server.ts` (no precompiled `.js`) is loaded and its route responds.

Note: this is the test that actually proves "out of the box in dev" AND (via the build the harness runs for TS apps) "from dist". Keep the fixture server-only (no admin) so it isolates the server loader path from the Vite path covered in Task 3.

- [ ] **Step 1: Add the TS plugin fixture to the test app**

Create the fixture files the harness seeds into the generated app. The server entry (`strapi-server.ts`) — TypeScript-only, no `.js`, no `package.json`, no build step:

```ts
// src/plugins/ts-fixture/strapi-server.ts
export default () => ({
  register() {},
  bootstrap() {},
  routes: {
    'content-api': {
      type: 'content-api',
      routes: [
        {
          method: 'GET',
          path: '/ts-fixture/ping',
          handler: 'ping.index',
          config: { auth: false },
        },
      ],
    },
  },
  controllers: {
    ping: {
      index(ctx: { body: unknown }) {
        ctx.body = { ok: true, lang: 'ts' };
      },
    },
  },
});
```

Register it in the test app's `config/plugins.ts`:

```ts
export default () => ({
  'ts-fixture': {
    enabled: true,
    resolve: './src/plugins/ts-fixture',
  },
});
```

- [ ] **Step 2: Write the failing API test**

```js
'use strict';

const { createStrapiInstance } = require('api-tests/strapi');
const { createContentAPIRequest } = require('api-tests/request');

let strapi;
let rq;

describe('Local TS-only plugin loading', () => {
  beforeAll(async () => {
    strapi = await createStrapiInstance();
    rq = await createContentAPIRequest({ strapi });
  });

  afterAll(async () => {
    await strapi.destroy();
  });

  test('loads a local plugin whose strapi-server is TypeScript-only', async () => {
    const res = await rq({ method: 'GET', url: '/ts-fixture/ping' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, lang: 'ts' });
  });
});
```

(Confirm the exact `api-tests/*` import paths against a neighbouring file in `tests/api`; use whatever the sibling tests use.)

- [ ] **Step 3: Run it to verify it fails on the current code**

Stash the Task 1/2 changes is NOT needed — instead confirm the test exercises the path. Run:
`yarn test:generate-app && yarn test:api --file tests/api/core/strapi/loaders/local-ts-plugin.test.api.js`
Expected (BEFORE Task 1 & 2, i.e. if you checkout those files): 404 on `/ts-fixture/ping` (plugin silently skipped). AFTER Task 1 & 2 are in place: this should pass — so to see the red state, temporarily revert `get-enabled-plugins.ts:75` to `app.root`, observe 404, then restore.

- [ ] **Step 4: Run with all fixes in place to verify it passes**

Run: `yarn test:generate-app && yarn test:api --file tests/api/core/strapi/loaders/local-ts-plugin.test.api.js`
Expected: PASS (200, `{ ok: true, lang: 'ts' }`).

- [ ] **Step 5: Commit**

```bash
git add tests/api/core/strapi/loaders/local-ts-plugin.test.api.js \
        <fixture files>
git commit -m "test(api): local TS-only plugin loads and serves a route"
```

---

## Task 5: Verify the full quality gate

**Files:** none (verification only).

- [ ] **Step 1: Unit + type + lint + format**

Run: `yarn test:unit && yarn test:ts && yarn lint && yarn prettier:check`
Expected: all pass. Fix anything that the new files trip (run `yarn lint:fix` / `yarn format` if needed and re-commit).

- [ ] **Step 2: Manual smoke (optional but recommended)**

In a scratch TS app (or `examples/getstarted` switched to TS — do NOT commit example changes), add a `src/plugins/ts-fixture/strapi-server.ts` as in Task 4, register it, then:

- `yarn develop` → hit `GET /ts-fixture/ping` → expect 200 (proves dev out-of-the-box).
- `yarn build && yarn start` → hit the same route → expect 200, and confirm `dist/src/plugins/ts-fixture/strapi-server.js` exists (proves prod-from-dist).

- [ ] **Step 3: Commit any fixups**

```bash
git add -A
git commit -m "chore: lint/format fixups for local ts plugin support"
```

---

## Out of scope (flag in the PR, do not implement here)

- The upstream docs (`strapi/documentation`, create-a-plugin page) still imply `.ts` local plugins "just work" — they will once this ships. A docs PR is a separate repo/change.
- A first-class Vite-runs-the-server architecture (Module Runner in dev, `vite build` server bundle in prod) is a much larger roadmap change and is explicitly NOT this plan. This plan deliberately reuses the existing `tsc → dist` pipeline.
- `strapi start` still requires a prior `strapi build` for TS projects (`start.ts:18-21`) — unchanged and intended.

---

## Self-Review

**Spec coverage:**

- "JS/TS work out of the box in dev" → Task 1 (loader→dist) + Task 2 (compile plugin server into dist; `develop` compiles on boot/reload) + Task 3 (admin Vite probe) + Task 4 (dev proof).
- "Load from dist in production" → Task 1 (dist.root resolution) + Task 2 (`strapi build` emits plugin server to dist) + Task 5 step 2 (prod proof).
- "Don't differentiate JS vs TS" → Task 1's `dist.root` collapses to `appDir` for JS, `outDir` for TS — single path, no `isTSProject` branch added.

**Placeholder scan:** No TBD/TODO; every code step has concrete code. The only deferred specifics are the exact `tests/api` import paths/locations, which depend on the live harness and are called out to confirm against a sibling file (a real constraint, not a hand-wave).

**Type consistency:** `toDetailedDeclaration` signature matches its definition; `getMapOfPluginsWithAdmin` consumes `plugin.path`/`plugin.modulePath` and returns objects with `modulePath` set to `'<modulePath>/strapi-admin'` — consistent with existing `.map` at `plugins.ts:259-262`. `ADMIN_ENTRY_EXTENSIONS` used only where declared.
