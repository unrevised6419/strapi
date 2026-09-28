import type { ID } from './constants';

import type { Flavor, Intersect } from '../utils';
import type * as UID from '../uid';
import type { AttributeNames, AttributeValueByName } from '../schema';

/**
 * A type used as the identifier for a document.
 *
 * Flavored so it can't be mixed up with an entry `ID`, while plain strings are still accepted.
 */
export type DocumentID = Flavor<string, 'DocumentID'>;

/**
 * Represents a content-type entry.
 *
 * @template TContentTypeUID - The content-type schema UID
 * @template TContentTypeKeys - A union of keys to be returned in the final object. If not specified, defaults to all the keys.
 */
export type ContentType<
  TContentTypeUID extends UID.ContentType = UID.ContentType,
  TContentTypeKeys extends AttributeNames<TContentTypeUID> = AttributeNames<TContentTypeUID>,
> = Intersect<
  [{ id: ID; documentId: DocumentID }, Pick<AttributeValues<TContentTypeUID>, TContentTypeKeys>]
>;

type AttributeValues<TContentTypeUID extends UID.ContentType = UID.ContentType> = {
  [TAttributeName in AttributeNames<TContentTypeUID>]?: AttributeValueByName<
    TContentTypeUID,
    TAttributeName
  > | null;
};
