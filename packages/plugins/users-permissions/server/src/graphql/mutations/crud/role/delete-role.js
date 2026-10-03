// @ts-check

'use strict';

/** @import { Data } from '@strapi/strapi' */

module.exports = ({ nexus, strapi }) => {
  const { nonNull } = nexus;

  return {
    type: 'UsersPermissionsDeleteRolePayload',

    args: {
      id: nonNull('ID'),
    },

    description: 'Delete an existing role',

    /**
     * @param {{ id: Data.ID }} args `id` is the entry id, not the documentId
     */
    async resolve(parent, args, context) {
      const { koaContext } = context;

      koaContext.params = { role: args.id };

      await strapi.plugin('users-permissions').controller('role').deleteRole(koaContext);

      return { ok: true };
    },
  };
};
