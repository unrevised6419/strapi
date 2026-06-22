import type { Plugin } from 'vite';

import type { BuildContext } from '../create-build-context';

export interface StrapiPluginOptions {
  /**
   * The build context. Optional on the experimental server path: the plugin's
   * `configEnvironment` branches are static (server conditions / client dedupe)
   * and do not read `ctx`, so the dev server can avoid constructing a second
   * Strapi instance just to satisfy this type. The admin build path passes a
   * real ctx.
   */
  ctx?: BuildContext;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function strapi({ ctx: _ctx }: StrapiPluginOptions): Plugin {
  return {
    name: 'strapi',
    configEnvironment(name) {
      if (name === 'client') {
        return {
          resolve: {
            dedupe: [
              'react',
              'react-dom',
              'react-router-dom',
              'styled-components',
              'react-redux',
              '@reduxjs/toolkit',
              '@strapi/design-system',
              '@radix-ui/react-tooltip',
              'lodash',
            ],
          },
        };
      }
      if (name === 'server') {
        return { resolve: { conditions: ['node', 'strapi-server'] } };
      }
      return undefined;
    },
  };
}
