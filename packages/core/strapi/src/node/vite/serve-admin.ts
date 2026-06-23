import path from 'node:path';
import fs from 'node:fs/promises';
import type { ViteDevServer } from 'vite';
import type { Core } from '@strapi/types';

import type { BuildContext } from '../create-build-context';

/**
 * Shared admin-serving wiring for the Vite dev server.
 *
 * Both the off-path `--watch-admin` flow ({@link ../vite/watch}) and the
 * experimental single-server dev path ({@link ./dev-server}) serve the admin
 * SPA the same way:
 *
 *  - assets + HMR for the `client` graph go through `vite.middlewares` (the
 *    `viteMiddlewares` Koa middleware below), and
 *  - the SPA entry (`.strapi/client/index.html`, run through
 *    `vite.transformIndexHtml`) is returned for GET/HEAD requests that fall
 *    through to a 404 (`serveAdmin`).
 *
 * The two callers differ only in how they obtain the Vite server and the Koa
 * router. This module factors the identical request handling so neither copy
 * drifts from the other.
 */

interface ServeAdminContext {
  /** App root — `.strapi/client/index.html` is resolved relative to it. */
  cwd: string;
  /** The admin public base path (e.g. `/admin`). */
  basePath: string;
  /** The internal admin path (e.g. `/admin`). */
  adminPath: string;
  logger: Pick<BuildContext['logger'], 'error'>;
}

/**
 * Koa middleware that forwards a request to Vite's connect middleware stack so
 * the `client` environment can serve admin assets and the HMR websocket
 * handshake. On a miss (Vite calls `next()` without sending), it restores the
 * original Koa path and continues the Strapi pipeline.
 *
 * The `prefix` dance mirrors the off-path: when the admin is mounted under a
 * nested public base (`basePath` differs from `adminPath`) the request path is
 * re-prefixed so Vite resolves assets against its configured `base`.
 */
export const createViteMiddlewares = (
  vite: ViteDevServer,
  ctx: ServeAdminContext
): Core.MiddlewareHandler => {
  return (koaCtx, next) => {
    return new Promise((resolve, reject) => {
      const prefix = ctx.basePath.replace(ctx.adminPath, '').replace(/\/+$/, '');

      const originalPath = koaCtx.path;
      if (!koaCtx.path.startsWith(prefix)) {
        koaCtx.path = `${prefix}${koaCtx.path}`;
      }

      // Set cache-control headers to prevent caching issues during development restarts
      koaCtx.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      koaCtx.set('Pragma', 'no-cache');
      koaCtx.set('Expires', '0');
      koaCtx.set('Surrogate-Control', 'no-store');

      vite.middlewares(koaCtx.req, koaCtx.res, (err: unknown) => {
        if (err) {
          reject(err);
        } else {
          if (!koaCtx.res.headersSent) {
            koaCtx.path = originalPath;
          }

          resolve(next());
        }
      });
    });
  };
};

/**
 * Koa middleware that serves the admin SPA entry. It runs the downstream
 * pipeline first; if a GET/HEAD request fell through unhandled (status 404, no
 * body) it returns `.strapi/client/index.html` transformed by Vite (which
 * injects the `@vite/client` + react-refresh scripts).
 */
export const createServeAdmin = (
  vite: ViteDevServer,
  ctx: ServeAdminContext
): Core.MiddlewareHandler => {
  return async (koaCtx, next) => {
    await next();

    if (koaCtx.method !== 'HEAD' && koaCtx.method !== 'GET') {
      return;
    }

    if (koaCtx.body != null || koaCtx.status !== 404) {
      return;
    }

    const url = koaCtx.originalUrl;

    try {
      let template = await fs.readFile(
        path.relative(ctx.cwd, path.join('.strapi', 'client', 'index.html')),
        'utf-8'
      );
      template = await vite.transformIndexHtml(url, template);

      koaCtx.type = 'html';
      koaCtx.body = template;
    } catch (error) {
      ctx.logger.error('Failed to serve admin panel in development mode:', error);
      // Don't fallback to other handlers in development mode to prevent MIME type conflicts
      koaCtx.status = 500;
      koaCtx.body = 'Admin panel temporarily unavailable during server restart';
    }
  };
};

/**
 * Mount the admin-serving middleware onto a Strapi instance's Koa router.
 *
 * Registers, under `${adminPath}/:path*`:
 *   - `serveAdmin` via `router.get` (SPA entry on a 404 fall-through), and
 *   - `viteMiddlewares` via `router.use` (assets + HMR).
 *
 * Any pre-existing layers for the same admin route are removed first so a
 * re-mount (e.g. after an in-process reload that re-creates the Strapi server)
 * does not stack duplicate handlers.
 */
export const mountViteAdmin = (
  strapi: Core.Strapi,
  vite: ViteDevServer,
  ctx: ServeAdminContext
): void => {
  const serveAdmin = createServeAdmin(vite, ctx);
  const viteMiddlewares = createViteMiddlewares(vite, ctx);

  const adminRoute = `${ctx.adminPath}/:path*`;

  // Remove any existing admin routes to prevent conflicts during restart
  const existingRoutes = strapi.server.router.stack.filter((layer) => layer.path === adminRoute);
  existingRoutes.forEach((route) => {
    const index = strapi.server.router.stack.indexOf(route);
    if (index > -1) {
      strapi.server.router.stack.splice(index, 1);
    }
  });

  strapi.server.router.get(adminRoute, serveAdmin);
  strapi.server.router.use(adminRoute, viteMiddlewares);
};

export type { ServeAdminContext };
