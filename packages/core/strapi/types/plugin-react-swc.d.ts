/**
 * Temporary type stub for @vitejs/plugin-react-swc 4.3.1.
 *
 * @vitejs/plugin-react-swc 4.3.1 emits a string-named export declaration:
 *   export { pluginForCjs as "module.exports" };
 * TypeScript 5.4.5 (pinned in this repo) cannot parse that syntax and errors:
 *   TS1003: Identifier expected / TS1128: Declaration or statement expected
 *
 * This file is mapped via the "paths" entry in tsconfig.build.json so that
 * the build:types step (tsc --emitDeclarationOnly) resolves
 * "@vitejs/plugin-react-swc" here instead of the package's own index.d.ts.
 *
 * REMOVE THIS FILE (and the "paths" + "types" include entries in
 * tsconfig.build.json and tsconfig.eslint.json) when either:
 *  - TypeScript is bumped to >=5.5 (which supports string-named exports), OR
 *  - @vitejs/plugin-react-swc ships types compatible with TS 5.4.
 *
 * Upstream reference: strapi/strapi#26541
 */
import type { Plugin } from 'vite';

type ReactSwcOptions = {
  jsxImportSource?: string;
  tsDecorators?: boolean;
  plugins?: [string, Record<string, unknown>][];
  /** SWC JscTarget string (kept inline to avoid importing @swc/core). */
  devTarget?: string;
  parserConfig?: (id: string) => unknown;
  reactRefreshHost?: string;
  useAtYourOwnRisk_mutateSwcOptions?: (options: unknown) => void;
  disableOxcRecommendation?: boolean;
};

declare const react: (_options?: ReactSwcOptions) => Plugin[];

export default react;
