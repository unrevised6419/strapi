import { resolve } from 'path';
import { statSync, existsSync } from 'fs';
import { yup, importDefault, unwrapModule } from '@strapi/utils';

import type { Core } from '@strapi/types';
import { getManifest, manifestDirExists, manifestHas } from '../utils/app-manifest';

// Candidate source entry extensions for the experimental source-only boot.
const SRC_INDEX_EXTS = ['index.ts', 'index.js', 'index.mts', 'index.cts', 'index.mjs', 'index.cjs'];

const srcSchema = yup
  .object()
  .shape({
    bootstrap: yup.mixed().isFunction(),
    register: yup.mixed().isFunction(),
    destroy: yup.mixed().isFunction(),
  })
  .noUnknown();

const validateSrcIndex = (srcIndex: unknown) => {
  return srcSchema.validateSync(srcIndex, { strict: true, abortEarly: false });
};

export default async (strapi: Core.Strapi) => {
  const manifest = getManifest(strapi);

  // Discovery: the src dir exists either on disk or in the inlined manifest.
  if (!existsSync(strapi.dirs.dist.src) && !manifestDirExists(manifest, strapi.dirs.dist.src)) {
    return;
  }

  const importModule = strapi.importModule;

  let srcIndex: unknown;

  if (importModule) {
    // Source-only path: resolve whichever index source entry exists (e.g.
    // `index.ts`) — from the manifest when inlined, else from disk — and load it
    // through `importModule` (manifest-backed in the bundle case).
    const entry = SRC_INDEX_EXTS.map((name) => resolve(strapi.dirs.dist.src, name)).find(
      (candidate) =>
        manifestHas(manifest, candidate) ||
        (existsSync(candidate) && !statSync(candidate).isDirectory())
    );

    if (!entry) {
      return {};
    }

    srcIndex = unwrapModule(await importModule(entry));
  } else {
    // Off-path: byte-for-byte the original sync `index.js` resolution.
    const pathToSrcIndex = resolve(strapi.dirs.dist.src, 'index.js');
    if (!existsSync(pathToSrcIndex) || statSync(pathToSrcIndex).isDirectory()) {
      return {};
    }

    srcIndex = importDefault(pathToSrcIndex);
  }

  try {
    validateSrcIndex(srcIndex);
  } catch (e) {
    if (e instanceof yup.ValidationError) {
      strapi.stopWithError({ message: `Invalid file \`./src/index.js\`: ${e.message}` });
    }

    throw e;
  }

  strapi.app = srcIndex;
};
