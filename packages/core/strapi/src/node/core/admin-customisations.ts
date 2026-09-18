import path from 'node:path';
import { convertSystemPathToModulePath, pathExists } from './files';
import type { BaseContext } from '../types';

const ADMIN_APP_FILES = ['app.js', 'app.mjs', 'app.ts', 'app.jsx', 'app.tsx'];

interface AdminCustomisations {
  config?: {
    locales?: string[];
  };
  bootstrap?: (...args: any[]) => any;
}

interface AppFile {
  /**
   * The system path to the file
   */
  path: string;
  /**
   * The module path to the file i.e. how you would import it
   */
  modulePath: string;
}

const loadUserAppFile = async ({
  runtimeDir,
  adminSrcDir,
}: Pick<BaseContext, 'runtimeDir'> & {
  /**
   * The absolute path to the admin source directory, i.e. `strapi.dirs.app.adminSrc`
   */
  adminSrcDir: string;
}): Promise<AppFile | undefined> => {
  for (const file of ADMIN_APP_FILES) {
    const filePath = path.join(adminSrcDir, file);

    if (await pathExists(filePath)) {
      return {
        path: filePath,
        modulePath: convertSystemPathToModulePath(path.relative(runtimeDir, filePath)),
      };
    }
  }

  return undefined;
};

export { loadUserAppFile };
export type { AdminCustomisations, AppFile };
