import * as tsUtils from '@strapi/typescript-utils';
import type { CLIContext } from '../cli/types';
import { handleAdminDependencies } from './core/ensure-admin-dependencies';
import { getTimer, prettyTime } from './core/timer';
import { createBuildContext } from './create-build-context';
import { writeStaticClientFiles } from './staticFiles';

interface BuildOptions extends CLIContext {
  /**
   * Which bundler to use for building.
   *
   * @default webpack
   */
  bundler?: 'webpack' | 'vite';
  /**
   * Minify the output
   *
   * @default true
   */
  minify?: boolean;
  /**
   * Generate sourcemaps – useful for debugging bugs in the admin panel UI.
   */
  sourcemaps?: boolean;
  /**
   * Print stats for build
   */
  stats?: boolean;
  /**
   * Auto-install missing admin dependencies
   *
   * @default false
   */
  installDeps?: boolean;
  /**
   * Build the server to a single-file CJS bundle via the Vite builder (experimental).
   * Enable with `--experimental-vite-build` or `STRAPI_EXPERIMENTAL_VITE_BUILD=true`.
   *
   * @default false
   */
  experimentalViteBuild?: boolean;
}

/**
 * @example `$ strapi build`
 *
 * @description Builds the admin panel of the strapi application.
 */
const build = async ({
  logger,
  cwd,
  tsconfig,
  installDeps = false,
  experimentalViteBuild = false,
  ...options
}: BuildOptions) => {
  const timer = getTimer();

  const shouldContinue = await handleAdminDependencies({
    cwd,
    logger,
    installIfMissing: installDeps,
  });

  if (!shouldContinue) {
    return;
  }

  // ── Experimental Vite builder path ──────────────────────────────────────────
  // When --experimental-vite-build is set, we type-check (no emit) and then
  // hand off to the Vite Builder which produces both the admin SPA and the
  // CJS single-file server bundle. The legacy path below is left entirely
  // unchanged so flag-off behavior is byte-for-byte identical.
  if (experimentalViteBuild) {
    if (tsconfig?.config) {
      timer.start('compilingTS');
      const compilingTsSpinner = logger.spinner(`Type-checking TS (no emit)`).start();

      try {
        // Pass noEmit via configOptions.options — the basic compiler merges
        // this into compilerOptions before calling program.emit(), so the emit
        // is a no-op (emitSkipped = true is fine; we check diagnostics only).
        await tsUtils.compile(cwd, {
          configOptions: { ignoreDiagnostics: false, options: { noEmit: true } },
        });
      } catch {
        process.exit(1);
      }

      const compilingDuration = timer.end('compilingTS');
      compilingTsSpinner.text = `Type-checking TS (no emit) (${prettyTime(compilingDuration)})`;
      compilingTsSpinner.succeed();
    }

    timer.start('createBuildContext');
    const contextSpinner = logger.spinner(`Building build context`).start();
    console.log('');

    const ctx = await createBuildContext({
      cwd,
      logger,
      tsconfig,
      options,
    });

    const contextDuration = timer.end('createBuildContext');
    contextSpinner.text = `Building build context (${prettyTime(contextDuration)})`;
    contextSpinner.succeed();

    timer.start('buildApp');
    const buildingSpinner = logger.spinner(`Building admin + server (Vite builder)`).start();
    console.log('');

    try {
      await writeStaticClientFiles(ctx);
      const { buildApp } = await import('./vite/builder');
      await buildApp(ctx);

      const buildDuration = timer.end('buildApp');
      buildingSpinner.text = `Building admin + server (Vite builder) (${prettyTime(buildDuration)})`;
      buildingSpinner.succeed();
    } catch (err) {
      buildingSpinner.fail();
      throw err;
    }

    return;
  }
  // ── End experimental path ───────────────────────────────────────────────────

  if (tsconfig?.config) {
    timer.start('compilingTS');
    const compilingTsSpinner = logger.spinner(`Compiling TS`).start();

    try {
      await tsUtils.compile(cwd, { configOptions: { ignoreDiagnostics: false } });
    } catch {
      // Match previous compiler behavior (process.exit inside basic.run).
      process.exit(1);
    }

    const compilingDuration = timer.end('compilingTS');
    compilingTsSpinner.text = `Compiling TS (${prettyTime(compilingDuration)})`;
    compilingTsSpinner.succeed();
  }

  timer.start('createBuildContext');
  const contextSpinner = logger.spinner(`Building build context`).start();
  console.log('');

  const ctx = await createBuildContext({
    cwd,
    logger,
    tsconfig,
    options,
  });

  const contextDuration = timer.end('createBuildContext');
  contextSpinner.text = `Building build context (${prettyTime(contextDuration)})`;
  contextSpinner.succeed();

  timer.start('buildAdmin');
  const buildingSpinner = logger.spinner(`Building admin panel`).start();
  console.log('');

  try {
    await writeStaticClientFiles(ctx);

    if (ctx.bundler === 'webpack') {
      const { build: buildWebpack } = await import('./webpack/build');
      await buildWebpack(ctx);
    } else if (ctx.bundler === 'vite') {
      const { build: buildVite } = await import('./vite/build');
      await buildVite(ctx);
    }

    const buildDuration = timer.end('buildAdmin');
    buildingSpinner.text = `Building admin panel (${prettyTime(buildDuration)})`;
    buildingSpinner.succeed();
  } catch (err) {
    buildingSpinner.fail();
    throw err;
  }
};

export { build };
export type { BuildOptions };
