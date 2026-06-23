import path from 'path';
import _ from 'lodash';
import fse from 'fs-extra';

import { importDefault, unwrapModule } from '@strapi/utils';
import { glob } from 'glob';
import { filePathToPropPath } from './filepath-to-prop-path';

type ImportModule = (id: string) => Promise<unknown>;

/**
 * Returns an Object build from a list of files matching a glob pattern in a directory
 * It builds a tree structure resembling the folder structure in dir
 *
 * When `importModule` is provided (experimental Vite source-only boot), non-JSON
 * source files are loaded through the runner (async) instead of the sync
 * `requireFn`. Off-path (no `importModule`) the behaviour is byte-for-byte the
 * original sync `requireFn`/`importDefault`.
 */
export const loadFiles = async <T extends object>(
  dir: string,
  pattern: string,
  {
    requireFn = importDefault,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    shouldUseFileNameAsKey = (_: any) => true,
    globArgs = {},
    importModule,
  }: {
    requireFn?: (modName: string) => unknown;
    shouldUseFileNameAsKey?: (file: string) => boolean;
    globArgs?: Record<string, unknown>;
    importModule?: ImportModule;
  } = {}
): Promise<T> => {
  const root = {};
  const files = await glob(pattern, { cwd: dir, ...globArgs });

  for (const file of files) {
    const absolutePath = path.resolve(dir, file);

    // load module
    delete require.cache[absolutePath];
    let mod;

    if (path.extname(absolutePath) === '.json') {
      mod = await fse.readJson(absolutePath);
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
