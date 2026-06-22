import path from 'path';
import fs from 'fs';
import { env } from '@strapi/utils';
import { loadConfigFile } from '../utils/load-config-file';
import { type AppManifest, manifestReaddir, manifestDirExists } from '../utils/app-manifest';

// On the experimental source-only path, config may be authored in TS and is
// inlined into the bundle — widen the accepted extensions accordingly.
const VALID_EXTENSIONS = ['.js', '.json'];
const VALID_SOURCE_EXTENSIONS = ['.js', '.ts', '.mts', '.cts', '.mjs', '.cjs', '.json'];

/**
 * Evaluate a config module already inlined in the manifest (synchronously). The
 * config loader runs in the Strapi constructor (sync), so it cannot use the
 * async `importModule`; the manifest's `loadSync` returns the bundled module.
 */
const evalManifestConfig = (manifest: AppManifest, absPath: string): unknown => {
  if (path.extname(absPath) === '.json') {
    return manifest.loadSync(absPath);
  }
  const mod = manifest.loadSync(absPath) as { default?: unknown };
  const val = mod?.default ?? mod;
  return typeof val === 'function' ? (val as (a: { env: typeof env }) => unknown)({ env }) : val;
};

// These filenames are restricted, but will also emit a warning that the filename is probably a mistake
const MISTAKEN_FILENAMES = {
  middleware: 'middlewares',
  plugin: 'plugins',
};

// the following are restricted to prevent conflicts with existing STRAPI_* env vars or root level config options
// must all be lowercase to match validator
const RESTRICTED_FILENAMES = [
  // existing env vars
  'uuid',
  'hosting',
  'license',
  'enforce',
  'disable',
  'enable',
  'telemetry',

  // reserved for future internal use
  'strapi',
  'internal',

  // root level config options
  // TODO: it would be better to move these out of the root config and allow them to be loaded
  'launchedAt',
  'serveAdminPanel',
  'autoReload',
  'environment',
  'packageJsonStrapi',
  'info',
  'autoReload',
  'dirs',

  // probably mistaken/typo filenames
  ...Object.keys(MISTAKEN_FILENAMES),
];

// Existing Strapi configuration files
const STRAPI_CONFIG_FILENAMES = [
  'admin',
  'server',
  'api',
  'database',
  'middlewares',
  'plugins',
  'features',
];

// Note: we don't have access to strapi logger at this point so we can't use it
const logWarning = (message: string) => {
  console.warn(message);
};

export default (dir: string, manifest?: AppManifest) => {
  // Source-only (bundle) path: discover + load config from the inlined manifest.
  const useManifest = !!manifest && manifestDirExists(manifest, dir);

  if (!useManifest && !fs.existsSync(dir)) return {};

  const validExtensions = useManifest ? VALID_SOURCE_EXTENSIONS : VALID_EXTENSIONS;
  const allFiles = (
    useManifest ? manifestReaddir(manifest, dir)! : fs.readdirSync(dir, { withFileTypes: true })
  ) as Array<{
    name: string;
    isFile: () => boolean;
  }>;
  const seenFilenames = new Set<string>();
  const configFiles = allFiles.reduce(
    (acc, file) => {
      const baseName = path.basename(file.name, path.extname(file.name));
      const baseNameLower = baseName.toLowerCase();
      const extension = path.extname(file.name);
      const extensionLower = extension.toLowerCase();

      if (!file.isFile()) {
        return acc;
      }

      if (!validExtensions.includes(extensionLower)) {
        logWarning(
          `Config file not loaded, extension must be one of ${validExtensions.join(',')}): ${
            file.name
          }`
        );
        return acc;
      }

      if (RESTRICTED_FILENAMES.includes(baseNameLower)) {
        logWarning(`Config file not loaded, restricted filename: ${file.name}`);

        // suggest the filename they probably meant
        if (baseNameLower in MISTAKEN_FILENAMES) {
          console.log(
            `Did you mean ${MISTAKEN_FILENAMES[baseNameLower as keyof typeof MISTAKEN_FILENAMES]}]} ?`
          );
        }

        return acc;
      }

      // restricted names and Strapi configs are also restricted from being prefixes
      const restrictedPrefix = [...RESTRICTED_FILENAMES, ...STRAPI_CONFIG_FILENAMES].find(
        (restrictedName) =>
          restrictedName.startsWith(baseNameLower) && restrictedName !== baseNameLower
      );
      if (restrictedPrefix) {
        logWarning(
          `Config file not loaded, filename cannot start with ${restrictedPrefix}: ${file.name}`
        );
      }

      /**
       *  Note: If user config files contain non-alpha-numeric characters, we won't be able to auto-load env
       * into them.
       *
       * For the initial feature, we will only load our internal configs, but later when we provide a method
       * to define the shape of custom configs, we will need to warn that those filenames can't be loaded
       * for technical limitations on env variable names
       *  */
      // if (!/^[A-Za-z0-9]+$/.test(baseName)) {
      //   logWarning("Using a non-alphanumeric config file name prevents Strapi from auto-loading it from environment variables.")
      // }

      // filter filenames without case-insensitive uniqueness
      if (seenFilenames.has(baseNameLower)) {
        logWarning(
          `Config file not loaded, case-insensitive name matches other config file: ${file.name}`
        );
        return acc;
      }
      seenFilenames.add(baseNameLower);

      // If file passes all filters, add it to the accumulator
      acc.push(file);
      return acc;
    },
    [] as Array<{ name: string; isFile: () => boolean }>
  );

  return configFiles.reduce(
    (acc, file) => {
      const key = path.basename(file.name, path.extname(file.name));
      const absPath = path.resolve(dir, file.name);

      acc[key] = useManifest ? evalManifestConfig(manifest!, absPath) : loadConfigFile(absPath);

      return acc;
    },
    {} as Record<string, unknown>
  );
};
