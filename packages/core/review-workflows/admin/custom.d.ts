/// <reference types="vite/client" />

import { type StrapiTheme } from '@strapi/design-system';

import type { BrowserStrapi } from '@strapi/admin/strapi-admin';

declare module 'styled-components' {
  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  export interface DefaultTheme extends StrapiTheme {}
}
declare global {
  interface Window {
    strapi: BrowserStrapi;
  }
}
