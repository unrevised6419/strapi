# Strapi → Vite Environment API Migration — Plan Set

> **Status:** plan set in progress. Grounded in the design note
> [`docs/superpowers/notes/2026-06-21-strapi-on-vite-environments.md`](../../notes/2026-06-21-strapi-on-vite-environments.md)
> and the shipped branch `fix/local-ts-plugin-support` (whose plan is
> [`../2026-06-21-local-ts-plugin-support.md`](../2026-06-21-local-ts-plugin-support.md)).
>
> **Vite baseline (verified 2026-06-22 against vite.dev):**
>
> - Repo currently pins **`vite@5.4.21`** (`packages/core/strapi/package.json`).
>   Vite 5 has **no** Environment API → a Vite 5→8 upgrade is a hard prerequisite
>   (**Phase 0**).
> - Latest stable is **Vite 8.0.16** (ships Rolldown as the unified bundler).
> - The **Environment API is in "release candidate" phase — NOT stable** even in
>   Vite 8. Config/runtime _shapes_ are held stable between majors (safe to build
>   on), but several sub-APIs are experimental and "planned for a future major":
>   the `hotUpdate` plugin hook, `ssrLoadModule` removal, "SSR using ModuleRunner",
>   `this.environment` in hooks. **Vite explicitly says "don't migrate yet"** for
>   the HMR hooks. → these plans use the _current_ APIs (`handleHotUpdate`) and
>   wrap the runner behind a thin abstraction so a future-major swap is localized.
> - `RunnableDevEnvironment` is a **type-only export**; the runtime guard is
>   `isRunnableDevEnvironment(env)`, or build a runner explicitly with
>   `createServerModuleRunner(env)` (`@experimental`).
>   The design note predates all this and says "Vite 6/7"; the plans supersede it.

**Goal:** move Strapi's dev and build toolchain off the `tsc`→`dist`→`require`
server pipeline and onto the Vite Environment API, so admin and server share one
resolve/transform pipeline, local TS plugins load from source, and the end state
is `vite` (dev) / `vite build` (build) / `node dist/server.js` (prod).

**Architecture:** one Vite server owns two environments — `client` (admin SPA,
browser) and `server` (Koa backend, run in-process through a `ModuleRunner` via
`RunnableDevEnvironment`). Packaged as a `strapi()` Vite plugin. Prod is a
single-file `dist/server.js` with `node_modules` externalized. Deploy target =
Fork A (any Node host, incl. Cloudflare Containers); edge/Workers is out of scope.

---

## The four phases

Each phase is its own plan and produces working, testable software on its own.

| Phase | Plan                                                                       | Scope                                                                                                                                                                                                    | Risk     | Ships |
| ----- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----- |
| **0** | [`phase-0-vite-upgrade.md`](./phase-0-vite-upgrade.md)                     | Upgrade the admin build from `vite@5.4.21` to `vite@^8`. Prerequisite for the Environment API. No Strapi-architecture change.                                                                            | medium   | yes   |
| **A** | [`phase-a-client-environment.md`](./phase-a-client-environment.md)         | Formalize today's admin Vite build as the `client` environment in an `environments` object. Pure refactor, no behavior change.                                                                           | low      | yes   |
| **B** | [`phase-b-server-environment-dev.md`](./phase-b-server-environment-dev.md) | Add a `server` environment in **dev only**, behind an experimental flag. Boot Strapi + plugins + config through the runner; coarse HMR via `strapi.reload()`. Old `tsc`+cluster path default and intact. | **high** | yes   |
| **C** | [`phase-c-prod-vite-build.md`](./phase-c-prod-vite-build.md)               | Prod through `vite build` (Builder API): single-file `dist/server.js`, externalized deps, inlined local plugins. `strapi start` → `node dist/server.js`.                                                 | high     | yes   |
| **D** | [`phase-d-remove-old-toolchain.md`](./phase-d-remove-old-toolchain.md)     | Remove the `tsc`→`dist` pipeline, the webpack admin path, and `strapi develop`/`build`/`start`. Major version boundary.                                                                                  | medium   | yes   |

## Validation gates — why C/D are contingent

The design note's five highest-risk assumptions are **unverified against a
running prototype**:

1. A `ModuleRunner` can host a **resident** Koa app (not request-scoped SSR) for
   weeks. (note §6.1)
2. `strapi.reload()` works **in-process** without the cluster fork. **CONFIRMED
   FALSE today** — `reloader.ts:18` is `process.send?.('reload')`, pure IPC to the
   cluster primary. Phase B must build a _new_ in-process reload path. This is
   Phase B's largest deliverable, not a given. (note §2.4)
   Compounding factor from Vite docs: after a Module Runner full-reload, a
   module's `exports` object goes stale — code must re-`import()`, never cache
   `exports`. The in-process reload must respect this.
3. Config files load through the runner with correct **boot ordering**. (note §2.3)
4. Koa + Vite **middleware ordering** for /admin vs /api is workable. (note §6.5)
5. Single-file server bundle + externalized `node_modules` **resolves at runtime**
   from an arbitrary cwd. (note §8.4)

Phase **B is the proving ground** for assumptions 1–4. Phase **A and B are fully
detailed** here as bite-sized TDD plans. Phases **C and D are specified at the
milestone level with explicit prerequisites**: their bite-sized steps cannot be
written honestly (no placeholders — see writing-plans skill) until Phase B
validates the runtime model and assumption 5 is prototyped. Each carries a
**"Detail-after" gate** listing exactly what Phase B must prove before C/D are
expanded into step-level plans.

---

## Global Constraints

_(Copied verbatim from AGENTS.md — every task implicitly includes these.)_

- **Node** ≥22 ≤26, **Yarn 4**, Nx monorepo. Yarn workspaces.
- **Target branch `develop`** (never `main`). Branch from `develop`.
- Internal `packages/` deps use **pinned semver** (e.g. `"5.42.0"`), not
  `workspace:*`. Run `yarn version:check` if any `package.json` changes.
- **Conventional Commits** enforced (commitlint). Types: `feat` `fix` `chore`
  `ci` `docs` `enhancement` `test` `revert` `security` `future` `release`.
- Commit message footer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **TypeScript:** import shared types from `@strapi/types`; never `any` where a
  type exists (prefer `unknown`). `yarn test:ts` must pass.
- **Pre-PR:** `yarn test:unit && yarn test:front && yarn test:ts && yarn lint && yarn prettier:check`.
- `examples/` apps are **sandboxes** — reproduce/test fixes there, never commit
  changes to them unless asked.
- **Entity Service deprecated** — use Document Service (`strapi.documents`).
- New behavior **behind an experimental flag, default off**, until validated.

---

_Per-phase plans are written below. A and B are step-level; C and D are
milestone-level pending Phase B validation._
