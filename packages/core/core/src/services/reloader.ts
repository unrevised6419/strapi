import type { Core } from '@strapi/types';

export interface ReloaderOptions {
  /**
   * In-process reload hook (experimental Vite server path). When set, `reload()`
   * calls this instead of signalling the cluster primary via `process.send`.
   * The hook is responsible for tearing down and re-booting Strapi in the same
   * process (no cluster fork). When omitted, the reloader keeps its byte-for-byte
   * original cluster behaviour.
   */
  onReload?: () => void | Promise<void>;
}

export const createReloader = (strapi: Core.Strapi, opts: ReloaderOptions = {}) => {
  const state = {
    shouldReload: 0,
    isWatching: true,
  };

  function reload() {
    if (state.shouldReload > 0) {
      // Reset the reloading state
      state.shouldReload -= 1;
      reload.isReloading = false;
      return;
    }

    // In-process path (experimental Vite server): reload Strapi without a
    // cluster fork. Fire-and-forget — the hook owns its own error handling.
    if (opts.onReload) {
      Promise.resolve(opts.onReload()).catch(() => {});
      return;
    }

    if (strapi.config.get('autoReload')) {
      process.send?.('reload');
    }
  }

  Object.defineProperty(reload, 'isWatching', {
    configurable: true,
    enumerable: true,
    set(value) {
      // Special state when the reloader is disabled temporarly (see GraphQL plugin example).
      if (state.isWatching === false && value === true) {
        state.shouldReload += 1;
      }
      state.isWatching = value;
    },
    get() {
      return state.isWatching;
    },
  });

  reload.isReloading = false;
  reload.isWatching = true;

  return reload;
};
