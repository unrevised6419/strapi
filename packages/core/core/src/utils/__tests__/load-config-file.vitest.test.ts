import { describe, it, expect } from 'vitest';
import { loadConfigFile } from '../load-config-file';

describe('loadConfigFile', () => {
  describe('sync path (no opts)', () => {
    it('returns {} for unknown extension', () => {
      // Unknown extension → default case returns {}
      // We can't easily load a real .json file in unit tests without fixtures,
      // but we can verify the sync path is still synchronous (returns non-Promise).
      const result = loadConfigFile('/nonexistent/file.xyz');
      // Should return {} immediately (not a Promise) for unknown extensions
      expect(result).toEqual({});
      expect(result).not.toBeInstanceOf(Promise);
    });

    it('returns a plain value (not a Promise) when called without opts', () => {
      const result = loadConfigFile('/some/file.xyz');
      // The sync path must never return a Promise
      const isPromise =
        result !== null &&
        typeof result === 'object' &&
        typeof (result as { then?: unknown }).then === 'function';
      expect(isPromise).toBe(false);
    });
  });

  describe('async path (with importModule)', () => {
    it('uses injected importModule when provided', async () => {
      const fake = async (id: string) => ({ default: { from: id } });
      const result = await loadConfigFile('/abs/config/server.ts', { importModule: fake });
      expect(result).toEqual({ from: '/abs/config/server.ts' });
    });

    it('unwraps default export from module', async () => {
      const fake = async () => ({ default: { host: 'localhost', port: 1337 } });
      const result = await loadConfigFile('/config/server.ts', { importModule: fake });
      expect(result).toEqual({ host: 'localhost', port: 1337 });
    });

    it('returns module directly if no default export', async () => {
      const fake = async () => ({ host: 'localhost', port: 1337 });
      const result = await loadConfigFile('/config/server.ts', { importModule: fake });
      expect(result).toEqual({ host: 'localhost', port: 1337 });
    });

    it('calls function exports with { env } and returns result', async () => {
      const fake = async () => ({
        default: ({ env }: { env: unknown }) => ({ calledWithEnv: typeof env }),
      });
      const result = await loadConfigFile('/config/server.ts', { importModule: fake });
      expect(result).toEqual({ calledWithEnv: 'function' });
    });

    it('passes the file path to importModule', async () => {
      let capturedId: string | undefined;
      const fake = async (id: string) => {
        capturedId = id;
        return { default: {} };
      };
      await loadConfigFile('/abs/path/to/plugin.ts', { importModule: fake });
      expect(capturedId).toBe('/abs/path/to/plugin.ts');
    });

    it('returns a Promise when importModule is provided', () => {
      const fake = async () => ({ default: {} });
      const result = loadConfigFile('/some/file.ts', { importModule: fake });
      expect(result).toBeInstanceOf(Promise);
    });
  });
});
