import type { Core } from '@strapi/types';

import { createReloader } from '../reloader';

const createMockStrapi = (autoReload: boolean): Core.Strapi =>
  ({
    config: {
      get: (key: string) => (key === 'autoReload' ? autoReload : undefined),
    },
  }) as unknown as Core.Strapi;

describe('reloader', () => {
  let originalSend: typeof process.send;

  beforeEach(() => {
    originalSend = process.send;
  });

  afterEach(() => {
    process.send = originalSend;
  });

  describe('cluster path (off-path — no onReload)', () => {
    it('signals the cluster primary via process.send when autoReload is set', () => {
      const send = jest.fn();
      process.send = send as unknown as typeof process.send;

      const reload = createReloader(createMockStrapi(true));
      reload();

      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith('reload');
    });

    it('does NOT signal when autoReload is disabled', () => {
      const send = jest.fn();
      process.send = send as unknown as typeof process.send;

      const reload = createReloader(createMockStrapi(false));
      reload();

      expect(send).not.toHaveBeenCalled();
    });

    it('is byte-for-byte unchanged: empty opts behaves exactly like no opts', () => {
      const send = jest.fn();
      process.send = send as unknown as typeof process.send;

      const reload = createReloader(createMockStrapi(true), {});
      reload();

      expect(send).toHaveBeenCalledWith('reload');
    });
  });

  describe('in-process path (onReload set)', () => {
    it('calls onReload instead of process.send', () => {
      const send = jest.fn();
      process.send = send as unknown as typeof process.send;
      const onReload = jest.fn();

      const reload = createReloader(createMockStrapi(true), { onReload });
      reload();

      expect(onReload).toHaveBeenCalledTimes(1);
      expect(send).not.toHaveBeenCalled();
    });

    it('does not throw when onReload returns a rejected promise', () => {
      const onReload = jest.fn(() => Promise.reject(new Error('boom')));

      const reload = createReloader(createMockStrapi(true), { onReload });

      expect(() => reload()).not.toThrow();
    });
  });

  describe('shouldReload / isWatching gating (unchanged behaviour)', () => {
    it('skips a reload and decrements shouldReload after re-enabling the watcher', () => {
      const onReload = jest.fn();
      const reload = createReloader(createMockStrapi(true), { onReload });

      // Disable then re-enable the watcher → bumps shouldReload to 1.
      reload.isWatching = false;
      reload.isWatching = true;

      // First reload is consumed by the shouldReload gate (no onReload call).
      reload();
      expect(onReload).not.toHaveBeenCalled();

      // Next reload goes through.
      reload();
      expect(onReload).toHaveBeenCalledTimes(1);
    });
  });
});
