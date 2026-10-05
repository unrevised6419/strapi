import { join } from 'path';
import { existsSync } from 'fs';
import * as resolve from 'resolve.exports';

/**
 * The server entrypoint of a plugin, relative to the plugin's root: the `strapi-server`
 * export when the package declares one, the legacy `./strapi-server.js` file otherwise
 */
export const resolveServerExport = (packageInfo?: Record<string, unknown>): string => {
  try {
    return (
      resolve.exports(packageInfo ?? {}, 'strapi-server', {
        require: true,
      }) ?? './strapi-server.js'
    ).toString();
  } catch {
    // no export map or missing strapi-server export => fallback to default
    return './strapi-server.js';
  }
};

export const hasServerEntrypoint = (plugin: {
  pathToPlugin?: string;
  packageInfo?: Record<string, unknown>;
}): boolean =>
  plugin.pathToPlugin !== undefined &&
  existsSync(join(plugin.pathToPlugin, resolveServerExport(plugin.packageInfo)));
