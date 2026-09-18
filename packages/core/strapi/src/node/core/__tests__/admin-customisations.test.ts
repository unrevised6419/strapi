import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadUserAppFile } from '../admin-customisations';
import { getUserConfig } from '../config';
import type { BuildContext } from '../../create-build-context';

describe('admin customisations lookup', () => {
  let appDir: string;

  beforeEach(async () => {
    appDir = await fs.mkdtemp(path.join(os.tmpdir(), 'strapi-admin-dirs-'));
  });

  afterEach(async () => {
    await fs.rm(appDir, { recursive: true, force: true });
  });

  const writeFile = async (relativePath: string, content: string) => {
    const filePath = path.join(appDir, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
    return filePath;
  };

  describe('loadUserAppFile', () => {
    it('finds the app file in the admin source directory', async () => {
      const filePath = await writeFile('admin/src/app.tsx', 'export default {};');
      const runtimeDir = path.join(appDir, '.strapi', 'client');

      const appFile = await loadUserAppFile({
        runtimeDir,
        adminSrcDir: path.join(appDir, 'admin', 'src'),
      });

      expect(appFile).toEqual({
        path: filePath,
        modulePath: '../../admin/src/app.tsx',
      });
    });

    it('returns undefined when the admin source directory has no app file', async () => {
      await writeFile('src/admin/app.tsx', 'export default {};');

      const appFile = await loadUserAppFile({
        runtimeDir: path.join(appDir, '.strapi', 'client'),
        adminSrcDir: path.join(appDir, 'admin', 'src'),
      });

      expect(appFile).toBeUndefined();
    });
  });

  describe('getUserConfig', () => {
    it('loads the bundler config from the admin directory', async () => {
      await writeFile('admin/vite.config.js', 'module.exports = () => "from admin";');

      const ctx = {
        appDir,
        strapi: {
          dirs: { app: { admin: path.join(appDir, 'admin') } },
        },
      } as unknown as BuildContext;

      const userConfig = await getUserConfig<() => string>(['vite.config.js'], ctx);

      expect(userConfig?.()).toBe('from admin');
    });
  });
});
