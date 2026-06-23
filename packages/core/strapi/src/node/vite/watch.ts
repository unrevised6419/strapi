import { mergeConfigWithUserConfig, resolveDevelopmentConfig } from './config';
import { mountViteAdmin } from './serve-admin';

import type { BuildContext } from '../create-build-context';

interface ViteWatcher {
  close(): Promise<void>;
}

const watch = async (ctx: BuildContext): Promise<ViteWatcher> => {
  const finalConfig = await mergeConfigWithUserConfig(await resolveDevelopmentConfig(ctx), ctx);

  ctx.logger.debug('Vite config', finalConfig);

  const { createServer } = await import('vite');

  const vite = await createServer(finalConfig);

  // Serve the admin SPA (assets + HMR via vite.middlewares, index.html via
  // transformIndexHtml) off the Strapi Koa router. The same wiring is reused by
  // the experimental single-server dev path (see ./serve-admin + ./dev-server).
  mountViteAdmin(ctx.strapi, vite, {
    cwd: ctx.cwd,
    basePath: ctx.basePath,
    adminPath: ctx.adminPath,
    logger: ctx.logger,
  });

  return {
    async close() {
      await vite.close();
    },
  };
};

export { watch };
export type { ViteWatcher };
