import { join, extname, basename } from 'path';
import fse from 'fs-extra';
import { importDefault, unwrapModule } from '@strapi/utils';
import type { Core } from '@strapi/types';
import { middlewares as internalMiddlewares } from '../middlewares';

// Source extensions loaded via the runner on the experimental source-only path.
const SOURCE_EXTS = ['.js', '.ts', '.mts', '.cts', '.mjs', '.cjs'];

// TODO:: allow folders with index.js inside for bigger policies
export default async function loadMiddlewares(strapi: Core.Strapi) {
  const localMiddlewares = await loadLocalMiddlewares(strapi);

  strapi.get('middlewares').add(`global::`, localMiddlewares);
  strapi.get('middlewares').add(`strapi::`, internalMiddlewares);
}

const loadLocalMiddlewares = async (strapi: Core.Strapi) => {
  const dir = strapi.dirs.dist.middlewares;

  if (!(await fse.pathExists(dir))) {
    return {};
  }

  const importModule = strapi.importModule;

  const middlewares: Record<string, Core.MiddlewareFactory> = {};
  const paths = await fse.readdir(dir, { withFileTypes: true });

  for (const fd of paths) {
    const { name } = fd;
    const fullPath = join(dir, name);
    const ext = extname(name);

    if (!fd.isFile()) {
      continue;
    }

    if (importModule && SOURCE_EXTS.includes(ext)) {
      // Source-only path: load any source extension (incl. `.ts`) via the runner.
      const key = basename(name, ext);
      middlewares[key] = unwrapModule(await importModule(fullPath)) as Core.MiddlewareFactory;
    } else if (!importModule && ext === '.js') {
      // Off-path: byte-for-byte the original `.js`-only sync load.
      const key = basename(name, '.js');
      middlewares[key] = importDefault(fullPath);
    }
  }

  return middlewares;
};
