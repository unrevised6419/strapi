import path from 'node:path';

import { resolveServerBuildConfig } from '../build-server';
import { VIRTUAL_ID } from '../app-manifest-plugin';

import type { BuildContext } from '../../create-build-context';

const ctx = {
  cwd: '/abs/app',
  // create-build-context sets distPath = <dist.root>/build (the admin SPA). The
  // server bundle is emitted to a dedicated <appDir>/dist subdir, independent of
  // distPath, so it never collides with the Vite root or the admin build dir.
  distPath: '/abs/app/build',
  appDir: '/abs/app',
} as unknown as BuildContext;

// A TS app: create-build-context populates `tsconfig.config`. This flips the
// server build into "inline app source" (manifest) mode.
const tsCtx = {
  ...ctx,
  tsconfig: { config: { options: {} } },
} as unknown as BuildContext;

describe('resolveServerBuildConfig', () => {
  it('emits a CJS single-file server bundle with externalized bare specifiers', () => {
    const cfg = resolveServerBuildConfig(ctx);

    expect(cfg.build?.ssr).toBe(true);

    const out = (cfg.build?.rollupOptions?.output ?? {}) as Record<string, unknown>;
    expect(out.format).toBe('cjs');
    expect(out.codeSplitting).toBe(false);
    expect(out.entryFileNames).toBe('server.js');

    // bundle emitted into <appDir>/dist (inside the app dir, separate from the
    // Vite root) so externals resolve by walking up to app/node_modules.
    expect(cfg.build?.outDir).toBe('/abs/app/dist');

    const ext = cfg.build?.rollupOptions?.external as (id: string) => boolean;
    expect(ext('node:path')).toBe(true); // node builtins external
    expect(ext('@strapi/core')).toBe(true); // bare specifier external
    expect(ext('./local')).toBe(false); // relative bundled
    expect(ext(path.join('/abs/app/src/x'))).toBe(false); // absolute bundled
    // The app-source manifest virtual module must NOT be externalized — the
    // plugin resolves + inlines it (Task C5).
    expect(ext(VIRTUAL_ID)).toBe(false);
    expect(ext('\0some-virtual')).toBe(false);
  });

  it('injects the absolute app dir at build time (no cwd dependency)', () => {
    const cfg = resolveServerBuildConfig(ctx);
    expect((cfg.define as Record<string, string>).__STRAPI_APP_DIR__).toBe(
      JSON.stringify('/abs/app')
    );
  });

  it('a JS app (no tsconfig) keeps the disk-loading prod entry and no manifest plugin', () => {
    const cfg = resolveServerBuildConfig(ctx);
    const input = cfg.build?.rollupOptions?.input as { server: string };
    expect(input.server).toMatch(/server-prod-entry(\.[cm]?[jt]s)?$/);
    expect(input.server).not.toMatch(/server-prod-entry-manifest/);
    expect(cfg.plugins).toEqual([]);
  });

  it('a TS app (tsconfig present) inlines app source via the manifest entry + plugin', () => {
    const cfg = resolveServerBuildConfig(tsCtx);
    const input = cfg.build?.rollupOptions?.input as { server: string };
    expect(input.server).toMatch(/server-prod-entry-manifest/);
    const pluginNames = (cfg.plugins as Array<{ name: string }>).map((p) => p.name);
    expect(pluginNames).toContain('strapi:app-manifest');
  });
});
