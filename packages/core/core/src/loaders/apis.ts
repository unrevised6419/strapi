import { join, extname, basename } from 'path';
import fse, { existsSync } from 'fs-extra';
import _ from 'lodash';
import { strings, importDefault, unwrapModule } from '@strapi/utils';
import { isEmpty } from 'lodash/fp';
import type { Core, Struct } from '@strapi/types';
import { getGlobalId, type ContentTypeDefinition } from '../domain/content-type';

interface API {
  bootstrap: () => void | Promise<void>;
  destroy: () => void | Promise<void>;
  register: () => void | Promise<void>;
  config: Record<string, unknown>;
  routes: Record<string, Core.Router>;
  controllers: Record<string, Core.Controller>;
  services: Record<string, Core.Service>;
  policies: Record<string, Core.Policy>;
  middlewares: Record<string, Core.Middleware>;
  contentTypes: Record<string, { schema: Struct.ContentTypeSchema }>;
}

interface APIs {
  [key: string]: API;
}

const DEFAULT_CONTENT_TYPE = {
  schema: {},
  actions: {},
  lifecycles: {},
};

// to handle names with numbers in it we first check if it is already in kebabCase
const normalizeName = (name: string) => (strings.isKebabCase(name) ? name : _.kebabCase(name));

const isDirectory = (fd: fse.Dirent) => fd.isDirectory();
const isDotFile = (fd: fse.Dirent) => fd.name.startsWith('.');

type ImportModule = (id: string) => Promise<unknown>;

// Source extensions to load via the runner when `importModule` is set
// (experimental source-only boot). Off-path (no `importModule`) keeps loading
// only `.js`, exactly as before.
const SOURCE_EXTS = ['.js', '.ts', '.mts', '.cts', '.mjs', '.cjs'];

export default async function loadAPIs(strapi: Core.Strapi) {
  if (!existsSync(strapi.dirs.dist.api)) {
    return;
  }

  const apisFDs = await (await fse.readdir(strapi.dirs.dist.api, { withFileTypes: true }))
    .filter(isDirectory)
    .filter(_.negate(isDotFile));

  const apis: APIs = {};

  const importModule = strapi.importModule;

  // only load folders
  for (const apiFD of apisFDs) {
    const apiName = normalizeName(apiFD.name);
    const api = await loadAPI(apiName, join(strapi.dirs.dist.api, apiFD.name), importModule);

    // @ts-expect-error TODO verify that it's a valid api, not missing bootstrap, register, and destroy
    apis[apiName] = api;
  }

  validateContentTypesUnicity(apis);

  for (const apiName of Object.keys(apis)) {
    strapi.get('apis').add(apiName, apis[apiName]);
  }
}

const validateContentTypesUnicity = (apis: APIs) => {
  const allApisSchemas = Object.values(apis).flatMap((api) => Object.values(api.contentTypes));

  const names: string[] = [];
  allApisSchemas.forEach(({ schema }) => {
    if (schema.info.singularName) {
      const singularName = _.kebabCase(schema.info.singularName);
      if (names.includes(singularName)) {
        throw new Error(`The singular name "${schema.info.singularName}" should be unique`);
      }
      names.push(singularName);
    }

    if (schema.info.pluralName) {
      const pluralName = _.kebabCase(schema.info.pluralName);
      if (names.includes(pluralName)) {
        throw new Error(`The plural name "${schema.info.pluralName}" should be unique`);
      }
      names.push(pluralName);
    }
  });
};

const loadAPI = async (apiName: string, dir: string, importModule?: ImportModule) => {
  const [index, config, routes, controllers, services, policies, middlewares, contentTypes] = (
    await Promise.all([
      loadIndex(dir, importModule),
      loadDir(join(dir, 'config'), importModule),
      loadDir(join(dir, 'routes'), importModule),
      loadDir(join(dir, 'controllers'), importModule),
      loadDir(join(dir, 'services'), importModule),
      loadDir(join(dir, 'policies'), importModule),
      loadDir(join(dir, 'middlewares'), importModule),
      loadContentTypes(apiName, join(dir, 'content-types'), importModule),
    ])
  ).map((result) => result?.result);

  return {
    ...(index || {}),
    config: config || {},
    routes: routes || [],
    controllers: controllers || {},
    services: services || {},
    policies: policies || {},
    middlewares: middlewares || {},
    contentTypes: contentTypes || {},
  };
};

const loadIndex = async (dir: string, importModule?: ImportModule) => {
  // Off-path: only `index.js`, exactly as before.
  if (!importModule) {
    if (await fse.pathExists(join(dir, 'index.js'))) {
      return loadFile(join(dir, 'index.js'), importModule);
    }
    return undefined;
  }

  // Source-only path: resolve whichever index source file exists.
  for (const ext of SOURCE_EXTS) {
    const candidate = join(dir, `index${ext}`);
    // eslint-disable-next-line no-await-in-loop
    if (await fse.pathExists(candidate)) {
      return loadFile(candidate, importModule);
    }
  }
  return undefined;
};

// because this is async and its contents are dynamic, we must return it within an object to avoid a property called `then` being interpreted as a Promise
const loadContentTypes = async (apiName: string, dir: string, importModule?: ImportModule) => {
  if (!(await fse.pathExists(dir))) {
    return;
  }

  const fds = await fse.readdir(dir, { withFileTypes: true });
  const contentTypes: API['contentTypes'] = {};

  // only load folders
  for (const fd of fds) {
    if (fd.isFile()) {
      continue;
    }

    const contentTypeName = normalizeName(fd.name);
    const loadedContentType = (await loadDir(join(dir, fd.name), importModule))?.result;

    if (isEmpty(loadedContentType) || isEmpty(loadedContentType.schema)) {
      throw new Error(`Could not load content type found at ${dir}`);
    }

    const contentType = {
      ...DEFAULT_CONTENT_TYPE,
      ...loadedContentType,
    } as ContentTypeDefinition;

    Object.assign(contentType.schema, {
      apiName,
      collectionName: contentType.schema.collectionName || contentType.schema.info.singularName,
      globalId: getGlobalId(contentType.schema),
    });

    contentTypes[normalizeName(contentTypeName)] = contentType;
  }

  return { result: contentTypes };
};

// because this is async and its contents are dynamic, we must return it within an object to avoid a property called `then` being interpreted as a Promise
const loadDir = async (dir: string, importModule?: ImportModule) => {
  if (!(await fse.pathExists(dir))) {
    return;
  }

  const fds = await fse.readdir(dir, { withFileTypes: true });

  const root: Record<string, unknown> = {};
  for (const fd of fds) {
    if (!fd.isFile() || extname(fd.name) === '.map') {
      continue;
    }

    const key = basename(fd.name, extname(fd.name));

    root[normalizeName(key)] = (await loadFile(join(dir, fd.name), importModule)).result;
  }

  return { result: root };
};

// because this is async and its contents are dynamic, we must return it as an array to avoid a property called `then` being interpreted as a Promise
const loadFile = async (
  file: string,
  importModule?: ImportModule
): Promise<{ result: unknown }> => {
  const ext = extname(file);

  if (ext === '.json') {
    return { result: await fse.readJSON(file) };
  }

  // Source-only path: load any source extension (incl. `.ts`) through the
  // runner and unwrap its ESM namespace the way `importDefault` would.
  if (importModule && SOURCE_EXTS.includes(ext)) {
    const mod = await importModule(file);
    return { result: unwrapModule(mod) };
  }

  // Off-path: byte-for-byte the original switch.
  switch (ext) {
    case '.js':
      return { result: importDefault(file) };
    default:
      return { result: {} };
  }
};
