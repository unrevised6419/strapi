import type { Plugin } from 'vite';

import type { BuildContext } from '../create-build-context';

export interface StrapiPluginOptions {
  ctx: BuildContext;
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
