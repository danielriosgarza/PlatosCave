const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * At most 140 characters of a post for a notification, cut between grapheme clusters so no
 * emoji sequence, accent or surrogate pair is split.
 */
export function excerpt(body: string): string {
  const chars = Array.from(graphemes.segment(body), (s) => s.segment);
  return chars.length > 140 ? `${chars.slice(0, 139).join('')}…` : body;
}
