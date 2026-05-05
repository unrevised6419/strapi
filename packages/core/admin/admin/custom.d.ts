/// <reference types="vite/client" />

import { type StrapiTheme } from '@strapi/design-system';

import type { BrowserStrapi } from './src/types/browserStrapi';

declare module 'styled-components' {
  export interface DefaultTheme extends StrapiTheme {}
}

declare global {
  interface Window {
    strapi?: BrowserStrapi;
  }
}
