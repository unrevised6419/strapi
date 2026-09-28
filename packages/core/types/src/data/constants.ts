import type { Flavor } from '../utils';

/**
 * A type used as the identifier for an entry.
 *
 * Flavored so it can't be mixed up with a `DocumentID`, while plain strings and numbers are still accepted.
 */
export type ID = Flavor<string | number, 'ID'>;
