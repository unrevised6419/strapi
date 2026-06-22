import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { createCommand } from 'commander';
import tsUtils from '@strapi/typescript-utils';
import { createStrapi } from '@strapi/core';

import type { StrapiCommand } from '../types';
import { runAction } from '../utils/helpers';

export const resolveStartTarget = (
  appDir: string
): { mode: 'bundle'; file: string } | { mode: 'legacy' } => {
  const file = path.join(appDir, 'dist', 'server.js');
  return fs.existsSync(file) ? { mode: 'bundle', file } : { mode: 'legacy' };
};

const action = async () => {
  const appDir = process.cwd();

  const target = resolveStartTarget(appDir);

  if (target.mode === 'bundle') {
    const child = spawn(process.execPath, ['--enable-source-maps', target.file], {
      stdio: 'inherit',
      cwd: appDir,
    });
    child.on('exit', (code) => process.exit(code ?? 0));
    return;
  }

  // Legacy path — preserved byte-for-byte
  const isTSProject = await tsUtils.isUsingTypeScript(appDir);

  const outDir = await tsUtils.resolveOutDir(appDir);
  const distDir = isTSProject ? outDir : appDir;

  const buildDirExists = fs.existsSync(outDir);
  if (isTSProject && !buildDirExists)
    throw new Error(
      `${outDir} directory not found. Please run the build command before starting your application`
    );

  createStrapi({ appDir, distDir }).start();
};

/**
 * `$ strapi start`
 */
const command: StrapiCommand = () => {
  return createCommand('start')
    .description('Start your Strapi application')
    .action(runAction('start', action));
};

export { command };
