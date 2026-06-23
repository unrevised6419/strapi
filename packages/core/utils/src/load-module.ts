import importDefault from './import-default';

/**
 * Unwrap an ESM namespace object the way `importDefault` unwraps a CJS module:
 * prefer the `default` export when present, otherwise return the namespace.
 *
 * This mirrors `importDefault`'s `__esModule ? mod.default : mod` semantics for
 * the async (`importModule`) path used by the experimental Vite server boot,
 * where app source is loaded through the Module Runner instead of `require`.
 */
export function unwrapModule(mod: unknown): unknown {
  return (mod as { default?: unknown })?.default ?? mod;
}

/**
 * Load a single app-source module, source-only when an async `importModule`
 * (the Vite server Module Runner's `import`) is provided, otherwise via the
 * legacy sync `require`-based `importDefault`.
 *
 * Off-path (no `importModule`): byte-for-byte the existing `importDefault`
 * behaviour, including `__esModule ? default : mod` unwrapping.
 */
export async function loadModule(
  fullPath: string,
  importModule?: (id: string) => Promise<unknown>
): Promise<unknown> {
  if (importModule) {
    const mod = await importModule(fullPath);
    return unwrapModule(mod);
  }
  return importDefault(fullPath);
}
