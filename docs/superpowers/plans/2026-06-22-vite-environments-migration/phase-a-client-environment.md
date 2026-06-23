# Phase A — Admin as the `client` environment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
>
> Global constraints: [`README.md`](./README.md#global-constraints). **Prerequisite: Phase 0 complete** (admin on Vite 8, suite green).

**Goal:** Express today's admin Vite config explicitly as the **`client`
environment** inside an `environments` object, and introduce a `strapi()` Vite
plugin scaffold — establishing the structure Phase B extends with a `server`
environment. **No behavior change**: the admin builds and serves identically.

**Architecture:** Vite's `client` environment IS the default browser environment;
top-level `build`/`resolve` config already maps onto it. This phase makes that
mapping explicit (`environments: { client: {...} }`) and moves the admin's config
contribution into a reusable `strapi()` plugin via the `configEnvironment` hook,
so Phase B only has to add a second environment.

**Tech Stack:** Vite 8 Environment API (`environments`, `configEnvironment`
plugin hook), `@vitejs/plugin-react`.

## Vite facts (verified 2026-06-22)

- `environments: { client: {...} }` — config per environment. The `client`
  environment is the browser default; moving top-level browser config there is
  behavior-neutral. ([api-environment](https://vite.dev/guide/api-environment))
- `configEnvironment(name, options)` plugin hook returns a partial config merged
  into the named environment. ([api-environment-plugins](https://vite.dev/guide/api-environment-plugins))
- Environment API is **RC, not stable** — config shapes are held stable between
  majors. Acceptable for this additive, behavior-neutral refactor.

## Global Constraints

See [`README.md`](./README.md#global-constraints).

---

## File Structure

| File                                                          | Responsibility                                                  | Change                                                       |
| ------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------ |
| `packages/core/strapi/src/node/vite/plugin.ts`                | **new** — the `strapi()` Vite plugin; owns environment config   | create                                                       |
| `packages/core/strapi/src/node/vite/config.ts`                | builds the `InlineConfig` for admin build/watch                 | route base config through `environments.client` + the plugin |
| `packages/core/strapi/src/node/vite/__tests__/plugin.test.ts` | **new** — unit test for the plugin's `configEnvironment` output | create                                                       |

---

## Task 1: Introduce the `strapi()` Vite plugin scaffold

**Files:**

- Create: `packages/core/strapi/src/node/vite/plugin.ts`
- Create: `packages/core/strapi/src/node/vite/__tests__/plugin.test.ts`

**Interfaces:**

- Consumes: `BuildContext` (from `create-build-context.ts`).
- Produces: `export function strapi(opts: StrapiPluginOptions): Plugin` where
  `interface StrapiPluginOptions { ctx: BuildContext }`. Phase B extends this same
  plugin with a `server` environment + `configureServer`/`handleHotUpdate`. Its
  `configEnvironment('client', ...)` returns the admin's browser config partial.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/strapi/src/node/vite/__tests__/plugin.test.ts
import { describe, it, expect } from 'vitest';
import { strapi } from '../plugin';

const fakeCtx = { target: ['chrome>=90'], env: {}, basePath: '/admin/' } as any;

describe('strapi() vite plugin', () => {
  it('contributes a client environment config via configEnvironment', () => {
    const plugin = strapi({ ctx: fakeCtx });
    expect(plugin.name).toBe('strapi');
    const clientCfg = (plugin.configEnvironment as any)('client', {});
    expect(clientCfg).toBeDefined();
    expect(clientCfg.resolve?.dedupe).toContain('react');
  });

  it('returns undefined for unknown environments (for now)', () => {
    const plugin = strapi({ ctx: fakeCtx });
    expect((plugin.configEnvironment as any)('server', {})).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run packages/core/strapi/src/node/vite/__tests__/plugin.test.ts`
Expected: FAIL — `Cannot find module '../plugin'`.

- [ ] **Step 3: Write the minimal plugin**

```ts
// packages/core/strapi/src/node/vite/plugin.ts
import type { Plugin } from 'vite';
import type { BuildContext } from '../create-build-context';

export interface StrapiPluginOptions {
  ctx: BuildContext;
}

export function strapi({ ctx }: StrapiPluginOptions): Plugin {
  return {
    name: 'strapi',
    configEnvironment(name) {
      if (name === 'client') {
        return {
          resolve: {
            dedupe: ['react', 'react-dom', 'react-router-dom', 'styled-components'],
          },
        };
      }
      // Phase B adds the 'server' environment here.
      return undefined;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn vitest run packages/core/strapi/src/node/vite/__tests__/plugin.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/strapi/src/node/vite/plugin.ts packages/core/strapi/src/node/vite/__tests__/plugin.test.ts
git commit -m "feat(strapi): add strapi() vite plugin scaffold with client environment"
```

---

## Task 2: Route the admin config through `environments.client` + the plugin

**Files:**

- Modify: `packages/core/strapi/src/node/vite/config.ts:12-216` (`resolveBaseConfig`, `resolveProductionConfig`, `resolveDevelopmentConfig`)

**Interfaces:**

- Consumes: `strapi()` from Task 1.
- Produces: `InlineConfig`s whose browser settings live under
  `environments.client` and that register `strapi({ ctx })` in `plugins`.

- [ ] **Step 1: Move browser build/resolve config into `environments.client`**

In `resolveBaseConfig`, wrap the browser-specific `build`/`resolve`/`optimizeDeps`
into an `environments.client` block, and register the plugin:

```ts
return {
  root: ctx.cwd,
  base: ctx.basePath,
  cacheDir: 'node_modules/.strapi/vite',
  configFile: false,
  define: {
    /* unchanged from Phase 0 */
  },
  envPrefix: 'STRAPI_ADMIN_',
  plugins: [react(), buildFilesPlugin(ctx), strapi({ ctx })],
  environments: {
    client: {
      build: { emptyOutDir: false, outDir: ctx.distDir, target },
      optimizeDeps: {
        /* moved from top level */
      },
      resolve: {
        dedupe: [
          /* … */
        ],
        alias: {
          /* … */
        },
      },
    },
  },
};
```

Keep `resolveProductionConfig` / `resolveDevelopmentConfig` overriding the
`environments.client.build` / `server` blocks they already touch (e.g. dev's
`server.middlewareMode`, `appType: 'custom'`, `hmr` stay top-level —
`middlewareMode` is a server-wide, not per-environment, setting).

- [ ] **Step 2: Run the production build to confirm no behavior change**

Run: `yarn nx build @strapi/admin`
Expected: PASS, output identical in shape to Phase 0 (same `dist/build` assets).

- [ ] **Step 3: Run the dev server to confirm no behavior change**

Run: `cd examples/getstarted && yarn develop --watch-admin`
Expected: admin serves at `/admin`, HMR works — same as Phase 0.

- [ ] **Step 4: Run the front + ts suite**

Run: `yarn test:front && yarn test:ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/strapi/src/node/vite/config.ts
git commit -m "refactor(strapi): express admin config as the client environment"
```

---

## Self-Review

- **Spec coverage:** plugin scaffold with `configEnvironment` (T1); admin config
  expressed as `environments.client` through the plugin (T2). Behavior-neutral —
  verified by the unchanged build output + green suite.
- **Type consistency:** `StrapiPluginOptions { ctx: BuildContext }` and the
  `strapi()` signature defined in T1 are exactly what Phase B imports and extends.
- **No placeholders:** all code shown; the "Phase B adds here" comment marks an
  extension point, not a gap in this phase.

## Execution Handoff

Plan complete. Proceed to
[`phase-b-server-environment-dev.md`](./phase-b-server-environment-dev.md).
