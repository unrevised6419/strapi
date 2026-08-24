// @ts-check

/** @import { Linter } from 'eslint' */

/**
 * Shared lodash policy for the monorepo. Two separate bans live here.
 *
 * 1. `BANNED_MEMBERS` — banned everywhere, from both `lodash` and `lodash/fp`. Each has a native
 *    equivalent, so importing it only costs a module and hides the standard API.
 *
 * 2. `FP_MIGRATED_MEMBERS` — banned from `lodash/fp` only, and fine from `lodash`. These are the
 *    helpers whose fp version is behaviourally identical to the plain one: unary, same signature,
 *    nothing to curry and no data-last argument order to flip. Reaching for the fp build buys
 *    nothing and splits the codebase across two lodash module graphs for the same function.
 *
 *    This ban also protects a migration in progress: the goal is to swap `lodash` for
 *    `es-toolkit/compat`, which mirrors the plain lodash API and ships no fp build at all. Every
 *    `lodash/fp` import is therefore a blocker for that swap, and each member added to the list
 *    below is one fewer call site to revisit. Members that legitimately still need fp (curried or
 *    capped-arity call sites) carry an `eslint-disable` with the reason on the line.
 *
 * The rules below ban every way of reaching a member — ESM named imports, deep submodule imports,
 * CommonJS `require`, and (for ban 1) namespace member access (`_.isArray`) — because a single
 * `no-restricted-imports` entry misses most of them.
 *
 * Named imports are matched via `no-restricted-syntax` rather than `no-restricted-imports`
 * `importNames`, because the latter also rejects `import * as _ from 'lodash'` outright; the
 * namespace itself is fine, only the member access is not.
 *
 * Ban 2 deliberately has no namespace-access selector: `_.isNil` is only a violation when `_` is
 * bound to `lodash/fp`, and a selector cannot see which module the local name came from. Banning it
 * unconditionally would reject the correct `import _ from 'lodash'; _.isNil(x)`.
 */

/**
 * A single `no-restricted-imports` `paths` entry.
 *
 * @typedef {{ name: string; importNames?: string[]; message?: string }} RestrictedImportPath
 */

/**
 * A single `no-restricted-syntax` entry.
 *
 * @typedef {{ selector: string; message?: string }} RestrictedSyntax
 */

/** Local identifiers conventionally bound to a lodash namespace. */
const LODASH_NAMESPACES = '(_|lodash|fp)';

/** Members banned everywhere, with the native replacement to reach for instead. */
const BANNED_MEMBERS = [
  {
    name: 'isArray',
    message:
      'Use the native `Array.isArray` instead of lodash `isArray` (lodash re-exports the native function).',
  },
  {
    name: 'forEach',
    message:
      'Use native iteration instead of lodash `forEach` — `for...of`, `Array.prototype.forEach`, or `Object.entries`/`Object.values` for objects.',
  },
];

/**
 * Members that must come from `lodash`, never `lodash/fp`.
 *
 * Every entry is unary with an identical signature in both builds, so the two are interchangeable
 * at the call site and the import can be swapped without touching any argument.
 *
 * Do NOT add a helper here if its fp version differs in any way — `pipe`/`curry`/`prop` exist only
 * in fp; `merge`/`set`/`update`/`assoc` are immutable in fp and mutating in plain lodash; and
 * anything data-last (`get`, `has`, `omit`, `pick`, `map`, …) takes its arguments in the opposite
 * order. Those all belong in `lodash/fp` and are intentionally absent.
 */
const FP_MIGRATED_MEMBERS = [
  'camelCase',
  'capitalize',
  'castArray',
  'clone',
  'cloneDeep',
  'compact',
  'constant',
  'entries',
  'eq',
  'first',
  'flatten',
  'head',
  'identity',
  'isBoolean',
  'isDate',
  'isEmpty',
  'isEqual',
  'isFinite',
  'isFunction',
  'isInteger',
  'isNaN',
  'isNil',
  'isNull',
  'isNumber',
  'isObject',
  'isPlainObject',
  'isString',
  'isUndefined',
  'kebabCase',
  'keys',
  'last',
  'lowerFirst',
  'max',
  'mean',
  'negate',
  'once',
  'size',
  'snakeCase',
  'sum',
  'toLower',
  'toNumber',
  'toPath',
  'toPlainObject',
  'toString',
  'toUpper',
  'trim',
  'uniq',
  'upperFirst',
  'values',
];

const FP_MIGRATED_MESSAGE =
  "Import this helper from 'lodash' rather than 'lodash/fp' — the fp and non-fp versions are " +
  'identical (unary, same signature), and `lodash/fp` blocks the planned move to ' +
  "`es-toolkit/compat`, which has no fp build. In admin/front code, import it as 'lodash/<method>'. " +
  'If you genuinely need the curried or capped-arity behaviour, disable this rule on the line and ' +
  'say why.';

/** Alternation of the fp-migrated members, for use inside an esquery attribute regex. */
const FP_MIGRATED_PATTERN = `^(${FP_MIGRATED_MEMBERS.join('|')})$`;

/** `no-restricted-imports` patterns: `import isArray from 'lodash/isArray'`. */
const restrictedImportPatterns = [
  ...BANNED_MEMBERS.map(({ name, message }) => ({
    group: [`lodash/${name}`, `lodash/fp/${name}`],
    message,
  })),
  // `import isNil from 'lodash/fp/isNil'` — the plain `lodash/isNil` form stays allowed.
  {
    group: FP_MIGRATED_MEMBERS.map((name) => `lodash/fp/${name}`),
    message: FP_MIGRATED_MESSAGE,
  },
];

/**
 * `no-restricted-syntax` entries, covering the forms `no-restricted-imports` cannot express.
 *
 * @type {RestrictedSyntax[]}
 */
const restrictedSyntax = BANNED_MEMBERS.flatMap(({ name, message }) => [
  {
    // `import { isArray } from 'lodash'` / `'lodash/fp'`
    selector: `ImportDeclaration[source.value=/^lodash(\\/fp)?$/] > ImportSpecifier[imported.name='${name}']`,
    message,
  },
  {
    // `_.isArray(x)`, `lodash.isArray(x)`, `fp.isArray(x)`
    selector: `MemberExpression[object.name=/^${LODASH_NAMESPACES}$/][property.name='${name}']`,
    message,
  },
  {
    // `const { isArray } = require('lodash')` / `require('lodash/fp')`
    selector: `VariableDeclarator[init.callee.name='require'][init.arguments.0.value=/^lodash(\\/fp)?$/] > ObjectPattern > Property[key.name='${name}']`,
    message,
  },
  {
    // `require('lodash/isArray')`
    selector: `CallExpression[callee.name='require'][arguments.0.value=/^lodash(\\/fp)?\\/${name}$/]`,
    message,
  },
]);

/**
 * Selectors for the fp-migrated members. One regex alternation rather than two selectors per
 * member, so the whole list costs two matchers instead of a hundred.
 *
 * @type {RestrictedSyntax[]}
 */
const fpMigratedSyntax = [
  {
    // `import { isNil } from 'lodash/fp'`
    selector: `ImportDeclaration[source.value='lodash/fp'] > ImportSpecifier[imported.name=/${FP_MIGRATED_PATTERN}/]`,
    message: FP_MIGRATED_MESSAGE,
  },
  {
    // `const { isNil } = require('lodash/fp');`
    selector: `VariableDeclarator[init.callee.name='require'][init.arguments.0.value='lodash/fp'] > ObjectPattern > Property[key.name=/${FP_MIGRATED_PATTERN}/]`,
    message: FP_MIGRATED_MESSAGE,
  },
];

/**
 * Builds the `no-restricted-imports` value, appending the lodash patterns to any package-specific
 * paths.
 *
 * @param {RestrictedImportPath[]} [paths]
 * @returns {Linter.RuleEntry<[{ paths: RestrictedImportPath[]; patterns: typeof restrictedImportPatterns }]>}
 */
const noRestrictedImports = (paths = []) => [
  'error',
  { paths, patterns: restrictedImportPatterns },
];

/**
 * Builds the `no-restricted-syntax` value, appending the lodash selectors to any package-specific
 * ones.
 *
 * @param {RestrictedSyntax[]} [selectors]
 * @returns {Linter.RuleEntry<RestrictedSyntax[]>}
 */
const noRestrictedSyntax = (selectors = []) => [
  'error',
  ...selectors,
  ...restrictedSyntax,
  ...fpMigratedSyntax,
];

module.exports = { noRestrictedImports, noRestrictedSyntax };
