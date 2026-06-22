import { join } from 'path';
import _ from 'lodash';
import { pathExists } from 'fs-extra';
import type { Core, Struct, UID } from '@strapi/types';
import { loadFiles } from '../utils/load-files';
import { getManifest, manifestDirExists } from '../utils/app-manifest';

type LoadedComponent = {
  collectionName: string;
  __filename__: string;
  __schema__: LoadedComponent;
  uid: string;
  category: string;
  modelName: string;
  globalId: string;
  info: any;
  attributes: any;
};

type LoadedComponents = {
  [category: string]: {
    [key: string]: LoadedComponent;
  };
};

type ComponentMap = {
  [uid in UID.Component]: Struct.ComponentSchema;
};

export default async function loadComponents(strapi: Core.Strapi) {
  const manifest = getManifest(strapi);
  const componentsDir = strapi.dirs.dist.components;

  // Manifest-aware existence check: when a manifest is present use it; otherwise
  // fall back to disk. Off-path (no manifest) is byte-for-byte unchanged.
  if (!manifestDirExists(manifest, componentsDir) && !(await pathExists(componentsDir))) {
    return {};
  }

  const importModule = strapi.importModule;

  // Component schemas are JSON; on the experimental source-only path also widen
  // the glob to TS/other source so a `.ts`-authored component schema can load
  // via the runner. Off-path keeps the original `js|json` glob and sync loader.
  const pattern = importModule ? '*/*.*(js|ts|mts|cts|mjs|cjs|json)' : '*/*.*(js|json)';

  const map = await loadFiles<LoadedComponents>(componentsDir, pattern, {
    importModule,
    appManifest: manifest,
  });

  const components = Object.keys(map).reduce((acc, category) => {
    Object.keys(map[category]).forEach((key) => {
      const schema = map[category][key];

      if (!schema.collectionName) {
        // NOTE: We're using the filepath from the app directory instead of the dist for information purpose
        const filePath = join(strapi.dirs.app.components, category, schema.__filename__);

        return strapi.stopWithError(
          `Component ${key} is missing a "collectionName" property.\nVerify file ${filePath}.`
        );
      }

      const uid: UID.Component = `${category}.${key}`;

      acc[uid] = Object.assign(schema, {
        __schema__: _.cloneDeep(schema),
        uid,
        category,
        modelType: 'component' as const,
        modelName: key,
        globalId: schema.globalId || _.upperFirst(_.camelCase(`component_${uid}`)),
      });
    });

    return acc;
  }, {} as ComponentMap);

  strapi.get('components').add(components);
}
