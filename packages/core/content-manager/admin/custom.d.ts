/// <reference types="vite/client" />

import { type StrapiTheme } from '@strapi/design-system';
import { type BaseEditor } from 'slate';
import { type HistoryEditor } from 'slate-history';
import { type ReactEditor } from 'slate-react';

import type { LinkEditor } from './src/pages/EditView/components/FormInputs/BlocksInput/Blocks/Link';
import type { BrowserStrapi } from '@strapi/admin/strapi-admin';
import type { Schema } from '@strapi/types';

declare module 'styled-components' {
  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  export interface DefaultTheme extends StrapiTheme {}
}

declare module 'slate' {
  interface CustomTypes {
    Editor: Omit<BaseEditor & ReactEditor & HistoryEditor & LinkEditor, 'children'> & {
      children: Schema.Attribute.BlocksValue;
    };
    Element: Schema.Attribute.BlocksNode;
    Descendant: Schema.Attribute.BlocksInlineNode | Text;
    Text: Schema.Attribute.BlocksTextNode;
  }
}

declare global {
  interface Window {
    strapi: BrowserStrapi;
  }
}
