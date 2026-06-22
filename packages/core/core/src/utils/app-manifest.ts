import path from 'path';
import type { Core } from '@strapi/types';

/**
 * Experimental (Phase C / Task C5) — the build-time app-source manifest.
 *
 * In a bundle-only production deploy the app's own source (`src/**`,
 * `config/**`, content-type `schema.json`) may NOT be present on disk: it is
 * inlined into `dist/server.js` by the Vite/Rolldown server build. Strapi's
 * loaders, however, DISCOVER modules by globbing the filesystem
 * (`fse.readdir`/`pathExists`/`glob`) and LOAD them via `importModule` / native
 * `require`. With no source on disk BOTH must come from the bundle.
 *
 * The manifest is generated at build time (see
 * `@strapi/strapi/node/vite/app-manifest-plugin`). It statically imports every
 * app source file (so Rolldown inlines them) and exposes:
 *
 *   - {@link AppManifest.files} — the absolute paths of every inlined file, so
 *     loaders can DISCOVER without touching disk.
 *   - {@link AppManifest.load} / {@link AppManifest.loadSync} — return the
 *     inlined module for a given absolute path, so loaders LOAD the bundled
 *     module instead of `require`-ing from disk.
 *
 * Off-path (dev, and JS-disk prod) the manifest is `undefined` and every loader
 * keeps its original disk-based discovery + load, byte-for-byte.
 */
export interface AppManifest {
  /** Absolute paths of every inlined app source file (for discovery). */
  files: string[];
  /** Async getter — backs `strapi.importModule`. */
  load: (absPath: string) => Promise<unknown>;
  /** Sync getter — used by the synchronous config loader in the constructor. */
  loadSync: (absPath: string) => unknown;
}

/** Does the manifest contain this absolute path? */
export const manifestHas = (manifest: AppManifest | undefined, absPath: string): boolean =>
  !!manifest && manifest.files.includes(absPath);

/**
 * List the direct children of `dir` recorded in the manifest, shaped like the
 * subset of `fs.Dirent` the loaders use (`name`, `isFile`, `isDirectory`).
 * Returns `undefined` when there is no manifest (caller falls back to disk).
 */
export const manifestReaddir = (
  manifest: AppManifest | undefined,
  dir: string
): Array<{ name: string; isFile: () => boolean; isDirectory: () => boolean }> | undefined => {
  if (!manifest) {
    return undefined;
  }

  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  const directChildren = new Map<string, boolean>(); // name -> isFile

  for (const file of manifest.files) {
    if (!file.startsWith(prefix)) {
      continue;
    }
    const rest = file.slice(prefix.length);
    const slash = rest.indexOf(path.sep);
    if (slash === -1) {
      directChildren.set(rest, true); // a file directly in dir
    } else {
      directChildren.set(rest.slice(0, slash), false); // a subdirectory
    }
  }

  return [...directChildren.entries()].map(([name, isFile]) => ({
    name,
    isFile: () => isFile,
    isDirectory: () => !isFile,
  }));
};

/** Does the manifest record `dir` as an existing (non-empty) directory? */
export const manifestDirExists = (manifest: AppManifest | undefined, dir: string): boolean => {
  if (!manifest) {
    return false;
  }
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  return manifest.files.some((file) => file.startsWith(prefix));
};

/** Resolve `strapi.appManifest` without widening the public Strapi type. */
export const getManifest = (strapi: Core.Strapi): AppManifest | undefined =>
  (strapi as unknown as { appManifest?: AppManifest }).appManifest;
