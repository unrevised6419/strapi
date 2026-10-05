/* eslint-disable @typescript-eslint/no-var-requires */
import { dirname, join, resolve } from 'path';
import { statSync, existsSync } from 'fs';
import { get, pickBy, defaultsDeep, map, prop, pipe } from 'lodash/fp';
import { strings } from '@strapi/utils';
import type { Core } from '@strapi/types';
import { getUserPluginsConfig, PluginDeclaration } from './get-user-plugins-config';
import { hasServerEntrypoint } from './server-entrypoint';

interface PluginMeta {
  enabled: boolean;
  pathToPlugin?: string;
  info: Record<string, unknown>;
  packageInfo?: Record<string, unknown>;
  /**
   * The plugin comes from the app's `devDependencies`, which production installs skip
   */
  isDevDependency?: boolean;
}

type PluginMetas = Record<string, PluginMeta>;

interface PluginInfo {
  name: string;
  kind: string;
}

/**
 * otherwise known as "core features"
 *
 * NOTE: These are excluded from the content manager plugin list, as they are always enabled.
 *       See admin.ts server controller on the content-manager plugin for more details.
 */
const INTERNAL_PLUGINS = [
  '@strapi/content-manager',
  '@strapi/content-type-builder',
  '@strapi/email',
  '@strapi/upload',
  '@strapi/i18n',
  '@strapi/content-releases',
  '@strapi/review-workflows',
];

const isStrapiPlugin = (info: PluginInfo) => get('strapi.kind', info) === 'plugin';

const validatePluginName = (pluginName: string) => {
  if (!strings.isKebabCase(pluginName)) {
    throw new Error(`Plugin name "${pluginName}" is not in kebab (an-example-of-kebab-case)`);
  }
};

const toDetailedDeclaration = (declaration: boolean | PluginDeclaration) => {
  if (typeof declaration === 'boolean') {
    return { enabled: declaration };
  }

  const detailedDeclaration: { enabled: boolean; pathToPlugin?: string } = {
    enabled: declaration.enabled,
  };

  if (declaration?.resolve) {
    let pathToPlugin = '';

    if (declaration.isModule) {
      /**
       * we only want the node_module here, not the package.json
       */
      pathToPlugin = join(declaration.resolve, '..');
    } else {
      try {
        pathToPlugin = dirname(require.resolve(declaration.resolve));
      } catch {
        pathToPlugin = resolve(strapi.dirs.app.root, declaration.resolve);

        if (!existsSync(pathToPlugin) || !statSync(pathToPlugin).isDirectory()) {
          throw new Error(`${declaration.resolve} couldn't be resolved`);
        }
      }
    }

    detailedDeclaration.pathToPlugin = pathToPlugin;
  }

  return detailedDeclaration;
};

export const getEnabledPlugins = async (strapi: Core.Strapi, { client } = { client: false }) => {
  const internalPlugins: PluginMetas = {};

  for (const dep of INTERNAL_PLUGINS) {
    const packagePath = join(dep, 'package.json');

    // NOTE: internal plugins should be resolved from the strapi package
    const packageModulePath = require.resolve(packagePath, {
      paths: [require.resolve('@strapi/strapi/package.json'), process.cwd()],
    });

    const packageInfo = require(packageModulePath);

    validatePluginName(packageInfo.strapi.name);
    internalPlugins[packageInfo.strapi.name] = {
      ...toDetailedDeclaration({ enabled: true, resolve: packageModulePath, isModule: client }),
      info: packageInfo.strapi,
      packageInfo,
    };
  }

  const installedPlugins: PluginMetas = {};
  const dependencies = strapi.config.get('info.dependencies', {});
  const devDependencies = strapi.config.get('info.devDependencies', {});

  /**
   * `devDependencies` come first, so a `dependencies` package that ships the same slice wins.
   * A package listed in both is read once, as a dependency
   */
  const installedPackages = new Set([
    ...Object.keys(devDependencies),
    ...Object.keys(dependencies),
  ]);

  for (const dep of installedPackages) {
    const isDevDependency = !(dep in dependencies);
    let packagePath;
    let packageInfo;
    try {
      // Resolve from the app first, where the app's dependencies are installed
      packagePath = require.resolve(join(dep, 'package.json'), {
        paths: [strapi.dirs.app.root, __dirname],
      });
      packageInfo = require(packagePath);
    } catch {
      continue;
    }

    if (isStrapiPlugin(packageInfo)) {
      validatePluginName(packageInfo.strapi.name);

      const plugin: PluginMeta = {
        ...toDetailedDeclaration({ enabled: true, resolve: packagePath, isModule: client }),
        info: {
          ...packageInfo.strapi,
          packageName: packageInfo.name,
        },
        packageInfo,
        isDevDependency,
      };

      /**
       * Two packages can share a plugin name and each ship one slice, e.g. the admin slice in a
       * dev dependency and the server slice in a dependency. A later package replaces an earlier
       * one only when it ships the server slice, so an admin-only package keeps the server slice
       */
      const previous = installedPlugins[packageInfo.strapi.name];

      if (previous && !hasServerEntrypoint(plugin)) {
        continue;
      }

      if (previous && hasServerEntrypoint(previous)) {
        strapi.log.warn(
          `The plugin "${packageInfo.strapi.name}" has a server slice in both "${previous.info.packageName}" and "${packageInfo.name}". Strapi loads the one from "${packageInfo.name}". Remove the other package, or give it a different plugin name.`
        );
      }

      installedPlugins[packageInfo.strapi.name] = plugin;
    }
  }

  const declaredPlugins: PluginMetas = {};
  const userPluginsConfig = await getUserPluginsConfig();

  for (const [pluginName, declaration] of Object.entries(userPluginsConfig)) {
    validatePluginName(pluginName);

    declaredPlugins[pluginName] = {
      ...toDetailedDeclaration(declaration),
      info: {},
    };

    const { pathToPlugin } = declaredPlugins[pluginName];

    // for manually resolved plugins
    if (pathToPlugin) {
      const packagePath = join(pathToPlugin, 'package.json');
      const packageInfo = require(packagePath);

      if (isStrapiPlugin(packageInfo)) {
        declaredPlugins[pluginName].info = packageInfo.strapi || {};
        declaredPlugins[pluginName].packageInfo = packageInfo;
      }
    }
  }

  const declaredPluginsResolves = map(prop('pathToPlugin'), declaredPlugins);
  const installedPluginsNotAlreadyUsed = pickBy(
    (p) => !declaredPluginsResolves.includes(p.pathToPlugin),
    installedPlugins
  );

  const enabledPlugins = pipe(
    defaultsDeep(declaredPlugins),
    defaultsDeep(installedPluginsNotAlreadyUsed),
    pickBy((p: PluginMeta) => p.enabled)
  )(internalPlugins);

  return enabledPlugins;
};
