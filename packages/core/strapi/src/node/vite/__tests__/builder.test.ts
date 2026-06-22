import { buildApp } from '../builder';

import type { BuildContext } from '../../create-build-context';

const buildClientAdmin = jest.fn(async () => {});
const buildServer = jest.fn(async () => {});

jest.mock('../build', () => ({
  build: (ctx: unknown) => buildClientAdmin(ctx),
}));

jest.mock('../build-server', () => ({
  buildServer: (ctx: unknown) => buildServer(ctx),
}));

const ctx = {
  cwd: '/abs/app',
  distPath: '/abs/app/build',
  appDir: '/abs/app',
} as unknown as BuildContext;

describe('buildApp', () => {
  beforeEach(() => {
    buildClientAdmin.mockClear();
    buildServer.mockClear();
  });

  it('builds BOTH environments (admin client SPA + server bundle) from one call', async () => {
    await buildApp(ctx);

    expect(buildClientAdmin).toHaveBeenCalledTimes(1);
    expect(buildClientAdmin).toHaveBeenCalledWith(ctx);
    expect(buildServer).toHaveBeenCalledTimes(1);
    expect(buildServer).toHaveBeenCalledWith(ctx);
  });

  it('builds the admin client SPA BEFORE the server bundle (admin survives a server failure)', async () => {
    const order: string[] = [];
    buildClientAdmin.mockImplementationOnce(async () => {
      order.push('client');
    });
    buildServer.mockImplementationOnce(async () => {
      order.push('server');
    });

    await buildApp(ctx);

    expect(order).toEqual(['client', 'server']);
  });
});
