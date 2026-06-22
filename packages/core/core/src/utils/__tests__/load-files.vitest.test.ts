import path from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { glob } from 'glob';
import fse from 'fs-extra';

import type { AppManifest } from '../app-manifest';
import { loadFiles } from '../load-files';

// We mock the heavy deps so the tests run without real disk/glob access.
// vi.mock is hoisted by Vitest, so these take effect even though import
// statements appear above them in source.
vi.mock('glob', () => ({
  glob: vi.fn().mockResolvedValue([]),
}));

vi.mock('fs-extra', () => ({
  default: {
    readJson: vi.fn(),
  },
  readJson: vi.fn(),
}));

vi.mock('@strapi/utils', () => ({
  importDefault: vi.fn((p: string) => ({ syncLoaded: p })),
  unwrapModule: vi.fn((m: unknown) => m),
}));

const APP = path.join('/abs', 'app');
const COMP_DIR = path.join(APP, 'src', 'components');

// ---- helpers ----------------------------------------------------------------

const makeManifest = (files: string[]): AppManifest => ({
  files,
  load: (p) => Promise.resolve({ __p: p }),
  loadSync: (p) => ({ __p: p }),
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ---- manifest path ----------------------------------------------------------

describe('loadFiles — manifest path (appManifest provided)', () => {
  it('discovers files from the manifest, not from glob', async () => {
    const schemaPath = path.join(COMP_DIR, 'shared', 'button.json');
    const manifest = makeManifest([
      schemaPath,
      path.join(APP, 'src', 'api', 'article', 'controllers', 'article.ts'), // outside COMP_DIR
    ]);

    // loadSync for JSON returns {default: {collectionName:'btn'}}
    const loadSyncSpy = vi
      .spyOn(manifest, 'loadSync')
      .mockImplementation(() => ({ default: { collectionName: 'btn', info: {}, attributes: {} } }));

    await loadFiles(COMP_DIR, '*/*.json', { appManifest: manifest });

    // glob should NOT have been called — discovery came from the manifest
    expect(glob).not.toHaveBeenCalled();
    // manifest.loadSync should have been called for the JSON file
    expect(loadSyncSpy).toHaveBeenCalledWith(schemaPath);
  });

  it('filters manifest files to the target dir and pattern', async () => {
    const match1 = path.join(COMP_DIR, 'shared', 'button.json');
    const match2 = path.join(COMP_DIR, 'layout', 'hero.json');
    const noMatch = path.join(APP, 'src', 'api', 'other', 'schema.json');
    const manifest = makeManifest([match1, match2, noMatch]);

    // Return a fresh object each call so Object.defineProperty doesn't hit the
    // "cannot redefine non-configurable property" guard on a reused object.
    const loadSyncSpy = vi
      .spyOn(manifest, 'loadSync')
      .mockImplementation(() => ({ collectionName: 'x' }));

    await loadFiles(COMP_DIR, '*/*.json', { appManifest: manifest });

    expect(loadSyncSpy).toHaveBeenCalledTimes(2);
    expect(loadSyncSpy).toHaveBeenCalledWith(match1);
    expect(loadSyncSpy).toHaveBeenCalledWith(match2);
    expect(loadSyncSpy).not.toHaveBeenCalledWith(noMatch);
  });

  it('unwraps .default from manifest JSON', async () => {
    const schemaPath = path.join(COMP_DIR, 'shared', 'button.json');
    const manifest = makeManifest([schemaPath]);
    const payload = { collectionName: 'btn', info: {}, attributes: {} };
    vi.spyOn(manifest, 'loadSync').mockReturnValue({ default: payload });

    const result = await loadFiles<Record<string, Record<string, unknown>>>(COMP_DIR, '*/*.json', {
      appManifest: manifest,
    });

    expect(result.shared?.button).toMatchObject(payload);
  });

  it('uses payload directly when no .default wrapper', async () => {
    const schemaPath = path.join(COMP_DIR, 'shared', 'button.json');
    const manifest = makeManifest([schemaPath]);
    const payload = { collectionName: 'btn', info: {}, attributes: {} };
    vi.spyOn(manifest, 'loadSync').mockReturnValue(payload);

    const result = await loadFiles<Record<string, Record<string, unknown>>>(COMP_DIR, '*/*.json', {
      appManifest: manifest,
    });

    expect(result.shared?.button).toMatchObject(payload);
  });

  it('does not call fse.readJson when manifest is provided', async () => {
    const schemaPath = path.join(COMP_DIR, 'shared', 'button.json');
    const manifest = makeManifest([schemaPath]);
    vi.spyOn(manifest, 'loadSync').mockImplementation(() => ({ collectionName: 'btn' }));

    await loadFiles(COMP_DIR, '*/*.json', { appManifest: manifest });

    expect(fse.readJson).not.toHaveBeenCalled();
  });

  it('matches ** glob patterns (extension strapi-server)', async () => {
    const extPath = path.join(APP, 'src', 'extensions', 'users-permissions', 'strapi-server.js');
    const extDir = path.join(APP, 'src', 'extensions');
    const manifest = makeManifest([extPath]);

    // strapi-server.js is not JSON — will go through importModule branch
    const importModule = vi.fn().mockResolvedValue({ default: {} });

    await loadFiles(extDir, '**/strapi-server.js', { importModule, appManifest: manifest });

    expect(glob).not.toHaveBeenCalled();
    expect(importModule).toHaveBeenCalledWith(extPath);
  });
});

// ---- off-path (no manifest) -------------------------------------------------

describe('loadFiles — off-path (no appManifest)', () => {
  it('uses glob for discovery when no manifest is provided', async () => {
    vi.mocked(glob).mockResolvedValue([]);
    await loadFiles(COMP_DIR, '*/*.json');
    expect(glob).toHaveBeenCalledWith('*/*.json', expect.objectContaining({ cwd: COMP_DIR }));
  });

  it('reads JSON from disk via fse.readJson when no manifest', async () => {
    const rel = path.join('shared', 'button.json');
    vi.mocked(glob).mockResolvedValue([rel]);
    vi.mocked(fse.readJson).mockResolvedValue({ collectionName: 'btn' });

    await loadFiles(COMP_DIR, '*/*.json');

    expect(fse.readJson).toHaveBeenCalledWith(path.join(COMP_DIR, rel));
  });

  it('does not call manifest.loadSync in off-path', async () => {
    const rel = path.join('shared', 'button.json');
    vi.mocked(glob).mockResolvedValue([rel]);
    vi.mocked(fse.readJson).mockResolvedValue({ collectionName: 'btn' });

    // Provide a manifest to confirm it is NOT used when it is omitted from opts
    const manifest = makeManifest([]);
    const loadSyncSpy = vi.spyOn(manifest, 'loadSync');

    // no appManifest in opts
    await loadFiles(COMP_DIR, '*/*.json');

    expect(loadSyncSpy).not.toHaveBeenCalled();
  });
});
