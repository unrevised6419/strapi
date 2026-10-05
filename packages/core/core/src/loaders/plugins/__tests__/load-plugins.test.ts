import fs from 'fs';
import os from 'os';
import path from 'path';

import loadPlugins from '..';
import { getEnabledPlugins } from '../get-enabled-plugins';

jest.mock('../get-enabled-plugins', () => ({ getEnabledPlugins: jest.fn() }));

const mockedGetEnabledPlugins = getEnabledPlugins as jest.MockedFunction<typeof getEnabledPlugins>;

describe('loadPlugins', () => {
  let appDir: string;
  let strapiMock: any;

  beforeEach(() => {
    appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strapi-load-plugins-'));

    const pluginDir = path.join(appDir, 'node_modules', 'foo-server');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'strapi-server.js'), 'module.exports = {};');

    strapiMock = {
      config: { set: jest.fn() },
      dirs: { dist: { config: path.join(appDir, 'config'), extensions: path.join(appDir, 'ext') } },
      log: { warn: jest.fn() },
      get: jest.fn(() => ({ add: jest.fn() })),
    };
    global.strapi = strapiMock;
  });

  afterEach(() => {
    // @ts-expect-error - cleanup of the test global
    delete global.strapi;
    fs.rmSync(appDir, { recursive: true, force: true });
  });

  const enabledPlugin = (isDevDependency: boolean) => ({
    foo: {
      enabled: true,
      pathToPlugin: path.join(appDir, 'node_modules', 'foo-server'),
      info: { name: 'foo', packageName: 'foo-server' },
      packageInfo: { name: 'foo-server' },
      isDevDependency,
    },
  });

  it('warns when the server slice comes from devDependencies', async () => {
    mockedGetEnabledPlugins.mockResolvedValue(enabledPlugin(true));

    await loadPlugins(strapiMock);

    expect(strapiMock.log.warn).toHaveBeenCalledWith(expect.stringContaining('"foo-server"'));
    expect(strapiMock.log.warn).toHaveBeenCalledWith(expect.stringContaining('devDependencies'));
  });

  it('does not warn when the server slice comes from dependencies', async () => {
    mockedGetEnabledPlugins.mockResolvedValue(enabledPlugin(false));

    await loadPlugins(strapiMock);

    expect(strapiMock.log.warn).not.toHaveBeenCalled();
  });

  it('does not warn for a dev dependency without a server slice', async () => {
    mockedGetEnabledPlugins.mockResolvedValue(enabledPlugin(true));
    fs.rmSync(path.join(appDir, 'node_modules', 'foo-server', 'strapi-server.js'));

    await loadPlugins(strapiMock);

    expect(strapiMock.log.warn).not.toHaveBeenCalled();
  });
});
