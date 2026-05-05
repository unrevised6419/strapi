/// <reference types="vite/client" />

import type { BrowserStrapi } from '@strapi/admin/strapi-admin';

declare global {
  interface Window {
    strapi: BrowserStrapi;
  }
}
