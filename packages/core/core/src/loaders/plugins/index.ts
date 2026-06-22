import { join } from 'path';
import fse from 'fs-extra';
import { defaultsDeep, defaults, getOr, get } from 'lodash/fp';
import * as resolve from 'resolve.exports';

import { env } from '@strapi/utils';
import type { Core, Plugin, Struct } from '@strapi/types';
import { loadConfigFile } from '../../utils/load-config-file';
import { loadFiles } from '../../utils/load-files';
import { getEnabledPlugins } from './get-enabled-plugins';
import { getUserPluginsConfig } from './get-user-plugins-config';
import { getGlobalId } from '../../domain/content-type';
import { getManifest, manifestHas } from '../../utils/app-manifest';

interface Plugins {
  [key: string]: Plugin.LoadedPlugin;
}

const defaultPlugin = {
  bootstrap() {},
  destroy() {},
  register() {},
  config: {
    default: {},
    validator() {},
  },
  routes: [],
  controllers: {},
  services: {},
  policies: {},
  middlewares: {},
  contentTypes: {},
};

const applyUserExtension = async (plugins: Plugins) => {
  const extensionsDir = strapi.dirs.dist.extensions;
  if (!(await fse.pathExists(extensionsDir))) {
    return;
  }

  const extendedSchemas = await loadFiles(extensionsDir, '**/content-types/**/schema.json');
  const strapiServers = await loadFiles(extensionsDir, '**/strapi-server.js');

  for (const pluginName of Object.keys(plugins)) {
    const plugin = plugins[pluginName];
    // first: load json schema
    const extendedContentTypes = get([pluginName, 'content-types'], extendedSchemas) ?? {};
    for (const ctName of Object.keys(extendedContentTypes)) {
      const extendedSchema = get([ctName, 'schema'], extendedContentTypes);
      if (!extendedSchema) {
        // eslint-disable-next-line no-continue
        continue;
      }

      if (!plugin.contentTypes[ctName]) {
        plugin.contentTypes[ctName] = { schema: extendedSchema };
      } else {
        plugin.contentTypes[ctName].schema = {
          ...plugin.contentTypes[ctName].schema,
          ...extendedSchema,
        };
      }
    }

    formatContentTypes(pluginName, plugin.contentTypes);
    // second: execute strapi-server extension
    const strapiServer = get([pluginName, 'strapi-server'], strapiServers);
    if (strapiServer) {
      plugins[pluginName] = await strapiServer(plugin);
    }
  }
};

const applyUserConfig = async (plugins: Plugins) => {
  const userPluginsConfig = await getUserPluginsConfig();

  for (const pluginName of Object.keys(plugins)) {
    const plugin = plugins[pluginName];
    const userPluginConfig = getOr({}, `${pluginName}.config`, userPluginsConfig);
    const defaultConfig =
      typeof plugin.config.default === 'function'
        ? plugin.config.default({ env })
        : plugin.config.default;

    const config = defaultsDeep(defaultConfig, userPluginConfig);
    try {
      plugin.config.validator(config);
    } catch (e) {
      if (e instanceof Error) {
        throw new Error(`Error regarding ${pluginName} config: ${e.message}`);
      }

      throw e;
    }
    plugin.config = config;
  }
};

export default async function loadPlugins(strapi: Core.Strapi) {
  const plugins: Plugins = {};

  const enabledPlugins = await getEnabledPlugins(strapi);

  strapi.config.set('enabledPlugins', enabledPlugins);

  for (const pluginName of Object.keys(enabledPlugins)) {
    const enabledPlugin = enabledPlugins[pluginName];

    let serverEntrypointPath;
    let resolvedExport = './strapi-server.js';

    try {
      resolvedExport = (
        resolve.exports(enabledPlugin.packageInfo, 'strapi-server', {
          require: true,
        }) ?? './strapi-server.js'
      ).toString();
    } catch (e) {
      // no export map or missing strapi-server export => fallback to default
    }

    try {
      serverEntrypointPath = join(enabledPlugin.pathToPlugin, resolvedExport);
    } catch (e) {
      throw new Error(
        `Error loading the plugin ${pluginName} because ${pluginName} is not installed. Please either install the plugin or remove its configuration.`
      );
    }

    // only load plugins with a server entrypoint. A LOCAL plugin's entrypoint
    // (e.g. `src/plugins/<name>/strapi-server.ts`) may be inlined in the bundle
    // and absent on disk — accept it when the manifest records it.
    if (
      !manifestHas(getManifest(strapi), serverEntrypointPath) &&
      !(await fse.pathExists(serverEntrypointPath))
    ) {
      continue;
    }

    const pluginServer = (await (strapi.importModule
      ? loadConfigFile(serverEntrypointPath, { importModule: strapi.importModule })
      : Promise.resolve(loadConfigFile(serverEntrypointPath)))) as Partial<Plugin.LoadedPlugin>;
    plugins[pluginName] = {
      ...defaultPlugin,
      ...pluginServer,
      contentTypes: formatContentTypes(pluginName, pluginServer.contentTypes ?? {}),
      config: defaults(defaultPlugin.config, pluginServer.config),
      routes: (pluginServer.routes ?? defaultPlugin.routes) as Plugin.LoadedPlugin['routes'],
    };
  }

  // TODO: validate plugin format
  await applyUserConfig(plugins);
  await applyUserExtension(plugins);

  for (const pluginName of Object.keys(plugins)) {
    strapi.get('plugins').add(pluginName, plugins[pluginName]);
  }
}

const formatContentTypes = (
  pluginName: string,
  contentTypes: Record<string, { schema: Struct.ContentTypeSchema }>
) => {
  Object.values(contentTypes).forEach((definition) => {
    const { schema } = definition;

    Object.assign(schema, {
      plugin: pluginName,
      collectionName:
        schema.collectionName || `${pluginName}_${schema.info.singularName}`.toLowerCase(),
      globalId: getGlobalId(schema, pluginName),
    });
  });

  return contentTypes;
};
