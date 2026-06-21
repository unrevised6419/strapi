import { strapi } from './plugin';

const fakeCtx = { target: ['chrome>=90'], env: {}, basePath: '/admin/' } as any;

describe('strapi() vite plugin', () => {
  it('contributes a client environment config via configEnvironment', () => {
    const plugin = strapi({ ctx: fakeCtx });
    expect(plugin.name).toBe('strapi');
    const clientCfg = (plugin.configEnvironment as any)('client', {});
    expect(clientCfg).toBeDefined();
    expect(clientCfg.resolve?.dedupe).toContain('react');
  });

  it('returns undefined for unknown environments (for now)', () => {
    const plugin = strapi({ ctx: fakeCtx });
    expect((plugin.configEnvironment as any)('server', {})).toBeUndefined();
  });
});
