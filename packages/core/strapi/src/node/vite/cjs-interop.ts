import { createRequire } from 'node:module';

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
 * Heuristic CJS detection: the module touches `module.exports` / `exports.x` /
 * `require(...)` and contains no top-level ESM `import`/`export`. Mixed modules
 * (ESM with a stray `require`) are left untouched so the runner's normal ESM
 * transform handles them.
 */
function looksLikeCjs(code: string): boolean {
  const usesCjs = /\bmodule\.exports\b|\bexports\.[A-Za-z_$]|\brequire\s*\(/.test(code);
  if (!usesCjs) {
    return false;
  }
  const usesEsm = /^\s*(?:export|import)\s/m.test(code);
  return !usesEsm;
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
      // Ignore querystring'd virtual ids and non-JS files.
      const cleanId = id.split('?')[0];
      if (!/\.c?js$/.test(cleanId)) {
        return undefined;
      }
      if (!looksLikeCjs(code)) {
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
