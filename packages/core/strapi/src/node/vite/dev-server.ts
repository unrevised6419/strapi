import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { createServer, isRunnableDevEnvironment } from 'vite';

import type { ModuleRunner, RunnableDevEnvironment } from 'vite';
import type { DevelopOptions } from '../develop';

type ViteServer = Awaited<ReturnType<typeof createServer>>;

/**
 * Phase B Task 2 SPIKE.
 *
 * Probe whether Vite's `server` environment Module Runner can import and
 * execute app source IN-PROCESS inside the Strapi dev process. This is a
 * GO/NO-GO gate, not the real boot — it imports a probe module, logs what the
 * runner returns, then closes the server and exits.
 */

/**
 * Returns the `server` environment's Module Runner.
 *
 * NOTE (Landmine 1): the first access of `env.runner` lazily constructs the
 * runner and mutates `process` globals (it calls `setSourceMapsEnabled` and
 * installs an `Error.prepareStackTrace`). We therefore touch `env.runner`
 * exactly once, early and deliberately, in `developViteServer` and pass the
 * resulting runner around — callers must not re-derive it ad hoc.
 */
export function getServerRunner(vite: ViteServer): ModuleRunner {
  const env = vite.environments.server;
  if (!isRunnableDevEnvironment(env)) {
    throw new Error('Strapi: server environment is not runnable');
  }
  // `env` is narrowed to RunnableDevEnvironment by the type guard above.
  return (env as RunnableDevEnvironment).runner;
}

export async function developViteServer(options: DevelopOptions): Promise<void> {
  const { cwd, logger } = options;

  const vite = await createServer({
    root: cwd,
    appType: 'custom',
    server: { middlewareMode: true },
    configFile: false,
    plugins: [
      // ctx-less probe plugin — enough to confirm wiring for the spike.
      { name: 'strapi:server-spike' },
    ],
    environments: {
      server: { resolve: { conditions: ['node', 'strapi-server'] } },
    },
  });

  // Probe A writes a trivial ESM source file under the app root, imports it,
  // then removes it. Self-contained so the spike works against any app without
  // depending on (or leaving behind) sandbox files.
  const trivialRel = '__vite_spike_probe__.mjs';
  const trivialAbs = join(cwd, trivialRel);

  try {
    await writeFile(trivialAbs, "export const spike = 'ok';\nexport default { ran: true };\n");

    // Landmine 1: access the runner once, early, deliberately.
    const runner = getServerRunner(vite);

    // Probe A: trivial ESM source. Isolates "can the runner import ANY source
    // in-process" from "can it import the full Strapi entry".
    await probe(runner, logger, `/${trivialRel}`, 'trivial');

    // Probe B: the real Strapi app entry. May fail for real reasons (the entry
    // uses CJS `module.exports`, pulls in @strapi/strapi / config, or expects a
    // Strapi runtime). A failure here is signal, not a harness bug.
    await probe(runner, logger, '/src/index.js', 'app-entry');
  } finally {
    await rm(trivialAbs, { force: true });
    await vite.close();
  }
}

async function probe(
  runner: ModuleRunner,
  logger: DevelopOptions['logger'],
  url: string,
  label: string
): Promise<void> {
  try {
    const mod = await runner.import<Record<string, unknown>>(url);
    const keys = Object.keys(mod);
    const hasDefault = Object.prototype.hasOwnProperty.call(mod, 'default');
    logger.info(
      `[vite-server spike] (${label}) imported ${url}: typeof=${typeof mod} ` +
        `hasDefault=${hasDefault} keys=[${keys.join(', ')}]`
    );
  } catch (err) {
    const e = err as Error;
    logger.error(`[vite-server spike] (${label}) FAILED importing ${url}: ${e.message}`);
    if (e.stack) {
      logger.error(`[vite-server spike] (${label}) stack:\n${e.stack}`);
    }
  }
}
