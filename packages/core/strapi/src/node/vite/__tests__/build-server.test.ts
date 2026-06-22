import path from 'node:path';

import { resolveServerBuildConfig } from '../build-server';

import type { BuildContext } from '../../create-build-context';

const ctx = {
  cwd: '/abs/app',
  // create-build-context sets distPath = <dist.root>/build; the server bundle
  // is emitted one level up, directly in the app's dist root.
  distPath: '/abs/app/dist/build',
  appDir: '/abs/app',
} as unknown as BuildContext;

describe('resolveServerBuildConfig', () => {
  it('emits a CJS single-file server bundle with externalized bare specifiers', () => {
    const cfg = resolveServerBuildConfig(ctx);

    expect(cfg.build?.ssr).toBe(true);

    const out = (cfg.build?.rollupOptions?.output ?? {}) as Record<string, unknown>;
    expect(out.format).toBe('cjs');
    expect(out.codeSplitting).toBe(false);
    expect(out.entryFileNames).toBe('server.js');

    // bundle emitted into the app's dist root (inside the app dir) so externals
    // resolve by walking up to app/node_modules.
    expect(cfg.build?.outDir).toBe('/abs/app/dist');

    const ext = cfg.build?.rollupOptions?.external as (id: string) => boolean;
    expect(ext('node:path')).toBe(true); // node builtins external
    expect(ext('@strapi/core')).toBe(true); // bare specifier external
    expect(ext('./local')).toBe(false); // relative bundled
    expect(ext(path.join('/abs/app/src/x'))).toBe(false); // absolute bundled
  });

  it('injects the absolute app dir at build time (no cwd dependency)', () => {
    const cfg = resolveServerBuildConfig(ctx);
    expect((cfg.define as Record<string, string>).__STRAPI_APP_DIR__).toBe(
      JSON.stringify('/abs/app')
    );
  });
});
