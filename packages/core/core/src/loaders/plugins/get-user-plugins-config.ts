import { join } from 'path';
import fse from 'fs-extra';
import { merge } from 'lodash/fp';
import { loadConfigFile } from '../../utils/load-config-file';
import { getManifest, manifestHas } from '../../utils/app-manifest';

// Source extensions for `config/plugins.*` on the experimental source-only path.
const PLUGINS_CONFIG_EXTS = ['.js', '.ts', '.mts', '.cts', '.mjs', '.cjs'];

/**
 * Resolve the `config/plugins` file in `dir` either from the inlined manifest
 * (any source extension) or from disk (`plugins.js`). Returns the loaded config
 * or `undefined` when no such file exists.
 */
const loadPluginsConfig = async (dir: string): Promise<Record<string, unknown> | undefined> => {
  const manifest = getManifest(strapi);

  if (manifest) {
    for (const ext of PLUGINS_CONFIG_EXTS) {
      const candidate = join(dir, `plugins${ext}`);
      if (manifestHas(manifest, candidate)) {
        // eslint-disable-next-line no-await-in-loop
        return (await loadConfigFile(candidate, {
          importModule: strapi.importModule!,
        })) as Record<string, unknown>;
      }
    }
  }

  const diskPath = join(dir, 'plugins.js');
  if (await fse.pathExists(diskPath)) {
    return loadConfigFile(diskPath) as Record<string, unknown>;
  }

  return undefined;
};

/**
 * Return user defined plugins' config
 * first load config from `config/plugins.js`
 * and then merge config from `config/env/{env}/plugins.js`
 */
export const getUserPluginsConfig = async () => {
  let config: Record<string, unknown> = {};

  const globalConfig = await loadPluginsConfig(strapi.dirs.dist.config);
  if (globalConfig) {
    config = globalConfig;
  }

  const envConfig = await loadPluginsConfig(
    join(strapi.dirs.dist.config, 'env', process.env.NODE_ENV as string)
  );
  if (envConfig) {
    config = merge(config, envConfig);
  }

  return config;
};
