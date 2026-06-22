import { bootProduction } from './server-entry';

/**
 * Phase C — the `rollupOptions.input` for the production `server` environment
 * build. Rolldown bundles THIS module (and its relative/absolute imports) into a
 * single-file CJS `dist/server.js`; `@strapi/core` and every other bare specifier
 * stays external and is resolved at runtime by walking up from the bundle's own
 * directory to `app/node_modules` (see `.superpowers/sdd/phase-c-assumption5-spike.md`).
 *
 * Kept separate from the dev boot (`createStrapiApp`, driven by the Vite Module
 * Runner in `dev-server.ts`) so the two boots never share a code path: dev boots
 * through the runner; prod boots from this top-level call to {@link bootProduction}.
 */
bootProduction().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
