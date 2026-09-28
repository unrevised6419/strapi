import type { Data } from '@strapi/strapi';

/**
 * Shapes of the plugin's entries as returned by `strapi.db.query`, which is typed as `any`.
 * Annotating query results with these keeps entry `id`s and `documentId`s apart.
 */
type Entry = {
  id: Data.ID;
  documentId: Data.DocumentID;
  createdAt?: string;
  updatedAt?: string;
  publishedAt?: string | null;
};

export type User = Entry & {
  username: string;
  email: string;
  provider?: string;
  password?: string;
  resetPasswordToken?: string | null;
  confirmationToken?: string | null;
  confirmed?: boolean;
  blocked?: boolean;
  role?: Role;
};

export type Role = Entry & {
  name: string;
  description?: string | null;
  type: string;
  permissions?: Permission[];
  users?: User[];
};

export type Permission = Entry & {
  action: string;
  role?: Role;
};
