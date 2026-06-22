import path from 'path';
import { describe, it, expect } from 'vitest';

import { type AppManifest, manifestHas, manifestReaddir, manifestDirExists } from '../app-manifest';

const APP = path.join('/abs', 'app');
const files = [
  path.join(APP, 'src', 'index.ts'),
  path.join(APP, 'src', 'api', 'ping', 'controllers', 'ping.ts'),
  path.join(APP, 'src', 'api', 'ping', 'content-types', 'ping', 'schema.json'),
  path.join(APP, 'config', 'server.ts'),
];

const manifest: AppManifest = {
  files,
  load: (p) => Promise.resolve({ __p: p }),
  loadSync: (p) => ({ __p: p }),
};

describe('app-manifest helpers', () => {
  it('manifestHas matches recorded files only', () => {
    expect(manifestHas(manifest, files[0])).toBe(true);
    expect(manifestHas(manifest, path.join(APP, 'src', 'nope.ts'))).toBe(false);
    expect(manifestHas(undefined, files[0])).toBe(false);
  });

  it('manifestDirExists is true for any ancestor dir of a recorded file', () => {
    expect(manifestDirExists(manifest, path.join(APP, 'src'))).toBe(true);
    expect(manifestDirExists(manifest, path.join(APP, 'src', 'api', 'ping'))).toBe(true);
    expect(manifestDirExists(manifest, path.join(APP, 'does', 'not', 'exist'))).toBe(false);
    expect(manifestDirExists(undefined, path.join(APP, 'src'))).toBe(false);
  });

  it('manifestReaddir lists direct children (files + subdirs) of a dir', () => {
    const apiDir = path.join(APP, 'src', 'api');
    const entries = manifestReaddir(manifest, apiDir)!;
    expect(entries.map((e) => e.name)).toEqual(['ping']);
    expect(entries[0].isDirectory()).toBe(true);
    expect(entries[0].isFile()).toBe(false);

    const ctrlDir = path.join(APP, 'src', 'api', 'ping', 'controllers');
    const ctrl = manifestReaddir(manifest, ctrlDir)!;
    expect(ctrl.map((e) => e.name)).toEqual(['ping.ts']);
    expect(ctrl[0].isFile()).toBe(true);
  });

  it('manifestReaddir returns undefined without a manifest (caller falls back to disk)', () => {
    expect(manifestReaddir(undefined, path.join(APP, 'src'))).toBeUndefined();
  });
});
