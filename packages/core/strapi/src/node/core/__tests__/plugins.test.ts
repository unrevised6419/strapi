import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getEnabledPlugins } from '../plugins';
import * as files from '../files';
import * as dependencies from '../dependencies';

jest.mock('../files', () => {
  const actual = jest.requireActual('../files');
  return {
    __esModule: true,
    ...actual,
    loadFile: jest.fn(),
  };
});

jest.mock('../dependencies', () => {
  const actual = jest.requireActual('../dependencies');
  return {
    __esModule: true,
    ...actual,
    getModule: jest.fn(),
  };
});

const mockedLoadFile = files.loadFile as jest.MockedFunction<typeof files.loadFile>;
const mockedGetModule = dependencies.getModule as jest.MockedFunction<
  typeof dependencies.getModule
>;

const installedPluginPackage = (name: string) => ({
  name,
  version: '1.0.0',
  strapi: { kind: 'plugin', name },
});

interface ContextOptions {
  pluginsConfig?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  cwd?: string;
  installedPackages?: Record<string, unknown>;
}

const buildContext = ({
  pluginsConfig = {},
  dependencies: deps = {},
  devDependencies: devDeps = {},
  cwd = '/app',
  installedPackages = {},
}: ContextOptions = {}) => {
  mockedLoadFile.mockReset();
  // loadUserPluginsFile tries plugins.js / .mjs / .ts and returns the first hit
  mockedLoadFile.mockImplementation(async (filePath: string) =>
    filePath.endsWith('plugins.js') ? pluginsConfig : undefined
  );

  mockedGetModule.mockReset();
  mockedGetModule.mockImplementation(
    async (name: string) => (installedPackages[name] ?? null) as any
  );

  return {
    cwd,
    runtimeDir: '/app/.strapi/client',
    logger: {
      debug: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      error: jest.fn(),
    } as any,
    strapi: {
      config: {
        get: jest.fn((key: string, def: unknown) => {
          if (key === 'info.dependencies') return deps;
          if (key === 'info.devDependencies') return devDeps;
          return def;
        }),
      },
      dirs: { app: { config: '/app/config' } },
    } as any,
  };
};

describe('admin build getEnabledPlugins', () => {
  describe('installed (node_modules) plugins respect config/plugins enabled flag (#23269)', () => {
    const deps = { 'my-plugin': '1.0.0' };
    const installedPackages = { 'my-plugin': installedPluginPackage('my-plugin') };

    it('includes an installed plugin that has no config entry', async () => {
      const ctx = buildContext({ dependencies: deps, installedPackages });
      const plugins = await getEnabledPlugins(ctx);
      expect(Object.keys(plugins)).toContain('my-plugin');
    });

    it('excludes an installed plugin disabled via { enabled: false }', async () => {
      const ctx = buildContext({
        pluginsConfig: { 'my-plugin': { enabled: false } },
        dependencies: deps,
        installedPackages,
      });
      const plugins = await getEnabledPlugins(ctx);
      expect(Object.keys(plugins)).not.toContain('my-plugin');
    });

    it('excludes an installed plugin disabled via the boolean shorthand `false`', async () => {
      const ctx = buildContext({
        pluginsConfig: { 'my-plugin': false },
        dependencies: deps,
        installedPackages,
      });
      const plugins = await getEnabledPlugins(ctx);
      expect(Object.keys(plugins)).not.toContain('my-plugin');
    });

    it('includes an installed plugin enabled via { enabled: true }', async () => {
      const ctx = buildContext({
        pluginsConfig: { 'my-plugin': { enabled: true } },
        dependencies: deps,
        installedPackages,
      });
      const plugins = await getEnabledPlugins(ctx);
      expect(Object.keys(plugins)).toContain('my-plugin');
    });
  });

  describe('local { resolve } plugins match the server loader semantics', () => {
    it('excludes a local plugin declared with resolve but no explicit enabled', async () => {
      const ctx = buildContext({ pluginsConfig: { foo: { resolve: './src/plugins/foo' } } });
      const plugins = await getEnabledPlugins(ctx);
      expect(Object.keys(plugins)).not.toContain('foo');
    });

    it('excludes a local plugin with enabled: false', async () => {
      const ctx = buildContext({
        pluginsConfig: { foo: { enabled: false, resolve: './src/plugins/foo' } },
      });
      const plugins = await getEnabledPlugins(ctx);
      expect(Object.keys(plugins)).not.toContain('foo');
    });

    it('includes a local plugin with enabled: true', async () => {
      const ctx = buildContext({
        pluginsConfig: { foo: { enabled: true, resolve: './src/plugins/foo' } },
      });
      const plugins = await getEnabledPlugins(ctx);
      expect(Object.keys(plugins)).toContain('foo');
    });
  });

  describe('devDependencies', () => {
    let appDir: string;

    // Writes a package to the app's node_modules, with a `strapi-admin` export when it has one
    const writePackage = (name: string, { admin }: { admin: boolean }) => {
      const dir = path.join(appDir, 'node_modules', name);
      fs.mkdirSync(dir, { recursive: true });

      const exports: Record<string, string> = { './package.json': './package.json' };

      if (admin) {
        exports['./strapi-admin'] = './strapi-admin.js';
        fs.writeFileSync(path.join(dir, 'strapi-admin.js'), 'module.exports = {};');
      }

      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, exports }));
    };

    const splitPlugin = {
      'foo-admin': { name: 'foo-admin', strapi: { kind: 'plugin', name: 'foo' } },
      'foo-server': { name: 'foo-server', strapi: { kind: 'plugin', name: 'foo' } },
    };

    beforeEach(() => {
      appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strapi-admin-plugins-'));
      writePackage('foo-admin', { admin: true });
      writePackage('foo-server', { admin: false });
    });

    afterEach(() => {
      fs.rmSync(appDir, { recursive: true, force: true });
    });

    it('includes a plugin listed in devDependencies', async () => {
      const ctx = buildContext({
        devDependencies: { 'my-plugin': '1.0.0' },
        installedPackages: { 'my-plugin': installedPluginPackage('my-plugin') },
      });
      const plugins = await getEnabledPlugins(ctx);
      expect(plugins['my-plugin']).toMatchObject({ modulePath: 'my-plugin' });
    });

    it('keeps the admin slice when a server-only dependency shares the plugin name', async () => {
      const ctx = buildContext({
        cwd: appDir,
        dependencies: { 'foo-server': '1.0.0' },
        devDependencies: { 'foo-admin': '1.0.0' },
        installedPackages: splitPlugin,
      });
      const plugins = await getEnabledPlugins(ctx);
      expect(plugins.foo).toMatchObject({ modulePath: 'foo-admin' });
      expect(ctx.logger.warn).not.toHaveBeenCalled();
    });

    it('keeps the admin slice whatever order the packages are listed in', async () => {
      const ctx = buildContext({
        cwd: appDir,
        dependencies: { 'foo-admin': '1.0.0', 'foo-server': '1.0.0' },
        installedPackages: splitPlugin,
      });
      const plugins = await getEnabledPlugins(ctx);
      expect(plugins.foo).toMatchObject({ modulePath: 'foo-admin' });
    });

    it('prefers the dependency when both packages ship the admin slice', async () => {
      writePackage('foo-dev', { admin: true });

      const ctx = buildContext({
        cwd: appDir,
        dependencies: { 'foo-admin': '1.0.0' },
        devDependencies: { 'foo-dev': '1.0.0' },
        installedPackages: {
          ...splitPlugin,
          'foo-dev': { name: 'foo-dev', strapi: { kind: 'plugin', name: 'foo' } },
        },
      });
      const plugins = await getEnabledPlugins(ctx);
      expect(plugins.foo).toMatchObject({ modulePath: 'foo-admin' });
      expect(ctx.logger.warn).toHaveBeenCalledTimes(1);
      expect(ctx.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('admin slice in both "foo-dev" and "foo-admin"')
      );
    });
  });
});
