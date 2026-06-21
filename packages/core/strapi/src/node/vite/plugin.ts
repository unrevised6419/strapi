import type { Plugin } from 'vite';

import type { BuildContext } from '../create-build-context';

export interface StrapiPluginOptions {
  ctx: BuildContext;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function strapi(_opts: StrapiPluginOptions): Plugin {
  return {
    name: 'strapi',
    configEnvironment(name) {
      if (name === 'client') {
        return {
          resolve: {
            dedupe: ['react', 'react-dom', 'react-router-dom', 'styled-components'],
          },
        };
      }
      // Phase B adds the 'server' environment here.
      return undefined;
    },
  };
}
