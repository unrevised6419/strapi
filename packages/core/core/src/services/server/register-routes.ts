import _ from 'lodash';
import type { Core } from '@strapi/types';
import { registerOpenAPIRoute } from './openapi';

/**
 * Route definitions from plugins and the admin (e.g. `@strapi/admin`'s
 * `export default [{ path: '/init', … }]`) are MODULE-LEVEL singletons loaded
 * once via native `require`. Route registration mutates routes in place
 * (`generateRouteScope` → `config`, `route.info`, and
 * `applyExtraParamsToRoutes` → `route.request`). In the normal cluster-fork dev
 * flow each boot is a fresh process, so mutating the singleton is harmless.
 *
 * Under the experimental in-process Vite reload, the SAME process re-registers
 * routes on every reload. Mutating the singletons there is a bug: the second
 * boot sees routes already carrying the first boot's mutations, and
 * `applyExtraParamsToRoutes` then throws `param "…" already exists on route`.
 *
 * We defend by registering a per-boot shallow clone of each route, with its
 * mutated-in-place sub-objects (`config`, `request`, `info`) cloned too, so the
 * source singleton stays pristine across boots. Zod schemas inside `request`
 * are NOT mutated in place by the merge helpers (they build new `z.object`s), so
 * a shallow clone of `request` is sufficient and we avoid cloning schema class
 * instances.
 */
const cloneRouteForRegistration = <T extends Core.RouteInput>(route: T): T => ({
  ...route,
  ...(route.config ? { config: _.cloneDeep(route.config) } : {}),
  ...(route.request ? { request: { ...route.request } } : {}),
  ...(route.info ? { info: { ...route.info } } : {}),
});

const cloneRoutesForRegistration = <T extends Core.RouteInput>(routes: T[]): T[] =>
  routes.map((route) => cloneRouteForRegistration(route));

const createRouteScopeGenerator = (namespace: string) => (route: Core.RouteInput) => {
  const prefix = namespace.endsWith('::') ? namespace : `${namespace}.`;

  if (typeof route.handler === 'string') {
    _.defaultsDeep(route, {
      config: {
        auth: {
          scope: [`${route.handler.startsWith(prefix) ? '' : prefix}${route.handler}`],
        },
      },
    });
  }
};

/**
 * Register all routes
 */
export default (strapi: Core.Strapi) => {
  registerAdminRoutes(strapi);
  registerAPIRoutes(strapi);
  registerPluginRoutes(strapi);
  registerOpenAPIRoute(strapi);
};

/**
 * Register admin routes
 * @param {import('../../').Strapi} strapi
 */
const registerAdminRoutes = (strapi: Core.Strapi) => {
  const generateRouteScope = createRouteScopeGenerator(`admin::`);

  // Instantiate function-like routers
  // Mutate admin.routes in-place and make sure router factories are instantiated correctly
  strapi.admin.routes = instantiateRouterInputs(strapi.admin.routes, strapi);

  _.forEach(strapi.admin.routes, (router) => {
    router.type = router.type || 'admin';
    router.prefix = router.prefix || `/admin`;
    // Clone so the admin's module-level route singletons stay pristine across
    // in-process reloads (see cloneRouteForRegistration).
    const routes = cloneRoutesForRegistration(router.routes);
    routes.forEach((route) => {
      generateRouteScope(route);
      route.info = { pluginName: 'admin' };
    });
    strapi.server.routes({ ...router, routes });
  });
};

/**
 * Register plugin routes
 * @param {import('../../').Strapi} strapi
 */
const registerPluginRoutes = (strapi: Core.Strapi) => {
  for (const pluginName of Object.keys(strapi.plugins)) {
    const plugin = strapi.plugins[pluginName];

    const generateRouteScope = createRouteScopeGenerator(`plugin::${pluginName}`);

    if (Array.isArray(plugin.routes)) {
      // Clone so the plugin's module-level route singletons stay pristine across
      // in-process reloads (see cloneRouteForRegistration).
      const routes = cloneRoutesForRegistration(plugin.routes);
      routes.forEach((route) => {
        generateRouteScope(route);
        route.info = { pluginName };
      });
      strapi.contentAPI.applyExtraParamsToRoutes(routes);

      strapi.server.routes({
        type: 'admin',
        prefix: `/${pluginName}`,
        routes,
      });
    } else {
      // Instantiate function-like routers
      // Mutate plugin.routes in-place and make sure router factories are instantiated correctly
      plugin.routes = instantiateRouterInputs(plugin.routes, strapi);

      _.forEach(plugin.routes, (router) => {
        router.type = router.type ?? 'admin';
        router.prefix = router.prefix ?? `/${pluginName}`;
        const routes = cloneRoutesForRegistration(router.routes ?? []);
        routes.forEach((route) => {
          generateRouteScope(route);
          route.info = { pluginName };
        });
        strapi.contentAPI.applyExtraParamsToRoutes(routes);

        strapi.server.routes({ ...router, routes });
      });
    }
  }
};

/**
 * Register api routes
 */
const registerAPIRoutes = (strapi: Core.Strapi) => {
  for (const apiName of Object.keys(strapi.apis)) {
    const api = strapi.api(apiName);

    const generateRouteScope = createRouteScopeGenerator(`api::${apiName}`);

    // Mutate api.routes in-place and make sure router factories are instantiated correctly
    api.routes = instantiateRouterInputs(api.routes, strapi);

    _.forEach(api.routes, (router) => {
      // TODO: remove once auth setup
      // pass meta down to compose endpoint
      router.type = 'content-api';
      // Clone so route singletons (e.g. the core router's memoized `routes`
      // getter) stay pristine across in-process reloads (see
      // cloneRouteForRegistration).
      const routes = cloneRoutesForRegistration(router.routes ?? []);
      routes.forEach((route) => {
        generateRouteScope(route);
        route.info = { apiName };
      });
      strapi.contentAPI.applyExtraParamsToRoutes(routes);

      return strapi.server.routes({ ...router, routes });
    });
  }
};

const instantiateRouterInputs = (
  routers: Record<string, Core.RouterConfig>,
  strapi: Core.Strapi
): Record<string, Core.Router> => {
  const entries = Object.entries(routers);

  return entries.reduce((record, [key, inputOrCallback]) => {
    const isCallback = typeof inputOrCallback === 'function';

    return { ...record, [key]: isCallback ? inputOrCallback({ strapi }) : inputOrCallback };
  }, {});
};
