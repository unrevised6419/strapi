// @ts-check

'use strict';

/** @import { Data } from '@strapi/strapi' */

const { checkBadRequest } = require('../../../utils');

const usersPermissionsUserUID = 'plugin::users-permissions.user';

module.exports = ({ nexus, strapi }) => {
  const { nonNull } = nexus;
  const { getEntityResponseName } = strapi.plugin('graphql').service('utils').naming;

  const userContentType = strapi.getModel(usersPermissionsUserUID);

  const responseName = getEntityResponseName(userContentType);

  return {
    type: nonNull(responseName),

    args: {
      id: nonNull('ID'),
    },

    description: 'Delete an existing user',

    /**
     * @param {{ id: Data.ID }} args `id` is the entry id, not the documentId
     */
    async resolve(parent, args, context) {
      const { koaContext } = context;

      koaContext.params = { id: args.id };

      await strapi.plugin('users-permissions').controller('user').destroy(koaContext);

      checkBadRequest(koaContext.body);

      return {
        value: koaContext.body,
        info: { args, resourceUID: 'plugin::users-permissions.user' },
      };
    },
  };
};
