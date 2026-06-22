import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { resolveStartTarget } from '../start';

describe('resolveStartTarget', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strapi-start-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns bundle mode when dist/server.js exists', () => {
    const distDir = path.join(tmpDir, 'dist');
    fs.mkdirSync(distDir);
    fs.writeFileSync(path.join(distDir, 'server.js'), '// bundle');

    expect(resolveStartTarget(tmpDir)).toEqual({
      mode: 'bundle',
      file: path.join(tmpDir, 'dist', 'server.js'),
    });
  });

  it('returns legacy mode when dist/server.js does not exist', () => {
    expect(resolveStartTarget(tmpDir)).toEqual({ mode: 'legacy' });
  });

  it('returns legacy mode when dist dir exists but server.js is missing', () => {
    const distDir = path.join(tmpDir, 'dist');
    fs.mkdirSync(distDir);

    expect(resolveStartTarget(tmpDir)).toEqual({ mode: 'legacy' });
  });
});
