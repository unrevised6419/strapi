import path from 'path';
import _ from 'lodash';
import fse from 'fs-extra';

import { importDefault, unwrapModule } from '@strapi/utils';
import { glob } from 'glob';
import { minimatch } from 'minimatch';
import { filePathToPropPath } from './filepath-to-prop-path';
import type { AppManifest } from './app-manifest';

type ImportModule = (id: string) => Promise<unknown>;

/**
 * Returns an Object build from a list of files matching a glob pattern in a directory
 * It builds a tree structure resembling the folder structure in dir
 *
 * When `importModule` is provided (experimental Vite source-only boot), non-JSON
 * source files are loaded through the runner (async) instead of the sync
 * `requireFn`/`importDefault`. Off-path (no `importModule`) the behaviour is
 * byte-for-byte the original sync `requireFn`/`importDefault`.
 *
 * When `appManifest` is provided (experimental prod bundle boot), file DISCOVERY
 * uses the manifest instead of globbing disk, and JSON files are loaded from the
 * inlined bundle. Off-path (no `appManifest`) the existing disk-glob + fse.readJson
 * path runs byte-for-byte unchanged.
 */
export const loadFiles = async <T extends object>(
  dir: string,
  pattern: string,
  {
    requireFn = importDefault,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    shouldUseFileNameAsKey = (_: string) => true,
    globArgs = {},
    importModule,
    appManifest,
  }: {
    requireFn?: (modName: string) => unknown;
    shouldUseFileNameAsKey?: (file: string) => boolean;
    globArgs?: Record<string, unknown>;
    importModule?: ImportModule;
    appManifest?: AppManifest;
  } = {}
): Promise<T> => {
  const root = {};

  // Manifest-aware discovery: filter inlined files to those under `dir` that
  // match `pattern`. Off-path (no manifest) falls through to the existing
  // disk-glob below, byte-for-byte unchanged.
  const files: string[] = appManifest
    ? manifestGlob(appManifest, dir, pattern)
    : await glob(pattern, { cwd: dir, ...globArgs });

  for (const file of files) {
    const absolutePath = path.resolve(dir, file);

    // load module
    delete require.cache[absolutePath];
    let mod;

    if (path.extname(absolutePath) === '.json') {
      if (appManifest) {
        // Manifest path: load inlined JSON (e.g. schema.json) from the bundle.
        const raw = appManifest.loadSync(absolutePath) as { default?: unknown };
        mod = raw?.default ?? raw;
      } else {
        mod = await fse.readJson(absolutePath);
      }
    } else if (importModule) {
      mod = unwrapModule(await importModule(absolutePath));
    } else {
      mod = requireFn(absolutePath);
    }

    Object.defineProperty(mod, '__filename__', {
      enumerable: true,
      configurable: false,
      writable: false,
      value: path.basename(file),
    });

    const propPath = filePathToPropPath(file, shouldUseFileNameAsKey(file));

    if (propPath.length === 0) _.merge(root, mod);
    _.merge(root, _.setWith({}, propPath, mod, Object));
  }

  return root as T;
};

/**
 * Filter manifest files to those under `dir` matching `pattern`, returning
 * paths relative to `dir` (exactly what `glob(pattern, {cwd:dir})` would return).
 */
const manifestGlob = (manifest: AppManifest, dir: string, pattern: string): string[] => {
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  const result: string[] = [];

  for (const file of manifest.files) {
    if (!file.startsWith(prefix)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    // relative path uses forward slashes for minimatch (glob convention)
    const rel = file.slice(prefix.length).split(path.sep).join('/');
    if (minimatch(rel, pattern, { dot: false })) {
      result.push(rel);
    }
  }

  return result;
};
