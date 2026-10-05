import fs from 'fs';
import os from 'os';
import path from 'path';

import { getEnabledPlugins } from '../get-enabled-plugins';

interface FixturePackage {
  name: string;
  pluginName: string;
  slices: Array<'server' | 'admin'>;
}

const writePackage = (appDir: string, { name, pluginName, slices }: FixturePackage) => {
  const dir = path.join(appDir, 'node_modules', name);
  fs.mkdirSync(dir, { recursive: true });

  const exports: Record<string, string> = { './package.json': './package.json' };

  if (slices.includes('server')) {
    exports['./strapi-server'] = './strapi-server.js';
    fs.writeFileSync(path.join(dir, 'strapi-server.js'), 'module.exports = {};');
  }

  if (slices.includes('admin')) {
    exports['./strapi-admin'] = './strapi-admin.js';
    fs.writeFileSync(path.join(dir, 'strapi-admin.js'), 'module.exports = {};');
  }

  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      strapi: { kind: 'plugin', name: pluginName },
      exports,
    })
  );
};

const appDirs: string[] = [];

const setupApp = ({
  packages,
  dependencies = {},
  devDependencies = {},
}: {
  packages: FixturePackage[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}) => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strapi-plugins-'));
  appDirs.push(appDir);
  packages.forEach((pkg) => writePackage(appDir, pkg));

  const info: Record<string, unknown> = { dependencies, devDependencies };

  global.strapi = {
    config: {
      get: jest.fn((key: string, def: unknown) => info[key.replace('info.', '')] ?? def),
    },
    log: { warn: jest.fn() },
    dirs: {
      app: { root: appDir },
      dist: { config: path.join(appDir, 'config') },
    },
  } as any;

  return appDir;
};

describe('getEnabledPlugins', () => {
  afterEach(() => {
    // @ts-expect-error - cleanup of the test global
    delete global.strapi;
    appDirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  });

  it('finds a plugin listed in devDependencies and marks it', async () => {
    const appDir = setupApp({
      packages: [{ name: 'dev-plugin', pluginName: 'dev-plugin', slices: ['server'] }],
      devDependencies: { 'dev-plugin': '1.0.0' },
    });

    const plugins = await getEnabledPlugins(strapi);

    expect(plugins['dev-plugin']).toMatchObject({
      enabled: true,
      isDevDependency: true,
      pathToPlugin: fs.realpathSync(path.join(appDir, 'node_modules', 'dev-plugin')),
    });
  });

  it('reads a package listed in both dependencies and devDependencies as a dependency', async () => {
    setupApp({
      packages: [{ name: 'both', pluginName: 'both', slices: ['server'] }],
      dependencies: { both: '1.0.0' },
      devDependencies: { both: '1.0.0' },
    });

    const plugins = await getEnabledPlugins(strapi);

    expect(plugins.both.isDevDependency).toBe(false);
  });

  it('keeps the server slice when an admin-only package shares the plugin name', async () => {
    setupApp({
      packages: [
        { name: 'foo-server', pluginName: 'foo', slices: ['server'] },
        { name: 'foo-admin', pluginName: 'foo', slices: ['admin'] },
      ],
      dependencies: { 'foo-server': '1.0.0' },
      devDependencies: { 'foo-admin': '1.0.0' },
    });

    const plugins = await getEnabledPlugins(strapi);

    expect(plugins.foo.info.packageName).toBe('foo-server');
    expect(strapi.log.warn).not.toHaveBeenCalled();
  });

  it('keeps the server slice whatever order the packages are listed in', async () => {
    setupApp({
      packages: [
        { name: 'foo-server', pluginName: 'foo', slices: ['server'] },
        { name: 'foo-admin', pluginName: 'foo', slices: ['admin'] },
      ],
      dependencies: { 'foo-server': '1.0.0', 'foo-admin': '1.0.0' },
    });

    const plugins = await getEnabledPlugins(strapi);

    expect(plugins.foo.info.packageName).toBe('foo-server');
  });

  it('prefers the dependency when both packages ship the server slice', async () => {
    setupApp({
      packages: [
        { name: 'foo-dep', pluginName: 'foo', slices: ['server'] },
        { name: 'foo-dev', pluginName: 'foo', slices: ['server'] },
      ],
      dependencies: { 'foo-dep': '1.0.0' },
      devDependencies: { 'foo-dev': '1.0.0' },
    });

    const plugins = await getEnabledPlugins(strapi);

    expect(plugins.foo).toMatchObject({
      isDevDependency: false,
      info: { packageName: 'foo-dep' },
    });
    expect(strapi.log.warn).toHaveBeenCalledTimes(1);
    expect(strapi.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('server slice in both "foo-dev" and "foo-dep"')
    );
  });
});
