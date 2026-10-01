import type { ReadingPosition } from './readings';

/** The part of the address that names a reading and the place in it (§5: restored on Back). */
export interface ReadingSearch {
  resource?: string | undefined;
  /** A block id behind the `b:` prefix, which keeps all-digit ids from being read as numbers. */
  block?: string | undefined;
  page?: number | undefined;
  offset?: number | undefined;
}

const PREFIX = 'b:';

export function positionFromSearch(search: ReadingSearch): ReadingPosition | null {
  const offset = search.offset ?? 0;
  if (search.block?.startsWith(PREFIX))
    return { blockId: search.block.slice(PREFIX.length), offset };
  if (search.page !== undefined) return { page: search.page, offset };
  return null;
}

export function searchFor(resource: string, position: ReadingPosition | null): ReadingSearch {
  if (!position) return { resource };
  return 'blockId' in position
    ? { resource, block: `${PREFIX}${position.blockId}`, offset: position.offset }
    : { resource, page: position.page, offset: position.offset };
}
