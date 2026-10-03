import { createHash } from 'node:crypto';

/**
 * Block identity (ADR-0003), shared by reading ingestion and anchor mapping. Kept apart from the
 * rendering pipeline so code that only compares text does not load it.
 */

export const sha12 = (value: string): string =>
  createHash('sha256').update(value).digest('hex').slice(0, 12);

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Whitespace-collapsed NFC text: what block ids hash, so reflowed source keeps its ids. */
export const normaliseText = (text: string): string =>
  text.normalize('NFC').replace(/\s+/g, ' ').trim();

/** ADR-0003: first 12 hex of sha256(normalisedText + ':' + occurrenceIndex). */
export const blockId = (normalisedText: string, occurrence: number): string =>
  sha12(`${normalisedText}:${occurrence}`);
