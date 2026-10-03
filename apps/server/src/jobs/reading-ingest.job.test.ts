import { describe, expect, test } from 'vitest';
import { isProcessed, isRasterOnly } from './reading-ingest.job';

describe('isRasterOnly', () => {
  test('a deck with no text on any page is raster-only', () => {
    expect(isRasterOnly([{ text: '' }, { text: ' \n' }])).toBe(true);
  });

  test('a deck with text on at least half of its pages is not', () => {
    expect(isRasterOnly([{ text: 'Intro' }, { text: '' }])).toBe(false);
    expect(isRasterOnly([{ text: 'Intro' }, { text: '' }, { text: '' }])).toBe(true);
  });
});

describe('isProcessed', () => {
  test('readings, decks and notebooks have a job; other types do not', () => {
    expect(
      ['reading_native', 'reading_pdf', 'slides_pdf', 'slides_web', 'notebook'].every(isProcessed),
    ).toBe(true);
    expect(['exercise', 'test', 'shiny'].some(isProcessed)).toBe(false);
  });
});
