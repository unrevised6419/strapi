import { createRequire } from 'node:module';
import { dirname as pathDirname, join as pathJoin, parse as pathParse } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

import type { Plugin } from 'vite';

/**
 * Phase B — CJS→ESM interop for the Vite `server` environment Module Runner.
 *
 * The runner evaluates every module as ESM (Vite 8's `ESModulesEvaluator`).
 * Strapi app source (`src/index.js`, controllers, services, config, …) and
 * most of the ecosystem are CommonJS (`module.exports` / `require`), so the
 * runner throws `ReferenceError: module is not defined` on raw CJS — this was
 * the wall the Task 2 spike hit.
 *
 * This plugin makes CJS source runner-evaluable by wrapping each detected CJS
 * module in a thin ESM shim that:
 *   - provides `module`, `exports`, `require`, `__filename`, `__dirname`,
 *   - delegates `require(...)` to a NATIVE `createRequire(filename)` so that
 *     relative CJS, JSON and `node_modules` deps resolve through Node exactly
 *     as they would outside the runner (no async hop, no runner round-trip),
 *   - re-exports `module.exports` as the ESM default export.
 *
 * Why a native `require` rather than routing nested requires back through the
 * runner: CJS `require` is synchronous, the runner's `import` is async, and the
 * deps a Strapi app pulls in are themselves CJS packages best loaded by Node.
 * The runner therefore owns the *entry* graph (so HMR + source-only boot work),
 * while native `require` owns the CJS sub-graph underneath each entry.
 *
 * `@rollup/plugin-commonjs` was evaluated first and rejected: it emits virtual
 * helper modules (`commonjsHelpers.js`, per-module proxies) that the Module
 * Runner cannot resolve (`Cannot find module ' commonjsHelpers.js'`), because
 * those helpers are a bundler-time construct, not runner-served modules.
 */

const HELPERS_ID = 'virtual:strapi-cjs-helpers';
const RESOLVED_HELPERS_ID = `\0${HELPERS_ID}`;

/**
 * Walk up from a file's directory to the nearest `package.json` and read its
 * `type` field. Returns `'module'`, `'commonjs'`, or `undefined` (no
 * package.json found / no `type` field). Cached per directory to avoid
 * re-reading on every transform.
 */
const pkgTypeCache = new Map<string, 'module' | 'commonjs' | undefined>();

function nearestPackageType(filePath: string): 'module' | 'commonjs' | undefined {
  let dir = pathDirname(filePath);
  const { root } = pathParse(dir);
  const visited: string[] = [];

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (pkgTypeCache.has(dir)) {
      const cached = pkgTypeCache.get(dir);
      // Propagate the resolved value to every directory we walked through.
      for (const d of visited) {
        pkgTypeCache.set(d, cached);
      }
      return cached;
    }
    visited.push(dir);

    const pkgPath = pathJoin(dir, 'package.json');
    if (existsSync(pkgPath)) {
      let type: 'module' | 'commonjs' | undefined;
      try {
        const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { type?: unknown };
        if (parsed.type === 'module' || parsed.type === 'commonjs') {
          type = parsed.type;
        }
      } catch {
        type = undefined;
      }
      for (const d of visited) {
        pkgTypeCache.set(d, type);
      }
      return type;
    }

    if (dir === root) {
      for (const d of visited) {
        pkgTypeCache.set(d, undefined);
      }
      return undefined;
    }
    dir = pathDirname(dir);
  }
}

/**
 * Robust module-system detection for the `server` runner.
 *
 * PRIMARY signal — deterministic, not source-dependent:
 *   - `.cjs` extension                  → CJS
 *   - `.mjs` extension                  → ESM
 *   - `.js` + nearest package.json
 *       `type: "module"`                → ESM
 *       (else / `type: "commonjs"`)     → CJS
 *
 * SECONDARY tie-breaker (only used for the ambiguous `.js`-without-clear-type
 * case): a syntactic check. A module that touches `module.exports` /
 * `exports.x` / `require(...)` and contains no top-level ESM `import`/`export`
 * is treated as CJS. This is the old fragile regex, demoted to a fallback so
 * comments/strings can no longer flip the classification of a file whose
 * extension/package-type already answers the question.
 */
function syntacticallyLooksLikeCjs(code: string): boolean {
  const usesCjs = /\bmodule\.exports\b|\bexports\.[A-Za-z_$]|\brequire\s*\(/.test(code);
  if (!usesCjs) {
    return false;
  }
  const usesEsm = /^\s*(?:export|import)\s/m.test(code);
  return !usesEsm;
}

function isCjsModule(cleanId: string, code: string): boolean {
  if (cleanId.endsWith('.cjs')) {
    return true;
  }
  if (cleanId.endsWith('.mjs')) {
    return false;
  }
  // `.ts` / `.mts` / `.cts` and everything else is left to Vite's own
  // (TS-aware, ESM) transform — Strapi TS app source is authored as ESM.
  if (!cleanId.endsWith('.js')) {
    return false;
  }

  const pkgType = nearestPackageType(cleanId);
  if (pkgType === 'module') {
    return false;
  }
  if (pkgType === 'commonjs') {
    return true;
  }

  // Ambiguous `.js` with no resolved package `type`: default for Node is CJS,
  // but only wrap when the source actually reads as CJS (syntactic tie-break),
  // so a `.js` ESM file with no package.json is not mis-wrapped.
  return syntacticallyLooksLikeCjs(code);
}

export function strapiCjsInterop(): Plugin {
  return {
    name: 'strapi:cjs-interop',
    // `pre` so we wrap before Vite's ESM-only transform sees the raw CJS.
    enforce: 'pre',
    applyToEnvironment(environment) {
      return environment.name === 'server';
    },
    resolveId(id) {
      if (id === HELPERS_ID) {
        return RESOLVED_HELPERS_ID;
      }
      return undefined;
    },
    load(id) {
      if (id === RESOLVED_HELPERS_ID) {
        // `createRequire` is re-exported through a virtual module so every
        // wrapped file shares one import the runner can resolve.
        return (
          `import { createRequire } from 'node:module';\n` +
          `export function makeRequire(filename) { return createRequire(filename); }\n`
        );
      }
      return undefined;
    },
    transform(code, id) {
      // Ignore querystring'd virtual ids. Only `.js`/`.cjs`/`.mjs` are
      // candidates for CJS wrapping; `.ts`/`.mts`/`.cts` are handled by Vite's
      // own TS-aware ESM transform (Strapi TS source is authored as ESM).
      const cleanId = id.split('?')[0];
      if (!/\.[cm]?js$/.test(cleanId)) {
        return undefined;
      }
      if (!isCjsModule(cleanId, code)) {
        return undefined;
      }

      const dirname = cleanId.replace(/[\\/][^\\/]*$/, '');
      const wrapped =
        `import { makeRequire } from ${JSON.stringify(HELPERS_ID)};\n` +
        `const __filename = ${JSON.stringify(cleanId)};\n` +
        `const __dirname = ${JSON.stringify(dirname)};\n` +
        `const require = makeRequire(__filename);\n` +
        `const module = { exports: {} };\n` +
        // eslint-disable-next-line prefer-const -- CJS bodies reassign `exports`
        `let exports = module.exports;\n` +
        `${code}\n` +
        `export default module.exports;\n`;

      return { code: wrapped, map: null };
    },
  };
}

/**
 * A native `require` bound to the app root — handy where the dev server itself
 * needs to resolve an app-relative CJS module outside the runner.
 */
export function createAppRequire(cwd: string): NodeJS.Require {
  return createRequire(`${cwd}/noop.js`);
}

const FRAMEWORK_PREFIX = '@strapi/';
const FRAMEWORK_VIRTUAL_PREFIX = '\0strapi-framework-cjs:';

/**
 * Keep the `@strapi/*` FRAMEWORK packages on the NATIVE CJS graph even when they
 * are imported from ESM app source (e.g. a TS `src/index.ts` doing
 * `import '@strapi/strapi'`).
 *
 * Task 4's two-graph rule: the framework's `dist/index.mjs` ESM build is not
 * standalone-importable (`import 'lodash/fp'` → ERR_UNSUPPORTED_DIR_IMPORT), so
 * it must NEVER be evaluated by the runner. For a CJS app this happened for free
 * (`require('@strapi/strapi')` via the cjs-interop native `createRequire`). An
 * ESM `.ts` app cannot `require` statically, so the runner would otherwise
 * resolve `@strapi/*` to the broken `.mjs` (or, via `mainFields`, mix the CJS
 * `dist` with framework `src` and crash).
 *
 * This plugin redirects every bare `@strapi/*` import to a virtual ESM shim that
 * `require`s the package through a native `createRequire` (resolving the CJS
 * `main` build) and re-exports it — both as `default` and as named exports
 * mirroring the CJS module's own keys. The framework therefore loads exactly as
 * it does in normal operation, off the runner's ESM evaluator entirely.
 */
export function strapiFrameworkCjs(cwd: string): Plugin {
  const appRequire = createRequire(`${cwd}/noop.js`);

  return {
    name: 'strapi:framework-cjs',
    enforce: 'pre',
    applyToEnvironment(environment) {
      return environment.name === 'server';
    },
    resolveId(id) {
      // Only intercept bare `@strapi/*` package imports (not deep relative ids
      // already resolved to absolute paths).
      if (id.startsWith(FRAMEWORK_PREFIX)) {
        return `${FRAMEWORK_VIRTUAL_PREFIX}${id}`;
      }
      return undefined;
    },
    load(id) {
      if (!id.startsWith(FRAMEWORK_VIRTUAL_PREFIX)) {
        return undefined;
      }
      const pkg = id.slice(FRAMEWORK_VIRTUAL_PREFIX.length);

      // Resolve + load the CJS build natively to discover its export names so we
      // can emit static named re-exports (some app source uses named imports).
      let names: string[] = [];
      try {
        const mod = appRequire(pkg) as Record<string, unknown>;
        if (mod && typeof mod === 'object') {
          names = Object.keys(mod).filter(
            (k) => k !== 'default' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k)
          );
        }
      } catch {
        names = [];
      }

      const namedReexports = names
        .map((n) => `export const ${n} = __cjs[${JSON.stringify(n)}];`)
        .join('\n');

      // The shim runs inside the runner but only ever touches a NATIVE require.
      return (
        `import { createRequire } from 'node:module';\n` +
        `const require = createRequire(${JSON.stringify(`${cwd}/noop.js`)});\n` +
        `const __cjs = require(${JSON.stringify(pkg)});\n` +
        `export default (__cjs && __cjs.__esModule) ? __cjs.default : __cjs;\n` +
        `${namedReexports}\n`
      );
    },
  };
}
