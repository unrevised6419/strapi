import { generateManifestSource, appManifestPlugin, VIRTUAL_ID } from '../app-manifest-plugin';

describe('app-manifest-plugin', () => {
  describe('generateManifestSource', () => {
    it('statically imports every file and maps absolute path -> module', () => {
      const files = ['/abs/app/src/index.ts', '/abs/app/config/server.ts'];
      const src = generateManifestSource(files);

      // every file is a STATIC import so Rolldown inlines it
      expect(src).toContain('import * as m0 from "/abs/app/src/index.ts";');
      expect(src).toContain('import * as m1 from "/abs/app/config/server.ts";');

      // the path -> module map backs load/loadSync
      expect(src).toContain('"/abs/app/src/index.ts": m0,');
      expect(src).toContain('"/abs/app/config/server.ts": m1,');

      // the discovery list + the three consumer surfaces
      expect(src).toContain('files: FILES');
      expect(src).toContain('load:');
      expect(src).toContain('loadSync:');
      expect(src).toContain(JSON.stringify(files));
    });

    it('throws (at runtime) for a path that was not inlined', () => {
      const src = generateManifestSource([]);
      expect(src).toContain('module not inlined');
    });
  });

  describe('appManifestPlugin', () => {
    it('resolves the virtual module id to a \\0-prefixed resolved id', () => {
      const plugin = appManifestPlugin('/abs/app');
      const resolve = plugin.resolveId as (id: string) => string | null;
      expect(resolve.call({}, VIRTUAL_ID)).toBe(`\0${VIRTUAL_ID}`);
      expect(resolve.call({}, 'some-other-id')).toBeNull();
    });

    it('loads only the resolved virtual id', () => {
      const plugin = appManifestPlugin('/abs/app');
      const load = plugin.load as (id: string) => string | null;
      expect(load.call({}, 'some-other-id')).toBeNull();
      // the resolved virtual id returns generated manifest source (string)
      expect(typeof load.call({}, `\0${VIRTUAL_ID}`)).toBe('string');
    });
  });
});
