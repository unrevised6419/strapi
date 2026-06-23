# Phase D — Remove the old toolchain + lifecycle commands (milestone plan)

> **For agentic workers:** **Milestone-level** plan. Step-level TDD is deferred
> until the Detail-after gate. This phase is a **major version boundary** (removes
> public commands and behavior).
>
> Global constraints: [`README.md`](./README.md#global-constraints).
> **Prerequisite: Phase C complete + the Vite-server path graduated from
> experimental to default (flag removed/inverted).**

**Goal:** Delete the `tsc`→`dist` server pipeline, the webpack admin path, and the
`strapi develop` / `strapi build` / `strapi start` lifecycle commands — leaving
`vite` / `vite build` / `node dist/server.js` and a CLI of only non-serving
commands (codegen, admin-user, EE, scaffold).

**Architecture:** Everything Phases 0–C added becomes the default. The cluster
primary/worker split (whose job was "recompile then restart") is removed; reload is
in-process; resolution flows through `strapi.config.ts` + the Vite plugin (note
§10/§11). `config/*` is pure runtime data; `resolve` is gone from runtime config.

## Codebase facts (verified 2026-06-22) — what gets removed

- `packages/core/strapi/src/node/develop.ts` — the `cluster.isPrimary`/`isWorker`
  split + `tsUtils().compile` calls + chokidar watcher (replaced by the Vite-server
  path from Phase B).
- `packages/core/strapi/src/cli/commands/{develop,build,start}.ts` — the three
  lifecycle commands.
- `packages/core/strapi/src/node/webpack/*` — the deprecated webpack admin bundler.
- `packages/core/core/src/services/reloader.ts` — the `process.send('reload')`
  cluster path (keep only in-process mode).
- `packages/core/strapi/src/node/core/files.ts` `esbuild-register` shim — config
  loads through the runner / build now.
- `load-config-file.ts` `switch(extname)` — superseded by `importModule`.
- `config/plugins` `resolve` field handling in `get-enabled-plugins.ts` — moved to
  `strapi.config.ts` + build manifest (note §10).
- `@strapi/typescript-utils` emit path — kept for type-checking (`--noEmit`) only;
  the emit-to-`dist` compiler is retired.

---

## Milestones

### D1 — Invert the flag, then remove it

Make the Vite-server path the default; keep `--legacy-cluster` as a one-minor
escape hatch, then remove it. **Deliverable:** default dev = Vite server.
**Test:** full suite + e2e green with no flag.

### D2 — Remove the cluster/tsc dev pipeline

Delete the cluster split, `tsUtils().compile` dev calls, and the chokidar watcher
from `develop.ts`. **Deliverable:** `develop.ts` is the Vite-server path only.
**Test:** dev boot + reload via the Vite path; no `dist` in dev.

### D3 — Remove the webpack admin path

Delete `node/webpack/*` and its branches in `build.ts`/`create-build-context.ts`.
**Deliverable:** Vite is the only bundler. **Test:** admin build + e2e green.

### D4 — Migrate `resolve` out of runtime config (note §10)

Auto-discover `src/plugins/*`; move explicit non-standard locations to
`strapi.config.ts`; emit the build manifest; strip `resolve` from `config/plugins`.
Keep a deprecation warning auto-mapping old `resolve` for one minor, then remove.
**Deliverable:** `config/plugins.ts` carries no path strings. **Test:** local
plugin (standard + non-standard location) loads via manifest in dev and prod.

### D5 — Introduce `strapi.config.ts` (note §11)

The toolchain/project-definition file consumed by both the Vite plugin and the CLI
codegen commands. **Deliverable:** `defineStrapi(...)` config read by both.
**Test:** `ts:generate-types` + scaffold read it without booting Vite.

### D6 — Remove the lifecycle commands

Delete `cli/commands/{develop,build,start}.ts`; document `vite` / `vite build` /
`node dist/server.js`. Keep thin deprecated aliases for one major, then remove.
**Deliverable:** CLI has only non-serving commands. **Test:** the three standard
commands work end-to-end; CLI help lists only codegen/admin/EE/scaffold.

### D7 — Retire the `tsc`-emit compiler path

Switch `@strapi/typescript-utils` usage to `--noEmit` type-checking only (CI +
IDE). **Deliverable:** no `tsc` emit anywhere. **Test:** `yarn test:ts` green;
no `dist` produced by `tsc`.

---

## Detail-after gate

Expand D1–D7 into step-level tasks only once:

1. **Phase C complete** — prod runs from `dist/server.js` across JS + TS projects,
   installed CJS + local TS plugins both work, EE gating intact.
2. **Vite-server path has soaked** as opt-in default through at least one minor with
   no open P0/P1 against it (assurance before deleting the fallback).
3. **Migration/codemod decided** for `config/plugins` `resolve` → `strapi.config.ts`
   (auto-map shape locked).
4. **Major-version slot agreed** — D removes public APIs; it must land on a major
   boundary with a changeset + upgrade guide.

## Risks specific to D

- **Irreversibility** — D deletes fallbacks. Each milestone must be independently
  revertable until the major ships; do not delete the cluster path until D1's
  default has soaked (gate item 2).
- **Ecosystem breakage** — removing `strapi develop/build/start` and `resolve`
  breaks existing apps/scripts. Requires the deprecation-alias window (D6) +
  codemod (D4) + a prominent upgrade guide.
- **Supervision gap** — removing cluster removes its crash-recovery side effect;
  document that prod supervision is now the deploy platform's job (note §8.6).

## Execution Handoff

After the Detail-after gate, return to the writing-plans skill to expand D1–D7
into step-level tasks. This is the terminal phase — the end state is `vite` /
`vite build` / `node dist/server.js` with a serving-free CLI.
