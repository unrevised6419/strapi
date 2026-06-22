// @ts-expect-error -- resolved at build time by the app-manifest Vite plugin.
import { manifest } from 'virtual:strapi-app-manifest';

import { bootProduction, type ProductionAppManifest } from './server-entry';

/**
 * Phase C / Task C5 — the production entry for a SOURCE-INLINED (TS) app.
 *
 * It imports the build-generated `virtual:strapi-app-manifest`, which statically
 * imports every app source file (so Rolldown inlines `src/**` + `config/**` +
 * content-type `schema.json` into `dist/server.js`). The manifest is handed to
 * {@link bootProduction}, which threads it into Strapi so the loaders discover +
 * load app modules from the bundle instead of disk. With this entry the app
 * boots prod source-only: no `tsc`, no runner, no `.ts`/`.js` app source on disk.
 *
 * The JS-disk path uses `server-prod-entry.ts` (no manifest) instead.
 */
bootProduction(manifest as ProductionAppManifest).catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
