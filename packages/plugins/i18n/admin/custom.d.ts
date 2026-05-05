/// <reference types="vite/client" />

import { type StrapiTheme } from '@strapi/design-system';

import type { BrowserStrapi } from '@strapi/admin/strapi-admin';

declare module 'styled-components' {
  export interface DefaultTheme extends StrapiTheme {}
}

declare global {
  interface Window {
    strapi: BrowserStrapi;
  }
}
