import { join, extname, basename } from 'path';
import fse from 'fs-extra';
import { importDefault, unwrapModule } from '@strapi/utils';

import type { Core } from '@strapi/types';

// Source extensions loaded via the runner on the experimental source-only path.
const SOURCE_EXTS = ['.js', '.ts', '.mts', '.cts', '.mjs', '.cjs'];

// TODO:: allow folders with index.js inside for bigger policies
export default async function loadPolicies(strapi: Core.Strapi) {
  const dir = strapi.dirs.dist.policies;

  if (!(await fse.pathExists(dir))) {
    return;
  }

  const importModule = strapi.importModule;

  const policies: Record<string, Core.Policy> = {};
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
      policies[key] = unwrapModule(await importModule(fullPath)) as Core.Policy;
    } else if (!importModule && ext === '.js') {
      // Off-path: byte-for-byte the original `.js`-only sync load.
      const key = basename(name, '.js');
      policies[key] = importDefault(fullPath);
    }
  }

  strapi.get('policies').add(`global::`, policies);
}
