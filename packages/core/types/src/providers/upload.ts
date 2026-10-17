import type { Buffer } from 'node:buffer';
import type { Readable } from 'node:stream';

/**
 * The module an upload provider package exports.
 *
 * `init` is declared as a property, not a method, so its parameters are checked
 * strictly: a provider cannot require more from `options` than the upload
 * plugin passes.
 */
export interface Factory<Options = object> {
  init: (options: Options) => Provider;
}

/**
 * The `actionOptions[<method>]` value of the `plugin::upload` config.
 * The upload plugin passes it as the last argument of each provider method.
 */
export type ActionOptions = Record<string, unknown>;

/**
 * A provider must implement `delete` and at least one of `upload` and
 * `uploadStream`. The upload plugin checks this at runtime.
 */
export interface Provider {
  upload?: (file: UploadFile, options?: ActionOptions) => Promise<unknown>;
  uploadStream?: (file: UploadFile, options?: ActionOptions) => Promise<unknown>;
  replace?: (newFile: UploadFile, oldFile: UploadFile, options?: ActionOptions) => Promise<unknown>;
  replaceStream?: (
    newFile: UploadFile,
    oldFile: UploadFile,
    options?: ActionOptions
  ) => Promise<unknown>;
  delete: (file: UploadFile, options?: ActionOptions) => Promise<unknown>;
  checkFileSize?: (file: UploadFile, options: CheckFileSizeOptions) => void;
  getSignedUrl?: (file: UploadFile, options?: ActionOptions) => Promise<{ url?: string }>;
  isPrivate?: () => boolean | Promise<boolean>;
}

export interface CheckFileSizeOptions {
  sizeLimit?: number;
}

/**
 * The file the upload plugin passes to provider methods.
 * Providers set `url`, and can set `previewUrl` and `provider_metadata`.
 */
export interface UploadFile {
  name: string;
  alternativeText?: string | null;
  caption?: string | null;
  width?: number | null;
  height?: number | null;
  formats?: Record<string, unknown> | null;
  hash: string;
  ext?: string;
  mime: string;
  /**
   * Size in kilobytes.
   */
  size: number;
  sizeInBytes?: number;
  url?: string;
  previewUrl?: string | null;
  path?: string | null;
  provider?: string;
  provider_metadata?: Record<string, unknown> | null;
  /**
   * Set when the plugin calls `uploadStream` or `replaceStream`.
   */
  stream?: Readable;
  /**
   * Set when the plugin calls `upload` or `replace`.
   */
  buffer?: Buffer;
}
