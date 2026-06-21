import type { InlineConfig, UserConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';

import { getUserConfig } from '../core/config';
import { getModulePath } from '../core/resolve-module';
import { isDesignSystemLinked } from '../core/linked-packages';
import { loadStrapiMonorepo } from '../core/monorepo';
import { getMonorepoAliases } from '../core/aliases';
import type { BuildContext } from '../create-build-context';
import { buildFilesPlugin } from './plugins';
import { strapi } from './plugin';

const resolveBaseConfig = async (ctx: BuildContext): Promise<InlineConfig> => {
  const { default: browserslistToEsbuild } = await import('browserslist-to-esbuild');
  const target = browserslistToEsbuild(ctx.target);
  const isMonorepoExampleApp = (ctx.strapi as any).internal_config?.uuid === 'getstarted';
  const designSystemLinked = isDesignSystemLinked();

  return {
    root: ctx.cwd,
    base: ctx.basePath,
    cacheDir: 'node_modules/.strapi/vite',
    configFile: false,
    define: {
      process: {},
      'process.env': JSON.stringify(ctx.env),
    },
    envPrefix: 'STRAPI_ADMIN_',
    // Explicit aliases ensure resolution under pnpm's strict dependency isolation,
    // where packages imported by plugins may not be resolvable from plugin chunks.
    // alias lives at top level because EnvironmentResolveOptions does not expose it.
    resolve: {
      alias: {
        react: getModulePath('react'),
        'react-dom': getModulePath('react-dom'),
        'react-router-dom': getModulePath('react-router-dom'),
        'styled-components': getModulePath('styled-components'),
        'react-redux': getModulePath('react-redux'),
        '@reduxjs/toolkit': getModulePath('@reduxjs/toolkit'),
        '@strapi/design-system': getModulePath('@strapi/design-system'),
        '@radix-ui/react-tooltip': getModulePath('@radix-ui/react-tooltip'),
        lodash: getModulePath('lodash'),
      },
    },
    plugins: [react(), buildFilesPlugin(ctx), strapi({ ctx })],
    environments: {
      client: {
        build: {
          emptyOutDir: false, // Rely on CLI to do this
          outDir: ctx.distDir,
          target,
        },
        optimizeDeps: {
          // When design-system is linked (portal:, file:, yarn link), exclude from pre-bundling
          // so changes are reflected without clearing node_modules/.strapi/vite cache
          ...(designSystemLinked && { exclude: ['@strapi/design-system'] }),
          include: [
            // pre-bundle React dependencies to avoid React duplicates,
            // even if React dependencies are not direct dependencies
            // https://react.dev/warnings/invalid-hook-call-warning#duplicate-react
            'react',
            `react/jsx-runtime`,
            'react-dom/client',
            'styled-components',
            'react-router-dom',
            // Admin + RTK Query share react-redux context; pre-bundle so dev chunks cannot load a
            // second copy (avoids "could not find react-redux context value" after upgrades / hoisting).
            'react-redux',
            '@reduxjs/toolkit',
            // Pre-bundle design-system so plugin custom field chunks (dynamic imports) resolve
            // to the same instance as the main app. Otherwise TooltipProvider/DesignSystemProvider
            // context from the root is not seen by components in plugin chunks.
            // Omit when linked so local changes are picked up (see exclude above)
            ...(!designSystemLinked ? ['@strapi/design-system'] : []),
            '@radix-ui/react-tooltip',
            // Pre-bundle lodash: design-system uses named imports (e.g. assignWith) but lodash
            // is CommonJS-only; pre-bundling converts it to ESM for the browser
            'lodash',
            // Pre-bundle prismjs so plugin chunks get a valid ESM namespace (prismjs is UMD and can
            // otherwise expose an empty object when bundled, causing "Prism is not defined" in admin).
            'prismjs',
            /**
             * Pre-bundle other dependencies that would otherwise cause a page reload when imported.
             * See "performance" section: https://vite.dev/guide/dep-pre-bundling.html#the-why
             * Only include dependencies for our internal example apps, otherwise it will break
             * real user apps that may not have those dependencies.
             */
            ...(isMonorepoExampleApp
              ? [
                  '@dnd-kit/core',
                  '@dnd-kit/sortable',
                  '@dnd-kit/utilities',
                  '@dnd-kit/modifiers',
                  '@radix-ui/react-toolbar',
                  'codemirror5',
                  'codemirror5/addon/display/placeholder',
                  'date-fns-tz',
                  'date-fns/format',
                  'date-fns/formatISO',
                  'highlight.js',
                  'lodash/capitalize',
                  'lodash/fp',
                  'lodash/groupBy',
                  'lodash/has',
                  'lodash/isNil',
                  'lodash/locale',
                  'lodash/map',
                  'lodash/mapValues',
                  'lodash/pull',
                  'lodash/size',
                  'lodash/sortBy',
                  'lodash/tail',
                  'lodash/toLower',
                  'lodash/toNumber',
                  'lodash/toString',
                  'lodash/truncate',
                  'lodash/uniq',
                  'lodash/upperFirst',
                  'markdown-it',
                  'markdown-it-abbr',
                  'markdown-it-container',
                  'markdown-it-deflist',
                  'markdown-it-emoji',
                  'markdown-it-footnote',
                  'markdown-it-ins',
                  'markdown-it-mark',
                  'markdown-it-sub',
                  'markdown-it-sup',
                  'prismjs/components/*.js',
                  'react-colorful',
                  'react-dnd-html5-backend',
                  'react-window',
                  'semver',
                  'semver/functions/lt',
                  'semver/functions/valid',
                  'slate',
                  'slate-history',
                  'slate-react',
                  'motion',
                ]
              : []),
          ],
        },
      },
    },
  };
};

const resolveProductionConfig = async (ctx: BuildContext): Promise<InlineConfig> => {
  const {
    options: { minify, sourcemaps },
  } = ctx;

  const baseConfig = await resolveBaseConfig(ctx);

  return {
    ...baseConfig,
    logLevel: 'silent',
    mode: 'production',
    environments: {
      client: {
        ...baseConfig.environments?.client,
        build: {
          ...baseConfig.environments?.client?.build,
          assetsDir: '',
          minify,
          sourcemap: sourcemaps,
          rolldownOptions: {
            input: {
              strapi: ctx.entry,
            },
          },
        },
      },
    },
  };
};

const resolveDevelopmentConfig = async (ctx: BuildContext): Promise<InlineConfig> => {
  const monorepo = await loadStrapiMonorepo(ctx.cwd);
  const baseConfig = await resolveBaseConfig(ctx);

  return {
    ...baseConfig,
    mode: 'development',
    // Monorepo aliases are additive: extend the base top-level resolve.alias with workspace paths.
    resolve: {
      ...baseConfig.resolve,
      alias: {
        ...(baseConfig.resolve?.alias as Record<string, string>),
        ...getMonorepoAliases({ monorepo }),
      },
    },
    server: {
      cors: false,
      /**
       * In middleware mode Strapi forwards the browser Host from reverse proxies (nginx, Traefik).
       * Vite 5+ blocks unknown hosts unless explicitly allowed (#23491).
       */
      allowedHosts: true,
      middlewareMode: true,
      open: ctx.options.open,
      hmr: {
        overlay: false,
        /**
         * Use Strapi's http.Server so HMR websockets reuse the app's listen port. A separate listener
         * plus clientPort pushes browsers toward host:5173-style URLs that fail behind proxies that
         * only expose the Strapi server port (#23491, #23008).
         */
        server: ctx.strapi.server.httpServer,
      },
    },
    appType: 'custom',
  };
};

const USER_CONFIGS = ['vite.config.js', 'vite.config.mjs', 'vite.config.ts', 'vite.config.mts'];

type UserViteConfig = (config: UserConfig) => UserConfig;

const mergeConfigWithUserConfig = async (config: InlineConfig, ctx: BuildContext) => {
  const userConfig = await getUserConfig<UserViteConfig>(USER_CONFIGS, ctx);

  if (userConfig) {
    return userConfig(config);
  }

  return config;
};

export { mergeConfigWithUserConfig, resolveProductionConfig, resolveDevelopmentConfig };
