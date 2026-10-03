import type { DocumentID, ID } from '..';
import type { ID as DocumentsID } from '../../modules/documents';

type Assert<T extends true> = T;
type IsEqual<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2 ? true : false;

// Plain values are still accepted
const numericId: ID = 1;
const stringId: ID = 'abc';
const documentId: DocumentID = 'abc';

// Flavored values are still their base type
documentId satisfies string;
numericId satisfies string | number;

// @ts-expect-error An entry ID is not a document ID
stringId satisfies DocumentID;

// @ts-expect-error A document ID is not an entry ID
documentId satisfies ID;

// @ts-expect-error A document ID is never numeric
1 satisfies DocumentID;

// The documents module alias is a document ID
true satisfies Assert<IsEqual<DocumentsID, DocumentID>>;
